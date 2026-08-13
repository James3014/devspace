import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitCandidate, pushCandidate, GitCandidateError } from "./git-candidate.js";

// Helper to run raw git commands for setup/verification
function runGitRaw(args: string[], cwd: string): string {
  return execSync(`git ${args.join(" ")}`, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}

function setupGitFixture() {
  const root = mkdtempSync(join(tmpdir(), "devspace-git-candidate-test-"));
  const bareDir = join(root, "bare.git");
  const cloneDir = join(root, "clone");
  const worktreeDir = join(root, "worktree-dir");

  // 1. Create bare repo
  mkdirSync(bareDir);
  runGitRaw(["init", "--bare", "--initial-branch=main"], bareDir);

  // 2. Create local clone
  runGitRaw(["clone", bareDir, cloneDir], root);
  runGitRaw(["config", "user.email", "test@example.com"], cloneDir);
  runGitRaw(["config", "user.name", "Test User"], cloneDir);

  // 3. Make initial commit
  writeFileSync(join(cloneDir, "readme.md"), "# Readme\n");
  runGitRaw(["add", "readme.md"], cloneDir);
  runGitRaw(["commit", "-m", "initial commit"], cloneDir);
  runGitRaw(["push", "origin", "main"], cloneDir);

  const initialHead = runGitRaw(["rev-parse", "HEAD"], cloneDir);

  // 4. Create git worktree (simulating managed worktree)
  runGitRaw(["worktree", "add", worktreeDir, "main"], cloneDir);
  runGitRaw(["config", "user.email", "test@example.com"], worktreeDir);
  runGitRaw(["config", "user.name", "Test User"], worktreeDir);

  // Detach worktree head to simulate detached candidate run
  runGitRaw(["checkout", "--detach"], worktreeDir);
  const worktreeHead = runGitRaw(["rev-parse", "HEAD"], worktreeDir);

  const clean = () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  };

  return {
    root,
    bareDir,
    cloneDir,
    worktreeDir,
    initialHead,
    worktreeHead,
    clean,
  };
}

test("commitCandidate - managed worktree vs canonical checkout and unmanaged roots", async () => {
  const f = setupGitFixture();
  try {
    // A. Canonical checkout reject: we check in server.ts for workspace.mode,
    // but in commitCandidate we verify that root matches Git toplevel.
    // If we pass an invalid/non-git directory to commitCandidate, it fails.
    const nonGitDir = join(f.root, "non-git");
    mkdirSync(nonGitDir);
    await assert.rejects(
      commitCandidate({
        workspaceId: "ws",
        workspaceRoot: nonGitDir,
        expectedHead: f.worktreeHead,
        message: "test",
        paths: ["dummy.txt"],
      }),
      (err: any) => {
        assert.equal(err.code, "GIT_MANAGED_WORKTREE_REQUIRED");
        return true;
      }
    );
  } finally {
    f.clean();
  }
});

test("commitCandidate - expectedHead mismatch", async () => {
  const f = setupGitFixture();
  try {
    const wrongHead = "a".repeat(40);
    await assert.rejects(
      commitCandidate({
        workspaceId: "ws",
        workspaceRoot: f.worktreeDir,
        expectedHead: wrongHead,
        message: "test",
        paths: ["readme.md"],
      }),
      (err: any) => {
        assert.equal(err.code, "GIT_HEAD_MISMATCH");
        return true;
      }
    );
  } finally {
    f.clean();
  }
});

test("commitCandidate - pre-existing staged changes detection", async () => {
  const f = setupGitFixture();
  try {
    // Stage something manually
    writeFileSync(join(f.worktreeDir, "manual.txt"), "pre-staged");
    runGitRaw(["add", "manual.txt"], f.worktreeDir);

    await assert.rejects(
      commitCandidate({
        workspaceId: "ws",
        workspaceRoot: f.worktreeDir,
        expectedHead: f.worktreeHead,
        message: "test commit",
        paths: ["readme.md"],
      }),
      (err: any) => {
        assert.equal(err.code, "GIT_INDEX_NOT_CLEAN");
        return true;
      }
    );
  } finally {
    f.clean();
  }
});

