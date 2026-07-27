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
