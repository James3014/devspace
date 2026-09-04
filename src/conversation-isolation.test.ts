import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer } from "./server.js";
import {
  CONVERSATION_CHECKOUT_SHARED,
  CONVERSATION_WORKSPACE_REBIND_REQUIRED,
  isReadOnlyInspectionCommand,
} from "./conversation-isolation.js";
import type {
  WorkspaceConversationBinding,
  WorkspaceSession,
  WorkspaceStore,
} from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

class MemoryWorkspaceStore implements WorkspaceStore {
  readonly sessions = new Map<string, WorkspaceSession>();
  readonly bindings = new Map<string, WorkspaceConversationBinding>();

  createSession(input: {
    id: string;
    root: string;
    mode?: "checkout" | "worktree";
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      managed: input.managed ?? false,
      createdAt: now,
      lastUsedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    return this.sessions.get(id);
  }

  touchSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.lastUsedAt = new Date().toISOString();
  }

  getConversationBinding(conversationScopeId: string, targetKey: string): WorkspaceConversationBinding | undefined {
    return this.bindings.get(JSON.stringify([conversationScopeId, targetKey]));
  }

  listConversationBindingsForTarget(targetKey: string): WorkspaceConversationBinding[] {
    return [...this.bindings.values()].filter((binding) => binding.targetKey === targetKey);
  }

  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding {
    const key = JSON.stringify([input.conversationScopeId, input.targetKey]);
    const existing = this.bindings.get(key);
    const now = new Date().toISOString();
    const binding: WorkspaceConversationBinding = {
      conversationScopeId: input.conversationScopeId,
      targetKey: input.targetKey,
      workspaceSessionId: input.workspaceSessionId,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    };
    this.bindings.set(key, binding);
    return binding;
  }

  touchConversationBinding(conversationScopeId: string, targetKey: string): void {
    const binding = this.getConversationBinding(conversationScopeId, targetKey);
    if (binding) binding.lastUsedAt = new Date().toISOString();
  }

  deleteConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.bindings.delete(JSON.stringify([conversationScopeId, targetKey]));
  }
}

async function fixture(t: TestContext, options: { git?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "devspace-conversation-isolation-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(project, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(project, "AGENTS.md"), "test project\n");
  if (options.git) {
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: project });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: project });
    await writeFile(join(project, "tracked.txt"), "base\n");
    await execFileAsync("git", ["add", "tracked.txt", "AGENTS.md"], { cwd: project });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: project });
  }
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const store = new MemoryWorkspaceStore();
  const registry = new WorkspaceRegistry(config, store);
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { root, project, store, registry };
}

test("two active conversations sharing one physical checkout are detected and direct mutation is blocked", async (t) => {
  const { project, registry } = await fixture(t);
  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-a" });
  const second = await registry.openWorkspace(project, { conversationScopeId: "chat-b" });

  assert.notEqual(first.workspace.id, second.workspace.id);
  const firstSafety = await registry.conversationMutationSafety(first.workspace.id, "chat-a");
  const secondSafety = await registry.conversationMutationSafety(second.workspace.id, "chat-b");
  assert.equal(firstSafety.reason, CONVERSATION_CHECKOUT_SHARED);
  assert.equal(secondSafety.reason, CONVERSATION_CHECKOUT_SHARED);
  assert.equal(firstSafety.competingConversationCount, 1);
  assert.equal(secondSafety.competingConversationCount, 1);
  await assert.rejects(
    () => registry.assertConversationMutationAllowed(first.workspace.id, "chat-a"),
    /CONVERSATION_CHECKOUT_SHARED/,
  );
});

test("same conversation checkout reuse remains mutation-eligible when no competitor exists", async (t) => {
  const { project, registry } = await fixture(t);
  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-a" });
  const repeated = await registry.openWorkspace(project, { conversationScopeId: "chat-a" });
  assert.equal(repeated.workspace.id, first.workspace.id);
  const safety = await registry.assertConversationMutationAllowed(first.workspace.id, "chat-a");
  assert.equal(safety.state, "SINGLE_CONVERSATION_CHECKOUT");
  assert.equal(safety.mutationAllowed, true);
});

test("using another conversation's workspace id fails closed and asks for rebind", async (t) => {
  const { project, registry } = await fixture(t);
  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-a" });
  const safety = await registry.conversationMutationSafety(first.workspace.id, "chat-b");
  assert.equal(safety.reason, CONVERSATION_WORKSPACE_REBIND_REQUIRED);
  assert.equal(safety.mutationAllowed, false);
});

test("managed worktrees remain independently mutation-eligible", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  await registry.openWorkspace(project, { conversationScopeId: "chat-a" });
  await registry.openWorkspace(project, { conversationScopeId: "chat-b" });
  const isolated = await registry.openWorkspace(
    { path: project, mode: "worktree" },
    { conversationScopeId: "chat-a" },
  );
  const safety = await registry.assertConversationMutationAllowed(isolated.workspace.id, "chat-a");
  assert.equal(safety.state, "ISOLATED_WORKTREE");
  assert.equal(safety.mutationAllowed, true);
});

