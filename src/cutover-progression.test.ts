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
import {
  McpCutoverController,
  type DurableReconciliationWitness,
  CUTOVER_SAFE_TOOLS,
} from "./mcp-cutover.js";
import {
  CutoverOrchestrator,
  type CutoverBlocker,
  type AdvanceOptions,
} from "./cutover-orchestration.js";
import type { BuildReadyProbeResult } from "./cutover-build-ready.js";
import type { SelfRestartActuator } from "./cutover-restart.js";

const oldIdentity: CutoverServerIdentity = {
  serverInstanceId: "server-gen-0",
  sourceCommit: "0".repeat(40),
  buildId: "devspace-1.0.7-00000000",
  capabilityManifestSha256: "a".repeat(64),
};

const targetIdentity: ExpectedCutoverIdentity = {
  sourceCommit: "1".repeat(40),
  buildId: "devspace-1.0.8-11111111",
  capabilityManifestSha256: "b".repeat(64),
};

const replacementIdentity: CutoverServerIdentity = {
  serverInstanceId: "server-gen-1",
  sourceCommit: "1".repeat(40),
  buildId: "devspace-1.0.8-11111111",
  capabilityManifestSha256: "b".repeat(64),
};

const mismatchedReplacementIdentity: CutoverServerIdentity = {
  serverInstanceId: "server-gen-mismatch",
  sourceCommit: "9".repeat(40),
  buildId: "devspace-1.0.8-99999999",
  capabilityManifestSha256: "b".repeat(64),
};

const positiveWitness: DurableReconciliationWitness = {
  workspaceQueryable: true,
  agentQueryable: true,
  agentReconciled: true,
};

function createMockActuator(fail = false): SelfRestartActuator & { scheduledCount: number } {
  const actuator = {
    scheduledCount: 0,
    actuator: "launchd-self" as const,
    serviceLabel: "com.example.devspace",
    launchdTarget: "gui/501/com.example.devspace",
    schedule: () => {
      actuator.scheduledCount += 1;
      if (fail) throw new Error("launchctl kickstart mock failure");
      return {
        scheduled: true,
        actuator: "launchd-self" as const,
        serviceLabel: "com.example.devspace",
        launchdTarget: "gui/501/com.example.devspace",
      };
    },
  };
  return actuator;
}

function createOrchestratorFixture(stateDir: string, options?: {
  actuatorFail?: boolean;
  probe?: (expected: ExpectedCutoverIdentity) => BuildReadyProbeResult;
  witness?: () => Promise<DurableReconciliationWitness>;
}) {
  const store = new CutoverStateStore(stateDir);
  const oldController = new McpCutoverController(store, oldIdentity);
  const replacementController = new McpCutoverController(store, replacementIdentity);
  const mismatchedController = new McpCutoverController(store, mismatchedReplacementIdentity);
  const actuator = createMockActuator(options?.actuatorFail ?? false);

  const makeOrch = (ctrl: McpCutoverController) => new CutoverOrchestrator({
    controller: ctrl,
    actuator,
    enumerateAll: options?.witness ?? (async () => positiveWitness),
    ...(options?.probe ? { probeBuildReady: options.probe } : {}),
  });

  return {
    store,
    oldController,
    replacementController,
    mismatchedController,
    actuator,
    oldOrch: makeOrch(oldController),
    replacementOrch: makeOrch(replacementController),
    mismatchedOrch: makeOrch(mismatchedController),
  };
}

// ---------------------------------------------------------------------------
// G0 & G2: Surface and Inventory Verification
// ---------------------------------------------------------------------------

test("devspace#263 G0/G2: cutover_advance is registered in CUTOVER_SAFE_TOOLS allowlist", () => {
  assert.equal(CUTOVER_SAFE_TOOLS.has("cutover_advance"), true);
  assert.equal(CUTOVER_SAFE_TOOLS.has("cutover_status"), true);
  assert.equal(CUTOVER_SAFE_TOOLS.has("capability_convergence_status"), true);
});

// ---------------------------------------------------------------------------
// G1 & G4: Full Controller Progression Canary
// ---------------------------------------------------------------------------

