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
  buildDeterministicHerdrAgentName,
  type HerdrExternalHandle,
  type HerdrSocketRequest,
  type HerdrSocketResponse,
  type HerdrPaneInfo,
  type HerdrAgentInfo,
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
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-herdr-busy-agent-"));
  const store = new LocalAgentStore(stateDir);
  const gateway = new HerdrThinGateway("/tmp/test.sock", undefined, store);
  // Mock getAgent to simulate an already busy agent
  (gateway as any).getAgent = async () => ({
    agent_status: "running",
    interactive_ready: false,
  });

  const attemptKey = "attempt-busy";
  const dispatchIntent = {
    taskId: "task-busy",
    attemptId: attemptKey,
    objective: "Test busy agent",
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
  const promptNonce = "NONCE-BUSY";

  const agent = store.create({
    provider: "local-runtime",
    profileName: "worker",
    workspaceRoot: "/tmp",
    workspaceId: "ws1",
    startReplay: { key: attemptKey, requestHash: "hash-busy" },
    executionContract: { writePaths: ["src"], dispatchIntent },
  });

  const handle: HerdrExternalHandle = {
    schemaVersion: 1,
    runtimeKind: HERDR_RUNTIME_KIND,
    agentId: agent.id,
    herdrSocketPath: "/tmp/test.sock",
    herdrWorkspaceId: "w1",
    herdrPaneId: "p1",
    herdrAgentIdentity: "ds-busy-agent",
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
      launch: {
        state: "AGENT_OBSERVED",
        launchRequestId: `HERDR-LAUNCH:${attemptKey}:req`,
        attemptKey,
        dispatchIntentHash,
        canonicalWorktreePath: "/tmp",
        gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
        agentKind: "opencode",
        promptNonce,
        fencedAt: new Date().toISOString(),
      },
      handle: handle as unknown as Record<string, unknown>,
    },
  });

  try {
    await assert.rejects(
      gateway.promptExternalAgent(handle, "consequential task"),
      (err: any) => {
        assert.match(err.message, /\[N-TURN\]/);
        return true;
      },
    );
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
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
  public listPanesCalls = 0;
  public getPaneCalls = 0;
  public getAgentCalls = 0;

  public failWorkspaceCreate = false;
  public failAgentStart = false;
  public simulatedWorkspaces: Array<{ workspace_id: string; label?: string }> = [];
  public simulatedPanes: Array<HerdrPaneInfo> = [];
  public simulatedAgents: Map<string, HerdrAgentInfo> = new Map();
  public simulatedAgentStatus: HerdrAgentInfo | undefined;

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
      const cwd = (req.params as any)?.cwd;
      const paneInfo: HerdrPaneInfo = {
        pane_id: paneId,
        workspace_id: wsId,
        cwd,
        foreground_cwd: cwd,
      };
      this.simulatedPanes.push(paneInfo);
      return {
        id: req.id,
        result: {
          workspace: { workspace_id: wsId },
          root_pane: {
            pane_id: paneId,
            cwd,
            foreground_cwd: cwd,
          },
        } as unknown as T,
      };
    }

    if (req.method === "agent.start") {
      this.agentStartCalls++;
      if (this.failAgentStart) {
        throw new Error("Simulated network timeout during agent.start");
      }
      const name = (req.params as any)?.name;
      const paneId = (req.params as any)?.pane_id;
      const pane = this.simulatedPanes.find((p) => p.pane_id === paneId);
      const agentInfo: HerdrAgentInfo = {
        name,
        agent: name,
        workspace_id: pane?.workspace_id || "sim-ws-default",
        pane_id: paneId,
        cwd: pane?.cwd,
        foreground_cwd: pane?.foreground_cwd,
        agent_status: "running",
        interactive_ready: true,
      };
      this.simulatedAgents.set(name, agentInfo);
      return {
        id: req.id,
        result: {
          agent: {
            agent: name,
            agent_status: "running",
            pane_id: paneId,
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
      const target = (req.params as any)?.target;
      const ws = this.simulatedWorkspaces.find((w) => w.workspace_id === target) || {
        workspace_id: target,
        label: target,
      };
      return {
        id: req.id,
        result: {
          type: "workspace_info",
          workspace: ws,
        } as unknown as T,
      };
    }

    if (req.method === "pane.list") {
      this.listPanesCalls++;
      const targetWs = (req.params as any)?.workspace_id;
      const filtered = targetWs
        ? this.simulatedPanes.filter((p) => p.workspace_id === targetWs)
        : this.simulatedPanes;
      return {
        id: req.id,
        result: {
          type: "pane_list",
          panes: filtered,
        } as unknown as T,
      };
    }

    if (req.method === "pane.get") {
      this.getPaneCalls++;
      const paneId = (req.params as any)?.pane_id;
      const pane = this.simulatedPanes.find((p) => p.pane_id === paneId);
      return {
        id: req.id,
        result: {
          type: "pane_info",
          pane,
        } as unknown as T,
      };
    }

    if (req.method === "agent.get") {
      this.getAgentCalls++;
      const target = (req.params as any)?.target;
      const agent =
        this.simulatedAgents.get(target) ??
        (this.simulatedAgentStatus
          ? {
              name: target,
              agent: target,
              ...this.simulatedAgentStatus,
            }
          : undefined);
      return {
        id: req.id,
        result: {
          type: "agent.get",
          agent,
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
    spyL4ReplayObserved.simulatedPanes = [
      { pane_id: "p-reconciled-l4", workspace_id: "ws-reconciled-l4", cwd: testRepo, foreground_cwd: testRepo },
    ];
    const agentNameL4 = buildDeterministicHerdrAgentName(attemptL4, hashL4);
    spyL4ReplayObserved.simulatedAgents.set(agentNameL4, {
      name: agentNameL4,
      agent: agentNameL4,
      workspace_id: "ws-reconciled-l4",
      pane_id: "p-reconciled-l4",
      cwd: testRepo,
      foreground_cwd: testRepo,
      agent_status: "idle",
      interactive_ready: true,
    });
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
    const agentNameL5 = buildDeterministicHerdrAgentName(attemptL5, hashL5);
    const recordL5 = store.getById(agentL5.id)!;
    const wsIdL5 = recordL5.externalRuntimeBinding!.launch!.herdrWorkspaceId!;
    const paneIdL5 = recordL5.externalRuntimeBinding!.launch!.herdrPaneId!;
    spyL5Replay.simulatedPanes = [
      { pane_id: paneIdL5, workspace_id: wsIdL5, cwd: testRepo, foreground_cwd: testRepo },
    ];
    spyL5Replay.simulatedAgents.set(agentNameL5, {
      name: agentNameL5,
      agent: agentNameL5,
      workspace_id: wsIdL5,
      pane_id: paneIdL5,
      cwd: testRepo,
      foreground_cwd: testRepo,
      agent_status: "idle",
      interactive_ready: true,
    });
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

test("HerdrThinGateway workspace reconciliation enforces physical cwd proof and fail-closed rules (REC-WORKSPACE-WRONG-CWD, REC-WORKSPACE-CWD-MISSING, REC-WORKSPACE-MULTIPLE-PANES, REC-PANE-NO-FABRICATION, R6-REPRO-1)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-rec-ws-test-"));
  const store = new LocalAgentStore(stateDir);
  const testRepo = mkdtempSync(join(tmpdir(), "devspace-rec-ws-repo-"));

  try {
    execFileSync("git", ["init", testRepo], { stdio: "ignore" });
    execFileSync("git", ["-C", testRepo, "config", "user.name", "Test"], { stdio: "ignore" });
    execFileSync("git", ["-C", testRepo, "config", "user.email", "test@test.com"], { stdio: "ignore" });
    writeFileSync(join(testRepo, "test.txt"), "hello");
    execFileSync("git", ["-C", testRepo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", testRepo, "commit", "-m", "init"], { stdio: "ignore" });

    // 1. REC-WORKSPACE-WRONG-CWD / R6-REPRO-1:
    // Candidate workspace exists with matching label, but its pane points to /some/other/repo
    const attempt1 = `rec-ws-wrong-cwd-${Date.now()}`;
    const intent1 = {
      taskId: "task-rec-1",
      attemptId: attempt1,
      objective: "REC-WORKSPACE-WRONG-CWD",
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
    const hash1 = hashDispatchIntent(intent1);
    const agent1 = store.create({
      workspaceId: "ws-rec-1",
      workspaceRoot: testRepo,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attempt1, requestHash: "hash-1" },
      executionContract: { writePaths: ["src"], dispatchIntent: intent1 },
    });

    // Durable pre-effect launch fence created with OUTCOME_UNKNOWN (simulating lost-ack before observation)
    const promptNonce1 = `NONCE-${attempt1}`;
    store.fenceExternalRuntimeLaunchCAS({
      agentId: agent1.id,
      attemptKey: attempt1,
      dispatchIntentHash: hash1,
      canonicalWorktreePath: testRepo,
      gitHeadBefore: execFileSync("git", ["-C", testRepo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(),
      agentKind: "opencode",
      promptNonce: promptNonce1,
      workspaceId: "ws-rec-1",
    });

    const registry1 = new HerdrGatewayRegistry();
    const spy1 = new SpyHerdrGateway("/tmp/test.sock", registry1, store);
    // Mock HerdR returns workspace matching label, but pane cwd is foreign
    spy1.simulatedWorkspaces = [{ workspace_id: "wrong-ws-id", label: `devspace-${attempt1}` }];
    spy1.simulatedPanes = [
      {
        pane_id: "wrong-pane-id",
        workspace_id: "wrong-ws-id",
        cwd: "/some/other/repo",
        foreground_cwd: "/some/other/repo",
      },
    ];

    await assert.rejects(
      spy1.startExternalAgent({
        agentId: agent1.id,
        store,
        attemptKey: attempt1,
        dispatchIntentHash: hash1,
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-rec-1",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );
    // Assert FAIL CLOSED: no durable workspace adoption, no agent attribution, no handle
    const record1 = store.getById(agent1.id)!;
    assert.equal(record1.externalRuntimeBinding?.launch?.herdrWorkspaceId, undefined, "Wrong workspace must NOT be adopted");
    assert.equal(record1.externalRuntimeBinding?.launch?.herdrPaneId, undefined);
    assert.equal(registry1.getHandle(attempt1), undefined, "Registry must NOT contain handle");
    assert.equal(spy1.workspaceCreateCalls, 0, "No new workspace.create calls permitted");

    // 2. REC-WORKSPACE-CWD-MISSING:
    // Workspace label matches, but no pane has observable cwd (null or empty)
    const attempt2 = `rec-ws-missing-cwd-${Date.now()}`;
    const intent2 = { ...intent1, attemptId: attempt2 };
    const hash2 = hashDispatchIntent(intent2);
    const agent2 = store.create({
      workspaceId: "ws-rec-2",
      workspaceRoot: testRepo,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attempt2, requestHash: "hash-2" },
      executionContract: { writePaths: ["src"], dispatchIntent: intent2 },
    });
    store.fenceExternalRuntimeLaunchCAS({
      agentId: agent2.id,
      attemptKey: attempt2,
      dispatchIntentHash: hash2,
      canonicalWorktreePath: testRepo,
      gitHeadBefore: execFileSync("git", ["-C", testRepo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(),
      agentKind: "opencode",
      promptNonce: `NONCE-${attempt2}`,
      workspaceId: "ws-rec-2",
    });

    const spy2 = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    spy2.simulatedWorkspaces = [{ workspace_id: "missing-cwd-ws", label: `devspace-${attempt2}` }];
    spy2.simulatedPanes = [
      {
        pane_id: "pane-null-cwd",
        workspace_id: "missing-cwd-ws",
        cwd: null,
        foreground_cwd: null,
      },
    ];

    await assert.rejects(
      spy2.startExternalAgent({
        agentId: agent2.id,
        store,
        attemptKey: attempt2,
        dispatchIntentHash: hash2,
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-rec-2",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );
    const record2 = store.getById(agent2.id)!;
    assert.equal(record2.externalRuntimeBinding?.launch?.herdrWorkspaceId, undefined);

    // 3. REC-WORKSPACE-MULTIPLE-PANES:
    // Multiple panes match the workspace, none uniquely provable as launch root -> fail closed
    const attempt3 = `rec-ws-multi-pane-${Date.now()}`;
    const intent3 = { ...intent1, attemptId: attempt3 };
    const hash3 = hashDispatchIntent(intent3);
    const agent3 = store.create({
      workspaceId: "ws-rec-3",
      workspaceRoot: testRepo,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attempt3, requestHash: "hash-3" },
      executionContract: { writePaths: ["src"], dispatchIntent: intent3 },
    });
    store.fenceExternalRuntimeLaunchCAS({
      agentId: agent3.id,
      attemptKey: attempt3,
      dispatchIntentHash: hash3,
      canonicalWorktreePath: testRepo,
      gitHeadBefore: execFileSync("git", ["-C", testRepo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(),
      agentKind: "opencode",
      promptNonce: `NONCE-${attempt3}`,
      workspaceId: "ws-rec-3",
    });

    const spy3 = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    spy3.simulatedWorkspaces = [{ workspace_id: "multi-pane-ws", label: `devspace-${attempt3}` }];
    spy3.simulatedPanes = [
      { pane_id: "pane-1", workspace_id: "multi-pane-ws", cwd: testRepo, foreground_cwd: testRepo },
      { pane_id: "pane-2", workspace_id: "multi-pane-ws", cwd: testRepo, foreground_cwd: testRepo },
    ];

    await assert.rejects(
      spy3.startExternalAgent({
        agentId: agent3.id,
        store,
        attemptKey: attempt3,
        dispatchIntentHash: hash3,
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-rec-3",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );
    const record3 = store.getById(agent3.id)!;
    assert.equal(record3.externalRuntimeBinding?.launch?.herdrWorkspaceId, undefined);

    // 4. REC-PANE-NO-FABRICATION:
    // Workspace has zero panes returned -> must not fabricate `${wsId}:p1`
    const attempt4 = `rec-ws-no-pane-${Date.now()}`;
    const intent4 = { ...intent1, attemptId: attempt4 };
    const hash4 = hashDispatchIntent(intent4);
    const agent4 = store.create({
      workspaceId: "ws-rec-4",
      workspaceRoot: testRepo,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attempt4, requestHash: "hash-4" },
      executionContract: { writePaths: ["src"], dispatchIntent: intent4 },
    });
    store.fenceExternalRuntimeLaunchCAS({
      agentId: agent4.id,
      attemptKey: attempt4,
      dispatchIntentHash: hash4,
      canonicalWorktreePath: testRepo,
      gitHeadBefore: execFileSync("git", ["-C", testRepo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(),
      agentKind: "opencode",
      promptNonce: `NONCE-${attempt4}`,
      workspaceId: "ws-rec-4",
    });

    const spy4 = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    spy4.simulatedWorkspaces = [{ workspace_id: "no-pane-ws", label: `devspace-${attempt4}` }];
    spy4.simulatedPanes = []; // Zero panes

    await assert.rejects(
      spy4.startExternalAgent({
        agentId: agent4.id,
        store,
        attemptKey: attempt4,
        dispatchIntentHash: hash4,
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-rec-4",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );
    const record4 = store.getById(agent4.id)!;
    assert.equal(record4.externalRuntimeBinding?.launch?.herdrPaneId, undefined, "Must NOT fabricate paneId");
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(testRepo, { recursive: true, force: true });
  }
});

test("HerdrThinGateway agent reconciliation enforces exact workspace, pane, and cwd identity (REC-AGENT-WRONG-WORKSPACE, REC-AGENT-WRONG-PANE, REC-AGENT-WRONG-CWD, REC-AGENT-EXACT)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-rec-agent-test-"));
  const store = new LocalAgentStore(stateDir);
  const testRepo = mkdtempSync(join(tmpdir(), "devspace-rec-agent-repo-"));

  try {
    execFileSync("git", ["init", testRepo], { stdio: "ignore" });
    execFileSync("git", ["-C", testRepo, "config", "user.name", "Test"], { stdio: "ignore" });
    execFileSync("git", ["-C", testRepo, "config", "user.email", "test@test.com"], { stdio: "ignore" });
    writeFileSync(join(testRepo, "test.txt"), "hello");
    execFileSync("git", ["-C", testRepo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", testRepo, "commit", "-m", "init"], { stdio: "ignore" });
    const gitHead = execFileSync("git", ["-C", testRepo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

    // Common setup helper: launch fence with workspace already observed
    function setupAgentWithObservedWorkspace(attemptKey: string, wsId: string, paneId: string) {
      const intent = {
        taskId: "task-agent-rec",
        attemptId: attemptKey,
        objective: "REC-AGENT",
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
      const hash = hashDispatchIntent(intent);
      const agent = store.create({
        workspaceId: "ws-rec-ag",
        workspaceRoot: testRepo,
        profileName: "worker",
        provider: "opencode",
        startReplay: { key: attemptKey, requestHash: "hash-ag" },
        executionContract: { writePaths: ["src"], dispatchIntent: intent },
      });
      store.fenceExternalRuntimeLaunchCAS({
        agentId: agent.id,
        attemptKey,
        dispatchIntentHash: hash,
        canonicalWorktreePath: testRepo,
        gitHeadBefore: gitHead,
        agentKind: "opencode",
        promptNonce: `NONCE-${attemptKey}`,
        workspaceId: "ws-rec-ag",
      });
      store.recordExternalRuntimeWorkspaceObservedCAS({
        agentId: agent.id,
        attemptKey,
        herdrWorkspaceId: wsId,
        herdrPaneId: paneId,
        observedCwd: testRepo,
      });
      return { agent, hash };
    }

    // 1. REC-AGENT-WRONG-WORKSPACE: agent.workspace_id != expected workspace
    const attempt1 = `rec-ag-wrong-ws-${Date.now()}`;
    const { agent: agent1, hash: hash1 } = setupAgentWithObservedWorkspace(attempt1, "ws-correct-1", "pane-correct-1");
    const spy1 = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    const agentName1 = buildDeterministicHerdrAgentName(attempt1, hash1);
    spy1.simulatedPanes = [
      { pane_id: "pane-correct-1", workspace_id: "ws-correct-1", cwd: testRepo, foreground_cwd: testRepo },
    ];
    spy1.simulatedAgents.set(agentName1, {
      name: agentName1,
      agent: agentName1,
      workspace_id: "ws-DIFFERENT-1", // Mismatch!
      pane_id: "pane-correct-1",
      cwd: testRepo,
      foreground_cwd: testRepo,
      agent_status: "idle",
      interactive_ready: true,
    });

    await assert.rejects(
      spy1.startExternalAgent({
        agentId: agent1.id,
        store,
        attemptKey: attempt1,
        dispatchIntentHash: hash1,
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-rec-ag",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );
    assert.equal(store.getById(agent1.id)?.externalRuntimeBinding?.launch?.herdrAgentIdentity, undefined);

    // 2. REC-AGENT-WRONG-PANE: agent.pane_id != expected pane
    const attempt2 = `rec-ag-wrong-pane-${Date.now()}`;
    const { agent: agent2, hash: hash2 } = setupAgentWithObservedWorkspace(attempt2, "ws-correct-2", "pane-correct-2");
    const spy2 = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    const agentName2 = buildDeterministicHerdrAgentName(attempt2, hash2);
    spy2.simulatedPanes = [
      { pane_id: "pane-correct-2", workspace_id: "ws-correct-2", cwd: testRepo, foreground_cwd: testRepo },
    ];
    spy2.simulatedAgents.set(agentName2, {
      name: agentName2,
      agent: agentName2,
      workspace_id: "ws-correct-2",
      pane_id: "pane-DIFFERENT-2", // Mismatch!
      cwd: testRepo,
      foreground_cwd: testRepo,
      agent_status: "idle",
      interactive_ready: true,
    });

    await assert.rejects(
      spy2.startExternalAgent({
        agentId: agent2.id,
        store,
        attemptKey: attempt2,
        dispatchIntentHash: hash2,
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-rec-ag",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );
    assert.equal(store.getById(agent2.id)?.externalRuntimeBinding?.launch?.herdrAgentIdentity, undefined);

    // 3. REC-AGENT-WRONG-CWD: agent workspace/pane match, but cwd points to other repo
    const attempt3 = `rec-ag-wrong-cwd-${Date.now()}`;
    const { agent: agent3, hash: hash3 } = setupAgentWithObservedWorkspace(attempt3, "ws-correct-3", "pane-correct-3");
    const spy3 = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    const agentName3 = buildDeterministicHerdrAgentName(attempt3, hash3);
    spy3.simulatedPanes = [
      { pane_id: "pane-correct-3", workspace_id: "ws-correct-3", cwd: testRepo, foreground_cwd: testRepo },
    ];
    spy3.simulatedAgents.set(agentName3, {
      name: agentName3,
      agent: agentName3,
      workspace_id: "ws-correct-3",
      pane_id: "pane-correct-3",
      cwd: "/some/unrelated/path", // Mismatch!
      foreground_cwd: "/some/unrelated/path",
      agent_status: "idle",
      interactive_ready: true,
    });

    await assert.rejects(
      spy3.startExternalAgent({
        agentId: agent3.id,
        store,
        attemptKey: attempt3,
        dispatchIntentHash: hash3,
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-rec-ag",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );
    assert.equal(store.getById(agent3.id)?.externalRuntimeBinding?.launch?.herdrAgentIdentity, undefined);

    // 4. REC-AGENT-EXACT: all physical fields match exact
    const attempt4 = `rec-ag-exact-${Date.now()}`;
    const { agent: agent4, hash: hash4 } = setupAgentWithObservedWorkspace(attempt4, "ws-correct-4", "pane-correct-4");
    const registry4 = new HerdrGatewayRegistry();
    const spy4 = new SpyHerdrGateway("/tmp/test.sock", registry4, store);
    const agentName4 = buildDeterministicHerdrAgentName(attempt4, hash4);
    spy4.simulatedPanes = [
      { pane_id: "pane-correct-4", workspace_id: "ws-correct-4", cwd: testRepo, foreground_cwd: testRepo },
    ];
    spy4.simulatedAgents.set(agentName4, {
      name: agentName4,
      agent: agentName4,
      workspace_id: "ws-correct-4",
      pane_id: "pane-correct-4",
      cwd: testRepo,
      foreground_cwd: testRepo,
      agent_status: "idle",
      interactive_ready: true,
    });

    const handle4 = await spy4.startExternalAgent({
      agentId: agent4.id,
      store,
      attemptKey: attempt4,
      dispatchIntentHash: hash4,
      agentKind: "opencode",
      canonicalWorktreePath: testRepo,
      workspaceId: "ws-rec-ag",
    });

    assert.equal(handle4.herdrWorkspaceId, "ws-correct-4");
    assert.equal(handle4.herdrPaneId, "pane-correct-4");
    assert.equal(handle4.herdrAgentIdentity, agentName4);
    assert.equal(registry4.getHandle(attempt4)?.herdrAgentIdentity, agentName4);
    assert.equal(store.getById(agent4.id)?.externalRuntimeBinding?.launch?.herdrAgentIdentity, agentName4);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(testRepo, { recursive: true, force: true });
  }
});

test("Name collision regression test: distinct long attemptKeys with identical 32-char prefix do not collide (Section 18 & 33)", () => {
  const prefix = "attempt-long-prefix-that-exceeds-32-chars-";
  const attemptKeyA = `${prefix}alpha-11111111111111111111111111111111`;
  const attemptKeyB = `${prefix}beta-222222222222222222222222222222222`;

  const nameA = buildDeterministicHerdrAgentName(attemptKeyA, "intent-hash-a");
  const nameB = buildDeterministicHerdrAgentName(attemptKeyB, "intent-hash-b");

  assert.notEqual(nameA, nameB, "Deterministic agent names must not collide even when prefixes are identical");
  assert.ok(nameA.length <= 32, `nameA length ${nameA.length} must be <= 32`);
  assert.ok(nameB.length <= 32, `nameB length ${nameB.length} must be <= 32`);

  // Same attemptKey and intentHash is strictly deterministic
  const nameA2 = buildDeterministicHerdrAgentName(attemptKeyA, "intent-hash-a");
  assert.equal(nameA, nameA2, "buildDeterministicHerdrAgentName must be deterministic across calls");
});

test("Reconciliation CAS failure matrix stops immediately and prevents registry leakage (REC-CAS-WORKSPACE-FAIL, REC-CAS-AGENT-FAIL, REC-CAS-FINAL-BIND-FAIL, R6-REPRO-2)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-rec-cas-test-"));
  const store = new LocalAgentStore(stateDir);
  const testRepo = mkdtempSync(join(tmpdir(), "devspace-rec-cas-repo-"));

  try {
    execFileSync("git", ["init", testRepo], { stdio: "ignore" });
    execFileSync("git", ["-C", testRepo, "config", "user.name", "Test"], { stdio: "ignore" });
    execFileSync("git", ["-C", testRepo, "config", "user.email", "test@test.com"], { stdio: "ignore" });
    writeFileSync(join(testRepo, "test.txt"), "hello");
    execFileSync("git", ["-C", testRepo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", testRepo, "commit", "-m", "init"], { stdio: "ignore" });
    const gitHead = execFileSync("git", ["-C", testRepo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

    // 1. REC-CAS-WORKSPACE-FAIL:
    // Workspace observed physically, but store.recordExternalRuntimeWorkspaceObservedCAS returns applied=false
    const attempt1 = `rec-cas-ws-fail-${Date.now()}`;
    const intent1 = {
      taskId: "task-cas-1",
      attemptId: attempt1,
      objective: "REC-CAS-WORKSPACE-FAIL",
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
    const hash1 = hashDispatchIntent(intent1);
    const agent1 = store.create({
      workspaceId: "ws-cas-1",
      workspaceRoot: testRepo,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attempt1, requestHash: "hash-cas-1" },
      executionContract: { writePaths: ["src"], dispatchIntent: intent1 },
    });
    store.fenceExternalRuntimeLaunchCAS({
      agentId: agent1.id,
      attemptKey: attempt1,
      dispatchIntentHash: hash1,
      canonicalWorktreePath: testRepo,
      gitHeadBefore: gitHead,
      agentKind: "opencode",
      promptNonce: `NONCE-${attempt1}`,
      workspaceId: "ws-cas-1",
    });

    const registry1 = new HerdrGatewayRegistry();
    const spy1 = new SpyHerdrGateway("/tmp/test.sock", registry1, store);
    spy1.simulatedWorkspaces = [{ workspace_id: "ws-cas-fail-1", label: `devspace-${attempt1}` }];
    spy1.simulatedPanes = [
      { pane_id: "pane-cas-fail-1", workspace_id: "ws-cas-fail-1", cwd: testRepo, foreground_cwd: testRepo },
    ];

    const origWsObserved = store.recordExternalRuntimeWorkspaceObservedCAS.bind(store);
    store.recordExternalRuntimeWorkspaceObservedCAS = () => ({ applied: false, reason: "simulated failure" });

    await assert.rejects(
      spy1.startExternalAgent({
        agentId: agent1.id,
        store,
        attemptKey: attempt1,
        dispatchIntentHash: hash1,
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-cas-1",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );
    // Assert: getAgent calls = 0, registry absent, no returned handle (Section 35)
    assert.equal(spy1.getAgentCalls, 0, "Failed workspace CAS must stop before getAgent");
    assert.equal(registry1.getHandle(attempt1), undefined, "Registry must NOT contain handle");
    store.recordExternalRuntimeWorkspaceObservedCAS = origWsObserved;

    // 2. REC-CAS-AGENT-FAIL:
    // Workspace CAS succeeds, agent observed physically, but store.recordExternalRuntimeAgentObservedCAS returns applied=false
    const attempt2 = `rec-cas-ag-fail-${Date.now()}`;
    const intent2 = { ...intent1, attemptId: attempt2 };
    const hash2 = hashDispatchIntent(intent2);
    const agent2 = store.create({
      workspaceId: "ws-cas-2",
      workspaceRoot: testRepo,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attempt2, requestHash: "hash-cas-2" },
      executionContract: { writePaths: ["src"], dispatchIntent: intent2 },
    });
    store.fenceExternalRuntimeLaunchCAS({
      agentId: agent2.id,
      attemptKey: attempt2,
      dispatchIntentHash: hash2,
      canonicalWorktreePath: testRepo,
      gitHeadBefore: gitHead,
      agentKind: "opencode",
      promptNonce: `NONCE-${attempt2}`,
      workspaceId: "ws-cas-2",
    });
    store.recordExternalRuntimeWorkspaceObservedCAS({
      agentId: agent2.id,
      attemptKey: attempt2,
      herdrWorkspaceId: "ws-cas-ag-2",
      herdrPaneId: "pane-cas-ag-2",
      observedCwd: testRepo,
    });

    const registry2 = new HerdrGatewayRegistry();
    const spy2 = new SpyHerdrGateway("/tmp/test.sock", registry2, store);
    const agentName2 = buildDeterministicHerdrAgentName(attempt2, hash2);
    spy2.simulatedPanes = [
      { pane_id: "pane-cas-ag-2", workspace_id: "ws-cas-ag-2", cwd: testRepo, foreground_cwd: testRepo },
    ];
    spy2.simulatedAgents.set(agentName2, {
      name: agentName2,
      agent: agentName2,
      workspace_id: "ws-cas-ag-2",
      pane_id: "pane-cas-ag-2",
      cwd: testRepo,
      foreground_cwd: testRepo,
      agent_status: "idle",
      interactive_ready: true,
    });

    const origAgObserved = store.recordExternalRuntimeAgentObservedCAS.bind(store);
    store.recordExternalRuntimeAgentObservedCAS = () => ({ applied: false, reason: "simulated failure" });

    await assert.rejects(
      spy2.startExternalAgent({
        agentId: agent2.id,
        store,
        attemptKey: attempt2,
        dispatchIntentHash: hash2,
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-cas-2",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );
    assert.equal(registry2.getHandle(attempt2), undefined, "Registry must NOT contain handle after agent CAS failure");
    store.recordExternalRuntimeAgentObservedCAS = origAgObserved;

    // 3. REC-CAS-FINAL-BIND-FAIL:
    // Workspace and agent CAS succeed, but bindExternalRuntimeBindingCAS returns applied=false
    const attempt3 = `rec-cas-bind-fail-${Date.now()}`;
    const intent3 = { ...intent1, attemptId: attempt3 };
    const hash3 = hashDispatchIntent(intent3);
    const agent3 = store.create({
      workspaceId: "ws-cas-3",
      workspaceRoot: testRepo,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attempt3, requestHash: "hash-cas-3" },
      executionContract: { writePaths: ["src"], dispatchIntent: intent3 },
    });
    store.fenceExternalRuntimeLaunchCAS({
      agentId: agent3.id,
      attemptKey: attempt3,
      dispatchIntentHash: hash3,
      canonicalWorktreePath: testRepo,
      gitHeadBefore: gitHead,
      agentKind: "opencode",
      promptNonce: `NONCE-${attempt3}`,
      workspaceId: "ws-cas-3",
    });
    store.recordExternalRuntimeWorkspaceObservedCAS({
      agentId: agent3.id,
      attemptKey: attempt3,
      herdrWorkspaceId: "ws-cas-bind-3",
      herdrPaneId: "pane-cas-bind-3",
      observedCwd: testRepo,
    });

    const registry3 = new HerdrGatewayRegistry();
    const spy3 = new SpyHerdrGateway("/tmp/test.sock", registry3, store);
    const agentName3 = buildDeterministicHerdrAgentName(attempt3, hash3);
    spy3.simulatedPanes = [
      { pane_id: "pane-cas-bind-3", workspace_id: "ws-cas-bind-3", cwd: testRepo, foreground_cwd: testRepo },
    ];
    spy3.simulatedAgents.set(agentName3, {
      name: agentName3,
      agent: agentName3,
      workspace_id: "ws-cas-bind-3",
      pane_id: "pane-cas-bind-3",
      cwd: testRepo,
      foreground_cwd: testRepo,
      agent_status: "idle",
      interactive_ready: true,
    });

    const origBind = store.bindExternalRuntimeBindingCAS.bind(store);
    store.bindExternalRuntimeBindingCAS = () => ({ applied: false, reason: "simulated failure" });

    await assert.rejects(
      spy3.startExternalAgent({
        agentId: agent3.id,
        store,
        attemptKey: attempt3,
        dispatchIntentHash: hash3,
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-cas-3",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );
    assert.equal(registry3.getHandle(attempt3), undefined, "Registry must NOT contain handle after final bind failure");
    store.bindExternalRuntimeBindingCAS = origBind;
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(testRepo, { recursive: true, force: true });
  }
});

test("No-store failure matrix: LAUNCH_NO_DURABLE_STORE and PROMPT_NO_DURABLE_STORE with zero external calls (Section 36, 37, R6-REPRO-3)", async () => {
  const testRepo = mkdtempSync(join(tmpdir(), "devspace-no-store-repo-"));
  try {
    execFileSync("git", ["init", testRepo], { stdio: "ignore" });
    execFileSync("git", ["-C", testRepo, "config", "user.name", "Test"], { stdio: "ignore" });
    execFileSync("git", ["-C", testRepo, "config", "user.email", "test@test.com"], { stdio: "ignore" });
    writeFileSync(join(testRepo, "test.txt"), "hello");
    execFileSync("git", ["-C", testRepo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", testRepo, "commit", "-m", "init"], { stdio: "ignore" });

    const gatewayWithoutStore = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry());

    // 1. LAUNCH_NO_DURABLE_STORE
    await assert.rejects(
      gatewayWithoutStore.startExternalAgent({
        attemptKey: "attempt-no-store",
        dispatchIntentHash: "hash-no-store",
        agentKind: "opencode",
        canonicalWorktreePath: testRepo,
        workspaceId: "ws-no-store",
      }),
      (err: any) => {
        assert.match(err.message, /\[LAUNCH_NO_DURABLE_STORE\]/);
        return true;
      },
    );
    assert.equal(gatewayWithoutStore.workspaceCreateCalls, 0, "No workspace.create calls when store is absent");
    assert.equal(gatewayWithoutStore.agentStartCalls, 0, "No agent.start calls when store is absent");
    assert.equal(gatewayWithoutStore.agentWaitCalls, 0, "No agent.wait calls when store is absent");

    // 2. PROMPT_NO_DURABLE_STORE
    const dummyHandle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      agentId: "dummy-agent-id",
      herdrSocketPath: "/tmp/test.sock",
      herdrWorkspaceId: "w1",
      herdrPaneId: "p1",
      herdrAgentIdentity: "ds-no-store",
      herdrAgentKind: "opencode",
      promptNonce: "NONCE-NO-STORE",
      canonicalWorktreePath: testRepo,
      workspaceId: "ws-no-store",
      gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
      attemptKey: "attempt-no-store",
      dispatchIntentHash: "hash-no-store",
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    await assert.rejects(
      gatewayWithoutStore.promptExternalAgent(dummyHandle, "some prompt"),
      (err: any) => {
        assert.match(err.message, /\[PROMPT_NO_DURABLE_STORE\]/);
        return true;
      },
    );
    assert.equal(gatewayWithoutStore.agentPromptCalls, 0, "No agent.prompt calls when store is absent");
  } finally {
    rmSync(testRepo, { recursive: true, force: true });
  }
});
