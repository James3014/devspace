import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitCandidate, pushCandidate, GitCandidateError } from "./git-candidate.js";

// Helper to run raw git commands for setup/verification
function runGitRaw(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
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
  runGitRaw(["worktree", "add", "--detach", worktreeDir], cloneDir);
  runGitRaw(["config", "user.email", "test@example.com"], worktreeDir);
  runGitRaw(["config", "user.name", "Test User"], worktreeDir);
  // Force local hooks path to bypass any user global core.hooksPath configuration
  runGitRaw(["config", "core.hooksPath", join(cloneDir, ".git", "hooks")], worktreeDir);
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

test("commitCandidate - git secret isolation hook sentinel test", async () => {
  const f = setupGitFixture();
  try {
    // Write pre-commit hook that fails if secret leaks
    const hooksDir = join(f.cloneDir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "pre-commit");

    writeFileSync(
      hookPath,
      `#!/bin/sh
if [ -n "$DEVSPACE_OAUTH_OWNER_TOKEN" ] || [ -n "$DEVSPACE_SENSITIVE_SECRET" ] || [ -n "$DEVSPACE_OAUTH_SCOPES" ]; then
  exit 99
fi
exit 0
`
    );
    execFileSync("chmod", ["+x", hookPath]);

    // Setup dummy file
    writeFileSync(join(f.worktreeDir, "secret-test.txt"), "secret test");

    // Inject secrets to process.env
    process.env.DEVSPACE_OAUTH_OWNER_TOKEN = "DO_NOT_LEAK";
    process.env.DEVSPACE_SENSITIVE_SECRET = "DO_NOT_LEAK";
    process.env.DEVSPACE_OAUTH_SCOPES = "DO_NOT_LEAK";

    // Should succeed because runGit strips them
    const result = await commitCandidate({
      workspaceId: "ws",
      workspaceRoot: f.worktreeDir,
      expectedHead: f.worktreeHead,
      message: "commit with secret isolation check",
      paths: ["secret-test.txt"],
    });

    assert.ok(result.commitSha);
  } finally {
    delete process.env.DEVSPACE_OAUTH_OWNER_TOKEN;
    delete process.env.DEVSPACE_SENSITIVE_SECRET;
    delete process.env.DEVSPACE_OAUTH_SCOPES;
    f.clean();
  }
});

test("commitCandidate - no automatic reset on fail", async () => {
  const f = setupGitFixture();
  try {
    const hooksDir = join(f.cloneDir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "pre-commit");
    writeFileSync(hookPath, `#!/bin/sh\nexit 1\n`);
    execFileSync("chmod", ["+x", hookPath]);

    writeFileSync(join(f.worktreeDir, "fail.txt"), "fail content");

    await assert.rejects(
      commitCandidate({
        workspaceId: "ws",
        workspaceRoot: f.worktreeDir,
        expectedHead: f.worktreeHead,
        message: "failed commit test",
        paths: ["fail.txt"],
      })
    );

    // Verify index is NOT reset (fail.txt should remain staged)
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: f.worktreeDir }).toString().trim();
    assert.equal(staged, "fail.txt");
  } finally {
    f.clean();
  }
});

test("commitCandidate - expected HEAD parent verification", async () => {
  const f = setupGitFixture();
  try {
    writeFileSync(join(f.worktreeDir, "adv.txt"), "advance");
    const result = await commitCandidate({
      workspaceId: "ws",
      workspaceRoot: f.worktreeDir,
      expectedHead: f.worktreeHead,
      message: "advancing commit",
      paths: ["adv.txt"],
    });

    assert.ok(result.commitSha);
    assert.notEqual(result.commitSha, f.worktreeHead);

    const parent = execFileSync("git", ["rev-parse", "HEAD^1"], { cwd: f.worktreeDir }).toString().trim();
    assert.equal(parent, f.worktreeHead);
  } finally {
    f.clean();
  }
});

