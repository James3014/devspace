import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedWorktree, repoWorktreeLockCount, withRepoWorktreeLock } from "./git-worktrees.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("worktree lock serializes same-key operations and removes its idle entry", async () => {
  const gate = deferred();
  const events: string[] = [];
  const first = withRepoWorktreeLock("same", async () => { events.push("first-start"); await gate.promise; events.push("first-end"); });
  const second = withRepoWorktreeLock("same", async () => { events.push("second"); });
  await Promise.resolve();
  assert.deepEqual(events, ["first-start"]);
  assert.equal(repoWorktreeLockCount(), 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second"]);
  assert.equal(repoWorktreeLockCount(), 0);
});

test("worktree lock releases the next waiter after rejection", async () => {
  const events: string[] = [];
  const first = withRepoWorktreeLock("reject", async () => { events.push("first"); throw new Error("expected failure"); });
  const second = withRepoWorktreeLock("reject", async () => { events.push("second"); });
  await assert.rejects(first, /expected failure/);
  await second;
  assert.deepEqual(events, ["first", "second"]);
  assert.equal(repoWorktreeLockCount(), 0);
});

test("worktree lock keeps a pending successor as the current owner", async () => {
  const firstGate = deferred();
  const secondGate = deferred();
  const events: string[] = [];
  const first = withRepoWorktreeLock("successor", async () => { events.push("first"); await firstGate.promise; });
  const second = withRepoWorktreeLock("successor", async () => { events.push("second"); await secondGate.promise; });
  const third = withRepoWorktreeLock("successor", async () => { events.push("third"); });
  await Promise.resolve();
  assert.equal(repoWorktreeLockCount(), 1);
  firstGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first", "second"]);
  assert.equal(repoWorktreeLockCount(), 1);
  secondGate.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(events, ["first", "second", "third"]);
  assert.equal(repoWorktreeLockCount(), 0);
});

test("createManagedWorktree automatically links parent node_modules when present", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "worktree-dep-test-"));
  const repoDir = join(tempDir, "repo");
  const worktreeRootDir = join(tempDir, "worktrees");
  await mkdir(repoDir, { recursive: true });
  await mkdir(join(repoDir, "node_modules"), { recursive: true });
  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial commit"], { cwd: repoDir });

  try {
    const worktree = await createManagedWorktree({
      sourcePath: repoDir,
      config: {
        allowedRoots: [tempDir],
        worktreeRoot: worktreeRootDir,
      } as any,
    });

    const targetNodeModules = join(worktree.path, "node_modules");
    const linkTarget = await readlink(targetNodeModules);
    assert.equal(linkTarget, join(repoDir, "node_modules"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
