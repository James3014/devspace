import { timingSafeEqual } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  assertBounded, assertTaskState, ChatSwarmError, hashContent, hashCredential, isExecutionActive, isTerminal,
  MAX_ID_BYTES, MAX_JSON_BYTES, MAX_PROMPT_BYTES, MAX_RESULT_BYTES, newId, requestHash, joinRequestHash,
  type ChatSwarm, type ChatSwarmAttempt, type ChatSwarmRuntimeKind, type ChatSwarmTask,
  type ChatSwarmTaskState, type ChatSwarmWorker, type TaskRequest, type ReconciliationEvidence,
  type ChatSwarmJoinRequest, type ChatSwarmJoinRequestStatus, JOIN_REQUEST_STATES,
} from "./chat-swarm-contract.js";

type Row = Record<string, unknown>;
const json = (value: unknown): string => JSON.stringify(value ?? {});
function parse<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  try { return JSON.parse(String(value)) as T; } catch { throw new ChatSwarmError("INVALID_STATE", "corrupt persisted JSON"); }
}
function parseObject(value: unknown, label: string): Record<string, unknown> | undefined {
  const parsed = parse<Record<string, unknown> | undefined>(value, undefined);
  if (parsed !== undefined && (!parsed || Array.isArray(parsed) || typeof parsed !== "object")) throw new ChatSwarmError("INVALID_STATE", `corrupt persisted ${label}`);
  return parsed;
}
const now = (): string => new Date().toISOString();
const WORKER_STATES = ["AVAILABLE", "BUSY", "DISABLED", "RECONCILE_REQUIRED"] as const;
const EFFECT_STATES = ["CLAIMED", "RUNNING", "RESULT_READY", "CANCEL_REQUESTED", "CANCELLED", "FAILED", "UNKNOWN"] as const;

export interface CreateSwarmInput { id?: string; ownerIdentity?: string; ownerIdentityFingerprint?: string; workerLimit: number; inviteCredential?: string; metadata?: Record<string, unknown>; }
export interface CreateWorkerInput { id?: string; swarmId: string; label: string; runtimeKind: ChatSwarmRuntimeKind; sessionIdentityFingerprint?: string; carrierConversationFingerprint?: string; }

