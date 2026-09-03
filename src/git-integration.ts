import { execFile } from "node:child_process";
import { isAbsolute, relative, sep } from "node:path";
import { canonicalizePath } from "./roots.js";
import type { CapabilityManifest } from "./capability-manifest.js";

/**
 * Typed integration primitive for one accepted, IMMUTABLE Candidate range.
 *
 * The Candidate boundary is a committed Git range:
 *
 *   candidateBase .. candidateHead
 *
 * Both identities are exact 40-character hex commit SHAs supplied by the
 * accepting authority. Mutable or ref-shaped values ("HEAD", "main",
 * "candidate/foo", "HEAD~1", "refs/heads/x") are rejected fail-closed, and a
 * supplied SHA must resolve to exactly itself in the source repository. The
 * integration payload is derived entirely from those frozen SHAs; nothing
 * from the source worktree's current dirty or untracked state can enter the
 * payload, so execution metadata (e.g. `.devspace/`) can never leak into a
 * destination.
 *
 * This module never pushes, merges, or releases, and never invents acceptance:
 * Owner acceptance stays external and readiness always reports it as not
 * granted here. Every deterministic gate runs before the first destination
 * mutation, so a rejected integration leaves the destination byte-identical.
 * `git apply` without --reject is patch-atomic (never a partial patch), but it
 * does NOT provide mutual exclusion: external mutation after the final re-fence
 * is not excluded and compatible concurrent edits may coexist with a successful
 * apply.
 */

export type DirtyPolicy = "allow_unrelated" | "pristine";

export interface CandidateRangeIdentity {
  /** Source workspace that produced the accepted Candidate commits. */
  sourceWorkspaceRoot: string;
  /**
   * Exact base SHA of the accepted Candidate range. Typically the source HEAD
   * at acceptance time; must be an ancestor of candidateHead.
   */
  candidateBase: string;
  /** Exact head SHA of the accepted Candidate range. */
  candidateHead: string;
  /** Destination checkout that should receive the Candidate range. */
  destinationWorkspaceRoot: string;
  /** Exact HEAD the destination must currently be at. Required; no guessing. */
  expectedDestinationHead: string;
  /** Refuse any destination dirtiness ("pristine") or only overlapping paths (default). */
  dirtyPolicy?: DirtyPolicy;
}

export interface IntegrationBlocker {
  code:
    | "SOURCE_DESTINATION_ALIAS"
    | "CANDIDATE_IDENTITY_NOT_IMMUTABLE"
    | "CANDIDATE_COMMIT_MISSING"
    | "CANDIDATE_BASE_INVALID"
    | "CANDIDATE_BASE_NOT_ANCESTOR"
    | "DESTINATION_UNAVAILABLE"
    | "DESTINATION_HEAD_MISMATCH"
    | "DIRTY_OVERLAP"
    | "DIRTY_DESTINATION"
    | "INTEGRATION_NOT_EXPRESSIBLE";
  detail: string;
}

export interface IntegrationReadiness {
  /** The candidate commit was resolved to an exact commit object. */
  candidateCommitVerified: boolean;
  /**
   * Canonical frozen candidateHead SHA (lowercase hex, self-verified). Present
   * whenever identity verification passed; all downstream identity-bearing
   * operations must use this instead of the raw caller string.
   */
  canonicalHead?: string;
  /** Canonical frozen candidateBase SHA; same contract as canonicalHead. */
  canonicalBase?: string;
  /** Exact tree identity verified for candidateHead. */
  candidateTreeId?: string;
  /** candidateBase resolved to an exact commit object. */
  candidateBaseVerified: boolean;
  /** candidateBase is a verified ancestor of candidateHead. */
  candidateBaseIsAncestor: boolean;
  /** Exact committed changed-path set derived from candidateBase..candidateHead. */
  candidateChangedPaths: string[];
  destinationBaseMatches: boolean;
  destinationOverlap: "none" | "overlap" | "unknown";
  overlappingPaths: string[];
  unrelatedDestinationDirtyPaths: string[];
  gitStateAvailable: boolean;
  operationExpressible: boolean;
  /** Technical integration readiness ONLY. Owner acceptance is external authority. */
  technicallyReadyToApply: boolean;
  /** Acceptance is external authority; Dev MCP never grants or infers it here. */
  acceptanceStatus: "external_not_granted_here";
  blockers: IntegrationBlocker[];
  unknowns: string[];
}

export interface IntegrationApplyResult {
  applied: boolean;
  appliedRange: { base: string; head: string };
  appliedTrackedFiles: number;
  blockers: IntegrationBlocker[];
}

export interface CandidatePromotionInput {
  /** Workspace containing the exact accepted Candidate objects. */
  sourceWorkspaceRoot: string;
  candidateBase: string;
  candidateHead: string;
  /** Exact tree SHA expected for candidateHead. */
  candidateTree: string;
  /** Attached local checkout whose maintained branch should advance. */
  destinationWorkspaceRoot: string;
  /** Short local branch name, for example `main` or `james/feature`. */
  expectedDestinationBranch: string;
  /** Exact pre-promotion branch HEAD. Must equal candidateBase. */
  expectedDestinationHead: string;
  /** Must be true before any ref or worktree mutation occurs. */
  confirmPromote: boolean;
  /** Expected values used only as a CAS fence against trusted live runtime facts. */
  runtimeBinding?: {
    expectedServerInstanceId: string;
    expectedSourceCommit: string;
    expectedBuildId: string;
    expectedCapabilityManifestSha256: string;
  };
  /** Deterministic race-test seam: runs after final validation, before CAS ref update. */
  beforeRefUpdateHook?: () => Promise<void> | void;
  /** Deterministic failure-test seam: runs after CAS ref update, before worktree/index sync. */
  beforeWorktreeSyncHook?: () => Promise<void> | void;
}

