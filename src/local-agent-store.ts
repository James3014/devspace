import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Result, type Result as BetterResult } from "better-result";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  AgentStoreError,
  isProgrammerDefect,
  type AgentProviderFailureDetails,
} from "./local-agent-errors.js";
import type { ServerConfig } from "./config.js";
import { canonicalizePath } from "./roots.js";
import {
  type ActiveTurnState,
  type AgentLifecycleKind,
  type AgentTerminalReason,
  type AgentTurnLaunchState,
  type EffectiveExecutionIdlePolicy,
  type ExecutionContract,
  type PathStateFingerprint,
  type ScopeBaseline,
  type ScopeState,
  type TerminationPendingState,
  deserializeExecutionContract,
  serializeExecutionContract,
} from "./local-agent-contract.js";
import {
  deserializeExecutionGenerationBinding,
  serializeExecutionGenerationBinding,
  type ExecutionGenerationBinding,
  hashDispatchIntent,
} from "./execution-protocol.js";
import {
  parseLocalEffectEnforcementReceipt,
  type LocalEffectEnforcementReceipt,
} from "./local-effect-enforcement.js";

export type LocalAgentStatus = "starting" | "running" | "idle" | "error" | "stopped";
export type ProviderContinuityState = "KNOWN_UNVERIFIED" | "RESUME_VERIFIED" | "LOST" | "UNKNOWN";

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
  /** Effective idle policy of the most recently settled turn, retained as terminal evidence. */
  lastExecutionIdlePolicy?: EffectiveExecutionIdlePolicy;
  /** Derived provider-native effect-enforcement evidence for the most recently settled turn. */
  lastEffectEnforcementReceipt?: LocalEffectEnforcementReceipt;
  /** Compatibility projection for the original termination callback API. */
  termination?: PhysicalTerminationState;
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

export interface PhysicalTerminationState {
  pending: boolean;
  fencedAt: string;
  reason: AgentTerminalReason;
  terminationId: string;
  previousWorkerPid?: number;
  previousWorkerToken?: string;
}

export interface ExternalRuntimePromptState {
  consequentialPromptFenced: boolean;
  promptNonce: string;
  fencedAt: string;
}

export type ExternalRuntimeLaunchState =
  | "FENCED"
  | "WORKSPACE_OBSERVED"
  | "AGENT_OBSERVED"
  | "OUTCOME_UNKNOWN";

export interface ExternalRuntimeLaunchFence {
  state: ExternalRuntimeLaunchState;
  launchRequestId: string;
  attemptKey: string;
  dispatchIntentHash: string;
  canonicalWorktreePath: string;
  gitHeadBefore: string;
  agentKind: string;
  herdrSocketPath?: string;
  requestedModel?: string;
  requestedEffort?: string;
  promptNonce: string;
  workspaceId?: string;
  herdrWorkspaceId?: string;
  herdrPaneId?: string;
  herdrAgentIdentity?: string;
  plannedAgentName?: string;
  observedCwd?: string;
  fencedAt: string;
  updatedAt?: string;
}

export interface ExternalRuntimeBinding {
  runtimeKind: string;
  launch?: ExternalRuntimeLaunchFence;
  handle?: Record<string, unknown>;
  promptState?: ExternalRuntimePromptState;
}

export interface FenceExternalRuntimeLaunchInput {
  agentId: string;
  attemptKey: string;
  dispatchIntentHash: string;
  canonicalWorktreePath: string;
  gitHeadBefore: string;
  agentKind: string;
  herdrSocketPath?: string;
  requestedModel?: string;
  requestedEffort?: string;
  promptNonce: string;
  workspaceId?: string;
  plannedAgentName?: string;
  expectedUpdatedAt?: string;
}

export interface RecordWorkspaceObservedInput {
  agentId: string;
  attemptKey: string;
  herdrWorkspaceId: string;
  herdrPaneId: string;
  observedCwd: string;
  expectedUpdatedAt?: string;
}

export interface RecordAgentObservedInput {
  agentId: string;
  attemptKey: string;
  herdrAgentIdentity: string;
  expectedUpdatedAt?: string;
}

export interface MarkLaunchOutcomeUnknownInput {
  agentId: string;
  attemptKey: string;
  reason?: string;
  expectedUpdatedAt?: string;
}

export interface BindExternalRuntimeBindingInput {
  agentId: string;
  expectedAttemptKey?: string;
  expectedDispatchIntentHash?: string;
  expectedUpdatedAt?: string;
  binding: ExternalRuntimeBinding;
}

export interface FenceConsequentialPromptInput {
  agentId: string;
  attemptKey: string;
  dispatchIntentHash: string;
  promptNonce: string;
  expectedUpdatedAt?: string;
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
  executionGeneration?: ExecutionGenerationBinding;
  startReplay?: StartReplayBinding;
  externalRuntimeBinding?: ExternalRuntimeBinding;
  terminalReason?: AgentTerminalReason;
  scopeState?: ScopeState;
  scopeBaseline?: ScopeBaseline;
  lifecycleState?: AgentLifecycleState;
  status: LocalAgentStatus;
  latestResponse?: string;
  error?: string;
  errorCode?: string;
  errorRetryable?: boolean;
  errorDetails?: AgentProviderFailureDetails;
  providerContinuityState?: ProviderContinuityState;
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
  executionIdlePolicy?: EffectiveExecutionIdlePolicy;
  executionGeneration?: ExecutionGenerationBinding;
  startReplay?: StartReplayBinding;
  externalRuntimeBinding?: ExternalRuntimeBinding;
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
  expectedPhase?: "startup" | "execution" | "idle" | "any";
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

export interface LocalAgentStoreTestHooks {
  beforeGenericUpdateLock?: (snapshot: LocalAgentRecord) => void;
}

export interface BeginContinuationCasInput {
  agentId: string;
  expectedPreviousGeneration?: string;
  expectedUpdatedAt?: string;
  turnStartedAt?: string;
  executionIdlePolicy?: EffectiveExecutionIdlePolicy;
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
  errorCode?: string;
  errorRetryable?: boolean;
  errorDetails?: AgentProviderFailureDetails | string;
  terminalReason?: AgentTerminalReason;
  scopeState?: ScopeState;
  cumulativeChangedPaths?: string[];
  turnEndBaseline?: ScopeBaseline;
  effectEnforcementReceipt?: LocalEffectEnforcementReceipt;
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
  provider_continuity_state: string | null;
  worker_pid: number | null;
  worker_token: string | null;
  execution_contract: string | null;
  execution_generation: string | null;
  terminal_reason: string | null;
  scope_state: string | null;
  scope_baseline: string | null;
  lifecycle_state: string | null;
  status: string;
  latest_response: string | null;
  error: string | null;
  error_code: string | null;
  error_retryable: string | null;
  error_details: string | null;
  created_at: string;
  updated_at: string;
}

export class LocalAgentStore {
  private readonly database: DatabaseHandle;

