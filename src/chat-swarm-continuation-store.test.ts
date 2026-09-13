import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatSwarmError } from "./chat-swarm-contract.js";
import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";
import { ChatSwarmStore } from "./chat-swarm-store.js";
import { ChatSwarmContinuationStore } from "./chat-swarm-continuation-store.js";
import { openDatabase } from "./db/client.js";
import { resolveChatSwarmIdentity } from "./request-meta.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "swarm-continuation-store-"));
  const swarmStore = new ChatSwarmStore(root);
  const coordinator = new ChatSwarmCoordinator(swarmStore);
  const ownerMeta = { "openai/session": "continuation-owner" };
  const sourceMeta = { "openai/conversation_id": "continuation-source" };
  const targetMeta = { "openai/conversation_id": "continuation-target" };
  const ownerFingerprint = resolveChatSwarmIdentity(ownerMeta).fingerprint;
  const targetFingerprint = resolveChatSwarmIdentity(targetMeta).fingerprint;
  const swarm = coordinator.createSwarm(ownerMeta, { workerLimit: 3, metadata: { test: true } });
  const worker = coordinator.joinWorker(sourceMeta, swarm.id, {
    label: "Worker-01",
    runtimeKind: "mcp_peer",
  });
  coordinator.checkpoint(
    sourceMeta,
    worker.id,
    0,
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    { lastTaskId: "task-safe", summary: "safe checkpoint" },
  );
  return {
    root,
    swarmStore,
    coordinator,
    ownerMeta,
    sourceMeta,
    targetMeta,
    ownerFingerprint,
    targetFingerprint,
    swarm,
    worker,
  };
}

function cleanup(f: ReturnType<typeof fixture>, continuation?: ChatSwarmContinuationStore) {
  continuation?.close();
  f.swarmStore.close();
  rmSync(f.root, { recursive: true, force: true });
}

function createInput(f: ReturnType<typeof fixture>, attemptKey = "continuation-attempt-1") {
  return {
    swarmId: f.swarm.id,
    workerId: f.worker.id,
    attemptKey,
    sourceEpoch: 0,
  };
}

test("durable continuation request replays exactly and changed material conflicts on the same attempt", () => {
  const f = fixture();
  const continuation = new ChatSwarmContinuationStore(f.root);
  try {
    const first = continuation.createRequest(f.targetFingerprint, createInput(f));
    assert.equal(first.created, true);
    assert.equal(first.request.status, "PENDING");
    assert.equal(first.request.version, 1);
    assert.equal(first.request.sourceEpoch, 0);
    assert.equal(first.request.targetEpoch, 1);
    assert.equal(first.request.ttlSeconds, 15 * 60);

    const replay = continuation.createRequest(f.targetFingerprint, createInput(f));
    assert.equal(replay.created, false);
    assert.equal(replay.request.id, first.request.id);
    assert.equal(replay.request.requestHash, first.request.requestHash);

    assert.throws(
      () => continuation.createRequest(f.targetFingerprint, {
        ...createInput(f),
        ttlSeconds: 1,
      }),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "REPLAY_CONFLICT",
    );

    const otherTarget = resolveChatSwarmIdentity({
      "openai/conversation_id": "continuation-target-other",
    }).fingerprint;
    assert.throws(
      () => continuation.createRequest(otherTarget, createInput(f)),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "REPLAY_CONFLICT",
    );

    const second = continuation.createRequest(
      otherTarget,
      createInput(f, "continuation-attempt-2"),
    );
    assert.equal(second.created, true);
    assert.notEqual(second.request.id, first.request.id);
    assert.equal(second.request.sourceEpoch, 0);
    assert.equal(second.request.targetEpoch, 1);
  } finally {
    cleanup(f, continuation);
  }
});

