import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ChatSwarmRuntimeManager,
  ChatSwarmRuntimeStore,
  type ChatSwarmManagedCarrierAdapter,
  type ManagedCarrierSlot,
  type ManagedConversationEvidence,
  type RuntimePreflight,
} from "./chat-swarm-runtime.js";
import {
  ensureManagedRuntime,
  wakeManagedDispatchedTask,
} from "./chat-swarm-runtime-delivery.js";
import type {
  CarrierCallInput,
  CarrierEnsureEvidence,
  CarrierWakeEvidence,
} from "./chat-swarm-carrier.js";
import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";
import { ChatSwarmStore } from "./chat-swarm-store.js";

const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex");

class FakeManagedAdapter implements ChatSwarmManagedCarrierAdapter {
  readonly kind = "mac_web_chatgpt";
  readonly configHash = "9".repeat(64);
  provisionCalls = 0;
  bootstrapCalls = 0;
  wakeCalls = 0;
  ensureExistingCalls = 0;
  recoverCalls = 0;
  stopCalls = 0;
  failProvision = false;
  failStop = false;
  recoverReady = true;
  onBootstrap?: (operationId: string, rawIdentity: string) => void;
  readonly rawIdentities = new Map<number, string>();

  capabilities() {
    return {
      boundedWait: "SUPPORTED" as const,
      eventWake: "SUPPORTED" as const,
      resultReadback: "SUPPORTED" as const,
      durableReplay: "SUPPORTED" as const,
    };
  }

  async preflight(): Promise<RuntimePreflight> {
    return {
      ready: true,
      state: "READY",
      controlMechanism: "CDP",
      browserVersion: "fake-browser",
      appBinding: "READY",
    };
  }

  async provision(input: {
    operationId: string;
    swarmId: string;
    runtimeSlot: number;
    projectUrl: string;
    deadlineAt: string;
  }): Promise<ManagedConversationEvidence> {
    this.provisionCalls += 1;
    if (this.failProvision) throw new Error("response lost after possible create");
    const rawIdentity = `managed-conversation-${input.runtimeSlot}`;
    this.rawIdentities.set(input.runtimeSlot, rawIdentity);
    return {
      conversationUrl: `https://chatgpt.com/c/${rawIdentity}`,
      conversationFingerprint: fingerprint(rawIdentity),
      appBinding: "READY",
    };
  }

  async bootstrap(input: {
    operationId: string;
    swarmId: string;
    runtimeSlot: number;
    conversationUrl: string;
    workerLabel: string;
    deadlineAt: string;
  }) {
    this.bootstrapCalls += 1;
    const rawIdentity = this.rawIdentities.get(input.runtimeSlot)!;
    this.onBootstrap?.(input.operationId, rawIdentity);
    return { disposition: "DELIVERED" as const, remoteMayContinue: true };
  }

  async recover(_slot: ManagedCarrierSlot) {
    this.recoverCalls += 1;
    return this.recoverReady
      ? { ready: true }
      : { ready: false, blocker: "carrier_lost" };
  }

  async stop(_slot: ManagedCarrierSlot): Promise<void> {
    this.stopCalls += 1;
    if (this.failStop) throw new Error("close acknowledgement lost");
  }

  async ensureExisting(input: CarrierCallInput): Promise<CarrierEnsureEvidence> {
    this.ensureExistingCalls += 1;
    return {
      disposition: "READY",
      operationId: input.operationId,
      swarmId: input.swarmId,
      workerId: input.workerId,
      expectedEpoch: input.expectedEpoch,
      carrierKind: input.carrierKind,
      carrierFingerprint: input.carrierFingerprint,
      remoteMayContinue: false,
    };
  }

  async wake(input: CarrierCallInput): Promise<CarrierWakeEvidence> {
    this.wakeCalls += 1;
    return {
      disposition: "DELIVERED",
      operationId: input.operationId,
      swarmId: input.swarmId,
      workerId: input.workerId,
      expectedEpoch: input.expectedEpoch,
      taskId: input.taskId,
      attemptId: input.attemptId,
      carrierKind: input.carrierKind,
      carrierFingerprint: input.carrierFingerprint,
      remoteMayContinue: false,
    };
  }
}

