import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";

const execFileAsync = promisify(execFile);
const REMOTE_FETCH_TIMEOUT_MS = 30_000;

interface GitExecOptions {
  timeoutMs?: number;
  disableTerminalPrompt?: boolean;
}

class GitExecError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number | string,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = "GitExecError";
  }
}

export class GitWorktreeError extends Error {
  constructor(
    readonly code:
      | "GIT_NOT_AVAILABLE"
      | "GIT_REPOSITORY_NOT_FOUND"
      | "GIT_REPOSITORY_HAS_NO_COMMITS"
      | "GIT_INVALID_BASE_REF"
      | "GIT_BASE_REF_NOT_LOCAL"
      | "GIT_REMOTE_NOT_CONFIGURED"
      | "GIT_REMOTE_REF_NOT_FOUND"
      | "GIT_REMOTE_FETCH_FAILED"
      | "GIT_REMOTE_FETCH_TIMEOUT"
      | "GIT_WORKTREE_CREATE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "GitWorktreeError";
  }
}

export interface ManagedWorktree {
  sourceRoot: string;
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

const repoWorktreeLocks = new Map<string, Promise<void>>();

export async function withRepoWorktreeLock<T>(sourceRoot: string, fn: () => Promise<T>): Promise<T> {
  const currentLock = repoWorktreeLocks.get(sourceRoot) ?? Promise.resolve();
  let releaseLock: () => void;
  const newLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const tail = currentLock.then(() => newLock, () => newLock);
  repoWorktreeLocks.set(sourceRoot, tail);
  try {
    await currentLock;
    return await fn();
  } finally {
    releaseLock!();
    if (repoWorktreeLocks.get(sourceRoot) === tail) {
      repoWorktreeLocks.delete(sourceRoot);
    }
  }
}

export function repoWorktreeLockCount(): number {
  return repoWorktreeLocks.size;
}

export async function createManagedWorktree(input: {
  sourcePath: string;
  baseRef?: string;
  config: ServerConfig;
}): Promise<ManagedWorktree> {
  const sourcePath = assertAllowedPath(input.sourcePath, input.config.allowedRoots);

  try {
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isDirectory()) {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_NOT_FOUND",
        `Cannot open workspace in worktree mode because the source path is not a directory: ${input.sourcePath}`,
      );
    }
  } catch (error) {
    if (error instanceof GitWorktreeError) throw error;
    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because the source path does not exist: ${input.sourcePath}`,
    );
  }

  const sourceRoot = await resolveGitRoot(sourcePath, input.config.allowedRoots);
  const baseRef = input.baseRef ?? "HEAD";
  const baseSha = await resolveBaseCommit(sourceRoot, baseRef);
  const dirtySource = (await git(["status", "--porcelain=v1"], sourceRoot)).trim().length > 0;
  const worktreePath = managedWorktreePath({
    worktreeRoot: input.config.worktreeRoot,
    repoRoot: sourceRoot,
  });

  await mkdir(input.config.worktreeRoot, { recursive: true });
  assertAllowedPath(worktreePath, [input.config.worktreeRoot]);

  try {
    await withRepoWorktreeLock(sourceRoot, () =>
      git(["worktree", "add", "--detach", worktreePath, baseSha], sourceRoot),
    );
  } catch (error) {
    await rm(worktreePath, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new GitWorktreeError(
      "GIT_WORKTREE_CREATE_FAILED",
      `Git failed to create the managed worktree. ${message}`,
    );
  }

  try {
    const sourceNodeModules = join(sourceRoot, "node_modules");
    const targetNodeModules = join(worktreePath, "node_modules");
    const nodeModulesStat = await stat(sourceNodeModules).catch(() => null);
    if (nodeModulesStat?.isDirectory()) {
      await symlink(sourceNodeModules, targetNodeModules).catch(() => {});
    }
  } catch {
    // Non-blocking best-effort dependency sharing for probe/verification runs
  }

  return {
    sourceRoot,
    path: worktreePath,
    baseRef,
    baseSha,
    dirtySource,
    detached: true,
    managed: true,
  };
}

async function resolveGitRoot(path: string, allowedRoots: string[]): Promise<string> {
  try {
    const output = await git(["rev-parse", "--show-toplevel"], path);
    return await assertGitRootAllowed(output.trim(), allowedRoots);
  } catch (error) {
    if (isGitUnavailable(error)) {
      throw new GitWorktreeError(
        "GIT_NOT_AVAILABLE",
        "Cannot open workspace in worktree mode because Git is not available on this machine.",
      );
    }

    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because this path is not inside a Git repository: ${path}. Use mode=\"checkout\" to work directly in this directory, or initialize Git and create an initial commit first.`,
    );
  }
}

