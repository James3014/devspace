import {
  parseDispatchIntent,
  parseNexusExecutionGrantRef,
  type DispatchIntent,
  type ExecutionAuthorityMode,
  type NexusExecutionGrantRef,
} from "./execution-protocol.js";

/**
 * Structured execution contract for a DevSpace subagent turn.
 *
 * This is an execution-control contract only. It binds where a worker may
 * write, how long it may run, and which toolchain its verification must use.
 * It grants no routing, admission, approval, integration, or acceptance
 * authority to Dev MCP.
 */

export type ScopeState = "WITHIN_SCOPE" | "SCOPE_VIOLATION" | "UNKNOWN";

export type AgentTerminalReason =
  | "completed"
  | "cancelled"
  | "timeout"
  | "idle_timeout"
  | "scope_violation"
  | "provider_error"
  | "launch_failed"
  | "unknown";

export interface ExecutionContract {
  /** Defaults to OWNER_DIRECT for backwards compatibility. */
  authorityMode?: ExecutionAuthorityMode;
  /** Immutable canonical Nexus authority pointer, required only for NEXUS_GOVERNED. */
  nexusGrant?: NexusExecutionGrantRef;
  /** Controller-authored bounded work semantics, transported durably by DevSpace. */
  dispatchIntent?: DispatchIntent;
  /**
   * If supplied, agent_start fails closed when the workspace HEAD no longer
   * matches before any worker mutation.
   */
  expectedHead?: string;
  /**
   * Exact intended writable paths relative to the workspace root. Recorded in
   * durable state. Enforced as OBSERVE_AND_ABORT (this execution
   * architecture cannot physically block writes elsewhere).
   */
  writePaths?: string[];
  /** Optional bound on the number of files a worker may change. */
  maxFiles?: number;
  /** Toolchain id used to resolve verifier executables outside the model prompt. */
  toolchainId?: string;
  /** Optional wall-clock bound for the whole agent turn (turn start -> terminal). */
  maxWallMs?: number;
  /** Optional wall-clock bound for the startup/readiness phase (turn start -> execution started). */
  maxStartupMs?: number;
  /** Optional wall-clock bound for semantic provider execution (execution started -> terminal). */
  maxExecutionMs?: number;
  /** Maximum interval without a provider/runtime activity event. */
  idleTimeoutMs?: number;
}

/**
 * Per-path physical fingerprint captured at a snapshot point. Persisted in the
 * baseline so a later snapshot can distinguish an untouched pre-existing dirty
 * path from the same path being modified again by the worker.
 */
export interface PathStateFingerprint {
  /** Tracked-modified, untracked, or tracked-deleted at snapshot time. */
  kind: "modified" | "untracked" | "deleted";
  /** sha256 hex over the file bytes; null when the path is absent (deleted). */
  contentHash: string | null;
  /** File size in bytes; 0 when the path is absent (deleted). */
  size: number;
  /** SHA-256 identity of the exact path's Git/index/staged+unstaged state, used to detect index-only/mode mutations. */
  gitStateHash: string;
}

export interface ScopeBaseline {
  /** Workspace-relative changed paths present before the worker turn started. */
  changedPaths: string[];
  /** HEAD at baseline snapshot time (or null when Git is unavailable). */
  head: string | null;
  /**
   * Per-path physical fingerprints keyed by workspace-relative changed path.
   * Absent on legacy persisted rows: exact attribution is then impossible and
   * scope must degrade to UNKNOWN instead of falsely claiming WITHIN_SCOPE.
   */
  fingerprints?: Record<string, PathStateFingerprint>;
}

export type AgentLifecycleKind = "detached_worker_v2";

export type AgentTurnLaunchState = "not_started" | "launching" | "spawned" | "claimed";

export interface ActiveTurnState {
  /** Opaque per-turn ABA fence. Never derived from provider, PID, or token identity. */
  generation?: string;
  turnStartedAt: string;
  executionStartedAt?: string;
  /** Last provider/runtime activity observed for idle-timeout supervision. */
  lastActivityAt?: string;
  launchState?: AgentTurnLaunchState;
}

export interface TerminationPendingState {
  generation: string;
  requestedAt: string;
  reason: AgentTerminalReason;
  terminalStatus: "error" | "stopped";
  previousStatus: "starting" | "running";
  workerToken?: string;
  workerPid?: number;
  launchState: AgentTurnLaunchState;
  lastAttemptAt?: string;
  lastFailure?: string;
}

