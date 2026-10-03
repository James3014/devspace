/**
 * P0 Resume / writer-lease negative-control tests.
 *
 * Tests 1–13 as required by the dispatch:
 *  1. exact same dispatch request twice => one underlying agent/provider start
 *  2. second controller/conversation targeting same worktree+scope gets
 *     ownership conflict before effect
 *  3. read-only status/list/read still works without writer lease
 *  4. stale lease version fails CAS
 *  5. handoff fences old owner
 *  6. expired unresolved/pinned lease cannot be reacquired
 *  7. OUTCOME_UNKNOWN duplicate dispatch returns reconcile-required and does not spawn
 *  8. terminal exact replay returns same handle/result and no new effect
 *  9. changed base/scope/contract under same work key fails conflict
 * 10. disjoint worktrees/scopes can proceed concurrently
 * 11. process timeout/lost ack does not mint new attempt
 * 12. restart reload returns same work key/lease/effect handle
 * 13. existing #62 tests remain green (ControlPlaneOwnershipStore primitives unaffected)
 */

import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneOwnershipStore, ControlPlaneOwnershipError } from "./control-plane-ownership.js";
import {
  WorkResumeStore,
  computeWorkKey,
  assertMaterialMatch,
  buildWorktreeLeaseInput,
  leaseIdempotencyKeyForWork,
  WorkResumeError,
  WORK_RESUME_SCHEMA,
  type WorkKeyMaterial,
} from "./work-resume.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const BASE_GRANT = {
  repository: "owner/devspace",
  goal: "issue-328",
  coordinatorThread: "session-a",
  evidenceHash: "deadbeef",
} as const;

const BASE_MATERIAL: WorkKeyMaterial = {
  repositoryKey: "owner/devspace",
  ownerIssueId: "issue-328",
  baseRevisionSha: "4fef445fa217a51794f13ac641a6b991db5d54ec",
  worktreeRealpath: "/worktrees/devspace-issue328",
  writeScope: ["/worktrees/devspace-issue328/src"],
  contractPurpose: "p0-resume-writer-lease",
};

function makeOwnershipOpts(nowFn?: () => number) {
  return {
    resolveResourceIdentity: (input: Parameters<ControlPlaneOwnershipStore["acquire"]>[1]) => input,
    resolveOwnerContext: (value: unknown) => ({ ownerThread: String(value) }),
    verifyGrantEvidence: () => true,
    verifyReconciliationEvidence: () => true,
    now: nowFn ?? (() => Date.now()),
  };
}

function setup(db?: Database.Database, nowFn?: () => number) {
  const sqlite = db ?? new Database(":memory:");
  const ownership = new ControlPlaneOwnershipStore(sqlite, makeOwnershipOpts(nowFn));
  ownership.putGrantEvidence("session-a", BASE_GRANT, 0);
  const store = new WorkResumeStore(sqlite, ownership, nowFn ?? (() => Date.now()));
  return { sqlite, ownership, store };
}

/** Helper: acquire a writer lease and register in the work-resume projection. */
function acquireLease(
  ownership: ControlPlaneOwnershipStore,
  store: WorkResumeStore,
  material: WorkKeyMaterial = BASE_MATERIAL,
  ownerContext: unknown = "session-a",
  expiresMs = 60_000,
) {
  const workKey = computeWorkKey(material);
  const expiresAt = new Date(Date.now() + expiresMs).toISOString();
  const leaseInput = buildWorktreeLeaseInput(workKey, material, BASE_GRANT, expiresAt);
  const lease = ownership.acquire(ownerContext, leaseInput);
  const { created, status } = store.register(workKey, material, leaseInput.idempotencyKey, lease.leaseId);
  return { workKey, lease, leaseInput, created, status };
}

/** Build a full reconciliation evidence object for the ownership store. */
function reconcileEvidence(
  leaseId: string,
  ownerThread: string,
  operationHandle: string,
  operation: string,
  baseRevision: string,
  leaseVersion: number,
  state: "finished" | "failed" = "finished",
) {
  return { leaseId, ownerThread, operationHandle, operation, baseRevision, leaseVersion, state };
}

// ─── Test 1: same dispatch twice => one underlying effect ────────────────────

