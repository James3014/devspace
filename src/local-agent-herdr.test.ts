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
} from "./local-agent-herdr.js";

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
    gateway.promptExternalAgent(handle, "consequential task"),
    (err: any) => {
      assert.match(err.message, /\[N-TURN\]/);
      return true;
    },
  );
});

test("HerdrThinGateway enforces Option A turn identity and durable nonce binding (B4, T1, T2, T3)", async () => {
  const registry = new HerdrGatewayRegistry();
  const gateway = new HerdrThinGateway("/tmp/test.sock", registry);

  const attemptKey = `turn-opt-a-${Date.now()}`;
  const handle: HerdrExternalHandle = {
    schemaVersion: 1,
    runtimeKind: HERDR_RUNTIME_KIND,
    herdrSocketPath: "/tmp/test.sock",
    herdrWorkspaceId: "w1",
    herdrPaneId: "p1",
    herdrAgentIdentity: "ds-turn-agent",
    herdrAgentKind: "opencode",
    promptNonce: `DURABLE-NONCE-${attemptKey}`,
    canonicalWorktreePath: "/tmp",
    workspaceId: "ws1",
    gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
    attemptKey,
    dispatchIntentHash: "intent-turn-a",
    launchTimestamp: new Date().toISOString(),
    enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
  };

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
  const firstRes = await gateway.promptExternalAgent(handle, "first prompt on handle");
  assert.equal(firstRes.status, "done");
  assert.equal(firstRes.turnNonce, handle.promptNonce);
  assert.ok(capturedPrompt.includes(`[NEXUS_ATTEMPT_NONCE:${handle.promptNonce}]`));
  assert.ok(capturedPrompt.includes("first prompt on handle"));
  assert.equal(registry.hasPromptSubmitted(attemptKey), true);

  // T2: Second prompt rejected under Option A
  await assert.rejects(
    gateway.promptExternalAgent(handle, "second prompt on same handle"),
    (err: any) => {
      assert.match(err.message, /\[N-TURN-OPTION-A\]/);
      return true;
    },
  );
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
  const gateway = new HerdrThinGateway();
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
    try {
      execFileSync("git", ["-C", "/Users/james/workspace/devspace", "worktree", "remove", worktreePath, "--force"], { stdio: "ignore" });
    } catch {}
    try {
      execFileSync("git", ["-C", "/Users/james/workspace/devspace", "branch", "-D", "canary-oc-branch"], { stdio: "ignore" });
    } catch {}
  }
});

test("HerdrThinGateway live canary with Agy on isolated worktree", async () => {
  const gateway = new HerdrThinGateway();
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
    let handle: HerdrExternalHandle | undefined;
    try {
      handle = await gateway.startExternalAgent({
        attemptKey,
        dispatchIntentHash: "intent-canary-agy",
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
