import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { LocalAgentSessionManager, AgentSessionError } from "./local-agent-sessions.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";

function setupFixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-agent-sessions-test-"));
  const config = {
    stateDir,
    subagents: true,
    oauth: { scopes: ["devspace"] },
  } as any;

  const spawnedWorkers: { agentId: string; promptFile: string }[] = [];
  let shouldLaunchFail = false;
  let launchErrorMsg = "Spawn failed error";

  const mockLauncher = async (agentId: string, promptFile: string) => {
    if (shouldLaunchFail) {
      throw new Error(launchErrorMsg);
    }
    spawnedWorkers.push({ agentId, promptFile });
  };

  const manager = new LocalAgentSessionManager(config, mockLauncher);

  const clean = () => {
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {}
  };

  return {
    manager,
    spawnedWorkers,
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

    // 1. Successful start
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

    // Verify worker spawn
    assert.equal(spawnedWorkers.length, 1);
    assert.equal(spawnedWorkers[0].agentId, startResult.agentId);
    assert.ok(spawnedWorkers[0].promptFile);

    // Clean up successful launch's temp prompt file (the mock launcher doesn't delete it automatically, but we can do it)
    try {
      rmSync(dirname(spawnedWorkers[0].promptFile), { recursive: true, force: true });
    } catch {}

    // 2. Unknown profile error (UNKNOWN_PROFILE)
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

    // 3. PROVIDER_UNAVAILABLE: deterministic test
    const badProfile: LocalAgentProfile = {
      name: "broken",
      description: "broken test",
      provider: "pi", // pi provider requires pi executable which is unavailable
      disabled: false,
      filePath: "broken.md",
      body: "",
    };

    await assert.rejects(
      manager.startAgent({
        workspaceId: "ws_test",
        workspaceRoot,
        profileName: "broken",
        prompt: "hello",
        profiles: [...mockProfiles, badProfile],
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

    // Verify record properties
    assert.equal(record.status, "starting");

    // Transition to idle and set providerSessionId
    manager.updateRecord(record.agentId, {
      status: "idle",
      latestResponse: "done 1",
      providerSessionId: "provider-session-123"
    });

    // 1. Successful continue preserves identity
    const continueResult = await manager.continueAgent({
      workspaceId: "ws_test",
      workspaceRoot,
      agentId: record.agentId,
      prompt: "hello 2",
    });

    assert.equal(continueResult.agentId, record.agentId);
    assert.equal(continueResult.status, "starting");
    assert.equal(continueResult.continued, true);

    // Verify only 1 record exists in DB
    const list = manager.listAgents({ workspaceId: "ws_test" });
    assert.equal(list.length, 1);
    assert.equal(list[0].agentId, record.agentId);

    // Verify providerSessionId was preserved in DB
    const recordInDb = manager.getRecordByPrefixOrId(record.agentId);
    assert.ok(recordInDb);
    assert.equal(recordInDb.providerSessionId, "provider-session-123");

    // Clean up temp files
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

    // Actual ID is e.g. agt_abc12345 (length 12)
    const exactId = record.agentId;
    const prefixId = exactId.slice(0, 7);

    // A. continueAgent with prefix must reject with UNKNOWN_AGENT
    await assert.rejects(
      manager.continueAgent({
        workspaceId: "ws_test",
        workspaceRoot,
        agentId: prefixId,
        prompt: "hello prefix",
      }),
      (err: any) => {
        assert.equal(err.code, "UNKNOWN_AGENT");
        return true;
      }
    );

    // B. getAgentStatus with prefix must reject with UNKNOWN_AGENT
    await assert.rejects(
      manager.getAgentStatus({
        workspaceId: "ws_test",
        workspaceRoot,
        agentId: prefixId,
      }),
      (err: any) => {
        assert.equal(err.code, "UNKNOWN_AGENT");
        return true;
      }
    );

    // C. CLI prefix resolution (getRecordByPrefixOrId) must still work
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

    const record = await manager.startAgent({
      workspaceId: "ws_test",
      workspaceRoot,
      profileName: "reviewer",
      prompt: "hello 1",
      profiles: mockProfiles,
    });

    manager.updateRecord(record.agentId, { status: "idle" });

    // A. getAgentStatus with different physical root fails
    await assert.rejects(
      manager.getAgentStatus({
        workspaceId: "ws_test",
        workspaceRoot: "/other/physical/path",
        agentId: record.agentId,
      }),
      (err: any) => {
        assert.equal(err.code, "AGENT_WORKSPACE_MISMATCH");
        return true;
      }
    );

    // B. continueAgent with different physical root fails
    await assert.rejects(
      manager.continueAgent({
        workspaceId: "ws_test",
        workspaceRoot: "/other/physical/path",
        agentId: record.agentId,
        prompt: "continue with bad root",
      }),
      (err: any) => {
        assert.equal(err.code, "AGENT_WORKSPACE_MISMATCH");
        return true;
      }
    );

    // C. listAgents with matching workspaceId but different workspaceRoot must be empty
    const matchedList = manager.listAgents({ workspaceId: "ws_test", workspaceRoot });
    assert.equal(matchedList.length, 1);

    const mismatchedList = manager.listAgents({ workspaceId: "ws_test", workspaceRoot: "/other/physical/path" });
    assert.equal(mismatchedList.length, 0);

  } finally {
    clean();
  }
});

test("LocalAgentSessionManager - recorded error state in status", async () => {
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

    // Force error status in DB
    manager.updateRecord(record.agentId, {
      status: "error",
      error: "API call timed out after 30s"
    });

    const status = await manager.getAgentStatus({
      workspaceId: "ws_test",
      workspaceRoot,
      agentId: record.agentId,
    });

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

    // Set launcher mock to fail
    setLaunchFail(true, "Permission denied spawning worker process");

    let promptFileCaptured = "";
    // Intercept prompt file path by listening to writePromptFile if we wanted,
    // but we can also just find it from temp folder or check if startAgent cleaned it.
    // Instead we can spy or check DB record state
    
    await assert.rejects(
      manager.startAgent({
        workspaceId: "ws_test",
        workspaceRoot,
        profileName: "reviewer",
        prompt: "hello launch failure test",
        profiles: mockProfiles,
      }),
      (err: any) => {
        assert.equal(err.code, "WORKER_LAUNCH_FAILED");
        assert.match(err.message, /Permission denied/);
        return true;
      }
    );

    // Verify DB state of this session is set to error, NOT starting (no phantom starting)
    const list = manager.listAgents({ workspaceId: "ws_test", workspaceRoot });
    assert.equal(list.length, 1);
    assert.equal(list[0].status, "error");

    const recordInDb = manager.getRecordByPrefixOrId(list[0].agentId);
    assert.ok(recordInDb);
    assert.match(recordInDb.error || "", /Permission denied/);

    // Let's verify launch failure on continueAgent
    manager.updateRecord(recordInDb.id, { status: "idle" });
    
    await assert.rejects(
      manager.continueAgent({
        workspaceId: "ws_test",
        workspaceRoot,
        agentId: recordInDb.id,
        prompt: "continue launch failure test"
      }),
      (err: any) => {
        assert.equal(err.code, "WORKER_LAUNCH_FAILED");
        return true;
      }
    );

    const recordAfterFailedContinue = manager.getRecordByPrefixOrId(recordInDb.id);
    assert.ok(recordAfterFailedContinue);
    assert.equal(recordAfterFailedContinue.status, "error");

  } finally {
    clean();
  }
});

