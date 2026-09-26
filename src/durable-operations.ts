import { CutoverBuildNotReadyError } from "./cutover-build-ready.js";
import type { SelfRestartActuator } from "./cutover-restart.js";
import type { CompletionSelection } from "./current-completion-matrix.js";
import { isDeepStrictEqual } from "node:util";
import { McpCutoverController, compareServerIdentity, type DurableReconciliationWitness } from "./mcp-cutover.js";
import { CutoverStateStore, type CutoverServerIdentity, type CutoverDrainEvidence, type BuildReadyReceipt, type ExpectedCutoverIdentity, type CutoverCoordinationBinding } from "./cutover-state.js";
import { ControlPlaneConsumer, type ControlPlaneConsumerOptions, type DependencyReconciliationEvidence } from "./control-plane-consumer.js";
import { ControlPlaneOwnershipError, ControlPlaneOwnershipStore, type HandoffInput, type TakeoverInput, type ReconciliationReceipt } from "./control-plane-ownership.js";
import { createHash } from "node:crypto";
import { spawn as nativeSpawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath, canonicalizePath, isPathInsideRoot } from "./roots.js";
import { EXECUTION_PROTOCOL_VERSION, type ExecutionAuthorityMode } from "./execution-protocol.js";

const spawn = nativeSpawn;
const crossSpawn = createRequire(import.meta.url)("cross-spawn") as typeof import("node:child_process").spawn;

export type DurableOperationKind =
  | "workspace_clone"
  | "dependency_sync"
  | "nexus_gateway_recover"
  | "nexus_gateway_recovery_preflight"
  | "nexus_gateway_recovery_materialize"
  | "cutover_start"
  | "host_operation"
  | "chat_swarm_reconciliation";
export type DurableOperationStatus = "started" | "succeeded" | "failed" | "outcome_unknown";
export type DependencySyncRecipe = "npm_ci" | "pnpm_frozen" | "uv_frozen";

export interface CutoverStartInput {
  attemptKey: string;
  currentIdentity: CutoverServerIdentity;
  expectedIdentity: ExpectedCutoverIdentity;
  expiresAt?: string;
}

/** One exact request identity for preparation and execution; creates no durable state. */
export function planCutoverStart(stateDir: string, input: CutoverStartInput) {
  assertAttemptKey(input.attemptKey);
  const snapshot = JSON.parse(JSON.stringify(input)) as CutoverStartInput;
  const stateRoot = canonicalizePath(stateDir);
  const request = {version:EXECUTION_PROTOCOL_VERSION,baseRevision:snapshot.currentIdentity.sourceCommit,stateRoot,currentIdentity:snapshot.currentIdentity,expectedIdentity:snapshot.expectedIdentity,expiresAt:snapshot.expiresAt};
  const requestHash = hashJson(request);
  const operationId = stableOperationId("cutover_start",stateRoot,snapshot.attemptKey);
  const subject = {operationId,requestHash,workspaceRoot:stateRoot,baseRevision:request.baseRevision,operation:"cutover_start" as const};
  return {snapshot,stateRoot,request,requestHash,operationId,subject};
}
export function cutoverTerminalRecordHash(record: NonNullable<ReturnType<CutoverStateStore["get"]>>) {
  const {expired,...durable}=record;
  return hashJson(durable);
}

import {
  NexusRecoveryAdapter,
  NEXUS_GATEWAY_RECOVERY_SCHEMA,
  NEXUS_GATEWAY_INTERPRETER,
  NEXUS_GATEWAY_ACCEPTED_MANAGER_SHA256,
  NEXUS_GATEWAY_ACCEPTED_CONTRACT_SHA256,
  NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_SCHEMA,
  NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_RECEIPT_SCHEMA,
  NEXUS_GATEWAY_STATE_ROOT,
  type NexusGatewayRecoveryRequest,
  type NexusGatewayRecoveryInput,
  type NexusGatewayRecoveryBridgeResult,
  type NexusGatewayRecoveryReceipt,
  type NexusGatewayRecoveryMaterializationReceipt,
  type NexusGatewayRecoveryMaterializationRequest,
  type NexusGatewayRecoveryMaterializationInput,
  type NexusGatewayPreflightResult,
  type NexusGatewayRecoveryPreflightResult,
  type NexusGatewayRecoveryRunner,
  type NexusGatewayRecoveryMaterializationRunner,
  assertNexusGatewayRecoveryRequest,
  assertNexusGatewayRecoveryMaterializationRequest,
  validateNexusGatewayPreflightReceipt,
  validateNexusGatewayRecoveryReceipt,
  validateNexusGatewayMaterializationReceipt,
  buildNexusGatewayRecoveryBridgeCode,
  NEXUS_GATEWAY_RECOVERY_BRIDGE_CODE,
  spawnNexusGatewayRecovery,
  buildNexusGatewayRecoveryPreflightBridgeCode,
  NEXUS_GATEWAY_RECOVERY_PREFLIGHT_BRIDGE_CODE,
  spawnNexusGatewayRecoveryPreflight,
  buildNexusGatewayRecoveryMaterializationBridgeCode,
  NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_BRIDGE_CODE,
  spawnNexusGatewayRecoveryMaterialize,
} from "./nexus-recovery-adapter.js";

export interface DurableOperationRecord {
  operationId: string;
  attemptKey: string;
  requestHash: string;
  kind: DurableOperationKind;
  authorityMode: ExecutionAuthorityMode;
  scopeRoot: string;
  workspaceId?: string;
  status: DurableOperationStatus;
  retrySafe: boolean;
  request: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

interface DurableOperationRow {
  operation_id: string;
  attempt_key: string;
  request_hash: string;
  kind: string;
  authority_mode: string;
  scope_root: string;
  workspace_id: string | null;
  status: string;
  retry_safe: string;
  request_json: string;
  receipt_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export class DurableOperationError extends Error {
  constructor(
    readonly code:
      | "INVALID_ATTEMPT_KEY"
      | "OPERATION_REPLAY_CONFLICT"
      | "OPERATION_IN_PROGRESS"
      | "OPERATION_OUTCOME_UNKNOWN"
      | "DESTINATION_OUTSIDE_ALLOWED_ROOT"
      | "DESTINATION_NOT_EMPTY"
      | "REMOTE_CREDENTIALS_NOT_ALLOWED"
      | "CLONE_FAILED"
      | "DEPENDENCY_RECIPE_UNSUPPORTED"
      | "DEPENDENCY_SYNC_FAILED"
      | "FROZEN_INPUT_CHANGED"
      | "NEXUS_GATEWAY_REQUEST_INVALID"
      | "NEXUS_GATEWAY_PREFLIGHT_FAILED"
      | "NEXUS_GATEWAY_RECOVERY_FAILED"
      | "NEXUS_GATEWAY_RECOVERY_UNCERTAIN"
      | "NEXUS_GATEWAY_MATERIALIZATION_FAILED"
      | "NEXUS_GATEWAY_MATERIALIZATION_UNCERTAIN"
      | "RECONCILIATION_REQUIRED",
    message: string,
    readonly operation?: DurableOperationRecord,
  ) {
    super(message);
    this.name = "DurableOperationError";
  }
}

export class DurableOperationStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  close(): void {
    this.database.close();
  }

