import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PathStateFingerprint, ScopeBaseline, ScopeState } from "./local-agent-contract.js";

/**
 * Read-only physical Git/workspace inspection used by preflight, status, and
 * reconcile. This is observability only: it never mutates repository state and
 * it grants no acceptance authority.
 */

export interface WorkspacePhysicalState {
  gitAvailable: boolean;
  head?: string;
  dirty: boolean;
  /** Workspace-relative changed paths (tracked + untracked), sorted. */
  changedPaths: string[];
  /**
   * Per-path physical fingerprints keyed by workspace-relative changed path.
   * Present whenever `changedPaths` is non-empty and the workspace is a Git
   * repository; each entry distinguishes modified/untracked/deleted and
   * carries a deterministic content hash. The map may be partial: paths that
   * cannot be safely fingerprinted (e.g. ones resolving outside the workspace
   * root) are skipped entirely.
   */
  fingerprints?: Record<string, PathStateFingerprint>;
  /** Stable hash over the combined diff + untracked file names. */
  diffHash?: string;
  /** Maximum mtime (epoch ms) among changed files, when known. */
  lastFileMutationAt?: number;
}

interface GitExecResult {
  ok: boolean;
  stdout: string;
}

const GIT_TIMEOUT_MS = 5_000;

function runGit(args: string[], cwd: string): Promise<GitExecResult> {
  return new Promise((resolvePromise) => {
    let completed = false;
    let timer: NodeJS.Timeout | undefined;
    const child = execFile(
      "git",
      args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (completed) return;
        completed = true;
        if (timer) clearTimeout(timer);
        resolvePromise({ ok: !error, stdout: stdout ?? "" });
      },
    );
    timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
      resolvePromise({ ok: false, stdout: "" });
    }, GIT_TIMEOUT_MS);
  });
}

export function isInsideGitRepository(workspaceRoot: string): Promise<boolean> {
  return runGit(["rev-parse", "--is-inside-work-tree"], workspaceRoot).then((result) => result.ok);
}

/**
 * Read the current HEAD SHA for a workspace root, or undefined when the
 * workspace is not a Git repository or Git is unavailable.
 */
export async function readWorkspaceHead(workspaceRoot: string): Promise<string | undefined> {
  const result = await runGit(["rev-parse", "HEAD"], workspaceRoot);
  return result.ok && result.stdout.trim() ? result.stdout.trim() : undefined;
}

/**
 * Resolve the Git toplevel for a workspace root (empty string when unavailable).
 */
export async function gitTopLevel(workspaceRoot: string): Promise<string | undefined> {
  const result = await runGit(["rev-parse", "--show-toplevel"], workspaceRoot);
  return result.ok && result.stdout.trim() ? result.stdout.trim() : undefined;
}

/**
 * Convert a repo-root-relative git path into a workspace-relative path.
 * Returns undefined when the path escapes the workspace root (treated as an
 * out-of-scope marker by callers).
 */
function workspaceRelativePath(gitRoot: string, workspaceRoot: string, gitPath: string): string {
  const absGitRoot = canonicalizePath(gitRoot);
  const absWorkspace = canonicalizePath(workspaceRoot);
  const abs = resolve(absGitRoot, gitPath);
  if (absGitRoot === absWorkspace) return gitPath;
  const rel = relative(absWorkspace, abs);
  return rel === "" ? "." : rel;
}

