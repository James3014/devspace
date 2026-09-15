import type { DurableOperationRecord } from "./durable-operations.js";

/**
 * #115 G4 controller-visible delivery lifecycle projection.
 *
 * Canonical persistent truth is `DurableOperationStore`. This module is a
 * PURE deterministic projection: it accepts an already-fetched
 * `DurableOperationRecord` and returns a controller-facing state. It never
 * opens or writes a database, never calls GitHub, never spawns git/gh,
 * never mutates the store, never reconciles, never retries, never creates
 * a PR, and never updates a receipt.
 *
 * Dependency direction: this module reads `DurableOperationRecord` /
 * G0-G3 receipts. `github-pr-delivery.ts` must never import this module.
 *
 * G4/G5 boundary: this projection performs no fresh remote read. A
 * `succeeded` operation carrying a structurally valid exact receipt is a
 * historical delivery fact (`PR_DELIVERED`). Whether the PR is still open,
 * whether head/base still match, checks, CI terminal state, mergeability,
 * `CI_GREEN` / `CI_FAILED` / `MERGE_READY` are G5 responsibilities and are
 * never emitted here.
 */

export const GITHUB_PR_DELIVERY_OPERATION_KIND = "github_pr_delivery" as const;

/** Canonical G0-G3 delivery receipt schema; mirrored from `github-pr-delivery.ts`. */
export const GITHUB_PR_DELIVERY_RECEIPT_SCHEMA = "devspace.github_pr_delivery_request.v1" as const;

export type PrDeliveryLifecycleState =
  | "PR_DELIVERY_PREPARED"
  | "PR_DELIVERY_IN_FLIGHT"
  | "PR_DELIVERED"
  | "PR_DELIVERY_RECONCILE_REQUIRED"
  | "PR_DELIVERY_BLOCKED";

export type PrDeliveryReceiptGap =
  | "DELIVERY_RECEIPT_MISSING"
  | "DELIVERY_RECEIPT_MALFORMED"
  | "DELIVERY_RECEIPT_IDENTITY_MISMATCH";

export interface PrDeliveryPrRef {
  repository: string;
  prNumber: number;
  url: string;
  headSha: string;
  baseSha: string;
  baseBranch: string;
  headBranch: string;
}

export interface PrDeliveryLifecycleProjection {
  operationId: string;
  attemptKey: string;
  state: PrDeliveryLifecycleState;
  retrySafe: boolean;
  errorCode?: string;
  /** Typed gap explaining BLOCKED / RECONCILE_REQUIRED; absent for clean states. */
  gap?: string;
  /** Present only for PR_DELIVERED. */
  pr?: PrDeliveryPrRef;
}

export type PrDeliveryLifecycleErrorCode = "WRONG_OPERATION_KIND";

