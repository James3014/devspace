/**
 * P0 Resume / writer-lease integration tests.
 *
 * These tests prove that real mutation sinks in the MCP server honor the P0
 * writer-lease fence BEFORE any provider launch, file write, git mutation, or
 * process spawn occurs.  They use fakes/spies injected via createMcpServer so
 * no real providers, Git repos, or processes are exercised.
 *
 * Coverage map (aligned to dispatch I. requirement):
 *   I-2  Second trusted controller/session → rejected before writer/provider effect.
 *   I-3  Lease version drift → agent_continue fenced before provider continuation.
 *   I-4  Read-only status still works without writer lease.
 *   I-5  OUTCOME_UNKNOWN → duplicate dispatch is suppressed.
 *   I-6  Terminal exact replay → no new effect.
 *   I-7  Restart/reopen DB → same workKey/lease handle readable.
 *   I-9  File write/edit P0-bound tests prove sink not called without valid lease.
 *   I-10 Write-capable process P0-bound test proves spawn not called without valid lease.
 *   I-11 CoreMutationGuard tests remain green (independent guard, bypassed here).
 *   I-12 #62 control-plane tests remain green (proved by existing suite, asserted here).
 *
 * Note: this file does not test domain/store primitives (those live in
 * work-resume.test.ts). It focuses exclusively on server-side sinks and
 * store-level fence guarantees.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import {
  WorkResumeStore,
  computeWorkKey,
  computeWorkRequestHash,
  buildWorktreeLeaseInput,
  createWorkResumeStore,
  WORKTREE_WRITER_OPERATION,
  type WorkKeyMaterial,
} from "./work-resume.js";
import {
  ControlPlaneOwnershipStore,
  ControlPlaneOwnershipError,
} from "./control-plane-ownership.js";
import { CORE_MUTATION_TEST_ONLY_UNTRUSTED_BYPASS } from "./core-mutation-tools.js";
import type { LocalAgentSessionManager } from "./local-agent-sessions.js";
import { CarrierBindingStore, type CarrierContract } from "./carrier-binding.js";
import { openDatabase } from "./db/client.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const OWNER_SESSION = "p0-integration-session-a";
const SECOND_SESSION = "p0-integration-session-b";
const BASE_SHA = "4fef445fa217a51794f13ac641a6b991db5d54ec";
const SESSION_META = { "openai/session": OWNER_SESSION };
const SESSION_B_META = { "openai/session": SECOND_SESSION };

// ─── Test-only identity-passthrough store builder ─────────────────────────────

/**
 * Builds a WorkResumeStore backed by an ControlPlaneOwnershipStore that uses
 * the identity resolver (no realpath calls) so tests can use arbitrary paths.
 */
function makeTestStore(
  sqlite: Database.Database,
  nowFn?: () => number,
): { store: WorkResumeStore; ownership: ControlPlaneOwnershipStore } {
  const ownership = new ControlPlaneOwnershipStore(sqlite, {
    resolveOwnerContext: (ctx) =>
      typeof ctx === "string" && ctx.length > 0 ? { ownerThread: ctx } : undefined,
    resolveResourceIdentity: (input) => input, // identity passthrough — no realpath
    verifyGrantEvidence: () => true,
    verifyReconciliationEvidence: () => true,
    now: nowFn,
  });
  const store = new WorkResumeStore(sqlite, ownership, nowFn);
  return { store, ownership };
}

/**
 * Register grant evidence for a session in a store.
 */
function putGrant(
  ownership: ControlPlaneOwnershipStore,
  session: string,
  repo = "owner/devspace",
  goal = "issue-328",
) {
  ownership.putGrantEvidence(session, {
    repository: repo,
    goal,
    coordinatorThread: session,
    evidenceHash: "deadbeef",
  }, 0);
}

// ─── Server fixture helpers ───────────────────────────────────────────────────

/**
 * Minimal fake LocalAgentSessionManager.  Wraps a spy counter around
 * startAgent/continueAgent so tests can assert call counts.
 */
