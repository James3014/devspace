import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CutoverStateStore,
  type CutoverServerIdentity,
  type ExpectedCutoverIdentity,
} from "./cutover-state.js";
import { McpCutoverController, type DurableReconciliationWitness } from "./mcp-cutover.js";
import { CutoverOrchestrator } from "./cutover-orchestration.js";
import type { BuildReadyProbeResult } from "./cutover-build-ready.js";
import type { SelfRestartActuator } from "./cutover-restart.js";

const oldIdentity: CutoverServerIdentity = {
  serverInstanceId: "server-old",
  sourceCommit: "source-old",
  buildId: "build-old",
  capabilityManifestSha256: "cap-shared",
};
const expectedId: ExpectedCutoverIdentity = {
  sourceCommit: "source-new",
  buildId: "build-new",
  capabilityManifestSha256: "cap-shared",
};
const newIdentity: CutoverServerIdentity = {
  serverInstanceId: "server-new",
  sourceCommit: "source-new",
  buildId: "build-new",
  capabilityManifestSha256: "cap-shared",
};

const goodWitness: DurableReconciliationWitness = {
  workspaceQueryable: true,
  agentQueryable: true,
  agentReconciled: true,
};
const badWitness: DurableReconciliationWitness = {
  workspaceQueryable: true,
  agentQueryable: true,
  agentReconciled: false,
};

function makeActuator(failOnSchedule = false): SelfRestartActuator & { calls: number } {
  const actuator: SelfRestartActuator & { calls: number } = {
    calls: 0,
    actuator: "launchd-self",
    serviceLabel: "com.example.devspace",
    launchdTarget: "gui/501/com.example.devspace",
    schedule: () => {
      actuator.calls += 1;
      if (failOnSchedule) {
        throw new Error("launchctl kickstart unavailable");
      }
      return {
        scheduled: true,
        actuator: "launchd-self",
        serviceLabel: "com.example.devspace",
        launchdTarget: "gui/501/com.example.devspace",
      };
    },
  };
  return actuator;
}

function makeStore(stateDir: string): {
  old: McpCutoverController;
  replacement: McpCutoverController;
  orchestrator: (controller: McpCutoverController, extra?: {
    actuator?: SelfRestartActuator;
    probe?: () => BuildReadyProbeResult;
    witness?: () => Promise<DurableReconciliationWitness>;
  }) => CutoverOrchestrator;
} {
  const old = new McpCutoverController(new CutoverStateStore(stateDir), oldIdentity);
  const replacement = new McpCutoverController(new CutoverStateStore(stateDir), newIdentity);
  const orchestrator = (
    controller: McpCutoverController,
    extra: {
      actuator?: SelfRestartActuator;
      probe?: () => BuildReadyProbeResult;
      witness?: () => Promise<DurableReconciliationWitness>;
    } = {},
  ) => {
    const enumerate = extra.witness ?? (async () => goodWitness);
    return new CutoverOrchestrator({
      controller,
      actuator: extra.actuator ?? makeActuator(),
      enumerateAll: enumerate,
      ...(extra.probe ? { probeBuildReady: extra.probe } : {}),
    });
  };
  return { old, replacement, orchestrator };
}