function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export async function inspectWorkspacePhysicalState(workspaceRoot: string): Promise<WorkspacePhysicalState> {
  const gitAvailable = await isInsideGitRepository(workspaceRoot);
  if (!gitAvailable) {
    return { gitAvailable, dirty: false, changedPaths: [] };
  }

  const gitRoot = await gitTopLevel(workspaceRoot);
  const state: WorkspacePhysicalState = { gitAvailable: true, dirty: false, changedPaths: [] };

  const headResult = await runGit(["rev-parse", "HEAD"], workspaceRoot);
  if (headResult.ok && headResult.stdout.trim()) {
    state.head = headResult.stdout.trim();
  }

  const trackedDiff = await runGit(["diff", "--name-only"], workspaceRoot);
  const stagedDiff = await runGit(["diff", "--cached", "--name-only"], workspaceRoot);
  const untrackedResult = await runGit(["ls-files", "--others", "--exclude-standard"], workspaceRoot);

  const tracked = splitLines(`${trackedDiff.stdout}\n${stagedDiff.stdout}`);
  const untracked = splitLines(untrackedResult.stdout);
  state.dirty = tracked.length > 0 || untracked.length > 0;

  if (gitRoot) {
    const seen = new Map<string, string>();
    const trackedRels = new Set<string>();
    const untrackedRels = new Set<string>();
    for (const path of tracked) {
      const rel = workspaceRelativePath(gitRoot, workspaceRoot, path);
      trackedRels.add(rel);
      seen.set(rel, rel);
    }
    for (const path of untracked) {
      const rel = workspaceRelativePath(gitRoot, workspaceRoot, path);
      untrackedRels.add(rel);
      seen.set(rel, rel);
    }
    state.changedPaths = Array.from(seen.values()).sort();
    state.fingerprints = await computePathFingerprints(
      workspaceRoot,
      state.changedPaths,
      trackedRels,
      untrackedRels,
    );
  } else {
    state.changedPaths = Array.from(new Set([...tracked, ...untracked])).sort();
  }

  const diffHash = await computeDiffHash(workspaceRoot, state.changedPaths);
  if (diffHash) state.diffHash = diffHash;

  if (state.changedPaths.length > 0) {
    const workspaceResolved = resolve(workspaceRoot);
    let latest = 0;
    for (const rel of state.changedPaths) {
      const candidate = resolve(workspaceResolved, rel);
      if (!isContainedWithin(workspaceResolved, candidate)) {
        // Path escapes the workspace root: never stat it.
        continue;
      }
      try {
        const info = await lstat(candidate);
        if (info.mtimeMs > latest) latest = info.mtimeMs;
      } catch {
        // path may have been deleted
      }
    }
    if (latest > 0) state.lastFileMutationAt = Math.floor(latest);
  }

  return state;
}

/**
 * Read-only per-path fingerprints captured from the FINAL physical state of
 * each dirty path. Kind is derived from the Git tracked/untracked sets plus
 * filesystem existence: tracked + present -> "modified", tracked + absent ->
 * "deleted", untracked -> "untracked". Deterministic because it iterates the
 * sorted changedPaths in order and hashes file bytes.
 *
 * Containment is enforced before any filesystem read: a path that resolves
 * outside the workspace root (e.g. via a `..` segment) is skipped entirely and
 * the returned map is left partial so attribution degrades to UNKNOWN. Symbolic
 * links are never followed; their link-target text is hashed instead.
 */
async function computePathFingerprints(
  workspaceRoot: string,
  changedPaths: string[],
  trackedRels: Set<string>,
  untrackedRels: Set<string>,
): Promise<Record<string, PathStateFingerprint>> {
  const fingerprints: Record<string, PathStateFingerprint> = {};
  const workspaceResolved = resolve(workspaceRoot);
  for (const rel of changedPaths) {
    const candidate = resolve(workspaceResolved, rel);
    if (!isContainedWithin(workspaceResolved, candidate)) {
      // Path escapes the workspace root: never read it, skip its fingerprint.
      continue;
    }
    const gitStateHash = await computePathGitStateHash(workspaceRoot, rel);
    if (gitStateHash === undefined) {
      // Git state could not be read fully: skip so coverage is partial and
      // attribution degrades to UNKNOWN instead of falsely KNOWN.
      continue;
    }
    let kind: PathStateFingerprint["kind"];
    let contentHash: string | null = null;
    let size = 0;
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) {
        // Do not follow the link target; hash the link target text itself.
        const target = await readlink(candidate);
        kind = untrackedRels.has(rel) ? "untracked" : "modified";
        contentHash = createHash("sha256").update(target).digest("hex");
        size = Buffer.byteLength(target, "utf8");
      } else if (info.isFile()) {
        const content = await readFile(candidate);
        // Tracked path present on disk -> modified; untracked -> untracked.
        kind = untrackedRels.has(rel) ? "untracked" : "modified";
        contentHash = createHash("sha256").update(content).digest("hex");
        size = content.length;
      } else {
        // Non-regular, non-symlink entries have no file bytes to hash; leave
        // coverage partial so attribution degrades to UNKNOWN.
        continue;
      }
    } catch {
      // Absent on disk -> deleted for tracked paths (untracked paths normally exist).
      kind = trackedRels.has(rel) ? "deleted" : "untracked";
    }
    fingerprints[rel] = { kind, contentHash, size, gitStateHash };
  }
  return fingerprints;
}