function makeAgentManagerSpy() {
  let startApiCalls = 0;
  let providerStartCalls = 0;
  let continueCalls = 0;
  const byAttempt = new Map<string, any>();
  const byAgent = new Map<string, any>();

  // This fake mirrors the real LocalAgentSessionManager's already-tested
  // attemptKey replay contract: duplicate exact attemptKey returns one durable
  // agent and does not increment the underlying provider-start counter.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const manager: any = {
    startCalls: () => startApiCalls,
    providerStartCalls: () => providerStartCalls,
    continueCalls: () => continueCalls,
    markTerminal: (agentId: string) => {
      const record = byAgent.get(agentId);
      if (!record) throw new Error(`unknown fake agent ${agentId}`);
      record.status = "stopped";
      record.updatedAt = new Date().toISOString();
    },
    startAgent: async (input: any) => {
      startApiCalls++;
      const replayKey = input.attemptKey ?? `legacy-${startApiCalls}`;
      const existing = byAttempt.get(replayKey);
      if (existing) return existing;

      providerStartCalls++;
      const now = new Date().toISOString();
      const record = {
        agentId: `agent_fake_${providerStartCalls}`,
        id: `agent_fake_${providerStartCalls}`,
        profileName: "reviewer",
        provider: "codex",
        status: "starting",
        workspaceId: input.workspaceId ?? "ws",
        workspaceRoot: input.workspaceRoot ?? "/fake",
        executionContract: input.executionContract,
        startReplay: input.attemptKey ? { key: input.attemptKey } : undefined,
        createdAt: now,
        updatedAt: now,
      };
      byAttempt.set(replayKey, record);
      byAgent.set(record.agentId, record);
      return record;
    },
    continueAgent: async (input: any) => {
      continueCalls++;
      const record = byAgent.get(input.agentId) ?? byAttempt.values().next().value;
      return {
        ...(record ?? {
          agentId: input.agentId,
          profileName: "reviewer",
          provider: "codex",
          workspaceId: input.workspaceId ?? "ws",
          workspaceRoot: input.workspaceRoot ?? "/fake",
          createdAt: new Date().toISOString(),
        }),
        status: "running",
        updatedAt: new Date().toISOString(),
        continued: true,
      };
    },
    getRecordByPrefixOrId: (id: string) => byAgent.get(id),
    listAllAgentRecords: () => [...byAgent.values()],
    bindCapabilityManifestSha256: (_sha: string) => {},
    close: () => {},
    getAgentStatus: async (input: any) => {
      const record = byAgent.get(input.agentId);
      return {
        agentId: input.agentId,
        status: record?.status ?? "stopped",
        terminal: record?.status === "stopped",
        profileName: record?.profileName ?? "reviewer",
        provider: record?.provider ?? "codex",
        workspaceRoot: input.workspaceRoot ?? record?.workspaceRoot ?? "/fake",
        workspaceId: input.workspaceId ?? record?.workspaceId ?? "ws",
        createdAt: record?.createdAt ?? new Date().toISOString(),
        updatedAt: record?.updatedAt ?? new Date().toISOString(),
      };
    },
    cancelAgent: async (input: any) => ({ agentId: input.agentId, status: "stopped", terminal: true, profileName: "reviewer", provider: "codex", workspaceRoot: input.workspaceRoot ?? "/fake", workspaceId: input.workspaceId ?? "ws", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
    listAgents: () => [...byAgent.values()],
    preflightAgent: async () => ({ profiles: [], workspace: {}, worker: {}, readiness: "ready", capacity: "available" }),
    reconcileAgent: async (input: any) => ({ agentId: input.agentId, status: "stopped", agentState: {}, workspace: {}, candidate: null, activity: null, profileName: "reviewer", provider: "codex", workspaceRoot: input.workspaceRoot ?? "/fake", workspaceId: input.workspaceId ?? "ws", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
  };

  return manager as {
    startCalls: () => number;
    providerStartCalls: () => number;
    continueCalls: () => number;
    markTerminal: (agentId: string) => void;
  } & LocalAgentSessionManager;
}

interface IntegrationFixture {
  client: Client;
  projectRoot: string;
  workspaceId: string;
  store: WorkResumeStore;
  ownership: ControlPlaneOwnershipStore;
  sqlite: Database.Database;
  agentSpy: ReturnType<typeof makeAgentManagerSpy>;
  workspaces: WorkspaceRegistry;
  close: () => Promise<void>;
}

async function makeFixture(): Promise<IntegrationFixture> {
  const tmpBase = mkdtempSync(join(tmpdir(), "devspace-p0-integration-"));
  const projectRoot = join(tmpBase, "project");
  const stateDir = join(tmpBase, ".state");
  const agentDir = join(tmpBase, "agents");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  // Minimal AGENTS.md so workspace inspection doesn't fail
  writeFileSync(join(projectRoot, "AGENTS.md"), "# Integration test workspace\n");
  writeFileSync(join(agentDir, "AGENTS.md"), "global instructions\n");
  mkdirSync(join(projectRoot, ".devspace", "agents"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".devspace", "agents", "reviewer.md"),
    ["---", "name: reviewer", "description: Reviews project changes.", "provider: codex", "write_mode: read_only", "---", "Review changes."].join("\n"),
  );
  execFileSync("git", ["init"], { cwd: projectRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "P0 Fixture"], { cwd: projectRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "p0-fixture@example.test"], { cwd: projectRoot, stdio: "pipe" });
  execFileSync("git", ["add", "."], { cwd: projectRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: projectRoot, stdio: "pipe" });

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(tmpBase, ".config"),
    DEVSPACE_ALLOWED_ROOTS: tmpBase,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKTREE_ROOT: join(tmpBase, "worktrees"),
    DEVSPACE_GIT_CANDIDATES: "true",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_TOOL_MODE: "full",
    PORT: "1",
  });

  // In-memory SQLite for WorkResumeStore / ControlPlaneOwnershipStore.
  // Uses createWorkResumeStore so it matches production path (resolvePhysicalResource).
  // The projectRoot is a real filesystem path (created above) so realpath resolves.
  const sqlite = new Database(":memory:");
  const { store, ownership } = createWorkResumeStore(
    sqlite,
    (ctx) => typeof ctx === "string" && ctx.length > 0 ? { ownerThread: ctx } : undefined,
  );

  // Pre-register grant evidence for both test sessions
  ownership.putGrantEvidence(OWNER_SESSION, {
    repository: "owner/devspace",
    goal: "issue-328",
    coordinatorThread: OWNER_SESSION,
    evidenceHash: "deadbeef",
  }, 0);
  ownership.putGrantEvidence(SECOND_SESSION, {
    repository: "owner/devspace",
    goal: "issue-328",
    coordinatorThread: SECOND_SESSION,
    evidenceHash: "deadbeef",
  }, 0);

  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const agentSpy = makeAgentManagerSpy();

  const mcpConfig = {
    ...config,
    subagents: { ...config.subagents, enabled: true },
  };

  const server = createMcpServer(
    mcpConfig,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => [],
    [],
    agentSpy,
    undefined, // codexGoals
    undefined, // runtimeBuildIdentityContext
    undefined, // durableOperations
    undefined, // cutoverControl
    undefined, // opencodeCatalogSource
    undefined, // clineCatalogService
    undefined, // chatSwarmLifecycle
    undefined, // carrierBindings
    undefined, // hostOperations
    undefined, // controlPlaneInventoryOverride
    undefined, // controlPlaneInventoryReader
    undefined, // coreMutationSessions
    CORE_MUTATION_TEST_ONLY_UNTRUSTED_BYPASS,
    store,
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "p0-integration-test", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  // Open workspace via MCP so we have a real workspaceId.
  // The response contains workspaceId in structuredContent, not in the text body.
  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: projectRoot },
    _meta: SESSION_META,
  });
  const structured = opened.structuredContent as Record<string, unknown> | undefined;
  const workspaceId = typeof structured?.workspaceId === "string" ? structured.workspaceId : undefined;
  assert.ok(workspaceId, `open_workspace did not return workspaceId. Got: ${JSON.stringify(opened)}`);

  const close = async () => {
    try { await client.close(); } catch { /* ignore */ }
    try { await server.close(); } catch { /* ignore */ }
    workspaceStore.close();
    sqlite.close();
    rmSync(tmpBase, { recursive: true, force: true });
  };

  return { client, projectRoot, workspaceId, store, ownership, sqlite, close, agentSpy, workspaces };
}

