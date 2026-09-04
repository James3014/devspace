import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type { ServerConfig } from "./config.js";

export type LocalAgentProvider =
  | "codex"
  | "claude"
  | "opencode"
  | "omp"
  | "pi"
  | "cursor"
  | "copilot"
  | "grok"
  | "agy"
  | "cline";

export const LOCAL_AGENT_PROVIDERS: readonly LocalAgentProvider[] = [
  "codex",
  "claude",
  "opencode",
  "omp",
  "pi",
  "cursor",
  "copilot",
  "grok",
  "agy",
  "cline",
];

export type WriteMode = "read_only" | "allowed";

export interface LocalAgentProfile {
  name: string;
  description: string;
  provider: LocalAgentProvider;
  model?: string;
  effort?: string;
  write_mode?: WriteMode;
  /** Default hard execution-idle timeout for trustworthy-activity providers. */
  execution_idle_timeout_ms?: number;
  /** Minimum allowed explicit per-task idle override for this profile. */
  execution_idle_min_override_ms?: number;
  /**
   * Repository-local profiles may explicitly extend a global profile and
   * override it. Silent same-name overrides are prohibited: a conflicting
   * repository definition must either declare an explicit tracked override
   * relationship or fail closed as PROFILE_AUTHORITY_CONFLICT.
   */
  extends?: string;
  override?: boolean;
  filePath: string;
  body: string;
  disabled: boolean;
}

export interface LocalAgentProfileSummary {
  name: string;
  description: string;
  provider: LocalAgentProvider;
  model?: string;
  effort?: string;
  write_mode?: WriteMode;
  execution_idle_timeout_ms?: number;
  execution_idle_min_override_ms?: number;
}

/**
 * Profile authority states. Every loaded profile is always visible with an
 * explicit state; profiles never silently disappear from diagnostics, and
 * non-ready states are never dispatchable.
 */
export type LocalAgentProfileState =
  | "ready"
  | "disabled"
  | "untracked_repository_profile"
  | "profile_authority_conflict";

export type LocalAgentProfileSource = "global" | "repository";

export interface LocalAgentProfileStatusInfo {
  state: LocalAgentProfileState;
  sources: LocalAgentProfileSource[];
  /** Git-tracked status of a repository-local profile file. */
  tracked?: boolean;
  diagnostic?: string;
}

export interface LocalAgentProfileEntry {
  profile: LocalAgentProfile;
  status: LocalAgentProfileStatusInfo;
}

interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_DELIMITER = "---";
const PROVIDERS = new Set<LocalAgentProvider>(LOCAL_AGENT_PROVIDERS);

