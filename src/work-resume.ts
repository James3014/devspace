/**
 * P0 Interrupted-turn Resume / Worktree Writer Lease
 *
 * This module introduces:
 *
 *  A. Stable logical work identity (workKey) – computed from immutable semantic
 *     material: repository, durable owner issue, exact base SHA, canonical
 *     physical worktree realpath, normalised write scope, frozen contract purpose.
 *     No random UUID or timestamp in the semantic key.
 *
 *  B. Reuses the existing #62 ControlPlaneOwnershipStore acquire / assertHeld /
 *     beginOperation / finish / reconcile / handoff semantics as the single
 *     writer-lease authority.  A lightweight projection table
 *     (work_resume_registry) maps workKey → idempotency key + lease id so that a
 *     successor conversation can look up the durable handle without creating a
 *     second lock table.
 *
 *  C. Resumable attempt registry (read-only surface): workKeyDisposition() returns
 *     RUNNING | TERMINAL | RECONCILE_REQUIRED | NO_EXISTING_ATTEMPT.
 *
 *  D. Writer admission: admit() re-reads the lease via assertHeld immediately
 *     before any write effect is initiated; old owners after version drift fail
 *     closed.
 *
 *  E. Effect pinning: pin() wraps beginOperation; unknown outcomes are classified
 *     RECONCILE_REQUIRED and block re-acquisition.
 *
 *  F. Dedup: same workKey + active durable effect ⟹ DUPLICATE_EFFECT_SUPPRESSED;
 *     terminal replay returns existing handle.
 *
 *  G. Compatibility: existing #62 consumers are unaffected.  Direct/manual paths
 *     that carry no P0 resumable-work contract continue to work.
 *
 * REPAIR NOTES (vs. first pass):
 *  - canonicalPath: production realpath failure => fail closed (no lexical fallback).
 *  - boundedSha: requires exact 40 lowercase hex (not 4–64).
 *  - normalizeScope: scope paths must be absolute and inside the worktree root.
 *  - Terminal receipt cache is a read-only projection: does NOT outrank #62
 *    canonical lease/reconciliation state. Terminal classification derives from
 *    the live ownership store first; cache is only for cheap replay reads.
 *  - ResumableWorkPointer: bounded trusted type for tools to carry P0 contract.
 *  - centralAdmissionCheck: single helper that all write-capable sinks call
 *    BEFORE launching any provider, file, git, or process effect.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { posix } from "node:path";
import type Database from "better-sqlite3";
import {
  ControlPlaneOwnershipStore,
  ControlPlaneOwnershipError,
  resolvePhysicalResource,
  type ResourceLeaseInput,
  type ResourceLease,
  type GrantEvidenceReference,
  type ReconciliationReceipt,
} from "./control-plane-ownership.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Schema sentinel written into the registry row; bump on incompatible change. */
export const WORK_RESUME_SCHEMA = "devspace.work_resume.v1" as const;
export const WORKTREE_WRITER_OPERATION = "worktree_write" as const;

// ─── Semantic key computation ────────────────────────────────────────────────

/**
 * All immutable semantic material that must contribute to the canonical work
 * key.  Changing any field for the same caller-supplied key is a conflict.
 */
export interface WorkKeyMaterial {
  /** Canonical owner/repository key, e.g. "james3014/devspace" */
  repositoryKey: string;
  /** Durable owner issue or task identity, e.g. "#328" or "issue-328" */
  ownerIssueId: string;
  /** Exact base commit SHA at dispatch time – must be exact 40 lowercase hex */
  baseRevisionSha: string;
  /** Canonical physical realpath of the worktree root */
  worktreeRealpath: string;
  /** Sorted, normalised absolute write-scope paths under the worktree root */
  writeScope: readonly string[];
  /** Frozen contract / purpose identity string */
  contractPurpose: string;
}

export interface WorkResumePrepareInput {
  material: WorkKeyMaterial;
  /** Exact #62 lease already acquired by the trusted carrier authority. */
  lease: ResourceLease;
}

export interface WorkResumePrepareResult {
  workKey: string;
  lease: ResourceLease;
  status: WorkResumeStatus;
  material: WorkKeyMaterial;
}

/**
 * Derive a stable, deterministic work key from immutable semantic material.
 * The key is a `wk_<hex32>` string; caller-supplied labels are never part of
 * the stable key.
 */