test("parallel prepared targets terminate losers as SUPERSEDED at winner commit", () => {
  const f = fixture();
  const continuation = new ChatSwarmContinuationStore(f.root);
  try {
    const targetA = f.targetFingerprint;
    const targetB = resolveChatSwarmIdentity({
      "openai/conversation_id": "continuation-target-b",
    }).fingerprint;
    const requestA = continuation.createRequest(targetA, createInput(f, "parallel-a")).request;
    const requestB = continuation.createRequest(targetB, createInput(f, "parallel-b")).request;

    const winner = continuation.approveRequest(f.ownerFingerprint, {
      swarmId: f.swarm.id,
      requestId: requestA.id,
      expectedRequestVersion: 1,
      expectedSwarmVersion: 1,
    });
    assert.equal(winner.status, "APPROVED");
    assert.equal(f.swarmStore.getWorker(f.worker.id)!.carrierConversationFingerprint, targetA);

    const loser = continuation.getRequest(requestB.id)!;
    assert.equal(loser.status, "SUPERSEDED");
    assert.equal(loser.version, 2);
    assert.throws(
      () => continuation.approveRequest(f.ownerFingerprint, {
        swarmId: f.swarm.id,
        requestId: requestB.id,
        expectedRequestVersion: 2,
        expectedSwarmVersion: 2,
      }),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "OWNERSHIP_CONFLICT",
    );

    assert.equal(continuation.recoverAfterRestart(), 0);
    assert.equal(continuation.getRequest(requestB.id)?.status, "SUPERSEDED");
    assert.equal(f.swarmStore.getWorker(f.worker.id)!.continuationEpoch, 1);
    assert.equal(f.swarmStore.getWorker(f.worker.id)!.carrierConversationFingerprint, targetA);
  } finally {
    cleanup(f, continuation);
  }
});

test("owner approval atomically transfers epoch and fences the old carrier", () => {
  const f = fixture();
  const continuation = new ChatSwarmContinuationStore(f.root);
  try {
    const created = continuation.createRequest(f.targetFingerprint, createInput(f));
    const approved = continuation.approveRequest(f.ownerFingerprint, {
      swarmId: f.swarm.id,
      requestId: created.request.id,
      expectedRequestVersion: 1,
      expectedSwarmVersion: 1,
    });
    assert.equal(approved.status, "APPROVED");
    assert.equal(approved.version, 2);
    assert.equal(approved.targetEpoch, 1);
    assert.ok(approved.approvedAt);

    const rebound = f.swarmStore.getWorker(f.worker.id)!;
    assert.equal(rebound.continuationEpoch, 1);
    assert.equal(rebound.carrierConversationFingerprint, f.targetFingerprint);
    assert.equal(f.coordinator.peerStatus(f.targetMeta, f.swarm.id).state, "BOUND");

    assert.throws(
      () => f.coordinator.nextTask(f.sourceMeta, f.worker.id),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "OWNERSHIP_CONFLICT",
    );

    const replay = continuation.approveRequest(f.ownerFingerprint, {
      swarmId: f.swarm.id,
      requestId: created.request.id,
      expectedRequestVersion: 1,
      expectedSwarmVersion: 1,
    });
    assert.equal(replay.status, "APPROVED");
    assert.equal(replay.version, 2);
    assert.equal(f.swarmStore.getSwarm(f.swarm.id)!.revision, 2);
  } finally {
    cleanup(f, continuation);
  }
});

test("checkpoint drift and active work fail closed before epoch transfer", () => {
  const f = fixture();
  const continuation = new ChatSwarmContinuationStore(f.root);
  try {
    const created = continuation.createRequest(f.targetFingerprint, createInput(f));
    f.coordinator.checkpoint(
      f.sourceMeta,
      f.worker.id,
      0,
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      { lastTaskId: "task-safe", summary: "changed checkpoint" },
    );
    assert.throws(
      () => continuation.approveRequest(f.ownerFingerprint, {
        swarmId: f.swarm.id,
        requestId: created.request.id,
        expectedRequestVersion: 1,
        expectedSwarmVersion: 1,
      }),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "CAS_DRIFT",
    );
  } finally {
    cleanup(f, continuation);
  }

  const busy = fixture();
  const continuationBusy = new ChatSwarmContinuationStore(busy.root);
  try {
    busy.coordinator.dispatch(busy.ownerMeta, {
      swarmId: busy.swarm.id,
      taskKey: "busy-task",
      prompt: "bounded read task",
      preferredWorkerId: busy.worker.id,
    });
    assert.throws(
      () => continuationBusy.createRequest(busy.targetFingerprint, createInput(busy)),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "RECONCILIATION_REQUIRED",
    );
  } finally {
    cleanup(busy, continuationBusy);
  }
});

