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

test("corrupt pending continuation identity fences all new continuation work", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-continuation-corruption-fence-"));
  const swarmStore = new ChatSwarmStore(root);
  const continuation = new ChatSwarmContinuationStore(root);
  const coordinator = new ChatSwarmCoordinator(swarmStore);
  const ownerMeta = { "openai/session": "continuation-owner" };
  const sourceMeta = { "openai/conversation_id": "continuation-source" };
  const targetA = resolveChatSwarmIdentity({ "openai/conversation_id": "continuation-target-a" }).fingerprint;
  const targetB = resolveChatSwarmIdentity({ "openai/conversation_id": "continuation-target-b" }).fingerprint;

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
      attemptKey: "original-attempt",
      sourceEpoch: 0,
    });

    const database = openDatabase(root);
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
      () => continuation.createRequest(targetB, {
        swarmId: swarm.id,
        workerId: worker.id,
        attemptKey: "new-attempt-must-not-bypass-corruption",
        sourceEpoch: 0,
      }),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_STATE",
    );
    assert.throws(
      () => continuation.getLatestForTarget(swarm.id, targetB),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_STATE",
    );
    assert.equal(swarmStore.getWorker(worker.id)?.continuationEpoch, 0);
  } finally {
    continuation.close();
    swarmStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});
