/**
 * Bounded GitHub PR delivery primitive (#115 G0-G3 core milestone).
 *
 * This module turns an already accepted, already pushed Candidate into exactly
 * one recoverable PR-delivery effect. It is a composable primitive, not a
 * workflow engine: it knows nothing about Candidate acceptance, worker
 * selection, controller authority, CI acceptance, merge readiness, merge,
 * release, or deployment.
 *
 * Effect boundary: all GitHub contact flows through the injected
 * {@link GitHubPrEffectAdapter}. The adapter owns authentication privately;
 * credentials must never appear in arguments, results, logs, or receipts.
 * Tests must inject a fake adapter; this module never creates a real PR.
 *
 * Durability: every delivery attempt is bound to one durable operation in
 * {@link DurableOperationStore} (kind `github_pr_delivery`) before the first
 * possible write. Timeout / disconnect / 502 / lost acknowledgement never
 * implies the remote effect did not happen: ambiguous outcomes persist as
 * `OUTCOME_UNKNOWN` and must be reconciled against exact remote PR state
 * before any retry. Only a proven `CONFIRMED_NO_EFFECT` permits safe retry,
 * and retries reuse the same operation identity, never a new attempt.
 */

import {
  DurableOperationStore,
  durableOperationId,
  hashDurableRequest,
  type DurableOperationRecord,
} from "./durable-operations.js";

export const GITHUB_PR_DELIVERY_KIND = "github_pr_delivery" as const;
export const GITHUB_PR_DELIVERY_REQUEST_SCHEMA = "devspace.github_pr_delivery_request.v1" as const;
export const GITHUB_PR_DELIVERY_HOST = "github.com" as const;