function fixture(workerLimit = 5) {
  const root = mkdtempSync(join(tmpdir(), "devspace-runtime-117-"));
  const store = new ChatSwarmStore(root);
  const coordinator = new ChatSwarmCoordinator(store);
  const owner = { "openai/session": "owner-runtime-117" };
  const swarm = coordinator.createSwarm(owner, { workerLimit });
  const registry = new ChatSwarmRuntimeStore(root);
  const adapter = new FakeManagedAdapter();
  const env: NodeJS.ProcessEnv = {
    DEVSPACE_CHAT_SWARM_RUNTIME: "1",
    DEVSPACE_CHAT_SWARM_PROJECT_URL: "https://chatgpt.com/g/g-p-runtime-test/project",
    DEVSPACE_CHAT_SWARM_POOL_DEFAULT: "3",
    DEVSPACE_CHAT_SWARM_RUNTIME_TIMEOUT_MS: "5000",
    DEVSPACE_CHAT_SWARM_BOOTSTRAP_WAIT_MS: "5000",
  };
  const manager = new ChatSwarmRuntimeManager(
    coordinator,
    { stateDir: root, chatSwarmMaxWorkers: workerLimit },
    { env, registry, adapter },
  );
  adapter.onBootstrap = (operationId, rawIdentity) => {
    manager.bootstrap({ "openai/session": rawIdentity }, operationId);
  };
  return { root, store, coordinator, owner, swarm, registry, adapter, manager };
}

function cleanup(f: ReturnType<typeof fixture>) {
  f.manager.close();
  f.store.close();
  rmSync(f.root, { recursive: true, force: true });
}

test("concurrent runtime ensure creates only missing managed workers and exact replay creates no duplicates", async () => {
  const f = fixture();
  try {
    const [first, concurrent] = await Promise.all([
      f.manager.ensure(f.owner, f.swarm.id, 3),
      f.manager.ensure(f.owner, f.swarm.id, 3),
    ]);
    assert.equal(first.slots.length, 3);
    assert.equal(concurrent.slots.length, 3);
    const final = await f.manager.ensure(f.owner, f.swarm.id, 3);
    assert.equal(final.slots.filter((slot) => slot.state === "PARKED").length, 3);
    assert.equal(new Set(final.slots.map((slot) => slot.workerId)).size, 3);
    assert.equal(f.adapter.provisionCalls, 3);
    assert.equal(f.adapter.bootstrapCalls, 3);
    assert.equal(
      f.coordinator.store
        .listWorkers(f.swarm.id)
        .filter((worker) => worker.lifecycleState !== "DISABLED").length,
      3,
    );
  } finally {
    cleanup(f);
  }
});

test("cold ensure reconciles exact existing carriers before declaring the pool healthy", async () => {
  const f = fixture();
  try {
    await f.manager.ensure(f.owner, f.swarm.id, 2);
    assert.equal(f.adapter.ensureExistingCalls, 0);
    const cold = await ensureManagedRuntime(f.manager, f.owner, f.swarm.id, 2);
    assert.equal(cold.slots.filter((slot) => slot.state === "PARKED").length, 2);
    assert.equal(f.adapter.ensureExistingCalls, 2);
    assert.equal(f.adapter.provisionCalls, 2);
    assert.equal(f.adapter.bootstrapCalls, 2);
  } finally {
    cleanup(f);
  }
});

test("managed bootstrap requires the exact created ChatGPT conversation identity", () => {
  const f = fixture();
  try {
    const slot = f.registry.ensureSlot(
      f.swarm.id,
      1,
      "https://chatgpt.com/g/g-p-runtime-test/project",
      "1".repeat(64),
    );
    const prepared = f.registry.prepareProvision(slot, 5_000);
    assert.ok(prepared.operation);
    assert.equal(f.registry.claimProvision(prepared.operation!.operationId), true);
    f.registry.markCarrierCreated(prepared.operation!.operationId, {
      conversationUrl: "https://chatgpt.com/c/exact-managed-conversation",
      conversationFingerprint: fingerprint("exact-managed-conversation"),
      appBinding: "READY",
    });
    assert.equal(f.registry.claimBootstrap(prepared.operation!.operationId), true);
    assert.throws(
      () =>
        f.manager.bootstrap(
          { "openai/session": "wrong-conversation" },
          prepared.operation!.operationId,
        ),
      /does not match the managed carrier/,
    );
    const accepted = f.manager.bootstrap(
      { "openai/session": "exact-managed-conversation" },
      prepared.operation!.operationId,
    );
    assert.equal(accepted.slot.state, "PARKED");
    assert.equal(
      accepted.worker.carrierConversationFingerprint,
      fingerprint("exact-managed-conversation"),
    );
  } finally {
    cleanup(f);
  }
});

test("targeted dispatch wake is a delivery hint and preserves canonical claimed task truth", async () => {
  const f = fixture();
  try {
    const status = await f.manager.ensure(f.owner, f.swarm.id, 2);
    const workerId = status.slots[0]!.workerId!;
    const task = f.coordinator.dispatch(f.owner, {
      swarmId: f.swarm.id,
      taskKey: "runtime-targeted-wake",
      prompt: "bounded reasoning task",
      preferredWorkerId: workerId,
    });
    assert.equal(task.lifecycleState, "CLAIMED");
    assert.equal(task.assignedWorkerId, workerId);
    await wakeManagedDispatchedTask(f.manager, f.owner, task);
    assert.equal(f.adapter.wakeCalls, 1);
    assert.equal(f.coordinator.store.getTask(task.id)?.lifecycleState, "CLAIMED");
  } finally {
    cleanup(f);
  }
});

