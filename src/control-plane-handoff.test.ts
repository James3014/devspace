import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ControlPlaneHandoff } from "./control-plane-handoff.js";
import { ControlPlaneOwnershipStore } from "./control-plane-ownership.js";

test("handoff facade delegates the atomic ownership transfer contract", () => {
  const db = new Database(":memory:");
  const options = { resolveOwnerContext: (value: unknown) => ({ ownerThread: String(value) }), verifyGrantEvidence: () => true };
  const store = new ControlPlaneOwnershipStore(db, options);
  db.prepare("insert into control_plane_grant_evidence(repository,goal,coordinator_thread,evidence_hash,version,updated_at) values(?,?,?,?,?,?)").run("owner/repo", "goal", "coord", "evidence", 1, new Date().toISOString());
  const lease = store.acquire("from", { repositoryKey: "owner/repo", resourceKind: "checkout", resourceId: "main", resource: "checkout", operation: "write", scope: ["/repo"], baseRevision: "sha", expiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: "handoff", grant: { repository: "owner/repo", goal: "goal", coordinatorThread: "coord", evidenceHash: "evidence" } });
  const receipt = new ControlPlaneHandoff(store).transfer("from", lease.leaseId, 1, "to", { resource: "checkout", candidateRevision: "sha2", liveOperation: "op", liveHandle: "handle", forbiddenOverlap: ["/repo"], tests: ["test"], evidence: ["evidence"], remainingGap: "none", nextGate: "gate", expiresAt: lease.expiresAt });
  assert.equal(receipt.fromOwnerThread, "from");
  assert.equal(receipt.toOwnerThread, "to");
  db.close();
});
