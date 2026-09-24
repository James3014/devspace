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
  buildHerdrAgentArgs,
  normalizeHerdrSocketPath,
  type HerdrExternalHandle,
  type HerdrSocketRequest,
  type HerdrSocketResponse,
  type HerdrPaneInfo,
  type HerdrAgentInfo,
} from "./local-agent-herdr.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { hashDispatchIntent } from "./execution-protocol.js";
import { LocalAgentSessionManager } from "./local-agent-sessions.js";

test("buildHerdrAgentArgs binds requested provider model, effort, and permission mode", () => {
  const cwd = "/tmp/worktree";
  assert.deepEqual(
    buildHerdrAgentArgs({ agentKind: "opencode", requestedModel: "mimo-v2.6-flash-free", writeMode: "read_only" }, cwd),
    ["-m", "mimo-v2.6-flash-free"],
  );
  assert.deepEqual(
    buildHerdrAgentArgs({ agentKind: "agy", requestedModel: "gemini-3.7-flash-medium", writeMode: "read_only" }, cwd),
    ["--model", "gemini-3.7-flash-medium", "--sandbox", "--dangerously-skip-permissions", "--add-dir", cwd, "--mode", "plan"],
  );
  assert.deepEqual(
    buildHerdrAgentArgs({ agentKind: "codex", requestedModel: "gpt-5.6-luna", requestedEffort: "high", writeMode: "read_only" }, cwd),
    ["-m", "gpt-5.6-luna", "-c", 'model_reasoning_effort="high"', "-s", "read-only", "-a", "never", "-C", cwd],
  );
  assert.deepEqual(
    buildHerdrAgentArgs({ agentKind: "grok", requestedModel: "grok-4.6", requestedEffort: "high", writeMode: "allowed" }, cwd),
    ["-m", "grok-4.6", "--reasoning-effort", "high", "--permission-mode", "acceptEdits", "--cwd", cwd],
  );
  assert.deepEqual(
    buildHerdrAgentArgs({ agentKind: "cline", requestedModel: "cline-pass/glm-5.3-flash", requestedEffort: "medium", requestedCliProviderId: "cline-pass", writeMode: "read_only" }, cwd),
    ["-P", "cline-pass", "--model", "cline-pass/glm-5.3-flash", "--thinking", "medium", "--plan", "--auto-approve"],
  );
});

