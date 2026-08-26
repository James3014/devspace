import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { LocalAgentSessionManager, AgentSessionError, getWorkerProcessOwnership } from "./local-agent-sessions.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";

function setupFixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-agent-sessions-test-"));
  const config = {
    stateDir,
    subagents: true,
    oauth: { scopes: ["devspace"] },
  } as any;

  const spawnedWorkers: { agentId: string; promptFile: string; workerToken: string }[] = [];
  const terminatedWorkers: Array<{ id: string; workerPid?: number; workerToken?: string }> = [];
  let shouldLaunchFail = false;
  let launchErrorMsg = "Spawn failed error";

  const mockLauncher = async (agentId: string, promptFile: string, workerToken: string) => {
    if (shouldLaunchFail) {
      throw new Error(launchErrorMsg);
    }
    spawnedWorkers.push({ agentId, promptFile, workerToken });
  };
  const mockTerminator = async (record: any) => {
    terminatedWorkers.push({ id: record.id, workerPid: record.workerPid, workerToken: record.workerToken });
    return true;
  };

  const manager = new LocalAgentSessionManager(config, mockLauncher, mockTerminator);

  const clean = () => {
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {}
  };

  return {
    manager,
    spawnedWorkers,
    terminatedWorkers,
    clean,
    stateDir,
    setLaunchFail: (fail: boolean, msg = "Spawn failed error") => {
      shouldLaunchFail = fail;
      launchErrorMsg = msg;
    }
  };
}

const mockProfiles: LocalAgentProfile[] = [
  {
    name: "reviewer",
    description: "test",
    provider: "agy",
    disabled: false,
    filePath: "reviewer.md",
    body: "reviewer prompt",
    write_mode: "read_only",
  },
  {
    name: "implementer",
    description: "test",
    provider: "agy",
    disabled: false,
    filePath: "implementer.md",
    body: "implementer prompt",
    write_mode: "allowed",
  }
];

test("LocalAgentSessionManager - startAgent and PROVIDER_UNAVAILABLE", async () => {
  const { manager, spawnedWorkers, clean } = setupFixture();
  try {
    const workspaceRoot = "/Users/jameschen/Workspace/nexus";

    const startResult = await manager.startAgent({
      workspaceId: "ws_test",
      workspaceRoot,
      profileName: "reviewer",
      prompt: "hello review",
      profiles: mockProfiles,
    });

    assert.ok(startResult.agentId);
    assert.equal(startResult.status, "starting");
    assert.equal(startResult.profileName, "reviewer");
    assert.equal(startResult.provider, "agy");
    assert.equal(startResult.workspaceId, "ws_test");
    assert.equal(startResult.workspaceRoot, workspaceRoot);
    assert.equal(spawnedWorkers.length, 1);
    assert.equal(spawnedWorkers[0].agentId, startResult.agentId);
    assert.ok(spawnedWorkers[0].promptFile);

    try {
      rmSync(dirname(spawnedWorkers[0].promptFile), { recursive: true, force: true });
    } catch {}

    await assert.rejects(
      manager.startAgent({
        workspaceId: "ws_test",
        workspaceRoot,
        profileName: "invalid-profile",
        prompt: "hello",
        profiles: mockProfiles,
      }),
      (err: any) => {
        assert.equal(err.code, "UNKNOWN_PROFILE");
        return true;
      }
    );

    const badProfile: LocalAgentProfile = {
      name: "broken",
      description: "broken test",
      provider: "copilot",
      disabled: false,
      filePath: "broken.md",
      body: "",
    };
    // Availability is environment-derived; force copilot to resolve to a
    // missing executable so this rejection stays hermetic.
    const previousCopilotCommand = process.env.COPILOT_COMMAND;
    process.env.COPILOT_COMMAND = "/definitely/missing/devspace-copilot";

    await assert.rejects(
      manager.startAgent({
        workspaceId: "ws_test",
        workspaceRoot,
        profileName: "broken",
        prompt: "hello",
        profiles: [...mockProfiles, badProfile],
      }).finally(() => {
        if (previousCopilotCommand === undefined) delete process.env.COPILOT_COMMAND;
        else process.env.COPILOT_COMMAND = previousCopilotCommand;
      }),
      (err: any) => {
        assert.equal(err.code, "PROVIDER_UNAVAILABLE");
        return true;
      }
    );
  } finally {
    clean();
  }
});