test("restart marks pending continuation unknown and exact no-effect reconciliation restores same request", () => {
  const f = fixture();
  const continuation = new ChatSwarmContinuationStore(f.root);
  try {
    const created = continuation.createRequest(f.targetFingerprint, createInput(f));
    assert.equal(continuation.recoverAfterRestart(), 1);
    const unknown = continuation.getRequest(created.request.id)!;
    assert.equal(unknown.status, "RECONCILE_REQUIRED");
    assert.equal(unknown.version, 2);

    assert.throws(
      () => continuation.approveRequest(f.ownerFingerprint, {
        swarmId: f.swarm.id,
        requestId: created.request.id,
        expectedRequestVersion: 2,
        expectedSwarmVersion: 1,
      }),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "RECONCILIATION_REQUIRED",
    );

    const reconciled = continuation.reconcileUnknownNoEffect(f.ownerFingerprint, created.request.id);
    assert.equal(reconciled.status, "PENDING");
    assert.equal(reconciled.version, 3);
    assert.equal(reconciled.id, created.request.id);

    const approved = continuation.approveRequest(f.ownerFingerprint, {
      swarmId: f.swarm.id,
      requestId: created.request.id,
      expectedRequestVersion: 3,
      expectedSwarmVersion: 1,
    });
    assert.equal(approved.status, "APPROVED");
    assert.equal(approved.version, 4);
  } finally {
    cleanup(f, continuation);
  }
});

test("expired continuation cannot transfer and target readback remains bounded to exact target", () => {
  const f = fixture();
  let now = new Date("2026-09-13T05:00:00.000Z");
  const continuation = new ChatSwarmContinuationStore(f.root, () => now);
  try {
    const created = continuation.createRequest(f.targetFingerprint, {
      ...createInput(f),
      ttlSeconds: 1,
    });
    const targetRead = continuation.getLatestForTarget(f.swarm.id, f.targetFingerprint);
    assert.equal(targetRead?.id, created.request.id);

    const otherFingerprint = resolveChatSwarmIdentity({
      "openai/conversation_id": "not-the-target",
    }).fingerprint;
    assert.equal(continuation.getLatestForTarget(f.swarm.id, otherFingerprint), undefined);

    now = new Date("2026-09-13T05:00:02.000Z");
    assert.equal(continuation.getRequest(created.request.id)?.status, "EXPIRED");
    assert.throws(
      () => continuation.approveRequest(f.ownerFingerprint, {
        swarmId: f.swarm.id,
        requestId: created.request.id,
        expectedRequestVersion: 1,
        expectedSwarmVersion: 1,
      }),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "EXPIRED",
    );
    const expired = continuation.getRequest(created.request.id)!;
    assert.equal(expired.status, "EXPIRED");
    assert.equal(expired.version, 2);
    assert.equal(f.swarmStore.getWorker(f.worker.id)!.continuationEpoch, 0);
  } finally {
    cleanup(f, continuation);
  }
});

test("persisted continuation attempt identity tamper fails closed", () => {
  const f = fixture();
  const continuation = new ChatSwarmContinuationStore(f.root);
  try {
    const created = continuation.createRequest(f.targetFingerprint, createInput(f, "tamper-attempt"));
    const database = openDatabase(f.root);
    try {
      const row = database.sqlite.prepare(
        "select request_json from durable_operations where operation_id=?",
      ).get(created.request.id) as { request_json: string };
      const request = JSON.parse(row.request_json) as Record<string, unknown>;
      request.attemptKey = "tampered-attempt";
      database.sqlite.prepare(
        "update durable_operations set request_json=? where operation_id=?",
      ).run(JSON.stringify(request), created.request.id);
    } finally {
      database.close();
    }

    assert.throws(
      () => continuation.getRequest(created.request.id),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_STATE",
    );
  } finally {
    cleanup(f, continuation);
  }
});