  createOwnershipStore(options: ControlPlaneConsumerOptions): ControlPlaneOwnershipStore {
    return new ControlPlaneOwnershipStore(this.database.sqlite, {
      ...options,
      resolveOwnerContext: context => {
        const owner = options.resolveOwnerContext?.(context);
        return owner && Object.freeze({...owner});
      },
      verifyGrantEvidence: (grant, owner) => options.verifyGrantEvidence?.(Object.freeze({...grant}), Object.freeze({...owner})) === true,
    });
  }

  atomic<T>(work: () => T): T { return this.database.sqlite.transaction(work).immediate(); }

  recordDependencyTerminal(operationId: string, requestHash: string, leaseId: string, exitCode: number, frozenInputsUnchanged: boolean): void {
    if (!Number.isSafeInteger(exitCode)) throw new Error("Invalid terminal exit status");
    this.database.sqlite.prepare("insert into dependency_terminal_witnesses(operation_id,request_hash,lease_id,exit_code,frozen_inputs_unchanged) values(?,?,?,?,?)")
      .run(operationId,requestHash,leaseId,exitCode,frozenInputsUnchanged?1:0);
  }

  markInterruptedUnknown(): number {
    const now = new Date().toISOString();
    const preflight = this.database.sqlite.prepare(`
      update durable_operations
      set status = 'outcome_unknown', retry_safe = 'false',
          error_code = 'RECONCILIATION_REQUIRED',
          error_message = 'DevSpace restarted while the read-only Gateway preflight was nonterminal; reconcile the same stored request.',
          updated_at = ?
      where status = 'started' and kind = 'nexus_gateway_recovery_preflight'
    `).run(now);
    const result = this.database.sqlite.prepare(`
      update durable_operations
      set status = 'outcome_unknown', retry_safe = 'false',
          error_code = 'RECONCILIATION_REQUIRED',
          error_message = 'DevSpace restarted while the mutating operation was nonterminal; reconcile physical state before any replay.',
          updated_at = ?
      where status = 'started'
        and kind not in ('dependency_sync', 'cutover_start', 'nexus_gateway_recovery_preflight')
    `).run(now);
    return result.changes + preflight.changes;
  }