export class PrDeliveryLifecycleError extends Error {
  constructor(
    readonly code: PrDeliveryLifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PrDeliveryLifecycleError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Validate that a `succeeded` receipt structurally contains the exact PR
 * delivery identity AND cross-check its physical identity against the
 * durable `operation.request` (repository, expectedBaseSha,
 * expectedCandidateHeadSha, baseBranch, candidateBranch).
 *
 * Returns the bound PR ref on success, or a typed gap on any failure.
 * Callers fail closed to PR_DELIVERY_RECONCILE_REQUIRED.
 */
function bindExactReceipt(
  operation: DurableOperationRecord,
): { pr: PrDeliveryPrRef } | { gap: PrDeliveryReceiptGap } {
  const receipt = operation.receipt;
  if (receipt === undefined || receipt === null) return { gap: "DELIVERY_RECEIPT_MISSING" };
  if (!isRecord(receipt)) return { gap: "DELIVERY_RECEIPT_MALFORMED" };

  const prNumber = receipt.prNumber;
  const repository = asNonEmptyString(receipt.repository);
  const url = asNonEmptyString(receipt.url);
  const headSha = asNonEmptyString(receipt.headSha);
  const baseSha = asNonEmptyString(receipt.baseSha);
  const baseBranch = asNonEmptyString(receipt.baseBranch);
  const headBranch = asNonEmptyString(receipt.headBranch);
  if (
    receipt.schema !== GITHUB_PR_DELIVERY_RECEIPT_SCHEMA ||
    typeof prNumber !== "number" ||
    !Number.isSafeInteger(prNumber) ||
    repository === undefined ||
    url === undefined ||
    headSha === undefined ||
    baseSha === undefined ||
    baseBranch === undefined ||
    headBranch === undefined
  ) {
    return { gap: "DELIVERY_RECEIPT_MALFORMED" };
  }

  const request = operation.request;
  if (!isRecord(request)) return { gap: "DELIVERY_RECEIPT_IDENTITY_MISMATCH" };
  const reqRepository = asNonEmptyString(request.repository);
  const reqBaseBranch = asNonEmptyString(request.baseBranch);
  const reqExpectedBaseSha = asNonEmptyString(request.expectedBaseSha);
  const reqCandidateBranch = asNonEmptyString(request.candidateBranch);
  const reqExpectedHeadSha = asNonEmptyString(request.expectedCandidateHeadSha);
  if (
    reqRepository === undefined ||
    reqBaseBranch === undefined ||
    reqExpectedBaseSha === undefined ||
    reqCandidateBranch === undefined ||
    reqExpectedHeadSha === undefined
  ) {
    return { gap: "DELIVERY_RECEIPT_IDENTITY_MISMATCH" };
  }

  // SHA and repository comparisons are case-insensitive, matching G0-G3
  // exact-match semantics; branch bindings are exact.
  if (
    repository.toLowerCase() !== reqRepository.toLowerCase() ||
    headSha.toLowerCase() !== reqExpectedHeadSha.toLowerCase() ||
    baseSha.toLowerCase() !== reqExpectedBaseSha.toLowerCase() ||
    baseBranch !== reqBaseBranch ||
    headBranch !== reqCandidateBranch
  ) {
    return { gap: "DELIVERY_RECEIPT_IDENTITY_MISMATCH" };
  }

  return {
    pr: { repository, prNumber, url, headSha, baseSha, baseBranch, headBranch },
  };
}

/**
 * Project one already-fetched durable `github_pr_delivery` operation record
 * to its controller-visible G4 lifecycle state. Pure: no I/O, no mutation;
 * the input record is never modified.
 */
export function projectPrDeliveryLifecycle(
  operation: DurableOperationRecord,
): PrDeliveryLifecycleProjection {
  if (operation.kind !== GITHUB_PR_DELIVERY_OPERATION_KIND) {
    throw new PrDeliveryLifecycleError(
      "WRONG_OPERATION_KIND",
      `pr_delivery_lifecycle_read only projects '${GITHUB_PR_DELIVERY_OPERATION_KIND}' operations, got '${operation.kind}'.`,
    );
  }

  const base = {
    operationId: operation.operationId,
    attemptKey: operation.attemptKey,
    retrySafe: operation.retrySafe,
    ...(operation.errorCode === undefined ? {} : { errorCode: operation.errorCode }),
  };

  switch (operation.status) {
    case "started":
      // The live process only knows the logical operation entered a
      // non-terminal delivery path. Never claim a remote create happened.
      return { ...base, state: "PR_DELIVERY_IN_FLIGHT" };
    case "outcome_unknown":
      // Strong invariant: unknown outcomes reconcile, never masquerade as
      // in-flight progress and never reset to prepared.
      return { ...base, state: "PR_DELIVERY_RECONCILE_REQUIRED" };
    case "failed":
      if (operation.retrySafe) {
        // Proven no-effect / pre-write failure: the same logical operation
        // may safely be attempted again. errorCode/retrySafe/operationId are
        // preserved so the controller knows this is not a new attempt.
        return { ...base, state: "PR_DELIVERY_PREPARED" };
      }
      // Non-retryable failure (definitive refusal such as
      // REMOTE_IDENTITY_DRIFT, or any other failed/retrySafe=false state):
      // the store forbids replay, so BLOCKED — never RECONCILE_REQUIRED,
      // because there is no remote-effect ambiguity left to reconcile.
      return {
        ...base,
        state: "PR_DELIVERY_BLOCKED",
        gap: operation.errorCode ?? "DELIVERY_FAILED_NON_RETRYABLE",
      };
    case "succeeded": {
      const bound = bindExactReceipt(operation);
      if ("gap" in bound) {
        return { ...base, state: "PR_DELIVERY_RECONCILE_REQUIRED", gap: bound.gap };
      }
      return { ...base, state: "PR_DELIVERED", pr: bound.pr };
    }
  }
}
