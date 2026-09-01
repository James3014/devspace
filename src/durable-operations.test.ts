import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import {
  DurableOperationError,
  DurableOperationManager,
  DurableOperationStore,
  type CommandRunner,
} from "./durable-operations.js";

const execFileAsync = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "devspace-durable-ops-"));
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_STATE_DIR: join(root, ".state"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  return { root, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

test("workspace_clone clones a local repository inside allowed roots and exact replay does not duplicate", async () => {
  const f = await fixture();
  try {
    const source = join(f.root, "source");
    const destination = join(f.root, "clone");
    await mkdir(source);
    await git(source, "init");
    await git(source, "config", "user.email", "devspace@example.com");
    await git(source, "config", "user.name", "DevSpace Test");
    await writeFile(join(source, "README.md"), "hello\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "initial");

    const manager = new DurableOperationManager(f.config);
    try {
      const first = await manager.workspaceClone({
        attemptKey: "clone-local-1",
        remote: source,
        destination,
      });
      assert.equal(first.status, "succeeded");
      assert.equal(first.receipt?.openable, true);
      assert.equal(await readFile(join(destination, "README.md"), "utf8"), "hello\n");

      const replay = await manager.workspaceClone({
        attemptKey: "clone-local-1",
        remote: source,
        destination,
      });
      assert.equal(replay.operationId, first.operationId);
      assert.equal(replay.updatedAt, first.updatedAt);
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("workspace_clone rejects destinations outside allowed roots and conflicting replay", async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "devspace-clone-outside-"));
  try {
    const source = join(f.root, "source");
    await mkdir(source);
    await git(source, "init");
    const manager = new DurableOperationManager(f.config);
    try {
      await assert.rejects(
        manager.workspaceClone({
          attemptKey: "outside-1",
          remote: source,
          destination: join(outside, "clone"),
        }),
        (error: unknown) => error instanceof DurableOperationError && error.code === "DESTINATION_OUTSIDE_ALLOWED_ROOT",
      );

      const destination = join(f.root, "clone-a");
      await manager.workspaceClone({ attemptKey: "conflict-1", remote: source, destination });
      await assert.rejects(
        manager.workspaceClone({
          attemptKey: "conflict-1",
          remote: source,
          destination: join(f.root, "clone-b"),
        }),
        (error: unknown) => error instanceof DurableOperationError && error.code === "OPERATION_REPLAY_CONFLICT",
      );
    } finally {
      manager.close();
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
    await f.cleanup();
  }
});

test("dependency_sync frozen recipe succeeds without changing manifest or lock inputs", async () => {
  const f = await fixture();
  try {
    const project = join(f.root, "project");
    await mkdir(project);
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }) + "\n");
    await writeFile(join(project, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: {} }) + "\n");
    const beforeManifest = await readFile(join(project, "package.json"), "utf8");
    const beforeLock = await readFile(join(project, "package-lock.json"), "utf8");
    const runner: CommandRunner = async () => ({ exitCode: 0, stdout: "ok", stderr: "" });
    const manager = new DurableOperationManager(f.config, runner);
    try {
      const result = await manager.dependencySync({
        attemptKey: "deps-frozen-1",
        workspaceId: "ws_fixture",
        workspaceRoot: project,
        recipe: "npm_ci",
      });
      assert.equal(result.status, "succeeded");
      assert.equal(await readFile(join(project, "package.json"), "utf8"), beforeManifest);
      assert.equal(await readFile(join(project, "package-lock.json"), "utf8"), beforeLock);
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("dependency_sync detects frozen input mutation even when the command exits zero", async () => {
  const f = await fixture();
  try {
    const project = join(f.root, "project");
    await mkdir(project);
    await writeFile(join(project, "package.json"), "{\"name\":\"fixture\"}\n");
    await writeFile(join(project, "package-lock.json"), "{\"lockfileVersion\":3}\n");
    const runner: CommandRunner = async (_command, _args, cwd) => {
      await writeFile(join(cwd, "package-lock.json"), "{\"lockfileVersion\":3,\"mutated\":true}\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = new DurableOperationManager(f.config, runner);
    try {
      const result = await manager.dependencySync({
        attemptKey: "deps-mutation-1",
        workspaceId: "ws_fixture",
        workspaceRoot: project,
        recipe: "npm_ci",
      });
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "FROZEN_INPUT_CHANGED");
      assert.equal(result.retrySafe, false);
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("restart fences a nonterminal mutating operation as outcome_unknown and requires reconciliation", async () => {
  const f = await fixture();
  try {
    const destination = join(f.root, "interrupted-clone");
    const store = new DurableOperationStore(f.config.stateDir);
    const created = store.createOrReplay({
      operationId: "op_interrupted",
      attemptKey: "interrupted-1",
      requestHash: "hash-1",
      kind: "workspace_clone",
      authorityMode: "OWNER_DIRECT",
      scopeRoot: f.root,
      request: { destination, remote: join(f.root, "missing-source") },
    }).record;
    assert.equal(created.status, "started");
    store.close();

    let runnerCalls = 0;
    const restarted = new DurableOperationManager(f.config, async () => {
      runnerCalls += 1;
      throw new Error("reconciliation must not re-execute mutation");
    });
    try {
      const afterRestart = restarted.store.getByOperationId("op_interrupted");
      assert.equal(afterRestart?.status, "outcome_unknown");
      assert.equal(afterRestart?.retrySafe, false);
      assert.equal(runnerCalls, 0, "restart fencing must not execute the original mutation");
      const reconciled = await restarted.reconcile("op_interrupted");
      assert.equal(reconciled.status, "outcome_unknown");
      assert.equal(reconciled.errorCode, "RECONCILIATION_REQUIRED");
      assert.equal(runnerCalls, 0, "reconciliation must inspect physical state without re-executing mutation");
    } finally {
      restarted.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("NEXUS_GOVERNED mutating operations fail closed before G9 validation wiring", async () => {
  const f = await fixture();
  try {
    const manager = new DurableOperationManager(f.config, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    try {
      await assert.rejects(
        manager.workspaceClone({
          attemptKey: "nexus-not-wired-1",
          remote: join(f.root, "source"),
          destination: join(f.root, "destination"),
          authorityMode: "NEXUS_GOVERNED",
        }),
        /G9 must provide validated Nexus authority evidence/,
      );
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});