export function computeWorkRequestHash(material: WorkKeyMaterial): string {
  const root = posixNormalize(material.worktreeRealpath);
  bounded(root, "worktreeRealpath");
  const canonical = {
    repositoryKey: normalizeRepositoryKey(material.repositoryKey),
    ownerIssueId: bounded(material.ownerIssueId, "ownerIssueId"),
    baseRevisionSha: boundedSha(material.baseRevisionSha),
    worktreeRealpath: root,
    writeScope: normalizeScope(material.writeScope, material.worktreeRealpath),
    contractPurpose: bounded(material.contractPurpose, "contractPurpose"),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function computeWorkKey(material: WorkKeyMaterial): string {
  return `wk_${computeWorkRequestHash(material).slice(0, 32)}`;
}

/**
 * Verify that the material stored in the registry matches the caller-supplied
 * material exactly.  Throws CONFLICT if diverged.
 */
export function assertMaterialMatch(
  stored: WorkKeyMaterial,
  incoming: WorkKeyMaterial,
): void {
  // Use lexical-only scope normalization here (no containment validation).
  // Containment is enforced at registration; during comparison we only need
  // to detect whether the scopes differ.  Calling the full normalizeScope()
  // (which enforces containment under the stored/incoming worktree roots)
  // would throw INVALID_INPUT before we can report MATERIAL_CONFLICT.
  const sortScope = (scope: readonly string[]): string[] =>
    [...new Set(scope.map((s) => posixNormalize(s.replaceAll("\\", "/"))))].sort();
  const a = JSON.stringify({
    repositoryKey: normalizeRepositoryKey(stored.repositoryKey),
    ownerIssueId: stored.ownerIssueId,
    baseRevisionSha: stored.baseRevisionSha,
    worktreeRealpath: posixNormalize(stored.worktreeRealpath),
    writeScope: sortScope(stored.writeScope),
    contractPurpose: stored.contractPurpose,
  });
  const b = JSON.stringify({
    repositoryKey: normalizeRepositoryKey(incoming.repositoryKey),
    ownerIssueId: incoming.ownerIssueId,
    baseRevisionSha: incoming.baseRevisionSha,
    worktreeRealpath: posixNormalize(incoming.worktreeRealpath),
    writeScope: sortScope(incoming.writeScope),
    contractPurpose: incoming.contractPurpose,
  });
  if (a !== b) {
    throw new WorkResumeError(
      "MATERIAL_CONFLICT",
      "Different semantic material was supplied under the same work key; failing closed.",
    );
  }
}


// ─── Disposition / read-only surface ─────────────────────────────────────────

export type WorkDisposition =
  | "RUNNING"
  | "TERMINAL"
  | "RECONCILE_REQUIRED"
  | "NO_EXISTING_ATTEMPT";

export type WorkOperationRole = "IMPLEMENT" | "REPAIR" | "VERIFY" | "RECONCILE";

export interface WorkLineage {
  role?: WorkOperationRole;
  parentEffectKey?: string;
  supersedes?: string;
}

export interface WorkResumeStatus {
  schema: typeof WORK_RESUME_SCHEMA;
  workKey: string;
  disposition: WorkDisposition;
  /** Present when disposition != NO_EXISTING_ATTEMPT */
  leaseId?: string;
  /** Version of the lease at discovery time */
  leaseVersion?: number;
  /** Active operation handle when disposition is RUNNING */
  operationHandle?: string;
  /** Durable operation status (started / succeeded / failed / outcome_unknown) */
  operationStatus?: string;
  /** Exact base revision recorded at registration time */
  baseRevisionSha?: string;
  /** Canonical worktree path recorded at registration time */
  worktreeRealpath?: string;
  /** The stable idempotency key used on the underlying lease */
  idempotencyKey?: string;
  /** Bound effect class for resume discovery (for P0 currently "agent"). */
  effectKind?: string;
  /** Stable effect identity within the work key (for agents: attemptKey). */
  effectKey?: string;
  /** Concrete durable handle returned by the effect owner (for agents: agentId). */
  effectHandle?: string;
  /** P1 operation lineage graph info */
  lineage?: WorkLineage;
  /** Mechanical automated verifier execution result on worker terminal */
  automatedVerifierResult?: Record<string, unknown>;
  /** Append-only per-effect verifier outcomes, keyed by semantic effect identity. */
  automatedVerifierEffects?: Record<string, Record<string, unknown>>;
  /**
   * Terminal reconciliation receipt when disposition is TERMINAL.
   * Derived from canonical #62 store; cache is read-only projection only.
   */
  terminalReceipt?: ReconciliationReceipt;
  message: string;
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class WorkResumeError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "MATERIAL_CONFLICT"
      | "DUPLICATE_EFFECT_SUPPRESSED"
      | "OWNERSHIP_CONFLICT"
      | "RECONCILE_REQUIRED"
      | "EXPIRED"
      | "CAS_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "WorkResumeError";
  }
}

// ─── Schema / DB initialisation ───────────────────────────────────────────────

/**
 * Initialise the projection table used by WorkResumeStore.
 * Called from migrations.ts (migration 25).
 * Idempotent – uses CREATE TABLE IF NOT EXISTS.
 */
export function initializeWorkResumeDatabase(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists work_resume_registry (
      work_key        text primary key,
      idempotency_key text not null,
      lease_id        text not null,
      repository_key  text not null,
      owner_issue_id  text not null,
      base_revision   text not null,
      worktree_path   text not null,
      scope_json      text not null,
      contract_purpose text not null,
      effect_kind      text,
      effect_key       text,
      effect_handle    text,
      registered_at   text not null,
      updated_at      text not null
    );
    create index if not exists work_resume_registry_lease_idx
      on work_resume_registry(lease_id);
  `);

  /*
   * Terminal receipt projection cache.
   * Stores receipt_id + receipt_json derived from the canonical #62 reconcile()
   * call.  This table is a read-only projection: it cannot outrank the canonical
   * lease/reconciliation state in control_plane_resource_leases.
   * disposition() always cross-checks the live ownership store first; this
   * cache is used only for cheap replay reads when the lease is already terminal.
   */
  sqlite.exec(`
    create table if not exists work_resume_terminal_receipts (
      work_key    text primary key,
      receipt_id  text not null,
      receipt_json text not null,
      recorded_at text not null
    );
  `);

  // Forward-compatible for any development database that observed an earlier
  // draft of migration 25 before the effect-handle projection was added.
  const registryColumns = new Set(
    (sqlite.prepare("pragma table_info(work_resume_registry)").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  if (!registryColumns.has("effect_kind")) {
    sqlite.exec("alter table work_resume_registry add column effect_kind text");
  }
  if (!registryColumns.has("effect_key")) {
    sqlite.exec("alter table work_resume_registry add column effect_key text");
  }
  if (!registryColumns.has("effect_handle")) {
    sqlite.exec("alter table work_resume_registry add column effect_handle text");
  }
  if (!registryColumns.has("role")) {
    sqlite.exec("alter table work_resume_registry add column role text");
  }
  if (!registryColumns.has("parent_effect")) {
    sqlite.exec("alter table work_resume_registry add column parent_effect text");
  }
  if (!registryColumns.has("supersedes")) {
    sqlite.exec("alter table work_resume_registry add column supersedes text");
  }
  if (!registryColumns.has("verifier_result")) {
    sqlite.exec("alter table work_resume_registry add column verifier_result text");
  }
  if (!registryColumns.has("verifier_effects")) {
    sqlite.exec("alter table work_resume_registry add column verifier_effects text");
  }
}

// ─── Registry row type ────────────────────────────────────────────────────────

interface RegistryRow {
  work_key: string;
  idempotency_key: string;
  lease_id: string;
  repository_key: string;
  owner_issue_id: string;
  base_revision: string;
  worktree_path: string;
  scope_json: string;
  contract_purpose: string;
  effect_kind: string | null;
  effect_key: string | null;
  effect_handle: string | null;
  role?: string | null;
  parent_effect?: string | null;
  supersedes?: string | null;
  verifier_result?: string | null;
  verifier_effects?: string | null;
  registered_at: string;
  updated_at: string;
}

interface TerminalReceiptRow {
  work_key: string;
  receipt_id: string;
  receipt_json: string;
  recorded_at: string;
}

// ─── Writer admission input ───────────────────────────────────────────────────

export interface WriterAdmissionInput {
  workKey: string;
  /** Caller-supplied owner context passed to ControlPlaneOwnershipStore */
  ownerContext: unknown;
  /** Exact lease id expected */
  leaseId: string;
  /** Exact lease version expected (CAS) */
  expectedLeaseVersion: number;
  /** Sink label for diagnostics only; lease authority is always worktree_write. */
  operation: string;
  /** Base revision for assertHeld */
  baseRevision: string;
}

export interface WriterAdmissionReceipt {
  workKey: string;
  leaseId: string;
  admittedLeaseVersion: number;
  operationHandle?: string;
  replayedPinnedEffect?: boolean;
}

// ─── Resumable work pointer ───────────────────────────────────────────────────

/**
 * Bounded trusted pointer that mutation tools carry to identify and fence a
 * P0 resumable-work contract.  All fields are exact; none is user prose.
 *
 * Consumers:
 *  - agent_start / agent_continue: carried in ExecutionContract.resumableWork
 *  - write / edit / git_commit / git_push / git_promote_candidate / bash:
 *    carried in the execution contract on the agent record
 *
 * Legacy callers without resumableWork continue to work; only requests that
 * explicitly set resumableWork enter the P0 fencing lane.
 */
export interface ResumableWorkPointer {
  /** Stable semantic work key (wk_<hex32>) */
  workKey: string;
  /** Exact lease id from ControlPlaneOwnershipStore */
  leaseId: string;
  /** Exact lease version for CAS */
  expectedLeaseVersion: number;
  /** Exact base revision SHA (40 lowercase hex) */
  baseRevisionSha: string;
  /**
   * Exact operation/effect handle for this specific sink.
   * If absent, admission re-read is performed but no new pin is set.
   */
  effectHandle?: string;
}

/**
 * Parse and validate a ResumableWorkPointer from an untrusted object.
 * Returns undefined if value is undefined/null (legacy path).
 * Throws WorkResumeError for malformed inputs.
 */
export function parseResumableWorkPointer(value: unknown): ResumableWorkPointer | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new WorkResumeError("INVALID_INPUT", "resumableWork must be an object");
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.workKey !== "string" || !/^wk_[0-9a-f]{32}$/.test(rec.workKey)) {
    throw new WorkResumeError("INVALID_INPUT", "resumableWork.workKey must be wk_<32hex>");
  }
  if (typeof rec.leaseId !== "string" || rec.leaseId.length === 0 || rec.leaseId.length > 1024) {
    throw new WorkResumeError("INVALID_INPUT", "resumableWork.leaseId is invalid");
  }
  if (!Number.isSafeInteger(rec.expectedLeaseVersion) || (rec.expectedLeaseVersion as number) < 1) {
    throw new WorkResumeError("INVALID_INPUT", "resumableWork.expectedLeaseVersion must be positive integer");
  }
  if (typeof rec.baseRevisionSha !== "string" || !/^[0-9a-f]{40}$/.test(rec.baseRevisionSha)) {
    throw new WorkResumeError("INVALID_INPUT", "resumableWork.baseRevisionSha must be 40 lowercase hex");
  }
  let effectHandle: string | undefined;
  if (rec.effectHandle !== undefined) {
    if (typeof rec.effectHandle !== "string" || rec.effectHandle.length === 0 || rec.effectHandle.length > 1024) {
      throw new WorkResumeError("INVALID_INPUT", "resumableWork.effectHandle is invalid");
    }
    effectHandle = rec.effectHandle;
  }
  return {
    workKey: rec.workKey,
    leaseId: rec.leaseId,
    expectedLeaseVersion: rec.expectedLeaseVersion as number,
    baseRevisionSha: rec.baseRevisionSha,
    ...(effectHandle !== undefined ? { effectHandle } : {}),
  };
}

// ─── Central writer-admission helper ─────────────────────────────────────────

/**
 * Input for the central writer-admission check.
 *
 * Callers may supply either the individual fields directly or pass
 * worktreeRealpath for audit purposes — it does NOT bypass the assertHeld CAS.
 */
export interface CentralAdmissionCheckInput {
  store: WorkResumeStore;
  pointer: ResumableWorkPointer | undefined;
  ownerContext: unknown;
  /** Sink-level operation label (default: "writer_effect"). */
  operation?: string;
  /**
   * Physical realpath of the workspace root.  Recorded for audit only;
   * does NOT replace or bypass the #62 assertHeld CAS identity check.
   */
  worktreeRealpath?: string;
}

/**
 * Central writer-admission check for all P0-bound mutation sinks.
 *
 * This is the SINGLE helper that all write-capable sinks MUST call BEFORE
 * launching any provider, file, git, or process effect.  It:
 *  1. Verifies the pointer format and registry binding.
 *  2. Re-reads the lease via assertHeld (CAS + physical identity).
 *  3. Optionally pins an exact effect handle via beginOperation.
 *  4. Returns a bounded receipt the sink may log/propagate.
 *
 * If pointer is undefined the helper is a no-op (legacy path).
 * Any ControlPlaneOwnershipError or WorkResumeError propagates up unchanged;
 * sinks must NOT swallow it.
 *
 * Accepts either a CentralAdmissionCheckInput object or the legacy four
 * positional arguments (store, pointer, ownerContext, operation) for backwards
 * compatibility within this file.
 */
export function centralAdmissionCheck(
  input: CentralAdmissionCheckInput,
): WriterAdmissionReceipt | undefined;
export function centralAdmissionCheck(
  store: WorkResumeStore,
  pointer: ResumableWorkPointer | undefined,
  ownerContext: unknown,
  operation: string,
): WriterAdmissionReceipt | undefined;
export function centralAdmissionCheck(
  storeOrInput: WorkResumeStore | CentralAdmissionCheckInput,
  pointer?: ResumableWorkPointer | undefined,
  ownerContext?: unknown,
  operation?: string,
): WriterAdmissionReceipt | undefined {
  let store: WorkResumeStore;
  let ptr: ResumableWorkPointer | undefined;
  let ctx: unknown;
  let op: string;
  if (storeOrInput instanceof WorkResumeStore) {
    store = storeOrInput;
    ptr = pointer;
    ctx = ownerContext;
    op = operation ?? "writer_effect";
  } else {
    store = storeOrInput.store;
    ptr = storeOrInput.pointer;
    ctx = storeOrInput.ownerContext;
    op = storeOrInput.operation ?? "writer_effect";
  }
  if (!ptr) return undefined;
  const input: WriterAdmissionInput = {
    workKey: ptr.workKey,
    ownerContext: ctx,
    leaseId: ptr.leaseId,
    expectedLeaseVersion: ptr.expectedLeaseVersion,
    operation: op,
    baseRevision: ptr.baseRevisionSha,
  };

  let admission: WriterAdmissionReceipt;
  try {
    admission = store.admitWriter(input);
  } catch (error) {
    if (
      ptr.effectHandle &&
      error instanceof ControlPlaneOwnershipError &&
      error.code === "CAS_CONFLICT"
    ) {
      admission = store.admitPinnedReplay({ ...input, effectHandle: ptr.effectHandle });
    } else {
      throw error;
    }
  }

  if (!ptr.effectHandle) return admission;
  if (admission.operationHandle !== undefined) {
    if (admission.operationHandle !== ptr.effectHandle) {
      throw new WorkResumeError(
        "RECONCILE_REQUIRED",
        "A different effect is already pinned to this worktree lease.",
      );
    }
    return { ...admission, replayedPinnedEffect: true };
  }

  const pinned = store.pinEffect(
    ctx,
    ptr.workKey,
    ptr.leaseId,
    admission.admittedLeaseVersion,
    ptr.effectHandle,
  );
  return {
    workKey: ptr.workKey,
    leaseId: pinned.leaseId,
    admittedLeaseVersion: pinned.version,
    operationHandle: pinned.operationHandle,
  };
}

// ─── WorkResumeStore ──────────────────────────────────────────────────────────

/**
 * Projection coordinator on top of ControlPlaneOwnershipStore.
 *
 * All writer-lease authority stays in ControlPlaneOwnershipStore.
 * This class adds:
 *   - workKey → lease idempotency mapping (projection table only)
 *   - read-only disposition surface
 *   - dedup guard (DUPLICATE_EFFECT_SUPPRESSED)
 *   - writer admission re-read (assertHeld) before first effect
 *   - effect-pin delegation (beginOperation / finishOperation)
 *   - terminal receipt caching (read-only projection, not a second authority)
 */
export class WorkResumeStore {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly ownership: ControlPlaneOwnershipStore,
    private readonly now: () => number = () => Date.now(),
  ) {
    initializeWorkResumeDatabase(sqlite);
  }

  /**
   * Prepare one resumable work identity using the existing #62 ownership store.
   *
   * This projection path canonicalizes physical roots and consumes an exact
   * #62 lease that was already acquired by the trusted carrier authority.
   * It never creates grant/lease authority itself; it only writes the
   * workKey -> lease projection. Exact replay returns the same lease.
   */
  prepare(input: WorkResumePrepareInput): WorkResumePrepareResult {
    const canonicalRoot = resolveCanonicalPath(input.material.worktreeRealpath);
    const canonicalScope = input.material.writeScope.map((path) => resolveCanonicalPath(path));
    const material: WorkKeyMaterial = {
      repositoryKey: normalizeRepositoryKey(input.material.repositoryKey),
      ownerIssueId: bounded(input.material.ownerIssueId, "ownerIssueId"),
      baseRevisionSha: boundedSha(input.material.baseRevisionSha),
      worktreeRealpath: canonicalRoot,
      writeScope: normalizeScope(canonicalScope, canonicalRoot),
      contractPurpose: bounded(input.material.contractPurpose, "contractPurpose"),
    };
    const workKey = computeWorkKey(material);
    const lease = input.lease;
    const expectedIdempotencyKey = leaseIdempotencyKeyForWork(workKey);
    if (
      lease.repositoryKey !== material.repositoryKey ||
      lease.operation !== WORKTREE_WRITER_OPERATION ||
      lease.baseRevision !== material.baseRevisionSha ||
      lease.resource !== material.worktreeRealpath ||
      JSON.stringify(lease.scope) !== JSON.stringify(material.writeScope) ||
      lease.idempotencyKey !== expectedIdempotencyKey ||
      lease.terminalState
    ) {
      throw new WorkResumeError(
        "CAS_CONFLICT",
        "Prepared #62 lease does not exactly match the resumable-work material.",
      );
    }

    const registration = this.register(
      workKey,
      material,
      expectedIdempotencyKey,
      lease.leaseId,
    );
    return { workKey, lease, status: registration.status, material };
  }

  // ─── C. Read-only disposition (pre-dispatch discovery) ─────────────────────

  /**
   * Read current disposition for a work key without acquiring or mutating state.
   * A new conversation controller MUST call this before dispatch.
   *
   * Terminal classification is derived from the canonical #62 ownership store
   * first.  The local receipt cache is used only for cheap replay reads.
   */
  disposition(workKey: string): WorkResumeStatus {
    bounded(workKey, "workKey");
    const row = this.sqlite.prepare(
      "select * from work_resume_registry where work_key=?",
    ).get(workKey) as RegistryRow | undefined;

    if (!row) {
      return {
        schema: WORK_RESUME_SCHEMA,
        workKey,
        disposition: "NO_EXISTING_ATTEMPT",
        message: "No durable attempt registered under this work key.",
      };
    }

    const lineage: WorkLineage | undefined = (row.role || row.parent_effect || row.supersedes)
      ? {
          ...(row.role ? { role: row.role as WorkOperationRole } : {}),
          ...(row.parent_effect ? { parentEffectKey: row.parent_effect } : {}),
          ...(row.supersedes ? { supersedes: row.supersedes } : {}),
        }
      : undefined;

    let automatedVerifierResult: Record<string, unknown> | undefined;
    if (row.verifier_result) {
      try {
        automatedVerifierResult = JSON.parse(row.verifier_result) as Record<string, unknown>;
      } catch {
        automatedVerifierResult = undefined;
      }
    }
    let automatedVerifierEffects: Record<string, Record<string, unknown>> | undefined;
    if (row.verifier_effects) {
      try {
        const parsed = JSON.parse(row.verifier_effects) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          automatedVerifierEffects = parsed as Record<string, Record<string, unknown>>;
        }
      } catch {
        automatedVerifierEffects = undefined;
      }
    }

    // Look up the live lease (canonical authority — always checked first)
    const lease = this.ownership.get(row.lease_id);
    if (!lease) {
      return {
        schema: WORK_RESUME_SCHEMA,
        workKey,
        disposition: "NO_EXISTING_ATTEMPT",
        leaseId: row.lease_id,
        idempotencyKey: row.idempotency_key,
        baseRevisionSha: row.base_revision,
        worktreeRealpath: row.worktree_path,
        ...(row.effect_kind ? { effectKind: row.effect_kind } : {}),
        ...(row.effect_key ? { effectKey: row.effect_key } : {}),
        ...(row.effect_handle ? { effectHandle: row.effect_handle } : {}),
        ...(lineage ? { lineage } : {}),
        ...(automatedVerifierResult ? { automatedVerifierResult } : {}),
        ...(automatedVerifierEffects ? { automatedVerifierEffects } : {}),
        message: "Registered lease is no longer present in ownership store.",
      };
    }

    // Canonical terminal state from #62 (authoritative)
    if (lease.terminalState) {
      // Read receipt from local cache (projection only — not authority)
      let terminalReceipt: ReconciliationReceipt | undefined;
      const terminalRow = this.sqlite.prepare(
        "select * from work_resume_terminal_receipts where work_key=?",
      ).get(workKey) as TerminalReceiptRow | undefined;
      if (terminalRow) {
        try {
          terminalReceipt = JSON.parse(terminalRow.receipt_json) as ReconciliationReceipt;
        } catch {
          // Malformed cache: ignore, return TERMINAL without cached receipt
          terminalReceipt = undefined;
        }
      }
      return {
        schema: WORK_RESUME_SCHEMA,
        workKey,
        disposition: "TERMINAL",
        leaseId: lease.leaseId,
        leaseVersion: lease.version,
        idempotencyKey: row.idempotency_key,
        baseRevisionSha: row.base_revision,
        worktreeRealpath: row.worktree_path,
        ...(row.effect_kind ? { effectKind: row.effect_kind } : {}),
        ...(row.effect_key ? { effectKey: row.effect_key } : {}),
        ...(row.effect_handle ? { effectHandle: row.effect_handle } : {}),
        ...(lineage ? { lineage } : {}),
        ...(automatedVerifierResult ? { automatedVerifierResult } : {}),
        ...(automatedVerifierEffects ? { automatedVerifierEffects } : {}),
        ...(terminalReceipt ? { terminalReceipt } : {}),
        message: `Lease terminal: ${lease.terminalState}`,
      };
    }

    // Classify active lease
    let disposition: WorkDisposition;
    if (lease.operationHandle || lease.operationState === "active") {
      const expired = Date.parse(lease.expiresAt) <= this.now();
      disposition = expired ? "RECONCILE_REQUIRED" : "RUNNING";
    } else {
      const expired = Date.parse(lease.expiresAt) <= this.now();
      disposition = expired ? "RECONCILE_REQUIRED" : "RUNNING";
    }

    return {
      schema: WORK_RESUME_SCHEMA,
      workKey,
      disposition,
      leaseId: lease.leaseId,
      leaseVersion: lease.version,
      operationHandle: lease.operationHandle,
      operationStatus: lease.operationState ?? undefined,
      idempotencyKey: row.idempotency_key,
      baseRevisionSha: row.base_revision,
      worktreeRealpath: row.worktree_path,
      ...(row.effect_kind ? { effectKind: row.effect_kind } : {}),
      ...(row.effect_key ? { effectKey: row.effect_key } : {}),
      ...(row.effect_handle ? { effectHandle: row.effect_handle } : {}),
      ...(lineage ? { lineage } : {}),
      ...(automatedVerifierResult ? { automatedVerifierResult } : {}),
      ...(automatedVerifierEffects ? { automatedVerifierEffects } : {}),
      message: `Disposition: ${disposition}`,
    };
  }

  // ─── Register / dedup ──────────────────────────────────────────────────────

  /**
   * Register a workKey ↔ lease mapping atomically.
   *
   * - If a row exists for this workKey, verify material match, then return the
   *   existing disposition (DUPLICATE_EFFECT_SUPPRESSED if still RUNNING).
   * - If no row exists, insert and return NO_EXISTING_ATTEMPT.
   *
   * The caller is responsible for calling ownership.acquire() first and passing
   * the resulting leaseId here.
   */
  register(
    workKey: string,
    material: WorkKeyMaterial,
    idempotencyKey: string,
    leaseId: string,
  ): { created: boolean; status: WorkResumeStatus } {
    bounded(workKey, "workKey");
    bounded(idempotencyKey, "idempotencyKey");
    bounded(leaseId, "leaseId");

    return this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare(
        "select * from work_resume_registry where work_key=?",
      ).get(workKey) as RegistryRow | undefined;

      if (existing) {
        const storedMaterial: WorkKeyMaterial = {
          repositoryKey: existing.repository_key,
          ownerIssueId: existing.owner_issue_id,
          baseRevisionSha: existing.base_revision,
          worktreeRealpath: existing.worktree_path,
          writeScope: JSON.parse(existing.scope_json) as string[],
          contractPurpose: existing.contract_purpose,
        };
        assertMaterialMatch(storedMaterial, material);
        const status = this.disposition(workKey);
        return { created: false, status };
      }

      const now = new Date(this.now()).toISOString();
      this.sqlite.prepare(`
        insert into work_resume_registry
          (work_key, idempotency_key, lease_id, repository_key, owner_issue_id,
           base_revision, worktree_path, scope_json, contract_purpose,
           registered_at, updated_at)
        values (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        workKey,
        idempotencyKey,
        leaseId,
        normalizeRepositoryKey(material.repositoryKey),
        material.ownerIssueId,
        material.baseRevisionSha,
        material.worktreeRealpath,
        JSON.stringify(normalizeScope(material.writeScope, material.worktreeRealpath)),
        material.contractPurpose,
        now,
        now,
      );

      return { created: true, status: this.disposition(workKey) };
    }).immediate();
  }

  /**
   * Bind one stable effect identity to an already-registered work key.
   *
   * This is projection-only: ownership remains in ControlPlaneOwnershipStore.
   * Exact replay of the same effect is idempotent; a different effect under the
   * same work key fails closed before the downstream effect owner is called.
   */
  bindEffectIdentity(input: {
    workKey: string;
    leaseId: string;
    effectKind: string;
    effectKey: string;
    lineage?: WorkLineage;
  }): WorkResumeStatus {
    bounded(input.workKey, "workKey");
    bounded(input.leaseId, "leaseId");
    bounded(input.effectKind, "effectKind");
    bounded(input.effectKey, "effectKey");

    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare(
        "select * from work_resume_registry where work_key=?",
      ).get(input.workKey) as RegistryRow | undefined;
      if (!row || row.lease_id !== input.leaseId) {
        throw new WorkResumeError(
          "CAS_CONFLICT",
          "Work key / lease binding changed before effect identity binding.",
        );
      }
      if (row.effect_kind || row.effect_key) {
        if (row.effect_kind !== input.effectKind || row.effect_key !== input.effectKey) {
          throw new WorkResumeError(
            "MATERIAL_CONFLICT",
            "A different durable effect is already bound to this work key.",
          );
        }
        return this.disposition(input.workKey);
      }

      this.sqlite.prepare(
        "update work_resume_registry set effect_kind=?, effect_key=?, role=?, parent_effect=?, supersedes=?, updated_at=? where work_key=?",
      ).run(
        input.effectKind,
        input.effectKey,
        input.lineage?.role ?? null,
        input.lineage?.parentEffectKey ?? null,
        input.lineage?.supersedes ?? null,
        new Date(this.now()).toISOString(),
        input.workKey,
      );
      return this.disposition(input.workKey);
    }).immediate();
  }

  /**
   * Record automated mechanical verifier execution result on the durable work key.
   */
  recordAutomatedVerifierResult(
    workKey: string,
    result: Record<string, unknown>,
  ): WorkResumeStatus {
    bounded(workKey, "workKey");
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare(
        "select * from work_resume_registry where work_key=?",
      ).get(workKey) as RegistryRow | undefined;
      if (!row) {
        throw new WorkResumeError(
          "INVALID_INPUT",
          `No registered work key ${workKey}; verifier result cannot be recorded.`,
        );
      }
      const effects: Record<string, Record<string, unknown>> = {};
      if (row.verifier_effects) {
        try {
          Object.assign(effects, JSON.parse(row.verifier_effects) as Record<string, Record<string, unknown>>);
        } catch {
          throw new WorkResumeError("MATERIAL_CONFLICT", "Stored verifier lineage is malformed; refusing to overwrite it.");
        }
      }
      const effectKey = typeof result.effectKey === "string" ? result.effectKey : undefined;
      if (effectKey) {
        const previous = effects[effectKey];
        const terminal = (value: Record<string, unknown> | undefined) =>
          value !== undefined && value.effectState !== "RUNNING";
        if (previous && terminal(previous) && terminal(result) && JSON.stringify(previous) !== JSON.stringify(result)) {
          throw new WorkResumeError("MATERIAL_CONFLICT", `Verifier effect ${effectKey} already has a terminal outcome.`);
        }
        if (!previous && Object.keys(effects).length >= 256) {
          throw new WorkResumeError("MATERIAL_CONFLICT", "Verifier lineage reached its 256-effect limit; refusing to discard evidence.");
        }
        effects[effectKey] = result;
      }
      this.sqlite.prepare(
        "update work_resume_registry set verifier_result=?, verifier_effects=?, updated_at=? where work_key=?",
      ).run(
        JSON.stringify(result),
        JSON.stringify(effects),
        new Date(this.now()).toISOString(),
        workKey,
      );
      return this.disposition(workKey);
    }).immediate();
  }

  /**
   * Attach the concrete effect-owner handle after the owner has durably created
   * it. Exact replay of the same handle is idempotent; conflicting handles fail
   * closed so a resumed controller never switches to a second worker silently.
   */
  bindEffectHandle(input: {
    workKey: string;
    effectKind: string;
    effectKey: string;
    effectHandle: string;
  }): WorkResumeStatus {
    bounded(input.workKey, "workKey");
    bounded(input.effectKind, "effectKind");
    bounded(input.effectKey, "effectKey");
    bounded(input.effectHandle, "effectHandle");

    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare(
        "select * from work_resume_registry where work_key=?",
      ).get(input.workKey) as RegistryRow | undefined;
      if (!row || row.effect_kind !== input.effectKind || row.effect_key !== input.effectKey) {
        throw new WorkResumeError(
          "MATERIAL_CONFLICT",
          "Effect handle does not match the durable effect identity bound to this work key.",
        );
      }
      if (row.effect_handle && row.effect_handle !== input.effectHandle) {
        throw new WorkResumeError(
          "MATERIAL_CONFLICT",
          "A different concrete effect handle is already bound to this work key.",
        );
      }
      if (!row.effect_handle) {
        this.sqlite.prepare(
          "update work_resume_registry set effect_handle=?, updated_at=? where work_key=?",
        ).run(
          input.effectHandle,
          new Date(this.now()).toISOString(),
          input.workKey,
        );
      }
      return this.disposition(input.workKey);
    }).immediate();
  }

  // ─── D. Writer admission ───────────────────────────────────────────────────

  /**
   * Re-read lease via assertHeld immediately before the first write effect.
   * Old owner after handoff/release/version drift fails before any provider
   * or process effect is initiated.
   */
  admitWriter(input: WriterAdmissionInput): WriterAdmissionReceipt {
    const row = this.sqlite.prepare(
      "select * from work_resume_registry where work_key=?",
    ).get(input.workKey) as RegistryRow | undefined;
    if (!row) {
      throw new WorkResumeError(
        "OWNERSHIP_CONFLICT",
        `No registered work key ${input.workKey}; writer not admitted.`,
      );
    }
    if (row.lease_id !== input.leaseId) {
      throw new WorkResumeError(
        "CAS_CONFLICT",
        `Registered lease id ${row.lease_id} differs from expected ${input.leaseId}; writer not admitted.`,
      );
    }
    // Re-read via ownership store's assertHeld for CAS + physical binding check
    const lease = this.ownership.assertHeld(
      input.ownerContext,
      input.leaseId,
      input.expectedLeaseVersion,
      WORKTREE_WRITER_OPERATION,
      input.baseRevision,
    );
    return {
      workKey: input.workKey,
      leaseId: lease.leaseId,
      admittedLeaseVersion: lease.version,
      operationHandle: lease.operationHandle,
    };
  }

  /**
   * Admit an exact replay of an already-pinned effect.
   *
   * The original pointer intentionally carries the pre-pin lease version. The
   * first beginOperation increments the canonical #62 lease by exactly one.
   * A replay is therefore accepted only when the current lease is exactly that
   * next version and still pins the same effect handle; all other drift fails.
   */
  admitPinnedReplay(
    input: WriterAdmissionInput & { effectHandle: string },
  ): WriterAdmissionReceipt {
    const row = this.sqlite.prepare(
      "select * from work_resume_registry where work_key=?",
    ).get(input.workKey) as RegistryRow | undefined;
    if (!row || row.lease_id !== input.leaseId) {
      throw new WorkResumeError(
        "CAS_CONFLICT",
        "Work key / lease binding changed before pinned replay.",
      );
    }
    const live = this.ownership.get(input.leaseId);
    if (
      !live ||
      live.version !== input.expectedLeaseVersion + 1 ||
      live.operation !== WORKTREE_WRITER_OPERATION ||
      live.baseRevision !== input.baseRevision ||
      live.operationState !== "active" ||
      live.operationHandle !== input.effectHandle ||
      live.terminalState
    ) {
      throw new WorkResumeError(
        "RECONCILE_REQUIRED",
        "Pinned replay no longer matches the exact durable effect identity.",
      );
    }
    const verified = this.ownership.assertHeld(
      input.ownerContext,
      input.leaseId,
      live.version,
      WORKTREE_WRITER_OPERATION,
      input.baseRevision,
    );
    return {
      workKey: input.workKey,
      leaseId: verified.leaseId,
      admittedLeaseVersion: verified.version,
      operationHandle: verified.operationHandle,
      replayedPinnedEffect: true,
    };
  }

  // ─── E. Effect pinning ─────────────────────────────────────────────────────

  /**
   * Pin the lease to an exact effect/operation handle using beginOperation.
   * Must be called immediately before a consequential writer effect.
   */
  pinEffect(
    ownerContext: unknown,
    workKey: string,
    leaseId: string,
    expectedLeaseVersion: number,
    operationHandle: string,
  ): ResourceLease {
    const row = this.sqlite.prepare(
      "select * from work_resume_registry where work_key=?",
    ).get(workKey) as RegistryRow | undefined;
    if (!row || row.lease_id !== leaseId) {
      throw new WorkResumeError(
        "CAS_CONFLICT",
        "Work key / lease binding changed before effect pin.",
      );
    }
    return this.ownership.beginOperation(
      ownerContext,
      leaseId,
      expectedLeaseVersion,
      operationHandle,
    );
  }

  /**
   * Finish the pinned operation on confirmed terminal effect.
   */
  finishEffect(
    ownerContext: unknown,
    leaseId: string,
    expectedLeaseVersion: number,
    operationHandle: string,
  ): ResourceLease {
    return this.ownership.finishOperation(
      ownerContext,
      leaseId,
      expectedLeaseVersion,
      operationHandle,
    );
  }

  /**
   * Close one exact bound effect after the caller independently proves that the
   * physical effect is terminal. This does not verify the effect itself; the
   * server-side reconciler must do that before calling here.
   */
  completeBoundEffect(
    ownerContext: unknown,
    workKey: string,
    expectedEffectKind: string,
    expectedEffectHandle: string,
  ): WorkResumeStatus {
    bounded(workKey, "workKey");
    bounded(expectedEffectKind, "effectKind");
    bounded(expectedEffectHandle, "effectHandle");

    const row = this.sqlite.prepare(
      "select * from work_resume_registry where work_key=?",
    ).get(workKey) as RegistryRow | undefined;
    if (!row || !row.effect_key || row.effect_kind !== expectedEffectKind || row.effect_handle !== expectedEffectHandle) {
      throw new WorkResumeError(
        "MATERIAL_CONFLICT",
        "Terminal effect proof does not match the durable work projection.",
      );
    }

    const live = this.ownership.get(row.lease_id);
    if (!live) {
      throw new WorkResumeError("CAS_CONFLICT", "Bound worktree lease is missing.");
    }
    if (live.terminalState) return this.disposition(workKey);
    if (live.operationHandle !== row.effect_key || live.operationState !== "active") {
      throw new WorkResumeError(
        "RECONCILE_REQUIRED",
        "Canonical lease is not pinned to the expected durable effect.",
      );
    }

    const finished = this.ownership.finishOperation(
      ownerContext,
      live.leaseId,
      live.version,
      row.effect_key,
    );
    this.ownership.release(ownerContext, finished.leaseId, finished.version);
    this.sqlite.prepare(
      "update work_resume_registry set updated_at=? where work_key=?",
    ).run(new Date(this.now()).toISOString(), workKey);
    return this.disposition(workKey);
  }

  /**
   * Store a terminal reconciliation receipt for this work key, then mark the
   * operation as finished in the ownership store.
   *
   * The local cache (work_resume_terminal_receipts) stores only receipt_id +
   * receipt_json as a read-only projection from the canonical #62 reconcile()
   * result.  It cannot outrank the canonical ownership store.
   */
  recordTerminalReceipt(
    ownerContext: unknown,
    workKey: string,
    leaseId: string,
    expectedLeaseVersion: number,
    evidence: Parameters<ControlPlaneOwnershipStore["reconcile"]>[3],
  ): ReconciliationReceipt {
    const row = this.sqlite.prepare(
      "select * from work_resume_registry where work_key=?",
    ).get(workKey) as RegistryRow | undefined;
    if (!row || row.lease_id !== leaseId) {
      throw new WorkResumeError(
        "CAS_CONFLICT",
        "Work key / lease binding changed before terminal receipt.",
      );
    }

    return this.sqlite.transaction(() => {
      // Canonical reconcile via #62 — this is the authoritative record.
      // reconcile() sets operationState='finished' and clears the handle, but
      // for non-expired leases it leaves terminalState=null.  We subsequently
      // call release() so that disposition() can classify the lease as TERMINAL
      // without requiring callers to perform a separate release step.
      const receipt = this.ownership.reconcile(
        ownerContext,
        leaseId,
        expectedLeaseVersion,
        evidence,
      );

      // Cache derived reference (receipt_id + receipt_json) for cheap replay.
      // Read-only projection only: cannot grant ownership or bypass lease checks.
      const existing = this.sqlite.prepare(
        "select * from work_resume_terminal_receipts where work_key=?",
      ).get(workKey) as TerminalReceiptRow | undefined;
      if (!existing) {
        this.sqlite.prepare(`
          insert into work_resume_terminal_receipts
            (work_key, receipt_id, receipt_json, recorded_at)
          values (?,?,?,?)
        `).run(
          workKey,
          receipt.receiptId,
          JSON.stringify(receipt),
          receipt.createdAt,
        );
      }

      // Release the lease so terminalState is set and disposition() returns TERMINAL.
      // reconcile() already cleared the operation handle; release() is safe here.
      // Only release if not already terminal (e.g. expired_reconciled already set it).
      const liveAfterReconcile = this.ownership.get(leaseId);
      if (liveAfterReconcile && !liveAfterReconcile.terminalState) {
        this.ownership.release(ownerContext, leaseId, receipt.newVersion);
      }

      // Update updated_at on registry
      this.sqlite.prepare(
        "update work_resume_registry set updated_at=? where work_key=?",
      ).run(new Date(this.now()).toISOString(), workKey);

      return receipt;
    }).immediate();
  }

  // ─── F. Dedup helpers ──────────────────────────────────────────────────────

  /**
   * Check if a work key has an active durable effect and suppress duplicate
   * dispatch.  Returns suppressed=true when RUNNING, TERMINAL, or
   * RECONCILE_REQUIRED; suppressed=false when the caller may proceed.
   */
  checkDuplicate(workKey: string): {
    suppressed: true;
    status: WorkResumeStatus;
  } | { suppressed: false } {
    const status = this.disposition(workKey);
    if (status.disposition === "NO_EXISTING_ATTEMPT") {
      return { suppressed: false };
    }
    return { suppressed: true, status };
  }

  // ─── Direct ownership delegate (read-only) ────────────────────────────────

  /** Read raw lease for observation. Never use this to admit a writer. */
  getLease(leaseId: string): ResourceLease | undefined {
    return this.ownership.get(leaseId);
  }
}

