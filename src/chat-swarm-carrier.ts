import { createHash, randomUUID } from "node:crypto";
import { ChatSwarmError, type ChatSwarmTask } from "./chat-swarm-contract.js";
import { resolveChatSwarmIdentity } from "./request-meta.js";
import { ChatSwarmStore, type CarrierOperationRecord } from "./chat-swarm-store.js";
import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";

export type CarrierDeliveryMode = "MANUAL_TURN_DRIVEN" | "MCP_LONG_WAIT" | "CARRIER_EVENT_WAKE";
export type CarrierCapability = "UNSUPPORTED" | "SUPPORTED";
export interface ChatSwarmCarrierAdapter {
  readonly kind: string;
  capabilities(): { boundedWait: CarrierCapability; eventWake: CarrierCapability; resultReadback: CarrierCapability; durableReplay: "UNKNOWN" | "SUPPORTED" };
  ensureExisting(input: CarrierCallInput): Promise<CarrierEnsureEvidence>;
  wake(input: CarrierCallInput): Promise<CarrierWakeEvidence>;
}
export interface CarrierCallInput { operationId: string; operationKey: string; swarmId: string; workerId: string; carrierKind: string; carrierFingerprint: string; expectedEpoch: number; taskId?: string; attemptId?: string; adapterConfigHash: string; signal: AbortSignal; deadlineAt: string; }
export interface CarrierEnsureEvidence { disposition: "READY" | "UNKNOWN" | "UNSUPPORTED"; operationId: string; swarmId: string; workerId: string; expectedEpoch: number; carrierKind: string; carrierFingerprint: string; remoteMayContinue: boolean; }
export interface CarrierWakeEvidence { disposition: "DELIVERED" | "UNKNOWN" | "UNSUPPORTED"; operationId: string; swarmId: string; workerId: string; expectedEpoch: number; taskId?: string; attemptId?: string; carrierKind: string; carrierFingerprint: string; remoteMayContinue: boolean; }
export interface CarrierResult { swarmId: string; workerId: string; carrierKind: string; carrierFingerprint: string; bindingEpoch: number; state: string; deliveryMode: CarrierDeliveryMode; operationId?: string; taskId?: string; attemptId?: string; blocker?: string; remoteMayContinue?: boolean; }
export interface CarrierStatusResult { swarmId: string; workers: CarrierResult[]; }

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const boundedHash = (value: string, label: string) => { if (!/^[0-9a-f]{64}$/.test(value)) throw new ChatSwarmError("INVALID_INPUT", `${label} must be a SHA-256 hash`); return value; };
const safeJson = (value: Record<string, unknown>) => { const keys = Object.keys(value); const allowed = ["swarmId","workerId","taskId","attemptId","bindingEpoch","carrierKind","carrierFingerprint","adapterConfigHash","kind"]; if (keys.some((key) => !allowed.includes(key))) throw new ChatSwarmError("INVALID_INPUT", "carrier journal contains unsupported fields"); for (const [key, item] of Object.entries(value)) { if (["taskId","attemptId"].includes(key) && item !== undefined && item !== null && (typeof item !== "string" || item.length === 0 || item.length > 256)) throw new ChatSwarmError("INVALID_INPUT", "carrier journal ID is malformed"); if (["swarmId","workerId","carrierKind","kind"].includes(key) && (typeof item !== "string" || item.length === 0 || item.length > 256)) throw new ChatSwarmError("INVALID_INPUT", "carrier journal identity is malformed"); if (["carrierFingerprint","adapterConfigHash"].includes(key) && (typeof item !== "string" || !/^[0-9a-f]{64}$/.test(item))) throw new ChatSwarmError("INVALID_INPUT", "carrier journal hash is malformed"); if (key === "bindingEpoch" && (!Number.isSafeInteger(item) || Number(item) < 0)) throw new ChatSwarmError("INVALID_INPUT", "carrier journal epoch is malformed"); } const text = JSON.stringify(value); if (Buffer.byteLength(text, "utf8") > 16 * 1024) throw new ChatSwarmError("INVALID_INPUT", "carrier journal exceeds 16 KiB"); return value; };