const ATTEMPT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[^\s~^:?*[]+$/;

export interface GitHubPrDeliveryRequest {
  /** Canonical `owner/repo` identity on github.com. */
  repository: string;
  baseBranch: string;
  /** Exact expected base SHA (40 hex chars). */
  expectedBaseSha: string;
  candidateBranch: string;
  /** Exact expected candidate head SHA (40 hex chars). */
  expectedCandidateHeadSha: string;
  title: string;
  body: string;
  issueNumber?: number;
  /** Caller-chosen idempotency key, bound to one logical delivery effect. */
  attemptKey: string;
  /**
   * Absolute local clone path that scopes the durable operation. Attempt
   * identity is per-checkout; cross-checkout duplicates are prevented by the
   * remote exact-physical-match check, never by title or Issue similarity.
   */
  localRepoRoot: string;
  workspaceId?: string;
}

export interface NormalizedPrDeliveryRequest {
  repository: string;
  baseBranch: string;
  expectedBaseSha: string;
  candidateBranch: string;
  expectedCandidateHeadSha: string;
  title: string;
  body: string;
  issueNumber?: number;
  attemptKey: string;
  localRepoRoot: string;
  workspaceId?: string;
}

export interface GitHubPrRef {
  repository: string;
  number: number;
  url: string;
  headSha: string;
  baseSha: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  issueNumber?: number;
  state: "open" | "closed" | "merged";
}

export type GitHubPrPreflightStatus =
  | "GITHUB_PR_READY"
  | "GITHUB_AUTH_UNAVAILABLE"
  | "GITHUB_NETWORK_UNAVAILABLE"
  | "PR_WRITE_UNAVAILABLE"
  | "PR_READ_UNAVAILABLE"
  | "REPOSITORY_NOT_AUTHORIZED"
  | "CANDIDATE_IDENTITY_INVALID";

export interface GitHubPrDeliveryPreflight {
  status: GitHubPrPreflightStatus;
  /** Read success never proves write capability; always false here. */
  writeProven: false;
  writeState: "UNPROVEN";
  repository: string;
  baseBranch: string;
  candidateBranch: string;
  observedBaseSha?: string;
  observedCandidateHeadSha?: string;
  matchedExistingPr?: GitHubPrRef;
  detail: string;
}

export type GitHubPrDeliveryOutcome = "COMPLETED" | "FAILED" | "OUTCOME_UNKNOWN";
export type GitHubPrReconcileOutcome = "COMPLETED" | "CONFIRMED_NO_EFFECT" | "OUTCOME_UNKNOWN" | "FAILED";

export interface GitHubPrDeliveryResult {
  outcome: GitHubPrDeliveryOutcome;
  operation: DurableOperationRecord;
  pr?: GitHubPrRef;
}

export interface GitHubPrReconcileResult {
  outcome: GitHubPrReconcileOutcome;
  operation: DurableOperationRecord;
  pr?: GitHubPrRef;
}

export type GitHubPrEffectCode =
  | "EFFECT_AUTH_UNAVAILABLE"
  | "EFFECT_NETWORK_UNAVAILABLE"
  | "EFFECT_FORBIDDEN"
  | "EFFECT_NOT_FOUND"
  | "EFFECT_TRANSPORT_LOST"
  | "EFFECT_FAILED";

/**
 * Host-side transport failure. `effectPossiblyApplied` distinguishes a
 * definitive failure (safe to reason about, retry only when proven safe)
 * from a lost acknowledgement (must reconcile before any retry).
 */
export class GitHubPrEffectError extends Error {
  constructor(
    readonly code: GitHubPrEffectCode,
    readonly retryable: boolean,
    readonly effectPossiblyApplied: boolean,
    message: string,
  ) {
    super(message);
    this.name = "GitHubPrEffectError";
  }
}

export type GitHubPrDeliveryCode =
  | "CANDIDATE_IDENTITY_INVALID"
  | "REMOTE_IDENTITY_DRIFT"
  | "RECONCILIATION_REQUIRED"
  | "DELIVERY_OUTCOME_UNKNOWN"
  | "OPERATION_NOT_FOUND";

export class GitHubPrDeliveryError extends Error {
  constructor(
    readonly code: GitHubPrDeliveryCode,
    message: string,
    readonly retryable = false,
    readonly operation?: DurableOperationRecord,
  ) {
    super(message);
    this.name = "GitHubPrDeliveryError";
  }
}

/**
 * Bounded host-side GitHub effect boundary. Implementations own credentials
 * privately and must never surface them in arguments, results, or errors.
 * `describeWriteCapability` is advisory only: `unknown` is the honest
 * default because write capability cannot be proven without mutation.
 */
export interface GitHubPrEffectAdapter {
  readRepository(): Promise<{ name: string }>;
  readBranchHead(branch: string): Promise<{ sha: string } | { missing: true }>;
  listOpenPrs(input: { headBranch: string; baseBranch: string }): Promise<GitHubPrRef[]>;
  readPr(prNumber: number): Promise<GitHubPrRef>;
  createPr(input: {
    title: string;
    body: string;
    headBranch: string;
    baseBranch: string;
    issueNumber?: number;
  }): Promise<GitHubPrRef>;
  describeWriteCapability?(): "unknown" | "unavailable";
}

function normalizeRequest(request: GitHubPrDeliveryRequest): NormalizedPrDeliveryRequest {
  const fail = (detail: string): never => {
    throw new GitHubPrDeliveryError("CANDIDATE_IDENTITY_INVALID", `Invalid PR delivery request: ${detail}.`);
  };
  if (!request || typeof request !== "object") fail("request must be an object");
  const repository = request.repository?.trim() ?? "";
  if (!REPOSITORY_PATTERN.test(repository)) fail("repository must be canonical 'owner/repo' on github.com");
  const baseBranch = request.baseBranch?.trim() ?? "";
  const candidateBranch = request.candidateBranch?.trim() ?? "";
  if (!baseBranch || !BRANCH_PATTERN.test(baseBranch)) fail("baseBranch is invalid");
  if (!candidateBranch || !BRANCH_PATTERN.test(candidateBranch)) fail("candidateBranch is invalid");
  if (baseBranch === candidateBranch) fail("base and candidate branches must differ");
  const expectedBaseSha = request.expectedBaseSha?.trim().toLowerCase() ?? "";
  const expectedCandidateHeadSha = request.expectedCandidateHeadSha?.trim().toLowerCase() ?? "";
  if (!SHA_PATTERN.test(expectedBaseSha)) fail("expectedBaseSha must be an exact 40-character SHA");
  if (!SHA_PATTERN.test(expectedCandidateHeadSha)) fail("expectedCandidateHeadSha must be an exact 40-character SHA");
  const title = request.title?.trim() ?? "";
  if (!title) fail("title must be non-empty");
  const body = request.body ?? "";
  if (typeof body !== "string") fail("body must be a string");
  const issueNumber = request.issueNumber;
  if (issueNumber !== undefined && (!Number.isInteger(issueNumber) || issueNumber <= 0)) {
    fail("issueNumber must be a positive integer when present");
  }
  const attemptKey = request.attemptKey ?? "";
  if (!ATTEMPT_KEY_PATTERN.test(attemptKey)) fail("attemptKey must be 1-128 characters of letters, numbers, '.', '_', ':', '/', '-', or '-' prefixed alphanumerically");
  const localRepoRoot = request.localRepoRoot?.trim() ?? "";
  if (!localRepoRoot) fail("localRepoRoot must be a non-empty absolute clone path");
  return {
    repository: repository.toLowerCase(),
    baseBranch,
    expectedBaseSha,
    candidateBranch,
    expectedCandidateHeadSha,
    title,
    body,
    ...(issueNumber === undefined ? {} : { issueNumber }),
    attemptKey,
    localRepoRoot,
    ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
  };
}

/** Every field that changes the logical delivery effect participates. */
function materialRequestHash(request: NormalizedPrDeliveryRequest): string {
  return hashDurableRequest({
    repository: request.repository,
    baseBranch: request.baseBranch,
    expectedBaseSha: request.expectedBaseSha,
    candidateBranch: request.candidateBranch,
    expectedCandidateHeadSha: request.expectedCandidateHeadSha,
    title: request.title,
    body: request.body,
    issueNumber: request.issueNumber ?? null,
  });
}

function isEffectError(error: unknown): error is GitHubPrEffectError {
  return error instanceof GitHubPrEffectError;
}

/** Physical Candidate identity: exact SHAs plus exact branch binding. Never title or Issue similarity. */
function isExactPrMatch(ref: GitHubPrRef, request: NormalizedPrDeliveryRequest): boolean {
  return (
    ref.state === "open" &&
    ref.repository.toLowerCase() === request.repository &&
    ref.headBranch === request.candidateBranch &&
    ref.baseBranch === request.baseBranch &&
    ref.headSha.toLowerCase() === request.expectedCandidateHeadSha &&
    ref.baseSha.toLowerCase() === request.expectedBaseSha
  );
}

function receiptToRef(receipt: Record<string, unknown> | undefined): GitHubPrRef | undefined {
  if (!receipt || typeof receipt !== "object") return undefined;
  const record = receipt as Record<string, unknown>;
  if (
    typeof record.prNumber !== "number" ||
    typeof record.url !== "string" ||
    typeof record.headSha !== "string" ||
    typeof record.baseSha !== "string" ||
    typeof record.baseBranch !== "string" ||
    typeof record.headBranch !== "string" ||
    typeof record.title !== "string" ||
    typeof record.repository !== "string"
  ) {
    return undefined;
  }
  return {
    repository: record.repository,
    number: record.prNumber,
    url: record.url,
    headSha: record.headSha,
    baseSha: record.baseSha,
    baseBranch: record.baseBranch,
    headBranch: record.headBranch,
    title: record.title,
    ...(typeof record.issueNumber === "number" ? { issueNumber: record.issueNumber } : {}),
    state: "open",
  };
}

function prReceipt(request: NormalizedPrDeliveryRequest, ref: GitHubPrRef, matchedExisting: boolean): Record<string, unknown> {
  return {
    schema: GITHUB_PR_DELIVERY_REQUEST_SCHEMA,
    repository: request.repository,
    prNumber: ref.number,
    url: ref.url,
    headSha: ref.headSha,
    baseSha: ref.baseSha,
    baseBranch: ref.baseBranch,
    headBranch: ref.headBranch,
    title: ref.title,
    ...(ref.issueNumber === undefined && request.issueNumber === undefined
      ? {}
      : { issueNumber: ref.issueNumber ?? request.issueNumber ?? null }),
    ...(request.issueNumber === undefined ? {} : { requestedIssueNumber: request.issueNumber }),
    matchedExisting,
  };
}

/**
 * Effect-free delivery preflight. Reads only; never calls `createPr`.
 * A successful read surface never proves write capability.
 */
export async function preflightPrDelivery(
  adapter: GitHubPrEffectAdapter,
  request: GitHubPrDeliveryRequest,
): Promise<GitHubPrDeliveryPreflight> {
  const normalized = normalizeRequest(request);
  const base = (status: GitHubPrPreflightStatus, detail: string): GitHubPrDeliveryPreflight => ({
    status,
    writeProven: false,
    writeState: "UNPROVEN",
    repository: normalized.repository,
    baseBranch: normalized.baseBranch,
    candidateBranch: normalized.candidateBranch,
    detail,
  });
  try {
    await adapter.readRepository();
  } catch (error) {
    if (isEffectError(error)) {
      if (error.code === "EFFECT_AUTH_UNAVAILABLE") return base("GITHUB_AUTH_UNAVAILABLE", "GitHub credentials are unavailable for this delivery path.");
      if (error.code === "EFFECT_NETWORK_UNAVAILABLE") return base("GITHUB_NETWORK_UNAVAILABLE", "GitHub is unreachable from this delivery path.");
      return base("REPOSITORY_NOT_AUTHORIZED", "Repository is not authorized for this delivery path.");
    }
    return base("GITHUB_NETWORK_UNAVAILABLE", "Repository probe failed without attributable transport evidence.");
  }
  let observedBaseSha: string | undefined;
  let observedCandidateHeadSha: string | undefined;
  for (
    const [branch, expected, label] of [
      [normalized.baseBranch, normalized.expectedBaseSha, "base"],
      [normalized.candidateBranch, normalized.expectedCandidateHeadSha, "candidate"],
    ] as const
  ) {
    let head: { sha: string } | { missing: true };
    try {
      head = await adapter.readBranchHead(branch);
    } catch (error) {
      if (isEffectError(error) && error.code === "EFFECT_NETWORK_UNAVAILABLE") {
        return base("GITHUB_NETWORK_UNAVAILABLE", `Branch read failed for ${label} branch.`);
      }
      if (isEffectError(error) && error.code === "EFFECT_AUTH_UNAVAILABLE") {
        return base("GITHUB_AUTH_UNAVAILABLE", `Branch read failed for ${label} branch.`);
      }
      return base("CANDIDATE_IDENTITY_INVALID", `Branch read failed for ${label} branch without attributable evidence.`);
    }
    if ("missing" in head) {
      return base("CANDIDATE_IDENTITY_INVALID", `Exact ${label} branch '${branch}' is missing on the remote.`);
    }
    if (head.sha.toLowerCase() !== expected) {
      return base(
        "CANDIDATE_IDENTITY_INVALID",
        `Remote ${label} branch '${branch}' already drifted from the expected Candidate identity.`,
      );
    }
    if (label === "base") observedBaseSha = head.sha;
    else observedCandidateHeadSha = head.sha;
  }
  if (adapter.describeWriteCapability && adapter.describeWriteCapability() === "unavailable") {
    return {
      ...base("PR_WRITE_UNAVAILABLE", "Write capability is affirmatively unavailable on this delivery path."),
      observedBaseSha,
      observedCandidateHeadSha,
    };
  }
  let matchedExistingPr: GitHubPrRef | undefined;
  try {
    const open = await adapter.listOpenPrs({ headBranch: normalized.candidateBranch, baseBranch: normalized.baseBranch });
    matchedExistingPr = open.find((ref) => isExactPrMatch(ref, normalized));
  } catch (error) {
    if (isEffectError(error) && error.code === "EFFECT_NETWORK_UNAVAILABLE") {
      return base("GITHUB_NETWORK_UNAVAILABLE", "PR listing failed while checking for an existing exact PR.");
    }
    if (isEffectError(error) && error.code === "EFFECT_AUTH_UNAVAILABLE") {
      return base("GITHUB_AUTH_UNAVAILABLE", "PR listing failed while checking for an existing exact PR.");
    }
    return base("PR_READ_UNAVAILABLE", "PR listing failed without attributable transport evidence.");
  }
  return {
    ...base(
      "GITHUB_PR_READY",
      matchedExistingPr
        ? "Delivery lane reads succeed; an exact open PR already exists for this Candidate."
        : "Delivery lane reads succeed; write capability remains unproven without mutation.",
    ),
    observedBaseSha,
    observedCandidateHeadSha,
    ...(matchedExistingPr === undefined ? {} : { matchedExistingPr }),
  };
}

function failRecord(
  store: DurableOperationStore,
  operationId: string,
  errorCode: string,
  errorMessage: string,
  retrySafe: boolean,
): DurableOperationRecord {
  return store.finish(operationId, { status: "failed", retrySafe, errorCode, errorMessage });
}

/**
 * Run one bounded PR-delivery effect. Creates the durable operation before
 * the first possible write, revalidates exact remote identity immediately
 * before writing, and refuses on any drift with zero create calls.
 */
export async function runPrDeliveryEffect(
  store: DurableOperationStore,
  adapter: GitHubPrEffectAdapter,
  request: GitHubPrDeliveryRequest,
): Promise<GitHubPrDeliveryResult> {
  const normalized = normalizeRequest(request);
  const scopeRoot = normalized.localRepoRoot;
  const requestHash = materialRequestHash(normalized);
  const operationId = durableOperationId(GITHUB_PR_DELIVERY_KIND, scopeRoot, normalized.attemptKey);
  const { record: existing, created } = store.createOrReplay({
    operationId,
    attemptKey: normalized.attemptKey,
    requestHash,
    kind: GITHUB_PR_DELIVERY_KIND,
    authorityMode: "OWNER_DIRECT",
    scopeRoot,
    ...(normalized.workspaceId === undefined ? {} : { workspaceId: normalized.workspaceId }),
    request: {
      schema: GITHUB_PR_DELIVERY_REQUEST_SCHEMA,
      repository: normalized.repository,
      baseBranch: normalized.baseBranch,
      expectedBaseSha: normalized.expectedBaseSha,
      candidateBranch: normalized.candidateBranch,
      expectedCandidateHeadSha: normalized.expectedCandidateHeadSha,
      title: normalized.title,
      body: normalized.body,
      ...(normalized.issueNumber === undefined ? {} : { issueNumber: normalized.issueNumber }),
    },
  });
  if (!created) {
    if (existing.status === "succeeded") {
      return { outcome: "COMPLETED", operation: existing, pr: receiptToRef(existing.receipt) };
    }
    if (existing.status === "failed") {
      if (!existing.retrySafe) return { outcome: "FAILED", operation: existing };
      // Proven CONFIRMED_NO_EFFECT: same operation may safely act again.
    } else {
      // outcome_unknown / started: caller must reconcile explicitly first.
      return { outcome: "OUTCOME_UNKNOWN", operation: existing };
    }
  }

  const refuse = (errorCode: string, errorMessage: string, retrySafe: boolean): GitHubPrDeliveryResult => ({
    outcome: "FAILED",
    operation: failRecord(store, operationId, errorCode, errorMessage, retrySafe),
  });

  // Fresh remote revalidation immediately before any possible write.
  for (
    const [branch, expected, label] of [
      [normalized.baseBranch, normalized.expectedBaseSha, "base"],
      [normalized.candidateBranch, normalized.expectedCandidateHeadSha, "candidate"],
    ] as const
  ) {
    let head: { sha: string } | { missing: true };
    try {
      head = await adapter.readBranchHead(branch);
    } catch (error) {
      return refuse(
        "PRE_WRITE_TRANSPORT",
        `Remote ${label} branch could not be revalidated before write; refusing.`,
        true,
      );
    }
    if ("missing" in head) {
      return refuse("REMOTE_IDENTITY_DRIFT", `Remote ${label} branch '${branch}' is missing; refusing before write.`, false);
    }
    if (head.sha.toLowerCase() !== expected) {
      return refuse(
        "REMOTE_IDENTITY_DRIFT",
        `Remote ${label} branch '${branch}' drifted from the expected Candidate identity; refusing before write.`,
        false,
      );
    }
  }

  // Exact physical match first: never create a duplicate for the same Candidate.
  let listed: GitHubPrRef[];
  try {
    listed = await adapter.listOpenPrs({ headBranch: normalized.candidateBranch, baseBranch: normalized.baseBranch });
  } catch (error) {
    return refuse("PRE_WRITE_TRANSPORT", "Existing-PR check failed before write; refusing.", true);
  }
  const matched = listed.find((ref) => isExactPrMatch(ref, normalized));
  if (matched) {
    const operation = store.finish(operationId, {
      status: "succeeded",
      retrySafe: false,
      receipt: prReceipt(normalized, matched, true),
    });
    return { outcome: "COMPLETED", operation, pr: matched };
  }

  let created_ref: GitHubPrRef;
  try {
    created_ref = await adapter.createPr({
      title: normalized.title,
      body: normalized.body,
      headBranch: normalized.candidateBranch,
      baseBranch: normalized.baseBranch,
      ...(normalized.issueNumber === undefined ? {} : { issueNumber: normalized.issueNumber }),
    });
  } catch (error) {
    if (isEffectError(error) && error.effectPossiblyApplied) {
      const operation = store.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "RECONCILIATION_REQUIRED",
        errorMessage: "PR create acknowledgement was lost; the remote effect may have applied. Reconcile before any retry.",
      });
      return { outcome: "OUTCOME_UNKNOWN", operation };
    }
    const message = isEffectError(error) ? `PR create failed: ${error.code}.` : "PR create failed without attributable evidence.";
    return refuse("CREATE_FAILED", message, !isEffectError(error) || !error.effectPossiblyApplied);
  }

  // Exact readback of what was created; a mismatch is ambiguity, not success.
  let readback: GitHubPrRef;
  try {
    readback = await adapter.readPr(created_ref.number);
  } catch (error) {
    const operation = store.finish(operationId, {
      status: "outcome_unknown",
      retrySafe: false,
      errorCode: "RECONCILIATION_REQUIRED",
      errorMessage: "PR was created but exact readback failed; reconcile before any retry.",
      receipt: prReceipt(normalized, created_ref, false),
    });
    return { outcome: "OUTCOME_UNKNOWN", operation, pr: created_ref };
  }
  if (
    readback.headSha.toLowerCase() !== normalized.expectedCandidateHeadSha ||
    readback.baseSha.toLowerCase() !== normalized.expectedBaseSha
  ) {
    const operation = store.finish(operationId, {
      status: "outcome_unknown",
      retrySafe: false,
      errorCode: "RECONCILIATION_REQUIRED",
      errorMessage: "Created PR readback does not match the accepted Candidate identity; reconcile before any retry.",
      receipt: prReceipt(normalized, readback, false),
    });
    return { outcome: "OUTCOME_UNKNOWN", operation, pr: readback };
  }
  const operation = store.finish(operationId, {
    status: "succeeded",
    retrySafe: false,
    receipt: prReceipt(normalized, readback, false),
  });
  return { outcome: "COMPLETED", operation, pr: readback };
}

