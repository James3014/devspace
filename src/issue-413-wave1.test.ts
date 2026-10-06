import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { createMcpServer } from "./server.js";
import { LocalAgentSessionManager } from "./local-agent-sessions.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { CodexGoalSessionManager } from "./codex-goal-sessions.js";

interface TestEnv {
  tempDir: string;
  allowedRoot: string;
  stateDir: string;
  worktreeRoot: string;
  createClient: (toolMode?: "minimal" | "dispatch" | "codex" | "full", subagents?: boolean) => Promise<{ client: Client; close: () => Promise<void> }>;
  closeAll: () => Promise<void>;
}

async function setupTestEnv(t: TestContext): Promise<TestEnv> {
  const tempDir = await mkdtemp(join(tmpdir(), "devspace-issue413-wave1-"));
  const allowedRoot = join(tempDir, "allowed");
  const stateDir = join(tempDir, "state");
  const worktreeRoot = join(tempDir, "worktrees");
  const agentDir = join(tempDir, "agents");

  await mkdir(allowedRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const closers: Array<() => Promise<void>> = [];

  const createClient = async (toolMode: "minimal" | "dispatch" | "codex" | "full" = "full", subagents = true) => {
    const config = loadConfig({
      DEVSPACE_ALLOWED_ROOTS: allowedRoot,
      DEVSPACE_WORKTREE_ROOT: worktreeRoot,
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_AGENT_DIR: agentDir,
      DEVSPACE_TOOL_MODE: toolMode,
      DEVSPACE_CODEX_GOALS: toolMode === "codex" ? "1" : undefined,
    });

    const store = new SqliteWorkspaceStore(stateDir);
    const workspaces = new WorkspaceRegistry(config, store);
    const processSessions = new ProcessSessionManager();
    const agentSessionManager = subagents
      ? new LocalAgentSessionManager(config, async () => {}, async () => true)
      : undefined;

    const codexGoals = toolMode === "codex"
      ? new CodexGoalSessionManager(processSessions, {
          codexBin: "/bin/echo",
          startupTimeoutMs: 8000,
          activationPollMs: 80,
          typeChunkCharacters: 24,
          typeChunkDelayMs: 30,
          cancelTimeoutMs: 3000,
        })
      : undefined;

    const server = createMcpServer(
      config,
      workspaces,
      createReviewCheckpointManager(),
      processSessions,
      () => [{ id: "codex", enabled: true, available: true, usable: true } as any],
      [],
      agentSessionManager,
      codexGoals,
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `test-client-${toolMode}`, version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const close = async () => {
      await client.close();
      await server.close();
      codexGoals?.shutdown();
      agentSessionManager?.close();
      processSessions.shutdown();
      store.close();
    };
    closers.push(close);
    return { client, close };
  };

  const closeAll = async () => {
    for (const closer of closers.reverse()) {
      await closer().catch(() => {});
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  };
  t.after(closeAll);

  return { tempDir, allowedRoot, stateDir, worktreeRoot, createClient, closeAll };
}

function initGitRepo(repoDir: string, remoteDir: string): void {
  execFileSync("git", ["init", "--bare", remoteDir]);
  execFileSync("git", ["init", repoDir]);
  execFileSync("git", ["config", "user.name", "DevSpace Test"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@devspace.local"], { cwd: repoDir });
  execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
  execFileSync("git", ["commit", "--allow-empty", "-m", "Initial commit"], { cwd: repoDir });
  execFileSync("git", ["push", "-u", "origin", "HEAD:main"], { cwd: repoDir });
}

function structuredContent(res: unknown): Record<string, unknown> {
  const r = res as { structuredContent?: Record<string, unknown> };
  return r?.structuredContent ?? {};
}

function responseText(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> })?.content;
  return content?.map((c) => c.text ?? "").join("\n") ?? "";
}

// ── Test 1: Nexus enrollment does not alter execution semantics ──────────────
test("Test 1: Repository with vs without .nexus-core/config.toml exhibits identical direct execution semantics", async (t) => {
  const env = await setupTestEnv(t);
  const { client } = await env.createClient("full");

  const repoA = join(env.allowedRoot, "repo-a");
  const remoteA = join(env.tempDir, "remote-a.git");
  initGitRepo(repoA, remoteA);

  const repoB = join(env.allowedRoot, "repo-b");
  const remoteB = join(env.tempDir, "remote-b.git");
  initGitRepo(repoB, remoteB);
  // Repo B is enrolled in Nexus Core
  await mkdir(join(repoB, ".nexus-core"), { recursive: true });
  await writeFile(join(repoB, ".nexus-core", "config.toml"), "schema_version = 1\n");
  execFileSync("git", ["add", ".nexus-core/config.toml"], { cwd: repoB });
  execFileSync("git", ["commit", "-m", "enroll in nexus"], { cwd: repoB });
  execFileSync("git", ["push", "origin", "HEAD:main"], { cwd: repoB });

  // Open both in worktree mode
  const openA = await client.callTool({ name: "open_workspace", arguments: { path: repoA, mode: "worktree" } });
  assert.equal(openA.isError, undefined);
  const wsA = structuredContent(openA).workspaceId as string;

  const openB = await client.callTool({ name: "open_workspace", arguments: { path: repoB, mode: "worktree" } });
  assert.equal(openB.isError, undefined);
  const wsB = structuredContent(openB).workspaceId as string;

  // Direct write on Repo A (no nexus config)
  const writeA = await client.callTool({
    name: "write",
    arguments: { workspaceId: wsA, path: "hello.txt", content: "wave1 direct write\n" },
  });
  assert.equal(writeA.isError, undefined, responseText(writeA));

  // Direct write on Repo B (has .nexus-core/config.toml)
  const writeB = await client.callTool({
    name: "write",
    arguments: { workspaceId: wsB, path: "hello.txt", content: "wave1 direct write\n" },
  });
  assert.equal(writeB.isError, undefined, responseText(writeB));

  // Invariant: Both succeed with identical results, no Nexus admission checks block Repo B
  assert.equal(structuredContent(writeA).created, structuredContent(writeB).created);
  assert.equal(structuredContent(writeA).coreMutation, undefined);
  assert.equal(structuredContent(writeB).coreMutation, undefined);

  // Direct edit on both
  const editA = await client.callTool({
    name: "edit",
    arguments: { workspaceId: wsA, path: "hello.txt", edits: [{ oldText: "wave1 direct write\n", newText: "wave1 edited\n" }] },
  });
  const editB = await client.callTool({
    name: "edit",
    arguments: { workspaceId: wsB, path: "hello.txt", edits: [{ oldText: "wave1 direct write\n", newText: "wave1 edited\n" }] },
  });
  assert.equal(editA.isError, undefined);
  assert.equal(editB.isError, undefined);

  // Direct bash execution on both
  const bashA = await client.callTool({
    name: "bash",
    arguments: { workspaceId: wsA, command: "echo test-exec", attemptKey: "bash-a-1" },
  });
  const bashB = await client.callTool({
    name: "bash",
    arguments: { workspaceId: wsB, command: "echo test-exec", attemptKey: "bash-b-1" },
  });
  assert.equal(bashA.isError, undefined, responseText(bashA));
  assert.equal(bashB.isError, undefined, responseText(bashB));
  assert.match(responseText(bashA), /test-exec/);
  assert.match(responseText(bashB), /test-exec/);
});

// ── Test 2: Nexus governance tools are absent from Dev MCP catalog ───────────
test("Test 2: Server catalog excludes all core_mutation_*, nexus_gateway_*, and coordination_* governance tools across all modes", async (t) => {
  const env = await setupTestEnv(t);

  const modes: Array<"minimal" | "dispatch" | "codex" | "full"> = ["minimal", "dispatch", "codex", "full"];

  for (const mode of modes) {
    const { client } = await env.createClient(mode);
    const list = await client.listTools();
    const toolNames = list.tools.map((tool) => tool.name);

    // Verify absence of any core_mutation tools
    const coreMutationTools = toolNames.filter((name) => name.startsWith("core_mutation_"));
    assert.deepEqual(coreMutationTools, [], `mode ${mode} must not register any core_mutation_* tools`);

    // Verify absence of any nexus_gateway tools
    const nexusGatewayTools = toolNames.filter((name) => name.startsWith("nexus_gateway_"));
    assert.deepEqual(nexusGatewayTools, [], `mode ${mode} must not register any nexus_gateway_* tools`);

    // Verify absence of Wave 1 removed coordination tools
    const coordinationTools = toolNames.filter((name) => name.startsWith("coordination_"));
    assert.deepEqual(coordinationTools, [], `mode ${mode} must not register any coordination_* governance tools`);
  }
});

// ── Test 3: Agent durable replay ─────────────────────────────────────────────
test("Test 3: Agent attemptKey replay is idempotent for identical requests and fails closed on conflict", async (t) => {
  const env = await setupTestEnv(t);
  const { client } = await env.createClient("full");

  const repo = join(env.allowedRoot, "repo-replay");
  const remote = join(env.tempDir, "remote-replay.git");
  initGitRepo(repo, remote);

  // Add mutator agent profile
  await mkdir(join(repo, ".devspace", "agents"), { recursive: true });
  await writeFile(
    join(repo, ".devspace", "agents", "mutator.md"),
    "---\nname: mutator\ndescription: test mutator\nprovider: codex\n---\nPrompt mutator\n",
  );
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "add mutator profile"], { cwd: repo });
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();

  const openRes = await client.callTool({ name: "open_workspace", arguments: { path: repo, mode: "worktree" } });
  const workspaceId = structuredContent(openRes).workspaceId as string;

  const attemptKey = "wave1-replay-key-001";
  const startArgs = {
    workspaceId,
    profile: "mutator",
    prompt: "First execution prompt",
    attemptKey,
    executionContract: {
      authorityMode: "OWNER_DIRECT",
      expectedHead: headSha,
      writePaths: ["file.txt"],
    },
  };

  // 1. Initial agent start
  const first = await client.callTool({ name: "agent_start", arguments: startArgs });
  assert.equal(first.isError, undefined, responseText(first));
  const agentId = structuredContent(first).agentId as string;
  assert.ok(agentId, "first launch should return agentId");

  // 2. Replay with identical attemptKey and identical arguments -> rendezvous with original agentId
  const replay = await client.callTool({ name: "agent_start", arguments: startArgs });
  assert.equal(replay.isError, undefined);
  assert.equal(structuredContent(replay).agentId, agentId, "identical replay must return same agentId");

  // 3. Replay with conflicting prompt -> fail closed
  const conflict = await client.callTool({
    name: "agent_start",
    arguments: { ...startArgs, prompt: "Conflicting prompt with same attemptKey" },
  });
  assert.equal(conflict.isError, true, "conflicting replay must fail closed");
  assert.match(responseText(conflict), /ATTEMPT_REPLAY_CONFLICT|materially different|conflict/i);
});

// ── Test 4: Lost ACK does not duplicate worker ───────────────────────────────
test("Test 4: Lost ACK recovery via agent_status/agent_reconcile preserves attempt identity without duplicate worker", async (t) => {
  const env = await setupTestEnv(t);
  const { client } = await env.createClient("full");

  const repo = join(env.allowedRoot, "repo-ack");
  const remote = join(env.tempDir, "remote-ack.git");
  initGitRepo(repo, remote);

  await mkdir(join(repo, ".devspace", "agents"), { recursive: true });
  await writeFile(
    join(repo, ".devspace", "agents", "mutator.md"),
    "---\nname: mutator\ndescription: test mutator\nprovider: codex\n---\nPrompt mutator\n",
  );
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "add mutator profile"], { cwd: repo });
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();

  const openRes = await client.callTool({ name: "open_workspace", arguments: { path: repo, mode: "worktree" } });
  const workspaceId = structuredContent(openRes).workspaceId as string;

  const attemptKey = "lost-ack-attempt-002";
  const startArgs = {
    workspaceId,
    profile: "mutator",
    prompt: "Worker execution prompt",
    attemptKey,
    executionContract: {
      authorityMode: "OWNER_DIRECT",
      expectedHead: headSha,
      writePaths: ["output.txt"],
    },
  };

  const started = await client.callTool({ name: "agent_start", arguments: startArgs });
  assert.equal(started.isError, undefined);
  const agentId = structuredContent(started).agentId as string;

  // Simulate client transport interruption: client checks status
  const status = await client.callTool({ name: "agent_status", arguments: { workspaceId, agentId } });
  assert.equal(status.isError, undefined);
  assert.equal(structuredContent(status).agentId, agentId);

  // Client retries agent_start after lost ACK
  const retryStart = await client.callTool({ name: "agent_start", arguments: startArgs });
  assert.equal(retryStart.isError, undefined);
  assert.equal(structuredContent(retryStart).agentId, agentId);

  // Check store only has 1 agent for this workspace
  const store = new LocalAgentStore(env.stateDir);
  try {
    const list = store.list({ workspaceId });
    assert.equal(list.length, 1, "must not launch duplicate worker");
  } finally {
    store.close();
  }
});

