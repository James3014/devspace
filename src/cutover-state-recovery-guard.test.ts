import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CutoverStateStore } from "./cutover-state.js";

const positiveWitness = {
  workspaceQueryable: true,
  agentQueryable: true,
  agentReconciled: true,
  witnessWorkspaceId: "workspace-1",
  witnessAgentId: "agent-1",
  witnessWorkspaceSessions: 1,
  witnessAgentSessions: 1,
  witnessKind: "exact-pair",
};

test("observed replacement recovery cannot erase a real drained cutover history", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-drain-preservation-"));
  try {
    const store = new CutoverStateStore(stateDir, {
      newId: () => "cutover-drained-history",
    });
    const expectedNewIdentity = {
      sourceCommit: "source-new",
      buildId: "build-new",
      capabilityManifestSha256: "manifest-new",
    };
    const created = store.begin({
      oldServerIdentity: {
        serverInstanceId: "server-old",
        sourceCommit: "source-old",
        buildId: "build-old",
        capabilityManifestSha256: "manifest-old",
      },
      expectedNewIdentity,
    });
    const drainEvidence = { activeSessions: 0, oldestAgeMs: 42 };
    store.recordDrain(created.cutoverId, drainEvidence);

    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: created.cutoverId,
        expectedNewIdentity,
        observedIdentity: {
          serverInstanceId: "server-new",
          ...expectedNewIdentity,
        },
        witness: positiveWitness,
        recoveredBy: "server-new",
      }),
      /requires prepared state without durable drain evidence/i,
    );

    const after = store.get();
    assert.equal(after?.phase, "drained");
    assert.deepEqual(after?.drainEvidence, drainEvidence);
    assert.equal(after?.observedReplacement, undefined);
    assert.equal(after?.reconciliationReceipt, undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("observed replacement recovery does not poison a later cutover generation", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-generation-local-recovery-"));
  try {
    let sequence = 0;
    const store = new CutoverStateStore(stateDir, {
      newId: () => `id-${sequence += 1}`,
    });

    const firstExpected = {
      sourceCommit: "source-one",
      buildId: "build-one",
      capabilityManifestSha256: "manifest-one",
    };
    const first = store.begin({
      oldServerIdentity: {
        serverInstanceId: "server-zero",
        sourceCommit: "source-zero",
        buildId: "build-zero",
      },
      expectedNewIdentity: firstExpected,
    });
    const firstRecovered = store.recoverObservedReplacement({
      cutoverId: first.cutoverId,
      expectedNewIdentity: firstExpected,
      observedIdentity: {
        serverInstanceId: "server-one",
        ...firstExpected,
      },
      witness: positiveWitness,
      recoveredBy: "server-one",
    });
    assert.equal(firstRecovered.record.phase, "closed");

    const secondExpected = {
      sourceCommit: "source-two",
      buildId: "build-two",
      capabilityManifestSha256: "manifest-two",
    };
    const second = store.begin({
      oldServerIdentity: {
        serverInstanceId: "server-one",
        ...firstExpected,
      },
      expectedNewIdentity: secondExpected,
    });
    const secondRecovered = store.recoverObservedReplacement({
      cutoverId: second.cutoverId,
      expectedNewIdentity: secondExpected,
      observedIdentity: {
        serverInstanceId: "server-two",
        ...secondExpected,
      },
      witness: positiveWitness,
      recoveredBy: "server-two",
    });

    assert.equal(secondRecovered.record.phase, "closed");
    assert.equal(secondRecovered.record.cutoverId, second.cutoverId);
    assert.equal(secondRecovered.record.observedReplacement?.expectedIdentity.sourceCommit, "source-two");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
