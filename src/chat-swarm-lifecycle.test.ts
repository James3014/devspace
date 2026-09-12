import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatSwarmError } from "./chat-swarm-contract.js";
import { ChatSwarmLifecycle, type ChatSwarmLifecycleMode } from "./chat-swarm-lifecycle.js";
import type { ChatSwarmCarrierAdapter } from "./chat-swarm-carrier.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devspace-chat-swarm-lifecycle-"));
  let mode: ChatSwarmLifecycleMode = "normal";
  const lifecycle = new ChatSwarmLifecycle({ stateDir: root, mode: () => mode });
  return { root, lifecycle, setMode: (next: ChatSwarmLifecycleMode) => { mode = next; } };
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

test("drain permits current-task next and uncertainty-safe completion, but rejects new claims", () => {
  const f = fixture();
  try {
    f.setMode("drain");
    for (const action of ["create", "join", "dispatch", "close"] as const) {
      assert.throws(() => f.lifecycle.admit(action), (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_STATE");
    }
    assert.doesNotThrow(() => f.lifecycle.admit("next", { existingTask: true }));
    assert.throws(() => f.lifecycle.admit("next", { existingTask: false }), ChatSwarmError);
    for (const action of ["submit", "status", "collect", "cancel", "reconcile"] as const) {
      assert.doesNotThrow(() => f.lifecycle.admit(action));
    }
  } finally {
    cleanup(f);
  }
});

test("reconcile-only permits inspection and explicit recovery actions only", () => {
  const f = fixture();
  try {
    f.setMode("reconcile-only");
    for (const action of ["status", "collect", "cancel", "reconcile", "submit"] as const) {
      assert.doesNotThrow(() => f.lifecycle.admit(action));
    }
    for (const action of ["create", "join", "dispatch", "next", "close"] as const) {
      assert.throws(() => f.lifecycle.admit(action), ChatSwarmError);
    }
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
    assert.throws(() => lifecycle.recoverAfterStartup(), ChatSwarmError);
    assert.throws(() => lifecycle.admit("status"), ChatSwarmError);
  } finally {
    lifecycle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("carrier effects require injected adapter, owner, normal mode, and explicit startup recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-chat-swarm-carrier-lifecycle-")); let mode: ChatSwarmLifecycleMode = "normal";
  const adapter: ChatSwarmCarrierAdapter = { kind: "fake", capabilities: () => ({ boundedWait: "UNSUPPORTED", eventWake: "UNSUPPORTED", resultReadback: "UNSUPPORTED", durableReplay: "SUPPORTED" }), ensureExisting: async (input) => ({ disposition: "READY", operationId: input.operationId, swarmId: input.swarmId, workerId: input.workerId, expectedEpoch: input.expectedEpoch, carrierKind: input.carrierKind, carrierFingerprint: input.carrierFingerprint, remoteMayContinue: false }), wake: async (input) => ({ disposition: "UNSUPPORTED", operationId: input.operationId, swarmId: input.swarmId, workerId: input.workerId, expectedEpoch: input.expectedEpoch, carrierKind: input.carrierKind, carrierFingerprint: input.carrierFingerprint, remoteMayContinue: false }) };
  const lifecycle = new ChatSwarmLifecycle({ stateDir: root, mode: () => mode, carrierAdapter: adapter }); const owner = { "openai/session": "owner" };
  try { const swarm = lifecycle.coordinator!.createSwarm(owner, { workerLimit: 1 }); lifecycle.store!.createWorker({ swarmId: swarm.id, label: "peer", runtimeKind: "mcp_peer", carrierConversationFingerprint: "a".repeat(64) }); const status = lifecycle.carrierStatus(owner, swarm.id); assert.equal(status.workers.length, 1); mode = "drain"; await assert.rejects(lifecycle.ensureCarriers(owner, { swarmId: swarm.id, capacity: 1, adapterConfigHash: "b".repeat(64) }), /carrier effects are unavailable/); mode = "normal"; assert.equal(lifecycle.recoverAfterStartup(), 0); } finally { lifecycle.close(); rmSync(root, { recursive: true, force: true }); }
});