test("scale 3 to 5 to 2 retires only safe idle tail workers", async () => {
  const f = fixture();
  try {
    await f.manager.ensure(f.owner, f.swarm.id, 3);
    const five = await f.manager.scale(f.owner, f.swarm.id, 5);
    assert.equal(five.slots.filter((slot) => slot.state !== "STOPPED").length, 5);
    const two = await f.manager.scale(f.owner, f.swarm.id, 2);
    assert.equal(two.slots.filter((slot) => slot.state !== "STOPPED").length, 2);
    assert.equal(f.adapter.provisionCalls, 5);
    assert.equal(f.adapter.stopCalls, 3);
  } finally {
    cleanup(f);
  }
});

test("busy targeted worker is never evicted during scale-down", async () => {
  const f = fixture(3);
  try {
    const status = await f.manager.ensure(f.owner, f.swarm.id, 3);
    const tailWorker = status.slots[2]!.workerId!;
    const task = f.coordinator.dispatch(f.owner, {
      swarmId: f.swarm.id,
      taskKey: "protect-tail",
      prompt: "do not evict",
      preferredWorkerId: tailWorker,
    });
    assert.equal(task.lifecycleState, "CLAIMED");
    assert.equal(task.assignedWorkerId, tailWorker);
    const scaled = await f.manager.scale(f.owner, f.swarm.id, 2);
    assert.equal(f.coordinator.store.getWorker(tailWorker)?.lifecycleState, "BUSY");
    assert.equal(
      scaled.slots.some(
        (slot) => slot.workerId === tailWorker && slot.state !== "STOPPED",
      ),
      true,
    );
    assert.equal(f.adapter.stopCalls, 1);
  } finally {
    cleanup(f);
  }
});

test("stop fences worker authority before browser close and unknown close never retries blindly", async () => {
  const f = fixture();
  try {
    const status = await f.manager.ensure(f.owner, f.swarm.id, 1);
    const workerId = status.slots[0]!.workerId!;
    f.adapter.failStop = true;
    await assert.rejects(
      f.manager.stop(f.owner, f.swarm.id, workerId),
      /outcome is unknown/,
    );
    assert.equal(
      f.coordinator.store.getWorker(workerId)?.lifecycleState,
      "DISABLED",
    );
    assert.equal(f.adapter.stopCalls, 1);
    await assert.rejects(
      f.manager.stop(f.owner, f.swarm.id, workerId),
      /managed worker carrier not found|reconciliation/,
    );
    assert.equal(f.adapter.stopCalls, 1);
  } finally {
    cleanup(f);
  }
});

test("recovery reopens the exact saved conversation and never mints a replacement task attempt", async () => {
  const f = fixture();
  try {
    const status = await f.manager.ensure(f.owner, f.swarm.id, 1);
    const workerId = status.slots[0]!.workerId!;
    const task = f.coordinator.store.createTask({
      swarmId: f.swarm.id,
      taskKey: "no-attempt",
      prompt: "queued",
    }).task;
    assert.equal(f.coordinator.store.listAttempts(task.id).length, 0);
    const recovered = await f.manager.recover(f.owner, f.swarm.id, workerId);
    assert.equal(recovered.slots[0]!.workerId, workerId);
    assert.equal(f.adapter.recoverCalls, 1);
    assert.equal(f.coordinator.store.listAttempts(task.id).length, 0);
  } finally {
    cleanup(f);
  }
});

test("response loss after possible carrier create is pinned for reconciliation and not reprovisioned", async () => {
  const f = fixture();
  f.adapter.failProvision = true;
  try {
    const first = await f.manager.ensure(f.owner, f.swarm.id, 1);
    assert.equal(first.state, "RECONCILE_REQUIRED");
    assert.equal(first.slots[0]!.state, "RECONCILE_REQUIRED");
    assert.equal(f.adapter.provisionCalls, 1);
    const replay = await f.manager.ensure(f.owner, f.swarm.id, 1);
    assert.equal(replay.slots[0]!.state, "RECONCILE_REQUIRED");
    assert.equal(f.adapter.provisionCalls, 1);
  } finally {
    cleanup(f);
  }
});

test("managed registry survives reopen without duplicating logical workers", async () => {
  const f = fixture();
  try {
    const first = await f.manager.ensure(f.owner, f.swarm.id, 2);
    const ids = first.slots.map((slot) => slot.workerId);
    f.registry.close();
    const reopened = new ChatSwarmRuntimeStore(f.root);
    const slots = reopened.listSlots(f.swarm.id);
    assert.deepEqual(slots.map((slot) => slot.workerId), ids);
    assert.equal(slots.every((slot) => slot.state === "PARKED"), true);
    reopened.close();
  } finally {
    cleanup(f);
  }
});