export class ChatSwarmCarrierManager {
  constructor(readonly store: ChatSwarmStore, readonly coordinator: ChatSwarmCoordinator, readonly adapter: ChatSwarmCarrierAdapter, private readonly deadlineMs = 10_000) { if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000) throw new ChatSwarmError("INVALID_INPUT", "carrier deadline must be between 1ms and 120s"); }

  ensure(meta: unknown, swarmId: string, capacity: number, adapterConfigHash: string): Promise<CarrierResult[]> {
    this.coordinator.assertOwnerForLifecycle(meta, swarmId); if (this.store.getSwarm(swarmId)?.status !== "ACTIVE") throw new ChatSwarmError("INVALID_STATE", "carrier ensure requires an active swarm"); if (!Number.isSafeInteger(capacity) || capacity < 1) throw new ChatSwarmError("INVALID_INPUT", "carrier capacity must be positive"); boundedHash(adapterConfigHash, "adapterConfigHash");
    const workers = this.coordinator.admittedCarrierWorkers(swarmId); if (workers.length === 0 || workers.length < capacity) { if (workers.length === 0) throw new ChatSwarmError("INVALID_STATE", "ADMISSION_REQUIRED: no admitted carrier workers"); return Promise.resolve(workers.map((worker) => this.result(worker, undefined, "UNSUPPORTED", "ADMISSION_REQUIRED"))); }
    if (workers.length > capacity) return Promise.resolve(workers.map((worker, index) => this.result(worker, undefined, index >= capacity ? "UNSUPPORTED" : worker.lifecycleState, index >= capacity ? "SCALE_DOWN_UNSUPPORTED" : undefined)));
    return Promise.all(workers.map(async (worker) => worker.currentTaskId ? this.result(worker, undefined, "UNSUPPORTED", "BUSY_WORKER_PROTECTED") : this.store.hasQueuedPreferredTask(worker.id) ? this.result(worker, undefined, "UNSUPPORTED", "TARGETED_WORKER_PROTECTED") : this.ensureWorker(worker, adapterConfigHash)));
  }

  status(meta: unknown, swarmId: string): CarrierStatusResult { this.coordinator.assertOwnerForLifecycle(meta, swarmId); const operations = this.store.listCarrierOperations(swarmId); const workers = this.store.listWorkers(swarmId).filter((worker) => worker.lifecycleState !== "DISABLED" && !!worker.carrierConversationFingerprint); const covered = new Set(operations.map((operation) => operation.workerId)); return { swarmId, workers: [...operations.map((operation) => this.resultFrom(operation)), ...workers.filter((worker) => !covered.has(worker.id)).map((worker) => this.result(worker))] }; }

  async wake(meta: unknown, input: { swarmId: string; workerId: string; expectedEpoch: number; taskId?: string; adapterConfigHash: string }): Promise<CarrierResult> {
    this.coordinator.assertOwnerForLifecycle(meta, input.swarmId); if (this.store.getSwarm(input.swarmId)?.status !== "ACTIVE") throw new ChatSwarmError("INVALID_STATE", "carrier wake requires an active swarm"); boundedHash(input.adapterConfigHash, "adapterConfigHash"); const worker = this.store.getWorker(input.workerId);
    if (!worker || worker.swarmId !== input.swarmId || !worker.carrierConversationFingerprint) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "worker is not an admitted bound carrier");
    if (worker.continuationEpoch !== input.expectedEpoch) throw new ChatSwarmError("VERSION_CONFLICT", "worker continuation epoch changed");
    if (worker.lifecycleState === "RECONCILE_REQUIRED" || worker.lifecycleState === "DISABLED") throw new ChatSwarmError("RECONCILIATION_REQUIRED", "worker requires reconciliation");
    let task: ChatSwarmTask | undefined; let attemptId: string | undefined;
    if (!input.taskId && worker.currentTaskId) input = { ...input, taskId: worker.currentTaskId };
    if (input.taskId) { task = this.store.getTask(input.taskId); if (!task || task.swarmId !== input.swarmId || task.assignedWorkerId !== worker.id) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "wake task is not assigned to worker"); const attempt = this.store.listAttempts(task.id).at(-1); if (!attempt || !["CLAIMED", "RUNNING", "CANCEL_REQUESTED"].includes(attempt.effectState)) throw new ChatSwarmError("INVALID_STATE", "wake task has no active current attempt"); attemptId = attempt.id; }
    if (task && !["CLAIMED", "RUNNING", "CANCEL_REQUESTED"].includes(task.lifecycleState)) throw new ChatSwarmError("INVALID_STATE", "wake task is not an active assignment");
    if (this.adapter.capabilities().eventWake !== "SUPPORTED") throw new ChatSwarmError("INVALID_STATE", "UNSUPPORTED: carrier event wake is unavailable");
    const slotKey = this.slotKey({ swarmId: input.swarmId, workerId: worker.id, taskId: task?.id, attemptId, epoch: worker.continuationEpoch, kind: "WAKE" });
    const operationKey = this.operationKey({ slotKey, carrierKind: worker.runtimeKind, carrierFingerprint: worker.carrierConversationFingerprint, config: input.adapterConfigHash });
    const request = safeJson({ swarmId: input.swarmId, workerId: worker.id, ...(task ? { taskId: task.id } : {}), ...(attemptId ? { attemptId } : {}), bindingEpoch: worker.continuationEpoch, carrierKind: worker.runtimeKind, carrierFingerprint: worker.carrierConversationFingerprint, adapterConfigHash: input.adapterConfigHash, kind: "WAKE" });
    const op = this.store.createCarrierOperation({ operationId: `carrier_${randomUUID().replaceAll("-", "")}`, operationKey, slotKey, swarmId: input.swarmId, workerId: worker.id, taskId: task?.id, attemptId, carrierKind: worker.runtimeKind, carrierFingerprint: worker.carrierConversationFingerprint, bindingEpoch: worker.continuationEpoch, adapterConfigHash: input.adapterConfigHash, kind: "WAKE", state: "PREPARED", request });
    return this.invoke(op, false);
  }

  private async ensureWorker(worker: NonNullable<ReturnType<ChatSwarmStore["getWorker"]>>, config: string): Promise<CarrierResult> {
    const fingerprint = worker.carrierConversationFingerprint!; const slotKey = this.slotKey({ swarmId: worker.swarmId, workerId: worker.id, epoch: worker.continuationEpoch, kind: "ENSURE_EXISTING" }); const operationKey = this.operationKey({ slotKey, carrierKind: worker.runtimeKind, carrierFingerprint: fingerprint, config });
    const request = safeJson({ swarmId: worker.swarmId, workerId: worker.id, bindingEpoch: worker.continuationEpoch, carrierKind: worker.runtimeKind, carrierFingerprint: fingerprint, adapterConfigHash: config, kind: "ENSURE_EXISTING" });
    const op = this.store.createCarrierOperation({ operationId: `carrier_${randomUUID().replaceAll("-", "")}`, operationKey, slotKey, swarmId: worker.swarmId, workerId: worker.id, carrierKind: worker.runtimeKind, carrierFingerprint: fingerprint, bindingEpoch: worker.continuationEpoch, adapterConfigHash: config, kind: "ENSURE_EXISTING", state: "PREPARED", request });
    return this.invoke(op, true);
  }

  private async invoke(op: CarrierOperationRecord, ensure: boolean): Promise<CarrierResult> {
    if (op.state !== "PREPARED") return this.finishExisting(op); if (this.adapter.capabilities().durableReplay !== "SUPPORTED") return this.resultFrom(this.store.casCarrierOperation(op.operationId, op.version, "PREPARED", "UNSUPPORTED", { disposition: "UNSUPPORTED", reason: "adapter_persistence_unknown" }));
    const inflight = this.store.casCarrierOperation(op.operationId, op.version, "PREPARED", "IN_FLIGHT"); const currentWorker = this.store.getWorker(op.workerId); if (!currentWorker || currentWorker.swarmId !== op.swarmId || currentWorker.continuationEpoch !== op.bindingEpoch || currentWorker.carrierConversationFingerprint !== op.carrierFingerprint || (op.taskId && currentWorker.currentTaskId !== op.taskId)) return this.resultFrom(this.store.casCarrierOperation(op.operationId, inflight.version, "IN_FLIGHT", "RECONCILE_REQUIRED", { disposition: "UNKNOWN", remoteMayContinue: false })); const controller = new AbortController(); const deadlineAt = new Date(Date.now() + this.deadlineMs).toISOString(); const abortTimer = setTimeout(() => controller.abort(), this.deadlineMs); let rejectTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const input: CarrierCallInput = { operationId: inflight.operationId, operationKey: inflight.operationKey, swarmId: inflight.swarmId, workerId: inflight.workerId, carrierKind: inflight.carrierKind, carrierFingerprint: inflight.carrierFingerprint, expectedEpoch: inflight.bindingEpoch, ...(inflight.taskId ? { taskId: inflight.taskId } : {}), ...(inflight.attemptId ? { attemptId: inflight.attemptId } : {}), adapterConfigHash: inflight.adapterConfigHash, signal: controller.signal, deadlineAt };
      const evidence = await Promise.race([ensure ? this.adapter.ensureExisting(input) : this.adapter.wake(input), new Promise<never>((_, reject) => { rejectTimer = setTimeout(() => reject(new Error("carrier operation deadline exceeded")), this.deadlineMs); })]);
      const wakeEvidence = evidence as CarrierWakeEvidence;
      if (!evidence || evidence.carrierKind !== op.carrierKind || evidence.carrierFingerprint !== op.carrierFingerprint || evidence.operationId !== op.operationId || evidence.swarmId !== op.swarmId || evidence.workerId !== op.workerId || evidence.expectedEpoch !== op.bindingEpoch || (!ensure && (wakeEvidence.taskId !== op.taskId || wakeEvidence.attemptId !== op.attemptId)) || (ensure && ("taskId" in evidence || "attemptId" in evidence)) || !(ensure ? ["READY", "UNKNOWN", "UNSUPPORTED"] : ["DELIVERED", "UNKNOWN", "UNSUPPORTED"]).includes(evidence.disposition) || typeof evidence.remoteMayContinue !== "boolean") throw new Error("carrier evidence mismatched or malformed");
      const state = evidence.disposition === "READY" || evidence.disposition === "DELIVERED" ? "SUCCEEDED" : evidence.disposition === "UNSUPPORTED" ? "UNSUPPORTED" : "RECONCILE_REQUIRED";
      return this.resultFrom(this.store.casCarrierOperation(op.operationId, inflight.version, "IN_FLIGHT", state, { disposition: evidence.disposition, remoteMayContinue: evidence.remoteMayContinue === true }));
    } catch (error) {
      try { return this.resultFrom(this.store.casCarrierOperation(op.operationId, inflight.version, "IN_FLIGHT", "RECONCILE_REQUIRED", { disposition: "UNKNOWN", remoteMayContinue: true })); } catch { return this.resultFrom(this.store.getCarrierOperation(op.operationId)!); }
    } finally { clearTimeout(abortTimer); if (rejectTimer) clearTimeout(rejectTimer); }
  }

  private finishExisting(op: CarrierOperationRecord): CarrierResult { return this.resultFrom(op); }
  private resultFrom(op: CarrierOperationRecord): CarrierResult { return { swarmId: op.swarmId, workerId: op.workerId, carrierKind: op.carrierKind, carrierFingerprint: op.carrierFingerprint, bindingEpoch: op.bindingEpoch, state: op.state, deliveryMode: this.mode(), operationId: op.operationId, ...(op.taskId ? { taskId: op.taskId } : {}), ...(op.attemptId ? { attemptId: op.attemptId } : {}), ...(typeof op.receipt?.remoteMayContinue === "boolean" ? { remoteMayContinue: op.receipt.remoteMayContinue } : {}), ...(op.state === "UNSUPPORTED" ? { blocker: String(op.receipt?.reason ?? "unsupported") } : {}) }; }
  private result(worker: NonNullable<ReturnType<ChatSwarmStore["getWorker"]>>, op?: CarrierOperationRecord, state?: string, blocker?: string): CarrierResult { return { swarmId: worker.swarmId, workerId: worker.id, carrierKind: worker.runtimeKind, carrierFingerprint: worker.carrierConversationFingerprint!, bindingEpoch: worker.continuationEpoch, state: state ?? worker.lifecycleState, deliveryMode: this.mode(), ...(op?.operationId ? { operationId: op.operationId } : {}), ...(blocker ? { blocker } : {}) }; }
  private mode(): CarrierDeliveryMode { return this.adapter.capabilities().eventWake === "SUPPORTED" ? "CARRIER_EVENT_WAKE" : "MANUAL_TURN_DRIVEN"; }
  private slotKey(input: { swarmId: string; workerId: string; taskId?: string; attemptId?: string; epoch: number; kind: string }): string { return `carrier-slot-${hash(JSON.stringify({ ...input, taskId: input.taskId ?? null, attemptId: input.attemptId ?? null }))}`; }
  private operationKey(input: { slotKey: string; carrierKind: string; carrierFingerprint: string; config: string }): string { return `carrier-op-${hash(JSON.stringify(input))}`; }
}