export interface PromotionBlocker {
  code:
    | "SOURCE_DESTINATION_ALIAS"
    | "CANDIDATE_IDENTITY_NOT_IMMUTABLE"
    | "CANDIDATE_COMMIT_MISSING"
    | "CANDIDATE_BASE_INVALID"
    | "CANDIDATE_BASE_NOT_ANCESTOR"
    | "CANDIDATE_TREE_MISMATCH"
    | "REPOSITORY_IDENTITY_MISMATCH"
    | "DESTINATION_UNAVAILABLE"
    | "DESTINATION_BRANCH_INVALID"
    | "DESTINATION_BRANCH_MISMATCH"
    | "DESTINATION_HEAD_MISMATCH"
    | "DIRTY_DESTINATION"
    | "PROMOTION_NOT_CONFIRMED"
    | "PROMOTION_CAS_FAILED"
    | "PROMOTION_WORKTREE_SYNC_FAILED"
    | "PROMOTION_POST_STATE_MISMATCH"
    | "PROMOTION_RUNTIME_IDENTITY_MISMATCH"
    | "PROMOTION_CAPABILITY_MANIFEST_INCOMPLETE"
    | "PROMOTION_CANDIDATE_CAPABILITY_BINDING_UNAVAILABLE"
    | "PROMOTION_CANONICAL_UPSTREAM_UNKNOWN"
    | "PROMOTION_STALE_CANONICAL_BASE"
    | "PROMOTION_CANONICAL_HEAD_DRIFT";
  detail: string;
}

export interface CandidatePromotionResult {
  success: boolean;
  promoted: boolean;
  alreadyPromoted: boolean;
  branch: string;
  previousHead: string;
  currentHead: string;
  candidateHead: string;
  candidateTree: string;
  canonicalRemote?: string;
  canonicalRef?: string;
  canonicalHead?: string;
  /** Acceptance remains external authority; this primitive only moves local Git state. */
  acceptanceStatus: "external_not_granted_here";
  blockers: PromotionBlocker[];
}

export interface PromotionRuntimeContext {
  identity: {
    serverInstanceId: string;
    sourceCommit: string;
    buildId: string;
  };
  capabilityManifest: CapabilityManifest;
}

const GIT_TIMEOUT_MS = 15_000;

interface GitResult {
  ok: boolean;
  stdout: string;
}

function runGit(args: string[], cwd: string, input?: string): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    let completed = false;
    const timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
      resolvePromise({ ok: false, stdout: "" });
    }, GIT_TIMEOUT_MS);
    const child = execFile(
      "git",
      args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolvePromise({ ok: !error, stdout: stdout ?? "" });
      },
    );
    if (input !== undefined) child.stdin?.end(input, "utf8");
  });
}

function containedWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

const EXACT_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Candidate identities are immutable object identities supplied by the
 * accepting authority. A mutable or ref-shaped value ("HEAD", "main",
 * "candidate/foo", "HEAD~1", "refs/heads/x") must never satisfy the immutable
 * Candidate fence, so identities must be exact whitespace-free
 * 40-character lowercase-hex commit SHAs that resolve to themselves.
 * Uppercase hex MAY normalize to lowercase; any leading/trailing or embedded
 * whitespace makes the value invalid — whitespace is never trimmed into
 * validity.
 */
export function normalizeExactCommitSha(
  value: string,
  field: "candidateBase" | "candidateHead",
): { sha: string } | { blocker: IntegrationBlocker } {
  const lowered = value.toLowerCase();
  if (/\s/.test(value) || !EXACT_COMMIT_SHA_PATTERN.test(lowered)) {
    return {
      blocker: {
        code: "CANDIDATE_IDENTITY_NOT_IMMUTABLE",
        detail: `Candidate ${field} ${JSON.stringify(value)} is not an exact whitespace-free 40-character hex commit SHA; mutable or ref-shaped identities are never accepted.`,
      },
    };
  }
  return { sha: lowered };
}

/**
 * Resolve a validated SHA and require it to name itself exactly. This rejects
 * e.g. an annotated-tag object SHA (which peels to a different commit) and any
 * repository where the supplied bytes are not the id of a commit in it.
 */
async function resolveSelfVerifyingSha(
  sha: string,
  field: "candidateBase" | "candidateHead",
  source: string,
): Promise<{ verified: true } | { verified: false; missing: boolean; blocker?: IntegrationBlocker }> {
  const resolved = await runGit(
    ["rev-parse", "--verify", "--end-of-options", `${sha}^{commit}`],
    source,
  );
  if (!resolved.ok) return { verified: false, missing: true };
  const resolvedSha = resolved.stdout.trim().toLowerCase();
  if (resolvedSha !== sha) {
    return {
      verified: false,
      missing: false,
      blocker: {
        code: "CANDIDATE_IDENTITY_NOT_IMMUTABLE",
        detail: `Candidate ${field} '${sha}' resolves to ${resolvedSha}; identities must resolve to exactly the supplied immutable SHA.`,
      },
    };
  }
  return { verified: true };
}

/**
 * Read-only integration readiness for one exact immutable Candidate range.
 * Missing evidence stays UNKNOWN and never folds into technical readiness.
 */
