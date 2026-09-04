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
    now = 3_000;
    const first = store.recordRestartRequest(created.cutoverId, {
      actuator: "launchd-self",
      requestedByServerInstanceId: oldIdentity.serverInstanceId,
    });
    assert.equal(first.newlyRequested, true);
    assert.equal(first.record.restartRequest?.actuator, "launchd-self");
    assert.equal(first.record.restartRequest?.requestedByServerInstanceId, oldIdentity.serverInstanceId);
    assert.equal(first.record.restartRequest?.requestedAt, new Date(3_000).toISOString());

    now = 4_000;
    const duplicate = new CutoverStateStore(stateDir, { now: () => now }).recordRestartRequest(
      created.cutoverId,
      {
        actuator: "launchd-self",
        requestedByServerInstanceId: oldIdentity.serverInstanceId,
      },
    );
    assert.equal(duplicate.newlyRequested, false);
    assert.equal(duplicate.record.restartRequest?.requestedAt, new Date(3_000).toISOString());
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
