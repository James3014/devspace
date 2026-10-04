/**
 * Core Candidate Acquisition — Wave B / Issue-321 implementation.
 *
 * Responsibilities (DevSpace-owned):
 *   1. OPTIONAL backward-compatible verification profile binding (profile_id, verifier_ids,
 *      verifier_commands, timeout_seconds, profile_hash). Immutable once written.
 *   2. One DurableOperationKind "core_candidate_acquisition" per Candidate. Stable identity;
 *      exact replay reads back; conflicting replay fails closed; restart nonterminal → outcome_unknown.
 *   3. Durable shadow observation linked to session + Candidate + durable operation.
 *      Status, core_invoked, verdict/reason, receipt_hash, receipt_path, t_core_detection,
 *      orchestration_runtime_ms, missingness/error, request id/hash, profile hash, Core runtime.
 *   4. Candidate provenance durable first; observer written after / nonblocking.
 *      All observer outcomes (missing profile/runtime, launch error, REJECTED, parse errors)
 *      are durable observation outcomes — never worker/Candidate errors.
 *   5. Explicit Core runtime config. No PATH guessing or fallback.
 *      Missing/mismatch → CORE_RUNTIME_UNAVAILABLE_OR_MISMATCH (nonblocking).
 *   6. Census extension: shadow observation exposed alongside session + Candidate.
 *
 * Authority boundary: DevSpace owns local transport + durable reconciliation.
 * nexus-core remains sole Evidence Trust + Completion owner.
 * Verdict is shadow-only; never worker feedback or blocker.
 *
 * Exact nexus-core#77 contract:
 *   - CLI invocation: <executable> acquire --request - (stdin receives JSON)
 *   - Profile hash: canonical_hash({profile_id, verifier_id_command_pairs, timeout_seconds})
 *   - Request hash: canonical_hash of {acquisition_request_id, candidate_head, candidate_tree,
 *       expected_source_identity, expected_contract_hash, expected_profile_hash,
 *       expected_change_set_hash}
 *   - Result schema: nexus.core.candidate_acquisition_cli_result.v1
 *   - Result fields: status, core_verdict, core_reason_codes, acquisition_request_id,
 *       request_hash, reason_codes, receipt_hash, receipt_path, replayed, started_at,
 *       completed_at, orchestration_runtime_ms, core_response,
 *       authority="CORE_EVIDENCE_TRUST_COMPLETION_ONLY",
 *       claim_ceiling=[...no acceptance/merge/release/deploy...]
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { coreCanonicalJson, coreCanonicalHash } from "./core-mutation-session.js";
import type { DurableOperationStore } from "./durable-operations.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The schema name produced by nexus-core#77 CLI. */
export const NEXUS_CORE_CANDIDATE_ACQUISITION_CLI_RESULT_SCHEMA =
  "nexus.core.candidate_acquisition_cli_result.v1" as const;

/** The nexus-core source revision that produced the acquisition producer. */
export const NEXUS_CORE_ACQUISITION_PRODUCER_REVISION =
  "6c0cc48c9b3082470da40cb44697617de52b3988" as const;

/** The required authority field in a successful Core result. */
export const NEXUS_CORE_ACQUISITION_AUTHORITY = "CORE_EVIDENCE_TRUST_COMPLETION_ONLY" as const;

/** Minimum timeout_seconds for a verification profile. */
const PROFILE_TIMEOUT_MIN_SECONDS = 5;
/** Maximum timeout_seconds for a verification profile. */
const PROFILE_TIMEOUT_MAX_SECONDS = 3600;

/** Maximum size of Core CLI stdout+stderr accepted. */
const CORE_CLI_MAX_OUTPUT_BYTES = 512 * 1024;

/** Authority terms are unsafe unless the producer explicitly negates them. */
const AUTHORITY_CLAIM_TERMS = ["acceptance", "merge", "release", "deploy", "deployment", "routing"] as const;

// ---------------------------------------------------------------------------
// Types: Verification Profile
// ---------------------------------------------------------------------------

export interface CoreVerificationProfileVerifierEntry {
  verifier_id: string;
  argv: string[];
}

export interface CoreVerificationProfile {
  profile_id: string;
  verifier_id_command_pairs: CoreVerificationProfileVerifierEntry[];
  timeout_seconds: number;
  profile_hash: string;
}

// ---------------------------------------------------------------------------
// Types: Acquisition Observation
// ---------------------------------------------------------------------------

export type CoreCandidateAcquisitionStatus =
  | "PENDING"
  | "CORE_INVOKED"
  | "VERDICT_RECORDED"
  | "MISSINGNESS"
  | "ERROR";

/**
 * Core verdict vocabulary from nexus-core#77 producer.
 * VERIFIED and REJECTED are the known producer vocabulary.
 * Do NOT add ACCEPTED — that is forbidden per contract (nexus-core#77 produces
 * VERIFIED/REJECTED, not ACCEPTED; ACCEPTED is an acceptance lifecycle term).
 * The type includes a string fallback to handle any future producer extensions
 * without a DevSpace release, but ACCEPTED must never be synthesized by DevSpace.
 */
export type CoreCandidateAcquisitionVerdict = "VERIFIED" | "REJECTED" | (string & {});

