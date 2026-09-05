import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath, canonicalizePath, isPathInsideRoot } from "./roots.js";
import { EXECUTION_PROTOCOL_VERSION, type ExecutionAuthorityMode } from "./execution-protocol.js";

export type DurableOperationKind =
  | "workspace_clone"
  | "dependency_sync"
  | "nexus_gateway_recover"
  | "nexus_task_card_authority_switch"
  | "nexus_task_card_authority_restore";
export type DurableOperationStatus = "started" | "succeeded" | "failed" | "outcome_unknown";
export type DependencySyncRecipe = "npm_ci" | "pnpm_frozen" | "uv_frozen";

const SAFE_NEXUS_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const NEXUS_DEPLOYMENT_ID = /^r1-[0-9a-f]{40}$/;
export const NEXUS_GATEWAY_RECOVERY_SCHEMA = "nexus.gateway.durable_recovery_request.v2" as const;
export const NEXUS_GATEWAY_INTERPRETER = "/Users/jameschen/Workspace/Nexus-new/.venv/bin/python";
export const NEXUS_GATEWAY_ACCEPTED_MANAGER_SHA256 = "7af3760bd2b6729654a89d7b07fa4c43bb9b323e8e0006a08aa5e485d78562ac";
export const NEXUS_GATEWAY_ACCEPTED_CONTRACT_SHA256 = "be6918bc5b328dfbf8c50387e88f983ce33f0096542cc22109f75fbe6250ab5e";
export const NEXUS_GATEWAY_STATE_ROOT = join(homedir(), "Library", "Application Support", "Nexus", "gateway-direct");
export const NEXUS_STANDING_GRANT_AUTHORITY_ROOT = join(homedir(), ".local", "state", "nexus", "authority");
export const NEXUS_STANDING_GRANT_PATH = join(NEXUS_STANDING_GRANT_AUTHORITY_ROOT, "standing-grant.json");
export const NEXUS_STANDING_GRANT_BACKUP_PATH = join(NEXUS_STANDING_GRANT_AUTHORITY_ROOT, ".devspace-task-card-authority-backup.json");

export interface StandingGrantRepositoryIdentity {
  repository_id: string;
  canonical_remote: string;
}

export interface StandingGrantContext {
  schema: "nexus.standing_grant_context.v1";
  owner_id: string;
  coordinator_id: string;
  repository: StandingGrantRepositoryIdentity;
  thread_id: string;
  goal_id: string;
  allowed_actions: string[];
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  context_hash: string;
}

export interface StandingGrantReceipt {
  schema: "nexus.standing_grant_receipt.v1";
  grant_id: string;
  context: StandingGrantContext;
  receipt_hash: string;
  supersedes_grant_hash: string | null;
}

export interface NexusTaskCardAuthoritySwitchInput {
  attemptKey: string;
  expectedCurrentReceiptHash: string;
  expectedCurrentGoalId: string;
  successorGoalId: string;
  successorThreadId: string;
  ttlMinutes?: number;
  ownerConfirmation: boolean;
}

export interface NexusTaskCardAuthorityRestoreInput {
  attemptKey: string;
  switchOperationId: string;
  expectedTemporaryReceiptHash: string;
  ownerConfirmation: boolean;
}

export interface NexusGatewayRecoveryRequest {
  request_id: string;
  idempotency_fence: string;
  operation: "gateway-recover";
  effect_class: "GATEWAY_DURABLE_RECOVERY";
  recovery_authority_id: string;
  recovery_authority_hash: string;
  desired_manifest_id: string;
  desired_manifest_hash: string;
  predecessor_manifest_id: string;
  predecessor_manifest_hash: string;
  request_hash: string;
  schema: typeof NEXUS_GATEWAY_RECOVERY_SCHEMA;
}

export interface NexusGatewayRecoveryInput {
  attemptKey: string;
  request: NexusGatewayRecoveryRequest;
}

export interface NexusGatewayRecoveryBridgeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface NexusGatewayRecoveryPreflightResult {
  status: "passed" | "error";
  effectStarted: boolean;
  readiness: string[];
  outcome?: Record<string, unknown>;
  errorMessage?: string;
}