async function assertGitRootAllowed(gitRoot: string, allowedRoots: string[]): Promise<string> {
  try {
    return assertAllowedPath(gitRoot, allowedRoots);
  } catch {
    const canonicalGitRoot = await realpath(gitRoot);
    for (const allowedRoot of allowedRoots) {
      const canonicalAllowedRoot = await realpath(allowedRoot).catch(() => undefined);
      if (!canonicalAllowedRoot || !isPathInsideRoot(canonicalGitRoot, canonicalAllowedRoot)) {
        continue;
      }

      const logicalGitRoot = resolve(allowedRoot, relative(canonicalAllowedRoot, canonicalGitRoot));
      return assertAllowedPath(logicalGitRoot, allowedRoots);
    }

    return assertAllowedPath(canonicalGitRoot, allowedRoots);
  }
}

async function resolveBaseCommit(sourceRoot: string, baseRef: string): Promise<string> {
  const localSha = await tryRevParse(sourceRoot, baseRef);
  if (localSha) return localSha;

  if (baseRef === "HEAD") {
    throw new GitWorktreeError(
      "GIT_REPOSITORY_HAS_NO_COMMITS",
      "Cannot open workspace in worktree mode because the repository has no commits yet. Create an initial commit first, or use mode=\"checkout\".",
    );
  }

  throw new GitWorktreeError(
    "GIT_BASE_REF_NOT_LOCAL",
    "[GIT_BASE_REF_NOT_LOCAL] Cannot open workspace in worktree mode because baseRef " +
      JSON.stringify(baseRef) +
      " is not present in the local Git ref namespace. Open the repository in checkout mode, call git_fetch_ref explicitly, then retry with the returned localRef.",
  );
}

export interface GitFetchRefResult {
  remote: string;
  branch: string;
  localRef: string;
  previousSha?: string;
  fetchedSha: string;
  changed: boolean;
}

