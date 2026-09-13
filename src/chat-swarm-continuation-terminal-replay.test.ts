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

function fixture(clock?: () => Date) {
  const root = mkdtempSync(join(tmpdir(), "swarm-continuation-terminal-replay-"));
  const swarmStore = new ChatSwarmStore(root);
  const continuation = new ChatSwarmContinuationStore(root, clock);
  const coordinator = new ChatSwarmCoordinator(swarmStore);
  const ownerMeta = { "openai/session": "continuation-owner" };
  const sourceMeta = { "openai/conversation_id": "continuation-source" };
  const targetA = resolveChatSwarmIdentity({ "openai/conversation_id": "continuation-target-a" }).fingerprint;
  const targetB = resolveChatSwarmIdentity({ "openai/conversation_id": "continuation-target-b" }).fingerprint;
  const ownerFingerprint = resolveChatSwarmIdentity(ownerMeta).fingerprint;
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
  return { root, swarmStore, continuation, coordinator, ownerFingerprint, swarm, worker, targetA, targetB };
}

function cleanup(f: ReturnType<typeof fixture>) {
  f.continuation.close();
  f.swarmStore.close();
  rmSync(f.root, { recursive: true, force: true });
}

test("approved continuation exact replay returns the same durable result after epoch advances", () => {
  const f = fixture();
  try {
    const input = {
      swarmId: f.swarm.id,
      workerId: f.worker.id,
      attemptKey: "approved-replay",
      sourceEpoch: 0,
    };
    const created = f.continuation.createRequest(f.targetA, input);
    const approved = f.continuation.approveRequest(f.ownerFingerprint, {
      swarmId: f.swarm.id,
      requestId: created.request.id,
      expectedRequestVersion: 1,
      expectedSwarmVersion: 1,
    });
    assert.equal(approved.status, "APPROVED");

    const replay = f.continuation.createRequest(f.targetA, input);
    assert.equal(replay.created, false);
    assert.equal(replay.request.id, created.request.id);
    assert.equal(replay.request.status, "APPROVED");
    assert.equal(replay.request.version, approved.version);

    assert.throws(
      () => f.continuation.createRequest(f.targetA, { ...input, ttlSeconds: 1 }),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "REPLAY_CONFLICT",
    );
  } finally {
    cleanup(f);
  }
});

test("superseded continuation exact replay returns the same terminal loser", () => {
  const f = fixture();
  try {
    const inputA = {
      swarmId: f.swarm.id,
      workerId: f.worker.id,
      attemptKey: "winner-replay",
      sourceEpoch: 0,
    };
    const inputB = {
      swarmId: f.swarm.id,
      workerId: f.worker.id,
      attemptKey: "loser-replay",
      sourceEpoch: 0,
    };
    const winner = f.continuation.createRequest(f.targetA, inputA).request;
    const loser = f.continuation.createRequest(f.targetB, inputB).request;
    f.continuation.approveRequest(f.ownerFingerprint, {
      swarmId: f.swarm.id,
      requestId: winner.id,
      expectedRequestVersion: 1,
      expectedSwarmVersion: 1,
    });
    assert.equal(f.continuation.getRequest(loser.id)?.status, "SUPERSEDED");

    const replay = f.continuation.createRequest(f.targetB, inputB);
    assert.equal(replay.created, false);
    assert.equal(replay.request.id, loser.id);
    assert.equal(replay.request.status, "SUPERSEDED");
  } finally {
    cleanup(f);
  }
});

test("expired exact replay durably persists terminal expiry", () => {
  let now = new Date("2026-09-13T06:00:00.000Z");
  const f = fixture(() => now);
  try {
    const input = {
      swarmId: f.swarm.id,
      workerId: f.worker.id,
      attemptKey: "expired-replay",
      sourceEpoch: 0,
      ttlSeconds: 1,
    };
    const created = f.continuation.createRequest(f.targetA, input);
    now = new Date("2026-09-13T06:00:02.000Z");

    const replay = f.continuation.createRequest(f.targetA, input);
    assert.equal(replay.created, false);
    assert.equal(replay.request.id, created.request.id);
    assert.equal(replay.request.status, "EXPIRED");
    assert.equal(replay.request.version, 2);
    assert.equal(f.continuation.getRequest(created.request.id)?.status, "EXPIRED");
    assert.equal(f.continuation.recoverAfterRestart(), 0);
  } finally {
    cleanup(f);
  }
});
