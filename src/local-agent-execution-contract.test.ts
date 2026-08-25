import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import Database from "better-sqlite3";
import { databasePath } from "./db/client.js";
import { LocalAgentSessionManager, AgentSessionError } from "./local-agent-sessions.js";
import { LocalAgentStore } from "./local-agent-store.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";
import type { ScopeBaseline } from "./local-agent-contract.js";
import { LocalAgentProviderError } from "./local-agent-runtime.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import {
  classifyScopeState,
  computeWorkerDelta,
  inspectWorkspacePhysicalState,
  workerChangedPathsSinceBaseline,
} from "./workspace-reconciliation.js";
import type { WorkspacePhysicalState } from "./workspace-reconciliation.js";

const originalDependencyRoot = process.env.DEVSPACE_DEPENDENCY_ROOT;
const codexRuntimeRoot = mkdtempSync(join(tmpdir(), "devspace-contract-codex-runtime-"));
const codexSdkPackagePath = join(
  codexRuntimeRoot,
  "node_modules",
  "@openai",
  "codex-sdk",
  "package.json",
);
const codexExecutable = join(
  codexRuntimeRoot,
  "node_modules",
  "@openai",
  "codex",
  "bin",
  "codex.js",
);
mkdirSync(join(codexRuntimeRoot, "node_modules", "@openai", "codex-sdk"), { recursive: true });
mkdirSync(join(codexRuntimeRoot, "node_modules", "@openai", "codex", "bin"), { recursive: true });
writeFileSync(
  codexSdkPackagePath,
  JSON.stringify({ name: "@openai/codex-sdk", version: "0.149.0" }),
);
writeFileSync(codexExecutable, "#!/bin/sh\necho 'codex-cli 0.149.0'\n", { mode: 0o755 });
process.env.DEVSPACE_DEPENDENCY_ROOT = codexRuntimeRoot;

after(() => {
  if (originalDependencyRoot === undefined) delete process.env.DEVSPACE_DEPENDENCY_ROOT;
  else process.env.DEVSPACE_DEPENDENCY_ROOT = originalDependencyRoot;
  rmSync(codexRuntimeRoot, { recursive: true, force: true });
});

function runGitRaw(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function setupGitFixture() {
  const root = mkdtempSync(join(tmpdir(), "devspace-contract-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  runGitRaw(["init", "--initial-branch=main"], repo);
  runGitRaw(["config", "user.email", "test@example.com"], repo);
  runGitRaw(["config", "user.name", "Test User"], repo);
  writeFileSync(join(repo, "readme.md"), "# Readme\n");
  runGitRaw(["add", "."], repo);
  runGitRaw(["commit", "-m", "initial"], repo);
  const head = runGitRaw(["rev-parse", "HEAD"], repo);

  const clean = () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  };
  return { root, repo, head, clean };
}

function setupManager(
  overrides: Record<string, unknown> = {},
  turnRunner?: any,
  launcher?: any,
) {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-contract-state-"));
  const terminated: Array<{ id: string }> = [];
  const config = {
    stateDir,
    subagents: true,
    oauth: { scopes: ["devspace"] },
    agentMaxConcurrent: 8,
    toolchains: [],
    ...overrides,
  } as any;

  const mockTerminator = async (record: any) => {
    terminated.push({ id: record.id });
    return true;
  };

  const manager = new LocalAgentSessionManager(
    config,
    launcher ?? (async () => undefined),
    mockTerminator,
    turnRunner,
  );

  const clean = () => {
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {}
  };
  return { manager, config, terminated, clean, stateDir };
}

function settleForContinuation(
  manager: LocalAgentSessionManager,
  agentId: string,
  patch: {
    status?: "idle" | "error";
    latestResponse?: string;
    providerSessionId?: string;
    error?: string;
    terminalReason?: "completed" | "provider_error";
  },
): void {
  const store = (manager as any).store as LocalAgentStore;
  const current = store.getById(agentId)!;
  const generation = current.lifecycleState!.activeTurn!.generation!;
  const workerToken = current.workerToken!;
  assert.equal(store.claimWorkerCAS(agentId, generation, workerToken, 39999).applied, true);
  assert.equal(store.finishTurnCAS({
    agentId,
    generation,
    workerToken,
    status: patch.status ?? "idle",
    terminalReason: patch.terminalReason ?? "completed",
    ...patch,
  }).applied, true);
}

function claimDetachedTurn(
  manager: LocalAgentSessionManager,
  agentId: string,
  workerPid: number,
  scopeBaseline?: ScopeBaseline,
): { store: LocalAgentStore; generation: string; workerToken: string } {
  const store = (manager as any).store as LocalAgentStore;
  const current = store.getById(agentId)!;
  const generation = current.lifecycleState!.activeTurn!.generation!;
  const workerToken = current.workerToken!;
  if (current.status === "starting") {
    assert.equal(store.claimWorkerCAS(agentId, generation, workerToken, workerPid).applied, true);
  }
  if (scopeBaseline) {
    assert.equal(store.updateTurnEvidenceCAS(agentId, generation, workerToken, { scopeBaseline }).applied, true);
  }
  return { store, generation, workerToken };
}

function failDetachedTurn(
  manager: LocalAgentSessionManager,
  agentId: string,
  input: { error: string; terminalReason: "timeout" | "provider_error"; scopeBaseline: ScopeBaseline },
): void {
  const claimed = claimDetachedTurn(manager, agentId, 39996, input.scopeBaseline);
  assert.equal(claimed.store.failTurnCAS({
    agentId,
    generation: claimed.generation,
    workerToken: claimed.workerToken,
    error: input.error,
    terminalReason: input.terminalReason,
  }).applied, true);
}

const mockProfiles: LocalAgentProfile[] = [
  {
    name: "reviewer",
    description: "test",
    provider: "codex",
    disabled: false,
    filePath: "reviewer.md",
    body: "reviewer prompt",
    write_mode: "read_only",
  },
];

// AC-2: expectedHead mismatch rejects before worker mutation.
test("AC-2 agent_start rejects STALE_WORKSPACE before worker mutation when HEAD mismatches", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    const wrongHead = "a".repeat(40);
    await assert.rejects(
      manager.startAgent({
        workspaceId: "ws_1",
        workspaceRoot: f.repo,
        profileName: "reviewer",
        prompt: "do work",
        profiles: mockProfiles,
        executionContract: { expectedHead: wrongHead },
      }),
      (err: any) => err.code === "STALE_WORKSPACE",
    );
    assert.equal(manager.listAgents({ workspaceId: "ws_1" }).length, 0);

    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: { expectedHead: f.head },
    });
    assert.equal(started.status, "starting");
  } finally {
    f.clean();
    clean();
  }
});

// AC-3: writePaths are represented in durable agent state.
test("AC-3 executionContract writePaths are durable", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: {
        writePaths: ["src", "tests"],
        maxFiles: 2,
        maxWallMs: 5000,
      },
    });
    const record = manager.getRecordByPrefixOrId(started.agentId);
    assert.ok(record);
    assert.deepEqual(record.executionContract?.writePaths, ["src", "tests"]);
    assert.equal(record.executionContract?.maxFiles, 2);
    assert.equal(record.executionContract?.maxWallMs, 5000);
  } finally {
    f.clean();
    clean();
  }
});

// AC-1: configured profile with unresolved auth/readiness reports UNKNOWN
// dispatch state, never READY and never a known failure.
test("AC-1 preflight dispatchState is UNKNOWN when auth/readiness are unresolved", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    const output = await manager.preflightAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      isolated: true,
      profileName: "reviewer",
      profiles: mockProfiles,
    });
    assert.equal(output.worker.profile, "reviewer");
    assert.equal(output.worker.provider, "codex");
    assert.equal(output.readiness.profileResolved, true);
    assert.equal(output.readiness.providerConfigured, true);
    assert.equal(output.readiness.authReady, "unknown");
    assert.equal(output.readiness.providerReachable, "unknown");
    assert.equal(output.readiness.runtimeReady, true);
    assert.equal(output.readiness.capacityAvailable, true);
    assert.equal(output.readiness.dispatchState, "UNKNOWN");
    assert.equal(output.workspace.head, f.head);
    assert.equal(output.workspace.dirty, false);
    assert.equal(output.workspace.isolated, true);
    assert.deepEqual(output.blockers, []);
    assert.ok(output.unknowns.some((entry) => entry.startsWith("authReady")));
    assert.ok(output.unknowns.some((entry) => entry.startsWith("providerReachable")));
  } finally {
    f.clean();
    clean();
  }
});

test("AC-1 Codex preflight fails closed when the configured executable is invalid", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  const originalExecutable = process.env.DEVSPACE_CODEX_EXECUTABLE;
  try {
    process.env.DEVSPACE_CODEX_EXECUTABLE = join(f.root, "missing-codex");
    const output = await manager.preflightAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      isolated: true,
      profileName: "reviewer",
      profiles: mockProfiles,
    });
    assert.equal(output.readiness.runtimeReady, false);
    assert.equal(output.readiness.dispatchState, "BLOCKED");
    assert.ok(
      output.blockers.some(
        (blocker) => blocker.code === "RUNTIME_STARTUP_NOT_READY" &&
          /codex/i.test(blocker.detail),
      ),
    );
  } finally {
    if (originalExecutable === undefined) delete process.env.DEVSPACE_CODEX_EXECUTABLE;
    else process.env.DEVSPACE_CODEX_EXECUTABLE = originalExecutable;
    f.clean();
    clean();
  }
});

// Known blockers produce BLOCKED, distinct from UNKNOWN.
test("preflight dispatchState is BLOCKED when a known blocker exists", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    const output = await manager.preflightAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      isolated: true,
      profileName: "no-such-profile",
      profiles: mockProfiles,
    });
    assert.equal(output.readiness.profileResolved, false);
    assert.equal(output.readiness.dispatchState, "BLOCKED");
    assert.ok(output.blockers.some((blocker) => blocker.code === "UNKNOWN_PROFILE"));

    const toolchainBlocked = await manager.preflightAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      isolated: true,
      profileName: "reviewer",
      profiles: mockProfiles,
      toolchainId: "missing-toolchain",
    });
    assert.equal(toolchainBlocked.readiness.dispatchState, "BLOCKED");
    assert.ok(toolchainBlocked.blockers.some((blocker) => blocker.code === "TOOLCHAIN_UNAVAILABLE"));
  } finally {
    f.clean();
    clean();
  }
});

// AC-4: an out-of-scope write is detected, agent becomes SCOPE_VIOLATION,
// offending paths are reported, and the implementation does not claim a hard sandbox.
test("AC-4 superviseActiveAgents detects out-of-scope write -> SCOPE_VIOLATION", async () => {
  const f = setupGitFixture();
  const { manager, terminated, clean } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: { writePaths: ["src"] },
    });
    const record = manager.getRecordByPrefixOrId(started.agentId);
    assert.ok(record);

    // Simulate a claimed running worker with a baseline snapshot.
    claimDetachedTurn(manager, record.id, 9999999, { changedPaths: [], head: f.head });
    mkdirSync(join(f.repo, "src"), { recursive: true });
    writeFileSync(join(f.repo, "src", "in-scope.ts"), "ok");
    writeFileSync(join(f.repo, "leaked-outside.txt"), "bad");

    await manager.superviseActiveAgents();

    const after = manager.getRecordByPrefixOrId(record.id);
    assert.ok(after);
    assert.equal(after.status, "error");
    assert.equal(after.terminalReason, "scope_violation");
    assert.equal(after.scopeState, "SCOPE_VIOLATION");
    assert.match(after.error ?? "", /leaked-outside\.txt/);
    assert.ok(terminated.some((entry) => entry.id === record.id));

    // Reconcile surfaces the same violation with offending paths.
    const reconciled = await manager.reconcileAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      isolated: true,
      agentId: record.id,
    });
    assert.equal(reconciled.candidate.scopeState, "SCOPE_VIOLATION");
    assert.ok(reconciled.candidate.unexpectedPaths.includes("leaked-outside.txt"));
    assert.ok(!reconciled.candidate.unexpectedPaths.includes("src/in-scope.ts"));
  } finally {
    f.clean();
    clean();
  }
});

// AC-6: provider timeout/error with an existing physical diff reconciles to candidate.present = true.
test("AC-6 reconcile preserves candidate after provider timeout", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: { writePaths: ["src"] },
    });
    failDetachedTurn(manager, started.agentId, {
      error: "provider timed out after 600000ms",
      terminalReason: "timeout",
      scopeBaseline: { changedPaths: [], head: f.head },
    });
    mkdirSync(join(f.repo, "src"), { recursive: true });
    writeFileSync(join(f.repo, "src", "change.ts"), "candidate");

    const reconciled = await manager.reconcileAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      isolated: true,
      agentId: started.agentId,
    });
    assert.equal(reconciled.agentState, "error");
    assert.equal(reconciled.terminalReason, "timeout");
    assert.equal(reconciled.candidate.present, true);
    assert.deepEqual(reconciled.candidate.changedPaths, ["src/change.ts"]);
    assert.equal(reconciled.candidate.scopeState, "WITHIN_SCOPE");
  } finally {
    f.clean();
    clean();
  }
});

// AC-7: provider timeout/error with no physical diff reconciles distinctly.
test("AC-7 reconcile distinguishes no-candidate after provider timeout", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: { writePaths: ["src"] },
    });
    failDetachedTurn(manager, started.agentId, {
      error: "provider timed out after 600000ms",
      terminalReason: "timeout",
      scopeBaseline: { changedPaths: [], head: f.head },
    });

    const reconciled = await manager.reconcileAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      isolated: true,
      agentId: started.agentId,
    });
    assert.equal(reconciled.candidate.present, false);
    assert.deepEqual(reconciled.candidate.changedPaths, []);
    assert.equal(reconciled.candidate.scopeState, "WITHIN_SCOPE");
  } finally {
    f.clean();
    clean();
  }
});