export class ChatSwarmStore {
  private readonly database: DatabaseHandle;
  private get sqlite() { return this.database.sqlite; }

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }
  close(): void { this.database.close(); }

  createSwarm(input: CreateSwarmInput): ChatSwarm {
    if (!Number.isInteger(input.workerLimit) || input.workerLimit < 1 || input.workerLimit > 1000) throw new ChatSwarmError("INVALID_INPUT", "workerLimit must be between 1 and 1000");
    if (input.id) assertBounded(input.id, MAX_ID_BYTES, "swarm id");
    const owner = input.ownerIdentityFingerprint ?? (input.ownerIdentity ? hashCredential(input.ownerIdentity) : undefined);
    if (!owner || !/^[0-9a-f]{64}$/.test(owner)) throw new ChatSwarmError("INVALID_INPUT", "owner identity must be a SHA-256 fingerprint");
    const metadata = input.metadata ?? {};
    const metadataJson = json(metadata); assertBounded(metadataJson, MAX_JSON_BYTES, "metadata");
    const createdAt = now(); const id = input.id ?? newId("swarm");
    this.sqlite.prepare(`insert into chat_swarms (id,status,owner_identity_fingerprint,worker_limit,invite_credential_hash,metadata_json,revision,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)`).run(id, "ACTIVE", owner, input.workerLimit, input.inviteCredential ? hashCredential(input.inviteCredential) : null, metadataJson, 1, createdAt, createdAt);
    return this.getSwarm(id)!;
  }
  getSwarm(id: string): ChatSwarm | undefined { const row = this.sqlite.prepare("select * from chat_swarms where id = ?").get(id) as Row | undefined; return row && swarmFrom(row); }
  verifyInviteCredential(swarmId: string, credential: string): boolean {
    const swarm = this.getSwarm(swarmId);
    if (!swarm?.inviteCredentialHash || !credential) return false;
    const supplied = Buffer.from(hashCredential(credential), "hex");
    const expected = Buffer.from(swarm.inviteCredentialHash, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  createWorker(input: CreateWorkerInput): ChatSwarmWorker {
    const operation = this.sqlite.transaction(() => {
      const swarm = this.getSwarm(input.swarmId);
      if (!swarm) throw new ChatSwarmError("NOT_FOUND", `swarm '${input.swarmId}' not found`);
      if (swarm.status !== "ACTIVE") throw new ChatSwarmError("INVALID_STATE", "cannot add a worker to a closed swarm");
      if (input.id) assertBounded(input.id, MAX_ID_BYTES, "worker id");
      assertBounded(input.label, MAX_ID_BYTES, "worker label");
      assertBounded(input.runtimeKind, MAX_ID_BYTES, "runtime kind");
      const workerCount = Number((this.sqlite.prepare("select count(*) as count from chat_swarm_workers where swarm_id = ? and lifecycle_state <> 'DISABLED'").get(input.swarmId) as { count: number }).count);
      if (workerCount >= swarm.workerLimit) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "swarm worker limit reached");
      for (const value of [input.sessionIdentityFingerprint, input.carrierConversationFingerprint]) if (value !== undefined && !/^[0-9a-f]{64}$/.test(value)) throw new ChatSwarmError("INVALID_INPUT", "worker identity values must be SHA-256 fingerprints");
      const timestamp = now(); const id = input.id ?? newId("worker");
      return this.insertWorkerRow(input.swarmId, input);
    });
    return operation.immediate();
  }
  getWorker(id: string): ChatSwarmWorker | undefined { const row = this.sqlite.prepare("select * from chat_swarm_workers where id = ?").get(id) as Row | undefined; return row && workerFrom(row); }
  listWorkers(swarmId: string): ChatSwarmWorker[] { return (this.sqlite.prepare("select * from chat_swarm_workers where swarm_id = ? order by id").all(swarmId) as Row[]).map(workerFrom); }
  findWorkerByCarrier(swarmId: string, fingerprint: string): ChatSwarmWorker | undefined { const row = this.sqlite.prepare("select * from chat_swarm_workers where swarm_id = ? and carrier_conversation_fingerprint = ? limit 1").get(swarmId, fingerprint) as Row | undefined; return row && workerFrom(row); }
  joinWorkerAtomic(swarmId: string, carrierFingerprint: string, input: CreateWorkerInput): ChatSwarmWorker {
    const operation = this.sqlite.transaction(() => {
      if (!/^[0-9a-f]{64}$/.test(carrierFingerprint) || (input.sessionIdentityFingerprint !== undefined && !/^[0-9a-f]{64}$/.test(input.sessionIdentityFingerprint))) throw new ChatSwarmError("INVALID_INPUT", "worker identity values must be SHA-256 fingerprints");
      if (input.runtimeKind !== "mcp_peer") throw new ChatSwarmError("INVALID_INPUT", "#47 only supports mcp_peer workers");
      const global = this.sqlite.prepare("select swarm_id from chat_swarm_workers where carrier_conversation_fingerprint=? and lifecycle_state <> 'DISABLED' limit 1").get(carrierFingerprint) as { swarm_id:string } | undefined;
      if (global && global.swarm_id !== swarmId) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "carrier is already bound in another swarm");
      const existing = this.sqlite.prepare("select * from chat_swarm_workers where swarm_id=? and carrier_conversation_fingerprint=? limit 1").get(swarmId, carrierFingerprint) as Row | undefined;
      if (existing) {
        const worker = workerFrom(existing);
        if (worker.lifecycleState === "DISABLED" || worker.lifecycleState === "RECONCILE_REQUIRED") throw new ChatSwarmError("RECONCILIATION_REQUIRED", "carrier worker requires explicit reconciliation");
        if ((input.id && input.id !== worker.id) || input.label !== worker.label || input.runtimeKind !== worker.runtimeKind || input.sessionIdentityFingerprint !== worker.sessionIdentityFingerprint) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "worker carrier is already bound to different join material");
        return worker;
      }
      const swarm = this.getSwarm(swarmId); if (!swarm) throw new ChatSwarmError("NOT_FOUND", "swarm not found"); if (swarm.status !== "ACTIVE") throw new ChatSwarmError("INVALID_STATE", "cannot add a worker to a closed swarm");
      if (input.id) assertBounded(input.id, MAX_ID_BYTES, "worker id"); assertBounded(input.label, MAX_ID_BYTES, "worker label"); assertBounded(input.runtimeKind, MAX_ID_BYTES, "runtime kind");
      const count = Number((this.sqlite.prepare("select count(*) as count from chat_swarm_workers where swarm_id=? and lifecycle_state <> 'DISABLED'").get(swarmId) as { count:number }).count); if (count >= swarm.workerLimit) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "swarm worker limit reached");
      return this.insertWorkerRow(swarmId, { ...input, carrierConversationFingerprint: carrierFingerprint });
    });
    return operation.immediate();
  }
  checkpointWorker(workerId: string, expectedEpoch: number, leaseExpiresAt: string, checkpoint: Record<string, unknown>): ChatSwarmWorker {
    const operation = this.sqlite.transaction(() => { const worker = this.requireWorker(workerId); if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0 || worker.continuationEpoch !== expectedEpoch) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "worker continuation epoch changed"); const parsed = Date.parse(leaseExpiresAt); const current = Date.now(); if (!Number.isFinite(parsed) || !/Z$/.test(leaseExpiresAt) || parsed <= current || parsed > current + 24 * 60 * 60 * 1000) throw new ChatSwarmError("INVALID_INPUT", "lease expiry must be a bounded future UTC timestamp"); const leaseJson = JSON.stringify({ expiresAt: new Date(parsed).toISOString() }); const checkpointJson = JSON.stringify(checkpoint); assertBounded(leaseJson, MAX_JSON_BYTES, "lease"); assertBounded(checkpointJson, MAX_JSON_BYTES, "checkpoint"); this.sqlite.prepare("update chat_swarm_workers set lease_json=?, checkpoint_json=?, updated_at=? where id=? and continuation_epoch=?").run(leaseJson, checkpointJson, now(), workerId, expectedEpoch); return this.requireWorker(workerId); }); return operation.immediate();
  }
  expireWorkerLease(workerId: string, at: string): ChatSwarmTask | undefined {
    const operation = this.sqlite.transaction(() => { const worker = this.requireWorker(workerId); const atMs = Date.parse(at); if (!Number.isFinite(atMs)) throw new ChatSwarmError("INVALID_INPUT", "lease observation time is invalid"); const lease = worker.lease; const leaseMs = lease && typeof lease.expiresAt === "string" ? Date.parse(lease.expiresAt) : NaN; if (!Number.isFinite(leaseMs) || leaseMs > atMs) return undefined; const canonicalAt = new Date(atMs).toISOString(); if (!worker.currentTaskId) { this.sqlite.prepare("update chat_swarm_workers set lifecycle_state='RECONCILE_REQUIRED', updated_at=? where id=?").run(canonicalAt, workerId); return undefined; } const task = this.requireTask(worker.currentTaskId); if (!isExecutionActive(task.lifecycleState)) return task; this.sqlite.prepare("update chat_swarm_tasks set lifecycle_state='RECONCILE_REQUIRED', retry_safe='false', reconciliation_json=?, updated_at=? where id=? and assigned_worker_id=?").run(JSON.stringify({ reason: "lease_expired", requiresExplicitDecision: true }), canonicalAt, task.id, workerId); this.sqlite.prepare("update chat_swarm_workers set lifecycle_state='RECONCILE_REQUIRED', updated_at=? where id=? and current_task_id=?").run(canonicalAt, workerId, task.id); return this.requireTask(task.id); }); return operation.immediate();
  }

  createTask(input: TaskRequest & { id?: string }): { task: ChatSwarmTask; created: boolean } {
    assertBounded(input.prompt, MAX_PROMPT_BYTES, "prompt");
    assertBounded(input.taskKey, MAX_ID_BYTES, "taskKey");
    if (input.id) assertBounded(input.id, MAX_ID_BYTES, "task id");
    const payload = input.payload ?? {}; const payloadJson = json(payload); assertBounded(payloadJson, MAX_JSON_BYTES, "payload");
    const swarm = this.getSwarm(input.swarmId); if (!swarm) throw new ChatSwarmError("NOT_FOUND", `swarm '${input.swarmId}' not found`); if (swarm.status !== "ACTIVE") throw new ChatSwarmError("INVALID_STATE", "cannot create a task in a closed swarm");
    if (input.preferredWorkerId) { const preferred = this.getWorker(input.preferredWorkerId); if (!preferred) throw new ChatSwarmError("NOT_FOUND", "preferred worker not found"); if (preferred.swarmId !== input.swarmId) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "preferred worker belongs to another swarm"); }
    const hash = requestHash(input); const taskId = input.id ?? newId("task"); const timestamp = now();
    const operation = this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare("select * from chat_swarm_tasks where swarm_id = ? and task_key = ?").get(input.swarmId, input.taskKey) as Row | undefined;
      if (existing) {
        if (existing.request_hash !== hash) throw new ChatSwarmError("REPLAY_CONFLICT", `taskKey '${input.taskKey}' is bound to a different request`);
        return { task: taskFrom(existing), created: false };
      }
      this.sqlite.prepare(`insert into chat_swarm_tasks (id,swarm_id,task_key,request_hash,prompt,payload_json,preferred_worker_id,assigned_worker_id,lifecycle_state,retry_safe,reconciliation_json,created_at,updated_at) values (?,?,?,?,?,?,?,null,'QUEUED','true',null,?,?)`).run(taskId, input.swarmId, input.taskKey, hash, input.prompt, payloadJson, input.preferredWorkerId ?? null, timestamp, timestamp);
      return { task: this.getTask(taskId)!, created: true };
    });
    return operation.immediate();
  }
  getTask(id: string): ChatSwarmTask | undefined { const row = this.sqlite.prepare("select * from chat_swarm_tasks where id = ?").get(id) as Row | undefined; return row && taskFrom(row); }
  getTaskByKey(swarmId: string, taskKey: string): ChatSwarmTask | undefined { const row = this.sqlite.prepare("select * from chat_swarm_tasks where swarm_id = ? and task_key = ?").get(swarmId, taskKey) as Row | undefined; return row && taskFrom(row); }
  countQueuedTasks(swarmId: string): number { return Number((this.sqlite.prepare("select count(*) as count from chat_swarm_tasks where swarm_id=? and lifecycle_state='QUEUED'").get(swarmId) as { count: number }).count); }
  nextQueuedTask(swarmId: string, preferredWorkerId?: string): ChatSwarmTask | undefined { const row = this.sqlite.prepare("select * from chat_swarm_tasks where swarm_id = ? and lifecycle_state = 'QUEUED' and (? is null or preferred_worker_id is null or preferred_worker_id = ?) order by created_at, id limit 1").get(swarmId, preferredWorkerId ?? null, preferredWorkerId ?? null) as Row | undefined; return row && taskFrom(row); }
  claimNextQueuedTaskAtomic(workerId: string): ChatSwarmTask | undefined {
    const operation = this.sqlite.transaction(() => { const worker = this.requireWorker(workerId); if (this.getSwarm(worker.swarmId)?.status !== "ACTIVE") return undefined; if (worker.lifecycleState !== "AVAILABLE" || worker.currentTaskId) return undefined; const row = this.sqlite.prepare("select * from chat_swarm_tasks where swarm_id=? and lifecycle_state='QUEUED' and (preferred_worker_id is null or preferred_worker_id=?) order by created_at,id limit 1").get(worker.swarmId, workerId) as Row | undefined; if (!row) return undefined; const task = taskFrom(row); const timestamp = now(); const previous = this.sqlite.prepare("select coalesce(max(attempt_number),0) as number from chat_swarm_attempts where task_id=?").get(task.id) as { number:number }; this.claimTaskInTransaction(task.id, workerId, worker.runtimeKind, timestamp, Number(previous.number)+1); return this.requireTask(task.id); }); return operation.immediate();
  }
  dispatchTaskAtomic(input: TaskRequest & { id?: string }, queueLimit?: number): ChatSwarmTask {
    assertBounded(input.prompt, MAX_PROMPT_BYTES, "prompt"); assertBounded(input.taskKey, MAX_ID_BYTES, "taskKey"); if (input.id) assertBounded(input.id, MAX_ID_BYTES, "task id");
    const payloadJson = JSON.stringify(input.payload ?? {}); assertBounded(payloadJson, MAX_JSON_BYTES, "payload");
    const operation = this.sqlite.transaction(() => {
      const swarm = this.getSwarm(input.swarmId); if (!swarm) throw new ChatSwarmError("NOT_FOUND", "swarm not found"); if (swarm.status !== "ACTIVE") throw new ChatSwarmError("INVALID_STATE", "swarm is not active");
      const hash = requestHash(input); const existing = this.sqlite.prepare("select * from chat_swarm_tasks where swarm_id=? and task_key=?").get(input.swarmId, input.taskKey) as Row | undefined;
      if (existing) { const task = taskFrom(existing); if (task.requestHash !== hash) throw new ChatSwarmError("REPLAY_CONFLICT", "task replay material differs"); if (task.lifecycleState !== "QUEUED") return task; }
      if (!existing && queueLimit !== undefined && this.countQueuedTasks(input.swarmId) >= queueLimit) throw new ChatSwarmError("INVALID_INPUT", "swarm queue limit reached");
      const taskId = existing ? String(existing.id) : input.id ?? newId("task"); const timestamp = now();
      if (!existing) this.insertTaskRow(input, taskId, hash, payloadJson, timestamp);
      const worker = input.preferredWorkerId ? this.requireWorker(input.preferredWorkerId) : this.listWorkers(input.swarmId).find((candidate) => candidate.lifecycleState === "AVAILABLE");
      if (!worker) return this.requireTask(taskId); if (worker.swarmId !== input.swarmId || worker.lifecycleState !== "AVAILABLE" || worker.currentTaskId) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "dispatch target is unavailable");
      const task = this.requireTask(taskId); if (task.preferredWorkerId && task.preferredWorkerId !== worker.id) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "dispatch target does not satisfy preference");
      const previous = this.sqlite.prepare("select coalesce(max(attempt_number),0) as number from chat_swarm_attempts where task_id=?").get(taskId) as { number:number }; this.claimTaskInTransaction(taskId, worker.id, worker.runtimeKind, timestamp, Number(previous.number)+1); return this.requireTask(taskId);
    }); return operation.immediate();
  }

  claimTask(taskId: string, workerId: string): ChatSwarmTask {
    const result = this.sqlite.transaction(() => {
      const task = this.requireTask(taskId); const worker = this.requireWorker(workerId);
      if (task.lifecycleState !== "QUEUED") throw new ChatSwarmError(task.lifecycleState === "RECONCILE_REQUIRED" ? "RECONCILIATION_REQUIRED" : "INVALID_STATE", `task '${taskId}' is ${task.lifecycleState}`);
      if (worker.swarmId !== task.swarmId) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "worker belongs to another swarm");
      if (worker.lifecycleState !== "AVAILABLE") throw new ChatSwarmError("OWNERSHIP_CONFLICT", "worker is not available");
      if (this.getSwarm(task.swarmId)?.status !== "ACTIVE") throw new ChatSwarmError("INVALID_STATE", "swarm is not active");
      if (worker.currentTaskId) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "worker already owns an active task");
      if (task.preferredWorkerId && task.preferredWorkerId !== workerId) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "task has a different preferred worker");
      const timestamp = now();
      const previous = this.sqlite.prepare("select coalesce(max(attempt_number), 0) as number from chat_swarm_attempts where task_id = ?").get(taskId) as { number: number };
      this.claimTaskInTransaction(taskId, workerId, worker.runtimeKind, timestamp, Number(previous.number) + 1);
      return this.requireTask(taskId);
    });
    return result.immediate();
  }

  startTask(taskId: string, workerId: string): ChatSwarmTask {
    return this.transitionOwned(taskId, workerId, "CLAIMED", "RUNNING", "RUNNING");
  }

  submitResult(taskId: string, workerId: string, result: string): ChatSwarmTask {
    assertBounded(result, MAX_RESULT_BYTES, "result");
    const operation = this.sqlite.transaction(() => {
      const task = this.requireTask(taskId);
      if (isTerminal(task.lifecycleState)) {
        if (task.assignedWorkerId !== workerId) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "worker does not own terminal task");
        if ((task.lifecycleState === "RESULT_READY" || task.lifecycleState === "COLLECTED") && task.result === result) return task;
        throw new ChatSwarmError("TERMINAL_IMMUTABLE", "terminal task result is immutable");
      }
      if (task.assignedWorkerId !== workerId) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "worker does not own task");
      if (task.lifecycleState !== "CLAIMED" && task.lifecycleState !== "RUNNING" && task.lifecycleState !== "CANCEL_REQUESTED") throw new ChatSwarmError("INVALID_STATE", `cannot submit from ${task.lifecycleState}`);
      const timestamp = now();
      this.sqlite.prepare("update chat_swarm_tasks set lifecycle_state='RESULT_READY', result=?, retry_safe='false', completed_at=?, updated_at=? where id=? and assigned_worker_id=?").run(result, timestamp, timestamp, taskId, workerId);
      this.sqlite.prepare("update chat_swarm_workers set current_task_id=null, lifecycle_state='AVAILABLE', updated_at=? where id=? and current_task_id=?").run(timestamp, workerId, taskId);
      this.sqlite.prepare("update chat_swarm_attempts set effect_state='RESULT_READY', runtime_receipt_json=?, finished_at=? where task_id=? and attempt_number=(select max(attempt_number) from chat_swarm_attempts where task_id=?)").run(json({ resultHash: hashContent(result) }), timestamp, taskId, taskId);
      return this.requireTask(taskId);
    });
    return operation.immediate();
  }

  collectTask(taskId: string): ChatSwarmTask {
    const operation = this.sqlite.transaction(() => {
      const task = this.requireTask(taskId); if (task.lifecycleState === "COLLECTED") return task; if (task.lifecycleState !== "RESULT_READY") throw new ChatSwarmError("INVALID_STATE", `cannot collect ${task.lifecycleState}`);
      const timestamp = now(); this.sqlite.prepare("update chat_swarm_tasks set lifecycle_state='COLLECTED', collected_at=?, updated_at=? where id=? and lifecycle_state='RESULT_READY'").run(timestamp, timestamp, taskId); return this.requireTask(taskId);
    }); return operation.immediate();
  }

  resolveReconciliation(taskId: string, decision: "REQUEUE" | "FAILED" | "RESULT_READY", result?: string, evidence?: ReconciliationEvidence): ChatSwarmTask {
    if (decision === "RESULT_READY") { if (result === undefined) throw new ChatSwarmError("INVALID_INPUT", "reconciled result is required"); return this.submitReconciledResult(taskId, result); }
    const operation = this.sqlite.transaction(() => {
      const task = this.requireTask(taskId); if (task.lifecycleState !== "RECONCILE_REQUIRED") throw new ChatSwarmError("INVALID_STATE", "task does not require reconciliation");
      if (decision === "REQUEUE") this.assertNoEffectEvidence(taskId, evidence);
      const timestamp = now(); const next = decision === "REQUEUE" ? "QUEUED" : "FAILED";
      this.sqlite.prepare("update chat_swarm_tasks set lifecycle_state=?, assigned_worker_id=null, error_code=?, error_message=?, retry_safe=?, reconciliation_json=?, completed_at=?, updated_at=? where id=?").run(next, decision === "REQUEUE" ? null : "RECONCILED_FAILURE", decision === "REQUEUE" ? null : "explicit reconciliation marked execution failed", decision === "REQUEUE" ? "true" : "false", json(evidence ?? { decision: "explicit" }), decision === "REQUEUE" ? null : timestamp, timestamp, taskId);
      this.sqlite.prepare("update chat_swarm_attempts set effect_state=?, finished_at=? where task_id=? and attempt_number=(select max(attempt_number) from chat_swarm_attempts where task_id=?)").run(decision === "REQUEUE" ? "CANCELLED" : "FAILED", timestamp, taskId, taskId);
      if (task.assignedWorkerId) this.sqlite.prepare("update chat_swarm_workers set current_task_id=null, lifecycle_state='AVAILABLE', updated_at=? where id=? and current_task_id=?").run(timestamp, task.assignedWorkerId, taskId);
      return this.requireTask(taskId);
    }); return operation.immediate();
  }

  getAttempt(id: string): ChatSwarmAttempt | undefined { const row = this.sqlite.prepare("select * from chat_swarm_attempts where id = ?").get(id) as Row | undefined; return row && attemptFrom(row); }
  listAttempts(taskId: string): ChatSwarmAttempt[] { return (this.sqlite.prepare("select * from chat_swarm_attempts where task_id = ? order by attempt_number").all(taskId) as Row[]).map(attemptFrom); }

  requestCancel(taskId: string, workerId: string): ChatSwarmTask { const task = this.requireTask(taskId); if (task.lifecycleState === "CLAIMED") return this.transitionOwned(taskId, workerId, "CLAIMED", "CANCEL_REQUESTED", "CANCEL_REQUESTED"); return this.transitionOwned(taskId, workerId, "RUNNING", "CANCEL_REQUESTED", "CANCEL_REQUESTED"); }
  failTask(taskId: string, workerId: string, errorCode: string, errorMessage: string): ChatSwarmTask { assertBounded(errorCode, MAX_ID_BYTES, "error code"); assertBounded(errorMessage, MAX_JSON_BYTES, "error message"); return this.finishOwned(taskId, workerId, "FAILED", "FAILED", errorCode, errorMessage); }
  cancelTask(taskId: string, workerId: string): ChatSwarmTask { const task = this.requireTask(taskId); if (task.lifecycleState === "QUEUED") { const operation = this.sqlite.transaction(() => { const timestamp = now(); this.sqlite.prepare("update chat_swarm_tasks set lifecycle_state='CANCELLED', error_code='CANCELLED', error_message='explicit cancellation', retry_safe='false', completed_at=?, updated_at=? where id=? and lifecycle_state='QUEUED'").run(timestamp, timestamp, taskId); return this.requireTask(taskId); }); return operation.immediate(); } return this.finishOwned(taskId, workerId, "CANCELLED", "CANCELLED", "CANCELLED", "explicit cancellation"); }
  closeSwarm(swarmId: string): ChatSwarm { const operation = this.sqlite.transaction(() => { const swarm = this.getSwarm(swarmId); if (!swarm) throw new ChatSwarmError("NOT_FOUND", "swarm not found"); const pending = this.sqlite.prepare("select count(*) as count from chat_swarm_tasks where swarm_id=? and lifecycle_state in ('QUEUED','CLAIMED','RUNNING','CANCEL_REQUESTED','RECONCILE_REQUIRED')").get(swarmId) as { count: number }; if (Number(pending.count) > 0) throw new ChatSwarmError("RECONCILIATION_REQUIRED", "swarm has pending tasks; cancel or reconcile them before close"); this.sqlite.prepare("update chat_swarms set status='CLOSED', updated_at=? where id=?").run(now(), swarmId); return this.getSwarm(swarmId)!; }); return operation.immediate(); }

  private submitReconciledResult(taskId: string, result: string): ChatSwarmTask {
    assertBounded(result, MAX_RESULT_BYTES, "result"); const operation = this.sqlite.transaction(() => {
      const task = this.requireTask(taskId); if (task.lifecycleState !== "RECONCILE_REQUIRED") throw new ChatSwarmError("INVALID_STATE", "task does not require reconciliation");
      const timestamp = now(); this.sqlite.prepare("update chat_swarm_tasks set lifecycle_state='RESULT_READY', result=?, retry_safe='false', completed_at=?, updated_at=? where id=?").run(result, timestamp, timestamp, taskId);
      this.sqlite.prepare("update chat_swarm_attempts set effect_state='RESULT_READY', runtime_receipt_json=?, finished_at=? where task_id=? and attempt_number=(select max(attempt_number) from chat_swarm_attempts where task_id=?)").run(json({ resultHash: hashContent(result), reconciled: true }), timestamp, taskId, taskId);
      if (task.assignedWorkerId) this.sqlite.prepare("update chat_swarm_workers set current_task_id=null, lifecycle_state='AVAILABLE', updated_at=? where id=? and current_task_id=?").run(timestamp, task.assignedWorkerId, taskId);
      return this.requireTask(taskId);
    }); return operation.immediate();
  }

  private assertNoEffectEvidence(taskId: string, evidence: ReconciliationEvidence | undefined): void {
    if (!evidence || evidence.taskId !== taskId || evidence.disposition !== "NO_EFFECT" || !evidence.evidenceRef || evidence.evidenceRef.length > 1024) throw new ChatSwarmError("RECONCILIATION_REQUIRED", "requeue requires exact no-effect evidence");
    const latest = this.listAttempts(taskId).at(-1);
    if (!latest || latest.id !== evidence.attemptId) throw new ChatSwarmError("RECONCILIATION_REQUIRED", "requeue evidence must identify the latest attempt");
  }

  private finishOwned(taskId: string, workerId: string, state: "FAILED" | "CANCELLED", effectState: string, errorCode: string, errorMessage: string): ChatSwarmTask {
    const operation = this.sqlite.transaction(() => { const task = this.requireTask(taskId); if (task.assignedWorkerId !== workerId) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "worker does not own task"); if (!isExecutionActive(task.lifecycleState)) throw new ChatSwarmError("INVALID_STATE", `cannot finish ${task.lifecycleState}`); const timestamp = now(); this.sqlite.prepare("update chat_swarm_tasks set lifecycle_state=?, error_code=?, error_message=?, retry_safe='false', completed_at=?, updated_at=? where id=? and assigned_worker_id=?").run(state, errorCode, errorMessage, timestamp, timestamp, taskId, workerId); this.sqlite.prepare("update chat_swarm_workers set current_task_id=null, lifecycle_state='AVAILABLE', updated_at=? where id=? and current_task_id=?").run(timestamp, workerId, taskId); this.sqlite.prepare("update chat_swarm_attempts set effect_state=?, finished_at=? where task_id=? and attempt_number=(select max(attempt_number) from chat_swarm_attempts where task_id=?)").run(effectState, timestamp, taskId, taskId); return this.requireTask(taskId); }); return operation.immediate();
  }

  private transitionOwned(taskId: string, workerId: string, from: ChatSwarmTaskState, to: ChatSwarmTaskState, effectState: string): ChatSwarmTask {
    const operation = this.sqlite.transaction(() => { const task = this.requireTask(taskId); if (task.assignedWorkerId !== workerId) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "worker does not own task"); if (task.lifecycleState !== from) throw new ChatSwarmError("INVALID_STATE", `cannot transition ${task.lifecycleState} to ${to}`); const timestamp = now(); this.sqlite.prepare("update chat_swarm_tasks set lifecycle_state=?, updated_at=? where id=? and lifecycle_state=? and assigned_worker_id=?").run(to, timestamp, taskId, from, workerId); this.sqlite.prepare("update chat_swarm_attempts set effect_state=?, started_at=coalesce(started_at, ?) where task_id=? and attempt_number=(select max(attempt_number) from chat_swarm_attempts where task_id=?)").run(effectState, timestamp, taskId, taskId); return this.requireTask(taskId); }); return operation.immediate();
  }
  private insertWorkerRow(swarmId: string, input: CreateWorkerInput): ChatSwarmWorker {
    const timestamp = now(); const id = input.id ?? newId("worker");
    this.sqlite.prepare("insert into chat_swarm_workers (id,swarm_id,label,runtime_kind,session_identity_fingerprint,carrier_conversation_fingerprint,lifecycle_state,current_task_id,lease_json,checkpoint_json,continuation_epoch,created_at,updated_at) values (?,?,?,?,?,?,?,null,null,null,?,?,?)").run(id, swarmId, input.label, input.runtimeKind, input.sessionIdentityFingerprint ?? null, input.carrierConversationFingerprint ?? null, "AVAILABLE", 0, timestamp, timestamp);
    return this.getWorker(id)!;
  }
  private insertTaskRow(input: TaskRequest & { id?: string }, taskId: string, hash: string, payloadJson: string, timestamp: string): void {
    this.sqlite.prepare("insert into chat_swarm_tasks (id,swarm_id,task_key,request_hash,prompt,payload_json,preferred_worker_id,assigned_worker_id,lifecycle_state,retry_safe,reconciliation_json,created_at,updated_at) values (?,?,?,?,?,?,?,null,'QUEUED','true',null,?,?)").run(taskId, input.swarmId, input.taskKey, hash, input.prompt, payloadJson, input.preferredWorkerId ?? null, timestamp, timestamp);
  }
  private claimTaskInTransaction(taskId: string, workerId: string, runtimeKind: string, timestamp: string, attemptNumber: number): void {
    const task = this.requireTask(taskId); const worker = this.requireWorker(workerId); const swarm = this.getSwarm(task.swarmId); if (!swarm || swarm.status !== "ACTIVE") throw new ChatSwarmError("INVALID_STATE", "swarm is not active"); if (task.lifecycleState !== "QUEUED") throw new ChatSwarmError("INVALID_STATE", "task is not queued"); if (worker.swarmId !== task.swarmId || worker.lifecycleState !== "AVAILABLE" || worker.currentTaskId) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "worker is not eligible to claim task"); if (task.preferredWorkerId && task.preferredWorkerId !== workerId) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "worker does not satisfy task preference");
    this.sqlite.prepare("update chat_swarm_tasks set assigned_worker_id=?, lifecycle_state='CLAIMED', updated_at=? where id=? and lifecycle_state='QUEUED'").run(workerId, timestamp, taskId);
    this.sqlite.prepare("update chat_swarm_workers set current_task_id=?, lifecycle_state='BUSY', updated_at=? where id=? and current_task_id is null").run(taskId, timestamp, workerId);
    this.sqlite.prepare("insert into chat_swarm_attempts (id,task_id,attempt_number,runtime_kind,effect_state,created_at) values (?,?,?,?,?,?)").run(newId("attempt"), taskId, attemptNumber, runtimeKind, "CLAIMED", timestamp);
  }
  private requireTask(id: string): ChatSwarmTask { const task = this.getTask(id); if (!task) throw new ChatSwarmError("NOT_FOUND", `task '${id}' not found`); return task; }
  private requireWorker(id: string): ChatSwarmWorker { const worker = this.getWorker(id); if (!worker) throw new ChatSwarmError("NOT_FOUND", `worker '${id}' not found`); return worker; }
  createJoinRequestAtomic(input: {
    swarmId: string;
    attemptKey: string;
    requesterFingerprint: string;
    label: string;
    ttlSeconds?: number;
  }): { request: ChatSwarmJoinRequest; created: boolean } {
    assertBounded(input.attemptKey, MAX_ID_BYTES, "attemptKey");
    assertBounded(input.label, MAX_ID_BYTES, "label");
    if (!/^[0-9a-f]{64}$/.test(input.requesterFingerprint)) {
      throw new ChatSwarmError("INVALID_INPUT", "requesterFingerprint must be a SHA-256 fingerprint");
    }
    const hash = joinRequestHash({
      swarmId: input.swarmId,
      label: input.label,
      requesterFingerprint: input.requesterFingerprint,
    });
    const operation = this.sqlite.transaction(() => {
      const swarm = this.getSwarm(input.swarmId);
      if (!swarm) throw new ChatSwarmError("NOT_FOUND", "swarm not found");
      if (swarm.status !== "ACTIVE") throw new ChatSwarmError("INVALID_STATE", "swarm is not active");

      const timestamp = now();
      // Lazy expiry of stale pending requests during consequential write
      this.sqlite
        .prepare("update chat_swarm_join_requests set status = 'EXPIRED' where status = 'PENDING' and expires_at <= ?")
        .run(timestamp);

      const existingRow = this.sqlite
        .prepare("select * from chat_swarm_join_requests where swarm_id = ? and attempt_key = ?")
        .get(input.swarmId, input.attemptKey) as Row | undefined;

      if (existingRow) {
        const existing = joinRequestFrom(existingRow);
        if (existing.requestHash !== hash) {
          throw new ChatSwarmError("REPLAY_CONFLICT", "join request attemptKey is bound to different inputs");
        }
        return { request: existing, created: false };
      }

      // Check active unexpired pending requests count for this peer
      const pendingCountRow = this.sqlite
        .prepare("select count(*) as count from chat_swarm_join_requests where swarm_id = ? and requester_fingerprint = ? and status = 'PENDING' and expires_at > ?")
        .get(input.swarmId, input.requesterFingerprint, timestamp) as { count: number };
      if (Number(pendingCountRow.count) >= 10) {
        throw new ChatSwarmError("CAPACITY_FULL", "too many pending join requests for this peer");
      }

      const id = newId("joinreq");
      const ttl = (input.ttlSeconds && input.ttlSeconds > 0) ? input.ttlSeconds : 900;
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

      this.sqlite
        .prepare(`
          insert into chat_swarm_join_requests (
            id, swarm_id, attempt_key, request_hash, requester_fingerprint,
            label, version, status, approved_worker_id, requested_at, expires_at, approved_at
          ) values (?, ?, ?, ?, ?, ?, 1, 'PENDING', null, ?, ?, null)
        `)
        .run(id, input.swarmId, input.attemptKey, hash, input.requesterFingerprint, input.label, timestamp, expiresAt);

      return { request: this.getJoinRequest(id)!, created: true };
    });
    return operation.immediate();
  }

  getJoinRequest(id: string): ChatSwarmJoinRequest | undefined {
    const row = this.sqlite.prepare("select * from chat_swarm_join_requests where id = ?").get(id) as Row | undefined;
    return row && joinRequestFrom(row);
  }

  getJoinRequestByAttemptKey(swarmId: string, attemptKey: string): ChatSwarmJoinRequest | undefined {
    const row = this.sqlite.prepare("select * from chat_swarm_join_requests where swarm_id = ? and attempt_key = ?").get(swarmId, attemptKey) as Row | undefined;
    return row && joinRequestFrom(row);
  }

  listPendingJoinRequests(swarmId: string, limit = 50, cursor?: string, effectiveNow = new Date().toISOString()): ChatSwarmJoinRequest[] {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const query = cursor
      ? "select * from chat_swarm_join_requests where swarm_id = ? and status = 'PENDING' and expires_at > ? and id > ? order by id asc limit ?"
      : "select * from chat_swarm_join_requests where swarm_id = ? and status = 'PENDING' and expires_at > ? order by id asc limit ?";
    const rows = (cursor
      ? this.sqlite.prepare(query).all(swarmId, effectiveNow, cursor, safeLimit)
      : this.sqlite.prepare(query).all(swarmId, effectiveNow, safeLimit)) as Row[];
    return rows.map(joinRequestFrom);
  }

  getWorkerByFingerprint(swarmId: string, fingerprint: string): ChatSwarmWorker | undefined {
    const row = this.sqlite
      .prepare("select * from chat_swarm_workers where swarm_id = ? and carrier_conversation_fingerprint = ? limit 1")
      .get(swarmId, fingerprint) as Row | undefined;
    return row && workerFrom(row);
  }

  getLatestJoinRequestByFingerprint(swarmId: string, fingerprint: string, effectiveNow = new Date().toISOString()): ChatSwarmJoinRequest | undefined {
    const row = this.sqlite
      .prepare("select * from chat_swarm_join_requests where swarm_id = ? and requester_fingerprint = ? and status = 'PENDING' and expires_at > ? order by requested_at desc, id desc limit 1")
      .get(swarmId, fingerprint, effectiveNow) as Row | undefined;
    return row && joinRequestFrom(row);
  }

  approveJoinRequestAtomic(input: {
    swarmId: string;
    requestId: string;
    expectedRequestVersion: number;
    expectedSwarmVersion: number;
  }): { request: ChatSwarmJoinRequest; worker: ChatSwarmWorker } {
    assertBounded(input.requestId, MAX_ID_BYTES, "requestId");
    if (!Number.isInteger(input.expectedSwarmVersion) || input.expectedSwarmVersion < 1) {
      throw new ChatSwarmError("INVALID_INPUT", "expectedSwarmVersion must be a positive integer");
    }
    const operation = this.sqlite.transaction(() => {
      const swarmRow = this.sqlite
        .prepare("select * from chat_swarms where id = ? and status = 'ACTIVE'")
        .get(input.swarmId) as Row | undefined;
      if (!swarmRow) throw new ChatSwarmError("NOT_FOUND", "swarm not found or not active");

      const currentSwarmRevision = Number(swarmRow.revision ?? 1);
      if (currentSwarmRevision !== input.expectedSwarmVersion) {
        throw new ChatSwarmError("CAS_DRIFT", `swarm revision mismatch: expected ${input.expectedSwarmVersion} but found ${currentSwarmRevision}`);
      }

      const reqRow = this.sqlite
        .prepare("select * from chat_swarm_join_requests where id = ? and swarm_id = ?")
        .get(input.requestId, input.swarmId) as Row | undefined;
      if (!reqRow) throw new ChatSwarmError("REQUEST_NOT_FOUND", "join request not found in swarm");

      const request = joinRequestFrom(reqRow);

      if (request.status === "APPROVED") {
        if (request.approvedWorkerId) {
          const existingWorker = this.getWorker(request.approvedWorkerId);
          if (existingWorker) {
            return { request, worker: existingWorker };
          }
        }
      }

      if (request.status === "EXPIRED") {
        throw new ChatSwarmError("EXPIRED", "join request has expired");
      }

      if (request.status !== "PENDING") {
        throw new ChatSwarmError("INVALID_STATE", `join request status is '${request.status}'`);
      }

      const timestamp = now();
      if (new Date(request.expiresAt).getTime() <= new Date(timestamp).getTime()) {
        this.sqlite
          .prepare("update chat_swarm_join_requests set status = 'EXPIRED' where id = ? and status = 'PENDING'")
          .run(request.id);
        throw new ChatSwarmError("EXPIRED", "join request has expired");
      }

      if (request.version !== input.expectedRequestVersion) {
        throw new ChatSwarmError("VERSION_CONFLICT", `expected request version ${input.expectedRequestVersion} but found ${request.version}`);
      }

      const workerCountRow = this.sqlite
        .prepare("select count(*) as count from chat_swarm_workers where swarm_id = ?")
        .get(input.swarmId) as { count: number };
      const currentWorkerCount = Number(workerCountRow.count);

      let worker = this.getWorkerByFingerprint(input.swarmId, request.requesterFingerprint);
      if (!worker) {
        if (currentWorkerCount >= Number(swarmRow.worker_limit)) {
          throw new ChatSwarmError("CAPACITY_FULL", "swarm worker limit reached");
        }
        const workerId = newId("worker");
        this.sqlite
          .prepare(`
            insert into chat_swarm_workers (
              id, swarm_id, label, runtime_kind, session_identity_fingerprint,
              carrier_conversation_fingerprint, lifecycle_state, current_task_id,
              lease_json, checkpoint_json, continuation_epoch, created_at, updated_at
            ) values (?, ?, ?, 'mcp_peer', null, ?, 'AVAILABLE', null, null, null, 0, ?, ?)
          `)
          .run(workerId, input.swarmId, request.label, request.requesterFingerprint, timestamp, timestamp);
        worker = this.getWorker(workerId)!;
      }

      const newVersion = request.version + 1;
      const updateResult = this.sqlite
        .prepare(`
          update chat_swarm_join_requests
          set status = 'APPROVED', version = ?, approved_worker_id = ?, approved_at = ?
          where id = ? and version = ? and status = 'PENDING'
        `)
        .run(newVersion, worker.id, timestamp, request.id, request.version);

      if (updateResult.changes === 0) {
        throw new ChatSwarmError("VERSION_CONFLICT", "concurrent update conflict on join request");
      }

      const updateSwarm = this.sqlite
        .prepare("update chat_swarms set revision = revision + 1, updated_at = ? where id = ? and revision = ?")
        .run(timestamp, input.swarmId, currentSwarmRevision);

      if (updateSwarm.changes === 0) {
        throw new ChatSwarmError("CAS_DRIFT", "concurrent update conflict on swarm revision");
      }

      return { request: this.getJoinRequest(request.id)!, worker };
    });
    return operation.immediate();
  }
  recoverAfterRestart(): number {
    const timestamp = now();
    const operation = this.sqlite.transaction(() => {
      const rows = this.sqlite.prepare("select id, assigned_worker_id from chat_swarm_tasks where lifecycle_state in ('CLAIMED','RUNNING','CANCEL_REQUESTED')").all() as Array<{id:string;assigned_worker_id:string|null}>;
      for (const row of rows) {
        this.sqlite.prepare("update chat_swarm_tasks set lifecycle_state='RECONCILE_REQUIRED', retry_safe='false', reconciliation_json=?, updated_at=? where id=?").run(json({ reason: "process_restart", requiresExplicitDecision: true }), timestamp, row.id);
        if (row.assigned_worker_id) this.sqlite.prepare("update chat_swarm_workers set lifecycle_state='RECONCILE_REQUIRED', updated_at=? where id=? and current_task_id=?").run(timestamp, row.assigned_worker_id, row.id);
      }
      return rows.length;
    });
    return operation.immediate();
  }
}