  getByOperationId(operationId: string): DurableOperationRecord | undefined {
    const row = this.database.sqlite.prepare(
      "select * from durable_operations where operation_id = ? limit 1",
    ).get(operationId) as DurableOperationRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  list(kind?: DurableOperationKind): DurableOperationRecord[] {
    const rows = (kind
      ? this.database.sqlite.prepare(
          "select * from durable_operations where kind = ? order by updated_at desc",
        ).all(kind)
      : this.database.sqlite.prepare(
          "select * from durable_operations order by updated_at desc",
        ).all()) as DurableOperationRow[];
    return rows.map(rowToRecord);
  }

  getByAttempt(scopeRoot: string, attemptKey: string): DurableOperationRecord | undefined {
    const row = this.database.sqlite.prepare(
      "select * from durable_operations where scope_root = ? and attempt_key = ? limit 1",
    ).get(canonicalizePath(scopeRoot), attemptKey) as DurableOperationRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  createOrReplay(input: Omit<DurableOperationRecord, "createdAt" | "updatedAt" | "status" | "retrySafe">): {
    record: DurableOperationRecord;
    created: boolean;
  } {
    const transact = this.database.sqlite.transaction(() => {
      const existing = this.getByAttempt(input.scopeRoot, input.attemptKey);
      if (existing) {
        if (existing.requestHash !== input.requestHash || existing.kind !== input.kind) {
          throw new DurableOperationError(
            "OPERATION_REPLAY_CONFLICT",
            `attemptKey '${input.attemptKey}' is already bound to a materially different ${existing.kind} request.`,
            existing,
          );
        }
        return { record: existing, created: false };
      }
      const now = new Date().toISOString();
      this.database.sqlite.prepare(`
        insert into durable_operations (
          operation_id, attempt_key, request_hash, kind, authority_mode,
          scope_root, workspace_id, status, retry_safe, request_json,
          receipt_json, error_code, error_message, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, 'started', 'false', ?, null, null, null, ?, ?)
      `).run(
        input.operationId,
        input.attemptKey,
        input.requestHash,
        input.kind,
        input.authorityMode,
        canonicalizePath(input.scopeRoot),
        input.workspaceId ?? null,
        JSON.stringify(input.request),
        now,
        now,
      );
      return { record: this.getByOperationId(input.operationId)!, created: true };
    });
    return transact.immediate();
  }

  finish(
    operationId: string,
    patch: {
      status: Exclude<DurableOperationStatus, "started">;
      retrySafe: boolean;
      receipt?: Record<string, unknown>;
      errorCode?: string;
      errorMessage?: string;
    },
  ): DurableOperationRecord {
    const now = new Date().toISOString();
    this.database.sqlite.prepare(`
      update durable_operations
      set status = ?, retry_safe = ?, receipt_json = coalesce(?, receipt_json), error_code = ?, error_message = ?, updated_at = ?
      where operation_id = ?
    `).run(
      patch.status,
      String(patch.retrySafe),
      patch.receipt ? JSON.stringify(patch.receipt) : null,
      patch.errorCode ?? null,
      patch.errorMessage ?? null,
      now,
      operationId,
    );
    const record = this.getByOperationId(operationId);
    if (!record) throw new Error(`Unknown durable operation: ${operationId}`);
    return record;
  }

  finishHostOperation(
    operationId: string,
    patch: Parameters<DurableOperationStore["finish"]>[1],
  ): DurableOperationRecord {
    const now = new Date().toISOString();
    const result = this.database.sqlite.prepare(`
      update durable_operations
      set status = ?, retry_safe = ?, receipt_json = coalesce(?, receipt_json), error_code = ?, error_message = ?, updated_at = ?
      where operation_id = ? and kind = 'host_operation' and status = 'started'
    `).run(patch.status, String(patch.retrySafe), patch.receipt ? JSON.stringify(patch.receipt) : null, patch.errorCode ?? null, patch.errorMessage ?? null, now, operationId);
    const record = this.getByOperationId(operationId);
    if (!record) throw new Error(`Unknown durable operation: ${operationId}`);
    if (result.changes !== 1 && record.status === "started") throw new DurableOperationError("OPERATION_IN_PROGRESS", `Host operation ${operationId} changed concurrently.` , record);
    return record;
  }

  recordHostOperationReceipt(operationId: string, receipt: Record<string, unknown>): DurableOperationRecord {
    const result = this.database.sqlite.prepare(
      "update durable_operations set receipt_json = ?, updated_at = ? where operation_id = ? and kind = 'host_operation' and status = 'started'",
    ).run(JSON.stringify(receipt), new Date().toISOString(), operationId);
    const record = this.getByOperationId(operationId);
    if (!record) throw new Error(`Unknown durable operation: ${operationId}`);
    if (result.changes !== 1) throw new DurableOperationError("OPERATION_IN_PROGRESS", `Host operation ${operationId} changed concurrently.`, record);
    return record;
  }
}

export interface WorkspaceCloneInput {
  attemptKey: string;
  remote: string;
  destination: string;
  ref?: string;
  authorityMode?: ExecutionAuthorityMode;
}

export interface DependencySyncInput {
  attemptKey: string;
  workspaceId: string;
  workspaceRoot: string;
  recipe: DependencySyncRecipe;
  authorityMode?: ExecutionAuthorityMode;
}

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

export class DurableOperationManager {
  readonly store: DurableOperationStore;
  private readonly consumer?: ControlPlaneConsumer;

  readonly recoveryAdapter: NexusRecoveryAdapter;

  constructor(
    private readonly config: ServerConfig,
    private readonly runCommand: CommandRunner = spawnCommand,
    runNexusGatewayRecovery?: NexusGatewayRecoveryRunner,
    runNexusGatewayRecoveryPreflight?: NexusGatewayRecoveryRunner,
    coordination?: ControlPlaneConsumerOptions,
    runNexusGatewayRecoveryMaterialize?: NexusGatewayRecoveryMaterializationRunner,
  ) {
    this.store = new DurableOperationStore(config.stateDir);
    this.store.markInterruptedUnknown();
    this.recoveryAdapter = new NexusRecoveryAdapter(this.store, {
      runRecovery: runNexusGatewayRecovery,
      runPreflight: runNexusGatewayRecoveryPreflight,
      runMaterialize: runNexusGatewayRecoveryMaterialize,
    });
    if (coordination) this.consumer = new ControlPlaneConsumer(this.store.createOwnershipStore(coordination), coordination);
  }

  close(): void {
    this.store.close();
  }

  async workspaceClone(input: WorkspaceCloneInput): Promise<DurableOperationRecord> {
    assertAttemptKey(input.attemptKey);
    const authorityMode = input.authorityMode ?? "OWNER_DIRECT";
    if (authorityMode !== "OWNER_DIRECT") {
      throw new DurableOperationError(
        "RECONCILIATION_REQUIRED",
        "NEXUS_GOVERNED workspace bootstrap is not self-authorizing; G9 must provide validated Nexus authority evidence.",
      );
    }
    assertCredentialFreeRemote(input.remote);
    const destination = canonicalizePath(
      assertAllowedDestination(input.destination, this.config.allowedRoots),
    );
    const scopeRoot = matchingAllowedRoot(destination, this.config.allowedRoots);

    const request = {
      version: EXECUTION_PROTOCOL_VERSION,
      remote: sanitizeRemote(input.remote),
      destination,
      ref: input.ref,
    };
    const requestHash = hashJson(request);
    const operationId = stableOperationId("workspace_clone", scopeRoot, input.attemptKey);
    const existing = this.store.getByAttempt(scopeRoot, input.attemptKey);
    if (existing) {
      if (existing.requestHash !== requestHash || existing.kind !== "workspace_clone") {
        throw new DurableOperationError(
          "OPERATION_REPLAY_CONFLICT",
          `attemptKey '${input.attemptKey}' is already bound to a materially different ${existing.kind} request.`,
          existing,
        );
      }
      return replayResult(existing);
    }

    await assertNewOrEmptyDestination(destination);
    const { record, created } = this.store.createOrReplay({
      operationId,
      attemptKey: input.attemptKey,
      requestHash,
      kind: "workspace_clone",
      authorityMode,
      scopeRoot,
      request,
    });
    if (!created) return replayResult(record);

    const args = ["clone", "--", input.remote, destination];
    if (input.ref) args.splice(1, 0, "--branch", input.ref, "--single-branch");
    const result = await this.runCommand("git", args, scopeRoot);
    if (result.exitCode !== 0) {
      return this.store.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "CLONE_FAILED",
        errorMessage: redactSecrets(result.stderr || `git clone exited ${result.exitCode}`),
        receipt: { destination, remote: sanitizeRemote(input.remote), ref: input.ref },
      });
    }

    const head = await readGitHead(destination);
    return this.store.finish(operationId, {
      status: "succeeded",
      retrySafe: false,
      receipt: {
        destination,
        remote: sanitizeRemote(input.remote),
        ref: input.ref,
        head,
        openable: existsSync(resolve(destination, ".git")),
      },
    });
  }

