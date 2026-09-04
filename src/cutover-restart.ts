import { spawn, spawnSync } from "node:child_process";

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
  inspectLaunchdTarget?: (command: string, args: string[]) => { status: number | null; stdout: string };
  spawnDetached?: (command: string, args: string[]) => void;
}

const LAUNCHD_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Resolve a restart actuator only when this process is itself running as a
 * macOS launchd job. The caller cannot choose a label, command, path, PID, or
 * target domain; launchd supplies XPC_SERVICE_NAME and the current uid binds
 * the gui domain.
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

  const launchdTarget = `gui/${uid}/${serviceLabel}`;
  const pid = options.pid ?? process.pid;
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const inspectLaunchdTarget = options.inspectLaunchdTarget ?? ((command, args) => {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { status: result.status, stdout: result.stdout ?? "" };
  });
  const inspection = inspectLaunchdTarget("/bin/launchctl", ["print", launchdTarget]);
  if (inspection.status !== 0 || !launchdOutputOwnsPid(inspection.stdout, pid)) return undefined;

  const delayMs = options.delayMs ?? 750;
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const spawnDetached = options.spawnDetached ?? ((command, args) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.once("error", (error) => {
      console.error("devspace self-restart actuator failed", error);
    });
    child.unref();
  });

  return {
    actuator: "launchd-self",
    serviceLabel,
    launchdTarget,
    schedule(): SelfRestartReceipt {
      const timer = schedule(() => {
        spawnDetached("/bin/launchctl", ["kickstart", "-k", launchdTarget]);
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

function launchdOutputOwnsPid(output: string, pid: number): boolean {
  return output
    .split(/\r?\n/)
    .some((line) => new RegExp(`^\\s*pid\\s*=\\s*${pid}\\s*$`).test(line));
}