test("commitCandidate - exact path staging & staging violation protection", async () => {
  const f = setupGitFixture();
  try {
    // Create two files
    writeFileSync(join(f.worktreeDir, "a.txt"), "a content");
    writeFileSync(join(f.worktreeDir, "b.txt"), "b content");

    // Try committing ONLY a.txt
    const result = await commitCandidate({
      workspaceId: "ws",
      workspaceRoot: f.worktreeDir,
      expectedHead: f.worktreeHead,
      message: "commit only a",
      paths: ["a.txt"],
    });

    assert.ok(result.commitSha);
    assert.equal(result.message, "commit only a");

    // Verify b.txt remains unstaged and untracked
    const status = runGitRaw(["status", "--porcelain"], f.worktreeDir);
    assert.match(status, /\?\? b\.txt/);

    // Verify HEAD advanced once
    const currentHead = runGitRaw(["rev-parse", "HEAD"], f.worktreeDir);
    assert.equal(currentHead, result.commitSha);
    assert.notEqual(currentHead, f.worktreeHead);

  } finally {
    f.clean();
  }
});

test("commitCandidate - wildcards pathspec magic injection protection", async () => {
  const f = setupGitFixture();
  try {
    writeFileSync(join(f.worktreeDir, "a.txt"), "a");
    writeFileSync(join(f.worktreeDir, "ab.txt"), "ab");

    // Path containing wildcard '*' should be handled literally, but we block magic input entirely.
    // Also, validatePaths blocks prefix ':'
    await assert.rejects(
      commitCandidate({
        workspaceId: "ws",
        workspaceRoot: f.worktreeDir,
        expectedHead: f.worktreeHead,
        message: "magic",
        paths: [":(glob)*.txt"],
      }),
      (err: any) => {
        assert.equal(err.code, "GIT_INVALID_PATH");
        return true;
      }
    );
  } finally {
    f.clean();
  }
});

test("commitCandidate - dot '.' not allowed", async () => {
  const f = setupGitFixture();
  try {
    await assert.rejects(
      commitCandidate({
        workspaceId: "ws",
        workspaceRoot: f.worktreeDir,
        expectedHead: f.worktreeHead,
        message: "dot reject",
        paths: ["."],
      }),
      (err: any) => {
        assert.equal(err.code, "GIT_INVALID_PATH");
        return true;
      }
    );
  } finally {
    f.clean();
  }
});

test("commitCandidate - git diff check formatting enforcement", async () => {
  const f = setupGitFixture();
  try {
    // Add trailing whitespace to trigger a git check error if configured or if standard git check fails.
    // To ensure check fails, let's create a file with conflict markers.
    writeFileSync(
      join(f.worktreeDir, "conflict.txt"),
      "c1\n<<<<<<< HEAD\nc2\n=======\nc3\n>>>>>>> branch\n"
    );

    // git diff --check will detect conflict markers. Let's verify:
    await assert.rejects(
      commitCandidate({
        workspaceId: "ws",
        workspaceRoot: f.worktreeDir,
        expectedHead: f.worktreeHead,
        message: "commit conflict file",
        paths: ["conflict.txt"],
      }),
      (err: any) => {
        // Enforced git diff --cached --check should throw execution error or similar
        assert.ok(err.code);
        return true;
      }
    );
  } finally {
    f.clean();
  }
});

test("commitCandidate - empty Candidate rejection", async () => {
  const f = setupGitFixture();
  try {
    // readme.md has no modifications
    await assert.rejects(
      commitCandidate({
        workspaceId: "ws",
        workspaceRoot: f.worktreeDir,
        expectedHead: f.worktreeHead,
        message: "empty commit",
        paths: ["readme.md"],
      }),
      (err: any) => {
        assert.equal(err.code, "GIT_NOTHING_TO_COMMIT");
        return true;
      }
    );
  } finally {
    f.clean();
  }
});