test("LocalAgentSessionManager - continueAgent identity and validation", async () => {
  const { manager, spawnedWorkers, clean } = setupFixture();
  try {
    const workspaceRoot = "/Users/jameschen/Workspace/nexus";
    const record = await manager.startAgent({
      workspaceId: "ws_test",
      workspaceRoot,
      profileName: "reviewer",
      prompt: "hello 1",
      profiles: mockProfiles,
    });
    assert.equal(record.status, "starting");
    manager.updateRecord(record.agentId, {
      status: "idle",
      latestResponse: "done 1",
      providerSessionId: "provider-session-123"
    });
    const continueResult = await manager.continueAgent({
      workspaceId: "ws_test",
      workspaceRoot,
      agentId: record.agentId,
      prompt: "hello 2",
    });
    assert.equal(continueResult.agentId, record.agentId);
    assert.equal(continueResult.status, "starting");
    assert.equal(continueResult.continued, true);
    const list = manager.listAgents({ workspaceId: "ws_test" });
    assert.equal(list.length, 1);
    assert.equal(list[0].agentId, record.agentId);
    const recordInDb = manager.getRecordByPrefixOrId(record.agentId);
    assert.ok(recordInDb);
    assert.equal(recordInDb.providerSessionId, "provider-session-123");
    for (const w of spawnedWorkers) {
      try { rmSync(dirname(w.promptFile), { recursive: true, force: true }); } catch {}
    }
  } finally {
    clean();
  }
});

test("LocalAgentSessionManager - exact ID matching vs legacy prefix", async () => {
  const { manager, clean } = setupFixture();
  try {
    const workspaceRoot = "/Users/jameschen/Workspace/nexus";
    const record = await manager.startAgent({
      workspaceId: "ws_test",
      workspaceRoot,
      profileName: "reviewer",
      prompt: "hello 1",
      profiles: mockProfiles,
    });
    const exactId = record.agentId;
    const prefixId = exactId.slice(0, 7);
    await assert.rejects(
      manager.continueAgent({ workspaceId: "ws_test", workspaceRoot, agentId: prefixId, prompt: "hello prefix" }),
      (err: any) => { assert.equal(err.code, "UNKNOWN_AGENT"); return true; },
    );
    await assert.rejects(
      manager.getAgentStatus({ workspaceId: "ws_test", workspaceRoot, agentId: prefixId }),
      (err: any) => { assert.equal(err.code, "UNKNOWN_AGENT"); return true; },
    );
    const cliResolved = manager.getRecordByPrefixOrId(prefixId);
    assert.ok(cliResolved);
    assert.equal(cliResolved.id, exactId);
  } finally {
    clean();
  }
});

test("LocalAgentSessionManager - workspace boundary checks", async () => {
  const { manager, clean } = setupFixture();
  try {
    const workspaceRoot = "/Users/jameschen/Workspace/nexus";
    const record = await manager.startAgent({ workspaceId: "ws_test", workspaceRoot, profileName: "reviewer", prompt: "hello 1", profiles: mockProfiles });
    manager.updateRecord(record.agentId, { status: "idle" });
    await assert.rejects(
      manager.getAgentStatus({ workspaceId: "ws_test", workspaceRoot: "/other/physical/path", agentId: record.agentId }),
      (err: any) => { assert.equal(err.code, "AGENT_WORKSPACE_MISMATCH"); return true; },
    );
    await assert.rejects(
      manager.continueAgent({ workspaceId: "ws_test", workspaceRoot: "/other/physical/path", agentId: record.agentId, prompt: "continue with bad root" }),
      (err: any) => { assert.equal(err.code, "AGENT_WORKSPACE_MISMATCH"); return true; },
    );
    assert.equal(manager.listAgents({ workspaceId: "ws_test", workspaceRoot }).length, 1);
    assert.equal(manager.listAgents({ workspaceId: "ws_test", workspaceRoot: "/other/physical/path" }).length, 0);
  } finally {
    clean();
  }
});