test("1: exact same work key + material dispatched twice returns existing registration (dedup)", () => {
  const { sqlite, ownership, store } = setup();
  try {
    const { workKey, lease, leaseInput, created } = acquireLease(ownership, store);
    assert.ok(created, "first registration should create row");

    // Second dispatch with identical material including the exact same expiresAt:
    // ownership.acquire is idempotent when (repositoryKey, resourceKind, resourceId,
    // idempotencyKey, ownerThread, baseRevision, operation, resource, scope, grant,
    // expiresAt) all match – using the stored lease.expiresAt ensures replay.
    const leaseInput2 = buildWorktreeLeaseInput(workKey, BASE_MATERIAL, BASE_GRANT, lease.expiresAt);
    assert.equal(leaseInput2.idempotencyKey, leaseInput.idempotencyKey, "idempotency key must be stable");
    const lease2 = ownership.acquire("session-a", leaseInput2);
    assert.equal(lease2.leaseId, lease.leaseId, "ownership store returns same lease for same idempotency key");

    // register: row exists, material matches → not created
    const { created: created2 } = store.register(workKey, BASE_MATERIAL, leaseInput2.idempotencyKey, lease2.leaseId);
    assert.ok(!created2, "second register must not create a new row");

    // checkDuplicate must report suppressed (RUNNING)
    const dup = store.checkDuplicate(workKey);
    assert.ok(dup.suppressed, "duplicate check must be suppressed");
    assert.equal(dup.suppressed && dup.status.disposition, "RUNNING");
  } finally {
    sqlite.close();
  }
});

// ─── Test 2: second controller gets ownership conflict before effect ──────────

test("2: second controller targeting same worktree+scope gets OWNERSHIP_CONFLICT before effect", () => {
  const { sqlite, ownership, store } = setup();
  try {
    // Add a grant for session-b (different coordinator thread – same grant authority)
    const grantB = { ...BASE_GRANT, coordinatorThread: "session-b" };
    ownership.putGrantEvidence("session-b", grantB, 0);

    const { workKey, lease } = acquireLease(ownership, store);

    // Session-b attempts to acquire the same worktree scope – must conflict
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const leaseInputB = {
      ...buildWorktreeLeaseInput(workKey, BASE_MATERIAL, grantB, expiresAt),
      idempotencyKey: "session-b-separate-attempt",
    };
    assert.throws(
      () => ownership.acquire("session-b", leaseInputB),
      (e: unknown) => e instanceof ControlPlaneOwnershipError,
      "second controller must get ownership conflict",
    );

    // Even if session-b somehow obtained the leaseId, admitWriter must reject wrong owner
    assert.throws(
      () => store.admitWriter({
        workKey,
        ownerContext: "session-b",
        leaseId: lease.leaseId,
        expectedLeaseVersion: lease.version,
        operation: "agent_write",
        baseRevision: BASE_MATERIAL.baseRevisionSha,
      }),
      (e: unknown) => e instanceof Error,
      "admitWriter must reject non-owner context",
    );
  } finally {
    sqlite.close();
  }
});

// ─── Test 3: read-only disposition works without writer lease ─────────────────

test("3: read-only disposition query works without holding writer lease", () => {
  const { sqlite, store } = setup();
  try {
    const result = store.disposition(computeWorkKey(BASE_MATERIAL));
    assert.equal(result.schema, WORK_RESUME_SCHEMA);
    assert.equal(result.disposition, "NO_EXISTING_ATTEMPT");
    assert.ok(!result.leaseId);
  } finally {
    sqlite.close();
  }
});

test("3b: getLease (read-only) works without being owner", () => {
  const { sqlite, ownership, store } = setup();
  try {
    const { lease } = acquireLease(ownership, store);
    const observed = store.getLease(lease.leaseId);
    assert.ok(observed);
    assert.equal(observed.leaseId, lease.leaseId);
  } finally {
    sqlite.close();
  }
});

// ─── Test 4: stale lease version fails CAS ───────────────────────────────────

test("4: stale lease version fails CAS in admitWriter and pinEffect", () => {
  const { sqlite, ownership, store } = setup();
  try {
    const { workKey, lease } = acquireLease(ownership, store);
    const originalVersion = lease.version;

    // Advance version by renewing
    ownership.renew("session-a", lease.leaseId, originalVersion, new Date(Date.now() + 120_000).toISOString());
    const current = ownership.get(lease.leaseId)!;
    assert.equal(current.version, originalVersion + 1);

    // admitWriter with stale version must fail (ControlPlaneOwnershipError from assertHeld)
    assert.throws(
      () => store.admitWriter({
        workKey,
        ownerContext: "session-a",
        leaseId: lease.leaseId,
        expectedLeaseVersion: originalVersion, // stale
        operation: lease.operation,
        baseRevision: BASE_MATERIAL.baseRevisionSha,
      }),
      (e: unknown) => e instanceof ControlPlaneOwnershipError,
      "stale version must fail CAS via assertHeld",
    );

    // pinEffect with stale version must also fail
    assert.throws(
      () => store.pinEffect("session-a", workKey, lease.leaseId, originalVersion, "effect-1"),
      (e: unknown) => e instanceof ControlPlaneOwnershipError,
      "pinEffect with stale version must fail CAS",
    );
  } finally {
    sqlite.close();
  }
});

