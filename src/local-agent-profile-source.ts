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
import {
  getActiveOpencodeCatalogSnapshot,
  validateOpencodeModelAndVariant,
  type OpencodeCatalogSnapshot,
} from "./local-agent-opencode-catalog.js";
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
  | "PROVIDER_UNAVAILABLE"
  | "EXACT_MODEL_UNAVAILABLE"
  | "VARIANT_UNAVAILABLE";

export interface ProfileCatalogEntry {
  name: string;
  description: string;
  provider: string;
  model?: string;
  effort?: string;
  cliProviderId?: "cline" | "cline-pass";
  write_mode?: string;
  state:
    | "advertised"
    | "disabled"
    | "untracked_repository_profile"
    | "profile_authority_conflict"
    | "provider_unavailable"
    | "provider_disabled"
    | "exact_model_unavailable"
    | "variant_unavailable";
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
  /** Exact OpenCode snapshot used to validate provider/model/variant entries. */
  opencodeCatalog?: OpencodeCatalogSnapshot;
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
    opencodeCatalog?: OpencodeCatalogSnapshot;
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
      } else if (profile.provider === "opencode") {
        const opencodeCatalog = options.opencodeCatalog ?? getActiveOpencodeCatalogSnapshot();
        const modelValidation = validateOpencodeModelAndVariant(profile.model, profile.effort, opencodeCatalog);
        if (!modelValidation.valid) {
          if (modelValidation.blockerCode === "EXACT_MODEL_UNAVAILABLE") {
            state = "exact_model_unavailable";
            diagnostic = modelValidation.reason ?? `OpenCode model '${profile.model}' is not available in current catalog`;
          } else {
            state = "variant_unavailable";
            diagnostic = modelValidation.reason ?? `OpenCode variant '${profile.effort}' is not available for model '${profile.model}'`;
          }
        } else {
          state = "advertised";
        }
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
      cliProviderId: profile.cliProviderId,
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
    // Bind the advertised profile generation to the exact live catalog
    // snapshot used for validation. A refreshed snapshot must therefore be
    // treated as execution material drift even when its profile projection is
    // textually unchanged.
    generation: computeProfileCatalogGeneration(catalogEntries, options.opencodeCatalog?.generation),
    opencodeCatalog: options.opencodeCatalog,
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
        case "exact_model_unavailable":
          return { code: "EXACT_MODEL_UNAVAILABLE", detail: catalogEntry.diagnostic ?? "requested model is unavailable" };
        case "variant_unavailable":
          return { code: "VARIANT_UNAVAILABLE", detail: catalogEntry.diagnostic ?? "requested variant is unavailable" };
      }
    },
  };
}

export function computeProfileCatalogGeneration(
  entries: readonly ProfileCatalogEntry[],
  catalogGeneration?: string,
): string {
  const hash = createHash("sha256");
  if (catalogGeneration !== undefined) {
    hash.update(`catalog-generation:${catalogGeneration}\n`);
  }
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(JSON.stringify({
      name: entry.name,
      provider: entry.provider,
      model: entry.model ?? null,
      effort: entry.effort ?? null,
      cliProviderId: entry.cliProviderId ?? null,
      write_mode: entry.write_mode ?? null,
      state: entry.state,
      sources: entry.sources,
    }));
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}