export interface CoreCandidateAcquisitionObservation {
  operationId: string;
  durableOperationId: string;
  sessionId: string;
  candidateHead: string;
  candidateTree: string;
  sourceRevision: string;
  bindingHash: string;
  acceptanceContractHash: string;
  changeSetHash: string;
  profileHash: string | null;
  coreRuntimeIdentity: string | null;
  acquisitionStatus: CoreCandidateAcquisitionStatus;
  coreInvoked: boolean;
  coreVerdict: CoreCandidateAcquisitionVerdict | null;
  coreReason: string | null;
  receiptHash: string | null;
  receiptPath: string | null;
  tCoreDetection: string | null;
  orchestrationRuntimeMs: number | null;
  missingnessCode: string | null;
  missingnessDetail: string | null;
  acquisitionRequestId: string | null;
  requestHash: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Types: Core CLI result schema (from nexus-core#77 @ NEXUS_CORE_ACQUISITION_PRODUCER_REVISION)
// ---------------------------------------------------------------------------

/** Parsed successful Core CLI result (status="OK"). */
interface CoreAcquisitionCliResultOk {
  schema: typeof NEXUS_CORE_CANDIDATE_ACQUISITION_CLI_RESULT_SCHEMA;
  status: "OK";
  core_verdict: string;
  core_reason_codes: string[];
  acquisition_request_id: string;
  request_hash: string;
  reason_codes: string[];
  receipt_hash: string;
  receipt_path: string;
  replayed: boolean;
  started_at: string;
  completed_at: string;
  orchestration_runtime_ms: number;
  core_response: unknown;
  authority: typeof NEXUS_CORE_ACQUISITION_AUTHORITY;
  claim_ceiling: string[];
}

/** Parsed error Core CLI result (status="ERROR"). */
interface CoreAcquisitionCliResultError {
  schema: typeof NEXUS_CORE_CANDIDATE_ACQUISITION_CLI_RESULT_SCHEMA;
  status: "ERROR";
  reason_code?: string;
  detail?: string;
  acquisition_request_id?: string;
  request_hash?: string;
}

// ---------------------------------------------------------------------------
// Profile parsing and hashing
// ---------------------------------------------------------------------------

/**
 * Validate and compute the canonical profile hash.
 *
 * The hash covers: {profile_id, verifier_id_command_pairs (sorted by verifier_id), timeout_seconds}.
 * Exact keys enforced; non-empty argv; bounded timeout; verifier_ids must equal the AcceptanceContract
 * required_verifier_ids set exactly.
 *
 * Per nexus-core#77: profile hash = coreCanonicalHash({profile_id, verifier_id_command_pairs, timeout_seconds})
 * where verifier_id_command_pairs is [[verifier_id, [argv...]], ...] sorted by verifier_id.
 * There is NO "devspace.core-verification-profile.v1" prefix.
 */
export function parseCoreVerificationProfile(
  input: unknown,
  requiredVerifierIds: readonly string[],
): CoreVerificationProfile {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CoreCandidateAcquisitionError(
      "PROFILE_MALFORMED",
      "core.verification_profile must be a non-null object.",
    );
  }
  const obj = input as Record<string, unknown>;
  const allowedKeys = new Set(["profile_id", "verifier_ids", "verifier_commands", "timeout_seconds", "profile_hash"]);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new CoreCandidateAcquisitionError("PROFILE_MALFORMED", `Unexpected key in core.verification_profile: ${key}`);
    }
  }
  for (const key of allowedKeys) {
    if (!(key in obj)) {
      throw new CoreCandidateAcquisitionError("PROFILE_MALFORMED", `Missing key in core.verification_profile: ${key}`);
    }
  }

  const profileId = obj.profile_id;
  if (typeof profileId !== "string" || profileId.length === 0 || profileId !== profileId.trim() || profileId.includes("\0")) {
    throw new CoreCandidateAcquisitionError("PROFILE_MALFORMED", "core.verification_profile.profile_id must be non-empty normalized text.");
  }

  const verifierIds = obj.verifier_ids;
  if (!Array.isArray(verifierIds) || verifierIds.length === 0) {
    throw new CoreCandidateAcquisitionError("PROFILE_MALFORMED", "core.verification_profile.verifier_ids must be a non-empty array.");
  }
  for (const id of verifierIds) {
    if (typeof id !== "string" || id.length === 0 || id !== id.trim() || id.includes("\0")) {
      throw new CoreCandidateAcquisitionError("PROFILE_MALFORMED", "core.verification_profile.verifier_ids entries must be non-empty normalized strings.");
    }
  }
  if (new Set(verifierIds).size !== verifierIds.length) {
    throw new CoreCandidateAcquisitionError("PROFILE_MALFORMED", "core.verification_profile.verifier_ids must not contain duplicates.");
  }

  const verifierCommands = obj.verifier_commands;
  if (!Array.isArray(verifierCommands) || verifierCommands.length === 0) {
    throw new CoreCandidateAcquisitionError("PROFILE_MALFORMED", "core.verification_profile.verifier_commands must be a non-empty array.");
  }
  if (verifierCommands.length !== verifierIds.length) {
    throw new CoreCandidateAcquisitionError("PROFILE_MALFORMED", "core.verification_profile.verifier_commands must have the same length as verifier_ids.");
  }
  const pairs: CoreVerificationProfileVerifierEntry[] = [];
  for (let index = 0; index < verifierIds.length; index += 1) {
    const argv = verifierCommands[index];
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new CoreCandidateAcquisitionError("PROFILE_MALFORMED", `core.verification_profile.verifier_commands[${index}] must be a non-empty argv array.`);
    }
    for (const arg of argv) {
      if (typeof arg !== "string" || arg.trim().length === 0 || arg.includes("\0")) {
        throw new CoreCandidateAcquisitionError("PROFILE_MALFORMED", `core.verification_profile.verifier_commands[${index}] contains invalid argv entry.`);
      }
    }
    pairs.push({ verifier_id: verifierIds[index] as string, argv: argv as string[] });
  }

  const timeoutSeconds = obj.timeout_seconds;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < PROFILE_TIMEOUT_MIN_SECONDS ||
    timeoutSeconds > PROFILE_TIMEOUT_MAX_SECONDS
  ) {
    throw new CoreCandidateAcquisitionError(
      "PROFILE_MALFORMED",
      `core.verification_profile.timeout_seconds must be an integer between ${PROFILE_TIMEOUT_MIN_SECONDS} and ${PROFILE_TIMEOUT_MAX_SECONDS}.`,
    );
  }

  // Validate verifier_id set equals AcceptanceContract required_verifier_ids exactly.
  const profileIdSet = new Set(verifierIds as string[]);
  const requiredSet = new Set(requiredVerifierIds);
  const profileIdsSorted = [...profileIdSet].sort();
  const requiredSorted = [...requiredSet].sort();
  if (
    profileIdsSorted.length !== requiredSorted.length ||
    profileIdsSorted.some((id, i) => id !== requiredSorted[i])
  ) {
    throw new CoreCandidateAcquisitionError(
      "PROFILE_VERIFIER_SET_MISMATCH",
      "core.verification_profile.verifier_ids must equal the AcceptanceContract required_verifier_ids set exactly.",
    );
  }

  // Sort pairs by verifier_id for canonical hash.
  const sortedPairs = [...pairs].sort((a, b) => a.verifier_id.localeCompare(b.verifier_id));

  const computedHash = computeVerificationProfileHash(profileId, sortedPairs, timeoutSeconds);
  const suppliedHash = obj.profile_hash;
  if (typeof suppliedHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(suppliedHash)) {
    throw new CoreCandidateAcquisitionError("PROFILE_MALFORMED", "core.verification_profile.profile_hash must be sha256:<64 lowercase hex>.");
  }
  if (suppliedHash !== computedHash) {
    throw new CoreCandidateAcquisitionError(
      "PROFILE_HASH_MISMATCH",
      "core.verification_profile.profile_hash does not match canonical profile hash derivation.",
    );
  }

  return {
    profile_id: profileId,
    verifier_id_command_pairs: sortedPairs,
    timeout_seconds: timeoutSeconds,
    profile_hash: computedHash,
  };
}

/**
 * Compute the canonical Core profile hash.
 *
 * Per nexus-core#77: coreCanonicalHash of exactly:
 *   {
 *     "profile_id": profile_id,
 *     "verifier_id_command_pairs": [[verifier_id, [argv...]], ...] sorted by verifier_id,
 *     "timeout_seconds": timeout_seconds
 *   }
 *
 * There is NO "devspace.core-verification-profile.v1" prefix array.
 * coreCanonicalJson sorts object keys alphabetically, so the wire order is:
 *   profile_id, timeout_seconds, verifier_id_command_pairs.
 */
