import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatSwarmError } from "./chat-swarm-contract.js";
import { ChatSwarmContinuationStore } from "./chat-swarm-continuation-store.js";
import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";
import { ChatSwarmStore } from "./chat-swarm-store.js";
import { resolveChatSwarmIdentity } from "./request-meta.js";

test("unresolved continuation fences any second replacement attempt", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-continuation-restart-fence-"));
  const swarmStore = new ChatSwarmStore(root);
  const continuation = new ChatSwarmContinuationStore(root);
  const coordinator = new ChatSwarmCoordinator(swarmStore);
  const ownerMeta = { "openai/session": "continuation-owner" };
  const sourceMeta = { "openai/conversation_id": "continuation-source" };
  const targetA = resolveChatSwarmIdentity({ "openai/conversation_id": "continuation-target-a" }).fingerprint;
  const targetB = resolveChatSwarmIdentity({ "openai/conversation_id": "continuation-target-b" }).fingerprint;
  const ownerFingerprint = resolveChatSwarmIdentity(ownerMeta).fingerprint;

  try {
    const swarm = coordinator.createSwarm(ownerMeta, { workerLimit: 2, metadata: { test: true } });
    const worker = coordinator.joinWorker(sourceMeta, swarm.id, {
      label: "Worker-01",
      runtimeKind: "mcp_peer",
    });
    coordinator.checkpoint(
      sourceMeta,
      worker.id,
      0,
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      { summary: "safe checkpoint" },
    );

    const first = continuation.createRequest(targetA, {
      swarmId: swarm.id,
      workerId: worker.id,
      attemptKey: "first-replacement",
      sourceEpoch: 0,
    });
    assert.equal(continuation.recoverAfterRestart(), 1);
    assert.equal(continuation.getRequest(first.request.id)?.status, "RECONCILE_REQUIRED");

    assert.throws(
      () => continuation.createRequest(targetB, {
        swarmId: swarm.id,
        workerId: worker.id,
        attemptKey: "second-replacement",
        sourceEpoch: 0,
      }),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "RECONCILIATION_REQUIRED",
    );
    assert.equal(continuation.getLatestForTarget(swarm.id, targetB), undefined);
    assert.equal(swarmStore.getWorker(worker.id)?.continuationEpoch, 0);
    assert.notEqual(swarmStore.getWorker(worker.id)?.carrierConversationFingerprint, targetB);

    const reconciled = continuation.reconcileUnknownNoEffect(ownerFingerprint, first.request.id);
    assert.equal(reconciled.status, "PENDING");

    const second = continuation.createRequest(targetB, {
      swarmId: swarm.id,
      workerId: worker.id,
      attemptKey: "second-replacement",
      sourceEpoch: 0,
    });
    assert.equal(second.created, true);
    assert.equal(second.request.status, "PENDING");
  } finally {
    continuation.close();
    swarmStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});
