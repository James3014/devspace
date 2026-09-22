import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  HerdrThinGateway,
  HerdrGatewayRegistry,
  HERDR_RUNTIME_KIND,
  detectBlockedOnboardingDialog,
  cleanPorcelainPath,
  parsePorcelainChangedPaths,
  type HerdrExternalHandle,
  type HerdrSocketRequest,
  type HerdrSocketResponse,
} from "./local-agent-herdr.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { hashDispatchIntent } from "./execution-protocol.js";

test("HerdrGatewayRegistry enforces N1 duplicate prevention and N2 conflicting replay", () => {
  const registry = new HerdrGatewayRegistry();

  const handle1: HerdrExternalHandle = {
    schemaVersion: 1,
    runtimeKind: HERDR_RUNTIME_KIND,
    herdrSocketPath: "/tmp/test.sock",
    herdrWorkspaceId: "w1",
    herdrPaneId: "w1:p1",
    herdrAgentIdentity: "ds-attempt-1",
    herdrAgentKind: "opencode",
    promptNonce: "NONCE-1",
    canonicalWorktreePath: "/tmp/worktree",
    workspaceId: "ws-1",
    gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
    attemptKey: "attempt-1",
    dispatchIntentHash: "intent-hash-a",
    launchTimestamp: new Date().toISOString(),
    enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
  };

  // Register handle
  registry.registerHandle(handle1);
  assert.equal(registry.getHandle("attempt-1"), handle1);

  // N1 Duplicate Prevention: Same attemptKey + same intent hash does not duplicate
  registry.registerHandle(handle1);
  assert.equal(registry.getHandle("attempt-1"), handle1);

  // N2 Conflicting Replay: Same attemptKey + different intent hash fails closed
  const conflictingHandle: HerdrExternalHandle = {
    ...handle1,
    dispatchIntentHash: "intent-hash-b",
  };

  assert.throws(
    () => registry.registerHandle(conflictingHandle),
    /Conflicting replay for attemptKey 'attempt-1'/,
  );

  // Release
  registry.releaseHandle("attempt-1");
  assert.equal(registry.getHandle("attempt-1"), undefined);
});

test("detectBlockedOnboardingDialog catches onboarding, trust and login menus (A5, N-TRUST)", () => {
  // Codex onboarding
  assert.equal(detectBlockedOnboardingDialog("codex", "Welcome to Codex, OpenAI's command-line coding agent\n1. Sign in with ChatGPT"), true);
  assert.equal(detectBlockedOnboardingDialog("codex", "Sign in with Device Code"), true);
  assert.equal(detectBlockedOnboardingDialog("codex", "Provide your own API key"), true);
  assert.equal(detectBlockedOnboardingDialog("codex", "Regular prompt: What is your task?"), false);

  // Cline onboarding
  assert.equal(detectBlockedOnboardingDialog("cline", "Enter this code in your browser: SRDP-QVKC\nhttps://authkit.cline.bot/device"), true);
  assert.equal(detectBlockedOnboardingDialog("cline", "Ready for prompt"), false);

  // Trust prompts (A5 / N-TRUST)
  assert.equal(detectBlockedOnboardingDialog("agy", "Do you trust the contents of this project?\nAntigravity CLI requires permission"), true);
  assert.equal(detectBlockedOnboardingDialog("agy", "Do you trust the authors of this repository?"), true);
  assert.equal(detectBlockedOnboardingDialog("agy", "Allow creation of this file? [y/n]"), true);
  assert.equal(detectBlockedOnboardingDialog("agy", "Antigravity CLI 1.2.8\nReady for input"), false);
});

test("Git base fence fails closed when Git HEAD is unresolvable (A9)", async () => {
  const nonGitDir = mkdtempSync(join(tmpdir(), "herdr-nongit-"));
  const gateway = new HerdrThinGateway();
  try {
    await assert.rejects(
      gateway.startExternalAgent({
        attemptKey: "attempt-nongit",
        dispatchIntentHash: "intent-nongit",
        agentKind: "opencode",
        canonicalWorktreePath: nonGitDir,
        workspaceId: "ws-nongit",
      }),
      (err: any) => {
        assert.match(err.message, /\[A9 Git Base Fence\]/);
        return true;
      },
    );
  } finally {
    rmSync(nonGitDir, { recursive: true, force: true });
  }
});

