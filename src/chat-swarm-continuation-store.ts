import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  assertBounded,
  ChatSwarmError,
  MAX_ID_BYTES,
  newId,
} from "./chat-swarm-contract.js";
import type {
  ApproveContinuationRequestInput,
  ChatSwarmContinuationRequest,
  CreateContinuationRequestInput,
} from "./chat-swarm-continuation-contract.js";
import {
  assertContinuationCommitAllowed,
  prepareContinuationMaterial,
  type WorkerContinuationSnapshot,
} from "./chat-swarm-continuation-domain.js";

const KIND = "chat_swarm_continuation";
const REQUEST_SCHEMA = "devspace.chat_swarm_continuation.v1";
const RECEIPT_SCHEMA = "devspace.chat_swarm_continuation_receipt.v1";
const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_TTL_SECONDS = 15 * 60;
const MAX_TTL_SECONDS = 60 * 60;
const MAX_PENDING_PER_WORKER = 10;
const CONTINUATION_RESTART_MESSAGE =
  "DevSpace restarted while continuation was pending; reconcile exact binding before approval.";

type Row = Record<string, unknown>;

interface DurableRow {
  operation_id: string;
  attempt_key: string;
  request_hash: string;
  kind: string;
  authority_mode: string;
  scope_root: string;
  status: string;
  request_json: string;
  receipt_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface PersistedRequest {
  schema: typeof REQUEST_SCHEMA;
  version: number;
  swarmId: string;
  workerId: string;
  attemptKey: string;
  sourceEpoch: number;
  targetEpoch: number;
  sourceCarrierFingerprint: string;
  targetCarrierFingerprint: string;
  checkpointHash: string;
  requestedAt: string;
  expiresAt: string;
}

interface PersistedReceipt {
  schema: typeof RECEIPT_SCHEMA;
  approvedAt: string;
  targetEpoch: number;
  targetCarrierFingerprint: string;
  checkpointHash: string;
}

type ApprovalOutcome =
  | { ok: true; request: ChatSwarmContinuationRequest }
  | {
      ok: false;
      code: "EXPIRED" | "RECONCILIATION_REQUIRED" | "OWNERSHIP_CONFLICT";
      message: string;
    };

export class ChatSwarmContinuationStore {
  private readonly database: DatabaseHandle;
  private readonly scopeRoot: string;

  constructor(
    stateDir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.database = openDatabase(stateDir);
    this.scopeRoot = resolve(stateDir);
  }

  close(): void {
    this.database.close();
  }

  createRequest(
    authenticatedTargetCarrierFingerprint: string,
    input: CreateContinuationRequestInput,
  ): { request: ChatSwarmContinuationRequest; created: boolean } {
    assertFingerprint(authenticatedTargetCarrierFingerprint, "authenticated target carrier fingerprint");
    assertBounded(input.swarmId, MAX_ID_BYTES, "swarmId");
    assertBounded(input.workerId, MAX_ID_BYTES, "workerId");
    assertBounded(input.attemptKey, MAX_ID_BYTES, "attemptKey");
    const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
      throw new ChatSwarmError("INVALID_INPUT", `ttlSeconds must be between 1 and ${MAX_TTL_SECONDS}`);
    }

    const tx = this.database.sqlite.transaction(() => {
      this.requireActiveSwarm(input.swarmId);
      const worker = this.workerSnapshot(input.workerId);
      const material = prepareContinuationMaterial(
        worker,
        input,
        authenticatedTargetCarrierFingerprint,
      );
      this.assertTargetCarrierAvailable(authenticatedTargetCarrierFingerprint, input.workerId);

      const durableAttemptKey = stableAttemptKey(input.swarmId, input.workerId, input.attemptKey);
      const existing = this.getDurableByAttempt(durableAttemptKey);
      if (existing) {
        if (existing.kind !== KIND || existing.request_hash !== material.requestHash) {
          throw new ChatSwarmError("REPLAY_CONFLICT", "continuation attemptKey is bound to different material");
        }
        return { request: this.toRequest(existing), created: false };
      }

      const now = this.nowIso();
      this.persistExpiredPendingForWorker(input.workerId, now);
      const pendingCount = this.listPendingDurableForWorker(input.workerId).length;
      if (pendingCount >= MAX_PENDING_PER_WORKER) {
        throw new ChatSwarmError("CAPACITY_FULL", "too many pending continuation requests for worker");
      }

      const requestedAt = now;
      const expiresAt = new Date(this.clock().getTime() + ttlSeconds * 1000).toISOString();
      const request: PersistedRequest = {
        schema: REQUEST_SCHEMA,
        version: 1,
        swarmId: input.swarmId,
        workerId: input.workerId,
        attemptKey: input.attemptKey,
        sourceEpoch: material.sourceEpoch,
        targetEpoch: material.targetEpoch,
        sourceCarrierFingerprint: material.sourceCarrierFingerprint,
        targetCarrierFingerprint: material.targetCarrierFingerprint,
        checkpointHash: material.checkpointHash,
        requestedAt,
        expiresAt,
      };
      const operationId = newId("continuation");
      this.database.sqlite.prepare(`
        insert into durable_operations (
          operation_id,attempt_key,request_hash,kind,authority_mode,scope_root,
          workspace_id,status,retry_safe,request_json,receipt_json,error_code,
          error_message,created_at,updated_at
        ) values (?,?,?,?,?,?,null,'started','false',?,null,null,null,?,?)
      `).run(
        operationId,
        durableAttemptKey,
        material.requestHash,
        KIND,
        "OWNER_DIRECT",
        this.scopeRoot,
        JSON.stringify(request),
        requestedAt,
        requestedAt,
      );
      return { request: this.getRequest(operationId)!, created: true };
    });

