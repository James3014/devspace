import { open, readFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { canonicalizePath, isPathInsideRoot } from "./roots.js";
import { redactSensitiveText } from "./sensitive-redaction.js";

export const hostOperationExternalOutputSchema = {
  found: z.boolean(),
  operation_id: z.string(),
  attempt_id: z.string().nullable().optional(),
  kind: z.literal("nexus_agy"),
  status: z.string(),
  phase: z.string().nullable().optional(),
  exit_code: z.number().nullable().optional(),
  requested_model: z.string().nullable().optional(),
  observed_model: z.string().nullable().optional(),
  observed_provider: z.string().nullable().optional(),
  account_alias_hash: z.string().nullable().optional(),
  lease_id_hash: z.string().nullable().optional(),
  quota_preflight_progress: z.record(z.string(), z.unknown()).nullable().optional(),
  provider_session_id: z.string().nullable().optional(),
  rotations: z.number().nullable().optional(),
  failure_kind: z.string().nullable().optional(),
  has_unresolved_external_effect: z.boolean().nullable().optional(),
  runtime_revision: z.string().nullable().optional(),
  tool_event_count: z.number().nullable().optional(),
  observed_changed_paths: z.array(z.string()).nullable().optional(),
  created_at: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
  reconciled_at: z.string().nullable().optional(),
  backend: z.record(z.string(), z.unknown()),
  lease_state: z.record(z.string(), z.unknown()).optional(),
  output_projection: z.record(z.string(), z.unknown()).optional(),
  retry_safety: z.record(z.string(), z.unknown()),
  error: z.string().optional(),
};

export type HostOperationExternalBackendKind = "nexus_agy";

export const AGY_OPERATION_ID_REGEX = /^agyop_[a-zA-Z0-9_-]{1,128}$/;
const AGY_OPERATION_SCHEMA = "nexus.agy_operation.v1";
const AGY_HASH_REGEX = /^[0-9a-f]{12}$/;
const TERMINAL_OPERATION_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"]);

export interface HostOperationExternalBackendProof {
  kind: "nexus_agy";
  journal_schema: string;
  journal_root: string;
  provenance: "canonical_host_journal";
}

export interface HostOperationExternalLeaseState {
  status: "active" | "released" | "unknown" | "not_applicable";
  residual: boolean;
  account_alias_hash: string | null;
  lease_id_hash: string | null;
  holder_pid?: number | null;
  holder_alive?: boolean | null;
}

export interface HostOperationExternalOutputProjection {
  stdout: string | null;
  stderr: string | null;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

export interface HostOperationExternalRetrySafety {
  /**
   * Effective authority granted by this read-only projection. Always false.
   * Any retry-safe evidence remains owned by the canonical journal.
   */
  retry_permitted: false;
  /** Canonical journal evidence, when present; informational only. */
  journal_retry_permitted: boolean | null;
  reconciliation_required: boolean;
}

export interface HostOperationExternalStatusSuccess {
  found: true;
  operation_id: string;
  attempt_id: string | null;
  kind: "nexus_agy";
  status: string;
  phase: string | null;
  exit_code: number | null;
  requested_model: string | null;
  observed_model: string | null;
  observed_provider: string | null;
  account_alias_hash: string | null;
  lease_id_hash: string | null;
  quota_preflight_progress: Record<string, unknown> | null;
  provider_session_id: string | null;
  rotations: number | null;
  failure_kind: string | null;
  has_unresolved_external_effect: boolean | null;
  runtime_revision: string | null;
  tool_event_count: number | null;
  observed_changed_paths: string[] | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  reconciled_at: string | null;
  backend: HostOperationExternalBackendProof;
  lease_state: HostOperationExternalLeaseState;
  output_projection: HostOperationExternalOutputProjection;
  retry_safety: HostOperationExternalRetrySafety;
}

export interface HostOperationExternalStatusNotFound {
  found: false;
  operation_id: string;
  kind: "nexus_agy";
  status: "NOT_FOUND" | "INVALID_OPERATION_ID" | "CORRUPTED";
  error: string;
  backend: HostOperationExternalBackendProof;
  retry_safety: HostOperationExternalRetrySafety;
}

export type HostOperationExternalStatusResult =
  | HostOperationExternalStatusSuccess
  | HostOperationExternalStatusNotFound;

export interface ExternalHostOperationOptions {
  kind?: string;
  operationRoot?: string;
  leasesDir?: string;
}

export function resolveCanonicalJournalRoots(config?: ServerConfig): {
  operationRoot: string;
  leasesDir: string;
} {
  const operationRoot =
    config?.nexusAgyOperationRoot ??
    process.env.NEXUS_AGY_OPERATION_ROOT ??
    join(homedir(), ".local/state/nexus-agy-operations");

  const leasesDir =
    config?.nexusAgyLeasesDir ??
    process.env.NEXUS_AGY_LEASES_DIR ??
    join(homedir(), ".nexus/agy-account-pool/leases");

  return {
    operationRoot: canonicalizePath(operationRoot),
    leasesDir: canonicalizePath(leasesDir),
  };
}

function isCanonicalPathInside(path: string, root: string): boolean {
  try {
    return isPathInsideRoot(canonicalizePath(path), canonicalizePath(root));
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function readBoundedLog(
  filePath: string,
  allowedRoot: string,
  maxBytes = 8192,
): Promise<{ text: string | null; truncated: boolean }> {
  try {
    if (!isCanonicalPathInside(filePath, allowedRoot)) {
      return { text: null, truncated: false };
    }
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return { text: null, truncated: false };
    }
    const truncated = stats.size > maxBytes;
    const fh = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stats.size, maxBytes));
      await fh.read(buffer, 0, buffer.length, 0);
      const rawText = buffer.toString("utf8");
      return { text: redactSensitiveText(rawText), truncated };
    } finally {
      await fh.close();
    }
  } catch {
    return { text: null, truncated: false };
  }
}

