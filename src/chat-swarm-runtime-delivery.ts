import {
  canonicalize,
  ChatSwarmError,
  hashContent,
  type ChatSwarmTask,
} from "./chat-swarm-contract.js";
import type {
  ChatSwarmRuntimeManager,
  RuntimeStatusResult,
} from "./chat-swarm-runtime.js";

const PROCESS_CARRIER_GENERATION = hashContent(
  `${process.pid}:${performance.timeOrigin}`,
);

function adapterConfigHash(manager: ChatSwarmRuntimeManager): string {
  return (
    manager.adapter.configHash ??
    hashContent(JSON.stringify(canonicalize({ kind: manager.adapter.kind })))
  );
}

/**
 * Merge the existing carrier-operation journal into the managed-pool status so
 * an unresolved ENSURE/WAKE cannot be hidden by an otherwise healthy registry.
 */
export async function readManagedRuntimeStatus(
  manager: ChatSwarmRuntimeManager,
  meta: unknown,
  swarmId: string,
): Promise<RuntimeStatusResult> {
  const status = await manager.status(meta, swarmId);
  const carrier = manager.carrierManager.status(meta, swarmId);
  if (carrier.workers.some((worker) => worker.state === "RECONCILE_REQUIRED")) {
    status.state = "RECONCILE_REQUIRED";
  }
  return status;
}

/**
 * Before provisioning missing capacity, reconcile/reopen the exact existing
 * managed carriers through the #116 durable ENSURE_EXISTING journal. The
 * generation is stable for one DevSpace process and changes across restart, so
 * repeated ensure in one boot is idempotent while a cold boot performs a fresh
 * physical carrier health check.
 */
export async function ensureManagedRuntime(
  manager: ChatSwarmRuntimeManager,
  meta: unknown,
  swarmId: string,
  desiredWorkers?: number,
  operationGeneration = PROCESS_CARRIER_GENERATION,
): Promise<RuntimeStatusResult> {
  if (manager.runtimeConfig.enabled) {
    const managedWorkerIds = new Set(
      manager.registry
        .listSlots(swarmId)
        .filter(
          (slot) =>
            slot.state !== "STOPPED" &&
            slot.state !== "RECONCILE_REQUIRED" &&
            Boolean(slot.workerId),
        )
        .map((slot) => slot.workerId!),
    );
    const admitted = manager.coordinator.admittedCarrierWorkers(swarmId);
    const managedAdmitted = admitted.filter((worker) => managedWorkerIds.has(worker.id));

    // A mixed manual/managed swarm cannot be safely projected through the
    // all-admitted #116 ensure API. Do not pretend manual carriers are managed.
    if (
      managedAdmitted.length > 0 &&
      managedAdmitted.length === admitted.length
    ) {
      const results = await manager.carrierManager.ensure(
        meta,
        swarmId,
        managedAdmitted.length,
        adapterConfigHash(manager),
        operationGeneration,
      );
      if (results.some((result) => result.state === "RECONCILE_REQUIRED")) {
        throw new ChatSwarmError(
          "RECONCILIATION_REQUIRED",
          "an existing managed carrier has an unresolved ensure outcome",
        );
      }
    }
  }

  const ensured = await manager.ensure(meta, swarmId, desiredWorkers);
  const carrier = manager.carrierManager.status(meta, swarmId);
  if (carrier.workers.some((worker) => worker.state === "RECONCILE_REQUIRED")) {
    ensured.state = "RECONCILE_REQUIRED";
  }
  return ensured;
}

/**
 * Deliver a durable dispatch to its managed carrier using the canonical store
 * state, never the caller's potentially stale task snapshot. The carrier wake
 * journal remains the idempotency/reconciliation fence; task truth is not
 * changed by this function.
 */
export async function wakeManagedDispatchedTask(
  manager: ChatSwarmRuntimeManager,
  meta: unknown,
  taskSnapshot: ChatSwarmTask,
): Promise<void> {
  if (!manager.runtimeConfig.enabled || !taskSnapshot.preferredWorkerId) return;

  const task = manager.coordinator.store.getTask(taskSnapshot.id);
  if (
    !task ||
    task.swarmId !== taskSnapshot.swarmId ||
    !task.preferredWorkerId ||
    !["QUEUED", "CLAIMED", "RUNNING"].includes(task.lifecycleState)
  ) return;

  const workerId = task.assignedWorkerId ?? task.preferredWorkerId;
  if (workerId !== task.preferredWorkerId) return;

  const slot = manager.registry.getSlotByWorker(task.swarmId, workerId);
  const worker = manager.coordinator.store.getWorker(workerId);
  if (
    !slot ||
    !worker ||
    !slot.conversationFingerprint ||
    worker.lifecycleState === "DISABLED" ||
    worker.lifecycleState === "RECONCILE_REQUIRED"
  ) return;

  try {
    await manager.carrierManager.wake(meta, {
      swarmId: task.swarmId,
      workerId: worker.id,
      expectedEpoch: worker.continuationEpoch,
      taskId: task.id,
      adapterConfigHash: adapterConfigHash(manager),
    });
  } catch {
    // Canonical dispatch is already durable. Wake is a delivery hint only;
    // its own carrier-operation journal owns unknown/reconciliation state.
  }
}
