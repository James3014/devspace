import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyHostStoragePlan,
  buildHostStoragePlan,
  HOST_STORAGE_BROWSER_MARKER_SCHEMA,
  type HostStorageRetentionInput,
} from "./host-storage-retention.js";
import type { LocalAgentRecord } from "./local-agent-store.js";
import type { WorkspaceConversationBinding, WorkspaceSession } from "./workspace-store.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devspace-retention-"));
  const stateDir = join(root, "state");
  const worktreeRoot = join(root, "worktrees");
  const packageRoot = join(root, "package");
  const source = join(root, "repo");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(source, { recursive: true });
  git(source, "init");
  git(source, "config", "user.name", "DevSpace Test");
  git(source, "config", "user.email", "devspace@example.invalid");
  writeFileSync(join(source, "base.txt"), "base\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "base");
  return { root, stateDir, worktreeRoot, packageRoot, source };
}

function makeWorktree(input: ReturnType<typeof fixture>, id: string) {
  const path = join(input.worktreeRoot, id);
  git(input.source, "worktree", "add", "--detach", path, "HEAD");
  return path;
}

function session(
  id: string,
  root: string,
  sourceRoot: string,
  lastUsedAt = "2026-09-17T00:00:00.000Z",
): WorkspaceSession {
  return {
    id,
    root,
    status: "active",
    mode: "worktree",
    sourceRoot,
    baseRef: "HEAD",
    baseSha: "a".repeat(40),
    managed: true,
    createdAt: "2026-09-17T00:00:00.000Z",
    lastUsedAt,
  };
}

function input(
  f: ReturnType<typeof fixture>,
  overrides: Partial<HostStorageRetentionInput> = {},
): HostStorageRetentionInput {
  return {
    stateDir: f.stateDir,
    worktreeRoot: f.worktreeRoot,
    packageRoot: f.packageRoot,
    workspaceSessions: [],
    conversationBindings: [],
    loadedWorkspaceIds: new Set(),
    agentRecords: [],
    nowMs: Date.parse("2026-09-19T12:00:00.000Z"),
    ...overrides,
  };
}

function artifact(plan: Awaited<ReturnType<typeof buildHostStoragePlan>>, id: string) {
  const found = plan.artifacts.find((entry) => entry.id === id);
  assert.ok(found, `missing artifact ${id}`);
  return found;
}

test("clean unreferenced old managed worktree becomes GC eligible and apply is idempotent", async () => {
  const f = fixture();
  const path = makeWorktree(f, "managed-old");
  let deleted = 0;
  const args = input(f, { workspaceSessions: [session("ws_old", path, f.source)] });

  const plan = await buildHostStoragePlan(args);
  assert.equal(artifact(plan, "workspace:ws_old").lifecycle, "GC_ELIGIBLE");

  const result = await applyHostStoragePlan(args, plan.planId, {
    deleteWorkspaceSession: () => { deleted += 1; },
  });
  assert.equal(result.removed.some((entry) => entry.id === "workspace:ws_old"), true);
  assert.equal(deleted, 1);
  assert.equal(git(f.source, "worktree", "list", "--porcelain").includes(path), false);

  const after = await buildHostStoragePlan({ ...args, workspaceSessions: [] });
  const replay = await applyHostStoragePlan({ ...args, workspaceSessions: [] }, after.planId, {
    deleteWorkspaceSession: () => { deleted += 1; },
  });
  assert.equal(replay.removed.length, 0);
  assert.equal(deleted, 1);
});

test("loaded, bound, resumable-agent, and dirty worktrees fail closed", async () => {
  const f = fixture();
  const loaded = makeWorktree(f, "loaded");
  const bound = makeWorktree(f, "bound");
  const agent = makeWorktree(f, "agent");
  const dirty = makeWorktree(f, "dirty");
  writeFileSync(join(dirty, "untracked.txt"), "do not delete\n");

  const bindings: WorkspaceConversationBinding[] = [{
    conversationScopeId: "conversation",
    targetKey: "target",
    workspaceSessionId: "ws_bound",
    createdAt: "2026-09-17T00:00:00.000Z",
    lastUsedAt: "2026-09-17T00:00:00.000Z",
  }];
  const agents: LocalAgentRecord[] = [{
    id: "agt_active",
    workspaceId: "ws_agent",
    workspaceRoot: agent,
    profileName: "test",
    provider: "codex",
    status: "idle",
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  }];

  const plan = await buildHostStoragePlan(input(f, {
    workspaceSessions: [
      session("ws_loaded", loaded, f.source),
      session("ws_bound", bound, f.source),
      session("ws_agent", agent, f.source),
      session("ws_dirty", dirty, f.source),
    ],
    conversationBindings: bindings,
    loadedWorkspaceIds: new Set(["ws_loaded"]),
    agentRecords: agents,
  }));

  assert.equal(artifact(plan, "workspace:ws_loaded").lifecycle, "ACTIVE");
  assert.equal(artifact(plan, "workspace:ws_bound").lifecycle, "PINNED");
  assert.equal(artifact(plan, "workspace:ws_agent").lifecycle, "PINNED");
  assert.equal(artifact(plan, "workspace:ws_dirty").lifecycle, "TERMINAL_BUT_RETAINED");
});

