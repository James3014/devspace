import assert from "node:assert/strict";
import test from "node:test";
import { ChatSwarmError } from "./chat-swarm-contract.js";
import {
  assertContinuationCommitAllowed,
  prepareContinuationMaterial,
  type WorkerContinuationSnapshot,
} from "./chat-swarm-continuation-domain.js";
import type { ChatSwarmContinuationRequest } from "./chat-swarm-continuation-contract.js";

const source = "a".repeat(64);
const target = "b".repeat(64);

function worker(overrides: Partial<WorkerContinuationSnapshot> = {}): WorkerContinuationSnapshot {
  return {
    swarmId: "swarm-1",
    workerId: "worker-1",
    lifecycleState: "AVAILABLE",
    continuationEpoch: 4,
    carrierConversationFingerprint: source,
    checkpoint: { lastTaskId: "task-9", summary: "safe boundary" },
    ...overrides,
  };
}

function request(overrides: Partial<ChatSwarmContinuationRequest> = {}): ChatSwarmContinuationRequest {
  const material = prepareContinuationMaterial(worker(), {
    swarmId: "swarm-1",
    workerId: "worker-1",
    attemptKey: "cont-1",
    sourceEpoch: 4,
    targetCarrierFingerprint: target,
  });
  return {
    id: "contreq-1",
    swarmId: "swarm-1",
    workerId: "worker-1",
    attemptKey: "cont-1",
    requestHash: material.requestHash,
    sourceEpoch: material.sourceEpoch,
    targetEpoch: material.targetEpoch,
    sourceCarrierFingerprint: material.sourceCarrierFingerprint,
    targetCarrierFingerprint: material.targetCarrierFingerprint,
    checkpointHash: material.checkpointHash,
    version: 1,
    status: "PENDING",
    requestedAt: "2026-09-13T00:00:00.000Z",
    expiresAt: "2026-09-13T00:15:00.000Z",
    ...overrides,
  };
}

test("prepare binds exact epoch, carriers and checkpoint", () => {
  const material = prepareContinuationMaterial(worker(), {
    swarmId: "swarm-1",
    workerId: "worker-1",
    attemptKey: "cont-1",
    sourceEpoch: 4,
    targetCarrierFingerprint: target,
  });
  assert.equal(material.sourceEpoch, 4);
  assert.equal(material.targetEpoch, 5);
  assert.equal(material.sourceCarrierFingerprint, source);
  assert.equal(material.targetCarrierFingerprint, target);
  assert.match(material.checkpointHash, /^[0-9a-f]{64}$/);
  assert.match(material.requestHash, /^[0-9a-f]{64}$/);
});

test("prepare rejects unsafe active worker and stale epoch", () => {
  assert.throws(
    () => prepareContinuationMaterial(worker({ lifecycleState: "BUSY", currentTaskId: "task-live" }), {
      swarmId: "swarm-1",
      workerId: "worker-1",
      attemptKey: "cont-2",
      sourceEpoch: 4,
      targetCarrierFingerprint: target,
    }),
    (error: unknown) => error instanceof ChatSwarmError && error.code === "RECONCILIATION_REQUIRED",
  );

  assert.throws(
    () => prepareContinuationMaterial(worker(), {
      swarmId: "swarm-1",
      workerId: "worker-1",
      attemptKey: "cont-3",
      sourceEpoch: 3,
      targetCarrierFingerprint: target,
    }),
    (error: unknown) => error instanceof ChatSwarmError && error.code === "OWNERSHIP_CONFLICT",
  );
});

test("commit guard rejects changed source carrier and checkpoint", () => {
  const prepared = request();
  assert.doesNotThrow(() => assertContinuationCommitAllowed(worker(), prepared));

  assert.throws(
    () => assertContinuationCommitAllowed(worker({ carrierConversationFingerprint: "c".repeat(64) }), prepared),
    (error: unknown) => error instanceof ChatSwarmError && error.code === "CAS_DRIFT",
  );

  assert.throws(
    () => assertContinuationCommitAllowed(worker({ checkpoint: { summary: "changed" } }), prepared),
    (error: unknown) => error instanceof ChatSwarmError && error.code === "CAS_DRIFT",
  );
});

test("commit guard rejects malformed target epoch and non-pending request", () => {
  assert.throws(
    () => assertContinuationCommitAllowed(worker(), request({ targetEpoch: 7 })),
    (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_STATE",
  );

  assert.throws(
    () => assertContinuationCommitAllowed(worker(), request({ status: "APPROVED" })),
    (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_STATE",
  );
});