// AC-8: agent_status exposes terminal reason and lifecycle timestamps.
test("AC-8 status exposes terminal reason and lifecycle timestamps", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
    });
    settleForContinuation(manager, started.agentId, {
      status: "error",
      error: "provider error",
      terminalReason: "provider_error",
    });
    const status = await manager.getAgentStatus({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      agentId: started.agentId,
    });
    assert.equal(status.terminal, true);
    assert.equal(status.terminalReason, "provider_error");
    assert.equal(status.startedAt, status.createdAt);
    assert.equal(status.lastActivityAt, status.updatedAt);
    assert.ok(typeof status.wallMs === "number" && status.wallMs >= 0);
    assert.ok(typeof status.idleMs === "number" && status.idleMs >= 0);
  } finally {
    f.clean();
    clean();
  }
});

// AC-9: existing callers without executionContract remain compatible.
test("AC-9 startAgent without executionContract remains compatible", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "hello",
      profiles: mockProfiles,
    });
    assert.equal(started.status, "starting");
    assert.equal(started.profileName, "reviewer");
    const record = manager.getRecordByPrefixOrId(started.agentId);
    assert.equal(record?.executionContract, undefined);
  } finally {
    f.clean();
    clean();
  }
});

// AC-10: agent_continue binds the same durable agent/provider conversation.
test("AC-10 continueAgent preserves provider session binding", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "hello 1",
      profiles: mockProfiles,
    });
    settleForContinuation(manager, started.agentId, {
      latestResponse: "done",
      providerSessionId: "provider-session-abc",
    });
    const continued = await manager.continueAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      agentId: started.agentId,
      prompt: "hello 2",
    });
    assert.equal(continued.agentId, started.agentId);
    assert.equal(continued.continued, true);
    const record = manager.getRecordByPrefixOrId(started.agentId);
    assert.equal(record?.providerSessionId, "provider-session-abc");
  } finally {
    f.clean();
    clean();
  }
});

test("AC-10b continuation maxWallMs fences the new turn, not durable session age", async () => {
  const f = setupGitFixture();
  const { manager, clean, terminated } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "hello 1",
      profiles: mockProfiles,
      executionContract: { maxWallMs: 100 },
    });
    settleForContinuation(manager, started.agentId, {
      latestResponse: "done",
      providerSessionId: "provider-session-abc",
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    await manager.continueAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      agentId: started.agentId,
      prompt: "hello 2",
    });
    await manager.superviseActiveAgents();

    const record = manager.getRecordByPrefixOrId(started.agentId);
    assert.equal(record?.status, "starting");
    assert.equal(terminated.length, 0);
  } finally {
    f.clean();
    clean();
  }
});

// AC-5: missing toolchain fails explicitly; Dev MCP never repairs the environment.
test("AC-5 missing toolchain fails explicitly without creating .venv or mutating repo", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager({ toolchains: [] });
  try {
    const before = runGitRaw(["status", "--porcelain"], f.repo);
    await assert.rejects(
      manager.startAgent({
        workspaceId: "ws_1",
        workspaceRoot: f.repo,
        profileName: "reviewer",
        prompt: "do work",
        profiles: mockProfiles,
        executionContract: { toolchainId: "nexus-python" },
      }),
      (err: any) => err.code === "TOOLCHAIN_UNAVAILABLE",
    );
    const after = runGitRaw(["status", "--porcelain"], f.repo);
    assert.equal(before, after);
    assert.equal(manager.listAgents({ workspaceId: "ws_1" }).length, 0);
  } finally {
    f.clean();
    clean();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// G3 Wall-Time Separation & Phase Budget Tests (TEST A - TEST H)
// ─────────────────────────────────────────────────────────────────────────────

// TEST A: Slow startup does not consume maxExecutionMs
test("G3 TEST A — slow startup does not consume maxExecutionMs", async () => {
  const f = setupGitFixture();
  const { manager, clean, terminated } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: {
        maxStartupMs: 1000,
        maxExecutionMs: 50,
      },
    });

    // Simulate startup phase running for 100ms (> maxExecutionMs of 50ms)
    await new Promise((r) => setTimeout(r, 100));
    await manager.superviseActiveAgents();

    const record1 = manager.getRecordByPrefixOrId(started.agentId);
    assert.equal(record1?.status, "starting");
    assert.equal(terminated.length, 0, "Must not timeout during startup when maxExecutionMs is exceeded but maxStartupMs is not");

    // Provider runtime becomes ready -> executionStartedAt recorded
    const store = (manager as any).store;
    const tokenA = "token-test-a";
    store.prepareWorker(started.agentId, tokenA);
    store.claimWorker(started.agentId, tokenA, 10001);
    store.markExecutionStarted(started.agentId, tokenA);

    // Fast semantic run (10ms < 50ms)
    await new Promise((r) => setTimeout(r, 10));
    await manager.superviseActiveAgents();

    const record2 = manager.getRecordByPrefixOrId(started.agentId);
    assert.equal(terminated.length, 0, "Must succeed without execution timeout");
  } finally {
    f.clean();
    clean();
  }
});

// TEST B: Startup timeout terminates exact worker with startup evidence
test("G3 TEST B — startup timeout terminates worker with startup evidence", async () => {
  const f = setupGitFixture();
  const { manager, clean, terminated } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: {
        maxStartupMs: 50,
        maxExecutionMs: 1000,
      },
    });

    await new Promise((r) => setTimeout(r, 80));
    await manager.superviseActiveAgents();

    const record = manager.getRecordByPrefixOrId(started.agentId);
    assert.equal(record?.status, "error");
    assert.equal(record?.terminalReason, "timeout");
    assert.match(record?.error ?? "", /maxStartupMs of 50ms during startup\/readiness/);
    assert.ok(terminated.some((entry) => entry.id === started.agentId));
  } finally {
    f.clean();
    clean();
  }
});

// TEST C: Execution timeout terminates worker after execution start
test("G3 TEST C — execution timeout terminates worker after execution start", async () => {
  const f = setupGitFixture();
  const { manager, clean, terminated } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: {
        maxStartupMs: 1000,
        maxExecutionMs: 50,
      },
    });

    const store = (manager as any).store;
    const tokenC = "token-test-c";
    store.prepareWorker(started.agentId, tokenC);
    store.claimWorker(started.agentId, tokenC, 10003);
    store.markExecutionStarted(started.agentId, tokenC);

    await new Promise((r) => setTimeout(r, 80));
    await manager.superviseActiveAgents();

    const record = manager.getRecordByPrefixOrId(started.agentId);
    assert.equal(record?.status, "error");
    assert.equal(record?.terminalReason, "timeout");
    assert.match(record?.error ?? "", /maxExecutionMs of 50ms during execution/);
    assert.ok(terminated.some((entry) => entry.id === started.agentId));
  } finally {
    f.clean();
    clean();
  }
});

// TEST D: Legacy maxWallMs preserved as whole-turn ceiling
test("G3 TEST D — legacy maxWallMs preserved as whole-turn ceiling", async () => {
  const f = setupGitFixture();
  const { manager, clean, terminated } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: {
        maxWallMs: 60,
        maxStartupMs: 1000,
        maxExecutionMs: 1000,
      },
    });

    // 40ms in startup + 40ms in execution = 80ms total (> maxWallMs 60ms)
    await new Promise((r) => setTimeout(r, 40));
    const store = (manager as any).store;
    const tokenD = "token-test-d";
    store.prepareWorker(started.agentId, tokenD);
    store.claimWorker(started.agentId, tokenD, 10004);
    store.markExecutionStarted(started.agentId, tokenD);
    await new Promise((r) => setTimeout(r, 40));

    await manager.superviseActiveAgents();

    const record = manager.getRecordByPrefixOrId(started.agentId);
    assert.equal(record?.status, "error");
    assert.equal(record?.terminalReason, "timeout");
    assert.match(record?.error ?? "", /maxWallMs of 60ms/);
    assert.ok(terminated.some((entry) => entry.id === started.agentId));
  } finally {
    f.clean();
    clean();
  }
});

// TEST E: maxExecutionMs does not fire before execution start
test("G3 TEST E — maxExecutionMs does not fire before execution start", async () => {
  const f = setupGitFixture();
  const { manager, clean, terminated } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: {
        maxExecutionMs: 30,
      },
    });

    // Still in startup, supervisor called multiple times
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 20));
      await manager.superviseActiveAgents();
      assert.equal(terminated.length, 0, `Supervisor iteration ${i} must not terminate`);
    }
  } finally {
    f.clean();
    clean();
  }
});

// TEST F: Continuation resets phase clock
test("G3 TEST F — continuation resets phase clock", async () => {
  const f = setupGitFixture();
  const { manager, clean, terminated } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "turn 1",
      profiles: mockProfiles,
      executionContract: {
        maxStartupMs: 100,
      },
    });

    settleForContinuation(manager, started.agentId, {
      latestResponse: "done 1",
      providerSessionId: "sess-1",
    });

    // Wait longer than maxStartupMs
    await new Promise((r) => setTimeout(r, 150));

    // Continue turn 2
    await manager.continueAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      agentId: started.agentId,
      prompt: "turn 2",
    });

    // Immediately supervise
    await manager.superviseActiveAgents();

    const record = manager.getRecordByPrefixOrId(started.agentId);
    assert.equal(record?.status, "starting");
    assert.equal(terminated.length, 0, "Turn 2 must not be affected by Turn 1 timestamps");
  } finally {
    f.clean();
    clean();
  }
});

// TEST G: updatedAt noise does not reset authoritative clocks
test("G3 TEST G — updatedAt noise does not reset authoritative clocks", async () => {
  const f = setupGitFixture();
  const { manager, clean, terminated } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: {
        maxStartupMs: 60,
      },
    });

    // Wait 40ms, touch updatedAt via an exact idempotent launch-state CAS.
    await new Promise((r) => setTimeout(r, 40));
    const store = (manager as any).store as LocalAgentStore;
    const active = store.getById(started.agentId)!;
    assert.equal(store.markWorkerSpawnedCAS(
      started.agentId,
      active.lifecycleState!.activeTurn!.generation!,
      active.workerToken!,
      active.workerPid,
    ).applied, true);

    // Wait another 30ms (total wall time = 70ms > 60ms)
    await new Promise((r) => setTimeout(r, 30));
    await manager.superviseActiveAgents();

    const record = manager.getRecordByPrefixOrId(started.agentId);
    assert.equal(record?.status, "error");
    assert.equal(record?.terminalReason, "timeout");
    assert.match(record?.error ?? "", /maxStartupMs of 60ms/);
    assert.ok(terminated.some((entry) => entry.id === started.agentId));
  } finally {
    f.clean();
    clean();
  }
});

// TEST H: executionStartedAt written to store before semantic run
test("G3 TEST H — executionStartedAt written before semantic run", async () => {
  const f = setupGitFixture();
  let executionStartedPresentDuringRun = false;
  let launched: { promptFile: string; workerToken: string } | undefined;
  const { manager, clean } = setupManager(
    {},
    async (profile: any, record: any, prompt: string, callbacks?: any) => {
      // Adapter calls onExecutionStarted when runtime is ready
      if (callbacks?.onExecutionStarted) {
        await callbacks.onExecutionStarted();
      }
      // Check durable store at the moment semantic run starts
      const current = (manager as any).store.getById(record.id);
      executionStartedPresentDuringRun = Boolean(current?.lifecycleState?.activeTurn?.executionStartedAt);
      return {
        provider: record.provider,
        providerSessionId: "p-sess",
        finalResponse: "ok",
        items: [],
      };
    },
    async (agentId: string, promptFile: string, workerToken: string) => {
      launched = { promptFile, workerToken };
    },
  );

  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
    });

    assert.ok(launched);
    // Process worker turn synchronously via runWorkerTurnFromFile
    await manager.runWorkerTurnFromFile(started.agentId, launched.promptFile, launched.workerToken);

    assert.equal(executionStartedPresentDuringRun, true, "Store must durably contain executionStartedAt before semantic run starts");
  } finally {
    f.clean();
    clean();
  }
});

// TEST I: executionStartedAt is write-once per active turn
test("G3 TEST I — executionStartedAt is write-once", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
    });

    const store = (manager as any).store;
    const workerToken = "token-test-i";
    store.prepareWorker(started.agentId, workerToken);
    const claimed = store.claimWorker(started.agentId, workerToken, 12345);

    const t1 = "2026-01-01T00:00:00.000Z";
    store.markExecutionStarted(started.agentId, workerToken, t1);

    const record1 = store.getById(started.agentId);
    assert.equal(record1?.lifecycleState?.activeTurn?.executionStartedAt, t1);

    // Second callback with later timestamp must be ignored (write-once)
    const t2 = "2026-01-01T00:05:00.000Z";
    store.markExecutionStarted(started.agentId, workerToken, t2);

    const record2 = store.getById(started.agentId);
    assert.equal(record2?.lifecycleState?.activeTurn?.executionStartedAt, t1, "executionStartedAt must remain t1");
  } finally {
    f.clean();
    clean();
  }
});

// TEST J: Late callback after startup timeout fails closed
test("G3 TEST J — late callback after startup timeout fails closed", async () => {
  const f = setupGitFixture();
  const { manager, clean, terminated } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: {
        maxStartupMs: 50,
      },
    });

    const store = (manager as any).store;
    const workerToken = "token-test-j";
    store.prepareWorker(started.agentId, workerToken);
    store.claimWorker(started.agentId, workerToken, 12345);

    // Supervisor terminates active agent due to startup timeout
    await new Promise((r) => setTimeout(r, 80));
    await manager.superviseActiveAgents();

    const record = store.getById(started.agentId);
    assert.equal(record?.status, "error");
    assert.equal(record?.terminalReason, "timeout");

    // Late worker callback attempt must fail closed
    assert.throws(
      () => store.markExecutionStarted(started.agentId, workerToken),
      /is no longer active under worker token/,
      "Late execution start callback must reject on terminal agent",
    );
  } finally {
    f.clean();
    clean();
  }
});