async function readResidualLeaseState(
  record: Record<string, unknown>,
  leasesDir: string,
): Promise<HostOperationExternalLeaseState> {
  const rawAccountAliasHash =
    typeof record.account_alias_hash === "string" ? record.account_alias_hash : null;
  const rawLeaseIdHash =
    typeof record.lease_id_hash === "string" ? record.lease_id_hash : null;
  const accountAliasHash =
    rawAccountAliasHash && AGY_HASH_REGEX.test(rawAccountAliasHash) ? rawAccountAliasHash : null;
  const leaseIdHash =
    rawLeaseIdHash && AGY_HASH_REGEX.test(rawLeaseIdHash) ? rawLeaseIdHash : null;

  if (!rawAccountAliasHash && !rawLeaseIdHash) {
    return {
      status: "not_applicable",
      residual: false,
      account_alias_hash: null,
      lease_id_hash: null,
      holder_pid: null,
      holder_alive: null,
    };
  }

  // Malformed journal identity must never become a filesystem path.
  if (!accountAliasHash || !leaseIdHash) {
    return {
      status: "unknown",
      residual: false,
      account_alias_hash: accountAliasHash,
      lease_id_hash: leaseIdHash,
      holder_pid: null,
      holder_alive: null,
    };
  }

  const receiptPath = join(leasesDir, `${accountAliasHash}.receipt.json`);
  if (!isCanonicalPathInside(receiptPath, leasesDir)) {
    return {
      status: "unknown",
      residual: false,
      account_alias_hash: accountAliasHash,
      lease_id_hash: leaseIdHash,
      holder_pid: null,
      holder_alive: null,
    };
  }

  let raw: string;
  try {
    const receiptStat = await lstat(receiptPath);
    if (receiptStat.isSymbolicLink() || !receiptStat.isFile()) {
      return {
        status: "unknown",
        residual: false,
        account_alias_hash: accountAliasHash,
        lease_id_hash: leaseIdHash,
        holder_pid: null,
        holder_alive: null,
      };
    }
    raw = await readFile(receiptPath, "utf8");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return {
        status: "released",
        residual: false,
        account_alias_hash: accountAliasHash,
        lease_id_hash: leaseIdHash,
        holder_pid: null,
        holder_alive: null,
      };
    }
    return {
      status: "unknown",
      residual: false,
      account_alias_hash: accountAliasHash,
      lease_id_hash: leaseIdHash,
      holder_pid: null,
      holder_alive: null,
    };
  }

  try {
    const receipt = JSON.parse(raw) as Record<string, unknown>;
    if (receipt.account_alias_hash !== accountAliasHash) {
      return {
        status: "unknown",
        residual: false,
        account_alias_hash: accountAliasHash,
        lease_id_hash: leaseIdHash,
        holder_pid: null,
        holder_alive: null,
      };
    }
    if (receipt.lease_id_hash !== leaseIdHash) {
      return {
        status: "released",
        residual: false,
        account_alias_hash: accountAliasHash,
        lease_id_hash: leaseIdHash,
        holder_pid: null,
        holder_alive: null,
      };
    }

    const holderPid = typeof receipt.pid === "number" && receipt.pid > 0 ? receipt.pid : null;
    const operationOwnerPid =
      typeof record.pid === "number" && record.pid > 0 ? record.pid : null;
    if (operationOwnerPid !== null && holderPid !== operationOwnerPid) {
      return {
        status: "unknown",
        residual: false,
        account_alias_hash: accountAliasHash,
        lease_id_hash: leaseIdHash,
        holder_pid: holderPid,
        holder_alive: null,
      };
    }

    let holderAlive: boolean | null = null;
    if (holderPid !== null) {
      try {
        process.kill(holderPid, 0);
        holderAlive = true;
      } catch (error: unknown) {
        holderAlive = errorCode(error) === "EPERM";
      }
    }

    const statusStr = String(record.status ?? "").toUpperCase();
    const phaseStr = String(record.phase ?? "").toUpperCase();
    const isTerminal =
      phaseStr === "TERMINAL" || TERMINAL_OPERATION_STATES.has(statusStr);

    if (isTerminal) {
      return {
        status: "active",
        residual: true,
        account_alias_hash: accountAliasHash,
        lease_id_hash: leaseIdHash,
        holder_pid: holderPid,
        holder_alive: holderAlive,
      };
    }

    if (holderAlive !== true) {
      // A dead/missing receipt owner does not prove the inherited account lock is free.
      return {
        status: "unknown",
        residual: holderAlive === false,
        account_alias_hash: accountAliasHash,
        lease_id_hash: leaseIdHash,
        holder_pid: holderPid,
        holder_alive: holderAlive,
      };
    }

    return {
      status: "active",
      residual: false,
      account_alias_hash: accountAliasHash,
      lease_id_hash: leaseIdHash,
      holder_pid: holderPid,
      holder_alive: holderAlive,
    };
  } catch {
    return {
      status: "unknown",
      residual: false,
      account_alias_hash: accountAliasHash,
      lease_id_hash: leaseIdHash,
      holder_pid: null,
      holder_alive: null,
    };
  }
}