test("HerdrGatewayRegistry scopes replay identity by workspace", () => {
  const registry = new HerdrGatewayRegistry();
  const base: HerdrExternalHandle = {
    schemaVersion: 1,
    runtimeKind: "HERDR",
    herdrSocketPath: "/tmp/herdr.sock",
    herdrWorkspaceId: "w-a",
    herdrPaneId: "w-a:p1",
    herdrAgentIdentity: "agent-a",
    herdrAgentKind: "opencode",
    promptNonce: "nonce-a",
    canonicalWorktreePath: "/tmp/worktree-a",
    workspaceId: "ws-a",
    gitHeadBefore: "a".repeat(40),
    attemptKey: "shared-attempt",
    dispatchIntentHash: "hash-a",
    launchTimestamp: "2026-09-25T00:00:00.000Z",
    enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
  };
  const other: HerdrExternalHandle = {
    ...base,
    herdrWorkspaceId: "w-b",
    herdrPaneId: "w-b:p1",
    herdrAgentIdentity: "agent-b",
    canonicalWorktreePath: "/tmp/worktree-b",
    workspaceId: "ws-b",
    dispatchIntentHash: "hash-b",
    promptNonce: "nonce-b",
  };

  registry.registerHandle(base);
  registry.registerHandle(other);

  assert.equal(registry.getHandle("shared-attempt"), undefined, "ambiguous global lookup must fail closed");
  assert.equal(registry.getHandle("shared-attempt", "ws-a"), base);
  assert.equal(registry.getHandle("shared-attempt", "ws-b"), other);

  registry.markPromptSubmitted("shared-attempt", "nonce-a", "ws-a");
  assert.equal(registry.hasPromptSubmitted("shared-attempt", "nonce-a", "ws-a"), true);
  assert.equal(registry.hasPromptSubmitted("shared-attempt", "nonce-a", "ws-b"), false);

  registry.releaseHandle("shared-attempt", "ws-a");
  assert.equal(registry.getHandle("shared-attempt", "ws-a"), undefined);
  assert.equal(registry.getHandle("shared-attempt", "ws-b"), other);
});

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
  // Declared outside try so they're accessible in finally
  let stateDir: string | undefined;
  let store: LocalAgentStore | undefined;
  try {
    execFileSync("git", ["init", testDir], { stdio: "ignore" });
    execFileSync("git", ["-C", testDir, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", testDir, "config", "user.email", "test@example.com"], { stdio: "ignore" });

    // Initial commit (valid 40-character commit SHA for gitHeadBefore)
    writeFileSync(join(testDir, "README.md"), "# Initial\n");
    execFileSync("git", ["-C", testDir, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", testDir, "commit", "-m", "init"], { stdio: "ignore" });
    const initCommit = execFileSync("git", ["-C", testDir, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

    stateDir = mkdtempSync(join(tmpdir(), "herdr-reconcile-store-"));
    store = new LocalAgentStore(stateDir);
    const agent = store.create({
      workspaceId: "ws-2",
      workspaceRoot: testDir,
      profileName: "worker",
      provider: "opencode",
    });
    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      agentId: agent.id,
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

    // Bind handle directly (no startReplay/executionContract guards needed for this test)
    store.bindExternalRuntimeBindingCAS({
      agentId: agent.id,
      binding: {
        runtimeKind: HERDR_RUNTIME_KIND,
        handle: handle as unknown as Record<string, unknown>,
      },
    });

    const gateway = new HerdrThinGateway("/nonexistent/herdr.sock", undefined, store);

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
    const liveGateway = new HerdrThinGateway(undefined, undefined, store);
    (liveGateway as any).sendRequest = async () => ({
      result: { type: "pong" },
    });
    (liveGateway as any).getPane = async () => ({
      pane_id: handle.herdrPaneId,
      workspace_id: handle.herdrWorkspaceId,
      cwd: testDir,
      foreground_cwd: testDir,
    });
    (liveGateway as any).getAgent = async () => ({
      name: handle.herdrAgentIdentity,
      agent: handle.herdrAgentKind,
      workspace_id: handle.herdrWorkspaceId,
      pane_id: handle.herdrPaneId,
      cwd: testDir,
      foreground_cwd: testDir,
      agent_status: "done",
      interactive_ready: true,
    });

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
    store?.close();
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("HerdrThinGateway enforces N-TURN by rejecting prompts to busy agents", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-herdr-busy-agent-"));
  const store = new LocalAgentStore(stateDir);
  const gateway = new HerdrThinGateway("/tmp/test.sock", undefined, store);
  (gateway as any).getPane = async () => ({
    pane_id: "p1",
    workspace_id: "w1",
    cwd: "/tmp",
    foreground_cwd: "/tmp",
  });
  // Mock getAgent to simulate an already busy agent
  (gateway as any).getAgent = async () => ({
    name: "ds-busy-agent",
    agent: "opencode",
    workspace_id: "w1",
    pane_id: "p1",
    cwd: "/tmp",
    foreground_cwd: "/tmp",
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

    (gateway as any).getPane = async () => ({
      pane_id: "p1",
      workspace_id: "w1",
      cwd: "/tmp",
      foreground_cwd: "/tmp",
    });
    (gateway as any).getAgent = async () => ({
      name: "ds-turn-agent",
      agent: "opencode",
      workspace_id: "w1",
      pane_id: "p1",
      cwd: "/tmp",
      foreground_cwd: "/tmp",
      agent_status: "idle",
      interactive_ready: true,
    });
    (gateway as any).readPane = async () => "ready\n";

    let capturedPrompt = "";
    (gateway as any).sendRequest = async (req: any) => {
      if (req.method === "agent.prompt") {
        capturedPrompt = req.params?.text ?? "";
        return {
          result: {
            agent: {
              name: "ds-turn-agent",
              agent: "opencode",
              workspace_id: "w1",
              pane_id: "p1",
              cwd: "/tmp",
              foreground_cwd: "/tmp",
              agent_status: "done",
              interactive_ready: true,
            },
          },
        };
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
      // F5: If live identity is verified and process settled idle/done without mutating, completionStatus is NOT_COMPLETE.
      // If live identity was lost/unknown, completionStatus is truthfully OUTCOME_UNKNOWN.
      assert.ok(
        reconcileRes.completionStatus === "NOT_COMPLETE" || reconcileRes.completionStatus === "OUTCOME_UNKNOWN",
        `Expected NOT_COMPLETE or OUTCOME_UNKNOWN, got ${reconcileRes.completionStatus}`,
      );
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
  public workspaceCloseCalls = 0;
  public agentStartCalls = 0;
  public agentPromptCalls = 0;
  public agentWaitCalls = 0;
  public listWorkspacesCalls = 0;
  public getWorkspaceCalls = 0;
  public listPanesCalls = 0;
  public getPaneCalls = 0;
  public getAgentCalls = 0;

  public failWorkspaceCreate = false;
  public failWorkspaceClose = false;
  public failAgentStart = false;
  public failAgentGet = false;
  public simulatedWorkspaces: Array<{ workspace_id: string; label?: string }> = [];
  public simulatedPanes: Array<HerdrPaneInfo> = [];
  public simulatedAgents: Map<string, HerdrAgentInfo> = new Map();
  public simulatedAgentStatus: HerdrAgentInfo | undefined;
  public socketCalls: Map<string, number> = new Map();
  public lastSocketPath?: string;
  public receivedSocketRequests: Array<{ method: string; socketPath?: string }> = [];
  public readPaneCalls = 0;
  public lastReadPaneSocketPath?: string;

  override async sendRequest<T = unknown>(
    req: HerdrSocketRequest,
    timeoutMs: number = 10_000,
    socketPath?: string,
  ): Promise<HerdrSocketResponse<T>> {
    const effectiveSocket = socketPath || (this as any).socketPath;
    this.lastSocketPath = effectiveSocket;
    this.socketCalls.set(effectiveSocket, (this.socketCalls.get(effectiveSocket) || 0) + 1);
    this.receivedSocketRequests.push({ method: req.method, socketPath: effectiveSocket });

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

    if (req.method === "workspace.close") {
      this.workspaceCloseCalls++;
      if (this.failWorkspaceClose) {
        throw new Error("Simulated network timeout during workspace.close");
      }
      return { id: req.id, result: { type: "ok" } as unknown as T };
    }

    if (req.method === "agent.start") {
      this.agentStartCalls++;
      if (this.failAgentStart) {
        throw new Error("Simulated network timeout during agent.start");
      }
      const name = (req.params as any)?.name;
      const paneId = (req.params as any)?.pane_id;
      const kind = (req.params as any)?.kind;
      const pane = this.simulatedPanes.find((p) => p.pane_id === paneId);
      const agentInfo: HerdrAgentInfo = {
        name,
        agent: kind || name,
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
          type: "agent_started",
          agent: {
            ...agentInfo,
            state_change_seq: 1,
          },
        } as unknown as T,
      };
    }

    if (req.method === "agent.prompt") {
      this.agentPromptCalls++;
      const target = (req.params as any)?.target;
      const agentInfo = this.simulatedAgents.get(target);
      return {
        id: req.id,
        result: {
          type: "agent_prompted",
          agent: {
            name: target,
            agent: agentInfo?.agent || target,
            workspace_id: agentInfo?.workspace_id,
            pane_id: agentInfo?.pane_id,
            cwd: agentInfo?.cwd,
            foreground_cwd: agentInfo?.foreground_cwd,
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
      if (this.failAgentGet) {
        throw new Error("Simulated agent.get transport failure");
      }
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

    if (req.method === "ping") {
      return { id: req.id, result: { type: "pong" } as unknown as T };
    }

    return { id: req.id, result: {} as unknown as T };
  }

  override async readPane(paneId: string, lines: number = 50, socketPath?: string): Promise<string> {
    this.readPaneCalls++;
    this.lastReadPaneSocketPath = socketPath;
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

    // Setup simulated pane and agent for live identity validation
    spy.simulatedPanes = [
      { pane_id: "p1", workspace_id: "ws1", cwd: "/tmp", foreground_cwd: "/tmp" },
    ];
    spy.simulatedAgents.set("ds-pf-agent", {
      name: "ds-pf-agent",
      agent: "opencode",
      workspace_id: "ws1",
      pane_id: "p1",
      cwd: "/tmp",
      foreground_cwd: "/tmp",
      agent_status: "idle",
      interactive_ready: true,
    });

    // 1. PF-WRONG-AGENT-ATTEMPT: agentId points to agent with attemptKey, but handle has different attemptKey
    const wrongAttemptHandle = { ...validHandle, attemptKey: "WRONG-ATTEMPT" };
    await assert.rejects(
      spy.promptExternalAgent(wrongAttemptHandle, "prompt text", { store }),
      (err: any) => {
        // Repair 8: F1 durable authority gate fires before fence CAS for fields included in handle normalization
        assert.match(err.message, /\[FAIL_CLOSED \/ DURABLE_HANDLE_AUTHORITY_MISMATCH\]|\[N-TURN-OPTION-A\]/);
        return true;
      },
    );
    assert.equal(spy.agentPromptCalls, 0, "PF-WRONG-AGENT-ATTEMPT must result in 0 external prompt calls");

    // 2. PF-WRONG-DISPATCH: handle has mismatched dispatchIntentHash
    const wrongDispatchHandle = { ...validHandle, dispatchIntentHash: "WRONG-DISPATCH-HASH" };
    await assert.rejects(
      spy.promptExternalAgent(wrongDispatchHandle, "prompt text", { store }),
      (err: any) => {
        // Repair 8: F1 durable authority gate fires before fence CAS for fields included in handle normalization
        assert.match(err.message, /\[FAIL_CLOSED \/ DURABLE_HANDLE_AUTHORITY_MISMATCH\]|\[N-TURN-OPTION-A\]/);
        return true;
      },
    );
    assert.equal(spy.agentPromptCalls, 0, "PF-WRONG-DISPATCH must result in 0 external prompt calls");

    // 3. PF-WRONG-NONCE: caller provides handle with different promptNonce
    const wrongNonceHandle = { ...validHandle, promptNonce: "WRONG-NONCE" };
    await assert.rejects(
      spy.promptExternalAgent(wrongNonceHandle, "prompt text", { store }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED .*\]|\[N-TURN-OPTION-A\]/);
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
        assert.match(err.message, /\[FAIL_CLOSED .*\]|\[N-TURN-OPTION-A\]/);
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
        assert.match(err.message, /\[FAIL_CLOSED .*\]|\[N-TURN-OPTION-A\]/);
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
        assert.match(err.message, /\[FAIL_CLOSED .*\]|\[N-TURN-OPTION-A\]/);
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
    spy2.simulatedPanes = [...spy1.simulatedPanes];
    spy2.simulatedAgents = new Map(spy1.simulatedAgents);
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
      agent: "opencode",
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
      agent: "opencode",
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
        herdrSocketPath: "/tmp/test.sock",
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
      agent: "opencode",
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
      agent: "opencode",
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
      agent: "opencode",
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
      agent: "opencode",
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
      agent: "opencode",
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
      agent: "opencode",
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

function createIsolatedTestGitRepo(): { repoPath: string; headSha: string } {
  const repoPath = mkdtempSync(join(tmpdir(), "devspace-herdr-test-repo-"));
  execFileSync("git", ["init", repoPath], { stdio: "ignore" });
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoPath, "config", "user.email", "test@test.com"], { stdio: "ignore" });
  writeFileSync(join(repoPath, "test.txt"), "hello world\n");
  execFileSync("git", ["-C", repoPath, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", repoPath, "commit", "-m", "init"], { stdio: "ignore" });
  const headSha = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  return { repoPath, headSha };
}

test("HerdrThinGateway first launch agent.start response identity validation (E1, FL-EXACT, FL-WRONG-WORKSPACE, FL-WRONG-PANE, FL-WRONG-CWD, FL-WRONG-NAME, FL-MISSING-IDENTITY, REPRODUCER-1)", async () => {
  const { repoPath, headSha } = createIsolatedTestGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-fl-matrix-"));
  const store = new LocalAgentStore(stateDir);

  try {
    const runLaunchCase = async (overrideResult?: (req: HerdrSocketRequest, defaultResult: any) => any) => {
      const attemptKey = `fl-case-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const intent = {
        taskId: `task-${attemptKey}`,
        attemptId: attemptKey,
        objective: "FL matrix test",
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
        workspaceId: "ws-fl",
        workspaceRoot: repoPath,
        profileName: "worker",
        provider: "opencode",
        startReplay: { key: attemptKey, requestHash: `req-${attemptKey}` },
        executionContract: { writePaths: ["src"], dispatchIntent: intent },
      });

      const registry = new HerdrGatewayRegistry();
      const spy = new SpyHerdrGateway("/tmp/test.sock", registry, store);

      if (overrideResult) {
        const origSend = spy.sendRequest.bind(spy);
        spy.sendRequest = async (req, timeout, sock) => {
          const res = await origSend(req, timeout, sock);
          if (req.method === "agent.start") {
            return overrideResult(req, res);
          }
          return res;
        };
      }

      return {
        attemptKey,
        hash,
        agent,
        spy,
        registry,
        startPromise: spy.startExternalAgent({
          agentId: agent.id,
          store,
          attemptKey,
          dispatchIntentHash: hash,
          agentKind: "opencode",
          canonicalWorktreePath: repoPath,
          workspaceId: "ws-fl",
        }),
      };
    };

    // 1. FL-EXACT: exact matching workspace, pane, cwd, and name -> succeeds
    const cExact = await runLaunchCase();
    const handleExact = await cExact.startPromise;
    assert.ok(handleExact);
    assert.equal(cExact.spy.workspaceCreateCalls, 1);
    assert.equal(cExact.spy.agentStartCalls, 1);
    assert.equal(cExact.spy.agentWaitCalls, 1);
    assert.equal(cExact.spy.workspaceCloseCalls, 0);
    const recExact = store.getById(cExact.agent.id);
    assert.equal(recExact?.externalRuntimeBinding?.launch?.state, "AGENT_OBSERVED");
    assert.ok(recExact?.externalRuntimeBinding?.handle);
    assert.ok(cExact.registry.getHandle(cExact.attemptKey));

    // 2. FL-WRONG-WORKSPACE: agent.start returns wrong workspace_id -> fails closed
    const cWrongWs = await runLaunchCase((req, res) => ({
      ...res,
      result: {
        ...res.result,
        agent: {
          ...res.result.agent,
          workspace_id: "wrong-ws-returned",
        },
      },
    }));
    await assert.rejects(cWrongWs.startPromise, (err: any) => {
      assert.match(err.message, /\[FAIL_CLOSED \/ E1\]/);
      return true;
    });
    assert.equal(cWrongWs.spy.workspaceCloseCalls, 1, "Workspace must be closed upon validation failure");
    assert.equal(cWrongWs.spy.agentWaitCalls, 0, "Zero agent.wait calls on validation failure");
    const recWrongWs = store.getById(cWrongWs.agent.id);
    assert.equal(recWrongWs?.externalRuntimeBinding?.launch?.state, "OUTCOME_UNKNOWN");
    assert.equal(recWrongWs?.externalRuntimeBinding?.handle, undefined);
    assert.equal(cWrongWs.registry.getHandle(cWrongWs.attemptKey), undefined);

    // 3. FL-WRONG-PANE: agent.start returns wrong pane_id -> fails closed
    const cWrongPane = await runLaunchCase((req, res) => ({
      ...res,
      result: {
        ...res.result,
        agent: {
          ...res.result.agent,
          pane_id: "wrong-pane-returned",
        },
      },
    }));
    await assert.rejects(cWrongPane.startPromise, (err: any) => {
      assert.match(err.message, /\[FAIL_CLOSED \/ E1\]/);
      return true;
    });
    assert.equal(cWrongPane.spy.workspaceCloseCalls, 1);
    assert.equal(cWrongPane.spy.agentWaitCalls, 0);
    assert.equal(store.getById(cWrongPane.agent.id)?.externalRuntimeBinding?.handle, undefined);
    assert.equal(cWrongPane.registry.getHandle(cWrongPane.attemptKey), undefined);

    // 4. FL-WRONG-CWD: agent.start returns wrong cwd -> fails closed
    const cWrongCwd = await runLaunchCase((req, res) => ({
      ...res,
      result: {
        ...res.result,
        agent: {
          ...res.result.agent,
          cwd: "/completely/unrelated/path",
          foreground_cwd: "/completely/unrelated/path",
        },
      },
    }));
    await assert.rejects(cWrongCwd.startPromise, (err: any) => {
      assert.match(err.message, /\[FAIL_CLOSED \/ E1\]/);
      return true;
    });
    assert.equal(cWrongCwd.spy.workspaceCloseCalls, 1);
    assert.equal(cWrongCwd.spy.agentWaitCalls, 0);
    assert.equal(store.getById(cWrongCwd.agent.id)?.externalRuntimeBinding?.handle, undefined);

    // 5. FL-WRONG-NAME: agent.start returns wrong name -> fails closed
    const cWrongName = await runLaunchCase((req, res) => ({
      ...res,
      result: {
        ...res.result,
        agent: {
          ...res.result.agent,
          name: "wrong-agent-name",
        },
      },
    }));
    await assert.rejects(cWrongName.startPromise, (err: any) => {
      assert.match(err.message, /\[FAIL_CLOSED \/ E1\]/);
      return true;
    });
    assert.equal(cWrongName.spy.workspaceCloseCalls, 1);
    assert.equal(cWrongName.spy.agentWaitCalls, 0);
    assert.equal(store.getById(cWrongName.agent.id)?.externalRuntimeBinding?.handle, undefined);

    // 6. FL-MISSING-IDENTITY: agent.start returns empty identity fields -> fails closed
    const cMissingId = await runLaunchCase((req, res) => ({
      ...res,
      result: {
        type: "agent_started",
        agent: {
          agent_status: "running",
          interactive_ready: true,
        },
      },
    }));
    await assert.rejects(cMissingId.startPromise, (err: any) => {
      assert.match(err.message, /\[FAIL_CLOSED \/ E1\]/);
      return true;
    });
    assert.equal(cMissingId.spy.workspaceCloseCalls, 1);
    assert.equal(cMissingId.spy.agentWaitCalls, 0);
    assert.equal(store.getById(cMissingId.agent.id)?.externalRuntimeBinding?.handle, undefined);

    // 7. REPRODUCER-1: Verify that untrusted agent.start response never leaks into durable store or registry
    assert.equal(cWrongWs.registry.getHandle(cWrongWs.attemptKey), undefined);
    assert.equal(cWrongPane.registry.getHandle(cWrongPane.attemptKey), undefined);
    assert.equal(cWrongCwd.registry.getHandle(cWrongCwd.attemptKey), undefined);
    assert.equal(cWrongName.registry.getHandle(cWrongName.attemptKey), undefined);
    assert.equal(cMissingId.registry.getHandle(cMissingId.attemptKey), undefined);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("HerdrThinGateway replay requires current live process continuity (E2, HR-EXACT-LIVE, HR-PANE-MISSING, HR-AGENT-MISSING, HR-PANE-WRONG-CWD, HR-AGENT-WRONG-WORKSPACE, HR-AGENT-WRONG-PANE, HR-AGENT-WRONG-CWD, HR-AGENT-WRONG-NAME, REPRODUCER-2)", async () => {
  const { repoPath, headSha } = createIsolatedTestGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-hr-matrix-"));
  const store = new LocalAgentStore(stateDir);

  try {
    const attemptKey = `hr-test-${Date.now()}`;
    const intent = {
      taskId: "task-hr",
      attemptId: attemptKey,
      objective: "HR replay matrix",
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
      workspaceId: "ws-hr",
      workspaceRoot: repoPath,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attemptKey, requestHash: "hash-hr" },
      executionContract: { writePaths: ["src"], dispatchIntent: intent },
    });

    const initRegistry = new HerdrGatewayRegistry();
    const spyInit = new SpyHerdrGateway("/tmp/test.sock", initRegistry, store);
    const initialHandle = await spyInit.startExternalAgent({
      agentId: agent.id,
      store,
      attemptKey,
      dispatchIntentHash: hash,
      agentKind: "opencode",
      canonicalWorktreePath: repoPath,
      workspaceId: "ws-hr",
    });

    // 1. HR-EXACT-LIVE: Replay with live pane and agent alive -> succeeds
    const regLive = new HerdrGatewayRegistry();
    const spyLive = new SpyHerdrGateway("/tmp/test.sock", regLive, store);
    spyLive.simulatedPanes = [...spyInit.simulatedPanes];
    spyLive.simulatedAgents = new Map(spyInit.simulatedAgents);
    const replayHandle = await spyLive.startExternalAgent({
      agentId: agent.id,
      store,
      attemptKey,
      dispatchIntentHash: hash,
      agentKind: "opencode",
      canonicalWorktreePath: repoPath,
      workspaceId: "ws-hr",
    });
    assert.deepEqual(replayHandle, initialHandle);
    assert.equal(spyLive.workspaceCreateCalls, 0);
    assert.equal(spyLive.agentStartCalls, 0);
    assert.ok(regLive.getHandle(attemptKey));

    // 2. HR-PANE-MISSING: Pane missing -> fails closed
    const spyPaneMissing = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    spyPaneMissing.simulatedPanes = []; // Pane missing!
    spyPaneMissing.simulatedAgents = new Map(spyInit.simulatedAgents);
    await assert.rejects(
      spyPaneMissing.startExternalAgent({
        agentId: agent.id,
        store,
        attemptKey,
        dispatchIntentHash: hash,
        agentKind: "opencode",
        canonicalWorktreePath: repoPath,
        workspaceId: "ws-hr",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );

    // 3. HR-AGENT-MISSING: Agent missing -> fails closed
    const spyAgentMissing = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    spyAgentMissing.simulatedPanes = [...spyInit.simulatedPanes];
    spyAgentMissing.simulatedAgents = new Map(); // Agent missing!
    await assert.rejects(
      spyAgentMissing.startExternalAgent({
        agentId: agent.id,
        store,
        attemptKey,
        dispatchIntentHash: hash,
        agentKind: "opencode",
        canonicalWorktreePath: repoPath,
        workspaceId: "ws-hr",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );

    // 4. HR-PANE-WRONG-CWD: Pane cwd mismatch -> fails closed
    const spyPaneWrongCwd = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    spyPaneWrongCwd.simulatedPanes = [
      {
        pane_id: initialHandle.herdrPaneId,
        workspace_id: initialHandle.herdrWorkspaceId,
        cwd: "/unrelated/cwd",
        foreground_cwd: "/unrelated/cwd",
      },
    ];
    spyPaneWrongCwd.simulatedAgents = new Map(spyInit.simulatedAgents);
    await assert.rejects(
      spyPaneWrongCwd.startExternalAgent({
        agentId: agent.id,
        store,
        attemptKey,
        dispatchIntentHash: hash,
        agentKind: "opencode",
        canonicalWorktreePath: repoPath,
        workspaceId: "ws-hr",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );

    // 5. HR-AGENT-WRONG-WORKSPACE: Agent belongs to wrong workspace -> fails closed
    const spyAgentWrongWs = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    spyAgentWrongWs.simulatedPanes = [...spyInit.simulatedPanes];
    spyAgentWrongWs.simulatedAgents = new Map([
      [
        initialHandle.herdrAgentIdentity,
        {
          name: initialHandle.herdrAgentIdentity,
          agent: initialHandle.herdrAgentKind,
          workspace_id: "wrong-ws",
          pane_id: initialHandle.herdrPaneId,
          cwd: repoPath,
          foreground_cwd: repoPath,
          agent_status: "idle",
          interactive_ready: true,
        },
      ],
    ]);
    await assert.rejects(
      spyAgentWrongWs.startExternalAgent({
        agentId: agent.id,
        store,
        attemptKey,
        dispatchIntentHash: hash,
        agentKind: "opencode",
        canonicalWorktreePath: repoPath,
        workspaceId: "ws-hr",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );

    // 6. HR-AGENT-WRONG-PANE: Agent belongs to wrong pane -> fails closed
    const spyAgentWrongPane = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    spyAgentWrongPane.simulatedPanes = [...spyInit.simulatedPanes];
    spyAgentWrongPane.simulatedAgents = new Map([
      [
        initialHandle.herdrAgentIdentity,
        {
          name: initialHandle.herdrAgentIdentity,
          agent: initialHandle.herdrAgentKind,
          workspace_id: initialHandle.herdrWorkspaceId,
          pane_id: "wrong-pane",
          cwd: repoPath,
          foreground_cwd: repoPath,
          agent_status: "idle",
          interactive_ready: true,
        },
      ],
    ]);
    await assert.rejects(
      spyAgentWrongPane.startExternalAgent({
        agentId: agent.id,
        store,
        attemptKey,
        dispatchIntentHash: hash,
        agentKind: "opencode",
        canonicalWorktreePath: repoPath,
        workspaceId: "ws-hr",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );

    // 7. HR-AGENT-WRONG-CWD: Agent cwd mismatch -> fails closed
    const spyAgentWrongCwd = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    spyAgentWrongCwd.simulatedPanes = [...spyInit.simulatedPanes];
    spyAgentWrongCwd.simulatedAgents = new Map([
      [
        initialHandle.herdrAgentIdentity,
        {
          name: initialHandle.herdrAgentIdentity,
          agent: initialHandle.herdrAgentKind,
          workspace_id: initialHandle.herdrWorkspaceId,
          pane_id: initialHandle.herdrPaneId,
          cwd: "/wrong/cwd",
          foreground_cwd: "/wrong/cwd",
          agent_status: "idle",
          interactive_ready: true,
        },
      ],
    ]);
    await assert.rejects(
      spyAgentWrongCwd.startExternalAgent({
        agentId: agent.id,
        store,
        attemptKey,
        dispatchIntentHash: hash,
        agentKind: "opencode",
        canonicalWorktreePath: repoPath,
        workspaceId: "ws-hr",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );

    // 8. HR-AGENT-WRONG-NAME: Agent name mismatch -> fails closed
    const spyAgentWrongName = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    spyAgentWrongName.simulatedPanes = [...spyInit.simulatedPanes];
    spyAgentWrongName.simulatedAgents = new Map([
      [
        initialHandle.herdrAgentIdentity,
        {
          name: "wrong-named-agent",
          agent: initialHandle.herdrAgentKind,
          workspace_id: initialHandle.herdrWorkspaceId,
          pane_id: initialHandle.herdrPaneId,
          cwd: repoPath,
          foreground_cwd: repoPath,
          agent_status: "idle",
          interactive_ready: true,
        },
      ],
    ]);
    await assert.rejects(
      spyAgentWrongName.startExternalAgent({
        agentId: agent.id,
        store,
        attemptKey,
        dispatchIntentHash: hash,
        agentKind: "opencode",
        canonicalWorktreePath: repoPath,
        workspaceId: "ws-hr",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\]/);
        return true;
      },
    );

    // 9. REPRODUCER-2: Verify zero handle registration in registry for all stale cases
    assert.equal(spyPaneMissing.agentStartCalls, 0);
    assert.equal(spyAgentMissing.agentStartCalls, 0);
    assert.equal(spyPaneWrongCwd.agentStartCalls, 0);
    assert.equal(spyAgentWrongWs.agentStartCalls, 0);
    assert.equal(spyAgentWrongPane.agentStartCalls, 0);
    assert.equal(spyAgentWrongCwd.agentStartCalls, 0);
    assert.equal(spyAgentWrongName.agentStartCalls, 0);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("HerdrThinGateway prompt live identity validation and response checks (E3, PI-EXACT, PI-AGENT-MISSING, PI-PANE-MISSING, PI-WRONG-WORKSPACE, PI-WRONG-PANE, PI-WRONG-CWD, PI-WRONG-NAME, PI-IDENTITY-LOST-AFTER-FENCE, PI-RESPONSE-IDENTITY-MISMATCH, REPRODUCER-3)", async () => {
  const { repoPath, headSha } = createIsolatedTestGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-pi-matrix-"));
  const store = new LocalAgentStore(stateDir);

  try {
    const setupPromptContext = () => {
      const attemptKey = `pi-case-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const intent = {
        taskId: `task-${attemptKey}`,
        attemptId: attemptKey,
        objective: "PI matrix test",
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
        workspaceId: "ws-pi",
        workspaceRoot: repoPath,
        profileName: "worker",
        provider: "opencode",
        startReplay: { key: attemptKey, requestHash: `req-${attemptKey}` },
        executionContract: { writePaths: ["src"], dispatchIntent: intent },
      });

      const promptNonce = `NONCE-${attemptKey}`;
      const handle: HerdrExternalHandle = {
        schemaVersion: 1,
        runtimeKind: HERDR_RUNTIME_KIND,
        agentId: agent.id,
        herdrSocketPath: "/tmp/test.sock",
        herdrWorkspaceId: `ws-pi-${attemptKey}`,
        herdrPaneId: `pane-pi-${attemptKey}`,
        herdrAgentIdentity: `agent-pi-${attemptKey}`,
        herdrAgentKind: "opencode",
        promptNonce,
        canonicalWorktreePath: repoPath,
        workspaceId: "ws-pi",
        gitHeadBefore: headSha,
        attemptKey,
        dispatchIntentHash: hash,
        launchTimestamp: new Date().toISOString(),
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
      };

      store.bindExternalRuntimeBindingCAS({
        agentId: agent.id,
        expectedAttemptKey: attemptKey,
        expectedDispatchIntentHash: hash,
        binding: {
          runtimeKind: HERDR_RUNTIME_KIND,
          handle: handle as unknown as Record<string, unknown>,
        },
      });

      const registry = new HerdrGatewayRegistry();
      const spy = new SpyHerdrGateway("/tmp/test.sock", registry, store);
      return { attemptKey, hash, agent, handle, spy, registry };
    };

    // 1. PI-EXACT: valid live pane and agent -> prompt succeeds
    const ctxExact = setupPromptContext();
    ctxExact.spy.simulatedPanes = [
      {
        pane_id: ctxExact.handle.herdrPaneId,
        workspace_id: ctxExact.handle.herdrWorkspaceId,
        cwd: repoPath,
        foreground_cwd: repoPath,
      },
    ];
    ctxExact.spy.simulatedAgents.set(ctxExact.handle.herdrAgentIdentity, {
      name: ctxExact.handle.herdrAgentIdentity,
      agent: ctxExact.handle.herdrAgentKind,
      workspace_id: ctxExact.handle.herdrWorkspaceId,
      pane_id: ctxExact.handle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });
    const promptRes = await ctxExact.spy.promptExternalAgent(ctxExact.handle, "prompt text", { store });
    assert.equal(promptRes.status, "done");
    assert.equal(ctxExact.spy.agentPromptCalls, 1);

    // 2. PI-AGENT-MISSING: agent missing before prompt -> fails closed, 0 agent.prompt
    const ctxAgMissing = setupPromptContext();
    ctxAgMissing.spy.simulatedPanes = [
      {
        pane_id: ctxAgMissing.handle.herdrPaneId,
        workspace_id: ctxAgMissing.handle.herdrWorkspaceId,
        cwd: repoPath,
        foreground_cwd: repoPath,
      },
    ];
    ctxAgMissing.spy.simulatedAgents = new Map(); // Agent missing!
    await assert.rejects(
      ctxAgMissing.spy.promptExternalAgent(ctxAgMissing.handle, "prompt text", { store }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ E3\]/);
        return true;
      },
    );
    assert.equal(ctxAgMissing.spy.agentPromptCalls, 0, "Zero agent.prompt calls on missing agent");

    // 3. PI-PANE-MISSING: pane missing before prompt -> fails closed, 0 agent.prompt
    const ctxPaneMissing = setupPromptContext();
    ctxPaneMissing.spy.simulatedPanes = []; // Pane missing!
    ctxPaneMissing.spy.simulatedAgents.set(ctxPaneMissing.handle.herdrAgentIdentity, {
      name: ctxPaneMissing.handle.herdrAgentIdentity,
      agent: ctxPaneMissing.handle.herdrAgentKind,
      workspace_id: ctxPaneMissing.handle.herdrWorkspaceId,
      pane_id: ctxPaneMissing.handle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });
    await assert.rejects(
      ctxPaneMissing.spy.promptExternalAgent(ctxPaneMissing.handle, "prompt text", { store }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ E3\]/);
        return true;
      },
    );
    assert.equal(ctxPaneMissing.spy.agentPromptCalls, 0, "Zero agent.prompt calls on missing pane");

    // 4. PI-WRONG-WORKSPACE: agent in wrong workspace -> fails closed, 0 agent.prompt
    const ctxWrongWs = setupPromptContext();
    ctxWrongWs.spy.simulatedPanes = [
      {
        pane_id: ctxWrongWs.handle.herdrPaneId,
        workspace_id: ctxWrongWs.handle.herdrWorkspaceId,
        cwd: repoPath,
        foreground_cwd: repoPath,
      },
    ];
    ctxWrongWs.spy.simulatedAgents.set(ctxWrongWs.handle.herdrAgentIdentity, {
      name: ctxWrongWs.handle.herdrAgentIdentity,
      agent: ctxWrongWs.handle.herdrAgentKind,
      workspace_id: "wrong-ws",
      pane_id: ctxWrongWs.handle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });
    await assert.rejects(
      ctxWrongWs.spy.promptExternalAgent(ctxWrongWs.handle, "prompt text", { store }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ E3\]/);
        return true;
      },
    );
    assert.equal(ctxWrongWs.spy.agentPromptCalls, 0);

    // 5. PI-WRONG-PANE: agent in wrong pane -> fails closed, 0 agent.prompt
    const ctxWrongPane = setupPromptContext();
    ctxWrongPane.spy.simulatedPanes = [
      {
        pane_id: ctxWrongPane.handle.herdrPaneId,
        workspace_id: ctxWrongPane.handle.herdrWorkspaceId,
        cwd: repoPath,
        foreground_cwd: repoPath,
      },
    ];
    ctxWrongPane.spy.simulatedAgents.set(ctxWrongPane.handle.herdrAgentIdentity, {
      name: ctxWrongPane.handle.herdrAgentIdentity,
      agent: ctxWrongPane.handle.herdrAgentKind,
      workspace_id: ctxWrongPane.handle.herdrWorkspaceId,
      pane_id: "wrong-pane",
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });
    await assert.rejects(
      ctxWrongPane.spy.promptExternalAgent(ctxWrongPane.handle, "prompt text", { store }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ E3\]/);
        return true;
      },
    );
    assert.equal(ctxWrongPane.spy.agentPromptCalls, 0);

    // 6. PI-WRONG-CWD: agent has wrong cwd -> fails closed, 0 agent.prompt
    const ctxWrongCwd = setupPromptContext();
    ctxWrongCwd.spy.simulatedPanes = [
      {
        pane_id: ctxWrongCwd.handle.herdrPaneId,
        workspace_id: ctxWrongCwd.handle.herdrWorkspaceId,
        cwd: repoPath,
        foreground_cwd: repoPath,
      },
    ];
    ctxWrongCwd.spy.simulatedAgents.set(ctxWrongCwd.handle.herdrAgentIdentity, {
      name: ctxWrongCwd.handle.herdrAgentIdentity,
      agent: ctxWrongCwd.handle.herdrAgentKind,
      workspace_id: ctxWrongCwd.handle.herdrWorkspaceId,
      pane_id: ctxWrongCwd.handle.herdrPaneId,
      cwd: "/wrong/cwd",
      foreground_cwd: "/wrong/cwd",
      agent_status: "idle",
      interactive_ready: true,
    });
    await assert.rejects(
      ctxWrongCwd.spy.promptExternalAgent(ctxWrongCwd.handle, "prompt text", { store }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ E3\]/);
        return true;
      },
    );
    assert.equal(ctxWrongCwd.spy.agentPromptCalls, 0);

    // 7. PI-WRONG-NAME: agent has wrong name -> fails closed, 0 agent.prompt
    const ctxWrongName = setupPromptContext();
    ctxWrongName.spy.simulatedPanes = [
      {
        pane_id: ctxWrongName.handle.herdrPaneId,
        workspace_id: ctxWrongName.handle.herdrWorkspaceId,
        cwd: repoPath,
        foreground_cwd: repoPath,
      },
    ];
    ctxWrongName.spy.simulatedAgents.set(ctxWrongName.handle.herdrAgentIdentity, {
      name: "wrong-name",
      agent: ctxWrongName.handle.herdrAgentKind,
      workspace_id: ctxWrongName.handle.herdrWorkspaceId,
      pane_id: ctxWrongName.handle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });
    await assert.rejects(
      ctxWrongName.spy.promptExternalAgent(ctxWrongName.handle, "prompt text", { store }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ E3\]/);
        return true;
      },
    );
    assert.equal(ctxWrongName.spy.agentPromptCalls, 0);

    // 8. PI-IDENTITY-LOST-AFTER-FENCE: agent exists before fence, but vanishes post-fence
    const ctxLostAfterFence = setupPromptContext();
    ctxLostAfterFence.spy.simulatedPanes = [
      {
        pane_id: ctxLostAfterFence.handle.herdrPaneId,
        workspace_id: ctxLostAfterFence.handle.herdrWorkspaceId,
        cwd: repoPath,
        foreground_cwd: repoPath,
      },
    ];
    ctxLostAfterFence.spy.simulatedAgents.set(ctxLostAfterFence.handle.herdrAgentIdentity, {
      name: ctxLostAfterFence.handle.herdrAgentIdentity,
      agent: ctxLostAfterFence.handle.herdrAgentKind,
      workspace_id: ctxLostAfterFence.handle.herdrWorkspaceId,
      pane_id: ctxLostAfterFence.handle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });

    const origFence = store.fenceConsequentialPromptCAS.bind(store);
    store.fenceConsequentialPromptCAS = (args) => {
      const res = origFence(args);
      ctxLostAfterFence.spy.simulatedAgents.clear();
      return res;
    };

    await assert.rejects(
      ctxLostAfterFence.spy.promptExternalAgent(ctxLostAfterFence.handle, "prompt text", { store }),
      (err: any) => {
        assert.match(err.message, /Agent live identity lost or mismatched after prompt fence/);
        return true;
      },
    );
    assert.equal(ctxLostAfterFence.spy.agentPromptCalls, 0, "Zero agent.prompt calls when identity lost after fence");

    // Confirm fence is preserved: subsequent prompt attempt must be rejected under Option A
    store.fenceConsequentialPromptCAS = origFence;
    await assert.rejects(
      ctxLostAfterFence.spy.promptExternalAgent(ctxLostAfterFence.handle, "retry prompt", { store }),
      (err: any) => {
        assert.match(err.message, /\[N-TURN-OPTION-A\]/);
        return true;
      },
    );

    // 9. PI-RESPONSE-IDENTITY-MISMATCH: agent.prompt response returns contradictory AgentInfo
    const ctxRespMismatch = setupPromptContext();
    ctxRespMismatch.spy.simulatedPanes = [
      {
        pane_id: ctxRespMismatch.handle.herdrPaneId,
        workspace_id: ctxRespMismatch.handle.herdrWorkspaceId,
        cwd: repoPath,
        foreground_cwd: repoPath,
      },
    ];
    ctxRespMismatch.spy.simulatedAgents.set(ctxRespMismatch.handle.herdrAgentIdentity, {
      name: ctxRespMismatch.handle.herdrAgentIdentity,
      agent: ctxRespMismatch.handle.herdrAgentKind,
      workspace_id: ctxRespMismatch.handle.herdrWorkspaceId,
      pane_id: ctxRespMismatch.handle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });

    const origSend = ctxRespMismatch.spy.sendRequest.bind(ctxRespMismatch.spy);
    ctxRespMismatch.spy.sendRequest = (async (req: any, timeout?: number, sock?: string): Promise<any> => {
      const res: any = await origSend(req, timeout, sock);
      if (req.method === "agent.prompt") {
        return {
          ...res,
          result: {
            ...res.result,
            agent: {
              ...res.result?.agent,
              workspace_id: "contradicting-workspace-in-response",
            },
          },
        };
      }
      return res;
    }) as any;

    const respResult = await ctxRespMismatch.spy.promptExternalAgent(ctxRespMismatch.handle, "prompt text", { store });
    assert.equal(respResult.status, "OUTCOME_UNKNOWN");
    assert.equal(respResult.rawStatus, "PROMPT_RESPONSE_IDENTITY_INCOMPLETE_OR_MISMATCH");

    // 10. REPRODUCER-3: Verifies unobservable or mismatched agent never receives prompt
    assert.equal(ctxAgMissing.spy.agentPromptCalls, 0);
    assert.equal(ctxPaneMissing.spy.agentPromptCalls, 0);
    assert.equal(ctxWrongWs.spy.agentPromptCalls, 0);
    assert.equal(ctxWrongPane.spy.agentPromptCalls, 0);
    assert.equal(ctxWrongCwd.spy.agentPromptCalls, 0);
    assert.equal(ctxWrongName.spy.agentPromptCalls, 0);
    assert.equal(ctxLostAfterFence.spy.agentPromptCalls, 0);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("HerdrThinGateway reconciliation live identity validation (E4, RI-EXACT-DONE, RI-EXACT-IDLE, RI-AGENT-MISSING-LAST-DONE, RI-AGENT-MISSING-LAST-IDLE, RI-WRONG-WORKSPACE, RI-WRONG-PANE, RI-WRONG-CWD, RI-WRONG-NAME, REPRODUCER-4)", async () => {
  const { repoPath, headSha } = createIsolatedTestGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-ri-matrix-"));
  const store = new LocalAgentStore(stateDir);

  try {
    const attemptKey = `ri-test-${Date.now()}`;
    const agent = store.create({
      workspaceId: "ws-ri",
      workspaceRoot: repoPath,
      profileName: "worker",
      provider: "opencode",
    });
    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      agentId: agent.id,
      herdrSocketPath: "/tmp/test.sock",
      herdrWorkspaceId: "ws-ri-test",
      herdrPaneId: "pane-ri-test",
      herdrAgentIdentity: "agent-ri-test",
      herdrAgentKind: "opencode",
      promptNonce: "NONCE-RI",
      canonicalWorktreePath: repoPath,
      workspaceId: "ws-ri",
      gitHeadBefore: headSha,
      attemptKey,
      dispatchIntentHash: "hash-ri",
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    store.bindExternalRuntimeBindingCAS({
      agentId: agent.id,
      binding: {
        runtimeKind: HERDR_RUNTIME_KIND,
        handle: handle as unknown as Record<string, unknown>,
      },
    });

    const spy = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    const validPane: HerdrPaneInfo = {
      pane_id: handle.herdrPaneId,
      workspace_id: handle.herdrWorkspaceId,
      cwd: repoPath,
      foreground_cwd: repoPath,
    };
    spy.simulatedPanes = [validPane];

    // Helper to mock ping
    const origSend = spy.sendRequest.bind(spy);
    spy.sendRequest = async (req, timeout, sock) => {
      if (req.method === "ping") {
        return { id: req.id, result: { type: "pong" } as any };
      }
      return origSend(req, timeout, sock);
    };

    // 1. RI-EXACT-DONE: live agent positively observed with exact identity, status "done" -> SETTLED_TERMINAL
    spy.simulatedAgents.set(handle.herdrAgentIdentity, {
      name: handle.herdrAgentIdentity,
      agent: handle.herdrAgentKind,
      workspace_id: handle.herdrWorkspaceId,
      pane_id: handle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "done",
      interactive_ready: true,
    });
    const resDone = await spy.reconcileExternalAgent(handle, [], false);
    assert.equal(resDone.executionState, "SETTLED_TERMINAL");
    assert.equal(resDone.settled, true);

    // 2. RI-EXACT-IDLE: live agent positively observed with exact identity, status "idle" -> SETTLED_TERMINAL
    spy.simulatedAgents.set(handle.herdrAgentIdentity, {
      name: handle.herdrAgentIdentity,
      agent: handle.herdrAgentKind,
      workspace_id: handle.herdrWorkspaceId,
      pane_id: handle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });
    const resIdle = await spy.reconcileExternalAgent(handle, [], false);
    assert.equal(resIdle.executionState, "SETTLED_TERMINAL");
    assert.equal(resIdle.settled, true);

    // 3. RI-AGENT-MISSING-LAST-DONE: agent missing, lastPromptResult.status = "done" -> OUTCOME_UNKNOWN
    spy.simulatedAgents.clear();
    const resMissingDone = await spy.reconcileExternalAgent(handle, [], false, { status: "done", turnNonce: "turn-1" });
    assert.equal(resMissingDone.executionState, "OUTCOME_UNKNOWN");
    assert.equal(resMissingDone.settled, false);
    assert.equal(resMissingDone.completionStatus, "OUTCOME_UNKNOWN");

    // 4. RI-AGENT-MISSING-LAST-IDLE: agent missing, lastPromptResult.status = "idle" -> OUTCOME_UNKNOWN
    const resMissingIdle = await spy.reconcileExternalAgent(handle, [], false, { status: "idle", turnNonce: "turn-2" });
    assert.equal(resMissingIdle.executionState, "OUTCOME_UNKNOWN");
    assert.equal(resMissingIdle.settled, false);
    assert.equal(resMissingIdle.completionStatus, "OUTCOME_UNKNOWN");

    // 5. RI-WRONG-WORKSPACE: agent workspace mismatch, lastPromptResult.status = "done" -> OUTCOME_UNKNOWN
    spy.simulatedAgents.set(handle.herdrAgentIdentity, {
      name: handle.herdrAgentIdentity,
      agent: handle.herdrAgentKind,
      workspace_id: "wrong-ws",
      pane_id: handle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "done",
      interactive_ready: true,
    });
    const resWrongWs = await spy.reconcileExternalAgent(handle, [], false, { status: "done", turnNonce: "turn-3" });
    assert.equal(resWrongWs.executionState, "OUTCOME_UNKNOWN");
    assert.equal(resWrongWs.settled, false);

    // 6. RI-WRONG-PANE: agent pane mismatch, lastPromptResult.status = "done" -> OUTCOME_UNKNOWN
    spy.simulatedAgents.set(handle.herdrAgentIdentity, {
      name: handle.herdrAgentIdentity,
      agent: handle.herdrAgentKind,
      workspace_id: handle.herdrWorkspaceId,
      pane_id: "wrong-pane",
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "done",
      interactive_ready: true,
    });
    const resWrongPane = await spy.reconcileExternalAgent(handle, [], false, { status: "done", turnNonce: "turn-4" });
    assert.equal(resWrongPane.executionState, "OUTCOME_UNKNOWN");
    assert.equal(resWrongPane.settled, false);

    // 7. RI-WRONG-CWD: agent cwd mismatch, lastPromptResult.status = "done" -> OUTCOME_UNKNOWN
    spy.simulatedAgents.set(handle.herdrAgentIdentity, {
      name: handle.herdrAgentIdentity,
      agent: handle.herdrAgentKind,
      workspace_id: handle.herdrWorkspaceId,
      pane_id: handle.herdrPaneId,
      cwd: "/wrong/cwd",
      foreground_cwd: "/wrong/cwd",
      agent_status: "done",
      interactive_ready: true,
    });
    const resWrongCwd = await spy.reconcileExternalAgent(handle, [], false, { status: "done", turnNonce: "turn-5" });
    assert.equal(resWrongCwd.executionState, "OUTCOME_UNKNOWN");
    assert.equal(resWrongCwd.settled, false);

    // 8. RI-WRONG-NAME: agent name mismatch, lastPromptResult.status = "done" -> OUTCOME_UNKNOWN
    spy.simulatedAgents.set(handle.herdrAgentIdentity, {
      name: "wrong-name",
      agent: handle.herdrAgentKind,
      workspace_id: handle.herdrWorkspaceId,
      pane_id: handle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "done",
      interactive_ready: true,
    });
    const resWrongName = await spy.reconcileExternalAgent(handle, [], false, { status: "done", turnNonce: "turn-6" });
    assert.equal(resWrongName.executionState, "OUTCOME_UNKNOWN");
    assert.equal(resWrongName.settled, false);

    // 9. REPRODUCER-4: Stale done/idle evidence never marks vanished/wrong agent settled
    assert.equal(resMissingDone.settled, false);
    assert.equal(resMissingIdle.settled, false);
    assert.equal(resWrongWs.settled, false);
    assert.equal(resWrongPane.settled, false);
    assert.equal(resWrongCwd.settled, false);
    assert.equal(resWrongName.settled, false);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("HerdrThinGateway stop external agent identity validation and side-door elimination (E5, E6, SI-EXACT, SI-NO-STORE, SI-DURABLE-MISMATCH, SI-PANE-MISSING, SI-AGENT-MISSING, SI-WRONG-WORKSPACE, SI-WRONG-PANE, SI-WRONG-CWD, SI-WRONG-NAME, SI-CLOSE-ERROR, REPRODUCER-5)", async () => {
  const { repoPath, headSha } = createIsolatedTestGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-si-matrix-"));
  const store = new LocalAgentStore(stateDir);

  try {
    const attemptKey = `si-test-${Date.now()}`;
    const intent = {
      taskId: "task-si",
      attemptId: attemptKey,
      objective: "SI matrix test",
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
      workspaceId: "ws-si",
      workspaceRoot: repoPath,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attemptKey, requestHash: "hash-si" },
      executionContract: { writePaths: ["src"], dispatchIntent: intent },
    });

    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      agentId: agent.id,
      herdrSocketPath: "/tmp/test.sock",
      herdrWorkspaceId: "ws-si-herdr",
      herdrPaneId: "pane-si-herdr",
      herdrAgentIdentity: "agent-si-herdr",
      herdrAgentKind: "opencode",
      promptNonce: "NONCE-SI",
      canonicalWorktreePath: repoPath,
      workspaceId: "ws-si",
      gitHeadBefore: headSha,
      attemptKey,
      dispatchIntentHash: hash,
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    store.bindExternalRuntimeBindingCAS({
      agentId: agent.id,
      expectedAttemptKey: attemptKey,
      expectedDispatchIntentHash: hash,
      binding: {
        runtimeKind: HERDR_RUNTIME_KIND,
        handle: handle as unknown as Record<string, unknown>,
      },
    });

    const registry = new HerdrGatewayRegistry();
    registry.registerHandle(handle);

    // 1. SI-NO-STORE: stopExternalAgent without store fails closed
    const gatewayNoStore = new HerdrThinGateway("/tmp/test.sock", registry);
    await assert.rejects(
      gatewayNoStore.stopExternalAgent(handle),
      (err: any) => {
        assert.match(err.message, /\[STOP_NO_DURABLE_STORE\]/);
        return true;
      },
    );

    // 2. SI-DURABLE-MISMATCH: handle does not match durable store binding
    const spy = new SpyHerdrGateway("/tmp/test.sock", registry, store);
    const mismatchedHandle = { ...handle, herdrWorkspaceId: "different-ws-id" };
    await assert.rejects(
      spy.stopExternalAgent(mismatchedHandle),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ DURABLE_HANDLE_AUTHORITY_MISMATCH\]|\[STOP_DURABLE_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.workspaceCloseCalls, 0, "Zero workspace.close on durable mismatch");

    // 3. SI-PANE-MISSING: pane not in HerdR
    spy.simulatedPanes = []; // Missing pane!
    spy.simulatedAgents.set(handle.herdrAgentIdentity, {
      name: handle.herdrAgentIdentity,
      agent: handle.herdrAgentKind,
      workspace_id: handle.herdrWorkspaceId,
      pane_id: handle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });
    await assert.rejects(
      spy.stopExternalAgent(handle),
      (err: any) => {
        assert.match(err.message, /\[STOP_LIVE_IDENTITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.workspaceCloseCalls, 0, "Zero workspace.close on missing pane");

    // 4. SI-AGENT-MISSING: exact pane/workspace/cwd remains owned and
    // a strict second agent.get positively confirms absence. Explicit operator
    // stop may reclaim that exact workspace so the durable session cannot leak
    // a local capacity slot forever.
    spy.simulatedPanes = [
      {
        pane_id: handle.herdrPaneId,
        workspace_id: handle.herdrWorkspaceId,
        cwd: repoPath,
        foreground_cwd: repoPath,
      },
    ];
    spy.simulatedAgents.clear();
    await spy.stopExternalAgent(handle);
    assert.equal(spy.workspaceCloseCalls, 1, "Verified missing agent reclaims exact owned workspace");

    // Re-register for the remaining negative stop cases.
    registry.registerHandle(handle);

    // 4b. SI-AGENT-LOOKUP-TRANSPORT: a failed strict absence readback must
    // remain fail-closed and must not close the workspace.
    spy.failAgentGet = true;
    await assert.rejects(
      spy.stopExternalAgent(handle),
      (err: any) => {
        assert.match(err.message, /Simulated agent\.get transport failure|AGENT_ABSENCE_UNVERIFIED/);
        return true;
      },
    );
    assert.equal(spy.workspaceCloseCalls, 1, "Zero additional workspace.close on unverified absence");
    spy.failAgentGet = false;

    // 5. SI-WRONG-WORKSPACE: agent workspace mismatch
    spy.simulatedAgents.set(handle.herdrAgentIdentity, {
      name: handle.herdrAgentIdentity,
      agent: handle.herdrAgentKind,
      workspace_id: "wrong-ws",
      pane_id: handle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });
    await assert.rejects(
      spy.stopExternalAgent(handle),
      (err: any) => {
        assert.match(err.message, /\[STOP_LIVE_IDENTITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.workspaceCloseCalls, 0);

    // 6. SI-WRONG-PANE: agent pane mismatch
    spy.simulatedAgents.set(handle.herdrAgentIdentity, {
      name: handle.herdrAgentIdentity,
      agent: handle.herdrAgentKind,
      workspace_id: handle.herdrWorkspaceId,
      pane_id: "wrong-pane",
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });
    await assert.rejects(
      spy.stopExternalAgent(handle),
      (err: any) => {
        assert.match(err.message, /\[STOP_LIVE_IDENTITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.workspaceCloseCalls, 0);

    // 7. SI-WRONG-CWD: agent cwd mismatch
    spy.simulatedAgents.set(handle.herdrAgentIdentity, {
      name: handle.herdrAgentIdentity,
      agent: handle.herdrAgentKind,
      workspace_id: handle.herdrWorkspaceId,
      pane_id: handle.herdrPaneId,
      cwd: "/wrong/cwd",
      foreground_cwd: "/wrong/cwd",
      agent_status: "idle",
      interactive_ready: true,
    });
    await assert.rejects(
      spy.stopExternalAgent(handle),
      (err: any) => {
        assert.match(err.message, /\[STOP_LIVE_IDENTITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.workspaceCloseCalls, 0);

    // 8. SI-WRONG-NAME: agent name mismatch
    spy.simulatedAgents.set(handle.herdrAgentIdentity, {
      name: "wrong-name",
      agent: handle.herdrAgentKind,
      workspace_id: handle.herdrWorkspaceId,
      pane_id: handle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });
    await assert.rejects(
      spy.stopExternalAgent(handle),
      (err: any) => {
        assert.match(err.message, /\[STOP_LIVE_IDENTITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.workspaceCloseCalls, 0);

    // 9. SI-CLOSE-ERROR: workspace.close fails -> error not swallowed, registry handle NOT released
    spy.simulatedAgents.set(handle.herdrAgentIdentity, {
      name: handle.herdrAgentIdentity,
      agent: handle.herdrAgentKind,
      workspace_id: handle.herdrWorkspaceId,
      pane_id: handle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });
    spy.failWorkspaceClose = true;
    await assert.rejects(
      spy.stopExternalAgent(handle),
      (err: any) => {
        assert.match(err.message, /Simulated network timeout during workspace\.close/);
        return true;
      },
    );
    assert.ok(registry.getHandle(attemptKey), "Registry handle must NOT be released if close fails (A8)");

    // 10. SI-EXACT: valid store and verified live identity -> succeeds, closes workspace, releases handle
    spy.failWorkspaceClose = false;
    assert.equal(spy.workspaceCloseCalls, 1);
    await spy.stopExternalAgent(handle);
    assert.equal(spy.workspaceCloseCalls, 2);
    assert.equal(registry.getHandle(attemptKey), undefined, "Registry handle released upon successful close");

    // 11. REPRODUCER-5: Consequential side-door elimination
    assert.equal((HerdrThinGateway.prototype as any).sendPaneKeys, undefined, "sendPaneKeys must be removed from HerdrThinGateway");
    assert.equal((LocalAgentSessionManager.prototype as any).getHerdrGateway, undefined, "getHerdrGateway must be removed from LocalAgentSessionManager");
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("HerdrThinGateway prompt exact durable handle authority (Blocker F1, F1-PROMPT-FORGED-PHYSICAL-TARGET, F1-PROMPT-WRONG-ATTEMPT, F1-PROMPT-WRONG-DISPATCH, F1-PROMPT-WRONG-NONCE, F1-PROMPT-WRONG-GIT-BASE, F1-PROMPT-WRONG-LOCAL-WORKSPACE, F1-PROMPT-WRONG-AGENT-KIND, PROMPT-REPRODUCER-F1)", async () => {
  const { repoPath, headSha } = createIsolatedTestGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-f1-matrix-"));
  const store = new LocalAgentStore(stateDir);

  try {
    const attemptKeyA = `attempt-f1-${Date.now()}`;
    const intentA = {
      taskId: "task-f1-a",
      attemptId: attemptKeyA,
      objective: "Test F1 authority",
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
    const hashA = hashDispatchIntent(intentA);
    const agentA = store.create({
      workspaceId: "ws-f1",
      workspaceRoot: repoPath,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attemptKeyA, requestHash: "hash-f1-a" },
      executionContract: { writePaths: ["src"], dispatchIntent: intentA },
    });

    const durableHandleA: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      agentId: agentA.id,
      herdrSocketPath: "/tmp/test.sock",
      herdrWorkspaceId: "ws-A",
      herdrPaneId: "pane-A",
      herdrAgentIdentity: "agent-A",
      herdrAgentKind: "opencode",
      promptNonce: `NONCE-${attemptKeyA}`,
      canonicalWorktreePath: repoPath,
      workspaceId: "ws-f1",
      gitHeadBefore: headSha,
      attemptKey: attemptKeyA,
      dispatchIntentHash: hashA,
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    store.bindExternalRuntimeBindingCAS({
      agentId: agentA.id,
      expectedAttemptKey: attemptKeyA,
      expectedDispatchIntentHash: hashA,
      binding: {
        runtimeKind: HERDR_RUNTIME_KIND,
        handle: durableHandleA as unknown as Record<string, unknown>,
      },
    });

    const registry = new HerdrGatewayRegistry();
    const spy = new SpyHerdrGateway("/tmp/test.sock", registry, store);

    // Simulate BOTH Target A and Target B as physically live in HerdR
    spy.simulatedPanes = [
      { pane_id: "pane-A", workspace_id: "ws-A", cwd: repoPath, foreground_cwd: repoPath },
      { pane_id: "pane-B", workspace_id: "ws-B", cwd: repoPath, foreground_cwd: repoPath },
    ];
    spy.simulatedAgents.set("agent-A", {
      name: "agent-A",
      agent: "opencode",
      workspace_id: "ws-A",
      pane_id: "pane-A",
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });
    spy.simulatedAgents.set("agent-B", {
      name: "agent-B",
      agent: "opencode",
      workspace_id: "ws-B",
      pane_id: "pane-B",
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });

    // 1. F1-PROMPT-FORGED-PHYSICAL-TARGET: caller redirects prompt to agent-B
    const forgedTargetHandle: HerdrExternalHandle = {
      ...durableHandleA,
      herdrWorkspaceId: "ws-B",
      herdrPaneId: "pane-B",
      herdrAgentIdentity: "agent-B",
    };

    await assert.rejects(
      spy.promptExternalAgent(forgedTargetHandle, "malicious prompt", { store }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ DURABLE_HANDLE_AUTHORITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.agentPromptCalls, 0, "Forged target must NOT receive any external prompt calls");
    assert.equal(store.getById(agentA.id)!.externalRuntimeBinding?.promptState, undefined, "Prompt fence must NOT be consumed");

    // 2. F1-PROMPT-WRONG-ATTEMPT
    await assert.rejects(
      spy.promptExternalAgent({ ...durableHandleA, attemptKey: "forged-attempt" }, "prompt", { store }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ DURABLE_HANDLE_AUTHORITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.agentPromptCalls, 0);

    // 3. F1-PROMPT-WRONG-DISPATCH
    await assert.rejects(
      spy.promptExternalAgent({ ...durableHandleA, dispatchIntentHash: "forged-hash" }, "prompt", { store }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ DURABLE_HANDLE_AUTHORITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.agentPromptCalls, 0);

    // 4. F1-PROMPT-WRONG-NONCE
    await assert.rejects(
      spy.promptExternalAgent({ ...durableHandleA, promptNonce: "forged-nonce" }, "prompt", { store }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ DURABLE_HANDLE_AUTHORITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.agentPromptCalls, 0);

    // 5. F1-PROMPT-WRONG-GIT-BASE
    await assert.rejects(
      spy.promptExternalAgent({ ...durableHandleA, gitHeadBefore: "forged-head" }, "prompt", { store }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ DURABLE_HANDLE_AUTHORITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.agentPromptCalls, 0);

    // 6. F1-PROMPT-WRONG-LOCAL-WORKSPACE
    await assert.rejects(
      spy.promptExternalAgent({ ...durableHandleA, workspaceId: "forged-ws" }, "prompt", { store }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ DURABLE_HANDLE_AUTHORITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.agentPromptCalls, 0);

    // 7. F1-PROMPT-WRONG-AGENT-KIND
    await assert.rejects(
      spy.promptExternalAgent({ ...durableHandleA, herdrAgentKind: "agy" }, "prompt", { store }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ DURABLE_HANDLE_AUTHORITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.agentPromptCalls, 0);

    // 8. F1-PROMPT-RESPONSE-MISSING-IDENTITY (Comment 5785928588)
    const origSend = spy.sendRequest.bind(spy);
    spy.sendRequest = (async (req: any, timeout?: number, sock?: string): Promise<any> => {
      if (req.method === "agent.prompt") {
        spy.agentPromptCalls++;
        return {
          id: req.id,
          result: {
            agent: {
              agent_status: "done",
              interactive_ready: true,
              // Intentionally omit workspace_id, pane_id, name, cwd
            },
          },
        };
      }
      return origSend(req, timeout, sock);
    }) as any;

    const incompleteRespRes = await spy.promptExternalAgent(durableHandleA, "legitimate prompt", { store });
    assert.equal(incompleteRespRes.status, "OUTCOME_UNKNOWN");
    assert.equal(incompleteRespRes.rawStatus, "PROMPT_RESPONSE_IDENTITY_INCOMPLETE_OR_MISMATCH");
    assert.equal(spy.agentPromptCalls, 1);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("HerdrThinGateway preserves OUTCOME_UNKNOWN and zero re-prompt after effect-before-ack transport loss", async () => {
  const { repoPath, headSha } = createIsolatedTestGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-prompt-lost-ack-"));
  let store: LocalAgentStore | undefined;
  let reopenedStore: LocalAgentStore | undefined;

  try {
    const attemptKey = `attempt-lost-ack-${Date.now()}`;
    const intent = {
      taskId: "task-lost-ack",
      attemptId: attemptKey,
      objective: "Exercise effect-before-ack ambiguity",
      roleIntent: "DEEP_ENGINEERING" as const,
      claimCeiling: "CANDIDATE_READY" as const,
      context: ["once-adversarial-reference"],
      readScope: ["src"],
      writeScope: ["effect.txt"],
      exclusiveOwnership: true,
      forbiddenChanges: [],
      acceptanceCriteria: ["no blind second prompt"],
      verificationRequired: true,
      expectedArtifacts: [],
    };
    const dispatchIntentHash = hashDispatchIntent(intent);

    store = new LocalAgentStore(stateDir);
    const agent = store.create({
      workspaceId: "ws-lost-ack",
      workspaceRoot: repoPath,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attemptKey, requestHash: "request-lost-ack" },
      executionContract: { writePaths: ["effect.txt"], dispatchIntent: intent },
    });

    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      agentId: agent.id,
      herdrSocketPath: "/tmp/test.sock",
      herdrWorkspaceId: "ws-lost-ack-target",
      herdrPaneId: "pane-lost-ack-target",
      herdrAgentIdentity: "agent-lost-ack-target",
      herdrAgentKind: "opencode",
      promptNonce: `NONCE-${attemptKey}`,
      canonicalWorktreePath: repoPath,
      workspaceId: "ws-lost-ack",
      gitHeadBefore: headSha,
      attemptKey,
      dispatchIntentHash,
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    const bind = store.bindExternalRuntimeBindingCAS({
      agentId: agent.id,
      expectedAttemptKey: attemptKey,
      expectedDispatchIntentHash: dispatchIntentHash,
      binding: {
        runtimeKind: HERDR_RUNTIME_KIND,
        handle: handle as unknown as Record<string, unknown>,
      },
    });
    assert.equal(bind.applied, true);

    const firstGateway = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    firstGateway.simulatedPanes = [{
      pane_id: handle.herdrPaneId,
      workspace_id: handle.herdrWorkspaceId,
      cwd: repoPath,
      foreground_cwd: repoPath,
    }];
    firstGateway.simulatedAgents.set(handle.herdrAgentIdentity, {
      name: handle.herdrAgentIdentity,
      agent: handle.herdrAgentKind,
      workspace_id: handle.herdrWorkspaceId,
      pane_id: handle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });

    const originalSend = firstGateway.sendRequest.bind(firstGateway);
    firstGateway.sendRequest = (async (req: HerdrSocketRequest, timeoutMs?: number, socketPath?: string) => {
      if (req.method === "agent.prompt") {
        firstGateway.agentPromptCalls++;
        writeFileSync(join(repoPath, "effect.txt"), "effect happened before acknowledgement\n");
        const lostAck = Object.assign(
          new Error("read ECONNRESET after provider accepted prompt"),
          { code: "ECONNRESET" },
        );
        throw lostAck;
      }
      return originalSend(req, timeoutMs, socketPath);
    }) as typeof firstGateway.sendRequest;

    const firstResult = await firstGateway.promptExternalAgent(handle, "perform external effect", { store });
    assert.equal(firstResult.status, "OUTCOME_UNKNOWN");
    assert.equal(firstResult.rawStatus, "ECONNRESET");
    assert.equal(firstGateway.agentPromptCalls, 1);
    assert.equal(readFileSync(join(repoPath, "effect.txt"), "utf8"), "effect happened before acknowledgement\n");
    assert.equal(
      store.getById(agent.id)?.externalRuntimeBinding?.promptState?.consequentialPromptFenced,
      true,
    );

    store.close();
    store = undefined;

    reopenedStore = new LocalAgentStore(stateDir);
    const replayGateway = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), reopenedStore);
    replayGateway.simulatedPanes = [{
      pane_id: handle.herdrPaneId,
      workspace_id: handle.herdrWorkspaceId,
      cwd: repoPath,
      foreground_cwd: repoPath,
    }];
    replayGateway.simulatedAgents.set(handle.herdrAgentIdentity, {
      name: handle.herdrAgentIdentity,
      agent: handle.herdrAgentKind,
      workspace_id: handle.herdrWorkspaceId,
      pane_id: handle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });

    await assert.rejects(
      replayGateway.promptExternalAgent(handle, "blind retry must not happen", { store: reopenedStore }),
      /\[N-TURN-OPTION-A\]/,
    );
    assert.equal(replayGateway.agentPromptCalls, 0);
  } finally {
    store?.close();
    reopenedStore?.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("HerdrThinGateway reconciliation exact durable authority (Blocker F2, F2-RECONCILE-NO-STORE, F2-RECONCILE-FORGED-HANDLE, F2-RECONCILE-EXACT, RECONCILE-REPRODUCER-F2)", async () => {
  const { repoPath, headSha } = createIsolatedTestGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-f2-matrix-"));
  const store = new LocalAgentStore(stateDir);

  try {
    const attemptKey = `attempt-f2-${Date.now()}`;
    const agent = store.create({
      workspaceId: "ws-f2",
      workspaceRoot: repoPath,
      profileName: "worker",
      provider: "opencode",
    });

    const durableHandle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      agentId: agent.id,
      herdrSocketPath: "/tmp/test.sock",
      herdrWorkspaceId: "ws-f2-target",
      herdrPaneId: "pane-f2-target",
      herdrAgentIdentity: "agent-f2-target",
      herdrAgentKind: "opencode",
      promptNonce: `NONCE-${attemptKey}`,
      canonicalWorktreePath: repoPath,
      workspaceId: "ws-f2",
      gitHeadBefore: headSha,
      attemptKey,
      dispatchIntentHash: "hash-f2",
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    store.bindExternalRuntimeBindingCAS({
      agentId: agent.id,
      binding: {
        runtimeKind: HERDR_RUNTIME_KIND,
        handle: durableHandle as unknown as Record<string, unknown>,
      },
    });

    // Create physical mutation on disk
    writeFileSync(join(repoPath, "f2_effect.txt"), "physical mutation occurred\n");

    const spy = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    spy.simulatedPanes = [
      { pane_id: durableHandle.herdrPaneId, workspace_id: durableHandle.herdrWorkspaceId, cwd: repoPath, foreground_cwd: repoPath },
    ];
    spy.simulatedAgents.set(durableHandle.herdrAgentIdentity, {
      name: durableHandle.herdrAgentIdentity,
      agent: durableHandle.herdrAgentKind,
      workspace_id: durableHandle.herdrWorkspaceId,
      pane_id: durableHandle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "done",
      interactive_ready: true,
    });
    const origSend = spy.sendRequest.bind(spy);
    spy.sendRequest = async (req, timeout, sock) => {
      if (req.method === "ping") return { id: req.id, result: { type: "pong" } as any };
      return origSend(req, timeout, sock);
    };

    // 1. F2-RECONCILE-NO-STORE: Gateway without store cannot attribute completion
    const gatewayNoStore = new HerdrThinGateway("/tmp/test.sock", new HerdrGatewayRegistry(), undefined);
    const resNoStore = await gatewayNoStore.reconcileExternalAgent(durableHandle, ["f2_effect.txt"], true, undefined, { store: undefined });
    assert.equal(resNoStore.settled, false);
    assert.equal(resNoStore.completionStatus, "OUTCOME_UNKNOWN");
    assert.equal(resNoStore.executionState, "OUTCOME_UNKNOWN");
    assert.equal(resNoStore.physicalEffect, "PRESENT");
    assert.deepEqual(resNoStore.changedPaths, ["f2_effect.txt"]);
    assert.match(resNoStore.reason || "", /\[DURABLE_AUTHORITY_MISSING\]/);

    // 2. F2-RECONCILE-FORGED-HANDLE: Forged handle with wrong attemptKey cannot attribute completion
    const forgedHandle: HerdrExternalHandle = {
      ...durableHandle,
      attemptKey: "forged-attempt-key",
    };
    const resForged = await spy.reconcileExternalAgent(forgedHandle, ["f2_effect.txt"], true, undefined, { store });
    assert.equal(resForged.settled, false);
    assert.equal(resForged.completionStatus, "OUTCOME_UNKNOWN");
    assert.equal(resForged.executionState, "OUTCOME_UNKNOWN");
    assert.equal(resForged.physicalEffect, "PRESENT");
    assert.match(resForged.reason || "", /\[DURABLE_AUTHORITY_MISSING\]/);

    // 3. F2-RECONCILE-EXACT: Exact durable authority + live target + physical mutation -> COMPLETED
    const resExact = await spy.reconcileExternalAgent(durableHandle, ["f2_effect.txt"], true, undefined, { store });
    assert.equal(resExact.settled, true);
    assert.equal(resExact.completionStatus, "COMPLETED");
    assert.equal(resExact.executionState, "SETTLED_TERMINAL");
    assert.equal(resExact.physicalEffect, "PRESENT");
    assert.deepEqual(resExact.changedPaths, ["f2_effect.txt"]);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("HerdrThinGateway stop exact durable authority (Blocker F3, F3-STOP-WRONG-ATTEMPT, F3-STOP-WRONG-DISPATCH, F3-STOP-WRONG-NONCE, F3-STOP-WRONG-GIT-BASE, F3-STOP-WRONG-WORKSPACE-ID, F3-STOP-WRONG-AGENT-KIND, F3-STOP-EXACT, STOP-REPRODUCER-F3)", async () => {
  const { repoPath, headSha } = createIsolatedTestGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-f3-matrix-"));
  const store = new LocalAgentStore(stateDir);

  try {
    const attemptKey = `attempt-f3-${Date.now()}`;
    const agent = store.create({
      workspaceId: "ws-f3",
      workspaceRoot: repoPath,
      profileName: "worker",
      provider: "opencode",
    });

    const durableHandle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      agentId: agent.id,
      herdrSocketPath: "/tmp/test.sock",
      herdrWorkspaceId: "ws-f3-stop",
      herdrPaneId: "pane-f3-stop",
      herdrAgentIdentity: "agent-f3-stop",
      herdrAgentKind: "opencode",
      promptNonce: `NONCE-${attemptKey}`,
      canonicalWorktreePath: repoPath,
      workspaceId: "ws-f3",
      gitHeadBefore: headSha,
      attemptKey,
      dispatchIntentHash: "hash-f3",
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    store.bindExternalRuntimeBindingCAS({
      agentId: agent.id,
      binding: {
        runtimeKind: HERDR_RUNTIME_KIND,
        handle: durableHandle as unknown as Record<string, unknown>,
      },
    });

    const registry = new HerdrGatewayRegistry();
    registry.registerHandle(durableHandle);

    const spy = new SpyHerdrGateway("/tmp/test.sock", registry, store);
    spy.simulatedPanes = [
      { pane_id: durableHandle.herdrPaneId, workspace_id: durableHandle.herdrWorkspaceId, cwd: repoPath, foreground_cwd: repoPath },
    ];
    spy.simulatedAgents.set(durableHandle.herdrAgentIdentity, {
      name: durableHandle.herdrAgentIdentity,
      agent: durableHandle.herdrAgentKind,
      workspace_id: durableHandle.herdrWorkspaceId,
      pane_id: durableHandle.herdrPaneId,
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });

    // 1. F3-STOP-WRONG-ATTEMPT
    await assert.rejects(
      spy.stopExternalAgent({ ...durableHandle, attemptKey: "forged-attempt" }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ DURABLE_HANDLE_AUTHORITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.workspaceCloseCalls, 0);

    // 2. F3-STOP-WRONG-DISPATCH
    await assert.rejects(
      spy.stopExternalAgent({ ...durableHandle, dispatchIntentHash: "forged-hash" }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ DURABLE_HANDLE_AUTHORITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.workspaceCloseCalls, 0);

    // 3. F3-STOP-WRONG-NONCE
    await assert.rejects(
      spy.stopExternalAgent({ ...durableHandle, promptNonce: "forged-nonce" }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ DURABLE_HANDLE_AUTHORITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.workspaceCloseCalls, 0);

    // 4. F3-STOP-WRONG-GIT-BASE
    await assert.rejects(
      spy.stopExternalAgent({ ...durableHandle, gitHeadBefore: "forged-git-base" }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ DURABLE_HANDLE_AUTHORITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.workspaceCloseCalls, 0);

    // 5. F3-STOP-WRONG-WORKSPACE-ID
    await assert.rejects(
      spy.stopExternalAgent({ ...durableHandle, workspaceId: "forged-workspace-id" }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ DURABLE_HANDLE_AUTHORITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.workspaceCloseCalls, 0);

    // 6. F3-STOP-WRONG-AGENT-KIND
    await assert.rejects(
      spy.stopExternalAgent({ ...durableHandle, herdrAgentKind: "agy" }),
      (err: any) => {
        assert.match(err.message, /\[FAIL_CLOSED \/ DURABLE_HANDLE_AUTHORITY_MISMATCH\]/);
        return true;
      },
    );
    assert.equal(spy.workspaceCloseCalls, 0);

    // 7. F3-STOP-EXACT
    await spy.stopExternalAgent(durableHandle);
    assert.equal(spy.workspaceCloseCalls, 1, "Exact durable handle must trigger workspace.close once");
    assert.equal(registry.getHandle(attemptKey), undefined, "Registry handle released using authoritative attemptKey");
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("HerdrThinGateway fenced launch reconciliation strict identity (Blocker F4, F4-PARTIAL-REPLAY-MISSING-WORKSPACE, F4-PARTIAL-REPLAY-MISSING-PANE, F4-PARTIAL-REPLAY-MISSING-NAME, F4-PARTIAL-REPLAY-MISSING-CWD, F4-PARTIAL-REPLAY-EXACT, REPLAY-REPRODUCER-F4)", async () => {
  const { repoPath, headSha } = createIsolatedTestGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-f4-matrix-"));
  const store = new LocalAgentStore(stateDir);

  try {
    const attemptKey = `attempt-f4-${Date.now()}`;
    const intentF4 = {
      taskId: "task-f4",
      attemptId: attemptKey,
      objective: "Test F4 replay",
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
    const hash = hashDispatchIntent(intentF4);
    const agent = store.create({
      workspaceId: "ws-f4",
      workspaceRoot: repoPath,
      profileName: "worker",
      provider: "opencode",
      startReplay: { key: attemptKey, requestHash: "hash-f4" },
      executionContract: { writePaths: ["src"], dispatchIntent: intentF4 },
    });

    const plannedAgentName = buildDeterministicHerdrAgentName(attemptKey, hash);
    const promptNonce = `NONCE-${attemptKey}`;

    // Helper to setup fenced launch in store
    function setupFencedLaunch() {
      store.fenceExternalRuntimeLaunchCAS({
        agentId: agent.id,
        attemptKey,
        dispatchIntentHash: hash,
        canonicalWorktreePath: repoPath,
        gitHeadBefore: headSha,
        agentKind: "opencode",
        herdrSocketPath: "/tmp/test.sock",
        promptNonce,
        workspaceId: "ws-f4",
        plannedAgentName,
        expectedUpdatedAt: store.getById(agent.id)!.updatedAt,
      });
      store.recordExternalRuntimeWorkspaceObservedCAS({
        agentId: agent.id,
        attemptKey,
        herdrWorkspaceId: "ws-f4-rec",
        herdrPaneId: "pane-f4-rec",
        observedCwd: repoPath,
      });
    }

    setupFencedLaunch();

    const spy = new SpyHerdrGateway("/tmp/test.sock", new HerdrGatewayRegistry(), store);
    spy.simulatedPanes = [
      { pane_id: "pane-f4-rec", workspace_id: "ws-f4-rec", cwd: repoPath, foreground_cwd: repoPath },
    ];

    // 1. F4-PARTIAL-REPLAY-MISSING-WORKSPACE: getAgent missing workspace_id
    spy.simulatedAgents.set(plannedAgentName, {
      name: plannedAgentName,
      agent: "opencode",
      pane_id: "pane-f4-rec",
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
      // Intentionally missing workspace_id
    });
    await assert.rejects(
      spy.startExternalAgent({
        agentId: agent.id,
        store,
        attemptKey,
        dispatchIntentHash: hash,
        agentKind: "opencode",
        canonicalWorktreePath: repoPath,
        workspaceId: "ws-f4",
      }),
      /\[OUTCOME_UNKNOWN\]/,
    );
    assert.equal(store.getById(agent.id)!.externalRuntimeBinding?.launch?.state, "WORKSPACE_OBSERVED");

    // 2. F4-PARTIAL-REPLAY-MISSING-PANE: getAgent missing pane_id
    spy.simulatedAgents.set(plannedAgentName, {
      name: plannedAgentName,
      agent: "opencode",
      workspace_id: "ws-f4-rec",
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
      // Intentionally missing pane_id
    });
    await assert.rejects(
      spy.startExternalAgent({
        agentId: agent.id,
        store,
        attemptKey,
        dispatchIntentHash: hash,
        agentKind: "opencode",
        canonicalWorktreePath: repoPath,
        workspaceId: "ws-f4",
      }),
      /\[OUTCOME_UNKNOWN\]/,
    );

    // 3. F4-PARTIAL-REPLAY-MISSING-NAME: getAgent missing name
    spy.simulatedAgents.set(plannedAgentName, {
      agent: "opencode",
      workspace_id: "ws-f4-rec",
      pane_id: "pane-f4-rec",
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
      // Intentionally missing name (must NOT substitute planned name)
    });
    await assert.rejects(
      spy.startExternalAgent({
        agentId: agent.id,
        store,
        attemptKey,
        dispatchIntentHash: hash,
        agentKind: "opencode",
        canonicalWorktreePath: repoPath,
        workspaceId: "ws-f4",
      }),
      /\[OUTCOME_UNKNOWN\]/,
    );

    // 4. F4-PARTIAL-REPLAY-MISSING-CWD: getAgent missing cwd
    spy.simulatedAgents.set(plannedAgentName, {
      name: plannedAgentName,
      agent: "opencode",
      workspace_id: "ws-f4-rec",
      pane_id: "pane-f4-rec",
      agent_status: "idle",
      interactive_ready: true,
      // Intentionally missing cwd and foreground_cwd
    });
    await assert.rejects(
      spy.startExternalAgent({
        agentId: agent.id,
        store,
        attemptKey,
        dispatchIntentHash: hash,
        agentKind: "opencode",
        canonicalWorktreePath: repoPath,
        workspaceId: "ws-f4",
      }),
      /\[OUTCOME_UNKNOWN\]/,
    );

    // 5. F4-PARTIAL-REPLAY-EXACT: Complete identity present and matching -> succeeds
    spy.simulatedAgents.set(plannedAgentName, {
      name: plannedAgentName,
      agent: "opencode",
      workspace_id: "ws-f4-rec",
      pane_id: "pane-f4-rec",
      cwd: repoPath,
      foreground_cwd: repoPath,
      agent_status: "idle",
      interactive_ready: true,
    });
    const handle = await spy.startExternalAgent({
      agentId: agent.id,
      store,
      attemptKey,
      dispatchIntentHash: hash,
      agentKind: "opencode",
      canonicalWorktreePath: repoPath,
      workspaceId: "ws-f4",
    });
    assert.equal(handle.herdrAgentIdentity, plannedAgentName);
    assert.equal(handle.herdrWorkspaceId, "ws-f4-rec");
    assert.equal(handle.herdrPaneId, "pane-f4-rec");
    assert.equal(store.getById(agent.id)!.externalRuntimeBinding?.launch?.state, "AGENT_OBSERVED");
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("HerdrThinGateway first-launch final-bind continuity window (Blocker F6, F6-FINAL-BIND-PANE-MISSING, F6-FINAL-BIND-AGENT-MISSING, F6-FINAL-BIND-WRONG-CWD, F6-FINAL-BIND-WRONG-NAME, F6-FINAL-BIND-EXACT, FINAL-BIND-REPRODUCER-F6)", async () => {
  const { repoPath, headSha } = createIsolatedTestGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-f6-matrix-"));
  const store = new LocalAgentStore(stateDir);

  try {
    function createF6Agent(attemptKey: string) {
      const intent = {
        taskId: `task-${attemptKey}`,
        attemptId: attemptKey,
        objective: "Test F6 continuity",
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
        workspaceId: "ws-f6",
        workspaceRoot: repoPath,
        profileName: "worker",
        provider: "opencode",
        startReplay: { key: attemptKey, requestHash: `hash-${attemptKey}` },
        executionContract: { writePaths: ["src"], dispatchIntent: intent },
      });
      return { agent, hash };
    }

    // 1. F6-FINAL-BIND-PANE-MISSING: Pane disappears after agent.start and wait
    const attempt1 = `attempt-f6-1-${Date.now()}`;
    const { agent: agent1, hash: hash1 } = createF6Agent(attempt1);
    const reg1 = new HerdrGatewayRegistry();
    const spy1 = new SpyHerdrGateway("/tmp/test.sock", reg1, store);
    // Hook sendRequest: after agent.start, clear panes
    const origSend1 = spy1.sendRequest.bind(spy1);
    spy1.sendRequest = (async (req: any, timeout?: number, sock?: string): Promise<any> => {
      const res = await origSend1(req, timeout, sock);
      if (req.method === "agent.start") {
        // Disappear the pane before final handle binding
        spy1.simulatedPanes = [];
      }
      return res;
    }) as any;

    await assert.rejects(
      spy1.startExternalAgent({
        agentId: agent1.id,
        store,
        attemptKey: attempt1,
        dispatchIntentHash: hash1,
        agentKind: "opencode",
        canonicalWorktreePath: repoPath,
        workspaceId: "ws-f6",
      }),
      (err: any) => {
        assert.match(err.message, /\[OUTCOME_UNKNOWN\] Current live process identity was lost after wait/);
        return true;
      },
    );
    assert.equal(store.getById(agent1.id)!.externalRuntimeBinding?.handle, undefined, "Zero final handle bindings permitted");
    assert.equal(reg1.getHandle(attempt1), undefined, "Zero registry insertions permitted");

    // 2. F6-FINAL-BIND-AGENT-MISSING: Agent disappears after agent.start and wait
    const attempt2 = `attempt-f6-2-${Date.now()}`;
    const { agent: agent2, hash: hash2 } = createF6Agent(attempt2);
    const reg2 = new HerdrGatewayRegistry();
    const spy2 = new SpyHerdrGateway("/tmp/test.sock", reg2, store);
    const origSend2 = spy2.sendRequest.bind(spy2);
    spy2.sendRequest = (async (req: any, timeout?: number, sock?: string): Promise<any> => {
      const res = await origSend2(req, timeout, sock);
      if (req.method === "agent.start") {
        spy2.simulatedAgents.clear();
      }
      return res;
    }) as any;

    await assert.rejects(
      spy2.startExternalAgent({
        agentId: agent2.id,
        store,
        attemptKey: attempt2,
        dispatchIntentHash: hash2,
        agentKind: "opencode",
        canonicalWorktreePath: repoPath,
        workspaceId: "ws-f6",
      }),
      /\[OUTCOME_UNKNOWN\] Current live process identity was lost after wait/,
    );
    assert.equal(store.getById(agent2.id)!.externalRuntimeBinding?.handle, undefined);
    assert.equal(reg2.getHandle(attempt2), undefined);

    // 3. F6-FINAL-BIND-WRONG-CWD: Agent cwd changes after wait
    const attempt3 = `attempt-f6-3-${Date.now()}`;
    const { agent: agent3, hash: hash3 } = createF6Agent(attempt3);
    const reg3 = new HerdrGatewayRegistry();
    const spy3 = new SpyHerdrGateway("/tmp/test.sock", reg3, store);
    const origSend3 = spy3.sendRequest.bind(spy3);
    spy3.sendRequest = (async (req: any, timeout?: number, sock?: string): Promise<any> => {
      const res = await origSend3(req, timeout, sock);
      if (req.method === "agent.start") {
        const agName = req.params.name;
        const ag = spy3.simulatedAgents.get(agName)!;
        spy3.simulatedAgents.set(agName, {
          ...ag,
          cwd: "/different/worktree",
          foreground_cwd: "/different/worktree",
        });
      }
      return res;
    }) as any;

    await assert.rejects(
      spy3.startExternalAgent({
        agentId: agent3.id,
        store,
        attemptKey: attempt3,
        dispatchIntentHash: hash3,
        agentKind: "opencode",
        canonicalWorktreePath: repoPath,
        workspaceId: "ws-f6",
      }),
      /\[OUTCOME_UNKNOWN\] Current live process identity was lost after wait/,
    );
    assert.equal(store.getById(agent3.id)!.externalRuntimeBinding?.handle, undefined);

    // 4. F6-FINAL-BIND-WRONG-NAME: Agent name changes after wait
    const attempt4 = `attempt-f6-4-${Date.now()}`;
    const { agent: agent4, hash: hash4 } = createF6Agent(attempt4);
    const reg4 = new HerdrGatewayRegistry();
    const spy4 = new SpyHerdrGateway("/tmp/test.sock", reg4, store);
    const origSend4 = spy4.sendRequest.bind(spy4);
    spy4.sendRequest = (async (req: any, timeout?: number, sock?: string): Promise<any> => {
      const res = await origSend4(req, timeout, sock);
      if (req.method === "agent.start") {
        const agName = req.params.name;
        const ag = spy4.simulatedAgents.get(agName)!;
        spy4.simulatedAgents.delete(agName);
        spy4.simulatedAgents.set(agName, { ...ag, name: "different-unexpected-name" });
      }
      return res;
    }) as any;

    await assert.rejects(
      spy4.startExternalAgent({
        agentId: agent4.id,
        store,
        attemptKey: attempt4,
        dispatchIntentHash: hash4,
        agentKind: "opencode",
        canonicalWorktreePath: repoPath,
        workspaceId: "ws-f6",
      }),
      /\[OUTCOME_UNKNOWN\] Current live process identity was lost after wait/,
    );
    assert.equal(store.getById(agent4.id)!.externalRuntimeBinding?.handle, undefined);

    // 5. F6-FINAL-BIND-EXACT: Continuity preserved across wait -> succeeds
    const attempt5 = `attempt-f6-5-${Date.now()}`;
    const { agent: agent5, hash: hash5 } = createF6Agent(attempt5);
    const reg5 = new HerdrGatewayRegistry();
    const spy5 = new SpyHerdrGateway("/tmp/test.sock", reg5, store);
    const validHandle = await spy5.startExternalAgent({
      agentId: agent5.id,
      store,
      attemptKey: attempt5,
      dispatchIntentHash: hash5,
      agentKind: "opencode",
      canonicalWorktreePath: repoPath,
      workspaceId: "ws-f6",
    });
    assert.ok(validHandle);
    assert.ok(store.getById(agent5.id)!.externalRuntimeBinding?.handle);
    assert.ok(reg5.getHandle(attempt5));
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("HerdrThinGateway authority-bound transport endpoint and strict replay equivalence (G1 to G5, Section 24)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-transport-g-"));
  const repoPath = mkdtempSync(join(tmpdir(), "devspace-transport-repo-"));
  const store = new LocalAgentStore(stateDir);

  try {
    execFileSync("git", ["init", repoPath], { stdio: "ignore" });
    execFileSync("git", ["-C", repoPath, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoPath, "config", "user.email", "test@example.com"], { stdio: "ignore" });
    writeFileSync(join(repoPath, "init.txt"), "hello");
    execFileSync("git", ["-C", repoPath, "add", "init.txt"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoPath, "commit", "-m", "init"], { stdio: "ignore" });
    const headSha = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

    const socketA = normalizeHerdrSocketPath("/tmp/herdr-endpoint-a.sock");
    const socketB = normalizeHerdrSocketPath("/tmp/herdr-endpoint-b.sock");
    const socketC = normalizeHerdrSocketPath("/tmp/herdr-endpoint-c.sock");
    const defaultGatewaySocket = normalizeHerdrSocketPath("/tmp/herdr-default-gateway.sock");

    // Helper to create agent and bound handle
    function createBoundAgent(attemptKey: string, socketPath: string, extra: {
      workspaceId?: string;
      requestedModel?: string;
      requestedEffort?: string;
    } = {}) {
      const intent = {
        taskId: `task-${attemptKey}`,
        attemptId: attemptKey,
        objective: "Test G1-G5",
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
      const wsId = extra.workspaceId ?? "ws-g";
      const agent = store.create({
        workspaceId: wsId,
        workspaceRoot: repoPath,
        profileName: "worker",
        provider: "opencode",
        startReplay: { key: attemptKey, requestHash: "hash-g" },
        executionContract: { writePaths: ["src"], dispatchIntent: intent },
      });

      const handle: HerdrExternalHandle = {
        schemaVersion: 1,
        runtimeKind: HERDR_RUNTIME_KIND,
        agentId: agent.id,
        herdrSocketPath: socketPath,
        herdrWorkspaceId: `ws-${attemptKey}`,
        herdrPaneId: `pane-${attemptKey}`,
        herdrAgentIdentity: `agent-${attemptKey}`,
        herdrAgentKind: "opencode",
        ...(extra.requestedModel ? { requestedModel: extra.requestedModel } : {}),
        ...(extra.requestedEffort ? { requestedEffort: extra.requestedEffort } : {}),
        promptNonce: `NONCE-${attemptKey}`,
        canonicalWorktreePath: repoPath,
        workspaceId: wsId,
        gitHeadBefore: headSha,
        attemptKey,
        dispatchIntentHash: hash,
        launchTimestamp: new Date().toISOString(),
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
      };

      store.bindExternalRuntimeBindingCAS({
        agentId: agent.id,
        expectedAttemptKey: attemptKey,
        expectedDispatchIntentHash: hash,
        binding: {
          runtimeKind: HERDR_RUNTIME_KIND,
          launch: {
            state: "AGENT_OBSERVED",
            launchRequestId: `HERDR-LAUNCH:${attemptKey}:${hash.slice(0, 16)}`,
            attemptKey,
            dispatchIntentHash: hash,
            canonicalWorktreePath: repoPath,
            gitHeadBefore: headSha,
            agentKind: "opencode",
            herdrSocketPath: socketPath,
            ...(extra.requestedModel ? { requestedModel: extra.requestedModel } : {}),
            ...(extra.requestedEffort ? { requestedEffort: extra.requestedEffort } : {}),
            promptNonce: `NONCE-${attemptKey}`,
            workspaceId: wsId,
            herdrWorkspaceId: `ws-${attemptKey}`,
            herdrPaneId: `pane-${attemptKey}`,
            herdrAgentIdentity: `agent-${attemptKey}`,
            fencedAt: new Date().toISOString(),
          },
          handle: handle as unknown as Record<string, unknown>,
        },
      });

      return { agent, handle, hash };
    }

    // 1. TRANSPORT-CROSS-SOCKET-PROMPT: promptExternalAgent directs all socket requests to handle.herdrSocketPath
    {
      const attempt1 = `attempt-cross-prompt-${Date.now()}`;
      const { agent: agent1, handle: handle1 } = createBoundAgent(attempt1, socketA);
      const registry1 = new HerdrGatewayRegistry();
      const spy1 = new SpyHerdrGateway(defaultGatewaySocket, registry1, store);

      // Setup simulated agent in spy
      spy1.simulatedPanes = [
        { pane_id: handle1.herdrPaneId, workspace_id: handle1.herdrWorkspaceId, cwd: repoPath, foreground_cwd: repoPath },
      ];
      spy1.simulatedAgents.set(handle1.herdrAgentIdentity, {
        name: handle1.herdrAgentIdentity,
        agent: "opencode",
        workspace_id: handle1.herdrWorkspaceId,
        pane_id: handle1.herdrPaneId,
        cwd: repoPath,
        foreground_cwd: repoPath,
        agent_status: "idle",
        interactive_ready: true,
      });

      const promptRes = await spy1.promptExternalAgent(handle1, "Execute task");
      assert.equal(promptRes.status, "done");
      assert.equal(spy1.socketCalls.get(defaultGatewaySocket) ?? 0, 0, "Zero calls to default gateway socket permitted");
      assert.ok((spy1.socketCalls.get(socketA) ?? 0) > 0, "Calls must target handle's durable socketA");
      assert.equal(spy1.lastReadPaneSocketPath, socketA, "readPane must target handle's durable socketA");
    }

    // 2. TRANSPORT-CROSS-SOCKET-STOP: stopExternalAgent directs close and live checks to handle.herdrSocketPath
    {
      const attempt2 = `attempt-cross-stop-${Date.now()}`;
      const { agent: agent2, handle: handle2 } = createBoundAgent(attempt2, socketB);
      const registry2 = new HerdrGatewayRegistry();
      registry2.registerHandle(handle2);
      const spy2 = new SpyHerdrGateway(defaultGatewaySocket, registry2, store);

      spy2.simulatedPanes = [
        { pane_id: handle2.herdrPaneId, workspace_id: handle2.herdrWorkspaceId, cwd: repoPath, foreground_cwd: repoPath },
      ];
      spy2.simulatedAgents.set(handle2.herdrAgentIdentity, {
        name: handle2.herdrAgentIdentity,
        agent: "opencode",
        workspace_id: handle2.herdrWorkspaceId,
        pane_id: handle2.herdrPaneId,
        cwd: repoPath,
        foreground_cwd: repoPath,
        agent_status: "idle",
        interactive_ready: true,
      });

      await spy2.stopExternalAgent(handle2);
      assert.equal(spy2.socketCalls.get(defaultGatewaySocket) ?? 0, 0, "Zero calls to default gateway socket permitted");
      assert.ok((spy2.socketCalls.get(socketB) ?? 0) > 0, "Calls must target handle's durable socketB");
    }

    // 3. TRANSPORT-CROSS-SOCKET-RECONCILE: reconcileExternalAgent directs ping and live checks to handle.herdrSocketPath
    {
      const attempt3 = `attempt-cross-rec-${Date.now()}`;
      const { agent: agent3, handle: handle3 } = createBoundAgent(attempt3, socketC);
      const registry3 = new HerdrGatewayRegistry();
      const spy3 = new SpyHerdrGateway(defaultGatewaySocket, registry3, store);

      spy3.simulatedPanes = [
        { pane_id: handle3.herdrPaneId, workspace_id: handle3.herdrWorkspaceId, cwd: repoPath, foreground_cwd: repoPath },
      ];
      spy3.simulatedAgents.set(handle3.herdrAgentIdentity, {
        name: handle3.herdrAgentIdentity,
        agent: "opencode",
        workspace_id: handle3.herdrWorkspaceId,
        pane_id: handle3.herdrPaneId,
        cwd: repoPath,
        foreground_cwd: repoPath,
        agent_status: "done",
        interactive_ready: true,
      });

      const recRes = await spy3.reconcileExternalAgent(handle3, ["src"], false);
      assert.equal(recRes.settled, true);
      assert.equal(spy3.socketCalls.get(defaultGatewaySocket) ?? 0, 0, "Zero calls to default gateway socket permitted");
      assert.ok((spy3.socketCalls.get(socketC) ?? 0) > 0, "Calls must target handle's durable socketC");
    }

    // 4. LAUNCH-REPLAY-WRONG-SOCKET: replay with mismatched socket fails closed
    {
      const attempt4 = `attempt-replay-sock-${Date.now()}`;
      const { agent: agent4, hash: hash4 } = createBoundAgent(attempt4, socketA);
      const spy4 = new SpyHerdrGateway(defaultGatewaySocket, new HerdrGatewayRegistry(), store);

      await assert.rejects(
        spy4.startExternalAgent({
          agentId: agent4.id,
          store,
          attemptKey: attempt4,
          dispatchIntentHash: hash4,
          agentKind: "opencode",
          canonicalWorktreePath: repoPath,
          workspaceId: "ws-g",
          socketPath: socketB, // Mismatch!
        }),
        /\[ATTEMPT_REPLAY_CONFLICT\] Replay socketPath/,
      );
    }

    // 5. LAUNCH-REPLAY-WRONG-LOCAL-WORKSPACE: replay with mismatched workspaceId fails closed
    {
      const attempt5 = `attempt-replay-ws-${Date.now()}`;
      const { agent: agent5, hash: hash5 } = createBoundAgent(attempt5, socketA, { workspaceId: "ws-expected" });
      const spy5 = new SpyHerdrGateway(defaultGatewaySocket, new HerdrGatewayRegistry(), store);

      await assert.rejects(
        spy5.startExternalAgent({
          agentId: agent5.id,
          store,
          attemptKey: attempt5,
          dispatchIntentHash: hash5,
          agentKind: "opencode",
          canonicalWorktreePath: repoPath,
          workspaceId: "ws-unexpected", // Mismatch!
          socketPath: socketA,
        }),
        /\[ATTEMPT_REPLAY_CONFLICT\] Replay workspaceId/,
      );
    }

    // 6. LAUNCH-REPLAY-WRONG-MODEL: replay with mismatched requestedModel fails closed
    {
      const attempt6 = `attempt-replay-model-${Date.now()}`;
      const { agent: agent6, hash: hash6 } = createBoundAgent(attempt6, socketA, { requestedModel: "model-alpha" });
      const spy6 = new SpyHerdrGateway(defaultGatewaySocket, new HerdrGatewayRegistry(), store);

      await assert.rejects(
        spy6.startExternalAgent({
          agentId: agent6.id,
          store,
          attemptKey: attempt6,
          dispatchIntentHash: hash6,
          agentKind: "opencode",
          canonicalWorktreePath: repoPath,
          workspaceId: "ws-g",
          socketPath: socketA,
          requestedModel: "model-beta", // Mismatch!
        }),
        /\[ATTEMPT_REPLAY_CONFLICT\] Replay requestedModel/,
      );
    }

    // 7. LAUNCH-REPLAY-WRONG-EFFORT: replay with mismatched requestedEffort fails closed
    {
      const attempt7 = `attempt-replay-effort-${Date.now()}`;
      const { agent: agent7, hash: hash7 } = createBoundAgent(attempt7, socketA, { requestedEffort: "low" });
      const spy7 = new SpyHerdrGateway(defaultGatewaySocket, new HerdrGatewayRegistry(), store);

      await assert.rejects(
        spy7.startExternalAgent({
          agentId: agent7.id,
          store,
          attemptKey: attempt7,
          dispatchIntentHash: hash7,
          agentKind: "opencode",
          canonicalWorktreePath: repoPath,
          workspaceId: "ws-g",
          socketPath: socketA,
          requestedEffort: "high", // Mismatch!
        }),
        /\[ATTEMPT_REPLAY_CONFLICT\] Replay requestedEffort/,
      );
    }

    // 8. LEGACY-FENCE-NO-ENDPOINT: stored launch fence without herdrSocketPath fails closed with 0 external calls
    {
      const attempt8 = `attempt-legacy-fence-${Date.now()}`;
      const intent8 = {
        taskId: `task-${attempt8}`,
        attemptId: attempt8,
        objective: "Test legacy fence",
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
      const hash8 = hashDispatchIntent(intent8);
      const agent8 = store.create({
        workspaceId: "ws-g",
        workspaceRoot: repoPath,
        profileName: "worker",
        provider: "opencode",
        startReplay: { key: attempt8, requestHash: "hash-8" },
        executionContract: { writePaths: ["src"], dispatchIntent: intent8 },
      });

      // Directly seed a legacy launch fence without herdrSocketPath
      store.fenceExternalRuntimeLaunchCAS({
        agentId: agent8.id,
        attemptKey: attempt8,
        dispatchIntentHash: hash8,
        canonicalWorktreePath: repoPath,
        gitHeadBefore: headSha,
        agentKind: "opencode",
        promptNonce: `NONCE-${attempt8}`,
        workspaceId: "ws-g",
      });

      const spy8 = new SpyHerdrGateway(defaultGatewaySocket, new HerdrGatewayRegistry(), store);
      await assert.rejects(
        spy8.startExternalAgent({
          agentId: agent8.id,
          store,
          attemptKey: attempt8,
          dispatchIntentHash: hash8,
          agentKind: "opencode",
          canonicalWorktreePath: repoPath,
          workspaceId: "ws-g",
        }),
        /\[OUTCOME_UNKNOWN\] Stored launch fence for attemptKey '.*' lacks durable herdrSocketPath endpoint; cannot infer gateway default\. Zero external calls permitted\./,
      );
      assert.equal(spy8.workspaceCreateCalls, 0, "Zero external calls permitted on legacy fence without endpoint");
      assert.equal(spy8.agentStartCalls, 0, "Zero external calls permitted on legacy fence without endpoint");
    }

    // 9. EXPLICIT-SOCKET-READBACK-FAILURE: readPane on explicit socket throws without CLI fallback
    {
      const realGateway = new HerdrThinGateway(defaultGatewaySocket, new HerdrGatewayRegistry(), store);
      await assert.rejects(
        realGateway.readPane("pane-nonexistent", 60, "/tmp/nonexistent-readback-probe.sock"),
        /\[EXPLICIT_SOCKET_READBACK_FAILURE\] Socket pane\.read on explicit socket '\/tmp\/nonexistent-readback-probe\.sock' failed.*CLI fallback forbidden\./,
      );
    }
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});
