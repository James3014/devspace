import { execFile } from "node:child_process";
import { resolve, isAbsolute, normalize } from "node:path";
import { realpathSync } from "node:fs";

export interface GitCommitOutput {
  workspaceId: string;
  previousHead: string;
  commitSha: string;
  treeSha: string;
  message: string;
  paths: string[];
  detached: boolean;
  created: true;
}

// Custom error codes matching spec requirements
export type GitCandidateErrorCode =
  | "GIT_MANAGED_WORKTREE_REQUIRED"
  | "GIT_HEAD_MISMATCH"
  | "GIT_INDEX_NOT_CLEAN"
  | "GIT_NOTHING_TO_COMMIT"
  | "GIT_PROTECTED_BRANCH"
  | "GIT_INVALID_PATH"
  | "GIT_STAGING_VIOLATION"
  | "GIT_EXECUTION_ERROR";

export class GitCandidateError extends Error {
  constructor(
    readonly code: GitCandidateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitCandidateError";
  }
}

/**
 * Filter sensitive environment variables before passing to Git.
 */
export function gitCommandEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  const keysToRemove = [
    "DEVSPACE_OAUTH_OWNER_TOKEN",
    "DEVSPACE_OAUTH_SCOPES",
  ];
  for (const key of keysToRemove) {
    delete next[key];
  }
  for (const key of Object.keys(next)) {
    const upper = key.toUpperCase();
    if (
      upper.startsWith("DEVSPACE_") &&
      (upper.includes("TOKEN") ||
       upper.includes("SECRET") ||
       upper.includes("AUTH") ||
       upper.includes("KEY") ||
       upper.includes("PASSWORD"))
    ) {
      delete next[key];
    }
  }
  return next;
}

/**
 * Execute a git command using execFile with terminal prompts disabled and bounded timeout.
 */
async function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number = 10000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let completed = false;
    const cleanEnv = gitCommandEnvironment(process.env);
    cleanEnv.GIT_TERMINAL_PROMPT = "0";

    const child = execFile(
      "git",
      args,
      {
        cwd,
        env: cleanEnv,
        detached: true, // create a process group
      } as any,
      (error: any, stdout: any, stderr: any) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);

        if (error) {
          const message = stderr?.trim() || error.message || String(error);
          rejectPromise(
            new GitCandidateError(
              "GIT_EXECUTION_ERROR",
              `Git command failed: git ${args.join(" ")}. Error: ${message}`,
            ),
          );
        } else {
          resolvePromise({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          });
        }
      },
    );

    const timer = setTimeout(() => {
      if (completed) return;
      completed = true;

      // Kill the entire process group
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (err) {
          // ignore if process already gone
        }
      }
      rejectPromise(
        new GitCandidateError(
          "GIT_EXECUTION_ERROR",
          `Git command timed out after ${timeoutMs}ms: git ${args.join(" ")}`,
        ),
      );
    }, timeoutMs);
  });
}

/**
 * Validate paths list for commit staging.
 */
function validatePaths(paths: string[]): void {
  if (!paths || paths.length === 0) {
    throw new GitCandidateError("GIT_INVALID_PATH", "Staging paths list cannot be empty.");
  }
  if (paths.length > 100) {
    throw new GitCandidateError("GIT_INVALID_PATH", "Staging paths list exceeds maximum of 100 items.");
  }

  for (const p of paths) {
    if (!p) {
      throw new GitCandidateError("GIT_INVALID_PATH", "Staging path cannot be empty.");
    }
    if (p === ".") {
      throw new GitCandidateError("GIT_INVALID_PATH", "Staging path '.' is not allowed.");
    }
    if (isAbsolute(p) || p.startsWith("/") || p.startsWith("\\")) {
      throw new GitCandidateError("GIT_INVALID_PATH", `Absolute path is not allowed: ${p}`);
    }
    if (p.includes("\0")) {
      throw new GitCandidateError("GIT_INVALID_PATH", `Path contains NUL character: ${p}`);
    }

    // Normalize path to verify it does not escape root (no .. escaping)
    const normalized = normalize(p);
    if (normalized.startsWith("..") || normalized.includes("../") || normalized.includes("..\\")) {
      throw new GitCandidateError("GIT_INVALID_PATH", `Path escapes workspace root: ${p}`);
    }

    // Prevent Git pathspec magic injection
    if (p.startsWith(":")) {
      throw new GitCandidateError("GIT_INVALID_PATH", `Path spec magic prefix ':' is not allowed: ${p}`);
    }
  }
}

/**
 * Create a candidate commit from exactly specified paths inside a managed worktree.
 */