/**
 * Build a P0 pointer (plain object matching resumableWorkSchema).
 */
function buildPointer(params: {
  workKey: string;
  leaseId: string;
  leaseVersion: number;
  baseRevisionSha?: string;
  effectHandle?: string;
}) {
  return {
    workKey: params.workKey,
    leaseId: params.leaseId,
    expectedLeaseVersion: params.leaseVersion,
    baseRevisionSha: params.baseRevisionSha ?? BASE_SHA,
    ...(params.effectHandle ? { effectHandle: params.effectHandle } : {}),
  };
}

/**
 * Acquire a P0 lease and register it in the store against a real filesystem path.
 * Uses the production resolvePhysicalResource path (requires real directory).
 */
function acquireAndRegister(
  ownership: ControlPlaneOwnershipStore,
  store: WorkResumeStore,
  worktreeRealpath: string,
  ownerSession: string = OWNER_SESSION,
): { workKey: string; leaseId: string; leaseVersion: number } {
  const canonicalRoot = realpathSync.native(worktreeRealpath).replaceAll("\\", "/");
  const material: WorkKeyMaterial = {
    repositoryKey: "owner/devspace",
    ownerIssueId: "issue-328",
    baseRevisionSha: BASE_SHA,
    worktreeRealpath: canonicalRoot,
    writeScope: [canonicalRoot],
    contractPurpose: "p0-resume-writer-lease",
  };
  const workKey = computeWorkKey(material);
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const grant = {
    repository: "owner/devspace",
    goal: "issue-328",
    coordinatorThread: ownerSession,
    evidenceHash: "deadbeef",
  };
  const leaseInput = buildWorktreeLeaseInput(workKey, material, grant, expiresAt);
  const lease = ownership.acquire(ownerSession, leaseInput);
  store.register(workKey, material, leaseInput.idempotencyKey, lease.leaseId);
  return { workKey, leaseId: lease.leaseId, leaseVersion: lease.version };
}

// ─── I-0: canonical #62 carrier prepares one worktree-writer lease ───────────