export async function inspectIntegrationReadiness(
  input: CandidateRangeIdentity,
): Promise<IntegrationReadiness> {
  const blockers: IntegrationBlocker[] = [];
  const unknowns: string[] = [];
  const dirtyPolicy = input.dirtyPolicy ?? "allow_unrelated";

  const source = canonicalizePath(input.sourceWorkspaceRoot);
  const destination = canonicalizePath(input.destinationWorkspaceRoot);

  let aliased = false;
  if (source === destination) {
    aliased = true;
    blockers.push({
      code: "SOURCE_DESTINATION_ALIAS",
      detail: `Source and destination resolve to the same physical checkout: ${source}`,
    });
  }

  // Immutable Candidate fence: only exact self-resolving commit SHAs pass.
  const baseIdentity = normalizeExactCommitSha(input.candidateBase, "candidateBase");
  const headIdentity = normalizeExactCommitSha(input.candidateHead, "candidateHead");
  if ("blocker" in baseIdentity) blockers.push(baseIdentity.blocker);
  if ("blocker" in headIdentity) blockers.push(headIdentity.blocker);
  if (!("sha" in baseIdentity) || !("sha" in headIdentity)) {
    return {
      candidateCommitVerified: false,
      candidateBaseVerified: false,
      candidateBaseIsAncestor: false,
      candidateChangedPaths: [],
      destinationBaseMatches: false,
      destinationOverlap: "unknown",
      overlappingPaths: [],
      unrelatedDestinationDirtyPaths: [],
      gitStateAvailable: false,
      operationExpressible: false,
      technicallyReadyToApply: false,
      acceptanceStatus: "external_not_granted_here",
      blockers,
      unknowns,
    };
  }
  const canonicalBase = baseIdentity.sha;
  const canonicalHead = headIdentity.sha;

  const headResolution = await resolveSelfVerifyingSha(canonicalHead, "candidateHead", source);
  const baseResolution = await resolveSelfVerifyingSha(canonicalBase, "candidateBase", source);
  const candidateCommitVerified = headResolution.verified;
  const candidateBaseVerified = baseResolution.verified;
  if (!headResolution.verified) {
    if (headResolution.missing) {
      blockers.push({
        code: "CANDIDATE_COMMIT_MISSING",
        detail: `Candidate commit ${canonicalHead} does not exist in ${source}.`,
      });
    } else if (headResolution.blocker) {
      blockers.push(headResolution.blocker);
    }
  }
  if (!baseResolution.verified) {
    if (baseResolution.missing) {
      blockers.push({
        code: "CANDIDATE_BASE_INVALID",
        detail: `Candidate base ${canonicalBase} does not exist in ${source}.`,
      });
    } else if (baseResolution.blocker) {
      blockers.push(baseResolution.blocker);
    }
  }

  let candidateTreeId: string | undefined;
  if (candidateCommitVerified) {
    const tree = await runGit(["rev-parse", `${canonicalHead}^{tree}`], source);
    candidateTreeId = tree.ok ? tree.stdout.trim() || undefined : undefined;
    if (!candidateTreeId) {
      unknowns.push("candidate tree identity could not be read.");
    }
  }

  let candidateBaseIsAncestor = false;
  let candidateChangedPaths: string[] = [];
  if (candidateCommitVerified && candidateBaseVerified) {
    const ancestor = await runGit(
      ["merge-base", "--is-ancestor", canonicalBase, canonicalHead],
      source,
    );
    candidateBaseIsAncestor = ancestor.ok;
    if (!ancestor.ok) {
      blockers.push({
        code: "CANDIDATE_BASE_NOT_ANCESTOR",
        detail: `Candidate base ${canonicalBase} is not an ancestor of candidate head ${canonicalHead}.`,
      });
    } else {
      const diffNames = await runGit(
        ["diff", "--name-only", `${canonicalBase}..${canonicalHead}`],
        source,
      );
      if (!diffNames.ok) {
        unknowns.push("committed Candidate changed paths could not be derived.");
      } else {
        candidateChangedPaths = [...new Set(splitLines(diffNames.stdout))].sort();
      }
    }
  }

  let destinationStateKnown = false;
  let destinationBaseMatches = false;
  if (!aliased) {
    const destHead = await runGit(["rev-parse", "HEAD"], destination);
    destinationStateKnown = destHead.ok && Boolean(destHead.stdout.trim());
    if (!destinationStateKnown) {
      blockers.push({
        code: "DESTINATION_UNAVAILABLE",
        detail: `Destination checkout Git state could not be read: ${destination}`,
      });
      unknowns.push("destination base state is unknown: Git inspection failed.");
    } else {
      destinationBaseMatches = destHead.stdout.trim() === input.expectedDestinationHead.toLowerCase();
      if (!destinationBaseMatches) {
        blockers.push({
          code: "DESTINATION_HEAD_MISMATCH",
          detail: `Destination HEAD ${destHead.stdout.trim()} does not match expected integration base ${input.expectedDestinationHead}.`,
        });
      }
    }
  }

  let destinationOverlap: IntegrationReadiness["destinationOverlap"] = "unknown";
  let overlappingPaths: string[] = [];
  let unrelatedDestinationDirtyPaths: string[] = [];
  if (!aliased && destinationStateKnown && candidateChangedPaths.length > 0) {
    const tracked = await runGit(["diff", "--name-only"], destination);
    const staged = await runGit(["diff", "--cached", "--name-only"], destination);
    const untracked = await runGit(["ls-files", "--others", "--exclude-standard"], destination);
    if (!tracked.ok || !staged.ok || !untracked.ok) {
      unknowns.push("destination dirty state is unknown: Git inspection failed.");
    } else {
      const destinationPaths = [
        ...new Set([
          ...splitLines(tracked.stdout),
          ...splitLines(staged.stdout),
          ...splitLines(untracked.stdout),
        ]),
      ].sort();
      const candidateSet = new Set(candidateChangedPaths);
      overlappingPaths = destinationPaths.filter((path) => candidateSet.has(path));
      unrelatedDestinationDirtyPaths = destinationPaths.filter((path) => !candidateSet.has(path));
      if (overlappingPaths.length > 0) {
        destinationOverlap = "overlap";
        blockers.push({
          code: "DIRTY_OVERLAP",
          detail: `Destination has uncommitted changes to Candidate paths: ${overlappingPaths.join(", ")}`,
        });
      } else {
        destinationOverlap = "none";
        if (dirtyPolicy === "pristine" && destinationPaths.length > 0) {
          blockers.push({
            code: "DIRTY_DESTINATION",
            detail: `Dirty policy 'pristine' refuses a dirty destination (${destinationPaths.length} changed path(s)).`,
          });
        }
      }
    }
  }

  let operationExpressible = false;
  if (
    !aliased &&
    candidateCommitVerified &&
    candidateBaseVerified &&
    candidateBaseIsAncestor &&
    candidateChangedPaths.length > 0 &&
    destinationBaseMatches &&
    destinationOverlap === "none" &&
    !(dirtyPolicy === "pristine" && unrelatedDestinationDirtyPaths.length > 0)
  ) {
    const patch = await runGit(
      ["diff", "--binary", canonicalBase, canonicalHead],
      source,
    );
    if (!patch.ok || !patch.stdout.trim()) {
      unknowns.push("committed Candidate patch could not be produced.");
    } else {
      const dryRun = await runGit(
        ["apply", "--check", "--binary", "--whitespace=nowarn", "-"],
        destination,
        patch.stdout,
      );
      operationExpressible = dryRun.ok;
      if (!dryRun.ok) {
        blockers.push({
          code: "INTEGRATION_NOT_EXPRESSIBLE",
          detail: "git apply --check rejected the committed Candidate range against the destination.",
        });
      }
    }
  }

  const technicallyReadyToApply =
    !aliased &&
    candidateCommitVerified &&
    candidateBaseVerified &&
    candidateBaseIsAncestor &&
    candidateChangedPaths.length > 0 &&
    candidateTreeId !== undefined &&
    destinationBaseMatches &&
    destinationOverlap === "none" &&
    !(dirtyPolicy === "pristine" && unrelatedDestinationDirtyPaths.length > 0) &&
    operationExpressible;

  return {
    candidateCommitVerified,
    canonicalBase,
    canonicalHead,
    candidateTreeId,
    candidateBaseVerified,
    candidateBaseIsAncestor,
    candidateChangedPaths,
    destinationBaseMatches,
    destinationOverlap,
    overlappingPaths,
    unrelatedDestinationDirtyPaths,
    gitStateAvailable: destinationStateKnown,
    operationExpressible,
    technicallyReadyToApply,
    acceptanceStatus: "external_not_granted_here",
    blockers,
    unknowns,
  };
}