    return tx.immediate();
  }

  approveRequest(
    ownerIdentityFingerprint: string,
    input: ApproveContinuationRequestInput,
  ): ChatSwarmContinuationRequest {
    assertFingerprint(ownerIdentityFingerprint, "owner identity fingerprint");
    assertBounded(input.swarmId, MAX_ID_BYTES, "swarmId");
    assertBounded(input.requestId, MAX_ID_BYTES, "requestId");
    if (!Number.isInteger(input.expectedRequestVersion) || input.expectedRequestVersion < 1) {
      throw new ChatSwarmError("INVALID_INPUT", "expectedRequestVersion must be a positive integer");
    }
    if (!Number.isInteger(input.expectedSwarmVersion) || input.expectedSwarmVersion < 1) {
      throw new ChatSwarmError("INVALID_INPUT", "expectedSwarmVersion must be a positive integer");
    }

    const tx = this.database.sqlite.transaction((): ApprovalOutcome => {
      const durable = this.requireDurable(input.requestId);
      const request = this.toRequest(durable);
      if (request.swarmId !== input.swarmId) {
        throw new ChatSwarmError("OWNERSHIP_CONFLICT", "continuation request belongs to another swarm");
      }

      const swarm = this.requireActiveSwarm(request.swarmId);
      if (String(swarm.owner_identity_fingerprint) !== ownerIdentityFingerprint) {
        throw new ChatSwarmError("OWNERSHIP_CONFLICT", "controller identity does not own swarm");
      }

      if (request.status === "APPROVED") {
        this.assertCommittedBinding(request);
        return { ok: true, request };
      }
      if (request.status === "EXPIRED") {
        this.persistExpired(input.requestId, this.nowIso());
        return { ok: false, code: "EXPIRED", message: "continuation request has expired" };
      }
      if (request.status === "SUPERSEDED") {
        return {
          ok: false,
          code: "OWNERSHIP_CONFLICT",
          message: "another continuation target already advanced this worker epoch",
        };
      }
      if (request.status === "RECONCILE_REQUIRED") {
        return {
          ok: false,
          code: "RECONCILIATION_REQUIRED",
          message: "continuation outcome requires explicit reconciliation",
        };
      }
      if (request.version !== input.expectedRequestVersion) {
        throw new ChatSwarmError(
          "VERSION_CONFLICT",
          `expected request version ${input.expectedRequestVersion} but found ${request.version}`,
        );
      }

      const now = this.nowIso();
      if (Date.parse(request.expiresAt) <= Date.parse(now)) {
        this.persistExpired(request.id, now);
        return { ok: false, code: "EXPIRED", message: "continuation request has expired" };
      }

      const swarmRevision = Number(swarm.revision ?? 1);
      if (swarmRevision !== input.expectedSwarmVersion) {
        throw new ChatSwarmError(
          "CAS_DRIFT",
          `swarm revision mismatch: expected ${input.expectedSwarmVersion} but found ${swarmRevision}`,
        );
      }

      const worker = this.workerSnapshot(request.workerId);
      assertContinuationCommitAllowed(worker, request);
      this.assertTargetCarrierAvailable(request.targetCarrierFingerprint, request.workerId);

      const workerUpdate = this.database.sqlite.prepare(`
        update chat_swarm_workers
        set carrier_conversation_fingerprint=?,continuation_epoch=?,lease_json=null,updated_at=?
        where id=? and swarm_id=? and continuation_epoch=?
          and carrier_conversation_fingerprint=? and lifecycle_state='AVAILABLE'
          and current_task_id is null
      `).run(
        request.targetCarrierFingerprint,
        request.targetEpoch,
        now,
        request.workerId,
        request.swarmId,
        request.sourceEpoch,
        request.sourceCarrierFingerprint,
      );
      if (workerUpdate.changes !== 1) {
        throw new ChatSwarmError("CAS_DRIFT", "worker binding changed during continuation transfer");
      }

      const receipt: PersistedReceipt = {
        schema: RECEIPT_SCHEMA,
        approvedAt: now,
        targetEpoch: request.targetEpoch,
        targetCarrierFingerprint: request.targetCarrierFingerprint,
        checkpointHash: request.checkpointHash,
      };
      const nextRequest = persistedFromRequest(request, request.version + 1);
      const operationUpdate = this.database.sqlite.prepare(`
        update durable_operations
        set status='succeeded',retry_safe='false',request_json=?,receipt_json=?,error_code=null,
            error_message=null,updated_at=?
        where operation_id=? and kind=? and status='started'
      `).run(
        JSON.stringify(nextRequest),
        JSON.stringify(receipt),
        now,
        request.id,
        KIND,
      );
      if (operationUpdate.changes !== 1) {
        throw new ChatSwarmError("VERSION_CONFLICT", "continuation request changed during transfer");
      }

      const swarmUpdate = this.database.sqlite.prepare(`
        update chat_swarms set revision=revision+1,updated_at=?
        where id=? and revision=? and status='ACTIVE'
      `).run(now, request.swarmId, swarmRevision);
      if (swarmUpdate.changes !== 1) {
        throw new ChatSwarmError("CAS_DRIFT", "swarm revision changed during continuation transfer");
      }

      this.supersedeCompetingRequests(request, now);
      return { ok: true, request: this.getRequest(request.id)! };
    });

    const outcome = tx.immediate();
    if (!outcome.ok) throw new ChatSwarmError(outcome.code, outcome.message);
    return outcome.request;
  }