export type NexusGatewayRecoveryRunner = (
  request: NexusGatewayRecoveryRequest,
) => Promise<NexusGatewayRecoveryBridgeResult>;

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
      | "NEXUS_GATEWAY_RECOVERY_FAILED"
      | "NEXUS_GATEWAY_RECOVERY_UNCERTAIN"
      | "NEXUS_AUTHORITY_SWITCH_INVALID"
      | "NEXUS_AUTHORITY_SWITCH_FAILED"
      | "NEXUS_AUTHORITY_RESTORE_INVALID"
      | "NEXUS_AUTHORITY_RESTORE_FAILED"
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

  markInterruptedUnknown(): number {
    const now = new Date().toISOString();
    const result = this.database.sqlite.prepare(`
      update durable_operations
      set status = 'outcome_unknown', retry_safe = 'false',
          error_code = 'RECONCILIATION_REQUIRED',
          error_message = 'DevSpace restarted while the mutating operation was nonterminal; reconcile physical state before any replay.',
          updated_at = ?
      where status = 'started'
    `).run(now);
    return result.changes;
  }

  getByOperationId(operationId: string): DurableOperationRecord | undefined {
    const row = this.database.sqlite.prepare(
      "select * from durable_operations where operation_id = ? limit 1",
    ).get(operationId) as DurableOperationRow | undefined;
    return row ? rowToRecord(row) : undefined;
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
      set status = ?, retry_safe = ?, receipt_json = ?, error_code = ?, error_message = ?, updated_at = ?
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

  constructor(
    private readonly config: ServerConfig,
    private readonly runCommand: CommandRunner = spawnCommand,
    private readonly runNexusGatewayRecovery: NexusGatewayRecoveryRunner = spawnNexusGatewayRecovery,
    private readonly runNexusGatewayRecoveryPreflight: NexusGatewayRecoveryRunner = spawnNexusGatewayRecoveryPreflight,
    private readonly standingGrantPath: string = NEXUS_STANDING_GRANT_PATH,
    private readonly standingGrantBackupPath: string = NEXUS_STANDING_GRANT_BACKUP_PATH,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new DurableOperationStore(config.stateDir);
    this.store.markInterruptedUnknown();
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

  async dependencySync(input: DependencySyncInput): Promise<DurableOperationRecord> {
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
    const request = {
      version: EXECUTION_PROTOCOL_VERSION,
      workspaceId: input.workspaceId,
      workspaceRoot,
      recipe: input.recipe,
      frozenInputs: before,
    };
    const requestHash = hashJson(request);
    const operationId = stableOperationId("dependency_sync", workspaceRoot, input.attemptKey);
    const { record, created } = this.store.createOrReplay({
      operationId,
      attemptKey: input.attemptKey,
      requestHash,
      kind: "dependency_sync",
      authorityMode,
      scopeRoot: workspaceRoot,
      workspaceId: input.workspaceId,
      request,
    });
    if (!created) return replayResult(record);

    const command = dependencyCommand(input.recipe);
    const result = await this.runCommand(command.command, command.args, workspaceRoot);
    const after = await hashFiles(workspaceRoot, frozenInputs);
    if (hashJson(before) !== hashJson(after)) {
      return this.store.finish(operationId, {
        status: "failed",
        retrySafe: false,
        errorCode: "FROZEN_INPUT_CHANGED",
        errorMessage: "Dependency specification or lock input changed during a FROZEN dependency sync.",
        receipt: { recipe: input.recipe, before, after, exitCode: result.exitCode },
      });
    }
    if (result.exitCode !== 0) {
      return this.store.finish(operationId, {
        status: "failed",
        retrySafe: false,
        errorCode: "DEPENDENCY_SYNC_FAILED",
        errorMessage: redactSecrets(result.stderr || `${command.command} exited ${result.exitCode}`),
        receipt: { recipe: input.recipe, frozenInputs: after, exitCode: result.exitCode },
      });
    }
    return this.store.finish(operationId, {
      status: "succeeded",
      retrySafe: false,
      receipt: { recipe: input.recipe, frozenInputs: after, exitCode: result.exitCode },
    });
  }

  async nexusGatewayRecover(input: NexusGatewayRecoveryInput): Promise<DurableOperationRecord> {
    assertAttemptKey(input.attemptKey);
    assertNexusGatewayRecoveryRequest(input.request);
    const scopeRoot = NEXUS_GATEWAY_STATE_ROOT;
    const request = { recoveryRequest: input.request };
    const requestHash = hashJson(request);
    const operationId = stableOperationId("nexus_gateway_recover", scopeRoot, input.attemptKey);
    const existing = this.store.getByAttempt(scopeRoot, input.attemptKey);
    if (existing) {
      if (existing.requestHash !== requestHash || existing.kind !== "nexus_gateway_recover") {
        throw new DurableOperationError(
          "OPERATION_REPLAY_CONFLICT",
          `attemptKey '${input.attemptKey}' is already bound to a materially different ${existing.kind} request.`,
          existing,
        );
      }
      return replayResult(existing);
    }

    const { record, created } = this.store.createOrReplay({
      operationId,
      attemptKey: input.attemptKey,
      requestHash,
      kind: "nexus_gateway_recover",
      authorityMode: "NEXUS_GOVERNED",
      scopeRoot,
      request,
    });
    if (!created) return replayResult(record);
    return await this.executeNexusGatewayRecovery(operationId, input.request, false);
  }

  async nexusGatewayRecoveryPreflight(input: NexusGatewayRecoveryInput): Promise<NexusGatewayRecoveryPreflightResult> {
    assertAttemptKey(input.attemptKey);
    assertNexusGatewayRecoveryRequest(input.request);
    let bridge: NexusGatewayRecoveryBridgeResult;
    try {
      bridge = await this.runNexusGatewayRecoveryPreflight(input.request);
    } catch (error) {
      return {
        status: "error",
        effectStarted: false,
        readiness: [],
        errorMessage: redactSecrets(error instanceof Error ? error.message : String(error)),
      };
    }
    if (bridge.exitCode !== 0) {
      return {
        status: "error",
        effectStarted: false,
        readiness: [],
        errorMessage: redactSecrets(
          bridge.stderr.trim() || `Preflight bridge exited ${String(bridge.exitCode)}.`,
        ),
      };
    }
    let outcome: Record<string, unknown>;
    try {
      const parsed = JSON.parse(bridge.stdout);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("outcome must be an object");
      outcome = parsed as Record<string, unknown>;
    } catch (error) {
      return {
        status: "error",
        effectStarted: false,
        readiness: [],
        errorMessage: `Preflight bridge returned malformed outcome JSON: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      };
    }
    const effectStarted = Boolean(outcome.effect_started);
    const result = String(outcome.result ?? "");
    const physicalObservation = (outcome.physical_observation ?? {}) as Record<string, unknown>;
    const readiness = Array.isArray(physicalObservation.readiness)
      ? (physicalObservation.readiness as unknown[]).map(String)
      : [];
    if (effectStarted) {
      return {
        status: "error",
        effectStarted: true,
        readiness,
        errorMessage: "Preflight must not start effects; gateway_recover() started an effect.",
      };
    }
    if (result !== "BLOCKED") {
      return {
        status: "error",
        effectStarted,
        readiness,
        errorMessage: `Preflight expected result=BLOCKED, got '${redactSecrets(result)}'.`,
      };
    }
    return {
      status: "passed",
      effectStarted: false,
      readiness,
      outcome,
    };
  }

  async nexusTaskCardAuthoritySwitch(input: NexusTaskCardAuthoritySwitchInput): Promise<DurableOperationRecord> {
    assertAttemptKey(input.attemptKey);
    if (input.ownerConfirmation !== true) {
      throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "ownerConfirmation must be explicitly true.");
    }
    for (const [field, value] of [
      ["expectedCurrentReceiptHash", input.expectedCurrentReceiptHash],
      ["expectedCurrentGoalId", input.expectedCurrentGoalId],
      ["successorGoalId", input.successorGoalId],
      ["successorThreadId", input.successorThreadId],
    ] as const) {
      if (field.endsWith("Hash")) {
        if (!HEX64.test(value)) throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", `${field} must be 64 lowercase hex characters.`);
      } else if (!SAFE_NEXUS_ID.test(value)) {
        throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", `${field} must be a bounded safe identifier.`);
      }
    }
    const ttlMinutes = input.ttlMinutes ?? 20;
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 30) {
      throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "ttlMinutes must be an integer between 1 and 30.");
    }

    const scopeRoot = dirname(resolve(this.standingGrantPath));
    const inputBinding = {
      expectedCurrentReceiptHash: input.expectedCurrentReceiptHash,
      expectedCurrentGoalId: input.expectedCurrentGoalId,
      successorGoalId: input.successorGoalId,
      successorThreadId: input.successorThreadId,
      ttlMinutes,
      ownerConfirmation: true,
    };
    const inputHash = hashJson(inputBinding);
    const existing = this.store.getByAttempt(scopeRoot, input.attemptKey);
    if (existing) {
      if (existing.kind !== "nexus_task_card_authority_switch" || existing.request.inputHash !== inputHash) {
        throw new DurableOperationError(
          "OPERATION_REPLAY_CONFLICT",
          `attemptKey '${input.attemptKey}' is already bound to a materially different ${existing.kind} request.`,
          existing,
        );
      }
      return replayResult(existing);
    }

    const predecessor = await readSecureStandingGrantReceipt(this.standingGrantPath, "NEXUS_AUTHORITY_SWITCH_INVALID");
    if (predecessor.receipt_hash !== input.expectedCurrentReceiptHash) {
      throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Current standing-grant receipt hash does not match expectedCurrentReceiptHash.");
    }
    if (predecessor.context.goal_id !== input.expectedCurrentGoalId) {
      throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Current standing-grant Goal does not match expectedCurrentGoalId.");
    }
    if (
      predecessor.context.repository.repository_id !== "James3014/Nexus-new" ||
      predecessor.context.repository.canonical_remote !== "https://github.com/James3014/Nexus-new.git"
    ) {
      throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Standing grant is not bound to the fixed Nexus repository identity.");
    }
    if (predecessor.context.revoked_at !== null || predecessor.context.revocation_reason !== null) {
      throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Current standing grant is revoked.");
    }
    if (
      predecessor.context.allowed_actions.length !== 1 ||
      predecessor.context.allowed_actions[0] !== "GITHUB_MERGE"
    ) {
      throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Task Card bootstrap requires predecessor actions to be exactly [GITHUB_MERGE].");
    }

    const now = this.now();
    const predecessorExpiry = Date.parse(predecessor.context.expires_at);
    if (!Number.isFinite(predecessorExpiry) || predecessorExpiry <= now) {
      throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Current standing grant is expired.");
    }
    const issuedAt = nexusCanonicalUtcTimestamp(now);
    const expiresAt = nexusCanonicalUtcTimestamp(Math.min(now + ttlMinutes * 60_000, predecessorExpiry));
    const temporaryContext = issueStandingGrantContext({
      owner_id: predecessor.context.owner_id,
      coordinator_id: predecessor.context.coordinator_id,
      repository: predecessor.context.repository,
      thread_id: input.successorThreadId,
      goal_id: input.successorGoalId,
      allowed_actions: ["TASK_CARD_COMMIT", "TASK_CARD_CREATE"],
      issued_at: issuedAt,
      expires_at: expiresAt,
      revoked_at: null,
      revocation_reason: null,
    });
    const temporaryReceipt = issueStandingGrantReceipt({
      grant_id: `devspace-task-card-${hashJson({ attemptKey: input.attemptKey, inputHash }).slice(0, 24)}`,
      context: temporaryContext,
      supersedes_grant_hash: predecessor.receipt_hash,
    });
    const request = {
      version: EXECUTION_PROTOCOL_VERSION,
      inputHash,
      ...inputBinding,
      issuedAt,
      expiresAt,
      predecessorReceiptHash: predecessor.receipt_hash,
      temporaryReceiptHash: temporaryReceipt.receipt_hash,
      targetActions: ["TASK_CARD_COMMIT", "TASK_CARD_CREATE"],
    };
    const requestHash = hashJson(request);
    const operationId = stableOperationId("nexus_task_card_authority_switch", scopeRoot, input.attemptKey);
    const { record, created } = this.store.createOrReplay({
      operationId,
      attemptKey: input.attemptKey,
      requestHash,
      kind: "nexus_task_card_authority_switch",
      authorityMode: "OWNER_DIRECT",
      scopeRoot,
      request,
    });
    if (!created) return replayResult(record);

    try {
      await writeStandingGrantBackup(this.standingGrantBackupPath, predecessor);
      await writeStandingGrantReceiptCas(this.standingGrantPath, temporaryReceipt, predecessor.receipt_hash);
      return this.store.finish(operationId, {
        status: "succeeded",
        retrySafe: false,
        receipt: {
          switched: true,
          predecessorReceiptHash: predecessor.receipt_hash,
          temporaryReceiptHash: temporaryReceipt.receipt_hash,
          predecessorGoalId: predecessor.context.goal_id,
          successorGoalId: temporaryReceipt.context.goal_id,
          successorThreadId: temporaryReceipt.context.thread_id,
          actions: [...temporaryReceipt.context.allowed_actions],
          expiresAt: temporaryReceipt.context.expires_at,
        },
      });
    } catch (error) {
      return this.store.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "NEXUS_AUTHORITY_SWITCH_FAILED",
        errorMessage: redactSecrets(error instanceof Error ? error.message : String(error)),
        receipt: {
          predecessorReceiptHash: predecessor.receipt_hash,
          temporaryReceiptHash: temporaryReceipt.receipt_hash,
        },
      });
    }
  }

  async nexusTaskCardAuthorityRestore(input: NexusTaskCardAuthorityRestoreInput): Promise<DurableOperationRecord> {
    assertAttemptKey(input.attemptKey);
    if (input.ownerConfirmation !== true) {
      throw new DurableOperationError("NEXUS_AUTHORITY_RESTORE_INVALID", "ownerConfirmation must be explicitly true.");
    }
    if (!HEX64.test(input.expectedTemporaryReceiptHash)) {
      throw new DurableOperationError("NEXUS_AUTHORITY_RESTORE_INVALID", "expectedTemporaryReceiptHash must be 64 lowercase hex characters.");
    }
    if (!input.switchOperationId) {
      throw new DurableOperationError("NEXUS_AUTHORITY_RESTORE_INVALID", "switchOperationId is required.");
    }

    const scopeRoot = dirname(resolve(this.standingGrantPath));
    const inputBinding = {
      switchOperationId: input.switchOperationId,
      expectedTemporaryReceiptHash: input.expectedTemporaryReceiptHash,
      ownerConfirmation: true,
    };
    const inputHash = hashJson(inputBinding);
    const existing = this.store.getByAttempt(scopeRoot, input.attemptKey);
    if (existing) {
      if (existing.kind !== "nexus_task_card_authority_restore" || existing.request.inputHash !== inputHash) {
        throw new DurableOperationError(
          "OPERATION_REPLAY_CONFLICT",
          `attemptKey '${input.attemptKey}' is already bound to a materially different ${existing.kind} request.`,
          existing,
        );
      }
      return replayResult(existing);
    }

    const switchRecord = this.store.getByOperationId(input.switchOperationId);
    if (!switchRecord || switchRecord.kind !== "nexus_task_card_authority_switch" || switchRecord.status !== "succeeded") {
      throw new DurableOperationError("NEXUS_AUTHORITY_RESTORE_INVALID", "switchOperationId must identify one successful Task Card authority switch.");
    }
    const predecessorReceiptHash = String(switchRecord.request.predecessorReceiptHash ?? "");
    const recordedTemporaryReceiptHash = String(switchRecord.request.temporaryReceiptHash ?? "");
    if (!HEX64.test(predecessorReceiptHash) || recordedTemporaryReceiptHash !== input.expectedTemporaryReceiptHash) {
      throw new DurableOperationError("NEXUS_AUTHORITY_RESTORE_INVALID", "Restore request does not match the durable switch binding.");
    }

    const backup = await readSecureStandingGrantReceipt(this.standingGrantBackupPath, "NEXUS_AUTHORITY_RESTORE_INVALID");
    if (backup.receipt_hash !== predecessorReceiptHash) {
      throw new DurableOperationError("NEXUS_AUTHORITY_RESTORE_INVALID", "Fixed standing-grant backup does not match the switch predecessor receipt.");
    }
    const current = await readSecureStandingGrantReceipt(this.standingGrantPath, "NEXUS_AUTHORITY_RESTORE_INVALID");
    if (current.receipt_hash !== input.expectedTemporaryReceiptHash) {
      throw new DurableOperationError("NEXUS_AUTHORITY_RESTORE_INVALID", "Current standing-grant receipt does not match expectedTemporaryReceiptHash.");
    }
    if (
      current.context.allowed_actions.length !== 2 ||
      current.context.allowed_actions[0] !== "TASK_CARD_COMMIT" ||
      current.context.allowed_actions[1] !== "TASK_CARD_CREATE" ||
      current.context.goal_id !== String(switchRecord.request.successorGoalId ?? "") ||
      current.context.thread_id !== String(switchRecord.request.successorThreadId ?? "")
    ) {
      throw new DurableOperationError("NEXUS_AUTHORITY_RESTORE_INVALID", "Current standing grant does not match the exact temporary Task Card authority binding.");
    }

    const restoredReceipt = issueStandingGrantReceipt({
      grant_id: `devspace-task-card-restore-${hashJson({ switchOperationId: input.switchOperationId, predecessorReceiptHash }).slice(0, 24)}`,
      context: backup.context,
      supersedes_grant_hash: current.receipt_hash,
    });
    const request = {
      version: EXECUTION_PROTOCOL_VERSION,
      inputHash,
      ...inputBinding,
      predecessorReceiptHash,
      restoredReceiptHash: restoredReceipt.receipt_hash,
    };
    const requestHash = hashJson(request);
    const operationId = stableOperationId("nexus_task_card_authority_restore", scopeRoot, input.attemptKey);
    const { record, created } = this.store.createOrReplay({
      operationId,
      attemptKey: input.attemptKey,
      requestHash,
      kind: "nexus_task_card_authority_restore",
      authorityMode: "OWNER_DIRECT",
      scopeRoot,
      request,
    });
    if (!created) return replayResult(record);

    try {
      await writeStandingGrantReceiptCas(this.standingGrantPath, restoredReceipt, current.receipt_hash);
      return this.store.finish(operationId, {
        status: "succeeded",
        retrySafe: false,
        receipt: {
          restored: true,
          switchOperationId: input.switchOperationId,
          temporaryReceiptHash: current.receipt_hash,
          predecessorReceiptHash,
          restoredReceiptHash: restoredReceipt.receipt_hash,
          restoredGoalId: restoredReceipt.context.goal_id,
          actions: [...restoredReceipt.context.allowed_actions],
          expiresAt: restoredReceipt.context.expires_at,
        },
      });
    } catch (error) {
      return this.store.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "NEXUS_AUTHORITY_RESTORE_FAILED",
        errorMessage: redactSecrets(error instanceof Error ? error.message : String(error)),
        receipt: {
          temporaryReceiptHash: current.receipt_hash,
          predecessorReceiptHash,
          restoredReceiptHash: restoredReceipt.receipt_hash,
        },
      });
    }
  }

  private async executeNexusGatewayRecovery(
    operationId: string,
    request: NexusGatewayRecoveryRequest,
    reconciled: boolean,
  ): Promise<DurableOperationRecord> {
    let bridge: NexusGatewayRecoveryBridgeResult;
    try {
      bridge = await this.runNexusGatewayRecovery(request);
    } catch (error) {
      return this.store.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "NEXUS_GATEWAY_RECOVERY_UNCERTAIN",
        errorMessage: redactSecrets(error instanceof Error ? error.message : String(error)),
        receipt: { reconciled, bridge: "transport_error" },
      });
    }

    if (bridge.exitCode !== 0) {
      return this.store.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "NEXUS_GATEWAY_RECOVERY_UNCERTAIN",
        errorMessage: redactSecrets(
          bridge.stderr.trim() || `Fixed Nexus Gateway recovery bridge exited ${String(bridge.exitCode)}.`,
        ),
        receipt: { reconciled, exitCode: bridge.exitCode },
      });
    }

    let outcome: Record<string, unknown>;
    try {
      const parsed = JSON.parse(bridge.stdout);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("outcome must be an object");
      outcome = parsed as Record<string, unknown>;
    } catch (error) {
      return this.store.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "NEXUS_GATEWAY_RECOVERY_UNCERTAIN",
        errorMessage: `Nexus Gateway recovery bridge returned malformed outcome JSON: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        receipt: { reconciled, exitCode: bridge.exitCode },
      });
    }

    const result = String(outcome.result ?? "");
    const receipt = { reconciled, exitCode: bridge.exitCode, nexusOutcome: outcome };
    if (result === "VERIFIED") {
      return this.store.finish(operationId, { status: "succeeded", retrySafe: false, receipt });
    }
    if (result === "BLOCKED" || result === "ROLLED_BACK") {
      return this.store.finish(operationId, {
        status: "failed",
        retrySafe: false,
        errorCode: "NEXUS_GATEWAY_RECOVERY_FAILED",
        errorMessage: `Nexus Gateway recovery ended ${result}.`,
        receipt,
      });
    }
    return this.store.finish(operationId, {
      status: "outcome_unknown",
      retrySafe: false,
      errorCode: "NEXUS_GATEWAY_RECOVERY_UNCERTAIN",
      errorMessage: result === "UNCERTAIN_EFFECT"
        ? "Nexus Gateway recovery reported UNCERTAIN_EFFECT; reconcile the same durable request before any replay."
        : `Nexus Gateway recovery returned unrecognized result '${redactSecrets(result)}'.`,
      receipt,
    });
  }

  async reconcile(operationId: string): Promise<DurableOperationRecord> {
    const record = this.store.getByOperationId(operationId);
    if (!record) throw new DurableOperationError("RECONCILIATION_REQUIRED", `Unknown durable operation: ${operationId}`);
    if (record.status !== "outcome_unknown" && record.status !== "started") return record;

    if (record.kind === "nexus_gateway_recover") {
      const recoveryRequest = record.request.recoveryRequest;
      assertNexusGatewayRecoveryRequest(recoveryRequest);
      return await this.executeNexusGatewayRecovery(operationId, recoveryRequest, true);
    }
    if (record.kind === "nexus_task_card_authority_switch") {
      try {
        const current = await readSecureStandingGrantReceipt(this.standingGrantPath, "NEXUS_AUTHORITY_SWITCH_INVALID");
        const temporaryReceiptHash = String(record.request.temporaryReceiptHash ?? "");
        const predecessorReceiptHash = String(record.request.predecessorReceiptHash ?? "");
        const priorReceipt = record.receipt as Record<string, unknown> | undefined;
        if (HEX64.test(temporaryReceiptHash) && current.receipt_hash === temporaryReceiptHash) {
          return this.store.finish(operationId, {
            status: "succeeded",
            retrySafe: false,
            receipt: { ...priorReceipt, reconciled: true, currentReceiptHash: current.receipt_hash },
          });
        }
        if (HEX64.test(predecessorReceiptHash) && current.receipt_hash === predecessorReceiptHash) {
          return this.store.finish(operationId, {
            status: "failed",
            retrySafe: true,
            errorCode: "NEXUS_AUTHORITY_SWITCH_FAILED",
            errorMessage: "Standing grant remains at the exact predecessor; switch produced no effect.",
            receipt: { ...priorReceipt, reconciled: true, currentReceiptHash: current.receipt_hash },
          });
        }
        return this.store.finish(operationId, {
          status: "outcome_unknown",
          retrySafe: false,
          errorCode: "RECONCILIATION_REQUIRED",
          errorMessage: "Standing grant is neither the bound predecessor nor the bound temporary successor.",
          receipt: { ...priorReceipt, reconciled: true, currentReceiptHash: current.receipt_hash },
        });
      } catch (error) {
        return this.store.finish(operationId, {
          status: "outcome_unknown",
          retrySafe: false,
          errorCode: "RECONCILIATION_REQUIRED",
          errorMessage: `Failed to inspect standing grant during reconciliation: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
          receipt: { reconciled: true },
        });
      }
    }

    if (record.kind === "nexus_task_card_authority_restore") {
      try {
        const current = await readSecureStandingGrantReceipt(this.standingGrantPath, "NEXUS_AUTHORITY_RESTORE_INVALID");
        const restoredReceiptHash = String(record.request.restoredReceiptHash ?? "");
        const expectedTemporaryReceiptHash = String(record.request.expectedTemporaryReceiptHash ?? "");
        const priorReceipt = record.receipt as Record<string, unknown> | undefined;
        if (HEX64.test(restoredReceiptHash) && current.receipt_hash === restoredReceiptHash) {
          return this.store.finish(operationId, {
            status: "succeeded",
            retrySafe: false,
            receipt: { ...priorReceipt, reconciled: true, currentReceiptHash: current.receipt_hash },
          });
        }
        if (HEX64.test(expectedTemporaryReceiptHash) && current.receipt_hash === expectedTemporaryReceiptHash) {
          return this.store.finish(operationId, {
            status: "failed",
            retrySafe: true,
            errorCode: "NEXUS_AUTHORITY_RESTORE_FAILED",
            errorMessage: "Standing grant remains at the exact temporary authority; restore produced no effect.",
            receipt: { ...priorReceipt, reconciled: true, currentReceiptHash: current.receipt_hash },
          });
        }
        return this.store.finish(operationId, {
          status: "outcome_unknown",
          retrySafe: false,
          errorCode: "RECONCILIATION_REQUIRED",
          errorMessage: "Standing grant is neither the bound temporary authority nor the bound restored successor.",
          receipt: { ...priorReceipt, reconciled: true, currentReceiptHash: current.receipt_hash },
        });
      } catch (error) {
        return this.store.finish(operationId, {
          status: "outcome_unknown",
          retrySafe: false,
          errorCode: "RECONCILIATION_REQUIRED",
          errorMessage: `Failed to inspect standing grant during reconciliation: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
          receipt: { reconciled: true },
        });
      }
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

    const workspaceRoot = String(record.request.workspaceRoot ?? record.scopeRoot);
    const recipe = String(record.request.recipe) as DependencySyncRecipe;
    const frozenInputs = recipeFrozenInputs(recipe);
    const current = await hashFiles(workspaceRoot, frozenInputs);
    const original = record.request.frozenInputs as Record<string, string | null> | undefined;
    if (original && hashJson(original) !== hashJson(current)) {
      return this.store.finish(operationId, {
        status: "failed",
        retrySafe: false,
        errorCode: "FROZEN_INPUT_CHANGED",
        errorMessage: "Frozen dependency inputs differ from the operation's bound inputs; success cannot be claimed.",
        receipt: { recipe, original, current, reconciled: true },
      });
    }
    return this.store.finish(operationId, {
      status: "outcome_unknown",
      retrySafe: false,
      errorCode: "RECONCILIATION_REQUIRED",
      errorMessage: "Dependency inputs are intact, but installed-environment success cannot be proven after interruption without re-executing mutation.",
      receipt: { recipe, frozenInputs: current, reconciled: true },
    });
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

export function assertNexusGatewayRecoveryRequest(value: unknown): asserts value is NexusGatewayRecoveryRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", "Nexus Gateway recovery request must be an object.");
  }
  const request = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "request_id",
    "idempotency_fence",
    "operation",
    "effect_class",
    "recovery_authority_id",
    "recovery_authority_hash",
    "desired_manifest_id",
    "desired_manifest_hash",
    "predecessor_manifest_id",
    "predecessor_manifest_hash",
    "request_hash",
    "schema",
  ]);
  const actualKeys = Object.keys(request);
  if (actualKeys.length !== expectedKeys.size || actualKeys.some((key) => !expectedKeys.has(key))) {
    throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", "Nexus Gateway recovery request schema mismatch.");
  }
  for (const key of ["request_id", "idempotency_fence", "recovery_authority_id"] as const) {
    if (typeof request[key] !== "string" || !SAFE_NEXUS_ID.test(request[key] as string)) {
      throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", `Invalid Nexus Gateway recovery ${key}.`);
    }
  }
  for (const key of ["desired_manifest_id", "predecessor_manifest_id"] as const) {
    if (typeof request[key] !== "string" || !NEXUS_DEPLOYMENT_ID.test(request[key] as string)) {
      throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", `Invalid Nexus Gateway recovery ${key}.`);
    }
  }
  for (const key of [
    "recovery_authority_hash",
    "desired_manifest_hash",
    "predecessor_manifest_hash",
    "request_hash",
  ] as const) {
    if (typeof request[key] !== "string" || !HEX64.test(request[key] as string)) {
      throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", `Invalid Nexus Gateway recovery ${key}.`);
    }
  }
  if (request.operation !== "gateway-recover" || request.effect_class !== "GATEWAY_DURABLE_RECOVERY") {
    throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", "Nexus Gateway recovery operation/effect mismatch.");
  }
  if (request.schema !== NEXUS_GATEWAY_RECOVERY_SCHEMA) {
    throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", "Nexus Gateway recovery schema mismatch.");
  }
  const expectedRequestHash = hashJson({
    request_id: request.request_id,
    idempotency_fence: request.idempotency_fence,
    operation: request.operation,
    effect_class: request.effect_class,
    recovery_authority_id: request.recovery_authority_id,
    recovery_authority_hash: request.recovery_authority_hash,
    desired_manifest_id: request.desired_manifest_id,
    desired_manifest_hash: request.desired_manifest_hash,
    predecessor_manifest_id: request.predecessor_manifest_id,
    predecessor_manifest_hash: request.predecessor_manifest_hash,
  });
  if (request.request_hash !== expectedRequestHash) {
    throw new DurableOperationError("NEXUS_GATEWAY_REQUEST_INVALID", "Nexus Gateway recovery request hash mismatch.");
  }
}

