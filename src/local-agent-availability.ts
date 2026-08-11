import { resolveLocalAgentExecutable } from "./local-agent-path.js";
import { checkCodexAppServerAvailability } from "./local-agent-codex/command.js";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

export interface LocalAgentProviderAvailability {
  name: LocalAgentProvider;
  available: boolean;
  reason?: string;
}

export function getLocalAgentProviderAvailabilitySnapshot(
  env: NodeJS.ProcessEnv = process.env,
): LocalAgentProviderAvailability[] {
  return LOCAL_AGENT_PROVIDERS.map((provider) => checkLocalAgentProviderAvailability(provider, env));
}

export function checkLocalAgentProviderAvailability(
  provider: LocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
): LocalAgentProviderAvailability {
  switch (provider) {
    case "codex":
      return codexAvailability(env);
    case "claude":
      return packageAvailability(provider, "@anthropic-ai/claude-agent-sdk");
    case "opencode":
      return packageAvailability(provider, "@opencode-ai/sdk/v2");
    case "pi":
      return packageAvailability(provider, "@earendil-works/pi-coding-agent");
    case "cursor":
      return commandAvailability(provider, "cursor-agent");
    case "copilot":
      return commandAvailability(provider, "copilot");
  }
}

export function assertLocalAgentProviderAvailable(
  provider: LocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const availability = checkLocalAgentProviderAvailability(provider, env);
  if (availability.available) return;
  throw new Error(
    `${provider} provider is not available: ${availability.reason ?? "provider preflight failed"}`,
  );
}

export function formatLocalAgentProviderAvailabilitySummary(
  providers: LocalAgentProviderAvailability[],
): string {
  const available = providers
    .filter((provider) => provider.available)
    .map((provider) => provider.name);
  const unavailable = providers
    .filter((provider) => !provider.available)
    .map((provider) => `${provider.name} (${provider.reason ?? "unavailable"})`);
  return [
    available.length > 0 ? `available: ${available.join(", ")}` : undefined,
    unavailable.length > 0 ? `unavailable: ${unavailable.join(", ")}` : undefined,
  ].filter(Boolean).join("; ");
}

function packageAvailability(
  provider: LocalAgentProvider,
  packageName: string,
): LocalAgentProviderAvailability {
  try {
    import.meta.resolve(packageName);
    return { name: provider, available: true };
  } catch {
    return {
      name: provider,
      available: false,
      reason: `${packageName} package not found`,
    };
  }
}

function commandAvailability(
  provider: LocalAgentProvider,
  command: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): LocalAgentProviderAvailability {
  const executable = resolveLocalAgentExecutable(command, options.env);
  if (!executable) {
    return {
      name: provider,
      available: false,
      reason: `${command} executable not found`,
    };
  }

  return { name: provider, available: true };
}

function codexAvailability(env: NodeJS.ProcessEnv): LocalAgentProviderAvailability {
  const result = checkCodexAppServerAvailability(env);
  return result.available
    ? { name: "codex", available: true }
    : { name: "codex", available: false, reason: result.reason };
}