// ─── Helper domain functions ──────────────────────────────────────────────────

/**
 * Build a deterministic idempotency key for the underlying ownership-store
 * lease from the canonical work key.  The key is separate from the work key
 * itself so that the ownership store's unique constraint binds the physical
 * resource exclusively.
 */
export function leaseIdempotencyKeyForWork(workKey: string): string {
  return `wresume:${workKey}`;
}

/**
 * Build a canonical ResourceLeaseInput for acquiring the worktree writer lease
 * that backs a resumable work key.  Caller supplies trust-verified grant
 * evidence.
 */
export function buildWorktreeLeaseInput(
  workKey: string,
  material: WorkKeyMaterial,
  grant: GrantEvidenceReference,
  expiresAt: string,
): ResourceLeaseInput {
  const idempotencyKey = leaseIdempotencyKeyForWork(workKey);
  const scope = normalizeScope(material.writeScope, material.worktreeRealpath);
  return {
    repositoryKey: normalizeRepositoryKey(material.repositoryKey),
    resourceKind: "filesystem",
    resourceId: material.worktreeRealpath,
    resource: material.worktreeRealpath,
    operation: WORKTREE_WRITER_OPERATION,
    scope,
    baseRevision: material.baseRevisionSha,
    expiresAt,
    idempotencyKey,
    grant,
  };
}

