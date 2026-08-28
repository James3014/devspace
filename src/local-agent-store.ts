import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Result, type Result as BetterResult } from "better-result";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { AgentStoreError, isProgrammerDefect } from "./local-agent-errors.js";
import type { ServerConfig } from "./config.js";
import { canonicalizePath } from "./roots.js";
import {
  type ActiveTurnState,
  type AgentLifecycleKind,
  type AgentTerminalReason,
  type AgentTurnLaunchState,
  type ExecutionContract,
  type PathStateFingerprint,
  type ScopeBaseline,
  type ScopeState,
  type TerminationPendingState,
  deserializeExecutionContract,
  serializeExecutionContract,
} from "./local-agent-contract.js";

export type LocalAgentStatus = "starting" | "running" | "idle" | "error" | "stopped";

const DETACHED_AUTHORITY_FIELDS: Array<keyof LocalAgentRecord> = [
  "providerSessionId",
  "workerPid",
  "workerToken",
  "terminalReason",
  "scopeState",
  "scopeBaseline",
  "lifecycleState",
  "status",
  "latestResponse",
  "error",
  "errorCode",
  "errorRetryable",
];

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
  lifecycleKind?: AgentLifecycleKind;
  cumulativeChangedPaths?: string[];
  turnEndBaseline?: ScopeBaseline;
  activeTurn?: ActiveTurnState;
  terminationPending?: TerminationPendingState;
  /** Parser evidence that a persisted pending-looking lifecycle is malformed. */
  lifecycleCorrupt?: true;
  /** Last generation settled by normal completion or verified termination. */
  lastSettledGeneration?: string;
  /** Legacy detached row whose exact physical target cannot be reconstructed. */
  terminationBlocked?: {
    detectedAt: string;
    reason: string;
  };
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
  lifecycleKind?: AgentLifecycleKind;
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

export interface FenceActiveTurnInput {
  agentId: string;
  expectedPhase?: "startup" | "execution" | "any";
  budgetMs?: number;
  terminalReason: AgentTerminalReason;
  error: string;
}

export interface FenceActiveTurnResult {
  applied: boolean;
  previous?: LocalAgentRecord;
  current?: LocalAgentRecord;
}

export interface LifecycleCasResult {
  applied: boolean;
  previous?: LocalAgentRecord;
  current?: LocalAgentRecord;
}

export interface BeginContinuationCasInput {
  agentId: string;
  expectedPreviousGeneration?: string;
  expectedUpdatedAt?: string;
  turnStartedAt?: string;
}

export interface BeginTerminationCasInput extends FenceActiveTurnInput {
  terminalStatus?: "error" | "stopped";
  errorCode?: string;
  errorRetryable?: boolean;
}

export interface FinishTurnCasInput {
  agentId: string;
  generation: string;
  workerToken: string;
  status: "idle" | "error";
  providerSessionId?: string;
  latestResponse?: string;
  error?: string;
  terminalReason?: AgentTerminalReason;
  scopeState?: ScopeState;
  cumulativeChangedPaths?: string[];
  turnEndBaseline?: ScopeBaseline;
}