test("checkout roots are foreign and never deletion targets", async () => {
  const f = fixture();
  const checkout: WorkspaceSession = {
    id: "ws_checkout",
    root: f.source,
    status: "active",
    mode: "checkout",
    managed: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    lastUsedAt: "2026-09-01T00:00:00.000Z",
  };
  const plan = await buildHostStoragePlan(input(f, { workspaceSessions: [checkout] }));
  assert.equal(artifact(plan, "workspace:ws_checkout").lifecycle, "FOREIGN");
});

test("release retention pins newest rollback candidates and removes only older owned releases", async () => {
  const f = fixture();
  const releases = join(f.packageRoot, "releases");
  mkdirSync(releases, { recursive: true });
  for (const [name, stamp] of [["release-old", 1], ["release-mid", 2], ["release-new", 3], ["release-latest", 4]] as const) {
    const path = join(releases, name);
    mkdirSync(path);
    writeFileSync(join(path, "package.json"), JSON.stringify({ name: "@waishnav/devspace" }));
    writeFileSync(join(path, "payload.bin"), "x".repeat(stamp * 32));
    const when = new Date(1_700_000_000_000 + stamp * 1000);
    execFileSync("touch", ["-mt", when.toISOString().replace(/[-:]/g, "").slice(0, 12), path]);
  }
  const foreign = join(releases, "release-foreign");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "package.json"), JSON.stringify({ name: "not-devspace" }));

  const args = input(f, { releaseKeepCount: 2 });
  const plan = await buildHostStoragePlan(args);
  assert.equal(artifact(plan, "release:release-latest").lifecycle, "PINNED");
  assert.equal(artifact(plan, "release:release-new").lifecycle, "PINNED");
  assert.equal(artifact(plan, "release:release-old").lifecycle, "GC_ELIGIBLE");
  assert.equal(artifact(plan, "release:release-foreign").lifecycle, "UNKNOWN");

  const result = await applyHostStoragePlan(args, plan.planId, { deleteWorkspaceSession: () => {} });
  assert.equal(result.removed.some((entry) => entry.id === "release:release-old"), true);
  assert.equal(readFileSync(join(foreign, "package.json"), "utf8").includes("not-devspace"), true);
});

test("browser runtimes require explicit DevSpace ownership and terminal lifecycle evidence", async () => {
  const f = fixture();
  const root = join(f.stateDir, "browser-runtimes");
  const unknown = join(root, "unknown");
  const active = join(root, "active");
  const terminal = join(root, "terminal");
  for (const path of [unknown, active, terminal]) mkdirSync(path, { recursive: true });
  writeFileSync(join(active, ".devspace-storage.json"), JSON.stringify({
    schema: HOST_STORAGE_BROWSER_MARKER_SCHEMA,
    owner: "devspace",
    kind: "browser_runtime",
    lifecycle: "active",
  }));
  writeFileSync(join(terminal, ".devspace-storage.json"), JSON.stringify({
    schema: HOST_STORAGE_BROWSER_MARKER_SCHEMA,
    owner: "devspace",
    kind: "browser_runtime",
    lifecycle: "terminal",
  }));

  const args = input(f);
  const plan = await buildHostStoragePlan(args);
  assert.equal(artifact(plan, "browser-runtime:unknown").lifecycle, "UNKNOWN");
  assert.equal(artifact(plan, "browser-runtime:active").lifecycle, "ACTIVE");
  assert.equal(artifact(plan, "browser-runtime:terminal").lifecycle, "GC_ELIGIBLE");
});

test("apply refuses a stale inventory hash before any deletion", async () => {
  const f = fixture();
  const releases = join(f.packageRoot, "releases");
  mkdirSync(releases, { recursive: true });
  for (const name of ["release-a", "release-b"]) {
    const path = join(releases, name);
    mkdirSync(path);
    writeFileSync(join(path, "package.json"), JSON.stringify({ name: "@waishnav/devspace" }));
  }
  const args = input(f, { releaseKeepCount: 1 });
  const plan = await buildHostStoragePlan(args);
  writeFileSync(join(releases, "release-a", "changed.txt"), "drift");

  await assert.rejects(
    () => applyHostStoragePlan(args, plan.planId, { deleteWorkspaceSession: () => {} }),
    /STORAGE_PLAN_STALE/,
  );
});