test("devspace#263 G4: end-to-end self-cutover progression canary (advance-driven)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-g4-"));
  try {
    const f = createOrchestratorFixture(stateDir);

    // Step 0: Initially no cutover active -> TERMINAL
    const initial = await f.oldOrch.advance();
    assert.equal(initial.status, "TERMINAL");
    assert.equal(initial.cutover_phase, "closed");
    assert.equal(initial.reconciliation_required, false);

    // Step 1: Controller starts cutover lease for approved target
    const started = f.oldController.begin(targetIdentity);
    assert.equal(started.phase, "prepared");

    // Step 2: cutover_advance derives AWAITING_EXTERNAL_DRAIN (never auto-drains)
    const step2 = await f.oldOrch.advance();
    assert.equal(step2.status, "BLOCKED");
    assert.equal(step2.blocker, "AWAITING_EXTERNAL_DRAIN");
    assert.equal(step2.cutover_phase, "prepared");
    assert.equal(step2.reconciliation_required, true);

    // Step 3: External drain executes and records evidence
    f.oldController.recordDrain(started.cutoverId, { activeSessions: 0, oldestAgeMs: 0 });

    // Step 4: cutover_advance derives AWAITING_RESTART_DECISION (requires build attestation)
    const step4 = await f.oldOrch.advance();
    assert.equal(step4.status, "BLOCKED");
    assert.equal(step4.blocker, "AWAITING_RESTART_DECISION");
    assert.equal(step4.cutover_phase, "drained");

    // Step 5: External restart decision is recorded with build-ready attestation
    f.oldController.requestRestart(started.cutoverId, {
      verifiedBy: "build-pipeline",
      verifiedAt: new Date().toISOString(),
    });

    // Step 6: cutover_advance marks restart and invokes actuator -> ADVANCED / AWAITING_RECONNECT
    const step6 = await f.oldOrch.advance();
    assert.equal(step6.status, "ADVANCED");
    assert.equal(step6.blocker, "AWAITING_RECONNECT");
    assert.equal(step6.cutover_phase, "drained");
    assert.equal(f.actuator.scheduledCount, 1);

    // Step 7: Repeated advance on old instance is idempotent and never re-schedules restart
    const step7 = await f.oldOrch.advance();
    assert.equal(step7.status, "BLOCKED");
    assert.equal(step7.blocker, "AWAITING_RECONNECT");
    assert.equal(f.actuator.scheduledCount, 1, "must never schedule duplicate restart");

    // Step 8: Client reconnects to replacement instance (reconcile-only mode)
    assert.equal(f.replacementController.mode(), "reconcile-only");
    const step8 = await f.replacementOrch.advance({
      callerContinuity: { caller: "reconnected-agent" },
    });
    assert.equal(step8.status, "TERMINAL");
    assert.equal(step8.cutover_phase, "closed");
    assert.equal(step8.reconciliation_required, false);
    assert.equal(f.replacementController.mode(), "normal");

    // Step 9: Post-close advance returns TERMINAL
    const final = await f.replacementOrch.advance();
    assert.equal(final.status, "TERMINAL");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G3: Hostile Regression Family
// ---------------------------------------------------------------------------

test("devspace#263 G3: #64 reconnect-before-drain yields AWAITING_EXTERNAL_DRAIN fail-closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-g3-64-"));
  try {
    const f = createOrchestratorFixture(stateDir);
    f.oldController.begin(targetIdentity);

    // Reconnected caller calls advance before drain is completed
    const res = await f.oldOrch.advance({ callerContinuity: { rebindId: "new-session" } });
    assert.equal(res.status, "BLOCKED");
    assert.equal(res.blocker, "AWAITING_EXTERNAL_DRAIN");
    assert.equal(res.reconciliation_required, true);
    assert.equal(f.actuator.scheduledCount, 0, "must not restart before drain");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("devspace#263 G3: restart observed before drain marker fails closed with RECONCILIATION_REQUIRED", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-g3-undrained-"));
  try {
    const f = createOrchestratorFixture(stateDir);
    f.oldController.begin(targetIdentity);

    // Server process was killed/restarted before drain was completed.
    // Replacement boots in reconcile-only mode without durable drain evidence.
    const res = await f.replacementOrch.advance();
    assert.equal(res.status, "BLOCKED");
    assert.equal(res.blocker, "RECONCILIATION_REQUIRED");
    assert.equal(res.code, "CUTOVER_RECONCILIATION_REQUIRED");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("devspace#263 G3: #230 DRAINED stale target / superseded target fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-g3-230-"));
  try {
    const f = createOrchestratorFixture(stateDir);
    const cutover = f.oldController.begin(targetIdentity);
    f.oldController.recordDrain(cutover.cutoverId, { activeSessions: 0, oldestAgeMs: 0 });

    // Target becomes stale and is superseded by a newer target
    const newerTarget: ExpectedCutoverIdentity = {
      sourceCommit: "2".repeat(40),
      buildId: "devspace-1.0.9-22222222",
      capabilityManifestSha256: "c".repeat(64),
    };
    f.mismatchedController.recoverCutover({
      cutoverId: cutover.cutoverId,
      expectedNewIdentity: newerTarget,
    });

    // Advance on superseded cutover must fail closed requiring reconciliation
    const res = await f.replacementOrch.advance();
    assert.equal(res.status, "BLOCKED");
    assert.equal(res.blocker, "RECONCILIATION_REQUIRED");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("devspace#263 G3: build-ready missing or probe failure blocks with BUILD_NOT_READY", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-g3-build-"));
  try {
    const f = createOrchestratorFixture(stateDir, {
      probe: () => ({ buildReady: false, detail: "disk binary missing" }),
    });
    const cutover = f.oldController.begin(targetIdentity);
    f.oldController.recordDrain(cutover.cutoverId, { activeSessions: 0, oldestAgeMs: 0 });

    // Case A: Missing attestation
    const noAttestation = await f.oldOrch.advance();
    assert.equal(noAttestation.status, "BLOCKED");
    assert.equal(noAttestation.blocker, "AWAITING_RESTART_DECISION");

    // Provide attestation but probe fails on disk
    f.oldController.requestRestart(cutover.cutoverId, {
      verifiedBy: "attester",
      verifiedAt: new Date().toISOString(),
    });
    const probeFailed = await f.oldOrch.advance();
    assert.equal(probeFailed.status, "BLOCKED");
    assert.equal(probeFailed.blocker, "BUILD_NOT_READY");
    assert.equal(probeFailed.code, "CUTOVER_BUILD_NOT_READY");
    assert.equal(f.actuator.scheduledCount, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("devspace#263 G3: replacement identity mismatch fails closed with RECONCILIATION_REQUIRED", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-g3-mismatch-"));
  try {
    const f = createOrchestratorFixture(stateDir);
    const cutover = f.oldController.begin(targetIdentity);
    f.oldController.recordDrain(cutover.cutoverId, { activeSessions: 0, oldestAgeMs: 0 });
    f.oldController.requestRestart(cutover.cutoverId, {
      verifiedBy: "attester",
      verifiedAt: new Date().toISOString(),
    });
    await f.oldOrch.advance();

    // Replacement boots with unexpected source/build
    const res = await f.mismatchedOrch.advance();
    assert.equal(res.status, "BLOCKED");
    assert.equal(res.blocker, "RECONCILIATION_REQUIRED");
    assert.equal(res.reconciliation_required, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("devspace#263 G3: actuator failure is durable and never retried blindly", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-g3-actuator-"));
  try {
    const f = createOrchestratorFixture(stateDir, { actuatorFail: true });
    const cutover = f.oldController.begin(targetIdentity);
    f.oldController.recordDrain(cutover.cutoverId, { activeSessions: 0, oldestAgeMs: 0 });
    f.oldController.requestRestart(cutover.cutoverId, {
      verifiedBy: "attester",
      verifiedAt: new Date().toISOString(),
    });

    const failed = await f.oldOrch.advance();
    assert.equal(failed.status, "BLOCKED");
    assert.equal(failed.blocker, "RECONCILIATION_REQUIRED");
    assert.equal(failed.code, "CUTOVER_ACTUATOR_UNAVAILABLE");

    // Second call never retries actuator
    const retry = await f.oldOrch.advance();
    assert.equal(retry.status, "BLOCKED");
    assert.equal(retry.blocker, "AWAITING_RECONNECT");
    assert.equal(f.actuator.scheduledCount, 1, "never schedules second launchctl call");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