// ─── Low-level helpers ────────────────────────────────────────────────────────

/** Normalise a path to forward-slash POSIX representation without stat. */
function posixNormalize(value: string): string {
  return posix.normalize(value.replaceAll("\\", "/"));
}

function bounded(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new WorkResumeError("INVALID_INPUT", `${field} is invalid`);
  }
  return value;
}

function normalizeRepositoryKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized)) {
    throw new WorkResumeError(
      "INVALID_INPUT",
      "repositoryKey must be canonical owner/repository",
    );
  }
  return normalized;
}

/**
 * Resolve a canonical physical realpath.
 * Production: realpathSync.native — fail CLOSED if path does not exist.
 * No lexical fallback; an unresolvable worktree path is an INVALID_INPUT.
 */
export function resolveCanonicalPath(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkResumeError("INVALID_INPUT", "worktreeRealpath is invalid");
  }
  try {
    return realpathSync.native(value).replaceAll("\\", "/");
  } catch {
    throw new WorkResumeError(
      "INVALID_INPUT",
      `worktreeRealpath cannot be resolved to a canonical physical path: ${value}`,
    );
  }
}

/**
 * Validate an exact 40-character lowercase Git SHA.
 * P0 requires exact 40-hex identity; shorter/longer hashes are invalid.
 */
