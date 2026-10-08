import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatSwarmError } from "./chat-swarm-contract.js";
import { ChatSwarmLifecycle } from "./chat-swarm-lifecycle.js";
import type { ChatSwarmCarrierAdapter } from "./chat-swarm-carrier.js";
import { DurableOperationStore } from "./durable-operations.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devspace-chat-swarm-lifecycle-"));
  const lifecycle = new ChatSwarmLifecycle({ stateDir: root });
  return { root, lifecycle };
}

function cleanup(f: ReturnType<typeof fixture>): void {
  f.lifecycle.close();
  rmSync(f.root, { recursive: true, force: true });
}

test("shares one coordinator and keeps startup recovery explicit", () => {
  const f = fixture();
  try {
    const owner = { "openai/session": "owner" };
    const workerMeta = { "openai/session": "worker" };
    const swarm = f.lifecycle.coordinator!.createSwarm(owner, { workerLimit: 1 });
    const worker = f.lifecycle.coordinator!.joinWorker(workerMeta, swarm.id, { label: "peer", runtimeKind: "mcp_peer" });
    const task = f.lifecycle.coordinator!.dispatch(owner, { swarmId: swarm.id, taskKey: "running", prompt: "p" });
    assert.equal(task.assignedWorkerId, worker.id);

    const second = new ChatSwarmLifecycle({ stateDir: f.root });
    try {
      assert.equal(second.store!.getTask(task.id)?.lifecycleState, "CLAIMED");
      assert.equal(second.recoverAfterStartup(), 1);
      assert.equal(f.lifecycle.store!.getTask(task.id)?.lifecycleState, "RECONCILE_REQUIRED");
    } finally {
      second.close();
    }
  } finally {
    cleanup(f);
  }
});

test("startup recovery normalizes continuation after generic durable-operation fencing", () => {
  const f = fixture();
  try {
    const owner = { "openai/session": "continuation-owner" };
    const source = { "openai/conversation_id": "continuation-source" };
    const target = { "openai/conversation_id": "continuation-target" };
    const swarm = f.lifecycle.coordinator!.createSwarm(owner, { workerLimit: 2 });
    const worker = f.lifecycle.coordinator!.joinWorker(source, swarm.id, {
      label: "peer",
      runtimeKind: "mcp_peer",
    });
    f.lifecycle.coordinator!.checkpoint(
      source,
      worker.id,
      0,
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      { summary: "safe checkpoint" },
    );
    const request = f.lifecycle.continuationCoordinator!.request(target, {
      swarmId: swarm.id,
      workerId: worker.id,
      attemptKey: "restart-fence",
      sourceEpoch: 0,
    }).request;
    assert.equal(request.status, "PENDING");
    assert.equal(request.version, 1);

    const genericDurableStore = new DurableOperationStore(f.root);
    try {
      assert.equal(genericDurableStore.markInterruptedUnknown(), 1);
    } finally {
      genericDurableStore.close();
    }
    const genericFenced = f.lifecycle.continuationStore!.getRequest(request.id)!;
    assert.equal(genericFenced.status, "RECONCILE_REQUIRED");
    assert.equal(genericFenced.version, 1);

    const second = new ChatSwarmLifecycle({ stateDir: f.root });
    try {
      assert.equal(second.recoverAfterStartup(), 0);
      const recovered = f.lifecycle.continuationStore!.getRequest(request.id)!;
      assert.equal(recovered.status, "RECONCILE_REQUIRED");
      assert.equal(recovered.version, 2);
      assert.equal(f.lifecycle.store!.getWorker(worker.id)!.continuationEpoch, 0);
      assert.equal(
        f.lifecycle.store!.getWorker(worker.id)!.carrierConversationFingerprint,
        worker.carrierConversationFingerprint,
      );
      assert.equal(second.continuationCoordinator!.recoverAfterRestart(), 0);
      assert.equal(f.lifecycle.continuationStore!.getRequest(request.id)!.version, 2);
    } finally {
      second.close();
    }
  } finally {
    cleanup(f);
  }
});

test("ChatSwarm admission is independent of deployment cutover state", () => {
  const f = fixture();
  try {
    for (const action of [
      "create",
      "join",
      "dispatch",
      "next",
      "submit",
      "status",
      "collect",
      "cancel",
      "reconcile",
      "close",
      "peer_status",
      "inspect",
      "tasks",
      "join_request",
      "approve_join",
      "continuation_request",
      "continuation_status",
      "continuation_approve",
      "continuation_reconcile",
    ] as const) {
      assert.doesNotThrow(() => f.lifecycle.admit(action));
    }
    assert.doesNotThrow(() => f.lifecycle.admit("next", { existingTask: true }));
    assert.doesNotThrow(() => f.lifecycle.admit("next", { existingTask: false }));
  } finally {
    cleanup(f);
  }
});

test("disabled lifecycle has no store and closes safely", () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-chat-swarm-disabled-"));
  const lifecycle = new ChatSwarmLifecycle({ stateDir: root, enabled: false });
  try {
    assert.equal(lifecycle.store, undefined);
    assert.equal(lifecycle.coordinator, undefined);
    assert.equal(lifecycle.continuationStore, undefined);
    assert.equal(lifecycle.continuationCoordinator, undefined);
    assert.throws(() => lifecycle.recoverAfterStartup(), ChatSwarmError);
    assert.throws(() => lifecycle.admit("status"), ChatSwarmError);
  } finally {
    lifecycle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("carrier effects require injected adapter, owner, and explicit startup recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-chat-swarm-carrier-lifecycle-"));
  const adapter: ChatSwarmCarrierAdapter = {
    kind: "fake",
    capabilities: () => ({
      boundedWait: "UNSUPPORTED",
      eventWake: "UNSUPPORTED",
      resultReadback: "UNSUPPORTED",
      durableReplay: "SUPPORTED",
    }),
    ensureExisting: async (input) => ({
      disposition: "READY",
      operationId: input.operationId,
      swarmId: input.swarmId,
      workerId: input.workerId,
      expectedEpoch: input.expectedEpoch,
      carrierKind: input.carrierKind,
      carrierFingerprint: input.carrierFingerprint,
      remoteMayContinue: false,
    }),
    wake: async (input) => ({
      disposition: "UNSUPPORTED",
      operationId: input.operationId,
      swarmId: input.swarmId,
      workerId: input.workerId,
      expectedEpoch: input.expectedEpoch,
      carrierKind: input.carrierKind,
      carrierFingerprint: input.carrierFingerprint,
      remoteMayContinue: false,
    }),
  };
  const lifecycle = new ChatSwarmLifecycle({
    stateDir: root,
    carrierAdapter: adapter,
  });
  const owner = { "openai/session": "owner" };
  try {
    const swarm = lifecycle.coordinator!.createSwarm(owner, { workerLimit: 1 });
    lifecycle.store!.createWorker({
      swarmId: swarm.id,
      label: "peer",
      runtimeKind: "mcp_peer",
      carrierConversationFingerprint: "a".repeat(64),
    });
    const status = lifecycle.carrierStatus(owner, swarm.id);
    assert.equal(status.workers.length, 1);
    assert.equal(lifecycle.recoverAfterStartup(), 0);
    const ensured = await lifecycle.ensureCarriers(owner, {
      swarmId: swarm.id,
      capacity: 1,
      adapterConfigHash: "b".repeat(64),
    });
    assert.equal(ensured.length, 1);
    assert.equal(ensured[0]?.state, "SUCCEEDED");
  } finally {
    lifecycle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