/**
 * Reconcile one logical delivery operation against exact remote PR state.
 * This path never creates a PR. Only a proven CONFIRMED_NO_EFFECT permits
 * a later safe retry through {@link runPrDeliveryEffect} on the same attempt.
 */
export async function reconcilePrDeliveryEffect(
  store: DurableOperationStore,
  adapter: GitHubPrEffectAdapter,
  scopeRoot: string,
  attemptKey: string,
): Promise<GitHubPrReconcileResult> {
  const existing = store.getByAttempt(scopeRoot, attemptKey);
  if (!existing || existing.kind !== GITHUB_PR_DELIVERY_KIND) {
    throw new GitHubPrDeliveryError("OPERATION_NOT_FOUND", `No PR delivery operation is bound to attempt '${attemptKey}'.`);
  }
  if (existing.status === "succeeded") {
    return { outcome: "COMPLETED", operation: existing, pr: receiptToRef(existing.receipt) };
  }
  if (existing.status === "failed" && !existing.retrySafe) {
    return { outcome: "FAILED", operation: existing };
  }
  let listed: GitHubPrRef[];
  try {
    const request = existing.request as unknown as {
      repository?: string;
      baseBranch?: string;
      expectedBaseSha?: string;
      candidateBranch?: string;
      expectedCandidateHeadSha?: string;
      title?: string;
      body?: string;
      issueNumber?: number;
    };
    const normalized = normalizeRequest({
      repository: typeof request.repository === "string" ? request.repository : "",
      baseBranch: typeof request.baseBranch === "string" ? request.baseBranch : "",
      expectedBaseSha: typeof request.expectedBaseSha === "string" ? request.expectedBaseSha : "",
      candidateBranch: typeof request.candidateBranch === "string" ? request.candidateBranch : "",
      expectedCandidateHeadSha: typeof request.expectedCandidateHeadSha === "string" ? request.expectedCandidateHeadSha : "",
      title: typeof request.title === "string" && request.title.trim() ? request.title : "reconcile",
      body: typeof request.body === "string" ? request.body : "",
      ...(typeof request.issueNumber === "number" ? { issueNumber: request.issueNumber } : {}),
      attemptKey: existing.attemptKey,
      localRepoRoot: existing.scopeRoot,
    });
    listed = await adapter.listOpenPrs({ headBranch: normalized.candidateBranch, baseBranch: normalized.baseBranch });
    const matched = listed.find((ref) => isExactPrMatch(ref, normalized));
    if (matched) {
      const operation = store.finish(existing.operationId, {
        status: "succeeded",
        retrySafe: false,
        receipt: prReceipt(normalized, matched, true),
      });
      return { outcome: "COMPLETED", operation, pr: matched };
    }
    const operation = store.finish(existing.operationId, {
      status: "failed",
      retrySafe: true,
      errorCode: "CONFIRMED_NO_EFFECT",
      errorMessage: "Reconciliation proved no exact PR exists for this delivery identity; safe retry is permitted on the same attempt.",
    });
    return { outcome: "CONFIRMED_NO_EFFECT", operation };
  } catch (error) {
    if (error instanceof GitHubPrDeliveryError) throw error;
    const operation = store.finish(existing.operationId, {
      status: "outcome_unknown",
      retrySafe: false,
      errorCode: "RECONCILIATION_REQUIRED",
      errorMessage: "Reconciliation could not prove remote PR state; the effect remains unknown.",
    });
    return { outcome: "OUTCOME_UNKNOWN", operation };
  }
}