export interface CompleteTerminationCasInput {
  agentId: string;
  generation: string;
  workerPid?: number;
  workerToken?: string;
  turnEndBaseline: ScopeBaseline;
  cumulativeChangedPaths?: string[];
  scopeState?: ScopeState;
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
      lifecycleState: input.lifecycleKind === "detached_worker_v2"
        ? {
            lifecycleKind: "detached_worker_v2",
            activeTurn: {
              generation: randomUUID(),
              turnStartedAt: now,
              launchState: "not_started",
            },
          }
        : {
            activeTurn: { turnStartedAt: now },
          },
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
          lifecycle_state,
          status,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        record.lifecycleState ? JSON.stringify(record.lifecycleState) : null,
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
    if (
      isDetachedLifecycle(current.lifecycleState) &&
      DETACHED_AUTHORITY_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(patch, field))
    ) {
      throw new Error(
        `Generic update cannot mutate generation-owned detached lifecycle fields for agent ${id}.`,
      );
    }

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

  beginContinuationCAS(input: BeginContinuationCasInput): LifecycleCasResult {
    const begin = this.database.sqlite.transaction(() => {
      const current = this.getById(input.agentId);
      if (!current) return { applied: false };
      const lifecycle = current.lifecycleState;
      if (
        !isDetachedLifecycle(lifecycle) ||
        current.status === "starting" ||
        current.status === "running" ||
        lifecycle?.activeTurn ||
        lifecycle?.terminationPending ||
        lifecycle?.lifecycleCorrupt ||
        (input.expectedUpdatedAt !== undefined && current.updatedAt !== input.expectedUpdatedAt) ||
        (input.expectedPreviousGeneration !== undefined &&
          lifecycle?.lastSettledGeneration !== input.expectedPreviousGeneration)
      ) {
        return { applied: false, previous: current, current };
      }

      const now = input.turnStartedAt ?? new Date().toISOString();
      const updatedLifecycle: AgentLifecycleState = {
        ...lifecycle,
        activeTurn: {
          generation: randomUUID(),
          turnStartedAt: now,
          launchState: "not_started",
        },
        terminationPending: undefined,
        lifecycleCorrupt: undefined,
      };
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set
          status = 'starting', latest_response = null, error = null,
          error_code = null, error_retryable = null, terminal_reason = null,
          worker_pid = null, worker_token = null, lifecycle_state = ?, updated_at = ?
         where id = ? and updated_at = ?`,
      ).run(JSON.stringify(updatedLifecycle), now, input.agentId, current.updatedAt);
      const refreshed = this.getById(input.agentId) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return begin.immediate();
  }

  prepareWorkerCAS(id: string, generation: string, workerToken: string): LifecycleCasResult {
    const prepare = this.database.sqlite.transaction(() => {
      const current = this.getById(id);
      if (!current) return { applied: false };
      const activeTurn = current.lifecycleState?.activeTurn;
      if (
        !isDetachedLifecycle(current.lifecycleState) ||
        current.status !== "starting" ||
        !activeTurn ||
        activeTurn.generation !== generation ||
        current.lifecycleState?.terminationPending ||
        current.lifecycleState?.lifecycleCorrupt
      ) {
        return { applied: false, previous: current, current };
      }
      const lifecycleState: AgentLifecycleState = {
        ...current.lifecycleState,
        activeTurn: { ...activeTurn, launchState: "launching" },
      };
      const now = new Date().toISOString();
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set worker_pid = null, worker_token = ?, lifecycle_state = ?, updated_at = ?
         where id = ? and status = 'starting' and updated_at = ?`,
      ).run(workerToken, JSON.stringify(lifecycleState), now, id, current.updatedAt);
      const refreshed = this.getById(id) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return prepare.immediate();
  }

  markWorkerSpawnedCAS(
    id: string,
    generation: string,
    workerToken: string,
    workerPid?: number,
  ): LifecycleCasResult {
    return this.bindWorkerProcessCAS(id, generation, workerToken, workerPid, "spawned", false);
  }

  claimWorkerCAS(id: string, generation: string, workerToken: string, workerPid: number): LifecycleCasResult {
    return this.bindWorkerProcessCAS(id, generation, workerToken, workerPid, "claimed", true);
  }

  private bindWorkerProcessCAS(
    id: string,
    generation: string,
    workerToken: string,
    workerPid: number | undefined,
    launchState: "spawned" | "claimed",
    claim: boolean,
  ): LifecycleCasResult {
    const bind = this.database.sqlite.transaction(() => {
      const current = this.getById(id);
      if (!current) return { applied: false };
      const lifecycle = current.lifecycleState;
      const activeTurn = lifecycle?.activeTurn;
      const pending = lifecycle?.terminationPending;
      if (!isDetachedLifecycle(lifecycle) || lifecycle.lifecycleCorrupt || current.workerToken !== workerToken) {
        return { applied: false, previous: current, current };
      }

      let lifecycleState: AgentLifecycleState;
      let status = current.status;
      if (
        activeTurn?.generation === generation &&
        !pending &&
        current.status === "starting"
      ) {
        lifecycleState = {
          ...lifecycle,
          activeTurn: { ...activeTurn, launchState },
        };
        if (claim) status = "running";
      } else if (pending?.generation === generation && pending.workerToken === workerToken) {
        lifecycleState = {
          ...lifecycle,
          terminationPending: {
            ...pending,
            workerPid: workerPid ?? pending.workerPid,
            launchState: laterLaunchState(pending.launchState, launchState),
          },
        };
      } else {
        return { applied: false, previous: current, current };
      }

      const now = new Date().toISOString();
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set status = ?, worker_pid = ?, lifecycle_state = ?, updated_at = ?
         where id = ? and worker_token = ? and updated_at = ?`,
      ).run(
        status,
        workerPid ?? current.workerPid ?? null,
        JSON.stringify(lifecycleState),
        now,
        id,
        workerToken,
        current.updatedAt,
      );
      const refreshed = this.getById(id) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return bind.immediate();
  }

  markExecutionStarted(
    id: string,
    workerToken: string,
    executionStartedAt = new Date().toISOString(),
    expectedGeneration?: string,
  ): LocalAgentRecord {
    const mark = this.database.sqlite.transaction(() => {
      const current = this.getById(id);
      if (!current) throw new Error(`Unknown subagent id: ${id}`);
      const activeTurn = current.lifecycleState?.activeTurn;
      if (
        current.status !== "running" ||
        !isDetachedLifecycle(current.lifecycleState) ||
        current.workerToken !== workerToken ||
        !activeTurn ||
        (expectedGeneration !== undefined && activeTurn.generation !== expectedGeneration) ||
        current.lifecycleState?.terminationPending ||
        current.lifecycleState?.lifecycleCorrupt
      ) {
        throw new Error(
          `Agent ${id} is no longer active under worker token ${workerToken} (status: ${current.status}).`,
        );
      }
      if (activeTurn.executionStartedAt) return current;
      const lifecycleState: AgentLifecycleState = {
        ...current.lifecycleState,
        activeTurn: { ...activeTurn, executionStartedAt },
      };
      const now = new Date().toISOString();
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set lifecycle_state = ?, updated_at = ?
         where id = ? and status = 'running' and worker_token = ? and updated_at = ?`,
      ).run(JSON.stringify(lifecycleState), now, id, workerToken, current.updatedAt);
      if (result.changes !== 1) {
        throw new Error(`Agent ${id} execution transition failed ownership guard.`);
      }
      return this.getById(id) ?? current;
    });
    return mark.immediate();
  }

  updateTurnEvidenceCAS(
    id: string,
    generation: string,
    workerToken: string,
    patch: { scopeBaseline?: ScopeBaseline; cumulativeChangedPaths?: string[] },
  ): LifecycleCasResult {
    const updateEvidence = this.database.sqlite.transaction(() => {
      const current = this.getById(id);
      if (!current) return { applied: false };
      const lifecycle = current.lifecycleState;
      if (
        !isDetachedLifecycle(lifecycle) ||
        !lifecycle?.activeTurn ||
        lifecycle.activeTurn.generation !== generation ||
        lifecycle.terminationPending ||
        lifecycle.lifecycleCorrupt ||
        current.workerToken !== workerToken ||
        (current.status !== "starting" && current.status !== "running")
      ) {
        return { applied: false, previous: current, current };
      }
      const lifecycleState: AgentLifecycleState = {
        ...lifecycle,
        cumulativeChangedPaths: patch.cumulativeChangedPaths ?? lifecycle.cumulativeChangedPaths,
      };
      const now = new Date().toISOString();
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set scope_baseline = ?, lifecycle_state = ?, updated_at = ?
         where id = ? and worker_token = ? and updated_at = ?`,
      ).run(
        patch.scopeBaseline === undefined
          ? (current.scopeBaseline ? JSON.stringify(current.scopeBaseline) : null)
          : JSON.stringify(patch.scopeBaseline),
        JSON.stringify(lifecycleState),
        now,
        id,
        workerToken,
        current.updatedAt,
      );
      const refreshed = this.getById(id) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return updateEvidence.immediate();
  }

  bindProviderSessionCAS(
    id: string,
    generation: string,
    workerToken: string,
    providerSessionId: string,
  ): LifecycleCasResult {
    const bind = this.database.sqlite.transaction(() => {
      const current = this.getById(id);
      if (!current) return { applied: false };
      const lifecycle = current.lifecycleState;
      if (
        !isDetachedLifecycle(lifecycle) ||
        !lifecycle?.activeTurn ||
        lifecycle.activeTurn.generation !== generation ||
        lifecycle.terminationPending ||
        lifecycle.lifecycleCorrupt ||
        current.workerToken !== workerToken ||
        (current.status !== "starting" && current.status !== "running")
      ) {
        return { applied: false, previous: current, current };
      }
      const now = new Date().toISOString();
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set provider_session_id = ?, updated_at = ?
         where id = ? and worker_token = ? and updated_at = ?`,
      ).run(providerSessionId, now, id, workerToken, current.updatedAt);
      const refreshed = this.getById(id) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return bind.immediate();
  }

  finishTurnCAS(input: FinishTurnCasInput): LifecycleCasResult {
    const finish = this.database.sqlite.transaction(() => {
      const current = this.getById(input.agentId);
      if (!current) return { applied: false };
      const lifecycle = current.lifecycleState;
      if (
        !isDetachedLifecycle(lifecycle) ||
        current.status !== "running" ||
        current.workerToken !== input.workerToken ||
        lifecycle?.activeTurn?.generation !== input.generation ||
        lifecycle.terminationPending ||
        lifecycle.lifecycleCorrupt
      ) {
        return { applied: false, previous: current, current };
      }
      const lifecycleState: AgentLifecycleState = {
        ...lifecycle,
        activeTurn: undefined,
        terminationPending: undefined,
        lastSettledGeneration: input.generation,
        cumulativeChangedPaths: input.cumulativeChangedPaths ?? lifecycle.cumulativeChangedPaths,
        turnEndBaseline: input.turnEndBaseline ?? lifecycle.turnEndBaseline,
      };
      const now = new Date().toISOString();
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set provider_session_id = coalesce(?, provider_session_id),
          status = ?, latest_response = ?, error = ?, terminal_reason = ?, scope_state = ?,
          worker_pid = null, worker_token = null, lifecycle_state = ?, updated_at = ?
         where id = ? and status = 'running' and worker_token = ? and updated_at = ?`,
      ).run(
        input.providerSessionId ?? null,
        input.status,
        input.latestResponse ?? null,
        input.error ?? null,
        input.terminalReason ?? null,
        input.scopeState ?? null,
        JSON.stringify(lifecycleState),
        now,
        input.agentId,
        input.workerToken,
        current.updatedAt,
      );
      const refreshed = this.getById(input.agentId) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return finish.immediate();
  }

  failTurnCAS(input: Omit<FinishTurnCasInput, "status">): LifecycleCasResult {
    return this.finishTurnCAS({ ...input, status: "error" });
  }

  failLaunchCAS(
    id: string,
    generation: string,
    workerToken: string,
    error: string,
  ): LifecycleCasResult {
    const fail = this.database.sqlite.transaction(() => {
      const current = this.getById(id);
      if (!current) return { applied: false };
      const lifecycle = current.lifecycleState;
      if (
        !isDetachedLifecycle(lifecycle) ||
        current.status !== "starting" ||
        current.workerToken !== workerToken ||
        lifecycle?.activeTurn?.generation !== generation ||
        lifecycle.terminationPending ||
        lifecycle.lifecycleCorrupt
      ) {
        return { applied: false, previous: current, current };
      }
      const lifecycleState: AgentLifecycleState = {
        ...lifecycle,
        activeTurn: undefined,
        lastSettledGeneration: generation,
      };
      const now = new Date().toISOString();
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set status = 'error', worker_pid = null, worker_token = null,
          error = ?, terminal_reason = 'launch_failed', lifecycle_state = ?, updated_at = ?
         where id = ? and status = 'starting' and worker_token = ? and updated_at = ?`,
      ).run(error, JSON.stringify(lifecycleState), now, id, workerToken, current.updatedAt);
      const refreshed = this.getById(id) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return fail.immediate();
  }

  beginTerminationCAS(input: BeginTerminationCasInput): LifecycleCasResult {
    const begin = this.database.sqlite.transaction(() => {
      const current = this.getById(input.agentId);
      if (!current) return { applied: false };
      const lifecycle = current.lifecycleState;
      if (
        !isDetachedLifecycle(lifecycle) ||
        lifecycle.terminationPending ||
        lifecycle.lifecycleCorrupt ||
        lifecycle.terminationBlocked
      ) {
        return { applied: false, previous: current, current };
      }
      const activeTurn = lifecycle?.activeTurn;
      if (
        !activeTurn?.generation ||
        !activeTurn.launchState ||
        (current.status !== "starting" && current.status !== "running")
      ) {
        return { applied: false, previous: current, current };
      }

      const nowMs = Date.now();
      const turnStartedAtMs = Date.parse(activeTurn.turnStartedAt);
      const executionStartedAtMs = activeTurn.executionStartedAt
        ? Date.parse(activeTurn.executionStartedAt)
        : undefined;
      if (input.expectedPhase === "startup") {
        if (executionStartedAtMs !== undefined) return { applied: false, previous: current, current };
        if (input.budgetMs !== undefined && nowMs - turnStartedAtMs <= input.budgetMs) {
          return { applied: false, previous: current, current };
        }
      } else if (input.expectedPhase === "execution") {
        if (executionStartedAtMs === undefined) return { applied: false, previous: current, current };
        if (input.budgetMs !== undefined && nowMs - executionStartedAtMs <= input.budgetMs) {
          return { applied: false, previous: current, current };
        }
      } else if (input.budgetMs !== undefined && nowMs - turnStartedAtMs <= input.budgetMs) {
        return { applied: false, previous: current, current };
      }

      const now = new Date().toISOString();
      const pending: TerminationPendingState = {
        generation: activeTurn.generation,
        requestedAt: now,
        reason: input.terminalReason,
        terminalStatus: input.terminalStatus ?? "error",
        previousStatus: current.status,
        workerToken: current.workerToken,
        workerPid: current.workerPid,
        launchState: activeTurn.launchState,
      };
      const lifecycleState: AgentLifecycleState = {
        ...lifecycle,
        activeTurn: undefined,
        terminationPending: pending,
      };
      const scopeState = input.terminalReason === "scope_violation"
        ? "SCOPE_VIOLATION"
        : current.scopeState;
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set status = ?, terminal_reason = ?, error = ?,
          error_code = ?, error_retryable = ?, scope_state = ?, lifecycle_state = ?, updated_at = ?
         where id = ? and status in ('starting', 'running') and updated_at = ?`,
      ).run(
        pending.terminalStatus,
        input.terminalReason,
        input.error,
        input.errorCode ?? null,
        input.errorRetryable === undefined ? null : String(input.errorRetryable),
        scopeState ?? null,
        JSON.stringify(lifecycleState),
        now,
        input.agentId,
        current.updatedAt,
      );
      const refreshed = this.getById(input.agentId) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return begin.immediate();
  }

  recordTerminationFailureCAS(input: {
    agentId: string;
    generation: string;
    workerPid?: number;
    workerToken?: string;
    failure: string;
  }): LifecycleCasResult {
    const fail = this.database.sqlite.transaction(() => {
      const current = this.getById(input.agentId);
      if (!current) return { applied: false };
      const pending = current.lifecycleState?.terminationPending;
      if (
        !isDetachedLifecycle(current.lifecycleState) ||
        !pending ||
        current.lifecycleState?.lifecycleCorrupt ||
        pending.generation !== input.generation ||
        pending.workerPid !== input.workerPid ||
        pending.workerToken !== input.workerToken ||
        current.workerPid !== input.workerPid ||
        current.workerToken !== input.workerToken
      ) {
        return { applied: false, previous: current, current };
      }
      const now = new Date().toISOString();
      const lifecycleState: AgentLifecycleState = {
        ...current.lifecycleState,
        terminationPending: { ...pending, lastAttemptAt: now, lastFailure: input.failure },
      };
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set error = ?, lifecycle_state = ?, updated_at = ?
         where id = ? and updated_at = ?`,
      ).run(input.failure, JSON.stringify(lifecycleState), now, input.agentId, current.updatedAt);
      const refreshed = this.getById(input.agentId) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return fail.immediate();
  }

  completeTerminationCAS(input: CompleteTerminationCasInput): LifecycleCasResult {
    const complete = this.database.sqlite.transaction(() => {
      const current = this.getById(input.agentId);
      if (!current) return { applied: false };
      const pending = current.lifecycleState?.terminationPending;
      if (
        !isDetachedLifecycle(current.lifecycleState) ||
        !pending ||
        current.lifecycleState?.lifecycleCorrupt ||
        pending.generation !== input.generation ||
        pending.workerPid !== input.workerPid ||
        pending.workerToken !== input.workerToken ||
        current.workerPid !== input.workerPid ||
        current.workerToken !== input.workerToken
      ) {
        return { applied: false, previous: current, current };
      }
      const lifecycleState: AgentLifecycleState = {
        ...current.lifecycleState,
        terminationPending: undefined,
        lifecycleCorrupt: undefined,
        lastSettledGeneration: input.generation,
        cumulativeChangedPaths: input.cumulativeChangedPaths ?? current.lifecycleState?.cumulativeChangedPaths,
        turnEndBaseline: input.turnEndBaseline,
      };
      const now = new Date().toISOString();
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set worker_pid = null, worker_token = null,
          scope_state = ?, lifecycle_state = ?, updated_at = ?
         where id = ? and updated_at = ?`,
      ).run(
        input.scopeState ?? current.scopeState ?? null,
        JSON.stringify(lifecycleState),
        now,
        input.agentId,
        current.updatedAt,
      );
      const refreshed = this.getById(input.agentId) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return complete.immediate();
  }

  fenceActiveTurn(input: FenceActiveTurnInput): FenceActiveTurnResult {
    return this.beginTerminationCAS({ ...input, terminalStatus: "error" });
  }

  reconcileLegacyDetachedActiveCAS(
    id: string,
    message = "DevSpace restarted while this agent turn was running.",
  ): LifecycleCasResult {
    const reconcile = this.database.sqlite.transaction(() => {
      const current = this.getById(id);
      if (!current) return { applied: false };
      if (
        isDetachedLifecycle(current.lifecycleState) ||
        (current.status !== "starting" && current.status !== "running") ||
        !current.lifecycleState?.activeTurn
      ) {
        return { applied: false, previous: current, current };
      }

      const hasPid = current.workerPid !== undefined;
      const hasToken = current.workerToken !== undefined;
      if (!hasPid && !hasToken) {
        return { applied: false, previous: current, current };
      }

      const now = new Date().toISOString();
      const generation = randomUUID();
      const lifecycleState: AgentLifecycleState = hasPid && hasToken
        ? {
            ...current.lifecycleState,
            lifecycleKind: "detached_worker_v2",
            activeTurn: undefined,
            terminationPending: {
              generation,
              requestedAt: now,
              reason: "unknown",
              terminalStatus: "error",
              previousStatus: current.status,
              workerPid: current.workerPid,
              workerToken: current.workerToken,
              launchState: "claimed",
            },
          }
        : {
            ...current.lifecycleState,
            lifecycleKind: "detached_worker_v2",
            activeTurn: undefined,
            terminationBlocked: {
              detectedAt: now,
              reason: "Legacy detached worker ownership is incomplete; exact PID and token are both required.",
            },
          };
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set status = 'error', terminal_reason = 'unknown',
          error = ?, error_code = 'DAEMON_UNAVAILABLE', error_retryable = 'true',
          lifecycle_state = ?, updated_at = ?
         where id = ? and status in ('starting', 'running') and updated_at = ?`,
      ).run(message, JSON.stringify(lifecycleState), now, id, current.updatedAt);
      const refreshed = this.getById(id) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return reconcile.immediate();
  }

  reconcileActiveRuns(message = "DevSpace restarted while this agent turn was running."): number {
    let reconciled = 0;
    for (const record of this.list()) {
      if (record.status !== "starting" && record.status !== "running") continue;
      if (isDetachedLifecycle(record.lifecycleState)) {
        const result = this.beginTerminationCAS({
          agentId: record.id,
          terminalReason: "unknown",
          terminalStatus: "error",
          error: message,
          errorCode: "DAEMON_UNAVAILABLE",
          errorRetryable: true,
        });
        if (result.applied) reconciled += 1;
        continue;
      }
      const adopted = this.reconcileLegacyDetachedActiveCAS(record.id, message);
      if (adopted.applied) {
        reconciled += 1;
        continue;
      }
      const current = adopted.current ?? record;
      if (!isDetachedLifecycle(current.lifecycleState)) {
        this.update(current.id, {
          status: "error",
          error: message,
          errorCode: "DAEMON_UNAVAILABLE",
          errorRetryable: true,
        });
        reconciled += 1;
      }
    }
    return reconciled;
  }

  reconcileActiveRunsResult(
    message = "DevSpace restarted while this agent turn was running.",
  ): BetterResult<number, AgentStoreError> {
    return storeResult("reconcile_active_runs", () => this.reconcileActiveRuns(message));
  }

  prepareWorker(id: string, workerToken: string): LocalAgentRecord {
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown subagent id: ${id}`);
    const generation = current.lifecycleState?.activeTurn?.generation;
    if (current.status !== "starting" || !generation) {
      throw new Error(`Agent ${id} is ${current.status}, not starting.`);
    }
    const result = this.prepareWorkerCAS(id, generation, workerToken);
    if (!result.applied || !result.current) throw new Error(`Agent ${id} worker preparation lost its generation guard.`);
    return result.current;
  }

  claimWorker(id: string, workerToken: string, workerPid: number): LocalAgentRecord | undefined {
    const current = this.getById(id);
    const generation = current?.lifecycleState?.activeTurn?.generation
      ?? current?.lifecycleState?.terminationPending?.generation;
    if (!generation) return undefined;
    const result = this.claimWorkerCAS(id, generation, workerToken, workerPid);
    return result.applied ? result.current : undefined;
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
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown subagent id: ${id}`);
    const generation = current.lifecycleState?.activeTurn?.generation;
    if (!generation) return current;
    return this.finishTurnCAS({ ...patch, agentId: id, generation, workerToken }).current ?? current;
  }

  cancelActive(id: string): { previous: LocalAgentRecord; current: LocalAgentRecord } {
    const previous = this.getById(id);
    if (!previous) throw new Error(`Unknown subagent id: ${id}`);
    const result = this.beginTerminationCAS({
      agentId: id,
      terminalReason: "cancelled",
      terminalStatus: "stopped",
      error: "cancelled by operator",
    });
    return { previous: result.previous ?? previous, current: result.current ?? previous };
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
    const detached = parsed.lifecycleKind === "detached_worker_v2";
    if (detached) state.lifecycleKind = "detached_worker_v2";
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
    if (detached && typeof parsed.lastSettledGeneration === "string" && parsed.lastSettledGeneration) {
      state.lastSettledGeneration = parsed.lastSettledGeneration;
    }
    if (!detached) {
      const legacyActiveTurn = readLegacyActiveTurnState(parsed.activeTurn);
      if (legacyActiveTurn) state.activeTurn = legacyActiveTurn;
      return Object.keys(state).length > 0 ? state : undefined;
    }

    const activeTurn = readActiveTurnState(parsed.activeTurn);
    const terminationPending = readTerminationPendingState(parsed.terminationPending);
    const terminationBlocked = readTerminationBlockedState(parsed.terminationBlocked);
    const activeLooking = parsed.activeTurn !== undefined && parsed.activeTurn !== null;
    const pendingLooking = parsed.terminationPending !== undefined && parsed.terminationPending !== null;
    const blockedLooking = parsed.terminationBlocked !== undefined && parsed.terminationBlocked !== null;
    const authorityStateCount = Number(Boolean(activeTurn)) + Number(Boolean(terminationPending)) + Number(Boolean(terminationBlocked));
    if (
      parsed.lifecycleCorrupt === true ||
      (activeLooking && !activeTurn) ||
      (pendingLooking && !terminationPending) ||
      (blockedLooking && !terminationBlocked) ||
      authorityStateCount > 1
    ) {
      state.lifecycleCorrupt = true;
    } else {
      if (activeTurn) state.activeTurn = activeTurn;
      if (terminationPending) state.terminationPending = terminationPending;
      if (terminationBlocked) state.terminationBlocked = terminationBlocked;
    }
    return Object.keys(state).length > 0 ? state : undefined;
  } catch {
    return value.includes("detached_worker_v2")
      ? { lifecycleKind: "detached_worker_v2", lifecycleCorrupt: true }
      : undefined;
  }
}

function readLegacyActiveTurnState(value: unknown): ActiveTurnState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.turnStartedAt !== "string") return undefined;
  return {
    turnStartedAt: record.turnStartedAt,
    executionStartedAt: typeof record.executionStartedAt === "string"
      ? record.executionStartedAt
      : undefined,
  };
}

