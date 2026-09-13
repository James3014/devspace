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

test("successful continuation permanently fences the retired source carrier", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-continuation-stale-carrier-"));
  const swarmStore = new ChatSwarmStore(root);
  const continuation = new ChatSwarmContinuationStore(root);
  const coordinator = new ChatSwarmCoordinator(swarmStore);
  const ownerMeta = { "openai/session": "continuation-owner" };
  const carrierAMeta = { "openai/conversation_id": "continuation-carrier-a" };
  const carrierBMeta = { "openai/conversation_id": "continuation-carrier-b" };
  const carrierA = resolveChatSwarmIdentity(carrierAMeta).fingerprint;
  const carrierB = resolveChatSwarmIdentity(carrierBMeta).fingerprint;
  const carrierC = resolveChatSwarmIdentity({ "openai/conversation_id": "continuation-carrier-c" }).fingerprint;
  const ownerFingerprint = resolveChatSwarmIdentity(ownerMeta).fingerprint;

  try {
    const swarm = coordinator.createSwarm(ownerMeta, { workerLimit: 2, metadata: { test: true } });
    const worker = coordinator.joinWorker(carrierAMeta, swarm.id, {
      label: "Worker-01",
      runtimeKind: "mcp_peer",
    });
    coordinator.checkpoint(
      carrierAMeta,
      worker.id,
      0,
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      { summary: "epoch zero checkpoint" },
    );

    const first = continuation.createRequest(carrierB, {
      swarmId: swarm.id,
      workerId: worker.id,
      attemptKey: "a-to-b",
      sourceEpoch: 0,
    });
    continuation.approveRequest(ownerFingerprint, {
      swarmId: swarm.id,
      requestId: first.request.id,
      expectedRequestVersion: 1,
      expectedSwarmVersion: 1,
    });
    assert.equal(swarmStore.getWorker(worker.id)?.carrierConversationFingerprint, carrierB);
    assert.equal(swarmStore.getWorker(worker.id)?.continuationEpoch, 1);

    coordinator.checkpoint(
      carrierBMeta,
      worker.id,
      1,
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      { summary: "epoch one checkpoint" },
    );

    assert.throws(
      () => continuation.createRequest(carrierA, {
        swarmId: swarm.id,
        workerId: worker.id,
        attemptKey: "b-back-to-retired-a",
        sourceEpoch: 1,
      }),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "OWNERSHIP_CONFLICT",
    );
    assert.equal(continuation.getLatestForTarget(swarm.id, carrierA), undefined);

    const fresh = continuation.createRequest(carrierC, {
      swarmId: swarm.id,
      workerId: worker.id,
      attemptKey: "b-to-fresh-c",
      sourceEpoch: 1,
    });
    assert.equal(fresh.created, true);
    assert.equal(fresh.request.targetCarrierFingerprint, carrierC);
  } finally {
    continuation.close();
    swarmStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});