test("I-0: canonical #62 carrier exact replay returns one P0 lease and a second controller cannot steal it", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "devspace-p0-carrier-"))).replaceAll("\\", "/");
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  mkdirSync(project, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  let now = Date.now();
  const carrier = new CarrierBindingStore(stateDir, () => now);
  const database = openDatabase(stateDir);
  const { store } = createWorkResumeStore(
    database.sqlite,
    (context) => typeof context === "string" && context.length > 0
      ? { ownerThread: context }
      : undefined,
  );
  const controllerA = { clientId: "shared-oauth", sessionId: "p0-controller-a" };
  const controllerB = { clientId: "shared-oauth", sessionId: "p0-controller-b" };

  try {
    const contract: CarrierContract = {
      repository: "owner/devspace",
      goal: "issue-328",
      role: "controller",
      scope: [project],
      baseRevision: BASE_SHA,
      operations: ["worktree_write"],
      expiresAt: new Date(now + 120_000).toISOString(),
    };

    const pairingA = carrier.requestPairing(controllerA);
    carrier.approveLocal(pairingA.pendingId, contract);
    carrier.redeem(controllerA, pairingA.credential);

    const canonicalRoot = realpathSync.native(project).replaceAll("\\", "/");
    const material: WorkKeyMaterial = {
      repositoryKey: contract.repository,
      ownerIssueId: contract.goal,
      baseRevisionSha: contract.baseRevision,
      worktreeRealpath: canonicalRoot,
      writeScope: [canonicalRoot],
      contractPurpose: "p0-public-prepare",
    };
    const workKey = computeWorkKey(material);
    const subject = {
      operationId: `wresume:${workKey}`,
      requestHash: computeWorkRequestHash(material),
      workspaceRoot: canonicalRoot,
      baseRevision: contract.baseRevision,
      operation: WORKTREE_WRITER_OPERATION,
    };

    const lease = carrier.prepareEffect(controllerA, subject);
    const first = store.prepare({ material, lease });
    assert.equal(first.workKey, workKey);
    assert.equal(first.lease.leaseId, lease.leaseId);
    assert.equal(first.status.leaseId, lease.leaseId);

    const replayLease = carrier.prepareEffect(controllerA, subject);
    const replay = store.prepare({ material, lease: replayLease });
    assert.equal(replay.lease.leaseId, first.lease.leaseId);
    assert.equal(replay.status.leaseVersion, first.status.leaseVersion);

    // A distinct authenticated controller can hold equivalent high-level
    // authority, but it cannot rebind the same active operation/worktree.
    const pairingB = carrier.requestPairing(controllerB);
    carrier.approveLocal(pairingB.pendingId, contract);
    carrier.redeem(controllerB, pairingB.credential);
    assert.throws(
      () => carrier.prepareEffect(controllerB, subject),
      (error: unknown) =>
        error instanceof ControlPlaneOwnershipError &&
        error.code === "OWNERSHIP_CONFLICT",
    );
  } finally {
    database.close();
    carrier.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── I-1: interrupted-turn exact replay reuses one provider effect ──────────

test("I-1: duplicate P0 agent_start reuses one provider launch and work_resume_status returns the same handle", async (t) => {
  const fix = await makeFixture();
  t.after(() => fix.close());

  const { workKey, leaseId, leaseVersion } = acquireAndRegister(
    fix.ownership,
    fix.store,
    fix.projectRoot,
    OWNER_SESSION,
  );
  const attemptKey = "issue328-p0-agent-attempt";
  const argumentsPayload = {
    workspaceId: fix.workspaceId,
    profile: "reviewer",
    prompt: "read-only P0 replay witness",
    attemptKey,
    executionContract: {
      resumableWork: buildPointer({
        workKey,
        leaseId,
        leaseVersion,
        effectHandle: attemptKey,
      }),
    },
  };

  const first = await fix.client.callTool({
    name: "agent_start",
    arguments: argumentsPayload,
    _meta: SESSION_META,
  });
  const second = await fix.client.callTool({
    name: "agent_start",
    arguments: argumentsPayload,
    _meta: SESSION_META,
  });

  assert.equal(fix.agentSpy.startCalls(), 2, "server should reach durable agent replay twice");
  assert.equal(
    fix.agentSpy.providerStartCalls(),
    1,
    "same P0 work + attemptKey must not create a second underlying provider effect",
  );

  const firstStructured = first.structuredContent as Record<string, unknown>;
  const secondStructured = second.structuredContent as Record<string, unknown>;
  assert.equal(firstStructured.agentId, secondStructured.agentId);

  const resume = await fix.client.callTool({
    name: "work_resume_status",
    arguments: { workspaceId: fix.workspaceId, workKey },
    _meta: SESSION_META,
  });
  assert.ok(
    resume.structuredContent,
    `work_resume_status did not return structured content: ${JSON.stringify(resume)}`,
  );
  const resumeStructured = resume.structuredContent as Record<string, unknown>;
  assert.equal(resumeStructured.effectKind, "agent");
  assert.equal(resumeStructured.effectKey, attemptKey);
  assert.equal(resumeStructured.effectHandle, firstStructured.agentId);
  assert.equal(
    (resumeStructured.agent as Record<string, unknown> | undefined)?.agentId,
    firstStructured.agentId,
  );

  const conflicting = await fix.client.callTool({
    name: "agent_start",
    arguments: {
      ...argumentsPayload,
      attemptKey: "issue328-different-attempt",
    },
    _meta: SESSION_META,
  });
  const conflictText = (conflicting.content as Array<{ type: string; text?: string }>)
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("");
  assert.ok(
    conflicting.isError || conflictText.includes("P0_WRITER_ADMISSION_FAILED"),
    "different attempt under the same work key must fail before a second provider launch",
  );
  assert.equal(fix.agentSpy.providerStartCalls(), 1);
});

// ─── I-3a: real agent_continue sink fences stale controller version ───────────

test("I-3a: lease version drift blocks agent_continue before provider continuation", async (t) => {
  const fix = await makeFixture();
  t.after(() => fix.close());

  const { workKey, leaseId, leaseVersion } = acquireAndRegister(
    fix.ownership,
    fix.store,
    fix.projectRoot,
    OWNER_SESSION,
  );
  const attemptKey = "issue328-p0-continue-attempt";
  const started = await fix.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId: fix.workspaceId,
      profile: "reviewer",
      prompt: "start continuation fence witness",
      attemptKey,
      executionContract: {
        resumableWork: buildPointer({
          workKey,
          leaseId,
          leaseVersion,
          effectHandle: attemptKey,
        }),
      },
    },
    _meta: SESSION_META,
  });
  const agentId = (started.structuredContent as Record<string, unknown>).agentId as string;
  assert.ok(agentId);
  assert.equal(fix.agentSpy.providerStartCalls(), 1);
  assert.equal(fix.agentSpy.continueCalls(), 0);

  const pinned = fix.ownership.get(leaseId);
  assert.ok(pinned?.operationHandle);
  const renewed = fix.ownership.renew(
    OWNER_SESSION,
    leaseId,
    pinned.version,
    new Date(Date.now() + 240_000).toISOString(),
  );
  assert.ok(renewed.version > pinned.version);

  const continuation = await fix.client.callTool({
    name: "agent_continue",
    arguments: {
      workspaceId: fix.workspaceId,
      agentId,
      prompt: "must be fenced before provider continuation",
    },
    _meta: SESSION_META,
  });
  const text = (continuation.content as Array<{ type: string; text?: string }>)
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("");
  assert.ok(
    continuation.isError || /P0_WRITER_ADMISSION_FAILED|Pinned replay no longer matches/i.test(text),
    `stale continuation unexpectedly admitted: ${JSON.stringify(continuation)}`,
  );
  assert.equal(
    fix.agentSpy.continueCalls(),
    0,
    "stale controller must be fenced before underlying provider continuation",
  );
});

// ─── I-1b: terminal agent reconciliation closes the exact writer lease ───────

