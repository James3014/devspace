import { after } from "node:test";
import { dirname, resolve } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { ProcessSessionManager } from "./process-sessions.js";

if (process.platform !== "win32") {
  await import("./codex-goal-sessions.test.js");
} else {
  const require = createRequire(import.meta.url);
  const fsModule = require("node:fs") as any;
  const pathModule = require("node:path") as any;
  const originalWriteFileSync = fsModule.writeFileSync;
  const originalJoin = pathModule.join;
  const originalStart = ProcessSessionManager.prototype.start;
  const originalProcessKill = process.kill;
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
    fsModule.writeFileSync = originalWriteFileSync;
    pathModule.join = originalJoin;
    (process as any).kill = originalProcessKill;
    process.removeListener("uncaughtExceptionMonitor", uncaughtExceptionMonitor);
    process.removeListener("exit", exitObserver);
    syncBuiltinESMExports();
    if (createdEchoFixture) rmSync(echoFixture, { force: true });
    if (createdEchoDir) rmSync(echoFixtureDir, { recursive: true, force: true });
  });
  await import("./codex-goal-sessions.test.js");
}