function readActiveTurnState(value: unknown): ActiveTurnState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const launchState = readLaunchState(record.launchState);
  if (
    typeof record.generation !== "string" ||
    !record.generation ||
    typeof record.turnStartedAt !== "string" ||
    !Number.isFinite(Date.parse(record.turnStartedAt)) ||
    !launchState ||
    (record.executionStartedAt !== undefined &&
      (typeof record.executionStartedAt !== "string" || !Number.isFinite(Date.parse(record.executionStartedAt))))
  ) {
    return undefined;
  }
  return {
    generation: record.generation,
    turnStartedAt: record.turnStartedAt,
    executionStartedAt: record.executionStartedAt as string | undefined,
    launchState,
  };
}

function readTerminationBlockedState(value: unknown): AgentLifecycleState["terminationBlocked"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.detectedAt !== "string" ||
    !Number.isFinite(Date.parse(record.detectedAt)) ||
    typeof record.reason !== "string" ||
    !record.reason
  ) {
    return undefined;
  }
  return { detectedAt: record.detectedAt, reason: record.reason };
}

function readTerminationPendingState(value: unknown): TerminationPendingState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const launchState = readLaunchState(record.launchState);
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
  const reason = typeof record.reason === "string" && reasons.includes(record.reason as AgentTerminalReason)
    ? record.reason as AgentTerminalReason
    : undefined;
  if (
    typeof record.generation !== "string" ||
    !record.generation ||
    typeof record.requestedAt !== "string" ||
    !Number.isFinite(Date.parse(record.requestedAt)) ||
    !reason ||
    (record.terminalStatus !== "error" && record.terminalStatus !== "stopped") ||
    (record.previousStatus !== "starting" && record.previousStatus !== "running") ||
    !launchState ||
    (record.workerToken !== undefined && (typeof record.workerToken !== "string" || !record.workerToken)) ||
    (record.workerPid !== undefined &&
      (typeof record.workerPid !== "number" || !Number.isInteger(record.workerPid) || record.workerPid < 1)) ||
    (record.lastAttemptAt !== undefined &&
      (typeof record.lastAttemptAt !== "string" || !Number.isFinite(Date.parse(record.lastAttemptAt)))) ||
    (record.lastFailure !== undefined && typeof record.lastFailure !== "string")
  ) {
    return undefined;
  }
  return {
    generation: record.generation,
    requestedAt: record.requestedAt,
    reason,
    terminalStatus: record.terminalStatus,
    previousStatus: record.previousStatus,
    workerToken: record.workerToken as string | undefined,
    workerPid: record.workerPid as number | undefined,
    launchState,
    lastAttemptAt: record.lastAttemptAt as string | undefined,
    lastFailure: record.lastFailure as string | undefined,
  };
}

function readLaunchState(value: unknown): AgentTurnLaunchState | undefined {
  return value === "not_started" || value === "launching" || value === "spawned" || value === "claimed"
    ? value
    : undefined;
}

function laterLaunchState(
  current: AgentTurnLaunchState,
  candidate: AgentTurnLaunchState,
): AgentTurnLaunchState {
  const order: AgentTurnLaunchState[] = ["not_started", "launching", "spawned", "claimed"];
  return order.indexOf(candidate) > order.indexOf(current) ? candidate : current;
}

export function isDetachedLifecycle(
  state: AgentLifecycleState | undefined,
): state is AgentLifecycleState & { lifecycleKind: "detached_worker_v2" } {
  return state?.lifecycleKind === "detached_worker_v2";
}