test("pushCandidate - exact refspec and ls-remote verification", async () => {
  const f = setupGitFixture();
  try {
    writeFileSync(join(f.worktreeDir, "p1.txt"), "v1");
    const commit = await commitCandidate({
      workspaceId: "ws",
      workspaceRoot: f.worktreeDir,
      expectedHead: f.worktreeHead,
      message: "commit for push verify",
      paths: ["p1.txt"],
    });

    await assert.rejects(
      pushCandidate({
        workspaceRoot: f.worktreeDir,
        expectedHead: commit.commitSha,
        remote: "-invalid-remote",
        branch: "candidate-branch-ok",
      })
    );

    const pushResult = await pushCandidate({
      workspaceRoot: f.worktreeDir,
      expectedHead: commit.commitSha,
      remote: "origin",
      branch: "candidate-branch-ok",
    });

    assert.equal(pushResult.pushedSha, commit.commitSha);

    const remoteRef = execFileSync("git", ["ls-remote", "--heads", "origin", "refs/heads/candidate-branch-ok"], { cwd: f.worktreeDir }).toString().trim();
    assert.ok(remoteRef.startsWith(commit.commitSha));
  } finally {
    f.clean();
  }
});

test("commitCandidate - hung hook timeout test", async () => {
  const f = setupGitFixture();
  try {
    const hooksDir = join(f.cloneDir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "pre-commit");

    writeFileSync(hookPath, `#!/bin/sh\nsleep 100\n`);
    execFileSync("chmod", ["+x", hookPath]);

    writeFileSync(join(f.worktreeDir, "timeout-test.txt"), "timeout content");

    const startTime = Date.now();
    await assert.rejects(
      commitCandidate({
        workspaceId: "ws",
        workspaceRoot: f.worktreeDir,
        expectedHead: f.worktreeHead,
        message: "should timeout commit",
        paths: ["timeout-test.txt"],
      }),
      (err: any) => {
        assert.match(err.message, /timed out/);
        return true;
      }
    );

    const duration = Date.now() - startTime;
    assert.ok(duration >= 25000 && duration < 40000, `Expected timeout around 30s, got ${duration}ms`);
  } finally {
    f.clean();
  }
});

test("commitCandidate - macOS var/private/var alias verification", async () => {
  const f = setupGitFixture();
  try {
    let aliasPath = f.worktreeDir;
    if (f.worktreeDir.startsWith("/private/var/")) {
      aliasPath = f.worktreeDir.replace("/private/var/", "/var/");
    } else if (f.worktreeDir.startsWith("/var/")) {
      aliasPath = "/private" + f.worktreeDir;
    }

    writeFileSync(join(f.worktreeDir, "alias.txt"), "alias");
    const result = await commitCandidate({
      workspaceId: "ws",
      workspaceRoot: aliasPath,
      expectedHead: f.worktreeHead,
      message: "alias test commit",
      paths: ["alias.txt"],
    });

    assert.ok(result.commitSha);
  } finally {
    f.clean();
  }
});