  getRequest(requestId: string): ChatSwarmContinuationRequest | undefined {
    const row = this.database.sqlite.prepare(
      "select * from durable_operations where operation_id=? and kind=? limit 1",
    ).get(requestId, KIND) as DurableRow | undefined;
    return row ? this.toRequest(row) : undefined;
  }

  getLatestForTarget(
    swarmId: string,
    authenticatedTargetCarrierFingerprint: string,
  ): ChatSwarmContinuationRequest | undefined {
    assertFingerprint(authenticatedTargetCarrierFingerprint, "authenticated target carrier fingerprint");
    const rows = this.database.sqlite.prepare(
      "select * from durable_operations where kind=? and scope_root=? order by created_at desc,operation_id desc",
    ).all(KIND, this.scopeRoot) as DurableRow[];
    for (const row of rows) {
      const request = this.toRequest(row);
      if (
        request.swarmId === swarmId &&
        request.targetCarrierFingerprint === authenticatedTargetCarrierFingerprint
      ) return request;
    }
    return undefined;
  }

  recoverAfterRestart(): number {
    const now = this.nowIso();
    const tx = this.database.sqlite.transaction(() => {
      const rows = this.database.sqlite.prepare(`
        select * from durable_operations
        where kind=? and scope_root=? and status in ('started','outcome_unknown')
      `).all(KIND, this.scopeRoot) as DurableRow[];
      let changed = 0;
      for (const row of rows) {
        if (row.status === "outcome_unknown" && row.error_message === CONTINUATION_RESTART_MESSAGE) {
          continue;
        }
        const request = this.toRequest(row);
        const nextRequest = persistedFromRequest(request, request.version + 1);
        const result = this.database.sqlite.prepare(`
          update durable_operations
          set status='outcome_unknown',retry_safe='false',request_json=?,
              error_code='RECONCILIATION_REQUIRED',error_message=?,updated_at=?
          where operation_id=? and kind=? and status in ('started','outcome_unknown')
        `).run(
          JSON.stringify(nextRequest),
          CONTINUATION_RESTART_MESSAGE,
          now,
          row.operation_id,
          KIND,
        );
        changed += Number(result.changes);
      }
      return changed;
    });
    return tx.immediate();
  }