/**
 * Deterministic test/observation seam: invoked by integrateCandidate AFTER its
 * internal readiness has passed and BEFORE the pre-mutation re-fence and
 * physical apply. It lets controlled tests mutate destination state inside the
 * same call, proving the check-to-mutation fence actually fires. Production
 * callers omit it.
 */
export type BeforeMutationHook = () => void | Promise<void>;

/**
 * Deterministic test/observation seam for the RESIDUAL window: invoked AFTER
 * the final re-fence has passed and immediately before `git apply`. It exists
 * solely so tests can demonstrate what an external writer in that unexcludable
 * window could do (including a compatible edit that coexists with a successful
 * apply). Production callers must never set it.
 */
export type BeforeApplyHook = () => void | Promise<void>;

export interface CandidateApplyInput extends CandidateRangeIdentity {
  confirmApply?: boolean;
  beforeMutationHook?: BeforeMutationHook;
  beforeApplyHook?: BeforeApplyHook;
}

/**
 * Bounded same-call re-fence bound to the physical mutation: re-reads the
 * destination HEAD and the Candidate-overlap dirty state immediately before
 * producing the patch and applying it. Fails closed on any drift observable at
 * fence time.
 */
async function refenceDestinationBeforeMutation(
  destination: string,
  identity: CandidateRangeIdentity,
  candidateChangedPaths: readonly string[],
): Promise<IntegrationBlocker[]> {
  const blockers: IntegrationBlocker[] = [];
  const dirtyPolicy = identity.dirtyPolicy ?? "allow_unrelated";

  const destHead = await runGit(["rev-parse", "HEAD"], destination);
  if (!destHead.ok || !destHead.stdout.trim()) {
    blockers.push({
      code: "DESTINATION_UNAVAILABLE",
      detail: `Destination checkout Git state could not be read before mutation: ${destination}`,
    });
    return blockers;
  }
  if (destHead.stdout.trim().toLowerCase() !== identity.expectedDestinationHead.toLowerCase()) {
    blockers.push({
      code: "DESTINATION_HEAD_MISMATCH",
      detail: `Destination HEAD advanced to ${destHead.stdout.trim()} after readiness; expected ${identity.expectedDestinationHead}.`,
    });
    return blockers;
  }

  const tracked = await runGit(["diff", "--name-only"], destination);
  const staged = await runGit(["diff", "--cached", "--name-only"], destination);
  const untracked = await runGit(["ls-files", "--others", "--exclude-standard"], destination);
  if (!tracked.ok || !staged.ok || !untracked.ok) {
    blockers.push({
      code: "DESTINATION_UNAVAILABLE",
      detail: "Destination dirty state could not be read before mutation.",
    });
    return blockers;
  }

  const candidateSet = new Set(candidateChangedPaths);
  const dirtyPaths = [
    ...new Set([
      ...splitLines(tracked.stdout),
      ...splitLines(staged.stdout),
      ...splitLines(untracked.stdout),
    ]),
  ];
  const overlapPaths = dirtyPaths.filter((path) => candidateSet.has(path));
  if (overlapPaths.length > 0) {
    blockers.push({
      code: "DIRTY_OVERLAP",
      detail: `Destination became dirty on Candidate paths after readiness: ${overlapPaths.join(", ")}`,
    });
    return blockers;
  }
  if (dirtyPolicy === "pristine" && dirtyPaths.length > 0) {
    blockers.push({
      code: "DIRTY_DESTINATION",
      detail: `Dirty policy 'pristine' refuses the post-readiness dirty destination (${dirtyPaths.length} changed path(s)).`,
    });
  }
  return blockers;
}

/**
 * Apply one exact immutable Candidate range onto the destination checkout.
 *
 * Every deterministic gate runs before the first destination mutation:
 * full readiness, then a same-call re-fence of destination HEAD and
 * Candidate-overlap dirtiness immediately before the patch is produced and
 * applied. Nothing outside the committed range (no untracked workspace files)
 * is ever copied.
 *
 * Exact safety guarantees — stated precisely, no more:
 * - readiness plus the same-call re-fence catch any drift OBSERVABLE at those
 *   two points in time;
 * - `git apply` without --reject is patch-atomic: the Candidate patch is either
 *   applied as a whole or not at all; there is never a partial patch;
 * - arbitrary external mutation AFTER the final re-fence is NOT excluded by
 *   this primitive;
 * - a compatible concurrent edit to a Candidate path may therefore coexist with
 *   a SUCCESSFUL apply, producing a mixed final file;
 * - hard mutual exclusion requires a destination-level/cooperative lock or a
 *   quiescent-destination contract, which this primitive does not provide or
 *   invent.
 */