export function parseExecutionContract(value: unknown): ExecutionContract | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("executionContract must be an object.");
  }
  const record = value as Record<string, unknown>;
  const contract: ExecutionContract = {};

  if (record.authorityMode !== undefined) {
    if (record.authorityMode !== "OWNER_DIRECT" && record.authorityMode !== "NEXUS_GOVERNED") {
      throw new Error("executionContract.authorityMode must be OWNER_DIRECT or NEXUS_GOVERNED.");
    }
    contract.authorityMode = record.authorityMode;
  }

  if (record.nexusGrant !== undefined) {
    contract.nexusGrant = parseNexusExecutionGrantRef(record.nexusGrant);
  }

  if (record.dispatchIntent !== undefined) {
    contract.dispatchIntent = parseDispatchIntent(record.dispatchIntent);
  }

  if (record.expectedHead !== undefined) {
    if (typeof record.expectedHead !== "string" || !/^[0-9a-fA-F]{40}$/.test(record.expectedHead)) {
      throw new Error("executionContract.expectedHead must be a 40-character commit SHA.");
    }
    contract.expectedHead = record.expectedHead;
  }

  if (record.writePaths !== undefined) {
    if (!Array.isArray(record.writePaths) || !record.writePaths.every((entry) => typeof entry === "string")) {
      throw new Error("executionContract.writePaths must be an array of strings.");
    }
    const paths = (record.writePaths as string[]).map((entry) => entry.trim()).filter(Boolean);
    for (const path of paths) {
      if (path === "." || path.startsWith("/") || path.startsWith("\\") || path.includes("..")) {
        throw new Error(`executionContract.writePaths contains an invalid path: ${path}`);
      }
    }
    contract.writePaths = paths.length > 0 ? paths : undefined;
  }

  if (record.maxFiles !== undefined) {
    if (typeof record.maxFiles !== "number" || !Number.isInteger(record.maxFiles) || record.maxFiles < 1) {
      throw new Error("executionContract.maxFiles must be a positive integer.");
    }
    contract.maxFiles = record.maxFiles;
  }

  if (record.toolchainId !== undefined) {
    if (typeof record.toolchainId !== "string" || !record.toolchainId.trim()) {
      throw new Error("executionContract.toolchainId must be a non-empty string.");
    }
    contract.toolchainId = record.toolchainId.trim();
  }

  if (record.maxWallMs !== undefined) {
    if (typeof record.maxWallMs !== "number" || !Number.isInteger(record.maxWallMs) || record.maxWallMs < 1) {
      throw new Error("executionContract.maxWallMs must be a positive integer.");
    }
    contract.maxWallMs = record.maxWallMs;
  }

  if (record.maxStartupMs !== undefined) {
    if (typeof record.maxStartupMs !== "number" || !Number.isInteger(record.maxStartupMs) || record.maxStartupMs < 1) {
      throw new Error("executionContract.maxStartupMs must be a positive integer.");
    }
    contract.maxStartupMs = record.maxStartupMs;
  }

  if (record.maxExecutionMs !== undefined) {
    if (typeof record.maxExecutionMs !== "number" || !Number.isInteger(record.maxExecutionMs) || record.maxExecutionMs < 1) {
      throw new Error("executionContract.maxExecutionMs must be a positive integer.");
    }
    contract.maxExecutionMs = record.maxExecutionMs;
  }

  if (record.idleTimeoutMs !== undefined) {
    if (typeof record.idleTimeoutMs !== "number" || !Number.isInteger(record.idleTimeoutMs) || record.idleTimeoutMs < 1) {
      throw new Error("executionContract.idleTimeoutMs must be a positive integer.");
    }
    contract.idleTimeoutMs = record.idleTimeoutMs;
  }

  const authorityMode = contract.authorityMode ?? "OWNER_DIRECT";
  if (authorityMode === "OWNER_DIRECT" && contract.nexusGrant) {
    throw new Error("OWNER_DIRECT execution must not carry Nexus grant authority.");
  }
  if (authorityMode === "NEXUS_GOVERNED") {
    if (!contract.nexusGrant || !contract.dispatchIntent || !contract.expectedHead) {
      throw new Error("NEXUS_GOVERNED execution requires nexusGrant, dispatchIntent, and expectedHead.");
    }
  }

  if (contract.dispatchIntent) {
    const intentWriteScope = contract.dispatchIntent.writeScope ?? [];
    const executionWriteScope = contract.writePaths ?? [];
    const intentKey = [...intentWriteScope].sort().join("\n");
    const executionKey = [...executionWriteScope].sort().join("\n");
    if (intentKey !== executionKey) {
      throw new Error(
        "executionContract.dispatchIntent.writeScope must exactly match executionContract.writePaths; DevSpace does not maintain two write-scope authorities.",
      );
    }
  }

  return Object.keys(contract).length > 0 ? contract : undefined;
}

export function serializeExecutionContract(contract: ExecutionContract | undefined): string | null {
  if (!contract) return null;
  return JSON.stringify(contract);
}

export function deserializeExecutionContract(value: string | null | undefined): ExecutionContract | undefined {
  if (!value) return undefined;
  try {
    return parseExecutionContract(JSON.parse(value));
  } catch {
    return undefined;
  }
}
