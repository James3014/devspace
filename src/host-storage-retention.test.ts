import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { DurableOperationRecord } from "./durable-operations.js";
import {
  applyHostStoragePlan,
  buildHostStoragePlan,
  HOST_STORAGE_BROWSER_MARKER_SCHEMA,
  resolveHostStorageRoot,
  type HostStorageRetentionInput,
} from "./host-storage-retention.js";
import type { LocalAgentRecord } from "./local-agent-store.js";
import type { WorkspaceConversationBinding, WorkspaceSession } from "./workspace-store.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

test("installed package root resolves to the DevSpace host install root", () => {
  assert.equal(
    resolveHostStorageRoot("/opt/devspace-chatgpt/node_modules/@waishnav/devspace"),
    resolve("/opt/devspace-chatgpt"),
  );
  assert.equal(
    resolveHostStorageRoot("/opt/devspace-chatgpt/node_modules/devspace"),
    resolve("/opt/devspace-chatgpt"),
  );
  assert.equal(
    resolveHostStorageRoot("/workspace/devspace"),
    resolve("/workspace/devspace"),
  );
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devspace-retention-"));
  const stateDir = join(root, "state");
  const worktreeRoot = join(root, "worktrees");
  const packageRoot = join(root, "package");
  const source = join(root, "repo");
  const cloneRoot = join(root, "Workspace", ".devspace-chatgpt");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(source, { recursive: true });
  mkdirSync(cloneRoot, { recursive: true });
  git(source, "init");
  git(source, "config", "user.name", "DevSpace Test");
  git(source, "config", "user.email", "devspace@example.invalid");
  writeFileSync(join(source, "base.txt"), "base\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "base");
  const baseSha = git(source, "rev-parse", "HEAD");
  return { root, stateDir, worktreeRoot, packageRoot, source, cloneRoot, baseSha };
}

function makeWorktree(input: ReturnType<typeof fixture>, id: string, path = join(input.worktreeRoot, id)) {
  git(input.source, "worktree", "add", "--detach", path, "HEAD");
  return path;
}

function session(
  f: ReturnType<typeof fixture>,
  id: string,
  root: string,
  sourceRoot = f.source,
  lastUsedAt = "2026-09-17T00:00:00.000Z",
): WorkspaceSession {
  return {
    id,
    root,
    status: "active",
    mode: "worktree",
    sourceRoot,
    baseRef: "HEAD",
    baseSha: f.baseSha,
    managed: true,
    createdAt: "2026-09-17T00:00:00.000Z",
    lastUsedAt,
  };
}

function checkoutSession(
  f: ReturnType<typeof fixture>,
  id = "ws_checkout",
  lastUsedAt = "2026-09-01T00:00:00.000Z",
): WorkspaceSession {
  return {
    id,
    root: f.source,
    status: "active",
    mode: "checkout",
    managed: false,
    createdAt: "2026-09-01T00:00:00.000Z",
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
    processWorkspaceStates: new Map(),
    durableOperations: [],
    allowedRoots: [f.root],
    browserProfileStates: new Map(),
    browserReferenceStateAvailable: true,
    nowMs: Date.parse("2026-09-19T12:00:00.000Z"),
    ...overrides,
  };
}

function artifact(plan: Awaited<ReturnType<typeof buildHostStoragePlan>>, id: string) {
  const found = plan.artifacts.find((entry) => entry.id === id);
  assert.ok(found, `missing artifact ${id}`);
  return found;
}

function cloneOperation(
  f: ReturnType<typeof fixture>,
  destination: string,
  head: string,
  status: DurableOperationRecord["status"] = "succeeded",
  id = "op_clone",
): DurableOperationRecord {
  return {
    operationId: id,
    attemptKey: id,
    requestHash: "a".repeat(64),
    kind: "workspace_clone",
    authorityMode: "OWNER_DIRECT",
    scopeRoot: f.root,
    status,
    retrySafe: false,
    request: { destination, remote: f.source },
    receipt: { destination, head, openable: true },
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

function profileId(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex");
}

test("dry-run classifies clean old managed worktree and apply is receipt-idempotent", async () => {
  const f = fixture();
  const path = makeWorktree(f, "managed-old");
  let deleted = 0;
  const args = input(f, { workspaceSessions: [session(f, "ws_old", path)] });

  const plan = await buildHostStoragePlan(args);
  const target = artifact(plan, "workspace:ws_old");
  assert.equal(target.lifecycle, "GC_ELIGIBLE");
  assert.equal(target.disposition, "DELETE");
  assert.deepEqual(target.blockers, []);
  assert.equal(existsSync(path), true, "inventory must be side-effect free");

  const result = await applyHostStoragePlan(args, plan.planId, {
    assertWorkspaceSessionUnloaded: () => {},
    deleteWorkspaceSession: () => { deleted += 1; },
  });
  assert.equal(result.removed.some((entry) => entry.id === "workspace:ws_old"), true);
  assert.equal(deleted, 1);
  assert.equal(git(f.source, "worktree", "list", "--porcelain").includes(path), false);

  const replay = await applyHostStoragePlan({ ...args, workspaceSessions: [] }, plan.planId, {
    deleteWorkspaceSession: () => { deleted += 1; },
  });
  assert.deepEqual(replay, result);
  assert.equal(deleted, 1);
});

test("loaded, bound, process-active, process-unknown, resumable-agent, agent-reconciliation, dirty and committed worktrees fail closed", async () => {
  const f = fixture();
  const paths = Object.fromEntries(
    ["loaded", "bound", "process", "processUnknown", "agent", "agentUnknown", "dirty", "committed"]
      .map((name) => [name, makeWorktree(f, name)]),
  ) as Record<string, string>;
  writeFileSync(join(paths.dirty, "untracked.txt"), "do not delete\n");
  writeFileSync(join(paths.committed, "commit.txt"), "preserve commit\n");
  git(paths.committed, "add", ".");
  git(paths.committed, "commit", "-m", "candidate commit");

  const bindings: WorkspaceConversationBinding[] = [{
    conversationScopeId: "conversation",
    targetKey: "target",
    workspaceSessionId: "ws_bound",
    createdAt: "2026-09-17T00:00:00.000Z",
    lastUsedAt: "2026-09-17T00:00:00.000Z",
  }];
  const agents: LocalAgentRecord[] = [
    {
      id: "agt_active",
      workspaceId: "ws_agent",
      workspaceRoot: paths.agent,
      profileName: "test",
      provider: "codex",
      status: "idle",
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    },
    {
      id: "agt_uncertain",
      workspaceId: "ws_agent_unknown",
      workspaceRoot: paths.agentUnknown,
      profileName: "test",
      provider: "codex",
      status: "error",
      terminalReason: "provider_error",
      scopeState: "UNKNOWN",
      lifecycleState: { lifecycleCorrupt: true },
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    },
  ];

  const plan = await buildHostStoragePlan(input(f, {
    workspaceSessions: [
      session(f, "ws_loaded", paths.loaded),
      session(f, "ws_bound", paths.bound),
      session(f, "ws_process", paths.process),
      session(f, "ws_process_unknown", paths.processUnknown),
      session(f, "ws_agent", paths.agent),
      session(f, "ws_agent_unknown", paths.agentUnknown),
      session(f, "ws_dirty", paths.dirty),
      session(f, "ws_committed", paths.committed),
    ],
    conversationBindings: bindings,
    loadedWorkspaceIds: new Set(["ws_loaded"]),
    processWorkspaceStates: new Map([
      ["ws_process", "ACTIVE"],
      ["ws_process_unknown", "UNKNOWN"],
    ]),
    agentRecords: agents,
  }));

  assert.equal(artifact(plan, "workspace:ws_loaded").lifecycle, "ACTIVE");
  assert.equal(artifact(plan, "workspace:ws_bound").lifecycle, "PINNED");
  assert.equal(artifact(plan, "workspace:ws_process").lifecycle, "PINNED");
  assert.equal(artifact(plan, "workspace:ws_process_unknown").lifecycle, "UNKNOWN");
  assert.equal(artifact(plan, "workspace:ws_agent").lifecycle, "PINNED");
  assert.equal(artifact(plan, "workspace:ws_agent_unknown").lifecycle, "UNKNOWN");
  assert.equal(artifact(plan, "workspace:ws_dirty").lifecycle, "TERMINAL_BUT_RETAINED");
  assert.equal(artifact(plan, "workspace:ws_committed").lifecycle, "TERMINAL_BUT_RETAINED");
});

test("canonical containment rejects a managed-worktree symlink that resolves outside worktreeRoot", async () => {
  const f = fixture();
  const outside = makeWorktree(f, "outside", join(f.root, "outside-worktree"));
  const link = join(f.worktreeRoot, "linked");
  symlinkSync(outside, link, "dir");
  const plan = await buildHostStoragePlan(input(f, {
    workspaceSessions: [session(f, "ws_escape", link)],
  }));
  assert.equal(artifact(plan, "workspace:ws_escape").lifecycle, "FOREIGN");
});

test("checkout physical root stays foreign while old unreferenced DevSpace session metadata can be collected", async () => {
  const f = fixture();
  const checkout = checkoutSession(f);
  const args = input(f, { workspaceSessions: [checkout] });
  const plan = await buildHostStoragePlan(args);
  assert.equal(artifact(plan, "workspace:ws_checkout").lifecycle, "FOREIGN");
  assert.equal(artifact(plan, "workspace-record:ws_checkout").lifecycle, "GC_ELIGIBLE");

  let deleted = 0;
  await applyHostStoragePlan(args, plan.planId, {
    assertWorkspaceSessionUnloaded: () => {},
    deleteWorkspaceSession: () => { deleted += 1; },
  });
  assert.equal(deleted, 1);
  assert.equal(existsSync(f.source), true, "GC must not delete a user checkout");
});

test("receipt-owned hidden DevSpace clones can be collected while changed or untracked clones fail closed", async () => {
  const f = fixture();
  const cloneA = join(f.cloneRoot, "clones", "old-clean");
  const cloneChanged = join(f.cloneRoot, "clones", "changed");
  const untracked = join(f.cloneRoot, "audits", "legacy");
  for (const path of [cloneA, cloneChanged, untracked]) {
    mkdirSync(join(path, ".."), { recursive: true });
    execFileSync("git", ["clone", "--quiet", f.source, path]);
  }
  const head = git(cloneA, "rev-parse", "HEAD");
  writeFileSync(join(cloneChanged, "change.txt"), "changed\n");

  const args = input(f, {
    durableOperations: [
      cloneOperation(f, cloneA, head, "succeeded", "op_clean"),
      cloneOperation(f, cloneChanged, head, "succeeded", "op_changed"),
    ],
  });
  const plan = await buildHostStoragePlan(args);
  assert.equal(artifact(plan, "managed-clone:op_clean").lifecycle, "GC_ELIGIBLE");
  assert.equal(artifact(plan, "managed-clone:op_changed").lifecycle, "TERMINAL_BUT_RETAINED");
  const legacy = plan.artifacts.find((entry) => entry.path === realpathSync(untracked));
  assert.ok(legacy);
  assert.equal(legacy.lifecycle, "UNKNOWN");

  await applyHostStoragePlan(args, plan.planId, {
    deleteWorkspaceSession: () => {},
    assertPathUnreferenced: () => {},
  });
  assert.equal(existsSync(cloneA), false);
  assert.equal(existsSync(cloneChanged), true);
  assert.equal(existsSync(untracked), true);
});

test("workspace_clone outside a .devspace-chatgpt ownership root is not a deletion target", async () => {
  const f = fixture();
  const external = join(f.root, "explicit-user-clone");
  execFileSync("git", ["clone", "--quiet", f.source, external]);
  const plan = await buildHostStoragePlan(input(f, {
    durableOperations: [cloneOperation(f, external, git(external, "rev-parse", "HEAD"))],
  }));
  assert.equal(plan.artifacts.some((entry) => entry.kind === "managed_clone" && entry.path === resolve(external)), false);
  assert.equal(existsSync(external), true);
});

test("release retention pins active and rollback candidates and removes only older owned releases", async () => {
  const f = fixture();
  const releases = join(f.packageRoot, "releases");
  mkdirSync(releases, { recursive: true });
  for (const [name, stamp] of [
    ["release-11111111", 1],
    ["release-22222222", 2],
    ["release-abcdef12", 3],
    ["release-44444444", 4],
  ] as const) {
    const path = join(releases, name);
    mkdirSync(path);
    writeFileSync(join(path, "package.json"), JSON.stringify({ name: "@waishnav/devspace" }));
    writeFileSync(join(path, "payload.bin"), "x".repeat(stamp * 32));
    const when = new Date(1_700_000_000_000 + stamp * 1000);
    utimesSync(path, when, when);
  }
  const foreign = join(releases, "release-foreign");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "package.json"), JSON.stringify({ name: "not-devspace" }));

  const args = input(f, {
    releaseKeepCount: 1,
    activeSourceCommit: "abcdef1234567890abcdef1234567890abcdef12",
  });
  const plan = await buildHostStoragePlan(args);
  assert.equal(artifact(plan, "release:release-abcdef12").lifecycle, "ACTIVE");
  assert.equal(artifact(plan, "release:release-44444444").lifecycle, "PINNED");
  assert.equal(artifact(plan, "release:release-11111111").lifecycle, "GC_ELIGIBLE");
  assert.equal(artifact(plan, "release:release-foreign").lifecycle, "UNKNOWN");

  const result = await applyHostStoragePlan(args, plan.planId, { deleteWorkspaceSession: () => {} });
  assert.equal(result.removed.some((entry) => entry.id === "release:release-11111111"), true);
  assert.equal(readFileSync(join(foreign, "package.json"), "utf8").includes("not-devspace"), true);
});

test("browser runtime GC requires ownership, durable terminal reference evidence, and no live profile process", async () => {
  const f = fixture();
  const root = join(f.stateDir, "browser-runtimes");
  const unknown = join(root, "unknown");
  const active = join(root, "active");
  const terminal = join(root, "terminal");
  for (const path of [unknown, active, terminal]) mkdirSync(path, { recursive: true });

  const args = input(f, {
    browserProfileStates: new Map([
      [profileId(active), "ACTIVE"],
      [profileId(terminal), "TERMINAL"],
    ]),
  });
  const plan = await buildHostStoragePlan(args);
  assert.equal(artifact(plan, "browser-runtime:unknown").lifecycle, "UNKNOWN");
  assert.equal(artifact(plan, "browser-runtime:active").lifecycle, "ACTIVE");
  assert.equal(artifact(plan, "browser-runtime:terminal").lifecycle, "GC_ELIGIBLE");

  const unavailable = await buildHostStoragePlan({
    ...args,
    browserReferenceStateAvailable: false,
  });
  assert.equal(artifact(unavailable, "browser-runtime:terminal").lifecycle, "UNKNOWN");
});

test("terminal browser marker never overrides unavailable durable reference evidence", async () => {
  const f = fixture();
  const root = join(f.stateDir, "browser-runtimes");
  const terminal = join(root, "terminal");
  mkdirSync(terminal, { recursive: true });
  writeFileSync(join(terminal, ".devspace-storage.json"), JSON.stringify({
    schema: HOST_STORAGE_BROWSER_MARKER_SCHEMA,
    owner: "devspace",
    kind: "browser_runtime",
    lifecycle: "terminal",
  }));
  const plan = await buildHostStoragePlan(input(f, { browserReferenceStateAvailable: false }));
  assert.equal(artifact(plan, "browser-runtime:terminal").lifecycle, "UNKNOWN");
});

test("browser-runtime symlink escapes are foreign and never deletion targets", async () => {
  const f = fixture();
  const root = join(f.stateDir, "browser-runtimes");
  const outside = join(f.root, "foreign-browser");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(root, "escape"), "dir");
  const plan = await buildHostStoragePlan(input(f));
  assert.equal(artifact(plan, "browser-runtime:escape").lifecycle, "FOREIGN");
  assert.equal(existsSync(outside), true);
});

test("verification/build backups require an explicit DevSpace terminal marker before deletion", async () => {
  const f = fixture();
  const unknown = join(f.packageRoot, ".wave-package-backup-old");
  const terminal = join(f.packageRoot, ".verify-build-backup-terminal");
  mkdirSync(unknown, { recursive: true });
  mkdirSync(terminal, { recursive: true });
  writeFileSync(join(terminal, ".devspace-storage.json"), JSON.stringify({
    schema: HOST_STORAGE_BROWSER_MARKER_SCHEMA,
    owner: "devspace",
    kind: "verification_artifact",
    lifecycle: "terminal",
  }));

  const args = input(f);
  const plan = await buildHostStoragePlan(args);
  assert.equal(artifact(plan, "verification-artifact:.wave-package-backup-old").lifecycle, "UNKNOWN");
  assert.equal(artifact(plan, "verification-artifact:.verify-build-backup-terminal").lifecycle, "GC_ELIGIBLE");

  await applyHostStoragePlan(args, plan.planId, { deleteWorkspaceSession: () => {} });
  assert.equal(existsSync(unknown), true);
  assert.equal(existsSync(terminal), false);
});

test("apply refuses a stale inventory hash before any deletion", async () => {
  const f = fixture();
  const releases = join(f.packageRoot, "releases");
  mkdirSync(releases, { recursive: true });
  for (const name of ["release-11111111", "release-22222222"]) {
    const path = join(releases, name);
    mkdirSync(path);
    writeFileSync(join(path, "package.json"), JSON.stringify({ name: "@waishnav/devspace" }));
  }
  const args = input(f, { releaseKeepCount: 1 });
  const plan = await buildHostStoragePlan(args);
  writeFileSync(join(releases, "release-11111111", "changed.txt"), "drift");

  await assert.rejects(
    () => applyHostStoragePlan(args, plan.planId, { deleteWorkspaceSession: () => {} }),
    /STORAGE_PLAN_STALE/,
  );
  assert.equal(existsSync(join(releases, "release-11111111")), true);
});

test("interrupted cleanup leaves a reconciliation receipt and exact replay never repeats deletion", async () => {
  const f = fixture();
  const path = makeWorktree(f, "interrupted");
  const args = input(f, { workspaceSessions: [session(f, "ws_interrupted", path)] });
  const plan = await buildHostStoragePlan(args);
  let deletes = 0;

  await assert.rejects(
    () => applyHostStoragePlan(args, plan.planId, {
      assertWorkspaceSessionUnloaded: () => {},
      deleteWorkspaceSession: () => {
        deletes += 1;
        throw new Error("simulated durable-store failure");
      },
    }),
    /STORAGE_RECONCILIATION_REQUIRED/,
  );
  assert.equal(deletes, 1);
  assert.equal(existsSync(path), false, "physical worktree effect occurred before simulated DB failure");

  await assert.rejects(
    () => applyHostStoragePlan(args, plan.planId, {
      deleteWorkspaceSession: () => { deletes += 1; },
    }),
    /STORAGE_RECONCILIATION_REQUIRED/,
  );
  assert.equal(deletes, 1, "replay must not repeat a partially applied destructive effect");
});
