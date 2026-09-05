import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CutoverStateStore } from "./cutover-state.js";

const oldIdentity = {
  serverInstanceId: "server-old",
  sourceCommit: "source-old",
  buildId: "build-old",
  capabilityManifestSha256: "capability-preserved",
};

test("active cutover is durable, exclusive, and never expires into takeover authority", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-state-"));
  try {
    let now = 1_000;
    const firstStore = new CutoverStateStore(stateDir, {
      now: () => now,
      newId: () => "cutover-stable",
    });
    const created = firstStore.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: {
        sourceCommit: "source-new",
        buildId: "build-new",
        capabilityManifestSha256: "capability-preserved",
      },
      expiresAt: new Date(2_000).toISOString(),
    });

    now = 50_000;
    const afterRestart = new CutoverStateStore(stateDir, {
      now: () => now,
      newId: () => "must-not-win",
    });
    assert.equal(afterRestart.get()?.cutoverId, "cutover-stable");
    assert.equal(afterRestart.get()?.expired, true);
    assert.throws(
      () => afterRestart.begin({
        oldServerIdentity: oldIdentity,
        expectedNewIdentity: { sourceCommit: "other", buildId: "other" },
      }),
      /unresolved cutover cutover-stable/i,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("concurrent controllers create exactly one active cutover", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-race-"));
  try {
    const stores = Array.from({ length: 8 }, (_, index) => new CutoverStateStore(stateDir, {
      newId: () => `cutover-${index}`,
    }));
    const results = await Promise.allSettled(stores.map(async (store) => store.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-new", buildId: "build-new" },
    })));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const ids = new Set(stores.map((store) => store.get()?.cutoverId));
    assert.equal(ids.size, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("restart request requires drain, survives replacement, and is idempotent", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-restart-request-"));
  try {
    let now = 1_000;
    const store = new CutoverStateStore(stateDir, {
      now: () => now,
      newId: () => `event-${now}`,
    });
    const created = store.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-new", buildId: "build-new" },
    });
    assert.throws(
      () => store.recordRestartRequest(created.cutoverId, {
        actuator: "launchd-self",
        requestedByServerInstanceId: oldIdentity.serverInstanceId,
      }),
      /must be drained/i,
    );

    now = 2_000;
    store.recordDrain(created.cutoverId, { activeSessions: 2, oldestAgeMs: 9_000 });
    const first = store.recordRestartRequest(created.cutoverId, {
      actuator: "launchd-self",
      requestedByServerInstanceId: oldIdentity.serverInstanceId,
    });
    assert.equal(first.newlyRequested, true);
    assert.equal(first.record.restartRequest?.actuator, "launchd-self");
    assert.equal(first.record.restartRequest?.requestedByServerInstanceId, oldIdentity.serverInstanceId);
    assert.equal(first.record.restartRequest?.requestedAt, new Date(2_000).toISOString());

    now = 4_000;
    const duplicate = new CutoverStateStore(stateDir, { now: () => now }).recordRestartRequest(
      created.cutoverId,
      {
        actuator: "launchd-self",
        requestedByServerInstanceId: oldIdentity.serverInstanceId,
      },
    );
    assert.equal(duplicate.newlyRequested, false);
    assert.equal(duplicate.record.restartRequest?.requestedAt, new Date(2_000).toISOString());
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("concurrent restart requesters produce exactly one restart authority winner", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-restart-race-"));
  try {
    const initial = new CutoverStateStore(stateDir, { newId: () => "cutover-restart-race" });
    initial.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-new", buildId: "build-new" },
    });
    initial.recordDrain("cutover-restart-race", { activeSessions: 4, oldestAgeMs: 5_000 });

    const stores = Array.from({ length: 12 }, () => new CutoverStateStore(stateDir));
    const results = await Promise.all(stores.map(async (store) => store.recordRestartRequest(
      "cutover-restart-race",
      {
        actuator: "launchd-self",
        requestedByServerInstanceId: oldIdentity.serverInstanceId,
      },
    )));
    assert.equal(results.filter((result) => result.newlyRequested).length, 1);
    assert.ok(results.every((result) => result.record.restartRequest?.actuator === "launchd-self"));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("replacement drain recovery is durable, typed, and survives store replacement", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-recovery-"));
  try {
    let now = 1_000;
    const first = new CutoverStateStore(stateDir, {
      now: () => now,
      newId: () => `recovery-${now}`,
    });
    first.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-new", buildId: "build-new" },
    });

    now = 2_000;
    const recovered = first.recordRecoveredDrain("recovery-1000", {
      recoveredByServerInstanceId: "server-new",
      transportEvidence: { activeSessions: 3, oldestAgeMs: 12_000 },
    });
    assert.equal(recovered.phase, "recovered");
    assert.deepEqual(recovered.recoveryEvidence, {
      kind: "REPLACEMENT_RECOVER_DRAIN",
      recoveredByServerInstanceId: "server-new",
      transportEvidence: { activeSessions: 3, oldestAgeMs: 12_000 },
      recoveredAt: new Date(2_000).toISOString(),
    });

    now = 3_000;
    const reopened = new CutoverStateStore(stateDir, { now: () => now });
    assert.equal(reopened.get()?.phase, "recovered");
    assert.equal(reopened.get()?.recoveryEvidence?.recoveredByServerInstanceId, "server-new");
    assert.equal(
      reopened.recordRecoveredDrain("recovery-1000", {
        recoveredByServerInstanceId: "server-other",
        transportEvidence: { activeSessions: 999, oldestAgeMs: 999 },
      }).recoveryEvidence?.recoveredByServerInstanceId,
      "server-new",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("drain evidence and terminal reconciliation receipt survive store replacement", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-receipt-"));
  try {
    const first = new CutoverStateStore(stateDir, { newId: () => "cutover-one" });
    first.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-new", buildId: "build-new" },
    });
    first.recordDrain("cutover-one", { activeSessions: 2, oldestAgeMs: 9_000 });

    const restarted = new CutoverStateStore(stateDir);
    assert.equal(restarted.get()?.phase, "drained");
    assert.deepEqual(restarted.get()?.drainEvidence, { activeSessions: 2, oldestAgeMs: 9_000 });
    restarted.close("cutover-one", {
      closedByServerInstanceId: "server-new",
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
      reconciledAt: "2026-09-04T00:00:00.000Z",
    });

    const terminal = new CutoverStateStore(stateDir).get();
    assert.equal(terminal?.phase, "closed");
    assert.equal(terminal?.reconciliationReceipt?.agentReconciled, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