// ─── Test 5: handoff fences old owner ────────────────────────────────────────

test("5: old owner is fenced after lease termination; stale version rejected by CAS", () => {
  const { sqlite, ownership, store } = setup();
  try {
    const { workKey, lease } = acquireLease(ownership, store);
    const originalVersion = lease.version;

    // Simulate session-a completing and releasing the lease
    ownership.release("session-a", lease.leaseId, originalVersion);
    const released = ownership.get(lease.leaseId)!;
    assert.equal(released.terminalState, "released");

    // Old version (pre-release) must be rejected by admitWriter
    assert.throws(
      () => store.admitWriter({
        workKey,
        ownerContext: "session-a",
        leaseId: lease.leaseId,
        expectedLeaseVersion: originalVersion,   // stale – now incremented by release
        operation: lease.operation,
        baseRevision: BASE_MATERIAL.baseRevisionSha,
      }),
      (e: unknown) => e instanceof ControlPlaneOwnershipError,
      "old version must be fenced after release",
    );

    // New version also fails (lease is terminal)
    assert.throws(
      () => store.admitWriter({
        workKey,
        ownerContext: "session-a",
        leaseId: lease.leaseId,
        expectedLeaseVersion: released.version,
        operation: lease.operation,
        baseRevision: BASE_MATERIAL.baseRevisionSha,
      }),
      (e: unknown) => e instanceof ControlPlaneOwnershipError,
      "released lease must be rejected even with current version",
    );
  } finally {
    sqlite.close();
  }
});

// ─── Test 6: expired unresolved/pinned lease cannot be reacquired ────────────

test("6: expired pinned (OUTCOME_UNKNOWN) lease cannot be reacquired; RECONCILE_REQUIRED", () => {
  let currentTime = Date.now();
  const nowFn = () => currentTime;
  const { sqlite, ownership, store } = setup(undefined, nowFn);

  try {
    const grantB = { ...BASE_GRANT, coordinatorThread: "session-b" };
    ownership.putGrantEvidence("session-b", grantB, 0);

    // Acquire with a short expiry
    const shortExpiry = new Date(currentTime + 1_000).toISOString();
    const workKey = computeWorkKey(BASE_MATERIAL);
    const leaseInput = buildWorktreeLeaseInput(workKey, BASE_MATERIAL, BASE_GRANT, shortExpiry);
    const lease = ownership.acquire("session-a", leaseInput);
    store.register(workKey, BASE_MATERIAL, leaseInput.idempotencyKey, lease.leaseId);

    // Pin an operation (simulating in-flight effect)
    const pinned = ownership.beginOperation("session-a", lease.leaseId, lease.version, "long-running-task");
    assert.equal(pinned.operationHandle, "long-running-task");

    // Advance time past expiry
    currentTime += 5_000;

    // Disposition must be RECONCILE_REQUIRED (expired + pinned)
    const status = store.disposition(workKey);
    assert.equal(status.disposition, "RECONCILE_REQUIRED");

    // Session-b cannot reacquire the same scope
    assert.throws(
      () => ownership.acquire("session-b", {
        ...leaseInput,
        idempotencyKey: "session-b-reacquire",
        grant: grantB,
        expiresAt: new Date(currentTime + 60_000).toISOString(),
      }),
      (e: unknown) => e instanceof ControlPlaneOwnershipError,
      "expired pinned lease must block new acquisition",
    );
  } finally {
    sqlite.close();
  }
});

// ─── Test 7: OUTCOME_UNKNOWN duplicate dispatch returns reconcile-required ────

