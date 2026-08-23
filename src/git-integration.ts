import { execFile } from "node:child_process";
import { isAbsolute, relative, sep } from "node:path";
import { canonicalizePath } from "./roots.js";

/**
 * Typed integration primitive for one accepted, IMMUTABLE Candidate range.
 *
 * The Candidate boundary is a committed Git range:
 *
 *   candidateBase .. candidateHead
 *
 * Both identities are exact SHAs supplied by the accepting authority. The
 * integration payload is derived entirely from that committed range; nothing
 * from the source worktree's current dirty or untracked state can enter the
 * payload, so execution metadata (e.g. `.devspace/`) can never leak into a
 * destination.
 *
 * This module never pushes, merges, or releases, and never invents acceptance:
 * Owner acceptance stays external and readiness always reports it as not
 * granted here. `git apply` without --reject is atomic, and every
 * deterministic gate runs before the first destination mutation, so a rejected
 * integration leaves the destination byte-identical.
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

  const headResult = await runGit(["rev-parse", "--verify", "--end-of-options", `${input.candidateHead}^{commit}`], source);
  const baseResult = await runGit(["rev-parse", "--verify", "--end-of-options", `${input.candidateBase}^{commit}`], source);
  const candidateCommitVerified = headResult.ok && splitLines(headResult.stdout).length > 0;
  const candidateBaseVerified = baseResult.ok && splitLines(baseResult.stdout).length > 0;

  let candidateTreeId: string | undefined;
  if (!candidateCommitVerified) {
    blockers.push({
      code: "CANDIDATE_COMMIT_MISSING",
      detail: `Candidate commit ${input.candidateHead} does not exist in ${source}.`,
    });
  } else {
    const tree = await runGit(["rev-parse", `${input.candidateHead}^{tree}`], source);
    candidateTreeId = tree.ok ? tree.stdout.trim() || undefined : undefined;
    if (!candidateTreeId) {
      unknowns.push("candidate tree identity could not be read.");
    }
  }
  if (!candidateBaseVerified) {
    blockers.push({
      code: "CANDIDATE_BASE_INVALID",
      detail: `Candidate base ${input.candidateBase} does not exist in ${source}.`,
    });
  }

  let candidateBaseIsAncestor = false;
  let candidateChangedPaths: string[] = [];
  if (candidateCommitVerified && candidateBaseVerified) {
    const ancestor = await runGit(
      ["merge-base", "--is-ancestor", input.candidateBase, input.candidateHead],
      source,
    );
    candidateBaseIsAncestor = ancestor.ok;
    if (!ancestor.ok) {
      blockers.push({
        code: "CANDIDATE_BASE_NOT_ANCESTOR",
        detail: `Candidate base ${input.candidateBase} is not an ancestor of candidate head ${input.candidateHead}.`,
      });
    } else {
      const diffNames = await runGit(
        ["diff", "--name-only", `${input.candidateBase}..${input.candidateHead}`],
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
      ["diff", "--binary", input.candidateBase, input.candidateHead],
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
 * Apply one exact immutable Candidate range onto the destination checkout.
 *
 * Every deterministic gate runs before the first destination mutation, and
 * `git apply` (without --reject) is atomic, so any failure — including one
 * between check and apply — leaves the destination unchanged. Nothing outside
 * the committed range (no untracked workspace files) is ever copied.
 */
export async function integrateCandidate(
  input: CandidateRangeIdentity & { confirmApply?: boolean },
): Promise<IntegrationApplyResult> {
  const readiness = await inspectIntegrationReadiness(input);
  if (!readiness.technicallyReadyToApply) {
    return {
      applied: false,
      appliedRange: { base: input.candidateBase, head: input.candidateHead },
      appliedTrackedFiles: 0,
      blockers: readiness.blockers,
    };
  }
  if (input.confirmApply !== true) {
    return {
      applied: false,
      appliedRange: { base: input.candidateBase, head: input.candidateHead },
      appliedTrackedFiles: 0,
      blockers: [
        {
          code: "INTEGRATION_NOT_EXPRESSIBLE",
          detail: "confirmApply was not set: preparation only, no mutation performed.",
        },
      ],
    };
  }

  const source = canonicalizePath(input.sourceWorkspaceRoot);
  const destination = canonicalizePath(input.destinationWorkspaceRoot);

  const patch = await runGit(
    ["diff", "--binary", input.candidateBase, input.candidateHead],
    source,
  );
  if (!patch.ok || !patch.stdout.trim()) {
    return {
      applied: false,
      appliedRange: { base: input.candidateBase, head: input.candidateHead },
      appliedTrackedFiles: 0,
      blockers: [
        {
          code: "INTEGRATION_NOT_EXPRESSIBLE",
          detail: "Committed Candidate patch could not be produced at apply time.",
        },
      ],
    };
  }

  // Atomic by design: git apply without --reject either lands the whole patch
  // or writes nothing.
  const applied = (
    await runGit(["apply", "--binary", "--whitespace=nowarn", "-"], destination, patch.stdout)
  ).ok;
  if (!applied) {
    return {
      applied: false,
      appliedRange: { base: input.candidateBase, head: input.candidateHead },
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
    appliedRange: { base: input.candidateBase, head: input.candidateHead },
    appliedTrackedFiles: changed.ok ? splitLines(changed.stdout).length : 0,
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
