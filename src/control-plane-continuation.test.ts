import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneContinuation } from "./control-plane-continuation.js";
import { ControlPlaneOwnershipStore, ControlPlaneOwnershipError } from "./control-plane-ownership.js";

function setupFixture(dbPath?: string, nowFn?: () => number, grantValidator?: (grant: any, owner: any) => boolean) {
  const db = new Database(dbPath ?? ":memory:");
  let currentTime = Date.now();
  const opts = {
    resolveResourceIdentity: (input: Parameters<ControlPlaneOwnershipStore["acquire"]>[1]) => input,
    resolveOwnerContext: (value: unknown) => ({ ownerThread: String(value) }),
    verifyGrantEvidence: (grant: any, owner: any) => (grantValidator ? grantValidator(grant, owner) : true),
    now: nowFn ?? (() => currentTime),
    verifyReconciliationEvidence: () => true,
  };
  const store = new ControlPlaneOwnershipStore(db, opts);
  const facade = new ControlPlaneContinuation(store);
  return {
    db,
    store,
    facade,
    opts,
    setTime: (t: number) => {
      currentTime = t;
    },
    getTime: () => currentTime,
  };
}

test("1 & 2 & 3: Session A owns resource, disappears; Session B discovers continuation and takes over safely", () => {
  const f = setupFixture();
  try {
    const grant = { repository: "owner/repo", goal: "goal-101", coordinatorThread: "session-a", evidenceHash: "hash-a" };
    f.store.putGrantEvidence("session-a", grant, 0);
    const lease = f.store.acquire("session-a", {
      repositoryKey: "owner/repo",
      resourceKind: "checkout",
      resourceId: "main",
      resource: "/repo",
      operation: "task_exec",
      scope: ["/repo"],
      baseRevision: "rev-base-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: "lease-101",
      grant,
    });

    // Session A disappears without orderly handoff. Session B discovers continuation:
    const discovery = f.facade.latest("session-b");
    assert.equal(discovery.status, "TAKEOVER_ELIGIBLE");
    assert.ok(discovery.continuation);
    assert.equal(discovery.continuation.leaseId, lease.leaseId);
    assert.equal(discovery.continuation.repositoryKey, "owner/repo");
    assert.equal(discovery.continuation.baseRevision, "rev-base-1");
    assert.equal(discovery.continuation.ownerThread, "session-a");

    // Session B executes crash-safe takeover
    const receipt = f.facade.takeover("session-b", lease.leaseId, 1, {
      takeoverReason: "context_rollover",
      checkpoint: "step-2-compiled",
      candidateRevision: "rev-cand-1",
      remainingGap: "independent-acceptance",
      nextGate: "DEVSPACE_CRASH_SAFE_CONTINUATION_G1",
      tests: ["test_core"],
      evidence: ["build_receipt"],
    });

    assert.equal(receipt.previousVersion, 1);
    assert.equal(receipt.newVersion, 2);
    assert.equal(receipt.fromOwnerThread, "session-a");
    assert.equal(receipt.toOwnerThread, "session-b");
    assert.equal(receipt.checkpoint, "step-2-compiled");
    assert.equal(receipt.remainingGap, "independent-acceptance");

    // Verify current lease ownership updated to session-b with incremented version
    const updated = f.store.get(lease.leaseId)!;
    assert.equal(updated.ownerThread, "session-b");
    assert.equal(updated.version, 2);
  } finally {
    f.db.close();
  }
});

test("4 & 14: Former owner session-a is rejected after takeover and cannot reclaim or mutate using stale version", () => {
  const f = setupFixture();
  try {
    const grant = { repository: "owner/repo", goal: "goal-101", coordinatorThread: "session-a", evidenceHash: "hash-a" };
    f.store.putGrantEvidence("session-a", grant, 0);
    const lease = f.store.acquire("session-a", {
      repositoryKey: "owner/repo",
      resourceKind: "checkout",
      resourceId: "main",
      resource: "/repo",
      operation: "task_exec",
      scope: ["/repo"],
      baseRevision: "rev-base-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: "lease-101-fencing",
      grant,
    });

    // Session B takes over
    f.facade.takeover("session-b", lease.leaseId, 1, {
      takeoverReason: "context_rollover",
    });

    // Session A tries to renew, release, or mutate with stale version 1
    assert.throws(() => f.store.renew("session-a", lease.leaseId, 1, new Date(Date.now() + 120_000).toISOString()), (e: any) => e instanceof ControlPlaneOwnershipError && e.code === "CAS_CONFLICT");
    assert.throws(() => f.store.release("session-a", lease.leaseId, 1), (e: any) => e instanceof ControlPlaneOwnershipError && e.code === "CAS_CONFLICT");
    assert.throws(() => f.store.beginOperation("session-a", lease.leaseId, 1, "op-stale"), (e: any) => e instanceof ControlPlaneOwnershipError && e.code === "CAS_CONFLICT");

    // Session A tries to use new version 2 (stealing back without takeover authority)
    assert.throws(() => f.store.renew("session-a", lease.leaseId, 2, new Date(Date.now() + 120_000).toISOString()), (e: any) => e instanceof ControlPlaneOwnershipError && e.code === "CAS_CONFLICT");
    assert.throws(() => f.store.release("session-a", lease.leaseId, 2), (e: any) => e instanceof ControlPlaneOwnershipError && e.code === "CAS_CONFLICT");
  } finally {
    f.db.close();
  }
});