test("7: OUTCOME_UNKNOWN duplicate dispatch is suppressed; no new spawn", () => {
  let currentTime = Date.now();
  const nowFn = () => currentTime;
  const { sqlite, ownership, store } = setup(undefined, nowFn);

  try {
    const shortExpiry = new Date(currentTime + 1_000).toISOString();
    const workKey = computeWorkKey(BASE_MATERIAL);
    const leaseInput = buildWorktreeLeaseInput(workKey, BASE_MATERIAL, BASE_GRANT, shortExpiry);
    const lease = ownership.acquire("session-a", leaseInput);
    store.register(workKey, BASE_MATERIAL, leaseInput.idempotencyKey, lease.leaseId);

    // Pin to simulate active effect that will become OUTCOME_UNKNOWN
    ownership.beginOperation("session-a", lease.leaseId, lease.version, "task-x");

    // Advance time – lease expires while operation is still pinned (transport loss)
    currentTime += 10_000;

    // Disposition: RECONCILE_REQUIRED (expired + still pinned)
    const status = store.disposition(workKey);
    assert.equal(status.disposition, "RECONCILE_REQUIRED");

    // Duplicate dispatch check must suppress
    const dup = store.checkDuplicate(workKey);
    assert.ok(dup.suppressed, "OUTCOME_UNKNOWN must be suppressed");
    assert.ok(dup.suppressed && dup.status.disposition === "RECONCILE_REQUIRED");
  } finally {
    sqlite.close();
  }
});

// ─── Test 8: terminal replay returns same handle/result, no new effect ────────

test("8: terminal exact replay returns same receipt handle and no new effect", () => {
  const { sqlite, ownership, store } = setup();
  try {
    const { workKey, lease } = acquireLease(ownership, store);

    // Pin then reconcile (terminal effect)
    const pinned = ownership.beginOperation("session-a", lease.leaseId, lease.version, "task-y");
    const evidence = reconcileEvidence(
      lease.leaseId,
      "session-a",
      "task-y",
      lease.operation,
      BASE_MATERIAL.baseRevisionSha,
      pinned.version,
    );
    const receipt = store.recordTerminalReceipt("session-a", workKey, lease.leaseId, pinned.version, evidence);
    assert.ok(receipt.receiptId);

    // Replay: disposition must be TERMINAL with cached receipt
    const replay = store.disposition(workKey);
    assert.equal(replay.disposition, "TERMINAL");
    assert.ok(replay.terminalReceipt);
    assert.equal(replay.terminalReceipt.receiptId, receipt.receiptId);

    // checkDuplicate must return suppressed (TERMINAL)
    const dup = store.checkDuplicate(workKey);
    assert.ok(dup.suppressed);
    assert.ok(dup.suppressed && dup.status.disposition === "TERMINAL");
    assert.ok(dup.suppressed && dup.status.terminalReceipt?.receiptId === receipt.receiptId);
  } finally {
    sqlite.close();
  }
});

// ─── Test 9: changed material under same work key fails conflict ──────────────

test("9: changed base SHA / scope / contract under same key fails MATERIAL_CONFLICT", () => {
  const { sqlite, ownership, store } = setup();
  try {
    const { workKey, lease } = acquireLease(ownership, store);

    const changedSha: WorkKeyMaterial = {
      ...BASE_MATERIAL,
      baseRevisionSha: "aaaa0000bbbb1111cccc2222dddd3333eeee4444",
    };
    assert.throws(
      () => store.register(workKey, changedSha, leaseIdempotencyKeyForWork(workKey), lease.leaseId),
      (e: unknown) => e instanceof WorkResumeError && e.code === "MATERIAL_CONFLICT",
      "changed base SHA must fail with MATERIAL_CONFLICT",
    );

    const changedScope: WorkKeyMaterial = { ...BASE_MATERIAL, writeScope: ["/different/scope"] };
    assert.throws(
      () => store.register(workKey, changedScope, leaseIdempotencyKeyForWork(workKey), lease.leaseId),
      (e: unknown) => e instanceof WorkResumeError && e.code === "MATERIAL_CONFLICT",
      "changed scope must fail with MATERIAL_CONFLICT",
    );

    const changedContract: WorkKeyMaterial = { ...BASE_MATERIAL, contractPurpose: "different-contract" };
    assert.throws(
      () => store.register(workKey, changedContract, leaseIdempotencyKeyForWork(workKey), lease.leaseId),
      (e: unknown) => e instanceof WorkResumeError && e.code === "MATERIAL_CONFLICT",
      "changed contract must fail with MATERIAL_CONFLICT",
    );
  } finally {
    sqlite.close();
  }
});

// ─── Test 10: disjoint worktrees / scopes proceed concurrently ────────────────