  startCutover(input: CutoverStartInput, context?: unknown): DurableOperationRecord {
    if (!this.consumer) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", "cutover start requires trusted host authority");
    const {snapshot,stateRoot,request,requestHash,operationId,subject} = planCutoverStart(this.config.stateDir,input);
    const consumer = this.consumer;
    const intent = this.store.atomic(() => {
      const binding = consumer.authorize(context,subject);
      if (binding.role !== "controller") throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED","cutover requires controller authority");
      const existing = this.store.getByOperationId(operationId);
      if (existing) {
        if (existing.requestHash !== requestHash || existing.kind !== "cutover_start") throw new DurableOperationError("OPERATION_REPLAY_CONFLICT","cutover attempt changed",existing);
        return {record:existing,created:false};
      }
      const coordinationBinding = consumer.pinCutover(context,subject,binding);
      return this.store.createOrReplay({operationId,attemptKey:snapshot.attemptKey,requestHash,kind:"cutover_start",authorityMode:"OWNER_DIRECT",scopeRoot:stateRoot,request:{...request,coordinationBinding}});
    });
    if (!intent.created) return this.reconcileCutoverStart(operationId,context);
    try {
      // Keep the committed intent/pin across crashes; this second transaction
      // serializes participating writers but cannot roll back the cutover file.
      return this.store.atomic(() => {
        const binding = consumer.authorize(context,subject);
        const currentPin = consumer.cutoverBinding(context,subject,binding,binding.leaseVersion);
        if (!isDeepStrictEqual(currentPin,intent.record.request.coordinationBinding) || !isDeepStrictEqual(this.store.getByOperationId(operationId),intent.record)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","cutover intent or pin changed before file write");
        const controller = new McpCutoverController(new CutoverStateStore(stateRoot),snapshot.currentIdentity);
        controller.begin(snapshot.expectedIdentity,snapshot.expiresAt,intent.record.request.coordinationBinding as unknown as CutoverCoordinationBinding);
        return this.reconcileCutoverStart(operationId,context);
      });
    } catch (error) {
      return this.store.atomic(() => {
        if (!isDeepStrictEqual(this.store.getByOperationId(operationId),intent.record)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","late cutover result cannot overwrite newer durable state");
        const binding = consumer.authorize(context,subject);
        if (!isDeepStrictEqual(consumer.cutoverBinding(context,subject,binding,binding.leaseVersion),intent.record.request.coordinationBinding)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","late cutover result no longer owns the original pin");
        if (!isDeepStrictEqual(this.store.getByOperationId(operationId),intent.record)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","cutover intent changed during unknown-result authority check");
        return this.store.finish(operationId,{status:"outcome_unknown",retrySafe:false,errorCode:"RECONCILIATION_REQUIRED",errorMessage:error instanceof Error?error.message:String(error)});
      });
    }
  }

  reconcileCutoverStart(operationId: string, context?: unknown): DurableOperationRecord {
    if (!this.consumer) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED","cutover reconciliation requires trusted host authority");
    const consumer = this.consumer;
    return this.store.atomic(() => {
      const record = this.store.getByOperationId(operationId);
      if (!record || record.kind !== "cutover_start" || typeof record.request.baseRevision !== "string" || record.scopeRoot !== canonicalizePath(this.config.stateDir)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","cutover intent is not bound to this state resource");
      const {coordinationBinding: persistedBinding, ...request} = record.request;
      if (hashJson(request) !== record.requestHash || request.stateRoot !== record.scopeRoot || !persistedBinding) throw new ControlPlaneOwnershipError("CAS_CONFLICT","cutover intent digest or resource is malformed");
      const subject = {operationId,requestHash:record.requestHash,workspaceRoot:record.scopeRoot,baseRevision:record.request.baseRevision,operation:"cutover_start" as const};
      const binding = consumer.authorize(context,subject);
      consumer.cutoverBinding(context,subject,binding,binding.leaseVersion);
      const observed = new CutoverStateStore(record.scopeRoot).get();
      if (!observed || !observed.coordinationBinding || observed.coordinationBinding.leaseId !== binding.leaseId || observed.coordinationBinding.operationHandle !== operationId || observed.coordinationBinding.requestHash !== record.requestHash || !record.request.coordinationBinding || !isDeepStrictEqual(observed.coordinationBinding,record.request.coordinationBinding) || !isDeepStrictEqual(observed.oldServerIdentity,record.request.currentIdentity) || !isDeepStrictEqual(observed.expectedNewIdentity,record.request.expectedIdentity) || observed.expiresAt !== record.request.expiresAt) throw new DurableOperationError("RECONCILIATION_REQUIRED","cutover outcome lacks exact persisted correlation; no retry or release is authorized",record);
      // The cutover file and SQLite are separate stores. Keep the lifecycle pin.
      if (!isDeepStrictEqual(this.store.getByOperationId(operationId),record)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","cutover intent changed during readback");
      if (record.status === "succeeded") return record;
      return this.store.finish(operationId,{status:"succeeded",retrySafe:false,receipt:{cutoverId:observed.cutoverId,coordinationBinding:observed.coordinationBinding,startVerified:true,lifecycleTerminal:false}});
    });
  }

  drainCutover(cutoverId: string, currentIdentity: CutoverServerIdentity, readTransportEvidence: () => CutoverDrainEvidence, context?: unknown) {
    if(!this.consumer) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED","cutover drain requires trusted host authority");
    const consumer=this.consumer;
    const identity=Object.freeze({...currentIdentity});
    return this.store.atomic(()=>{
      const cutoverStore=new CutoverStateStore(canonicalizePath(this.config.stateDir));
      const observed=cutoverStore.get();
      if(!observed?.coordinationBinding || observed.cutoverId!==cutoverId) throw new ControlPlaneOwnershipError("CAS_CONFLICT","drain requires exact bound cutover generation");
      const intent=this.reconcileCutoverStart(observed.coordinationBinding.operationHandle,context);
      const subject={operationId:intent.operationId,requestHash:intent.requestHash,workspaceRoot:intent.scopeRoot,baseRevision:intent.request.baseRevision as string,operation:"cutover_start" as const};
      const action={action:"drain" as const,cutoverId,currentIdentity:identity};
      const binding=consumer.authorizeCutoverLifecycle(context,subject,action);
      if(!isDeepStrictEqual(observed.oldServerIdentity,identity)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","drain runtime identity does not match original generation");
      if(!isDeepStrictEqual(cutoverStore.get(),observed)||!isDeepStrictEqual(this.store.getByOperationId(intent.operationId),intent)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","drain generation changed during approval");
      if(observed.phase==="drained") return observed;
      if(observed.phase!=="prepared") throw new ControlPlaneOwnershipError("CAS_CONFLICT","drain requires prepared or already drained generation");
      const evidence=JSON.parse(JSON.stringify(readTransportEvidence())) as CutoverDrainEvidence;
      const current=consumer.authorizeCutoverLifecycle(context,subject,action);
      if(!isDeepStrictEqual(current,binding)||!isDeepStrictEqual(cutoverStore.get(),observed)||!isDeepStrictEqual(this.store.getByOperationId(intent.operationId),intent)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","drain binding changed during evidence collection");
      // Same DB fence; file effects cannot be rolled back by a SQLite failure.
      return new McpCutoverController(cutoverStore,identity).recordDrain(cutoverId,evidence);
    });
  }

  async restartCutover(cutoverId:string, currentIdentity:CutoverServerIdentity, buildReady:BuildReadyReceipt, probe:(expected:ExpectedCutoverIdentity)=>{buildReady:boolean;detail:string}|Promise<{buildReady:boolean;detail:string}>, actuator:SelfRestartActuator, context?:unknown) {
    if(!this.consumer) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED","restart requires trusted host authority");
    const consumer=this.consumer,identity=Object.freeze({...currentIdentity});
    const target=Object.freeze({actuator:actuator.actuator,serviceLabel:actuator.serviceLabel,launchdTarget:actuator.launchdTarget});
    const schedule=actuator.schedule,ready=Object.freeze({...buildReady});
    const action={action:"restart" as const,cutoverId,currentIdentity:identity,buildReady:ready,actuator:target};
    const cutoverStore=new CutoverStateStore(canonicalizePath(this.config.stateDir));
    const readBound=()=>{
      const file=cutoverStore.get();
      if(!file?.coordinationBinding||file.cutoverId!==cutoverId||file.phase!=="drained"||!isDeepStrictEqual(file.oldServerIdentity,identity)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","restart requires exact drained original runtime binding");
      const intent=this.reconcileCutoverStart(file.coordinationBinding.operationHandle,context);
      const subject={operationId:intent.operationId,requestHash:intent.requestHash,workspaceRoot:intent.scopeRoot,baseRevision:intent.request.baseRevision as string,operation:"cutover_start" as const};
      const binding=consumer.authorizeCutoverLifecycle(context,subject,action);
      if(schedule!==actuator.schedule||!isDeepStrictEqual(target,{actuator:actuator.actuator,serviceLabel:actuator.serviceLabel,launchdTarget:actuator.launchdTarget})) throw new ControlPlaneOwnershipError("CAS_CONFLICT","restart actuator binding changed");
      if(file.restartRequest && (!isDeepStrictEqual(file.restartRequest.buildReady,ready)||file.restartRequest.requestedByServerInstanceId!==identity.serverInstanceId||file.restartRequest.actuator!==target.actuator)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","restart marker action binding mismatch");
      if(intent.receipt?.restartAction && !isDeepStrictEqual(intent.receipt.restartAction,action)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","restart action changed");
      if(!isDeepStrictEqual(cutoverStore.get(),file)||!isDeepStrictEqual(this.store.getByOperationId(intent.operationId),intent)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","restart binding changed during approval");
      return {file,intent,subject,binding};
    };
    const initial=this.store.atomic(()=>{
      const current=readBound();
      if(current.file.restartRequest) {
        if(!current.intent.receipt?.restartAction) throw new ControlPlaneOwnershipError("CAS_CONFLICT","restart marker lacks bound action; reconciliation required");
        return {...current,replay:true};
      }
      this.store.finish(current.intent.operationId,{status:"succeeded",retrySafe:false,receipt:{...current.intent.receipt,restartAction:action,restartState:"requested"}});
      new McpCutoverController(cutoverStore,identity).requestRestart(cutoverId,ready);
      return {...readBound(),replay:false};
    });
    if(initial.replay) return {record:initial.file,scheduled:false,outcome:"outcome_unknown" as const};
    const result=await probe(Object.freeze({...initial.file.expectedNewIdentity}));
    if(result.buildReady!==true) throw new CutoverBuildNotReadyError(result.detail);
    return this.store.atomic(()=>{
      const current=readBound();
      const {replay,...expected}=initial;
      if(!isDeepStrictEqual(current,expected)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","restart binding changed during probe");
      const marked=new McpCutoverController(cutoverStore,identity).markRestartScheduled(cutoverId);
      // Durable file marker precedes the external actuator; errors keep the pin.
      const scheduled=readBound();
      if(!isDeepStrictEqual(scheduled.binding,current.binding)||!isDeepStrictEqual(scheduled.intent,current.intent)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","restart authority changed after scheduling marker");
      if(marked.newlyScheduled) schedule.call(actuator);
      return {record:marked.record,scheduled:marked.newlyScheduled,outcome:"outcome_unknown" as const};
    });
  }

  async finishCutover(cutoverId: string, currentIdentity: CutoverServerIdentity, preferredPair: {workspaceId:string;agentId:string}, reconcile: () => Promise<DurableReconciliationWitness>, context?: unknown) {
    if(!this.consumer) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED","cutover finish requires trusted host authority");
    const consumer=this.consumer;
    const identity=Object.freeze({...currentIdentity}),pair=Object.freeze({...preferredPair});
    const action={action:"finish" as const,cutoverId,currentIdentity:identity,preferredPair:pair};
    const cutoverStore=new CutoverStateStore(canonicalizePath(this.config.stateDir));
    const digest=cutoverTerminalRecordHash;
    const readBound=()=>{
      const file=cutoverStore.get();
      if(!file?.coordinationBinding||file.cutoverId!==cutoverId) throw new ControlPlaneOwnershipError("CAS_CONFLICT","finish requires exact bound cutover generation");
      const intent=this.store.getByOperationId(file.coordinationBinding.operationHandle);
      if(!intent||intent.kind!=="cutover_start"||intent.scopeRoot!==canonicalizePath(this.config.stateDir)||typeof intent.request.baseRevision!=="string") throw new ControlPlaneOwnershipError("CAS_CONFLICT","finish intent binding is missing");
      const {coordinationBinding,...request}=intent.request;
      if(hashJson(request)!==intent.requestHash||request.stateRoot!==intent.scopeRoot||!isDeepStrictEqual(coordinationBinding,file.coordinationBinding)||!isDeepStrictEqual(request.currentIdentity,file.oldServerIdentity)||!isDeepStrictEqual(request.expectedIdentity,file.expectedNewIdentity)||request.expiresAt!==file.expiresAt) throw new ControlPlaneOwnershipError("CAS_CONFLICT","finish intent or file correlation changed");
      const subject={operationId:intent.operationId,requestHash:intent.requestHash,workspaceRoot:intent.scopeRoot,baseRevision:intent.request.baseRevision,operation:"cutover_start" as const};
      const replay=intent.receipt?.lifecycleTerminal===true;
      const {binding,recovery}=consumer.authorizeCutoverFinish(context,subject,action,replay,intent.receipt?.expiredLeaseRecovery as ReconciliationReceipt|undefined);
      if(binding.leaseId!==file.coordinationBinding.leaseId) throw new ControlPlaneOwnershipError("CAS_CONFLICT","finish authorized lease differs from generation");
      const comparison=compareServerIdentity(file,identity);
      if(!Object.values(comparison).every(Boolean)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","finish replacement runtime identity mismatch");
      const expiredPreparedRecovery=recovery&&file.phase==="prepared"&&!file.drainEvidence&&!file.restartRequest;
      const activePreparedReplacement=!recovery&&file.phase==="prepared"&&!file.drainEvidence&&!file.restartRequest&&Object.values(comparison).every(Boolean);
      if(file.phase!=="drained"&&file.phase!=="closed"&&!expiredPreparedRecovery&&!activePreparedReplacement) throw new ControlPlaneOwnershipError("CAS_CONFLICT","bound finish requires drained generation unless an exact prepared replacement or expired prepared recovery applies");
      if(replay&&(file.phase!=="closed"||intent.receipt?.terminalRecordHash!==digest(file)||!isDeepStrictEqual(intent.receipt?.lifecycleAction,action))) throw new ControlPlaneOwnershipError("CAS_CONFLICT","terminal replay receipt mismatch");
      return {file,intent,subject,binding,replay,recovery,expiredPreparedRecovery,activePreparedReplacement};
    };
    const validWitness=(w:DurableReconciliationWitness|undefined)=>!!w&&w.workspaceQueryable===true&&w.agentQueryable===true&&w.agentReconciled===true&&w.witnessWorkspaceId===pair.workspaceId&&w.witnessAgentId===pair.agentId;
    const initial=this.store.atomic(readBound);
    let witness:DurableReconciliationWitness|undefined;
    if(initial.file.phase!=="closed") witness=JSON.parse(JSON.stringify(await reconcile())) as DurableReconciliationWitness;
    return this.store.atomic(()=>{
      const current=readBound();
      if(!isDeepStrictEqual(current,initial)||!isDeepStrictEqual(cutoverStore.get(),current.file)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","finish binding changed while reconciliation was pending");
      if(current.file.phase!=="closed") {
        if(!validWitness(witness)) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED","finish requires positive exact workspace/agent witness");
        const controller=new McpCutoverController(cutoverStore,identity);
        if(current.expiredPreparedRecovery||current.activePreparedReplacement) controller.finishExpiredPreparedRecoveryWithWitness(cutoverId,witness!);
        else controller.finishWithWitness(cutoverId,witness!);
      }
      const closed=cutoverStore.get();const receipt=closed?.reconciliationReceipt;
      if(!closed||closed.phase!=="closed"||closed.cutoverId!==cutoverId||!isDeepStrictEqual(closed.coordinationBinding,current.file.coordinationBinding)||!validWitness(receipt)||receipt?.closedByServerInstanceId!==identity.serverInstanceId||!Number.isFinite(Date.parse(receipt.reconciledAt))||Date.parse(receipt.reconciledAt)>Date.now()) throw new ControlPlaneOwnershipError("CAS_CONFLICT","closed file lacks exact terminal witness");
      if(current.replay) return closed;
      const expiredLeaseRecovery=current.recovery ? consumer.reconcileCutoverFinish(context,current.subject,action,current.binding,JSON.stringify({kind:"cutover_terminal",cutoverId,requestHash:current.subject.requestHash,terminalRecordHash:digest(closed)})) : undefined;
      if(!current.recovery) consumer.finish(context,current.subject,current.binding,current.binding.leaseVersion);
      if(!isDeepStrictEqual(cutoverStore.get(),closed)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","terminal file changed during final authority check");
      if(!isDeepStrictEqual(this.store.getByOperationId(current.intent.operationId),current.intent)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","terminal intent changed during final authority check");
      this.store.finish(current.intent.operationId,{status:"succeeded",retrySafe:false,receipt:{...current.intent.receipt,lifecycleTerminal:true,terminalRecordHash:digest(closed),lifecycleAction:action,...(expiredLeaseRecovery?{expiredLeaseRecovery}:{})}});
      return closed;
    });
  }

  readCompletion(selection: CompletionSelection, context?: unknown) {
    if(!this.consumer) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED","completion read requires trusted host authority");
    return this.consumer.readCompletion(context,selection);
  }

  handoff(leaseId: string, expectedVersion: number, recipientHandle: string, receipt: HandoffInput, context?: unknown) {
    if (!this.consumer) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED","handoff requires trusted host authority");
    return this.consumer.handoff(context,leaseId,expectedVersion,recipientHandle,receipt);
  }

  readHandoff(leaseId: string, previousVersion: number, expectedCurrentVersion: number, consumerContext?: unknown) {
    if (!this.consumer) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", "handoff readback requires trusted host authority");
    return this.consumer.readHandoff(consumerContext, leaseId, previousVersion, expectedCurrentVersion);
  }

  latestContinuation(context?: unknown) {
    if (!this.consumer) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", "continuation discovery requires trusted host authority");
    return this.consumer.latestContinuation(context);
  }

  takeover(leaseId: string, expectedVersion: number, input: TakeoverInput, context?: unknown) {
    if (!this.consumer) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", "takeover requires trusted host authority");
    return this.consumer.takeover(context, leaseId, expectedVersion, input);
  }

  readTakeover(leaseId: string, previousVersion: number, expectedCurrentVersion: number, context?: unknown) {
    if (!this.consumer) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", "takeover readback requires trusted host authority");
    return this.consumer.readTakeover(context, leaseId, previousVersion, expectedCurrentVersion);
  }

  async planDependencySync(input: DependencySyncInput) {
    assertAttemptKey(input.attemptKey);
    const authorityMode = input.authorityMode ?? "OWNER_DIRECT";
    if (authorityMode !== "OWNER_DIRECT") {
      throw new DurableOperationError(
        "RECONCILIATION_REQUIRED",
        "NEXUS_GOVERNED dependency sync is not self-authorizing; G9 must provide validated Nexus authority evidence.",
      );
    }
    const workspaceRoot = canonicalizePath(input.workspaceRoot);
    if (!this.config.allowedRoots.some((root) => isPathInsideRoot(workspaceRoot, canonicalizePath(root))) &&
        !isPathInsideRoot(workspaceRoot, canonicalizePath(this.config.worktreeRoot))) {
      throw new DurableOperationError("DESTINATION_OUTSIDE_ALLOWED_ROOT", `Workspace is outside configured roots: ${workspaceRoot}`);
    }

    const frozenInputs = recipeFrozenInputs(input.recipe);
    const before = await hashFiles(workspaceRoot, frozenInputs);
    const baseRevision = await readGitHead(workspaceRoot);
    if (!baseRevision) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", "dependency workspace revision cannot be verified");
    const request = {
      version: EXECUTION_PROTOCOL_VERSION,
      baseRevision,
      workspaceId: input.workspaceId,
      workspaceRoot,
      recipe: input.recipe,
      frozenInputs: before,
    };
    const requestHash = hashJson(request);
    const operationId = stableOperationId("dependency_sync", workspaceRoot, input.attemptKey);
    const subject = {operationId, requestHash, workspaceRoot, baseRevision, operation: "dependency_sync" as const};
    return {subject, request, workspaceRoot, authorityMode, frozenInputs, before, baseRevision, requestHash, operationId};
  }

  async dependencySync(input: DependencySyncInput, consumerContext?: unknown): Promise<DurableOperationRecord> {
    if (!this.consumer) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", "dependency sync requires a trusted host authority reader");
    const consumer = this.consumer;
    const {subject, request, workspaceRoot, authorityMode, frozenInputs, before, baseRevision, requestHash, operationId} = await this.planDependencySync(input);
    const { record, created, binding, pinnedVersion } = this.store.atomic(() => {
      const binding = consumer.authorize(consumerContext, subject);
      const value = this.store.createOrReplay({
      operationId,
      attemptKey: input.attemptKey,
      requestHash,
      kind: "dependency_sync",
      authorityMode,
      scopeRoot: workspaceRoot,
      workspaceId: input.workspaceId,
      request,
      });
      const pinnedVersion = value.created ? consumer.pin(consumerContext, subject, binding) : binding.leaseVersion;
      return {...value, binding, pinnedVersion};
    });
    if (!created) return replayResult(record);

    const finish = (patch: Parameters<DurableOperationStore["finish"]>[1]) => this.store.atomic(() => {
      consumer.finish(consumerContext, subject, binding, pinnedVersion);
      return this.store.finish(operationId, patch);
    });
    try {
    if (await readGitHead(workspaceRoot) !== baseRevision || hashJson(await hashFiles(workspaceRoot, frozenInputs)) !== hashJson(before)) {
      throw new Error("Frozen dependency input or base revision changed before launch");
    }
    consumer.assertPinned(consumerContext, subject, binding, pinnedVersion);
    const command = dependencyCommand(input.recipe);
    const result = await this.runCommand(command.command, command.args, workspaceRoot);
    if (result.exitCode === null) throw new Error("Command termination is unconfirmed");
    const after = await hashFiles(workspaceRoot, frozenInputs);
    const frozenInputsUnchanged = hashJson(before) === hashJson(after) && await readGitHead(workspaceRoot) === baseRevision;
    this.store.recordDependencyTerminal(operationId,requestHash,binding.leaseId,result.exitCode,frozenInputsUnchanged);
    if (!frozenInputsUnchanged) {
      return finish({
        status: "failed",
        retrySafe: false,
        errorCode: "FROZEN_INPUT_CHANGED",
        errorMessage: "Dependency specification or lock input changed during a FROZEN dependency sync.",
        receipt: { recipe: input.recipe, before, after, exitCode: result.exitCode },
      });
    }
    if (result.exitCode !== 0) {
      return finish({
        status: "failed",
        retrySafe: false,
        errorCode: "DEPENDENCY_SYNC_FAILED",
        errorMessage: redactSecrets(result.stderr || `${command.command} exited ${result.exitCode}`),
        receipt: { recipe: input.recipe, frozenInputs: after, exitCode: result.exitCode },
      });
    }
    return finish({
      status: "succeeded",
      retrySafe: false,
      receipt: { recipe: input.recipe, frozenInputs: after, exitCode: result.exitCode },
    });
    } catch (error) {
      return this.store.atomic(() => {
        if (JSON.stringify(this.store.getByOperationId(operationId)) !== JSON.stringify(record)) {
          throw new ControlPlaneOwnershipError("CAS_CONFLICT", "late dependency result cannot overwrite a newer durable outcome");
        }
        return this.store.finish(operationId, {status: "outcome_unknown", retrySafe:false, errorCode:"RECONCILIATION_REQUIRED", errorMessage: redactSecrets(error instanceof Error ? error.message : String(error))});
      });
    }
  }

  reconcileDependencySync(operationId: string, evidence: DependencyReconciliationEvidence, consumerContext?: unknown): DurableOperationRecord {
    if (!this.consumer) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", "dependency reconciliation requires trusted host authority");
    const consumer = this.consumer;
    const proof = Object.freeze(structuredClone(evidence));
    return this.store.atomic(() => {
      const record = this.store.getByOperationId(operationId);
      if (!record || record.kind !== "dependency_sync" || typeof record.request.baseRevision !== "string") {
        throw new ControlPlaneOwnershipError("CAS_CONFLICT", "no revision-bound dependency operation to reconcile");
      }
      const subject = {operationId, requestHash:record.requestHash, workspaceRoot:record.scopeRoot, baseRevision:record.request.baseRevision, operation:"dependency_sync" as const};
      consumer.reconcile(consumerContext, subject, proof);
      if (JSON.stringify(this.store.getByOperationId(operationId)) !== JSON.stringify(record)) throw new ControlPlaneOwnershipError("CAS_CONFLICT", "durable operation changed during reconciliation");
      if (record.status === "succeeded" || record.status === "failed") return record;
      return this.store.finish(operationId, {
        status: proof.exitCode === 0 && proof.frozenInputsUnchanged && proof.state === "finished" ? "succeeded" : "failed",
        retrySafe:false,
        receipt: {reconciliation:proof},
      });
    });
  }

  async nexusGatewayRecover(input: NexusGatewayRecoveryInput): Promise<DurableOperationRecord> {
    return await this.recoveryAdapter.recover(input);
  }

  async nexusGatewayRecoveryPreflight(input: NexusGatewayRecoveryInput): Promise<NexusGatewayPreflightResult> {
    return await this.recoveryAdapter.preflight(input);
  }

  async nexusGatewayRecoveryPreflightStart(input: NexusGatewayRecoveryInput): Promise<DurableOperationRecord> {
    return await this.recoveryAdapter.preflightStart(input);
  }

  async nexusGatewayRecoveryMaterialize(input: NexusGatewayRecoveryMaterializationInput): Promise<DurableOperationRecord> {
    return await this.recoveryAdapter.materialize(input);
  }

  async reconcile(operationId: string, consumerContext?: unknown): Promise<DurableOperationRecord> {
    const record = this.store.getByOperationId(operationId);
    if (!record) throw new DurableOperationError("RECONCILIATION_REQUIRED", `Unknown durable operation: ${operationId}`);
    if (record.kind === "cutover_start") return this.reconcileCutoverStart(operationId,consumerContext);
    if (record.kind === "dependency_sync") {
      if (!this.consumer || typeof record.request.baseRevision !== "string") throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", "dependency reconciliation requires revision-bound host authority");
      const subject = {operationId, requestHash:record.requestHash, workspaceRoot:record.scopeRoot, baseRevision:record.request.baseRevision, operation:"dependency_sync" as const};
      return this.reconcileDependencySync(operationId, this.consumer.readReconciliation(consumerContext, subject), consumerContext);
    }
    if (
      record.kind === "nexus_gateway_recovery_preflight"
      || record.kind === "nexus_gateway_recover"
      || record.kind === "nexus_gateway_recovery_materialize"
    ) {
      return await this.recoveryAdapter.reconcile(record);
    }

    if (record.kind === "workspace_clone") {
      const destination = String(record.request.destination ?? "");
      const expectedRemote = String(record.request.remote ?? "");
      const head = await readGitHead(destination);
      const remote = await readGitRemote(destination);
      if (head && remote && sanitizeRemote(remote) === expectedRemote) {
        return this.store.finish(operationId, {
          status: "succeeded",
          retrySafe: false,
          receipt: { destination, remote: expectedRemote, head, reconciled: true, openable: true },
        });
      }
      return this.store.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "RECONCILIATION_REQUIRED",
        errorMessage: "Clone physical state does not prove a complete matching repository; manual cleanup or explicit recovery is required.",
        receipt: { destination, observedHead: head, observedRemote: remote ? sanitizeRemote(remote) : undefined, reconciled: true },
      });
    }

    throw new DurableOperationError("RECONCILIATION_REQUIRED", "Unsupported durable operation kind");
  }
}

function replayResult(record: DurableOperationRecord): DurableOperationRecord {
  if (record.status === "started") {
    throw new DurableOperationError("OPERATION_IN_PROGRESS", `Operation ${record.operationId} is already started.`, record);
  }
  if (record.status === "outcome_unknown") {
    throw new DurableOperationError(
      "OPERATION_OUTCOME_UNKNOWN",
      `Operation ${record.operationId} has uncertain physical effects; reconcile it instead of replaying mutation.`,
      record,
    );
  }
  return record;
}

function rowToRecord(row: DurableOperationRow): DurableOperationRecord {
  return {
    operationId: row.operation_id,
    attemptKey: row.attempt_key,
    requestHash: row.request_hash,
    kind: row.kind as DurableOperationKind,
    authorityMode: row.authority_mode as ExecutionAuthorityMode,
    scopeRoot: row.scope_root,
    workspaceId: row.workspace_id ?? undefined,
    status: row.status as DurableOperationStatus,
    retrySafe: row.retry_safe === "true",
    request: JSON.parse(row.request_json) as Record<string, unknown>,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) as Record<string, unknown> : undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertAttemptKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
    throw new DurableOperationError("INVALID_ATTEMPT_KEY", "attemptKey must be a bounded stable operation identity.");
  }
}


export function stableOperationId(kind: DurableOperationKind, scopeRoot: string, attemptKey: string): string {
  return `op_${createHash("sha256").update(`${kind}\0${resolve(scopeRoot)}\0${attemptKey}`).digest("hex").slice(0, 16)}`;
}

function assertAllowedDestination(destination: string, roots: readonly string[]): string {
  try {
    return assertAllowedPath(destination, [...roots]);
  } catch (error) {
    throw new DurableOperationError(
      "DESTINATION_OUTSIDE_ALLOWED_ROOT",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function matchingAllowedRoot(destination: string, roots: readonly string[]): string {
  const canonicalDestination = canonicalizePath(destination);
  const matches = roots
    .map((root) => canonicalizePath(root))
    .filter((root) => isPathInsideRoot(canonicalDestination, root))
    .sort((a, b) => b.length - a.length);
  if (!matches[0]) throw new DurableOperationError("DESTINATION_OUTSIDE_ALLOWED_ROOT", `No allowed root contains ${destination}`);
  return matches[0];
}

async function assertNewOrEmptyDestination(destination: string): Promise<void> {
  try {
    const info = await stat(destination);
    if (!info.isDirectory()) {
      throw new DurableOperationError("DESTINATION_NOT_EMPTY", `Clone destination already exists and is not a directory: ${destination}`);
    }
    const { readdir } = await import("node:fs/promises");
    if ((await readdir(destination)).length > 0) {
      throw new DurableOperationError("DESTINATION_NOT_EMPTY", `Clone destination must be new or empty: ${destination}`);
    }
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno?.code === "ENOENT") return;
    throw error;
  }
}

function assertCredentialFreeRemote(remote: string): void {
  try {
    const url = new URL(remote);
    if (url.username || url.password) {
      throw new DurableOperationError(
        "REMOTE_CREDENTIALS_NOT_ALLOWED",
        "Credential-bearing Git URLs are not accepted. Use a credential helper and a credential-free remote URL.",
      );
    }
  } catch (error) {
    if (error instanceof DurableOperationError) throw error;
    // Local paths and SCP-like Git remotes are allowed; receipts still redact obvious credentials.
  }
}

function sanitizeRemote(remote: string): string {
  return redactSecrets(remote);
}

function redactSecrets(value: string): string {
  return value
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|access_token|password|secret)=)[^&\s]+/gi, "$1[redacted]");
}


export function durableOperationId(kind: DurableOperationKind, scopeRoot: string, attemptKey: string): string {
  assertAttemptKey(attemptKey);
  return stableOperationId(kind, scopeRoot, attemptKey);
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
}

export function hashDurableRequest(value: unknown): string {
  return hashJson(value);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function recipeFrozenInputs(recipe: DependencySyncRecipe): string[] {
  if (recipe === "npm_ci") return ["package.json", "package-lock.json"];
  if (recipe === "pnpm_frozen") return ["package.json", "pnpm-lock.yaml"];
  if (recipe === "uv_frozen") return ["pyproject.toml", "uv.lock"];
  throw new DurableOperationError("DEPENDENCY_RECIPE_UNSUPPORTED", `Unsupported dependency recipe: ${recipe}`);
}

function dependencyCommand(recipe: DependencySyncRecipe): { command: string; args: string[] } {
  if (recipe === "npm_ci") {
    return { command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"] };
  }
  if (recipe === "pnpm_frozen") {
    return { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts"] };
  }
  if (recipe === "uv_frozen") {
    return { command: "uv", args: ["sync", "--frozen"] };
  }
  throw new DurableOperationError("DEPENDENCY_RECIPE_UNSUPPORTED", `Unsupported dependency recipe: ${recipe}`);
}

async function hashFiles(root: string, paths: string[]): Promise<Record<string, string | null>> {
  const output: Record<string, string | null> = {};
  for (const path of paths) {
    const absolute = resolve(root, path);
    if (!isPathInsideRoot(absolute, root)) throw new Error(`Frozen input escaped workspace: ${path}`);
    try {
      output[path] = createHash("sha256").update(await readFile(absolute)).digest("hex");
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno?.code === "ENOENT") output[path] = null;
      else throw error;
    }
  }
  return output;
}

async function readGitHead(root: string): Promise<string | undefined> {
  if (!existsSync(root)) return undefined;
  try {
    const result = await spawnCommand("git", ["rev-parse", "HEAD"], root);
    return result.exitCode === 0 ? result.stdout.trim().toLowerCase() || undefined : undefined;
  } catch {
    return undefined;
  }
}

async function readGitRemote(root: string): Promise<string | undefined> {
  if (!existsSync(root)) return undefined;
  try {
    const result = await spawnCommand("git", ["remote", "get-url", "origin"], root);
    return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}


async function spawnCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const commandSpawn = process.platform === "win32" && /^(npm|pnpm)\.cmd$/i.test(command)
      ? crossSpawn
      : spawn;
    const child = commandSpawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", rejectPromise);
    child.on("close", (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
  });
}

export {
  NEXUS_GATEWAY_RECOVERY_SCHEMA,
  NEXUS_GATEWAY_INTERPRETER,
  NEXUS_GATEWAY_ACCEPTED_MANAGER_SHA256,
  NEXUS_GATEWAY_ACCEPTED_CONTRACT_SHA256,
  NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_SCHEMA,
  NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_RECEIPT_SCHEMA,
  NEXUS_GATEWAY_STATE_ROOT,
  type NexusGatewayRecoveryRequest,
  type NexusGatewayRecoveryInput,
  type NexusGatewayRecoveryBridgeResult,
  type NexusGatewayRecoveryReceipt,
  type NexusGatewayRecoveryMaterializationReceipt,
  type NexusGatewayRecoveryMaterializationRequest,
  type NexusGatewayRecoveryMaterializationInput,
  type NexusGatewayPreflightResult,
  type NexusGatewayRecoveryPreflightResult,
  type NexusGatewayRecoveryRunner,
  type NexusGatewayRecoveryMaterializationRunner,
  assertNexusGatewayRecoveryRequest,
  assertNexusGatewayRecoveryMaterializationRequest,
  validateNexusGatewayPreflightReceipt,
  validateNexusGatewayRecoveryReceipt,
  validateNexusGatewayMaterializationReceipt,
  buildNexusGatewayRecoveryBridgeCode,
  NEXUS_GATEWAY_RECOVERY_BRIDGE_CODE,
  spawnNexusGatewayRecovery,
  buildNexusGatewayRecoveryPreflightBridgeCode,
  NEXUS_GATEWAY_RECOVERY_PREFLIGHT_BRIDGE_CODE,
  spawnNexusGatewayRecoveryPreflight,
  buildNexusGatewayRecoveryMaterializationBridgeCode,
  NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_BRIDGE_CODE,
  spawnNexusGatewayRecoveryMaterialize,
  NexusRecoveryAdapter,
} from "./nexus-recovery-adapter.js";