/**
 * True when `candidate` is an absolute path strictly inside `root` (or the root
 * itself), never escaping via a `..` segment.
 */
function isContainedWithin(root: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Deterministic SHA-256 over the exact path's Git state: worktree diff, staged
 * diff, and index stage entry. Includes labeled separators so the concatenated
 * outputs cannot be misparsed, and the per-path `--` argument keeps the path
 * out of flag parsing. Used to detect index-only/mode mutations that byte
 * hashing of the working-tree file would miss. Returns undefined when any
 * required Git call fails or times out so a partial hash is never produced.
 */
async function computePathGitStateHash(workspaceRoot: string, rel: string): Promise<string | undefined> {
  const diff = await runGit(["diff", "--binary", "--", rel], workspaceRoot);
  if (!diff.ok) return undefined;
  const staged = await runGit(["diff", "--cached", "--binary", "--", rel], workspaceRoot);
  if (!staged.ok) return undefined;
  const indexEntry = await runGit(["ls-files", "--stage", "--", rel], workspaceRoot);
  if (!indexEntry.ok) return undefined;
  const hash = createHash("sha256");
  hash.update("diff:");
  hash.update(diff.stdout);
  hash.update("\0");
  hash.update("staged:");
  hash.update(staged.stdout);
  hash.update("\0");
  hash.update("stage:");
  hash.update(indexEntry.stdout);
  hash.update("\0");
  return hash.digest("hex");
}

async function computeDiffHash(
  workspaceRoot: string,
  changedPaths: string[],
): Promise<string | undefined> {
  if (changedPaths.length === 0) return undefined;
  const hash = createHash("sha256");

  const diff = await runGit(["diff"], workspaceRoot);
  hash.update(diff.stdout);
  const staged = await runGit(["diff", "--cached"], workspaceRoot);
  hash.update(staged.stdout);
  for (const path of changedPaths) {
    hash.update(path);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Determine scope compliance for a set of worker-caused changed paths against
 * the intended write scope.
 *
 * - No writePaths bound -> UNKNOWN (scope was not claimed).
 * - All worker-caused changes inside writePaths -> WITHIN_SCOPE.
 * - Any change outside writePaths -> SCOPE_VIOLATION with the offending paths.
 */
export function classifyScopeState(
  workerChangedPaths: string[],
  writePaths: string[] | undefined,
): { scopeState: ScopeState; unexpectedPaths: string[] } {
  if (!writePaths || writePaths.length === 0) {
    return { scopeState: "UNKNOWN", unexpectedPaths: [] };
  }

  const allowed = writePaths.map(normalizeScopePath);
  const unexpected: string[] = [];
  for (const path of workerChangedPaths) {
    const normalized = normalizeScopePath(path);
    if (normalized === "." || !isWithinScope(normalized, allowed)) {
      unexpected.push(path);
    }
  }

  return {
    scopeState: unexpected.length > 0 ? "SCOPE_VIOLATION" : "WITHIN_SCOPE",
    unexpectedPaths: unexpected,
  };
}

function isWithinScope(normalizedPath: string, allowed: string[]): boolean {
  return allowed.some((entry) => normalizedPath === entry || normalizedPath.startsWith(`${entry}/`));
}

/**
 * Subtract a baseline snapshot so pre-existing workspace changes are not
 * attributed to the worker.
 */
export function workerChangedPathsSinceBaseline(
  currentPaths: string[],
  baselinePaths: string[] | undefined,
): string[] {
  const baseline = new Set((baselinePaths ?? []).map(normalizeScopePath));
  return currentPaths.filter((path) => !baseline.has(normalizeScopePath(path)));
}

/** Certainty of worker attribution for a delta computed from a baseline. */
export type WorkerAttribution = "KNOWN" | "UNKNOWN";

/**
 * Structured baseline-to-current worker delta. `changedPaths` holds paths that
 * are definitely attributable to the worker; `attribution` records whether the
 * delta is complete (`KNOWN`) or may under-report overlap/disappearance
 * (`UNKNOWN`) when the baseline cannot fully disambiguate.
 */
export interface WorkerDelta {
  changedPaths: string[];
  attribution: WorkerAttribution;
}

/**
 * Compute the definite worker-caused delta between a baseline snapshot and the
 * current physical workspace state.
 *
 * - No baseline -> UNKNOWN, no paths claimed.
 * - Baseline with empty `changedPaths` -> KNOWN, every current dirty path is
 *   worker-caused.
 * - Baseline whose `changedPaths` is not fully covered by valid fingerprints ->
 *   UNKNOWN. Missing fingerprints mean overlap/disappearance cannot be
 *   distinguished truthfully, but definitely attributable paths are still
 *   reported: current paths not dirty at baseline, and baseline paths that have
 *   a fingerprint and differ or disappeared.
 * - Baseline where every `changedPaths` entry has a valid fingerprint -> KNOWN.
 */
export function computeWorkerDelta(
  current: WorkspacePhysicalState,
  baseline: ScopeBaseline | undefined,
): WorkerDelta {
  const currentPaths = [...(current.changedPaths ?? [])].sort();
  const currentSet = new Set(currentPaths);
  const currentFingerprints = current.fingerprints ?? {};

  if (!baseline) {
    return { changedPaths: [], attribution: "UNKNOWN" };
  }

  const baselinePaths = [...(baseline.changedPaths ?? [])].sort();
  const baselineSet = new Set(baselinePaths);

  if (baselinePaths.length === 0) {
    return { changedPaths: currentPaths, attribution: "KNOWN" };
  }

  const baselineFingerprints = baseline.fingerprints ?? {};
  const baselineByPath = new Map<string, PathStateFingerprint>();
  for (const path of baselinePaths) {
    const fingerprint = baselineFingerprints[path];
    // A baseline fingerprint is complete only when it carries the Git-state
    // hash; legacy rows lacking it cannot disambiguate, so they stay out of
    // baselineByPath and attribution degrades to UNKNOWN.
    if (fingerprint && typeof fingerprint.gitStateHash === "string" && fingerprint.gitStateHash.length > 0) {
      baselineByPath.set(path, fingerprint);
    }
  }

  // Attribution is KNOWN only when every baseline path has a valid fingerprint
  // and every overlapping baseline/current path needed for comparison also has
  // a complete current fingerprint.
  let fullyAttributable = baselineByPath.size === baselinePaths.length;

  const changed = new Set<string>();
  for (const path of currentPaths) {
    if (!baselineSet.has(path)) {
      // Newly dirty after baseline: definite by path appearance; a missing
      // current fingerprint does not erase that fact.
      changed.add(path);
      continue;
    }
    const baselineFingerprint = baselineByPath.get(path);
    if (!baselineFingerprint) {
      // Baseline path missing a fingerprint: do not guess whether it changed.
      continue;
    }
    const currentFingerprint = currentFingerprints[path];
    if (!isCompleteFingerprint(currentFingerprint)) {
      // Overlap where the current fingerprint is missing/incomplete: cannot
      // prove whether the worker changed it, so it is not definite and the
      // delta cannot claim full attribution.
      fullyAttributable = false;
      continue;
    }
    if (!fingerprintsEqual(currentFingerprint, baselineFingerprint)) {
      changed.add(path);
    }
  }
  // Baseline dirty paths no longer current: definite only when fingerprinted
  // at baseline; disappearance is observable without a current fingerprint.
  for (const path of baselinePaths) {
    if (!currentSet.has(path) && baselineByPath.has(path)) changed.add(path);
  }

  return {
    changedPaths: [...changed].sort(),
    attribution: fullyAttributable ? "KNOWN" : "UNKNOWN",
  };
}

function isCompleteFingerprint(fingerprint: PathStateFingerprint | undefined): boolean {
  return (
    fingerprint !== undefined &&
    typeof fingerprint.gitStateHash === "string" &&
    fingerprint.gitStateHash.length > 0
  );
}

function fingerprintsEqual(a: PathStateFingerprint, b: PathStateFingerprint): boolean {
  return (
    a.kind === b.kind &&
    a.contentHash === b.contentHash &&
    a.size === b.size &&
    a.gitStateHash === b.gitStateHash
  );
}

function normalizeScopePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/$/, "");
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