test("pushCandidate - push detached HEAD to remote", async () => {
  const f = setupGitFixture();
  try {
    // 1. Commit something to push
    writeFileSync(join(f.worktreeDir, "pushed.txt"), "hello pushed");
    const commit = await commitCandidate({
      workspaceId: "ws",
      workspaceRoot: f.worktreeDir,
      expectedHead: f.worktreeHead,
      message: "pre-push commit",
      paths: ["pushed.txt"],
    });

    // 2. Successful push to remote branch
    const pushResult = await pushCandidate({
      workspaceRoot: f.worktreeDir,
      expectedHead: commit.commitSha,
      remote: "origin",
      branch: "candidate-branch-1",
    });

    assert.equal(pushResult.remote, "origin");
    assert.equal(pushResult.branch, "candidate-branch-1");
    assert.equal(pushResult.pushedSha, commit.commitSha);

    // Verify in bare repo that candidate-branch-1 was created with commit.commitSha
    const remoteSha = runGitRaw(["rev-parse", "refs/heads/candidate-branch-1"], f.bareDir);
    assert.equal(remoteSha, commit.commitSha);

  } finally {
    f.clean();
  }
});

test("pushCandidate - reject URL as remote", async () => {
  const f = setupGitFixture();
  try {
    await assert.rejects(
      pushCandidate({
        workspaceRoot: f.worktreeDir,
        expectedHead: f.worktreeHead,
        remote: "https://github.com/user/repo.git",
        branch: "candidate-branch",
      }),
      (err: any) => {
        assert.equal(err.code, "GIT_EXECUTION_ERROR");
        return true;
      }
    );
  } finally {
    f.clean();
  }
});

test("pushCandidate - default branches protected", async () => {
  const f = setupGitFixture();
  try {
    for (const b of ["main", "master", "trunk"]) {
      await assert.rejects(
        pushCandidate({
          workspaceRoot: f.worktreeDir,
          expectedHead: f.worktreeHead,
          remote: "origin",
          branch: b,
        }),
        (err: any) => {
          assert.equal(err.code, "GIT_PROTECTED_BRANCH");
          return true;
        }
      );
    }
  } finally {
    f.clean();
  }
});

test("pushCandidate - non-fast-forward push failure", async () => {
  const f = setupGitFixture();
  try {
    // 1. Force push candidate-branch-1 from cloneDir to bare first to establish it
    writeFileSync(join(f.cloneDir, "p1.txt"), "v1");
    runGitRaw(["add", "p1.txt"], f.cloneDir);
    runGitRaw(["commit", "-m", "remote commit"], f.cloneDir);
    runGitRaw(["push", "origin", "main:refs/heads/candidate-branch-ff"], f.cloneDir);

    // Reset clone HEAD to avoid issues
    const remoteCommit = runGitRaw(["rev-parse", "HEAD"], f.cloneDir);

    // 2. Local worktree has a divergent commit starting from previous head
    writeFileSync(join(f.worktreeDir, "divergent.txt"), "diverged");
    const commit = await commitCandidate({
      workspaceId: "ws",
      workspaceRoot: f.worktreeDir,
      expectedHead: f.worktreeHead,
      message: "divergent commit",
      paths: ["divergent.txt"],
    });

    // 3. Push local commit to candidate-branch-ff. This must fail because it's divergent/non-ff
    await assert.rejects(
      pushCandidate({
        workspaceRoot: f.worktreeDir,
        expectedHead: commit.commitSha,
        remote: "origin",
        branch: "candidate-branch-ff",
      }),
      (err: any) => {
        assert.equal(err.code, "GIT_EXECUTION_ERROR");
        assert.match(err.message, /non-fast-forward/);
        return true;
      }
    );
  } finally {
    f.clean();
  }
});
