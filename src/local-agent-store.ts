import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type { ServerConfig } from "./config.js";
import {
  type AgentTerminalReason,
  type ExecutionContract,
  type ScopeBaseline,
  type ScopeState,
  deserializeExecutionContract,
  serializeExecutionContract,
} from "./local-agent-contract.js";

export type LocalAgentStatus = "starting" | "running" | "idle" | "error" | "stopped";

export interface LocalAgentRecord {
  id: string;
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  thinking?: string;
  providerSessionId?: string;
  workerPid?: number;
  workerToken?: string;
  executionContract?: ExecutionContract;
  terminalReason?: AgentTerminalReason;
  scopeState?: ScopeState;
  scopeBaseline?: ScopeBaseline;
  status: LocalAgentStatus;
  latestResponse?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocalAgentRecordInput {
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  thinking?: string;
  executionContract?: ExecutionContract;
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
  thinking: string | null;
  provider_session_id: string | null;
  worker_pid: number | null;
  worker_token: string | null;
  execution_contract: string | null;
  terminal_reason: string | null;
  scope_state: string | null;
  scope_baseline: string | null;
  status: string;
  latest_response: string | null;
  error: string | null;
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

  create(input: CreateLocalAgentRecordInput): LocalAgentRecord {
    const now = new Date().toISOString();
    const record: LocalAgentRecord = {
      id: `agt_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      workspaceId: input.workspaceId,
      workspaceRoot: resolve(input.workspaceRoot),
      profileName: input.profileName,
      provider: input.provider,
      model: input.model,
      thinking: input.thinking,
      executionContract: input.executionContract,
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
          thinking,
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
        record.thinking ?? null,
        serializeExecutionContract(record.executionContract),
        record.status,
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

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
          thinking = ?,
          provider_session_id = ?,
          worker_pid = ?,
          worker_token = ?,
          execution_contract = ?,
          terminal_reason = ?,
          scope_state = ?,
          scope_baseline = ?,
          status = ?,
          latest_response = ?,
          error = ?,
          updated_at = ?
         where id = ?`,
      )
      .run(
        updated.workspaceId ?? null,
        resolve(updated.workspaceRoot),
        updated.profileName,
        updated.provider,
        updated.model ?? null,
        updated.thinking ?? null,
        updated.providerSessionId ?? null,
        updated.workerPid ?? null,
        updated.workerToken ?? null,
        serializeExecutionContract(updated.executionContract),
        updated.terminalReason ?? null,
        updated.scopeState ?? null,
        updated.scopeBaseline ? JSON.stringify(updated.scopeBaseline) : null,
        updated.status,
        updated.latestResponse ?? null,
        updated.error ?? null,
        updated.updatedAt,
        updated.id,
      );

    return updated;
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

  getById(id: string): LocalAgentRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from local_agent_sessions where id = ?")
      .get(id) as LocalAgentRow | undefined;
    return row ? rowToLocalAgentRecord(row) : undefined;
  }
}

export function createLocalAgentStore(config: ServerConfig): LocalAgentStore {
  return new LocalAgentStore(config.stateDir);
}

function rowToLocalAgentRecord(row: LocalAgentRow): LocalAgentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root,
    profileName: row.profile_name,
    provider: row.provider,
    model: row.model ?? undefined,
    thinking: row.thinking ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
    workerPid: row.worker_pid ?? undefined,
    workerToken: row.worker_token ?? undefined,
    executionContract: deserializeExecutionContract(row.execution_contract),
    terminalReason: readTerminalReason(row.terminal_reason),
    scopeState: readScopeState(row.scope_state),
    scopeBaseline: readScopeBaseline(row.scope_baseline),
    status: readStatus(row.status),
    latestResponse: row.latest_response ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

function readScopeBaseline(value: string | null | undefined): ScopeBaseline | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const changedPaths = Array.isArray(parsed.changedPaths)
      ? parsed.changedPaths.filter((entry): entry is string => typeof entry === "string")
      : [];
    const head = typeof parsed.head === "string" || parsed.head === null ? parsed.head : null;
    return { changedPaths, head };
  } catch {
    return undefined;
  }
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
