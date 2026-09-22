import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath } from "./db/client.js";
import { LocalAgentStore } from "./local-agent-store.js";
import type { ScopeBaseline } from "./local-agent-contract.js";
import {
  buildLocalEffectEnforcementReceipt,
  LOCAL_EFFECT_PROJECTION_SCHEMA,
} from "./local-effect-enforcement.js";
import { hashDispatchIntent } from "./execution-protocol.js";

const root = mkdtempSync(join(tmpdir(), "devspace-local-agent-store-test-"));
const stores: LocalAgentStore[] = [];

try {
  const store = new LocalAgentStore(root);
  stores.push(store);
  const created = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "reviewer",
    provider: "codex",
    model: "gpt-5.4",
    effort: "high",
  });

  assert.match(created.id, /^agt_[a-f0-9]{8}$/);
  assert.equal(created.status, "starting");
  assert.equal(created.providerContinuityState, "UNKNOWN");
  assert.equal(store.getById(created.id)?.effort, "high");
  assert.equal(store.getById(created.id)?.profileName, "reviewer");
  assert.equal(store.getById(created.id.slice(0, 7)), undefined);

  const updated = store.update(created.id, {
    status: "error",
    latestResponse: "done",
    providerSessionId: "thread_123",
    effort: "medium",
    error: "Codex executable was not found.",
    errorCode: "PROVIDER_UNAVAILABLE",
    errorRetryable: false,
  });

  assert.equal(updated.status, "error");
  assert.equal(updated.effort, "medium");
  assert.equal(updated.errorCode, "PROVIDER_UNAVAILABLE");
  assert.equal(updated.errorRetryable, false);
  assert.equal(updated.providerContinuityState, "KNOWN_UNVERIFIED");
  assert.equal(updated.providerSessionId, "thread_123");
  assert.equal(store.getById("thread_123"), undefined);
  const storedError = store.getById(created.id);
  assert.equal(storedError?.error, "Codex executable was not found.");
  assert.equal(storedError?.errorCode, "PROVIDER_UNAVAILABLE");
  assert.equal(storedError?.errorRetryable, false);
  assert.equal(storedError?.providerContinuityState, "KNOWN_UNVERIFIED");
  assert.equal(storedError?.providerSessionId, "thread_123");

  const mismatched = store.update(created.id, {
    providerSessionId: "thread_456",
  });
  assert.equal(mismatched.providerContinuityState, "LOST");
  assert.equal(mismatched.providerSessionId, "thread_123");
  const readbackMismatched = store.getById(created.id);
  assert.equal(readbackMismatched?.providerContinuityState, "LOST");
  assert.equal(readbackMismatched?.providerSessionId, "thread_123");
  assert.equal(store.update(created.id, { latestResponse: undefined }).latestResponse, undefined);
  assert.deepEqual(
    store.list({ workspaceRoot: join(root, "project") }).map((agent) => agent.latestResponse),
    [undefined],
  );