function computeRetrySafety(
  record: Record<string, unknown>,
): HostOperationExternalRetrySafety {
  const statusStr = String(record.status ?? "").toUpperCase();
  const phaseStr = String(record.phase ?? "").toUpperCase();
  const reconciliation =
    typeof record.reconciliation === "object" && record.reconciliation !== null
      ? (record.reconciliation as Record<string, unknown>)
      : null;
  const journalRetryPermitted =
    typeof reconciliation?.retry_permitted === "boolean"
      ? reconciliation.retry_permitted
      : null;

  return {
    // This tool is evidence-only: it may project journal retry evidence but never grants retry authority.
    retry_permitted: false,
    journal_retry_permitted: journalRetryPermitted,
    reconciliation_required:
      statusStr === "OUTCOME_UNKNOWN" || phaseStr === "RECONCILE_REQUIRED",
  };
}

export async function readExternalHostOperationStatus(
  operationId: string,
  options?: ExternalHostOperationOptions,
): Promise<HostOperationExternalStatusResult> {
  const kind = options?.kind ?? "nexus_agy";
  if (kind !== "nexus_agy") {
    throw new Error(`Unsupported operation backend kind: ${kind}`);
  }

  const { operationRoot, leasesDir } = resolveCanonicalJournalRoots({
    nexusAgyOperationRoot: options?.operationRoot,
    nexusAgyLeasesDir: options?.leasesDir,
  } as ServerConfig);

  const fallbackProof: HostOperationExternalBackendProof = {
    kind: "nexus_agy",
    journal_schema: AGY_OPERATION_SCHEMA,
    journal_root: operationRoot,
    provenance: "canonical_host_journal",
  };

  if (
    !operationId ||
    typeof operationId !== "string" ||
    !AGY_OPERATION_ID_REGEX.test(operationId)
  ) {
    return {
      found: false,
      operation_id: String(operationId ?? ""),
      kind: "nexus_agy",
      status: "INVALID_OPERATION_ID",
      error: `Invalid operation ID format: "${operationId}". Expected agyop_<id>.`,
      backend: fallbackProof,
      retry_safety: {
        retry_permitted: false,
        journal_retry_permitted: null,
        reconciliation_required: false,
      },
    };
  }

  const operationsDir = join(operationRoot, "operations");
  const operationDir = join(operationsDir, operationId);
  const operationJsonPath = join(operationDir, "operation.json");

  if (
    !isCanonicalPathInside(operationDir, operationsDir) ||
    !isCanonicalPathInside(operationJsonPath, operationDir)
  ) {
    return {
      found: false,
      operation_id: operationId,
      kind: "nexus_agy",
      status: "CORRUPTED",
      error: `Operation record for ${operationId} escapes the canonical journal root.`,
      backend: fallbackProof,
      retry_safety: {
        retry_permitted: false,
        journal_retry_permitted: null,
        reconciliation_required: true,
      },
    };
  }

  let record: Record<string, unknown>;
  try {
    const recordStat = await lstat(operationJsonPath);
    if (recordStat.isSymbolicLink() || !recordStat.isFile()) {
      throw new Error("operation.json must be a regular non-symlink file");
    }
    const raw = await readFile(operationJsonPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("operation.json must contain an object");
    }
    record = parsed as Record<string, unknown>;
  } catch (err: unknown) {
    if (errorCode(err) === "ENOENT") {
      return {
        found: false,
        operation_id: operationId,
        kind: "nexus_agy",
        status: "NOT_FOUND",
        error: `Operation ${operationId} not found in canonical journal.`,
        backend: fallbackProof,
        retry_safety: {
          retry_permitted: false,
          journal_retry_permitted: null,
          reconciliation_required: false,
        },
      };
    }
    return {
      found: false,
      operation_id: operationId,
      kind: "nexus_agy",
      status: "CORRUPTED",
      error: `Operation record for ${operationId} is corrupted or unreadable: ${
        err instanceof Error ? err.message : String(err)
      }`,
      backend: fallbackProof,
      retry_safety: {
        retry_permitted: false,
        journal_retry_permitted: null,
        reconciliation_required: true,
      },
    };
  }

  if (
    record.schema !== AGY_OPERATION_SCHEMA ||
    record.operation_id !== operationId
  ) {
    return {
      found: false,
      operation_id: operationId,
      kind: "nexus_agy",
      status: "CORRUPTED",
      error: `Operation record for ${operationId} failed canonical schema/identity validation.`,
      backend: fallbackProof,
      retry_safety: {
        retry_permitted: false,
        journal_retry_permitted: null,
        reconciliation_required: true,
      },
    };
  }

  const safeStdoutPath =
    typeof record.stdout_path === "string" &&
    isPathInsideRoot(record.stdout_path, operationDir)
      ? record.stdout_path
      : join(operationDir, "stdout.log");

  const safeStderrPath =
    typeof record.stderr_path === "string" &&
    isPathInsideRoot(record.stderr_path, operationDir)
      ? record.stderr_path
      : join(operationDir, "stderr.log");

  const [stdoutResult, stderrResult, leaseState] = await Promise.all([
    readBoundedLog(safeStdoutPath, operationDir),
    readBoundedLog(safeStderrPath, operationDir),
    readResidualLeaseState(record, leasesDir),
  ]);

  const retrySafety = computeRetrySafety(record);

  return {
    found: true,
    operation_id: operationId,
    attempt_id: typeof record.attempt_id === "string" ? record.attempt_id : null,
    kind: "nexus_agy",
    status: String(record.status ?? "UNKNOWN"),
    phase: typeof record.phase === "string" ? record.phase : null,
    exit_code: typeof record.exit_code === "number" ? record.exit_code : null,
    requested_model: typeof record.model === "string" ? record.model : null,
    observed_model:
      typeof record.observed_model === "string" ? record.observed_model : null,
    observed_provider:
      typeof record.observed_provider === "string"
        ? record.observed_provider
        : typeof record.provider === "string"
          ? record.provider
          : null,
    account_alias_hash:
      typeof record.account_alias_hash === "string" &&
      AGY_HASH_REGEX.test(record.account_alias_hash)
        ? record.account_alias_hash
        : null,
    lease_id_hash:
      typeof record.lease_id_hash === "string" &&
      AGY_HASH_REGEX.test(record.lease_id_hash)
        ? record.lease_id_hash
        : null,
    quota_preflight_progress:
      typeof record.quota_preflight_progress === "object" &&
      record.quota_preflight_progress !== null
        ? (record.quota_preflight_progress as Record<string, unknown>)
        : null,
    provider_session_id:
      typeof record.provider_session_id === "string"
        ? record.provider_session_id
        : null,
    rotations: typeof record.rotations === "number" ? record.rotations : null,
    failure_kind:
      typeof record.failure_kind === "string" ? record.failure_kind : null,
    has_unresolved_external_effect:
      typeof record.has_unresolved_external_effect === "boolean"
        ? record.has_unresolved_external_effect
        : null,
    runtime_revision:
      typeof record.runtime_revision === "string"
        ? record.runtime_revision
        : null,
    tool_event_count:
      typeof record.tool_event_count === "number" ? record.tool_event_count : null,
    observed_changed_paths: Array.isArray(record.observed_changed_paths)
      ? record.observed_changed_paths.filter(
          (p): p is string => typeof p === "string",
        )
      : null,
    created_at: typeof record.created_at === "string" ? record.created_at : null,
    started_at: typeof record.started_at === "string" ? record.started_at : null,
    finished_at:
      typeof record.finished_at === "string" ? record.finished_at : null,
    reconciled_at:
      typeof record.reconciled_at === "string" ? record.reconciled_at : null,
    backend: {
      kind: "nexus_agy",
      journal_schema: AGY_OPERATION_SCHEMA,
      journal_root: operationRoot,
      provenance: "canonical_host_journal",
    },
    lease_state: leaseState,
    output_projection: {
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      stdout_truncated: stdoutResult.truncated,
      stderr_truncated: stderrResult.truncated,
    },
    retry_safety: retrySafety,
  };
}