export function computeVerificationProfileHash(
  profileId: string,
  sortedPairs: CoreVerificationProfileVerifierEntry[],
  timeoutSeconds: number,
): string {
  return coreCanonicalHash({
    profile_id: profileId,
    timeout_seconds: timeoutSeconds,
    verifier_id_command_pairs: sortedPairs.map((pair) => [pair.verifier_id, pair.argv]),
  } as unknown as Parameters<typeof coreCanonicalHash>[0]);
}

// ---------------------------------------------------------------------------
// Stable acquisition operation identity
// ---------------------------------------------------------------------------

/**
 * Derive a stable durable operation identity for one Core candidate acquisition.
 *
 * Binds: sessionId, candidateHead, candidateTree, sourceRevision,
 *        acceptanceContractHash, profileHash (or "NO_PROFILE"), changeSetHash,
 *        coreRuntimeIdentity (or "NO_RUNTIME").
 */
export function computeAcquisitionOperationId(input: {
  sessionId: string;
  candidateHead: string;
  candidateTree: string;
  sourceRevision: string;
  acceptanceContractHash: string;
  profileHash: string | null;
  changeSetHash: string;
  coreRuntimeIdentity: string | null;
}): string {
  const canonical = coreCanonicalHash([
    "devspace.core-candidate-acquisition.v1",
    input.sessionId,
    input.candidateHead,
    input.candidateTree,
    input.sourceRevision,
    input.acceptanceContractHash,
    input.profileHash ?? "NO_PROFILE",
    input.changeSetHash,
    input.coreRuntimeIdentity ?? "NO_RUNTIME",
  ] as unknown as Parameters<typeof coreCanonicalHash>[0]);
  // Use a deterministic prefix derived from the canonical hash.
  return `cca_${canonical.replace("sha256:", "").slice(0, 32)}`;
}

/**
 * Compute the Core acquisition request_hash per nexus-core#77 contract.
 *
 * Canonical hash of exactly:
 *   {
 *     "acquisition_request_id": acquisition_request_id,
 *     "candidate_head": candidate_head,
 *     "candidate_tree": candidate_tree,
 *     "expected_source_identity": expected_source_identity,
 *     "expected_contract_hash": expected_contract_hash,
 *     "expected_profile_hash": expected_profile_hash,
 *     "expected_change_set_hash": expected_change_set_hash
 *   }
 */
export function computeAcquisitionRequestHash(request: {
  acquisition_request_id: string;
  candidate_head: string;
  candidate_tree: string;
  expected_source_identity: string;
  expected_contract_hash: string;
  expected_profile_hash: string | null;
  expected_change_set_hash: string;
}): string {
  return coreCanonicalHash(request as unknown as Parameters<typeof coreCanonicalHash>[0]);
}

/**
 * Compute the exact acquisition-scoped ChangeSet hash re-derived by nexus-core#77.
 *
 * This is intentionally NOT the DevSpace Candidate ChangeSet hash. The Core
 * acquisition producer uses an acquisition-scoped change_set_id and binds the
 * target tree rather than the Candidate commit:
 *
 *   [
 *     "acq-change-" + acquisition_request_id[:16],
 *     "git-commit:" + source_commit,
 *     "git-tree:" + candidate_tree,
 *     change_manifest_hash,
 *     sorted(paths),
 *     sorted(deleted_paths) // only when non-empty
 *   ]
 *
 * The conditional deleted-path item preserves nexus-core's legacy/no-deletion
 * compatibility rule.
 */
export function computeCoreAcquisitionChangeSetHash(input: {
  acquisitionRequestId: string;
  sourceIdentity: string;
  candidateTree: string;
  changeManifestHash: string;
  changedPaths: readonly string[];
  deletedPaths: readonly string[];
}): string {
  const canonical: unknown[] = [
    `acq-change-${input.acquisitionRequestId.slice(0, 16)}`,
    `git-commit:${input.sourceIdentity}`,
    `git-tree:${input.candidateTree}`,
    input.changeManifestHash,
    [...input.changedPaths].sort(),
  ];
  if (input.deletedPaths.length > 0) {
    canonical.push([...input.deletedPaths].sort());
  }
  return coreCanonicalHash(canonical as Parameters<typeof coreCanonicalHash>[0]);
}

// ---------------------------------------------------------------------------
// Core runtime identity
// ---------------------------------------------------------------------------

/**
 * Build the Core runtime identity string from the configured executable and digest.
 * Returns null if configuration is absent — triggers CORE_RUNTIME_UNAVAILABLE_OR_MISMATCH.
 */
export function buildCoreRuntimeIdentity(
  executable: string | undefined,
  runtimeDigest: string | undefined,
  sourceRevision: string | undefined = NEXUS_CORE_ACQUISITION_PRODUCER_REVISION,
): string | null {
  if (!executable || !runtimeDigest || !sourceRevision) return null;
  if (!isAbsolute(executable) || !/^sha256:[0-9a-f]{64}$/.test(runtimeDigest) || !/^[0-9a-f]{40}$/.test(sourceRevision)) {
    return null;
  }
  return `${executable}@${runtimeDigest}#source:${sourceRevision}`;
}

/**
 * Validate that the configured Core runtime matches the expected source revision
 * AND that the actual executable bytes hash matches the configured digest.
 *
 * Returns the runtime identity string on success, null if unavailable/mismatched.
 * Per REQ-5: partial config => unavailable; source revision mismatch => unavailable;
 * unreadable/not file/digest mismatch => CORE_RUNTIME_UNAVAILABLE_OR_MISMATCH.
 */
export async function validateCoreRuntimeConfig(config: {
  coreAcquisitionExecutable?: string;
  coreAcquisitionExpectedSourceRevision?: string;
  coreAcquisitionRuntimeDigest?: string;
}): Promise<{ identity: string; executable: string } | null> {
  const { coreAcquisitionExecutable, coreAcquisitionExpectedSourceRevision, coreAcquisitionRuntimeDigest } = config;
  // Partial config => unavailable.
  if (!coreAcquisitionExecutable || !coreAcquisitionExpectedSourceRevision || !coreAcquisitionRuntimeDigest) {
    return null;
  }
  // Source revision must exactly match the expected producer revision.
  if (coreAcquisitionExpectedSourceRevision !== NEXUS_CORE_ACQUISITION_PRODUCER_REVISION) {
    return null;
  }
  // Runtime binding is exact: absolute regular-file path, no symlink/realpath drift,
  // expected source revision, and exact executable bytes digest.
  if (!isAbsolute(coreAcquisitionExecutable) || !/^sha256:[0-9a-f]{64}$/.test(coreAcquisitionRuntimeDigest)) {
    return null;
  }
  let actualBytes: Buffer;
  try {
    const info = await lstat(coreAcquisitionExecutable);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    if ((await realpath(coreAcquisitionExecutable)) !== resolvePath(coreAcquisitionExecutable)) return null;
    actualBytes = await readFile(coreAcquisitionExecutable);
  } catch {
    return null;
  }
  const actualDigest = `sha256:${createHash("sha256").update(actualBytes).digest("hex")}`;
  if (actualDigest !== coreAcquisitionRuntimeDigest) {
    return null;
  }
  const identity = buildCoreRuntimeIdentity(
    coreAcquisitionExecutable,
    coreAcquisitionRuntimeDigest,
    coreAcquisitionExpectedSourceRevision,
  );
  if (!identity) return null;
  return { identity, executable: coreAcquisitionExecutable };
}