export async function commitCandidate(options: {
  workspaceId: string;
  workspaceRoot: string;
  expectedHead: string;
  message: string;
  paths: string[];
}): Promise<GitCommitOutput> {
  const { workspaceId, workspaceRoot, expectedHead, message, paths } = options;

  // 1. Basic expected HEAD validation (40-char SHA1)
  if (!/^[0-9a-fA-F]{40}$/.test(expectedHead)) {
    throw new GitCandidateError("GIT_HEAD_MISMATCH", `Invalid expectedHead format: ${expectedHead}`);
  }

  // 2. Validate paths inputs
  validatePaths(paths);

  // 3. Verify physical git toplevel equals workspaceRoot (canonicalized paths)
  let resolvedWorkspaceRoot = "";
  try {
    resolvedWorkspaceRoot = realpathSync(workspaceRoot);
  } catch (err) {
    throw new GitCandidateError("GIT_MANAGED_WORKTREE_REQUIRED", `Workspace root path is invalid or non-existent: ${workspaceRoot}`);
  }

  let toplevel = "";
  try {
    const { stdout } = await runGit(["rev-parse", "--show-toplevel"], resolvedWorkspaceRoot, 10000);
    toplevel = realpathSync(resolve(stdout));
  } catch (err) {
    throw new GitCandidateError("GIT_MANAGED_WORKTREE_REQUIRED", "Workspace root is not a Git repository.");
  }

  if (resolvedWorkspaceRoot !== toplevel) {
    throw new GitCandidateError(
      "GIT_MANAGED_WORKTREE_REQUIRED",
      `Workspace root '${resolvedWorkspaceRoot}' does not match physical Git toplevel '${toplevel}'`,
    );
  }

  // 4. Verify current HEAD matches expectedHead
  let currentHead = "";
  try {
    const { stdout } = await runGit(["rev-parse", "HEAD"], resolvedWorkspaceRoot, 10000);
    currentHead = stdout;
  } catch (err) {
    throw new GitCandidateError("GIT_HEAD_MISMATCH", "Failed to resolve current Git HEAD.");
  }

  if (currentHead !== expectedHead) {
    throw new GitCandidateError(
      "GIT_HEAD_MISMATCH",
      `Git HEAD mismatch. Expected: ${expectedHead}, Current: ${currentHead}`,
    );
  }

  // 5. Verify index is clean before staging (git diff --cached --quiet)
  let indexClean = true;
  try {
    await runGit(["diff", "--cached", "--quiet"], resolvedWorkspaceRoot, 10000);
  } catch (err) {
    indexClean = false;
  }

  if (!indexClean) {
    throw new GitCandidateError("GIT_INDEX_NOT_CLEAN", "Pre-existing staged changes detected in index.");
  }

  // 6. Format paths as literal pathspecs internally to block wildcards / regex expansion
  // e.g. :(literal)path/to/file
  const literalPathspecs = paths.map((p) => `:(literal)${p}`);

  // Stage changes exactly
  try {
    await runGit(["add", "--", ...literalPathspecs], resolvedWorkspaceRoot, 10000);
  } catch (err: any) {
    throw new GitCandidateError("GIT_EXECUTION_ERROR", `Failed to stage requested paths: ${err.message}`);
  }

  // 7. Verify only requested paths are staged
  let stagedFiles: string[] = [];
  try {
    const { stdout } = await runGit(["diff", "--cached", "--name-only", "-z"], resolvedWorkspaceRoot, 10000);
    stagedFiles = stdout ? stdout.split("\0").filter(Boolean) : [];
  } catch (err) {
    throw new GitCandidateError("GIT_EXECUTION_ERROR", "Failed to inspect staged index.");
  }

  // Check if anything is staged
  if (stagedFiles.length === 0) {
    throw new GitCandidateError("GIT_NOTHING_TO_COMMIT", "No changes staged. Nothing to commit.");
  }

  // Normalize paths for matching
  const normalizedPaths = new Set(paths.map((p) => normalize(p)));
  const violations: string[] = [];

  for (const file of stagedFiles) {
    if (!normalizedPaths.has(normalize(file))) {
      violations.push(file);
    }
  }

  if (violations.length > 0) {
    throw new GitCandidateError(
      "GIT_STAGING_VIOLATION",
      `Staging violation: unexpected file(s) staged: ${violations.join(", ")}`,
    );
  }

  // 8. Enforce git diff --cached --check before committing
  try {
    await runGit(["diff", "--cached", "--check"], resolvedWorkspaceRoot, 10000);
  } catch (err: any) {
    throw new GitCandidateError("GIT_EXECUTION_ERROR", `Git diff check failed: ${err.message}`);
  }

  // 8.5 Re-verify HEAD matches expectedHead immediately before commit
  let preCommitHead = "";
  try {
    const { stdout } = await runGit(["rev-parse", "HEAD"], resolvedWorkspaceRoot, 10000);
    preCommitHead = stdout;
  } catch (err) {
    throw new GitCandidateError("GIT_HEAD_MISMATCH", "Failed to re-resolve current Git HEAD before commit.");
  }

  if (preCommitHead !== expectedHead) {
    throw new GitCandidateError(
      "GIT_HEAD_MISMATCH",
      `Git HEAD mismatch immediately before commit. Expected: ${expectedHead}, Current: ${preCommitHead}`,
    );
  }

  // 9. Execute commit without bypassing hooks
  try {
    await runGit(["commit", "-m", message], resolvedWorkspaceRoot, 30000);
  } catch (err: any) {
    throw new GitCandidateError("GIT_EXECUTION_ERROR", `Git commit failed: ${err.message}`);
  }

  // 10. Fetch new HEAD & Tree SHAs and verify parent
  let newHead = "";
  let treeSha = "";
  try {
    const { stdout: headOut } = await runGit(["rev-parse", "HEAD"], resolvedWorkspaceRoot, 10000);
    newHead = headOut;
    const { stdout: treeOut } = await runGit(["rev-parse", "HEAD^{tree}"], resolvedWorkspaceRoot, 10000);
    treeSha = treeOut;
  } catch (err) {
    throw new GitCandidateError("GIT_EXECUTION_ERROR", "Failed to resolve new Git HEAD after commit.");
  }

  if (newHead === expectedHead) {
    throw new GitCandidateError("GIT_EXECUTION_ERROR", `Git HEAD did not advance after commit. HEAD remains at ${expectedHead}`);
  }

  let parentHead = "";
  try {
    const { stdout } = await runGit(["rev-parse", "HEAD^1"], resolvedWorkspaceRoot, 10000);
    parentHead = stdout;
  } catch (err) {
    throw new GitCandidateError("GIT_EXECUTION_ERROR", "Failed to verify commit parent SHA.");
  }

  if (parentHead !== expectedHead) {
    throw new GitCandidateError(
      "GIT_EXECUTION_ERROR",
      `Commit parent verification failed. Parent is ${parentHead}, expected ${expectedHead}`,
    );
  }

  // Determine if detached HEAD
  let detached = false;
  try {
    await runGit(["symbolic-ref", "-q", "HEAD"], resolvedWorkspaceRoot, 10000);
  } catch {
    detached = true;
  }

  return {
    workspaceId,
    previousHead: expectedHead,
    commitSha: newHead,
    treeSha,
    message,
    paths,
    detached,
    created: true,
  };
}

