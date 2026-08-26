import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Result, type Result as BetterResult } from "better-result";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { AgentStoreError, isProgrammerDefect } from "./local-agent-errors.js";
import type { ServerConfig } from "./config.js";
import { canonicalizePath } from "./roots.js";
import {
  type AgentTerminalReason,
  type ExecutionContract,
  type PathStateFingerprint,
  type ScopeBaseline,
  type ScopeState,
  deserializeExecutionContract,
  serializeExecutionContract,
} from "./local-agent-contract.js";

export type LocalAgentStatus = "starting" | "running" | "idle" | "error" | "stopped";

/**
 * Durable cross-turn scope lifecycle evidence persisted beside the baseline.
 *
 * - `cumulativeChangedPaths`: worker-attributed paths from every completed
 *   turn, so writePaths/maxFiles stay enforced across continuation turns.
 * - `turnEndBaseline`: physical snapshot captured after a turn finishes, so
 *   foreign edits made while the agent is terminal are detectable (and never
 *   attributed to the worker) at continuation admission.
 */
export interface AgentLifecycleState {
  cumulativeChangedPaths?: string[];
  turnEndBaseline?: ScopeBaseline;
}

export interface LocalAgentRecord {
  id: string;
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  effort?: string;
  providerSessionId?: string;
  workerPid?: number;
  workerToken?: string;
  executionContract?: ExecutionContract;
  startReplay?: StartReplayBinding;
  terminalReason?: AgentTerminalReason;
  scopeState?: ScopeState;
  scopeBaseline?: ScopeBaseline;
  lifecycleState?: AgentLifecycleState;
  status: LocalAgentStatus;
  latestResponse?: string;
  error?: string;
  errorCode?: string;
  errorRetryable?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocalAgentRecordInput {
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  effort?: string;
  executionContract?: ExecutionContract;
  startReplay?: StartReplayBinding;
}

export interface LocalAgentWorkspaceScope {
  workspaceId?: string;
  workspaceRoot: string;
}

export interface StartReplayBinding {
  key: string;
  requestHash: string;
}

export class LocalAgentReplayConflictError extends Error {
  constructor(readonly existingAgentId: string) {
    super(`Attempt replay key is already bound to a materially different agent_start request.`);
    this.name = "LocalAgentReplayConflictError";
  }
}

export interface LocalAgentListScope {
  workspaceId?: string;
  workspaceRoot?: string;
}

interface LocalAgentRow {
  id: string;
  workspace_id: string | null;
  workspace_root: string;
  profile_name: string;
  provider: string;
  model: string | null;
  effort: string | null;
  provider_session_id: string | null;
  worker_pid: number | null;
  worker_token: string | null;
  execution_contract: string | null;
  terminal_reason: string | null;
  scope_state: string | null;
  scope_baseline: string | null;
  lifecycle_state: string | null;
  status: string;
  latest_response: string | null;
  error: string | null;
  error_code: string | null;
  error_retryable: string | null;
  created_at: string;
  updated_at: string;
}

export class LocalAgentStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  list(scope: LocalAgentListScope = {}): LocalAgentRecord[] {
    let rows: LocalAgentRow[];
    if (scope.workspaceId && scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ? and workspace_root = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId, resolve(scope.workspaceRoot)) as LocalAgentRow[];
    } else if (scope.workspaceId) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId) as LocalAgentRow[];
    } else if (scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_root = ?
           order by updated_at desc`,
        )
        .all(resolve(scope.workspaceRoot)) as LocalAgentRow[];
    } else {
      rows = this.database.sqlite
        .prepare("select * from local_agent_sessions order by updated_at desc")
        .all() as LocalAgentRow[];
    }

    return rows.map(rowToLocalAgentRecord);
  }

  listResult(scope: LocalAgentListScope = {}): BetterResult<LocalAgentRecord[], AgentStoreError> {
    return storeResult("list", () => this.list(scope));
  }

  create(input: CreateLocalAgentRecordInput): LocalAgentRecord {
    const now = new Date().toISOString();
    const record: LocalAgentRecord = {
      id: `agt_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      workspaceId: input.workspaceId,
      workspaceRoot: resolve(input.workspaceRoot),
      profileName: input.profileName,
      provider: input.provider,
      model: input.model,
      effort: input.effort,
      executionContract: input.executionContract,
      startReplay: input.startReplay,
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };

    this.database.sqlite
      .prepare(
        `insert into local_agent_sessions (
          id,
          workspace_id,
          workspace_root,
          profile_name,
          provider,
          model,
          effort,
          execution_contract,
          status,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId ?? null,
        record.workspaceRoot,
        record.profileName,
        record.provider,
        record.model ?? null,
        record.effort ?? null,
        serializeStoredExecutionState(record.executionContract, record.startReplay),
        record.status,
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

  createResult(input: CreateLocalAgentRecordInput): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("create", () => this.create(input));
  }

  resolveStartReplay(
    workspaceRoot: string,
    binding: StartReplayBinding,
  ): LocalAgentRecord | undefined {
    const rows = this.database.sqlite
      .prepare("select * from local_agent_sessions")
      .all() as LocalAgentRow[];
    const canonicalRoot = canonicalizePath(workspaceRoot);
    const matches = rows.filter((row) =>
      canonicalizePath(row.workspace_root) === canonicalRoot &&
      readStoredExecutionState(row.execution_contract).startReplay?.key === binding.key
    );
    if (matches.length > 1) {
      throw new LocalAgentReplayConflictError(matches[0]!.id);
    }
    const existing = matches[0];
    if (!existing) return undefined;
    const record = rowToLocalAgentRecord(existing);
    if (record.startReplay?.requestHash !== binding.requestHash) {
      throw new LocalAgentReplayConflictError(record.id);
    }
    return record;
  }

  createOrReplay(
    input: CreateLocalAgentRecordInput & { workspaceId: string; startReplay: StartReplayBinding },
  ): { record: LocalAgentRecord; created: boolean } {
    const create = this.database.sqlite.transaction(() => {
      const existing = this.resolveStartReplay(input.workspaceRoot, input.startReplay);
      if (existing) return { record: existing, created: false };
      return { record: this.create(input), created: true };
    });
    return create.immediate();
  }

  getById(id: string): LocalAgentRecord | undefined {
    const exact = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where id = ?
         limit 1`,
      )
      .get(id) as LocalAgentRow | undefined;
    return exact ? rowToLocalAgentRecord(exact) : undefined;
  }

  getByIdResult(id: string): BetterResult<LocalAgentRecord | undefined, AgentStoreError> {
    return storeResult("get", () => this.getById(id));
  }

  /**
   * Compatibility alias for callers that already use the store directly.
   * Resolves an exact id, a unique id prefix, or a provider session id.
   */
  get(idOrPrefix: string): LocalAgentRecord | undefined {
    const exact = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where id = ? or provider_session_id = ?
         limit 1`,
      )
      .get(idOrPrefix, idOrPrefix) as LocalAgentRow | undefined;
    if (exact) return rowToLocalAgentRecord(exact);

    const matches = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where id like ? escape '\\' or provider_session_id like ? escape '\\'
         order by updated_at desc`,
      )
      .all(`${escapeLike(idOrPrefix)}%`, `${escapeLike(idOrPrefix)}%`) as LocalAgentRow[];

    return matches.length === 1 ? rowToLocalAgentRecord(matches[0]!) : undefined;
  }

  update(id: string, patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>): LocalAgentRecord {
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown subagent id: ${id}`);

    const updated: LocalAgentRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    this.database.sqlite
      .prepare(
        `update local_agent_sessions set
          workspace_id = ?,
          workspace_root = ?,
          profile_name = ?,
          provider = ?,
          model = ?,
          effort = ?,
          provider_session_id = ?,
          worker_pid = ?,
          worker_token = ?,
          execution_contract = ?,
          terminal_reason = ?,
          scope_state = ?,
          scope_baseline = ?,
          lifecycle_state = ?,
          status = ?,
          latest_response = ?,
          error = ?,
          error_code = ?,
          error_retryable = ?,
          updated_at = ?
         where id = ?`,
      )
      .run(
        updated.workspaceId ?? null,
        resolve(updated.workspaceRoot),
        updated.profileName,
        updated.provider,
        updated.model ?? null,
        updated.effort ?? null,
        updated.providerSessionId ?? null,
        updated.workerPid ?? null,
        updated.workerToken ?? null,
        serializeStoredExecutionState(updated.executionContract, updated.startReplay),
        updated.terminalReason ?? null,
        updated.scopeState ?? null,
        updated.scopeBaseline ? JSON.stringify(updated.scopeBaseline) : null,
        updated.lifecycleState ? JSON.stringify(updated.lifecycleState) : null,
        updated.status,
        updated.latestResponse ?? null,
        updated.error ?? null,
        updated.errorCode ?? null,
        updated.errorRetryable === undefined ? null : String(updated.errorRetryable),
        updated.updatedAt,
        updated.id,
      );

    return updated;
  }

  updateResult(
    id: string,
    patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>,
  ): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("update", () => this.update(id, patch));
  }

  reconcileActiveRuns(message = "DevSpace restarted while this agent turn was running."): number {
    const now = new Date().toISOString();
    const result = this.database.sqlite
      .prepare(
        `update local_agent_sessions
         set status = 'error', error = ?, error_code = 'DAEMON_UNAVAILABLE', error_retryable = 'true', updated_at = ?
         where status in ('starting', 'running')`,
      )
      .run(message, now);
    return Number(result.changes);
  }

  reconcileActiveRunsResult(
    message = "DevSpace restarted while this agent turn was running.",
  ): BetterResult<number, AgentStoreError> {
    return storeResult("reconcile_active_runs", () => this.reconcileActiveRuns(message));
  }

  prepareWorker(id: string, workerToken: string): LocalAgentRecord {
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown subagent id: ${id}`);
    if (current.status !== "starting") {
      throw new Error(`Agent ${id} is ${current.status}, not starting.`);
    }
    return this.update(id, {
      workerPid: undefined,
      workerToken,
    });
  }

  claimWorker(id: string, workerToken: string, workerPid: number): LocalAgentRecord | undefined {
    const now = new Date().toISOString();
    const result = this.database.sqlite
      .prepare(
        `update local_agent_sessions set
          status = 'running',
          worker_pid = ?,
          updated_at = ?
         where id = ? and status = 'starting' and worker_token = ?`,
      )
      .run(workerPid, now, id, workerToken);
    return result.changes === 1 ? this.getById(id) : undefined;
  }

  finishWorker(
    id: string,
    workerToken: string,
    patch: {
      status: "idle" | "error";
      providerSessionId?: string;
      latestResponse?: string;
      error?: string;
      terminalReason?: AgentTerminalReason;
      scopeState?: ScopeState;
    },
  ): LocalAgentRecord {
    const now = new Date().toISOString();
    this.database.sqlite
      .prepare(
        `update local_agent_sessions set
          provider_session_id = coalesce(?, provider_session_id),
          status = ?,
          latest_response = ?,
          error = ?,
          terminal_reason = ?,
          scope_state = ?,
          worker_pid = null,
          worker_token = null,
          updated_at = ?
         where id = ? and status = 'running' and worker_token = ?`,
      )
      .run(
        patch.providerSessionId ?? null,
        patch.status,
        patch.latestResponse ?? null,
        patch.error ?? null,
        patch.terminalReason ?? null,
        patch.scopeState ?? null,
        now,
        id,
        workerToken,
      );
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown subagent id: ${id}`);
    return current;
  }

  cancelActive(id: string): { previous: LocalAgentRecord; current: LocalAgentRecord } {
    const cancel = this.database.sqlite.transaction(() => {
      const previous = this.getById(id);
      if (!previous) throw new Error(`Unknown subagent id: ${id}`);
      if (previous.status !== "starting" && previous.status !== "running") {
        return { previous, current: previous };
      }
      const current = this.update(id, {
        status: "stopped",
        workerPid: undefined,
        workerToken: undefined,
        error: "cancelled by operator",
        terminalReason: "cancelled",
      });
      return { previous, current };
    });
    return cancel.immediate();
  }

  close(): void {
    this.database.close();
  }
}

export function createLocalAgentStore(stateDir: string): LocalAgentStore {
  return new LocalAgentStore(stateDir);
}

function rowToLocalAgentRecord(row: LocalAgentRow): LocalAgentRecord {
  const storedExecution = readStoredExecutionState(row.execution_contract);
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root,
    profileName: row.profile_name,
    provider: row.provider,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
    workerPid: row.worker_pid ?? undefined,
    workerToken: row.worker_token ?? undefined,
    executionContract: storedExecution.executionContract,
    startReplay: storedExecution.startReplay,
    terminalReason: readTerminalReason(row.terminal_reason),
    scopeState: readScopeState(row.scope_state),
    scopeBaseline: readScopeBaseline(row.scope_baseline),
    lifecycleState: readLifecycleState(row.lifecycle_state),
    status: readStatus(row.status),
    latestResponse: row.latest_response ?? undefined,
    error: row.error ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorRetryable: readOptionalBoolean(row.error_retryable),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readOptionalBoolean(value: string | null): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function storeResult<T>(operation: string, run: () => T): BetterResult<T, AgentStoreError> {
  try {
    return Result.ok(run());
  } catch (cause) {
    if (isProgrammerDefect(cause)) throw cause;
    return Result.err(new AgentStoreError(operation, cause));
  }
}

function serializeStoredExecutionState(
  executionContract: ExecutionContract | undefined,
  startReplay: StartReplayBinding | undefined,
): string | null {
  if (!startReplay) return serializeExecutionContract(executionContract);
  return JSON.stringify({
    storedExecutionStateVersion: 1,
    executionContract: executionContract ?? null,
    startReplay,
  });
}

function readStoredExecutionState(value: string | null | undefined): {
  executionContract?: ExecutionContract;
  startReplay?: StartReplayBinding;
} {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.storedExecutionStateVersion !== 1) {
      return { executionContract: deserializeExecutionContract(value) };
    }
    const replay = parsed.startReplay as Record<string, unknown> | undefined;
    const startReplay = replay && typeof replay.key === "string" && typeof replay.requestHash === "string"
      ? { key: replay.key, requestHash: replay.requestHash }
      : undefined;
    const executionContract = parsed.executionContract === null
      ? undefined
      : deserializeExecutionContract(JSON.stringify(parsed.executionContract));
    return { executionContract, startReplay };
  } catch {
    return {};
  }
}

function readStatus(status: string): LocalAgentStatus {
  if (
    status === "starting" ||
    status === "running" ||
    status === "idle" ||
    status === "error" ||
    status === "stopped"
  ) {
    return status;
  }
  return "error";
}

function readTerminalReason(value: string | null | undefined): AgentTerminalReason | undefined {
  if (!value) return undefined;
  const reasons: AgentTerminalReason[] = [
    "completed",
    "cancelled",
    "timeout",
    "idle_timeout",
    "scope_violation",
    "provider_error",
    "launch_failed",
    "unknown",
  ];
  return reasons.includes(value as AgentTerminalReason) ? (value as AgentTerminalReason) : "unknown";
}

function readScopeState(value: string | null | undefined): ScopeState | undefined {
  if (!value) return undefined;
  if (value === "WITHIN_SCOPE" || value === "SCOPE_VIOLATION" || value === "UNKNOWN") {
    return value;
  }
  return "UNKNOWN";
}

function readScopeBaseline(value: string | null | undefined): ScopeBaseline | undefined {  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const changedPaths = Array.isArray(parsed.changedPaths)
      ? parsed.changedPaths.filter((entry): entry is string => typeof entry === "string")
      : [];
    const head = typeof parsed.head === "string" || parsed.head === null ? parsed.head : null;
    const fingerprints = readScopeBaselineFingerprints(parsed.fingerprints);
    return fingerprints ? { changedPaths, head, fingerprints } : { changedPaths, head };
  } catch {
    return undefined;
  }
}

function readScopeBaselineFingerprints(value: unknown): Record<string, PathStateFingerprint> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fingerprints: Record<string, PathStateFingerprint> = {};
  for (const [path, entry] of Object.entries(value as Record<string, unknown>)) {
    const fingerprint = readPathStateFingerprint(entry);
    if (fingerprint) fingerprints[path] = fingerprint;
  }
  return Object.keys(fingerprints).length > 0 ? fingerprints : undefined;
}

function readPathStateFingerprint(value: unknown): PathStateFingerprint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== "modified" && record.kind !== "untracked" && record.kind !== "deleted") {
    return undefined;
  }
  if (record.contentHash !== null && typeof record.contentHash !== "string") return undefined;
  if (typeof record.size !== "number" || !Number.isFinite(record.size) || record.size < 0) {
    return undefined;
  }
  // Entries lacking a non-empty gitStateHash are legacy/incomplete: ignoring
  // them leaves fingerprint coverage partial so attribution degrades UNKNOWN.
  if (typeof record.gitStateHash !== "string" || record.gitStateHash.length === 0) {
    return undefined;
  }
  return {
    kind: record.kind,
    contentHash: record.contentHash,
    size: record.size,
    gitStateHash: record.gitStateHash,
  };
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function readLifecycleState(value: string | null | undefined): AgentLifecycleState | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const state: AgentLifecycleState = {};
    if (Array.isArray(parsed.cumulativeChangedPaths)) {
      const paths = parsed.cumulativeChangedPaths.filter((entry): entry is string => typeof entry === "string");
      if (paths.length > 0) state.cumulativeChangedPaths = paths;
    }
    if (parsed.turnEndBaseline !== undefined && parsed.turnEndBaseline !== null) {
      // Reuse the strict baseline reader by round-tripping through JSON so a
      // corrupt or legacy turn-end snapshot degrades to absent evidence.
      const baseline = readScopeBaseline(JSON.stringify(parsed.turnEndBaseline));
      if (baseline) state.turnEndBaseline = baseline;
    }
    return Object.keys(state).length > 0 ? state : undefined;
  } catch {
    return undefined;
  }
}