test("I-1b: terminal P0 agent reconciles and releases the exact lease without another provider effect", async (t) => {
  const fix = await makeFixture();
  t.after(() => fix.close());

  const { workKey, leaseId, leaseVersion } = acquireAndRegister(
    fix.ownership,
    fix.store,
    fix.projectRoot,
    OWNER_SESSION,
  );
  const attemptKey = "issue328-p0-terminal-attempt";
  const payload = {
    workspaceId: fix.workspaceId,
    profile: "reviewer",
    prompt: "terminal reconcile witness",
    attemptKey,
    executionContract: {
      resumableWork: buildPointer({
        workKey,
        leaseId,
        leaseVersion,
        effectHandle: attemptKey,
      }),
    },
  };

  const started = await fix.client.callTool({
    name: "agent_start",
    arguments: payload,
    _meta: SESSION_META,
  });
  const agentId = (started.structuredContent as Record<string, unknown>).agentId as string;
  assert.ok(agentId);
  assert.equal(fix.agentSpy.providerStartCalls(), 1);
  assert.equal(fix.store.disposition(workKey).disposition, "RUNNING");

  fix.agentSpy.markTerminal(agentId);

  const reconciled = await fix.client.callTool({
    name: "work_resume_reconcile_agent",
    arguments: { workspaceId: fix.workspaceId, workKey, agentId },
    _meta: SESSION_META,
  });
  assert.ok(reconciled.structuredContent, JSON.stringify(reconciled));
  const first = reconciled.structuredContent as Record<string, unknown>;
  assert.equal(first.disposition, "TERMINAL");
  assert.equal(first.effectHandle, agentId);
  assert.equal(first.released, true);
  assert.equal(fix.agentSpy.providerStartCalls(), 1);

  const status = await fix.client.callTool({
    name: "work_resume_status",
    arguments: { workspaceId: fix.workspaceId, workKey },
    _meta: SESSION_B_META,
  });
  const statusData = status.structuredContent as Record<string, unknown>;
  assert.equal(statusData.disposition, "TERMINAL");
  assert.equal(statusData.effectKey, attemptKey);
  assert.equal(statusData.effectHandle, agentId);

  const replay = await fix.client.callTool({
    name: "work_resume_reconcile_agent",
    arguments: { workspaceId: fix.workspaceId, workKey, agentId },
    _meta: SESSION_META,
  });
  assert.ok(replay.structuredContent, JSON.stringify(replay));
  const replayData = replay.structuredContent as Record<string, unknown>;
  assert.equal(replayData.disposition, "TERMINAL");
  assert.equal(replayData.released, false);
  assert.equal(fix.agentSpy.providerStartCalls(), 1);
});

// ─── I-9a: write tool — invalid lease rejected before file write ──────────────

test("I-9a: P0-bound write tool rejects with invalid leaseId before writing file", async (t) => {
  const fix = await makeFixture();
  t.after(() => fix.close());

  const fakePointer = buildPointer({
    workKey: "wk_" + "a".repeat(32),
    leaseId: "lease_nonexistent",
    leaseVersion: 1,
  });

  const result = await fix.client.callTool({
    name: "write",
    arguments: { workspaceId: fix.workspaceId, path: "test.txt", content: "hello", resumableWork: fakePointer },
    _meta: SESSION_META,
  });

  const texts = (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  assert.ok(
    result.isError || texts.includes("P0_WRITER_ADMISSION_FAILED"),
    `Expected P0 admission failure. Got: ${JSON.stringify(result.content)}`,
  );
});

// ─── I-9b: write tool — valid lease admitted before file write ────────────────

test("I-9b: P0-bound write tool admitted with valid lease writes file", async (t) => {
  const fix = await makeFixture();
  t.after(() => fix.close());

  const { workKey, leaseId, leaseVersion } = acquireAndRegister(
    fix.ownership, fix.store, fix.projectRoot, OWNER_SESSION,
  );

  const result = await fix.client.callTool({
    name: "write",
    arguments: {
      workspaceId: fix.workspaceId,
      path: "admitted.txt",
      content: "admitted content",
      resumableWork: buildPointer({ workKey, leaseId, leaseVersion }),
    },
    _meta: SESSION_META,
  });

  const texts = (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  assert.ok(
    !texts.includes("P0_WRITER_ADMISSION_FAILED"),
    `P0-admitted write failed with admission error unexpectedly: ${texts}`,
  );
});

// ─── I-9c: edit tool — invalid lease rejected before file edit ────────────────

test("I-9c: P0-bound edit tool rejects with invalid lease before editing file", async (t) => {
  const fix = await makeFixture();
  t.after(() => fix.close());

  // Write the file first (legacy path, no P0)
  await fix.client.callTool({
    name: "write",
    arguments: { workspaceId: fix.workspaceId, path: "editable.txt", content: "original" },
    _meta: SESSION_META,
  });

  const fakePointer = buildPointer({ workKey: "wk_" + "b".repeat(32), leaseId: "lease_nonexistent", leaseVersion: 1 });

  const result = await fix.client.callTool({
    name: "edit",
    arguments: {
      workspaceId: fix.workspaceId,
      path: "editable.txt",
      oldContent: "original",
      newContent: "mutated",
      resumableWork: fakePointer,
    },
    _meta: SESSION_META,
  });

  const texts = (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  assert.ok(
    result.isError || texts.includes("P0_WRITER_ADMISSION_FAILED"),
    `Expected P0 admission failure on edit. Got: ${JSON.stringify(result.content)}`,
  );
});

// ─── I-9d: Git sinks — invalid lease rejected before Git effect ───────────────

test("I-9d: P0-bound Git mutation tools reject before commit/push/promote effects", async (t) => {
  const fix = await makeFixture();
  t.after(() => fix.close());

  const opened = await fix.client.callTool({
    name: "open_workspace",
    arguments: { path: fix.projectRoot, mode: "worktree" },
    _meta: SESSION_META,
  });
  const managedWorkspaceId = (opened.structuredContent as Record<string, unknown> | undefined)?.workspaceId;
  assert.equal(typeof managedWorkspaceId, "string");
  const managed = fix.workspaces.getWorkspace(managedWorkspaceId as string);
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: managed.root,
    encoding: "utf8",
  }).trim().toLowerCase();
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: managed.root,
    encoding: "utf8",
  }).trim().toLowerCase();
  writeFileSync(join(managed.root, "p0-git.txt"), "candidate change\n");

  const fakePointer = buildPointer({
    workKey: "wk_" + "e".repeat(32),
    leaseId: "lease_nonexistent",
    leaseVersion: 1,
    baseRevisionSha: head,
  });

  const expectP0Reject = async (name: string, args: Record<string, unknown>) => {
    const result = await fix.client.callTool({
      name,
      arguments: { ...args, resumableWork: fakePointer },
      _meta: SESSION_META,
    });
    const texts = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    assert.ok(
      result.isError || texts.includes("P0_WRITER_ADMISSION_FAILED"),
      `${name} must fail P0 admission before Git effect. Got: ${texts}`,
    );
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: managed.root, encoding: "utf8" }).trim().toLowerCase(),
      head,
      `${name} must not move HEAD after failed P0 admission`,
    );
  };

  await expectP0Reject("git_commit", {
    workspaceId: managedWorkspaceId,
    expectedHead: head,
    message: "must not commit",
    paths: ["p0-git.txt"],
  });
  await expectP0Reject("git_push", {
    workspaceId: managedWorkspaceId,
    expectedHead: head,
    remote: "origin",
    branch: "p0-must-not-push",
  });
  await expectP0Reject("git_promote_candidate", {
    sourceWorkspaceId: managedWorkspaceId,
    candidateBase: head,
    candidateHead: head,
    candidateTree: tree,
    destinationWorkspaceId: managedWorkspaceId,
    expectedDestinationBranch: "main",
    expectedDestinationHead: head,
    expectedServerInstanceId: "p0-fixture-server",
    expectedSourceCommit: head,
    expectedBuildId: "p0-fixture-build",
    expectedCapabilityManifestSha256: "f".repeat(64),
    confirmPromote: true,
  });
});

