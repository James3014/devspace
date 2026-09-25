import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test, { after } from "node:test";
import { LocalAgentSessionManager, AgentSessionError, getWorkerProcessOwnership } from "./local-agent-sessions.js";
import { LocalAgentStore } from "./local-agent-store.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";
import { type HerdrExternalHandle, type HerdrPromptResult, HerdrThinGateway, defaultHerdrGatewayRegistry } from "./local-agent-herdr.js";
import { hashDispatchIntent } from "./execution-protocol.js";
import { AgentProviderFailureError } from "./local-agent-errors.js";

const originalAgyCommand = process.env.AGY_COMMAND;
process.env.AGY_COMMAND = process.execPath;

after(() => {
  if (originalAgyCommand === undefined) delete process.env.AGY_COMMAND;
  else process.env.AGY_COMMAND = originalAgyCommand;
});

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

test("agent preflight and start persist the same host-bound execution generation", async () => {
  const { manager, spawnedWorkers, clean, stateDir } = setupFixture();
  try {
    manager.bindCapabilityManifestSha256("d".repeat(64));
    const workspaceRoot = stateDir;
    const preflight = await manager.preflightAgent({
      workspaceId: "ws_host_generation",
      workspaceRoot,
      isolated: true,
      profileName: "reviewer",
      profiles: mockProfiles,
    });
    const started = await manager.startAgent({
      workspaceId: "ws_host_generation",
      workspaceRoot,
      profileName: "reviewer",
      prompt: "host generation parity",
      profiles: mockProfiles,
    });
    const record = manager.getRecordByPrefixOrId(started.agentId);
    assert.ok(record?.executionGeneration);
    assert.ok(preflight.worker.executionGeneration);
    assert.equal(
      preflight.worker.executionGeneration.executionBindingHash,
      record.executionGeneration.executionBindingHash,
      "preflight and persisted execution must qualify the exact same generation",
    );
    assert.equal(
      preflight.worker.executionGeneration.hostGeneration?.hostGenerationHash,
      record.executionGeneration.hostGeneration?.hostGenerationHash,
    );
    assert.equal(
      record.executionGeneration.hostGeneration?.capabilityManifestSha256,
      "d".repeat(64),
    );
    assert.equal(record.executionGeneration.authReadiness, "UNKNOWN");

    if (spawnedWorkers[0]?.promptFile) {
      try { rmSync(dirname(spawnedWorkers[0].promptFile), { recursive: true, force: true }); } catch {}
    }
  } finally {
    manager.close();
    clean();
  }
});

test("direct provider/model identity survives durable worker reload without a disk profile", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-direct-state-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "devspace-direct-workspace-"));
  const devspaceAgentsDir = mkdtempSync(join(tmpdir(), "devspace-direct-agents-"));
  const spawnedWorkers: Array<{ agentId: string; promptFile: string; workerToken: string }> = [];
  let observedProfile: LocalAgentProfile | undefined;
  const config = { stateDir, devspaceAgentsDir, subagents: true, oauth: { scopes: ["devspace"] } } as any;
  let manager = new LocalAgentSessionManager(
    config,
    async (agentId: string, promptFile: string, workerToken: string) => {
      spawnedWorkers.push({ agentId, promptFile, workerToken });
    },
    async () => true,
    async (profile: LocalAgentProfile | undefined) => {
      assert.ok(profile);
      observedProfile = profile;
      return { provider: profile.provider, providerSessionId: null, finalResponse: "direct-ok", items: [] };
    },
  );
  try {
    const profileName = "__direct__agy__direct-model__high";
    const started = await manager.startAgent({
      workspaceId: "ws_direct",
      workspaceRoot,
      profileName,
      prompt: "read package metadata",
      executionContract: {
        directSelection: {
          provider: "agy",
          model: "direct-model",
          effort: "high",
          writeMode: "read_only",
        },
      },
      attemptKey: "direct-replay",
      profiles: [{
        name: profileName,
        description: "direct",
        provider: "agy",
        model: "direct-model",
        effort: "high",
        write_mode: "read_only",
        filePath: "<direct-dispatch>",
        body: "",
        disabled: false,
      }],
    });
    const launched = spawnedWorkers[0]!;
    manager.close();
    writeFileSync(join(devspaceAgentsDir, "collision.md"), [
      "---",
      `name: ${profileName}`,
      "description: collision",
      "provider: claude",
      "write_mode: allowed",
      "---",
      "must never shadow direct evidence",
    ].join("\n"));
    manager = new LocalAgentSessionManager(
      config,
      async (agentId: string, promptFile: string, workerToken: string) => {
        spawnedWorkers.push({ agentId, promptFile, workerToken });
      },
      async () => true,
      async (profile: LocalAgentProfile | undefined) => {
        assert.ok(profile);
        observedProfile = profile;
        return { provider: profile.provider, providerSessionId: "direct-session-1", finalResponse: "direct-ok", items: [] };
      },
    );
    const replayed = await manager.startAgent({
      workspaceId: "ws_direct",
      workspaceRoot,
      profileName,
      prompt: "read package metadata",
      attemptKey: "direct-replay",
      executionContract: {
        directSelection: { provider: "agy", model: "direct-model", effort: "high", writeMode: "read_only" },
      },
      profiles: [{
        name: profileName, description: "direct", provider: "agy", model: "direct-model", effort: "high",
        write_mode: "read_only", filePath: "<direct-dispatch>", body: "", disabled: false,
      }],
    });
    assert.equal(replayed.agentId, started.agentId);
    await manager.runWorkerTurnFromFile(started.agentId, launched.promptFile, launched.workerToken);
    assert.equal(observedProfile?.provider, "agy");
    assert.equal(observedProfile?.model, "direct-model");
    assert.equal(observedProfile?.effort, "high");
    assert.equal(observedProfile?.write_mode, "read_only");
    assert.equal(manager.getRecordByPrefixOrId(started.agentId)?.status, "idle");
    const continued = await manager.continueAgent({
      workspaceId: "ws_direct",
      workspaceRoot,
      agentId: started.agentId,
      prompt: "continue direct evidence",
    });
    const continuedLaunch = spawnedWorkers.at(-1)!;
    await manager.runWorkerTurnFromFile(continued.agentId, continuedLaunch.promptFile, continuedLaunch.workerToken);
    assert.equal(manager.getRecordByPrefixOrId(started.agentId)?.status, "idle");
  } finally {
    manager.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(devspaceAgentsDir, { recursive: true, force: true });
  }
});

test("LocalAgentSessionManager - effective idle policy fences silent worker and activity resets clock", async () => {
  const { manager, terminatedWorkers, clean } = setupFixture();
  try {
    const store = (manager as any).store as LocalAgentStore;
    const workspaceRoot = "/Users/jameschen/Workspace/nexus";
    const createRunning = (timeoutMs: number, pid: number) => {
      const record = store.create({
        workspaceId: "ws_idle",
        workspaceRoot,
        profileName: "synthetic-trustworthy",
        provider: "codex",
        executionContract: {},
        executionIdlePolicy: {
          source: "EXPLICIT_OVERRIDE",
          activityCapability: "TRUSTWORTHY",
          timeoutMs,
        },
        lifecycleKind: "detached_worker_v2",
      });
      const generation = record.lifecycleState!.activeTurn!.generation!;
      const token = `token-${pid}`;
      assert.equal(store.prepareWorkerCAS(record.id, generation, token).applied, true);
      assert.equal(store.claimWorkerCAS(record.id, generation, token, pid).applied, true);
      store.markExecutionStarted(record.id, token, new Date().toISOString(), generation);
      return { record, generation, token };
    };

    const silent = createRunning(1, 4242);
    store.touchActivityCAS(silent.record.id, silent.generation, silent.token, new Date(Date.now() - 100).toISOString());
    await manager.superviseActiveAgents();
    const result = manager.getRecordByPrefixOrId(silent.record.id)!;
    assert.equal(result.status, "error");
    assert.equal(result.terminalReason, "idle_timeout");
    assert.equal(terminatedWorkers.length, 1);

    const active = createRunning(60_000, 4243);
    store.touchActivityCAS(active.record.id, active.generation, active.token);
    await manager.superviseActiveAgents();
    assert.equal(manager.getRecordByPrefixOrId(active.record.id)!.status, "running");
  } finally {
    clean();
  }
});

test("LocalAgentSessionManager - effective idle timeout does not apply during startup", async () => {
  const { manager, terminatedWorkers, clean } = setupFixture();
  try {
    const store = (manager as any).store as LocalAgentStore;
    const record = store.create({
      workspaceId: "ws_startup_idle",
      workspaceRoot: "/Users/jameschen/Workspace/nexus",
      profileName: "synthetic-trustworthy",
      provider: "codex",
      executionContract: { maxStartupMs: 60_000 },
      executionIdlePolicy: {
        source: "EXPLICIT_OVERRIDE",
        activityCapability: "TRUSTWORTHY",
        timeoutMs: 1,
      },
      lifecycleKind: "detached_worker_v2",
    });
    const generation = record.lifecycleState!.activeTurn!.generation!;
    const token = "token-startup";
    assert.equal(store.prepareWorkerCAS(record.id, generation, token).applied, true);
    assert.equal(store.claimWorkerCAS(record.id, generation, token, 4244).applied, true);
    store.touchActivityCAS(record.id, generation, token, new Date(Date.now() - 100).toISOString());
    await manager.superviseActiveAgents();
    assert.equal(manager.getRecordByPrefixOrId(record.id)!.status, "running");
    assert.equal(terminatedWorkers.length, 0);
  } finally {
    clean();
  }
});