export async function integrateCandidate(
  input: CandidateApplyInput,
): Promise<IntegrationApplyResult> {
  const { beforeMutationHook, beforeApplyHook, ...identity } = input;
  const readiness = await inspectIntegrationReadiness(identity);
  if (!readiness.technicallyReadyToApply) {
    return {
      applied: false,
      appliedRange: { base: identity.candidateBase, head: identity.candidateHead },
      appliedTrackedFiles: 0,
      blockers: readiness.blockers,
    };
  }
  if (input.confirmApply !== true) {
    return {
      applied: false,
      appliedRange: { base: identity.candidateBase, head: identity.candidateHead },
      appliedTrackedFiles: 0,
      blockers: [
        {
          code: "INTEGRATION_NOT_EXPRESSIBLE",
          detail: "confirmApply was not set: preparation only, no mutation performed.",
        },
      ],
    };
  }

  // Immutable identity verification has passed: from here on, only the frozen
  // canonical SHAs are used for every identity-bearing operation.
  const canonicalBase = readiness.canonicalBase!;
  const canonicalHead = readiness.canonicalHead!;

  const source = canonicalizePath(identity.sourceWorkspaceRoot);
  const destination = canonicalizePath(identity.destinationWorkspaceRoot);

  // Controlled seam for deterministic race tests: runs after readiness, before
  // the re-fence, so mutations performed here are caught by the fence below.
  await beforeMutationHook?.();

  const refenceBlockers = await refenceDestinationBeforeMutation(
    destination,
    identity,
    readiness.candidateChangedPaths,
  );
  if (refenceBlockers.length > 0) {
    return {
      applied: false,
      appliedRange: { base: canonicalBase, head: canonicalHead },
      appliedTrackedFiles: 0,
      blockers: refenceBlockers,
    };
  }

  // Residual-window observation seam (tests only): runs after the final
  // re-fence, immediately before apply. Mutations here are NOT fenced — that is
  // exactly the documented residual concurrency limitation.
  await beforeApplyHook?.();

  const patch = await runGit(
    ["diff", "--binary", canonicalBase, canonicalHead],
    source,
  );
  if (!patch.ok || !patch.stdout.trim()) {
    return {
      applied: false,
      appliedRange: { base: canonicalBase, head: canonicalHead },
      appliedTrackedFiles: 0,
      blockers: [
        {
          code: "INTEGRATION_NOT_EXPRESSIBLE",
          detail: "Committed Candidate patch could not be produced at apply time.",
        },
      ],
    };
  }

  // Patch-atomic by design: git apply without --reject lands the whole patch
  // or writes nothing. It does NOT exclude concurrent writers.
  const applied = (
    await runGit(["apply", "--binary", "--whitespace=nowarn", "-"], destination, patch.stdout)
  ).ok;
  if (!applied) {
    return {
      applied: false,
      appliedRange: { base: canonicalBase, head: canonicalHead },
      appliedTrackedFiles: 0,
      blockers: [
        {
          code: "INTEGRATION_NOT_EXPRESSIBLE",
          detail: "git apply failed at apply time; the destination was left unchanged.",
        },
      ],
    };
  }

  const changed = await runGit(["diff", "--name-only"], destination);
  return {
    applied: true,
    appliedRange: { base: canonicalBase, head: canonicalHead },
    appliedTrackedFiles: changed.ok ? splitLines(changed.stdout).length : 0,
    blockers: [],
  };
}

// ─── Durable local Candidate branch promotion ───────────────────────────────

async function gitCommonDirectory(workspaceRoot: string): Promise<string | undefined> {
  const result = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    workspaceRoot,
  );
  if (!result.ok || !result.stdout.trim()) return undefined;
  try {
    return canonicalizePath(result.stdout.trim());
  } catch {
    return undefined;
  }
}

async function destinationPromotionState(
  destination: string,
  branch: string,
): Promise<{
  symbolicRef?: string;
  branchHead?: string;
  head?: string;
  tree?: string;
  status?: string;
}> {
  const fullRef = `refs/heads/${branch}`;
  const [symbolic, branchHead, head, tree, status] = await Promise.all([
    runGit(["symbolic-ref", "-q", "HEAD"], destination),
    runGit(["show-ref", "--verify", "--hash", fullRef], destination),
    runGit(["rev-parse", "--verify", "HEAD"], destination),
    runGit(["rev-parse", "--verify", "HEAD^{tree}"], destination),
    runGit(["status", "--porcelain=v1", "--untracked-files=all"], destination),
  ]);
  return {
    symbolicRef: symbolic.ok ? symbolic.stdout.trim() : undefined,
    branchHead: branchHead.ok ? branchHead.stdout.trim().toLowerCase() : undefined,
    head: head.ok ? head.stdout.trim().toLowerCase() : undefined,
    tree: tree.ok ? tree.stdout.trim().toLowerCase() : undefined,
    status: status.ok ? status.stdout : undefined,
  };
}

interface CanonicalUpstreamObservation {
  remote: string;
  ref: string;
  head: string;
}

async function observeCanonicalUpstream(
  destination: string,
  branch: string,
): Promise<CanonicalUpstreamObservation | undefined> {
  const [remoteResult, mergeResult] = await Promise.all([
    runGit(["config", "--get", `branch.${branch}.remote`], destination),
    runGit(["config", "--get", `branch.${branch}.merge`], destination),
  ]);
  const remote = remoteResult.ok ? remoteResult.stdout.trim() : "";
  const ref = mergeResult.ok ? mergeResult.stdout.trim() : "";
  if (!remote || remote === "." || remote.startsWith("-") || !ref.startsWith("refs/heads/")) {
    return undefined;
  }

  const advertisedHead = await runGit(["ls-remote", "--symref", remote, "HEAD"], destination);
  if (!advertisedHead.ok) return undefined;
  const symbolicHeadLines = splitLines(advertisedHead.stdout)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[0] === "ref:");
  if (symbolicHeadLines.length !== 1) return undefined;
  const [marker, defaultRef, target, ...extra] = symbolicHeadLines[0]!;
  if (
    marker !== "ref:"
    || !defaultRef?.startsWith("refs/heads/")
    || target !== "HEAD"
    || extra.length > 0
    || defaultRef !== ref
  ) return undefined;

  const observed = await runGit(["ls-remote", "--exit-code", "--heads", remote, ref], destination);
  if (!observed.ok) return undefined;
  const matches = splitLines(observed.stdout)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[1] === ref && EXACT_COMMIT_SHA_PATTERN.test(parts[0]?.toLowerCase() ?? ""));
  if (matches.length !== 1) return undefined;
  return { remote, ref, head: matches[0]![0]!.toLowerCase() };
}