test("10: disjoint worktrees and scopes can acquire leases concurrently without conflict", () => {
  const { sqlite, ownership } = setup();
  try {
    const grantB = { ...BASE_GRANT, coordinatorThread: "session-b" };
    ownership.putGrantEvidence("session-b", grantB, 0);

    // Build two disjoint stores sharing the same SQLite db
    const storeA = new WorkResumeStore(sqlite, ownership);
    const storeB = new WorkResumeStore(sqlite, ownership);

    const materialA: WorkKeyMaterial = {
      ...BASE_MATERIAL,
      worktreeRealpath: "/worktrees/repo-a",
      writeScope: ["/worktrees/repo-a/src"],
      ownerIssueId: "issue-328",
    };
    const materialB: WorkKeyMaterial = {
      ...BASE_MATERIAL,
      worktreeRealpath: "/worktrees/repo-b",
      writeScope: ["/worktrees/repo-b/src"],
      ownerIssueId: "issue-329",  // different issue → different key
    };

    const workKeyA = computeWorkKey(materialA);
    const workKeyB = computeWorkKey(materialB);
    assert.notEqual(workKeyA, workKeyB);

    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const inputA = buildWorktreeLeaseInput(workKeyA, materialA, BASE_GRANT, expiresAt);
    const leaseA = ownership.acquire("session-a", inputA);

    const inputB = buildWorktreeLeaseInput(workKeyB, materialB, grantB, expiresAt);
    const leaseB = ownership.acquire("session-b", inputB);

    assert.notEqual(leaseA.leaseId, leaseB.leaseId);
    storeA.register(workKeyA, materialA, inputA.idempotencyKey, leaseA.leaseId);
    storeB.register(workKeyB, materialB, inputB.idempotencyKey, leaseB.leaseId);

    assert.equal(storeA.disposition(workKeyA).disposition, "RUNNING");
    assert.equal(storeB.disposition(workKeyB).disposition, "RUNNING");
  } finally {
    sqlite.close();
  }
});

// ─── Test 11: process timeout/lost ack does not mint new attempt ──────────────

test("11: process timeout / lost ack does not mint new attempt; disposition stays RECONCILE_REQUIRED", () => {
  let currentTime = Date.now();
  const { sqlite, ownership, store } = setup(undefined, () => currentTime);

  try {
    const expiresAt = new Date(currentTime + 30_000).toISOString();
    const workKey = computeWorkKey(BASE_MATERIAL);
    const leaseInput = buildWorktreeLeaseInput(workKey, BASE_MATERIAL, BASE_GRANT, expiresAt);
    const lease = ownership.acquire("session-a", leaseInput);
    store.register(workKey, BASE_MATERIAL, leaseInput.idempotencyKey, lease.leaseId);

    // Process times out without explicit ack – no finishOperation called
    ownership.beginOperation("session-a", lease.leaseId, lease.version, "effect-timed-out");

    // Within window: RUNNING
    assert.equal(store.disposition(workKey).disposition, "RUNNING");

    // Advance past expiry (process died, lost ack)
    currentTime += 60_000;

    // Must be RECONCILE_REQUIRED – NOT NO_EXISTING_ATTEMPT (no new attempt minted)
    const status = store.disposition(workKey);
    assert.equal(status.disposition, "RECONCILE_REQUIRED");
    assert.equal(status.leaseId, lease.leaseId);

    // The pinned operation handle is still readable via getLease
    const liveLease = store.getLease(lease.leaseId);
    assert.equal(liveLease?.operationHandle, "effect-timed-out");
  } finally {
    sqlite.close();
  }
});

// ─── Test 12: restart reload returns same work key/lease/effect handle ────────

