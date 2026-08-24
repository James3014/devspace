import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { LocalAgentSessionManager, AgentSessionError } from "./local-agent-sessions.js";
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

function setupManager(overrides: Record<string, unknown> = {}) {
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
    async () => undefined,
    mockTerminator,
  );

  const clean = () => {
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {}
  };
  return { manager, config, terminated, clean, stateDir };
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
    manager.updateRecord(record.id, {
      status: "running",
      workerPid: 9999999,
      workerToken: "tok",
      scopeBaseline: { changedPaths: [], head: f.head },
    });
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
    manager.updateRecord(started.agentId, {
      status: "error",
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
    manager.updateRecord(started.agentId, {
      status: "error",
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
    manager.updateRecord(started.agentId, {
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
    manager.updateRecord(started.agentId, {
      status: "idle",
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
    manager.updateRecord(started.agentId, {
      status: "idle",
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
    manager.updateRecord(record.id, {
      status: "running",
      workerPid: 9999998,
      workerToken: "tok",
      scopeBaseline: baseline,
    });

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
    manager.updateRecord(record.id, {
      status: "running",
      workerPid: 9999997,
      workerToken: "tok",
      scopeBaseline: baseline,
    });

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
    manager.updateRecord(started.agentId, { scopeBaseline: legacyBaseline });

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
