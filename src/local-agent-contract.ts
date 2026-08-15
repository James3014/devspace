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
  /** Optional wall-clock bound for the whole agent turn. */
  maxWallMs?: number;
  /** Recorded and surfaced; not auto-enforced without a mid-run activity signal. */
  idleTimeoutMs?: number;
}

export interface ScopeBaseline {
  /** Workspace-relative changed paths present before the worker turn started. */
  changedPaths: string[];
  /** HEAD at baseline snapshot time (or null when Git is unavailable). */
  head: string | null;
}

export function parseExecutionContract(value: unknown): ExecutionContract | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("executionContract must be an object.");
  }
  const record = value as Record<string, unknown>;
  const contract: ExecutionContract = {};

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

  if (record.idleTimeoutMs !== undefined) {
    if (typeof record.idleTimeoutMs !== "number" || !Number.isInteger(record.idleTimeoutMs) || record.idleTimeoutMs < 1) {
      throw new Error("executionContract.idleTimeoutMs must be a positive integer.");
    }
    contract.idleTimeoutMs = record.idleTimeoutMs;
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
