import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CutoverStateStore } from "./cutover-state.js";

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
        witness: {
          workspaceQueryable: true,
          agentQueryable: true,
          agentReconciled: true,
          witnessWorkspaceId: "workspace-1",
          witnessAgentId: "agent-1",
          witnessWorkspaceSessions: 1,
          witnessAgentSessions: 1,
          witnessKind: "exact-pair",
        },
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
