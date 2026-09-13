import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatSwarmError } from "./chat-swarm-contract.js";
import { ChatSwarmContinuationStore } from "./chat-swarm-continuation-store.js";
import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";
import { ChatSwarmStore } from "./chat-swarm-store.js";
import { openDatabase } from "./db/client.js";
import { resolveChatSwarmIdentity } from "./request-meta.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "swarm-continuation-corruption-fence-"));
  const swarmStore = new ChatSwarmStore(root);
  const continuation = new ChatSwarmContinuationStore(root);
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
  return {
    root,
    swarmStore,
    continuation,
    coordinator,
    ownerMeta,
    sourceMeta,
    targetA,
    targetB,
    ownerFingerprint,
    swarm,
    worker,
  };
}

function cleanup(f: ReturnType<typeof fixture>): void {
  f.continuation.close();
  f.swarmStore.close();
  rmSync(f.root, { recursive: true, force: true });
}

function createRequest(f: ReturnType<typeof fixture>, attemptKey: string, target = f.targetA) {
  return f.continuation.createRequest(target, {
    swarmId: f.swarm.id,
    workerId: f.worker.id,
    attemptKey,
    sourceEpoch: 0,
  });
}

test("corrupt pending continuation identity fences all new continuation work", () => {
  const f = fixture();
  try {
    const first = createRequest(f, "original-attempt");

    const database = openDatabase(f.root);
    try {
      const row = database.sqlite.prepare(
        "select request_json from durable_operations where operation_id=?",
      ).get(first.request.id) as { request_json: string };
      const request = JSON.parse(row.request_json) as Record<string, unknown>;
      request.attemptKey = "tampered-attempt";
      database.sqlite.prepare(
        "update durable_operations set request_json=? where operation_id=?",
      ).run(JSON.stringify(request), first.request.id);
    } finally {
      database.close();
    }

    assert.throws(
      () => createRequest(f, "new-attempt-must-not-bypass-corruption", f.targetB),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_STATE",
    );
    assert.throws(
      () => f.continuation.getLatestForTarget(f.swarm.id, f.targetB),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_STATE",
    );
    assert.equal(f.swarmStore.getWorker(f.worker.id)?.continuationEpoch, 0);
  } finally {
    cleanup(f);
  }
});

test("succeeded continuation without approval receipt fails closed", () => {
  const f = fixture();
  try {
    const created = createRequest(f, "approved-with-receipt");
    const approved = f.continuation.approveRequest(f.ownerFingerprint, {
      swarmId: f.swarm.id,
      requestId: created.request.id,
      expectedRequestVersion: 1,
      expectedSwarmVersion: 1,
    });
    assert.equal(approved.status, "APPROVED");

    const database = openDatabase(f.root);
    try {
      database.sqlite.prepare(
        "update durable_operations set receipt_json=null where operation_id=?",
      ).run(created.request.id);
    } finally {
      database.close();
    }

    assert.throws(
      () => f.continuation.getRequest(created.request.id),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_STATE",
    );
  } finally {
    cleanup(f);
  }
});

test("pending continuation with forged approval receipt fails closed", () => {
  const f = fixture();
  try {
    const created = createRequest(f, "pending-forged-receipt");
    const database = openDatabase(f.root);
    try {
      database.sqlite.prepare(
        "update durable_operations set receipt_json=? where operation_id=?",
      ).run(JSON.stringify({ schema: "forged" }), created.request.id);
    } finally {
      database.close();
    }

    assert.throws(
      () => f.continuation.getRequest(created.request.id),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_STATE",
    );
    assert.throws(
      () => createRequest(f, "pending-forged-receipt-new", f.targetB),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_STATE",
    );
  } finally {
    cleanup(f);
  }
});

test("outcome-unknown continuation with wrong reconciliation code fails closed", () => {
  const f = fixture();
  try {
    const created = createRequest(f, "unknown-wrong-error-code");
    assert.equal(f.continuation.recoverAfterRestart(), 1);

    const database = openDatabase(f.root);
    try {
      database.sqlite.prepare(
        "update durable_operations set error_code='WRONG_CODE' where operation_id=?",
      ).run(created.request.id);
    } finally {
      database.close();
    }

    assert.throws(
      () => f.continuation.getRequest(created.request.id),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_STATE",
    );
  } finally {
    cleanup(f);
  }
});
