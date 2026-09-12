import {
  ChatSwarmError,
  type ChatSwarm,
  type ChatSwarmTask,
  type ChatSwarmWorker,
  type TaskRequest,
  type ReconciliationEvidence,
  type ChatSwarmTaskSummary,
  type ChatSwarmTaskListResult,
  type ChatSwarmTaskState,
} from "./chat-swarm-contract.js";
import { ChatSwarmStore, type CreateSwarmInput, type CreateWorkerInput } from "./chat-swarm-store.js";
import { resolveChatSwarmIdentity, ChatSwarmIdentityError, type ChatSwarmIdentityEvidence } from "./request-meta.js";

export interface DispatchRequest extends TaskRequest { id?: string; }
export interface JoinRequest extends Omit<CreateWorkerInput, "swarmId" | "carrierConversationFingerprint" | "sessionIdentityFingerprint"> { sessionIdentityFingerprint?: string; }

export interface PeerStatusResult {
  identity: {
    status: "RESOLVED" | "MISSING" | "AMBIGUOUS" | "MALFORMED";
    source?: string;
    trustClassification?: string;
    fingerprint?: string;
  };
  state: "UNBOUND" | "PENDING_APPROVAL" | "APPROVED" | "BOUND" | "BLOCKED";
  deliveryMode: "POLLING_ONLY";
  pendingRequest?: {
    requestId: string;
    label: string;
    version: number;
    expiresAt: string;
  };
  boundWorker?: {
    workerId: string;
    label: string;
    continuationEpoch: number;
    currentTaskId?: string;
  };
  blocker?: {
    code: string;
    message: string;
    stage: string;
  };
}

export interface InspectRosterWorker {
  id: string;
  label: string;
  lifecycleState: string;
  currentTaskId?: string;
  continuationEpoch: number;
  updatedAt: string;
}

export interface InspectPendingRequest {
  requestId: string;
  requesterFingerprint: string;
  label: string;
  version: number;
  requestedAt: string;
  expiresAt: string;
}