function nexusCanonicalUtcTimestamp(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, -1)}000Z`;
}

export function canonicalAutonomyHash(value: Record<string, unknown>): string {
  const payload = { ...value };
  delete payload.context_hash;
  return hashJson(payload);
}

function canonicalStandingGrantReceiptHash(value: Record<string, unknown>): string {
  const payload = { ...value };
  delete payload.receipt_hash;
  return hashJson(payload);
}

export function assertStandingGrantContext(value: unknown): asserts value is StandingGrantContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Standing grant context must be an object.");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schema !== "nexus.standing_grant_context.v1") {
    throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", `Invalid standing grant schema: ${String(raw.schema)}`);
  }
  for (const field of ["owner_id", "coordinator_id", "thread_id", "goal_id"] as const) {
    if (typeof raw[field] !== "string" || !SAFE_NEXUS_ID.test(raw[field] as string)) {
      throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", `Invalid or missing ${field} in standing grant.`);
    }
  }
  if (!raw.repository || typeof raw.repository !== "object" || Array.isArray(raw.repository)) {
    throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Invalid or missing repository in standing grant.");
  }
  const repo = raw.repository as Record<string, unknown>;
  if (typeof repo.repository_id !== "string" || typeof repo.canonical_remote !== "string") {
    throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Invalid repository structure in standing grant.");
  }
  if (!Array.isArray(raw.allowed_actions) || raw.allowed_actions.length === 0 || raw.allowed_actions.some((action) => typeof action !== "string" || !action)) {
    throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "allowed_actions must be a non-empty string array.");
  }
  if (typeof raw.issued_at !== "string" || Number.isNaN(Date.parse(raw.issued_at))) {
    throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Invalid issued_at timestamp in standing grant.");
  }
  if (typeof raw.expires_at !== "string" || Number.isNaN(Date.parse(raw.expires_at))) {
    throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Invalid expires_at timestamp in standing grant.");
  }
  if (!(raw.revoked_at === null || typeof raw.revoked_at === "string") || !(raw.revocation_reason === null || typeof raw.revocation_reason === "string")) {
    throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Invalid revocation binding in standing grant.");
  }
  if (typeof raw.context_hash !== "string" || !HEX64.test(raw.context_hash)) {
    throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Invalid context_hash format in standing grant.");
  }
  if (raw.context_hash !== canonicalAutonomyHash(raw)) {
    throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Standing grant context_hash tampering or mismatch.");
  }
}

function assertStandingGrantReceipt(value: unknown, code: "NEXUS_AUTHORITY_SWITCH_INVALID" | "NEXUS_AUTHORITY_RESTORE_INVALID"): asserts value is StandingGrantReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DurableOperationError(code, "Standing grant receipt must be an object.");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schema !== "nexus.standing_grant_receipt.v1" || typeof raw.grant_id !== "string" || !SAFE_NEXUS_ID.test(raw.grant_id)) {
    throw new DurableOperationError(code, "Standing grant receipt identity is invalid.");
  }
  assertStandingGrantContext(raw.context);
  if (typeof raw.receipt_hash !== "string" || !HEX64.test(raw.receipt_hash)) {
    throw new DurableOperationError(code, "Standing grant receipt_hash is invalid.");
  }
  if (!(raw.supersedes_grant_hash === null || (typeof raw.supersedes_grant_hash === "string" && HEX64.test(raw.supersedes_grant_hash)))) {
    throw new DurableOperationError(code, "Standing grant supersedes hash is invalid.");
  }
  if (raw.receipt_hash !== canonicalStandingGrantReceiptHash(raw)) {
    throw new DurableOperationError(code, "Standing grant receipt hash mismatch.");
  }
}

function issueStandingGrantContext(values: Omit<StandingGrantContext, "schema" | "context_hash">): StandingGrantContext {
  const payload = {
    schema: "nexus.standing_grant_context.v1" as const,
    ...values,
    allowed_actions: [...new Set(values.allowed_actions)].sort(),
  };
  return { ...payload, context_hash: canonicalAutonomyHash(payload as unknown as Record<string, unknown>) };
}

function issueStandingGrantReceipt(values: Omit<StandingGrantReceipt, "schema" | "receipt_hash">): StandingGrantReceipt {
  const payload = { schema: "nexus.standing_grant_receipt.v1" as const, ...values };
  return { ...payload, receipt_hash: canonicalStandingGrantReceiptHash(payload as unknown as Record<string, unknown>) };
}

async function assertSecureAuthorityDirectory(directory: string, code: "NEXUS_AUTHORITY_SWITCH_INVALID" | "NEXUS_AUTHORITY_RESTORE_INVALID"): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o777) !== 0o700) {
    throw new DurableOperationError(code, "Nexus authority directory ownership/mode is unsafe.");
  }
}

async function readSecureStandingGrantReceipt(filePath: string, code: "NEXUS_AUTHORITY_SWITCH_INVALID" | "NEXUS_AUTHORITY_RESTORE_INVALID"): Promise<StandingGrantReceipt> {
  const resolved = resolve(filePath);
  await assertSecureAuthorityDirectory(dirname(resolved), code);
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o777) !== 0o600 || info.size > 16 * 1024) {
    throw new DurableOperationError(code, "Standing grant file ownership/mode/size is unsafe.");
  }
  const parsed = JSON.parse(await readFile(resolved, "utf8")) as unknown;
  assertStandingGrantReceipt(parsed, code);
  return parsed;
}

async function writeStandingGrantFile(filePath: string, content: StandingGrantReceipt): Promise<void> {
  const dir = dirname(resolve(filePath));
  await assertSecureAuthorityDirectory(dir, "NEXUS_AUTHORITY_SWITCH_INVALID");
  const tempPath = join(dir, `.standing-grant-${randomUUID()}.tmp`);
  const payload = JSON.stringify(sortJson(content)) + "\n";
  await writeFile(tempPath, payload, { mode: 0o600, encoding: "utf8" });
  await chmod(tempPath, 0o600);
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

async function writeStandingGrantBackup(filePath: string, predecessor: StandingGrantReceipt): Promise<void> {
  if (existsSync(filePath)) {
    const existing = await readSecureStandingGrantReceipt(filePath, "NEXUS_AUTHORITY_SWITCH_INVALID");
    if (existing.receipt_hash !== predecessor.receipt_hash) {
      throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Existing Task Card authority backup is bound to a different predecessor.");
    }
    return;
  }
  await writeStandingGrantFile(filePath, predecessor);
}

const NEXUS_GATEWAY_DIRECT_PLIST = join(homedir(), "Library", "LaunchAgents", "com.nexus.mcp.gateway.direct.plist");
const NEXUS_GATEWAY_DEPLOYMENTS_ROOT = join(homedir(), "Library", "Application Support", "Nexus", "gateway-direct", "deployments");

export const NEXUS_STANDING_GRANT_CAS_BRIDGE_CODE = String.raw`
import json
import os
import pathlib
import plistlib
import re
import stat
import subprocess
import sys

