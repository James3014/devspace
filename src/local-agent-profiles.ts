import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ServerConfig } from "./config.js";
import { isObject, isString, type JsonObject } from "./value-types.js";

export type LocalAgentProvider = "codex" | "claude" | "opencode" | "pi" | "cursor" | "copilot";

export const LOCAL_AGENT_PROVIDERS: readonly LocalAgentProvider[] = [
  "codex",
  "claude",
  "opencode",
  "pi",
  "cursor",
  "copilot",
];

export interface LocalAgentProfile {
  name: string;
  description: string;
  provider: LocalAgentProvider;
  model?: string;
  thinking?: string;
  filePath: string;
  body: string;
  disabled: boolean;
}

export interface LocalAgentProfileSummary {
  name: string;
  description: string;
  provider: LocalAgentProvider;
  model?: string;
  thinking?: string;
}

interface ParsedFrontmatter {
  frontmatter: JsonObject;
  body: string;
}

const FRONTMATTER_DELIMITER = "---";
export async function loadLocalAgentProfiles(
  config: ServerConfig,
  workspaceRoot: string,
): Promise<LocalAgentProfile[]> {
  if (!config.subagents) return [];

  const profileDirs = [
    config.devspaceAgentsDir,
    join(workspaceRoot, ".devspace", "agents"),
  ];
  const profilesByName = new Map<string, LocalAgentProfile>();

  for (const directory of profileDirs) {
    for (const profile of await loadProfilesFromDirectory(directory)) {
      profilesByName.set(profile.name, profile);
    }
  }

  return Array.from(profilesByName.values())
    .filter((profile) => !profile.disabled)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function summarizeLocalAgentProfile(
  profile: LocalAgentProfile,
): LocalAgentProfileSummary {
  return {
    name: profile.name,
    description: profile.description,
    provider: profile.provider,
    model: profile.model,
    thinking: profile.thinking,
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

function parseProfileYaml(source: string, filePath: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = parseYaml(source) ?? {};
  } catch (error) {
    throw new Error(`Unable to parse subagent profile frontmatter: ${filePath}: ${errorMessage(error)}`);
  }

  if (!isObject(parsed)) {
    throw new Error(`Subagent profile frontmatter must be a mapping: ${filePath}`);
  }

  // SAFETY: yaml mappings are plain objects after the object-shape check above.
  return parsed as JsonObject;
}

function profileFromFrontmatter(
  frontmatter: JsonObject,
  body: string,
  filePath: string,
): LocalAgentProfile {
  const name = readString(frontmatter, "name") ?? basename(filePath, ".md");
  const description = readString(frontmatter, "description");
  const provider = readProvider(frontmatter, filePath);
  if (!description) {
    throw new Error(`Subagent profile is missing description: ${filePath}`);
  }

  return {
    name,
    description,
    provider,
    model: readString(frontmatter, "model"),
    thinking: readString(frontmatter, "thinking"),
    filePath,
    body,
    disabled: frontmatter.disabled === true,
  };
}

function readProvider(frontmatter: JsonObject, filePath: string): LocalAgentProvider {
  const provider = readString(frontmatter, "provider");
  if (!provider) {
    throw new Error(`Subagent profile is missing provider: ${filePath}`);
  }
  const providerName = LOCAL_AGENT_PROVIDERS.find((candidate) => candidate === provider);
  if (!providerName) {
    throw new Error(
      `Subagent profile provider must be codex, claude, opencode, pi, cursor, or copilot: ${filePath}`,
    );
  }
  return providerName;
}

export function isLocalAgentProvider(value: string): value is LocalAgentProvider {
  return LOCAL_AGENT_PROVIDERS.some((candidate) => candidate === value);
}

function readString(frontmatter: JsonObject, key: string): string | undefined {
  const value = frontmatter[key];
  if (!isString(value)) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function errorMessage<T>(error: T): string {
  return error instanceof Error ? error.message : String(error);
}