assert.deepEqual(store.list({ workspaceId: "ws_1" }).map((agent) => agent.id), [created.id]);
assert.deepEqual(store.list({ workspaceId: "ws_other" }), []);
assert.deepEqual(store.list({ workspaceId: "ws_1", workspaceRoot: join(root, "other") }), []);
assert.deepEqual(store.list({ workspaceRoot: join(root, "other") }), []);

  const supervisionStateDir = join(root, "supervision-candidates");
  let supervisionStore = new LocalAgentStore(supervisionStateDir);
  const historicalTerminalIds: string[] = [];
  for (let index = 0; index < 200; index += 1) {
    const historical = supervisionStore.create({
      workspaceId: "ws_history",
      workspaceRoot: join(root, "history"),
      profileName: "historical-worker",
      provider: "codex",
      executionContract: { maxWallMs: 60_000, writePaths: ["src"] },
      lifecycleKind: "detached_worker_v2",
    });
    const generation = historical.lifecycleState!.activeTurn!.generation!;
    supervisionStore.prepareWorker(historical.id, `history-token-${index}`);
    supervisionStore.claimWorker(historical.id, `history-token-${index}`, 10_000 + index);
    assert.equal(supervisionStore.finishTurnCAS({
      agentId: historical.id,
      generation,
      workerToken: `history-token-${index}`,
      status: "idle",
      terminalReason: "completed",
    }).applied, true);
    historicalTerminalIds.push(historical.id);
  }

  const starting = supervisionStore.create({
    workspaceId: "ws_active",
    workspaceRoot: join(root, "active"),
    profileName: "starting-worker",
    provider: "codex",
    lifecycleKind: "detached_worker_v2",
  });
  const running = supervisionStore.create({
    workspaceId: "ws_active",
    workspaceRoot: join(root, "active"),
    profileName: "running-worker",
    provider: "codex",
    lifecycleKind: "detached_worker_v2",
  });
  supervisionStore.prepareWorker(running.id, "running-token");
  supervisionStore.claimWorker(running.id, "running-token", 20_001);

  const pending = supervisionStore.create({
    workspaceId: "ws_pending",
    workspaceRoot: join(root, "pending"),
    profileName: "pending-worker",
    provider: "codex",
    lifecycleKind: "detached_worker_v2",
  });
  const pendingGeneration = pending.lifecycleState!.activeTurn!.generation!;
  supervisionStore.prepareWorker(pending.id, "pending-token");
  supervisionStore.claimWorker(pending.id, "pending-token", 20_002);
  const supervisionFenced = supervisionStore.fenceActiveTurn({
    agentId: pending.id,
    expectedPhase: "any",
    terminalReason: "timeout",
    error: "pending cleanup",
  });
  assert.equal(supervisionFenced.applied, true);
  assert.equal(supervisionFenced.current?.lifecycleState?.terminationPending?.generation, pendingGeneration);
  assert.equal(supervisionFenced.current?.status, "error");

  const terminalInventoryCount = supervisionStore.list().length;
  assert.equal(terminalInventoryCount, historicalTerminalIds.length + 3);
  assert.equal(supervisionStore.list().some((record) => record.id === historicalTerminalIds[0]), true);
  const candidatesBeforeReopen = supervisionStore.listSupervisionCandidates();
  assert.equal(candidatesBeforeReopen.some((record) => historicalTerminalIds.includes(record.id)), false);
  assert.equal(candidatesBeforeReopen.some((record) => record.id === starting.id), true);
  assert.equal(candidatesBeforeReopen.some((record) => record.id === running.id), true);
  assert.equal(candidatesBeforeReopen.some((record) => record.id === pending.id), true);
  assert.equal(candidatesBeforeReopen.find((record) => record.id === pending.id)?.status, "error");

  supervisionStore.close();
  supervisionStore = new LocalAgentStore(supervisionStateDir);
  assert.equal(supervisionStore.list().length, terminalInventoryCount);
  assert.equal(supervisionStore.list().some((record) => record.id === historicalTerminalIds[0]), true);
  const candidatesAfterReopen = supervisionStore.listSupervisionCandidates();
  assert.equal(candidatesAfterReopen.some((record) => record.id === pending.id), true);
  assert.equal(candidatesAfterReopen.find((record) => record.id === pending.id)?.lifecycleState?.terminationPending?.generation, pendingGeneration);
  stores.push(supervisionStore);

  const failedContinuation = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "continued-worker",
    provider: "omp",
    lifecycleKind: "detached_worker_v2",
  });
  store.prepareWorker(failedContinuation.id, "token-failure");
  const failedClaim = store.claimWorker(failedContinuation.id, "token-failure", 1000)!;
  assert.equal(store.bindProviderSessionCAS(
    failedContinuation.id,
    failedClaim.lifecycleState!.activeTurn!.generation!,
    "token-failure",
    "omp-session-existing",
  ).applied, true);
  const failed = store.finishWorker(failedContinuation.id, "token-failure", {
    status: "error",
    error: "provider failed",
  });
  assert.equal(failed.providerSessionId, "omp-session-existing");
  assert.equal(failed.providerContinuityState, "KNOWN_UNVERIFIED");

  const continuityStateDir = join(root, "provider-continuity-state");
  let continuityStore = new LocalAgentStore(continuityStateDir);
  const continuityAgent = continuityStore.create({
    workspaceId: "ws_continuity",
    workspaceRoot: join(root, "continuity-project"),
    profileName: "continuity-worker",
    provider: "codex",
    lifecycleKind: "detached_worker_v2",
  });
  assert.equal(continuityAgent.providerContinuityState, "UNKNOWN");
  continuityStore.prepareWorker(continuityAgent.id, "continuity-token-1");
  const continuityClaim1 = continuityStore.claimWorker(continuityAgent.id, "continuity-token-1", 3001)!;
  const continuityGeneration1 = continuityClaim1.lifecycleState!.activeTurn!.generation!;
  const firstIdentity = continuityStore.bindProviderSessionCAS(
    continuityAgent.id,
    continuityGeneration1,
    "continuity-token-1",
    "provider-session-1",
  );
  assert.equal(firstIdentity.applied, true);
  assert.equal(firstIdentity.current?.providerContinuityState, "KNOWN_UNVERIFIED");
  assert.equal(continuityStore.finishTurnCAS({
    agentId: continuityAgent.id,
    generation: continuityGeneration1,
    workerToken: "continuity-token-1",
    status: "idle",
    terminalReason: "completed",
  }).applied, true);
  continuityStore.close();

  continuityStore = new LocalAgentStore(continuityStateDir);
  const firstReopen = continuityStore.getById(continuityAgent.id)!;
  assert.equal(firstReopen.providerSessionId, "provider-session-1");
  assert.equal(firstReopen.providerContinuityState, "KNOWN_UNVERIFIED");
  const continuation1 = continuityStore.beginContinuationCAS({
    agentId: continuityAgent.id,
    expectedPreviousGeneration: firstReopen.lifecycleState?.lastSettledGeneration,
    expectedUpdatedAt: firstReopen.updatedAt,
  });
  assert.equal(continuation1.applied, true);
  assert.equal(continuation1.current?.providerContinuityState, "KNOWN_UNVERIFIED");
  const continuityGeneration2 = continuation1.current!.lifecycleState!.activeTurn!.generation!;
  assert.equal(continuityStore.prepareWorkerCAS(
    continuityAgent.id,
    continuityGeneration2,
    "continuity-token-2",
  ).applied, true);
  assert.equal(continuityStore.claimWorkerCAS(
    continuityAgent.id,
    continuityGeneration2,
    "continuity-token-2",
    3002,
  ).applied, true);
  const resumedIdentity = continuityStore.bindProviderSessionCAS(
    continuityAgent.id,
    continuityGeneration2,
    "continuity-token-2",
    "provider-session-1",
  );
  assert.equal(resumedIdentity.applied, true);
  assert.equal(resumedIdentity.current?.providerContinuityState, "RESUME_VERIFIED");
  assert.equal(continuityStore.finishTurnCAS({
    agentId: continuityAgent.id,
    generation: continuityGeneration2,
    workerToken: "continuity-token-2",
    status: "idle",
    terminalReason: "completed",
  }).applied, true);
  continuityStore.close();

  continuityStore = new LocalAgentStore(continuityStateDir);
  const resumeReopen = continuityStore.getById(continuityAgent.id)!;
  assert.equal(resumeReopen.providerContinuityState, "RESUME_VERIFIED");
  const continuation2 = continuityStore.beginContinuationCAS({
    agentId: continuityAgent.id,
    expectedPreviousGeneration: resumeReopen.lifecycleState?.lastSettledGeneration,
    expectedUpdatedAt: resumeReopen.updatedAt,
  });
  assert.equal(continuation2.applied, true);
  assert.equal(continuation2.current?.providerContinuityState, "KNOWN_UNVERIFIED");
  const continuityGeneration3 = continuation2.current!.lifecycleState!.activeTurn!.generation!;
  assert.equal(continuityStore.prepareWorkerCAS(
    continuityAgent.id,
    continuityGeneration3,
    "continuity-token-3",
  ).applied, true);
  assert.equal(continuityStore.claimWorkerCAS(
    continuityAgent.id,
    continuityGeneration3,
    "continuity-token-3",
    3003,
  ).applied, true);
  const changedIdentity = continuityStore.bindProviderSessionCAS(
    continuityAgent.id,
    continuityGeneration3,
    "continuity-token-3",
    "provider-session-2",
  );
  assert.equal(changedIdentity.applied, true);
  assert.equal(changedIdentity.current?.providerContinuityState, "LOST");
  assert.equal(changedIdentity.current?.providerSessionId, "provider-session-1");
  assert.equal(continuityStore.failTurnCAS({
    agentId: continuityAgent.id,
    generation: continuityGeneration3,
    workerToken: "continuity-token-3",
    error: "provider session identity changed",
    terminalReason: "provider_error",
  }).applied, true);
  continuityStore.close();

  continuityStore = new LocalAgentStore(continuityStateDir);
  stores.push(continuityStore);
  const lostReopen = continuityStore.getById(continuityAgent.id)!;
  assert.equal(lostReopen.providerContinuityState, "LOST");
  assert.equal(lostReopen.providerSessionId, "provider-session-1");
  assert.equal(continuityStore.beginContinuationCAS({
    agentId: continuityAgent.id,
    expectedPreviousGeneration: lostReopen.lifecycleState?.lastSettledGeneration,
    expectedUpdatedAt: lostReopen.updatedAt,
  }).applied, false);

  const agyWithoutIdentity = continuityStore.create({
    workspaceId: "ws_continuity",
    workspaceRoot: join(root, "continuity-project"),
    profileName: "agy-worker",
    provider: "agy",
    lifecycleKind: "detached_worker_v2",
  });
  continuityStore.prepareWorker(agyWithoutIdentity.id, "agy-continuity-token");
  const agyClaim = continuityStore.claimWorker(agyWithoutIdentity.id, "agy-continuity-token", 3004)!;
  assert.equal(continuityStore.finishTurnCAS({
    agentId: agyWithoutIdentity.id,
    generation: agyClaim.lifecycleState!.activeTurn!.generation!,
    workerToken: "agy-continuity-token",
    status: "idle",
    terminalReason: "completed",
  }).applied, true);
  assert.equal(continuityStore.getById(agyWithoutIdentity.id)?.providerContinuityState, "LOST");

  const effectReceiptRecord = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "effect-receipt",
    provider: "omp",
    lifecycleKind: "detached_worker_v2",
  });
  store.prepareWorker(effectReceiptRecord.id, "token-effect-receipt");
  const effectClaim = store.claimWorker(effectReceiptRecord.id, "token-effect-receipt", 1002)!;
  const effectReceipt = buildLocalEffectEnforcementReceipt({
    provider: "omp",
    model: "google/gemini-3.7-flash",
    writeMode: "read_only",
    selectedToolIntents: ["workspace.read", "workspace.search_text"],
    effectProjection: {
      schema: LOCAL_EFFECT_PROJECTION_SCHEMA,
      process: { mode: "DENY" },
      network: { egress: "DENY" },
      git: { mode: "DENY" },
    },
    enforcementSurface: { tools: "grep,read", shell: "deny", network: "deny" },
  });
  assert.equal(store.finishTurnCAS({
    agentId: effectReceiptRecord.id,
    generation: effectClaim.lifecycleState!.activeTurn!.generation!,
    workerToken: "token-effect-receipt",
    status: "idle",
    latestResponse: "done",
    effectEnforcementReceipt: effectReceipt,
  }).applied, true);
  assert.deepEqual(
    store.getById(effectReceiptRecord.id)?.lifecycleState?.lastEffectEnforcementReceipt,
    effectReceipt,
    "provider-native effect receipt must survive durable store round-trip",
  );

  const fenced = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "omp-worker",
    provider: "omp",
    lifecycleKind: "detached_worker_v2",
  });
  const prepared = store.prepareWorker(fenced.id, "token-a");
  assert.equal(prepared.workerToken, "token-a");
  assert.equal(prepared.workerPid, undefined);
  assert.equal(store.claimWorker(fenced.id, "wrong-token", 1001), undefined);
  const claimed = store.claimWorker(fenced.id, "token-a", 1001);
  assert.equal(claimed?.status, "running");
  assert.equal(claimed?.workerPid, 1001);
  const cancelled = store.cancelActive(fenced.id);
  assert.equal(cancelled.previous.workerToken, "token-a");
  assert.equal(cancelled.previous.workerPid, 1001);
  assert.equal(cancelled.current.status, "stopped");
  assert.equal(cancelled.current.workerToken, "token-a");
  assert.equal(cancelled.current.workerPid, 1001);
  const cancelledPending = (cancelled.current.lifecycleState as any)?.terminationPending;
  assert.ok(cancelledPending);
  assert.equal(cancelledPending.workerToken, "token-a");
  assert.equal(cancelledPending.workerPid, 1001);
  assert.equal((cancelled.current.lifecycleState as any)?.activeTurn, undefined);
  assert.equal((store as any).completeTerminationCAS({
    agentId: fenced.id,
    generation: cancelledPending.generation,
    workerPid: 1001,
    workerToken: "token-a",
    turnEndBaseline: { changedPaths: [], head: null },
  }).applied, true);
  assert.equal(store.getById(fenced.id)?.workerToken, undefined);
  assert.equal(store.getById(fenced.id)?.workerPid, undefined);
  assert.equal(
    store.finishWorker(fenced.id, "token-a", {
      status: "idle",
      latestResponse: "late completion",
    }).status,
    "stopped",
  );

  const generationGuarded = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "generation-guarded",
    provider: "omp",
    lifecycleKind: "detached_worker_v2",
  });
  store.prepareWorker(generationGuarded.id, "token-generation-a");
  store.claimWorker(generationGuarded.id, "token-generation-a", 2001);
  const fenceA = store.fenceActiveTurn({
    agentId: generationGuarded.id,
    terminalReason: "timeout",
    error: "generation A timeout",
  });
  assert.equal(fenceA.applied, true);
  const terminationA = (fenceA.current?.lifecycleState as any)?.terminationPending;
  assert.ok(terminationA);
  assert.equal(typeof terminationA.generation, "string");
  assert.equal(terminationA.workerPid, 2001);
  assert.equal(terminationA.workerToken, "token-generation-a");
  assert.equal(fenceA.current?.workerPid, 2001);
  assert.equal(fenceA.current?.workerToken, "token-generation-a");
  assert.equal((fenceA.current?.lifecycleState as any)?.activeTurn, undefined);
  assert.equal((store as any).completeTerminationCAS({
    agentId: generationGuarded.id,
    generation: terminationA.generation,
    workerPid: terminationA.workerPid,
    workerToken: terminationA.workerToken,
    turnEndBaseline: { changedPaths: [], head: null },
  }).applied, true);

  const continuationB = (store as any).beginContinuationCAS({
    agentId: generationGuarded.id,
    expectedPreviousGeneration: terminationA.generation,
    turnStartedAt: new Date().toISOString(),
  });
  assert.equal(continuationB.applied, true);
  const activeB = (continuationB.current.lifecycleState as any).activeTurn;
  assert.equal(typeof activeB.generation, "string");
  assert.notEqual(activeB.generation, terminationA.generation);
  const duplicateContinuationB = (store as any).beginContinuationCAS({
    agentId: generationGuarded.id,
    expectedPreviousGeneration: terminationA.generation,
    turnStartedAt: new Date().toISOString(),
  });
  assert.equal(duplicateContinuationB.applied, false);
  assert.equal(
    (store.getById(generationGuarded.id)?.lifecycleState as any)?.activeTurn?.generation,
    activeB.generation,
  );
  (store as any).prepareWorkerCAS(generationGuarded.id, activeB.generation, "token-generation-b");
  (store as any).claimWorkerCAS(generationGuarded.id, activeB.generation, "token-generation-b", 2002);
  const fenceB = store.fenceActiveTurn({
    agentId: generationGuarded.id,
    terminalReason: "scope_violation",
    error: "generation B violation",
  });
  const terminationB = (fenceB.current?.lifecycleState as any)?.terminationPending;
  assert.ok(terminationB);
  assert.equal(typeof terminationB.generation, "string");
  assert.notEqual(terminationB.generation, terminationA.generation);

  const staleA = (store as any).completeTerminationCAS({
    agentId: generationGuarded.id,
    generation: terminationA.generation,
    workerPid: terminationA.workerPid,
    workerToken: terminationA.workerToken,
    turnEndBaseline: { changedPaths: [], head: null },
  });
  assert.equal(staleA.applied, false);
  const afterStaleA = store.getById(generationGuarded.id);
  assert.deepEqual((afterStaleA?.lifecycleState as any)?.terminationPending, terminationB);
  assert.equal(afterStaleA?.terminalReason, "scope_violation");
  assert.equal(afterStaleA?.error, "generation B violation");
  const generationBBeforeCallbacks = store.getById(generationGuarded.id)!;
  assert.equal(store.prepareWorkerCAS(
    generationGuarded.id,
    terminationA.generation,
    "token-generation-a",
  ).applied, false);
  assert.equal(store.claimWorkerCAS(
    generationGuarded.id,
    terminationA.generation,
    "token-generation-a",
    2001,
  ).applied, false);
  assert.equal(store.markWorkerSpawnedCAS(
    generationGuarded.id,
    terminationA.generation,
    "token-generation-a",
    2001,
  ).applied, false);
  assert.equal(store.updateTurnEvidenceCAS(
    generationGuarded.id,
    terminationA.generation,
    "token-generation-a",
    { scopeBaseline: { changedPaths: ["stale"], head: null } },
  ).applied, false);
  assert.equal(store.bindProviderSessionCAS(
    generationGuarded.id,
    terminationA.generation,
    "token-generation-a",
    "stale-provider-session",
  ).applied, false);
  assert.equal(store.finishTurnCAS({
    agentId: generationGuarded.id,
    generation: terminationA.generation,
    workerToken: "token-generation-a",
    status: "idle",
    latestResponse: "stale finish",
  }).applied, false);
  assert.equal(store.failTurnCAS({
    agentId: generationGuarded.id,
    generation: terminationA.generation,
    workerToken: "token-generation-a",
    error: "stale fail",
  }).applied, false);
  assert.equal(store.failLaunchCAS(
    generationGuarded.id,
    terminationA.generation,
    "token-generation-a",
    "stale launch failure",
  ).applied, false);
  assert.equal(store.recordTerminationFailureCAS({
    agentId: generationGuarded.id,
    generation: terminationA.generation,
    workerPid: 2001,
    workerToken: "token-generation-a",
    failure: "stale termination failure",
  }).applied, false);
  assert.throws(
    () => store.markExecutionStarted(generationGuarded.id, "token-generation-a", undefined, terminationA.generation),
    /no longer active/,
  );
  assert.deepEqual(store.getById(generationGuarded.id), generationBBeforeCallbacks);

  const otherStore = new LocalAgentStore(root);
  stores.push(otherStore);
  const createdFromOtherStore = otherStore.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "explorer",
    provider: "claude",
  });

  assert.deepEqual(
    store.list({ workspaceId: "ws_1" }).map((agent) => agent.id).sort(),
    [created.id, failedContinuation.id, effectReceiptRecord.id, fenced.id, generationGuarded.id, createdFromOtherStore.id].sort(),
  );

  const legacyStateDir = join(root, "legacy-state");
  mkdirSync(legacyStateDir, { recursive: true });
  const legacy = new Database(databasePath(legacyStateDir));
  legacy.exec(`
    create table devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
    create table local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      thinking text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );
  `);
  const migration = legacy.prepare(
    "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
  );
  // Leave migration 3 unapplied to exercise an interrupted legacy upgrade:
  // it adds an empty effort column before migration 6 copies thinking values.
  for (const [version, name] of [[1, "workspace-state"], [2, "oauth-state"], [4, "workspace-conversation-bindings"]] as const) {
    migration.run(version, name, "2026-08-01T00:00:00.000Z");
  }
  legacy.prepare(`
    insert into local_agent_sessions (
      id, workspace_root, profile_name, provider, thinking, status, error, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "agt_legacy",
    join(root, "legacy-project"),
    "reviewer",
    "codex",
    "high",
    "error",
    "old error",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
  );
  legacy.close();

  const upgradedStore = new LocalAgentStore(legacyStateDir);
  stores.push(upgradedStore);
  const legacyRecord = upgradedStore.getById("agt_legacy");
  assert.equal(legacyRecord?.error, "old error");
  assert.equal(legacyRecord?.effort, "high");
  assert.equal(legacyRecord?.errorCode, undefined);
  assert.equal(legacyRecord?.errorRetryable, undefined);
  assert.equal(legacyRecord?.providerContinuityState, "UNKNOWN");
  const upgradedRecord = upgradedStore.update("agt_legacy", {
    errorCode: "DAEMON_TIMEOUT",
    errorRetryable: true,
  });
  assert.equal(upgradedRecord.errorCode, "DAEMON_TIMEOUT");
  assert.equal(upgradedRecord.errorRetryable, true);
  const reloadedRecord = upgradedStore.getById("agt_legacy");
  assert.equal(reloadedRecord?.error, "old error");
  assert.equal(reloadedRecord?.errorCode, "DAEMON_TIMEOUT");
  assert.equal(reloadedRecord?.errorRetryable, true);

  const contracted = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "implementer",
    provider: "codex",
    executionContract: {
      writePaths: ["src"],
      maxFiles: 3,
      maxWallMs: 60_000,
      toolchainId: "nexus-python",
    },
  });
  assert.deepEqual(store.getById(contracted.id)?.executionContract?.writePaths, ["src"]);
  assert.equal(store.getById(contracted.id)?.executionContract?.maxWallMs, 60_000);
  assert.equal(store.getById(contracted.id)?.executionContract?.toolchainId, "nexus-python");

  const completed = store.update(contracted.id, {
    status: "error",
    terminalReason: "scope_violation",
    scopeState: "SCOPE_VIOLATION",
    scopeBaseline: { changedPaths: [], head: "abc123" },
  });
  assert.equal(completed.terminalReason, "scope_violation");
  assert.equal(completed.scopeState, "SCOPE_VIOLATION");
  assert.deepEqual(completed.scopeBaseline, { changedPaths: [], head: "abc123" });
  assert.equal(store.getById(contracted.id)?.scopeState, "SCOPE_VIOLATION");
  assert.equal(store.getById(contracted.id)?.terminalReason, "scope_violation");
  assert.equal(store.getById(contracted.id)?.scopeBaseline?.head, "abc123");

  const fingerprintsBaseline: ScopeBaseline = {
    changedPaths: ["src/a.ts", "src/b.ts"],
    head: "abc123",
    fingerprints: {
      "src/a.ts": {
        kind: "modified",
        contentHash: "aa11bb22",
        size: 42,
        gitStateHash: "1111111111111111111111111111111111111111111111111111111111111111",
      },
      "src/b.ts": {
        kind: "deleted",
        contentHash: null,
        size: 0,
        gitStateHash: "2222222222222222222222222222222222222222222222222222222222222222",
      },
    },
  };
  const roundTrip = store.update(contracted.id, { scopeBaseline: fingerprintsBaseline });
  assert.deepEqual(roundTrip.scopeBaseline, fingerprintsBaseline);
  assert.deepEqual(store.getById(contracted.id)?.scopeBaseline, fingerprintsBaseline);
  const persistedFingerprints = store.getById(contracted.id)?.scopeBaseline?.fingerprints;
  assert.deepEqual(persistedFingerprints, fingerprintsBaseline.fingerprints);
  assert.equal(persistedFingerprints?.["src/a.ts"]?.kind, "modified");
  assert.equal(persistedFingerprints?.["src/a.ts"]?.contentHash, "aa11bb22");
  assert.equal(persistedFingerprints?.["src/a.ts"]?.size, 42);
  assert.equal(
    persistedFingerprints?.["src/a.ts"]?.gitStateHash,
    "1111111111111111111111111111111111111111111111111111111111111111",
  );
  assert.equal(persistedFingerprints?.["src/b.ts"]?.kind, "deleted");
  assert.equal(persistedFingerprints?.["src/b.ts"]?.contentHash, null);
  assert.equal(persistedFingerprints?.["src/b.ts"]?.size, 0);
  assert.equal(
    persistedFingerprints?.["src/b.ts"]?.gitStateHash,
    "2222222222222222222222222222222222222222222222222222222222222222",
  );

  const legacyBaseline = store.update(contracted.id, {
    scopeBaseline: { changedPaths: ["src/old.ts"], head: "deadbeef" },
  });
  assert.deepEqual(legacyBaseline.scopeBaseline, { changedPaths: ["src/old.ts"], head: "deadbeef" });
  assert.equal(store.getById(contracted.id)?.scopeBaseline?.head, "deadbeef");
  assert.equal(store.getById(contracted.id)?.scopeBaseline?.fingerprints, undefined);

  const compatibilityStateDir = join(root, "lifecycle-kind-compatibility");
  const compatibilityStore = new LocalAgentStore(compatibilityStateDir);
  stores.push(compatibilityStore);
  const legacyManagerRecord = compatibilityStore.create({
    workspaceId: "ws_legacy_manager",
    workspaceRoot: join(root, "legacy-manager"),
    profileName: "reviewer",
    provider: "codex",
  });
  assert.equal((legacyManagerRecord.lifecycleState as any)?.lifecycleKind, undefined);
  const legacyMetadata = compatibilityStore.update(legacyManagerRecord.id, {
    model: "legacy-model",
    effort: "legacy-effort",
    executionContract: { maxWallMs: 1234 },
    startReplay: { key: "legacy-replay", requestHash: "legacy-request-hash" },
  });
  assert.equal(legacyMetadata.model, "legacy-model");
  assert.equal(legacyMetadata.effort, "legacy-effort");
  assert.equal(legacyMetadata.executionContract?.maxWallMs, 1234);
  assert.equal(legacyMetadata.startReplay?.key, "legacy-replay");
  compatibilityStore.update(legacyManagerRecord.id, { status: "running" });
  assert.equal(compatibilityStore.reconcileActiveRuns(), 1);
  const reconciledLegacy = compatibilityStore.getById(legacyManagerRecord.id)!;
  assert.equal(reconciledLegacy.status, "error");
  assert.equal((reconciledLegacy.lifecycleState as any)?.terminationPending, undefined);
  assert.equal(reconciledLegacy.errorCode, "DAEMON_UNAVAILABLE");
  assert.equal(reconciledLegacy.errorRetryable, true);

  const exactLegacyDetached = compatibilityStore.create({
    workspaceId: "ws_legacy_exact",
    workspaceRoot: join(root, "legacy-exact"),
    profileName: "reviewer",
    provider: "codex",
  });
  compatibilityStore.update(exactLegacyDetached.id, {
    status: "running",
    workerPid: 4101,
    workerToken: "legacy-exact-token",
  });
  assert.equal(compatibilityStore.reconcileActiveRuns(), 1);
  const adoptedExact = compatibilityStore.getById(exactLegacyDetached.id)!;
  assert.equal((adoptedExact.lifecycleState as any)?.lifecycleKind, "detached_worker_v2");
  assert.equal((adoptedExact.lifecycleState as any)?.terminationPending?.workerPid, 4101);
  assert.equal((adoptedExact.lifecycleState as any)?.terminationPending?.workerToken, "legacy-exact-token");

  const partialLegacyDetached = compatibilityStore.create({
    workspaceId: "ws_legacy_partial",
    workspaceRoot: join(root, "legacy-partial"),
    profileName: "reviewer",
    provider: "codex",
  });
  compatibilityStore.update(partialLegacyDetached.id, {
    status: "starting",
    workerToken: "legacy-partial-token",
  });
  assert.equal(compatibilityStore.reconcileActiveRuns(), 1);
  const blockedPartial = compatibilityStore.getById(partialLegacyDetached.id)!;
  assert.equal((blockedPartial.lifecycleState as any)?.lifecycleKind, "detached_worker_v2");
  assert.ok((blockedPartial.lifecycleState as any)?.terminationBlocked);
  assert.equal((blockedPartial.lifecycleState as any)?.terminationPending, undefined);
  assert.equal(blockedPartial.workerToken, "legacy-partial-token");

  const detachedRecord = compatibilityStore.create({
    workspaceId: "ws_detached_v2",
    workspaceRoot: join(root, "detached-v2"),
    profileName: "reviewer",
    provider: "codex",
    lifecycleKind: "detached_worker_v2",
  } as any);
  assert.equal((detachedRecord.lifecycleState as any)?.lifecycleKind, "detached_worker_v2");
  const detachedIdentity = compatibilityStore.getById(detachedRecord.id)!;
  const forbiddenDetachedPatches = [
    { workspaceId: "ws_redirected" },
    { workspaceRoot: join(root, "redirected") },
    { profileName: "redirected-profile" },
    { provider: "redirected-provider" },
    { model: "redirected-model" },
    { effort: "redirected-effort" },
    { executionContract: { maxWallMs: 999999 } },
    { startReplay: { key: "redirected-replay", requestHash: "redirected-request" } },
    { status: "idle" as const },
  ];
  for (const patch of forbiddenDetachedPatches) {
    assert.throws(
      () => compatibilityStore.update(detachedRecord.id, patch),
      /generation-owned detached lifecycle/i,
    );
  }
  assert.deepEqual(compatibilityStore.getById(detachedRecord.id), detachedIdentity);
  compatibilityStore.prepareWorker(detachedRecord.id, "detached-guard-token");
  compatibilityStore.claimWorker(detachedRecord.id, "detached-guard-token", 4102);
  const claimedDetached = compatibilityStore.getById(detachedRecord.id)!;
  assert.throws(
    () => compatibilityStore.update(detachedRecord.id, { effort: "stale-claim-writer" }),
    /generation-owned detached lifecycle/i,
  );
  assert.deepEqual(compatibilityStore.getById(detachedRecord.id), claimedDetached);
  const guardedFence = compatibilityStore.fenceActiveTurn({
    agentId: detachedRecord.id,
    terminalReason: "timeout",
    error: "detached guard timeout",
  });
  const guardedGeneration = guardedFence.current!.lifecycleState!.terminationPending!.generation;
  assert.throws(
    () => compatibilityStore.update(detachedRecord.id, { workspaceRoot: join(root, "stale-fence-writer") }),
    /generation-owned detached lifecycle/i,
  );
  const pendingAfterStaleWriter = compatibilityStore.getById(detachedRecord.id)!;
  assert.equal(pendingAfterStaleWriter.lifecycleState!.terminationPending!.generation, guardedGeneration);
  assert.equal(pendingAfterStaleWriter.status, "error");
  assert.equal(pendingAfterStaleWriter.workerPid, 4102);
  assert.equal(pendingAfterStaleWriter.workerToken, "detached-guard-token");
  assert.equal(pendingAfterStaleWriter.workspaceRoot, detachedIdentity.workspaceRoot);
  const joinedCancel = compatibilityStore.cancelActive(detachedRecord.id);
  assert.equal(joinedCancel.current.lifecycleState!.terminationPending!.generation, guardedGeneration);
  assert.equal(joinedCancel.current.lifecycleState!.terminationPending!.reason, "timeout");

  const finishedDetached = compatibilityStore.create({
    workspaceId: "ws_detached_finished",
    workspaceRoot: join(root, "detached-finished"),
    profileName: "reviewer",
    provider: "codex",
    executionContract: { maxExecutionMs: 4321 },
    startReplay: { key: "detached-finished", requestHash: "detached-finished-request" },
    lifecycleKind: "detached_worker_v2",
  });
  compatibilityStore.prepareWorker(finishedDetached.id, "detached-finished-token");
  const finishedClaim = compatibilityStore.claimWorker(
    finishedDetached.id,
    "detached-finished-token",
    4103,
  )!;
  assert.equal(compatibilityStore.finishTurnCAS({
    agentId: finishedDetached.id,
    generation: finishedClaim.lifecycleState!.activeTurn!.generation!,
    workerToken: "detached-finished-token",
    status: "idle",
    terminalReason: "completed",
    latestResponse: "finished",
  }).applied, true);
  const finishedSnapshot = compatibilityStore.getById(finishedDetached.id)!;
  assert.throws(
    () => compatibilityStore.update(finishedDetached.id, { model: "stale-finish-writer" }),
    /generation-owned detached lifecycle/i,
  );
  assert.deepEqual(compatibilityStore.getById(finishedDetached.id), finishedSnapshot);
  assert.equal(finishedSnapshot.executionContract?.maxExecutionMs, 4321);
  assert.equal(finishedSnapshot.startReplay?.key, "detached-finished");

  const raceStateDir = join(root, "legacy-to-detached-race");
  const raceStoreB = new LocalAgentStore(raceStateDir);
  stores.push(raceStoreB);
  const racedLegacy = raceStoreB.create({
    workspaceId: "ws_raced_legacy",
    workspaceRoot: join(root, "raced-legacy"),
    profileName: "reviewer",
    provider: "codex",
    executionContract: { maxWallMs: 2222 },
    startReplay: { key: "raced-legacy", requestHash: "raced-legacy-request" },
  });
  raceStoreB.update(racedLegacy.id, {
    status: "running",
    workerPid: 4201,
    workerToken: "raced-legacy-token",
    error: "legacy error bytes",
  });
  let observedLegacySnapshot: ReturnType<LocalAgentStore["getById"]>;
  let fencedRaceSnapshot: ReturnType<LocalAgentStore["getById"]>;
  let rawFencedSnapshot: unknown;
  const raceStoreA = new LocalAgentStore(raceStateDir, {
    beforeGenericUpdateLock(snapshot) {
      observedLegacySnapshot = snapshot;
      assert.equal(raceStoreB.reconcileLegacyDetachedActiveCAS(racedLegacy.id).applied, true);
      fencedRaceSnapshot = raceStoreB.getById(racedLegacy.id);
      const database = new Database(databasePath(raceStateDir), { readonly: true });
      rawFencedSnapshot = database.prepare(
        `select workspace_id, workspace_root, profile_name, provider, model, effort,
          worker_pid, worker_token, execution_contract, terminal_reason,
          lifecycle_state, status, latest_response, error, error_code,
          error_retryable, updated_at
         from local_agent_sessions where id = ?`,
      ).get(racedLegacy.id);
      database.close();
    },
  });
  stores.push(raceStoreA);
  assert.throws(
    () => raceStoreA.update(racedLegacy.id, {
      workspaceRoot: join(root, "stale-race-redirect"),
      provider: "stale-provider",
      executionContract: { maxWallMs: 999999 },
      startReplay: { key: "stale-replay", requestHash: "stale-request" },
    }),
    /stale generic update conflict/i,
  );
  assert.equal((observedLegacySnapshot?.lifecycleState as any)?.lifecycleKind, undefined);
  assert.equal((fencedRaceSnapshot?.lifecycleState as any)?.lifecycleKind, "detached_worker_v2");
  assert.equal((fencedRaceSnapshot?.lifecycleState as any)?.terminationPending?.workerPid, 4201);
  assert.equal((fencedRaceSnapshot?.lifecycleState as any)?.terminationPending?.workerToken, "raced-legacy-token");
  assert.deepEqual(raceStoreB.getById(racedLegacy.id), fencedRaceSnapshot);
  const verifyDatabase = new Database(databasePath(raceStateDir), { readonly: true });
  const rawAfterStaleWriter = verifyDatabase.prepare(
    `select workspace_id, workspace_root, profile_name, provider, model, effort,
      worker_pid, worker_token, execution_contract, terminal_reason,
      lifecycle_state, status, latest_response, error, error_code,
      error_retryable, updated_at
     from local_agent_sessions where id = ?`,
  ).get(racedLegacy.id);
  verifyDatabase.close();
  assert.deepEqual(rawAfterStaleWriter, rawFencedSnapshot);

  const corruptStateDir = join(root, "corrupt-detached-lifecycle");
  const corruptStore = new LocalAgentStore(corruptStateDir);
  const corruptRecord = corruptStore.create({
    workspaceId: "ws_corrupt_detached",
    workspaceRoot: join(root, "corrupt-detached"),
    profileName: "reviewer",
    provider: "codex",
    lifecycleKind: "detached_worker_v2",
  } as any);
  const corruptLifecycle = {
    ...(corruptRecord.lifecycleState as any),
    lifecycleKind: "detached_worker_v2",
    activeTurn: {
      ...(corruptRecord.lifecycleState as any).activeTurn,
      executionStartedAt: "invalid",
    },
  };
  corruptStore.close();
  const corruptDatabase = new Database(databasePath(corruptStateDir));
  corruptDatabase.prepare("update local_agent_sessions set lifecycle_state = ? where id = ?")
    .run(JSON.stringify(corruptLifecycle), corruptRecord.id);
  corruptDatabase.close();
  const reopenedCorruptStore = new LocalAgentStore(corruptStateDir);
  stores.push(reopenedCorruptStore);
  const reopenedCorrupt = reopenedCorruptStore.getById(corruptRecord.id)!;
  assert.equal((reopenedCorrupt.lifecycleState as any)?.lifecycleKind, "detached_worker_v2");
  assert.equal((reopenedCorrupt.lifecycleState as any)?.lifecycleCorrupt, true);

  const activityRecord = store.create({
    workspaceId: "ws_activity",
    workspaceRoot: join(root, "activity"),
    profileName: "reviewer",
    provider: "codex",
    lifecycleKind: "detached_worker_v2",
  });
  const activityGeneration = activityRecord.lifecycleState!.activeTurn!.generation!;
  store.prepareWorker(activityRecord.id, "activity-token");
  store.claimWorker(activityRecord.id, "activity-token", 4111);
  const activityAt = new Date(Date.now() + 1000).toISOString();
  assert.equal(store.touchActivityCAS(activityRecord.id, activityGeneration, "activity-token", activityAt).applied, true);
  assert.equal(
    store.getById(activityRecord.id)?.lifecycleState?.activeTurn?.lastActivityAt,
    activityAt,
  );
  assert.equal(store.touchActivityCAS(activityRecord.id, "stale-generation", "activity-token").applied, false);

  // Case A & C: failTurnCAS persists errorCode, errorRetryable, errorDetails
  const failureAgent = store.create({
    workspaceId: "ws_failure",
    workspaceRoot: join(root, "failure"),
    profileName: "cline-reviewer",
    provider: "cline",
    lifecycleKind: "detached_worker_v2",
  });
  const failGeneration = failureAgent.lifecycleState!.activeTurn!.generation!;
  store.prepareWorker(failureAgent.id, "fail-token");
  store.claimWorker(failureAgent.id, "fail-token", 5222);

  const failResult = store.failTurnCAS({
    agentId: failureAgent.id,
    generation: failGeneration,
    workerToken: "fail-token",
    error: "Subscription required for ClinePass",
    errorCode: "CLINEPASS_ENTITLEMENT_REQUIRED",
    errorRetryable: false,
    errorDetails: {
      code: "CLINEPASS_ENTITLEMENT_REQUIRED",
      errorClass: "ENTITLEMENT_REQUIRED",
      retryable: false,
      model: "cline-pass/glm-5.3-flash",
      variant: "high",
      providerSessionId: "sess-cline-999",
      providerMessage: "Account lacks entitlement",
    },
    terminalReason: "provider_error",
  });
  assert.equal(failResult.applied, true);

  const readFailed = store.getById(failureAgent.id)!;
  assert.equal(readFailed.status, "error");
  assert.equal(readFailed.errorCode, "CLINEPASS_ENTITLEMENT_REQUIRED");
  assert.equal(readFailed.errorRetryable, false);
  assert.deepEqual(readFailed.errorDetails, {
    code: "CLINEPASS_ENTITLEMENT_REQUIRED",
    errorClass: "ENTITLEMENT_REQUIRED",
    retryable: false,
    model: "cline-pass/glm-5.3-flash",
    variant: "high",
    providerSessionId: "sess-cline-999",
    providerMessage: "Account lacks entitlement",
  });

  // Case D: successful finishTurnCAS clears prior error fields
  const successAgent = store.create({
    workspaceId: "ws_success",
    workspaceRoot: join(root, "success"),
    profileName: "agy-reviewer",
    provider: "agy",
    lifecycleKind: "detached_worker_v2",
  });
  const succGeneration = successAgent.lifecycleState!.activeTurn!.generation!;
  store.prepareWorker(successAgent.id, "succ-token");
  store.claimWorker(successAgent.id, "succ-token", 5333);

  const succResult = store.finishTurnCAS({
    agentId: successAgent.id,
    generation: succGeneration,
    workerToken: "succ-token",
    status: "idle",
    latestResponse: "All good",
    terminalReason: "completed",
  });
  assert.equal(succResult.applied, true);

  const readSuccess = store.getById(successAgent.id)!;
  assert.equal(readSuccess.status, "idle");
  assert.equal(readSuccess.errorCode, undefined);
  assert.equal(readSuccess.errorRetryable, undefined);
  assert.equal(readSuccess.errorDetails, undefined);

  // Case E: cheap count and countResult projection
  const totalCount = store.count();
  const totalCountResult = store.countResult();
  assert.equal(totalCount >= 2, true);
  assert.equal(totalCountResult.isOk(), true);
  assert.equal(totalCountResult.unwrap(), totalCount);

  const scopedWsCount = store.count({ workspaceId: "ws_success" });
  assert.equal(scopedWsCount, 1);
  const scopedWsAndRootCount = store.count({ workspaceId: "ws_success", workspaceRoot: join(root, "success") });
  assert.equal(scopedWsAndRootCount, 1);
  // Case F: bindExternalRuntimeBindingCAS and StoredExecutionStateV2
  const bindingAgent = store.create({
    workspaceId: "ws_binding",
    workspaceRoot: join(root, "binding"),
    profileName: "reviewer",
    provider: "agy",
    startReplay: {
      key: "attempt-bind-1",
      requestHash: "hash-123",
    },
  });

  const testBinding = {
    runtimeKind: "HERDR",
    handle: {
      attemptKey: "attempt-bind-1",
      workspaceId: "ws_binding",
      herdrSocketPath: "/tmp/herdr.sock",
    },
  };

  // Successful binding
  const bindRes = store.bindExternalRuntimeBindingCAS({
    agentId: bindingAgent.id,
    expectedAttemptKey: "attempt-bind-1",
    binding: testBinding,
  });
  assert.equal(bindRes.applied, true);

  const boundRecord = store.getById(bindingAgent.id)!;
  assert.deepEqual(boundRecord.externalRuntimeBinding, testBinding);
  // provider_session_id is NOT modified
  assert.equal(boundRecord.providerSessionId, undefined);

  // Idempotent re-binding succeeds
  const rebindRes = store.bindExternalRuntimeBindingCAS({
    agentId: bindingAgent.id,
    expectedAttemptKey: "attempt-bind-1",
    binding: testBinding,
  });
  assert.equal(rebindRes.applied, true);

  // Conflicting handle fails CAS
  const conflictRes = store.bindExternalRuntimeBindingCAS({
    agentId: bindingAgent.id,
    expectedAttemptKey: "attempt-bind-1",
    binding: {
      runtimeKind: "HERDR",
      handle: { attemptKey: "attempt-bind-1", different: true },
    },
  });
  assert.equal(conflictRes.applied, false);

  // Mismatched expectedAttemptKey fails CAS
  const mismatchAttemptRes = store.bindExternalRuntimeBindingCAS({
    agentId: bindingAgent.id,
    expectedAttemptKey: "wrong-attempt-key",
    binding: testBinding,
  });
  assert.equal(mismatchAttemptRes.applied, false);

  // v1 backward compatibility: simulate a raw v1 row
  const rawDb = (store as any).database.sqlite;
  rawDb.prepare(`
    insert into local_agent_sessions (
      id, workspace_root, profile_name, provider, status, execution_contract, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "agt_legacy_v1",
    join(root, "legacy"),
    "reviewer",
    "codex",
    "starting",
    JSON.stringify({
      storedExecutionStateVersion: 1,
      executionContract: null,
      startReplay: { key: "legacy-key", requestHash: "legacy-hash" },
    }),
    new Date().toISOString(),
    new Date().toISOString(),
  );

  const legacyV1Record = store.getById("agt_legacy_v1");
  assert.ok(legacyV1Record);
  assert.equal(legacyV1Record.startReplay?.key, "legacy-key");
  assert.equal(legacyV1Record.externalRuntimeBinding, undefined);

  // Case G: Negative controls for CAS fail-closed on missing authority evidence (Blocker B)
  // CAS-MISSING-ATTEMPT: startReplay absent, expectedAttemptKey supplied -> applied: false
  const noReplayAgent = store.create({
    workspaceId: "ws_no_replay",
    workspaceRoot: join(root, "no_replay"),
    profileName: "reviewer",
    provider: "agy",
  });
  const missingAttemptRes = store.bindExternalRuntimeBindingCAS({
    agentId: noReplayAgent.id,
    expectedAttemptKey: "some-attempt-key",
    binding: testBinding,
  });
  assert.equal(missingAttemptRes.applied, false, "CAS-MISSING-ATTEMPT must fail closed");

  // CAS-MISSING-DISPATCH: dispatchIntent absent, expectedDispatchIntentHash supplied -> applied: false
  const missingDispatchRes = store.bindExternalRuntimeBindingCAS({
    agentId: noReplayAgent.id,
    expectedDispatchIntentHash: "intent-hash-xyz",
    binding: testBinding,
  });
  assert.equal(missingDispatchRes.applied, false, "CAS-MISSING-DISPATCH must fail closed");

  // CAS-WRONG-ATTEMPT: startReplay is attempt-bind-wrong, expected is attempt-bind-expected -> applied: false
  const wrongReplayAgent = store.create({
    workspaceId: "ws_wrong_replay",
    workspaceRoot: join(root, "wrong_replay"),
    profileName: "reviewer",
    provider: "agy",
    startReplay: {
      key: "attempt-bind-stored",
      requestHash: "hash-stored",
    },
  });
  const wrongAttemptRes = store.bindExternalRuntimeBindingCAS({
    agentId: wrongReplayAgent.id,
    expectedAttemptKey: "attempt-bind-expected",
    binding: testBinding,
  });
  assert.equal(wrongAttemptRes.applied, false, "CAS-WRONG-ATTEMPT must fail closed");

  // CAS-WRONG-DISPATCH: executionContract.dispatchIntent has different hash -> applied: false
  const dispatchAgent = store.create({
    workspaceId: "ws_dispatch",
    workspaceRoot: join(root, "dispatch"),
    profileName: "reviewer",
    provider: "agy",
    executionContract: {
      writePaths: ["src/local-agent-store.ts"],
      dispatchIntent: {
        taskId: "task-intent-1",
        attemptId: "attempt-intent-1",
        objective: "Implement one bounded controller-contract seam.",
        roleIntent: "DEEP_ENGINEERING",
        claimCeiling: "CANDIDATE_READY",
        context: ["Preserve existing execution mechanics."],
        readScope: ["src"],
        writeScope: ["src/local-agent-store.ts"],
        exclusiveOwnership: true,
        forbiddenChanges: ["Do not add route or acceptance authority to Dev MCP."],
        acceptanceCriteria: ["Typed controller intent is durable and independently inspectable."],
        verificationRequired: true,
        expectedArtifacts: ["source diff"],
      },
    },
    startReplay: {
      key: "attempt-intent-1",
      requestHash: "hash-intent-1",
    },
  });
  const wrongDispatchRes = store.bindExternalRuntimeBindingCAS({
    agentId: dispatchAgent.id,
    expectedAttemptKey: "attempt-intent-1",
    expectedDispatchIntentHash: "sha256-wrong-intent-hash",
    binding: {
      runtimeKind: "HERDR",
      handle: { attemptKey: "attempt-intent-1" },
    },
  });
  assert.equal(wrongDispatchRes.applied, false, "CAS-WRONG-DISPATCH must fail closed");

  // CAS-CONCURRENT-UPDATE: stale updated_at -> applied: false
  const staleUpdateRes = store.bindExternalRuntimeBindingCAS({
    agentId: dispatchAgent.id,
    expectedAttemptKey: "attempt-intent-1",
    expectedUpdatedAt: "1970-01-01T00:00:00.000Z",
    binding: {
      runtimeKind: "HERDR",
      handle: { attemptKey: "attempt-intent-1" },
    },
  });
  assert.equal(staleUpdateRes.applied, false, "CAS-CONCURRENT-UPDATE must fail closed");

  // CAS-EXACT: exact match for attemptKey and dispatchIntentHash -> applied: true
  const correctDispatchHash = hashDispatchIntent(dispatchAgent.executionContract!.dispatchIntent!);
  const exactRes = store.bindExternalRuntimeBindingCAS({
    agentId: dispatchAgent.id,
    expectedAttemptKey: "attempt-intent-1",
    expectedDispatchIntentHash: correctDispatchHash,
    expectedUpdatedAt: dispatchAgent.updatedAt,
    binding: {
      runtimeKind: "HERDR",
      handle: {
        attemptKey: "attempt-intent-1",
        dispatchIntentHash: correctDispatchHash,
        promptNonce: "nonce-dispatch-1",
      },
    },
  });
  assert.equal(exactRes.applied, true, "CAS-EXACT must succeed");

  // Case H: fenceConsequentialPromptCAS exact authority tuple (Blocker C1)
  // 1. Cannot fence unbound agent (PF-MISSING-HANDLE)
  const unBoundFenceRes = store.fenceConsequentialPromptCAS({
    agentId: noReplayAgent.id,
    attemptKey: "some-attempt",
    dispatchIntentHash: "some-hash",
    promptNonce: "nonce-unbound",
  });
  assert.equal(unBoundFenceRes.applied, false, "PF-MISSING-HANDLE must fail closed");

  // PF-WRONG-AGENT-ATTEMPT: agentId is dispatchAgent (bound to attempt-intent-1), input attemptKey is WRONG-ATTEMPT
  const wrongAttemptFenceRes = store.fenceConsequentialPromptCAS({
    agentId: dispatchAgent.id,
    attemptKey: "WRONG-ATTEMPT",
    dispatchIntentHash: correctDispatchHash,
    promptNonce: "nonce-dispatch-1",
  });
  assert.equal(wrongAttemptFenceRes.applied, false, "PF-WRONG-AGENT-ATTEMPT must fail closed");

  // PF-WRONG-DISPATCH: input dispatchIntentHash is wrong
  const wrongDispatchFenceRes = store.fenceConsequentialPromptCAS({
    agentId: dispatchAgent.id,
    attemptKey: "attempt-intent-1",
    dispatchIntentHash: "wrong-dispatch-hash",
    promptNonce: "nonce-dispatch-1",
  });
  assert.equal(wrongDispatchFenceRes.applied, false, "PF-WRONG-DISPATCH must fail closed");

  // PF-WRONG-NONCE: stored handle nonce is nonce-dispatch-1, input is WRONG-NONCE
  const wrongNonceFenceRes = store.fenceConsequentialPromptCAS({
    agentId: dispatchAgent.id,
    attemptKey: "attempt-intent-1",
    dispatchIntentHash: correctDispatchHash,
    promptNonce: "WRONG-NONCE",
  });
  assert.equal(wrongNonceFenceRes.applied, false, "PF-WRONG-NONCE must fail closed");

  // PF-MALFORMED-HANDLE: handle missing required fields
  const malformedAgent = store.create({
    workspaceId: "ws_malformed",
    workspaceRoot: join(root, "malformed"),
    profileName: "reviewer",
    provider: "agy",
    executionContract: {
      writePaths: ["src"],
      dispatchIntent: dispatchAgent.executionContract!.dispatchIntent!,
    },
    startReplay: {
      key: "attempt-malformed",
      requestHash: "hash-malformed",
    },
  });
  store.bindExternalRuntimeBindingCAS({
    agentId: malformedAgent.id,
    expectedAttemptKey: "attempt-malformed",
    expectedDispatchIntentHash: correctDispatchHash,
    binding: {
      runtimeKind: "HERDR",
      handle: { attemptKey: "attempt-malformed" }, // missing dispatchIntentHash and promptNonce
    },
  });
  const malformedFenceRes = store.fenceConsequentialPromptCAS({
    agentId: malformedAgent.id,
    attemptKey: "attempt-malformed",
    dispatchIntentHash: correctDispatchHash,
    promptNonce: "nonce-malformed",
  });
  assert.equal(malformedFenceRes.applied, false, "PF-MALFORMED-HANDLE must fail closed");

  // PF-WRONG-RUNTIME: runtimeKind !== HERDR
  const wrongRuntimeAgent = store.create({
    workspaceId: "ws_wrong_rt",
    workspaceRoot: join(root, "wrong_rt"),
    profileName: "reviewer",
    provider: "agy",
    executionContract: {
      writePaths: ["src"],
      dispatchIntent: dispatchAgent.executionContract!.dispatchIntent!,
    },
    startReplay: {
      key: "attempt-wrong-rt",
      requestHash: "hash-wrong-rt",
    },
  });
  store.bindExternalRuntimeBindingCAS({
    agentId: wrongRuntimeAgent.id,
    expectedAttemptKey: "attempt-wrong-rt",
    expectedDispatchIntentHash: correctDispatchHash,
    binding: {
      runtimeKind: "OTHER_RUNTIME",
      handle: {
        attemptKey: "attempt-wrong-rt",
        dispatchIntentHash: correctDispatchHash,
        promptNonce: "nonce-wrong-rt",
      },
    },
  });
  const wrongRuntimeFenceRes = store.fenceConsequentialPromptCAS({
    agentId: wrongRuntimeAgent.id,
    attemptKey: "attempt-wrong-rt",
    dispatchIntentHash: correctDispatchHash,
    promptNonce: "nonce-wrong-rt",
  });
  assert.equal(wrongRuntimeFenceRes.applied, false, "PF-WRONG-RUNTIME must fail closed");

  // PF-CONCURRENT: stale expectedUpdatedAt
  const concurrentFenceRes = store.fenceConsequentialPromptCAS({
    agentId: dispatchAgent.id,
    attemptKey: "attempt-intent-1",
    dispatchIntentHash: correctDispatchHash,
    promptNonce: "nonce-dispatch-1",
    expectedUpdatedAt: "1970-01-01T00:00:00.000Z",
  });
  assert.equal(concurrentFenceRes.applied, false, "PF-CONCURRENT must fail closed");

  // PF-EXACT: exact authority tuple succeeds
  const exactFenceRes = store.fenceConsequentialPromptCAS({
    agentId: dispatchAgent.id,
    attemptKey: "attempt-intent-1",
    dispatchIntentHash: correctDispatchHash,
    promptNonce: "nonce-dispatch-1",
  });
  assert.equal(exactFenceRes.applied, true, "PF-EXACT must succeed");
  const postFenceRecord = store.getById(dispatchAgent.id)!;
  assert.equal(postFenceRecord.externalRuntimeBinding?.promptState?.consequentialPromptFenced, true);
  assert.equal(postFenceRecord.externalRuntimeBinding?.promptState?.promptNonce, "nonce-dispatch-1");
  assert.ok(postFenceRecord.externalRuntimeBinding?.promptState?.fencedAt);

  // Second fence on same agent/attemptKey fails CAS (one consequential prompt fence)
  const secondFenceRes = store.fenceConsequentialPromptCAS({
    agentId: dispatchAgent.id,
    attemptKey: "attempt-intent-1",
    dispatchIntentHash: correctDispatchHash,
    promptNonce: "nonce-dispatch-1",
  });
  assert.equal(secondFenceRes.applied, false, "Second fence must fail CAS");

  // Independent physical reproducer (Section 49)
  // stored attempt = attempt-intent-1, stored nonce = nonce-dispatch-1
  // fence call: attempt = WRONG-ATTEMPT, nonce = WRONG-NONCE -> applied: false, stored promptState unchanged
  const independentReprodRes = store.fenceConsequentialPromptCAS({
    agentId: dispatchAgent.id,
    attemptKey: "WRONG-ATTEMPT",
    dispatchIntentHash: correctDispatchHash,
    promptNonce: "WRONG-NONCE",
  });
  assert.equal(independentReprodRes.applied, false, "Independent reproducer must fail closed");
  const uncorruptedRecord = store.getById(dispatchAgent.id)!;
  assert.equal(uncorruptedRecord.externalRuntimeBinding?.promptState?.promptNonce, "nonce-dispatch-1");

  // DevSpace restart persistence: create a second store instance on same directory
  const reopenedStore = new LocalAgentStore(root);
  stores.push(reopenedStore);
  const reopenedRecord = reopenedStore.getById(dispatchAgent.id)!;
  assert.ok(reopenedRecord);
  assert.equal(reopenedRecord.externalRuntimeBinding?.promptState?.consequentialPromptFenced, true);
  assert.equal(reopenedRecord.externalRuntimeBinding?.promptState?.promptNonce, "nonce-dispatch-1");

  // Fence on reopened store fails CAS
  const reopenedFenceRes = reopenedStore.fenceConsequentialPromptCAS({
    agentId: dispatchAgent.id,
    attemptKey: "attempt-intent-1",
    dispatchIntentHash: correctDispatchHash,
    promptNonce: "nonce-dispatch-1",
  });
  assert.equal(reopenedFenceRes.applied, false, "Fence after restart must fail CAS on already fenced attempt");

  // Case I: fenceExternalRuntimeLaunchCAS and positive observation (Blocker C2)
  const launchAgent = store.create({
    workspaceId: "ws_launch_test",
    workspaceRoot: join(root, "launch_project"),
    profileName: "reviewer",
    provider: "agy",
    executionContract: {
      writePaths: ["src"],
      dispatchIntent: {
        taskId: "task-launch-1",
        attemptId: "attempt-launch-1",
        objective: "Test launch fencing.",
        roleIntent: "DEEP_ENGINEERING",
        claimCeiling: "CANDIDATE_READY",
        context: ["test"],
        readScope: ["src"],
        writeScope: ["src"],
        exclusiveOwnership: true,
        forbiddenChanges: [],
        acceptanceCriteria: ["pass"],
        verificationRequired: true,
        expectedArtifacts: [],
      },
    },
    startReplay: {
      key: "attempt-launch-1",
      requestHash: "hash-launch-1",
    },
  });
  const launchIntentHash = hashDispatchIntent(launchAgent.executionContract!.dispatchIntent!);

  // L-WRONG-ATTEMPT: launch fence with wrong attemptKey fails
  assert.equal(store.fenceExternalRuntimeLaunchCAS({
    agentId: launchAgent.id,
    attemptKey: "WRONG-ATTEMPT",
    dispatchIntentHash: launchIntentHash,
    canonicalWorktreePath: join(root, "launch_project"),
    gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
    agentKind: "opencode",
    promptNonce: "NONCE-LAUNCH-1",
  }).applied, false);

  // L-WRONG-DISPATCH: launch fence with wrong dispatchIntentHash fails
  assert.equal(store.fenceExternalRuntimeLaunchCAS({
    agentId: launchAgent.id,
    attemptKey: "attempt-launch-1",
    dispatchIntentHash: "wrong-dispatch-hash",
    canonicalWorktreePath: join(root, "launch_project"),
    gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
    agentKind: "opencode",
    promptNonce: "NONCE-LAUNCH-1",
  }).applied, false);

  // L-WRONG-WORKTREE: launch fence with wrong canonicalWorktreePath fails
  assert.equal(store.fenceExternalRuntimeLaunchCAS({
    agentId: launchAgent.id,
    attemptKey: "attempt-launch-1",
    dispatchIntentHash: launchIntentHash,
    canonicalWorktreePath: join(root, "other_project"),
    gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
    agentKind: "opencode",
    promptNonce: "NONCE-LAUNCH-1",
  }).applied, false);

  // L-INVALID-GIT-HEAD: non-40 hex gitHeadBefore fails
  assert.equal(store.fenceExternalRuntimeLaunchCAS({
    agentId: launchAgent.id,
    attemptKey: "attempt-launch-1",
    dispatchIntentHash: launchIntentHash,
    canonicalWorktreePath: join(root, "launch_project"),
    gitHeadBefore: "invalid-head",
    agentKind: "opencode",
    promptNonce: "NONCE-LAUNCH-1",
  }).applied, false);

  // L-FRESH-LAUNCH: fresh launch fence succeeds
  const freshLaunchRes = store.fenceExternalRuntimeLaunchCAS({
    agentId: launchAgent.id,
    attemptKey: "attempt-launch-1",
    dispatchIntentHash: launchIntentHash,
    canonicalWorktreePath: join(root, "launch_project"),
    gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
    agentKind: "opencode",
    promptNonce: "NONCE-LAUNCH-1",
  });
  assert.equal(freshLaunchRes.applied, true, "L-FRESH-LAUNCH must succeed");
  const postLaunchRecord = store.getById(launchAgent.id)!;
  assert.equal(postLaunchRecord.externalRuntimeBinding?.runtimeKind, "HERDR");
  assert.equal(postLaunchRecord.externalRuntimeBinding?.launch?.state, "FENCED");
  assert.equal(postLaunchRecord.externalRuntimeBinding?.launch?.attemptKey, "attempt-launch-1");
  assert.equal(postLaunchRecord.externalRuntimeBinding?.launch?.dispatchIntentHash, launchIntentHash);

  // L-IDEMPOTENT-LAUNCH: repeating same exact launch fence succeeds idempotently
  assert.equal(store.fenceExternalRuntimeLaunchCAS({
    agentId: launchAgent.id,
    attemptKey: "attempt-launch-1",
    dispatchIntentHash: launchIntentHash,
    canonicalWorktreePath: join(root, "launch_project"),
    gitHeadBefore: "3f8d6c12c4986c0af806944d9aaa7c3427fb0380",
    agentKind: "opencode",
    promptNonce: "NONCE-LAUNCH-1",
  }).applied, true, "L-IDEMPOTENT-LAUNCH must succeed");

  // L-WORKSPACE-OBSERVED: record positive workspace observation
  const wsObservedRes = store.recordExternalRuntimeWorkspaceObservedCAS({
    agentId: launchAgent.id,
    attemptKey: "attempt-launch-1",
    herdrWorkspaceId: "w_launch_1",
    herdrPaneId: "p_launch_1",
    observedCwd: join(root, "launch_project"),
  });
  assert.equal(wsObservedRes.applied, true, "recordExternalRuntimeWorkspaceObservedCAS must succeed");
  const postWsRecord = store.getById(launchAgent.id)!;
  assert.equal(postWsRecord.externalRuntimeBinding?.launch?.state, "WORKSPACE_OBSERVED");
  assert.equal(postWsRecord.externalRuntimeBinding?.launch?.herdrWorkspaceId, "w_launch_1");
  assert.equal(postWsRecord.externalRuntimeBinding?.launch?.herdrPaneId, "p_launch_1");

  // L-AGENT-OBSERVED: record positive agent observation
  const agentObservedRes = store.recordExternalRuntimeAgentObservedCAS({
    agentId: launchAgent.id,
    attemptKey: "attempt-launch-1",
    herdrAgentIdentity: "ds-attempt-launch-1",
  });
  assert.equal(agentObservedRes.applied, true, "recordExternalRuntimeAgentObservedCAS must succeed");
  const postAgentRecord = store.getById(launchAgent.id)!;
  assert.equal(postAgentRecord.externalRuntimeBinding?.launch?.state, "AGENT_OBSERVED");
  assert.equal(postAgentRecord.externalRuntimeBinding?.launch?.herdrAgentIdentity, "ds-attempt-launch-1");

  // Case J: Store backward compatibility tests (Section 54)
  // 1. Existing V2 without launch fields is readable
  (store as any).database.sqlite.prepare(`
    insert into local_agent_sessions (
      id, workspace_root, profile_name, provider, status, execution_contract, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "agt_v2_no_launch",
    join(root, "v2_no_launch"),
    "reviewer",
    "codex",
    "starting",
    JSON.stringify({
      storedExecutionStateVersion: 2,
      executionContract: null,
      startReplay: { key: "v2-key", requestHash: "v2-hash" },
      externalRuntimeBinding: {
        runtimeKind: "HERDR",
        handle: { attemptKey: "v2-key", promptNonce: "v2-nonce" },
      },
    }),
    new Date().toISOString(),
    new Date().toISOString(),
  );
  const v2NoLaunchRecord = store.getById("agt_v2_no_launch");
  assert.ok(v2NoLaunchRecord);
  assert.equal(v2NoLaunchRecord.externalRuntimeBinding?.runtimeKind, "HERDR");
  assert.equal(v2NoLaunchRecord.externalRuntimeBinding?.launch, undefined);
  assert.equal((v2NoLaunchRecord.externalRuntimeBinding?.handle as any)?.attemptKey, "v2-key");

  // 2. Existing V2 with prompt binding is readable
  (store as any).database.sqlite.prepare(`
    insert into local_agent_sessions (
      id, workspace_root, profile_name, provider, status, execution_contract, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "agt_v2_with_prompt",
    join(root, "v2_prompt"),
    "reviewer",
    "codex",
    "starting",
    JSON.stringify({
      storedExecutionStateVersion: 2,
      executionContract: null,
      startReplay: { key: "v2-prompt-key", requestHash: "v2-prompt-hash" },
      externalRuntimeBinding: {
        runtimeKind: "HERDR",
        handle: { attemptKey: "v2-prompt-key", promptNonce: "v2-prompt-nonce" },
        promptState: {
          consequentialPromptFenced: true,
          promptNonce: "v2-prompt-nonce",
          fencedAt: "2026-09-23T00:00:00.000Z",
        },
      },
    }),
    new Date().toISOString(),
    new Date().toISOString(),
  );
  const v2PromptRecord = store.getById("agt_v2_with_prompt");
  assert.ok(v2PromptRecord);
  assert.equal(v2PromptRecord.externalRuntimeBinding?.promptState?.consequentialPromptFenced, true);
  assert.equal(v2PromptRecord.externalRuntimeBinding?.promptState?.promptNonce, "v2-prompt-nonce");

} finally {
  for (const store of stores) {
    store.close();
  }
  rmSync(root, { recursive: true, force: true });
}
