import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalAgentSessionManager, AgentSessionError } from "./local-agent-sessions.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";
import { classifyScopeState, workerChangedPathsSinceBaseline } from "./workspace-reconciliation.js";

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