test("shell classifier permits bounded inspection but treats tests/builds and unknown commands as consequential", () => {
  assert.equal(isReadOnlyInspectionCommand("git status --short && git diff --stat"), true);
  assert.equal(isReadOnlyInspectionCommand("rg -n foo src && git rev-parse HEAD"), true);
  assert.equal(isReadOnlyInspectionCommand("git branch --show-current"), true);
  assert.equal(isReadOnlyInspectionCommand("npm test"), false);
  assert.equal(isReadOnlyInspectionCommand("git checkout main"), false);
  assert.equal(isReadOnlyInspectionCommand("rg foo src > out.txt"), false);
  assert.equal(isReadOnlyInspectionCommand("node script.js"), false);
});

test("production MCP write/edit shell admission blocks shared checkout mutation while read/inspection remains usable", async (t) => {
  const { project, registry } = await fixture(t);
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(project, ".config"),
    DEVSPACE_ALLOWED_ROOTS: project,
    DEVSPACE_WORKTREE_ROOT: join(project, ".worktrees"),
    DEVSPACE_AGENT_DIR: join(project, ".agents"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_TOOL_MODE: "minimal",
    PORT: "1",
  });
  const server = createMcpServer(
    config,
    registry,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => [],
    [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "conversation-isolation-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const call = (name: string, args: Record<string, unknown>, conversationScopeId: string) =>
    client.callTool({
      name,
      arguments: args,
      _meta: { "openai/session": conversationScopeId },
    } as Parameters<Client["callTool"]>[0]);

  const firstOpen = await call("open_workspace", { path: project }, "chat-a");
  await call("open_workspace", { path: project }, "chat-b");
  const firstWorkspaceId = (firstOpen.structuredContent as Record<string, unknown>).workspaceId as string;

  const blockedWrite = await call("write", {
    workspaceId: firstWorkspaceId,
    path: "blocked.txt",
    content: "must not be written\n",
  }, "chat-a");
  assert.equal(blockedWrite.isError, true);
  assert.match(responseText(blockedWrite), /CONVERSATION_CHECKOUT_SHARED/);

  const blockedEdit = await call("edit", {
    workspaceId: firstWorkspaceId,
    path: "AGENTS.md",
    edits: [{ oldText: "test project", newText: "changed" }],
  }, "chat-a");
  assert.equal(blockedEdit.isError, true);
  assert.match(responseText(blockedEdit), /CONVERSATION_CHECKOUT_SHARED/);

  const readResult = await call("read", {
    workspaceId: firstWorkspaceId,
    path: "AGENTS.md",
  }, "chat-a");
  assert.notEqual(readResult.isError, true);
  assert.match(responseText(readResult), /test project/);

  const inspectResult = await call("bash", {
    workspaceId: firstWorkspaceId,
    command: "pwd",
    attemptKey: "shared-read-only-pwd",
  }, "chat-a");
  assert.notEqual(inspectResult.isError, true);

  const blockedShell = await call("bash", {
    workspaceId: firstWorkspaceId,
    command: "node script.js",
    attemptKey: "shared-consequential-shell",
  }, "chat-a");
  assert.equal(blockedShell.isError, true);
  assert.match(responseText(blockedShell), /CONVERSATION_CHECKOUT_SHARED/);
});

test("Codex-compatible apply_patch and consequential exec_command share the same checkout admission gate", async (t) => {
  const { project, registry } = await fixture(t);
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(project, ".config-codex"),
    DEVSPACE_ALLOWED_ROOTS: project,
    DEVSPACE_WORKTREE_ROOT: join(project, ".worktrees-codex"),
    DEVSPACE_AGENT_DIR: join(project, ".agents-codex"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_TOOL_MODE: "codex",
    PORT: "1",
  });
  const server = createMcpServer(
    config,
    registry,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => [],
    [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "conversation-isolation-codex-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const call = (name: string, args: Record<string, unknown>, conversationScopeId: string) =>
    client.callTool({
      name,
      arguments: args,
      _meta: { "openai/session": conversationScopeId },
    } as Parameters<Client["callTool"]>[0]);

  const firstOpen = await call("open_workspace", { path: project }, "chat-a");
  await call("open_workspace", { path: project }, "chat-b");
  const firstWorkspaceId = (firstOpen.structuredContent as Record<string, unknown>).workspaceId as string;

  const blockedPatch = await call("apply_patch", {
    workspaceId: firstWorkspaceId,
    patch: "*** Begin Patch\n*** Update File: AGENTS.md\n@@\n-test project\n+changed\n*** End Patch",
  }, "chat-a");
  assert.equal(blockedPatch.isError, true);
  assert.match(responseText(blockedPatch), /CONVERSATION_CHECKOUT_SHARED/);

  const inspectResult = await call("exec_command", {
    workspaceId: firstWorkspaceId,
    cmd: "pwd",
    attemptKey: "codex-shared-read-only-pwd",
  }, "chat-a");
  assert.notEqual(inspectResult.isError, true);

  const blockedExec = await call("exec_command", {
    workspaceId: firstWorkspaceId,
    cmd: "npm test",
    attemptKey: "codex-shared-consequential-command",
  }, "chat-a");
  assert.equal(blockedExec.isError, true);
  assert.match(responseText(blockedExec), /CONVERSATION_CHECKOUT_SHARED/);
});

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first.text as string;
}