// TEST K: Wrong workerToken fails closed
test("G3 TEST K — wrong workerToken fails closed", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
    });

    const store = (manager as any).store;
    const correctToken = "token-test-k-correct";
    store.prepareWorker(started.agentId, correctToken);
    store.claimWorker(started.agentId, correctToken, 12345);

    assert.throws(
      () => store.markExecutionStarted(started.agentId, "wrong-token"),
      /is no longer active under worker token/,
      "Wrong workerToken must reject",
    );

    const record = store.getById(started.agentId);
    assert.equal(record?.lifecycleState?.activeTurn?.executionStartedAt, undefined);
  } finally {
    f.clean();
    clean();
  }
});

// TEST L: Timeout vs execution-start race
test("G3 TEST L — timeout vs execution-start race", async () => {
  const f = setupGitFixture();
  const { manager, clean, terminated } = setupManager();
  try {
    // Case 1: Execution transition wins first
    const started1 = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work 1",
      profiles: mockProfiles,
      executionContract: { maxStartupMs: 50, maxExecutionMs: 1000 },
    });
    const store = (manager as any).store;
    const token1 = "token-race-1";
    store.prepareWorker(started1.agentId, token1);
    store.claimWorker(started1.agentId, token1, 1001);

    // Transition to execution before startup timeout
    store.markExecutionStarted(started1.agentId, token1);

    // Startup timeout period passes, but worker is already in execution phase
    await new Promise((r) => setTimeout(r, 80));
    await manager.superviseActiveAgents();

    const record1 = store.getById(started1.agentId);
    assert.equal(record1?.status, "running", "Should not timeout since execution started");

    // Case 2: Startup timeout wins first
    const started2 = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work 2",
      profiles: mockProfiles,
      executionContract: { maxStartupMs: 50, maxExecutionMs: 1000 },
    });
    const token2 = "token-race-2";
    store.prepareWorker(started2.agentId, token2);
    store.claimWorker(started2.agentId, token2, 1002);

    // Startup timeout passes
    await new Promise((r) => setTimeout(r, 80));
    await manager.superviseActiveAgents();

    // Late execution transition fails
    assert.throws(
      () => store.markExecutionStarted(started2.agentId, token2),
      /is no longer active/,
    );
  } finally {
    f.clean();
    clean();
  }
});

// TEST M: DriverBacked production boundary order
test("G3 TEST M — DriverBacked production boundary order", async () => {
  const { createLocalAgentAdapter } = await import("./local-agent-adapters.js");
  const events: string[] = [];

  const fakeDriver = {
    provider: "claude" as const,
    runtimeKey: () => "fake",
    async createRuntime() {
      events.push("createRuntime:start");
      await new Promise((r) => setTimeout(r, 20));
      events.push("createRuntime:ready");
      return {
        isOk: () => true,
        value: {
          provider: "claude" as const,
          async run() {
            events.push("runtime.run:start");
            return {
              isOk: () => true,
              value: { provider: "claude", providerSessionId: "p1", finalResponse: "ok", items: [] },
            };
          },
          async releaseSession() {},
          async close() {},
          isAlive: () => true,
        },
      } as any;
    },
  };

  const adapter = (createLocalAgentAdapter as any)("claude", {
    claudeQueryFactory: undefined,
  });
  // Replace driver with fakeDriver to trace exact lifecycle
  (adapter as any).driver = fakeDriver;

  const callbacks = {
    onExecutionStarted: async () => {
      events.push("executionStarted");
    },
  };

  await adapter.run({
    prompt: "hello",
    workspaceRoot: ".",
  }, callbacks);

  assert.deepEqual(events, [
    "createRuntime:start",
    "createRuntime:ready",
    "executionStarted",
    "runtime.run:start",
  ], "executionStarted callback must be called strictly between createRuntime:ready and runtime.run:start");
});

// TEST N: OMP production boundary order via runOmpAcpSession
test("G3 TEST N — OMP production boundary order", async () => {
  const { runOmpAcpSession } = await import("./local-agent-omp.js");
  const events: string[] = [];

  const fakeAgent = {
    async request(method: string, params: any) {
      if (method === "agent.initialize" || method === "initialize") {
        events.push("initialize");
        return { agentCapabilities: { sessionCapabilities: { resume: true } } };
      }
      if (method === "agent.session.new" || method === "session/new") {
        events.push("session.new");
        return { sessionId: "sess-omp-n" };
      }
      if (method === "agent.session.prompt" || method === "session/prompt") {
        events.push("session.prompt");
        return { response: "omp result" };
      }
      return {};
    },
  };

  const methods = {
    agent: {
      initialize: "agent.initialize",
      session: {
        new: "agent.session.new",
        resume: "agent.session.resume",
        prompt: "agent.session.prompt",
      },
    },
  };

  const callbacks = {
    onExecutionStarted: async () => {
      events.push("onExecutionStarted");
    },
  };

  await runOmpAcpSession(
    fakeAgent,
    methods,
    "1.0",
    { prompt: "test prompt", workspaceRoot: "." },
    callbacks,
  );

  assert.deepEqual(events, [
    "initialize",
    "session.new",
    "onExecutionStarted",
    "session.prompt",
  ], "OMP session prompt must occur strictly after onExecutionStarted");
});

// TEST O: OMP slow readiness does not consume execution budget
test("G3 TEST O — OMP slow readiness does not consume execution budget", async () => {
  const f = setupGitFixture();
  const { manager, clean, terminated } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: {
        maxStartupMs: 1000,
        maxExecutionMs: 50,
      },
    });

    const store = (manager as any).store;
    const workerToken = "token-omp-o";
    store.prepareWorker(started.agentId, workerToken);
    store.claimWorker(started.agentId, workerToken, 12345);

    // OMP initialization / session setup takes 100ms (> maxExecutionMs 50ms)
    await new Promise((r) => setTimeout(r, 100));
    await manager.superviseActiveAgents();

    const record1 = store.getById(started.agentId);
    assert.equal(record1?.status, "running");
    assert.equal(terminated.length, 0, "OMP slow startup must not trigger maxExecutionMs timeout");

    // OMP session becomes ready -> marks execution started
    store.markExecutionStarted(started.agentId, workerToken);

    // Fast semantic prompt
    await new Promise((r) => setTimeout(r, 10));
    await manager.superviseActiveAgents();

    assert.equal(terminated.length, 0, "Must not timeout");
  } finally {
    f.clean();
    clean();
  }
});

// TEST P: Durable timeout fence precedes terminator completion (Atomic Race Witness)
test("G3 TEST P — durable timeout fence precedes terminator completion", async () => {
  const f = setupGitFixture();
  let terminatorEntered = false;
  let releaseTerminator!: () => void;
  const terminatorHoldPromise = new Promise<void>((resolve) => {
    releaseTerminator = resolve;
  });

  const customTerminator = async (record: any) => {
    terminatorEntered = true;
    await terminatorHoldPromise;
    return true;
  };

  const stateDir = mkdtempSync(join(tmpdir(), "devspace-race-p-"));
  const config = {
    stateDir,
    subagents: true,
    oauth: { scopes: ["devspace"] },
    agentMaxConcurrent: 8,
    toolchains: [],
  } as any;

  const manager = new LocalAgentSessionManager(
    config,
    async () => undefined,
    customTerminator,
  );

  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: {
        maxStartupMs: 40,
      },
    });

    const store = (manager as any).store;
    const workerToken = "token-race-p";
    store.prepareWorker(started.agentId, workerToken);
    const claimed = store.claimWorker(started.agentId, workerToken, 12345);

    // Wait for startup timeout to exceed
    await new Promise((r) => setTimeout(r, 60));

    // Launch supervisor in background
    const supervisePromise = manager.superviseActiveAgents();

    // Poll until terminator is entered
    while (!terminatorEntered) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // ★ CRITICAL RACE WITNESS: While terminator is STILL RUNNING / NOT RESOLVED,
    // the DB record MUST ALREADY BE TERMINAL FENCED!
    const recordWhileTerminating = store.getById(started.agentId);
    assert.equal(recordWhileTerminating?.status, "error", "Status must already be error before terminator finishes");
    assert.equal(recordWhileTerminating?.workerToken, workerToken, "cleanup identity remains until verified success");
    assert.equal(recordWhileTerminating?.workerPid, 12345, "cleanup PID remains until verified success");
    assert.equal(recordWhileTerminating?.lifecycleState?.activeTurn, undefined);
    const terminationPending = recordWhileTerminating?.lifecycleState?.terminationPending;
    assert.ok(terminationPending, "fence must atomically install durable terminationPending");
    assert.equal(terminationPending.generation, claimed?.lifecycleState?.activeTurn?.generation);
    assert.equal(terminationPending.launchState, "claimed");

    const pendingStatus = await manager.getAgentStatus({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      agentId: started.agentId,
      waitMs: 20,
    });
    assert.equal(pendingStatus.terminal, false, "logical terminal status is not physical terminal while pending");
    assert.equal((pendingStatus as any).termination?.generation, terminationPending.generation);

    await assert.rejects(
      manager.continueAgent({
        workspaceId: "ws_1",
        workspaceRoot: f.repo,
        agentId: started.agentId,
        prompt: "must remain blocked",
      }),
      (error: any) => error.code === "AGENT_TERMINATION_PENDING",
    );
    await assert.rejects(
      manager.cleanupAgentScratch(started.agentId),
      (error: any) => error.code === "AGENT_TERMINATION_PENDING",
    );

    // Any late worker callback using the old token MUST fail closed immediately
    assert.throws(
      () => store.markExecutionStarted(started.agentId, workerToken),
      /is no longer active/,
      "Late execution transition during termination MUST fail closed",
    );

    // Now release terminator and finish supervisor
    releaseTerminator();
    await supervisePromise;
    assert.equal(store.getById(started.agentId)?.lifecycleState?.terminationPending, undefined);
  } finally {
    f.clean();
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {}
  }
});