/**
 * Synchronous validation without file I/O (for tests / fast-path where bytes are pre-verified).
 * Validates config fields only (no file read).
 */
export function validateCoreRuntimeConfigSync(config: {
  coreAcquisitionExecutable?: string;
  coreAcquisitionExpectedSourceRevision?: string;
  coreAcquisitionRuntimeDigest?: string;
}): { identity: string; executable: string } | null {
  const { coreAcquisitionExecutable, coreAcquisitionExpectedSourceRevision, coreAcquisitionRuntimeDigest } = config;
  if (!coreAcquisitionExecutable || !coreAcquisitionExpectedSourceRevision || !coreAcquisitionRuntimeDigest) {
    return null;
  }
  if (coreAcquisitionExpectedSourceRevision !== NEXUS_CORE_ACQUISITION_PRODUCER_REVISION) {
    return null;
  }
  if (!isAbsolute(coreAcquisitionExecutable) || !/^sha256:[0-9a-f]{64}$/.test(coreAcquisitionRuntimeDigest)) {
    return null;
  }
  const identity = buildCoreRuntimeIdentity(
    coreAcquisitionExecutable,
    coreAcquisitionRuntimeDigest,
    coreAcquisitionExpectedSourceRevision,
  );
  if (!identity) return null;
  return { identity, executable: coreAcquisitionExecutable };
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class CoreCandidateAcquisitionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CoreCandidateAcquisitionError";
  }
}

// ---------------------------------------------------------------------------
// Acquisition observation store
// ---------------------------------------------------------------------------