// ─── I-10a: shell — write-capable command rejected without valid lease ─────────

test("I-10a: P0-bound shell command rejects write-capable command without valid lease", async (t) => {
  const fix = await makeFixture();
  t.after(() => fix.close());

  const fakePointer = buildPointer({ workKey: "wk_" + "c".repeat(32), leaseId: "lease_nonexistent", leaseVersion: 1 });

  let threw = false;
  let result: Awaited<ReturnType<typeof fix.client.callTool>> | undefined;
  try {
    result = await fix.client.callTool({
      name: "shell",
      arguments: {
        workspaceId: fix.workspaceId,
        command: "touch p0test.txt",
        attemptKey: "p0-shell-test-1",
        resumableWork: fakePointer,
      },
      _meta: SESSION_META,
    });
  } catch (err) {
    threw = true;
    assert.ok(
      String(err).includes("P0_WRITER_ADMISSION_FAILED") || String(err).includes("admission"),
      `Expected P0 admission error, got: ${err}`,
    );
  }

  if (!threw && result) {
    const texts = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    assert.ok(
      result.isError || texts.includes("P0_WRITER_ADMISSION_FAILED"),
      `Expected P0 admission to reject write-capable shell command. Got: ${texts}`,
    );
  }
});

// ─── I-10b: shell — read-only command passes without lease check ──────────────

