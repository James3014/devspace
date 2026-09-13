import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatSwarmError } from "./chat-swarm-contract.js";
import { ChatSwarmContinuationCoordinator } from "./chat-swarm-continuation-coordinator.js";
import { ChatSwarmContinuationStore } from "./chat-swarm-continuation-store.js";
import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";
import { ChatSwarmStore } from "./chat-swarm-store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "swarm-continuation-coordinator-"));
  const swarmStore = new ChatSwarmStore(root);
  const swarmCoordinator = new ChatSwarmCoordinator(swarmStore);
  const continuationStore = new ChatSwarmContinuationStore(root);
  const continuation = new ChatSwarmContinuationCoordinator(continuationStore, swarmCoordinator);
  const ownerMeta = { "openai/session": "continuation-owner" };
  const attackerMeta = { "openai/session": "continuation-attacker" };
  const sourceMeta = { "openai/conversation_id": "continuation-source" };
  const targetMeta = { "openai/conversation_id": "continuation-target" };
  const otherTargetMeta = { "openai/conversation_id": "continuation-other-target" };
  const swarm = swarmCoordinator.createSwarm(ownerMeta, { workerLimit: 3, metadata: { test: true } });
  const worker = swarmCoordinator.joinWorker(sourceMeta, swarm.id, {
    label: "Worker-01",
    runtimeKind: "mcp_peer",
  });
  swarmCoordinator.checkpoint(
    sourceMeta,
    worker.id,
    0,
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    { summary: "safe checkpoint" },
  );
  return {
    root,
    swarmStore,
    continuationStore,
    continuation,
    ownerMeta,
    attackerMeta,
    sourceMeta,
    targetMeta,
    otherTargetMeta,
    swarm,
    worker,
  };
}

function cleanup(f: ReturnType<typeof fixture>) {
  f.continuationStore.close();
  f.swarmStore.close();
  rmSync(f.root, { recursive: true, force: true });
}

test("target request identity comes from authenticated metadata and exact target can read it", () => {
  const f = fixture();
  try {
    const created = f.continuation.request(f.targetMeta, {
      swarmId: f.swarm.id,
      workerId: f.worker.id,
      attemptKey: "target-bound-1",
      sourceEpoch: 0,
    });
    assert.equal(created.created, true);
    assert.equal(f.continuation.targetStatus(f.targetMeta, f.swarm.id)?.id, created.request.id);
    assert.equal(f.continuation.targetStatus(f.otherTargetMeta, f.swarm.id), undefined);

    assert.throws(
      () => f.continuation.request(f.sourceMeta, {
        swarmId: f.swarm.id,
        workerId: f.worker.id,
        attemptKey: "source-cannot-replace-itself",
        sourceEpoch: 0,
      }),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_INPUT",
    );
  } finally {
    cleanup(f);
  }
});

test("only exact owner may approve, including idempotent approved readback", () => {
  const f = fixture();
  try {
    const created = f.continuation.request(f.targetMeta, {
      swarmId: f.swarm.id,
      workerId: f.worker.id,
      attemptKey: "owner-bound-1",
      sourceEpoch: 0,
    });

    assert.throws(
      () => f.continuation.approve(f.attackerMeta, {
        swarmId: f.swarm.id,
        requestId: created.request.id,
        expectedRequestVersion: 1,
        expectedSwarmVersion: 1,
      }),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "OWNERSHIP_CONFLICT",
    );

    const approved = f.continuation.approve(f.ownerMeta, {
      swarmId: f.swarm.id,
      requestId: created.request.id,
      expectedRequestVersion: 1,
      expectedSwarmVersion: 1,
    });
    assert.equal(approved.status, "APPROVED");

    assert.throws(
      () => f.continuation.approve(f.attackerMeta, {
        swarmId: f.swarm.id,
        requestId: created.request.id,
        expectedRequestVersion: 1,
        expectedSwarmVersion: 1,
      }),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "OWNERSHIP_CONFLICT",
    );
  } finally {
    cleanup(f);
  }
});
