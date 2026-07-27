import type { LocalAgentProvider } from "./local-agent-profiles.js";

export type LocalAgentCapabilityDiscovery =
  | "provider_static"
  | "model_dependent"
  | "session_dynamic";

export type LocalAgentEffortSemantics =
  | "reasoning_effort"
  | "thinking_level"
  | "model_variant";

export interface LocalAgentProviderCapabilities {
  structuredOutput: "native" | "prompt";
  resumableSessions: boolean;
  cancellation: "signal" | "process";
  supportsWorkspaceIsolation: boolean;
  model: {
    supported: boolean;
    discovery: LocalAgentCapabilityDiscovery;
  };
  effort: {
    supported: boolean;
    semantics: LocalAgentEffortSemantics;
    discovery: LocalAgentCapabilityDiscovery;
  };
}

export const LOCAL_AGENT_PROVIDER_CAPABILITIES = {
  codex: {
    structuredOutput: "native",
    resumableSessions: true,
    cancellation: "signal",
    supportsWorkspaceIsolation: true,
    model: { supported: true, discovery: "model_dependent" },
    effort: {
      supported: true,
      semantics: "reasoning_effort",
      discovery: "model_dependent",
    },
  },
  claude: {
    structuredOutput: "native",
    resumableSessions: true,
    cancellation: "signal",
    supportsWorkspaceIsolation: true,
    model: { supported: true, discovery: "model_dependent" },
    effort: {
      supported: true,
      semantics: "reasoning_effort",
      discovery: "model_dependent",
    },
  },
  opencode: {
    structuredOutput: "prompt",
    resumableSessions: true,
    cancellation: "process",
    supportsWorkspaceIsolation: true,
    model: { supported: true, discovery: "model_dependent" },
    effort: {
      supported: true,
      semantics: "model_variant",
      discovery: "model_dependent",
    },
  },
  pi: {
    structuredOutput: "prompt",
    resumableSessions: true,
    cancellation: "process",
    supportsWorkspaceIsolation: true,
    model: { supported: true, discovery: "model_dependent" },
    effort: {
      supported: true,
      semantics: "thinking_level",
      discovery: "model_dependent",
    },
  },
  cursor: {
    structuredOutput: "prompt",
    resumableSessions: true,
    cancellation: "process",
    supportsWorkspaceIsolation: true,
    model: { supported: true, discovery: "session_dynamic" },
    effort: {
      supported: true,
      semantics: "thinking_level",
      discovery: "session_dynamic",
    },
  },
  copilot: {
    structuredOutput: "prompt",
    resumableSessions: true,
    cancellation: "process",
    supportsWorkspaceIsolation: true,
    model: { supported: true, discovery: "session_dynamic" },
    effort: {
      supported: true,
      semantics: "thinking_level",
      discovery: "session_dynamic",
    },
  },
} as const satisfies Record<LocalAgentProvider, LocalAgentProviderCapabilities>;

export function getLocalAgentProviderCapabilities(
  provider: LocalAgentProvider,
): LocalAgentProviderCapabilities {
  return LOCAL_AGENT_PROVIDER_CAPABILITIES[provider];
}

export function supportsNativeStructuredOutput(provider: LocalAgentProvider): boolean {
  return LOCAL_AGENT_PROVIDER_CAPABILITIES[provider].structuredOutput === "native";
}