test("commitCandidate classifies a failing pre-commit hook as confirmed no effect", async () => {
  const f = setupGitFixture();
  try {
    const hookPath = join(f.cloneDir, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\nprintf 'escape\\n' > hook-failure-escape.txt\nexit 17\n");
    execFileSync("chmod", ["+x", hookPath]);
    writeFileSync(join(f.worktreeDir, "hook-failure.txt"), "candidate\n");
    await assert.rejects(
      commitCandidate({ workspaceId: "ws", workspaceRoot: f.worktreeDir, expectedHead: f.worktreeHead, message: "hook failure", paths: ["hook-failure.txt"] }),
      (error: unknown) => {
        assert.ok(error instanceof GitCandidateError);
        assert.equal(error.effect?.state, "CONFIRMED_NO_EFFECT");
        assert.equal(error.effect?.observedHead, f.worktreeHead);
        assert.equal(error.effect?.retryAllowed, false);
        assert.equal(runGitRaw(["rev-parse", "HEAD"], f.worktreeDir), f.worktreeHead);
        return true;
      },
    );
  } finally {
    f.clean();
  }
});

test("commitCandidate preserves confirmed commit when first identity readback fails", async () => {
  const f = setupGitFixture();
  try {
    writeFileSync(join(f.worktreeDir, "readback.txt"), "candidate\n");
    let committed = false;
    let failedReadbacks = 0;
    const gitRunner = async (args: string[], cwd: string) => {
      if (committed && args.join(" ") === "rev-parse HEAD" && failedReadbacks++ === 0) {
        throw new Error("injected first post-commit HEAD readback failure");
      }
      const stdout = runGitRaw(args, cwd);
      if (args[0] === "commit") committed = true;
      return { stdout, stderr: "" };
    };
    await assert.rejects(
      commitCandidate({ workspaceId: "ws", workspaceRoot: f.worktreeDir, expectedHead: f.worktreeHead, message: "readback failure", paths: ["readback.txt"], gitRunner } as Parameters<typeof commitCandidate>[0]),
      (error: unknown) => {
        assert.ok(error instanceof GitCandidateError);
        assert.equal(error.effect?.state, "CONFIRMED_LOCAL_COMMIT");
        assert.equal(error.effect?.observedHead, runGitRaw(["rev-parse", "HEAD"], f.worktreeDir));
        assert.match(String(error.effect?.observedTree), /^[0-9a-f]{40}$/);
        assert.match(error.message, /injected first post-commit HEAD readback failure/);
        return true;
      },
    );
  } finally {
    f.clean();
  }
});

test("pushCandidate reconciles expected remote SHA after initial readback failure", async () => {
  const f = setupGitFixture();
  try {
    writeFileSync(join(f.worktreeDir, "push-reconcile.txt"), "candidate\n");
    const commit = await commitCandidate({ workspaceId: "ws", workspaceRoot: f.worktreeDir, expectedHead: f.worktreeHead, message: "push reconcile", paths: ["push-reconcile.txt"] });
    let readbacks = 0;
    const gitRunner = async (args: string[], cwd: string) => {
      if (args[0] === "ls-remote" && readbacks++ === 0) throw new Error("injected initial remote readback failure");
      return { stdout: runGitRaw(args, cwd), stderr: "" };
    };
    const result = await pushCandidate({ workspaceRoot: f.worktreeDir, expectedHead: commit.commitSha, remote: "origin", branch: "reconciled-readback", gitRunner } as Parameters<typeof pushCandidate>[0]);
    assert.equal(result.pushedSha, commit.commitSha);
    assert.equal(readbacks, 2, "push must perform one bounded reconciliation readback");
  } finally {
    f.clean();
  }
});

test("pushCandidate preserves EFFECT_UNKNOWN when push succeeds but both readbacks fail", async () => {
  const f = setupGitFixture();
  try {
    writeFileSync(join(f.worktreeDir, "push-unknown.txt"), "candidate\n");
    const commit = await commitCandidate({ workspaceId: "ws", workspaceRoot: f.worktreeDir, expectedHead: f.worktreeHead, message: "push unknown", paths: ["push-unknown.txt"] });
    let readbacks = 0;
    const gitRunner = async (args: string[], cwd: string) => {
      if (args[0] === "ls-remote") {
        readbacks += 1;
        throw new Error(`injected remote readback failure ${readbacks}`);
      }
      return { stdout: runGitRaw(args, cwd), stderr: "" };
    };
    await assert.rejects(
      pushCandidate({ workspaceRoot: f.worktreeDir, expectedHead: commit.commitSha, remote: "origin", branch: "unknown-readback", gitRunner } as Parameters<typeof pushCandidate>[0]),
      (error: unknown) => {
        assert.ok(error instanceof GitCandidateError);
        assert.equal(error.effect?.state, "EFFECT_UNKNOWN");
        assert.equal(error.effect?.expectedPushedSha, commit.commitSha);
        assert.equal(error.effect?.remote, "origin");
        assert.equal(error.effect?.branch, "unknown-readback");
        assert.equal(error.effect?.retryAllowed, false);
        assert.match(error.message, /injected remote readback failure/);
        return true;
      },
    );
    assert.equal(readbacks, 2);
    assert.equal(runGitRaw(["rev-parse", "refs/heads/unknown-readback"], f.bareDir), commit.commitSha);
  } finally {
    f.clean();
  }
});