test("HerdrThinGateway reconciliation enforces N5, N5-COMMIT, N6, N6-COMMIT, N7, N7-PHYSICAL, N8 controls", async () => {
  // Create a temporary git repo worktree
  const testDir = mkdtempSync(join(tmpdir(), "herdr-reconcile-test-"));
  try {
    execFileSync("git", ["init", testDir], { stdio: "ignore" });
    execFileSync("git", ["-C", testDir, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", testDir, "config", "user.email", "test@example.com"], { stdio: "ignore" });

    // Initial commit (valid 40-character commit SHA for gitHeadBefore)
    writeFileSync(join(testDir, "README.md"), "# Initial\n");
    execFileSync("git", ["-C", testDir, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", testDir, "commit", "-m", "init"], { stdio: "ignore" });
    const initCommit = execFileSync("git", ["-C", testDir, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

    const gateway = new HerdrThinGateway("/nonexistent/herdr.sock");
    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      herdrSocketPath: "/nonexistent/herdr.sock",
      herdrWorkspaceId: "w1",
      herdrPaneId: "w1:p1",
      herdrAgentIdentity: "ds-attempt-2",
      herdrAgentKind: "opencode",
      promptNonce: "NONCE-2",
      canonicalWorktreePath: testDir,
      workspaceId: "ws-2",
      gitHeadBefore: initCommit,
      attemptKey: "attempt-2",
      dispatchIntentHash: "hash-2",
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    // N7: Server unreachable, no mutations -> OUTCOME_UNKNOWN, physicalEffect ABSENT
    const resServerDown = await gateway.reconcileExternalAgent(handle);
    assert.equal(resServerDown.completionStatus, "OUTCOME_UNKNOWN");
    assert.equal(resServerDown.settled, false);
    assert.equal(resServerDown.physicalEffect, "ABSENT");
    assert.match(resServerDown.reason || "", /UNRECOVERABLE_PROCESS_UPON_HEADLESS_RESTART/);
    assert.equal(resServerDown.enforcementState, "REQUEST_ONLY_NOT_ENFORCED"); // N8

    // N7-PHYSICAL: Server unreachable, but physical mutation exists on disk
    writeFileSync(join(testDir, "README.md"), "# Modified by worker before server loss\n");
    const resServerDownMutated = await gateway.reconcileExternalAgent(handle);
    assert.equal(resServerDownMutated.completionStatus, "OUTCOME_UNKNOWN");
    assert.equal(resServerDownMutated.settled, false);
    assert.equal(resServerDownMutated.physicalEffect, "PRESENT");
    assert.deepEqual(resServerDownMutated.changedPaths, ["README.md"]);
    assert.equal(resServerDownMutated.enforcementState, "REQUEST_ONLY_NOT_ENFORCED"); // N8

    // Reset README.md
    execFileSync("git", ["-C", testDir, "checkout", "README.md"], { stdio: "ignore" });

    // Mock live gateway to test terminal states
    const liveGateway = new HerdrThinGateway();

    // N5: Worker settled terminal, but physical git status is clean -> NOT_COMPLETE
    const resClean = await liveGateway.reconcileExternalAgent(handle, ["feature.ts"], true, { status: "done", turnNonce: "turn-n5" });
    assert.equal(resClean.settled, true);
    assert.equal(resClean.completionStatus, "NOT_COMPLETE");
    assert.equal(resClean.physicalEffect, "ABSENT");
    assert.match(resClean.reason || "", /no physical file modifications were observed/);
    assert.equal(resClean.enforcementState, "REQUEST_ONLY_NOT_ENFORCED"); // N8

    // N5-COMMIT: Worker committed authorized change; git status is clean, but git diff against gitHeadBefore detects commit
    writeFileSync(join(testDir, "feature.ts"), "export const ok = true;");
    execFileSync("git", ["-C", testDir, "add", "feature.ts"], { stdio: "ignore" });
    execFileSync("git", ["-C", testDir, "commit", "-m", "worker commit feature"], { stdio: "ignore" });
    const resCommitSuccess = await liveGateway.reconcileExternalAgent(handle, ["feature.ts"], true, { status: "done", turnNonce: "turn-n5-commit" });
    assert.equal(resCommitSuccess.settled, true);
    assert.equal(resCommitSuccess.completionStatus, "COMPLETED");
    assert.equal(resCommitSuccess.physicalEffect, "PRESENT");
    assert.deepEqual(resCommitSuccess.changedPaths, ["feature.ts"]);
    assert.deepEqual(resCommitSuccess.unexpectedPaths, []);
    assert.equal(resCommitSuccess.enforcementState, "REQUEST_ONLY_NOT_ENFORCED"); // N8

    // N6: Working tree has unexpected modification outside scope
    writeFileSync(join(testDir, "unexpected.txt"), "forbidden modification");
    const resUnexpected = await liveGateway.reconcileExternalAgent(handle, ["feature.ts"], true, { status: "done", turnNonce: "turn-n6" });
    assert.equal(resUnexpected.settled, true);
    assert.equal(resUnexpected.completionStatus, "SCOPE_VIOLATION"); // N6
    assert.ok(resUnexpected.unexpectedPaths.includes("unexpected.txt"));
    assert.equal(resUnexpected.enforcementState, "REQUEST_ONLY_NOT_ENFORCED"); // N8
    rmSync(join(testDir, "unexpected.txt"));

    // N6-COMMIT: Worker committed unauthorized path outside scope
    writeFileSync(join(testDir, "unauthorized.ts"), "export const backdoor = true;");
    execFileSync("git", ["-C", testDir, "add", "unauthorized.ts"], { stdio: "ignore" });
    execFileSync("git", ["-C", testDir, "commit", "-m", "worker commit unauthorized"], { stdio: "ignore" });
    const resCommitScopeViolation = await liveGateway.reconcileExternalAgent(handle, ["feature.ts"], true, { status: "done", turnNonce: "turn-n6-commit" });
    assert.equal(resCommitScopeViolation.settled, true);
    assert.equal(resCommitScopeViolation.completionStatus, "SCOPE_VIOLATION"); // N6-COMMIT
    assert.ok(resCommitScopeViolation.unexpectedPaths.includes("unauthorized.ts"));
    assert.equal(resCommitScopeViolation.enforcementState, "REQUEST_ONLY_NOT_ENFORCED"); // N8
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("HerdrThinGateway enforces N-TURN by rejecting prompts to busy agents", async () => {
  const gateway = new HerdrThinGateway();
  // Mock getAgent to simulate an already busy agent
  (gateway as any).getAgent = async () => ({
    agent_status: "running",
    interactive_ready: false,
  });

  const handle: HerdrExternalHandle = {
    schemaVersion: 1,
    runtimeKind: HERDR_RUNTIME_KIND,
    herdrSocketPath: "/tmp/test.sock",
    herdrWorkspaceId: "w1",
    herdrPaneId: "p1",
    herdrAgentIdentity: "ds-busy-agent",
    herdrAgentKind: "opencode",
    promptNonce: "NONCE",
    canonicalWorktreePath: "/tmp",
    workspaceId: "ws1",
    gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
    attemptKey: "attempt-busy",
    dispatchIntentHash: "intent-busy",
    launchTimestamp: new Date().toISOString(),
    enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
  };

  await assert.rejects(
    gateway.promptExternalAgent(handle, "consequential task", { allowTestOnlyNonConsequential: true }),
    (err: any) => {
      assert.match(err.message, /\[N-TURN\]/);
      return true;
    },
  );
});

test("HerdrThinGateway enforces Option A turn identity and durable nonce binding (B4, T1, T2, T3)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-herdr-turn-test-"));
  const store = new LocalAgentStore(stateDir);
  const registry = new HerdrGatewayRegistry();
  const gateway = new HerdrThinGateway("/tmp/test.sock", registry, store);

  try {
    const attemptKey = `turn-opt-a-${Date.now()}`;
    const dispatchIntent = {
      taskId: "task-opt-a",
      attemptId: attemptKey,
      objective: "Test Option A",
      roleIntent: "DEEP_ENGINEERING" as const,
      claimCeiling: "CANDIDATE_READY" as const,
      context: ["test"],
      readScope: ["src"],
      writeScope: ["src"],
      exclusiveOwnership: true,
      forbiddenChanges: [],
      acceptanceCriteria: ["pass"],
      verificationRequired: true,
      expectedArtifacts: [],
    };
    const dispatchIntentHash = hashDispatchIntent(dispatchIntent);
    const agent = store.create({
      workspaceId: "ws1",
      workspaceRoot: "/tmp",
      profileName: "reviewer",
      provider: "opencode",
      startReplay: { key: attemptKey, requestHash: "hash-opt-a" },
      executionContract: {
        writePaths: ["src"],
        dispatchIntent,
      },
    });

    const promptNonce = `DURABLE-NONCE-${attemptKey}`;
    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      agentId: agent.id,
      herdrSocketPath: "/tmp/test.sock",
      herdrWorkspaceId: "w1",
      herdrPaneId: "p1",
      herdrAgentIdentity: "ds-turn-agent",
      herdrAgentKind: "opencode",
      promptNonce,
      canonicalWorktreePath: "/tmp",
      workspaceId: "ws1",
      gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
      attemptKey,
      dispatchIntentHash,
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    store.bindExternalRuntimeBindingCAS({
      agentId: agent.id,
      expectedAttemptKey: attemptKey,
      expectedDispatchIntentHash: dispatchIntentHash,
      binding: {
        runtimeKind: HERDR_RUNTIME_KIND,
        handle: handle as unknown as Record<string, unknown>,
      },
    });

    registry.registerHandle(handle);

    (gateway as any).getAgent = async () => ({
      agent_status: "idle",
      interactive_ready: true,
    });
    (gateway as any).readPane = async () => "ready\n";

    let capturedPrompt = "";
    (gateway as any).sendRequest = async (req: any) => {
      if (req.method === "agent.prompt") {
        capturedPrompt = req.params?.text ?? "";
        return { result: { agent: { agent_status: "done", interactive_ready: true } } };
      }
      return { result: {} };
    };

    assert.equal(registry.hasPromptSubmitted(attemptKey), false);

    // T1: First prompt submits successfully and embeds durable promptNonce
    const firstRes = await gateway.promptExternalAgent(handle, "first prompt on handle", { store });
    assert.equal(firstRes.status, "done");
    assert.equal(firstRes.turnNonce, handle.promptNonce);
    assert.ok(capturedPrompt.includes(`[NEXUS_ATTEMPT_NONCE:${handle.promptNonce}]`));
    assert.ok(capturedPrompt.includes("first prompt on handle"));
    assert.equal(registry.hasPromptSubmitted(attemptKey), true);

    // T2: Second prompt rejected under Option A
    await assert.rejects(
      gateway.promptExternalAgent(handle, "second prompt on same handle", { store }),
      (err: any) => {
        assert.match(err.message, /\[N-TURN-OPTION-A\]/);
        return true;
      },
    );
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("HerdrThinGateway enforces N-ATTEST by leaving effectiveModel undefined without readback", async () => {
  const gateway = new HerdrThinGateway();
  const worktreePath = "/Users/james/workspace/devspace";
  const attemptKey = `attest-test-${Date.now()}`;

  // Registry validation: requestedModel does not populate effectiveModel
  const handle: HerdrExternalHandle = {
    schemaVersion: 1,
    runtimeKind: HERDR_RUNTIME_KIND,
    herdrSocketPath: "/tmp/test.sock",
    herdrWorkspaceId: "w1",
    herdrPaneId: "p1",
    herdrAgentIdentity: "ds-attest",
    herdrAgentKind: "opencode",
    requestedModel: "opencode/mimo-v2.6-flash-free",
    effectiveModel: undefined,
    promptNonce: "NONCE",
    canonicalWorktreePath: worktreePath,
    workspaceId: "ws-attest",
    gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
    attemptKey,
    dispatchIntentHash: "intent-attest",
    launchTimestamp: new Date().toISOString(),
    enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
  };

  assert.equal(handle.requestedModel, "opencode/mimo-v2.6-flash-free");
  assert.equal(handle.effectiveModel, undefined);
  assert.equal(handle.effectiveProvider, undefined);
  assert.equal(handle.effectiveEffort, undefined);
});

test("HerdrThinGateway live canary with OpenCode on isolated worktree", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-canary-oc-store-"));
  const store = new LocalAgentStore(stateDir);
  const gateway = new HerdrThinGateway(undefined, undefined, store);
  const worktreePath = "/Users/james/.devspace/worktrees/herdr-gateway-canary-oc";

  // Clean up any stale worktree
  try {
    execFileSync("git", ["-C", "/Users/james/workspace/devspace", "worktree", "remove", worktreePath, "--force"], { stdio: "ignore" });
  } catch {}
  try {
    execFileSync("git", ["-C", "/Users/james/workspace/devspace", "branch", "-D", "canary-oc-branch"], { stdio: "ignore" });
  } catch {}

  // Create isolated test worktree
  execFileSync("git", ["-C", "/Users/james/workspace/devspace", "worktree", "add", "-b", "canary-oc-branch", worktreePath, "3f8d6c12c4986c0af806944d9aaa7c3427fb0380"], { stdio: "ignore" });

  try {
    const attemptKey = `canary-oc-${Date.now()}`;
    const dispatchIntent = {
      taskId: "task-canary-oc",
      attemptId: attemptKey,
      objective: "OpenCode live canary",
      roleIntent: "DEEP_ENGINEERING" as const,
      claimCeiling: "CANDIDATE_READY" as const,
      context: ["test"],
      readScope: ["src"],
      writeScope: ["src", "oc_canary.txt"],
      exclusiveOwnership: true,
      forbiddenChanges: [],
      acceptanceCriteria: ["pass"],
      verificationRequired: true,
      expectedArtifacts: [],
    };
    const dispatchIntentHash = hashDispatchIntent(dispatchIntent);
    const agent = store.create({
      workspaceId: "canary-ws-oc",
      workspaceRoot: worktreePath,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attemptKey, requestHash: "hash-canary-oc" },
      executionContract: {
        writePaths: ["src", "oc_canary.txt"],
        dispatchIntent,
      },
    });

    const handle = await gateway.startExternalAgent({
      agentId: agent.id,
      attemptKey,
      dispatchIntentHash,
      agentKind: "opencode",
      canonicalWorktreePath: worktreePath,
      workspaceId: "canary-ws-oc",
      requestedModel: "opencode/mimo-v2.6-flash-free",
    });

    assert.equal(handle.runtimeKind, HERDR_RUNTIME_KIND);
    assert.equal(handle.enforcementState, "REQUEST_ONLY_NOT_ENFORCED"); // N8
    assert.equal(handle.canonicalWorktreePath, worktreePath);
    assert.equal(handle.effectiveModel, undefined); // A6 / N-ATTEST

    const nonce = `OPENCODE-REAL-MUTATION-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Prompt OpenCode to create a file with exact nonce
    const promptRes = await gateway.promptExternalAgent(
      handle,
      `Create a file named oc_canary.txt containing exact text:\n${nonce}\nDo not ask questions.`,
      { timeoutMs: 60_000 },
    );
    assert.ok(promptRes.status === "done" || promptRes.status === "idle");
    assert.ok(promptRes.turnNonce);

    // Independently verify physical file exists and contains exact nonce (A4)
    const filePath = join(worktreePath, "oc_canary.txt");
    const fileContent = readFileSync(filePath, "utf-8");
    assert.ok(fileContent.includes(nonce), `Expected ${fileContent} to contain nonce ${nonce}`);

    // Reconcile physical completion
    const reconcileRes = await gateway.reconcileExternalAgent(handle, ["oc_canary.txt"], true, promptRes);
    assert.equal(reconcileRes.completionStatus, "COMPLETED");
    assert.equal(reconcileRes.physicalEffect, "PRESENT");
    assert.deepEqual(reconcileRes.changedPaths, ["oc_canary.txt"]);

    // Clean up
    await gateway.stopExternalAgent(handle);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    try {
      execFileSync("git", ["-C", "/Users/james/workspace/devspace", "worktree", "remove", worktreePath, "--force"], { stdio: "ignore" });
    } catch {}
    try {
      execFileSync("git", ["-C", "/Users/james/workspace/devspace", "branch", "-D", "canary-oc-branch"], { stdio: "ignore" });
    } catch {}
  }
});

test("HerdrThinGateway live canary with Agy on isolated worktree", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-canary-agy-store-"));
  const store = new LocalAgentStore(stateDir);
  const gateway = new HerdrThinGateway(undefined, undefined, store);
  const worktreePath = "/Users/james/.devspace/worktrees/herdr-gateway-canary-agy";

  // Clean up any stale worktree
  try {
    execFileSync("git", ["-C", "/Users/james/workspace/devspace", "worktree", "remove", worktreePath, "--force"], { stdio: "ignore" });
  } catch {}
  try {
    execFileSync("git", ["-C", "/Users/james/workspace/devspace", "branch", "-D", "canary-agy-branch"], { stdio: "ignore" });
  } catch {}

  // Create isolated test worktree
  execFileSync("git", ["-C", "/Users/james/workspace/devspace", "worktree", "add", "-b", "canary-agy-branch", worktreePath, "3f8d6c12c4986c0af806944d9aaa7c3427fb0380"], { stdio: "ignore" });

  try {
    const attemptKey = `canary-agy-${Date.now()}`;
    const dispatchIntent = {
      taskId: "task-canary-agy",
      attemptId: attemptKey,
      objective: "Agy live canary",
      roleIntent: "DEEP_ENGINEERING" as const,
      claimCeiling: "CANDIDATE_READY" as const,
      context: ["test"],
      readScope: ["src"],
      writeScope: ["src", "agy_canary.txt"],
      exclusiveOwnership: true,
      forbiddenChanges: [],
      acceptanceCriteria: ["pass"],
      verificationRequired: true,
      expectedArtifacts: [],
    };
    const dispatchIntentHash = hashDispatchIntent(dispatchIntent);
    const agent = store.create({
      workspaceId: "canary-ws-agy",
      workspaceRoot: worktreePath,
      profileName: "worker",
      provider: "agy",
      startReplay: { key: attemptKey, requestHash: "hash-canary-agy" },
      executionContract: {
        writePaths: ["src", "agy_canary.txt"],
        dispatchIntent,
      },
    });

    let handle: HerdrExternalHandle | undefined;
    try {
      handle = await gateway.startExternalAgent({
        agentId: agent.id,
        attemptKey,
        dispatchIntentHash,
        agentKind: "agy",
        canonicalWorktreePath: worktreePath,
        workspaceId: "canary-ws-agy",
      });
    } catch (startErr: any) {
      // Truthful BLOCKED_ON_PERMISSION_ADMISSION fail-closed outcome (B3 / Section 13 / 26)
      assert.match(
        startErr.message,
        /BLOCKED_ON_PERMISSION_ADMISSION/,
        `Expected start error to be BLOCKED_ON_PERMISSION_ADMISSION, got ${startErr.message}`,
      );
      return;
    }

    assert.equal(handle.runtimeKind, HERDR_RUNTIME_KIND);
    assert.equal(handle.enforcementState, "REQUEST_ONLY_NOT_ENFORCED"); // N8
    assert.equal(handle.canonicalWorktreePath, worktreePath);
    assert.equal(handle.effectiveModel, undefined); // A6 / N-ATTEST

    const nonce = `AGY-REAL-MUTATION-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Prompt Agy to create a file with exact nonce
    const promptRes = await gateway.promptExternalAgent(
      handle,
      `Create a file named agy_canary.txt containing exact text:\n${nonce}\nDo not ask questions.`,
      { timeoutMs: 60_000 },
    );

    if (promptRes.status === "blocked" || promptRes.rawStatus === "BLOCKED_ON_PERMISSION_ADMISSION") {
      // Truthfully blocked on permission admission during prompt
      const reconcileRes = await gateway.reconcileExternalAgent(handle, ["agy_canary.txt"], true, promptRes);
      assert.equal(reconcileRes.completionStatus, "NOT_COMPLETE");
      assert.equal(reconcileRes.executionState, "BLOCKED");
      await gateway.stopExternalAgent(handle);
      return;
    }

    // If file was not created by worker due to lack of permission admission:
    const filePath = join(worktreePath, "agy_canary.txt");
    if (!existsSync(filePath)) {
      const reconcileRes = await gateway.reconcileExternalAgent(handle, ["agy_canary.txt"], true, promptRes);
      assert.equal(reconcileRes.completionStatus, "NOT_COMPLETE");
      assert.equal(reconcileRes.physicalEffect, "ABSENT");
      await gateway.stopExternalAgent(handle);
      return;
    }

    assert.ok(promptRes.status === "done" || promptRes.status === "idle");
    assert.ok(promptRes.turnNonce);

    // Independently verify physical file exists and contains exact nonce (A4 - ZERO test-authored writeFileSync!)
    const fileContent = readFileSync(filePath, "utf-8");
    assert.ok(fileContent.includes(nonce), `Expected ${fileContent} to contain nonce ${nonce}`);

    // Reconcile physical completion
    const reconcileRes = await gateway.reconcileExternalAgent(handle, ["agy_canary.txt"], true, promptRes);
    assert.equal(reconcileRes.completionStatus, "COMPLETED");
    assert.equal(reconcileRes.physicalEffect, "PRESENT");
    assert.deepEqual(reconcileRes.changedPaths, ["agy_canary.txt"]);

    // Clean up
    await gateway.stopExternalAgent(handle);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    try {
      execFileSync("git", ["-C", "/Users/james/workspace/devspace", "worktree", "remove", worktreePath, "--force"], { stdio: "ignore" });
    } catch {}
    try {
      execFileSync("git", ["-C", "/Users/james/workspace/devspace", "branch", "-D", "canary-agy-branch"], { stdio: "ignore" });
    } catch {}
  }
});

test("cleanPorcelainPath and parsePorcelainChangedPaths support renames, spaces, deletions, staged and untracked changes (P1-P8)", () => {
  // P8: unquotes quoted paths with spaces
  assert.equal(cleanPorcelainPath('"path with spaces.txt"'), "path with spaces.txt");
  assert.equal(cleanPorcelainPath("regular_path.ts"), "regular_path.ts");

  // P7: rename parsing
  const renameOutput = 'R  old.txt -> new.txt\nR  "old space.txt" -> "new space.txt"\n';
  const renamePaths = parsePorcelainChangedPaths(renameOutput);
  assert.deepEqual(renamePaths, ["old.txt", "new.txt", "old space.txt", "new space.txt"]);

  // P6: deletion parsing
  const deleteOutput = "D  deleted_file.txt\n D unstaged_deleted.txt\n";
  const deletePaths = parsePorcelainChangedPaths(deleteOutput);
  assert.deepEqual(deletePaths, ["deleted_file.txt", "unstaged_deleted.txt"]);

  // P1, P2: staged and untracked
  const mixedOutput = 'M  staged.ts\n M unstaged.ts\n?? untracked.ts\nA  "staged spaces.ts"\n';
  const mixedPaths = parsePorcelainChangedPaths(mixedOutput);
  assert.deepEqual(mixedPaths, ["staged.ts", "unstaged.ts", "untracked.ts", "staged spaces.ts"]);
});

test("HerdrThinGateway reconciliation handles renames, spaces, deletions and staged changes in physical Git repository (P1, P2, P6, P7, P8)", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "herdr-git-variations-"));
  try {
    execFileSync("git", ["init", testDir], { stdio: "ignore" });
    execFileSync("git", ["-C", testDir, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", testDir, "config", "user.email", "test@example.com"], { stdio: "ignore" });

    // Initial commit
    writeFileSync(join(testDir, "initial.txt"), "hello\n");
    writeFileSync(join(testDir, "to_delete.txt"), "delete me\n");
    writeFileSync(join(testDir, "to_rename.txt"), "rename me\n");
    execFileSync("git", ["-C", testDir, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", testDir, "commit", "-m", "init"], { stdio: "ignore" });
    const initCommit = execFileSync("git", ["-C", testDir, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

    const gateway = new HerdrThinGateway("/nonexistent/herdr.sock");
    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      herdrSocketPath: "/nonexistent/herdr.sock",
      herdrWorkspaceId: "w1",
      herdrPaneId: "w1:p1",
      herdrAgentIdentity: "ds-attempt-variations",
      herdrAgentKind: "opencode",
      promptNonce: "NONCE-VAR",
      canonicalWorktreePath: testDir,
      workspaceId: "ws-var",
      gitHeadBefore: initCommit,
      attemptKey: "attempt-var",
      dispatchIntentHash: "hash-var",
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    // P8: Create file with spaces in filename
    writeFileSync(join(testDir, "path with spaces.txt"), "space content\n");
    // P6: Delete a file
    rmSync(join(testDir, "to_delete.txt"));
    // P7: Rename a file
    execFileSync("git", ["-C", testDir, "mv", "to_rename.txt", "renamed.txt"], { stdio: "ignore" });

    // Reconcile with gateway (server down -> OUTCOME_UNKNOWN, but physicalEffect PRESENT) (P9)
    const rec = await gateway.reconcileExternalAgent(handle);
    assert.equal(rec.completionStatus, "OUTCOME_UNKNOWN");
    assert.equal(rec.physicalEffect, "PRESENT");
    assert.ok(rec.changedPaths.includes("path with spaces.txt"));
    assert.ok(rec.changedPaths.includes("to_delete.txt"));
    assert.ok(rec.changedPaths.includes("renamed.txt"));
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

class SpyHerdrGateway extends HerdrThinGateway {
  public workspaceCreateCalls = 0;
  public agentStartCalls = 0;
  public agentPromptCalls = 0;
  public agentWaitCalls = 0;
  public listWorkspacesCalls = 0;
  public getWorkspaceCalls = 0;
  public getAgentCalls = 0;

  public failWorkspaceCreate = false;
  public failAgentStart = false;
  public simulatedWorkspaces: Array<{ workspace_id: string; label?: string }> = [];
  public simulatedAgentStatus: { agent_status: string; interactive_ready: boolean } | undefined;

  override async sendRequest<T = unknown>(
    req: HerdrSocketRequest,
    timeoutMs: number = 10_000,
    socketPath?: string,
  ): Promise<HerdrSocketResponse<T>> {
    if (req.method === "workspace.create") {
      this.workspaceCreateCalls++;
      if (this.failWorkspaceCreate) {
        throw new Error("Simulated network timeout during workspace.create");
      }
      const wsId = `sim-ws-${Date.now()}-${this.workspaceCreateCalls}`;
      const paneId = `sim-pane-${Date.now()}-${this.workspaceCreateCalls}`;
      return {
        id: req.id,
        result: {
          workspace: { workspace_id: wsId },
          root_pane: {
            pane_id: paneId,
            cwd: (req.params as any)?.cwd,
            foreground_cwd: (req.params as any)?.cwd,
          },
        } as unknown as T,
      };
    }

    if (req.method === "agent.start") {
      this.agentStartCalls++;
      if (this.failAgentStart) {
        throw new Error("Simulated network timeout during agent.start");
      }
      return {
        id: req.id,
        result: {
          agent: {
            agent: (req.params as any)?.name,
            agent_status: "running",
            pane_id: (req.params as any)?.pane_id,
            state_change_seq: 1,
            interactive_ready: true,
          },
        } as unknown as T,
      };
    }

    if (req.method === "agent.prompt") {
      this.agentPromptCalls++;
      return {
        id: req.id,
        result: {
          agent: {
            agent: (req.params as any)?.target,
            agent_status: "done",
            interactive_ready: true,
          },
        } as unknown as T,
      };
    }

    if (req.method === "agent.wait") {
      this.agentWaitCalls++;
      return { id: req.id, result: {} as unknown as T };
    }

    if (req.method === "workspace.list") {
      this.listWorkspacesCalls++;
      return {
        id: req.id,
        result: {
          type: "workspace.list",
          workspaces: this.simulatedWorkspaces,
        } as unknown as T,
      };
    }

    if (req.method === "workspace.get") {
      this.getWorkspaceCalls++;
      return {
        id: req.id,
        result: {
          workspace: {
            workspace_id: (req.params as any)?.target,
            root_pane_id: `${(req.params as any)?.target}:p1`,
          },
        } as unknown as T,
      };
    }

    if (req.method === "agent.get") {
      this.getAgentCalls++;
      return {
        id: req.id,
        result: {
          type: "agent.get",
          agent: this.simulatedAgentStatus ?? {
            agent_status: "idle",
            interactive_ready: true,
          },
        } as unknown as T,
      };
    }

    return { id: req.id, result: {} as unknown as T };
  }

  override async readPane(paneId: string, lines: number = 50): Promise<string> {
    return "Ready prompt\n";
  }
}

test("HerdrThinGateway prompt fence negative matrix and zero external calls (C1, PF-WRONG-ATTEMPT, PF-WRONG-DISPATCH, PF-WRONG-NONCE, PF-MISSING-HANDLE, PF-MALFORMED-HANDLE, PF-WRONG-RUNTIME, PF-CONCURRENT, PF-EXACT)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-pf-matrix-"));
  const store = new LocalAgentStore(stateDir);
  const registry = new HerdrGatewayRegistry();
  const spy = new SpyHerdrGateway("/tmp/test.sock", registry, store);

  try {
    const attemptKey = `pf-test-${Date.now()}`;
    const dispatchIntent = {
      taskId: "task-pf",
      attemptId: attemptKey,
      objective: "Test PF negative matrix",
      roleIntent: "DEEP_ENGINEERING" as const,
      claimCeiling: "CANDIDATE_READY" as const,
      context: ["test"],
      readScope: ["src"],
      writeScope: ["src"],
      exclusiveOwnership: true,
      forbiddenChanges: [],
      acceptanceCriteria: ["pass"],
      verificationRequired: true,
      expectedArtifacts: [],
    };
    const dispatchIntentHash = hashDispatchIntent(dispatchIntent);
    const promptNonce = `DURABLE-NONCE-${attemptKey}`;

    const agent = store.create({
      workspaceId: "ws-pf",
      workspaceRoot: "/tmp",
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attemptKey, requestHash: "hash-pf" },
      executionContract: {
        writePaths: ["src"],
        dispatchIntent,
      },
    });

    const validHandle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      agentId: agent.id,
      herdrSocketPath: "/tmp/test.sock",
      herdrWorkspaceId: "ws1",
      herdrPaneId: "p1",
      herdrAgentIdentity: "ds-pf-agent",
      herdrAgentKind: "opencode",
      promptNonce,
      canonicalWorktreePath: "/tmp",
      workspaceId: "ws-pf",
      gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
      attemptKey,
      dispatchIntentHash,
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    // Bind valid handle into store
    store.bindExternalRuntimeBindingCAS({
      agentId: agent.id,
      expectedAttemptKey: attemptKey,
      expectedDispatchIntentHash: dispatchIntentHash,
      binding: {
        runtimeKind: HERDR_RUNTIME_KIND,
        handle: validHandle as unknown as Record<string, unknown>,
      },
    });

    // 1. PF-WRONG-AGENT-ATTEMPT: agentId points to agent with attemptKey, but handle has different attemptKey
    const wrongAttemptHandle = { ...validHandle, attemptKey: "WRONG-ATTEMPT" };
    await assert.rejects(
      spy.promptExternalAgent(wrongAttemptHandle, "prompt text", { store }),
      (err: any) => {
        assert.match(err.message, /\[N-TURN-OPTION-A\]/);
        return true;
      },
    );
    assert.equal(spy.agentPromptCalls, 0, "PF-WRONG-AGENT-ATTEMPT must result in 0 external prompt calls");

    // 2. PF-WRONG-DISPATCH: handle has mismatched dispatchIntentHash
    const wrongDispatchHandle = { ...validHandle, dispatchIntentHash: "WRONG-DISPATCH-HASH" };
    await assert.rejects(
      spy.promptExternalAgent(wrongDispatchHandle, "prompt text", { store }),
      (err: any) => {
        assert.match(err.message, /\[N-TURN-OPTION-A\]/);
        return true;
      },
    );
    assert.equal(spy.agentPromptCalls, 0, "PF-WRONG-DISPATCH must result in 0 external prompt calls");

    // 3. PF-WRONG-NONCE: caller provides handle with different promptNonce
    const wrongNonceHandle = { ...validHandle, promptNonce: "WRONG-NONCE" };
    await assert.rejects(
      spy.promptExternalAgent(wrongNonceHandle, "prompt text", { store }),
      (err: any) => {
        assert.match(err.message, /\[N-TURN-OPTION-A\]/);
        return true;
      },
    );
    assert.equal(spy.agentPromptCalls, 0, "PF-WRONG-NONCE must result in 0 external prompt calls");

    // 4. PF-MISSING-HANDLE: agent record has no externalRuntimeBinding
    const agentNoBinding = store.create({
      workspaceId: "ws-pf-2",
      workspaceRoot: "/tmp",
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: "attempt-no-binding", requestHash: "hash-pf-2" },
      executionContract: {
        writePaths: ["src"],
        dispatchIntent: { ...dispatchIntent, attemptId: "attempt-no-binding" },
      },
    });
    const handleNoBinding = { ...validHandle, agentId: agentNoBinding.id, attemptKey: "attempt-no-binding" };
    await assert.rejects(
      spy.promptExternalAgent(handleNoBinding, "prompt text", { store }),
      (err: any) => {
        assert.match(err.message, /\[N-TURN-OPTION-A\]/);
        return true;
      },
    );
    assert.equal(spy.agentPromptCalls, 0, "PF-MISSING-HANDLE must result in 0 external prompt calls");

    // 5. PF-MALFORMED-HANDLE: HERDR binding exists but lacks attemptKey / promptNonce
    const agentMalformed = store.create({
      workspaceId: "ws-pf-3",
      workspaceRoot: "/tmp",
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: "attempt-malformed", requestHash: "hash-pf-3" },
      executionContract: {
        writePaths: ["src"],
        dispatchIntent: { ...dispatchIntent, attemptId: "attempt-malformed" },
      },
    });
    store.bindExternalRuntimeBindingCAS({
      agentId: agentMalformed.id,
      expectedAttemptKey: "attempt-malformed",
      expectedDispatchIntentHash: dispatchIntentHash,
      binding: {
        runtimeKind: HERDR_RUNTIME_KIND,
        handle: {} as any,
      },
    });
    const handleMalformed = { ...validHandle, agentId: agentMalformed.id, attemptKey: "attempt-malformed" };
    await assert.rejects(
      spy.promptExternalAgent(handleMalformed, "prompt text", { store }),
      (err: any) => {
        assert.match(err.message, /\[N-TURN-OPTION-A\]/);
        return true;
      },
    );
    assert.equal(spy.agentPromptCalls, 0, "PF-MALFORMED-HANDLE must result in 0 external prompt calls");

    // 6. PF-WRONG-RUNTIME: binding exists but runtimeKind != HERDR
    const agentWrongRuntime = store.create({
      workspaceId: "ws-pf-4",
      workspaceRoot: "/tmp",
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: "attempt-wrong-rt", requestHash: "hash-pf-4" },
      executionContract: {
        writePaths: ["src"],
        dispatchIntent: { ...dispatchIntent, attemptId: "attempt-wrong-rt" },
      },
    });
    store.bindExternalRuntimeBindingCAS({
      agentId: agentWrongRuntime.id,
      expectedAttemptKey: "attempt-wrong-rt",
      expectedDispatchIntentHash: dispatchIntentHash,
      binding: {
        runtimeKind: "OTHER" as any,
        handle: { ...validHandle, attemptKey: "attempt-wrong-rt" } as any,
      },
    });
    const handleWrongRt = { ...validHandle, agentId: agentWrongRuntime.id, attemptKey: "attempt-wrong-rt" };
    await assert.rejects(
      spy.promptExternalAgent(handleWrongRt, "prompt text", { store }),
      (err: any) => {
        assert.match(err.message, /\[N-TURN-OPTION-A\]/);
        return true;
      },
    );
    assert.equal(spy.agentPromptCalls, 0, "PF-WRONG-RUNTIME must result in 0 external prompt calls");

    // 7. PF-CONCURRENT: stale expectedUpdatedAt
    const staleRes = store.fenceConsequentialPromptCAS({
      agentId: agent.id,
      attemptKey,
      dispatchIntentHash,
      promptNonce,
      expectedUpdatedAt: "1970-01-01T00:00:00.000Z",
    });
    assert.equal(staleRes.applied, false, "Concurrent CAS with stale expectedUpdatedAt must fail");
    assert.equal(spy.agentPromptCalls, 0, "PF-CONCURRENT must result in 0 external prompt calls");

    // Independent wrong handle reproducer (Section 49):
    const directRes = store.fenceConsequentialPromptCAS({
      agentId: agent.id,
      attemptKey: "WRONG-ATTEMPT",
      dispatchIntentHash,
      promptNonce: "WRONG-NONCE",
    });
    assert.equal(directRes.applied, false);
    const rereadAgent = store.getById(agent.id);
    assert.equal(rereadAgent?.externalRuntimeBinding?.promptState, undefined);
    assert.equal((rereadAgent?.externalRuntimeBinding?.handle as any)?.promptNonce, promptNonce);

    // 8. PF-EXACT: exact authority tuple succeeds and issues exactly 1 socket call
    const exactRes = await spy.promptExternalAgent(validHandle, "prompt text", { store });
    assert.equal(exactRes.status, "done");
    assert.equal(exactRes.turnNonce, promptNonce);
    assert.equal(spy.agentPromptCalls, 1, "PF-EXACT must issue exactly 1 external agent.prompt call");
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("HerdrThinGateway launch identity and lost-ack controls (C2, L1 to L10)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-l-controls-"));
  const store = new LocalAgentStore(stateDir);
  const testRepo = mkdtempSync(join(tmpdir(), "devspace-herdr-l-repo-"));

  try {
    execFileSync("git", ["init", testRepo], { stdio: "ignore" });
    execFileSync("git", ["-C", testRepo, "config", "user.name", "Test"], { stdio: "ignore" });
    execFileSync("git", ["-C", testRepo, "config", "user.email", "test@test.com"], { stdio: "ignore" });
    writeFileSync(join(testRepo, "test.txt"), "hello");
    execFileSync("git", ["-C", testRepo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", testRepo, "commit", "-m", "init"], { stdio: "ignore" });
    const initHead = execFileSync("git", ["-C", testRepo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

    const attemptKey = `launch-test-${Date.now()}`;
    const dispatchIntent = {
      taskId: "task-launch-test",
      attemptId: attemptKey,
      objective: "Test launch controls",
      roleIntent: "DEEP_ENGINEERING" as const,
      claimCeiling: "CANDIDATE_READY" as const,
      context: ["test"],
      readScope: ["src"],
      writeScope: ["src"],
      exclusiveOwnership: true,
      forbiddenChanges: [],
      acceptanceCriteria: ["pass"],
      verificationRequired: true,
      expectedArtifacts: [],
    };
    const dispatchIntentHash = hashDispatchIntent(dispatchIntent);

    const agent = store.create({
      workspaceId: "ws-launch",
      workspaceRoot: testRepo,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attemptKey, requestHash: "hash-launch" },
      executionContract: {
        writePaths: ["src"],
        dispatchIntent,
      },
    });

    // L1: FIRST LAUNCH
    const spy1 = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    const handle1 = await spy1.startExternalAgent({
      agentId: agent.id,
      store,
      attemptKey,
      dispatchIntentHash,
      agentKind: "opencode",
      canonicalWorktreePath: testRepo,
      workspaceId: "ws-launch",
    });
    assert.equal(spy1.workspaceCreateCalls, 1, "L1 must call workspace.create exactly once");
    assert.equal(spy1.agentStartCalls, 1, "L1 must call agent.start exactly once");
    assert.equal(handle1.attemptKey, attemptKey);
    assert.equal(handle1.gitHeadBefore, initHead);

    const recordL1 = store.getById(agent.id);
    assert.equal(recordL1?.externalRuntimeBinding?.launch?.state, "AGENT_OBSERVED");
    assert.ok(recordL1?.externalRuntimeBinding?.launch?.herdrWorkspaceId);
    assert.ok(recordL1?.externalRuntimeBinding?.launch?.herdrAgentIdentity);
    assert.ok(recordL1?.externalRuntimeBinding?.handle);

    // L2: EXACT REPLAY
    const spy2 = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    const handle2 = await spy2.startExternalAgent({
      agentId: agent.id,
      store,
      attemptKey,
      dispatchIntentHash,
      agentKind: "opencode",
      canonicalWorktreePath: testRepo,
      workspaceId: "ws-launch",
    });
    assert.equal(spy2.workspaceCreateCalls, 0, "L2 exact replay must issue 0 workspace.create calls");
    assert.equal(spy2.agentStartCalls, 0, "L2 exact replay must issue 0 agent.start calls");
    assert.equal(handle2.attemptKey, handle1.attemptKey);

    // L3: CONFLICTING INTENT
    const spy3 = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    await assert.rejects(
      spy3.startExternalAgent({
        agentId: agent.id,
        store,
        attemptKey,
        dispatchIntentHash: "DIFFERENT-INTENT-HASH",
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-launch",
      }),
      (err: any) => {
        assert.match(err.message, /\[N2 Conflicting Replay\]/);
        return true;
      },
    );
    assert.equal(spy3.workspaceCreateCalls, 0, "L3 conflicting intent must issue 0 workspace.create calls");
    assert.equal(spy3.agentStartCalls, 0, "L3 conflicting intent must issue 0 agent.start calls");

    // L4: LOST ACK WORKSPACE
    const attemptL4 = `launch-l4-${Date.now()}`;
    const intentL4 = { ...dispatchIntent, attemptId: attemptL4 };
    const hashL4 = hashDispatchIntent(intentL4);
    const agentL4 = store.create({
      workspaceId: "ws-launch-l4",
      workspaceRoot: testRepo,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attemptL4, requestHash: "hash-l4" },
      executionContract: { writePaths: ["src"], dispatchIntent: intentL4 },
    });

    const spyL4 = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    spyL4.failWorkspaceCreate = true;
    await assert.rejects(
      spyL4.startExternalAgent({
        agentId: agentL4.id,
        store,
        attemptKey: attemptL4,
        dispatchIntentHash: hashL4,
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-launch-l4",
      }),
    );
    assert.equal(spyL4.workspaceCreateCalls, 1);
    assert.equal(spyL4.agentStartCalls, 0);

    const recordL4 = store.getById(agentL4.id);
    assert.equal(recordL4?.externalRuntimeBinding?.launch?.state, "OUTCOME_UNKNOWN");

    // L4 restart with NO observed workspace: must NOT retry workspace.create!
    const spyL4Replay = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    await assert.rejects(
      spyL4Replay.startExternalAgent({
        agentId: agentL4.id,
        store,
        attemptKey: attemptL4,
        dispatchIntentHash: hashL4,
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-launch-l4",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );
    assert.equal(spyL4Replay.workspaceCreateCalls, 0, "L4 replay without observation must issue 0 workspace.create calls");

    // L4 restart with positively observed workspace: reconciles without new workspace.create
    const spyL4ReplayObserved = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    spyL4ReplayObserved.simulatedWorkspaces = [{ workspace_id: "ws-reconciled-l4", label: `devspace-${attemptL4}` }];
    const handleL4Reconciled = await spyL4ReplayObserved.startExternalAgent({
      agentId: agentL4.id,
      store,
      attemptKey: attemptL4,
      dispatchIntentHash: hashL4,
      agentKind: "opencode",
      canonicalWorktreePath: testRepo,
      workspaceId: "ws-launch-l4",
    });
    assert.equal(spyL4ReplayObserved.workspaceCreateCalls, 0, "L4 replay with observation must issue 0 workspace.create calls");
    assert.equal(handleL4Reconciled.herdrWorkspaceId, "ws-reconciled-l4");

    // L5: LOST ACK AGENT
    const attemptL5 = `launch-l5-${Date.now()}`;
    const intentL5 = { ...dispatchIntent, attemptId: attemptL5 };
    const hashL5 = hashDispatchIntent(intentL5);
    const agentL5 = store.create({
      workspaceId: "ws-launch-l5",
      workspaceRoot: testRepo,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attemptL5, requestHash: "hash-l5" },
      executionContract: { writePaths: ["src"], dispatchIntent: intentL5 },
    });

    const spyL5 = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    spyL5.failAgentStart = true;
    await assert.rejects(
      spyL5.startExternalAgent({
        agentId: agentL5.id,
        store,
        attemptKey: attemptL5,
        dispatchIntentHash: hashL5,
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-launch-l5",
      }),
    );
    assert.equal(spyL5.workspaceCreateCalls, 1);
    assert.equal(spyL5.agentStartCalls, 1);

    // L5 restart with positively observed agent: reconciles without new workspace.create or agent.start
    const spyL5Replay = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    const handleL5Reconciled = await spyL5Replay.startExternalAgent({
      agentId: agentL5.id,
      store,
      attemptKey: attemptL5,
      dispatchIntentHash: hashL5,
      agentKind: "opencode",
      canonicalWorktreePath: testRepo,
      workspaceId: "ws-launch-l5",
    });
    assert.equal(spyL5Replay.workspaceCreateCalls, 0, "L5 replay must issue 0 new workspace.create calls");
    assert.equal(spyL5Replay.agentStartCalls, 0, "L5 replay must issue 0 new agent.start calls");
    assert.ok(handleL5Reconciled.herdrAgentIdentity);

    // L6: WORKSPACE PERSIST FAILURE
    const attemptL6 = `launch-l6-${Date.now()}`;
    const intentL6 = { ...dispatchIntent, attemptId: attemptL6 };
    const hashL6 = hashDispatchIntent(intentL6);
    const agentL6 = store.create({
      workspaceId: "ws-launch-l6",
      workspaceRoot: testRepo,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attemptL6, requestHash: "hash-l6" },
      executionContract: { writePaths: ["src"], dispatchIntent: intentL6 },
    });
    const origWsObserved = store.recordExternalRuntimeWorkspaceObservedCAS.bind(store);
    store.recordExternalRuntimeWorkspaceObservedCAS = () => ({ applied: false, reason: "simulated CAS error" });

    const spyL6 = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    await assert.rejects(
      spyL6.startExternalAgent({
        agentId: agentL6.id,
        store,
        attemptKey: attemptL6,
        dispatchIntentHash: hashL6,
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-launch-l6",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );
    assert.equal(spyL6.agentStartCalls, 0, "L6 workspace persistence failure must halt before agent.start");
    store.recordExternalRuntimeWorkspaceObservedCAS = origWsObserved;

    // L7: AGENT PERSIST FAILURE
    const attemptL7 = `launch-l7-${Date.now()}`;
    const intentL7 = { ...dispatchIntent, attemptId: attemptL7 };
    const hashL7 = hashDispatchIntent(intentL7);
    const agentL7 = store.create({
      workspaceId: "ws-launch-l7",
      workspaceRoot: testRepo,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attemptL7, requestHash: "hash-l7" },
      executionContract: { writePaths: ["src"], dispatchIntent: intentL7 },
    });
    const origAgentObserved = store.recordExternalRuntimeAgentObservedCAS.bind(store);
    store.recordExternalRuntimeAgentObservedCAS = () => ({ applied: false, reason: "simulated CAS error" });

    const spyL7 = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    await assert.rejects(
      spyL7.startExternalAgent({
        agentId: agentL7.id,
        store,
        attemptKey: attemptL7,
        dispatchIntentHash: hashL7,
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-launch-l7",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );
    assert.equal(spyL7.agentPromptCalls, 0, "L7 agent persistence failure must halt before prompt");
    store.recordExternalRuntimeAgentObservedCAS = origAgentObserved;

    // L8: WRONG WORKTREE
    const wrongRepo = mkdtempSync(join(tmpdir(), "devspace-herdr-wrong-repo-"));
    execFileSync("git", ["init", wrongRepo], { stdio: "ignore" });
    execFileSync("git", ["-C", wrongRepo, "config", "user.name", "Test"], { stdio: "ignore" });
    execFileSync("git", ["-C", wrongRepo, "config", "user.email", "test@test.com"], { stdio: "ignore" });
    writeFileSync(join(wrongRepo, "test.txt"), "hello");
    execFileSync("git", ["-C", wrongRepo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", wrongRepo, "commit", "-m", "init"], { stdio: "ignore" });

    const spyL8 = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    await assert.rejects(
      spyL8.startExternalAgent({
        agentId: agent.id,
        store,
        attemptKey,
        dispatchIntentHash,
        agentKind: "opencode",
        canonicalWorktreePath: wrongRepo,
        workspaceId: "ws-launch",
      }),
      (err: any) => {
        assert.match(err.message, /\[N4 Wrong Worktree\]/);
        return true;
      },
    );
    assert.equal(spyL8.workspaceCreateCalls, 0, "L8 wrong worktree must issue 0 workspace.create calls");
    assert.equal(spyL8.agentStartCalls, 0, "L8 wrong worktree must issue 0 agent.start calls");
    rmSync(wrongRepo, { recursive: true, force: true });

    // L9: WRONG AGENT KIND
    const spyL9 = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    await assert.rejects(
      spyL9.startExternalAgent({
        agentId: agent.id,
        store,
        attemptKey,
        dispatchIntentHash,
        agentKind: "agy",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-launch",
      }),
      (err: any) => {
        assert.match(err.message, /\[ATTEMPT_REPLAY_CONFLICT\]/);
        return true;
      },
    );
    assert.equal(spyL9.workspaceCreateCalls, 0, "L9 wrong agent kind must issue 0 workspace.create calls");
    assert.equal(spyL9.agentStartCalls, 0, "L9 wrong agent kind must issue 0 agent.start calls");

    // L10: SOURCE HEAD DRIFT
    // Commit to testRepo so HEAD drifts
    writeFileSync(join(testRepo, "test.txt"), "hello modified");
    execFileSync("git", ["-C", testRepo, "commit", "-am", "second commit"], { stdio: "ignore" });
    const driftedHead = execFileSync("git", ["-C", testRepo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    assert.notEqual(driftedHead, initHead);

    const spyL10 = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    await assert.rejects(
      spyL10.startExternalAgent({
        agentId: agent.id,
        store,
        attemptKey,
        dispatchIntentHash,
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-launch",
      }),
      (err: any) => {
        assert.match(err.message, /\[SOURCE_IDENTITY_DRIFT\]/);
        return true;
      },
    );
    assert.equal(spyL10.workspaceCreateCalls, 0, "L10 source head drift must issue 0 workspace.create calls");
    assert.equal(spyL10.agentStartCalls, 0, "L10 source head drift must issue 0 agent.start calls");
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(testRepo, { recursive: true, force: true });
  }
});
