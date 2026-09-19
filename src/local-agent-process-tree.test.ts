import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { LocalAgentSessionManager } from "./local-agent-sessions.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";

const originalAgyCommand = process.env.AGY_COMMAND;
process.env.AGY_COMMAND = process.execPath;

after(() => {
  if (originalAgyCommand === undefined) delete process.env.AGY_COMMAND;
  else process.env.AGY_COMMAND = originalAgyCommand;
});

const profiles: LocalAgentProfile[] = [{
  name: "process-tree-reviewer",
  description: "macOS process-tree cleanup witness",
  provider: "agy",
  disabled: false,
  filePath: "process-tree-reviewer.md",
  body: "reviewer prompt",
  write_mode: "read_only",
}];

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(path, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {}
    await sleep(25);
  }
  throw new Error(`Timed out waiting for process witness file ${path}`);
}

test("macOS local-agent default terminator cleans detached descendants without touching unrelated processes", {
  skip: process.platform !== "darwin",
}, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-agent-tree-state-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "devspace-agent-tree-workspace-"));
  const childPidPath = join(stateDir, "child.pid");
  const grandchildPidPath = join(stateDir, "grandchild.pid");
  const childScript = join(stateDir, "child.mjs");
  const workerScript = join(stateDir, "worker.mjs");

  writeFileSync(
    childScript,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });`,
      "grandchild.unref();",
      `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  writeFileSync(
    workerScript,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const child = spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );

  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  sentinel.unref();

  let workerPid = 0;
  let childPid = 0;
  let grandchildPid = 0;
  const manager = new LocalAgentSessionManager(
    { stateDir, subagents: true, oauth: { scopes: ["devspace"] } } as any,
    async (agentId, _promptFile, workerToken) => {
      const worker = spawn(
        process.execPath,
        [workerScript, "agents", "__worker", agentId, "--worker-token", workerToken],
        { detached: true, stdio: "ignore" },
      );
      worker.unref();
      workerPid = worker.pid!;
      return workerPid;
    },
  );

  try {
    const record = await manager.startAgent({
      workspaceId: "ws_tree_default_terminator",
      workspaceRoot,
      profileName: profiles[0]!.name,
      prompt: "physical process tree cancellation",
      profiles,
    });
    childPid = await waitForPid(childPidPath);
    grandchildPid = await waitForPid(grandchildPidPath);

    assert.equal(processAlive(workerPid), true);
    assert.equal(processAlive(childPid), true);
    assert.equal(processAlive(grandchildPid), true);
    assert.equal(processAlive(sentinel.pid!), true);

    const cancelled = await manager.cancelAgent({
      workspaceId: "ws_tree_default_terminator",
      workspaceRoot,
      agentId: record.agentId,
    });

    assert.equal(cancelled.terminal, true);
    assert.equal(cancelled.status, "stopped");
    assert.equal(processAlive(workerPid), false);
    assert.equal(processAlive(childPid), false);
    assert.equal(processAlive(grandchildPid), false, "detached grandchild must not survive a clean local-agent cancellation");
    assert.equal(processAlive(sentinel.pid!), true, "unrelated sentinel must remain alive");

    const reopened = manager.getRecordByPrefixOrId(record.agentId);
    assert.equal(reopened?.workerPid, undefined);
    assert.equal(reopened?.workerToken, undefined);
    assert.equal(reopened?.lifecycleState?.terminationPending, undefined);
  } finally {
    manager.close();
    for (const pid of [grandchildPid, childPid, workerPid, sentinel.pid ?? 0]) {
      if (pid <= 0) continue;
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    await sleep(50);
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
