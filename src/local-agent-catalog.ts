import { getLocalAgentProviderCapabilities } from "./local-agent-capabilities.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import {
  summarizeLocalAgentProfile,
  type LocalAgentProfile,
} from "./local-agent-profiles.js";

export interface LocalAgentProviderCatalogEntry {
  name: LocalAgentProviderAvailability["name"];
  model: ReturnType<typeof getLocalAgentProviderCapabilities>["model"];
  effort: ReturnType<typeof getLocalAgentProviderCapabilities>["effort"];
}

export interface LocalAgentCatalog {
  providers: LocalAgentProviderCatalogEntry[];
  profiles: ReturnType<typeof summarizeLocalAgentProfile>[];
}

export interface LocalAgentTargetCatalog {
  providers: Array<{ name: string }>;
  profiles: ReturnType<typeof summarizeLocalAgentProfile>[];
}

/** Keep model-facing target discovery focused on selectable values. */
export function compactLocalAgentCatalog(catalog: LocalAgentCatalog): LocalAgentTargetCatalog {
  return {
    providers: catalog.providers.map(({ name }) => ({ name })),
    profiles: catalog.profiles,
  };
}

export function formatLocalAgentCatalog(catalog: LocalAgentCatalog): string {
  const profileLines = catalog.profiles.length > 0
    ? [
        "Profiles:",
        ...catalog.profiles.map((profile) => {
          const details = [
            profile.provider,
            profile.model ? `model=${profile.model}` : undefined,
            profile.effort ? `effort=${profile.effort}` : undefined,
          ].filter(Boolean).join(", ");
          return `  ${profile.name} (${details}) — ${profile.description}`;
        }),
      ]
    : ["Profiles: none"];
  const providerLines = catalog.providers.length > 0
    ? ["Providers:", ...catalog.providers.map((provider) => `  ${provider.name}`)]
    : ["Providers: none"];
  return [...profileLines, "", ...providerLines].join("\n");
}

/** Build the compact model-facing catalog from currently usable providers. */
export function buildLocalAgentCatalog(
  profiles: LocalAgentProfile[],
  availability: LocalAgentProviderAvailability[],
): LocalAgentCatalog {
  const usable = availability.filter((provider) => provider.available);
  const usableNames = new Set(usable.map((provider) => provider.name));
  return {
    providers: usable.map((provider) => {
      const capabilities = getLocalAgentProviderCapabilities(provider.name);
      return {
        name: provider.name,
        model: capabilities.model,
        effort: capabilities.effort,
      };
    }),
    profiles: profiles
      .filter((profile) => usableNames.has(profile.provider))
      .map(summarizeLocalAgentProfile),
  };
}