test("5, 6, 7 & 8: Active in-flight operation blocks takeover; reconciled/finished operation allows takeover", () => {
  const f = setupFixture();
  try {
    const grant = { repository: "owner/repo", goal: "goal-101", coordinatorThread: "session-a", evidenceHash: "hash-a" };
    f.store.putGrantEvidence("session-a", grant, 0);
    const lease = f.store.acquire("session-a", {
      repositoryKey: "owner/repo",
      resourceKind: "checkout",
      resourceId: "main",
      resource: "/repo",
      operation: "task_exec",
      scope: ["/repo"],
      baseRevision: "rev-base-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: "lease-101-ops",
      grant,
    });

    // Start an in-flight operation (pin it)
    const pinned = f.store.beginOperation("session-a", lease.leaseId, 1, "in-flight-command");
    assert.equal(pinned.operationHandle, "in-flight-command");

    // Discovery sees active effect
    const discovery = f.facade.latest("session-b");
    assert.equal(discovery.status, "TAKEOVER_BLOCKED_ACTIVE_EFFECT");

    // Attempting takeover while operation is in-flight is strictly blocked
    assert.throws(
      () =>
        f.facade.takeover("session-b", lease.leaseId, pinned.version, {
          takeoverReason: "context_rollover",
        }),
      (e: any) => e instanceof ControlPlaneOwnershipError && e.code === "OWNERSHIP_CONFLICT" && e.message.includes("reconciled"),
    );

    // Reconcile/finish the operation
    const finished = f.store.finishOperation("session-a", lease.leaseId, pinned.version, "in-flight-command");
    assert.equal(finished.operationHandle, undefined);

    // Now discovery reports eligible
    const discovery2 = f.facade.latest("session-b");
    assert.equal(discovery2.status, "TAKEOVER_ELIGIBLE");

    // Takeover now succeeds cleanly!
    const receipt = f.facade.takeover("session-b", lease.leaseId, finished.version, {
      takeoverReason: "context_rollover_after_reconcile",
    });
    assert.equal(receipt.newVersion, finished.version + 1);
    assert.equal(receipt.toOwnerThread, "session-b");
  } finally {
    f.db.close();
  }
});

test("9 & 10: State survives Dev MCP process restart (file-backed SQLite)", () => {
  const dir = mkdtempSync(join(tmpdir(), "devspace-continuation-restart-"));
  const dbPath = join(dir, "state.sqlite");
  const grant = { repository: "owner/repo", goal: "goal-101", coordinatorThread: "session-a", evidenceHash: "hash-a" };

  // Phase 1: Session A creates lease and disappears
  let f1 = setupFixture(dbPath);
  f1.store.putGrantEvidence("session-a", grant, 0);
  const lease = f1.store.acquire("session-a", {
    repositoryKey: "owner/repo",
    resourceKind: "checkout",
    resourceId: "main",
    resource: "/repo",
    operation: "task_exec",
    scope: ["/repo"],
    baseRevision: "rev-base-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: "lease-restart",
    grant,
  });
  f1.db.close();

  // Phase 2: Restart Dev MCP -> Session B discovers continuation and takes over
  let f2 = setupFixture(dbPath);
  const discovery = f2.facade.latest("session-b");
  assert.equal(discovery.status, "TAKEOVER_ELIGIBLE");
  assert.equal(discovery.continuation?.leaseId, lease.leaseId);

  const receipt = f2.facade.takeover("session-b", lease.leaseId, 1, {
    takeoverReason: "restart_recovery",
    checkpoint: "phase-2-checkpoint",
  });
  assert.equal(receipt.newVersion, 2);
  f2.db.close();

  // Phase 3: Restart Dev MCP again -> Session B reads back receipt
  let f3 = setupFixture(dbPath);
  const readback = f3.facade.readback("session-b", lease.leaseId, 1, 2);
  assert.equal(readback.receipt.receiptId, receipt.receiptId);
  assert.equal(readback.receipt.toOwnerThread, "session-b");
  assert.equal(readback.currentLease.ownerThread, "session-b");
  assert.equal(readback.currentLease.version, 2);
  f3.db.close();
});