  reconcileUnknownNoEffect(
    ownerIdentityFingerprint: string,
    requestId: string,
  ): ChatSwarmContinuationRequest {
    assertFingerprint(ownerIdentityFingerprint, "owner identity fingerprint");
    const tx = this.database.sqlite.transaction((): ApprovalOutcome => {
      const durable = this.requireDurable(requestId);
      const request = this.toRequest(durable);
      if (request.status !== "RECONCILE_REQUIRED") {
        throw new ChatSwarmError("INVALID_STATE", "continuation request does not require reconciliation");
      }
      const swarm = this.requireActiveSwarm(request.swarmId);
      if (String(swarm.owner_identity_fingerprint) !== ownerIdentityFingerprint) {
        throw new ChatSwarmError("OWNERSHIP_CONFLICT", "controller identity does not own swarm");
      }
      const worker = this.workerSnapshot(request.workerId);
      const pendingView: ChatSwarmContinuationRequest = { ...request, status: "PENDING" };
      assertContinuationCommitAllowed(worker, pendingView);
      const now = this.nowIso();
      if (Date.parse(request.expiresAt) <= Date.parse(now)) {
        this.persistExpired(request.id, now);
        return { ok: false, code: "EXPIRED", message: "continuation request expired during reconciliation" };
      }
      const nextRequest = persistedFromRequest(request, request.version + 1);
      const result = this.database.sqlite.prepare(`
        update durable_operations
        set status='started',request_json=?,error_code=null,error_message=null,updated_at=?
        where operation_id=? and kind=? and status='outcome_unknown'
      `).run(JSON.stringify(nextRequest), now, request.id, KIND);
      if (result.changes !== 1) {
        throw new ChatSwarmError("CAS_DRIFT", "continuation reconciliation changed concurrently");
      }
      return { ok: true, request: this.getRequest(request.id)! };
    });

    const outcome = tx.immediate();
    if (!outcome.ok) throw new ChatSwarmError(outcome.code, outcome.message);
    return outcome.request;
  }

  private requireActiveSwarm(swarmId: string): Row {
    const row = this.database.sqlite.prepare(
      "select * from chat_swarms where id=? and status='ACTIVE'",
    ).get(swarmId) as Row | undefined;
    if (!row) throw new ChatSwarmError("NOT_FOUND", "swarm not found or not active");
    return row;
  }

  private workerSnapshot(workerId: string): WorkerContinuationSnapshot {
    const row = this.database.sqlite.prepare(
      "select * from chat_swarm_workers where id=?",
    ).get(workerId) as Row | undefined;
    if (!row) throw new ChatSwarmError("NOT_FOUND", "worker not found");
    let checkpoint: Record<string, unknown> | undefined;
    if (row.checkpoint_json != null) {
      try {
        const parsed = JSON.parse(String(row.checkpoint_json));
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("bad checkpoint");
        checkpoint = parsed as Record<string, unknown>;
      } catch {
        throw new ChatSwarmError("INVALID_STATE", "corrupt persisted worker checkpoint");
      }
    }
    return {
      swarmId: String(row.swarm_id),
      workerId: String(row.id),
      lifecycleState: String(row.lifecycle_state) as WorkerContinuationSnapshot["lifecycleState"],
      currentTaskId: row.current_task_id == null ? undefined : String(row.current_task_id),
      continuationEpoch: Number(row.continuation_epoch),
      carrierConversationFingerprint: row.carrier_conversation_fingerprint == null
        ? undefined
        : String(row.carrier_conversation_fingerprint),
      checkpoint,
    };
  }

  private assertTargetCarrierAvailable(targetCarrierFingerprint: string, workerId: string): void {
    const row = this.database.sqlite.prepare(`
      select id from chat_swarm_workers
      where carrier_conversation_fingerprint=? and lifecycle_state <> 'DISABLED'
      limit 1
    `).get(targetCarrierFingerprint) as Row | undefined;
    if (row && String(row.id) !== workerId) {
      throw new ChatSwarmError("OWNERSHIP_CONFLICT", "target carrier is already bound to another worker");
    }
  }

  private getDurableByAttempt(durableAttemptKey: string): DurableRow | undefined {
    return this.database.sqlite.prepare(
      "select * from durable_operations where scope_root=? and attempt_key=? limit 1",
    ).get(this.scopeRoot, durableAttemptKey) as DurableRow | undefined;
  }

