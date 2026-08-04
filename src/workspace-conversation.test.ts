import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig, type ServerConfig } from "./config.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

test("a conversation reuses its checkout and receives bootstrap once", async (t) => {
  const { project, registry } = await fixture(t);
  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const second = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  assert.equal(second.workspace.id, first.workspace.id);
  assert.equal(first.workspaceReused, false);
  assert.equal(second.workspaceReused, true);
  assert.equal(first.includeBootstrapContext, true);
  assert.equal(second.includeBootstrapContext, false);
});

test("different conversations receive different checkout workspaces", async (t) => {
  const { project, registry } = await fixture(t);
  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const second = await registry.openWorkspace(project, { conversationScopeId: "chat-2" });

  assert.notEqual(second.workspace.id, first.workspace.id);
  assert.equal(first.includeBootstrapContext, true);
  assert.equal(second.includeBootstrapContext, true);
});

test("worktree requests stay fresh without replacing the reusable checkout", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const checkout = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const firstWorktree = await registry.openWorkspace(
    { path: project, mode: "worktree" },
    { conversationScopeId: "chat-1" },
  );
  const secondWorktree = await registry.openWorkspace(
    { path: project, mode: "worktree" },
    { conversationScopeId: "chat-1" },
  );
  const checkoutAgain = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  assert.notEqual(firstWorktree.workspace.id, secondWorktree.workspace.id);
  assert.notEqual(firstWorktree.workspace.root, secondWorktree.workspace.root);
  assert.equal(firstWorktree.workspaceReused, false);
  assert.equal(secondWorktree.workspaceReused, false);
  assert.equal(firstWorktree.includeBootstrapContext, false);
  assert.equal(secondWorktree.includeBootstrapContext, false);
  assert.equal(checkoutAgain.workspace.id, checkout.workspace.id);
});

test("concurrent worktree opens deliver project bootstrap once", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const opens = await Promise.all([
    registry.openWorkspace(
      { path: project, mode: "worktree" },
      { conversationScopeId: "chat-1" },
    ),
    registry.openWorkspace(
      { path: project, mode: "worktree" },
      { conversationScopeId: "chat-1" },
    ),
  ]);

  assert.notEqual(opens[0]?.workspace.id, opens[1]?.workspace.id);
  assert.equal(opens.filter((open) => open.includeBootstrapContext).length, 1);
});

test("checkout reuse survives a registry restart", async (t) => {
  const context = await fixture(t);
  const first = await context.registry.openWorkspace(context.project, {
    conversationScopeId: "chat-1",
  });
  context.closeStore(context.store);

  const restoredStore = context.openStore();
  const restoredRegistry = new WorkspaceRegistry(context.config, restoredStore);
  const restored = await restoredRegistry.openWorkspace(context.project, {
    conversationScopeId: "chat-1",
  });

  assert.equal(restored.workspace.id, first.workspace.id);
  assert.equal(restored.workspaceReused, true);
  assert.equal(restored.includeBootstrapContext, false);
});

test("context failures neither consume bootstrap nor discard a checkout binding", async (t) => {
  const { project, registry } = await fixture(t);
  const agentsDir = join(project, ".devspace", "agents");
  const backupDir = join(project, ".devspace", "agents-backup");

  await breakAgentsDirectory(agentsDir, backupDir);
  await assert.rejects(
    () => registry.openWorkspace(project, { conversationScopeId: "chat-1" }),
    /directory|ENOTDIR/i,
  );
  await restoreAgentsDirectory(agentsDir, backupDir);

  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  assert.equal(first.includeBootstrapContext, true);

  await breakAgentsDirectory(agentsDir, backupDir);
  await assert.rejects(
    () => registry.openWorkspace(project, { conversationScopeId: "chat-1" }),
    /directory|ENOTDIR/i,
  );
  await restoreAgentsDirectory(agentsDir, backupDir);

  const recovered = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  assert.equal(recovered.workspace.id, first.workspace.id);
  assert.equal(recovered.workspaceReused, true);
  assert.equal(recovered.includeBootstrapContext, false);
});

test("a deleted checkout is replaced without repeating project bootstrap", async (t) => {
  const { project, registry } = await fixture(t);
  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  await rm(project, { recursive: true, force: true });
  const replacement = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  assert.notEqual(replacement.workspace.id, first.workspace.id);
  assert.equal(replacement.workspaceReused, false);
  assert.equal(replacement.includeBootstrapContext, false);
  assert.equal((await stat(project)).isDirectory(), true);
});

test("canonical checkout identity survives symlink aliases and a missing target", { skip: platform() === "win32" }, async (t) => {
  const { root, project, registry } = await fixture(t);
  const alias = join(root, "project-alias");
  const target = join(project, "temporary-checkout");
  const aliasedTarget = join(alias, "temporary-checkout");
  await symlink(project, alias, "dir");
  await mkdir(target);

  const direct = await registry.openWorkspace(target, { conversationScopeId: "chat-1" });
  const aliased = await registry.openWorkspace(aliasedTarget, { conversationScopeId: "chat-1" });
  assert.equal(aliased.workspace.id, direct.workspace.id);

  await rm(target, { recursive: true, force: true });
  const replacement = await registry.openWorkspace(aliasedTarget, {
    conversationScopeId: "chat-1",
  });
  assert.notEqual(replacement.workspace.id, direct.workspace.id);
  assert.equal(replacement.includeBootstrapContext, false);
});

interface WorkspaceFixture {
  root: string;
  project: string;
  stateDir: string;
  config: ServerConfig;
  store: SqliteWorkspaceStore;
  registry: WorkspaceRegistry;
  openStore: () => SqliteWorkspaceStore;
  closeStore: (store: SqliteWorkspaceStore) => void;
}

async function fixture(
  t: TestContext,
  options: { git?: boolean } = {},
): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-conversation-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");
  const stores = new Set<SqliteWorkspaceStore>();
  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) await initializeGitRepository(project);

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const openStore = () => {
    const store = new SqliteWorkspaceStore(stateDir);
    stores.add(store);
    return store;
  };
  const closeStore = (store: SqliteWorkspaceStore) => {
    if (stores.delete(store)) store.close();
  };
  const store = openStore();
  t.after(async () => {
    for (const openStore of stores) openStore.close();
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    project,
    stateDir,
    config,
    store,
    registry: new WorkspaceRegistry(config, store),
    openStore,
    closeStore,
  };
}

async function breakAgentsDirectory(agentsDir: string, backupDir: string): Promise<void> {
  await rename(agentsDir, backupDir);
  await writeFile(agentsDir, "not a directory\n");
}

async function restoreAgentsDirectory(agentsDir: string, backupDir: string): Promise<void> {
  await rm(agentsDir, { force: true });
  await rename(backupDir, agentsDir);
}

async function initializeGitRepository(root: string): Promise<void> {
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Initial commit"]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