export interface SwarmInspectResult {
  swarm: {
    id: string;
    status: string;
    workerLimit: number;
    revision: number;
    createdAt: string;
  };
  roster: InspectRosterWorker[];
  pendingRequests: InspectPendingRequest[];
  taskCounts?: Record<string, number>;
  recentTasks?: ChatSwarmTaskSummary[];
  observedDeliveryMode: "POLLING_ONLY";
}

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

  nextTask(meta: unknown, workerId: string, expectedCurrentTaskId?: string): ChatSwarmTask | undefined {
    const worker = this.requireWorkerIdentity(meta, workerId);
    if (worker.lifecycleState === "RECONCILE_REQUIRED" || worker.lifecycleState === "DISABLED") return undefined;
    const current = worker.currentTaskId ? this.store.getTask(worker.currentTaskId) : undefined;
    // An admitted existing-task read must never become a new claim after a race.
    if (expectedCurrentTaskId !== undefined) return worker.currentTaskId === expectedCurrentTaskId && current?.assignedWorkerId === worker.id ? current : undefined;
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

  peerStatus(meta: unknown, swarmId?: string): PeerStatusResult {
    let identityEvidence: ChatSwarmIdentityEvidence | undefined;
    let identityError: unknown;
    try {
      identityEvidence = this.identity(meta);
    } catch (err) {
      identityError = err;
    }

    if (!identityEvidence) {
      let status: "MISSING" | "AMBIGUOUS" | "MALFORMED" = "MISSING";
      let blockerCode = "IDENTITY_MISSING";
      let message = "no verified conversation identity headers present";

      if (identityError instanceof ChatSwarmIdentityError) {
        if (identityError.code === "AMBIGUOUS") {
          status = "AMBIGUOUS";
          blockerCode = "IDENTITY_AMBIGUOUS";
          message = "conflicting conversation identity headers found";
        } else if (identityError.code === "MALFORMED") {
          status = "MALFORMED";
          blockerCode = "IDENTITY_MALFORMED";
          message = identityError.message || "malformed conversation identity headers";
        } else {
          status = "MISSING";
          blockerCode = "IDENTITY_MISSING";
          message = identityError.message || "no verified conversation identity headers present";
        }
      }

      return {
        identity: {
          status,
        },
        state: "BLOCKED",
        deliveryMode: "POLLING_ONLY",
        blocker: {
          code: blockerCode,
          message,
          stage: "identity_validated",
        },
      };
    }

    const fingerprint = identityEvidence.fingerprint;
    const baseIdentity = {
      status: "RESOLVED" as const,
      source: identityEvidence.source,
      trustClassification: "CARRIER_HEADER",
      fingerprint,
    };

    if (!swarmId) {
      return {
        identity: baseIdentity,
        state: "UNBOUND",
        deliveryMode: "POLLING_ONLY",
      };
    }

    const swarm = this.store.getSwarm(swarmId);
    if (!swarm) {
      return {
        identity: baseIdentity,
        state: "BLOCKED",
        deliveryMode: "POLLING_ONLY",
        blocker: {
          code: "NOT_FOUND",
          message: "swarm not found",
          stage: "admission_denied",
        },
      };
    }

    const worker = this.store.getWorkerByFingerprint(swarmId, fingerprint);
    if (worker) {
      return {
        identity: baseIdentity,
        state: "BOUND",
        deliveryMode: "POLLING_ONLY",
        boundWorker: {
          workerId: worker.id,
          label: worker.label,
          continuationEpoch: worker.continuationEpoch,
          currentTaskId: worker.currentTaskId,
        },
      };
    }

    const request = this.store.getLatestJoinRequestByFingerprint(swarmId, fingerprint);
    if (request) {
      if (request.status === "PENDING") {
        const isExpired = new Date(request.expiresAt).getTime() <= Date.now();
        if (isExpired) {
          return {
            identity: baseIdentity,
            state: "BLOCKED",
            deliveryMode: "POLLING_ONLY",
            blocker: {
              code: "REQUEST_EXPIRED",
              message: "join request has expired",
              stage: "admission_denied",
            },
          };
        }
        return {
          identity: baseIdentity,
          state: "PENDING_APPROVAL",
          deliveryMode: "POLLING_ONLY",
          pendingRequest: {
            requestId: request.id,
            label: request.label,
            version: request.version,
            expiresAt: request.expiresAt,
          },
        };
      }
      if (request.status === "APPROVED" && request.approvedWorkerId) {
        const approvedWorker = this.store.getWorker(request.approvedWorkerId);
        if (approvedWorker) {
          return {
            identity: baseIdentity,
            state: "APPROVED",
            deliveryMode: "POLLING_ONLY",
            boundWorker: {
              workerId: approvedWorker.id,
              label: approvedWorker.label,
              continuationEpoch: approvedWorker.continuationEpoch,
              currentTaskId: approvedWorker.currentTaskId,
            },
          };
        }
      }
    }

    return {
      identity: baseIdentity,
      state: "UNBOUND",
      deliveryMode: "POLLING_ONLY",
    };
  }

  inspect(meta: unknown, swarmId: string, cursor?: string, limit = 50): SwarmInspectResult {
    this.assertOwner(meta, swarmId);
    const swarm = this.store.getSwarm(swarmId);
    if (!swarm) throw new ChatSwarmError("NOT_FOUND", "swarm not found");

    const workers = this.store.listWorkers(swarmId);
    const roster: InspectRosterWorker[] = workers.map((w) => ({
      id: w.id,
      label: w.label,
      lifecycleState: w.lifecycleState,
      currentTaskId: w.currentTaskId,
      continuationEpoch: w.continuationEpoch,
      updatedAt: w.updatedAt,
    }));

    const pendingRequestsRaw = this.store.listPendingJoinRequests(swarmId, limit, cursor);
    const pendingRequests: InspectPendingRequest[] = pendingRequestsRaw.map((req) => ({
      requestId: req.id,
      requesterFingerprint: req.requesterFingerprint,
      label: req.label,
      version: req.version,
      requestedAt: req.requestedAt,
      expiresAt: req.expiresAt,
    }));

    const taskCounts = this.store.getTaskCounts(swarmId);
    const recentTasksResult = this.store.listTasks(swarmId, { limit: 10 });

    return {
      swarm: {
        id: swarm.id,
        status: swarm.status,
        workerLimit: swarm.workerLimit,
        revision: swarm.revision,
        createdAt: swarm.createdAt,
      },
      roster,
      pendingRequests,
      taskCounts,
      recentTasks: recentTasksResult.tasks,
      observedDeliveryMode: "POLLING_ONLY",
    };
  }

  listTasks(
    meta: unknown,
    swarmId: string,
    options: { limit?: number; cursor?: string; lifecycleState?: ChatSwarmTaskState } = {},
  ): ChatSwarmTaskListResult {
    this.assertOwner(meta, swarmId);
    return this.store.listTasks(swarmId, options);
  }

  createJoinRequest(meta: unknown, swarmId: string, label: string, attemptKey: string) {
    const identity = this.identity(meta);
    return this.store.createJoinRequestAtomic({
      swarmId,
      label,
      attemptKey,
      requesterFingerprint: identity.fingerprint,
    });
  }

  approveJoin(
    meta: unknown,
    swarmId: string,
    requestId: string,
    expectedRequestVersion: number,
    expectedSwarmVersion: number,
  ) {
    this.assertOwner(meta, swarmId);
    return this.store.approveJoinRequestAtomic({
      swarmId,
      requestId,
      expectedRequestVersion,
      expectedSwarmVersion,
    });
  }

  expireLease(workerId: string, at: string): ChatSwarmTask | undefined { return this.store.expireWorkerLease(workerId, at); }

  private identity(meta: unknown): ChatSwarmIdentityEvidence { return resolveChatSwarmIdentity(meta); }
  private assertOwner(meta: unknown, swarmId: string): void { const identity = this.identity(meta); const swarm = this.store.getSwarm(swarmId); if (!swarm) throw new ChatSwarmError("NOT_FOUND", "swarm not found"); if (swarm.ownerIdentityFingerprint !== identity.fingerprint) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "controller identity does not own swarm"); }
  private requireOwnedTask(meta: unknown, swarmId: string, taskId: string): ChatSwarmTask { this.assertOwner(meta, swarmId); const task = this.store.getTask(taskId); if (!task || task.swarmId !== swarmId) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "task does not belong to asserted swarm"); return task; }
  private requireWorkerIdentity(meta: unknown, workerId: string): ChatSwarmWorker { const identity = this.identity(meta); const worker = this.store.getWorker(workerId); if (!worker) throw new ChatSwarmError("NOT_FOUND", "worker not found"); if (worker.carrierConversationFingerprint !== identity.fingerprint) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "conversation is not bound to worker"); return worker; }
}