test("advance is a no-op without an unresolved cutover", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-orch-noop-"));
  try {
    const { old, orchestrator } = makeStore(stateDir);
    const outcome = await orchestrator(old).advance();
    assert.equal(outcome.outcome, "noop");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("advance awaits drain after start and never auto-drains", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-orch-drain-"));
  try {
    const { old, orchestrator } = makeStore(stateDir);
    old.begin(expectedId);
    const outcome = await orchestrator(old).advance();
    assert.equal(outcome.outcome, "awaiting_drain");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("advance awaits an operator restart decision after drain without a restart request", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-orch-decision-"));
  try {
    const { old, orchestrator } = makeStore(stateDir);
    old.begin(expectedId);
    old.recordDrain(old.record()!.cutoverId, { activeSessions: 0, oldestAgeMs: 0 });
    const outcome = await orchestrator(old).advance();
    assert.equal(outcome.outcome, "awaiting_decision");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("advance blocks un-gated restarts with CUTOVER_BUILD_NOT_READY and never schedules", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-orch-ungated-"));
  try {
    const { old, orchestrator } = makeStore(stateDir);
    const actuator = makeActuator();
    old.begin(expectedId);
    const cutoverId = old.record()!.cutoverId;
    old.recordDrain(cutoverId, { activeSessions: 0, oldestAgeMs: 0 });
    old.requestRestart(cutoverId);
    const outcome = await orchestrator(old, { actuator }).advance();
    assert.equal(outcome.outcome, "blocked");
    assert.equal(outcome.code, "CUTOVER_BUILD_NOT_READY");
    assert.equal(actuator.calls, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("advance refuses to schedule when the build-ready probe fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-orch-probe-fail-"));
  try {
    const { old, orchestrator } = makeStore(stateDir);
    const actuator = makeActuator();
    old.begin(expectedId);
    const cutoverId = old.record()!.cutoverId;
    old.recordDrain(cutoverId, { activeSessions: 0, oldestAgeMs: 0 });
    old.requestRestart(cutoverId, { verifiedBy: "op", verifiedAt: new Date().toISOString() });
    const outcome = await orchestrator(old, {
      actuator,
      probe: () => ({
        buildReady: false,
        verifiedBy: "build-identity-file",
        verifiedAt: new Date().toISOString(),
        expectedSourceCommit: expectedId.sourceCommit,
        expectedBuildId: expectedId.buildId,
        actualSourceCommit: "source-wrong",
        actualBuildId: "build-wrong",
        detail: "mismatch",
      }),
    }).advance();
    assert.equal(outcome.outcome, "blocked");
    assert.equal("code" in outcome && outcome.code, "CUTOVER_BUILD_NOT_READY");
    assert.ok("probe" in outcome && outcome.probe && !outcome.probe.buildReady);
    assert.equal(actuator.calls, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("advance schedules a gated restart exactly once and durably records the marker", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-orch-schedule-"));
  try {
    const { old, orchestrator } = makeStore(stateDir);
    const actuator = makeActuator();
    old.begin(expectedId);
    const cutoverId = old.record()!.cutoverId;
    old.recordDrain(cutoverId, { activeSessions: 0, oldestAgeMs: 0 });
    old.requestRestart(cutoverId, { verifiedBy: "op", verifiedAt: new Date().toISOString() });

    const first = await orchestrator(old, { actuator }).advance();
    assert.equal(first.outcome, "restart_scheduled");
    assert.equal(actuator.calls, 1);
    assert.equal(old.record()?.restartRequest?.restartScheduledAt !== undefined, true);

    const second = await orchestrator(old, { actuator }).advance();
    assert.equal(second.outcome, "restart_already_scheduled");
    assert.equal(actuator.calls, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("dry-run rehearsal never schedules or mutates durable state", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-orch-dryrun-"));
  try {
    const { old, orchestrator } = makeStore(stateDir);
    const actuator = makeActuator();
    old.begin(expectedId);
    const cutoverId = old.record()!.cutoverId;
    old.recordDrain(cutoverId, { activeSessions: 0, oldestAgeMs: 0 });
    old.requestRestart(cutoverId, { verifiedBy: "op", verifiedAt: new Date().toISOString() });

    const rehearsed = await orchestrator(old, { actuator }).advance({ dryRun: true });
    assert.equal(rehearsed.outcome, "restart_scheduled");
    assert.equal("dryRun" in rehearsed && rehearsed.dryRun, true);
    assert.equal(actuator.calls, 0);
    assert.equal(old.record()?.restartRequest?.restartScheduledAt, undefined);

    const enacted = await orchestrator(old, { actuator }).advance();
    assert.equal(enacted.outcome, "restart_scheduled");
    assert.equal(actuator.calls, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("advance blocks with CUTOVER_ACTUATOR_UNAVAILABLE and never re-schedules after actuator failure", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-orch-actuator-fail-"));
  try {
    const { old, orchestrator } = makeStore(stateDir);
    const actuator = makeActuator(true);
    old.begin(expectedId);
    const cutoverId = old.record()!.cutoverId;
    old.recordDrain(cutoverId, { activeSessions: 0, oldestAgeMs: 0 });
    old.requestRestart(cutoverId, { verifiedBy: "op", verifiedAt: new Date().toISOString() });

    const blocked = await orchestrator(old, { actuator }).advance();
    assert.equal(blocked.outcome, "blocked");
    assert.equal("code" in blocked && blocked.code, "CUTOVER_ACTUATOR_UNAVAILABLE");
    assert.equal(old.record()?.restartRequest?.restartScheduledAt !== undefined, true);

    const later = await orchestrator(old, { actuator }).advance();
    assert.equal(later.outcome, "restart_already_scheduled");
    assert.equal(actuator.calls, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("reconcile-only advance closes the cutover only on a fully positive witness", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-orch-reconcile-"));
  try {
    const { old, replacement, orchestrator } = makeStore(stateDir);
    old.begin(expectedId);
    const cutoverId = old.record()!.cutoverId;
    old.recordDrain(cutoverId, { activeSessions: 0, oldestAgeMs: 0 });
    old.requestRestart(cutoverId, { verifiedBy: "op", verifiedAt: new Date().toISOString() });
    old.markRestartScheduled(cutoverId);

    const bad = await orchestrator(replacement, {
      witness: async () => badWitness,
    }).advance();
    assert.equal(bad.outcome, "blocked");
    assert.equal(replacement.record()?.phase, "drained");

    const good = await orchestrator(replacement, {
      witness: async () => goodWitness,
    }).advance();
    assert.equal(good.outcome, "reconciled_and_finished");
    assert.equal(replacement.record()?.phase, "closed");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("reconcile-only advance fails closed on ambiguous restart and missing drain evidence", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-orch-reconcile-blocked-"));
  try {
    const { old, replacement, orchestrator } = makeStore(stateDir);
    old.begin(expectedId);
    const cutoverId = old.record()!.cutoverId;
    old.recordDrain(cutoverId, { activeSessions: 0, oldestAgeMs: 0 });
    old.requestRestart(cutoverId, { verifiedBy: "op", verifiedAt: new Date().toISOString() });

    const unscheduledRequest = await orchestrator(replacement).advance();
    assert.equal(unscheduledRequest.outcome, "blocked");
    assert.equal(unscheduledRequest.code, "CUTOVER_RECONCILIATION_REQUIRED");

    const beforeDrainDir = mkdtempSync(join(tmpdir(), "devspace-orch-reconcile-predrain-"));
    try {
      const begunOnOld = new McpCutoverController(new CutoverStateStore(beforeDrainDir), oldIdentity);
      begunOnOld.begin(expectedId);
      const onReplacement = new McpCutoverController(new CutoverStateStore(beforeDrainDir), newIdentity);
      const beforeDrain = await new CutoverOrchestrator({
        controller: onReplacement,
        actuator: makeActuator(),
        enumerateAll: async () => goodWitness,
      }).advance();
      assert.equal(beforeDrain.outcome, "blocked");
      assert.equal(beforeDrain.code, "CUTOVER_RECONCILIATION_REQUIRED");
    } finally {
      rmSync(beforeDrainDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("advance never establishes a recovery successor for a superseded terminal", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-orch-superseded-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-superseded" });
    new McpCutoverController(store, oldIdentity).begin(expectedId);
    store.recoverSupersede({
      cutoverId: "cutover-superseded",
      expectedNewIdentity: { sourceCommit: "source-target", buildId: "build-target" },
      observedIdentity: oldIdentity,
      recoveredBy: "seam",
    });
    // Simulate the crash window where the superseded terminal survives but the
    // successor write was lost: only the recovery seam may establish it.
    rmSync(join(stateDir, "cutover", "active", "successor-created.json"), { force: true });
    assert.equal(store.get()?.phase, "superseded");

    const actuator = makeActuator();
    const replacement = new McpCutoverController(store, newIdentity);
    const outcome = await new CutoverOrchestrator({
      controller: replacement,
      actuator,
      enumerateAll: async () => goodWitness,
    }).advance();
    assert.equal(outcome.outcome, "blocked");
    assert.equal("code" in outcome && outcome.code, "CUTOVER_RECONCILIATION_REQUIRED");
    assert.equal(actuator.calls, 0);
    assert.equal(store.get()?.phase, "superseded");
    assert.equal(store.get()?.supersedesCutoverId, undefined);
    assert.equal(store.supersededRecord()?.cutoverId, "cutover-superseded");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
for (const changeDuringProbe of [false, true]) {
  test(`orchestrator rejects bound generation ${changeDuringProbe ? "after probe" : "at entry"} without scheduling`, async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "devspace-orch-bound-"));
    try {
      const { old, orchestrator } = makeStore(stateDir);
      const actuator = makeActuator();
      const binding = { leaseId: "lease", pinnedLeaseVersion: 1, operationHandle: "operation", requestHash: "a".repeat(64), ownerThread: "owner" };
      old.begin(expectedId, undefined, changeDuringProbe ? undefined : binding);
      const id = old.record()!.cutoverId;
      old.recordDrain(id, { activeSessions: 0, oldestAgeMs: 0 });
      old.requestRestart(id, { verifiedBy: "op", verifiedAt: new Date().toISOString() });
      let probes = 0;
      const originalRecord = old.record.bind(old);
      const run = orchestrator(old, { actuator, probe: () => {
        probes++;
        old.record = () => ({ ...originalRecord()!, coordinationBinding: binding });
        return { buildReady: true, verifiedBy: "build-identity-file", verifiedAt: new Date().toISOString(), expectedSourceCommit: expectedId.sourceCommit, expectedBuildId: expectedId.buildId, detail: "fixture target verified" };
      } });
      await assert.rejects(run.advance(), /COORDINATION_REQUIRED/);
      assert.equal(probes, changeDuringProbe ? 1 : 0);
      assert.equal(actuator.calls, 0);
      assert.equal(originalRecord()?.restartRequest?.restartScheduledAt, undefined);
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
}

test("orchestrator rejects an unbound generation changed during probe without scheduling", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-orch-generation-"));
  try {
    const { old, orchestrator } = makeStore(stateDir);
    const actuator = makeActuator();
    old.begin(expectedId);
    const id = old.record()!.cutoverId;
    old.recordDrain(id, { activeSessions: 0, oldestAgeMs: 0 });
    old.requestRestart(id, { verifiedBy: "op", verifiedAt: new Date().toISOString() });
    const originalRecord = old.record.bind(old);
    const outcome = await orchestrator(old, { actuator, probe: () => {
      old.record = () => ({ ...originalRecord()!, cutoverId: "different-generation" });
      return { buildReady: true, verifiedBy: "build-identity-file", verifiedAt: new Date().toISOString(), expectedSourceCommit: expectedId.sourceCommit, expectedBuildId: expectedId.buildId, detail: "fixture target verified" };
    } }).advance();
    assert.equal(outcome.outcome, "blocked");
    assert.equal("code" in outcome && outcome.code, "CUTOVER_RECONCILIATION_REQUIRED");
    assert.equal(actuator.calls, 0);
    assert.equal(originalRecord()?.restartRequest?.restartScheduledAt, undefined);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