test("LocalAgentSessionManager - prompt cleanup paths", async () => {
  const { manager, clean } = setupFixture();
  try {
    const workspaceRoot = "/Users/jameschen/Workspace/nexus";

    // A. Successful worker path: runWorkerTurnFromFile deletes file
    const record = await manager.startAgent({
      workspaceId: "ws_test",
      workspaceRoot,
      profileName: "reviewer",
      prompt: "success prompt turn",
      profiles: mockProfiles,
    });

    const activeRecord = manager.getRecordByPrefixOrId(record.agentId);
    assert.ok(activeRecord);
    
    // We need to write a fake prompt file manually so we can execute runWorkerTurnFromFile
    const tempDir = mkdtempSync(join(tmpdir(), "devspace-agent-prompt-"));
    const tempFile = join(tempDir, "prompt.txt");
    writeFileSync(tempFile, "run this prompt", { mode: 0o600 });
    assert.ok(existsSync(tempFile));

    // Mock provider execution to resolve immediately (simulate successful turn)
    // runWorkerTurnFromFile will execute and call runLocalAgentProfile, which we can mock or let it fail
    // If it fails with profile error or provider error, it transitions to "error" status but STILL cleans up prompt.
    // Let's execute it:
    await manager.runWorkerTurnFromFile(record.agentId, tempFile);

    // Prompt file and parent temp directory must be deleted
    assert.equal(existsSync(tempFile), false);
    assert.equal(existsSync(tempDir), false);

    // B. Error worker path: runWorkerTurnFromFile deletes file even when provider execution fails
    const record2 = await manager.startAgent({
      workspaceId: "ws_test",
      workspaceRoot,
      profileName: "reviewer",
      prompt: "error prompt turn",
      profiles: mockProfiles,
    });

    const tempDir2 = mkdtempSync(join(tmpdir(), "devspace-agent-prompt-"));
    const tempFile2 = join(tempDir2, "prompt.txt");
    writeFileSync(tempFile2, "fail this prompt", { mode: 0o600 });

    // Corrupt profile name in DB to force runWorkerTurnFromFile to fail during execution
    manager.updateRecord(record2.agentId, { profileName: "nonexistent-profile" });

    await manager.runWorkerTurnFromFile(record2.agentId, tempFile2);

    // Verifies it still cleans up prompt file on throw
    assert.equal(existsSync(tempFile2), false);
    assert.equal(existsSync(tempDir2), false);

    // C. Unowned path delete protection: cleanup must refuse to delete arbitrary paths
    const safeFile = join(tmpdir(), "arbitrary.txt");
    writeFileSync(safeFile, "keep me safe", { mode: 0o600 });
    
    // We invoke runWorkerTurnFromFile with it. It will read it, fail, and pass it to cleanup.
    // But since it doesn't match the owned-temp pattern, cleanup must refuse to delete it.
    const record3 = await manager.startAgent({
      workspaceId: "ws_test",
      workspaceRoot,
      profileName: "reviewer",
      prompt: "unowned check",
      profiles: mockProfiles,
    });
    
    await manager.runWorkerTurnFromFile(record3.agentId, safeFile);
    
    // File must still exist!
    assert.ok(existsSync(safeFile));
    try { rmSync(safeFile, { force: true }); } catch {}

  } finally {
    clean();
  }
});