/**
 * Publish candidate HEAD from a managed worktree to a non-default remote branch.
 */
export async function pushCandidate(options: {
  workspaceRoot: string;
  expectedHead: string;
  remote: string;
  branch: string;
}): Promise<{ remote: string; branch: string; pushedSha: string }> {
  const { workspaceRoot, expectedHead, remote, branch } = options;

  // 1. Basic expected HEAD validation
  if (!/^[0-9a-fA-F]{40}$/.test(expectedHead)) {
    throw new GitCandidateError("GIT_HEAD_MISMATCH", `Invalid expectedHead format: ${expectedHead}`);
  }

  // 1.5 Canonicalize path
  let resolvedWorkspaceRoot = "";
  try {
    resolvedWorkspaceRoot = realpathSync(workspaceRoot);
  } catch (err) {
    throw new GitCandidateError("GIT_MANAGED_WORKTREE_REQUIRED", `Workspace root path is invalid or non-existent: ${workspaceRoot}`);
  }

  // 2. Verify current HEAD matches expectedHead
  let currentHead = "";
  try {
    const { stdout } = await runGit(["rev-parse", "HEAD"], resolvedWorkspaceRoot, 10000);
    currentHead = stdout;
  } catch (err) {
    throw new GitCandidateError("GIT_HEAD_MISMATCH", "Failed to resolve current Git HEAD.");
  }

  if (currentHead !== expectedHead) {
    throw new GitCandidateError(
      "GIT_HEAD_MISMATCH",
      `Git HEAD mismatch. Expected: ${expectedHead}, Current: ${currentHead}`,
    );
  }

  // 3. Verify worktree/index tracked state is clean
  // Verify no unstaged tracked changes
  let hasUnstaged = false;
  try {
    await runGit(["diff", "--quiet"], resolvedWorkspaceRoot, 10000);
  } catch {
    hasUnstaged = true;
  }

  // Verify no staged changes
  let hasStaged = false;
  try {
    await runGit(["diff", "--cached", "--quiet"], resolvedWorkspaceRoot, 10000);
  } catch {
    hasStaged = true;
  }

  // Verify no untracked files
  let hasUntracked = false;
  try {
    const { stdout } = await runGit(["status", "--porcelain"], resolvedWorkspaceRoot, 10000);
    if (stdout.split("\n").some((line) => line.startsWith("??"))) {
      hasUntracked = true;
    }
  } catch {}

  if (hasUnstaged || hasStaged || hasUntracked) {
    const details = [
      hasStaged ? "staged changes" : "",
      hasUnstaged ? "unstaged changes" : "",
      hasUntracked ? "untracked files" : "",
    ].filter(Boolean).join(", ");
    throw new GitCandidateError(
      "GIT_INDEX_NOT_CLEAN",
      `Worktree contains uncommitted changes or untracked files: ${details}`,
    );
  }

  // 4. Remote validation
  // Prevent option injection
  if (remote.startsWith("-")) {
    throw new GitCandidateError("GIT_EXECUTION_ERROR", `Invalid remote name: ${remote}`);
  }

  // Verify remote is not a raw URL
  if (
    remote.includes("://") ||
    remote.startsWith("git@") ||
    remote.includes("@") ||
    remote.startsWith("file:")
  ) {
    throw new GitCandidateError("GIT_EXECUTION_ERROR", `Remote parameter must be a configured remote name, URL not allowed: ${remote}`);
  }

  // Verify remote is an existing configured remote
  let remoteList: string[] = [];
  try {
    const { stdout } = await runGit(["remote"], resolvedWorkspaceRoot, 10000);
    remoteList = stdout.split("\n").map((r) => r.trim()).filter(Boolean);
  } catch (err) {
    throw new GitCandidateError("GIT_EXECUTION_ERROR", "Failed to list configured remotes.");
  }

  if (!remoteList.includes(remote)) {
    throw new GitCandidateError("GIT_EXECUTION_ERROR", `Remote '${remote}' is not configured in this repository.`);
  }

  // 5. Branch validation
  // Validate name using check-ref-format
  try {
    await runGit(["check-ref-format", "--branch", branch], resolvedWorkspaceRoot, 10000);
  } catch {
    throw new GitCandidateError("GIT_EXECUTION_ERROR", `Invalid branch name: ${branch}`);
  }

  // Prevent pushing to default branch names
  const conventionalProtected = ["main", "master", "trunk"];
  if (conventionalProtected.includes(branch.toLowerCase())) {
    throw new GitCandidateError("GIT_PROTECTED_BRANCH", `Pushing to protected default branch name '${branch}' is denied.`);
  }

  // Try to determine the remote default branch
  let remoteDefaultBranch = "";
  try {
    const { stdout } = await runGit(["symbolic-ref", `refs/remotes/${remote}/HEAD`], resolvedWorkspaceRoot, 10000);
    const prefix = `refs/remotes/${remote}/`;
    if (stdout.startsWith(prefix)) {
      remoteDefaultBranch = stdout.slice(prefix.length).trim();
    }
  } catch {
    // Ignore: remote HEAD may not be fetched/available
  }

  if (remoteDefaultBranch && branch === remoteDefaultBranch) {
    throw new GitCandidateError(
      "GIT_PROTECTED_BRANCH",
      `Pushing to discovered remote default branch '${branch}' is denied.`,
    );
  }

  // 6. Push exact SHA: refs push remote expectedHead:refs/heads/<branch>
  try {
    await runGit(["push", remote, `${expectedHead}:refs/heads/${branch}`], resolvedWorkspaceRoot, 60000);
  } catch (err: any) {
    throw new GitCandidateError("GIT_EXECUTION_ERROR", `Git push failed: ${err.message}`);
  }

  // 7. Verify remote ref SHA equals expectedHead
  let remoteRefSha = "";
  try {
    const { stdout } = await runGit(["ls-remote", "--heads", remote, `refs/heads/${branch}`], resolvedWorkspaceRoot, 10000);
    const parts = stdout.split(/\s+/);
    if (parts.length > 0 && parts[0]) {
      remoteRefSha = parts[0].trim();
    }
  } catch (err: any) {
    throw new GitCandidateError("GIT_EXECUTION_ERROR", `Failed to read back remote ref SHA: ${err.message}`);
  }

  if (remoteRefSha !== expectedHead) {
    throw new GitCandidateError(
      "GIT_EXECUTION_ERROR",
      `Remote ref verification failed. Remote ref has SHA ${remoteRefSha}, expected ${expectedHead}`,
    );
  }

  return {
    remote,
    branch,
    pushedSha: expectedHead,
  };
}
