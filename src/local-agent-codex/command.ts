import { spawnSync } from "node:child_process";
import {
  removeDevspaceNodeModulesBinFromPath,
  resolveLocalAgentExecutable,
} from "../local-agent-path.js";

export interface ResolvedCodexCommand {
  executable: string;
  env: NodeJS.ProcessEnv;
  runtimeKey: string;
}

export function resolveCodexCommand(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCodexCommand | undefined {
  const explicit = env.CODEX_COMMAND?.trim();
  const commandEnv = explicit ? { ...env } : codexDefaultEnvironment(env);
  const executable = resolveLocalAgentExecutable(explicit || "codex", commandEnv);
  if (!executable) return undefined;
  return {
    executable,
    env: commandEnv,
    runtimeKey: `${executable}\0${commandEnv.CODEX_HOME ?? ""}`,
  };
}

export function checkCodexAppServerAvailability(
  env: NodeJS.ProcessEnv = process.env,
): { available: true } | { available: false; reason: string } {
  const resolved = resolveCodexCommand(env);
  if (!resolved) {
    return {
      available: false,
      reason: `${env.CODEX_COMMAND?.trim() || "codex"} executable not found`,
    };
  }
  const result = spawnSync(resolved.executable, ["app-server", "--help"], {
    encoding: "utf8",
    env: resolved.env,
    windowsHide: true,
    timeout: 5_000,
  });
  if (!result.error && result.status === 0) return { available: true };
  const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status ?? "unknown"}`;
  return {
    available: false,
    reason: `Codex CLI does not support app-server (${detail})`,
  };
}

function codexDefaultEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.PATH) return { ...env };
  return {
    ...env,
    PATH: removeDevspaceNodeModulesBinFromPath(env.PATH),
  };
}
