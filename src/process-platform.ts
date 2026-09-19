import { basename } from "node:path";
import { spawnSync } from "node:child_process";

export interface ShellCommand {
  executable: string;
  args: string[];
}

export interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface OwnedProcessIdentity {
  pid: number;
  ppid: number;
  pgid: number;
  startTime: string;
  command: string;
}

export type OwnedProcessTreeState = "terminated" | "still-running" | "unknown";

export interface ProcessTreeTerminationReceipt {
  supported: boolean;
  captureComplete: boolean;
  descendants: OwnedProcessIdentity[];
  state?: OwnedProcessTreeState;
}

interface ProcessTreeRuntime {
  platform: NodeJS.Platform;
  killGroup(pid: number, signal: NodeJS.Signals): void;
  killPid?(pid: number, signal: NodeJS.Signals): void;
  killWindowsTree(pid: number): boolean;
  listProcesses?(): OwnedProcessIdentity[] | undefined;
}

function listDarwinProcesses(): OwnedProcessIdentity[] | undefined {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,command="], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 2_000,
  });
  if (result.error || result.status !== 0) return undefined;
  const rows: OwnedProcessIdentity[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0 || !Number.isSafeInteger(pgid) || pgid <= 0) {
      continue;
    }
    rows.push({ pid, ppid, pgid, startTime: match[4] ?? "", command: match[5] ?? "" });
  }
  return rows;
}

const defaultProcessTreeRuntime: ProcessTreeRuntime = {
  platform: process.platform,
  killGroup: (pid, signal) => process.kill(-pid, signal),
  killPid: (pid, signal) => process.kill(pid, signal),
  killWindowsTree: (pid) => {
    const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  },
  listProcesses: process.platform === "darwin" ? listDarwinProcesses : undefined,
};

const LOGIN_SHELLS = new Set(["bash", "ksh", "zsh"]);
const POSIX_SHELLS = new Set(["ash", "dash", "sh"]);

export function resolveShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ShellCommand {
  if (platform === "win32") {
    return {
      executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }

  const configuredShell = environment.SHELL;
  const shellName = configuredShell ? basename(configuredShell) : "";
  if (configuredShell && LOGIN_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-lc", command] };
  }
  if (configuredShell && POSIX_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-c", command] };
  }

  return { executable: "/bin/sh", args: ["-c", command] };
}

function sameProcessIdentity(
  expected: OwnedProcessIdentity,
  current: OwnedProcessIdentity,
  requireParent: boolean,
): boolean {
  return expected.pid === current.pid
    && expected.pgid === current.pgid
    && expected.startTime === current.startTime
    && expected.command === current.command
    && (!requireParent || expected.ppid === current.ppid);
}

function captureDarwinDescendants(
  rootPid: number,
  runtime: ProcessTreeRuntime,
): { captureComplete: boolean; descendants: OwnedProcessIdentity[] } {
  if (runtime.platform !== "darwin") return { captureComplete: false, descendants: [] };
  const table = runtime.listProcesses?.();
  if (!table) return { captureComplete: false, descendants: [] };

  const byParent = new Map<number, OwnedProcessIdentity[]>();
  for (const row of table) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }

  const descendants: Array<{ identity: OwnedProcessIdentity; depth: number }> = [];
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of byParent.get(current.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      const depth = current.depth + 1;
      descendants.push({ identity: child, depth });
      queue.push({ pid: child.pid, depth });
    }
  }

  descendants.sort((a, b) => b.depth - a.depth || b.identity.pid - a.identity.pid);
  return { captureComplete: true, descendants: descendants.map((entry) => entry.identity) };
}

export function inspectOwnedProcessTree(
  descendants: readonly OwnedProcessIdentity[],
  runtime: ProcessTreeRuntime = defaultProcessTreeRuntime,
): OwnedProcessTreeState | undefined {
  if (runtime.platform !== "darwin") return undefined;
  const table = runtime.listProcesses?.();
  if (!table) return "unknown";
  const byPid = new Map(table.map((row) => [row.pid, row]));
  let sawStillRunning = false;
  let sawUnknown = false;
  for (const expected of descendants) {
    const current = byPid.get(expected.pid);
    if (!current) continue;
    if (sameProcessIdentity(expected, current, false)) sawStillRunning = true;
    else sawUnknown = true;
  }
  if (sawUnknown) return "unknown";
  if (sawStillRunning) return "still-running";
  return "terminated";
}

export function signalOwnedProcessTree(
  descendants: readonly OwnedProcessIdentity[],
  signal: NodeJS.Signals,
  runtime: ProcessTreeRuntime = defaultProcessTreeRuntime,
  requireParent = true,
): OwnedProcessTreeState | undefined {
  if (runtime.platform !== "darwin") return undefined;
  const table = runtime.listProcesses?.();
  if (!table || !runtime.killPid) return "unknown";
  const byPid = new Map(table.map((row) => [row.pid, row]));
  let uncertain = false;

  for (const expected of descendants) {
    const current = byPid.get(expected.pid);
    if (!current) continue;
    if (!sameProcessIdentity(expected, current, requireParent)) {
      uncertain = true;
      continue;
    }
    try {
      runtime.killPid(expected.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") uncertain = true;
    }
  }

  const state = inspectOwnedProcessTree(descendants, runtime);
  if (uncertain && state !== "terminated") return "unknown";
  return state;
}

export function terminateProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals,
  detached: boolean,
  runtime: ProcessTreeRuntime = defaultProcessTreeRuntime,
): ProcessTreeTerminationReceipt {
  const rootPid = child.pid;
  const supported = runtime.platform === "darwin" && Boolean(rootPid);
  const captured = rootPid
    ? captureDarwinDescendants(rootPid, runtime)
    : { captureComplete: supported, descendants: [] };

  let state: OwnedProcessTreeState | undefined;
  if (supported) {
    state = captured.captureComplete
      ? signalOwnedProcessTree(captured.descendants, signal, runtime) ?? "unknown"
      : "unknown";
  }

  if (runtime.platform === "win32" && rootPid) {
    if (runtime.killWindowsTree(rootPid)) {
      return {
        supported: false,
        captureComplete: false,
        descendants: [],
      };
    }
  } else if (detached && rootPid) {
    try {
      runtime.killGroup(rootPid, signal);
      return {
        supported,
        captureComplete: captured.captureComplete,
        descendants: captured.descendants,
        ...(supported ? { state: inspectOwnedProcessTree(captured.descendants, runtime) ?? state ?? "unknown" } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return {
          supported,
          captureComplete: captured.captureComplete,
          descendants: captured.descendants,
          ...(supported ? { state: inspectOwnedProcessTree(captured.descendants, runtime) ?? state ?? "unknown" } : {}),
        };
      }
    }
  }

  child.kill(signal);
  return {
    supported,
    captureComplete: captured.captureComplete,
    descendants: captured.descendants,
    ...(supported ? { state: inspectOwnedProcessTree(captured.descendants, runtime) ?? state ?? "unknown" } : {}),
  };
}
