import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { LocalAgentSessionManager, AgentSessionError, getWorkerProcessOwnership } from "./local-agent-sessions.js";
import { LocalAgentStore } from "./local-agent-store.js";
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

function settleAgent(
  manager: LocalAgentSessionManager,
  agentId: string,
  patch: {
    status?: "idle" | "error";
    latestResponse?: string;
    providerSessionId?: string;
    error?: string;
    terminalReason?: "completed" | "provider_error";
  } = {},
): void {
  const store = (manager as any).store as LocalAgentStore;
  const current = store.getById(agentId)!;
  const generation = current.lifecycleState!.activeTurn!.generation!;
  const workerToken = current.workerToken!;
  assert.equal(store.claimWorkerCAS(agentId, generation, workerToken, 39997).applied, true);
  assert.equal(store.finishTurnCAS({
    agentId,
    generation,
    workerToken,
    status: patch.status ?? "idle",
    terminalReason: patch.terminalReason ?? "completed",
    ...patch,
  }).applied, true);
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

test("LocalAgentSessionManager - idle timeout fences silent worker with idle_timeout", async () => {
  const { manager, spawnedWorkers, terminatedWorkers, clean } = setupFixture();
  try {
    const workspaceRoot = "/Users/jameschen/Workspace/nexus";
    const started = await manager.startAgent({
      workspaceId: "ws_idle",
      workspaceRoot,
      profileName: "reviewer",
      prompt: "silent worker",
      profiles: mockProfiles,
      executionContract: { idleTimeoutMs: 1 },
    });
    const store = (manager as any).store as LocalAgentStore;
    const generation = store.getById(started.agentId)!.lifecycleState!.activeTurn!.generation!;
    const token = spawnedWorkers[0]!.workerToken;
    store.claimWorkerCAS(started.agentId, generation, token, 4242);
    store.markExecutionStarted(started.agentId, token, new Date().toISOString(), generation);
    store.touchActivityCAS(started.agentId, generation, token, new Date(Date.now() - 100).toISOString());
    await manager.superviseActiveAgents();
    const result = manager.getRecordByPrefixOrId(started.agentId)!;
    assert.equal(result.status, "error");
    assert.equal(result.terminalReason, "idle_timeout");
    assert.equal(terminatedWorkers.length, 1);

    const active = await manager.startAgent({
      workspaceId: "ws_idle",
      workspaceRoot,
      profileName: "reviewer",
      prompt: "active worker",
      profiles: mockProfiles,
      executionContract: { idleTimeoutMs: 60_000 },
    });
    const activeRecord = store.getById(active.agentId)!;
    const activeGeneration = activeRecord.lifecycleState!.activeTurn!.generation!;
    const activeToken = spawnedWorkers[1]!.workerToken;
    store.claimWorkerCAS(active.agentId, activeGeneration, activeToken, 4243);
    store.touchActivityCAS(active.agentId, activeGeneration, activeToken);
    await manager.superviseActiveAgents();
    assert.equal(manager.getRecordByPrefixOrId(active.agentId)!.status, "running");
  } finally {
    clean();
  }
});

test("LocalAgentSessionManager - idle timeout does not apply during startup", async () => {
  const { manager, spawnedWorkers, terminatedWorkers, clean } = setupFixture();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_startup_idle",
      workspaceRoot: "/Users/jameschen/Workspace/nexus",
      profileName: "reviewer",
      prompt: "startup still pending",
      profiles: mockProfiles,
      executionContract: { idleTimeoutMs: 1, maxStartupMs: 60_000 },
    });
    const store = (manager as any).store as LocalAgentStore;
    const current = store.getById(started.agentId)!;
    const generation = current.lifecycleState!.activeTurn!.generation!;
    const token = spawnedWorkers[0]!.workerToken;
    store.claimWorkerCAS(started.agentId, generation, token, 4244);
    store.touchActivityCAS(started.agentId, generation, token, new Date(Date.now() - 100).toISOString());
    await manager.superviseActiveAgents();
    assert.equal(manager.getRecordByPrefixOrId(started.agentId)!.status, "running");
    assert.equal(terminatedWorkers.length, 0);
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
    settleAgent(manager, record.agentId, {
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
    settleAgent(manager, record.agentId);
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
    settleAgent(manager, record.agentId, {
      status: "error",
      error: "API call timed out after 30s",
      terminalReason: "provider_error",
    });
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
    (manager as any).store.claimWorker(record.agentId, workerToken, 424242);
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
    (manager as any).store.claimWorker(record.agentId, workerToken, 9999999);

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
    (manager as any).store.claimWorker(record.agentId, workerToken, process.pid);

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

    const record2 = manager.createRecord({
      workspaceId: "ws_test",
      workspaceRoot,
      profileName: "nonexistent-profile",
      provider: "agy",
    });
    (manager as any).store.prepareWorker(record2.id, "error-cleanup-token");
    const tempDir2 = mkdtempSync(join(tmpdir(), "devspace-agent-prompt-"));
    const tempFile2 = join(tempDir2, "prompt.txt");
    writeFileSync(tempFile2, "fail this prompt", { mode: 0o600 });
    const activeRecord2 = manager.getRecordByPrefixOrId(record2.id);
    assert.ok(activeRecord2?.workerToken);
    await manager.runWorkerTurnFromFile(record2.id, tempFile2, activeRecord2.workerToken);
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
    settleAgent(manager, agentId);

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

test("runWorkerTurnFromFile persists typed AgentProviderFailureError details", async () => {
  const { stateDir, clean } = setupFixture();
  try {
    const { AgentProviderFailureError } = await import("./local-agent-errors.js");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const config = {
      stateDir,
      subagents: true,
      oauth: { scopes: ["devspace"] },
    } as any;

    const projectRoot = join(stateDir, "project");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(projectRoot, { recursive: true });

    const manager = new LocalAgentSessionManager(
      config,
      undefined,
      undefined,
      async () => {
        throw new AgentProviderFailureError({
          code: "CLINEPASS_ENTITLEMENT_REQUIRED",
          provider: "cline",
          errorClass: "ENTITLEMENT_REQUIRED",
          operation: "run",
          message: "No access to ClinePass subscription models",
          retryable: false,
          model: "cline-pass/glm-5.3-flash",
          variant: "high",
          providerSessionId: "sess-cline-live-1",
          providerMessage: "ClinePass entitlement required",
        });
      },
    );

    const store = (manager as any).store;
    const record = store.create({
      workspaceId: "ws_typed_err",
      workspaceRoot: projectRoot,
      profileName: "cline-test",
      provider: "cline",
      lifecycleKind: "detached_worker_v2",
    });
    const token = "worker-token-test";
    store.prepareWorker(record.id, token);

    const promptFile = join(config.stateDir, `prompt-${record.id}.json`);
    writeFileSync(promptFile, JSON.stringify({ prompt: "test prompt" }));

    await manager.runWorkerTurnFromFile(record.id, promptFile, token);

    const updated = store.getById(record.id)!;
    assert.equal(updated.status, "error");
    assert.equal(updated.errorCode, "CLINEPASS_ENTITLEMENT_REQUIRED");
    assert.equal(updated.errorRetryable, false);
    assert.equal(updated.terminalReason, "provider_error");
    assert.deepEqual(updated.errorDetails, {
      code: "CLINEPASS_ENTITLEMENT_REQUIRED",
      errorClass: "ENTITLEMENT_REQUIRED",
      retryable: false,
      model: "cline-pass/glm-5.3-flash",
      variant: "high",
      providerSessionId: "sess-cline-live-1",
      providerMessage: "ClinePass entitlement required",
    });
  } finally {
    clean();
  }
});