/**
 * Advance one exact attached local branch from candidateBase to candidateHead.
 *
 * This is intentionally NOT a generic reset/rebase/reconciliation primitive.
 * It only supports a same-repository, pristine, pure fast-forward promotion of
 * an externally accepted Candidate. The stable replay request remains
 * candidateBase -> candidateHead: when the exact branch is already cleanly at
 * candidateHead with the expected tree, the operation returns idempotent
 * success without mutating Git state.
 *
 * The ref move uses `git update-ref <ref> <new> <old>` so an unexpected branch
 * move cannot be overwritten. After the CAS succeeds, `git read-tree -u -m`
 * synchronizes the index/worktree from the exact old tree to the exact new tree
 * without moving the ref again. If that synchronization fails, the primitive
 * attempts a CAS rollback from candidateHead to candidateBase and reports the
 * failure; it never force-resets a branch or overwrites a later ref move.
 */
export async function promoteCandidate(
  input: CandidatePromotionInput,
  runtimeContext?: PromotionRuntimeContext,
): Promise<CandidatePromotionResult> {
  const blockers: PromotionBlocker[] = [];
  const branch = input.expectedDestinationBranch;
  let previousHead = input.expectedDestinationHead.toLowerCase();
  let currentHead = "";
  let canonicalUpstream: CanonicalUpstreamObservation | undefined;

  const fail = (): CandidatePromotionResult => ({
    success: false,
    promoted: false,
    alreadyPromoted: false,
    branch,
    previousHead,
    currentHead,
    candidateHead: input.candidateHead.toLowerCase(),
    candidateTree: input.candidateTree.toLowerCase(),
    canonicalRemote: canonicalUpstream?.remote,
    canonicalRef: canonicalUpstream?.ref,
    canonicalHead: canonicalUpstream?.head,
    acceptanceStatus: "external_not_granted_here",
    blockers,
  });

  const source = canonicalizePath(input.sourceWorkspaceRoot);
  const destination = canonicalizePath(input.destinationWorkspaceRoot);
  if (source === destination) {
    blockers.push({
      code: "SOURCE_DESTINATION_ALIAS",
      detail: `Source and destination resolve to the same physical checkout: ${source}`,
    });
    return fail();
  }

  const baseIdentity = normalizeExactCommitSha(input.candidateBase, "candidateBase");
  const headIdentity = normalizeExactCommitSha(input.candidateHead, "candidateHead");
  if (!("sha" in baseIdentity) || !("sha" in headIdentity)) {
    blockers.push({
      code: "CANDIDATE_IDENTITY_NOT_IMMUTABLE",
      detail: "Candidate base/head must both be exact immutable 40-character commit SHAs.",
    });
    return fail();
  }
  const candidateBase = baseIdentity.sha;
  const candidateHead = headIdentity.sha;

  const candidateTree = input.candidateTree.toLowerCase();
  if (/\s/.test(input.candidateTree) || !EXACT_COMMIT_SHA_PATTERN.test(candidateTree)) {
    blockers.push({
      code: "CANDIDATE_TREE_MISMATCH",
      detail: `Candidate tree ${JSON.stringify(input.candidateTree)} is not an exact whitespace-free 40-character hex tree SHA.`,
    });
    return fail();
  }

  const expectedDestinationHead = input.expectedDestinationHead.toLowerCase();
  previousHead = expectedDestinationHead;
  if (/\s/.test(input.expectedDestinationHead) || !EXACT_COMMIT_SHA_PATTERN.test(expectedDestinationHead)) {
    blockers.push({
      code: "DESTINATION_HEAD_MISMATCH",
      detail: `Expected destination HEAD ${JSON.stringify(input.expectedDestinationHead)} is not an exact 40-character commit SHA.`,
    });
    return fail();
  }
  if (expectedDestinationHead !== candidateBase) {
    blockers.push({
      code: "DESTINATION_HEAD_MISMATCH",
      detail: `Promotion expectedDestinationHead must equal candidateBase (${candidateBase}); received ${expectedDestinationHead}.`,
    });
    return fail();
  }

  const branchFormat = await runGit(["check-ref-format", "--branch", branch], destination);
  if (!branchFormat.ok || !branch || branch.startsWith("refs/")) {
    blockers.push({
      code: "DESTINATION_BRANCH_INVALID",
      detail: `Expected destination branch ${JSON.stringify(branch)} is not a valid short local branch name.`,
    });
    return fail();
  }

  const [sourceCommonDir, destinationCommonDir] = await Promise.all([
    gitCommonDirectory(source),
    gitCommonDirectory(destination),
  ]);
  if (!sourceCommonDir || !destinationCommonDir) {
    blockers.push({
      code: "DESTINATION_UNAVAILABLE",
      detail: "Could not resolve source/destination Git common-directory identity.",
    });
    return fail();
  }
  if (sourceCommonDir !== destinationCommonDir) {
    blockers.push({
      code: "REPOSITORY_IDENTITY_MISMATCH",
      detail: "Source Candidate and destination branch are not worktrees of the same Git common directory.",
    });
    return fail();
  }

  const baseVerified = await resolveSelfVerifyingSha(candidateBase, "candidateBase", source);
  if (!baseVerified.verified) {
    blockers.push({
      code: "CANDIDATE_BASE_INVALID",
      detail: `Candidate base ${candidateBase} is not an exact commit object in the source repository.`,
    });
    return fail();
  }
  const headVerified = await resolveSelfVerifyingSha(candidateHead, "candidateHead", source);
  if (!headVerified.verified) {
    blockers.push({
      code: "CANDIDATE_COMMIT_MISSING",
      detail: `Candidate head ${candidateHead} is not an exact commit object in the source repository.`,
    });
    return fail();
  }

  const ancestry = await runGit(["merge-base", "--is-ancestor", candidateBase, candidateHead], source);
  if (!ancestry.ok) {
    blockers.push({
      code: "CANDIDATE_BASE_NOT_ANCESTOR",
      detail: `Candidate base ${candidateBase} is not an ancestor of candidate head ${candidateHead}.`,
    });
    return fail();
  }

  const treeResult = await runGit(
    ["rev-parse", "--verify", "--end-of-options", `${candidateHead}^{tree}`],
    source,
  );
  const actualCandidateTree = treeResult.ok ? treeResult.stdout.trim().toLowerCase() : "";
  if (!actualCandidateTree || actualCandidateTree !== candidateTree) {
    blockers.push({
      code: "CANDIDATE_TREE_MISMATCH",
      detail: `Candidate head tree is ${actualCandidateTree || "unavailable"}, expected ${candidateTree}.`,
    });
    return fail();
  }

  if (runtimeContext) {
    const binding = input.runtimeBinding;
    const actual = runtimeContext.identity;
    const manifest = runtimeContext.capabilityManifest;
    if (
      !binding
      || binding.expectedServerInstanceId !== actual.serverInstanceId
      || binding.expectedSourceCommit !== actual.sourceCommit
      || binding.expectedBuildId !== actual.buildId
      || binding.expectedCapabilityManifestSha256 !== manifest.manifestSha256
    ) {
      blockers.push({
        code: "PROMOTION_RUNTIME_IDENTITY_MISMATCH",
        detail: "Promotion runtime binding does not match the currently loaded serverInstanceId/sourceCommit/buildId/capability manifest.",
      });
      return fail();
    }
    if (manifest.missing.length > 0) {
      blockers.push({
        code: "PROMOTION_CAPABILITY_MANIFEST_INCOMPLETE",
        detail: `Currently loaded runtime is missing required capabilities: ${manifest.missing.join(", ")}.`,
      });
      return fail();
    }
    if (actual.sourceCommit !== candidateHead) {
      blockers.push({
        code: "PROMOTION_CANDIDATE_CAPABILITY_BINDING_UNAVAILABLE",
        detail: `Candidate ${candidateHead} is not the exact sourceCommit loaded by this runtime (${actual.sourceCommit}); DevSpace has no narrow trusted primitive to execute and attest an arbitrary candidate, so promotion fails closed.`,
      });
      return fail();
    }

    canonicalUpstream = await observeCanonicalUpstream(destination, branch);
    if (!canonicalUpstream) {
      blockers.push({
        code: "PROMOTION_CANONICAL_UPSTREAM_UNKNOWN",
        detail: `Could not derive and live-observe the configured upstream for destination branch ${branch}.`,
      });
      return fail();
    }
    if (canonicalUpstream.head !== candidateBase) {
      blockers.push({
        code: "PROMOTION_STALE_CANONICAL_BASE",
        detail: `Candidate base ${candidateBase} does not equal the live canonical upstream head ${canonicalUpstream.head} derived from ${canonicalUpstream.remote}/${canonicalUpstream.ref}.`,
      });
      return fail();
    }
  }

  const expectedFullRef = `refs/heads/${branch}`;
  let state = await destinationPromotionState(destination, branch);
  currentHead = state.head ?? "";
  if (!state.symbolicRef || !state.branchHead || !state.head || state.status === undefined) {
    blockers.push({
      code: "DESTINATION_UNAVAILABLE",
      detail: "Destination branch/HEAD/status could not be read completely.",
    });
    return fail();
  }
  if (state.symbolicRef !== expectedFullRef) {
    blockers.push({
      code: "DESTINATION_BRANCH_MISMATCH",
      detail: `Destination HEAD is attached to ${state.symbolicRef}, expected ${expectedFullRef}.`,
    });
    return fail();
  }
  if (state.branchHead !== state.head) {
    blockers.push({
      code: "DESTINATION_HEAD_MISMATCH",
      detail: `Destination branch ref is ${state.branchHead}, while HEAD resolves to ${state.head}.`,
    });
    return fail();
  }

  // Stable replay: same exact request after a successful promotion is a no-op.
  if (state.head === candidateHead) {
    if (state.status.trim() !== "") {
      blockers.push({
        code: "DIRTY_DESTINATION",
        detail: "Destination is already at the Candidate head but is not pristine; replay is refused.",
      });
      return fail();
    }
    if (state.tree !== candidateTree) {
      blockers.push({
        code: "CANDIDATE_TREE_MISMATCH",
        detail: `Destination already points at Candidate head but tree ${state.tree ?? "unavailable"} does not match ${candidateTree}.`,
      });
      return fail();
    }
    return {
      success: true,
      promoted: false,
      alreadyPromoted: true,
      branch,
      previousHead: candidateBase,
      currentHead: candidateHead,
      candidateHead,
      candidateTree,
      canonicalRemote: canonicalUpstream?.remote,
      canonicalRef: canonicalUpstream?.ref,
      canonicalHead: canonicalUpstream?.head,
      acceptanceStatus: "external_not_granted_here",
      blockers: [],
    };
  }

  if (state.head !== expectedDestinationHead) {
    blockers.push({
      code: "DESTINATION_HEAD_MISMATCH",
      detail: `Destination HEAD is ${state.head}, expected exact promotion base ${expectedDestinationHead}.`,
    });
    return fail();
  }
  if (state.status.trim() !== "") {
    blockers.push({
      code: "DIRTY_DESTINATION",
      detail: "Destination index/worktree must be pristine before local Candidate promotion.",
    });
    return fail();
  }
  if (input.confirmPromote !== true) {
    blockers.push({
      code: "PROMOTION_NOT_CONFIRMED",
      detail: "confirmPromote was not set: no local branch mutation performed.",
    });
    return fail();
  }

  // Final same-call re-fence before the first mutation.
  state = await destinationPromotionState(destination, branch);
  currentHead = state.head ?? "";
  if (state.symbolicRef !== expectedFullRef) {
    blockers.push({
      code: "DESTINATION_BRANCH_MISMATCH",
      detail: `Destination branch changed before promotion; expected ${expectedFullRef}, observed ${state.symbolicRef ?? "detached/unavailable"}.`,
    });
    return fail();
  }
  if (state.head !== expectedDestinationHead || state.branchHead !== expectedDestinationHead) {
    blockers.push({
      code: "DESTINATION_HEAD_MISMATCH",
      detail: `Destination moved before promotion; expected ${expectedDestinationHead}, observed HEAD=${state.head ?? "unavailable"} ref=${state.branchHead ?? "unavailable"}.`,
    });
    return fail();
  }
  if (state.status === undefined || state.status.trim() !== "") {
    blockers.push({
      code: "DIRTY_DESTINATION",
      detail: "Destination became dirty before promotion; no ref mutation performed.",
    });
    return fail();
  }

  // Deterministic race seam used by tests to move the ref after the final
  // re-fence but before update-ref's old-OID CAS.
  await input.beforeRefUpdateHook?.();

  if (runtimeContext && canonicalUpstream) {
    const finalCanonical = await observeCanonicalUpstream(destination, branch);
    if (
      !finalCanonical
      || finalCanonical.remote !== canonicalUpstream.remote
      || finalCanonical.ref !== canonicalUpstream.ref
      || finalCanonical.head !== canonicalUpstream.head
    ) {
      blockers.push({
        code: "PROMOTION_CANONICAL_HEAD_DRIFT",
        detail: "Destination canonical upstream binding or live remote head changed before the promotion CAS; no local ref mutation occurred.",
      });
      return fail();
    }
  }

  // CAS ref advancement: a concurrent ref move is never overwritten.
  const refUpdate = await runGit(
    ["update-ref", expectedFullRef, candidateHead, expectedDestinationHead],
    destination,
  );
  if (!refUpdate.ok) {
    const raced = await destinationPromotionState(destination, branch);
    currentHead = raced.head ?? "";
    blockers.push({
      code: "PROMOTION_CAS_FAILED",
      detail: `Conditional ref update failed; destination branch was not overwritten. Current HEAD=${currentHead || "unavailable"}.`,
    });
    return fail();
  }

  await input.beforeWorktreeSyncHook?.();

  // Synchronize the pristine base index/worktree to the exact Candidate tree
  // without moving the branch ref again.
  const sync = await runGit(
    ["read-tree", "-u", "-m", candidateBase, candidateHead],
    destination,
  );
  if (!sync.ok) {
    const rollback = await runGit(
      ["update-ref", expectedFullRef, candidateBase, candidateHead],
      destination,
    );
    const afterFailure = await destinationPromotionState(destination, branch);
    currentHead = afterFailure.head ?? "";
    blockers.push({
      code: "PROMOTION_WORKTREE_SYNC_FAILED",
      detail: rollback.ok
        ? "Candidate ref advance was rolled back by CAS after index/worktree synchronization failed."
        : "Index/worktree synchronization failed and CAS rollback could not restore the original ref because branch state changed again; no later ref move was overwritten.",
    });
    return fail();
  }

  const finalState = await destinationPromotionState(destination, branch);
  currentHead = finalState.head ?? "";
  const coherent =
    finalState.symbolicRef === expectedFullRef &&
    finalState.branchHead === candidateHead &&
    finalState.head === candidateHead &&
    finalState.tree === candidateTree &&
    finalState.status !== undefined &&
    finalState.status.trim() === "";
  if (!coherent) {
    blockers.push({
      code: "PROMOTION_POST_STATE_MISMATCH",
      detail: `Promotion post-state is not coherent: branch=${finalState.symbolicRef ?? "unavailable"}, ref=${finalState.branchHead ?? "unavailable"}, HEAD=${finalState.head ?? "unavailable"}, tree=${finalState.tree ?? "unavailable"}, dirty=${finalState.status === undefined ? "unknown" : String(finalState.status.trim() !== "")}.`,
    });
    return fail();
  }

  return {
    success: true,
    promoted: true,
    alreadyPromoted: false,
    branch,
    previousHead: candidateBase,
    currentHead: candidateHead,
    candidateHead,
    candidateTree,
    canonicalRemote: canonicalUpstream?.remote,
    canonicalRef: canonicalUpstream?.ref,
    canonicalHead: canonicalUpstream?.head,
    acceptanceStatus: "external_not_granted_here",
    blockers: [],
  };
}

