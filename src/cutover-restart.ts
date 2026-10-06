import { spawn, spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CUTOVER_STABLE_LAUNCHER_RELATIVE_PATH } from "./cutover-activation.js";

export interface SelfRestartReceipt {
  scheduled: true;
  actuator: "launchd-self";
  serviceLabel: string;
  launchdTarget: string;
}

export interface SelfRestartActuator {
  readonly actuator: "launchd-self";
  readonly serviceLabel: string;
  readonly launchdTarget: string;
  schedule(): SelfRestartReceipt;
}

interface TimerHandle {
  unref?: () => unknown;
}

interface LaunchdSelfRestartOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  pid?: number;
  delayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  inspectLaunchdTarget?: (
    command: string,
    args: string[],
  ) => { status: number | null; stdout: string };
  spawnDetached?: (command: string, args: string[]) => void;
  expectedStableServiceRoot?: string;
  verifyActivation?: () => void;
  onError?: (error: Error) => void;
}

const LAUNCHD_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface BoundLaunchdRestartOptions {
  platform?: NodeJS.Platform;
  uid?: number;
  livePid: number;
  serviceLabel: string;
  launchdTarget: string;
  delayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  inspectLaunchdTarget?: (
    command: string,
    args: string[],
  ) => { status: number | null; stdout: string };
  spawnDetached?: (command: string, args: string[]) => void;
  onError?: (error: Error) => void;
  expectedStableServiceRoot?: string;
  verifyActivation?: () => void;
}

export interface StableLaunchdServiceBinding {
  serviceRoot: string;
  program: string;
  arguments: string[];
  pid: number;
}

export interface InspectStableLaunchdServiceOptions {
  platform?: NodeJS.Platform;
  uid?: number;
  livePid: number;
  serviceLabel: string;
  launchdTarget: string;
  inspectLaunchdTarget?: (
    command: string,
    args: string[],
  ) => { status: number | null; stdout: string };
}

/**
 * Host-local restart actuator for an already-approved cutover. The physical
 * launchd job is re-read before the deferred kickstart. When a stable service
 * root is supplied, the loaded job must resolve through dist/service-launcher.js
 * in that exact root rather than a per-release dist/cli.js checkout.
 */
export function createBoundLaunchdRestartActuator(
  options: BoundLaunchdRestartOptions,
): SelfRestartActuator | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return undefined;
  if (
    !options.serviceLabel ||
    options.serviceLabel === "0" ||
    options.serviceLabel === "(null)" ||
    !LAUNCHD_LABEL.test(options.serviceLabel)
  ) return undefined;

  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid) || (uid ?? -1) < 0) return undefined;
  if (!Number.isInteger(options.livePid) || options.livePid <= 0) return undefined;

  const expectedTarget = "gui/" + uid + "/" + options.serviceLabel;
  if (options.launchdTarget !== expectedTarget) return undefined;

  const inspectLaunchdTarget = options.inspectLaunchdTarget ?? defaultInspectLaunchdTarget;
  const ownsBoundPid = (): boolean => {
    const inspection = inspectLaunchdTarget("/bin/launchctl", ["print", expectedTarget]);
    if (
      inspection.status !== 0 ||
      !launchdOutputOwnsPid(inspection.stdout, options.livePid)
    ) return false;
    return options.expectedStableServiceRoot === undefined ||
      launchdOutputUsesStableLauncher(
        inspection.stdout,
        options.expectedStableServiceRoot,
        options.livePid,
      );
  };
  if (!ownsBoundPid()) return undefined;

  const delayMs = options.delayMs ?? 750;
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const spawnDetached = options.spawnDetached ?? defaultSpawnDetached(
    options.onError,
    "devspace bound restart actuator failed",
  );
  const onError = options.onError ?? ((error: Error) => {
    console.error("devspace bound restart actuator failed", error);
  });

  return {
    actuator: "launchd-self",
    serviceLabel: options.serviceLabel,
    launchdTarget: expectedTarget,
    schedule(): SelfRestartReceipt {
      schedule(() => {
        try {
          if (!ownsBoundPid()) {
            throw new Error(
              "Bound launchd service PID or stable launch binding changed before deferred restart.",
            );
          }
          options.verifyActivation?.();
          spawnDetached("/bin/launchctl", ["kickstart", "-k", expectedTarget]);
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      }, delayMs);
      return {
        scheduled: true,
        actuator: "launchd-self",
        serviceLabel: options.serviceLabel,
        launchdTarget: expectedTarget,
      };
    },
  };
}

/**
 * Resolve a self-restart actuator only when this process is itself owned by the
 * expected macOS launchd job. With expectedStableServiceRoot set, the loaded
 * launchd job must already use the canonical stable launcher.
 */