  private listPendingDurableForWorker(workerId: string): DurableRow[] {
    const rows = this.database.sqlite.prepare(
      "select * from durable_operations where kind=? and scope_root=? and status='started'",
    ).all(KIND, this.scopeRoot) as DurableRow[];
    return rows.filter((row) => readPersistedRequest(row).workerId === workerId);
  }

  private persistExpiredPendingForWorker(workerId: string, now: string): void {
    for (const row of this.listPendingDurableForWorker(workerId)) {
      const request = readPersistedRequest(row);
      if (Date.parse(request.expiresAt) <= Date.parse(now)) this.persistExpired(row.operation_id, now);
    }
  }

  private supersedeCompetingRequests(
    winner: ChatSwarmContinuationRequest,
    now: string,
  ): void {
    for (const row of this.listPendingDurableForWorker(winner.workerId)) {
      if (row.operation_id === winner.id) continue;
      const other = this.toRequest(row);
      if (
        other.sourceEpoch !== winner.sourceEpoch ||
        other.sourceCarrierFingerprint !== winner.sourceCarrierFingerprint
      ) continue;
      if (Date.parse(other.expiresAt) <= Date.parse(now)) {
        this.persistExpired(other.id, now);
        continue;
      }
      const nextRequest = persistedFromRequest(other, other.version + 1);
      this.database.sqlite.prepare(`
        update durable_operations
        set status='failed',retry_safe='false',request_json=?,error_code='SUPERSEDED',
            error_message='Another continuation target atomically advanced this worker epoch.',updated_at=?
        where operation_id=? and kind=? and status='started'
      `).run(JSON.stringify(nextRequest), now, other.id, KIND);
    }
  }

  private requireDurable(requestId: string): DurableRow {
    const row = this.database.sqlite.prepare(
      "select * from durable_operations where operation_id=? and kind=? limit 1",
    ).get(requestId, KIND) as DurableRow | undefined;
    if (!row) throw new ChatSwarmError("REQUEST_NOT_FOUND", "continuation request not found");
    return row;
  }

  private persistExpired(requestId: string, now: string): void {
    const durable = this.requireDurable(requestId);
    if (durable.status !== "started" && durable.status !== "outcome_unknown") return;
    const request = this.toRequest(durable);
    const nextRequest = persistedFromRequest(request, request.version + 1);
    this.database.sqlite.prepare(`
      update durable_operations
      set status='failed',retry_safe='false',request_json=?,error_code='EXPIRED',
          error_message='Continuation request expired before transfer.',updated_at=?
      where operation_id=? and kind=? and status in ('started','outcome_unknown')
    `).run(JSON.stringify(nextRequest), now, requestId, KIND);
  }

  private assertCommittedBinding(request: ChatSwarmContinuationRequest): void {
    const worker = this.workerSnapshot(request.workerId);
    if (
      worker.continuationEpoch !== request.targetEpoch ||
      worker.carrierConversationFingerprint !== request.targetCarrierFingerprint
    ) {
      throw new ChatSwarmError("RECONCILIATION_REQUIRED", "approved continuation does not match current worker binding");
    }
  }

  private toRequest(row: DurableRow): ChatSwarmContinuationRequest {
    if (row.kind !== KIND || row.authority_mode !== "OWNER_DIRECT") {
      throw new ChatSwarmError("INVALID_STATE", "durable continuation operation authority is malformed");
    }
    const persisted = readPersistedRequest(row);
    const requestHash = continuationMaterialHash(persisted);
    if (requestHash !== row.request_hash) {
      throw new ChatSwarmError("INVALID_STATE", "persisted continuation request hash mismatch");
    }

    let status: ChatSwarmContinuationRequest["status"];
    if (row.status === "started") {
      status = Date.parse(persisted.expiresAt) <= this.clock().getTime() ? "EXPIRED" : "PENDING";
    } else if (row.status === "succeeded") status = "APPROVED";
    else if (row.status === "failed" && row.error_code === "EXPIRED") status = "EXPIRED";
    else if (row.status === "failed" && row.error_code === "SUPERSEDED") status = "SUPERSEDED";
    else if (row.status === "outcome_unknown") status = "RECONCILE_REQUIRED";
    else throw new ChatSwarmError("INVALID_STATE", `unsupported durable continuation status '${row.status}'`);

    let approvedAt: string | undefined;
    if (row.receipt_json) {
      try {
        const receipt = JSON.parse(row.receipt_json) as PersistedReceipt;
        if (receipt.schema !== RECEIPT_SCHEMA) throw new Error("receipt schema mismatch");
        if (
          receipt.targetEpoch !== persisted.targetEpoch ||
          receipt.targetCarrierFingerprint !== persisted.targetCarrierFingerprint ||
          receipt.checkpointHash !== persisted.checkpointHash ||
          !Number.isFinite(Date.parse(receipt.approvedAt))
        ) throw new Error("receipt binding mismatch");
        approvedAt = receipt.approvedAt;
      } catch {
        throw new ChatSwarmError("INVALID_STATE", "corrupt persisted continuation receipt");
      }
    }

    return {
      id: row.operation_id,
      swarmId: persisted.swarmId,
      workerId: persisted.workerId,
      attemptKey: persisted.attemptKey,
      requestHash: row.request_hash,
      sourceEpoch: persisted.sourceEpoch,
      targetEpoch: persisted.targetEpoch,
      sourceCarrierFingerprint: persisted.sourceCarrierFingerprint,
      targetCarrierFingerprint: persisted.targetCarrierFingerprint,
      checkpointHash: persisted.checkpointHash,
      version: persisted.version,
      status,
      requestedAt: persisted.requestedAt,
      expiresAt: persisted.expiresAt,
      approvedAt,
    };
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }
}