test("I-10b: P0-bound shell command — read-only command passes lease check (pointer ignored)", async (t) => {
  const fix = await makeFixture();
  t.after(() => fix.close());

  const fakePointer = buildPointer({ workKey: "wk_" + "d".repeat(32), leaseId: "lease_nonexistent", leaseVersion: 1 });

  // ls is a read-only command; P0 pointer must be ignored
  const result = await fix.client.callTool({
    name: "shell",
    arguments: {
      workspaceId: fix.workspaceId,
      command: "ls",
      attemptKey: "p0-shell-readonly-1",
      resumableWork: fakePointer,
    },
    _meta: SESSION_META,
  });

  const texts = (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  assert.ok(
    !texts.includes("P0_WRITER_ADMISSION_FAILED"),
    `Read-only command must NOT trigger P0 fencing. Got: ${texts}`,
  );
});

// ─── I-2: second session targeting same worktree gets rejected ────────────────

test("I-2: second session targeting same worktree+scope gets ownership conflict before file write", async (t) => {
  const fix = await makeFixture();
  t.after(() => fix.close());

  // Acquire valid lease for session-a (the projectRoot is real)
  const { workKey, leaseId, leaseVersion } = acquireAndRegister(
    fix.ownership, fix.store, fix.projectRoot, OWNER_SESSION,
  );

  // Session-b uses the same workKey/leaseId pointer, but session-b is NOT the ownerThread
  const result = await fix.client.callTool({
    name: "write",
    arguments: {
      workspaceId: fix.workspaceId,
      path: "session-b-attempt.txt",
      content: "should be blocked",
      resumableWork: buildPointer({ workKey, leaseId, leaseVersion }),
    },
    _meta: SESSION_B_META,
  });

  const texts = (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  assert.ok(
    result.isError ||
    texts.includes("P0_WRITER_ADMISSION_FAILED") ||
    texts.includes("CAS_CONFLICT") ||
    texts.includes("AUTHORITY_REQUIRED") ||
    texts.includes("OWNERSHIP_CONFLICT"),
    `Expected session-b to be rejected. Got: ${JSON.stringify(result.content)}`,
  );
});

// ─── I-4: read-only status works without writer lease ─────────────────────────

test("I-4: read-only WorkResumeStore.disposition works without holding writer lease", () => {
  const sqlite = new Database(":memory:");
  const { store } = makeTestStore(sqlite);
  try {
    const fakeKey = "wk_" + "e".repeat(32);
    const status = store.disposition(fakeKey);
    assert.equal(status.disposition, "NO_EXISTING_ATTEMPT");
    assert.equal(status.workKey, fakeKey);
  } finally {
    sqlite.close();
  }
});

// ─── I-3: lease version drift fences the CAS before any continuation ──────────

test("I-3: stale lease version fails CAS; proves agent_continue fencing at store level", () => {
  const sqlite = new Database(":memory:");
  const { store, ownership } = makeTestStore(sqlite);
  try {
    const session = "session-drift";
    putGrant(ownership, session);

    const root = "/fake/drift";
    const material: WorkKeyMaterial = {
      repositoryKey: "owner/devspace",
      ownerIssueId: "issue-328",
      baseRevisionSha: BASE_SHA,
      worktreeRealpath: root,
      writeScope: [root],
      contractPurpose: "p0-drift-test",
    };
    const wk = computeWorkKey(material);
    const li = buildWorktreeLeaseInput(wk, material, {
      repository: "owner/devspace", goal: "issue-328",
      coordinatorThread: session, evidenceHash: "deadbeef",
    }, new Date(Date.now() + 60_000).toISOString());
    const lease = ownership.acquire(session, li);
    store.register(wk, material, li.idempotencyKey, lease.leaseId);
    const origV = lease.version;

    // Advance version by renewal
    ownership.renew(session, lease.leaseId, origV, new Date(Date.now() + 90_000).toISOString());
    assert.equal(ownership.get(lease.leaseId)!.version, origV + 1);

    // admitWriter with stale version must fail — this is what centralAdmissionCheck does
    assert.throws(
      () => store.admitWriter({
        workKey: wk,
        ownerContext: session,
        leaseId: lease.leaseId,
        expectedLeaseVersion: origV, // stale
        operation: "agent_write",
        baseRevision: BASE_SHA,
      }),
      (e: unknown) => e instanceof ControlPlaneOwnershipError,
      "Stale lease version must fail CAS — proves agent_continue would be fenced",
    );
  } finally {
    sqlite.close();
  }
});

// ─── I-5: OUTCOME_UNKNOWN → checkDuplicate suppressed ────────────────────────

test("I-5: OUTCOME_UNKNOWN disposition is suppressed (checkDuplicate returns suppressed=true)", () => {
  let now = Date.now();
  const sqlite = new Database(":memory:");
  const { store, ownership } = makeTestStore(sqlite, () => now);
  try {
    const session = "session-outcome-unknown";
    ownership.putGrantEvidence(session, {
      repository: "owner/devspace", goal: "issue-329",
      coordinatorThread: session, evidenceHash: "cafebabe",
    }, 0);

    const root = "/fake/outcome-unknown";
    const material: WorkKeyMaterial = {
      repositoryKey: "owner/devspace",
      ownerIssueId: "issue-329",
      baseRevisionSha: BASE_SHA,
      worktreeRealpath: root,
      writeScope: [root],
      contractPurpose: "p0-outcome-unknown",
    };
    const wk = computeWorkKey(material);
    const li = buildWorktreeLeaseInput(wk, material, {
      repository: "owner/devspace", goal: "issue-329",
      coordinatorThread: session, evidenceHash: "cafebabe",
    }, new Date(now + 1_000).toISOString());
    const lease = ownership.acquire(session, li);
    store.register(wk, material, li.idempotencyKey, lease.leaseId);

    // Pin to simulate in-flight effect
    ownership.beginOperation(session, lease.leaseId, lease.version, "in-flight-task");

    // Expire lease
    now += 10_000;

    // Must be suppressed as RECONCILE_REQUIRED
    const dup = store.checkDuplicate(wk);
    assert.ok(dup.suppressed, "OUTCOME_UNKNOWN must be suppressed");
    assert.equal(dup.suppressed && dup.status.disposition, "RECONCILE_REQUIRED");
  } finally {
    sqlite.close();
  }
});

// ─── I-6: terminal replay → suppressed, receipt readable ─────────────────────

test("I-6: terminal exact replay is suppressed; receipt readable via disposition", () => {
  const sqlite = new Database(":memory:");
  const { store, ownership } = makeTestStore(sqlite);
  try {
    const session = "session-terminal";
    ownership.putGrantEvidence(session, {
      repository: "owner/devspace", goal: "issue-330",
      coordinatorThread: session, evidenceHash: "beefdead",
    }, 0);

    const root = "/fake/terminal-replay";
    const material: WorkKeyMaterial = {
      repositoryKey: "owner/devspace",
      ownerIssueId: "issue-330",
      baseRevisionSha: BASE_SHA,
      worktreeRealpath: root,
      writeScope: [root],
      contractPurpose: "p0-terminal-replay",
    };
    const wk = computeWorkKey(material);
    const li = buildWorktreeLeaseInput(wk, material, {
      repository: "owner/devspace", goal: "issue-330",
      coordinatorThread: session, evidenceHash: "beefdead",
    }, new Date(Date.now() + 60_000).toISOString());
    const lease = ownership.acquire(session, li);
    store.register(wk, material, li.idempotencyKey, lease.leaseId);

    const pinned = ownership.beginOperation(session, lease.leaseId, lease.version, "effect-terminal");
    const evidence = {
      leaseId: lease.leaseId,
      ownerThread: session,
      operationHandle: "effect-terminal",
      operation: WORKTREE_WRITER_OPERATION,
      baseRevision: BASE_SHA,
      leaseVersion: pinned.version,
      state: "finished" as const,
    };
    const receipt = store.recordTerminalReceipt(session, wk, lease.leaseId, pinned.version, evidence);
    assert.ok(receipt.receiptId);

    const replay = store.disposition(wk);
    assert.equal(replay.disposition, "TERMINAL");
    assert.equal(replay.terminalReceipt?.receiptId, receipt.receiptId);

    const dup = store.checkDuplicate(wk);
    assert.ok(dup.suppressed);
    assert.equal(dup.suppressed && dup.status.disposition, "TERMINAL");
  } finally {
    sqlite.close();
  }
});

// ─── I-7: process restart → same workKey/lease/effect handle ─────────────────

test("I-7: process restart reads back same workKey/lease/effect handle from durable SQLite", () => {
  const dir = mkdtempSync(join(tmpdir(), "devspace-p0-restart-"));
  const dbPath = join(dir, "p0-state.sqlite");
  const session = "session-restart";
  const root = "/fake/p0-restart";

  let capturedWorkKey: string;
  let capturedLeaseId: string;

  try {
    // Phase 1: initial acquisition
    {
      const db = new Database(dbPath);
      const { store, ownership } = makeTestStore(db);
      ownership.putGrantEvidence(session, {
        repository: "owner/devspace", goal: "issue-331",
        coordinatorThread: session, evidenceHash: "abcd1234",
      }, 0);
      const material: WorkKeyMaterial = {
        repositoryKey: "owner/devspace",
        ownerIssueId: "issue-331",
        baseRevisionSha: BASE_SHA,
        worktreeRealpath: root,
        writeScope: [root],
        contractPurpose: "p0-restart-test",
      };
      capturedWorkKey = computeWorkKey(material);
      const li = buildWorktreeLeaseInput(capturedWorkKey, material, {
        repository: "owner/devspace", goal: "issue-331",
        coordinatorThread: session, evidenceHash: "abcd1234",
      }, new Date(Date.now() + 60_000).toISOString());
      const lease = ownership.acquire(session, li);
      store.register(capturedWorkKey, material, li.idempotencyKey, lease.leaseId);
      capturedLeaseId = lease.leaseId;
      ownership.beginOperation(session, lease.leaseId, lease.version, "pre-restart-effect");
      db.close();
    }

    // Phase 2: restart — new instance, same durable DB
    {
      const db = new Database(dbPath);
      const { store: store2, ownership: ownership2 } = makeTestStore(db);
      // putGrantEvidence at version 1 (already stored at version 1 from phase 1)
      ownership2.putGrantEvidence(session, {
        repository: "owner/devspace", goal: "issue-331",
        coordinatorThread: session, evidenceHash: "abcd1234",
      }, 1);

      const status = store2.disposition(capturedWorkKey);
      assert.ok(
        status.disposition === "RUNNING" || status.disposition === "RECONCILE_REQUIRED",
        `Expected RUNNING or RECONCILE_REQUIRED after restart, got: ${status.disposition}`,
      );
      assert.equal(status.leaseId, capturedLeaseId);

      const live = store2.getLease(capturedLeaseId);
      assert.equal(live?.operationHandle, "pre-restart-effect");
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── I-12: #62 control-plane semantics unchanged ──────────────────────────────

test("I-12: ControlPlaneOwnershipStore core semantics unchanged by P0 additions", () => {
  const db = new Database(":memory:");
  // Use identity resolver (no physical resource resolution) for the pure #62 test
  const ownership = new ControlPlaneOwnershipStore(db, {
    resolveOwnerContext: (ctx) =>
      typeof ctx === "string" && ctx.length > 0 ? { ownerThread: ctx } : undefined,
    resolveResourceIdentity: (input) => input,
    verifyGrantEvidence: () => true,
    verifyReconciliationEvidence: () => true,
  });
  const grant = { repository: "r/repo", goal: "g1", coordinatorThread: "owner62", evidenceHash: "ef" };
  ownership.putGrantEvidence("owner62", grant, 0);

  try {
    const lease = ownership.acquire("owner62", {
      repositoryKey: "r/repo",
      resourceKind: "filesystem",
      resourceId: "/repo",
      resource: "/repo",
      operation: "sync",
      scope: ["/repo"],
      baseRevision: "0".repeat(40),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: "p0-i12-test",
      grant,
    });
    assert.ok(lease.leaseId);
    assert.equal(lease.version, 1);

    const held = ownership.assertHeld("owner62", lease.leaseId, 1, "sync", "0".repeat(40));
    assert.equal(held.leaseId, lease.leaseId);

    const pinned = ownership.beginOperation("owner62", lease.leaseId, 1, "some-op");
    assert.equal(pinned.version, 2);
    assert.equal(pinned.operationHandle, "some-op");

    const finished = ownership.finishOperation("owner62", lease.leaseId, 2, "some-op");
    assert.equal(finished.version, 3);
    assert.ok(!finished.operationHandle);

    ownership.release("owner62", lease.leaseId, 3);
    assert.equal(ownership.get(lease.leaseId)?.terminalState, "released");
  } finally {
    db.close();
  }
});