// ─── Remote writability probe ───────────────────────────────────────────────

export interface RemoteWritabilityProbe {
  remoteName?: string;
  remoteUrl?: string;
  /** Remote is configured in the local repository. */
  remoteConfigured: boolean;
  reachable: boolean | "unknown";
  credentialsEvidence: "known_ok" | "known_failure" | "unknown";
  upstreamBranch?: string;
  upstreamConfigured: boolean;
  /**
   * Push permission cannot be proven without performing a mutating push, which
   * this probe refuses to do. It therefore always stays unknown.
   */
  pushPermissionProven: "unknown";
  notes: string[];
}

/**
 * Read-only remote readiness probe. Never pushes; push permission stays
 * explicitly unknown instead of being inferred from a configured URL.
 */
export async function probeRemoteWritability(
  workspaceRoot: string,
  remoteName = "origin",
): Promise<RemoteWritabilityProbe> {
  const notes: string[] = [];
  const urlResult = await runGit(["remote", "get-url", remoteName], workspaceRoot);
  if (!urlResult.ok || !urlResult.stdout.trim()) {
    return {
      remoteName,
      remoteConfigured: false,
      reachable: "unknown",
      credentialsEvidence: "unknown",
      upstreamConfigured: false,
      pushPermissionProven: "unknown",
      notes: [`Remote '${remoteName}' is not configured.`],
    };
  }
  const remoteUrl = urlResult.stdout.trim();

  const lsRemote = await runGit(["ls-remote", "--heads", remoteName], workspaceRoot);
  let reachable: boolean | "unknown" = "unknown";
  let credentialsEvidence: RemoteWritabilityProbe["credentialsEvidence"] = "unknown";
  if (lsRemote.ok) {
    reachable = true;
    credentialsEvidence = "known_ok";
  } else {
    // A failed ls-remote can mean network OR auth failure; do not guess which.
    reachable = "unknown";
    credentialsEvidence = "unknown";
    notes.push("ls-remote failed; reachability/auth cause could not be distinguished without mutating probes.");
  }

  const upstream = await runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    workspaceRoot,
  );
  const upstreamBranch = upstream.ok ? upstream.stdout.trim() || undefined : undefined;

  notes.push("push permission is never proven by this probe: proving it requires a mutating push.");

  return {
    remoteName,
    remoteUrl,
    remoteConfigured: true,
    reachable,
    credentialsEvidence,
    upstreamBranch,
    upstreamConfigured: Boolean(upstreamBranch),
    pushPermissionProven: "unknown",
    notes,
  };
}