function swarmFrom(row: Row): ChatSwarm { const status = String(row.status); if (status !== "ACTIVE" && status !== "CLOSED") throw new ChatSwarmError("INVALID_STATE", `unknown swarm state '${status}'`); return { id: String(row.id), status, ownerIdentityFingerprint: String(row.owner_identity_fingerprint), workerLimit: Number(row.worker_limit), inviteCredentialHash: row.invite_credential_hash == null ? undefined : String(row.invite_credential_hash), metadata: parseObject(row.metadata_json, "swarm metadata") ?? {}, revision: Number(row.revision ?? 1), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function workerFrom(row: Row): ChatSwarmWorker { const lifecycleState = String(row.lifecycle_state); if (!(WORKER_STATES as readonly string[]).includes(lifecycleState)) throw new ChatSwarmError("INVALID_STATE", `unknown worker state '${lifecycleState}'`); return { id: String(row.id), swarmId: String(row.swarm_id), label: String(row.label), runtimeKind: String(row.runtime_kind), sessionIdentityFingerprint: row.session_identity_fingerprint == null ? undefined : String(row.session_identity_fingerprint), carrierConversationFingerprint: row.carrier_conversation_fingerprint == null ? undefined : String(row.carrier_conversation_fingerprint), lifecycleState: lifecycleState as ChatSwarmWorker["lifecycleState"], currentTaskId: row.current_task_id == null ? undefined : String(row.current_task_id), lease: parseObject(row.lease_json, "worker lease"), checkpoint: parseObject(row.checkpoint_json, "worker checkpoint"), continuationEpoch: Number(row.continuation_epoch), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function taskFrom(row: Row): ChatSwarmTask { const state = String(row.lifecycle_state); assertTaskState(state); const payload = parseObject(row.payload_json, "task payload"); const reconciliation = parseObject(row.reconciliation_json, "reconciliation"); return { id: String(row.id), swarmId: String(row.swarm_id), taskKey: String(row.task_key), requestHash: String(row.request_hash), prompt: String(row.prompt), payload: payload ?? {}, preferredWorkerId: row.preferred_worker_id == null ? undefined : String(row.preferred_worker_id), assignedWorkerId: row.assigned_worker_id == null ? undefined : String(row.assigned_worker_id), lifecycleState: state, result: row.result == null ? undefined : String(row.result), errorCode: row.error_code == null ? undefined : String(row.error_code), errorMessage: row.error_message == null ? undefined : String(row.error_message), retrySafe: row.retry_safe === "true", reconciliation, createdAt: String(row.created_at), updatedAt: String(row.updated_at), completedAt: row.completed_at == null ? undefined : String(row.completed_at), collectedAt: row.collected_at == null ? undefined : String(row.collected_at) }; }
export function attemptFrom(row: Row): ChatSwarmAttempt { const effectState = String(row.effect_state); if (!(EFFECT_STATES as readonly string[]).includes(effectState)) throw new ChatSwarmError("INVALID_STATE", `unknown attempt effect state '${effectState}'`); return { id: String(row.id), taskId: String(row.task_id), attemptNumber: Number(row.attempt_number), runtimeKind: String(row.runtime_kind), effectState, runtimeReceipt: parseObject(row.runtime_receipt_json, "attempt receipt"), startedAt: row.started_at == null ? undefined : String(row.started_at), acknowledgedAt: row.acknowledged_at == null ? undefined : String(row.acknowledged_at), finishedAt: row.finished_at == null ? undefined : String(row.finished_at), createdAt: String(row.created_at) }; }
function joinRequestFrom(row: Row): ChatSwarmJoinRequest {
  const status = String(row.status);
  if (!(JOIN_REQUEST_STATES as readonly string[]).includes(status)) {
    throw new ChatSwarmError("INVALID_STATE", `unknown join request status '${status}'`);
  }
  return {
    id: String(row.id),
    swarmId: String(row.swarm_id),
    attemptKey: String(row.attempt_key),
    requestHash: String(row.request_hash),
    requesterFingerprint: String(row.requester_fingerprint),
    label: String(row.label),
    version: Number(row.version),
    status: status as ChatSwarmJoinRequestStatus,
    approvedWorkerId: row.approved_worker_id == null ? undefined : String(row.approved_worker_id),
    requestedAt: String(row.requested_at),
    expiresAt: String(row.expires_at),
    approvedAt: row.approved_at == null ? undefined : String(row.approved_at),
  };
}
