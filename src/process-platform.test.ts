import assert from "node:assert/strict";
import {
  inspectOwnedProcessTree,
  resolveShellCommand,
  signalOwnedProcessTree,
  terminateProcessTree,
  type OwnedProcessIdentity,
} from "./process-platform.js";

assert.deepEqual(resolveShellCommand("echo ok", "win32", { ComSpec: "C:\\Windows\\cmd.exe" }), {
  executable: "C:\\Windows\\cmd.exe",
  args: ["/d", "/s", "/c", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "darwin", { SHELL: "/bin/zsh" }), {
  executable: "/bin/zsh",
  args: ["-lc", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "linux", { SHELL: "/bin/dash" }), {
  executable: "/bin/dash",
  args: ["-c", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "linux", { SHELL: "/usr/bin/fish" }), {
  executable: "/bin/sh",
  args: ["-c", "echo ok"],
});

const windowsCalls: string[] = [];
terminateProcessTree(
  { pid: 42, kill: (signal) => (windowsCalls.push(`child:${signal}`), true) },
  "SIGTERM",
  false,
  {
    platform: "win32",
    killGroup: () => undefined,
    killWindowsTree: (pid) => (windowsCalls.push(`tree:${pid}`), true),
  },
);
assert.deepEqual(windowsCalls, ["tree:42"]);

const posixCalls: string[] = [];
terminateProcessTree(
  { pid: 43, kill: (signal) => (posixCalls.push(`child:${signal}`), true) },
  "SIGINT",
  true,
  {
    platform: "darwin",
    killGroup: (pid, signal) => posixCalls.push(`group:${pid}:${signal}`),
    killWindowsTree: () => false,
  },
);
assert.deepEqual(posixCalls, ["group:43:SIGINT"]);

const fallbackCalls: string[] = [];
terminateProcessTree(
  { pid: 44, kill: (signal) => (fallbackCalls.push(`child:${signal}`), true) },
  "SIGTERM",
  false,
  {
    platform: "linux",
    killGroup: () => undefined,
    killWindowsTree: () => false,
  },
);
assert.deepEqual(fallbackCalls, ["child:SIGTERM"]);


{
  const owned: OwnedProcessIdentity = {
    pid: 101,
    ppid: 100,
    pgid: 100,
    startTime: "Sat Sep 19 17:40:00 2026",
    command: "/usr/bin/node owned-child.mjs",
  };
  const unrelated: OwnedProcessIdentity = {
    pid: 999,
    ppid: 1,
    pgid: 999,
    startTime: "Sat Sep 19 17:39:00 2026",
    command: "/usr/bin/node unrelated.mjs",
  };
  let table = [owned, unrelated];
  const signals: string[] = [];
  const runtime = {
    platform: "darwin" as NodeJS.Platform,
    killGroup: () => undefined,
    killPid: (pid: number, signal: NodeJS.Signals) => {
      signals.push(`${pid}:${signal}`);
      table = table.filter((row) => row.pid !== pid);
    },
    killWindowsTree: () => false,
    listProcesses: () => [...table],
  };

  assert.equal(inspectOwnedProcessTree([owned], runtime), "still-running");
  assert.equal(signalOwnedProcessTree([owned], "SIGTERM", runtime), "terminated");
  assert.deepEqual(signals, ["101:SIGTERM"]);
  assert.equal(table.some((row) => row.pid === unrelated.pid), true, "unrelated process must remain untouched");
}

{
  const original: OwnedProcessIdentity = {
    pid: 111,
    ppid: 100,
    pgid: 100,
    startTime: "Sat Sep 19 17:40:00 2026",
    command: "/usr/bin/node child.mjs",
  };
  const reused: OwnedProcessIdentity = {
    ...original,
    startTime: "Sat Sep 19 17:41:00 2026",
  };
  const signals: string[] = [];
  const runtime = {
    platform: "darwin" as NodeJS.Platform,
    killGroup: () => undefined,
    killPid: (pid: number, signal: NodeJS.Signals) => signals.push(`${pid}:${signal}`),
    killWindowsTree: () => false,
    listProcesses: () => [reused],
  };

  assert.equal(signalOwnedProcessTree([original], "SIGKILL", runtime), "unknown");
  assert.deepEqual(signals, [], "PID reuse with changed start identity must never be signalled");
}

{
  const child: OwnedProcessIdentity = {
    pid: 201,
    ppid: 200,
    pgid: 200,
    startTime: "Sat Sep 19 17:42:00 2026",
    command: "/usr/bin/node child.mjs",
  };
  const grandchild: OwnedProcessIdentity = {
    pid: 202,
    ppid: 201,
    pgid: 202,
    startTime: "Sat Sep 19 17:42:01 2026",
    command: "/usr/bin/node grandchild.mjs",
  };
  const unrelated: OwnedProcessIdentity = {
    pid: 299,
    ppid: 1,
    pgid: 299,
    startTime: "Sat Sep 19 17:42:02 2026",
    command: "/usr/bin/node sentinel.mjs",
  };
  let table = [child, grandchild, unrelated];
  const calls: string[] = [];
  const receipt = terminateProcessTree(
    { pid: 200, kill: (signal) => (calls.push(`root:${signal}`), true) },
    "SIGTERM",
    true,
    {
      platform: "darwin",
      killGroup: (pid, signal) => calls.push(`group:${pid}:${signal}`),
      killPid: (pid, signal) => {
        calls.push(`pid:${pid}:${signal}`);
        table = table.filter((row) => row.pid !== pid);
      },
      killWindowsTree: () => false,
      listProcesses: () => [...table],
    },
  );

  assert.equal(receipt.captureComplete, true);
  assert.equal(receipt.state, "terminated");
  assert.deepEqual(receipt.descendants.map((row) => row.pid), [202, 201]);
  assert.deepEqual(calls, ["pid:202:SIGTERM", "pid:201:SIGTERM", "group:200:SIGTERM"]);
  assert.equal(table.some((row) => row.pid === unrelated.pid), true, "recursive cleanup must not include unrelated processes");
}