// ── Test 5: Workspace safety ─────────────────────────────────────────────────
test("Test 5: Shared checkout competing mutation is blocked while isolated worktree is writable", async (t) => {
  const env = await setupTestEnv(t);
  const { client } = await env.createClient("minimal");

  const repo = join(env.allowedRoot, "repo-safety");
  const remote = join(env.tempDir, "remote-safety.git");
  initGitRepo(repo, remote);

  // 1. Conversation A opens canonical checkout
  const openCheckoutA = await client.callTool({
    name: "open_workspace",
    arguments: { path: repo, mode: "checkout" },
    _meta: { "openai/session": "conversation-alpha" },
  });
  const wsCheckoutA = structuredContent(openCheckoutA).workspaceId as string;

  // Conversation B attempts to mutate checkout without isolated worktree -> competing conversation blocked
  const writeCheckoutB = await client.callTool({
    name: "write",
    arguments: { workspaceId: wsCheckoutA, path: "test.txt", content: "mutation" },
    _meta: { "openai/session": "conversation-beta" },
  });
  assert.equal(writeCheckoutB.isError, true, "mutation on shared checkout by competing conversation must be blocked");
  assert.match(responseText(writeCheckoutB), /SHARED_CHECKOUT|isolated worktree|competing/i);

  // 2. Conversation B opens isolated worktree
  const openWorktreeB = await client.callTool({
    name: "open_workspace",
    arguments: { path: repo, mode: "worktree" },
    _meta: { "openai/session": "conversation-beta" },
  });
  const wsWorktreeB = structuredContent(openWorktreeB).workspaceId as string;

  // Mutation in isolated worktree succeeds
  const writeWorktree = await client.callTool({
    name: "write",
    arguments: { workspaceId: wsWorktreeB, path: "test.txt", content: "mutation" },
    _meta: { "openai/session": "conversation-beta" },
  });
  assert.equal(writeWorktree.isError, undefined, responseText(writeWorktree));
  assert.match(responseText(writeWorktree), /Successfully wrote.*test\.txt/i);
});

