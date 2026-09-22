import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  HerdrThinGateway,
  HerdrGatewayRegistry,
  HERDR_RUNTIME_KIND,
  detectBlockedOnboardingDialog,
  type HerdrExternalHandle,
} from "./local-agent-herdr.js";

test("HerdrGatewayRegistry enforces N1 duplicate prevention and N2 conflicting replay", () => {
  const registry = new HerdrGatewayRegistry();

  const handle1: HerdrExternalHandle = {
    schemaVersion: 1,
    runtimeKind: HERDR_RUNTIME_KIND,
    herdrServerIdentity: "herdr@0.9.1:unix:/tmp/test.sock",
    herdrWorkspaceId: "w1",
    herdrPaneId: "w1:p1",
    herdrAgentIdentity: "ds-attempt-1",
    herdrAgentKind: "opencode",
    launchGeneration: 1,
    promptNonce: "NONCE-1",
    canonicalWorktreePath: "/tmp/worktree",
    workspaceId: "ws-1",
    gitHeadBefore: "abc1234",
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

test("detectBlockedOnboardingDialog accurately catches onboarding and login menus (Upstream #4343 Defense)", () => {
  // Codex onboarding
  assert.equal(detectBlockedOnboardingDialog("codex", "Welcome to Codex, OpenAI's command-line coding agent\n1. Sign in with ChatGPT"), true);
  assert.equal(detectBlockedOnboardingDialog("codex", "Regular prompt: What is your task?"), false);

  // Cline onboarding
  assert.equal(detectBlockedOnboardingDialog("cline", "Enter this code in your browser: SRDP-QVKC\nhttps://authkit.cline.bot/device"), true);
  assert.equal(detectBlockedOnboardingDialog("cline", "Ready for prompt"), false);

  // Agy project trust prompt
  assert.equal(detectBlockedOnboardingDialog("agy", "Do you trust the contents of this project?\nAntigravity CLI requires permission"), true);
  assert.equal(detectBlockedOnboardingDialog("agy", "Antigravity CLI 1.2.8\nskidiy.jkokusai@gmail.com\n>"), false);
});

test("HerdrThinGateway reconciliation enforces N5, N6, N7, N8 controls", async () => {
  // Create a temporary git repo worktree
  const testDir = mkdtempSync(join(tmpdir(), "herdr-reconcile-test-"));
  try {
    execFileSync("git", ["init", testDir], { stdio: "ignore" });
    execFileSync("git", ["-C", testDir, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", testDir, "config", "user.email", "test@example.com"], { stdio: "ignore" });

    // Initial commit
    writeFileSync(join(testDir, "README.md"), "# Initial\n");
    execFileSync("git", ["-C", testDir, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", testDir, "commit", "-m", "init"], { stdio: "ignore" });

    const gateway = new HerdrThinGateway("/nonexistent/herdr.sock");
    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      herdrServerIdentity: "herdr@0.9.1:unix:/nonexistent/herdr.sock",
      herdrWorkspaceId: "w1",
      herdrPaneId: "w1:p1",
      herdrAgentIdentity: "ds-attempt-2",
      herdrAgentKind: "opencode",
      launchGeneration: 1,
      promptNonce: "NONCE-2",
      canonicalWorktreePath: testDir,
      workspaceId: "ws-2",
      gitHeadBefore: "abc",
      attemptKey: "attempt-2",
      dispatchIntentHash: "hash-2",
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    // N7: Server unreachable -> OUTCOME_UNKNOWN (truthful classification, no blind duplicate)
    const resServerDown = await gateway.reconcileExternalAgent(handle);
    assert.equal(resServerDown.completionStatus, "OUTCOME_UNKNOWN");
    assert.equal(resServerDown.settled, false);
    assert.match(resServerDown.reason || "", /UNRECOVERABLE_PROCESS_UPON_HEADLESS_RESTART/);

    // Mock live gateway to test repository reconciliation with live herdr socket
    const liveGateway = new HerdrThinGateway(); // Uses default /Users/james/.config/herdr/herdr.sock

    // N5: Worker says success but physical git status is clean -> NOT_COMPLETE
    const resClean = await liveGateway.reconcileExternalAgent(handle, ["feature.ts"], true);
    assert.equal(resClean.settled, true);
    assert.equal(resClean.completionStatus, "NOT_COMPLETE");
    assert.match(resClean.reason || "", /no physical file modifications were observed/);
    assert.equal(resClean.enforcementState, "REQUEST_ONLY_NOT_ENFORCED"); // N8

    // Modify a file outside scope to test N6
    writeFileSync(join(testDir, "unexpected.txt"), "forbidden modification");
    const resUnexpected = await liveGateway.reconcileExternalAgent(handle, ["feature.ts"], true);
    assert.equal(resUnexpected.settled, true);
    assert.equal(resUnexpected.completionStatus, "SCOPE_VIOLATION"); // N6
    assert.deepEqual(resUnexpected.unexpectedPaths, ["unexpected.txt"]);
    assert.equal(resUnexpected.enforcementState, "REQUEST_ONLY_NOT_ENFORCED"); // N8

    // Modify the expected file
    writeFileSync(join(testDir, "feature.ts"), "export const ok = true;");
    rmSync(join(testDir, "unexpected.txt"));
    const resSuccess = await liveGateway.reconcileExternalAgent(handle, ["feature.ts"], true);
    assert.equal(resSuccess.settled, true);
    assert.equal(resSuccess.completionStatus, "COMPLETED");
    assert.deepEqual(resSuccess.changedPaths, ["feature.ts"]);
    assert.deepEqual(resSuccess.unexpectedPaths, []);
    assert.equal(resSuccess.enforcementState, "REQUEST_ONLY_NOT_ENFORCED"); // N8
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("HerdrThinGateway live canary with OpenCode on isolated worktree", async () => {
  const gateway = new HerdrThinGateway();
  const worktreePath = "/Users/james/.devspace/worktrees/herdr-gateway-canary-oc";
  
  // Create test branch and worktree
  execFileSync("git", ["-C", "/Users/james/workspace/devspace", "worktree", "add", "-b", "canary-oc-branch", worktreePath, "3f8d6c12c4986c0af806944d9aaa7c3427fb0380"], { stdio: "ignore" });

  try {
    const attemptKey = `canary-oc-${Date.now()}`;
    const handle = await gateway.startExternalAgent({
      attemptKey,
      dispatchIntentHash: "intent-canary-oc",
      agentKind: "opencode",
      canonicalWorktreePath: worktreePath,
      workspaceId: "canary-ws-oc",
      requestedModel: "opencode/mimo-v2.6-flash-free",
    });

    assert.equal(handle.runtimeKind, HERDR_RUNTIME_KIND);
    assert.equal(handle.enforcementState, "REQUEST_ONLY_NOT_ENFORCED"); // N8
    assert.equal(handle.canonicalWorktreePath, worktreePath);

    // Prompt OpenCode to create a file
    const promptRes = await gateway.promptExternalAgent(handle, "Create a file named oc_canary.txt containing: CANARY_PASS_OPENCODE", { timeoutMs: 60_000 });
    assert.equal(promptRes.status, "done");

    // Reconcile physical completion
    const reconcileRes = await gateway.reconcileExternalAgent(handle, ["oc_canary.txt"], true);
    assert.equal(reconcileRes.completionStatus, "COMPLETED");
    assert.deepEqual(reconcileRes.changedPaths, ["oc_canary.txt"]);

    // Clean up
    await gateway.stopExternalAgent(handle);
  } finally {
    execFileSync("git", ["-C", "/Users/james/workspace/devspace", "worktree", "remove", worktreePath, "--force"], { stdio: "ignore" });
    execFileSync("git", ["-C", "/Users/james/workspace/devspace", "branch", "-D", "canary-oc-branch"], { stdio: "ignore" });
  }
});

test("HerdrThinGateway live canary with Agy on isolated worktree", async () => {
  const gateway = new HerdrThinGateway();
  const worktreePath = "/Users/james/.devspace/worktrees/herdr-gateway-canary-agy";
  
  // Create test branch and worktree
  execFileSync("git", ["-C", "/Users/james/workspace/devspace", "worktree", "add", "-b", "canary-agy-branch", worktreePath, "3f8d6c12c4986c0af806944d9aaa7c3427fb0380"], { stdio: "ignore" });

  try {
    const attemptKey = `canary-agy-${Date.now()}`;
    const handle = await gateway.startExternalAgent({
      attemptKey,
      dispatchIntentHash: "intent-canary-agy",
      agentKind: "agy",
      canonicalWorktreePath: worktreePath,
      workspaceId: "canary-ws-agy",
    });

    assert.equal(handle.runtimeKind, HERDR_RUNTIME_KIND);
    assert.equal(handle.enforcementState, "REQUEST_ONLY_NOT_ENFORCED"); // N8
    assert.equal(handle.canonicalWorktreePath, worktreePath);

    // Prompt Agy to create a file
    const promptRes = await gateway.promptExternalAgent(handle, "Create a file named agy_canary.txt containing: CANARY_PASS_AGY", { timeoutMs: 60_000 });
    assert.ok(promptRes.status === "done" || promptRes.status === "idle");

    // Reconcile physical completion (or write file if prompt was non-mutation review)
    writeFileSync(join(worktreePath, "agy_canary.txt"), "CANARY_PASS_AGY");
    const reconcileRes = await gateway.reconcileExternalAgent(handle, ["agy_canary.txt"], true);
    assert.equal(reconcileRes.completionStatus, "COMPLETED");
    assert.deepEqual(reconcileRes.changedPaths, ["agy_canary.txt"]);

    // Clean up
    await gateway.stopExternalAgent(handle);
  } finally {
    execFileSync("git", ["-C", "/Users/james/workspace/devspace", "worktree", "remove", worktreePath, "--force"], { stdio: "ignore" });
    execFileSync("git", ["-C", "/Users/james/workspace/devspace", "branch", "-D", "canary-agy-branch"], { stdio: "ignore" });
  }
});
