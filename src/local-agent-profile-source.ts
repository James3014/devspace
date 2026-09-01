import { createHash } from "node:crypto";
import {
  loadLocalAgentProfileEntries,
  type LocalAgentProfile,
  type LocalAgentProfileEntry,
} from "./local-agent-profiles.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
  type LocalAgentProviderAvailability,
} from "./local-agent-availability.js";
import { resolveSubagentsConfig, type SubagentsConfig } from "./local-agent-config.js";
import { LOCAL_AGENT_PROVIDERS } from "./local-agent-profiles.js";
import type { ServerConfig } from "./config.js";

/**
 * Owner-approved profile authority contract:
 *
 * The advertised profile set (open_workspace), the preflight resolvable set
 * (agent_preflight), and the agent_start admissible set are all derived from
 * this single source. A profile that is not dispatchable never silently
 * disappears: it stays visible with an explicit state and a typed blocker, so
 * callers observe consistent sets plus diagnostics instead of ghost profiles.
 */
export type ProfileBlockerCode =
  | "PROFILE_DISABLED"
  | "UNTRACKED_REPOSITORY_PROFILE"
  | "PROFILE_AUTHORITY_CONFLICT"
  | "PROVIDER_DISABLED"
  | "PROVIDER_UNAVAILABLE";

export interface ProfileCatalogEntry {
  name: string;
  description: string;
  provider: string;
  model?: string;
  effort?: string;
  write_mode?: string;
  state: "advertised" | "disabled" | "untracked_repository_profile" | "profile_authority_conflict" | "provider_unavailable" | "provider_disabled";
  sources: string[];
  tracked?: boolean;
  diagnostic?: string;
}

export interface ProfileCatalog {
  /** Dispatchable profiles. Identical to the open_workspace advertised set. */
  profiles: LocalAgentProfile[];
  /** Every profile with explicit state, including non-dispatchable ones. */
  entries: ProfileCatalogEntry[];
  /** Stable fingerprint over the full profile + state surface. */
  generation: string;
  /** Resolve a profile by name; returns the advertised profile or undefined. */
  advertised(profileName: string): LocalAgentProfile | undefined;
  /** Typed blocker for a known-but-not-advertised profile; undefined if unknown. */
  blockerFor(profileName: string): { code: ProfileBlockerCode; detail: string } | undefined;
}

export async function loadProfileCatalog(
  config: ServerConfig,
  workspaceRoot: string,
  options: {
    subagents?: SubagentsConfig;
    availability?: readonly LocalAgentProviderAvailability[];
  } = {},
): Promise<ProfileCatalog> {
  const entries: LocalAgentProfileEntry[] = await loadLocalAgentProfileEntries(config, workspaceRoot);
  const availability = options.availability ?? getLocalAgentProviderAvailabilitySnapshot();
  const availabilityByName = new Map(availability.map((entry) => [entry.name, entry]));
  const subagents = resolveSubagentsConfig(options.subagents ?? config.subagents);
  // Empty providers list means "no explicit provider allow-list": every provider
  // is enabled, matching legacy subagents semantics. Explicit lists gate.
  const providerEnabled = new Set(
    subagents.providers.length === 0
      ? subagents.enabled
        ? LOCAL_AGENT_PROVIDERS
        : []
      : subagents.providers.filter((provider) => provider.enabled).map((provider) => provider.id),
  );

  const catalogEntries: ProfileCatalogEntry[] = [];
  const advertised = new Map<string, LocalAgentProfile>();

  for (const entry of entries) {
    const { profile, status } = entry;
    let state: ProfileCatalogEntry["state"];
    let diagnostic = status.diagnostic;

    if (status.state === "profile_authority_conflict") {
      state = "profile_authority_conflict";
    } else if (status.state === "disabled") {
      state = "disabled";
      diagnostic = diagnostic ?? "profile is marked disabled";
    } else if (status.state === "untracked_repository_profile") {
      state = "untracked_repository_profile";
    } else if (!providerEnabled.has(profile.provider)) {
      state = "provider_disabled";
      diagnostic = diagnostic ?? `provider '${profile.provider}' is not enabled in subagents config`;
    } else {
      const live = availabilityByName.get(profile.provider);
      if (!live?.available) {
        state = "provider_unavailable";
        diagnostic = diagnostic ?? `provider '${profile.provider}' is unavailable: ${live?.reason ?? "provider preflight failed"}`;
      } else {
        state = "advertised";
      }
    }

    if (state === "advertised") advertised.set(profile.name, profile);
    catalogEntries.push({
      name: profile.name,
      description: profile.description,
      provider: profile.provider,
      model: profile.model,
      effort: profile.effort,
      write_mode: profile.write_mode,
      state,
      sources: status.sources,
      tracked: status.tracked,
      diagnostic,
    });
  }

  return {
    profiles: Array.from(advertised.values()).sort((a, b) => a.name.localeCompare(b.name)),
    entries: catalogEntries.sort((a, b) => a.name.localeCompare(b.name)),
    generation: computeProfileCatalogGeneration(catalogEntries),
    advertised: (profileName) => advertised.get(profileName),
    blockerFor: (profileName) => {
      const catalogEntry = catalogEntries.find((candidate) => candidate.name === profileName);
      if (!catalogEntry) return undefined;
      switch (catalogEntry.state) {
        case "advertised":
          return undefined;
        case "disabled":
          return { code: "PROFILE_DISABLED", detail: catalogEntry.diagnostic ?? "profile is disabled" };
        case "untracked_repository_profile":
          return {
            code: "UNTRACKED_REPOSITORY_PROFILE",
            detail: catalogEntry.diagnostic ?? "repository profile is not Git-tracked",
          };
        case "profile_authority_conflict":
          return {
            code: "PROFILE_AUTHORITY_CONFLICT",
            detail: catalogEntry.diagnostic ?? "conflicting global and repository profile definitions",
          };
        case "provider_disabled":
          return { code: "PROVIDER_DISABLED", detail: catalogEntry.diagnostic ?? "provider is not enabled" };
        case "provider_unavailable":
          return { code: "PROVIDER_UNAVAILABLE", detail: catalogEntry.diagnostic ?? "provider is unavailable" };
      }
    },
  };
}

export function computeProfileCatalogGeneration(
  entries: readonly ProfileCatalogEntry[],
): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(JSON.stringify({
      name: entry.name,
      provider: entry.provider,
      model: entry.model ?? null,
      effort: entry.effort ?? null,
      write_mode: entry.write_mode ?? null,
      state: entry.state,
      sources: entry.sources,
    }));
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}
