import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

export interface LocalAgentProviderAvailability {
  name: LocalAgentProvider;
  available: boolean;
  reason?: string;
  note?: string;
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
    case "omp":
      return commandAvailability(provider, env.OMP_COMMAND ?? "omp", env);
    case "pi":
      return packageAvailability(provider, "@earendil-works/pi-coding-agent");
    case "cursor":
      return commandAvailability(provider, env.CURSOR_COMMAND ?? "cursor-agent", env);
    case "copilot":
      return commandAvailability(provider, env.COPILOT_COMMAND ?? "copilot", env);
    case "grok":
      return commandAvailability(provider, env.GROK_COMMAND ?? "grok", env);
    case "agy":
      return checkAgyAvailability(env);
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
    .map(formatAvailableProvider);
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

function codexAvailability(env: NodeJS.ProcessEnv): LocalAgentProviderAvailability {
  const availability = commandAvailability("codex", env.CODEX_COMMAND ?? "codex", env);
  return availability.available
    ? {
        ...availability,
        note: "available",
      }
    : availability;
}

function commandAvailability(
  provider: LocalAgentProvider,
  command: string,
  env: NodeJS.ProcessEnv,
): LocalAgentProviderAvailability {
  if (resolveCommand(command, env)) return { name: provider, available: true };
  return {
    name: provider,
    available: false,
    reason: `${command} executable not found`,
  };
}

function resolveCommand(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    return executableExists(command) ? command : undefined;
  }
  const path = env.PATH;
  if (!path) return undefined;
  const extensions = process.platform === "win32"
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`);
      if (executableExists(candidate)) return candidate;
    }
  }
  return undefined;
}

function formatAvailableProvider(provider: LocalAgentProviderAvailability): string {
  return provider.note ? `${provider.name} (${provider.note})` : provider.name;
}

function executableExists(command: string): boolean {
  const mode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
  try {
    accessSync(command, mode);
    return true;
  } catch {
    return false;
  }
}

export function resolveAgyExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.AGY_COMMAND) {
    const resolved = resolveCommand(env.AGY_COMMAND, env);
    if (resolved) return resolved;
  }
  const resolvedPath = resolveCommand("agy", env);
  if (resolvedPath) return resolvedPath;

  const fallback = "/Users/jameschen/.local/bin/agy";
  if (executableExists(fallback)) {
    return fallback;
  }
  return undefined;
}

function checkAgyAvailability(env: NodeJS.ProcessEnv): LocalAgentProviderAvailability {
  const executable = resolveAgyExecutable(env);
  if (!executable) {
    return {
      name: "agy",
      available: false,
      reason: "agy executable not found",
    };
  }
  return { name: "agy", available: true };
}

/**
 * Resolve the concrete executable for a provider, when the provider runs an
 * external command. Package-providers (codex/claude/opencode) return undefined.
 */
export function resolveLocalAgentProviderExecutable(
  provider: LocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  switch (provider) {
    case "omp":
      return resolveCommand(env.OMP_COMMAND ?? "omp", env);
    case "pi":
      return resolveCommand(env.PI_COMMAND ?? "pi", env);
    case "cursor":
      return resolveCommand("cursor-agent", env);
    case "copilot":
      return resolveCommand("copilot", env);
    case "grok":
      return resolveCommand(env.GROK_COMMAND ?? "grok", env);
    case "agy":
      return resolveAgyExecutable(env);
    default:
      return undefined;
  }
}

/**
 * Best-effort runtime version for a provider, from `--version` on the resolved
 * executable. Package-providers report undefined. Never throws.
 */
export function getLocalAgentProviderRuntimeVersion(
  provider: LocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const executable = resolveLocalAgentProviderExecutable(provider, env);
  if (!executable) return undefined;
  try {
    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      env,
      windowsHide: true,
      timeout: 5_000,
    });
    if (result.error) return undefined;
    const version = (result.stdout ?? "").trim() || (result.stderr ?? "").trim();
    return version.slice(0, 120) || undefined;
  } catch {
    return undefined;
  }
}