test("11: Multiple unfinished continuations return structured ambiguity (no guessing)", () => {
  const f = setupFixture();
  try {
    const grant1 = { repository: "owner/repo1", goal: "goal-1", coordinatorThread: "session-a", evidenceHash: "hash-1" };
    const grant2 = { repository: "owner/repo2", goal: "goal-2", coordinatorThread: "session-a", evidenceHash: "hash-2" };
    f.store.putGrantEvidence("session-a", grant1, 0);
    f.store.putGrantEvidence("session-a", grant2, 0);

    f.store.acquire("session-a", {
      repositoryKey: "owner/repo1",
      resourceKind: "checkout",
      resourceId: "main",
      resource: "/repo1",
      operation: "task_exec",
      scope: ["/repo1"],
      baseRevision: "rev-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: "multi-1",
      grant: grant1,
    });

    f.store.acquire("session-a", {
      repositoryKey: "owner/repo2",
      resourceKind: "checkout",
      resourceId: "main",
      resource: "/repo2",
      operation: "task_exec",
      scope: ["/repo2"],
      baseRevision: "rev-2",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: "multi-2",
      grant: grant2,
    });

    const discovery = f.facade.latest("session-b");
    assert.equal(discovery.status, "MULTIPLE_CONTINUATIONS");
    assert.equal(discovery.candidates?.length, 2);
    assert.equal(discovery.continuation, undefined);
  } finally {
    f.db.close();
  }
});

test("12: Expired or invalid recipient grant blocks takeover", () => {
  let grantAllowed = true;
  const f = setupFixture(undefined, undefined, (_g, o) => (o.ownerThread === "session-b" ? grantAllowed : true));
  try {
    const grant = { repository: "owner/repo", goal: "goal-101", coordinatorThread: "session-a", evidenceHash: "hash-a" };
    f.store.putGrantEvidence("session-a", grant, 0);
    const lease = f.store.acquire("session-a", {
      repositoryKey: "owner/repo",
      resourceKind: "checkout",
      resourceId: "main",
      resource: "/repo",
      operation: "task_exec",
      scope: ["/repo"],
      baseRevision: "rev-base-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: "lease-grant-fail",
      grant,
    });

    grantAllowed = false; // Revoke / invalidate grant for session-b
    assert.throws(
      () =>
        f.facade.takeover("session-b", lease.leaseId, 1, {
          takeoverReason: "context_rollover",
        }),
      (e: any) => e instanceof ControlPlaneOwnershipError && e.code === "AUTHORITY_REQUIRED",
    );
  } finally {
    f.db.close();
  }
});

test("16: Repeated takeover call is idempotent", () => {
  const f = setupFixture();
  try {
    const grant = { repository: "owner/repo", goal: "goal-101", coordinatorThread: "session-a", evidenceHash: "hash-a" };
    f.store.putGrantEvidence("session-a", grant, 0);
    const lease = f.store.acquire("session-a", {
      repositoryKey: "owner/repo",
      resourceKind: "checkout",
      resourceId: "main",
      resource: "/repo",
      operation: "task_exec",
      scope: ["/repo"],
      baseRevision: "rev-base-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: "lease-idempotent",
      grant,
    });

    const first = f.facade.takeover("session-b", lease.leaseId, 1, {
      takeoverReason: "context_rollover",
      checkpoint: "step-1",
    });

    // Second call with same expectedVersion from session-b returns existing receipt idempotently
    const second = f.facade.takeover("session-b", lease.leaseId, 1, {
      takeoverReason: "context_rollover",
      checkpoint: "step-1",
    });

    assert.equal(first.receiptId, second.receiptId);
    assert.equal(second.newVersion, 2);
    assert.equal(f.store.get(lease.leaseId)?.version, 2);
  } finally {
    f.db.close();
  }
});