test("LocalAgentSessionManager - recorded error state in status", async () => {
  const { manager, clean } = setupFixture();
  try {
    const workspaceRoot = "/Users/jameschen/Workspace/nexus";
    const record = await manager.startAgent({ workspaceId: "ws_test", workspaceRoot, profileName: "reviewer", prompt: "hello 1", profiles: mockProfiles });
    manager.updateRecord(record.agentId, { status: "error", error: "API call timed out after 30s" });
    const status = await manager.getAgentStatus({ workspaceId: "ws_test", workspaceRoot, agentId: record.agentId });
    assert.equal(status.status, "error");
    assert.equal(status.terminal, true);
    assert.equal(status.error, "API call timed out after 30s");
  } finally {
    clean();
  }
});

test("LocalAgentSessionManager - launch failure fail-closed behavior", async () => {
  const { manager, setLaunchFail, clean } = setupFixture();
  try {
    const workspaceRoot = "/Users/jameschen/Workspace/nexus";
    setLaunchFail(true, "Permission denied spawning worker process");
    await assert.rejects(
      manager.startAgent({ workspaceId: "ws_test", workspaceRoot, profileName: "reviewer", prompt: "hello launch failure test", profiles: mockProfiles }),
      (err: any) => { assert.equal(err.code, "WORKER_LAUNCH_FAILED"); assert.match(err.message, /Permission denied/); return true; },
    );
    const list = manager.listAgents({ workspaceId: "ws_test", workspaceRoot });
    assert.equal(list.length, 1);
    assert.equal(list[0].status, "error");
    const recordInDb = manager.getRecordByPrefixOrId(list[0].agentId);
    assert.ok(recordInDb);
    assert.match(recordInDb.error || "", /Permission denied/);
    manager.updateRecord(recordInDb.id, { status: "idle" });
    await assert.rejects(
      manager.continueAgent({ workspaceId: "ws_test", workspaceRoot, agentId: recordInDb.id, prompt: "continue launch failure test" }),
      (err: any) => { assert.equal(err.code, "WORKER_LAUNCH_FAILED"); return true; },
    );
    const recordAfterFailedContinue = manager.getRecordByPrefixOrId(recordInDb.id);
    assert.ok(recordAfterFailedContinue);
    assert.equal(recordAfterFailedContinue.status, "error");
  } finally {
    clean();
  }
});

test("LocalAgentSessionManager - cancel fences a starting worker before claim", async () => {
  const { manager, spawnedWorkers, terminatedWorkers, clean } = setupFixture();
  try {
    const workspaceRoot = "/Users/jameschen/Workspace/nexus";
    const record = await manager.startAgent({ workspaceId: "ws_test", workspaceRoot, profileName: "reviewer", prompt: "cancel before claim", profiles: mockProfiles });
    assert.equal(spawnedWorkers.length, 1);
    const workerToken = spawnedWorkers[0]!.workerToken;
    const cancelled = await manager.cancelAgent({ workspaceId: "ws_test", workspaceRoot, agentId: record.agentId });
    assert.equal(cancelled.status, "stopped");
    assert.equal(cancelled.terminal, true);
    assert.equal(terminatedWorkers.length, 1);
    const tempDir = mkdtempSync(join(tmpdir(), "devspace-agent-prompt-"));
    const tempFile = join(tempDir, "prompt.txt");
    writeFileSync(tempFile, "late worker", { mode: 0o600 });
    await manager.runWorkerTurnFromFile(record.agentId, tempFile, workerToken);
    assert.equal(manager.getRecordByPrefixOrId(record.agentId)?.status, "stopped");
    assert.equal(existsSync(tempFile), false);
  } finally {
    clean();
  }
});