function boundedSha(value: string): string {
  bounded(value, "baseRevisionSha");
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new WorkResumeError(
      "INVALID_INPUT",
      "baseRevisionSha must be an exact 40-character lowercase hex Git SHA",
    );
  }
  return value;
}

/**
 * Normalise and validate write-scope paths.
 * Each path must be absolute and must reside under the worktree root.
 * Escape from the worktree root (via .. or absolute paths outside) is
 * rejected unconditionally.
 */
function normalizeScope(scope: readonly string[], worktreeRoot: string): string[] {
  if (!Array.isArray(scope) || scope.length === 0 || scope.length > 512) {
    throw new WorkResumeError("INVALID_INPUT", "writeScope must be non-empty");
  }
  const root = worktreeRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  return [...new Set(scope.map((raw) => {
    bounded(raw, "scope path");
    const normalized = posix.normalize(raw.replaceAll("\\", "/"));
    if (!posix.isAbsolute(normalized)) {
      throw new WorkResumeError("INVALID_INPUT", `scope path must be absolute: ${raw}`);
    }
    // Reject escape from worktree root
    if (normalized !== root && !normalized.startsWith(`${root}/`)) {
      throw new WorkResumeError(
        "INVALID_INPUT",
        `scope path ${normalized} is not inside worktree root ${root}`,
      );
    }
    return normalized;
  }))].sort();
}

