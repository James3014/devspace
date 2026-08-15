import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { relative, resolve, join } from "node:path";
import type { ScopeState } from "./local-agent-contract.js";

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
    for (const path of [...tracked, ...untracked]) {
      const rel = workspaceRelativePath(gitRoot, workspaceRoot, path);
      seen.set(rel, rel);
    }
    state.changedPaths = Array.from(seen.values()).sort();
  } else {
    state.changedPaths = Array.from(new Set([...tracked, ...untracked])).sort();
  }

  const diffHash = await computeDiffHash(workspaceRoot, state.changedPaths);
  if (diffHash) state.diffHash = diffHash;

  if (state.changedPaths.length > 0) {
    const workspaceResolved = resolve(workspaceRoot);
    let latest = 0;
    for (const rel of state.changedPaths) {
      try {
        const info = await stat(join(workspaceResolved, rel));
        if (info.mtimeMs > latest) latest = info.mtimeMs;
      } catch {
        // path may have been deleted
      }
    }
    if (latest > 0) state.lastFileMutationAt = Math.floor(latest);
  }

  return state;
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

function normalizeScopePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/$/, "");
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