test("LocalAgentSessionManager - cancel passes exact running worker ownership", async () => {
  const { manager, spawnedWorkers, terminatedWorkers, clean } = setupFixture();
  try {
    const workspaceRoot = "/Users/jameschen/Workspace/nexus";
    const record = await manager.startAgent({ workspaceId: "ws_test", workspaceRoot, profileName: "reviewer", prompt: "running cancel", profiles: mockProfiles });
    const workerToken = spawnedWorkers[0]!.workerToken;
    manager.updateRecord(record.agentId, { status: "running", workerPid: 424242, workerToken });
    const cancelled = await manager.cancelAgent({ workspaceId: "ws_test", workspaceRoot, agentId: record.agentId });
    assert.equal(cancelled.status, "stopped");
    assert.deepEqual(terminatedWorkers[0], { id: record.agentId, workerPid: 424242, workerToken });
    const current = manager.getRecordByPrefixOrId(record.agentId);
    assert.equal(current?.workerPid, undefined);
    assert.equal(current?.workerToken, undefined);
  } finally {
    clean();
  }
});

test("LocalAgentSessionManager - cancel with default terminator: absent PID succeeds", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-agent-sessions-test-"));
  const config = { stateDir, subagents: true, oauth: { scopes: ["devspace"] } } as any;
  const spawnedWorkers: { agentId: string; promptFile: string; workerToken: string }[] = [];
  const mockLauncher = async (agentId: string, promptFile: string, workerToken: string) => {
    spawnedWorkers.push({ agentId, promptFile, workerToken });
  };
  const manager = new LocalAgentSessionManager(config, mockLauncher);
  try {
    const workspaceRoot = "/Users/jameschen/Workspace/nexus";
    const record = await manager.startAgent({
      workspaceId: "ws_test",
      workspaceRoot,
      profileName: "reviewer",
      prompt: "absent test",
      profiles: mockProfiles,
    });
    const workerToken = spawnedWorkers[0]!.workerToken;
    manager.updateRecord(record.agentId, { status: "running", workerPid: 9999999, workerToken });

    const cancelled = await manager.cancelAgent({ workspaceId: "ws_test", workspaceRoot, agentId: record.agentId });
    assert.equal(cancelled.status, "stopped");
    assert.equal(cancelled.terminal, true);
    const inDb = manager.getRecordByPrefixOrId(record.agentId);
    assert.equal(inDb?.status, "stopped");
    assert.equal(inDb?.workerPid, undefined);
    assert.equal(inDb?.workerToken, undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("LocalAgentSessionManager - cancel with default terminator: foreign PID fails closed without signaling", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-agent-sessions-test-"));
  const config = { stateDir, subagents: true, oauth: { scopes: ["devspace"] } } as any;
  const spawnedWorkers: { agentId: string; promptFile: string; workerToken: string }[] = [];
  const mockLauncher = async (agentId: string, promptFile: string, workerToken: string) => {
    spawnedWorkers.push({ agentId, promptFile, workerToken });
  };
  const manager = new LocalAgentSessionManager(config, mockLauncher);
  try {
    const workspaceRoot = "/Users/jameschen/Workspace/nexus";
    const record = await manager.startAgent({
      workspaceId: "ws_test",
      workspaceRoot,
      profileName: "reviewer",
      prompt: "foreign test",
      profiles: mockProfiles,
    });
    const workerToken = spawnedWorkers[0]!.workerToken;
    manager.updateRecord(record.agentId, { status: "running", workerPid: process.pid, workerToken });

    await assert.rejects(
      manager.cancelAgent({ workspaceId: "ws_test", workspaceRoot, agentId: record.agentId }),
      (err: any) => {
        assert.equal(err.code, "WORKER_TERMINATION_FAILED");
        return true;
      },
    );

    const inDb = manager.getRecordByPrefixOrId(record.agentId);
    assert.equal(inDb?.status, "stopped");
    assert.match(inDb?.error ?? "", /could not be verified/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("getWorkerProcessOwnership - ownership inspection and platform branches", async () => {
  assert.equal(getWorkerProcessOwnership(9999999, "agt_test", "tok_test"), "absent");

  if (process.platform !== "win32") {
    assert.equal(getWorkerProcessOwnership(process.pid, "agt_test", "tok_test"), "foreign");
  }

  assert.equal(getWorkerProcessOwnership(process.pid, "agt_test", "tok_test", "win32"), "unknown");
  assert.equal(getWorkerProcessOwnership(9999999, "agt_test", "tok_test", "win32"), "absent");
});

test("LocalAgentSessionManager - prompt cleanup paths", async () => {
  const { manager, clean } = setupFixture();
  try {
    const workspaceRoot = "/Users/jameschen/Workspace/nexus";
    const record = await manager.startAgent({ workspaceId: "ws_test", workspaceRoot, profileName: "reviewer", prompt: "success prompt turn", profiles: mockProfiles });
    const activeRecord = manager.getRecordByPrefixOrId(record.agentId);
    assert.ok(activeRecord);
    const tempDir = mkdtempSync(join(tmpdir(), "devspace-agent-prompt-"));
    const tempFile = join(tempDir, "prompt.txt");
    writeFileSync(tempFile, "run this prompt", { mode: 0o600 });
    assert.ok(existsSync(tempFile));
    await manager.runWorkerTurnFromFile(record.agentId, tempFile, activeRecord.workerToken!);
    assert.equal(existsSync(tempFile), false);
    assert.equal(existsSync(tempDir), false);

    const record2 = await manager.startAgent({ workspaceId: "ws_test", workspaceRoot, profileName: "reviewer", prompt: "error prompt turn", profiles: mockProfiles });
    const tempDir2 = mkdtempSync(join(tmpdir(), "devspace-agent-prompt-"));
    const tempFile2 = join(tempDir2, "prompt.txt");
    writeFileSync(tempFile2, "fail this prompt", { mode: 0o600 });
    manager.updateRecord(record2.agentId, { profileName: "nonexistent-profile" });
    const activeRecord2 = manager.getRecordByPrefixOrId(record2.agentId);
    assert.ok(activeRecord2?.workerToken);
    await manager.runWorkerTurnFromFile(record2.agentId, tempFile2, activeRecord2.workerToken);
    assert.equal(existsSync(tempFile2), false);
    assert.equal(existsSync(tempDir2), false);

    const safeFile = join(tmpdir(), "arbitrary.txt");
    writeFileSync(safeFile, "keep me safe", { mode: 0o600 });
    const record3 = await manager.startAgent({ workspaceId: "ws_test", workspaceRoot, profileName: "reviewer", prompt: "unowned check", profiles: mockProfiles });
    const activeRecord3 = manager.getRecordByPrefixOrId(record3.agentId);
    assert.ok(activeRecord3?.workerToken);
    await manager.runWorkerTurnFromFile(record3.agentId, safeFile, activeRecord3.workerToken);
    assert.ok(existsSync(safeFile));
    try { rmSync(safeFile, { force: true }); } catch {}
  } finally {
    clean();
  }
});

test("LocalAgentSessionManager - Cross-conversation recovery regression", async () => {
  const { manager, clean } = setupFixture();
  try {
    const workspaceRoot = "/Users/jameschen/Workspace/nexus";
    const startResult = await manager.startAgent({
      workspaceId: "ws_A",
      workspaceRoot,
      profileName: "reviewer",
      prompt: "cross-convo recovery test",
      profiles: mockProfiles,
    });
    const agentId = startResult.agentId;

    // A. Same physical checkout, different workspaceIds (ws_A and ws_B)
    // ws_B can list the agent
    const wsBList = manager.listAgents({ workspaceId: "ws_B", workspaceRoot });
    assert.equal(wsBList.length, 1);
    assert.equal(wsBList[0].agentId, agentId);

    // ws_B can check status
    const statusB = await manager.getAgentStatus({ workspaceId: "ws_B", workspaceRoot, agentId });
    assert.equal(statusB.status, "starting");

    // Set status to idle so we can continue it
    manager.updateRecord(agentId, { status: "idle" });

    // ws_B can continue it
    const continueB = await manager.continueAgent({
      workspaceId: "ws_B",
      workspaceRoot,
      agentId,
      prompt: "continue prompt",
    });
    assert.equal(continueB.status, "starting");
    assert.equal(continueB.continued, true);

    // Verify workspaceId remains ws_A (original provenance preserved)
    const currentRecord = manager.getRecordByPrefixOrId(agentId);
    assert.ok(currentRecord);
    assert.equal(currentRecord.workspaceId, "ws_A");

    // ws_B can cancel it
    const cancelB = await manager.cancelAgent({ workspaceId: "ws_B", workspaceRoot, agentId });
    assert.equal(cancelB.status, "stopped");

    // B. Different workspace Root rejects (ws_C -> /other-project)
    const otherRoot = "/Users/jameschen/Workspace/other-project";

    // list does not expose it
    const wsCList = manager.listAgents({ workspaceId: "ws_C", workspaceRoot: otherRoot });
    assert.equal(wsCList.length, 0);

    // status rejects
    await assert.rejects(
      manager.getAgentStatus({ workspaceId: "ws_C", workspaceRoot: otherRoot, agentId }),
      (err: any) => { assert.equal(err.code, "AGENT_WORKSPACE_MISMATCH"); return true; }
    );

    // continue rejects
    await assert.rejects(
      manager.continueAgent({ workspaceId: "ws_C", workspaceRoot: otherRoot, agentId, prompt: "rejected continue" }),
      (err: any) => { assert.equal(err.code, "AGENT_WORKSPACE_MISMATCH"); return true; }
    );

    // cancel rejects
    await assert.rejects(
      manager.cancelAgent({ workspaceId: "ws_C", workspaceRoot: otherRoot, agentId }),
      (err: any) => { assert.equal(err.code, "AGENT_WORKSPACE_MISMATCH"); return true; }
    );

    // C. Separate worktrees: ws_W1 -> /managed-worktrees/w1 vs ws_W2 -> /managed-worktrees/w2
    const w1Root = "/managed-worktrees/w1";
    const w2Root = "/managed-worktrees/w2";

    const startW1 = await manager.startAgent({
      workspaceId: "ws_W1",
      workspaceRoot: w1Root,
      profileName: "reviewer",
      prompt: "w1 test",
      profiles: mockProfiles,
    });

    // W2 should not be able to list, status, continue, or cancel W1
    const w2List = manager.listAgents({ workspaceId: "ws_W2", workspaceRoot: w2Root });
    assert.ok(!w2List.some(a => a.agentId === startW1.agentId));

    await assert.rejects(
      manager.getAgentStatus({ workspaceId: "ws_W2", workspaceRoot: w2Root, agentId: startW1.agentId }),
      (err: any) => { assert.equal(err.code, "AGENT_WORKSPACE_MISMATCH"); return true; }
    );

    await assert.rejects(
      manager.continueAgent({ workspaceId: "ws_W2", workspaceRoot: w2Root, agentId: startW1.agentId, prompt: "w2 rejected continue" }),
      (err: any) => { assert.equal(err.code, "AGENT_WORKSPACE_MISMATCH"); return true; }
    );

    await assert.rejects(
      manager.cancelAgent({ workspaceId: "ws_W2", workspaceRoot: w2Root, agentId: startW1.agentId }),
      (err: any) => { assert.equal(err.code, "AGENT_WORKSPACE_MISMATCH"); return true; }
    );

  } finally {
    clean();
  }
});