// ── Test 6: expectedHead guard ───────────────────────────────────────────────
test("Test 6: expectedHead mismatch fails closed before mutation effect", async (t) => {
  const env = await setupTestEnv(t);
  const { client } = await env.createClient("minimal");

  const repo = join(env.allowedRoot, "repo-head-guard");
  const remote = join(env.tempDir, "remote-head-guard.git");
  initGitRepo(repo, remote);

  const openRes = await client.callTool({ name: "open_workspace", arguments: { path: repo, mode: "worktree" } });
  const workspaceId = structuredContent(openRes).workspaceId as string;

  await client.callTool({
    name: "write",
    arguments: { workspaceId, path: "staged.txt", content: "staged content\n" },
  });

  // Call git_commit with wrong expectedHead
  const commitMismatch = await client.callTool({
    name: "git_commit",
    arguments: {
      workspaceId,
      expectedHead: "0".repeat(40),
      message: "should fail",
      paths: ["staged.txt"],
    },
  });
  assert.equal(commitMismatch.isError, true, "mismatched expectedHead must fail closed");
  assert.match(responseText(commitMismatch), /GIT_HEAD_MISMATCH|expectedHead/i);
});

// ── Test 7: Write scope bound enforcement ────────────────────────────────────
test("Test 7: Worker write scope (writePaths) is enforced for direct workers", async (t) => {
  const env = await setupTestEnv(t);
  const { client } = await env.createClient("dispatch");

  const repo = join(env.allowedRoot, "repo-scope");
  const remote = join(env.tempDir, "remote-scope.git");
  initGitRepo(repo, remote);

  await mkdir(join(repo, ".devspace", "agents"), { recursive: true });
  await writeFile(
    join(repo, ".devspace", "agents", "mutator.md"),
    "---\nname: mutator\ndescription: test mutator\nprovider: codex\nwrite_mode: allowed\n---\nPrompt mutator\n",
  );
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "add mutator profile"], { cwd: repo });
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();

  const openRes = await client.callTool({ name: "open_workspace", arguments: { path: repo, mode: "worktree" } });
  const workspaceId = structuredContent(openRes).workspaceId as string;

  // In dispatch mode, worker without bounded writePaths must be rejected
  const unbounded = await client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "mutator",
      prompt: "unbounded worker",
      attemptKey: "scope-test-1",
      executionContract: {
        authorityMode: "OWNER_DIRECT",
        expectedHead: headSha,
        // no writePaths supplied
      },
    },
  });
  assert.equal(unbounded.isError, true);
  assert.match(responseText(unbounded), /writePaths/i);
});

