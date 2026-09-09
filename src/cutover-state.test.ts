import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CutoverStateStore, type DurableReconciliationWitness } from "./cutover-state.js";

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

test("recoverSupersede terminally supersedes a stale cutover and establishes a fresh successor", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-supersede-"));
  try {
    let now = 1_000;
    const store = new CutoverStateStore(stateDir, {
      now: () => now,
      newId: () => {
        now += 1;
        return `id-${now}`;
      },
    });
    store.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-stale", buildId: "build-stale" },
    });

    now = 10_000;
    const recovered = store.recoverSupersede({
      cutoverId: "id-1001",
      expectedNewIdentity: { sourceCommit: "source-target", buildId: "build-target" },
      observedIdentity: {
        serverInstanceId: "server-recovery",
        sourceCommit: "source-target",
        buildId: "build-target",
      },
      recoveredBy: "server-recovery",
    });

    assert.equal(recovered.newlyRecovered, true);
    assert.equal(recovered.terminal.phase, "superseded");
    assert.equal(recovered.terminal.cutoverId, "id-1001");
    assert.equal(recovered.terminal.supersedesCutoverId, undefined);
    assert.equal(recovered.terminal.supersession?.schema, "devspace.cutover_superseded.v1");
    assert.equal(recovered.terminal.supersession?.supersededCutoverId, "id-1001");
    assert.equal(recovered.terminal.supersession?.oldServerIdentity.serverInstanceId, "server-old");
    assert.deepEqual(recovered.terminal.supersession?.oldExpectedIdentity, {
      sourceCommit: "source-stale",
      buildId: "build-stale",
    });
    assert.equal(recovered.terminal.supersession?.observedIdentity.serverInstanceId, "server-recovery");
    assert.equal(recovered.terminal.supersession?.terminalReason, "STALE_TARGET_SUPERSEDED");
    assert.equal(recovered.terminal.supersession?.successorCutoverId, recovered.successor.cutoverId);
    assert.deepEqual(recovered.terminal.supersession?.restartAmbiguity, {
      restartRequested: false,
      restartScheduled: false,
      oldRestartEffect: "ambiguous_historical",
    });

    assert.equal(recovered.successor.phase, "prepared");
    assert.equal(recovered.successor.supersedesCutoverId, "id-1001");
    assert.deepEqual(recovered.successor.expectedNewIdentity, {
      sourceCommit: "source-target",
      buildId: "build-target",
    });
    assert.equal(recovered.successor.oldServerIdentity.serverInstanceId, "server-old");
    assert.notEqual(recovered.successor.cutoverId, "id-1001");

    assert.equal(store.get()?.cutoverId, recovered.successor.cutoverId);
    assert.equal(store.get()?.phase, "prepared");
    assert.equal(store.supersededRecord()?.cutoverId, "id-1001");
    assert.equal(existsSync(join(stateDir, "cutover", "recovery-intent.json")), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("recoverSupersede rendezvouses to the same successor and refuses a changed target", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-rendezvous-"));
  try {
    const store = new CutoverStateStore(stateDir, {
      newId: (() => { let n = 0; return () => `cutover-${n += 1}`; })(),
    });
    store.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-stale", buildId: "build-stale" },
    });
    const first = store.recoverSupersede({
      cutoverId: "cutover-1",
      expectedNewIdentity: { sourceCommit: "source-target", buildId: "build-target" },
      observedIdentity: oldIdentity,
      recoveredBy: "server-recovery",
    });
    assert.equal(first.newlyRecovered, true);

    // Rendezvous after successor creation + ack loss: same successor, no mutation.
    const retry = store.recoverSupersede({
      cutoverId: "cutover-1",
      expectedNewIdentity: { sourceCommit: "source-target", buildId: "build-target" },
      observedIdentity: oldIdentity,
      recoveredBy: "server-recovery",
    });
    assert.equal(retry.newlyRecovered, false);
    assert.equal(retry.successor.cutoverId, first.successor.cutoverId);
    assert.equal(retry.terminal.cutoverId, first.terminal.cutoverId);

    // A different target on retry fails closed at the recovery intent.
    assert.throws(
      () => store.recoverSupersede({
        cutoverId: "cutover-1",
        expectedNewIdentity: { sourceCommit: "source-different", buildId: "build-target" },
        observedIdentity: oldIdentity,
        recoveredBy: "server-recovery",
      }),
      /RECOVERY_BINDING_MISMATCH/i,
    );

  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("recoverSupersede resumes a superseded terminal when the successor was lost (C2)", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-c2-"));
  try {
    const store = new CutoverStateStore(stateDir, {
      newId: (() => { let n = 0; return () => `cutover-${n += 1}`; })(),
    });
    store.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-stale", buildId: "build-stale" },
    });
    store.recoverSupersede({
      cutoverId: "cutover-1",
      expectedNewIdentity: { sourceCommit: "source-target", buildId: "build-target" },
      observedIdentity: oldIdentity,
      recoveredBy: "server-recovery",
    });
    rmSync(join(stateDir, "cutover", "active", "successor-created.json"), { force: true });

    // The superseded terminal still owns the durable fence and is visible.
    assert.equal(store.get()?.cutoverId, "cutover-1");
    assert.equal(store.get()?.phase, "superseded");

    // Retry re-establishes exactly one successor bound to the same target.
    const resumed = store.recoverSupersede({
      cutoverId: "cutover-1",
      expectedNewIdentity: { sourceCommit: "source-target", buildId: "build-target" },
      observedIdentity: oldIdentity,
      recoveredBy: "server-recovery",
    });
    assert.equal(resumed.newlyRecovered, true);
    assert.equal(resumed.successor.supersedesCutoverId, "cutover-1");

    // The fence remains exclusive: a fresh recover cannot create a second successor.
    const again = store.recoverSupersede({
      cutoverId: "cutover-1",
      expectedNewIdentity: { sourceCommit: "source-target", buildId: "build-target" },
      observedIdentity: oldIdentity,
      recoveredBy: "server-recovery",
    });
    assert.equal(again.newlyRecovered, false);
    assert.equal(again.successor.cutoverId, resumed.successor.cutoverId);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("recoverSupersede resumes an intent-only crash window and fences a changed target (C1)", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-c1-"));
  try {
    const store = new CutoverStateStore(stateDir, {
      newId: (() => { let n = 0; return () => `cutover-${n += 1}`; })(),
    });
    store.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-stale", buildId: "build-stale" },
    });
    const cutoverRoot = join(stateDir, "cutover");
    writeFileSync(
      join(cutoverRoot, "recovery-intent.json"),
      JSON.stringify({
        schema: "devspace.cutover_recovery_intent.v1",
        version: 1,
        supersedesCutoverId: "cutover-1",
        expectedNewIdentity: { sourceCommit: "source-target", buildId: "build-target" },
        requestedByServerInstanceId: "server-recovery",
        requestedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const resumed = store.recoverSupersede({
      cutoverId: "cutover-1",
      expectedNewIdentity: { sourceCommit: "source-target", buildId: "build-target" },
      observedIdentity: oldIdentity,
      recoveredBy: "server-recovery",
    });
    assert.equal(resumed.newlyRecovered, true);
    assert.equal(resumed.terminal.phase, "superseded");

    // A different target after the intent window is refused even though it is the
    // only other possible writer.
    const bound = store.recoverSupersede({
      cutoverId: "cutover-1",
      expectedNewIdentity: { sourceCommit: "source-target", buildId: "build-target" },
      observedIdentity: oldIdentity,
      recoveredBy: "server-recovery",
    });
    assert.equal(bound.newlyRecovered, false);
    assert.throws(
      () => store.recoverSupersede({
        cutoverId: "cutover-1",
        expectedNewIdentity: { sourceCommit: "source-different", buildId: "build-target" },
        observedIdentity: oldIdentity,
        recoveredBy: "server-recovery",
      }),
      /RECOVERY_BINDING_MISMATCH/i,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("concurrent recoverers produce exactly one successor cutover", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-supersede-race-"));
  try {
    const initialState = new CutoverStateStore(stateDir, { newId: () => "cutover-race" });
    initialState.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-stale", buildId: "build-stale" },
    });

    const stores = Array.from({ length: 8 }, (_, index) => new CutoverStateStore(stateDir, {
      newId: () => `successor-${index}`,
    }));
    const results = await Promise.allSettled(stores.map(async (store) => store.recoverSupersede({
      cutoverId: "cutover-race",
      expectedNewIdentity: { sourceCommit: "source-target", buildId: "build-target" },
      observedIdentity: oldIdentity,
      recoveredBy: `recovery-${Math.random()}`,
    })));
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    assert.ok(fulfilled.length >= 1);
    const successorIds = new Set(
      fulfilled.map((result) => (result as PromiseFulfilledResult<{
        successor: { cutoverId: string };
      }>).value.successor.cutoverId),
    );
    assert.equal(successorIds.size, 1);
    assert.equal(fulfilled.filter((result) => (result as PromiseFulfilledResult<{
      newlyRecovered: boolean;
    }>).value.newlyRecovered).length, 1);
    assert.equal(new CutoverStateStore(stateDir).supersededRecord()?.cutoverId, "cutover-race");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("recoverSupersede rejects a closed cutover and a mismatched active id", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-reject-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-closed" });
    store.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-new", buildId: "build-new" },
    });
    store.recordDrain("cutover-closed", { activeSessions: 1, oldestAgeMs: 10 });
    store.close("cutover-closed", {
      closedByServerInstanceId: "server-new",
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
      reconciledAt: new Date().toISOString(),
    });
    assert.throws(
      () => store.recoverSupersede({
        cutoverId: "cutover-closed",
        expectedNewIdentity: { sourceCommit: "source-target", buildId: "build-target" },
        observedIdentity: oldIdentity,
        recoveredBy: "server-recovery",
      }),
      /already closed/i,
    );

    const other = new CutoverStateStore(stateDir, { newId: () => "cutover-other" });
    assert.throws(
      () => other.recoverSupersede({
        cutoverId: "not-the-active-cutover",
        expectedNewIdentity: { sourceCommit: "source-target", buildId: "build-target" },
        observedIdentity: oldIdentity,
        recoveredBy: "server-recovery",
      }),
      /already closed|mismatch|no durable/i,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("successor lifecycle drains, restarts, schedules, and closes with scoped markers", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-successor-lifecycle-"));
  try {
    let now = 1_000;
    const store = new CutoverStateStore(stateDir, {
      now: () => now,
      newId: () => {
        now += 1;
        return `id-${now}`;
      },
    });
    store.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-stale", buildId: "build-stale" },
    });
    const recovered = store.recoverSupersede({
      cutoverId: "id-1001",
      expectedNewIdentity: { sourceCommit: "source-target", buildId: "build-target" },
      observedIdentity: oldIdentity,
      recoveredBy: "server-recovery",
    });
    const successorId = recovered.successor.cutoverId;

    assert.throws(
      () => store.recordRestartRequest(successorId, {
        actuator: "launchd-self",
        requestedByServerInstanceId: "server-target",
      }),
      /must be drained/i,
    );

    store.recordDrain(successorId, { activeSessions: 3, oldestAgeMs: 40_000 });
    assert.equal(store.get()?.phase, "drained");
    assert.equal(store.get()?.cutoverId, successorId);

    const requested = store.recordRestartRequest(successorId, {
      actuator: "launchd-self",
      requestedByServerInstanceId: "server-target",
      buildReady: { verifiedBy: "seam", verifiedAt: new Date(now).toISOString() },
    });
    assert.equal(requested.newlyRequested, true);

    const scheduled = store.recordRestartScheduled(successorId, "server-target");
    assert.equal(scheduled.newlyScheduled, true);

    const activeDir = join(stateDir, "cutover", "active");
    assert.equal(existsSync(join(activeDir, `restart-requested-${successorId}.json`)), true);
    assert.equal(existsSync(join(activeDir, `restart-scheduled-${successorId}.json`)), true);

    store.close(successorId, {
      closedByServerInstanceId: "server-target",
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
      reconciledAt: new Date(now).toISOString(),
    });
    assert.equal(store.get()?.phase, "closed");
    assert.equal(store.get()?.supersedesCutoverId, "id-1001");

    const next = store.begin({
      oldServerIdentity: {
        serverInstanceId: "server-target",
        sourceCommit: "source-target",
        buildId: "build-target",
      },
      expectedNewIdentity: { sourceCommit: "source-future", buildId: "build-future" },
    });
    assert.equal(store.get()?.cutoverId, next.cutoverId);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("malformed supersession records fail closed on parse", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-supersession-parse-"));
  try {
    const store = new CutoverStateStore(stateDir, {
      newId: (() => { let n = 0; return () => `cutover-${n += 1}`; })(),
    });
    store.begin({
      oldServerIdentity: oldIdentity,
      expectedNewIdentity: { sourceCommit: "source-stale", buildId: "build-stale" },
    });
    store.recoverSupersede({
      cutoverId: "cutover-1",
      expectedNewIdentity: { sourceCommit: "source-target", buildId: "build-target" },
      observedIdentity: oldIdentity,
      recoveredBy: "server-recovery",
    });

    const superseded = store.supersededRecord();
    assert.ok(superseded);
    const activeDir = join(stateDir, "cutover", "active");
    const supersededPath = join(
      activeDir,
      readdirSync(activeDir).find((name) => name.startsWith("superseded-")) ?? "missing.json",
    );
    writeFileSync(supersededPath, JSON.stringify({
      ...superseded,
      supersession: { ...superseded.supersession, successorExpectedIdentity: undefined },
    }), "utf8");
    assert.throws(
      () => new CutoverStateStore(stateDir).supersededRecord(),
      /malformed/i,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Test 2 & 3 — current production deadlock recovered without fabricated drain", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-deadlock-recovery-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-deadlock" });
    const instanceA = {
      serverInstanceId: "instance-A",
      sourceCommit: "old-source-S0",
      buildId: "old-build-B0",
      capabilityManifestSha256: "manifest-M",
    };
    const expectedTarget = {
      sourceCommit: "target-source-S",
      buildId: "target-build-B",
      capabilityManifestSha256: "manifest-M",
    };
    store.begin({
      oldServerIdentity: instanceA,
      expectedNewIdentity: expectedTarget,
    });
    const initial = store.get()!;
    assert.equal(initial.phase, "prepared");
    assert.equal(initial.drainEvidence, undefined);

    const instanceB = {
      serverInstanceId: "instance-B",
      sourceCommit: "target-source-S",
      buildId: "target-build-B",
      capabilityManifestSha256: "manifest-M",
    };

    const goodWitness: DurableReconciliationWitness = {
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
      witnessWorkspaceId: "ws-test",
      witnessAgentId: "agent-test",
      witnessWorkspaceSessions: 1,
      witnessAgentSessions: 1,
      witnessKind: "exact-pair",
    };

    const recovered = store.recoverObservedReplacement({
      cutoverId: "cutover-deadlock",
      expectedNewIdentity: expectedTarget,
      observedIdentity: instanceB,
      witness: goodWitness,
      recoveredBy: instanceB.serverInstanceId,
    });

    // Test 2: Legal recovery + terminal close
    assert.equal(recovered.newlyRecovered, true);
    assert.equal(recovered.record.phase, "closed");
    assert.equal(recovered.record.observedReplacement?.cutoverId, "cutover-deadlock");
    assert.equal(recovered.record.observedReplacement?.terminalReason, "OBSERVED_REPLACEMENT_WITHOUT_DRAIN");

    // Test 3: No fabricated drain
    assert.equal(recovered.record.drainEvidence, undefined);
    assert.equal(recovered.record.observedReplacement?.preRestartDrainObserved, false);
    assert.equal(recovered.record.reconciliationReceipt?.preRestartDrainObserved, false);

    const reloaded = new CutoverStateStore(stateDir).get()!;
    assert.equal(reloaded.phase, "closed");
    assert.equal(reloaded.drainEvidence, undefined);
    assert.equal(reloaded.observedReplacement?.preRestartDrainObserved, false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Test 4, 5, 6 — wrong identity fails closed with state unchanged", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-identity-failclosed-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-ident" });
    const instanceA = { serverInstanceId: "inst-A", sourceCommit: "source-A", buildId: "build-A" };
    const expected = { sourceCommit: "source-target", buildId: "build-target", capabilityManifestSha256: "cap-target" };
    store.begin({ oldServerIdentity: instanceA, expectedNewIdentity: expected });

    const goodWitness: DurableReconciliationWitness = {
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
      witnessWorkspaceId: "ws-test",
      witnessAgentId: "agent-test",
      witnessWorkspaceSessions: 1,
      witnessAgentSessions: 1,
      witnessKind: "exact-pair",
    };

    // Test 4: wrong source
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-ident",
        observedIdentity: { serverInstanceId: "inst-B", sourceCommit: "wrong-source", buildId: "build-target", capabilityManifestSha256: "cap-target" },
        witness: goodWitness,
        recoveredBy: "inst-B",
      }),
      /sourceCommit/i,
    );
    assert.equal(store.get()?.phase, "prepared");

    // Test 5: wrong build
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-ident",
        observedIdentity: { serverInstanceId: "inst-B", sourceCommit: "source-target", buildId: "wrong-build", capabilityManifestSha256: "cap-target" },
        witness: goodWitness,
        recoveredBy: "inst-B",
      }),
      /buildId/i,
    );
    assert.equal(store.get()?.phase, "prepared");

    // Test 6: wrong capability manifest
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-ident",
        observedIdentity: { serverInstanceId: "inst-B", sourceCommit: "source-target", buildId: "build-target", capabilityManifestSha256: "wrong-cap" },
        witness: goodWitness,
        recoveredBy: "inst-B",
      }),
      /capability manifest/i,
    );
    assert.equal(store.get()?.phase, "prepared");

    // Same old server instance
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-ident",
        observedIdentity: { serverInstanceId: "inst-A", sourceCommit: "source-target", buildId: "build-target", capabilityManifestSha256: "cap-target" },
        witness: goodWitness,
        recoveredBy: "inst-A",
      }),
      /serverInstanceId did not change/i,
    );
    assert.equal(store.get()?.phase, "prepared");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Test 7 — witness incomplete fails closed without terminal close", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-witness-failclosed-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-wit" });
    const instanceA = { serverInstanceId: "inst-A", sourceCommit: "source-A", buildId: "build-A" };
    const expected = { sourceCommit: "source-target", buildId: "build-target" };
    store.begin({ oldServerIdentity: instanceA, expectedNewIdentity: expected });

    const targetInstance = { serverInstanceId: "inst-B", sourceCommit: "source-target", buildId: "build-target" };

    // workspaceQueryable=false
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-wit",
        observedIdentity: targetInstance,
        witness: {
          workspaceQueryable: false,
          agentQueryable: true,
          agentReconciled: true,
          witnessWorkspaceId: "ws-1",
          witnessAgentId: "agent-1",
          witnessWorkspaceSessions: 1,
          witnessAgentSessions: 1,
        },
        recoveredBy: "inst-B",
      }),
      /witness is not fully positive/i,
    );
    assert.equal(store.get()?.phase, "prepared");

    // agentQueryable=false
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-wit",
        observedIdentity: targetInstance,
        witness: {
          workspaceQueryable: true,
          agentQueryable: false,
          agentReconciled: true,
          witnessWorkspaceId: "ws-1",
          witnessAgentId: "agent-1",
          witnessWorkspaceSessions: 1,
          witnessAgentSessions: 1,
        },
        recoveredBy: "inst-B",
      }),
      /witness is not fully positive/i,
    );
    assert.equal(store.get()?.phase, "prepared");

    // agentReconciled=false
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-wit",
        observedIdentity: targetInstance,
        witness: {
          workspaceQueryable: true,
          agentQueryable: true,
          agentReconciled: false,
          witnessWorkspaceId: "ws-1",
          witnessAgentId: "agent-1",
          witnessWorkspaceSessions: 1,
          witnessAgentSessions: 1,
        },
        recoveredBy: "inst-B",
      }),
      /witness is not fully positive/i,
    );
    assert.equal(store.get()?.phase, "prepared");

    // P0-2: zero agents
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-wit",
        observedIdentity: targetInstance,
        witness: {
          workspaceQueryable: true,
          agentQueryable: true,
          agentReconciled: true,
          witnessWorkspaceId: "ws-1",
          witnessAgentId: "agent-1",
          witnessWorkspaceSessions: 1,
          witnessAgentSessions: 0,
        },
        recoveredBy: "inst-B",
      }),
      /witness is not fully positive/i,
    );
    assert.equal(store.get()?.phase, "prepared");

    // P0-2: zero workspaces
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-wit",
        observedIdentity: targetInstance,
        witness: {
          workspaceQueryable: true,
          agentQueryable: true,
          agentReconciled: true,
          witnessWorkspaceId: "ws-1",
          witnessAgentId: "agent-1",
          witnessWorkspaceSessions: 0,
          witnessAgentSessions: 1,
        },
        recoveredBy: "inst-B",
      }),
      /witness is not fully positive/i,
    );
    assert.equal(store.get()?.phase, "prepared");

    // P0-2: missing witnessAgentId
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-wit",
        observedIdentity: targetInstance,
        witness: {
          workspaceQueryable: true,
          agentQueryable: true,
          agentReconciled: true,
          witnessWorkspaceId: "ws-1",
          witnessWorkspaceSessions: 1,
          witnessAgentSessions: 1,
        },
        recoveredBy: "inst-B",
      }),
      /witness is not fully positive/i,
    );
    assert.equal(store.get()?.phase, "prepared");

    // P0-2: missing witnessWorkspaceId
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-wit",
        observedIdentity: targetInstance,
        witness: {
          workspaceQueryable: true,
          agentQueryable: true,
          agentReconciled: true,
          witnessAgentId: "agent-1",
          witnessWorkspaceSessions: 1,
          witnessAgentSessions: 1,
        },
        recoveredBy: "inst-B",
      }),
      /witness is not fully positive/i,
    );
    assert.equal(store.get()?.phase, "prepared");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Test 8 & 9 — exact replay idempotent, changed binding fails closed", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-replay-idempotent-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-replay" });
    const instanceA = { serverInstanceId: "inst-A", sourceCommit: "source-A", buildId: "build-A" };
    const expected = { sourceCommit: "source-target", buildId: "build-target" };
    store.begin({ oldServerIdentity: instanceA, expectedNewIdentity: expected });

    const targetInstance = { serverInstanceId: "inst-B", sourceCommit: "source-target", buildId: "build-target" };
    const goodWitness: DurableReconciliationWitness = {
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
      witnessWorkspaceId: "ws-test",
      witnessAgentId: "agent-test",
      witnessWorkspaceSessions: 1,
      witnessAgentSessions: 1,
      witnessKind: "exact-pair",
    };

    const first = store.recoverObservedReplacement({
      cutoverId: "cutover-replay",
      expectedNewIdentity: expected,
      observedIdentity: targetInstance,
      witness: goodWitness,
      recoveredBy: "inst-B",
    });
    assert.equal(first.newlyRecovered, true);
    assert.equal(first.record.phase, "closed");

    // Test 8: Exact replay idempotent
    const second = store.recoverObservedReplacement({
      cutoverId: "cutover-replay",
      expectedNewIdentity: expected,
      observedIdentity: targetInstance,
      witness: goodWitness,
      recoveredBy: "inst-B",
    });
    assert.equal(second.newlyRecovered, false);
    assert.equal(second.record.phase, "closed");
    assert.equal(second.record.cutoverId, first.record.cutoverId);

    // A closed receipt is idempotent only for the same observed replacement;
    // a changed generation identity must still fail closed.
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-replay",
        expectedNewIdentity: expected,
        observedIdentity: { ...targetInstance, serverInstanceId: "inst-C" },
        witness: goodWitness,
        recoveredBy: "inst-C",
      }),
      /observed sourceCommit|observed buildId|RECOVERY_BINDING_MISMATCH|already closed/i,
    );

    // Test 9: Changed recovery binding fails closed
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-replay",
        expectedNewIdentity: { sourceCommit: "different-source", buildId: "build-target" },
        observedIdentity: targetInstance,
        witness: goodWitness,
        recoveredBy: "inst-B",
      }),
      /RECOVERY_BINDING_MISMATCH/i,
    );

    const closedEvent = readdirSync(join(stateDir, "cutover", "active"))
      .find((name) => name.startsWith("closed-"));
    assert.ok(closedEvent);
    const tampered = JSON.parse(readFileSync(join(stateDir, "cutover", "active", closedEvent), "utf8")) as {
      observedReplacement: { cutoverId: string };
    };
    tampered.observedReplacement.cutoverId = "cutover-other";
    writeFileSync(join(stateDir, "cutover", "active", closedEvent), `${JSON.stringify(tampered)}\n`);
    assert.throws(
      () => new CutoverStateStore(stateDir).get(),
      /malformed|reconciliation/i,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
