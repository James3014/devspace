import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableOperationStore, type DurableOperationRecord } from "./durable-operations.js";
import {
  GITHUB_PR_DELIVERY_OPERATION_KIND,
  GITHUB_PR_DELIVERY_RECEIPT_SCHEMA,
  PrDeliveryLifecycleError,
  projectPrDeliveryLifecycle,
  type PrDeliveryLifecycleState,
} from "./pr-delivery-lifecycle.js";

const KIND = GITHUB_PR_DELIVERY_OPERATION_KIND;

const REQUEST = {
  repository: "James3014/devspace",
  baseBranch: "main",
  expectedBaseSha: "b2e9331f0ed84b5e8902ef322b9e391b8d07c0ed",
  candidateBranch: "codex/issue-115-pr-delivery-g0-g3",
  expectedCandidateHeadSha: "e4a9897803d647e4ac299973f54995b5cb9433b6",
  title: "feat(delivery): bounded GitHub PR delivery",
  body: "body",
  attemptKey: "g4-attempt-1",
  localRepoRoot: "/tmp/devspace",
};

const RECEIPT = {
  schema: GITHUB_PR_DELIVERY_RECEIPT_SCHEMA,
  repository: "James3014/devspace",
  prNumber: 147,
  url: "https://github.com/James3014/devspace/pull/147",
  headSha: "e4a9897803d647e4ac299973f54995b5cb9433b6",
  baseSha: "b2e9331f0ed84b5e8902ef322b9e391b8d07c0ed",
  baseBranch: "main",
  headBranch: "codex/issue-115-pr-delivery-g0-g3",
  title: "feat(delivery): bounded GitHub PR delivery",
  matchedExisting: false,
};

