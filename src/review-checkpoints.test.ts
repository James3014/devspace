import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { createReviewCheckpointManager } from "./review-checkpoints.js";

const execFileAsync = promisify(execFile);

test("review changes reports edits and advances the last-shown checkpoint", async (t) => {
  const root = await repository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_review", root });
  assert.equal((await manager.reviewChanges({ workspaceId: "ws_review", root })).summary.files, 0);

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  await writeFile(join(root, "new.txt"), "new\n");
  const changed = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: false,
  });
  assert.deepEqual(changed.files.map((file) => file.path).sort(), ["README.md", "new.txt"]);
  assert.equal(changed.summary.additions, 2);

  assert.equal((await manager.reviewChanges({ workspaceId: "ws_review", root })).summary.files, 2);
  assert.equal((await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: false,
  })).summary.files, 0);
});

test("review checkpoints survive a manager restart", async (t) => {
  const root = await repository(t);
  const firstManager = createReviewCheckpointManager();
  await firstManager.initializeWorkspace({ workspaceId: "ws_review", root });
  await writeFile(join(root, "README.md"), "hello\nworld\n");

  const restartedManager = createReviewCheckpointManager();
  await restartedManager.initializeWorkspace({ workspaceId: "ws_review", root });
  const sinceLastShown = await restartedManager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: false,
  });
  const sinceWorkspaceOpen = await restartedManager.reviewChanges({
    workspaceId: "ws_review",
    root,
    since: "workspace_open",
    markReviewed: false,
  });

  assert.equal(sinceLastShown.summary.files, 1);
  assert.equal(sinceWorkspaceOpen.summary.files, 1);
});

test("review waits for concurrent checkpoint initialization", async (t) => {
  const root = await repository(t);
  const setupManager = createReviewCheckpointManager();
  await setupManager.initializeWorkspace({ workspaceId: "ws_review", root });
  await writeFile(join(root, "README.md"), "hello\nlater\n");

  const manager = createReviewCheckpointManager();
  const [, review] = await Promise.all([
    manager.initializeWorkspace({ workspaceId: "ws_review", root }),
    manager.reviewChanges({ workspaceId: "ws_review", root, markReviewed: false }),
  ]);

  assert.equal(review.summary.files, 1);
  assert.match(review.patch, /later/);
});

test("a missing last-shown checkpoint falls back and is re-established", async (t) => {
  const root = await repository(t);
  const setupManager = createReviewCheckpointManager();
  await setupManager.initializeWorkspace({ workspaceId: "ws_review", root });
  await writeFile(join(root, "README.md"), "hello\nlater\n");
  await deleteCheckpointRef(root, "ws_review", "baseline");

  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_review", root });
  const fallback = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: false,
  });
  assert.equal(fallback.summary.files, 1);
  assert.match(fallback.result, /compared from workspace open/);

  const reestablished = await manager.reviewChanges({ workspaceId: "ws_review", root });
  assert.match(reestablished.result, /baseline was re-established/);
  assert.equal((await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: false,
  })).summary.files, 0);
});

test("a missing workspace-open checkpoint preserves last-shown behavior", async (t) => {
  const root = await repository(t);
  const setupManager = createReviewCheckpointManager();
  await setupManager.initializeWorkspace({ workspaceId: "ws_review", root });
  await writeFile(join(root, "new.txt"), "still visible from baseline\n");
  await deleteCheckpointRef(root, "ws_review", "open");

  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_review", root });
  const sinceLastShown = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: false,
  });
  assert.equal(sinceLastShown.summary.files, 1);
  assert.match(sinceLastShown.patch, /still visible from baseline/);
  await assert.rejects(
    () => manager.reviewChanges({
      workspaceId: "ws_review",
      root,
      since: "workspace_open",
      markReviewed: false,
    }),
    /workspace-open review checkpoint is missing/,
  );
});

test("an unborn repository becomes reviewable after its first commit", async (t) => {
  const root = await repository(t, false);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_unborn", root });
  await assert.rejects(
    () => manager.reviewChanges({ workspaceId: "ws_unborn", root }),
    /commit|HEAD|Git/i,
  );

  await writeFile(join(root, "README.md"), "first commit\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial commit"]);
  const afterFirstCommit = await manager.reviewChanges({
    workspaceId: "ws_unborn",
    root,
    markReviewed: false,
  });
  assert.equal(afterFirstCommit.summary.files, 0);
  assert.equal(afterFirstCommit.patch, "");
});

async function repository(t: TestContext, initialCommit = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devspace-review-checkpoints-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  if (initialCommit) {
    await writeFile(join(root, "README.md"), "hello\n");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "Initial commit"]);
  }
  return root;
}

async function deleteCheckpointRef(
  root: string,
  workspaceId: string,
  checkpoint: "open" | "baseline",
): Promise<void> {
  await git(root, ["update-ref", "-d", `refs/devspace/review/${workspaceId}/${checkpoint}`]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