export async function fetchRemoteBranchRef(
  input: {
    sourcePath: string;
    remote: string;
    branch: string;
    config: ServerConfig;
  },
  options: {
    fetchTimeoutMs?: number;
    runFetch?: typeof git;
  } = {},
): Promise<GitFetchRefResult> {
  const sourcePath = assertAllowedPath(input.sourcePath, input.config.allowedRoots);
  const sourceRoot = await resolveGitRoot(sourcePath, input.config.allowedRoots);
  const remote = input.remote.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(remote) || remote.startsWith("-")) {
    throw new GitWorktreeError(
      "GIT_REMOTE_NOT_CONFIGURED",
      "[GIT_REMOTE_NOT_CONFIGURED] Invalid Git remote name: " + JSON.stringify(input.remote) + ".",
    );
  }

  const configuredRemotes = (await git(["remote"], sourceRoot))
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!configuredRemotes.includes(remote)) {
    throw new GitWorktreeError(
      "GIT_REMOTE_NOT_CONFIGURED",
      "[GIT_REMOTE_NOT_CONFIGURED] Git remote " + JSON.stringify(remote) + " is not configured for this repository.",
    );
  }

  let branch = input.branch.trim();
  if (branch.startsWith("refs/heads/")) branch = branch.slice("refs/heads/".length);
  const remotePrefix = remote + "/";
  const remoteRefPrefix = "refs/remotes/" + remote + "/";
  if (branch.startsWith(remoteRefPrefix)) branch = branch.slice(remoteRefPrefix.length);
  else if (branch.startsWith(remotePrefix)) branch = branch.slice(remotePrefix.length);

  if (!branch || branch.startsWith("-")) {
    throw new GitWorktreeError(
      "GIT_REMOTE_REF_NOT_FOUND",
      "[GIT_REMOTE_REF_NOT_FOUND] Invalid remote branch: " + JSON.stringify(input.branch) + ".",
    );
  }
  try {
    await git(["check-ref-format", "--branch", branch], sourceRoot);
  } catch {
    throw new GitWorktreeError(
      "GIT_REMOTE_REF_NOT_FOUND",
      "[GIT_REMOTE_REF_NOT_FOUND] Invalid remote branch: " + JSON.stringify(input.branch) + ".",
    );
  }

  const localRef = "refs/remotes/" + remote + "/" + branch;
  const previousSha = (await tryRevParse(sourceRoot, localRef)) ?? undefined;
  const runFetch = options.runFetch ?? git;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? REMOTE_FETCH_TIMEOUT_MS;
  try {
    await withRepoWorktreeLock(sourceRoot, () =>
      runFetch(
        [
          "fetch",
          "--depth=1",
          "--no-tags",
          remote,
          "+refs/heads/" + branch + ":" + localRef,
        ],
        sourceRoot,
        {
          timeoutMs: fetchTimeoutMs,
          disableTerminalPrompt: true,
        },
      ),
    );
  } catch (error) {
    if (isGitTimeout(error)) {
      throw new GitWorktreeError(
        "GIT_REMOTE_FETCH_TIMEOUT",
        "[GIT_REMOTE_FETCH_TIMEOUT] Timed out while fetching remote branch " +
          JSON.stringify(branch) + " from configured remote " + JSON.stringify(remote) + ".",
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/couldn['’]t find remote ref|remote ref .* not found/i.test(message)) {
      throw new GitWorktreeError(
        "GIT_REMOTE_REF_NOT_FOUND",
        "[GIT_REMOTE_REF_NOT_FOUND] Remote branch " + JSON.stringify(branch) +
          " does not exist on configured remote " + JSON.stringify(remote) + ".",
      );
    }
    throw new GitWorktreeError(
      "GIT_REMOTE_FETCH_FAILED",
      "[GIT_REMOTE_FETCH_FAILED] Could not fetch remote branch " + JSON.stringify(branch) +
        " from configured remote " + JSON.stringify(remote) +
        ". Check network/authentication and retry the exact fetch.",
    );
  }

  const fetchedSha = await tryRevParse(sourceRoot, localRef);
  if (!fetchedSha) {
    throw new GitWorktreeError(
      "GIT_REMOTE_REF_NOT_FOUND",
      "[GIT_REMOTE_REF_NOT_FOUND] Fetched remote branch " + JSON.stringify(branch) + " did not resolve to a commit.",
    );
  }

  return {
    remote,
    branch,
    localRef,
    previousSha,
    fetchedSha,
    changed: previousSha !== fetchedSha,
  };
}

async function tryRevParse(sourceRoot: string, ref: string): Promise<string | null> {
  try {
    const sha = (await git(["rev-parse", "--verify", `${ref}^{commit}`], sourceRoot)).trim();
    return sha || null;
  } catch {
    return null;
  }
}


function managedWorktreePath(input: { worktreeRoot: string; repoRoot: string }): string {
  const repoName = sanitizePathSegment(basename(input.repoRoot)) || "repo";
  const worktreeId = randomBytes(4).toString("hex");
  return join(input.worktreeRoot, `${repoName}-${worktreeId}`);
}

function sanitizePathSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function git(args: string[], cwd: string, options: GitExecOptions = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      env: options.disableTerminalPrompt
        ? { ...process.env, GIT_TERMINAL_PROMPT: "0" }
        : process.env,
    });
    return stdout;
  } catch (error) {
    if (isGitUnavailable(error)) throw error;

    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const stdout = typeof error === "object" && error && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "").trim()
      : "";
    const details = stderr || stdout || (error instanceof Error ? error.message : String(error));
    const exitCode = typeof error === "object" && error && "code" in error
      ? (error as { code?: number | string }).code
      : undefined;
    const timedOut = Boolean(
      typeof error === "object" &&
      error &&
      (("killed" in error && (error as { killed?: unknown }).killed === true) ||
        exitCode === "ETIMEDOUT"),
    );
    throw new GitExecError(details, exitCode, timedOut);
  }
}

function isGitTimeout(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
    error &&
    (("timedOut" in error && (error as { timedOut?: unknown }).timedOut === true) ||
      ("killed" in error && (error as { killed?: unknown }).killed === true) ||
      ("code" in error && (error as { code?: unknown }).code === "ETIMEDOUT")),
  );
}

function isGitUnavailable(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}