  constructor(
    stateDir: string,
    private readonly testHooks: LocalAgentStoreTestHooks = {},
  ) {
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

  /**
   * Return only rows that can require the active-agent supervision pass.
   *
   * Active status is kept as a SQL predicate so legacy rows remain eligible
   * for adoption/reconciliation. A durable terminationPending marker is also
   * selected independently of status because fencing persists a terminal
   * status before physical worker cleanup completes. The marker check is
   * intentionally textual: it avoids deserializing historical lifecycle and
   * execution blobs merely to discover that a terminal row is ineligible.
   */
  listSupervisionCandidates(scope: LocalAgentListScope = {}): LocalAgentRecord[] {
    const clauses = [
      "(status in ('starting', 'running') or instr(coalesce(lifecycle_state, ''), '\"terminationPending\"') > 0)",
    ];
    const parameters: string[] = [];
    if (scope.workspaceId) {
      clauses.push("workspace_id = ?");
      parameters.push(scope.workspaceId);
    }
    if (scope.workspaceRoot) {
      clauses.push("workspace_root = ?");
      parameters.push(resolve(scope.workspaceRoot));
    }

    const rows = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where ${clauses.join(" and ")}
         order by updated_at desc`,
      )
      .all(...parameters) as LocalAgentRow[];
    return rows.map(rowToLocalAgentRecord);
  }

  count(scope: LocalAgentListScope = {}): number {
    let row: { count: number } | undefined;
    if (scope.workspaceId && scope.workspaceRoot) {
      row = this.database.sqlite
        .prepare(
          `select count(*) as count from local_agent_sessions
           where workspace_id = ? and workspace_root = ?`,
        )
        .get(scope.workspaceId, resolve(scope.workspaceRoot)) as { count: number } | undefined;
    } else if (scope.workspaceId) {
      row = this.database.sqlite
        .prepare(
          `select count(*) as count from local_agent_sessions
           where workspace_id = ?`,
        )
        .get(scope.workspaceId) as { count: number } | undefined;
    } else if (scope.workspaceRoot) {
      row = this.database.sqlite
        .prepare(
          `select count(*) as count from local_agent_sessions
           where workspace_root = ?`,
        )
        .get(resolve(scope.workspaceRoot)) as { count: number } | undefined;
    } else {
      row = this.database.sqlite
        .prepare("select count(*) as count from local_agent_sessions")
        .get() as { count: number } | undefined;
    }

    return Number(row?.count ?? 0);
  }

  countResult(scope: LocalAgentListScope = {}): BetterResult<number, AgentStoreError> {
    return storeResult("count", () => this.count(scope));
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
      providerContinuityState: "UNKNOWN",
      executionContract: input.executionContract,
      executionGeneration: input.executionGeneration,
      startReplay: input.startReplay,
      externalRuntimeBinding: input.externalRuntimeBinding,
      lifecycleState: input.lifecycleKind === "detached_worker_v2"
        ? {
            lifecycleKind: "detached_worker_v2",
            activeTurn: {
              generation: randomUUID(),
              turnStartedAt: now,
              lastActivityAt: now,
              executionIdlePolicy: input.executionIdlePolicy,
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
          provider_continuity_state,
          execution_contract,
          execution_generation,
          lifecycle_state,
          status,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId ?? null,
        record.workspaceRoot,
        record.profileName,
        record.provider,
        record.model ?? null,
        record.effort ?? null,
        record.providerContinuityState,
        serializeStoredExecutionState(record.executionContract, record.startReplay, record.externalRuntimeBinding),
        serializeExecutionGenerationBinding(record.executionGeneration),
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
    const observedBeforeLock = this.testHooks.beforeGenericUpdateLock
      ? this.getById(id)
      : undefined;
    if (observedBeforeLock) this.testHooks.beforeGenericUpdateLock?.(observedBeforeLock);

    const updateLegacy = this.database.sqlite.transaction(() => {
      const row = this.database.sqlite.prepare(
        "select * from local_agent_sessions where id = ? limit 1",
      ).get(id) as LocalAgentRow | undefined;
      if (!row) throw new Error(`Unknown subagent id: ${id}`);
      const current = rowToLocalAgentRecord(row);
      if (isDetachedLifecycle(current.lifecycleState)) {
        if (observedBeforeLock && !isDetachedLifecycle(observedBeforeLock.lifecycleState)) {
          throw new Error(
            `Stale generic update conflict for agent ${id}: legacy snapshot became detached-worker v2 before lock acquisition.`,
          );
        }
        throw new Error(
          `Generic update cannot mutate a generation-owned detached lifecycle record for agent ${id}.`,
        );
      }

      const providerSessionPatched = Object.prototype.hasOwnProperty.call(patch, "providerSessionId");
      const sessionMismatch = Boolean(
        current.providerSessionId &&
        patch.providerSessionId &&
        current.providerSessionId !== patch.providerSessionId,
      );
      const updatedProviderContinuityState: ProviderContinuityState = sessionMismatch
        ? "LOST"
        : patch.providerContinuityState
          ?? (providerSessionPatched
            ? patch.providerSessionId ? "KNOWN_UNVERIFIED" : "UNKNOWN"
            : current.providerContinuityState ?? (current.providerSessionId ? "KNOWN_UNVERIFIED" : "UNKNOWN"));
      const updatedProviderSessionId = sessionMismatch
        ? current.providerSessionId
        : (providerSessionPatched ? patch.providerSessionId : current.providerSessionId);

      const updated: LocalAgentRecord = {
        ...current,
        ...patch,
        providerSessionId: updatedProviderSessionId,
        providerContinuityState: updatedProviderContinuityState,
        updatedAt: new Date().toISOString(),
      };
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set
          workspace_id = ?,
          workspace_root = ?,
          profile_name = ?,
          provider = ?,
          model = ?,
          effort = ?,
          provider_session_id = ?,
          provider_continuity_state = ?,
          worker_pid = ?,
          worker_token = ?,
          execution_contract = ?,
          execution_generation = ?,
          terminal_reason = ?,
          scope_state = ?,
          scope_baseline = ?,
          lifecycle_state = ?,
          status = ?,
          latest_response = ?,
          error = ?,
          error_code = ?,
          error_retryable = ?,
          error_details = ?,
          updated_at = ?
         where id = ? and updated_at = ? and lifecycle_state is ?`,
      )
      .run(
        updated.workspaceId ?? null,
        resolve(updated.workspaceRoot),
        updated.profileName,
        updated.provider,
        updated.model ?? null,
        updated.effort ?? null,
        updated.providerSessionId ?? null,
        updatedProviderContinuityState,
        updated.workerPid ?? null,
        updated.workerToken ?? null,
        serializeStoredExecutionState(updated.executionContract, updated.startReplay, updated.externalRuntimeBinding),
        serializeExecutionGenerationBinding(updated.executionGeneration),
        updated.terminalReason ?? null,
        updated.scopeState ?? null,
        updated.scopeBaseline ? JSON.stringify(updated.scopeBaseline) : null,
        updated.lifecycleState ? JSON.stringify(updated.lifecycleState) : null,
        updated.status,
        updated.latestResponse ?? null,
        updated.error ?? null,
        updated.errorCode ?? null,
        updated.errorRetryable === undefined ? null : String(updated.errorRetryable),
        updated.errorDetails ? JSON.stringify(updated.errorDetails) : null,
        updated.updatedAt,
        updated.id,
        row.updated_at,
        row.lifecycle_state,
      );
      if (result.changes !== 1) {
        throw new Error(
          `Stale generic update conflict for agent ${id}: exact locked row snapshot no longer matches.`,
        );
      }
      return this.getById(id) ?? updated;
    });
    return updateLegacy.immediate();
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
        current.providerContinuityState === "LOST" ||
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
          lastActivityAt: now,
          executionIdlePolicy: input.executionIdlePolicy,
          launchState: "not_started",
        },
        terminationPending: undefined,
        lifecycleCorrupt: undefined,
      };
      const continuityState: ProviderContinuityState = current.providerSessionId
        ? "KNOWN_UNVERIFIED"
        : "UNKNOWN";
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set
          status = 'starting', latest_response = null, error = null,
          error_code = null, error_retryable = null, terminal_reason = null,
          provider_continuity_state = ?, worker_pid = null, worker_token = null, lifecycle_state = ?, updated_at = ?
         where id = ? and updated_at = ?`,
      ).run(continuityState, JSON.stringify(updatedLifecycle), now, input.agentId, current.updatedAt);
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
        activeTurn: { ...activeTurn, executionStartedAt, lastActivityAt: executionStartedAt },
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

  /** Persist a provider/runtime event as the authoritative idle clock. */
  touchActivityCAS(
    id: string,
    generation: string,
    workerToken: string,
    activityAt = new Date().toISOString(),
  ): LifecycleCasResult {
    const touch = this.database.sqlite.transaction(() => {
      const current = this.getById(id);
      const lifecycle = current?.lifecycleState;
      const activeTurn = lifecycle?.activeTurn;
      if (
        !current ||
        !isDetachedLifecycle(lifecycle) ||
        !activeTurn ||
        activeTurn.generation !== generation ||
        lifecycle.terminationPending ||
        lifecycle.lifecycleCorrupt ||
        current.workerToken !== workerToken ||
        (current.status !== "starting" && current.status !== "running")
      ) {
        return { applied: false, previous: current, current };
      }
      const lifecycleState: AgentLifecycleState = {
        ...lifecycle,
        activeTurn: { ...activeTurn, lastActivityAt: activityAt },
      };
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set lifecycle_state = ?, updated_at = ?
         where id = ? and worker_token = ? and updated_at = ?`,
      ).run(JSON.stringify(lifecycleState), activityAt, id, workerToken, current.updatedAt);
      const refreshed = this.getById(id) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return touch.immediate();
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
      const sessionChanged = current.providerContinuityState === "LOST" || Boolean(
        current.providerSessionId && current.providerSessionId !== providerSessionId,
      );
      const continuityState: ProviderContinuityState = sessionChanged
        ? "LOST"
        : lifecycle.lastSettledGeneration && current.providerSessionId === providerSessionId
          ? "RESUME_VERIFIED"
          : "KNOWN_UNVERIFIED";
      const storedProviderSessionId = continuityState === "LOST"
        ? current.providerSessionId
        : providerSessionId;
      const now = new Date().toISOString();
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set provider_session_id = ?, provider_continuity_state = ?, updated_at = ?
         where id = ? and worker_token = ? and updated_at = ?`,
      ).run(storedProviderSessionId ?? null, continuityState, now, id, workerToken, current.updatedAt);
      const refreshed = this.getById(id) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return bind.immediate();
  }

  bindExternalRuntimeBindingCAS(input: BindExternalRuntimeBindingInput): LifecycleCasResult {
    const bind = this.database.sqlite.transaction(() => {
      const current = this.getById(input.agentId);
      if (!current) return { applied: false };

      if (input.expectedUpdatedAt !== undefined && current.updatedAt !== input.expectedUpdatedAt) {
        return { applied: false, previous: current, current };
      }

      // Fail closed on attemptKey consistency
      if (input.expectedAttemptKey !== undefined) {
        if (!current.startReplay?.key || current.startReplay.key !== input.expectedAttemptKey) {
          return { applied: false, previous: current, current };
        }
      }

      // Fail closed on dispatchIntentHash consistency
      if (input.expectedDispatchIntentHash !== undefined) {
        if (!current.executionContract?.dispatchIntent) {
          return { applied: false, previous: current, current };
        }
        const currentHash = hashDispatchIntent(current.executionContract.dispatchIntent);
        if (!currentHash || currentHash !== input.expectedDispatchIntentHash) {
          return { applied: false, previous: current, current };
        }
      }

      // Check idempotency if already bound
      if (current.externalRuntimeBinding?.handle) {
        const existing = current.externalRuntimeBinding;
        if (
          existing.runtimeKind === input.binding.runtimeKind &&
          JSON.stringify(existing.handle) === JSON.stringify(input.binding.handle)
        ) {
          return { applied: true, previous: current, current };
        }
        return { applied: false, previous: current, current };
      }

      const mergedBinding: ExternalRuntimeBinding = {
        ...input.binding,
        launch: input.binding.launch ?? current.externalRuntimeBinding?.launch,
        promptState: input.binding.promptState ?? current.externalRuntimeBinding?.promptState,
      };

      const serialized = serializeStoredExecutionState(
        current.executionContract,
        current.startReplay,
        mergedBinding,
      );

      const now = new Date().toISOString();
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set execution_contract = ?, updated_at = ?
         where id = ? and updated_at = ?`,
      ).run(serialized, now, current.id, current.updatedAt);

      const refreshed = this.getById(current.id) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return bind.immediate();
  }

  fenceExternalRuntimeLaunchCAS(input: FenceExternalRuntimeLaunchInput): LifecycleCasResult {
    const fence = this.database.sqlite.transaction(() => {
      const current = this.getById(input.agentId);
      if (!current) return { applied: false };

      if (input.expectedUpdatedAt !== undefined && current.updatedAt !== input.expectedUpdatedAt) {
        return { applied: false, previous: current, current };
      }

      // 1. Validate exact attemptKey
      if (!current.startReplay?.key || current.startReplay.key !== input.attemptKey) {
        return { applied: false, previous: current, current };
      }

      // 2. Validate exact dispatchIntentHash
      if (!current.executionContract?.dispatchIntent) {
        return { applied: false, previous: current, current };
      }
      const currentHash = hashDispatchIntent(current.executionContract.dispatchIntent);
      if (!currentHash || currentHash !== input.dispatchIntentHash) {
        return { applied: false, previous: current, current };
      }

      // 3. Validate canonical worktree
      if (canonicalizePath(current.workspaceRoot) !== canonicalizePath(input.canonicalWorktreePath)) {
        return { applied: false, previous: current, current };
      }

      // 4. Validate git head format
      if (!/^[0-9a-f]{40}$/i.test(input.gitHeadBefore)) {
        return { applied: false, previous: current, current };
      }

      // 5. Check existing binding
      if (current.externalRuntimeBinding) {
        if (current.externalRuntimeBinding.runtimeKind !== "HERDR") {
          return { applied: false, previous: current, current };
        }
        const existingLaunch = current.externalRuntimeBinding.launch;
        if (existingLaunch) {
          const existingSocket = existingLaunch.herdrSocketPath
            ? canonicalizePath(existingLaunch.herdrSocketPath)
            : undefined;
          const inputSocket = input.herdrSocketPath
            ? canonicalizePath(input.herdrSocketPath)
            : undefined;

          if (
            existingLaunch.attemptKey === input.attemptKey &&
            existingLaunch.dispatchIntentHash === input.dispatchIntentHash &&
            canonicalizePath(existingLaunch.canonicalWorktreePath) === canonicalizePath(input.canonicalWorktreePath) &&
            existingLaunch.gitHeadBefore === input.gitHeadBefore &&
            existingLaunch.agentKind === input.agentKind &&
            existingSocket === inputSocket &&
            (existingLaunch.workspaceId ?? undefined) === (input.workspaceId ?? undefined) &&
            (existingLaunch.requestedModel ?? undefined) === (input.requestedModel ?? undefined) &&
            (existingLaunch.requestedEffort ?? undefined) === (input.requestedEffort ?? undefined) &&
            existingLaunch.promptNonce === input.promptNonce &&
            (existingLaunch.plannedAgentName ?? undefined) === (input.plannedAgentName ?? undefined)
          ) {
            return { applied: true, previous: current, current };
          }
          return { applied: false, previous: current, current };
        }
      }

      const now = new Date().toISOString();
      const launchRequestId = `HERDR-LAUNCH:${input.attemptKey}:${input.dispatchIntentHash.slice(0, 16)}`;
      const launchFence: ExternalRuntimeLaunchFence = {
        state: "FENCED",
        launchRequestId,
        attemptKey: input.attemptKey,
        dispatchIntentHash: input.dispatchIntentHash,
        canonicalWorktreePath: canonicalizePath(input.canonicalWorktreePath),
        gitHeadBefore: input.gitHeadBefore,
        agentKind: input.agentKind,
        ...(input.herdrSocketPath ? { herdrSocketPath: input.herdrSocketPath } : {}),
        ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
        ...(input.requestedEffort ? { requestedEffort: input.requestedEffort } : {}),
        promptNonce: input.promptNonce,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.plannedAgentName ? { plannedAgentName: input.plannedAgentName } : {}),
        fencedAt: now,
      };

      const updatedBinding: ExternalRuntimeBinding = {
        runtimeKind: "HERDR",
        ...(current.externalRuntimeBinding ?? {}),
        launch: launchFence,
      };

      const serialized = serializeStoredExecutionState(
        current.executionContract,
        current.startReplay,
        updatedBinding,
      );

      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set execution_contract = ?, updated_at = ?
         where id = ? and updated_at = ?`,
      ).run(serialized, now, current.id, current.updatedAt);

      const refreshed = this.getById(current.id) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return fence.immediate();
  }

  recordExternalRuntimeWorkspaceObservedCAS(input: RecordWorkspaceObservedInput): LifecycleCasResult {
    const record = this.database.sqlite.transaction(() => {
      const current = this.getById(input.agentId);
      if (!current) return { applied: false };

      if (input.expectedUpdatedAt !== undefined && current.updatedAt !== input.expectedUpdatedAt) {
        return { applied: false, previous: current, current };
      }

      if (!current.startReplay?.key || current.startReplay.key !== input.attemptKey) {
        return { applied: false, previous: current, current };
      }

      const binding = current.externalRuntimeBinding;
      if (!binding || binding.runtimeKind !== "HERDR" || !binding.launch) {
        return { applied: false, previous: current, current };
      }

      if (binding.launch.attemptKey !== input.attemptKey) {
        return { applied: false, previous: current, current };
      }

      if (!input.herdrWorkspaceId || !input.herdrPaneId || !input.observedCwd) {
        return { applied: false, previous: current, current };
      }

      if (
        canonicalizePath(input.observedCwd) !==
        canonicalizePath(binding.launch.canonicalWorktreePath)
      ) {
        return { applied: false, previous: current, current };
      }

      if (
        binding.launch.herdrWorkspaceId === input.herdrWorkspaceId &&
        binding.launch.herdrPaneId === input.herdrPaneId
      ) {
        return { applied: true, previous: current, current };
      }

      const now = new Date().toISOString();
      const updatedLaunch: ExternalRuntimeLaunchFence = {
        ...binding.launch,
        state: "WORKSPACE_OBSERVED",
        herdrWorkspaceId: input.herdrWorkspaceId,
        herdrPaneId: input.herdrPaneId,
        observedCwd: canonicalizePath(input.observedCwd),
        updatedAt: now,
      };

      const updatedBinding: ExternalRuntimeBinding = {
        ...binding,
        launch: updatedLaunch,
      };

      const serialized = serializeStoredExecutionState(
        current.executionContract,
        current.startReplay,
        updatedBinding,
      );

      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set execution_contract = ?, updated_at = ?
         where id = ? and updated_at = ?`,
      ).run(serialized, now, current.id, current.updatedAt);

      const refreshed = this.getById(current.id) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return record.immediate();
  }

  recordExternalRuntimeAgentObservedCAS(input: RecordAgentObservedInput): LifecycleCasResult {
    const record = this.database.sqlite.transaction(() => {
      const current = this.getById(input.agentId);
      if (!current) return { applied: false };

      if (input.expectedUpdatedAt !== undefined && current.updatedAt !== input.expectedUpdatedAt) {
        return { applied: false, previous: current, current };
      }

      if (!current.startReplay?.key || current.startReplay.key !== input.attemptKey) {
        return { applied: false, previous: current, current };
      }

      const binding = current.externalRuntimeBinding;
      if (!binding || binding.runtimeKind !== "HERDR" || !binding.launch) {
        return { applied: false, previous: current, current };
      }

      if (binding.launch.attemptKey !== input.attemptKey) {
        return { applied: false, previous: current, current };
      }

      if (binding.launch.herdrAgentIdentity === input.herdrAgentIdentity) {
        return { applied: true, previous: current, current };
      }

      const now = new Date().toISOString();
      const updatedLaunch: ExternalRuntimeLaunchFence = {
        ...binding.launch,
        state: "AGENT_OBSERVED",
        herdrAgentIdentity: input.herdrAgentIdentity,
        updatedAt: now,
      };

      const updatedBinding: ExternalRuntimeBinding = {
        ...binding,
        launch: updatedLaunch,
      };

      const serialized = serializeStoredExecutionState(
        current.executionContract,
        current.startReplay,
        updatedBinding,
      );

      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set execution_contract = ?, updated_at = ?
         where id = ? and updated_at = ?`,
      ).run(serialized, now, current.id, current.updatedAt);

      const refreshed = this.getById(current.id) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return record.immediate();
  }

  markExternalRuntimeLaunchOutcomeUnknownCAS(input: MarkLaunchOutcomeUnknownInput): LifecycleCasResult {
    const record = this.database.sqlite.transaction(() => {
      const current = this.getById(input.agentId);
      if (!current) return { applied: false };

      if (input.expectedUpdatedAt !== undefined && current.updatedAt !== input.expectedUpdatedAt) {
        return { applied: false, previous: current, current };
      }

      const binding = current.externalRuntimeBinding;
      if (!binding || binding.runtimeKind !== "HERDR" || !binding.launch) {
        return { applied: false, previous: current, current };
      }

      if (binding.launch.state === "OUTCOME_UNKNOWN") {
        return { applied: true, previous: current, current };
      }

      const now = new Date().toISOString();
      const updatedLaunch: ExternalRuntimeLaunchFence = {
        ...binding.launch,
        state: "OUTCOME_UNKNOWN",
        updatedAt: now,
      };

      const updatedBinding: ExternalRuntimeBinding = {
        ...binding,
        launch: updatedLaunch,
      };

      const serialized = serializeStoredExecutionState(
        current.executionContract,
        current.startReplay,
        updatedBinding,
      );

      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set execution_contract = ?, updated_at = ?
         where id = ? and updated_at = ?`,
      ).run(serialized, now, current.id, current.updatedAt);

      const refreshed = this.getById(current.id) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return record.immediate();
  }

  fenceConsequentialPromptCAS(input: FenceConsequentialPromptInput): LifecycleCasResult {
    const fence = this.database.sqlite.transaction(() => {
      if (!input.agentId) return { applied: false };
      const current = this.getById(input.agentId);
      if (!current) return { applied: false };

      if (input.expectedUpdatedAt !== undefined && current.updatedAt !== input.expectedUpdatedAt) {
        return { applied: false, previous: current, current };
      }

      // 1. Exact attemptKey match on durable record
      if (!current.startReplay?.key || current.startReplay.key !== input.attemptKey) {
        return { applied: false, previous: current, current };
      }

      // 2. Exact dispatchIntentHash match on durable record
      if (!current.executionContract?.dispatchIntent) {
        return { applied: false, previous: current, current };
      }
      const recordHash = hashDispatchIntent(current.executionContract.dispatchIntent);
      if (!recordHash || recordHash !== input.dispatchIntentHash) {
        return { applied: false, previous: current, current };
      }

      // 3. Durable externalRuntimeBinding must exist
      if (!current.externalRuntimeBinding) {
        return { applied: false, previous: current, current };
      }

      // 4. runtimeKind must be HERDR
      if (current.externalRuntimeBinding.runtimeKind !== "HERDR") {
        return { applied: false, previous: current, current };
      }

      // 5. Durable handle must exist and be an object
      const storedHandle = current.externalRuntimeBinding.handle;
      if (!storedHandle || typeof storedHandle !== "object") {
        return { applied: false, previous: current, current };
      }

      const h = storedHandle as Record<string, unknown>;

      // 6. Handle attemptKey must match input.attemptKey
      if (typeof h.attemptKey !== "string" || h.attemptKey !== input.attemptKey) {
        return { applied: false, previous: current, current };
      }

      // 7. Handle dispatchIntentHash must match input.dispatchIntentHash
      if (typeof h.dispatchIntentHash !== "string" || h.dispatchIntentHash !== input.dispatchIntentHash) {
        return { applied: false, previous: current, current };
      }

      // 8. Handle promptNonce must match input.promptNonce exactly
      if (typeof h.promptNonce !== "string" || h.promptNonce !== input.promptNonce) {
        return { applied: false, previous: current, current };
      }

      // 9. If already fenced, fail closed
      if (current.externalRuntimeBinding.promptState?.consequentialPromptFenced) {
        return { applied: false, previous: current, current };
      }

      const now = new Date().toISOString();
      const updatedBinding: ExternalRuntimeBinding = {
        ...current.externalRuntimeBinding,
        promptState: {
          consequentialPromptFenced: true,
          promptNonce: h.promptNonce,
          fencedAt: now,
        },
      };

      const serialized = serializeStoredExecutionState(
        current.executionContract,
        current.startReplay,
        updatedBinding,
      );

      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set execution_contract = ?, updated_at = ?
         where id = ? and updated_at = ?`,
      ).run(serialized, now, current.id, current.updatedAt);

      const refreshed = this.getById(current.id) ?? current;
      return { applied: result.changes === 1, previous: current, current: refreshed };
    });
    return fence.immediate();
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
        lastExecutionIdlePolicy: lifecycle.activeTurn?.executionIdlePolicy,
        lastEffectEnforcementReceipt: input.effectEnforcementReceipt,
        activeTurn: undefined,
        terminationPending: undefined,
        lastSettledGeneration: input.generation,
        cumulativeChangedPaths: input.cumulativeChangedPaths ?? lifecycle.cumulativeChangedPaths,
        turnEndBaseline: input.turnEndBaseline ?? lifecycle.turnEndBaseline,
      };
      const errorCode = input.status === "idle" ? null : input.errorCode ?? null;
      const errorRetryable = input.status === "idle" ? null : input.errorRetryable === undefined ? null : String(input.errorRetryable);
      const errorDetails = input.status === "idle"
        ? null
        : typeof input.errorDetails === "string"
          ? input.errorDetails
          : input.errorDetails ? JSON.stringify(input.errorDetails) : null;

      const suppliedProviderSessionId = input.providerSessionId;
      const sessionChanged = Boolean(
        current.providerSessionId && suppliedProviderSessionId && current.providerSessionId !== suppliedProviderSessionId,
      );
      let providerContinuityState: ProviderContinuityState = current.providerContinuityState
        ?? (current.providerSessionId ? "KNOWN_UNVERIFIED" : "UNKNOWN");
      let providerSessionId = current.providerSessionId ?? suppliedProviderSessionId;
      if (providerContinuityState === "LOST" || sessionChanged) {
        providerContinuityState = "LOST";
        providerSessionId = current.providerSessionId;
      } else if (suppliedProviderSessionId) {
        if (
          input.status === "idle" &&
          lifecycle.lastSettledGeneration &&
          current.providerSessionId === suppliedProviderSessionId
        ) {
          providerContinuityState = "RESUME_VERIFIED";
        } else if (providerContinuityState !== "RESUME_VERIFIED") {
          providerContinuityState = "KNOWN_UNVERIFIED";
        }
      } else if (!providerSessionId && current.provider === "agy") {
        providerContinuityState = "LOST";
      }

      const now = new Date().toISOString();
      const result = this.database.sqlite.prepare(
        `update local_agent_sessions set provider_session_id = ?, provider_continuity_state = ?,
          status = ?, latest_response = ?, error = ?, error_code = ?, error_retryable = ?, error_details = ?,
          terminal_reason = ?, scope_state = ?,
          worker_pid = null, worker_token = null, lifecycle_state = ?, updated_at = ?
         where id = ? and status = 'running' and worker_token = ? and updated_at = ?`,
      ).run(
        providerSessionId ?? null,
        providerContinuityState,
        input.status,
        input.latestResponse ?? null,
        input.error ?? null,
        errorCode,
        errorRetryable,
        errorDetails,
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
        lastExecutionIdlePolicy: lifecycle.activeTurn?.executionIdlePolicy,
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
      } else if (input.expectedPhase === "idle") {
        if (executionStartedAtMs === undefined) return { applied: false, previous: current, current };
        const activityAtMs = Date.parse(activeTurn.lastActivityAt ?? activeTurn.executionStartedAt!);
        if (input.budgetMs !== undefined && nowMs - activityAtMs <= input.budgetMs) {
          return { applied: false, previous: current, current };
        }
      } else if (input.budgetMs !== undefined && nowMs - turnStartedAtMs <= input.budgetMs) {
        return { applied: false, previous: current, current };
      }

      const now = new Date().toISOString();
      const terminationId = randomUUID();
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
        lastExecutionIdlePolicy: activeTurn.executionIdlePolicy,
        activeTurn: undefined,
        termination: {
          pending: true,
          fencedAt: now,
          reason: input.terminalReason,
          terminationId,
          previousWorkerPid: current.workerPid,
          previousWorkerToken: current.workerToken,
        },
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
      return { applied: result.changes === 1, terminationId, previous: current, current: refreshed };
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
        termination: undefined,
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

  /** Compatibility completion hook for older termination callbacks. */
  completeTermination(agentId: string, terminationId: string, verified: boolean): LocalAgentRecord {
    const current = this.getById(agentId);
    if (!current) throw new Error(`Unknown subagent id: ${agentId}`);
    if (current.lifecycleState?.termination?.terminationId !== terminationId) return current;
    if (verified && current.lifecycleState?.terminationPending) {
      const pending = current.lifecycleState.terminationPending;
      return this.completeTerminationCAS({
        agentId,
        generation: pending.generation,
        workerPid: pending.workerPid,
        workerToken: pending.workerToken,
        turnEndBaseline: current.lifecycleState.turnEndBaseline ?? { changedPaths: [], head: null },
      }).current ?? current;
    }
    return this.update(agentId, {
      error: `${current.error ?? "Termination requested."} Worker termination could not be verified.`,
    });
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
    // Legacy/runtime-pool rows can be adopted when a detached worker is
    // launched. Install one generation before the guarded preparation CAS so
    // the worker path retains its historical behavior without weakening the
    // detached ownership fence.
    if (current.status === "starting" && !isDetachedLifecycle(current.lifecycleState) && !generation) {
      const now = new Date().toISOString();
      const adopted = this.update(id, {
        lifecycleState: {
          lifecycleKind: "detached_worker_v2",
          activeTurn: {
            generation: randomUUID(),
            turnStartedAt: now,
            launchState: "not_started",
          },
        },
      });
      return this.prepareWorker(adopted.id, workerToken);
    }
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
    providerContinuityState: readProviderContinuityState(row.provider_continuity_state, row.provider_session_id),
    workerPid: row.worker_pid ?? undefined,
    workerToken: row.worker_token ?? undefined,
    executionContract: storedExecution.executionContract,
    executionGeneration: deserializeExecutionGenerationBinding(row.execution_generation),
    startReplay: storedExecution.startReplay,
    externalRuntimeBinding: storedExecution.externalRuntimeBinding,
    terminalReason: readTerminalReason(row.terminal_reason),
    scopeState: readScopeState(row.scope_state),
    scopeBaseline: readScopeBaseline(row.scope_baseline),
    lifecycleState: readLifecycleState(row.lifecycle_state),
    status: readStatus(row.status),
    latestResponse: row.latest_response ?? undefined,
    error: row.error ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorRetryable: readOptionalBoolean(row.error_retryable),
    errorDetails: readErrorDetails(row.error_details),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readProviderContinuityState(
  value: string | null,
  providerSessionId: string | null,
): ProviderContinuityState {
  if (
    value === "KNOWN_UNVERIFIED" ||
    value === "RESUME_VERIFIED" ||
    value === "LOST" ||
    value === "UNKNOWN"
  ) {
    return value;
  }
  return providerSessionId ? "KNOWN_UNVERIFIED" : "UNKNOWN";
}

function readErrorDetails(value: string | null): AgentProviderFailureDetails | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<AgentProviderFailureDetails>;
    if (parsed.code && parsed.errorClass) {
      return {
        code: parsed.code,
        errorClass: parsed.errorClass,
        retryable: parsed.retryable === true,
        model: parsed.model,
        variant: parsed.variant,
        providerSessionId: parsed.providerSessionId,
        providerMessage: parsed.providerMessage,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
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
  externalRuntimeBinding?: ExternalRuntimeBinding,
): string | null {
  if (!startReplay && !externalRuntimeBinding) return serializeExecutionContract(executionContract);
  return JSON.stringify({
    storedExecutionStateVersion: 2,
    executionContract: executionContract ?? null,
    startReplay,
    externalRuntimeBinding,
  });
}

function readStoredExecutionState(value: string | null | undefined): {
  executionContract?: ExecutionContract;
  startReplay?: StartReplayBinding;
  externalRuntimeBinding?: ExternalRuntimeBinding;
} {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.storedExecutionStateVersion === 2) {
      const replay = parsed.startReplay as Record<string, unknown> | undefined;
      const startReplay = replay && typeof replay.key === "string" && typeof replay.requestHash === "string"
        ? { key: replay.key, requestHash: replay.requestHash }
        : undefined;
      const executionContract = parsed.executionContract === null
        ? undefined
        : deserializeExecutionContract(JSON.stringify(parsed.executionContract));
      const bindingRaw = parsed.externalRuntimeBinding as Record<string, unknown> | undefined;
      const promptState = readExternalRuntimePromptState(bindingRaw?.promptState);
      const launch = readExternalRuntimeLaunchFence(bindingRaw?.launch);
      const handle = bindingRaw?.handle && typeof bindingRaw.handle === "object"
        ? (bindingRaw.handle as Record<string, unknown>)
        : undefined;
      const externalRuntimeBinding: ExternalRuntimeBinding | undefined =
        bindingRaw && typeof bindingRaw.runtimeKind === "string" && (handle || launch)
          ? {
              runtimeKind: bindingRaw.runtimeKind,
              ...(launch ? { launch } : {}),
              ...(handle ? { handle } : {}),
              ...(promptState ? { promptState } : {}),
            }
          : undefined;
      return { executionContract, startReplay, externalRuntimeBinding };
    }
    if (parsed.storedExecutionStateVersion === 1) {
      const replay = parsed.startReplay as Record<string, unknown> | undefined;
      const startReplay = replay && typeof replay.key === "string" && typeof replay.requestHash === "string"
        ? { key: replay.key, requestHash: replay.requestHash }
        : undefined;
      const executionContract = parsed.executionContract === null
        ? undefined
        : deserializeExecutionContract(JSON.stringify(parsed.executionContract));
      return { executionContract, startReplay };
    }
    return { executionContract: deserializeExecutionContract(value) };
  } catch {
    return {};
  }
}

function readExternalRuntimeLaunchFence(value: unknown): ExternalRuntimeLaunchFence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.state === "string" &&
    typeof record.launchRequestId === "string" &&
    typeof record.attemptKey === "string" &&
    typeof record.dispatchIntentHash === "string" &&
    typeof record.canonicalWorktreePath === "string" &&
    typeof record.gitHeadBefore === "string" &&
    typeof record.agentKind === "string" &&
    typeof record.promptNonce === "string" &&
    typeof record.fencedAt === "string"
  ) {
    return {
      state: record.state as ExternalRuntimeLaunchState,
      launchRequestId: record.launchRequestId,
      attemptKey: record.attemptKey,
      dispatchIntentHash: record.dispatchIntentHash,
      canonicalWorktreePath: record.canonicalWorktreePath,
      gitHeadBefore: record.gitHeadBefore,
      agentKind: record.agentKind,
      ...(typeof record.herdrSocketPath === "string" ? { herdrSocketPath: record.herdrSocketPath } : {}),
      ...(typeof record.requestedModel === "string" ? { requestedModel: record.requestedModel } : {}),
      ...(typeof record.requestedEffort === "string" ? { requestedEffort: record.requestedEffort } : {}),
      promptNonce: record.promptNonce,
      ...(typeof record.workspaceId === "string" ? { workspaceId: record.workspaceId } : {}),
      ...(typeof record.herdrWorkspaceId === "string" ? { herdrWorkspaceId: record.herdrWorkspaceId } : {}),
      ...(typeof record.herdrPaneId === "string" ? { herdrPaneId: record.herdrPaneId } : {}),
      ...(typeof record.herdrAgentIdentity === "string" ? { herdrAgentIdentity: record.herdrAgentIdentity } : {}),
      ...(typeof record.plannedAgentName === "string" ? { plannedAgentName: record.plannedAgentName } : {}),
      ...(typeof record.observedCwd === "string" ? { observedCwd: record.observedCwd } : {}),
      fencedAt: record.fencedAt,
      ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
    };
  }
  return undefined;
}

function readExternalRuntimePromptState(value: unknown): ExternalRuntimePromptState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.consequentialPromptFenced === "boolean" &&
    typeof record.promptNonce === "string" &&
    typeof record.fencedAt === "string"
  ) {
    return {
      consequentialPromptFenced: record.consequentialPromptFenced,
      promptNonce: record.promptNonce,
      fencedAt: record.fencedAt,
    };
  }
  return undefined;
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
    const termination = readPhysicalTerminationState(parsed.termination);
    if (termination) state.termination = termination;
    const lastExecutionIdlePolicy = readEffectiveExecutionIdlePolicy(parsed.lastExecutionIdlePolicy);
    if (lastExecutionIdlePolicy) state.lastExecutionIdlePolicy = lastExecutionIdlePolicy;
    const effectReceiptLooking =
      parsed.lastEffectEnforcementReceipt !== undefined &&
      parsed.lastEffectEnforcementReceipt !== null;
    const lastEffectEnforcementReceipt = parseLocalEffectEnforcementReceipt(
      parsed.lastEffectEnforcementReceipt,
    );
    if (lastEffectEnforcementReceipt) {
      state.lastEffectEnforcementReceipt = lastEffectEnforcementReceipt;
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
      (effectReceiptLooking && !lastEffectEnforcementReceipt) ||
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

function readPhysicalTerminationState(value: unknown): PhysicalTerminationState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.terminationId !== "string" || typeof record.fencedAt !== "string") return undefined;
  return {
    pending: record.pending === true,
    fencedAt: record.fencedAt,
    reason: typeof record.reason === "string" ? record.reason as AgentTerminalReason : "unknown",
    terminationId: record.terminationId,
    previousWorkerPid: typeof record.previousWorkerPid === "number" ? record.previousWorkerPid : undefined,
    previousWorkerToken: typeof record.previousWorkerToken === "string" ? record.previousWorkerToken : undefined,
  };
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
  const executionIdlePolicy = readEffectiveExecutionIdlePolicy(record.executionIdlePolicy);
  if (record.executionIdlePolicy !== undefined && record.executionIdlePolicy !== null && !executionIdlePolicy) {
    return undefined;
  }
  return {
    generation: record.generation,
    turnStartedAt: record.turnStartedAt,
    executionStartedAt: record.executionStartedAt as string | undefined,
    lastActivityAt: typeof record.lastActivityAt === "string" && Number.isFinite(Date.parse(record.lastActivityAt))
      ? record.lastActivityAt
      : undefined,
    executionIdlePolicy,
    launchState,
  };
}

function readEffectiveExecutionIdlePolicy(value: unknown): EffectiveExecutionIdlePolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.source !== "PROFILE_DEFAULT" && record.source !== "EXPLICIT_OVERRIDE") return undefined;
  if (record.activityCapability !== "TRUSTWORTHY" && record.activityCapability !== "UNAVAILABLE") return undefined;
  if (record.timeoutMs !== undefined &&
      (typeof record.timeoutMs !== "number" || !Number.isInteger(record.timeoutMs) || record.timeoutMs < 1)) {
    return undefined;
  }
  return {
    source: record.source,
    activityCapability: record.activityCapability,
    ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs }),
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
