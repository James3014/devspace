import { spawnSync } from "node:child_process";
import { extname } from "node:path";
import {
  removeDevspaceNodeModulesBinFromPath,
  resolveLocalAgentExecutable,
} from "../local-agent-path.js";

export interface ResolvedCodexCommand {
  executable: string;
  env: NodeJS.ProcessEnv;
  runtimeKey: string;
}

export interface CodexProcessLaunch {
  executable: string;
  args: string[];
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
  let launch: CodexProcessLaunch;
  try {
    launch = buildCodexProcessLaunch(resolved, ["app-server", "--help"]);
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const result = spawnSync(launch.executable, launch.args, {
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

export function buildCodexProcessLaunch(
  command: ResolvedCodexCommand,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): CodexProcessLaunch {
  if (platform !== "win32" || !isWindowsBatchShim(command.executable)) {
    return { executable: command.executable, args: [...args] };
  }

  validateWindowsBatchShimPath(command.executable);
  for (const arg of args) validateWindowsBatchArgument(arg);
  const commandLine = `""${command.executable}"${args.length > 0 ? ` ${args.join(" ")}` : ""}"`;
  return {
    executable: command.env.ComSpec?.trim() || process.env.ComSpec?.trim() || "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
  };
}

function codexDefaultEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.PATH) return { ...env };
  return {
    ...env,
    PATH: removeDevspaceNodeModulesBinFromPath(env.PATH),
  };
}

function isWindowsBatchShim(executable: string): boolean {
  const extension = extname(executable).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

function validateWindowsBatchShimPath(executable: string): void {
  // cmd.exe expands/interprets these characters even inside quoted command
  // strings. Codex shims never need them, so reject instead of attempting
  // incomplete shell escaping.
  if (/["&|<>^%!\r\n]/.test(executable)) {
    throw new Error("Codex batch shim path contains characters that cannot be launched safely.");
  }
}

function validateWindowsBatchArgument(arg: string): void {
  // DevSpace only invokes fixed Codex subcommands/options through this path.
  if (!/^[A-Za-z0-9_-]+$/.test(arg)) {
    throw new Error(`Unsafe Codex batch-shim argument: ${arg}`);
  }
}