test("LocalAgentSessionManager - supervision leaves unrelated terminal rows untouched", async () => {
  const { manager, terminatedWorkers, clean } = setupFixture();
  try {
    const store = (manager as any).store as LocalAgentStore;
    const record = store.create({
      workspaceId: "ws_terminal_history",
      workspaceRoot: "/Users/jameschen/Workspace/nexus",
      profileName: "terminal-history",
      provider: "codex",
      executionContract: { maxWallMs: 1 },
      lifecycleKind: "detached_worker_v2",
    });
    const generation = record.lifecycleState!.activeTurn!.generation!;
    assert.equal(store.prepareWorkerCAS(record.id, generation, "terminal-history-token").applied, true);
    assert.equal(store.claimWorkerCAS(record.id, generation, "terminal-history-token", 4245).applied, true);
    assert.equal(store.finishTurnCAS({
      agentId: record.id,
      generation,
      workerToken: "terminal-history-token",
      status: "idle",
      terminalReason: "completed",
    }).applied, true);
    const before = store.getById(record.id)!;

    await manager.superviseActiveAgents();

    assert.deepEqual(store.getById(record.id), before);
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
      (err: any) => {
        assert.equal(err.code, "REBIND_REQUIRED");
        assert.match(err.message, /provider session identity/i);
        return true;
      },
    );
    const recordAfterFailedContinue = manager.getRecordByPrefixOrId(recordInDb.id);
    assert.ok(recordAfterFailedContinue);
    assert.equal(recordAfterFailedContinue.status, "error");
  } finally {
    clean();
  }
});

