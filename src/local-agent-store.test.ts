import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath } from "./db/client.js";
import { LocalAgentStore } from "./local-agent-store.js";
import type { ScopeBaseline } from "./local-agent-contract.js";

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
  assert.equal(store.getById("thread_123"), undefined);
  const storedError = store.getById(created.id);
  assert.equal(storedError?.error, "Codex executable was not found.");
  assert.equal(storedError?.errorCode, "PROVIDER_UNAVAILABLE");
  assert.equal(storedError?.errorRetryable, false);
  assert.equal(store.update(created.id, { latestResponse: undefined }).latestResponse, undefined);
  assert.deepEqual(
    store.list({ workspaceRoot: join(root, "project") }).map((agent) => agent.latestResponse),
    [undefined],
  );
assert.deepEqual(store.list({ workspaceId: "ws_1" }).map((agent) => agent.id), [created.id]);
assert.deepEqual(store.list({ workspaceId: "ws_other" }), []);
assert.deepEqual(store.list({ workspaceId: "ws_1", workspaceRoot: join(root, "other") }), []);
assert.deepEqual(store.list({ workspaceRoot: join(root, "other") }), []);

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
    [created.id, failedContinuation.id, fenced.id, generationGuarded.id, createdFromOtherStore.id].sort(),
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
  assert.throws(
    () => compatibilityStore.update(detachedRecord.id, { status: "idle" }),
    /generation-owned detached lifecycle/i,
  );
  compatibilityStore.prepareWorker(detachedRecord.id, "detached-guard-token");
  compatibilityStore.claimWorker(detachedRecord.id, "detached-guard-token", 4102);
  const guardedFence = compatibilityStore.fenceActiveTurn({
    agentId: detachedRecord.id,
    terminalReason: "timeout",
    error: "detached guard timeout",
  });
  const guardedGeneration = guardedFence.current!.lifecycleState!.terminationPending!.generation;
  assert.throws(
    () => compatibilityStore.update(detachedRecord.id, { latestResponse: "stale daemon callback" }),
    /generation-owned detached lifecycle/i,
  );
  assert.equal(
    compatibilityStore.getById(detachedRecord.id)!.lifecycleState!.terminationPending!.generation,
    guardedGeneration,
  );
  const joinedCancel = compatibilityStore.cancelActive(detachedRecord.id);
  assert.equal(joinedCancel.current.lifecycleState!.terminationPending!.generation, guardedGeneration);
  assert.equal(joinedCancel.current.lifecycleState!.terminationPending!.reason, "timeout");

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

} finally {
  for (const store of stores) {
    store.close();
  }
  rmSync(root, { recursive: true, force: true });
}
