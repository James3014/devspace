import { after } from "node:test";
import { dirname, join, resolve } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, rmSync, rmdirSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { ProcessSessionManager } from "./process-sessions.js";

if (process.platform !== "win32") {
  await import("./codex-goal-sessions.test.js");
} else {
  const require = createRequire(import.meta.url);
  const fsModule = require("node:fs") as any;
  const pathModule = require("node:path") as any;
  const childProcessModule = require("node:child_process") as any;
  const originalWriteFileSync = fsModule.writeFileSync;
  const originalJoin = pathModule.join;
  const originalFork = childProcessModule.fork;
  const originalStart = ProcessSessionManager.prototype.start;
  const originalTerminate = ProcessSessionManager.prototype.terminate;
  const originalShutdown = ProcessSessionManager.prototype.shutdown;
  const originalProcessKill = process.kill;
  const fsyncProbeDir = mkdtempSync(join(tmpdir(), "devspace-windows-dir-fsync-"));
  const fsyncProbeFile = join(fsyncProbeDir, "probe-file");
  const probeDirectory = (phase: "empty" | "populated") => {
    for (const flags of ["r", "r+"] as const) {
      let descriptor: number | undefined;
      let result = "ok";
      let errorCode: string | undefined;
      try {
        descriptor = openSync(fsyncProbeDir, flags);
      } catch (error) {
        result = "open-error";
        errorCode = (error as NodeJS.ErrnoException).code;
      }
      if (descriptor !== undefined) {
        try {
          fsyncSync(descriptor);
        } catch (error) {
          result = "fsync-error";
          errorCode = (error as NodeJS.ErrnoException).code;
        } finally {
          try {
            closeSync(descriptor);
          } catch (error) {
            if (result === "ok") {
              result = "close-error";
              errorCode = (error as NodeJS.ErrnoException).code;
            }
          }
        }
      }
      console.error(
        `[windows-directory-fsync] phase=${phase} flags=${flags} result=${result}${errorCode ? ` errorCode=${errorCode}` : ""}`,
      );
    }
  };
  try {
    console.error(`[windows-directory-fsync] runtime=node${process.version} uv=${process.versions.uv}`);
    probeDirectory("empty");
    let descriptor: number | undefined;
    let result = "ok";
    let errorCode: string | undefined;
    try {
      descriptor = openSync(fsyncProbeFile, "wx");
    } catch (error) {
      result = "file-open-error";
      errorCode = (error as NodeJS.ErrnoException).code;
    }
    if (descriptor !== undefined && result === "ok") {
      try {
        writeSync(descriptor, "probe\n");
      } catch (error) {
        result = "file-write-error";
        errorCode = (error as NodeJS.ErrnoException).code;
      }
    }
    if (descriptor !== undefined && result === "ok") {
      try {
        fsyncSync(descriptor);
      } catch (error) {
        result = "file-fsync-error";
        errorCode = (error as NodeJS.ErrnoException).code;
      }
    }
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        if (result === "ok") {
          result = "file-close-error";
          errorCode = (error as NodeJS.ErrnoException).code;
        }
      }
    }
    console.error(
      `[windows-directory-fsync] phase=file flags=wx result=${result}${errorCode ? ` errorCode=${errorCode}` : ""}`,
    );
    probeDirectory("populated");
  } finally {
    rmSync(fsyncProbeFile, { force: true });
    rmdirSync(fsyncProbeDir);
  }
  const uncaughtExceptionMonitor = (error: Error, origin: string) => {
    console.error("[codex-goal-ci-diagnostic] uncaughtExceptionMonitor", { pid: process.pid, origin, error: error.stack ?? error.message });
  };
  const exitObserver = (code: number) => {
    console.error("[codex-goal-ci-diagnostic] exit", { pid: process.pid, code });
  };
  console.error("[codex-goal-ci-diagnostic] parent", { pid: process.pid, parentPid: process.ppid });
  process.on("uncaughtExceptionMonitor", uncaughtExceptionMonitor);
  process.on("exit", exitObserver);
  (process as any).kill = ((targetPid: number, signal?: NodeJS.Signals | number) => {
    console.error("[codex-goal-ci-diagnostic] process.kill", { selfPid: process.pid, targetPid, signal });
    return signal === undefined
      ? originalProcessKill.call(process, targetPid)
      : originalProcessKill.call(process, targetPid, signal);
  }) as typeof process.kill;
  childProcessModule.fork = function (this: unknown, modulePath: unknown, args?: unknown[], ...rest: unknown[]) {
    const helper = typeof modulePath === "string" && /[\\/]conpty_console_list_agent(?:\.js)?$/.test(modulePath);
    if (!helper) return originalFork.call(this, modulePath, args, ...rest);
    const targetPid = typeof args?.[0] === "string" && args[0].length > 0 && args[0].split("").every((character) => character >= "0" && character <= "9") ? Number(args[0]) : undefined;
    console.error("[codex-goal-ci-diagnostic] conpty fork", { modulePath, targetPid, pid: process.pid });
    const child = originalFork.call(this, modulePath, args, ...rest);
    console.error("[codex-goal-ci-diagnostic] conpty forked", { modulePath, childPid: child.pid, parentPid: process.pid });
    child.on("message", (message: unknown) => {
      const list = (message as { consoleProcessList?: unknown } | null)?.consoleProcessList;
      if (Array.isArray(list) && list.every((pid): pid is number => typeof pid === "number")) {
        console.error("[codex-goal-ci-diagnostic] conpty consoleProcessList", { childPid: child.pid, consoleProcessList: list });
      }
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      console.error("[codex-goal-ci-diagnostic] conpty fork exit", { childPid: child.pid, code, signal });
    });
    return child;
  };
  ProcessSessionManager.prototype.terminate = function (this: ProcessSessionManager, ...args: unknown[]) {
    console.error("[codex-goal-ci-diagnostic] manager.terminate", { pid: process.pid, args });
    return originalTerminate.apply(this, args as never);
  } as typeof ProcessSessionManager.prototype.terminate;
  ProcessSessionManager.prototype.shutdown = function (this: ProcessSessionManager, ...args: unknown[]) {
    console.error("[codex-goal-ci-diagnostic] manager.shutdown", { pid: process.pid, args });
    return originalShutdown.apply(this, args as never);
  } as typeof ProcessSessionManager.prototype.shutdown;
  syncBuiltinESMExports();

  // The upstream fixture is an extensionless shebang script. Windows ConPTY
  // requires a native executable, so retain the same JS fake TUI as a sidecar
  // and translate only that test executable to the real Node binary.
  fsModule.writeFileSync = ((path: unknown, data: unknown, options?: unknown) => {
    originalWriteFileSync(path, data, options);
    if (typeof path === "string" && /[\\/]codex-fake$/.test(path)) {
      originalWriteFileSync(`${path}.cjs`, data, options);
    }
  }) as typeof fsModule.writeFileSync;

  // One resolver unit explicitly simulates Linux but hard-codes ':' in the
  // synthetic PATH. On a Windows host, adapt only that marker-bearing join so
  // the test continues to exercise the intended Linux lookup contract.
  pathModule.join = ((...parts: string[]) => {
    if (parts.length === 2 && parts[1] === "codex") {
      const directory = parts[0] ?? "";
      const syntheticSuffix = ":whatever";
      if (directory.includes("devspace-goals-bin-") && directory.endsWith(syntheticSuffix)) {
        return originalJoin(directory.slice(0, -syntheticSuffix.length), "codex");
      }
    }
    return originalJoin(...parts);
  }) as typeof pathModule.join;

  syncBuiltinESMExports();

  ProcessSessionManager.prototype.start = function (input) {
    if (input.tty && input.executable && /[\\/]codex-fake$/.test(input.executable)) {
      return originalStart.call(this, {
        ...input,
        command: process.execPath,
        executable: process.execPath,
        args: [`${input.executable}.cjs`, ...(input.args ?? [])],
      });
    }
    return originalStart.call(this, input);
  };

  // The PTY-unavailable negative test needs only a path that passes executable
  // validation before its injected backend throws. Preserve its original
  // `/bin/echo` input without requiring a POSIX filesystem on Windows.
  const echoFixture = resolve("/bin/echo");
  const echoFixtureDir = dirname(echoFixture);
  const createdEchoDir = !existsSync(echoFixtureDir);
  const createdEchoFixture = !existsSync(echoFixture);
  if (createdEchoDir) mkdirSync(echoFixtureDir, { recursive: true });
  if (createdEchoFixture) originalWriteFileSync(echoFixture, "windows-test-executable-placeholder\n");

  // Import registers node:test cases but does not await their execution. Keep
  // the Windows adapters alive until every registered test has completed.
  after(() => {
    ProcessSessionManager.prototype.start = originalStart;
    ProcessSessionManager.prototype.terminate = originalTerminate;
    ProcessSessionManager.prototype.shutdown = originalShutdown;
    fsModule.writeFileSync = originalWriteFileSync;
    pathModule.join = originalJoin;
    childProcessModule.fork = originalFork;
    (process as any).kill = originalProcessKill;
    syncBuiltinESMExports();
    if (createdEchoFixture) rmSync(echoFixture, { force: true });
    if (createdEchoDir) rmSync(echoFixtureDir, { recursive: true, force: true });
  });
  await import("./codex-goal-sessions.test.js");
}