test("LocalAgentSessionManager - cancel reclaims an exact not-started turn without invoking a terminator", async () => {
  const { manager, terminatedWorkers, clean } = setupFixture();
  try {
    const workspaceRoot = "/Users/jameschen/Workspace/prelaunch";
    const store = (manager as any).store;
    const record = store.create({
      workspaceId: "ws_prelaunch",
      workspaceRoot,
      profileName: "reviewer",
      provider: "opencode",
      lifecycleKind: "detached_worker_v2",
    });
    const generation = record.lifecycleState?.activeTurn?.generation;
    assert.equal(record.lifecycleState?.activeTurn?.launchState, "not_started");
    assert.ok(generation);

    const cancelled = await manager.cancelAgent({
      workspaceId: "ws_prelaunch",
      workspaceRoot,
      agentId: record.id,
    });
    assert.equal(cancelled.status, "stopped");
    assert.equal(cancelled.terminal, true);
    assert.equal(terminatedWorkers.length, 0);
    const readback = store.getById(record.id);
    assert.equal(readback?.terminalReason, "cancelled");
    assert.equal(readback?.lifecycleState?.activeTurn, undefined);
    assert.equal(readback?.lifecycleState?.lastSettledGeneration, generation);

    const launching = store.create({
      workspaceId: "ws_prelaunch",
      workspaceRoot,
      profileName: "reviewer",
      provider: "opencode",
      lifecycleKind: "detached_worker_v2",
    });
    const launchingGeneration = launching.lifecycleState?.activeTurn?.generation;
    assert.ok(launchingGeneration);
    assert.equal(store.prepareWorkerCAS(launching.id, launchingGeneration, "owned-token").applied, true);
    assert.equal(
      store.cancelExternalRuntimePreLaunchCAS(launching.id, launchingGeneration).applied,
      false,
      "launching/token-bound turns must not use the pre-launch reclaim seam",
    );
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

    // Establish provider continuity so this test exercises cross-conversation reuse rather than rebind fencing.
    settleAgent(manager, agentId, { providerSessionId: "provider-session-cross-convo" });

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

test("runWorkerTurnFromFile persists generic AgentProviderError diagnostics", async () => {
  const { stateDir, clean } = setupFixture();
  try {
    const { AgentProviderExecutionError } = await import("./local-agent-errors.js");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");

    const config = {
      stateDir,
      subagents: true,
      oauth: { scopes: ["devspace"] },
    } as any;
    const projectRoot = join(stateDir, "project-generic-error");
    mkdirSync(projectRoot, { recursive: true });

    const manager = new LocalAgentSessionManager(
      config,
      undefined,
      undefined,
      async () => {
        throw new AgentProviderExecutionError({
          code: "PROVIDER_EXECUTION_ERROR",
          provider: "opencode",
          operation: "run",
          message: "OpenCode agent execution failed.",
          retryable: false,
          cause: new Error("provider runtime rejected request token=synthetic-secret-value-9f3a"),
        });
      },
    );

    const store = (manager as any).store;
    const record = store.create({
      workspaceId: "ws_generic_err",
      workspaceRoot: projectRoot,
      profileName: "opencode-test",
      provider: "opencode",
      lifecycleKind: "detached_worker_v2",
    });
    const token = "worker-token-generic-error";
    store.prepareWorker(record.id, token);
    const promptFile = join(config.stateDir, `prompt-${record.id}.json`);
    writeFileSync(promptFile, "test prompt");

    await manager.runWorkerTurnFromFile(record.id, promptFile, token);

    const updated = store.getById(record.id)!;
    assert.equal(updated.status, "error");
    assert.equal(updated.errorCode, "PROVIDER_EXECUTION_ERROR");
    assert.equal(updated.errorRetryable, false);
    assert.equal(updated.terminalReason, "provider_error");
    assert.deepEqual(updated.errorDetails, {
      code: "PROVIDER_EXECUTION_ERROR",
      errorClass: "PROVIDER_EXECUTION_ERROR",
      retryable: false,
      model: undefined,
      variant: undefined,
      providerSessionId: undefined,
      providerMessage: "Error: provider runtime rejected request token=[REDACTED]",
    });
  } finally {
    clean();
  }
});

test("runWorkerTurnFromFile redacts successful provider output before durable status readback", async () => {
  const { stateDir, clean } = setupFixture();
  try {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const config = { stateDir, subagents: true, oauth: { scopes: ["devspace"] } } as any;
    const projectRoot = join(stateDir, "project-success-redaction");
    mkdirSync(projectRoot, { recursive: true });
    const manager = new LocalAgentSessionManager(
      config,
      undefined,
      undefined,
      async () => ({
        provider: "codex",
        providerSessionId: "thread-redaction",
        finalResponse: "done Bearer synthetic-secret-value-9f3a",
        items: [],
      }),
    );
    const store = (manager as any).store;
    const record = store.create({
      workspaceId: "ws_success_redaction",
      workspaceRoot: projectRoot,
      profileName: "codex-test",
      provider: "codex",
      lifecycleKind: "detached_worker_v2",
    });
    const token = "worker-token-success-redaction";
    store.prepareWorker(record.id, token);
    const promptFile = join(config.stateDir, `prompt-${record.id}.json`);
    writeFileSync(promptFile, "test prompt");
    await manager.runWorkerTurnFromFile(record.id, promptFile, token);
    const updated = store.getById(record.id)!;
    assert.equal(updated.status, "idle");
    assert.equal(updated.latestResponse, "done Bearer [REDACTED]");
    assert.equal(updated.providerSessionId, "thread-redaction");
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
          providerMessage: "ClinePass entitlement required api_key=synthetic-secret-value-9f3a",
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
      providerMessage: "ClinePass entitlement required api_key=[REDACTED]",
    });

    assert.equal(manager.countAllAgentRecords(), 1);
  } finally {
    clean();
  }
});

test("LocalAgentSessionManager - binds and retrieves HerdrExternalHandle for durable attempt records", async () => {
  const { manager, clean } = setupFixture();
  const projectRoot = mkdtempSync(join(tmpdir(), "devspace-herdr-session-test-"));

  try {
    const dispatchIntent = {
      taskId: "task-herdr-1",
      attemptId: "attempt-herdr-1",
      objective: "Run herdr test",
      roleIntent: "DEEP_ENGINEERING" as const,
      claimCeiling: "CANDIDATE_READY" as const,
      context: ["test"],
      readScope: ["src"],
      writeScope: ["src/local-agent-sessions.ts"],
      exclusiveOwnership: true,
      forbiddenChanges: [],
      acceptanceCriteria: ["pass"],
      verificationRequired: true,
      expectedArtifacts: [],
    };
    const intentHash = hashDispatchIntent(dispatchIntent);

    const store = (manager as any).store;
    const record = store.create({
      workspaceId: "ws_herdr_test",
      workspaceRoot: projectRoot,
      profileName: "opencode-test",
      provider: "opencode",
      lifecycleKind: "detached_worker_v2",
      startReplay: {
        key: "attempt-herdr-1",
        requestHash: "hash-1",
      },
      executionContract: {
        writePaths: ["src/local-agent-sessions.ts"],
        dispatchIntent,
      },
    });

    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: "HERDR",
      herdrSocketPath: "/Users/james/.config/herdr/herdr.sock",
      herdrWorkspaceId: "w_test_1",
      herdrPaneId: "w_test_1:p1",
      herdrAgentIdentity: "ds-attempt-herdr-1",
      herdrAgentKind: "opencode",
      promptNonce: "HERDR-DISPATCH-1",
      canonicalWorktreePath: projectRoot,
      workspaceId: "ws_herdr_test",
      gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
      attemptKey: "attempt-herdr-1",
      dispatchIntentHash: intentHash,
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    // Bind handle to agent session
    manager.bindHerdrExternalHandle(record.id, handle);

    // Retrieve by agentId and attemptKey
    assert.deepEqual(manager.getHerdrExternalHandle(record.id), handle);
    assert.deepEqual(manager.getHerdrExternalHandle("attempt-herdr-1"), handle);

    // Status includes herdrHandle
    const status = await manager.getAgentStatus({
      workspaceId: "ws_herdr_test",
      workspaceRoot: projectRoot,
      agentId: record.id,
    });
    assert.deepEqual(status.herdrHandle, handle);

    // Reconcile includes herdrHandle
    const reconcile = await manager.reconcileAgent({
      workspaceId: "ws_herdr_test",
      workspaceRoot: projectRoot,
      isolated: false,
      agentId: record.id,
    });
    assert.deepEqual(reconcile.herdrHandle, handle);
    assert.equal(reconcile.herdrHandle?.enforcementState, "REQUEST_ONLY_NOT_ENFORCED"); // N8
  } finally {
    defaultHerdrGatewayRegistry.releaseHandle("attempt-herdr-1");
    clean();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("LocalAgentSessionManager - persists HerdrExternalHandle across restart and replay (A1, N1-R)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-herdr-restart-test-"));
  const config = {
    stateDir,
    subagents: true,
    oauth: { scopes: ["devspace"] },
  } as any;

  const projectRoot = mkdtempSync(join(tmpdir(), "devspace-herdr-restart-repo-"));
  const spawnedWorkers1: any[] = [];
  const spawnedWorkers2: any[] = [];

  try {
    const manager1 = new LocalAgentSessionManager(
      config,
      async (agentId, promptFile, workerToken) => { spawnedWorkers1.push({ agentId }); },
      async () => true,
    );

    const dispatchIntent = {
      taskId: "task-restart-1",
      attemptId: "attempt-restart-1",
      objective: "Review restart task",
      roleIntent: "DEEP_ENGINEERING" as const,
      claimCeiling: "CANDIDATE_READY" as const,
      context: ["test"],
      readScope: ["src"],
      writeScope: ["src/local-agent-sessions.ts"],
      exclusiveOwnership: true,
      forbiddenChanges: [],
      acceptanceCriteria: ["pass"],
      verificationRequired: true,
      expectedArtifacts: [],
    };
    const intentHash = hashDispatchIntent(dispatchIntent);

    // Start an agent with attemptKey and dispatchIntent
    const startRes1 = await manager1.startAgent({
      workspaceId: "ws_restart_test",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      prompt: "review task",
      profiles: mockProfiles,
      attemptKey: "attempt-restart-1",
      executionContract: {
        writePaths: ["src/local-agent-sessions.ts"],
        dispatchIntent,
      },
    });

    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: "HERDR",
      herdrSocketPath: "/Users/james/.config/herdr/herdr.sock",
      herdrWorkspaceId: "w_restart_1",
      herdrPaneId: "w_restart_1:p1",
      herdrAgentIdentity: "ds-attempt-restart-1",
      herdrAgentKind: "agy",
      promptNonce: "HERDR-DISPATCH-RESTART-1",
      canonicalWorktreePath: projectRoot,
      workspaceId: "ws_restart_test",
      gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
      attemptKey: "attempt-restart-1",
      dispatchIntentHash: intentHash,
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    // Bind handle in manager 1 (persists to SQLite execution_contract via store CAS)
    manager1.bindHerdrExternalHandle(startRes1.agentId, handle);
    assert.deepEqual(manager1.getHerdrExternalHandle("attempt-restart-1"), handle);

    // Simulate DevSpace restart: instantiate a fresh manager2 with same stateDir
    defaultHerdrGatewayRegistry.releaseHandle("attempt-restart-1");
    const manager2 = new LocalAgentSessionManager(
      config,
      async (agentId, promptFile, workerToken) => { spawnedWorkers2.push({ agentId }); },
      async () => true,
    );

    // Instrument spy gateway on manager2 to assert zero HerdR creation calls on replay (N1-R)
    class SpyHerdrGateway extends HerdrThinGateway {
      workspaceCreateCount = 0;
      agentStartCount = 0;
      override async startExternalAgent(params: any): Promise<any> {
        this.workspaceCreateCount++;
        this.agentStartCount++;
        return super.startExternalAgent(params);
      }
    }
    const spyGateway = new SpyHerdrGateway();
    (manager2 as any).herdrGateway = spyGateway;

    // N1-R: Manager2 resolves durable handle from store despite empty in-memory map
    const recoveredHandle = manager2.getHerdrExternalHandle("attempt-restart-1");
    assert.ok(recoveredHandle);
    assert.deepEqual(recoveredHandle, handle);

    // Replay startAgent in manager2 with same attemptKey and prompt
    const replayRes = await manager2.startAgent({
      workspaceId: "ws_restart_test",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      prompt: "review task",
      profiles: mockProfiles,
      attemptKey: "attempt-restart-1",
      executionContract: {
        writePaths: ["src/local-agent-sessions.ts"],
        dispatchIntent,
      },
    });

    // Same durable session and handle returned; 0 new workers launched
    assert.equal(replayRes.agentId, startRes1.agentId);
    assert.deepEqual(replayRes.herdrHandle, handle);
    assert.equal(spawnedWorkers2.length, 0);

    // N1-R: HerdR gateway was NOT called on replay
    assert.equal(spyGateway.workspaceCreateCount, 0);
    assert.equal(spyGateway.agentStartCount, 0);

    // B1: Verify providerSessionId was not contaminated and remains undefined
    const recordInStore = manager2.getRecordByPrefixOrId(startRes1.agentId);
    assert.equal(recordInStore?.providerSessionId, undefined);
    assert.ok(recordInStore?.externalRuntimeBinding);
    assert.equal(recordInStore?.externalRuntimeBinding?.runtimeKind, "HERDR");

    // Replay with conflicting prompt fails closed
    await assert.rejects(
      manager2.startAgent({
        workspaceId: "ws_restart_test",
        workspaceRoot: projectRoot,
        profileName: "reviewer",
        prompt: "DIFFERENT conflicting prompt",
        profiles: mockProfiles,
        attemptKey: "attempt-restart-1",
      }),
      (err: any) => err instanceof AgentSessionError && err.code === "ATTEMPT_REPLAY_CONFLICT",
    );
    assert.equal(spyGateway.workspaceCreateCount, 0);
    assert.equal(spyGateway.agentStartCount, 0);
  } finally {
    defaultHerdrGatewayRegistry.releaseHandle("attempt-restart-1");
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("LocalAgentSessionManager - rejects conflicting replay and enforcement state violations for HerdrExternalHandle", async () => {
  const { manager, clean } = setupFixture();
  const projectRoot = mkdtempSync(join(tmpdir(), "devspace-herdr-conflict-test-"));

  try {
    const store = (manager as any).store;
    const record = store.create({
      workspaceId: "ws_conflict_test",
      workspaceRoot: projectRoot,
      profileName: "agy-test",
      provider: "agy",
      lifecycleKind: "detached_worker_v2",
      startReplay: {
        key: "bound-attempt-key",
        requestHash: "req-hash-1",
      },
    });

    // Mismatched attemptKey against record's startReplay key
    const mismatchedHandle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: "HERDR",
      herdrSocketPath: "/Users/james/.config/herdr/herdr.sock",
      herdrWorkspaceId: "w_test_2",
      herdrPaneId: "w_test_2:p1",
      herdrAgentIdentity: "ds-attempt-other",
      herdrAgentKind: "agy",
      promptNonce: "HERDR-DISPATCH-2",
      canonicalWorktreePath: projectRoot,
      workspaceId: "ws_conflict_test",
      gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
      attemptKey: "different-attempt-key",
      dispatchIntentHash: "intent-hash-other",
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    assert.throws(
      () => manager.bindHerdrExternalHandle(record.id, mismatchedHandle),
      (err: any) => err instanceof AgentSessionError && err.code === "ATTEMPT_REPLAY_CONFLICT",
    );

    // Illegal PHYSICALLY_ENFORCED claim (N8 violation) fails closed
    const illegalEnforcementHandle: HerdrExternalHandle = {
      ...mismatchedHandle,
      attemptKey: "bound-attempt-key",
      enforcementState: "PHYSICALLY_ENFORCED" as any,
    };

    assert.throws(
      () => manager.bindHerdrExternalHandle(record.id, illegalEnforcementHandle),
      (err: any) => err instanceof AgentSessionError && err.code === "INVALID_EXECUTION_CONTRACT",
    );
  } finally {
    defaultHerdrGatewayRegistry.releaseHandle("bound-attempt-key");
    defaultHerdrGatewayRegistry.releaseHandle("different-attempt-key");
    clean();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

class SpyProductionHerdrGateway extends HerdrThinGateway {
  ready = true;
  startCalls = 0;
  promptCalls = 0;
  stopCalls = 0;
  nonces: string[] = [];
  handle?: HerdrExternalHandle;
  promptFailure?: AgentProviderFailureError;
  knownOnboardingFailure?: string;

  override async probeReady(): Promise<boolean> {
    return this.ready;
  }

  override async startExternalAgent(params: any): Promise<HerdrExternalHandle> {
    this.startCalls++;
    const gitHeadBefore = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: params.canonicalWorktreePath,
      encoding: "utf8",
    }).trim();
    if (this.knownOnboardingFailure) {
      const fenced = params.store.fenceExternalRuntimeLaunchCAS({
        agentId: params.agentId,
        attemptKey: params.attemptKey,
        dispatchIntentHash: params.dispatchIntentHash,
        canonicalWorktreePath: params.canonicalWorktreePath,
        gitHeadBefore,
        agentKind: params.agentKind,
        herdrSocketPath: "/tmp/herdr-public-path.sock",
        requestedModel: params.requestedModel,
        requestedEffort: params.requestedEffort,
        promptNonce: `HERDR-DISPATCH-${params.attemptKey}`,
        workspaceId: params.workspaceId,
        plannedAgentName: `ds-${params.attemptKey}`,
      });
      assert.equal(fenced.applied, true);
      const workspaceObserved = params.store.recordExternalRuntimeWorkspaceObservedCAS({
        agentId: params.agentId,
        attemptKey: params.attemptKey,
        herdrWorkspaceId: `w-${params.attemptKey}`,
        herdrPaneId: `p-${params.attemptKey}`,
        observedCwd: params.canonicalWorktreePath,
      });
      assert.equal(workspaceObserved.applied, true);
      const agentObserved = params.store.recordExternalRuntimeAgentObservedCAS({
        agentId: params.agentId,
        attemptKey: params.attemptKey,
        herdrAgentIdentity: `ds-${params.attemptKey}`,
      });
      assert.equal(agentObserved.applied, true);
      throw new Error(`HerdR onboarding blocked: ${this.knownOnboardingFailure}`);
    }
    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: "HERDR",
      agentId: params.agentId,
      herdrSocketPath: "/tmp/herdr-public-path.sock",
      herdrWorkspaceId: `w-${params.attemptKey}`,
      herdrPaneId: `p-${params.attemptKey}`,
      herdrAgentIdentity: `ds-${params.attemptKey}`,
      herdrAgentKind: params.agentKind,
      requestedModel: params.requestedModel,
      requestedEffort: params.requestedEffort,
      promptNonce: `HERDR-DISPATCH-${params.attemptKey}`,
      canonicalWorktreePath: params.canonicalWorktreePath,
      workspaceId: params.workspaceId,
      gitHeadBefore,
      attemptKey: params.attemptKey,
      dispatchIntentHash: params.dispatchIntentHash,
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };
    this.handle = handle;
    return handle;
  }

  override async promptExternalAgent(handle: HerdrExternalHandle, _prompt: string, options: any = {}): Promise<any> {
    this.promptCalls++;
    this.nonces.push(handle.promptNonce);
    this.handle = handle;
    if (options.store) {
      const fenced = options.store.fenceConsequentialPromptCAS({
        agentId: handle.agentId,
        attemptKey: handle.attemptKey,
        dispatchIntentHash: handle.dispatchIntentHash,
        promptNonce: handle.promptNonce,
      });
      assert.equal(fenced.applied, true);
    }
    if (this.promptFailure) throw this.promptFailure;
    return {
      turnNonce: handle.promptNonce,
      status: "done",
      rawStatus: "done",
      paneOutput: `PUBLIC_HERDR_TURN_${this.promptCalls}`,
    };
  }

  override async reconcileExternalAgent(handle: HerdrExternalHandle): Promise<any> {
    return {
      settled: true,
      completionStatus: "COMPLETED",
      executionState: "SETTLED_TERMINAL",
      physicalEffect: "ABSENT",
      changedPaths: [],
      unexpectedPaths: [],
      gitHeadAfter: handle.gitHeadBefore,
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };
  }

  override async stopExternalAgent(): Promise<void> {
    this.stopCalls++;
  }
}

test("LocalAgentSessionManager - HERDR public lifecycle routes start, continue, status and cancel without legacy launcher", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-herdr-public-state-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "devspace-herdr-public-repo-"));
  const gateway = new SpyProductionHerdrGateway();
  let legacyLaunches = 0;
  const config = {
    stateDir,
    subagents: true,
    oauth: { scopes: ["devspace"] },
    agentExecutionBackend: "herdr",
    allowedRoots: [projectRoot],
    toolchains: [],
    agentMaxConcurrent: 4,
    port: 7676,
  } as any;

  execFileSync("git", ["init", "--initial-branch=main"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: projectRoot });
  writeFileSync(join(projectRoot, "README.md"), "herdr public path\n");
  execFileSync("git", ["add", "."], { cwd: projectRoot });
  execFileSync("git", ["commit", "-m", "base"], { cwd: projectRoot });

  const manager = new LocalAgentSessionManager(
    config,
    async () => { legacyLaunches++; },
    async () => true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    gateway,
  );
  const attemptKey = "issue242-public-herdr-1";
  const dispatchIntent = {
    taskId: "issue242-public-herdr",
    attemptId: attemptKey,
    objective: "Prove public lifecycle uses HerdR",
    roleIntent: "DEEP_ENGINEERING" as const,
    claimCeiling: "RESULT_RETURNED" as const,
    context: ["test"],
    readScope: ["README.md"],
    writeScope: [],
    exclusiveOwnership: false,
    forbiddenChanges: [],
    acceptanceCriteria: ["HerdR public path"],
    verificationRequired: true,
    expectedArtifacts: [],
  };

  try {
    const started = await manager.startAgent({
      workspaceId: "ws_issue242_public",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      prompt: "first turn",
      profiles: mockProfiles,
      attemptKey,
      executionContract: { dispatchIntent },
    });
    assert.equal(started.provider, "agy");

    let first = await manager.getAgentStatus({
      workspaceId: "ws_issue242_public",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
      waitMs: 1_000,
    });
    if (first.status !== "idle") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      first = await manager.getAgentStatus({
        workspaceId: "ws_issue242_public",
        workspaceRoot: projectRoot,
        agentId: started.agentId,
        waitMs: 1_000,
      });
    }

    assert.equal(legacyLaunches, 0);
    assert.equal(gateway.startCalls, 1);
    assert.equal(gateway.promptCalls, 1);
    assert.equal(first.status, "idle");
    assert.equal(first.runtime?.runtimeKind, "HERDR");
    assert.equal(first.runtime?.agentIdentity, `ds-${attemptKey}`);
    assert.equal(first.latestResponse, "PUBLIC_HERDR_TURN_1");

    await manager.continueAgent({
      workspaceId: "ws_issue242_public",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
      prompt: "second turn",
      profiles: mockProfiles,
    });
    let second = await manager.getAgentStatus({
      workspaceId: "ws_issue242_public",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
      waitMs: 1_000,
    });
    if (second.status !== "idle") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      second = await manager.getAgentStatus({
        workspaceId: "ws_issue242_public",
        workspaceRoot: projectRoot,
        agentId: started.agentId,
        waitMs: 1_000,
      });
    }

    assert.equal(gateway.startCalls, 1, "continuation must reuse the same HerdR agent");
    assert.equal(gateway.promptCalls, 2);
    assert.notEqual(gateway.nonces[0], gateway.nonces[1], "each consequential turn must have a fresh durable nonce");
    assert.equal(second.status, "idle");
    assert.equal(second.runtime?.runtimeKind, "HERDR");
    assert.equal(second.latestResponse, "PUBLIC_HERDR_TURN_2");

    const reconciled = await manager.reconcileAgent({
      workspaceId: "ws_issue242_public",
      workspaceRoot: projectRoot,
      isolated: true,
      agentId: started.agentId,
    });
    assert.equal(reconciled.runtime?.runtimeKind, "HERDR");
    assert.equal(reconciled.providerState, "SETTLED_TERMINAL");

    const stopped = await manager.cancelAgent({
      workspaceId: "ws_issue242_public",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
    });
    assert.equal(gateway.stopCalls, 1);
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.runtime?.runtimeKind, "HERDR");
    assert.equal(legacyLaunches, 0);
  } finally {
    defaultHerdrGatewayRegistry.releaseHandle(attemptKey);
    manager.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("LocalAgentSessionManager - HERDR confirmed onboarding block settles terminal without a durable handle", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-herdr-onboarding-state-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "devspace-herdr-onboarding-repo-"));
  const gateway = new SpyProductionHerdrGateway();
  gateway.knownOnboardingFailure = "Agent 'grok' is stuck at onboarding: BLOCKED_ON_PERMISSION_ADMISSION";
  let legacyLaunches = 0;
  const config = {
    stateDir,
    subagents: true,
    oauth: { scopes: ["devspace"] },
    agentExecutionBackend: "herdr",
    allowedRoots: [projectRoot],
    toolchains: [],
    agentMaxConcurrent: 4,
    port: 7676,
  } as any;
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: projectRoot });
  writeFileSync(join(projectRoot, "README.md"), "herdr onboarding\n");
  execFileSync("git", ["add", "."], { cwd: projectRoot });
  execFileSync("git", ["commit", "-m", "base"], { cwd: projectRoot });

  const manager = new LocalAgentSessionManager(
    config,
    async () => { legacyLaunches++; },
    async () => true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    gateway,
  );
  const attemptKey = "issue242-herdr-onboarding";
  const dispatchIntent = {
    taskId: "issue242-herdr-onboarding",
    attemptId: attemptKey,
    objective: "Settle confirmed HerdR onboarding block",
    roleIntent: "TEST_VERIFIER" as const,
    claimCeiling: "RESULT_RETURNED" as const,
    context: ["test"],
    readScope: ["README.md"],
    writeScope: [],
    exclusiveOwnership: false,
    forbiddenChanges: [],
    acceptanceCriteria: ["confirmed onboarding block is terminal"],
    verificationRequired: true,
    expectedArtifacts: [],
  };

  try {
    const started = await manager.startAgent({
      workspaceId: "ws_issue242_onboarding",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      prompt: "onboarding probe",
      profiles: mockProfiles,
      attemptKey,
      executionContract: { dispatchIntent },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const status = await manager.getAgentStatus({
      workspaceId: "ws_issue242_onboarding",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
      waitMs: 1_000,
    });
    assert.equal(legacyLaunches, 0);
    assert.equal(status.status, "error");
    assert.equal(status.terminal, true);
    assert.equal(status.terminalReason, "launch_failed");
    assert.equal(status.errorCode, "PROVIDER_EXECUTION_ERROR");
    assert.match(status.error ?? "", /HerdR onboarding blocked:/);
    assert.equal(status.runtime, undefined);
  } finally {
    manager.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("LocalAgentSessionManager - HERDR typed provider capacity failure stays durable and is not washed into success", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-herdr-provider-error-state-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "devspace-herdr-provider-error-repo-"));
  const gateway = new SpyProductionHerdrGateway();
  gateway.promptFailure = new AgentProviderFailureError({
    code: "PROVIDER_CAPACITY_ERROR",
    provider: "agy",
    operation: "run",
    retryable: true,
    errorClass: "QUOTA_CAPACITY",
    model: "free-model",
    providerSessionId: "session_quota",
    providerMessage: "daily free model limit reached",
    message: "Provider quota or capacity failure",
  });
  let legacyLaunches = 0;
  const config = {
    stateDir,
    subagents: true,
    oauth: { scopes: ["devspace"] },
    agentExecutionBackend: "herdr",
    allowedRoots: [projectRoot],
    toolchains: [],
    agentMaxConcurrent: 4,
    port: 7676,
  } as any;
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: projectRoot });
  writeFileSync(join(projectRoot, "README.md"), "herdr provider error\n");
  execFileSync("git", ["add", "."], { cwd: projectRoot });
  execFileSync("git", ["commit", "-m", "base"], { cwd: projectRoot });

  const manager = new LocalAgentSessionManager(
    config,
    async () => { legacyLaunches++; },
    async () => true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    gateway,
  );
  const attemptKey = "issue242-herdr-provider-capacity";
  const dispatchIntent = {
    taskId: "issue242-herdr-provider-capacity",
    attemptId: attemptKey,
    objective: "Preserve provider capacity truth",
    roleIntent: "DEEP_ENGINEERING" as const,
    claimCeiling: "RESULT_RETURNED" as const,
    context: ["test"],
    readScope: ["README.md"],
    writeScope: [],
    exclusiveOwnership: false,
    forbiddenChanges: [],
    acceptanceCriteria: ["typed provider capacity stays error"],
    verificationRequired: true,
    expectedArtifacts: [],
  };

  try {
    const started = await manager.startAgent({
      workspaceId: "ws_issue242_provider_capacity",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      prompt: "quota probe",
      profiles: mockProfiles,
      attemptKey,
      executionContract: { dispatchIntent },
    });
    const status = await manager.getAgentStatus({
      workspaceId: "ws_issue242_provider_capacity",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
      waitMs: 1_000,
    });
    assert.equal(legacyLaunches, 0);
    assert.equal(gateway.promptCalls, 1);
    assert.equal(status.status, "error");
    assert.equal(status.errorCode, "PROVIDER_CAPACITY_ERROR");
    assert.equal(status.errorRetryable, true);
    assert.equal(status.providerSessionId, "session_quota");
    assert.equal(status.latestResponse, "daily free model limit reached");
    assert.equal(status.terminalReason, "provider_error");
  } finally {
    defaultHerdrGatewayRegistry.releaseHandle(attemptKey);
    manager.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("LocalAgentSessionManager - HERDR daemon unavailable fails closed before record creation and never launches legacy worker", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-herdr-unavailable-state-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "devspace-herdr-unavailable-repo-"));
  const gateway = new SpyProductionHerdrGateway();
  gateway.ready = false;
  let legacyLaunches = 0;
  const config = {
    stateDir,
    subagents: true,
    oauth: { scopes: ["devspace"] },
    agentExecutionBackend: "herdr",
    allowedRoots: [projectRoot],
    toolchains: [],
    agentMaxConcurrent: 4,
    port: 7676,
  } as any;
  const manager = new LocalAgentSessionManager(
    config,
    async () => { legacyLaunches++; },
    async () => true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    gateway,
  );
  const attemptKey = "issue242-herdr-down";
  const dispatchIntent = {
    taskId: "issue242-herdr-down",
    attemptId: attemptKey,
    objective: "Fail closed when HerdR is unavailable",
    roleIntent: "DEEP_ENGINEERING" as const,
    claimCeiling: "RESULT_RETURNED" as const,
    context: ["test"],
    readScope: ["README.md"],
    writeScope: [],
    exclusiveOwnership: false,
    forbiddenChanges: [],
    acceptanceCriteria: ["no fallback"],
    verificationRequired: true,
    expectedArtifacts: [],
  };

  try {
    await assert.rejects(
      manager.startAgent({
        workspaceId: "ws_issue242_down",
        workspaceRoot: projectRoot,
        profileName: "reviewer",
        prompt: "must not launch",
        profiles: mockProfiles,
        attemptKey,
        executionContract: { dispatchIntent },
      }),
      (error: any) => {
        assert.equal(error.code, "PROVIDER_UNAVAILABLE");
        assert.match(error.message, /HerdR daemon is unavailable/);
        return true;
      },
    );
    assert.equal(legacyLaunches, 0);
    assert.equal(gateway.startCalls, 0);
    assert.equal(manager.countAllAgentRecords(), 0);
  } finally {
    manager.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

class SpyPromptGateway extends HerdrThinGateway {
  promptCallCount = 0;
  mockPromptOutcome: "done" | "timeout" | "error" | "blocked" = "done";
  currentHandle?: HerdrExternalHandle;

  override async getPane(paneId: string): Promise<any> {
    if (this.currentHandle && paneId === this.currentHandle.herdrPaneId) {
      return {
        pane_id: this.currentHandle.herdrPaneId,
        workspace_id: this.currentHandle.herdrWorkspaceId,
        cwd: this.currentHandle.canonicalWorktreePath,
        foreground_cwd: this.currentHandle.canonicalWorktreePath,
      };
    }
    return undefined;
  }

  override async getAgent(agentName: string): Promise<any> {
    if (this.currentHandle && agentName === this.currentHandle.herdrAgentIdentity) {
      return {
        name: this.currentHandle.herdrAgentIdentity,
        agent: this.currentHandle.herdrAgentKind,
        workspace_id: this.currentHandle.herdrWorkspaceId,
        pane_id: this.currentHandle.herdrPaneId,
        cwd: this.currentHandle.canonicalWorktreePath,
        foreground_cwd: this.currentHandle.canonicalWorktreePath,
        agent_status: "idle",
        interactive_ready: true,
      };
    }
    return { agent_status: "idle", interactive_ready: true };
  }

  override async readPane(paneId: string) {
    if (this.mockPromptOutcome === "blocked") {
      return "Do you trust the contents of this project?";
    }
    return "Output from agent";
  }

  protected override async sendRequest<T = unknown>(req: any, timeoutMs?: number): Promise<any> {
    if (req.method === "agent.prompt") {
      this.promptCallCount++;
      if (this.mockPromptOutcome === "error") {
        throw new Error("Simulated socket network disconnect");
      }
      if (this.mockPromptOutcome === "timeout") {
        return {
          id: req.id,
          error: { code: "timeout", message: "Prompt timed out after 30000ms" },
        };
      }
      return {
        id: req.id,
        result: {
          agent: {
            name: this.currentHandle?.herdrAgentIdentity,
            agent: this.currentHandle?.herdrAgentKind,
            workspace_id: this.currentHandle?.herdrWorkspaceId,
            pane_id: this.currentHandle?.herdrPaneId,
            cwd: this.currentHandle?.canonicalWorktreePath,
            foreground_cwd: this.currentHandle?.canonicalWorktreePath,
            agent_status: this.mockPromptOutcome === "blocked" ? "blocked" : "done",
            interactive_ready: true,
          },
        },
      };
    }
    return { id: req.id, result: {} };
  }
}

test("LocalAgentSessionManager - PROMPT-R1, R2, R3, R4 durable prompt fence survives DevSpace restart", async () => {
  const cases: Array<{
    name: string;
    attemptKey: string;
    outcome: "done" | "timeout" | "error" | "blocked";
  }> = [
    { name: "PROMPT-R1 (normal settlement)", attemptKey: "attempt-prompt-r1", outcome: "done" },
    { name: "PROMPT-R2 (timeout OUTCOME_UNKNOWN)", attemptKey: "attempt-prompt-r2", outcome: "timeout" },
    { name: "PROMPT-R3 (network/socket error)", attemptKey: "attempt-prompt-r3", outcome: "error" },
    { name: "PROMPT-R4 (blocked onboarding dialog)", attemptKey: "attempt-prompt-r4", outcome: "blocked" },
  ];

  for (const c of cases) {
    const stateDir = mkdtempSync(join(tmpdir(), `devspace-fence-${c.attemptKey}-`));
    const projectRoot = mkdtempSync(join(tmpdir(), `devspace-fence-repo-${c.attemptKey}-`));
    const config = { stateDir, subagents: true, oauth: { scopes: ["devspace"] } } as any;

    try {
      const manager1 = new LocalAgentSessionManager(config, async () => {}, async () => true);
      const dispatchIntent = {
        taskId: `task-${c.attemptKey}`,
        attemptId: c.attemptKey,
        objective: `Test durable fence for ${c.name}`,
        roleIntent: "DEEP_ENGINEERING" as const,
        claimCeiling: "CANDIDATE_READY" as const,
        context: ["test"],
        readScope: ["src"],
        writeScope: ["src/local-agent-sessions.ts"],
        exclusiveOwnership: true,
        forbiddenChanges: [],
        acceptanceCriteria: ["pass"],
        verificationRequired: true,
        expectedArtifacts: [],
      };
      const intentHash = hashDispatchIntent(dispatchIntent);

      const startRes = await manager1.startAgent({
        workspaceId: "ws_fence_test",
        workspaceRoot: projectRoot,
        profileName: "reviewer",
        prompt: "test fence",
        profiles: mockProfiles,
        attemptKey: c.attemptKey,
        executionContract: {
          writePaths: ["src/local-agent-sessions.ts"],
          dispatchIntent,
        },
      });

      const handle: HerdrExternalHandle = {
        schemaVersion: 1,
        runtimeKind: "HERDR",
        herdrSocketPath: "/tmp/herdr.sock",
        herdrWorkspaceId: `w_${c.attemptKey}`,
        herdrPaneId: `p_${c.attemptKey}`,
        herdrAgentIdentity: `ds-${c.attemptKey}`,
        herdrAgentKind: "agy",
        promptNonce: `NONCE-${c.attemptKey}`,
        canonicalWorktreePath: projectRoot,
        workspaceId: "ws_fence_test",
        gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
        attemptKey: c.attemptKey,
        dispatchIntentHash: intentHash,
        launchTimestamp: new Date().toISOString(),
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
      };

      manager1.bindHerdrExternalHandle(startRes.agentId, handle);

      const spyGateway1 = new SpyPromptGateway("/tmp/herdr.sock", defaultHerdrGatewayRegistry, (manager1 as any).store);
      spyGateway1.currentHandle = handle;
      spyGateway1.mockPromptOutcome = c.outcome;

      // 1. Submit first prompt
      if (c.outcome === "error") {
        const res = await spyGateway1.promptExternalAgent(handle, "first prompt", { store: (manager1 as any).store });
        assert.equal(res.status, "OUTCOME_UNKNOWN");
        assert.equal(res.timeout, false);
      } else {
        const res = await spyGateway1.promptExternalAgent(handle, "first prompt", { store: (manager1 as any).store });
        if (c.outcome === "done") assert.equal(res.status, "done");
        if (c.outcome === "timeout") assert.equal(res.status, "OUTCOME_UNKNOWN");
        if (c.outcome === "blocked") assert.equal(res.status, "blocked");
      }
      assert.equal(spyGateway1.promptCallCount, 1, `${c.name}: first prompt must call external agent once`);

      // 2. Simulate DevSpace restart: clear process registry and instantiate fresh manager2
      defaultHerdrGatewayRegistry.releaseHandle(c.attemptKey);
      manager1.close();

      const manager2 = new LocalAgentSessionManager(config, async () => {}, async () => true);
      const recoveredHandle = manager2.getHerdrExternalHandle(c.attemptKey);
      assert.ok(recoveredHandle, `${c.name}: handle must recover from store`);

      const spyGateway2 = new SpyPromptGateway("/tmp/herdr.sock", defaultHerdrGatewayRegistry, (manager2 as any).store);
      spyGateway2.currentHandle = recoveredHandle!;
      assert.equal(spyGateway2.promptCallCount, 0);

      // 3. Second prompt on same attempt after restart MUST fail closed with [N-TURN-OPTION-A]
      await assert.rejects(
        async () => spyGateway2.promptExternalAgent(recoveredHandle!, "second prompt after restart", { store: (manager2 as any).store }),
        /\[N-TURN-OPTION-A\]/,
        `${c.name}: second prompt must be rejected with [N-TURN-OPTION-A]`,
      );

      // 4. CRUCIAL ASSERTION: Zero external agent.prompt calls made on the second prompt
      assert.equal(
        spyGateway2.promptCallCount,
        0,
        `${c.name}: external agent.prompt call count must be 0 on second prompt after restart`,
      );

      manager2.close();
    } finally {
      defaultHerdrGatewayRegistry.releaseHandle(c.attemptKey);
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }
});

test("Issue #256: HerdR stale lifecycle and capacity reconciliation 5D matrix", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-herdr-5d-"));
  const repoDir = mkdtempSync(join(tmpdir(), "devspace-herdr-repo-"));

  function initTestGitRepo(dir: string): string {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "README.md"), "# Initial\n");
    execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
  }

  const initialHead = initTestGitRepo(repoDir);

  class Mock5DHerdrGateway extends HerdrThinGateway {
    serverReachable = true;
    workspaceAbsent = false;
    agentAbsent = false;
    liveAgentStatus: "running" | "idle" | "done" | null = "done";
    liveAgentPresent = true;
    identityMismatch = false;

    override async probeReady(): Promise<boolean> {
      return this.serverReachable;
    }

    override async pingServer(): Promise<boolean> {
      return this.serverReachable;
    }

    override async confirmObservedLaunchAbsent(): Promise<boolean> {
      if (!this.serverReachable || this.identityMismatch) {
        throw new Error("Exact HerdR absence is unverified.");
      }
      return this.workspaceAbsent || this.agentAbsent;
    }

    override async startExternalAgent(params: any): Promise<HerdrExternalHandle> {
      const handle: HerdrExternalHandle = {
        schemaVersion: 1,
        runtimeKind: "HERDR",
        herdrSocketPath: "/tmp/mock-herdr.sock",
        herdrWorkspaceId: `ws-${params.attemptKey}`,
        herdrPaneId: `pane-${params.attemptKey}`,
        herdrAgentIdentity: `agent-${params.attemptKey}`,
        herdrAgentKind: params.agentKind,
        promptNonce: `nonce-${params.attemptKey}`,
        canonicalWorktreePath: params.canonicalWorktreePath,
        workspaceId: params.workspaceId,
        gitHeadBefore: initialHead,
        attemptKey: params.attemptKey,
        dispatchIntentHash: params.dispatchIntentHash,
        launchTimestamp: new Date().toISOString(),
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
      };
      return handle;
    }

    override async observeAndValidateLiveHandle(expectations: any): Promise<any> {
      if (!this.serverReachable) return { valid: false, reason: "Server unreachable" };
      if (this.identityMismatch) {
        return { valid: false, reason: "Live identity mismatch: unexpected foreign agent in pane" };
      }
      if (!this.liveAgentPresent || !this.liveAgentStatus) {
        return {
          valid: false,
          reason: `Agent '${expectations.herdrAgentIdentity}' not found in HerdR`,
          pane: {
            pane_id: expectations.herdrPaneId,
            workspace_id: expectations.herdrWorkspaceId,
            cwd: expectations.canonicalWorktreePath,
          },
        };
      }
      return {
        valid: true,
        agent: {
          agent_status: this.liveAgentStatus,
          interactive_ready: true,
          workspace_id: expectations.herdrWorkspaceId,
          pane_id: expectations.herdrPaneId,
          cwd: expectations.canonicalWorktreePath,
        },
      };
    }

    override async stopExternalAgent(handle: HerdrExternalHandle): Promise<void> {
      if (!this.serverReachable) throw new Error("HerdR server unreachable during stop");
      if (this.identityMismatch) throw new Error("Live identity mismatch during stop");
      defaultHerdrGatewayRegistry.releaseHandle(handle.attemptKey, handle.workspaceId);
    }

    override async promptExternalAgent(handle: HerdrExternalHandle, prompt: string, options?: any): Promise<HerdrPromptResult> {
      return {
        status: "done",
        paneOutput: "mock output",
        finalResponse: "mock response",
      };
    }

    override async reconcileExternalAgent(handle: HerdrExternalHandle, writeScope?: string[], forceClose?: boolean, promptResult?: any, options?: any): Promise<any> {
      return {
        settled: true,
        executionState: "DONE",
        completionStatus: "CLEAN",
        changedPaths: [],
        unexpectedPaths: [],
      };
    }
  }

  try {
    const config = {
      stateDir,
      agentExecutionBackend: "herdr",
      agentMaxConcurrent: 1,
      oauth: { scopes: ["devspace"] },
    } as any;

    const mockGateway = new Mock5DHerdrGateway("/tmp/mock-herdr.sock", defaultHerdrGatewayRegistry);
    const manager = new LocalAgentSessionManager(
      config,
      async () => {},
      async () => true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mockGateway,
    );

    // ─────────────────────────────────────────────────────────────────────────────
    // CASE 1: Lost Durable Handle + Starting + Clean Workspace (Headless Restart)
    // ─────────────────────────────────────────────────────────────────────────────
    {
      const store = (manager as any).store as LocalAgentStore;
      const rec = store.create({
        workspaceId: "ws_lost_start",
        workspaceRoot: repoDir,
        profileName: "reviewer",
        provider: "opencode",
        lifecycleKind: "detached_worker_v2",
        executionContract: { writePaths: ["README.md"] },
      });
      // Session starts with activeTurn, no handle bound (e.g. crash after launch fence was recorded)
      store.bindExternalRuntimeBindingCAS({
        agentId: rec.id,
        binding: {
          runtimeKind: "HERDR",
          launch: {
            state: "WORKSPACE_OBSERVED",
            launchRequestId: `HERDR-LAUNCH:attempt-lost-start`,
            attemptKey: "attempt-lost-start",
            dispatchIntentHash: "hash-lost-start",
            canonicalWorktreePath: repoDir,
            gitHeadBefore: initialHead,
            agentKind: "opencode",
            herdrSocketPath: "/tmp/mock-herdr.sock",
            herdrWorkspaceId: "ws-lost-start-herdr",
            herdrPaneId: "pane-lost-start-herdr",
            herdrAgentIdentity: "agent-lost-start-herdr",
            observedCwd: repoDir,
            promptNonce: "nonce-lost-start",
            fencedAt: new Date().toISOString(),
          },
        },
      });

      mockGateway.workspaceAbsent = true;
      assert.equal(manager.runningCount(), 1, "Slot occupied before reclaim");
      const preBefore = await manager.preflightAgent({
        workspaceId: "ws_lost_start",
        workspaceRoot: repoDir,
        isolated: false,
        profileName: "reviewer",
        profiles: mockProfiles,
      });
      assert.equal(preBefore.capacity.localState, "AVAILABLE", "Preflight proactively reclaimed stale lost-handle slot");
      assert.equal(manager.runningCount(), 0, "Capacity reclaimed after preflight");

      const readback = store.getById(rec.id);
      assert.equal(readback?.status, "error");
      assert.equal(readback?.terminalReason, "launch_failed");
      mockGateway.workspaceAbsent = false;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // CASE 2: Lost Durable Handle + Running + Hostile Dirty Candidate Workspace
    // ─────────────────────────────────────────────────────────────────────────────
    {
      const store = (manager as any).store as LocalAgentStore;
      const rec = store.create({
        workspaceId: "ws_lost_running",
        workspaceRoot: repoDir,
        profileName: "reviewer",
        provider: "opencode",
        lifecycleKind: "detached_worker_v2",
        executionContract: { writePaths: ["authorized.txt"] },
      });
      store.bindExternalRuntimeBindingCAS({
        agentId: rec.id,
        binding: {
          runtimeKind: "HERDR",
          launch: {
            state: "AGENT_OBSERVED",
            launchRequestId: `HERDR-LAUNCH:attempt-lost-running`,
            attemptKey: "attempt-lost-running",
            dispatchIntentHash: "hash-lost-running",
            canonicalWorktreePath: repoDir,
            gitHeadBefore: initialHead,
            agentKind: "opencode",
            herdrSocketPath: "/tmp/mock-herdr.sock",
            herdrWorkspaceId: "ws-lost-running-herdr",
            herdrPaneId: "pane-lost-running-herdr",
            herdrAgentIdentity: "agent-lost-running-herdr",
            observedCwd: repoDir,
            promptNonce: "nonce-lost-running",
            fencedAt: new Date().toISOString(),
          },
        },
      });
      // Model a claimed running turn whose clean physical baseline was durably captured
      // before the final HerdR handle bind was lost.
      (store as any).database.sqlite.prepare(
        "update local_agent_sessions set status = 'running', scope_baseline = ? where id = ?",
      ).run(JSON.stringify({ changedPaths: [], head: initialHead }), rec.id);

      // Create an unexpected modification outside declared writeScope.
      writeFileSync(join(repoDir, "hostile_unauthorized.txt"), "hostile payload");
      mockGateway.workspaceAbsent = true;

      assert.equal(manager.runningCount(), 1);
      const reclaimed = await manager.reconcileStaleHerdRSessions();
      assert.equal(reclaimed, 1, "Hostile lost-handle session reclaimed");
      assert.equal(manager.runningCount(), 0, "Slot freed after terminal classification");

      const readback = store.getById(rec.id);
      assert.equal(readback?.status, "error");
      assert.equal(readback?.scopeState, "SCOPE_VIOLATION", "Hostile effects must be recorded as SCOPE_VIOLATION");
      assert.ok(readback?.lifecycleState?.cumulativeChangedPaths?.includes("hostile_unauthorized.txt"));

      // Clean up the hostile file
      rmSync(join(repoDir, "hostile_unauthorized.txt"));
      mockGateway.workspaceAbsent = false;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // CASE 3: Unreachable HerdR Server (FAIL-CLOSED: Slot MUST NOT be released)
    // ─────────────────────────────────────────────────────────────────────────────
    {
      const store = (manager as any).store as LocalAgentStore;
      const handle: HerdrExternalHandle = {
        schemaVersion: 1,
        runtimeKind: "HERDR",
        herdrSocketPath: "/tmp/mock-herdr.sock",
        herdrWorkspaceId: "ws-unreachable-1",
        herdrPaneId: "pane-unreachable-1",
        herdrAgentIdentity: "agent-unreachable-1",
        herdrAgentKind: "opencode",
        promptNonce: "nonce-unreachable-1",
        canonicalWorktreePath: repoDir,
        workspaceId: "ws_unreachable",
        gitHeadBefore: initialHead,
        attemptKey: "attempt-unreachable-1",
        dispatchIntentHash: "hash-unreachable",
        launchTimestamp: new Date().toISOString(),
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
      };

      const rec = store.create({
        workspaceId: "ws_unreachable",
        workspaceRoot: repoDir,
        profileName: "reviewer",
        provider: "opencode",
        lifecycleKind: "detached_worker_v2",
        startReplay: { key: "attempt-unreachable-1", requestHash: "p" },
      });
      handle.agentId = rec.id;
      store.bindExternalRuntimeBindingCAS({
        agentId: rec.id,
        binding: {
          runtimeKind: "HERDR",
          handle: handle as any,
        },
      });
      (store as any).database.sqlite.prepare(
        "update local_agent_sessions set status = 'running' where id = ?",
      ).run(rec.id);

      mockGateway.serverReachable = false; // HerdR is dead / connection refused

      const reclaimed = await manager.reconcileStaleHerdRSessions();
      assert.equal(reclaimed, 0, "Unreachable HerdR MUST NOT reclaim slot (FAIL-CLOSED)");
      assert.equal(manager.runningCount(), 1, "Slot remains occupied to prevent destructive worker collisions");

      const pre = await manager.preflightAgent({
        workspaceId: "ws_unreachable",
        workspaceRoot: repoDir,
        isolated: false,
        profileName: "reviewer",
        profiles: mockProfiles,
      });
      assert.equal(pre.capacity.localState, "EXHAUSTED");
      assert.equal(pre.capacity.unreconciledStale, 1, "Preflight flags slot as unreconciledStale");
      assert.ok(pre.blockers.some((b: { code: string; detail: string }) => b.detail.includes("unreconciled/stale HerdR sessions")));

      // Restore reachability for subsequent cases
      mockGateway.serverReachable = true;
      // Clean up this session via terminateActiveAgent
      await (manager as any).terminateActiveAgent(rec.id, "cancelled", "cleanup", undefined, undefined, "stopped");
      assert.equal(manager.runningCount(), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // CASE 4: Live Identity Mismatch (FAIL-CLOSED: Zero destructive actions)
    // ─────────────────────────────────────────────────────────────────────────────
    {
      const store = (manager as any).store as LocalAgentStore;
      const handle: HerdrExternalHandle = {
        schemaVersion: 1,
        runtimeKind: "HERDR",
        herdrSocketPath: "/tmp/mock-herdr.sock",
        herdrWorkspaceId: "ws-mismatch-1",
        herdrPaneId: "pane-mismatch-1",
        herdrAgentIdentity: "agent-mismatch-1",
        herdrAgentKind: "opencode",
        promptNonce: "nonce-mismatch-1",
        canonicalWorktreePath: repoDir,
        workspaceId: "ws_mismatch",
        gitHeadBefore: initialHead,
        attemptKey: "attempt-mismatch-1",
        dispatchIntentHash: "hash-mismatch",
        launchTimestamp: new Date().toISOString(),
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
      };

      const rec = store.create({
        workspaceId: "ws_mismatch",
        workspaceRoot: repoDir,
        profileName: "reviewer",
        provider: "opencode",
        lifecycleKind: "detached_worker_v2",
        startReplay: { key: "attempt-mismatch-1", requestHash: "p" },
      });
      handle.agentId = rec.id;
      store.bindExternalRuntimeBindingCAS({
        agentId: rec.id,
        binding: {
          runtimeKind: "HERDR",
          handle: handle as any,
        },
      });
      (store as any).database.sqlite.prepare(
        "update local_agent_sessions set status = 'running' where id = ?",
      ).run(rec.id);

      mockGateway.identityMismatch = true; // Pane occupied by someone else
      mockGateway.agentAbsent = true; // Expected agent is also missing: mismatch must still win fail-closed.

      const reclaimed = await manager.reconcileStaleHerdRSessions();
      assert.equal(reclaimed, 0, "Identity mismatch MUST NOT reclaim slot (FAIL-CLOSED)");
      assert.equal(manager.runningCount(), 1, "Slot preserved");

      mockGateway.identityMismatch = false;
      mockGateway.agentAbsent = false;
      await (manager as any).terminateActiveAgent(rec.id, "cancelled", "cleanup", undefined, undefined, "stopped");
      assert.equal(manager.runningCount(), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // CASE 5: Exact Absent HerdR Workspace (Safe Recovery on Verified Absence)
    // ─────────────────────────────────────────────────────────────────────────────
    {
      const store = (manager as any).store as LocalAgentStore;
      const handle: HerdrExternalHandle = {
        schemaVersion: 1,
        runtimeKind: "HERDR",
        herdrSocketPath: "/tmp/mock-herdr.sock",
        herdrWorkspaceId: "ws-absent-1",
        herdrPaneId: "pane-absent-1",
        herdrAgentIdentity: "agent-absent-1",
        herdrAgentKind: "opencode",
        promptNonce: "nonce-absent-1",
        canonicalWorktreePath: repoDir,
        workspaceId: "ws_absent",
        gitHeadBefore: initialHead,
        attemptKey: "attempt-absent-1",
        dispatchIntentHash: "hash-absent",
        launchTimestamp: new Date().toISOString(),
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
      };

      const rec = store.create({
        workspaceId: "ws_absent",
        workspaceRoot: repoDir,
        profileName: "reviewer",
        provider: "opencode",
        lifecycleKind: "detached_worker_v2",
        startReplay: { key: "attempt-absent-1", requestHash: "p" },
      });
      handle.agentId = rec.id;
      store.bindExternalRuntimeBindingCAS({
        agentId: rec.id,
        binding: {
          runtimeKind: "HERDR",
          handle: handle as any,
        },
      });
      (store as any).database.sqlite.prepare(
        "update local_agent_sessions set status = 'running' where id = ?",
      ).run(rec.id);

      mockGateway.liveAgentPresent = false;
      mockGateway.workspaceAbsent = true; // Workspace confirmed 404/not_found

      assert.equal(manager.runningCount(), 1);
      const reclaimed = await manager.reconcileStaleHerdRSessions();
      assert.equal(reclaimed, 1, "Confirmed absent workspace safely reclaimed");
      assert.equal(manager.runningCount(), 0, "Capacity available again");

      const readback = store.getById(rec.id);
      assert.equal(readback?.status, "stopped");
      assert.equal(readback?.terminalReason, "cancelled");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // CASE 6: JIT Stale Reclaim during startAgent when Capacity is Exhausted
    // ─────────────────────────────────────────────────────────────────────────────
    {
      const store = (manager as any).store as LocalAgentStore;
      const handle: HerdrExternalHandle = {
        schemaVersion: 1,
        runtimeKind: "HERDR",
        herdrSocketPath: "/tmp/mock-herdr.sock",
        herdrWorkspaceId: "ws-jit-1",
        herdrPaneId: "pane-jit-1",
        herdrAgentIdentity: "agent-jit-1",
        herdrAgentKind: "opencode",
        promptNonce: "nonce-jit-1",
        canonicalWorktreePath: repoDir,
        workspaceId: "ws_jit",
        gitHeadBefore: initialHead,
        attemptKey: "attempt-jit-1",
        dispatchIntentHash: "hash-jit",
        launchTimestamp: new Date().toISOString(),
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
      };

      const rec = store.create({
        workspaceId: "ws_jit",
        workspaceRoot: repoDir,
        profileName: "reviewer",
        provider: "opencode",
        lifecycleKind: "detached_worker_v2",
        startReplay: { key: "attempt-jit-1", requestHash: "p" },
      });
      handle.agentId = rec.id;
      store.bindExternalRuntimeBindingCAS({
        agentId: rec.id,
        binding: {
          runtimeKind: "HERDR",
          handle: handle as any,
        },
      });
      (store as any).database.sqlite.prepare(
        "update local_agent_sessions set status = 'running' where id = ?",
      ).run(rec.id);

      // Max concurrent is 1; rec occupies that 1 slot.
      assert.equal(manager.runningCount(), 1);

      // External workspace confirmed absent
      mockGateway.liveAgentPresent = false;
      mockGateway.workspaceAbsent = true;

      // Starting a new agent should JIT reclaim the stale slot and succeed
      const started = await manager.startAgent({
        workspaceId: "ws_jit_new",
        workspaceRoot: repoDir,
        profileName: "reviewer",
        prompt: "new task after JIT reclaim",
        profiles: mockProfiles,
        attemptKey: "attempt-jit-new",
        executionContract: {
          dispatchIntent: {
            taskId: "task-jit-new",
            attemptId: "attempt-jit-new",
            objective: "JIT reclaim test",
            roleIntent: "DEEP_ENGINEERING",
            claimCeiling: "RESULT_RETURNED",
            context: ["test"],
            readScope: ["README.md"],
            writeScope: [],
            exclusiveOwnership: false,
            forbiddenChanges: [],
            acceptanceCriteria: ["reclaimed"],
            verificationRequired: false,
            expectedArtifacts: [],
          },
        },
      });
      assert.ok(started.agentId);
      assert.notEqual(started.agentId, rec.id);

      // Wait for background turn task to settle cleanly before closing manager
      const status = await manager.getAgentStatus({
        workspaceId: "ws_jit_new",
        workspaceRoot: repoDir,
        agentId: started.agentId,
        waitMs: 500,
      });
      assert.ok(status.terminal || status.status === "idle");

      // Clean up
      defaultHerdrGatewayRegistry.releaseHandle("attempt-jit-new");
      mockGateway.workspaceAbsent = false;
      mockGateway.liveAgentPresent = true;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // CASE 7: Public cancel uses the same exact-absence proof before releasing a
    // no-handle HerdR starting slot.
    // ─────────────────────────────────────────────────────────────────────────────
    {
      const store = (manager as any).store as LocalAgentStore;
      const rec = store.create({
        workspaceId: "ws_cancel_absent",
        workspaceRoot: repoDir,
        profileName: "reviewer",
        provider: "opencode",
        lifecycleKind: "detached_worker_v2",
      });
      store.bindExternalRuntimeBindingCAS({
        agentId: rec.id,
        binding: {
          runtimeKind: "HERDR",
          launch: {
            state: "AGENT_OBSERVED",
            launchRequestId: "HERDR-LAUNCH:attempt-cancel-absent",
            attemptKey: "attempt-cancel-absent",
            dispatchIntentHash: "hash-cancel-absent",
            canonicalWorktreePath: repoDir,
            gitHeadBefore: initialHead,
            agentKind: "opencode",
            herdrSocketPath: "/tmp/mock-herdr.sock",
            herdrWorkspaceId: "ws-cancel-absent-herdr",
            herdrPaneId: "pane-cancel-absent-herdr",
            herdrAgentIdentity: "agent-cancel-absent-herdr",
            observedCwd: repoDir,
            promptNonce: "nonce-cancel-absent",
            fencedAt: new Date().toISOString(),
          },
        },
      });
      mockGateway.workspaceAbsent = true;
      const cancelled = await manager.cancelAgent({
        workspaceId: "ws_cancel_absent",
        workspaceRoot: repoDir,
        agentId: rec.id,
      });
      assert.equal(cancelled.status, "error");
      assert.equal(store.getById(rec.id)?.terminalReason, "launch_failed");
      assert.equal(manager.runningCount(), 0);
      mockGateway.workspaceAbsent = false;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // CASE 8: Restart preserves stale no-handle reconciliation and exact absence proof.
    // ─────────────────────────────────────────────────────────────────────────────
    {
      const restartStateDir = mkdtempSync(join(tmpdir(), "devspace-herdr-restart-state-"));
      const restartGateway = new Mock5DHerdrGateway(
        "/tmp/mock-herdr-restart.sock",
        defaultHerdrGatewayRegistry,
      );
      const restartConfig = { ...config, stateDir: restartStateDir };
      const firstManager = new LocalAgentSessionManager(
        restartConfig,
        async () => {},
        async () => true,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        restartGateway,
      );
      try {
        const firstStore = (firstManager as any).store as LocalAgentStore;
        const rec = firstStore.create({
          workspaceId: "ws_restart_stale",
          workspaceRoot: repoDir,
          profileName: "reviewer",
          provider: "opencode",
          lifecycleKind: "detached_worker_v2",
        });
        firstStore.bindExternalRuntimeBindingCAS({
          agentId: rec.id,
          binding: {
            runtimeKind: "HERDR",
            launch: {
              state: "AGENT_OBSERVED",
              launchRequestId: "HERDR-LAUNCH:attempt-restart-stale",
              attemptKey: "attempt-restart-stale",
              dispatchIntentHash: "hash-restart-stale",
              canonicalWorktreePath: repoDir,
              gitHeadBefore: initialHead,
              agentKind: "opencode",
              herdrSocketPath: "/tmp/mock-herdr-restart.sock",
              herdrWorkspaceId: "ws-restart-stale-herdr",
              herdrPaneId: "pane-restart-stale-herdr",
              herdrAgentIdentity: "agent-restart-stale-herdr",
              observedCwd: repoDir,
              promptNonce: "nonce-restart-stale",
              fencedAt: new Date().toISOString(),
            },
          },
        });
        assert.equal(firstManager.runningCount(), 1);
      } finally {
        firstManager.close();
      }

      restartGateway.workspaceAbsent = true;
      const restartedManager = new LocalAgentSessionManager(
        restartConfig,
        async () => {},
        async () => true,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        restartGateway,
      );
      try {
        assert.equal(restartedManager.runningCount(), 1, "Restart reloads the fenced stale slot");
        const preflight = await restartedManager.preflightAgent({
          workspaceId: "ws_restart_stale",
          workspaceRoot: repoDir,
          isolated: false,
          profileName: "reviewer",
          profiles: mockProfiles,
        });
        assert.equal(preflight.capacity.localState, "AVAILABLE");
        assert.equal(restartedManager.runningCount(), 0, "Restarted manager reclaims only after exact absence proof");
      } finally {
        restartedManager.close();
        rmSync(restartStateDir, { recursive: true, force: true });
      }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // CASE 9: External absence without provable local physical state stays fenced.
    // ─────────────────────────────────────────────────────────────────────────────
    {
      const nonGitDir = mkdtempSync(join(tmpdir(), "devspace-herdr-unknown-physical-"));
      const store = (manager as any).store as LocalAgentStore;
      try {
        const rec = store.create({
          workspaceId: "ws_unknown_physical",
          workspaceRoot: nonGitDir,
          profileName: "reviewer",
          provider: "opencode",
          lifecycleKind: "detached_worker_v2",
        });
        store.bindExternalRuntimeBindingCAS({
          agentId: rec.id,
          binding: {
            runtimeKind: "HERDR",
            launch: {
              state: "WORKSPACE_OBSERVED",
              launchRequestId: "HERDR-LAUNCH:attempt-unknown-physical",
              attemptKey: "attempt-unknown-physical",
              dispatchIntentHash: "hash-unknown-physical",
              canonicalWorktreePath: nonGitDir,
              gitHeadBefore: initialHead,
              agentKind: "opencode",
              herdrSocketPath: "/tmp/mock-herdr.sock",
              herdrWorkspaceId: "ws-unknown-physical-herdr",
              herdrPaneId: "pane-unknown-physical-herdr",
              herdrAgentIdentity: "agent-unknown-physical-herdr",
              observedCwd: nonGitDir,
              promptNonce: "nonce-unknown-physical",
              fencedAt: new Date().toISOString(),
            },
          },
        });
        mockGateway.workspaceAbsent = true;

        const reclaimed = await manager.reconcileStaleHerdRSessions();
        assert.equal(reclaimed, 0, "External absence alone cannot release a slot when physical state is unknown");
        assert.equal(manager.runningCount(), 1);

        await assert.rejects(
          manager.cancelAgent({
            workspaceId: "ws_unknown_physical",
            workspaceRoot: nonGitDir,
            agentId: rec.id,
          }),
          (error: any) => {
            assert.equal(error.code, "AGENT_LIFECYCLE_CORRUPT");
            assert.match(error.message, /slot remains fenced/);
            return true;
          },
        );
        assert.equal(manager.runningCount(), 1, "Failed cancel must preserve the fenced slot");
        mockGateway.workspaceAbsent = false;
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }
    }

    manager.close();
  } finally {
    defaultHerdrGatewayRegistry.releaseHandle("attempt-unreachable-1");
    defaultHerdrGatewayRegistry.releaseHandle("attempt-mismatch-1");
    defaultHerdrGatewayRegistry.releaseHandle("attempt-absent-1");
    defaultHerdrGatewayRegistry.releaseHandle("attempt-jit-1");
    defaultHerdrGatewayRegistry.releaseHandle("attempt-jit-new");
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});
