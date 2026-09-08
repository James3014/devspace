import { ChatSwarmError, type ChatSwarm, type ChatSwarmTask, type ChatSwarmWorker, type TaskRequest, type ReconciliationEvidence } from "./chat-swarm-contract.js";
import { ChatSwarmStore, type CreateSwarmInput, type CreateWorkerInput } from "./chat-swarm-store.js";
import { resolveChatSwarmIdentity, type ChatSwarmIdentityEvidence } from "./request-meta.js";

export interface DispatchRequest extends TaskRequest { id?: string; }
export interface JoinRequest extends Omit<CreateWorkerInput, "swarmId" | "carrierConversationFingerprint" | "sessionIdentityFingerprint"> { sessionIdentityFingerprint?: string; }

export class ChatSwarmCoordinator {
  constructor(readonly store: ChatSwarmStore) {}

  createSwarm(meta: unknown, input: Omit<CreateSwarmInput, "ownerIdentity" | "ownerIdentityFingerprint">): ChatSwarm {
    const identity = resolveChatSwarmIdentity(meta);
    return this.store.createSwarm({ ...input, ownerIdentityFingerprint: identity.fingerprint });
  }

  joinWorker(meta: unknown, swarmId: string, input: JoinRequest): ChatSwarmWorker {
    const identity = this.identity(meta);
    return this.store.joinWorkerAtomic(swarmId, identity.fingerprint, { ...input, swarmId, carrierConversationFingerprint: identity.fingerprint, sessionIdentityFingerprint: input.sessionIdentityFingerprint });
  }

  dispatch(meta: unknown, input: DispatchRequest, queueLimit?: number): ChatSwarmTask {
    this.assertOwner(meta, input.swarmId);
    return this.store.dispatchTaskAtomic(input, queueLimit);
  }

  status(meta: unknown, swarmId: string, taskId: string): ChatSwarmTask {
    this.assertOwner(meta, swarmId);
    const task = this.store.getTask(taskId);
    if (!task || task.swarmId !== swarmId) throw new ChatSwarmError("NOT_FOUND", "task not found in swarm");
    return task;
  }

  collect(meta: unknown, swarmId: string, taskId: string): ChatSwarmTask { this.requireOwnedTask(meta, swarmId, taskId); return this.store.collectTask(taskId); }
  cancel(meta: unknown, swarmId: string, taskId: string): ChatSwarmTask { const task = this.requireOwnedTask(meta, swarmId, taskId); if (task.lifecycleState === "QUEUED") return this.store.cancelTask(taskId, "controller"); if (task.assignedWorkerId) return this.store.requestCancel(taskId, task.assignedWorkerId); throw new ChatSwarmError("INVALID_STATE", `cannot cancel ${task.lifecycleState}`); }
  reconcile(meta: unknown, swarmId: string, taskId: string, decision: "REQUEUE" | "FAILED" | "RESULT_READY", result?: string, evidence?: ReconciliationEvidence): ChatSwarmTask { this.requireOwnedTask(meta, swarmId, taskId); return this.store.resolveReconciliation(taskId, decision, result, evidence); }
  close(meta: unknown, swarmId: string): ChatSwarm { this.assertOwner(meta, swarmId); return this.store.closeSwarm(swarmId); }

  nextTask(meta: unknown, workerId: string): ChatSwarmTask | undefined {
    const worker = this.requireWorkerIdentity(meta, workerId);
    if (worker.lifecycleState === "RECONCILE_REQUIRED" || worker.lifecycleState === "DISABLED") return undefined;
    const current = worker.currentTaskId ? this.store.getTask(worker.currentTaskId) : undefined;
    if (current) return current;
    return this.store.claimNextQueuedTaskAtomic(worker.id);
  }

  submit(meta: unknown, workerId: string, taskId: string, result: string): ChatSwarmTask {
    this.requireWorkerIdentity(meta, workerId);
    return this.store.submitResult(taskId, workerId, result);
  }

  checkpoint(meta: unknown, workerId: string, expectedEpoch: number, leaseExpiresAt: string, checkpoint: Record<string, unknown>): ChatSwarmWorker {
    this.requireWorkerIdentity(meta, workerId);
    return this.store.checkpointWorker(workerId, expectedEpoch, leaseExpiresAt, checkpoint);
  }

  expireLease(workerId: string, at: string): ChatSwarmTask | undefined { return this.store.expireWorkerLease(workerId, at); }

  private identity(meta: unknown): ChatSwarmIdentityEvidence { return resolveChatSwarmIdentity(meta); }
  private assertOwner(meta: unknown, swarmId: string): void { const identity = this.identity(meta); const swarm = this.store.getSwarm(swarmId); if (!swarm) throw new ChatSwarmError("NOT_FOUND", "swarm not found"); if (swarm.ownerIdentityFingerprint !== identity.fingerprint) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "controller identity does not own swarm"); }
  private requireOwnedTask(meta: unknown, swarmId: string, taskId: string): ChatSwarmTask { this.assertOwner(meta, swarmId); const task = this.store.getTask(taskId); if (!task || task.swarmId !== swarmId) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "task does not belong to asserted swarm"); return task; }
  private requireWorkerIdentity(meta: unknown, workerId: string): ChatSwarmWorker { const identity = this.identity(meta); const worker = this.store.getWorker(workerId); if (!worker) throw new ChatSwarmError("NOT_FOUND", "worker not found"); if (worker.carrierConversationFingerprint !== identity.fingerprint) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "conversation is not bound to worker"); return worker; }
}