PLIST = pathlib.Path.home() / "Library" / "LaunchAgents" / "com.nexus.mcp.gateway.direct.plist"
DEPLOYMENTS = pathlib.Path.home() / "Library" / "Application Support" / "Nexus" / "gateway-direct" / "deployments"
REMOTE = "https://github.com/James3014/Nexus-new.git"
HEX64 = re.compile(r"^[0-9a-f]{64}$")


def fail(message):
    raise RuntimeError(message)


def secure_file(path, label):
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        fail(label + " must be a regular non-symlink file")
    if info.st_uid != os.getuid() or (stat.S_IMODE(info.st_mode) & 0o022):
        fail(label + " ownership/mode invalid")


def secure_dir(path, label):
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        fail(label + " must be a real directory")
    if info.st_uid != os.getuid() or (stat.S_IMODE(info.st_mode) & 0o022):
        fail(label + " ownership/mode invalid")


def git(root, *args):
    result = subprocess.run(
        ["/usr/bin/git", "-C", str(root), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
        check=False,
        env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
    )
    if result.returncode != 0:
        fail("active Nexus deployment git verification failed")
    return result.stdout.strip()


try:
    request = json.load(sys.stdin)
    if not isinstance(request, dict) or set(request) != {"expected_receipt_hash", "receipt"}:
        fail("standing-grant CAS request schema mismatch")
    expected = request.get("expected_receipt_hash")
    if not isinstance(expected, str) or HEX64.fullmatch(expected) is None:
        fail("expected receipt hash invalid")

    secure_file(PLIST, "Nexus Gateway plist")
    secure_dir(DEPLOYMENTS, "Nexus Gateway deployments root")
    plist = plistlib.loads(PLIST.read_bytes())
    root_text = plist.get("WorkingDirectory") if isinstance(plist, dict) else None
    if not isinstance(root_text, str) or not root_text:
        fail("Nexus Gateway WorkingDirectory missing")
    root_path = pathlib.Path(root_text)
    if root_path.is_symlink():
        fail("active Nexus deployment root is symlinked")
    root = root_path.resolve(strict=True)
    deployments = DEPLOYMENTS.resolve(strict=True)
    if root.parent != deployments:
        fail("active Nexus deployment escaped fixed deployments root")
    secure_dir(root, "active Nexus deployment")
    if git(root, "rev-parse", "--show-toplevel") != str(root):
        fail("active Nexus deployment top-level mismatch")
    if git(root, "remote", "get-url", "origin") != REMOTE:
        fail("active Nexus deployment remote mismatch")
    if git(root, "status", "--porcelain"):
        fail("active Nexus deployment is dirty")

    sys.path.insert(0, str(root))
    from nexus.orchestrator.standing_grant_store import (
        StandingGrantReceipt,
        load_standing_grant_receipt,
        write_standing_grant_receipt,
    )

    candidate = StandingGrantReceipt.model_validate(request.get("receipt"))
    if candidate.supersedes_grant_hash != expected:
        fail("candidate predecessor binding mismatch")

    current = load_standing_grant_receipt()
    if current is not None and current.receipt_hash == candidate.receipt_hash:
        print(json.dumps({"result": "VERIFIED", "already_applied": True, "receipt_hash": current.receipt_hash}, sort_keys=True))
        raise SystemExit(0)
    if current is None or current.receipt_hash != expected:
        fail("canonical standing-grant CAS predecessor mismatch")

    write_standing_grant_receipt(candidate, expected_receipt_hash=expected)
    readback = load_standing_grant_receipt()
    if readback is None or readback.receipt_hash != candidate.receipt_hash:
        fail("canonical standing-grant readback mismatch")
    print(json.dumps({"result": "VERIFIED", "already_applied": False, "receipt_hash": readback.receipt_hash}, sort_keys=True))
except SystemExit:
    raise
except Exception as exc:
    print("NEXUS_STANDING_GRANT_CAS_ERROR:" + type(exc).__name__ + ":" + str(exc), file=sys.stderr)
    raise SystemExit(1)
`;

async function writeCanonicalStandingGrantViaNexusStore(receipt: StandingGrantReceipt, expectedReceiptHash: string): Promise<void> {
  const maxOutputBytes = 64 * 1024;
  const result = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
    const child = spawn(NEXUS_GATEWAY_INTERPRETER, ["-I", "-B", "-c", NEXUS_STANDING_GRANT_CAS_BRIDGE_CODE], {
      cwd: homedir(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        HOME: homedir(),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(new Error("Fixed Nexus standing-grant CAS bridge timed out."));
    }, 15_000);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const append = (target: "stdout" | "stderr", chunk: unknown) => {
      const next = String(chunk);
      const combined = (target === "stdout" ? stdout : stderr) + next;
      if (Buffer.byteLength(combined, "utf8") > maxOutputBytes) {
        finish(() => {
          child.kill("SIGKILL");
          rejectPromise(new Error("Fixed Nexus standing-grant CAS bridge exceeded bounded output."));
        });
        return;
      }
      if (target === "stdout") stdout = combined;
      else stderr = combined;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => finish(() => rejectPromise(error)));
    child.stdin.on("error", (error) => finish(() => rejectPromise(error)));
    child.on("close", (exitCode) => finish(() => resolvePromise({ exitCode, stdout, stderr })));
    child.stdin.end(JSON.stringify({ expected_receipt_hash: expectedReceiptHash, receipt }));
  });
  if (result.exitCode !== 0) {
    throw new Error(redactSecrets(result.stderr.trim() || `Fixed Nexus standing-grant CAS bridge exited ${String(result.exitCode)}.`));
  }
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  if (parsed.result !== "VERIFIED" || parsed.receipt_hash !== receipt.receipt_hash) {
    throw new Error("Fixed Nexus standing-grant CAS bridge returned an invalid verification receipt.");
  }
}

async function writeStandingGrantReceiptCas(filePath: string, receipt: StandingGrantReceipt, expectedReceiptHash: string): Promise<void> {
  if (resolve(filePath) === resolve(NEXUS_STANDING_GRANT_PATH)) {
    await writeCanonicalStandingGrantViaNexusStore(receipt, expectedReceiptHash);
    return;
  }
  // Test-only injected paths never target the canonical machine-local authority store.
  const current = await readSecureStandingGrantReceipt(filePath, "NEXUS_AUTHORITY_SWITCH_INVALID");
  if (current.receipt_hash !== expectedReceiptHash || receipt.supersedes_grant_hash !== expectedReceiptHash) {
    throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Standing grant CAS predecessor mismatch.");
  }
  await writeStandingGrantFile(filePath, receipt);
  const readback = await readSecureStandingGrantReceipt(filePath, "NEXUS_AUTHORITY_SWITCH_INVALID");
  if (readback.receipt_hash !== receipt.receipt_hash) {
    throw new DurableOperationError("NEXUS_AUTHORITY_SWITCH_INVALID", "Standing grant readback mismatch after CAS write.");
  }
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

function stableOperationId(kind: DurableOperationKind, scopeRoot: string, attemptKey: string): string {
  return `op_${createHash("sha256").update(`${kind}\0${resolve(scopeRoot)}\0${attemptKey}`).digest("hex").slice(0, 16)}`;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
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
    return { command: "npm", args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"] };
  }
  if (recipe === "pnpm_frozen") {
    return { command: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts"] };
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

export function buildNexusGatewayRecoveryBridgeCode(
  acceptedManagerSha256: string,
  acceptedContractSha256: string,
): string {
  if (!HEX64.test(acceptedManagerSha256) || !HEX64.test(acceptedContractSha256)) {
    throw new Error("Nexus Gateway bridge trust-root hashes must be lowercase SHA-256 values.");
  }
  return String.raw`
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import stat
import subprocess
import sys

STATE = pathlib.Path.home() / "Library" / "Application Support" / "Nexus" / "gateway-direct"
AUTHORITY = STATE / "recovery-authority.json"
MANAGER = STATE / "manager.py"
DEPLOYMENTS = STATE / "deployments"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX40 = re.compile(r"^[0-9a-f]{40}$")
DEPLOYMENT_ID = re.compile(r"^r1-[0-9a-f]{40}$")
REMOTE = "https://github.com/James3014/Nexus-new.git"
ACCEPTED_MANAGER_SHA256 = "${acceptedManagerSha256}"
ACCEPTED_CONTRACT_SHA256 = "${acceptedContractSha256}"


def fail(message):
    raise RuntimeError(message)


def secure_file(path, label):
    if path.is_symlink():
        fail(label + " must not be a symlink")
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode):
        fail(label + " must be a regular file")
    if info.st_uid != os.getuid() or (stat.S_IMODE(info.st_mode) & 0o022):
        fail(label + " ownership/mode invalid")