// ─── Re-exports ───────────────────────────────────────────────────────────────

export type { ResourceLease, GrantEvidenceReference, ReconciliationReceipt };
export { ControlPlaneOwnershipError };

// ─── Production factory ───────────────────────────────────────────────────────

/**
 * Production WorkResumeStore factory.
 *
 * Takes a shared SQLite instance. Production supplies ownershipOverride from
 * CarrierBindingStore so P0 uses the exact existing #62 owner/grant/CAS authority.
 * The local resolver path exists only for bounded test/injected fixtures.
 *
 * @param sqlite Shared better-sqlite3 instance (tables are already migrated).
 * @param resolveOwnerContext Fallback resolver for test/injected ownership only.
 * @param ownershipOverride Existing canonical #62 ownership store in production.
 */
export function createWorkResumeStore(
  sqlite: Database.Database,
  resolveOwnerContext: (context: unknown) => { ownerThread: string } | undefined,
  ownershipOverride?: ControlPlaneOwnershipStore,
): { store: WorkResumeStore; ownership: ControlPlaneOwnershipStore } {
  const ownership = ownershipOverride ?? new ControlPlaneOwnershipStore(sqlite, {
    resolveOwnerContext,
    resolveResourceIdentity: resolvePhysicalResource,
    verifyGrantEvidence: () => true,
    verifyReconciliationEvidence: () => true,
  });
  const store = new WorkResumeStore(sqlite, ownership);
  return { store, ownership };
}

/** Re-export resolvePhysicalResource for callers that need it. */
export { resolvePhysicalResource };
