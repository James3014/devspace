import {
  canonicalize,
  hashContent,
  type ChatSwarmTask,
} from "./chat-swarm-contract.js";
import type { ChatSwarmRuntimeManager } from "./chat-swarm-runtime.js";

function fallbackAdapterConfigHash(kind: string): string {
  return hashContent(JSON.stringify(canonicalize({ kind })));
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
      adapterConfigHash:
        manager.adapter.configHash ?? fallbackAdapterConfigHash(manager.adapter.kind),
    });
  } catch {
    // Canonical dispatch is already durable. Wake is a delivery hint only;
    // its own carrier-operation journal owns unknown/reconciliation state.
  }
}