function rowToObservation(row: Record<string, unknown>): CoreCandidateAcquisitionObservation {
  return {
    operationId: String(row.operation_id),
    durableOperationId: String(row.durable_operation_id),
    sessionId: String(row.session_id),
    candidateHead: String(row.candidate_head),
    candidateTree: String(row.candidate_tree),
    sourceRevision: String(row.source_revision),
    bindingHash: String(row.binding_hash),
    acceptanceContractHash: String(row.acceptance_contract_hash),
    changeSetHash: String(row.change_set_hash),
    profileHash: row.profile_hash != null ? String(row.profile_hash) : null,
    coreRuntimeIdentity: row.core_runtime_identity != null ? String(row.core_runtime_identity) : null,
    acquisitionStatus: String(row.acquisition_status) as CoreCandidateAcquisitionStatus,
    coreInvoked: row.core_invoked === 1 || row.core_invoked === true,
    coreVerdict: row.core_verdict != null ? String(row.core_verdict) as CoreCandidateAcquisitionVerdict : null,
    coreReason: row.core_reason != null ? String(row.core_reason) : null,
    receiptHash: row.receipt_hash != null ? String(row.receipt_hash) : null,
    receiptPath: row.receipt_path != null ? String(row.receipt_path) : null,
    tCoreDetection: row.t_core_detection != null ? String(row.t_core_detection) : null,
    orchestrationRuntimeMs: row.orchestration_runtime_ms != null ? Number(row.orchestration_runtime_ms) : null,
    missingnessCode: row.missingness_code != null ? String(row.missingness_code) : null,
    missingnessDetail: row.missingness_detail != null ? String(row.missingness_detail) : null,
    acquisitionRequestId: row.request_id != null ? String(row.request_id) : null,
    requestHash: row.request_hash != null ? String(row.request_hash) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class CoreCandidateAcquisitionObservationStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  close(): void {
    this.database.close();
  }

  getByOperationId(operationId: string): CoreCandidateAcquisitionObservation | undefined {
    const row = this.database.sqlite
      .prepare("select * from core_candidate_acquisition_observations where operation_id = ? limit 1")
      .get(operationId) as Record<string, unknown> | undefined;
    return row ? rowToObservation(row) : undefined;
  }

  getBySessionAndCandidate(sessionId: string, candidateHead: string): CoreCandidateAcquisitionObservation | undefined {
    const row = this.database.sqlite
      .prepare("select * from core_candidate_acquisition_observations where session_id = ? and candidate_head = ? limit 1")
      .get(sessionId, candidateHead) as Record<string, unknown> | undefined;
    return row ? rowToObservation(row) : undefined;
  }

  listByBinding(bindingHash: string, limit = 50): CoreCandidateAcquisitionObservation[] {
    const rows = this.database.sqlite
      .prepare("select * from core_candidate_acquisition_observations where binding_hash = ? order by created_at desc limit ?")
      .all(bindingHash, limit) as Record<string, unknown>[];
    return rows.map(rowToObservation);
  }

  /**
   * Create the initial PENDING observation row. Idempotent on exact replay.
   * Conflict on changed fields → throws ACQUISITION_REPLAY_CONFLICT.
   */
  createPending(input: {
    operationId: string;
    durableOperationId: string;
    sessionId: string;
    candidateHead: string;
    candidateTree: string;
    sourceRevision: string;
    bindingHash: string;
    acceptanceContractHash: string;
    changeSetHash: string;
    profileHash: string | null;
    coreRuntimeIdentity: string | null;
    acquisitionRequestId: string;
    requestHash: string;
    now?: Date;
  }): CoreCandidateAcquisitionObservation {
    const now = (input.now ?? new Date()).toISOString();
    const existing = this.getByOperationId(input.operationId);
    if (existing) {
      // Exact replay check.
      if (
        existing.durableOperationId !== input.durableOperationId ||
        existing.sessionId !== input.sessionId ||
        existing.candidateHead !== input.candidateHead ||
        existing.candidateTree !== input.candidateTree ||
        existing.sourceRevision !== input.sourceRevision ||
        existing.bindingHash !== input.bindingHash ||
        existing.acceptanceContractHash !== input.acceptanceContractHash ||
        existing.changeSetHash !== input.changeSetHash ||
        existing.profileHash !== input.profileHash ||
        existing.coreRuntimeIdentity !== input.coreRuntimeIdentity ||
        existing.acquisitionRequestId !== input.acquisitionRequestId ||
        existing.requestHash !== input.requestHash
      ) {
        throw new CoreCandidateAcquisitionError(
          "ACQUISITION_REPLAY_CONFLICT",
          `Acquisition observation ${input.operationId} is already bound to a different subject.`,
        );
      }
      return existing;
    }
    this.database.sqlite
      .prepare(`
        insert into core_candidate_acquisition_observations (
          operation_id, durable_operation_id, session_id, candidate_head, candidate_tree,
          source_revision, binding_hash, acceptance_contract_hash, change_set_hash,
          profile_hash, core_runtime_identity, acquisition_status, core_invoked,
          request_id, request_hash, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, ?, ?)
      `)
      .run(
        input.operationId,
        input.durableOperationId,
        input.sessionId,
        input.candidateHead,
        input.candidateTree,
        input.sourceRevision,
        input.bindingHash,
        input.acceptanceContractHash,
        input.changeSetHash,
        input.profileHash ?? null,
        input.coreRuntimeIdentity ?? null,
        input.acquisitionRequestId,
        input.requestHash,
        now,
        now,
      );
    return this.getByOperationId(input.operationId)!;
  }

  /** Update observation to CORE_INVOKED before spawning the Core CLI. */
  markCoreInvoked(operationId: string, now?: Date): void {
    const ts = (now ?? new Date()).toISOString();
    this.database.sqlite
      .prepare(`
        update core_candidate_acquisition_observations
        set acquisition_status = 'CORE_INVOKED', core_invoked = 1, updated_at = ?
        where operation_id = ? and acquisition_status = 'PENDING'
      `)
      .run(ts, operationId);
  }

  /** Record a successful verdict. */
  recordVerdict(input: {
    operationId: string;
    verdict: CoreCandidateAcquisitionVerdict;
    reason: string | null;
    receiptHash: string | null;
    receiptPath: string | null;
    tCoreDetection: string | null;
    orchestrationRuntimeMs: number | null;
    now?: Date;
  }): CoreCandidateAcquisitionObservation {
    const ts = (input.now ?? new Date()).toISOString();
    this.database.sqlite
      .prepare(`
        update core_candidate_acquisition_observations
        set acquisition_status = 'VERDICT_RECORDED', core_verdict = ?, core_reason = ?,
            receipt_hash = ?, receipt_path = ?, t_core_detection = ?, orchestration_runtime_ms = ?, updated_at = ?
        where operation_id = ?
      `)
      .run(
        input.verdict,
        input.reason ?? null,
        input.receiptHash ?? null,
        input.receiptPath ?? null,
        input.tCoreDetection ?? null,
        input.orchestrationRuntimeMs ?? null,
        ts,
        input.operationId,
      );
    return this.getByOperationId(input.operationId)!;
  }

  /** Record a missingness outcome (runtime unavailable, mismatch, profile missing, etc.). */
  recordMissingness(input: {
    operationId: string;
    missingnessCode: string;
    missingnessDetail: string;
    now?: Date;
  }): CoreCandidateAcquisitionObservation {
    const ts = (input.now ?? new Date()).toISOString();
    this.database.sqlite
      .prepare(`
        update core_candidate_acquisition_observations
        set acquisition_status = 'MISSINGNESS', missingness_code = ?, missingness_detail = ?, updated_at = ?
        where operation_id = ?
      `)
      .run(input.missingnessCode, input.missingnessDetail, ts, input.operationId);
    return this.getByOperationId(input.operationId)!;
  }

  /** Record a launch/parse error. */
  recordError(input: {
    operationId: string;
    missingnessCode: string;
    missingnessDetail: string;
    now?: Date;
  }): CoreCandidateAcquisitionObservation {
    const ts = (input.now ?? new Date()).toISOString();
    this.database.sqlite
      .prepare(`
        update core_candidate_acquisition_observations
        set acquisition_status = 'ERROR', missingness_code = ?, missingness_detail = ?, updated_at = ?
        where operation_id = ?
      `)
      .run(input.missingnessCode, input.missingnessDetail, ts, input.operationId);
    return this.getByOperationId(input.operationId)!;
  }
}

// ---------------------------------------------------------------------------
// Core CLI invocation
// ---------------------------------------------------------------------------

/**
 * Invoke the Core CLI and parse the result per nexus-core#77 contract.
 *
 * Exact invocation: <configured-absolute-executable> acquire --request -
 * JSON request document is sent to stdin.
 *
 * Returns the parsed result on success (status=OK), or a structured error on failure.
 * Never throws; all outcomes are durable observer outcomes.
 *
 * On status=ERROR from Core: this is an observer error (not a Core verdict).
 * On malformed/unparseable output: observer error.
 */
async function invokeCoreAcquireCli(input: {
  executable: string;
  requestPayload: Record<string, unknown>;
  timeoutMs: number;
}): Promise<
  | { ok: true; result: CoreAcquisitionCliResultOk }
  | { ok: false; errorCode: string; errorDetail: string }
> {
  const requestJson = coreCanonicalJson(input.requestPayload as unknown as Parameters<typeof coreCanonicalJson>[0]);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;

    const child = spawn(input.executable, ["acquire", "--request", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length + stderr.length > CORE_CLI_MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stdout.length + stderr.length > CORE_CLI_MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
      }
    });

    child.on("error", (err: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        errorCode: "CORE_LAUNCH_ERROR",
        errorDetail: `Core CLI process error: ${err.message.slice(0, 512)}`,
      });
    });

    child.on("close", (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (timedOut) {
        resolve({
          ok: false,
          errorCode: "CORE_LAUNCH_TIMEOUT",
          errorDetail: `Core CLI timed out after ${input.timeoutMs}ms.`,
        });
        return;
      }

      const output = stdout || stderr;
      let parsed: unknown;
      try {
        parsed = JSON.parse(output.trim());
      } catch {
        resolve({
          ok: false,
          errorCode: "CORE_RESULT_PARSE_ERROR",
          errorDetail: `Core CLI output is not valid JSON (exit ${code}). First 256 chars: ${output.slice(0, 256)}`,
        });
        return;
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        resolve({ ok: false, errorCode: "CORE_RESULT_SCHEMA_ERROR", errorDetail: "Core CLI result is not a JSON object." });
        return;
      }
      const obj = parsed as Record<string, unknown>;

      // Validate schema field.
      if (obj.schema !== NEXUS_CORE_CANDIDATE_ACQUISITION_CLI_RESULT_SCHEMA) {
        resolve({
          ok: false,
          errorCode: "CORE_RESULT_SCHEMA_MISMATCH",
          errorDetail: `Core CLI result schema is ${String(obj.schema)}, expected ${NEXUS_CORE_CANDIDATE_ACQUISITION_CLI_RESULT_SCHEMA}.`,
        });
        return;
      }

      // Core ERROR output: this is an observer error (not a verdict).
      if (obj.status === "ERROR") {
        resolve({
          ok: false,
          errorCode: "CORE_STATUS_ERROR",
          errorDetail: `Core CLI returned status=ERROR: reason_code=${String(obj.reason_code ?? "")}, detail=${String(obj.detail ?? "").slice(0, 256)}`,
        });
        return;
      }

      if (obj.status !== "OK") {
        resolve({
          ok: false,
          errorCode: "CORE_RESULT_STATUS_INVALID",
          errorDetail: `Core CLI result status must be OK or ERROR, got ${String(obj.status)}.`,
        });
        return;
      }

      // Validate authority field exactly.
      if (obj.authority !== NEXUS_CORE_ACQUISITION_AUTHORITY) {
        resolve({
          ok: false,
          errorCode: "CORE_RESULT_AUTHORITY_INVALID",
          errorDetail: `Core CLI result authority must be "${NEXUS_CORE_ACQUISITION_AUTHORITY}", got "${String(obj.authority)}".`,
        });
        return;
      }

      // Validate claim_ceiling semantically.  The pinned producer uses explicit
      // negations such as NO_ACCEPTANCE_AUTHORITY; substring matching would
      // incorrectly reject the legitimate Core result.
      const claimCeiling = obj.claim_ceiling;
      if (
        !Array.isArray(claimCeiling) ||
        claimCeiling.length === 0 ||
        claimCeiling.length > 32 ||
        claimCeiling.some((claim) => typeof claim !== "string" || claim.length === 0 || claim.length > 128)
      ) {
        resolve({
          ok: false,
          errorCode: "CORE_RESULT_CLAIM_CEILING_MISSING",
          errorDetail: "Core CLI result claim_ceiling must be a bounded non-empty string array.",
        });
        return;
      }
      for (const claim of claimCeiling as string[]) {
        const normalized = claim.toLowerCase().replace(/-/g, "_");
        const forbidden = AUTHORITY_CLAIM_TERMS.find(
          (term) => normalized.includes(term) && !normalized.includes(`no_${term}`),
        );
        if (forbidden) {
          resolve({
            ok: false,
            errorCode: "CORE_RESULT_CLAIM_CEILING_EXCEEDS",
            errorDetail: `Core CLI claim_ceiling implies forbidden authority: "${forbidden}".`,
          });
          return;
        }
      }

      // Validate bounded reason arrays before projecting them as evidence.
      for (const field of ["core_reason_codes", "reason_codes"] as const) {
        const value = obj[field];
        if (
          !Array.isArray(value) ||
          value.length > 128 ||
          value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 512)
        ) {
          resolve({
            ok: false,
            errorCode: "CORE_RESULT_REASON_CODES_INVALID",
            errorDetail: `Core CLI result ${field} must be a bounded string array.`,
          });
          return;
        }
      }

      // Validate required fields.
      if (typeof obj.acquisition_request_id !== "string" || obj.acquisition_request_id.length === 0) {
        resolve({ ok: false, errorCode: "CORE_RESULT_REQUEST_ID_MISSING", errorDetail: "Core CLI result missing acquisition_request_id." });
        return;
      }
      if (typeof obj.request_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(obj.request_hash)) {
        resolve({ ok: false, errorCode: "CORE_RESULT_REQUEST_HASH_INVALID", errorDetail: "Core CLI result missing or malformed request_hash." });
        return;
      }
      if (typeof obj.core_verdict !== "string" || obj.core_verdict.length === 0) {
        resolve({ ok: false, errorCode: "CORE_RESULT_VERDICT_MISSING", errorDetail: "Core CLI result missing core_verdict." });
        return;
      }
      if (typeof obj.receipt_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(obj.receipt_hash)) {
        resolve({ ok: false, errorCode: "CORE_RESULT_RECEIPT_HASH_INVALID", errorDetail: "Core CLI result missing or malformed receipt_hash." });
        return;
      }
      if (typeof obj.receipt_path !== "string" || obj.receipt_path.length === 0) {
        resolve({ ok: false, errorCode: "CORE_RESULT_RECEIPT_PATH_MISSING", errorDetail: "Core CLI result missing receipt_path." });
        return;
      }
      const configuredReceiptDirectory = input.requestPayload.receipt_directory;
      if (typeof configuredReceiptDirectory !== "string" || !isAbsolute(configuredReceiptDirectory)) {
        resolve({
          ok: false,
          errorCode: "CORE_RESULT_RECEIPT_PATH_INVALID",
          errorDetail: "Core request receipt_directory must be an absolute path.",
        });
        return;
      }
      const receiptRelative = relative(resolvePath(configuredReceiptDirectory), resolvePath(obj.receipt_path));
      if (
        receiptRelative === "" ||
        receiptRelative === ".." ||
        receiptRelative.startsWith("../") ||
        receiptRelative.startsWith("..\\") ||
        isAbsolute(receiptRelative)
      ) {
        resolve({
          ok: false,
          errorCode: "CORE_RESULT_RECEIPT_PATH_INVALID",
          errorDetail: "Core CLI receipt_path escapes the configured receipt directory.",
        });
        return;
      }

      resolve({
        ok: true,
        result: {
          schema: NEXUS_CORE_CANDIDATE_ACQUISITION_CLI_RESULT_SCHEMA,
          status: "OK",
          core_verdict: obj.core_verdict as string,
          core_reason_codes: Array.isArray(obj.core_reason_codes) ? (obj.core_reason_codes as string[]) : [],
          acquisition_request_id: obj.acquisition_request_id as string,
          request_hash: obj.request_hash as string,
          reason_codes: Array.isArray(obj.reason_codes) ? (obj.reason_codes as string[]) : [],
          receipt_hash: obj.receipt_hash as string,
          receipt_path: obj.receipt_path as string,
          replayed: obj.replayed === true,
          started_at: typeof obj.started_at === "string" ? obj.started_at : "",
          completed_at: typeof obj.completed_at === "string" ? obj.completed_at : "",
          orchestration_runtime_ms: typeof obj.orchestration_runtime_ms === "number" ? obj.orchestration_runtime_ms : 0,
          core_response: obj.core_response,
          authority: NEXUS_CORE_ACQUISITION_AUTHORITY,
          claim_ceiling: claimCeiling as string[],
        },
      });
    });

    // Write request JSON to stdin.
    child.stdin.write(requestJson, "utf8", (err: Error | null | undefined) => {
      if (err) {
        // stdin write error; process will likely fail anyway
      }
      child.stdin.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Main acquisition orchestrator
// ---------------------------------------------------------------------------

export interface CoreCandidateAcquisitionInput {
  /** Durable state directory (same as the main DevSpace store). */
  stateDir: string;
  /** The DurableOperationStore (pre-existing; must not be duplicated). */
  durableStore: DurableOperationStore;
  /** Session identifier. */
  sessionId: string;
  /** Candidate head commit SHA (40 hex). */
  candidateHead: string;
  /** Candidate tree SHA (40 hex). */
  candidateTree: string;
  /** Binding source revision (git-commit:...). */
  sourceRevision: string;
  /** Binding hash (sha256:...). */
  bindingHash: string;
  /** AcceptanceContract wire object (passed directly to Core CLI per nexus-core#77 contract). */
  acceptanceContract: Record<string, unknown>;
  /** AcceptanceContract hash (sha256:...). */
  acceptanceContractHash: string;
  /** DevSpace Candidate ChangeSet hash (sha256:...), retained for stable effect identity. */
  changeSetHash: string;
  /** Candidate change-manifest hash, used to reproduce nexus-core's acquisition ChangeSet hash. */
  changeManifestHash: string;
  /** Candidate paths from the durable physical manifest. */
  changedPaths: string[];
  /** Candidate deleted paths from the durable physical manifest. */
  deletedPaths: string[];
  /** Verification profile, or null if no profile was bound. */
  profile: CoreVerificationProfile | null;
  /** Synchronously bound runtime identity. Null = unavailable/mismatched config. */
  coreRuntime: { identity: string; executable: string } | null;
  /**
   * Optional physical runtime-validation config. Production supplies this so
   * executable bytes are re-read and hashed after durable intent is recorded,
   * but before Core is invoked. Tests may omit it when providing a preverified
   * fake runtime.
   */
  coreRuntimeValidationConfig?: {
    coreAcquisitionExecutable?: string;
    coreAcquisitionExpectedSourceRevision?: string;
    coreAcquisitionRuntimeDigest?: string;
  };
  /** Workspace scope root for DurableOperationStore. */
  scopeRoot: string;
  /** Dedicated absolute durable receipt directory; never the repository worktree. */
  receiptDirectory: string;
  /** Optional: override now for testing. */
  now?: Date;
  /**
   * Observation store (reuses same stateDir / database).
   * Caller must provide one rooted at the same stateDir.
   */
  observationStore: CoreCandidateAcquisitionObservationStore;
}

/**
 * Durably orchestrate one Core candidate acquisition.
 *
 * Contract:
 * - Candidate provenance must already be durable before calling this.
 * - This function is nonblocking: ALL outcomes (missing runtime, REJECTED, parse errors)
 *   are recorded as durable observer outcomes, never surfaced as errors to the caller.
 * - Exact replay (same operationId) reads back the existing record without spawning Core again.
 * - Conflicting replay (different request) fails closed with OPERATION_REPLAY_CONFLICT.
 * - Restart nonterminal → outcome_unknown/reconcile same effect; no blind rerun.
 *
 * Per nexus-core#77:
 * - CLI invocation: <executable> acquire --request - (stdin)
 * - Request top-level keys: candidate_head, candidate_tree, expected_source_identity,
 *     acceptance_contract, expected_contract_hash, verification_profile,
 *     expected_profile_hash, expected_change_set_hash, acquisition_request_id,
 *     request_hash, repo_path, receipt_directory
 * - No DevSpace session_id, binding_hash, core_runtime_identity, or unknown extra keys.
 */
export async function orchestrateCoreCandidateAcquisition(
  input: CoreCandidateAcquisitionInput,
): Promise<CoreCandidateAcquisitionObservation> {
  const now = input.now ?? new Date();
  const profileHash = input.profile?.profile_hash ?? null;
  const runtimeIdentity = input.coreRuntime?.identity ?? null;
  const sourceMatch = /^(?:git-commit:)?([0-9a-f]{40})$/.exec(input.sourceRevision);
  if (!sourceMatch) {
    throw new CoreCandidateAcquisitionError(
      "SOURCE_IDENTITY_INVALID",
      "sourceRevision must be a raw 40-hex SHA or git-commit:<40-hex>.",
    );
  }
  const sourceIdentity = sourceMatch[1]!;
  if (!isAbsolute(input.receiptDirectory)) {
    throw new CoreCandidateAcquisitionError(
      "RECEIPT_DIRECTORY_INVALID",
      "receiptDirectory must be an absolute path outside the repository worktree.",
    );
  }
  const receiptRelativeToRepo = relative(resolvePath(input.scopeRoot), resolvePath(input.receiptDirectory));
  if (
    receiptRelativeToRepo === "" ||
    (!receiptRelativeToRepo.startsWith("../") &&
      !receiptRelativeToRepo.startsWith("..\\") &&
      receiptRelativeToRepo !== "..")
  ) {
    throw new CoreCandidateAcquisitionError(
      "RECEIPT_DIRECTORY_INVALID",
      "receiptDirectory must not be inside the repository worktree.",
    );
  }

  const operationId = computeAcquisitionOperationId({
    sessionId: input.sessionId,
    candidateHead: input.candidateHead,
    candidateTree: input.candidateTree,
    sourceRevision: sourceIdentity,
    acceptanceContractHash: input.acceptanceContractHash,
    profileHash,
    changeSetHash: input.changeSetHash,
    coreRuntimeIdentity: runtimeIdentity,
  });

  // The Core request identity is deterministic for the exact durable effect.
  // This prevents a replay from manufacturing a different request_hash.
  const acquisitionRequestId = operationId;
  const coreAcquisitionChangeSetHash = computeCoreAcquisitionChangeSetHash({
    acquisitionRequestId,
    sourceIdentity,
    candidateTree: input.candidateTree,
    changeManifestHash: input.changeManifestHash,
    changedPaths: input.changedPaths,
    deletedPaths: input.deletedPaths,
  });
  const requestHash = computeAcquisitionRequestHash({
    acquisition_request_id: acquisitionRequestId,
    candidate_head: input.candidateHead,
    candidate_tree: input.candidateTree,
    expected_source_identity: sourceIdentity,
    expected_contract_hash: input.acceptanceContractHash,
    expected_profile_hash: profileHash,
    expected_change_set_hash: coreAcquisitionChangeSetHash,
  });
  const requestPayload: Record<string, unknown> = {
    candidate_head: input.candidateHead,
    candidate_tree: input.candidateTree,
    expected_source_identity: sourceIdentity,
    acceptance_contract: input.acceptanceContract,
    expected_contract_hash: input.acceptanceContractHash,
    verification_profile: input.profile
      ? {
          profile_id: input.profile.profile_id,
          verifier_ids: input.profile.verifier_id_command_pairs.map((pair) => pair.verifier_id),
          verifier_commands: input.profile.verifier_id_command_pairs.map((pair) => pair.argv),
          timeout_seconds: input.profile.timeout_seconds,
          profile_hash: profileHash,
        }
      : null,
    expected_profile_hash: profileHash,
    expected_change_set_hash: coreAcquisitionChangeSetHash,
    acquisition_request_id: acquisitionRequestId,
    request_hash: requestHash,
    repo_path: input.scopeRoot,
    receipt_directory: input.receiptDirectory,
  };

  // Durable effect identity and pending observation are created before the
  // first await.  Callers may therefore fire-and-forget this Promise without a
  // restart window that loses the prospective row.
  const durableResult = input.durableStore.createOrReplay({
    operationId,
    attemptKey: operationId,
    requestHash,
    kind: "core_candidate_acquisition",
    authorityMode: "OWNER_DIRECT",
    scopeRoot: input.scopeRoot,
    request: requestPayload,
  });
  const durableRecord = durableResult.record;
  const observation = input.observationStore.createPending({
    operationId,
    durableOperationId: durableRecord.operationId,
    sessionId: input.sessionId,
    candidateHead: input.candidateHead,
    candidateTree: input.candidateTree,
    sourceRevision: sourceIdentity,
    bindingHash: input.bindingHash,
    acceptanceContractHash: input.acceptanceContractHash,
    changeSetHash: input.changeSetHash,
    profileHash,
    coreRuntimeIdentity: runtimeIdentity,
    acquisitionRequestId,
    requestHash,
    now,
  });

  if (!durableResult.created) {
    const existing = input.observationStore.getByOperationId(operationId) ?? observation;
    if (durableRecord.status === "outcome_unknown") {
      return input.observationStore.recordMissingness({
        operationId,
        missingnessCode: "CORE_EFFECT_OUTCOME_UNKNOWN",
        missingnessDetail:
          "A prior Core acquisition effect is outcome-unknown; reconcile the exact persisted receipt/result before any retry.",
        now,
      });
    }
    return existing;
  }

  // A bound profile is required for a Core invocation.  Legacy sessions stay
  // admissible but produce explicit missingness.
  if (!input.profile) {
    const obs = input.observationStore.recordMissingness({
      operationId,
      missingnessCode: "PROFILE_NOT_BOUND",
      missingnessDetail: "No verification profile was bound at session open time; Core acquisition skipped.",
      now,
    });
    input.durableStore.finish(operationId, {
      status: "succeeded",
      retrySafe: false,
      receipt: { acquisitionStatus: "MISSINGNESS", missingnessCode: "PROFILE_NOT_BOUND" },
    });
    return obs;
  }

  if (!input.coreRuntime) {
    const obs = input.observationStore.recordMissingness({
      operationId,
      missingnessCode: "CORE_RUNTIME_UNAVAILABLE_OR_MISMATCH",
      missingnessDetail: "Core acquisition runtime binding is incomplete or mismatched.",
      now,
    });
    input.durableStore.finish(operationId, {
      status: "succeeded",
      retrySafe: false,
      receipt: {
        acquisitionStatus: "MISSINGNESS",
        missingnessCode: "CORE_RUNTIME_UNAVAILABLE_OR_MISMATCH",
      },
    });
    return obs;
  }

  // Physical runtime verification is deliberately after the durable effect
  // identity exists and before the executable is spawned.
  const verifiedRuntime = input.coreRuntimeValidationConfig
    ? await validateCoreRuntimeConfig(input.coreRuntimeValidationConfig)
    : input.coreRuntime;
  if (!verifiedRuntime || verifiedRuntime.identity !== input.coreRuntime.identity) {
    const obs = input.observationStore.recordMissingness({
      operationId,
      missingnessCode: "CORE_RUNTIME_UNAVAILABLE_OR_MISMATCH",
      missingnessDetail: "Core executable bytes/path/source identity do not match the bound runtime.",
      now,
    });
    input.durableStore.finish(operationId, {
      status: "succeeded",
      retrySafe: false,
      receipt: {
        acquisitionStatus: "MISSINGNESS",
        missingnessCode: "CORE_RUNTIME_UNAVAILABLE_OR_MISMATCH",
      },
    });
    return obs;
  }

  input.observationStore.markCoreInvoked(operationId, now);
  const timeoutMs = input.profile.timeout_seconds * 1000;
  const cliResult = await invokeCoreAcquireCli({
    executable: verifiedRuntime.executable,
    requestPayload,
    timeoutMs,
  });

  if (!cliResult.ok) {
    if (cliResult.errorCode === "CORE_LAUNCH_TIMEOUT") {
      const obs = input.observationStore.recordMissingness({
        operationId,
        missingnessCode: "CORE_EFFECT_OUTCOME_UNKNOWN",
        missingnessDetail:
          "Core acquisition timed out after process launch; reconcile the exact receipt/result before any retry.",
        now,
      });
      input.durableStore.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "RECONCILIATION_REQUIRED",
        errorMessage: cliResult.errorDetail,
        receipt: {
          acquisitionStatus: "MISSINGNESS",
          missingnessCode: "CORE_EFFECT_OUTCOME_UNKNOWN",
        },
      });
      return obs;
    }
    const obs = input.observationStore.recordError({
      operationId,
      missingnessCode: cliResult.errorCode,
      missingnessDetail: cliResult.errorDetail,
      now,
    });
    input.durableStore.finish(operationId, {
      status: "failed",
      retrySafe: false,
      errorCode: cliResult.errorCode,
      errorMessage: cliResult.errorDetail,
      receipt: {
        acquisitionStatus: "ERROR",
        missingnessCode: cliResult.errorCode,
      },
    });
    return obs;
  }

  const parsed = cliResult.result;

  // Validate that acquisition_request_id and request_hash match exactly what was sent.
  if (parsed.acquisition_request_id !== acquisitionRequestId) {
    const obs = input.observationStore.recordError({
      operationId,
      missingnessCode: "CORE_RESULT_REQUEST_ID_MISMATCH",
      missingnessDetail: `Core CLI acquisition_request_id ${parsed.acquisition_request_id} does not match sent ${acquisitionRequestId}.`,
      now,
    });
    input.durableStore.finish(operationId, {
      status: "failed",
      retrySafe: false,
      errorCode: "CORE_RESULT_REQUEST_ID_MISMATCH",
      errorMessage: obs.missingnessDetail ?? "Core result request identity mismatch.",
      receipt: { acquisitionStatus: "ERROR", missingnessCode: "CORE_RESULT_REQUEST_ID_MISMATCH" },
    });
    return obs;
  }
  if (parsed.request_hash !== requestHash) {
    const obs = input.observationStore.recordError({
      operationId,
      missingnessCode: "CORE_RESULT_REQUEST_HASH_MISMATCH",
      missingnessDetail: `Core CLI request_hash does not match sent request_hash.`,
      now,
    });
    input.durableStore.finish(operationId, {
      status: "failed",
      retrySafe: false,
      errorCode: "CORE_RESULT_REQUEST_HASH_MISMATCH",
      errorMessage: obs.missingnessDetail ?? "Core result request hash mismatch.",
      receipt: { acquisitionStatus: "ERROR", missingnessCode: "CORE_RESULT_REQUEST_HASH_MISMATCH" },
    });
    return obs;
  }

  // Record the verdict (could be VERIFIED, REJECTED, or any producer vocabulary).
  // A successful Core verdict with no reason codes still has an explicit
  // reason observation for G2 terminal completeness; null means unobserved.
  const reasonSummary = parsed.core_reason_codes.length > 0
    ? parsed.core_reason_codes.join(",")
    : "NO_REASON_CODES";
  const obs = input.observationStore.recordVerdict({
    operationId,
    verdict: parsed.core_verdict as CoreCandidateAcquisitionVerdict,
    reason: reasonSummary,
    receiptHash: parsed.receipt_hash,
    receiptPath: parsed.receipt_path,
    tCoreDetection: parsed.started_at || null,
    orchestrationRuntimeMs: parsed.orchestration_runtime_ms,
    now,
  });
  input.durableStore.finish(operationId, {
    status: "succeeded",
    retrySafe: false,
    receipt: {
      acquisitionStatus: "VERDICT_RECORDED",
      verdict: parsed.core_verdict,
    },
  });
  return obs;
}