test("G3 TEST U/W — verified termination unlocks continuation with a new turn", async () => {
  const f = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-termination-unlock-"));
  let releaseTerminator!: () => void;
  let terminatorEntered!: () => void;
  const entered = new Promise<void>((resolve) => { terminatorEntered = resolve; });
  const held = new Promise<void>((resolve) => { releaseTerminator = resolve; });
  const launches: string[] = [];
  const manager = new LocalAgentSessionManager(
    { stateDir, subagents: true, oauth: { scopes: ["devspace"] }, agentMaxConcurrent: 1, toolchains: [] } as any,
    async (_agentId, _promptFile, token) => { launches.push(token); },
    async () => { terminatorEntered(); await held; return true; },
  );
  try {
    const record = manager.createRecord({
      workspaceId: "ws_termination_unlock",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      provider: "codex",
      executionContract: { maxStartupMs: 20 },
    });
    const promptFile = LocalAgentSessionManager.writePromptFile("turn A");
    await manager.spawnWorker(record.id, promptFile);
    rmSync(dirname(promptFile), { recursive: true, force: true });
    const started = { agentId: record.id };
    const store = (manager as any).store;
    const oldToken = launches[0]!;
    store.claimWorker(started.agentId, oldToken, 3101);
    const oldTurnStartedAt = store.getById(started.agentId).lifecycleState.activeTurn.turnStartedAt;
    const oldGeneration = store.getById(started.agentId).lifecycleState.activeTurn.generation;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const supervise = manager.superviseActiveAgents();
    await entered;

    const pending = store.getById(started.agentId)!.lifecycleState?.terminationPending;
    assert.ok(pending, "timeout fence must persist an exact termination generation");
    assert.equal(typeof pending.generation, "string");
    assert.equal(manager.runningCount(), 1);
    assert.equal(launches.length, 1);
    assert.throws(() => store.markExecutionStarted(started.agentId, oldToken), /no longer active/);

    releaseTerminator();
    await supervise;
    const continued = await manager.continueAgent({
      workspaceId: "ws_termination_unlock",
      workspaceRoot: f.repo,
      agentId: started.agentId,
      prompt: "turn B",
    });
    assert.equal(continued.continued, true);
    assert.equal(launches.length, 2);
    assert.notEqual(launches[1], oldToken);
    assert.notEqual(store.getById(started.agentId).lifecycleState.activeTurn.turnStartedAt, oldTurnStartedAt);
    assert.notEqual(store.getById(started.agentId).lifecycleState.activeTurn.generation, oldGeneration);
    assert.equal(store.getById(started.agentId).lifecycleState.activeTurn.launchState, "spawned");
  } finally {
    f.clean();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

for (const failureMode of ["false", "throw"] as const) {
  test(`G3 TEST V — terminator ${failureMode} keeps cancellation pending`, async () => {
    const f = setupGitFixture();
    const stateDir = mkdtempSync(join(tmpdir(), `devspace-termination-${failureMode}-`));
    const manager = new LocalAgentSessionManager(
      { stateDir, subagents: true, oauth: { scopes: ["devspace"] }, agentMaxConcurrent: 1, toolchains: [] } as any,
      async () => undefined,
      async () => {
        if (failureMode === "throw") throw new Error("terminator transport failed");
        return false;
      },
    );
    try {
      const record = manager.createRecord({
        workspaceId: `ws_${failureMode}`,
        workspaceRoot: f.repo,
        profileName: "reviewer",
        provider: "codex",
      });
      const promptFile = LocalAgentSessionManager.writePromptFile("cancel me");
      await manager.spawnWorker(record.id, promptFile);
      rmSync(dirname(promptFile), { recursive: true, force: true });
      const started = { agentId: record.id };
      await assert.rejects(
        manager.cancelAgent({ workspaceId: `ws_${failureMode}`, workspaceRoot: f.repo, agentId: started.agentId }),
        (error: any) => error.code === "WORKER_TERMINATION_FAILED",
      );
      const current = manager.getRecordByPrefixOrId(started.agentId) as any;
      assert.equal(current?.status, "stopped");
      const pending = current?.lifecycleState?.terminationPending;
      assert.ok(pending, "failed physical termination must remain durably pending");
      assert.equal(typeof pending.generation, "string");
      assert.match(pending.lastFailure ?? "", /termination could not be verified/i);
      await assert.rejects(
        manager.continueAgent({
          workspaceId: `ws_${failureMode}`,
          workspaceRoot: f.repo,
          agentId: started.agentId,
          prompt: "blocked continuation",
        }),
        (error: any) => error.code === "AGENT_TERMINATION_PENDING",
      );
    } finally {
      f.clean();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

test("G3 TEST Y — termination-pending worker consumes execution capacity", async () => {
  const f = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-termination-capacity-"));
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const held = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const manager = new LocalAgentSessionManager(
    { stateDir, subagents: true, oauth: { scopes: ["devspace"] }, agentMaxConcurrent: 1, toolchains: [] } as any,
    async () => undefined,
    async () => { enteredResolve(); await held; return true; },
  );
  try {
    const firstRecord = manager.createRecord({
      workspaceId: "ws_capacity_pending",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      provider: "codex",
      executionContract: { maxStartupMs: 20 },
    });
    const promptFile = LocalAgentSessionManager.writePromptFile("first");
    await manager.spawnWorker(firstRecord.id, promptFile);
    rmSync(dirname(promptFile), { recursive: true, force: true });
    const first = { agentId: firstRecord.id };
    const store = (manager as any).store;
    store.claimWorker(first.agentId, store.getById(first.agentId).workerToken, 3201);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const supervise = manager.superviseActiveAgents();
    await entered;
    await assert.rejects(
      manager.startAgent({
        workspaceId: "ws_capacity_pending",
        workspaceRoot: f.repo,
        profileName: "reviewer",
        prompt: "second",
        profiles: mockProfiles,
      }),
      (error: any) => error.code === "NO_EXECUTION_CAPACITY",
    );
    const preflight = await manager.preflightAgent({
      workspaceId: "ws_capacity_pending",
      workspaceRoot: f.repo,
      isolated: true,
      profileName: "reviewer",
      profiles: mockProfiles,
    });
    assert.equal(preflight.readiness.capacityAvailable, false);
    assert.ok(preflight.blockers.some((blocker) => blocker.code === "NO_EXECUTION_CAPACITY"));
    releaseResolve();
    await supervise;
  } finally {
    f.clean();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("G3 adversarial — scope violation uses the same durable cleanup primitive", async () => {
  const f = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-termination-scope-"));
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const held = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const manager = new LocalAgentSessionManager(
    { stateDir, subagents: true, oauth: { scopes: ["devspace"] }, agentMaxConcurrent: 1, toolchains: [] } as any,
    async () => undefined,
    async () => { enteredResolve(); await held; return true; },
  );
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_scope_pending",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "bounded scope",
      profiles: mockProfiles,
      executionContract: { writePaths: ["src"] },
    });
    const store = (manager as any).store as LocalAgentStore;
    const token = store.getById(started.agentId)!.workerToken!;
    store.claimWorker(started.agentId, token, 3251);
    const baseline = await inspectWorkspacePhysicalState(f.repo);
    const current = store.getById(started.agentId)!;
    assert.equal(store.updateTurnEvidenceCAS(
      started.agentId,
      current.lifecycleState!.activeTurn!.generation!,
      token,
      { scopeBaseline: {
        changedPaths: baseline.changedPaths,
        head: baseline.head ?? null,
        fingerprints: baseline.fingerprints,
      } },
    ).applied, true);
    writeFileSync(join(f.repo, "outside.txt"), "scope violation\n");
    const supervise = manager.superviseActiveAgents();
    await entered;
    const pending = store.getById(started.agentId)!.lifecycleState?.terminationPending;
    assert.ok(pending, "scope fence must install the same terminationPending state");
    assert.equal(pending.reason, "scope_violation");
    assert.equal(pending.workerToken, token);
    releaseResolve();
    await supervise;
  } finally {
    f.clean();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("G3 XA2 I1-I13 — lifecycle store exposes the full generation-CAS kill list", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-xa2-cas-surface-"));
  const store = new LocalAgentStore(stateDir);
  try {
    const requiredCasMethods = [
      "beginContinuationCAS",
      "prepareWorkerCAS",
      "claimWorkerCAS",
      "markExecutionStarted",
      "updateTurnEvidenceCAS",
      "bindProviderSessionCAS",
      "finishTurnCAS",
      "failTurnCAS",
      "failLaunchCAS",
      "beginTerminationCAS",
      "recordTerminationFailureCAS",
      "completeTerminationCAS",
    ] as const;
    const missing = requiredCasMethods.filter((name) => typeof (store as any)[name] !== "function");
    assert.deepEqual(missing, [], `generation-CAS surface is incomplete: ${missing.join(", ")}`);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("G3 TEST Z1 — valid pending termination survives reopen and blocks", async () => {
  const f = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-termination-reopen-"));
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const held = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const first = new LocalAgentSessionManager(
    { stateDir, subagents: true, oauth: { scopes: ["devspace"] }, agentMaxConcurrent: 1, toolchains: [] } as any,
    async () => undefined,
    async () => { enteredResolve(); await held; return true; },
  );
  let reopened: LocalAgentSessionManager | undefined;
  const retriedGenerations: string[] = [];
  let interruptedSupervisor: Promise<void> | undefined;
  try {
    const started = await first.startAgent({
      workspaceId: "ws_pending_reopen",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "turn before crash",
      profiles: mockProfiles,
      executionContract: { maxStartupMs: 20 },
    });
    const store = (first as any).store as LocalAgentStore;
    const token = store.getById(started.agentId)!.workerToken!;
    store.claimWorker(started.agentId, token, 3301);
    await new Promise((resolve) => setTimeout(resolve, 30));
    interruptedSupervisor = first.superviseActiveAgents();
    await entered;
    const generation = store.getById(started.agentId)!.lifecycleState!.terminationPending!.generation;
    (first as any).store.close();

    reopened = new LocalAgentSessionManager(
      { stateDir, subagents: true, oauth: { scopes: ["devspace"] }, agentMaxConcurrent: 1, toolchains: [] } as any,
      async () => undefined,
      async (record) => {
        retriedGenerations.push(record.lifecycleState?.terminationPending?.generation ?? "missing");
        return true;
      },
    );
    const status = await reopened.getAgentStatus({
      workspaceId: "ws_pending_reopen",
      workspaceRoot: f.repo,
      agentId: started.agentId,
    });
    assert.equal(status.terminal, false);
    assert.equal((status as any).termination?.generation, generation);
    assert.equal(reopened.runningCount(), 1);
    await assert.rejects(
      reopened.continueAgent({
        workspaceId: "ws_pending_reopen",
        workspaceRoot: f.repo,
        agentId: started.agentId,
        prompt: "must remain blocked after reopen",
      }),
      (error: any) => error.code === "AGENT_TERMINATION_PENDING",
    );
    const settled = await reopened.cancelAgent({
      workspaceId: "ws_pending_reopen",
      workspaceRoot: f.repo,
      agentId: started.agentId,
    });
    assert.equal(settled.terminal, true);
    assert.equal(settled.termination, undefined);
    assert.deepEqual(retriedGenerations, [generation]);
    assert.equal(reopened.runningCount(), 0);
  } finally {
    releaseResolve();
    await interruptedSupervisor?.catch(() => undefined);
    try { (reopened as any)?.store.close(); } catch {}
    f.clean();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("G3 TEST Z1b — malformed pending state fails closed after reopen", async () => {
  const f = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-termination-malformed-"));
  const first = new LocalAgentSessionManager(
    { stateDir, subagents: true, oauth: { scopes: ["devspace"] }, agentMaxConcurrent: 1, toolchains: [] } as any,
    async () => undefined,
    async () => true,
  );
  try {
    const started = await first.startAgent({
      workspaceId: "ws_pending_malformed",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "malformed persisted state",
      profiles: mockProfiles,
    });
    (first as any).store.close();
    const database = new Database(databasePath(stateDir));
    database.prepare("update local_agent_sessions set status = 'error', lifecycle_state = ? where id = ?")
      .run(JSON.stringify({
        lifecycleKind: "detached_worker_v2",
        terminationPending: { generation: 42 },
      }), started.agentId);
    database.close();
    const manager = new LocalAgentSessionManager(
      { stateDir, subagents: true, oauth: { scopes: ["devspace"] }, agentMaxConcurrent: 1, toolchains: [] } as any,
      async () => undefined,
      async () => true,
    );
    const parsedStatus = await manager.getAgentStatus({
      workspaceId: "ws_pending_malformed",
      workspaceRoot: f.repo,
      agentId: started.agentId,
    });
    assert.equal(parsedStatus.terminal, false, "corrupt pending evidence must not become terminal");
    assert.equal((parsedStatus as any).termination?.corrupt, true);
    assert.equal(manager.runningCount(), 1, "corrupt pending evidence must continue to occupy capacity");
    await assert.rejects(
      manager.continueAgent({
        workspaceId: "ws_pending_malformed",
        workspaceRoot: f.repo,
        agentId: started.agentId,
        prompt: "must fail closed",
      }),
      (error: any) =>
        error.code === "AGENT_TERMINATION_PENDING" || error.code === "AGENT_LIFECYCLE_CORRUPT",
    );
    (manager as any).store.close();
  } finally {
    f.clean();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("G3 TEST Z2 — launching generation without PID remains pending when termination is unprovable", async () => {
  const f = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-termination-launch-gap-"));
  let allowTermination = false;
  const terminatedTargets: Array<{ generation?: string; workerPid?: number }> = [];
  const manager = new LocalAgentSessionManager(
    { stateDir, subagents: true, oauth: { scopes: ["devspace"] }, agentMaxConcurrent: 1, toolchains: [] } as any,
    async () => undefined,
    async (record) => {
      terminatedTargets.push({
        generation: record.lifecycleState?.terminationPending?.generation,
        workerPid: record.workerPid,
      });
      return allowTermination;
    },
  );
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_launch_gap",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "launch gap",
      profiles: mockProfiles,
    });
    const before = manager.getRecordByPrefixOrId(started.agentId)! as any;
    assert.equal(before.workerPid, undefined);
    await assert.rejects(
      manager.cancelAgent({ workspaceId: "ws_launch_gap", workspaceRoot: f.repo, agentId: started.agentId }),
      (error: any) => error.code === "WORKER_TERMINATION_FAILED",
    );
    const after = manager.getRecordByPrefixOrId(started.agentId)! as any;
    assert.equal(after.lifecycleState?.terminationPending?.workerPid, undefined);
    assert.equal(after.lifecycleState?.terminationPending?.workerToken, before.workerToken);
    assert.equal(after.workerToken, before.workerToken);
    assert.equal(after.lifecycleState?.terminationPending?.launchState, "spawned");
    assert.equal(typeof (manager as any).store.claimWorkerCAS, "function");
    (manager as any).store.claimWorkerCAS(
      started.agentId,
      after.lifecycleState!.terminationPending!.generation,
      before.workerToken,
      3399,
    );
    const latePid = manager.getRecordByPrefixOrId(started.agentId)! as any;
    assert.equal(latePid.lifecycleState?.activeTurn, undefined, "late PID bind must never restore active authority");
    assert.equal(latePid.lifecycleState?.terminationPending?.workerPid, 3399);
    allowTermination = true;
    const settled = await manager.cancelAgent({
      workspaceId: "ws_launch_gap",
      workspaceRoot: f.repo,
      agentId: started.agentId,
    });
    assert.equal(settled.terminal, true);
    assert.equal(settled.termination, undefined);
    assert.deepEqual(terminatedTargets.at(-1), {
      generation: after.lifecycleState!.terminationPending!.generation,
      workerPid: 3399,
    });
  } finally {
    f.clean();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("G3 XA2 I11 — verified kill snapshots before unlock and later foreign edits block continuation", async () => {
  const f = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-termination-post-kill-baseline-"));
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const held = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const manager = new LocalAgentSessionManager(
    { stateDir, subagents: true, oauth: { scopes: ["devspace"] }, agentMaxConcurrent: 1, toolchains: [] } as any,
    async () => undefined,
    async () => { enteredResolve(); await held; return true; },
  );
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_post_kill_baseline",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "bounded turn",
      profiles: mockProfiles,
      executionContract: { maxStartupMs: 20 },
    });
    const token = manager.getRecordByPrefixOrId(started.agentId)!.workerToken!;
    (manager as any).store.claimWorker(started.agentId, token, 3401);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const supervise = manager.superviseActiveAgents();
    await entered;
    writeFileSync(join(f.repo, "worker-final.txt"), "last worker bytes\n");
    releaseResolve();
    await supervise;

    const settled = manager.getRecordByPrefixOrId(started.agentId)! as any;
    assert.equal(settled.lifecycleState?.terminationPending, undefined);
    assert.ok(
      settled.lifecycleState?.turnEndBaseline?.fingerprints?.["worker-final.txt"],
      "post-termination evidence must be durable before pending clears",
    );
    writeFileSync(join(f.repo, "worker-final.txt"), "foreign bytes after settlement\n");
    await assert.rejects(
      manager.continueAgent({
        workspaceId: "ws_post_kill_baseline",
        workspaceRoot: f.repo,
        agentId: started.agentId,
        prompt: "must reject foreign post-kill edit",
      }),
      (error: any) => error.code === "CONTINUATION_ADMISSION_FAILED",
    );
  } finally {
    f.clean();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("G3 T18 — legacy manager rows remain outside detached capacity and reconciliation", async () => {
  const f = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-legacy-kind-"));
  const legacyStore = new LocalAgentStore(stateDir);
  const legacy = legacyStore.create({
    workspaceId: "ws_legacy",
    workspaceRoot: f.repo,
    profileName: "reviewer",
    provider: "codex",
  });
  legacyStore.update(legacy.id, { status: "running", latestResponse: "runtime-pool progress" });
  const partialLegacyDetached = legacyStore.create({
    workspaceId: "ws_legacy_partial",
    workspaceRoot: f.repo,
    profileName: "reviewer",
    provider: "codex",
  });
  legacyStore.update(partialLegacyDetached.id, {
    status: "starting",
    workerToken: "partial-legacy-token",
  });
  legacyStore.close();
  const manager = new LocalAgentSessionManager(
    { stateDir, subagents: true, oauth: { scopes: ["devspace"] }, agentMaxConcurrent: 1, toolchains: [] } as any,
    async () => undefined,
    async () => true,
  );
  try {
    await manager.superviseActiveAgents();
    assert.equal(manager.runningCount(), 0, "legacy manager activity must not consume detached capacity");
    const compatibilityStore = (manager as any).store as LocalAgentStore;
    const blockedPartial = compatibilityStore.getById(partialLegacyDetached.id)!;
    assert.ok((blockedPartial.lifecycleState as any)?.terminationBlocked);
    assert.equal((blockedPartial.lifecycleState as any)?.terminationPending, undefined);
    const blockedStatus = await manager.getAgentStatus({
      workspaceId: "ws_legacy_partial",
      workspaceRoot: f.repo,
      agentId: partialLegacyDetached.id,
    });
    assert.equal(blockedStatus.terminal, false);
    assert.equal((blockedStatus as any).termination?.blocked, true);
    await assert.rejects(
      manager.continueAgent({
        workspaceId: "ws_legacy_partial",
        workspaceRoot: f.repo,
        agentId: partialLegacyDetached.id,
        prompt: "blocked partial target",
      }),
      (error: any) => error.code === "AGENT_LIFECYCLE_CORRUPT",
    );
    await assert.rejects(
      manager.cancelAgent({
        workspaceId: "ws_legacy_partial",
        workspaceRoot: f.repo,
        agentId: partialLegacyDetached.id,
      }),
      (error: any) => error.code === "AGENT_LIFECYCLE_CORRUPT",
    );
    await assert.rejects(
      manager.cleanupAgentScratch(partialLegacyDetached.id),
      (error: any) => error.code === "AGENT_LIFECYCLE_CORRUPT",
    );
    assert.equal(compatibilityStore.reconcileActiveRuns(), 1);
    const reconciledLegacy = compatibilityStore.getById(legacy.id)!;
    assert.equal(reconciledLegacy.status, "error");
    assert.ok(reconciledLegacy.lifecycleState?.activeTurn, "legacy activeTurn remains owned by legacy semantics");
    assert.equal((reconciledLegacy.lifecycleState as any)?.terminationPending, undefined);
    assert.equal(manager.runningCount(), 0, "terminal legacy activeTurn remains detached-capacity free");
    const started = await manager.startAgent({
      workspaceId: "ws_detached",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "detached turn",
      profiles: mockProfiles,
    });
    assert.ok(started.agentId);
    const store = (manager as any).store as LocalAgentStore;
    assert.equal((store.getById(started.agentId)?.lifecycleState as any)?.lifecycleKind, "detached_worker_v2");
    assert.throws(
      () => store.update(started.agentId, { status: "idle" }),
      /generation-owned detached lifecycle/i,
    );
    const legacyAfter = store.getById(legacy.id)!;
    assert.equal((legacyAfter.lifecycleState as any)?.terminationPending, undefined);
    assert.equal(legacyAfter.latestResponse, "runtime-pool progress");
  } finally {
    f.clean();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("G3 T18b — exact legacy detached PID and token adopt and settle one generation", async () => {
  const f = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-legacy-exact-adoption-"));
  const legacyStore = new LocalAgentStore(stateDir);
  const legacy = legacyStore.create({
    workspaceId: "ws_legacy_exact",
    workspaceRoot: f.repo,
    profileName: "reviewer",
    provider: "codex",
  });
  legacyStore.update(legacy.id, {
    status: "running",
    workerPid: 3503,
    workerToken: "legacy-exact-token",
  });
  legacyStore.close();
  const terminated: Array<{ generation?: string; workerPid?: number; workerToken?: string }> = [];
  const manager = new LocalAgentSessionManager(
    { stateDir, subagents: true, oauth: { scopes: ["devspace"] }, agentMaxConcurrent: 1, toolchains: [] } as any,
    async () => undefined,
    async (record) => {
      terminated.push({
        generation: record.lifecycleState?.terminationPending?.generation,
        workerPid: record.workerPid,
        workerToken: record.workerToken,
      });
      return true;
    },
  );
  try {
    await manager.superviseActiveAgents();
    assert.equal(terminated.length, 1);
    assert.equal(typeof terminated[0]!.generation, "string");
    assert.equal(terminated[0]!.workerPid, 3503);
    assert.equal(terminated[0]!.workerToken, "legacy-exact-token");
    const settled = manager.getRecordByPrefixOrId(legacy.id)!;
    assert.equal((settled.lifecycleState as any)?.lifecycleKind, "detached_worker_v2");
    assert.equal(settled.lifecycleState?.terminationPending, undefined);
    assert.equal(settled.workerPid, undefined);
    assert.equal(settled.workerToken, undefined);
    assert.equal(manager.runningCount(), 0);
  } finally {
    f.clean();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("G3 T19 — failed termination is not retried by every supervisor tick", async () => {
  const f = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-termination-retry-control-"));
  let attempts = 0;
  const manager = new LocalAgentSessionManager(
    { stateDir, subagents: true, oauth: { scopes: ["devspace"] }, agentMaxConcurrent: 1, toolchains: [] } as any,
    async () => undefined,
    async () => { attempts += 1; return false; },
  );
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_retry_control",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "timeout once",
      profiles: mockProfiles,
      executionContract: { maxStartupMs: 20 },
    });
    const store = (manager as any).store as LocalAgentStore;
    const current = store.getById(started.agentId)!;
    store.claimWorker(started.agentId, current.workerToken!, 3501);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await manager.superviseActiveAgents();
    assert.equal(attempts, 1);
    await manager.superviseActiveAgents();
    await manager.superviseActiveAgents();
    assert.equal(attempts, 1, "ordinary ticks must not hot-loop a failed terminator");
    await assert.rejects(
      manager.cancelAgent({
        workspaceId: "ws_retry_control",
        workspaceRoot: f.repo,
        agentId: started.agentId,
      }),
      (error: any) => error.code === "WORKER_TERMINATION_FAILED",
    );
    assert.equal(attempts, 2, "explicit cancel retries the same pending generation exactly once");
  } finally {
    f.clean();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("G3 T8 — concurrent continuation admits one generation and one launcher", async () => {
  const f = setupGitFixture();
  let launches = 0;
  const { manager, clean } = setupManager({}, undefined, async () => { launches += 1; });
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_concurrent_continue",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "turn A",
      profiles: mockProfiles,
    });
    settleForContinuation(manager, started.agentId, { latestResponse: "turn A done" });
    const beforeGeneration = manager.getRecordByPrefixOrId(started.agentId)!.lifecycleState!.lastSettledGeneration;
    const results = await Promise.allSettled([
      manager.continueAgent({
        workspaceId: "ws_concurrent_continue",
        workspaceRoot: f.repo,
        agentId: started.agentId,
        prompt: "turn B first",
      }),
      manager.continueAgent({
        workspaceId: "ws_concurrent_continue",
        workspaceRoot: f.repo,
        agentId: started.agentId,
        prompt: "turn B second",
      }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(launches, 2, "start plus exactly one continuation launch");
    const current = manager.getRecordByPrefixOrId(started.agentId)!;
    assert.equal(current.status, "starting");
    assert.notEqual(current.lifecycleState!.activeTurn!.generation, beforeGeneration);
  } finally {
    f.clean();
    clean();
  }
});

test("G3 T12 — launcher PID is persisted under the active generation before claim", async () => {
  const f = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-launcher-pid-bind-"));
  const terminatedPids: number[] = [];
  const manager = new LocalAgentSessionManager(
    { stateDir, subagents: true, oauth: { scopes: ["devspace"] }, agentMaxConcurrent: 1, toolchains: [] } as any,
    async () => 3601,
    async (record) => { terminatedPids.push(record.workerPid!); return true; },
  );
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_launcher_pid",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "bind pid",
      profiles: mockProfiles,
    });
    const record = manager.getRecordByPrefixOrId(started.agentId)!;
    assert.equal(record.workerPid, 3601);
    assert.equal(record.lifecycleState!.activeTurn!.launchState, "spawned");
    assert.equal(typeof record.lifecycleState!.activeTurn!.generation, "string");
    await manager.cancelAgent({
      workspaceId: "ws_launcher_pid",
      workspaceRoot: f.repo,
      agentId: started.agentId,
    });
    assert.deepEqual(terminatedPids, [3601]);
  } finally {
    f.clean();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("G3 P1 — invalid persisted execution timestamp reopens corrupt and cannot bypass supervision", async () => {
  const f = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-invalid-execution-clock-"));
  const first = new LocalAgentSessionManager(
    { stateDir, subagents: true, oauth: { scopes: ["devspace"] }, agentMaxConcurrent: 1, toolchains: [] } as any,
    async () => undefined,
    async () => true,
  );
  let reopened: LocalAgentSessionManager | undefined;
  let terminationAttempts = 0;
  try {
    const started = await first.startAgent({
      workspaceId: "ws_invalid_clock",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "invalid clock",
      profiles: mockProfiles,
      executionContract: { maxExecutionMs: 1 },
    });
    const store = (first as any).store as LocalAgentStore;
    const record = store.getById(started.agentId)!;
    store.claimWorker(started.agentId, record.workerToken!, 3502);
    const claimed = store.getById(started.agentId)!;
    (first as any).store.close();
    const database = new Database(databasePath(stateDir));
    database.prepare("update local_agent_sessions set lifecycle_state = ? where id = ?").run(
      JSON.stringify({
        ...(claimed.lifecycleState as any),
        lifecycleKind: "detached_worker_v2",
        activeTurn: {
          ...(claimed.lifecycleState as any).activeTurn,
          executionStartedAt: "invalid",
        },
      }),
      started.agentId,
    );
    database.close();
    reopened = new LocalAgentSessionManager(
      { stateDir, subagents: true, oauth: { scopes: ["devspace"] }, agentMaxConcurrent: 1, toolchains: [] } as any,
      async () => undefined,
      async () => { terminationAttempts += 1; return true; },
    );
    await reopened.superviseActiveAgents();
    const status = await reopened.getAgentStatus({
      workspaceId: "ws_invalid_clock",
      workspaceRoot: f.repo,
      agentId: started.agentId,
    });
    assert.equal(status.terminal, false);
    assert.equal((status as any).termination?.corrupt, true);
    assert.equal(reopened.runningCount(), 1);
    assert.equal(terminationAttempts, 0, "corrupt clock must surface blocked, not silently run timeout arithmetic");
    await assert.rejects(
      reopened.continueAgent({
        workspaceId: "ws_invalid_clock",
        workspaceRoot: f.repo,
        agentId: started.agentId,
        prompt: "must not continue",
      }),
      (error: any) => error.code === "AGENT_LIFECYCLE_CORRUPT",
    );
    await assert.rejects(
      reopened.cleanupAgentScratch(started.agentId),
      (error: any) => error.code === "AGENT_LIFECYCLE_CORRUPT",
    );
  } finally {
    try { (reopened as any)?.store.close(); } catch {}
    f.clean();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// TEST Q: Execution transition wins stale startup timeout race
test("G3 TEST Q — execution transition wins stale startup timeout race", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: {
        maxStartupMs: 50,
      },
    });

    const store = (manager as any).store;
    const workerToken = "token-race-q";
    store.prepareWorker(started.agentId, workerToken);
    store.claimWorker(started.agentId, workerToken, 12345);

    // Exact worker executes markExecutionStarted first
    const e1 = "2026-01-01T00:00:10.000Z";
    store.markExecutionStarted(started.agentId, workerToken, e1);

    // Now a stale startup timeout observer attempts to fence based on startup budget
    const fenceResult = store.fenceActiveTurn({
      agentId: started.agentId,
      expectedPhase: "startup",
      budgetMs: 50,
      terminalReason: "timeout",
      error: "stale startup timeout attempt",
    });

    assert.equal(fenceResult.applied, false, "Startup timeout fence must NOT apply to an active execution turn");
    const record = store.getById(started.agentId);
    assert.equal(record?.status, "running", "Agent status must remain running");
    assert.equal(record?.lifecycleState?.activeTurn?.executionStartedAt, e1, "executionStartedAt must remain e1");
  } finally {
    f.clean();
    clean();
  }
});

// TEST R: Completion wins before stale timeout fence
test("G3 TEST R — completion wins before stale timeout fence", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
    });

    const store = (manager as any).store;
    const workerToken = "token-race-r";
    store.prepareWorker(started.agentId, workerToken);
    store.claimWorker(started.agentId, workerToken, 12345);

    // Worker completes successfully
    store.finishWorker(started.agentId, workerToken, {
      status: "idle",
      latestResponse: "done successfully",
      terminalReason: "completed",
    });

    // Stale timeout fence attempts to apply
    const fenceResult = store.fenceActiveTurn({
      agentId: started.agentId,
      expectedPhase: "any",
      budgetMs: 10,
      terminalReason: "timeout",
      error: "stale timeout attempt",
    });

    assert.equal(fenceResult.applied, false, "Timeout fence must not overwrite completed turn");
    const record = store.getById(started.agentId);
    assert.equal(record?.status, "idle");
    assert.equal(record?.terminalReason, "completed");
    assert.equal(record?.latestResponse, "done successfully");
  } finally {
    f.clean();
    clean();
  }
});

// TEST S: Real production OMP helper slow readiness
test("G3 TEST S — real production helper slow readiness", async () => {
  const { runOmpAcpSession } = await import("./local-agent-omp.js");
  const events: string[] = [];

  const fakeAgent = {
    async request(method: string) {
      if (method === "initialize") {
        events.push("initialize:start");
        await new Promise((r) => setTimeout(r, 20));
        events.push("initialize:done");
        return { agentCapabilities: { sessionCapabilities: { resume: true } } };
      }
      if (method === "session/new") {
        events.push("session.new:start");
        await new Promise((r) => setTimeout(r, 20));
        events.push("session.new:done");
        return { sessionId: "sess-omp-s" };
      }
      if (method === "session/prompt") {
        events.push("session.prompt:start");
        return { response: "prompt result" };
      }
      return {};
    },
  };

  const methods = {
    agent: {
      initialize: "initialize",
      session: {
        new: "session/new",
        resume: "session/resume",
        prompt: "session/prompt",
      },
    },
  };

  const callbacks = {
    onExecutionStarted: async () => {
      events.push("callback:executionStarted");
    },
  };

  await runOmpAcpSession(
    fakeAgent,
    methods,
    "1.0",
    { prompt: "run task", workspaceRoot: "." },
    callbacks,
  );

  assert.deepEqual(events, [
    "initialize:start",
    "initialize:done",
    "session.new:start",
    "session.new:done",
    "callback:executionStarted",
    "session.prompt:start",
  ], "executionStarted must only trigger after session readiness is complete and before prompt");
});

// TEST T: OMP callback failure prevents prompt dispatch
test("G3 TEST T — OMP callback failure prevents prompt dispatch", async () => {
  const { runOmpAcpSession } = await import("./local-agent-omp.js");
  let promptSent = false;

  const fakeAgent = {
    async request(method: string) {
      if (method === "initialize") {
        return { agentCapabilities: { sessionCapabilities: { resume: true } } };
      }
      if (method === "session/new") {
        return { sessionId: "sess-omp-t" };
      }
      if (method === "session/prompt") {
        promptSent = true;
        return { response: "should not be called" };
      }
      return {};
    },
  };

  const methods = {
    agent: {
      initialize: "initialize",
      session: {
        new: "session/new",
        resume: "session/resume",
        prompt: "session/prompt",
      },
    },
  };

  const callbacks = {
    onExecutionStarted: async () => {
      throw new Error("Worker was fenced by supervisor due to timeout");
    },
  };

  await assert.rejects(
    runOmpAcpSession(
      fakeAgent,
      methods,
      "1.0",
      { prompt: "run task", workspaceRoot: "." },
      callbacks,
    ),
    /Worker was fenced by supervisor/,
  );

  assert.equal(promptSent, false, "When onExecutionStarted throws, session.prompt must NOT be sent");
});

// TEST U: Continuation blocked while terminator pending
test("G3 TEST U — continuation blocked while terminator pending", async () => {
  const f = setupGitFixture();
  let terminatorEntered = false;
  let releaseTerminator!: () => void;
  const terminatorHoldPromise = new Promise<void>((resolve) => {
    releaseTerminator = resolve;
  });

  const customTerminator = async (record: any) => {
    terminatorEntered = true;
    await terminatorHoldPromise;
    return true;
  };

  const stateDir = mkdtempSync(join(tmpdir(), "devspace-race-u-"));
  const config = {
    stateDir,
    subagents: true,
    oauth: { scopes: ["devspace"] },
    agentMaxConcurrent: 8,
    toolchains: [],
  } as any;

  const manager = new LocalAgentSessionManager(
    config,
    async () => undefined,
    customTerminator,
  );

  try {
    const store = (manager as any).store;
    const started = store.create({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      provider: "claude",
      lifecycleKind: "detached_worker_v2",
      executionContract: {
        maxStartupMs: 40,
      },
    });

    const workerToken = "token-race-u";
    store.prepareWorker(started.id, workerToken);
    store.claimWorker(started.id, workerToken, 12345);

    // Wait for startup timeout to exceed
    await new Promise((r) => setTimeout(r, 60));

    // Launch supervisor in background
    const supervisePromise = manager.superviseActiveAgents();

    // Poll until terminator is entered
    while (!terminatorEntered) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Record is error and termination is pending
    const recordWhileTerminating = store.getById(started.id);
    assert.equal(recordWhileTerminating?.status, "error");
    assert.equal(recordWhileTerminating?.lifecycleState?.termination?.pending, true);

    // Continuation attempt MUST fail with AGENT_TERMINATION_PENDING
    await assert.rejects(
      manager.continueAgent({
        workspaceId: "ws_1",
        workspaceRoot: f.repo,
        agentId: started.id,
        prompt: "continue prompt",
      }),
      (err: any) => {
        assert.equal(err.code, "AGENT_TERMINATION_PENDING");
        return true;
      },
      "Continuation must be rejected when physical worker termination is pending",
    );

    // Release terminator and wait for supervision to finish
    releaseTerminator();
    await supervisePromise;

    // After successful termination, termination pending is cleared
    const recordAfter = store.getById(started.id);
    assert.equal(recordAfter?.lifecycleState?.termination, undefined);
  } finally {
    f.clean();
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {}
  }
});

// TEST V: Termination failure keeps continuation blocked
test("G3 TEST V — termination failure keeps continuation blocked", async () => {
  const f = setupGitFixture();
  const customTerminator = async (record: any) => {
    return false; // Termination could not be verified
  };

  const stateDir = mkdtempSync(join(tmpdir(), "devspace-race-v-"));
  const config = {
    stateDir,
    subagents: true,
    oauth: { scopes: ["devspace"] },
    agentMaxConcurrent: 8,
    toolchains: [],
  } as any;

  const manager = new LocalAgentSessionManager(
    config,
    async () => undefined,
    customTerminator,
  );

  try {
    const store = (manager as any).store;
    const started = store.create({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      provider: "claude",
      lifecycleKind: "detached_worker_v2",
      executionContract: {
        maxStartupMs: 40,
      },
    });

    const workerToken = "token-race-v";
    store.prepareWorker(started.id, workerToken);
    store.claimWorker(started.id, workerToken, 12345);

    // Wait for startup timeout to exceed and supervise
    await new Promise((r) => setTimeout(r, 60));
    await manager.superviseActiveAgents();

    const record = store.getById(started.id);
    assert.equal(record?.status, "error");
    assert.equal(record?.lifecycleState?.termination?.pending, true);
    assert.match(record?.error ?? "", /Worker termination could not be verified/);

    // Continuation must still be blocked
    await assert.rejects(
      manager.continueAgent({
        workspaceId: "ws_1",
        workspaceRoot: f.repo,
        agentId: started.id,
        prompt: "continue prompt",
      }),
      (err: any) => {
        assert.equal(err.code, "AGENT_TERMINATION_PENDING");
        return true;
      },
    );
  } finally {
    f.clean();
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {}
  }
});

// TEST W: Successful termination unlocks continuation
test("G3 TEST W — successful termination unlocks continuation", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    const store = (manager as any).store;
    const started = store.create({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      provider: "claude",
      lifecycleKind: "detached_worker_v2",
      executionContract: {
        maxStartupMs: 40,
      },
    });

    const workerToken = "token-race-w";
    store.prepareWorker(started.id, workerToken);
    store.claimWorker(started.id, workerToken, 12345);

    // Timeout occurs and supervisor successfully terminates worker
    await new Promise((r) => setTimeout(r, 60));
    await manager.superviseActiveAgents();

    const recordBefore = store.getById(started.id);
    assert.equal(recordBefore?.status, "error");
    assert.equal(recordBefore?.lifecycleState?.termination, undefined);

    // Continuation is now permitted
    await manager.continueAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      agentId: started.id,
      prompt: "continue prompt",
    });

    const recordAfter = store.getById(started.id);
    assert.equal(recordAfter?.status, "starting");
    assert.ok(recordAfter?.lifecycleState?.activeTurn?.turnStartedAt);
  } finally {
    f.clean();
    clean();
  }
});

// TEST X: Stale cleanup callback cannot touch newer generation
test("G3 TEST X — stale cleanup callback cannot touch newer generation", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    const store = (manager as any).store;
    const started = store.create({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      provider: "claude",
      lifecycleKind: "detached_worker_v2",
      executionContract: { maxStartupMs: 40 },
    });

    const workerTokenA = "token-gen-a";
    store.prepareWorker(started.id, workerTokenA);
    store.claimWorker(started.id, workerTokenA, 12345);

    // Timeout generation A
    const fenceResultA = store.fenceActiveTurn({
      agentId: started.id,
      terminalReason: "timeout",
      error: "timeout A",
    });
    const terminationIdA = fenceResultA.terminationId!;
    assert.ok(terminationIdA);

    // Complete generation A
    store.completeTermination(started.id, terminationIdA, true);

    // Start generation B via continuation
    await manager.continueAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      agentId: started.id,
      prompt: "turn B",
    });

    const workerTokenB = "token-gen-b";
    store.prepareWorker(started.id, workerTokenB);
    store.claimWorker(started.id, workerTokenB, 67890);

    const recordBBefore = store.getById(started.id);
    assert.equal(recordBBefore?.status, "running");
    assert.equal(recordBBefore?.workerToken, workerTokenB);

    // Stale generation A completion attempts to touch record B
    store.completeTermination(started.id, terminationIdA, true);
    store.completeTermination(started.id, terminationIdA, false);

    const recordBAfter = store.getById(started.id);
    assert.equal(recordBAfter?.status, "running", "Stale cleanup callback must not mutate newer generation status");
    assert.equal(recordBAfter?.workerToken, workerTokenB, "Stale cleanup callback must not touch workerToken");
  } finally {
    f.clean();
    clean();
  }
});

// TEST Y: Termination-pending counts against capacity
test("G3 TEST Y — termination-pending counts against capacity", async () => {
  const f = setupGitFixture();
  let releaseTerminatorA!: () => void;
  const holdTerminatorA = new Promise<void>((resolve) => {
    releaseTerminatorA = resolve;
  });

  let agentAId = "";
  const customTerminator = async (record: any) => {
    if (record.id === agentAId) {
      await holdTerminatorA;
    }
    return true;
  };

  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cap-y-"));
  const config = {
    stateDir,
    subagents: true,
    oauth: { scopes: ["devspace"] },
    agentMaxConcurrent: 1, // Max concurrent is 1
    toolchains: [],
  } as any;

  const manager = new LocalAgentSessionManager(
    config,
    async () => undefined,
    customTerminator,
  );

  try {
    const store = (manager as any).store;
    // Direct store fixture for Agent A (uses real generated id)
    const agentA = store.create({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      provider: "claude",
      lifecycleKind: "detached_worker_v2",
    });
    agentAId = agentA.id;
    const tokenA = "token-a";
    store.prepareWorker(agentAId, tokenA);
    store.claimWorker(agentAId, tokenA, 101);

    // Fence Agent A to error with pending termination
    store.fenceActiveTurn({
      agentId: agentAId,
      terminalReason: "timeout",
      error: "timed out",
    });

    assert.equal(manager.runningCount(), 1, "Termination pending must count towards runningCount");

    // Capacity must be exhausted while termination is pending
    assert.equal((manager as any).hasExecutionCapacity(), false, "Capacity must be exhausted while termination is pending");

    // Clear Agent A termination
    const agentARecord = store.getById(agentAId);
    assert.ok(agentARecord?.lifecycleState?.termination?.terminationId);
    store.completeTermination(agentAId, agentARecord.lifecycleState.termination.terminationId, true);

    assert.equal(manager.runningCount(), 0, "runningCount must be 0 after termination cleared");
    assert.equal((manager as any).hasExecutionCapacity(), true, "Capacity must reopen after termination cleared");
  } finally {
    f.clean();
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {}
  }
});

test("AC-5 dependency bridge rejects stale workspace evidence before worker launch", async () => {
  const f = setupGitFixture();
  const dependencyRoot = mkdtempSync(join(tmpdir(), "devspace-contract-dependencies-"));
  const lock = JSON.stringify({ name: "expected", lockfileVersion: 3 });
  const lockfileSha256 = createHash("sha256").update(lock).digest("hex");
  writeFileSync(join(dependencyRoot, "package-lock.json"), lock);
  mkdirSync(join(dependencyRoot, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(f.repo, "package-lock.json"), `${lock}\n`);
  const { manager, clean } = setupManager({
    toolchains: [{
      id: "node",
      root: dependencyRoot,
      verifiers: {},
      dependencyBridge: { lockfileSha256, packages: {} },
    }],
  });
  try {
    await assert.rejects(
      manager.startAgent({
        workspaceId: "ws_1",
        workspaceRoot: f.repo,
        profileName: "reviewer",
        prompt: "do work",
        profiles: mockProfiles,
        executionContract: { toolchainId: "node" },
      }),
      (err: any) => err.code === "TOOLCHAIN_UNAVAILABLE" && /workspace lockfile is stale/.test(err.message),
    );
    assert.equal(manager.listAgents({ workspaceId: "ws_1" }).length, 0);
  } finally {
    rmSync(dependencyRoot, { recursive: true, force: true });
    f.clean();
    clean();
  }
});

// AC-11: no secrets appear in preflight/reconcile/status output.
test("AC-11 no secrets in preflight or reconcile output", async () => {
  const f = setupGitFixture();
  const sentinel = "SENTINEL_SUPER_SECRET_12345";
  const { manager, clean } = setupManager();
  try {
    process.env.DEVSPACE_OAUTH_OWNER_TOKEN = sentinel;
    try {
      const preflight = await manager.preflightAgent({
        workspaceId: "ws_1",
        workspaceRoot: f.repo,
        isolated: true,
        profileName: "reviewer",
        profiles: mockProfiles,
      });
      assert.ok(!JSON.stringify(preflight).includes(sentinel));

      const started = await manager.startAgent({
        workspaceId: "ws_1",
        workspaceRoot: f.repo,
        profileName: "reviewer",
        prompt: "hello",
        profiles: mockProfiles,
      });
      const reconciled = await manager.reconcileAgent({
        workspaceId: "ws_1",
        workspaceRoot: f.repo,
        isolated: true,
        agentId: started.agentId,
      });
      assert.ok(!JSON.stringify(reconciled).includes(sentinel));
    } finally {
      delete process.env.DEVSPACE_OAUTH_OWNER_TOKEN;
    }
  } finally {
    f.clean();
    clean();
  }
});

// Pure scope-classification helpers.
test("scope helpers classify worker-caused changes correctly", () => {
  const baseline = ["pre-existing.txt"];
  assert.deepEqual(
    workerChangedPathsSinceBaseline(["pre-existing.txt", "src/new.ts"], baseline),
    ["src/new.ts"],
  );
  assert.deepEqual(
    classifyScopeState(["src/new.ts"], ["src"]),
    { scopeState: "WITHIN_SCOPE", unexpectedPaths: [] },
  );
  const violation = classifyScopeState(["src/new.ts", "leaked.txt"], ["src"]);
  assert.equal(violation.scopeState, "SCOPE_VIOLATION");
  assert.deepEqual(violation.unexpectedPaths, ["leaked.txt"]);
  assert.deepEqual(classifyScopeState(["a.txt"], undefined), {
    scopeState: "UNKNOWN",
    unexpectedPaths: [],
  });
});

// Capacity: explicit NO_EXECUTION_CAPACITY when at the configured limit.
test("agent_start returns NO_EXECUTION_CAPACITY when at capacity", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager({ agentMaxConcurrent: 1 });
  try {
    const first = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "first",
      profiles: mockProfiles,
    });
    assert.equal(first.status, "starting");
    await assert.rejects(
      manager.startAgent({
        workspaceId: "ws_1",
        workspaceRoot: f.repo,
        profileName: "reviewer",
        prompt: "second",
        profiles: mockProfiles,
      }),
      (err: any) => err.code === "NO_EXECUTION_CAPACITY",
    );
  } finally {
    f.clean();
    clean();
  }
});

test("agent_start attemptKey concurrently reuses one durable launch", async () => {
  const f = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-replay-state-"));
  let launches = 0;
  const manager = new LocalAgentSessionManager(
    {
      stateDir,
      subagents: true,
      oauth: { scopes: ["devspace"] },
      agentMaxConcurrent: 1,
      toolchains: [],
    } as any,
    async () => { launches += 1; },
  );
  try {
    const input = {
      workspaceId: "ws_replay",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "bounded work",
      profiles: mockProfiles,
      attemptKey: "issue-517-attempt-1",
      executionContract: { expectedHead: f.head, writePaths: ["src"], maxFiles: 1 },
    };
    const [first, replay] = await Promise.all([
      manager.startAgent(input),
      manager.startAgent(input),
    ]);

    assert.equal(replay.agentId, first.agentId);
    assert.equal(launches, 1);
    assert.equal(manager.listAgents({ workspaceId: "ws_replay" }).length, 1);
  } finally {
    f.clean();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("agent_start attemptKey binding survives store reopen and rejects material conflicts", async () => {
  const f = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-replay-reopen-state-"));
  const config = {
    stateDir,
    subagents: true,
    oauth: { scopes: ["devspace"] },
    agentMaxConcurrent: 8,
    toolchains: [],
  } as any;
  let firstLaunches = 0;
  let reopenedLaunches = 0;
  const firstManager = new LocalAgentSessionManager(config, async () => { firstLaunches += 1; });
  const reopenedManager = new LocalAgentSessionManager(config, async () => { reopenedLaunches += 1; });
  const baseProfile = mockProfiles[0]!;
  const baseInput = {
    workspaceId: "ws_replay_reload",
    workspaceRoot: f.repo,
    profileName: "reviewer",
    prompt: "bounded work",
    profiles: mockProfiles,
    attemptKey: "durable-attempt",
    executionContract: { writePaths: ["src"], maxFiles: 2 },
  };
  try {
    const first = await firstManager.startAgent(baseInput);
    const replay = await reopenedManager.startAgent(baseInput);
    assert.equal(replay.agentId, first.agentId);
    assert.equal(firstLaunches, 1);
    assert.equal(reopenedLaunches, 0);

    const conflicts = [
      { ...baseInput, prompt: "different prompt" },
      { ...baseInput, profileName: "other", profiles: [{ ...baseProfile, name: "other" }] },
      { ...baseInput, profiles: [{ ...baseProfile, model: "different-model" }] },
      { ...baseInput, profiles: [{ ...baseProfile, effort: "xhigh" }] },
      { ...baseInput, profiles: [{ ...baseProfile, write_mode: "allowed" as const }] },
      { ...baseInput, executionContract: { writePaths: ["src", "test"], maxFiles: 2 } },
    ];
    for (const conflict of conflicts) {
      await assert.rejects(
        reopenedManager.startAgent(conflict),
        (error: any) => error.code === "ATTEMPT_REPLAY_CONFLICT",
      );
    }
  } finally {
    f.clean();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("agent_start replay survives restart when reopen returns a new workspaceId for the same physical checkout", async () => {
  const f = setupGitFixture();
  const other = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-replay-workspace-reopen-state-"));
  const config = {
    stateDir,
    subagents: true,
    oauth: { scopes: ["devspace"] },
    agentMaxConcurrent: 8,
    toolchains: [],
    allowedRoots: [f.root, other.root],
    worktreeRoot: join(stateDir, "worktrees"),
    agentDir: join(stateDir, "agents"),
    devspaceAgentsDir: join(stateDir, "agents"),
  } as any;
  let firstLaunches = 0;
  let reopenedLaunches = 0;
  const firstWorkspaceStore = new SqliteWorkspaceStore(stateDir);
  const firstRegistry = new WorkspaceRegistry(config, firstWorkspaceStore);
  const firstWorkspace = await firstRegistry.openWorkspace(f.repo);
  const firstManager = new LocalAgentSessionManager(config, async () => { firstLaunches += 1; });
  try {
    const input = {
      workspaceId: firstWorkspace.workspace.id,
      workspaceRoot: firstWorkspace.workspace.root,
      profileName: "reviewer",
      prompt: "restart-safe work",
      profiles: mockProfiles,
      attemptKey: "restart-safe-attempt",
      executionContract: { writePaths: ["src"] },
    };
    const first = await firstManager.startAgent(input);
    firstWorkspaceStore.close();

    const reopenedWorkspaceStore = new SqliteWorkspaceStore(stateDir);
    try {
      const reopenedRegistry = new WorkspaceRegistry(config, reopenedWorkspaceStore);
      const reopenedWorkspace = await reopenedRegistry.openWorkspace(f.repo);
      assert.notEqual(reopenedWorkspace.workspace.id, firstWorkspace.workspace.id);

      const reopenedManager = new LocalAgentSessionManager(config, async () => { reopenedLaunches += 1; });
      const replay = await reopenedManager.startAgent({
        ...input,
        workspaceId: reopenedWorkspace.workspace.id,
        workspaceRoot: reopenedWorkspace.workspace.root,
      });
      assert.equal(replay.agentId, first.agentId);
      assert.equal(firstLaunches, 1);
      assert.equal(reopenedLaunches, 0);

      await assert.rejects(
        reopenedManager.startAgent({
          ...input,
          workspaceId: reopenedWorkspace.workspace.id,
          workspaceRoot: reopenedWorkspace.workspace.root,
          prompt: "conflicting restart work",
        }),
        (error: any) => error.code === "ATTEMPT_REPLAY_CONFLICT",
      );
      assert.equal(reopenedLaunches, 0);

      const otherWorkspace = await reopenedRegistry.openWorkspace(other.repo);
      const otherAttempt = await reopenedManager.startAgent({
        ...input,
        workspaceId: otherWorkspace.workspace.id,
        workspaceRoot: otherWorkspace.workspace.root,
      });
      assert.notEqual(otherAttempt.agentId, first.agentId);
      assert.equal(reopenedLaunches, 1);
    } finally {
      reopenedWorkspaceStore.close();
    }
  } finally {
    f.clean();
    other.clean();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("agent_start without attemptKey remains non-idempotent", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    const input = {
      workspaceId: "ws_no_replay",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "same request",
      profiles: mockProfiles,
    };
    const first = await manager.startAgent(input);
    const second = await manager.startAgent(input);
    assert.notEqual(second.agentId, first.agentId);
    assert.equal(manager.listAgents({ workspaceId: "ws_no_replay" }).length, 2);
  } finally {
    f.clean();
    clean();
  }
});

test("provider failure preserves session, response evidence, and physical candidate", async () => {
  const f = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-provider-evidence-state-"));
  let launched: { promptFile: string; workerToken: string } | undefined;
  const manager = new LocalAgentSessionManager(
    {
      stateDir,
      subagents: true,
      oauth: { scopes: ["devspace"] },
      agentMaxConcurrent: 8,
      toolchains: [],
      devspaceAgentsDir: join(stateDir, "agents"),
    } as any,
    async (_agentId, promptFile, workerToken) => {
      launched = { promptFile, workerToken };
    },
    undefined,
    async () => {
      mkdirSync(join(f.repo, "src"), { recursive: true });
      writeFileSync(join(f.repo, "src", "candidate.ts"), "export const candidate = true;\n");
      throw new LocalAgentProviderError("provider timed out after the completed turn", {
        providerSessionId: "conversation-usable-123",
        finalResponse: "I changed src/candidate.ts before the provider rejected the turn.",
      });
    },
  );
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_provider_evidence",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "make the bounded change",
      profiles: mockProfiles,
      executionContract: { writePaths: ["src"] },
    });
    assert.ok(launched);
    await manager.runWorkerTurnFromFile(started.agentId, launched.promptFile, launched.workerToken);

    const status = await manager.getAgentStatus({
      workspaceId: "ws_provider_evidence",
      workspaceRoot: f.repo,
      agentId: started.agentId,
    });
    assert.equal(status.status, "error");
    assert.equal(status.terminalReason, "provider_error");
    assert.equal(status.providerSessionId, "conversation-usable-123");
    assert.equal(status.latestResponse, "I changed src/candidate.ts before the provider rejected the turn.");
    assert.match(status.error ?? "", /provider timed out/);

    const reconciled = await manager.reconcileAgent({
      workspaceId: "ws_provider_evidence",
      workspaceRoot: f.repo,
      isolated: true,
      agentId: started.agentId,
    });
    assert.equal(reconciled.agentState, "error");
    assert.equal(reconciled.terminalReason, "provider_error");
    assert.equal(reconciled.providerSessionId, "conversation-usable-123");
    assert.equal(reconciled.candidate.present, true);
    assert.deepEqual(reconciled.candidate.changedPaths, ["src/candidate.ts"]);
    assert.equal(reconciled.candidate.scopeState, "WITHIN_SCOPE");
  } finally {
    f.clean();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ─── Dirty-baseline fingerprint/delta regression tests ───────────────────────

type PhysicalState = Awaited<ReturnType<typeof inspectWorkspacePhysicalState>>;

function baselineFromState(state: PhysicalState): ScopeBaseline {
  return { changedPaths: state.changedPaths, head: state.head ?? null, fingerprints: state.fingerprints };
}

// 1. PHYSICAL SNAPSHOT: kind derivation for modified/untracked/deleted paths.
test("physical snapshot fingerprints modified, untracked, and deleted paths", async () => {
  const f = setupGitFixture();
  try {
    writeFileSync(join(f.repo, "tracked.txt"), "tracked v1");
    writeFileSync(join(f.repo, "delete-me.txt"), "delete me");
    runGitRaw(["add", "tracked.txt", "delete-me.txt"], f.repo);
    runGitRaw(["commit", "-m", "seed tracked files"], f.repo);

    writeFileSync(join(f.repo, "tracked.txt"), "tracked v2");
    writeFileSync(join(f.repo, "untracked.txt"), "untracked content");
    rmSync(join(f.repo, "delete-me.txt"));

    const state = await inspectWorkspacePhysicalState(f.repo);
    assert.ok(state.fingerprints);

    const modified = state.fingerprints["tracked.txt"];
    assert.ok(modified);
    assert.equal(modified.kind, "modified");
    assert.match(modified.contentHash ?? "", /^[0-9a-f]{64}$/);
    assert.ok(modified.size > 0);

    const untracked = state.fingerprints["untracked.txt"];
    assert.ok(untracked);
    assert.equal(untracked.kind, "untracked");
    assert.ok(untracked.contentHash && untracked.contentHash.length === 64);
    assert.ok(untracked.size > 0);

    const deleted = state.fingerprints["delete-me.txt"];
    assert.ok(deleted);
    assert.equal(deleted.kind, "deleted");
    assert.equal(deleted.contentHash, null);
    assert.equal(deleted.size, 0);
  } finally {
    f.clean();
  }
});

test("candidate diffHash changes with untracked bytes at a stable path", async () => {
  const f = setupGitFixture();
  try {
    const candidate = join(f.repo, "untracked.txt");
    writeFileSync(candidate, "first bytes");
    const first = await inspectWorkspacePhysicalState(f.repo);
    const unchanged = await inspectWorkspacePhysicalState(f.repo);
    assert.ok(first.diffHash);
    assert.equal(unchanged.diffHash, first.diffHash);
    assert.deepEqual(unchanged.changedPaths, first.changedPaths);

    writeFileSync(candidate, "other bytes");
    const mutated = await inspectWorkspacePhysicalState(f.repo);
    assert.deepEqual(mutated.changedPaths, first.changedPaths);
    assert.notEqual(mutated.diffHash, first.diffHash);
  } finally {
    f.clean();
  }
});

// 2. DELTA UNTOUCHED: a pre-existing dirty path unchanged after the modern
// baseline is NOT attributed to the worker, with attribution KNOWN.
test("delta does not attribute an untouched pre-existing dirty path", async () => {
  const f = setupGitFixture();
  try {
    writeFileSync(join(f.repo, "pre-existing-outside.txt"), "v1");
    const baseline = baselineFromState(await inspectWorkspacePhysicalState(f.repo));
    assert.ok(baseline.fingerprints);

    const current = await inspectWorkspacePhysicalState(f.repo);
    const delta = computeWorkerDelta(current, baseline);
    assert.equal(delta.attribution, "KNOWN");
    assert.ok(!delta.changedPaths.includes("pre-existing-outside.txt"));
  } finally {
    f.clean();
  }
});

// 3. DELTA MODIFIED AGAIN: the same pre-existing dirty path modified after the
// modern baseline IS attributed to the worker, with attribution KNOWN.
test("delta attributes a pre-existing dirty path modified again", async () => {
  const f = setupGitFixture();
  try {
    writeFileSync(join(f.repo, "pre-existing-outside.txt"), "v1");
    const baseline = baselineFromState(await inspectWorkspacePhysicalState(f.repo));
    assert.ok(baseline.fingerprints);

    writeFileSync(join(f.repo, "pre-existing-outside.txt"), "v2");
    const current = await inspectWorkspacePhysicalState(f.repo);
    const delta = computeWorkerDelta(current, baseline);
    assert.equal(delta.attribution, "KNOWN");
    assert.ok(delta.changedPaths.includes("pre-existing-outside.txt"));
  } finally {
    f.clean();
  }
});

// 4. END-TO-END SUPERVISOR: a modern fingerprint baseline protects a
// pre-existing dirty out-of-scope file until the worker touches it again.
test("supervisor ignores untouched pre-existing dirty path and terminates on re-modification", async () => {
  const f = setupGitFixture();
  const { manager, terminated, clean } = setupManager();
  try {
    const leaked = join(f.repo, "leaked-outside.txt");
    writeFileSync(leaked, "v1");
    const baseline = baselineFromState(await inspectWorkspacePhysicalState(f.repo));

    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: { writePaths: ["src"] },
    });
    const record = manager.getRecordByPrefixOrId(started.agentId);
    assert.ok(record);
    claimDetachedTurn(manager, record.id, 9999998, baseline);

    // Untouched pre-existing dirty path: must not terminate.
    await manager.superviseActiveAgents();
    const untouched = manager.getRecordByPrefixOrId(record.id);
    assert.equal(untouched?.status, "running");
    assert.equal(terminated.length, 0);

    // Modify the same pre-existing dirty path again: definite violation.
    writeFileSync(leaked, "v2");
    await manager.superviseActiveAgents();
    const after = manager.getRecordByPrefixOrId(record.id);
    assert.ok(after);
    assert.equal(after.status, "error");
    assert.equal(after.terminalReason, "scope_violation");
    assert.equal(after.scopeState, "SCOPE_VIOLATION");
    assert.match(after.error ?? "", /leaked-outside\.txt/);
    assert.ok(terminated.some((entry) => entry.id === record.id));

    const reconciled = await manager.reconcileAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      isolated: true,
      agentId: record.id,
    });
    assert.equal(reconciled.candidate.scopeState, "SCOPE_VIOLATION");
    assert.ok(reconciled.candidate.unexpectedPaths.includes("leaked-outside.txt"));
  } finally {
    f.clean();
    clean();
  }
});

// maxFiles-only contract: no writePaths claimed, but the file-count bound is
// independently enforced by the supervisor against a modern baseline.
test("supervisor enforces maxFiles-only file-count bound", async () => {
  const f = setupGitFixture();
  const { manager, terminated, clean } = setupManager();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: { maxFiles: 1 },
    });
    const record = manager.getRecordByPrefixOrId(started.agentId);
    assert.ok(record);

    const baseline = baselineFromState(await inspectWorkspacePhysicalState(f.repo));
    claimDetachedTurn(manager, record.id, 9999997, baseline);

    writeFileSync(join(f.repo, "a.txt"), "a");
    writeFileSync(join(f.repo, "b.txt"), "b");

    await manager.superviseActiveAgents();

    const after = manager.getRecordByPrefixOrId(record.id);
    assert.ok(after);
    assert.equal(after.status, "error");
    assert.equal(after.terminalReason, "scope_violation");
    assert.equal(after.scopeState, "SCOPE_VIOLATION");
    assert.ok(terminated.some((entry) => entry.id === record.id));
  } finally {
    f.clean();
    clean();
  }
});

// 5. LEGACY BASELINE: non-empty changedPaths without fingerprints can never
// prove attribution, so delta and reconcile report UNKNOWN (never WITHIN_SCOPE)
// while newly dirty paths still appear as definite changedPaths.
test("legacy baseline without fingerprints yields UNKNOWN, never false WITHIN_SCOPE", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager();
  try {
    writeFileSync(join(f.repo, "pre-existing.txt"), "pre");
    const legacyBaseline: ScopeBaseline = { changedPaths: ["pre-existing.txt"], head: f.head };

    mkdirSync(join(f.repo, "src"), { recursive: true });
    writeFileSync(join(f.repo, "src", "new.ts"), "new within scope");

    const current = await inspectWorkspacePhysicalState(f.repo);
    const delta = computeWorkerDelta(current, legacyBaseline);
    assert.equal(delta.attribution, "UNKNOWN");
    assert.ok(delta.changedPaths.includes("src/new.ts"));
    assert.ok(!delta.changedPaths.includes("pre-existing.txt"));

    const started = await manager.startAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "do work",
      profiles: mockProfiles,
      executionContract: { writePaths: ["src"] },
    });
    claimDetachedTurn(manager, started.agentId, 9999996, legacyBaseline);

    // Within-scope new path: still UNKNOWN because overlap cannot be proven.
    const within = await manager.reconcileAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      isolated: true,
      agentId: started.agentId,
    });
    assert.equal(within.candidate.scopeState, "UNKNOWN");
    assert.ok(within.candidate.changedPaths.includes("src/new.ts"));

    // A newly dirty out-of-scope path is a proven violation even under legacy.
    writeFileSync(join(f.repo, "leaked.txt"), "bad");
    const leaked = await manager.reconcileAgent({
      workspaceId: "ws_1",
      workspaceRoot: f.repo,
      isolated: true,
      agentId: started.agentId,
    });
    assert.equal(leaked.candidate.scopeState, "SCOPE_VIOLATION");
    assert.ok(leaked.candidate.unexpectedPaths.includes("leaked.txt"));
  } finally {
    f.clean();
    clean();
  }
});

// 6. PARTIAL fingerprint baseline: one missing baseline fingerprint degrades
// attribution to UNKNOWN while definite paths are still reported. The one valid
// fingerprint carries a non-empty gitStateHash so it stays comparable; the
// other path has no fingerprint entry at all and keeps attribution UNKNOWN.
test("partial fingerprint baseline yields UNKNOWN but reports definite changed paths", async () => {
  const f = setupGitFixture();
  try {
    writeFileSync(join(f.repo, "pre-existing-a.txt"), "a");
    writeFileSync(join(f.repo, "pre-existing-b.txt"), "b");
    writeFileSync(join(f.repo, "new.txt"), "new");

    const partialBaseline: ScopeBaseline = {
      changedPaths: ["pre-existing-a.txt", "pre-existing-b.txt"],
      head: f.head,
      fingerprints: {
        "pre-existing-a.txt": {
          kind: "untracked",
          contentHash: "bogus-hash",
          size: 1,
          gitStateHash: "bogus-git-state-hash",
        },
      },
    };

    const current = await inspectWorkspacePhysicalState(f.repo);
    const delta = computeWorkerDelta(current, partialBaseline);
    assert.equal(delta.attribution, "UNKNOWN");
    assert.ok(delta.changedPaths.includes("pre-existing-a.txt"));
    assert.ok(delta.changedPaths.includes("new.txt"));
    assert.ok(!delta.changedPaths.includes("pre-existing-b.txt"));
  } finally {
    f.clean();
  }
});

// 7. STAGE-ONLY REGRESSION: an index-only mutation (git add with unchanged
// bytes) must still be detected. The baseline fingerprint carries a
// gitStateHash so staging the new blob flips the fingerprint even though the
// working-tree file bytes never changed.
test("delta detects a stage-only mutation via gitStateHash", async () => {
  const f = setupGitFixture();
  try {
    writeFileSync(join(f.repo, "outside.txt"), "A");
    runGitRaw(["add", "outside.txt"], f.repo);
    runGitRaw(["commit", "-m", "seed outside"], f.repo);

    writeFileSync(join(f.repo, "outside.txt"), "B");
    const baseline = baselineFromState(await inspectWorkspacePhysicalState(f.repo));
    const baselineFingerprint = baseline.fingerprints?.["outside.txt"];
    assert.ok(baselineFingerprint);
    assert.ok(
      typeof baselineFingerprint.gitStateHash === "string" &&
        baselineFingerprint.gitStateHash.length > 0,
    );

    runGitRaw(["add", "outside.txt"], f.repo);

    const current = await inspectWorkspacePhysicalState(f.repo);
    const delta = computeWorkerDelta(current, baseline);
    assert.equal(delta.attribution, "KNOWN");
    assert.ok(delta.changedPaths.includes("outside.txt"));
  } finally {
    f.clean();
  }
});

// 8. LEGACY FINGERPRINT WITHOUT GIT STATE: a fingerprint lacking gitStateHash
// is incomplete and must degrade attribution to UNKNOWN instead of falsely
// claiming KNOWN overlap for the same dirty path.
test("baseline fingerprint without gitStateHash degrades attribution to UNKNOWN", async () => {
  const f = setupGitFixture();
  try {
    writeFileSync(join(f.repo, "pre-existing.txt"), "pre");

    const legacyFingerprint = {
      kind: "untracked" as const,
      contentHash: "deadbeef",
      size: 3,
    };
    const legacyBaseline = {
      changedPaths: ["pre-existing.txt"],
      head: f.head,
      fingerprints: { "pre-existing.txt": legacyFingerprint },
    } as unknown as ScopeBaseline;

    const current = await inspectWorkspacePhysicalState(f.repo);
    const delta = computeWorkerDelta(current, legacyBaseline);
    assert.equal(delta.attribution, "UNKNOWN");
  } finally {
    f.clean();
  }
});

// 9. OVERLAP WITHOUT CURRENT FINGERPRINT: when the same path is present in both
// baseline and current, the baseline fingerprint is complete, but the current
// fingerprint is missing/incomplete, the path must NOT be claimed as definite
// worker change and attribution must degrade to UNKNOWN (no false-positive
// SCOPE_VIOLATION).
test("overlap with missing current fingerprint is not definite and yields UNKNOWN", () => {
  const baseline: ScopeBaseline = {
    changedPaths: ["pre-existing.txt"],
    head: "abc123",
    fingerprints: {
      "pre-existing.txt": {
        kind: "modified",
        contentHash: "aa11bb22",
        size: 5,
        gitStateHash: "baseline-git-state-hash",
      },
    },
  };
  const current: WorkspacePhysicalState = {
    gitAvailable: true,
    dirty: true,
    changedPaths: ["pre-existing.txt"],
  };
  const delta = computeWorkerDelta(current, baseline);
  assert.ok(!delta.changedPaths.includes("pre-existing.txt"));
  assert.equal(delta.attribution, "UNKNOWN");
});

// 10. SECURITY: a symlink inside the repo pointing outside the workspace is
// fingerprinted by its link-target text, never by the external target's bytes.
test("symlink fingerprint derives from link target text, not external target bytes", async () => {
  const f = setupGitFixture();
  try {
    const externalTarget = join(f.root, "external-target.txt");
    const linkPath = join(f.repo, "external-link.txt");
    writeFileSync(externalTarget, "external v1");
    symlinkSync(externalTarget, linkPath);

    const linkRel = "external-link.txt";
    const first = await inspectWorkspacePhysicalState(f.repo);
    assert.ok(first.fingerprints);
    const firstFp = first.fingerprints[linkRel];
    assert.ok(firstFp);
    assert.equal(firstFp.kind, "untracked");
    assert.equal(
      firstFp.contentHash,
      createHash("sha256").update(externalTarget).digest("hex"),
    );
    assert.equal(firstFp.size, Buffer.byteLength(externalTarget, "utf8"));

    writeFileSync(externalTarget, "external v2");
    const second = await inspectWorkspacePhysicalState(f.repo);
    assert.ok(second.fingerprints);
    const secondFp = second.fingerprints[linkRel];
    assert.ok(secondFp);
    assert.equal(secondFp.kind, "untracked");
    assert.equal(secondFp.contentHash, firstFp.contentHash);
    assert.equal(secondFp.size, firstFp.size);
    assert.notEqual(
      firstFp.contentHash,
      createHash("sha256").update("external v2").digest("hex"),
    );
  } finally {
    f.clean();
  }
});

// 11. PATHSpec MAGIC NAME: a filename that looks like Git pathspec magic
// (`:(glob)*.txt`) must be fingerprinted literally, not as a glob pattern. Its
// gitStateHash is computed with `--literal-pathspecs`, so changing only an
// unrelated `.txt` file's Git state (worktree + index) must not change the
// magic-name path's fingerprint.
test("pathspec-magic-looking filename is fingerprinted literally", async () => {
  const f = setupGitFixture();
  try {
    const magicName = ":(glob)*.txt";
    writeFileSync(join(f.repo, magicName), "magic v1");
    writeFileSync(join(f.repo, "unrelated.txt"), "A");
    runGitRaw(["add", "."], f.repo);
    runGitRaw(["commit", "-m", "seed magic-name and unrelated paths"], f.repo);

    writeFileSync(join(f.repo, magicName), "magic v2");
    const first = await inspectWorkspacePhysicalState(f.repo);
    const firstFp = first.fingerprints?.[magicName];
    assert.ok(firstFp);
    assert.equal(firstFp.kind, "modified");
    assert.ok(typeof firstFp.gitStateHash === "string" && firstFp.gitStateHash.length > 0);

    writeFileSync(join(f.repo, "unrelated.txt"), "B");
    runGitRaw(["add", "unrelated.txt"], f.repo);

    const second = await inspectWorkspacePhysicalState(f.repo);
    const secondFp = second.fingerprints?.[magicName];
    assert.ok(secondFp);
    assert.equal(secondFp.gitStateHash, firstFp.gitStateHash);
    assert.equal(secondFp.contentHash, firstFp.contentHash);
  } finally {
    f.clean();
  }
});