def git(root, *args):
    result = subprocess.run(
        ["/usr/bin/git", "-C", str(root), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
        check=False,
        env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
    )
    if result.returncode != 0:
        fail("deployment git verification failed")
    return result.stdout.strip()


try:
    request = json.load(sys.stdin)
    if not isinstance(request, dict):
        fail("recovery request must be an object")
    secure_file(AUTHORITY, "recovery authority")
    secure_file(MANAGER, "manager artifact")
    authority = json.loads(AUTHORITY.read_text(encoding="utf-8"))
    if not isinstance(authority, dict) or authority.get("schema") != "nexus.gateway.durable_recovery_authority.v2":
        fail("recovery authority schema mismatch")
    if authority.get("revocation_state") != "NOT_REVOKED":
        fail("recovery authority is not active")
    manager_hash = authority.get("final_manager_sha256")
    if manager_hash != ACCEPTED_MANAGER_SHA256:
        fail("recovery authority accepted manager hash mismatch")
    if hashlib.sha256(MANAGER.read_bytes()).hexdigest() != ACCEPTED_MANAGER_SHA256:
        fail("manager artifact hash mismatch")

    binding_pairs = (
        ("request_id", "request_id"),
        ("idempotency_fence", "idempotency_fence"),
        ("recovery_authority_id", "receipt_id"),
        ("recovery_authority_hash", "receipt_hash"),
        ("desired_manifest_id", "desired_manifest_id"),
        ("desired_manifest_hash", "desired_manifest_sha256"),
        ("predecessor_manifest_id", "predecessor_manifest_id"),
        ("predecessor_manifest_hash", "predecessor_manifest_sha256"),
    )
    for request_key, authority_key in binding_pairs:
        if request.get(request_key) != authority.get(authority_key):
            fail("request/authority binding mismatch")
    if request.get("operation") != "gateway-recover" or request.get("effect_class") != "GATEWAY_DURABLE_RECOVERY":
        fail("recovery operation/effect mismatch")
    if request.get("schema") != "nexus.gateway.durable_recovery_request.v2":
        fail("recovery request schema mismatch")

    desired_id = authority.get("desired_manifest_id")
    desired_manifest = authority.get("desired_manifest")
    if not isinstance(desired_id, str) or DEPLOYMENT_ID.fullmatch(desired_id) is None:
        fail("desired deployment id invalid")
    if not isinstance(desired_manifest, dict) or desired_manifest.get("deployment_id") != desired_id:
        fail("desired deployment manifest binding mismatch")
    desired_commit = desired_manifest.get("commit")
    desired_tree = desired_manifest.get("tree")
    if not isinstance(desired_commit, str) or HEX40.fullmatch(desired_commit) is None:
        fail("desired deployment commit invalid")
    if not isinstance(desired_tree, str) or HEX40.fullmatch(desired_tree) is None:
        fail("desired deployment tree invalid")

    deployments_root = DEPLOYMENTS.resolve(strict=True)
    desired_root_path = DEPLOYMENTS / desired_id
    if desired_root_path.is_symlink():
        fail("desired deployment root must not be a symlink")
    desired_root = desired_root_path.resolve(strict=True)
    if desired_root.parent != deployments_root or not desired_root.is_dir():
        fail("desired deployment root escaped fixed deployments directory")
    root_info = os.lstat(desired_root)
    if root_info.st_uid != os.getuid() or (stat.S_IMODE(root_info.st_mode) & 0o022):
        fail("desired deployment root ownership/mode invalid")
    if git(desired_root, "rev-parse", "--show-toplevel") != str(desired_root):
        fail("desired deployment toplevel mismatch")
    if git(desired_root, "remote", "get-url", "origin") != REMOTE:
        fail("desired deployment remote mismatch")
    if git(desired_root, "status", "--porcelain"):
        fail("desired deployment is dirty")
    if git(desired_root, "rev-parse", "HEAD") != desired_commit:
        fail("desired deployment commit mismatch")
    if git(desired_root, "rev-parse", "HEAD^{tree}") != desired_tree:
        fail("desired deployment tree mismatch")
    contract_path = desired_root / "nexus" / "contracts" / "gateway_deployment.py"
    secure_file(contract_path, "gateway deployment authority contract")
    if hashlib.sha256(contract_path.read_bytes()).hexdigest() != ACCEPTED_CONTRACT_SHA256:
        fail("gateway deployment authority contract hash mismatch")

    sys.path.insert(0, str(desired_root))
    spec = importlib.util.spec_from_file_location("nexus_gateway_stable_manager", MANAGER)
    if spec is None or spec.loader is None:
        fail("manager import spec unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    outcome = module._gateway_recover_live(request)
    print(json.dumps(outcome.model_dump(mode="json"), sort_keys=True, separators=(",", ":")))
except Exception as exc:
    print("NEXUS_GATEWAY_BRIDGE_ERROR:" + type(exc).__name__ + ":" + str(exc), file=sys.stderr)
    raise SystemExit(1)
`;
}

export const NEXUS_GATEWAY_RECOVERY_BRIDGE_CODE = buildNexusGatewayRecoveryBridgeCode(
  NEXUS_GATEWAY_ACCEPTED_MANAGER_SHA256,
  NEXUS_GATEWAY_ACCEPTED_CONTRACT_SHA256,
);

function buildNexusGatewayRecoveryPreflightBridgeCode(
  acceptedManagerSha256: string,
  acceptedContractSha256: string,
): string {
  return String.raw `
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import stat
import subprocess
import sys


STATE = pathlib.Path.home() / "Library" / "Application Support" / "Nexus" / "gateway-direct"
AUTHORITY = STATE / "recovery-authority.json"
MANAGER = STATE / "manager.py"
DEPLOYMENTS = STATE / "deployments"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX40 = re.compile(r"^[0-9a-f]{40}$")
DEPLOYMENT_ID = re.compile(r"^r1-[0-9a-f]{40}$")
REMOTE = "https://github.com/James3014/Nexus-new.git"
ACCEPTED_MANAGER_SHA256 = "${acceptedManagerSha256}"
ACCEPTED_CONTRACT_SHA256 = "${acceptedContractSha256}"


def fail(message):
    raise RuntimeError(message)


def secure_file(path, label):
    if path.is_symlink():
        fail(label + " must not be a symlink")
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode):
        fail(label + " must be a regular file")
    if info.st_uid != os.getuid() or (stat.S_IMODE(info.st_mode) & 0o022):
        fail(label + " ownership/mode invalid")


def git(root, *args):
    result = subprocess.run(
        ["/usr/bin/git", "-C", str(root), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
        check=False,
        env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
    )
    if result.returncode != 0:
        fail("deployment git verification failed")
    return result.stdout.strip()


try:
    request = json.load(sys.stdin)
    if not isinstance(request, dict):
        fail("recovery request must be an object")
    secure_file(AUTHORITY, "recovery authority")
    secure_file(MANAGER, "manager artifact")
    authority = json.loads(AUTHORITY.read_text(encoding="utf-8"))
    if not isinstance(authority, dict) or authority.get("schema") != "nexus.gateway.durable_recovery_authority.v2":
        fail("recovery authority schema mismatch")
    if authority.get("revocation_state") != "NOT_REVOKED":
        fail("recovery authority is not active")
    manager_hash = authority.get("final_manager_sha256")
    if manager_hash != ACCEPTED_MANAGER_SHA256:
        fail("recovery authority accepted manager hash mismatch")
    if hashlib.sha256(MANAGER.read_bytes()).hexdigest() != ACCEPTED_MANAGER_SHA256:
        fail("manager artifact hash mismatch")

    binding_pairs = (
        ("request_id", "request_id"),
        ("idempotency_fence", "idempotency_fence"),
        ("recovery_authority_id", "receipt_id"),
        ("recovery_authority_hash", "receipt_hash"),
        ("desired_manifest_id", "desired_manifest_id"),
        ("desired_manifest_hash", "desired_manifest_sha256"),
        ("predecessor_manifest_id", "predecessor_manifest_id"),
        ("predecessor_manifest_hash", "predecessor_manifest_sha256"),
    )
    for request_key, authority_key in binding_pairs:
        if request.get(request_key) != authority.get(authority_key):
            fail("request/authority binding mismatch")
    if request.get("operation") != "gateway-recover" or request.get("effect_class") != "GATEWAY_DURABLE_RECOVERY":
        fail("recovery operation/effect mismatch")
    if request.get("schema") != "nexus.gateway.durable_recovery_request.v2":
        fail("recovery request schema mismatch")

    desired_id = authority.get("desired_manifest_id")
    desired_manifest = authority.get("desired_manifest")
    if not isinstance(desired_id, str) or DEPLOYMENT_ID.fullmatch(desired_id) is None:
        fail("desired deployment id invalid")
    if not isinstance(desired_manifest, dict) or desired_manifest.get("deployment_id") != desired_id:
        fail("desired deployment manifest binding mismatch")
    desired_commit = desired_manifest.get("commit")
    desired_tree = desired_manifest.get("tree")
    if not isinstance(desired_commit, str) or HEX40.fullmatch(desired_commit) is None:
        fail("desired deployment commit invalid")
    if not isinstance(desired_tree, str) or HEX40.fullmatch(desired_tree) is None:
        fail("desired deployment tree invalid")

    deployments_root = DEPLOYMENTS.resolve(strict=True)
    desired_root_path = DEPLOYMENTS / desired_id
    if desired_root_path.is_symlink():
        fail("desired deployment root must not be a symlink")
    desired_root = desired_root_path.resolve(strict=True)
    if desired_root.parent != deployments_root or not desired_root.is_dir():
        fail("desired deployment root escaped fixed deployments directory")
    root_info = os.lstat(desired_root)
    if root_info.st_uid != os.getuid() or (stat.S_IMODE(root_info.st_mode) & 0o022):
        fail("desired deployment root ownership/mode invalid")
    if git(desired_root, "rev-parse", "--show-toplevel") != str(desired_root):
        fail("desired deployment toplevel mismatch")
    if git(desired_root, "remote", "get-url", "origin") != REMOTE:
        fail("desired deployment remote mismatch")
    if git(desired_root, "status", "--porcelain"):
        fail("desired deployment is dirty")
    if git(desired_root, "rev-parse", "HEAD") != desired_commit:
        fail("desired deployment commit mismatch")
    if git(desired_root, "rev-parse", "HEAD^{tree}") != desired_tree:
        fail("desired deployment tree mismatch")
    contract_path = desired_root / "nexus" / "contracts" / "gateway_deployment.py"
    secure_file(contract_path, "gateway deployment authority contract")
    if hashlib.sha256(contract_path.read_bytes()).hexdigest() != ACCEPTED_CONTRACT_SHA256:
        fail("gateway deployment authority contract hash mismatch")

    sys.path.insert(0, str(desired_root))
    spec = importlib.util.spec_from_file_location("nexus_gateway_stable_manager", MANAGER)
    if spec is None or spec.loader is None:
        fail("manager import spec unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    outcome = module.gateway_recover(request)
    print(json.dumps(outcome.model_dump(mode="json"), sort_keys=True, separators=(",", ":")))
except Exception as exc:
    print("NEXUS_GATEWAY_BRIDGE_ERROR:" + type(exc).__name__ + ":" + str(exc), file=sys.stderr)
    raise SystemExit(1)
`;
}

export const NEXUS_GATEWAY_RECOVERY_PREFLIGHT_BRIDGE_CODE = buildNexusGatewayRecoveryPreflightBridgeCode(
  NEXUS_GATEWAY_ACCEPTED_MANAGER_SHA256,
  NEXUS_GATEWAY_ACCEPTED_CONTRACT_SHA256,
);

async function spawnNexusGatewayRecovery(
  request: NexusGatewayRecoveryRequest,
): Promise<NexusGatewayRecoveryBridgeResult> {
  const maxOutputBytes = 1024 * 1024;
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(NEXUS_GATEWAY_INTERPRETER, ["-I", "-B", "-c", NEXUS_GATEWAY_RECOVERY_BRIDGE_CODE], {
      cwd: homedir(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        HOME: homedir(),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(error);
    };
    const appendBounded = (target: "stdout" | "stderr", chunk: unknown) => {
      const next = String(chunk);
      if (Buffer.byteLength((target === "stdout" ? stdout : stderr) + next, "utf8") > maxOutputBytes) {
        rejectOnce(new Error("Fixed Nexus Gateway recovery bridge exceeded bounded output."));
        return;
      }
      if (target === "stdout") stdout += next;
      else stderr += next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => appendBounded("stdout", chunk));
    child.stderr.on("data", (chunk) => appendBounded("stderr", chunk));
    child.on("error", (error) => rejectOnce(error));
    child.stdin.on("error", (error) => rejectOnce(error));
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      resolvePromise({ exitCode, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function spawnNexusGatewayRecoveryPreflight(
  request: NexusGatewayRecoveryRequest,
): Promise<NexusGatewayRecoveryBridgeResult> {
  const maxOutputBytes = 1024 * 1024;
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(NEXUS_GATEWAY_INTERPRETER, ["-I", "-B", "-c", NEXUS_GATEWAY_RECOVERY_PREFLIGHT_BRIDGE_CODE], {
      cwd: homedir(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        HOME: homedir(),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(error);
    };
    const appendBounded = (target: "stdout" | "stderr", chunk: unknown) => {
      const next = String(chunk);
      if (Buffer.byteLength((target === "stdout" ? stdout : stderr) + next, "utf8") > maxOutputBytes) {
        rejectOnce(new Error("Fixed Nexus Gateway recovery preflight bridge exceeded bounded output."));
        return;
      }
      if (target === "stdout") stdout += next;
      else stderr += next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => appendBounded("stdout", chunk));
    child.stderr.on("data", (chunk) => appendBounded("stderr", chunk));
    child.on("error", (error) => rejectOnce(error));
    child.stdin.on("error", (error) => rejectOnce(error));
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      resolvePromise({ exitCode, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function spawnCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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