function stableAttemptKey(swarmId: string, workerId: string, attemptKey: string): string {
  return `continuation:${createHash("sha256")
    .update(JSON.stringify({ swarmId, workerId, attemptKey }))
    .digest("hex")}`;
}

function continuationMaterialHash(request: PersistedRequest): string {
  return createHash("sha256").update(JSON.stringify({
    checkpointHash: request.checkpointHash,
    sourceCarrierFingerprint: request.sourceCarrierFingerprint,
    sourceEpoch: request.sourceEpoch,
    swarmId: request.swarmId,
    targetCarrierFingerprint: request.targetCarrierFingerprint,
    targetEpoch: request.targetEpoch,
    workerId: request.workerId,
  })).digest("hex");
}

function persistedFromRequest(
  request: ChatSwarmContinuationRequest,
  version: number,
): PersistedRequest {
  return {
    schema: REQUEST_SCHEMA,
    version,
    swarmId: request.swarmId,
    workerId: request.workerId,
    attemptKey: request.attemptKey,
    sourceEpoch: request.sourceEpoch,
    targetEpoch: request.targetEpoch,
    sourceCarrierFingerprint: request.sourceCarrierFingerprint,
    targetCarrierFingerprint: request.targetCarrierFingerprint,
    checkpointHash: request.checkpointHash,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
  };
}

function readPersistedRequest(row: DurableRow): PersistedRequest {
  let request: PersistedRequest;
  try {
    request = JSON.parse(row.request_json) as PersistedRequest;
  } catch {
    throw new ChatSwarmError("INVALID_STATE", "corrupt persisted continuation request");
  }
  validatePersistedRequest(request);
  return request;
}

function validatePersistedRequest(request: PersistedRequest): void {
  if (!request || request.schema !== REQUEST_SCHEMA) {
    throw new ChatSwarmError("INVALID_STATE", "persisted continuation request schema mismatch");
  }
  if (!Number.isSafeInteger(request.version) || request.version < 1) {
    throw new ChatSwarmError("INVALID_STATE", "persisted continuation request version is malformed");
  }
  for (const [label, value] of [
    ["source carrier fingerprint", request.sourceCarrierFingerprint],
    ["target carrier fingerprint", request.targetCarrierFingerprint],
    ["checkpoint hash", request.checkpointHash],
  ] as const) assertFingerprint(value, label);
  if (
    !Number.isSafeInteger(request.sourceEpoch) ||
    request.sourceEpoch < 0 ||
    request.targetEpoch !== request.sourceEpoch + 1
  ) {
    throw new ChatSwarmError("INVALID_STATE", "persisted continuation epoch binding is malformed");
  }
  if (!request.swarmId || !request.workerId || !request.attemptKey) {
    throw new ChatSwarmError("INVALID_STATE", "persisted continuation identity is incomplete");
  }
  if (!Number.isFinite(Date.parse(request.requestedAt)) || !Number.isFinite(Date.parse(request.expiresAt))) {
    throw new ChatSwarmError("INVALID_STATE", "persisted continuation timestamps are malformed");
  }
}

function assertFingerprint(value: string, label: string): void {
  if (!SHA256.test(value)) {
    throw new ChatSwarmError("INVALID_INPUT", `${label} must be a SHA-256 fingerprint`);
  }
}