export async function loadLocalAgentProfiles(
  config: ServerConfig,
  workspaceRoot: string,
  options: { includeDisabled?: boolean } = {},
): Promise<LocalAgentProfile[]> {
  const entries = await loadLocalAgentProfileEntries(config, workspaceRoot);
  return entries
    .filter((entry) =>
      entry.status.state === "ready"
      || (options.includeDisabled && entry.status.state === "disabled")
    )
    .map((entry) => entry.profile)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Single authoritative profile loader. Loads global machine profiles and
 * repository profiles, applies the owner-approved authority rules, and returns
 * every profile with an explicit state:
 *
 * - Global profiles (~/.devspace/agents) are the machine/provider capability
 *   authority.
 * - Repository profiles (<workspace>/.devspace/agents) are project execution
 *   policy and must be Git-tracked to be dispatchable.
 * - Untracked repository profiles are diagnostic-only and never dispatchable.
 * - Same name with different definitions fails closed as
 *   PROFILE_AUTHORITY_CONFLICT unless the repository profile is tracked and
 *   explicitly declares `extends` + `override: true`.
 */
export async function loadLocalAgentProfileEntries(
  config: ServerConfig,
  workspaceRoot: string,
): Promise<LocalAgentProfileEntry[]> {
  if (!config.subagents.enabled) return [];

  const globalDir = resolve(config.devspaceAgentsDir);
  const repoDir = resolve(join(workspaceRoot, ".devspace", "agents"));

  const globalProfiles = await loadProfilesFromDirectory(globalDir);
  const repoProfiles = await loadProfilesFromDirectory(repoDir);
  const repoTracking = new Map<string, { tracked: boolean; nonGit: boolean }>();
  for (const profile of repoProfiles) {
    const probe = isPathGitTracked(workspaceRoot, profile.filePath);
    repoTracking.set(profile.filePath, { tracked: probe === true, nonGit: probe === "non_git" });
  }

  const byName = new Map<string, LocalAgentProfileEntry>();

  for (const profile of globalProfiles) {
    byName.set(profile.name, {
      profile,
      status: {
        state: profile.disabled ? "disabled" : "ready",
        sources: ["global"],
      },
    });
  }

  for (const profile of repoProfiles) {
    const tracking = repoTracking.get(profile.filePath) ?? { tracked: false, nonGit: false };
    const tracked = tracking.tracked;
    const existing = byName.get(profile.name);
    if (!existing) {
      byName.set(profile.name, repositoryOnlyEntry(profile, tracked, tracking.nonGit));
      continue;
    }

    const mergedSources: LocalAgentProfileSource[] =
      existing.status.sources.includes("global")
        ? [...existing.status.sources, "repository"]
        : ["repository"];

    if (profilesEquivalent(existing.profile, profile)) {
      byName.set(profile.name, {
        profile,
        status: {
          state: existing.profile.disabled || profile.disabled ? "disabled" : "ready",
          sources: mergedSources,
          tracked,
        },
      });
      continue;
    }

    if (
      tracked === true
      && profile.override === true
      && profile.extends !== undefined
      && normalizeExtendsTarget(profile.extends) === profile.name
      && !profile.disabled
    ) {
      byName.set(profile.name, {
        profile,
        status: {
          state: "ready",
          sources: mergedSources,
          tracked,
          diagnostic: `repository profile explicitly overrides global profile '${profile.name}' (tracked, extends+override)`,
        },
      });
      continue;
    }

    byName.set(profile.name, {
      profile: existing.profile,
      status: {
        state: "profile_authority_conflict",
        sources: mergedSources,
        tracked,
        diagnostic:
          `PROFILE_AUTHORITY_CONFLICT: global profile '${existing.profile.filePath}' and repository profile '${profile.filePath}' `
          + `define different definitions for '${profile.name}'. A repository profile may only override a global profile `
          + `when it is Git-tracked and declares 'extends: global:${profile.name}' with 'override: true'.`,
      },
    });
  }

  return Array.from(byName.values()).sort((a, b) =>
    a.profile.name.localeCompare(b.profile.name),
  );
}

function repositoryOnlyEntry(
  profile: LocalAgentProfile,
  tracked: boolean,
  nonGit: boolean,
): LocalAgentProfileEntry {
  if (profile.disabled) {
    return {
      profile,
      status: { state: "disabled", sources: ["repository"], tracked },
    };
  }
  if (nonGit) {
    return {
      profile,
      status: {
        state: "ready",
        sources: ["repository"],
        diagnostic:
          "workspace is not a Git worktree; repository-local profile tracking cannot be verified",
      },
    };
  }
  if (!tracked) {
    return {
      profile,
      status: {
        state: "untracked_repository_profile",
        sources: ["repository"],
        tracked: false,
        diagnostic:
          `UNTRACKED_REPOSITORY_PROFILE: '${profile.filePath}' is not Git-tracked. It is visible here for `
          + `diagnostics but is NOT advertised and NOT dispatchable. Commit the profile or move it to the `
          + `global agents directory (~/.devspace/agents).`,
      },
    };
  }
  return { profile, status: { state: "ready", sources: ["repository"], tracked: true } };
}

function profilesEquivalent(a: LocalAgentProfile, b: LocalAgentProfile): boolean {
  return a.description === b.description
    && a.provider === b.provider
    && (a.model ?? undefined) === (b.model ?? undefined)
    && (a.effort ?? undefined) === (b.effort ?? undefined)
    && (a.write_mode ?? undefined) === (b.write_mode ?? undefined)
    && (a.execution_idle_timeout_ms ?? undefined) === (b.execution_idle_timeout_ms ?? undefined)
    && (a.execution_idle_min_override_ms ?? undefined) === (b.execution_idle_min_override_ms ?? undefined)
    && a.body === b.body
    && a.disabled === b.disabled;
}

function normalizeExtendsTarget(value: string): string {
  return value.trim().replace(/^global:/, "");
}

/**
 * Returns true when the file is tracked by Git in the repository containing
 * workspaceRoot, false when it is untracked, and "non_git" when workspaceRoot
 * is not inside a Git worktree.
 */
export function isPathGitTracked(
  workspaceRoot: string,
  filePath: string,
  run: typeof spawnSync = spawnSync,
): boolean | "non_git" {
  try {
    const inside = run("git", ["-C", workspaceRoot, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    if (inside.status !== 0 || inside.stdout?.trim() !== "true") return "non_git";
    const rel = relative(resolve(workspaceRoot), resolve(filePath));
    if (rel.startsWith("..")) return false;
    const listed = run("git", ["-C", workspaceRoot, "ls-files", "--", rel], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    return listed.status === 0 && Boolean(listed.stdout?.trim().length);
  } catch {
    return false;
  }
}

export function summarizeLocalAgentProfile(
  profile: LocalAgentProfile,
): LocalAgentProfileSummary {
  return {
    name: profile.name,
    description: profile.description,
    provider: profile.provider,
    model: profile.model,
    effort: profile.effort,
    write_mode: profile.write_mode,
    execution_idle_timeout_ms: profile.execution_idle_timeout_ms,
    execution_idle_min_override_ms: profile.execution_idle_min_override_ms,
  };
}

async function loadProfilesFromDirectory(directory: string): Promise<LocalAgentProfile[]> {
  const resolvedDirectory = resolve(directory);
  if (!existsSync(resolvedDirectory)) return [];

  const entries = await readdir(resolvedDirectory, { withFileTypes: true });
  const profiles: LocalAgentProfile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;

    const filePath = join(resolvedDirectory, entry.name);
    try {
      profiles.push(await loadProfileFile(filePath));
    } catch (error) {
      console.warn(`Skipping invalid subagent profile ${filePath}: ${errorMessage(error)}`);
    }
  }

  return profiles;
}

async function loadProfileFile(filePath: string): Promise<LocalAgentProfile> {
  const content = await readFile(filePath, "utf8");
  const parsed = parseFrontmatter(content, filePath);
  return profileFromFrontmatter(parsed.frontmatter, parsed.body, filePath);
}

function parseFrontmatter(content: string, filePath: string): ParsedFrontmatter {
  const normalized = content.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new Error(`Subagent profile is missing frontmatter: ${filePath}`);
  }

  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER,
  );
  if (endIndex === -1) {
    throw new Error(`Subagent profile frontmatter is not closed: ${filePath}`);
  }

  return {
    frontmatter: parseProfileYaml(lines.slice(1, endIndex).join("\n"), filePath),
    body: lines.slice(endIndex + 1).join("\n").trim(),
  };
}

function parseProfileYaml(source: string, filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(source) ?? {};
  } catch (error) {
    throw new Error(`Unable to parse subagent profile frontmatter: ${filePath}: ${errorMessage(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Subagent profile frontmatter must be a mapping: ${filePath}`);
  }

  return parsed as Record<string, unknown>;
}

function profileFromFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
  filePath: string,
): LocalAgentProfile {
  const name = readString(frontmatter, "name") ?? basename(filePath, ".md");
  const description = readString(frontmatter, "description");
  const provider = readProvider(frontmatter, filePath);
  if (!description) {
    throw new Error(`Subagent profile is missing description: ${filePath}`);
  }

  const override = frontmatter.override === true ? true : undefined;
  return {
    name,
    description,
    provider,
    model: readString(frontmatter, "model"),
    effort: readString(frontmatter, "effort") ?? readString(frontmatter, "thinking"),
    write_mode: readWriteMode(frontmatter, filePath),
    execution_idle_timeout_ms: readPositiveInteger(frontmatter, "execution_idle_timeout_ms", filePath),
    execution_idle_min_override_ms: readPositiveInteger(frontmatter, "execution_idle_min_override_ms", filePath),
    extends: readString(frontmatter, "extends"),
    override,
    filePath,
    body,
    disabled: frontmatter.disabled === true,
  };
}

function readProvider(frontmatter: Record<string, unknown>, filePath: string): LocalAgentProvider {
  const provider = readString(frontmatter, "provider");
  if (!provider) {
    throw new Error(`Subagent profile is missing provider: ${filePath}`);
  }
  if (!PROVIDERS.has(provider as LocalAgentProvider)) {
    throw new Error(
      `Subagent profile provider must be codex, claude, opencode, omp, pi, cursor, copilot, grok, agy, or cline: ${filePath}`,
    );
  }
  return provider as LocalAgentProvider;
}

export function isLocalAgentProvider(value: string): value is LocalAgentProvider {
  return PROVIDERS.has(value as LocalAgentProvider);
}

function readWriteMode(frontmatter: Record<string, unknown>, filePath: string): WriteMode {
  const value = readString(frontmatter, "write_mode");
  if (!value) return "read_only";
  if (value !== "read_only" && value !== "allowed") {
    throw new Error(`Subagent profile write_mode must be read_only or allowed: ${filePath}`);
  }
  return value as WriteMode;
}

function readPositiveInteger(
  frontmatter: Record<string, unknown>,
  key: string,
  filePath: string,
): number | undefined {
  const value = frontmatter[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Subagent profile ${key} must be a positive integer: ${filePath}`);
  }
  return value;
}

function readString(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
