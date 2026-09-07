import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { performCutoverRecovery } from "./cutover-recovery.js";
import { CutoverStateStore, type CutoverServerIdentity, type ExpectedCutoverIdentity } from "./cutover-state.js";
import type { BuildReadyProbeResult } from "./cutover-build-ready.js";

const staleIdentity: CutoverServerIdentity = {
  serverInstanceId: "stale-old-owner",
  sourceCommit: "stale-source",
  buildId: "stale-build",
  capabilityManifestSha256: "cap-shared",
};
const targetIdentity: CutoverServerIdentity = {
  serverInstanceId: "target-server",
  sourceCommit: "target-source",
  buildId: "target-build",
  capabilityManifestSha256: "cap-shared",
};
const expectedTarget: ExpectedCutoverIdentity = {
  sourceCommit: "target-source",
  buildId: "target-build",
  capabilityManifestSha256: "cap-shared",
};
const goodProbe = (): BuildReadyProbeResult => ({
  buildReady: true,
  verifiedBy: "build-identity-file",
  verifiedAt: new Date().toISOString(),
  expectedSourceCommit: expectedTarget.sourceCommit,
  expectedBuildId: expectedTarget.buildId,
  actualSourceCommit: expectedTarget.sourceCommit,
  actualBuildId: expectedTarget.buildId,
  detail: "installed build identity matches the bound recovery target",
});

function makeStateDir(): { stateDir: string; store: CutoverStateStore } {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-seam-"));
  const store = new CutoverStateStore(stateDir, {
    newId: (() => { let n = 0; return () => `cutover-${n += 1}`; })(),
  });
  store.begin({
    oldServerIdentity: staleIdentity,
    expectedNewIdentity: { sourceCommit: "stale-target", buildId: "stale-target-build" },
  });
  return { stateDir, store };
}

test("seam performs a durable probe-gated recovery with successor drain and restart scheduling", () => {
  const { stateDir, store } = makeStateDir();
  try {
    const result = performCutoverRecovery({
      store,
      requesterIdentity: targetIdentity,
      cutoverId: "cutover-1",
      expectedNewIdentity: expectedTarget,
      drainEvidence: { activeSessions: 5, oldestAgeMs: 211_548_160 },
      buildReadyProbe: goodProbe,
    });

    assert.equal(result.newlyRecovered, true);
    assert.equal(result.terminal.phase, "superseded");
    assert.equal(result.terminal.supersession?.observedIdentity.serverInstanceId, "target-server");
    assert.equal(result.successor.supersedesCutoverId, "cutover-1");
    assert.equal(result.successor.phase, "prepared");
    assert.deepEqual(result.drainRecord.drainEvidence, { activeSessions: 5, oldestAgeMs: 211_548_160 });
    assert.equal(result.drainRecord.phase, "drained");
    assert.equal(result.restartRequested, true);
    assert.equal(result.restartScheduled, true);
    assert.equal(result.buildReadyVerifiedBy, "build-identity-file");

    const replayed = new CutoverStateStore(stateDir).get();
    assert.equal(replayed?.phase, "drained");
    assert.equal(replayed?.supersedesCutoverId, "cutover-1");
    assert.equal(replayed?.restartRequest?.buildReady?.verifiedBy, "build-identity-file");
    assert.equal(replayed?.restartRequest?.restartScheduledForServerInstanceId, "target-server");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("seam rerun is idempotent and refuses a changed target", () => {
  const { stateDir, store } = makeStateDir();
  try {
    const first = performCutoverRecovery({
      store,
      requesterIdentity: targetIdentity,
      cutoverId: "cutover-1",
      expectedNewIdentity: expectedTarget,
      drainEvidence: { activeSessions: 2, oldestAgeMs: 10_000 },
      buildReadyProbe: goodProbe,
    });
    const second = performCutoverRecovery({
      store,
      requesterIdentity: targetIdentity,
      cutoverId: "cutover-1",
      expectedNewIdentity: expectedTarget,
      drainEvidence: { activeSessions: 2, oldestAgeMs: 10_000 },
      buildReadyProbe: goodProbe,
    });
    assert.equal(second.newlyRecovered, false);
    assert.equal(second.successor.cutoverId, first.successor.cutoverId);
    assert.equal(second.restartScheduled, false);

    assert.throws(
      () => performCutoverRecovery({
        store,
        requesterIdentity: targetIdentity,
        cutoverId: "cutover-1",
        expectedNewIdentity: { sourceCommit: "different-source", buildId: "target-build" },
        drainEvidence: { activeSessions: 2, oldestAgeMs: 10_000 },
        buildReadyProbe: goodProbe,
      }),
      /RECOVERY_BINDING_MISMATCH/i,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("seam fails closed without either a probe or an operator attestation", () => {
  const { stateDir, store } = makeStateDir();
  try {
    assert.throws(
      () => performCutoverRecovery({
        store,
        requesterIdentity: targetIdentity,
        cutoverId: "cutover-1",
        expectedNewIdentity: expectedTarget,
        drainEvidence: { activeSessions: 0, oldestAgeMs: 0 },
      }),
      /requires either a physical build-ready probe or an operator build-ready attestation/i,
    );
    assert.equal(new CutoverStateStore(stateDir).get()?.phase, "prepared");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("seam fails closed on a negative build-ready probe with no mutation", () => {
  const { stateDir, store } = makeStateDir();
  try {
    const badProbe = (): BuildReadyProbeResult => ({
      buildReady: false,
      verifiedBy: "build-identity-file",
      verifiedAt: new Date().toISOString(),
      expectedSourceCommit: expectedTarget.sourceCommit,
      expectedBuildId: expectedTarget.buildId,
      actualSourceCommit: "wrong-source",
      actualBuildId: "wrong-build",
      detail: "installed build identity does not match the bound recovery target",
    });
    assert.throws(
      () => performCutoverRecovery({
        store,
        requesterIdentity: targetIdentity,
        cutoverId: "cutover-1",
        expectedNewIdentity: expectedTarget,
        drainEvidence: { activeSessions: 0, oldestAgeMs: 0 },
        buildReadyProbe: badProbe,
      }),
      /CUTOVER_BUILD_NOT_READY/i,
    );
    assert.equal(new CutoverStateStore(stateDir).get()?.phase, "prepared");
    assert.equal(new CutoverStateStore(stateDir).supersededRecord(), undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("seam accepts an operator build-ready attestation when no probe root is configured", () => {
  const { stateDir, store } = makeStateDir();
  try {
    const result = performCutoverRecovery({
      store,
      requesterIdentity: targetIdentity,
      cutoverId: "cutover-1",
      expectedNewIdentity: expectedTarget,
      drainEvidence: { activeSessions: 3, oldestAgeMs: 40_000 },
      buildReadyAttestation: {
        verifiedBy: "verified-accepted-build-install",
        evidence: "installed FINAL_ACCEPTED_BUILD matches the recovery binding",
      },
    });
    assert.equal(result.buildReadyVerifiedBy, "verified-accepted-build-install");
    const replayed = new CutoverStateStore(stateDir).get();
    assert.equal(replayed?.phase, "drained");
    assert.equal(replayed?.restartRequest?.buildReady?.verifiedBy, "verified-accepted-build-install");
    assert.equal(replayed?.restartRequest?.buildReady?.evidence?.includes("FINAL_ACCEPTED_BUILD"), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});