function record(overrides: Partial<DurableOperationRecord> = {}): DurableOperationRecord {
  return {
    operationId: "op_g4_test",
    attemptKey: "g4-attempt-1",
    requestHash: "hash-g4-1",
    kind: KIND,
    authorityMode: "OWNER_DIRECT",
    scopeRoot: "/tmp/devspace",
    status: "started",
    retrySafe: false,
    request: { ...REQUEST },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

const FORBIDDEN_STATES = ["CI_GREEN", "CI_FAILED", "MERGE_READY"] as const;

function assertNeverForbidden(state: PrDeliveryLifecycleState): void {
  for (const forbidden of FORBIDDEN_STATES) {
    assert.notEqual(state, forbidden, `projection must never emit ${forbidden}`);
  }
}

test("G4-01 started projects PR_DELIVERY_IN_FLIGHT without claiming remote create", () => {
  const projection = projectPrDeliveryLifecycle(record({ status: "started" }));
  assert.equal(projection.state, "PR_DELIVERY_IN_FLIGHT");
  assert.equal(projection.pr, undefined);
  assertNeverForbidden(projection.state);
});

test("G4-02 outcome_unknown projects PR_DELIVERY_RECONCILE_REQUIRED, never IN_FLIGHT or PREPARED", () => {
  const projection = projectPrDeliveryLifecycle(
    record({ status: "outcome_unknown", retrySafe: false, errorCode: "RECONCILIATION_REQUIRED" }),
  );
  assert.equal(projection.state, "PR_DELIVERY_RECONCILE_REQUIRED");
  assert.notEqual(projection.state, "PR_DELIVERY_IN_FLIGHT");
  assert.notEqual(projection.state, "PR_DELIVERY_PREPARED");
  assertNeverForbidden(projection.state);
});

test("G4-03 definitive non-retryable failure projects PR_DELIVERY_BLOCKED, not RECONCILE_REQUIRED", () => {
  const projection = projectPrDeliveryLifecycle(
    record({ status: "failed", retrySafe: false, errorCode: "REMOTE_IDENTITY_DRIFT" }),
  );
  assert.equal(projection.state, "PR_DELIVERY_BLOCKED");
  assert.equal(projection.gap, "REMOTE_IDENTITY_DRIFT");
  assert.equal(projection.retrySafe, false);
  assertNeverForbidden(projection.state);
});

test("G4-04 failed retrySafe=true projects PR_DELIVERY_PREPARED preserving error identity", () => {
  const projection = projectPrDeliveryLifecycle(
    record({ status: "failed", retrySafe: true, errorCode: "CONFIRMED_NO_EFFECT" }),
  );
  assert.equal(projection.state, "PR_DELIVERY_PREPARED");
  assert.equal(projection.errorCode, "CONFIRMED_NO_EFFECT");
  assert.equal(projection.retrySafe, true);
  assert.equal(projection.operationId, "op_g4_test");
  assertNeverForbidden(projection.state);
});

test("G4-05 succeeded with valid exact receipt projects PR_DELIVERED", () => {
  const projection = projectPrDeliveryLifecycle(
    record({ status: "succeeded", retrySafe: false, receipt: { ...RECEIPT } }),
  );
  assert.equal(projection.state, "PR_DELIVERED");
  assert.deepEqual(projection.pr, {
    repository: RECEIPT.repository,
    prNumber: RECEIPT.prNumber,
    url: RECEIPT.url,
    headSha: RECEIPT.headSha,
    baseSha: RECEIPT.baseSha,
    baseBranch: RECEIPT.baseBranch,
    headBranch: RECEIPT.headBranch,
  });
  assertNeverForbidden(projection.state);
});

test("G4-06 succeeded with missing receipt fails closed to RECONCILE_REQUIRED", () => {
  const projection = projectPrDeliveryLifecycle(record({ status: "succeeded", retrySafe: false }));
  assert.equal(projection.state, "PR_DELIVERY_RECONCILE_REQUIRED");
  assert.equal(projection.gap, "DELIVERY_RECEIPT_MISSING");
  assert.equal(projection.pr, undefined);
});

test("G4-07 succeeded with wrong-repository receipt fails closed to RECONCILE_REQUIRED", () => {
  const projection = projectPrDeliveryLifecycle(
    record({
      status: "succeeded",
      retrySafe: false,
      receipt: { ...RECEIPT, repository: "SomeoneElse/other" },
    }),
  );
  assert.equal(projection.state, "PR_DELIVERY_RECONCILE_REQUIRED");
  assert.equal(projection.gap, "DELIVERY_RECEIPT_IDENTITY_MISMATCH");
  assert.equal(projection.pr, undefined);
});

test("G4-08 succeeded with wrong head SHA fails closed to RECONCILE_REQUIRED", () => {
  const projection = projectPrDeliveryLifecycle(
    record({
      status: "succeeded",
      retrySafe: false,
      receipt: { ...RECEIPT, headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    }),
  );
  assert.equal(projection.state, "PR_DELIVERY_RECONCILE_REQUIRED");
  assert.equal(projection.gap, "DELIVERY_RECEIPT_IDENTITY_MISMATCH");
  assert.equal(projection.pr, undefined);
});

test("G4-09 succeeded with wrong branch fails closed to RECONCILE_REQUIRED", () => {
  const projection = projectPrDeliveryLifecycle(
    record({
      status: "succeeded",
      retrySafe: false,
      receipt: { ...RECEIPT, headBranch: "codex/some-other-branch" },
    }),
  );
  assert.equal(projection.state, "PR_DELIVERY_RECONCILE_REQUIRED");
  assert.equal(projection.gap, "DELIVERY_RECEIPT_IDENTITY_MISMATCH");
  assert.equal(projection.pr, undefined);
});

test("G4-10 wrong operation kind is rejected, never projected", () => {
  assert.throws(
    () => projectPrDeliveryLifecycle(record({ kind: "workspace_clone" })),
    (error: unknown) =>
      error instanceof PrDeliveryLifecycleError && error.code === "WRONG_OPERATION_KIND",
  );
});

test("G4-11 projection is pure: frozen input untouched and store read changes nothing", async () => {
  const frozen = Object.freeze(record({ status: "succeeded", retrySafe: false, receipt: { ...RECEIPT } }));
  const before = JSON.stringify(frozen);
  const projection = projectPrDeliveryLifecycle(frozen);
  assert.equal(JSON.stringify(frozen), before, "projection must not mutate its input");
  assert.equal(projection.state, "PR_DELIVERED");

  const stateDir = await mkdtemp(join(tmpdir(), "devspace-g4-lifecycle-"));
  try {
    const store = new DurableOperationStore(stateDir);
    try {
      const created = store.createOrReplay({
        operationId: "op_g4_readonly",
        attemptKey: "g4-readonly-1",
        requestHash: "hash-g4-readonly",
        kind: KIND,
        authorityMode: "OWNER_DIRECT",
        scopeRoot: stateDir,
        request: { ...REQUEST },
      }).record;
      const snapshotBefore = JSON.stringify(store.getByOperationId(created.operationId));
      const read = store.getByOperationId(created.operationId);
      assert.ok(read, "operation must be readable");
      assert.equal(read.kind, KIND);
      const projected = projectPrDeliveryLifecycle(read);
      assert.equal(projected.state, "PR_DELIVERY_IN_FLIGHT");
      assert.equal(
        JSON.stringify(store.getByOperationId(created.operationId)),
        snapshotBefore,
        "read plus projection must not change the durable record",
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("G4-12 restart-fenced started operation projects PR_DELIVERY_RECONCILE_REQUIRED", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-g4-restart-"));
  try {
    const store = new DurableOperationStore(stateDir);
    try {
      const created = store.createOrReplay({
        operationId: "op_g4_restart",
        attemptKey: "g4-restart-1",
        requestHash: "hash-g4-restart",
        kind: KIND,
        authorityMode: "OWNER_DIRECT",
        scopeRoot: stateDir,
        request: { ...REQUEST },
      }).record;
      assert.equal(projectPrDeliveryLifecycle(created).state, "PR_DELIVERY_IN_FLIGHT");
      const fenced = store.markInterruptedUnknown();
      assert.equal(fenced, 1, "exactly the started delivery operation must be fenced");
      const after = store.getByOperationId(created.operationId);
      assert.ok(after);
      assert.equal(after.status, "outcome_unknown");
      assert.equal(projectPrDeliveryLifecycle(after).state, "PR_DELIVERY_RECONCILE_REQUIRED");
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("G4-13/14/15 projection never emits CI_GREEN, CI_FAILED, or MERGE_READY", () => {
  const fixtures: DurableOperationRecord[] = [
    record({ status: "started" }),
    record({ status: "outcome_unknown", errorCode: "RECONCILIATION_REQUIRED" }),
    record({ status: "failed", retrySafe: false, errorCode: "REMOTE_IDENTITY_DRIFT" }),
    record({ status: "failed", retrySafe: true, errorCode: "CONFIRMED_NO_EFFECT" }),
    record({ status: "succeeded", receipt: { ...RECEIPT } }),
    record({ status: "succeeded" }),
  ];
  for (const fixture of fixtures) {
    assertNeverForbidden(projectPrDeliveryLifecycle(fixture).state);
  }
  const states: PrDeliveryLifecycleState[] = [
    "PR_DELIVERY_PREPARED",
    "PR_DELIVERY_IN_FLIGHT",
    "PR_DELIVERED",
    "PR_DELIVERY_RECONCILE_REQUIRED",
    "PR_DELIVERY_BLOCKED",
  ];
  assert.equal(states.length, 5, "G4 state union must stay bounded without CI/merge states");
});