test("12: process restart reads back same work key, lease id, and effect handle from durable SQLite", () => {
  const dir = mkdtempSync(join(tmpdir(), "devspace-work-resume-restart-"));
  const dbPath = join(dir, "state.sqlite");

  try {
    let workKey: string;
    let expectedLeaseId: string;
    const expectedHandle = "pre-restart-effect";

    // Phase 1: initial dispatch
    {
      const db = new Database(dbPath);
      const { ownership, store } = setup(db);
      const { workKey: wk, lease } = acquireLease(ownership, store);
      workKey = wk;
      expectedLeaseId = lease.leaseId;
      ownership.beginOperation("session-a", lease.leaseId, lease.version, expectedHandle);
      db.close();
    }

    // Phase 2: process restart – new instance, re-open existing DB, read durable state
    {
      const db = new Database(dbPath);
      // Reconstruct ownership store; grant was persisted so session-a's grant exists
      // but we call putGrantEvidence again with version=1 (already stored at 1)
      const ownership2 = new ControlPlaneOwnershipStore(db, makeOwnershipOpts());
      // Grant already at version 1 from phase 1 – putGrantEvidence(version=1) updates it
      ownership2.putGrantEvidence("session-a", BASE_GRANT, 1);
      const store2 = new WorkResumeStore(db, ownership2);
      const status = store2.disposition(workKey);
      // Within default expiry (60s): RUNNING. If enough time: RECONCILE_REQUIRED.
      assert.ok(
        status.disposition === "RUNNING" || status.disposition === "RECONCILE_REQUIRED",
        `Expected RUNNING or RECONCILE_REQUIRED, got ${status.disposition}`,
      );
      assert.equal(status.leaseId, expectedLeaseId);
      const live = store2.getLease(expectedLeaseId);
      assert.equal(live?.operationHandle, expectedHandle);
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Test 13 guard: existing #62 ownership semantics unchanged ────────────────

test("13: existing ControlPlaneOwnershipStore acquire/assertHeld/beginOp/finishOp/release semantics unchanged", () => {
  const db = new Database(":memory:");
  const grant62 = { repository: "r/r", goal: "g", coordinatorThread: "owner", evidenceHash: "eh" };
  const ownership = new ControlPlaneOwnershipStore(db, makeOwnershipOpts());
  ownership.putGrantEvidence("owner", grant62, 0);

  try {
    const lease = ownership.acquire("owner", {
      repositoryKey: "r/r",
      resourceKind: "filesystem",
      resourceId: "/repo",
      resource: "/repo",
      operation: "sync",
      scope: ["/repo"],
      baseRevision: "abcd1234",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: "test-62",
      grant: grant62,
    });
    assert.ok(lease.leaseId);
    assert.equal(lease.version, 1);

    const held = ownership.assertHeld("owner", lease.leaseId, 1, "sync", "abcd1234");
    assert.equal(held.leaseId, lease.leaseId);

    const pinned = ownership.beginOperation("owner", lease.leaseId, 1, "some-op");
    assert.equal(pinned.version, 2);
    assert.equal(pinned.operationHandle, "some-op");

    const finished = ownership.finishOperation("owner", lease.leaseId, 2, "some-op");
    assert.equal(finished.version, 3);
    assert.ok(!finished.operationHandle);

    ownership.release("owner", lease.leaseId, 3);
    assert.equal(ownership.get(lease.leaseId)?.terminalState, "released");
  } finally {
    db.close();
  }
});

// ─── computeWorkKey determinism / invariants ──────────────────────────────────

test("computeWorkKey: deterministic for same material", () => {
  const k1 = computeWorkKey(BASE_MATERIAL);
  const k2 = computeWorkKey(BASE_MATERIAL);
  assert.equal(k1, k2);
  assert.ok(k1.startsWith("wk_"));
});

test("computeWorkKey: different material produces different keys", () => {
  const k1 = computeWorkKey(BASE_MATERIAL);
  const k2 = computeWorkKey({ ...BASE_MATERIAL, baseRevisionSha: "0000000000000000000000000000000000001234" });
  assert.notEqual(k1, k2);
});

test("assertMaterialMatch: passes for identical material", () => {
  assert.doesNotThrow(() => assertMaterialMatch(BASE_MATERIAL, BASE_MATERIAL));
});

test("assertMaterialMatch: throws MATERIAL_CONFLICT for changed scope", () => {
  assert.throws(
    () => assertMaterialMatch(BASE_MATERIAL, { ...BASE_MATERIAL, writeScope: ["/other"] }),
    (e: unknown) => e instanceof WorkResumeError && e.code === "MATERIAL_CONFLICT",
  );
});

test("buildWorktreeLeaseInput: idempotency key is stable and prefixed", () => {
  const workKey = computeWorkKey(BASE_MATERIAL);
  const input = buildWorktreeLeaseInput(workKey, BASE_MATERIAL, BASE_GRANT, new Date(Date.now() + 60_000).toISOString());
  assert.ok(input.idempotencyKey.startsWith("wresume:wk_"));
  const input2 = buildWorktreeLeaseInput(workKey, BASE_MATERIAL, BASE_GRANT, new Date(Date.now() + 90_000).toISOString());
  assert.equal(input.idempotencyKey, input2.idempotencyKey, "idempotency key must be stable across calls");
});