export function createLaunchdSelfRestartActuator(
  options: LaunchdSelfRestartOptions = {},
): SelfRestartActuator | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return undefined;

  const env = options.env ?? process.env;
  const serviceLabel = env.XPC_SERVICE_NAME;
  if (
    !serviceLabel ||
    serviceLabel === "0" ||
    serviceLabel === "(null)" ||
    !LAUNCHD_LABEL.test(serviceLabel)
  ) return undefined;

  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid) || (uid ?? -1) < 0) return undefined;
  const pid = options.pid ?? process.pid;
  if (!Number.isInteger(pid) || pid <= 0) return undefined;

  const launchdTarget = "gui/" + uid + "/" + serviceLabel;
  const inspectLaunchdTarget = options.inspectLaunchdTarget ?? defaultInspectLaunchdTarget;
  const ownsBoundPid = (): boolean => {
    const inspection = inspectLaunchdTarget("/bin/launchctl", ["print", launchdTarget]);
    if (inspection.status !== 0 || !launchdOutputOwnsPid(inspection.stdout, pid)) {
      return false;
    }
    return options.expectedStableServiceRoot === undefined ||
      launchdOutputUsesStableLauncher(
        inspection.stdout,
        options.expectedStableServiceRoot,
        pid,
      );
  };
  if (!ownsBoundPid()) return undefined;

  const delayMs = options.delayMs ?? 750;
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const spawnDetached = options.spawnDetached ?? defaultSpawnDetached(
    options.onError,
    "devspace self-restart actuator failed",
  );
  const onError = options.onError ?? ((error: Error) => {
    console.error("devspace self-restart actuator failed", error);
  });

  return {
    actuator: "launchd-self",
    serviceLabel,
    launchdTarget,
    schedule(): SelfRestartReceipt {
      const timer = schedule(() => {
        try {
          if (!ownsBoundPid()) {
            throw new Error(
              "Launchd service PID or stable launch binding changed before deferred restart.",
            );
          }
          options.verifyActivation?.();
          spawnDetached("/bin/launchctl", ["kickstart", "-k", launchdTarget]);
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      }, delayMs);
      timer.unref?.();
      return {
        scheduled: true,
        actuator: "launchd-self",
        serviceLabel,
        launchdTarget,
      };
    },
  };
}

export function inspectBoundStableLaunchdService(
  options: InspectStableLaunchdServiceOptions,
): StableLaunchdServiceBinding | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return undefined;
  if (!options.serviceLabel || !LAUNCHD_LABEL.test(options.serviceLabel)) return undefined;

  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid) || (uid ?? -1) < 0) return undefined;
  if (!Number.isInteger(options.livePid) || options.livePid <= 0) return undefined;

  const expectedTarget = "gui/" + uid + "/" + options.serviceLabel;
  if (options.launchdTarget !== expectedTarget) return undefined;

  const inspectLaunchdTarget = options.inspectLaunchdTarget ?? defaultInspectLaunchdTarget;
  const inspection = inspectLaunchdTarget("/bin/launchctl", ["print", expectedTarget]);
  if (inspection.status !== 0) return undefined;
  return parseStableLaunchdService(inspection.stdout, options.livePid);
}

function parseStableLaunchdService(
  output: string,
  livePid: number,
): StableLaunchdServiceBinding | undefined {
  if (!launchdOutputOwnsPid(output, livePid)) return undefined;

  const program = scalar(output.match(/^\s*program\s*=\s*(.+?)\s*$/m)?.[1]);
  const workingDirectory = scalar(
    output.match(/^\s*working directory\s*=\s*(.+?)\s*$/m)?.[1],
  );
  const argsBlock = output.match(
    /^\s*arguments\s*=\s*\{\s*\n([\s\S]*?)^\s*\}\s*$/m,
  )?.[1];
  if (!program || !workingDirectory || !argsBlock) return undefined;
  if (!isAbsolute(program) || !isAbsolute(workingDirectory)) return undefined;

  let serviceRoot: string;
  let actualProgram: string;
  try {
    const rootInfo = lstatSync(workingDirectory);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return undefined;
    serviceRoot = realpathSync.native(workingDirectory);
    actualProgram = realpathSync.native(program);
  } catch {
    return undefined;
  }

  let currentNode: string;
  try {
    currentNode = realpathSync.native(process.execPath);
  } catch {
    return undefined;
  }
  if (actualProgram !== currentNode) return undefined;

  const args = argsBlock
    .split(/\r?\n/)
    .map((line) => scalar(line))
    .filter((value): value is string => Boolean(value));
  if (args.length < 3) return undefined;

  let argProgram: string;
  try {
    argProgram = realpathSync.native(args[0]!);
  } catch {
    return undefined;
  }
  if (argProgram !== actualProgram || args[2] !== "serve") return undefined;

  const expectedLauncher = resolve(
    join(serviceRoot, CUTOVER_STABLE_LAUNCHER_RELATIVE_PATH),
  );
  const configuredLauncher = isAbsolute(args[1]!)
    ? resolve(args[1]!)
    : resolve(serviceRoot, args[1]!);
  if (configuredLauncher !== expectedLauncher) return undefined;

  try {
    const launcherInfo = lstatSync(expectedLauncher);
    if (!launcherInfo.isFile() || launcherInfo.isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }

  return {
    serviceRoot,
    program: actualProgram,
    arguments: args,
    pid: livePid,
  };
}

function launchdOutputUsesStableLauncher(
  output: string,
  expectedServiceRoot: string,
  livePid: number,
): boolean {
  const parsed = parseStableLaunchdService(output, livePid);
  if (!parsed) return false;
  try {
    return parsed.serviceRoot === realpathSync.native(expectedServiceRoot);
  } catch {
    return false;
  }
}

function scalar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    trimmed.startsWith('"') &&
    trimmed.endsWith('"')
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function defaultInspectLaunchdTarget(
  command: string,
  args: string[],
): { status: number | null; stdout: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { status: result.status, stdout: result.stdout ?? "" };
}

function defaultSpawnDetached(
  onError: ((error: Error) => void) | undefined,
  label: string,
): (command: string, args: string[]) => void {
  return (command, args) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.once("error", (error) => {
      (onError ?? ((value) => console.error(label, value)))(error);
    });
    child.unref();
  };
}

function launchdOutputOwnsPid(output: string, pid: number): boolean {
  return output
    .split(/\r?\n/)
    .some((line) => new RegExp("^\\s*pid\\s*=\\s*" + pid + "\\s*$").test(line));
}
