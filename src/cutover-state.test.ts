import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("restart scheduling requires build-ready attestation and marker is durable and idempotent", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-restart-scheduled-"));
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
      () => store.recordRestartScheduled(created.cutoverId, oldIdentity.serverInstanceId),
      /requires a drained cutover/i,
    );

    now = 2_000;
    store.recordDrain(created.cutoverId, { activeSessions: 2, oldestAgeMs: 9_000 });
    const requested = store.recordRestartRequest(created.cutoverId, {
      actuator: "launchd-self",
      requestedByServerInstanceId: oldIdentity.serverInstanceId,
      buildReady: {
        verifiedBy: "deploy-operator",
        verifiedAt: new Date(2_000).toISOString(),
        evidence: "staged artifact matches expected build",
      },
    });
    assert.equal(requested.record.restartRequest?.buildReady?.verifiedBy, "deploy-operator");

    now = 3_000;
    const scheduled = store.recordRestartScheduled(created.cutoverId, oldIdentity.serverInstanceId);
    assert.equal(scheduled.newlyScheduled, true);
    assert.equal(scheduled.record.restartRequest?.restartScheduledAt, new Date(3_000).toISOString());
    assert.equal(
      scheduled.record.restartRequest?.restartScheduledForServerInstanceId,
      oldIdentity.serverInstanceId,
    );

    const duplicate = new CutoverStateStore(stateDir, { now: () => now })
      .recordRestartScheduled(created.cutoverId, oldIdentity.serverInstanceId);
    assert.equal(duplicate.newlyScheduled, false);
    assert.equal(duplicate.record.restartRequest?.restartScheduledAt, new Date(3_000).toISOString());

    const afterReplacement = new CutoverStateStore(stateDir).get();
    assert.equal(afterReplacement?.restartRequest?.restartScheduledAt, new Date(3_000).toISOString());
    assert.equal(afterReplacement?.restartRequest?.buildReady?.verifiedBy, "deploy-operator");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("restart scheduling fails closed without a build-ready attestation", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-restart-ungated-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-ungated" });
    store.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-new", buildId: "build-new" },
    });
    store.recordDrain("cutover-ungated", { activeSessions: 2, oldestAgeMs: 9_000 });
    store.recordRestartRequest("cutover-ungated", {
      actuator: "launchd-self",
      requestedByServerInstanceId: oldIdentity.serverInstanceId,
    });
    assert.throws(
      () => store.recordRestartScheduled("cutover-ungated", oldIdentity.serverInstanceId),
      /build-ready attestation/i,
    );
    assert.throws(
      () => store.recordRestartScheduled("cutover-ungated", oldIdentity.serverInstanceId),
      /CUTOVER_BUILD_NOT_READY/i,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("concurrent schedulers produce exactly one restart schedule winner", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-schedule-race-"));
  try {
    const initial = new CutoverStateStore(stateDir, { newId: () => "cutover-schedule-race" });
    initial.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-new", buildId: "build-new" },
    });
    initial.recordDrain("cutover-schedule-race", { activeSessions: 4, oldestAgeMs: 5_000 });
    initial.recordRestartRequest("cutover-schedule-race", {
      actuator: "launchd-self",
      requestedByServerInstanceId: oldIdentity.serverInstanceId,
      buildReady: { verifiedBy: "deploy-operator", verifiedAt: new Date().toISOString() },
    });

    const stores = Array.from({ length: 12 }, () => new CutoverStateStore(stateDir));
    const results = await Promise.all(stores.map(async (store) => store.recordRestartScheduled(
      "cutover-schedule-race",
      oldIdentity.serverInstanceId,
    )));
    assert.equal(results.filter((result) => result.newlyScheduled).length, 1);
    assert.ok(results.every((result) => result.record.restartRequest?.restartScheduledAt !== undefined));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("invalid build-ready receipt and malformed schedule fence fail closed", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-invalid-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-invalid" });
    store.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-new", buildId: "build-new" },
    });
    store.recordDrain("cutover-invalid", { activeSessions: 0, oldestAgeMs: 0 });
    assert.throws(
      () => store.recordRestartRequest("cutover-invalid", {
        actuator: "launchd-self",
        requestedByServerInstanceId: oldIdentity.serverInstanceId,
        buildReady: { verifiedBy: "op", verifiedAt: "not-a-date" },
      }),
      /build-ready attestation is invalid/i,
    );

    store.recordRestartRequest("cutover-invalid", {
      actuator: "launchd-self",
      requestedByServerInstanceId: oldIdentity.serverInstanceId,
      buildReady: { verifiedBy: "op", verifiedAt: new Date().toISOString() },
    });
    store.recordRestartScheduled("cutover-invalid", oldIdentity.serverInstanceId);

    const activeDir = join(stateDir, "cutover", "active");
    writeFileSync(join(activeDir, "restart-scheduled.json"), "garbage", "utf8");
    assert.throws(
      () => new CutoverStateStore(stateDir).get(),
      /restart-scheduled fence is malformed/i,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("schedule fence from another cutover or a missing marker reads safely", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-fence-wrong-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-fence-wrong" });
    store.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-new", buildId: "build-new" },
    });
    store.recordDrain("cutover-fence-wrong", { activeSessions: 0, oldestAgeMs: 0 });
    store.recordRestartRequest("cutover-fence-wrong", {
      actuator: "launchd-self",
      requestedByServerInstanceId: oldIdentity.serverInstanceId,
      buildReady: { verifiedBy: "op", verifiedAt: new Date().toISOString() },
    });
    assert.equal(store.get()?.restartRequest?.restartScheduledAt, undefined);

    const activeDir = join(stateDir, "cutover", "active");
    writeFileSync(
      join(activeDir, "restart-scheduled.json"),
      JSON.stringify({
        schema: "devspace.cutover_restart_scheduled.v1",
        cutoverId: "some-other-cutover",
        scheduledForServerInstanceId: "server-other",
        scheduledAt: new Date().toISOString(),
      }),
      "utf8",
    );
    assert.throws(
      () => new CutoverStateStore(stateDir).get(),
      /does not match the active cutover/i,
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