// ── Test 8: Tool mode separation ─────────────────────────────────────────────
test("Test 8: Tool modes (minimal, dispatch, codex, full) surface separation is strictly preserved", async (t) => {
  const env = await setupTestEnv(t);

  const minimal = await env.createClient("minimal");
  const minimalTools = (await minimal.client.listTools()).tools.map((t) => t.name);

  const dispatch = await env.createClient("dispatch");
  const dispatchTools = (await dispatch.client.listTools()).tools.map((t) => t.name);

  const codex = await env.createClient("codex");
  const codexTools = (await codex.client.listTools()).tools.map((t) => t.name);

  // Minimal mode has direct coding tools, but NO agent tools
  assert.ok(minimalTools.includes("read"));
  assert.ok(minimalTools.includes("write"));
  assert.ok(minimalTools.includes("edit"));
  assert.ok(minimalTools.includes("apply_patch"));
  assert.ok(minimalTools.includes("bash"));
  assert.equal(minimalTools.includes("agent_start"), false, "minimal mode must not include agent_start");

  // Dispatch mode has agent dispatch tools, but NO raw mutation tools
  assert.ok(dispatchTools.includes("agent_start"));
  assert.ok(dispatchTools.includes("agent_status"));
  assert.ok(dispatchTools.includes("agent_reconcile"));
  assert.ok(dispatchTools.includes("agent_cancel"));
  assert.equal(dispatchTools.includes("write"), false, "dispatch mode must not include write");
  assert.equal(dispatchTools.includes("edit"), false, "dispatch mode must not include edit");
  assert.equal(dispatchTools.includes("bash"), false, "dispatch mode must not include bash");

  // Codex mode has goal tools and process tools
  assert.ok(codexTools.includes("codex_goal_start"));
  assert.ok(codexTools.includes("codex_goal_status"));
  assert.ok(codexTools.includes("codex_goal_continue"));
  assert.ok(codexTools.includes("codex_goal_cancel"));
  assert.ok(codexTools.includes("exec_command"));
  assert.ok(codexTools.includes("write_stdin"));
});
