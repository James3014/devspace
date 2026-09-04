import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { MINIMUM_CODEX_RUNTIME_VERSION } from "./codex-runtime.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { DurableOperationManager } from "./durable-operations.js";
import { createMcpServer, createServer } from "./server.js";
import { CutoverStateStore } from "./cutover-state.js";
import { McpCutoverController } from "./mcp-cutover.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { LocalAgentSessionManager } from "./local-agent-sessions.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

// Hermetic Codex runtime so dispatch gates see a valid, inspectable runtime
// and spawned workers fail fast locally instead of invoking a real provider.
const originalDependencyRoot = process.env.DEVSPACE_DEPENDENCY_ROOT;
const codexRuntimeRoot = mkdtempSync(join(tmpdir(), "devspace-server-codex-runtime-"));
mkdirSync(join(codexRuntimeRoot, "node_modules", "@openai", "codex-sdk"), { recursive: true });
mkdirSync(join(codexRuntimeRoot, "node_modules", "@openai", "codex", "bin"), { recursive: true });
writeFileSync(
  join(codexRuntimeRoot, "node_modules", "@openai", "codex-sdk", "package.json"),
  JSON.stringify({ name: "@openai/codex-sdk", version: MINIMUM_CODEX_RUNTIME_VERSION }),
);
writeFileSync(
  join(codexRuntimeRoot, "node_modules", "@openai", "codex", "bin", "codex.js"),
  `#!/bin/sh\necho 'codex-cli ${MINIMUM_CODEX_RUNTIME_VERSION}'\n`,
  { mode: 0o755 },
);
process.env.DEVSPACE_DEPENDENCY_ROOT = codexRuntimeRoot;

after(async () => {
  if (originalDependencyRoot === undefined) delete process.env.DEVSPACE_DEPENDENCY_ROOT;
  else process.env.DEVSPACE_DEPENDENCY_ROOT = originalDependencyRoot;
  await rm(codexRuntimeRoot, { recursive: true, force: true });
});

test("configures Express with an exact trusted proxy hop count", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-trust-proxy-test-"));
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: join(root, ".state"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_TRUST_PROXY_HOPS: "1",
    PORT: "1",
  });

  const running = createServer(config);
  try {
    assert.equal(running.app.get("trust proxy"), 1);
  } finally {
    await running.close();
  }
});

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const providerNote = "available";
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true, note: providerNote }],
  });
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);
  const providerSchema = outputProperties?.agentProviders as {
    items?: { properties?: Record<string, unknown> };
  } | undefined;
  assert.ok(providerSchema?.items?.properties?.note);

  const firstStructured = structuredContent(first);
  assert.equal(firstStructured.workspaceId, structuredContent(repeated).workspaceId);
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.ok(Array.isArray(firstStructured.availableAgentsFiles));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agentProviders));
  assert.equal(
    (firstStructured.agentProviders as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (firstStructured.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skillDiagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.equal(repeatedStructured.availableAgentsFiles, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agentProviders, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skillDiagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.ok(Array.isArray(card.agentProviders));
  assert.equal(
    (card.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(card.agents));
});

test("open_workspace refreshes provider availability for each catalog", async (t) => {
  let available = false;
  const context = await fixture(t, {
    localAgentProviders: () => [{ name: "codex", available }],
  });

  const unavailable = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(unavailable.agentProviders, []);
  assert.deepEqual(unavailable.agents, []);

  available = true;
  const usable = structuredContent(await callOpen(context.client, context.project, "chat-2"));
  assert.equal(
    (usable.agentProviders as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (usable.agents as Array<Record<string, unknown>>)[0]?.name,
    "reviewer",
  );
});

test("open_workspace omits providers disabled by configuration", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [
      { name: "codex", available: true },
      { name: "claude", available: true },
    ],
    subagents: {
      enabled: true,
      providers: [
        { id: "codex", enabled: true },
        { id: "claude", enabled: false },
      ],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(
    (opened.agentProviders as Array<Record<string, unknown>>).map((provider) => provider.id),
    ["codex"],
  );
});

test("concurrent checkout opens return one full context and one reuse instruction", async (t) => {
  const context = await fixture(t);
  const [first, second] = await Promise.all([
    callOpen(context.client, context.project, "chat-1"),
    callOpen(context.client, context.project, "chat-1"),
  ]);

  assert.equal(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.equal(
    [first, second].filter((result) => Array.isArray(structuredContent(result).agentsFiles)).length,
    1,
  );
  assert.equal(
    [first, second].filter((result) => responseText(result).includes("Workspace already open as")).length,
    1,
  );
});

test("new worktrees always receive a fresh workspace and complete worktree context", async (t) => {
  const context = await fixture(t, { git: true });
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const firstWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const secondWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.notEqual(structuredContent(firstWorktree).workspaceId, structuredContent(secondWorktree).workspaceId);
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  for (const result of [firstWorktree, secondWorktree]) {
    const structured = structuredContent(result);
    assert.equal(structured.mode, "worktree");
    assert.ok(Array.isArray(structured.agentsFiles));
    assert.ok(Array.isArray(structured.availableAgentsFiles));
    assert.ok(Array.isArray(structured.skills));
    assert.ok(Array.isArray(structured.agentProviders));
    assert.ok(Array.isArray(structured.agents));
    assert.ok(Array.isArray(structured.skillDiagnostics));
    assert.match(responseText(result), /Opened isolated worktree workspace/);
  }
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
});

test("checkout opened after a worktree receives its own complete context", async (t) => {
  const context = await fixture(t, { git: true });
  const worktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.equal(structuredContent(worktree).mode, "worktree");
  assert.ok(Array.isArray(structuredContent(worktree).agentsFiles));
  assert.equal(structuredContent(checkout).mode, "checkout");
  assert.ok(Array.isArray(structuredContent(checkout).agentsFiles));
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
});

test("a host without conversation metadata receives normal explicit-workspace behavior", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project);
  const second = await callOpen(context.client, context.project);

  assert.notEqual(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.ok(Array.isArray(structuredContent(first).agentsFiles));
  assert.ok(Array.isArray(structuredContent(second).agentsFiles));
  assert.doesNotMatch(responseText(first), /conversation metadata/i);
  assert.doesNotMatch(responseText(second), /conversation metadata/i);
});

test("checkout reuse and context suppression survive a registry restart", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const firstWorkspaceId = structuredContent(first).workspaceId;

  await context.close();

  const restoredStore = new SqliteWorkspaceStore(context.stateDir);
  const restoredServer = createMcpServer(
    context.config,
    new WorkspaceRegistry(context.config, restoredStore),
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => [],
    [],
  );
  const [restoredClientTransport, restoredServerTransport] = InMemoryTransport.createLinkedPair();
  const restoredClient = new Client({ name: "devspace-restored-test-client", version: "1.0.0" });
  let restoredClosed = false;
  const closeRestored = async () => {
    if (restoredClosed) return;
    restoredClosed = true;
    await restoredClient.close();
    await restoredServer.close();
    restoredStore.close();
  };
  t.after(closeRestored);

  try {
    await Promise.all([
      restoredClient.connect(restoredClientTransport),
      restoredServer.connect(restoredServerTransport),
    ]);

    const restored = await callOpen(restoredClient, context.project, "chat-1");
    assert.equal(structuredContent(restored).workspaceId, firstWorkspaceId);
    assert.equal(structuredContent(restored).agentsFiles, undefined);
  } finally {
    await closeRestored();
  }
});

test("cutover MCP control exposes bounded lease lifecycle and schedules self restart once", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-cutover-mcp-control-"));
  const stateDir = join(root, ".state");
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const cutoverController = new McpCutoverController(
    new CutoverStateStore(stateDir, { newId: () => "cutover-mcp-control" }),
    {
      serverInstanceId: "server-old",
      sourceCommit: "old-source",
      buildId: "old-build",
      capabilityManifestSha256: "a".repeat(64),
    },
  );
  let restartSchedules = 0;
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => [],
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    {
      controller: cutoverController,
      transportEvidence: () => ({ activeSessions: 3, oldestAgeMs: 12_000 }),
      reconcileDurableState: async () => ({
        workspaceQueryable: true,
        agentQueryable: true,
        agentReconciled: true,
      }),
      restartSelf: {
        actuator: "launchd-self",
        serviceLabel: "com.example.devspace",
        launchdTarget: "gui/501/com.example.devspace",
        schedule: () => {
          restartSchedules += 1;
          return {
            scheduled: true,
            actuator: "launchd-self",
            serviceLabel: "com.example.devspace",
            launchdTarget: "gui/501/com.example.devspace",
          };
        },
      },
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-cutover-control-test", version: "1.0.0" });
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const tools = await client.listTools();
    for (const name of [
      "cutover_status",
      "cutover_start",
      "cutover_drain",
      "cutover_restart_self",
      "cutover_finish",
    ]) {
      assert.ok(tools.tools.some((tool) => tool.name === name), `missing ${name}`);
    }

    const started = structuredContent(await client.callTool({
      name: "cutover_start",
      arguments: {
        expectedSourceCommit: "b".repeat(40),
        expectedBuildId: "new-build",
        expectedCapabilityManifestSha256: "a".repeat(64),
      },
    }));
    assert.equal((started.cutover as Record<string, unknown>).phase, "prepared");

    const drained = structuredContent(await client.callTool({
      name: "cutover_drain",
      arguments: { cutoverId: "cutover-mcp-control" },
    }));
    assert.equal((drained.cutover as Record<string, unknown>).phase, "drained");
    assert.deepEqual(
      (drained.cutover as { drainEvidence?: unknown }).drainEvidence,
      { activeSessions: 3, oldestAgeMs: 12_000 },
    );

    const firstRestart = structuredContent(await client.callTool({
      name: "cutover_restart_self",
      arguments: { cutoverId: "cutover-mcp-control" },
    }));
    assert.equal((firstRestart.restart as Record<string, unknown>).scheduled, true);
    assert.equal((firstRestart.restart as Record<string, unknown>).alreadyRequested, false);
    assert.equal(restartSchedules, 1);

    const duplicateRestart = structuredContent(await client.callTool({
      name: "cutover_restart_self",
      arguments: { cutoverId: "cutover-mcp-control" },
    }));
    assert.equal((duplicateRestart.restart as Record<string, unknown>).scheduled, false);
    assert.equal((duplicateRestart.restart as Record<string, unknown>).alreadyRequested, true);
    assert.equal(restartSchedules, 1);
  } finally {
    await client.close();
    await server.close();
    workspaceStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cutover restart tool is absent when no bounded self actuator is available", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-cutover-no-actuator-"));
  const stateDir = join(root, ".state");
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  const cutoverController = new McpCutoverController(
    new CutoverStateStore(stateDir),
    { serverInstanceId: "old", sourceCommit: "old", buildId: "old" },
  );
  const server = createMcpServer(
    config,
    new WorkspaceRegistry(config, workspaceStore),
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => [],
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    {
      controller: cutoverController,
      transportEvidence: () => ({ activeSessions: 0, oldestAgeMs: 0 }),
      reconcileDurableState: async () => ({
        workspaceQueryable: true,
        agentQueryable: true,
        agentReconciled: true,
      }),
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-cutover-no-actuator", version: "1.0.0" });
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "cutover_start"));
    assert.equal(tools.tools.some((tool) => tool.name === "cutover_restart_self"), false);
  } finally {
    await client.close();
    await server.close();
    workspaceStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cutover finish proves real durable agent and workspace reconciliation after replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-cutover-durable-witness-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  await mkdir(project, { recursive: true });
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const workspaceId = "ws_cutover_durable";
  let agentId: string;
  const initialWorkspaceStore = new SqliteWorkspaceStore(stateDir);
  const initialAgentStore = new LocalAgentStore(stateDir);
  try {
    initialWorkspaceStore.createSession({ id: workspaceId, root: project });
    agentId = initialAgentStore.create({
      workspaceId,
      workspaceRoot: project,
      profileName: "durable-reviewer",
      provider: "codex",
    }).id;
  } finally {
    initialAgentStore.close();
    initialWorkspaceStore.close();
  }

  const old = new McpCutoverController(
    new CutoverStateStore(stateDir, { newId: () => "cutover-durable" }),
    { serverInstanceId: "server-old", sourceCommit: "old", buildId: "old-build" },
  );
  old.begin({ sourceCommit: "new", buildId: "new-build" });
  old.recordDrain("cutover-durable", { activeSessions: 1, oldestAgeMs: 100 });

  const replacementWorkspaceStore = new SqliteWorkspaceStore(stateDir);
  const replacementWorkspaces = new WorkspaceRegistry(config, replacementWorkspaceStore);
  const replacementAgents = new LocalAgentSessionManager(config, async () => {}, async () => true);
  try {
    const replacement = new McpCutoverController(
      new CutoverStateStore(stateDir),
      { serverInstanceId: "server-new", sourceCommit: "new", buildId: "new-build" },
    );
    const closed = await replacement.finish("cutover-durable", async () => {
      const workspace = replacementWorkspaces.getWorkspace(workspaceId);
      const status = await replacementAgents.getAgentStatus({
        workspaceId,
        workspaceRoot: workspace.root,
        agentId,
      });
      const reconciliation = await replacementAgents.reconcileAgent({
        workspaceId,
        workspaceRoot: workspace.root,
        isolated: false,
        agentId,
      });
      return {
        workspaceQueryable: workspace.id === workspaceId,
        agentQueryable: status.agentId === agentId,
        agentReconciled: reconciliation.agentId === agentId,
      };
    });
    assert.equal(closed.reconciliationReceipt?.agentReconciled, true);
  } finally {
    replacementAgents.close();
    replacementWorkspaceStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

interface ServerFixture {
  client: Client;
  project: string;
  config: ServerConfig;
  stateDir: string;
  close: () => Promise<void>;
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    localAgentProviders?: LocalAgentProviderAvailability[] | (() => LocalAgentProviderAvailability[]);
    subagents?: boolean | SubagentsConfig;
    gitCandidates?: boolean;
    toolchains?: string;
    toolMode?: "full" | "minimal" | "codex";
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

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

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const initialProviderAvailability = typeof options.localAgentProviders === "function"
    ? options.localAgentProviders()
    : options.localAgentProviders ?? [];
  const subagentsObject = typeof options.subagents === "object" ? options.subagents : undefined;
  const wantsSubagents =
    options.subagents === true ||
    (subagentsObject !== undefined && subagentsObject.enabled !== false) ||
    (options.subagents === undefined && options.localAgentProviders !== undefined);
  const loadedConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_GIT_CANDIDATES: options.gitCandidates ? "true" : "false",
    DEVSPACE_TOOLCHAINS: options.toolchains,
  });
  let config: ServerConfig = {
    ...loadedConfig,
    toolMode: options.toolMode ?? loadedConfig.toolMode,
    subagents: {
      ...loadedConfig.subagents,
      enabled: wantsSubagents,
      ...(subagentsObject ?? {}),
    },
  };
  if (options.localAgentProviders) {
    config = {
      ...config,
      subagents: subagentsObject ?? {
        enabled: true,
        providers: initialProviderAvailability.map((provider) => ({
          id: provider.name,
          enabled: true,
        })),
      },
    };
  }
  const resolveProviderAvailability: () => LocalAgentProviderAvailability[] =
    typeof options.localAgentProviders === "function"
      ? options.localAgentProviders
      : () => initialProviderAvailability;
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    resolveProviderAvailability(),
  );
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const { LocalAgentSessionManager } = await import("./local-agent-sessions.js");
  const agentSessionManager = config.subagents.enabled
    ? new LocalAgentSessionManager(config, async () => {}, async () => true)
    : undefined;
  const durableOperations = new DurableOperationManager(config);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    resolveLocalAgentProviders,
    [],
    agentSessionManager,
    undefined,
    undefined,
    durableOperations,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    durableOperations.close();
    agentSessionManager?.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project, config, stateDir, close };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
  mode?: "checkout" | "worktree",
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: {
      path,
      ...(mode ? { mode } : {}),
    },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}

test("subagents disabled: agent tools are absent", async (t) => {
  const context = await fixture(t, { subagents: false });
  const tools = await context.client.listTools();
  const agentTools = tools.tools.filter((tool) => tool.name.startsWith("agent_"));
  assert.equal(agentTools.length, 0);
});

test("subagents enabled: agent tools are present and functional", async (t) => {
  const context = await fixture(t, { subagents: true });
  const tools = await context.client.listTools();
  const agentTools = tools.tools.filter((tool) => tool.name.startsWith("agent_"));
  assert.equal(agentTools.length, 7);

  const startTool = agentTools.find((tool) => tool.name === "agent_start");
  const continueTool = agentTools.find((tool) => tool.name === "agent_continue");
  const statusTool = agentTools.find((tool) => tool.name === "agent_status");
  const cancelTool = agentTools.find((tool) => tool.name === "agent_cancel");
  const listTool = agentTools.find((tool) => tool.name === "agent_list");
  const preflightTool = agentTools.find((tool) => tool.name === "agent_preflight");
  const reconcileTool = agentTools.find((tool) => tool.name === "agent_reconcile");

  assert.ok(startTool);
  assert.ok(continueTool);
  assert.ok(statusTool);
  assert.ok(cancelTool);
  assert.ok(listTool);
  assert.ok(preflightTool);
  assert.ok(reconcileTool);

  // Verify start annotations
  assert.equal(startTool.annotations?.readOnlyHint, false);
  assert.equal(startTool.annotations?.destructiveHint, true);
  assert.equal(startTool.annotations?.idempotentHint, false);
  assert.equal(startTool.annotations?.openWorldHint, true);

  // Open workspace to get workspaceId
  const openResult = await callOpen(context.client, context.project, "chat-1");
  const workspaceId = structuredContent(openResult).workspaceId as string;
  assert.ok(workspaceId);

  // Schema Security Checks: verify no workspaceRoot or provider/profile leakage
  const startProps = startTool.inputSchema.properties as Record<string, any>;
  assert.equal(startProps.workspaceRoot, undefined);
  assert.equal(startProps.provider, undefined);
  assert.ok(startProps.attemptKey);

  const continueProps = continueTool.inputSchema.properties as Record<string, any>;
  assert.equal(continueProps.workspaceRoot, undefined);
  assert.equal(continueProps.provider, undefined);
  assert.equal(continueProps.profile, undefined);

  const statusProps = statusTool.inputSchema.properties as Record<string, any>;
  assert.equal(statusProps.workspaceRoot, undefined);
  const statusOutputProps = statusTool.outputSchema?.properties as Record<string, any>;
  assert.ok(statusOutputProps.termination, "agent_status must expose physical termination evidence");

  const cancelProps = cancelTool.inputSchema.properties as Record<string, any>;
  assert.equal(cancelProps.workspaceRoot, undefined);
  assert.equal(cancelProps.workerPid, undefined);
  assert.equal(cancelProps.workerToken, undefined);
  assert.equal(cancelProps.signal, undefined);
  const cancelOutputProps = cancelTool.outputSchema?.properties as Record<string, any>;
  assert.ok(cancelOutputProps.termination, "agent_cancel must expose physical termination evidence");

  const listProps = listTool.inputSchema.properties as Record<string, any>;
  assert.equal(listProps.workspaceRoot, undefined);

  // Call agent_start
  const startResult = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "hello review tests",
      attemptKey: "server-functional-attempt",
    },
  });

  const startStructured = startResult.structuredContent as Record<string, any>;
  assert.ok(startStructured.agentId);
  assert.equal(startStructured.status, "starting");
  assert.equal(startStructured.profileName, "reviewer");

  const replayResult = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "hello review tests",
      attemptKey: "server-functional-attempt",
    },
  });
  assert.equal(replayResult.isError, undefined);
  assert.equal(
    (replayResult.structuredContent as Record<string, unknown>).agentId,
    startStructured.agentId,
  );

  const replayConflict = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "materially different prompt",
      attemptKey: "server-functional-attempt",
    },
  });
  assert.equal(replayConflict.isError, true);
  assert.match(responseText(replayConflict), /materially different request/);

  // Call agent_status
  const statusResult = await context.client.callTool({
    name: "agent_status",
    arguments: {
      workspaceId,
      agentId: startStructured.agentId,
      waitMs: 0,
    },
  });

  const statusStructured = statusResult.structuredContent as Record<string, any>;
  assert.equal(statusStructured.agentId, startStructured.agentId);
  assert.equal(statusStructured.status, "starting");

  // Call agent_list
  const listResult = await context.client.callTool({
    name: "agent_list",
    arguments: {
      workspaceId,
      limit: 10,
    },
  });

  const listStructured = listResult.structuredContent as { agents: any[] };
  assert.equal(listStructured.agents.length, 1);
  assert.equal(listStructured.agents[0].agentId, startStructured.agentId);
  assert.equal(listStructured.agents[0].latestResponse, undefined); // Excluded

  // Test agent_continue
  // Update status to idle using a fresh store connection
  const { LocalAgentStore } = await import("./local-agent-store.js");
  const store = new LocalAgentStore(context.stateDir);
  try {
    const record = store.getById(startStructured.agentId)!;
    const generation = record.lifecycleState!.activeTurn!.generation!;
    const workerToken = record.workerToken!;
    store.claimWorkerCAS(startStructured.agentId, generation, workerToken, process.pid);
    store.finishTurnCAS({
      agentId: startStructured.agentId,
      generation,
      workerToken,
      status: "idle",
      terminalReason: "completed",
    });
  } finally {
    store.close();
  }

  const continueResult = await context.client.callTool({
    name: "agent_continue",
    arguments: {
      workspaceId,
      agentId: startStructured.agentId,
      prompt: "hello follow up prompt",
    },
  });

  const continueStructured = continueResult.structuredContent as Record<string, any>;
  assert.equal(continueStructured.agentId, startStructured.agentId);
  assert.equal(continueStructured.status, "starting");
  assert.equal(continueStructured.continued, true);

  // Verify list count is still 1 (no duplicate record created)
  const listResultAfter = await context.client.callTool({
    name: "agent_list",
    arguments: {
      workspaceId,
      limit: 10,
    },
  });
  const listStructuredAfter = listResultAfter.structuredContent as { agents: any[] };
  assert.equal(listStructuredAfter.agents.length, 1);
  assert.equal(listStructuredAfter.agents[0].agentId, startStructured.agentId);

  const cancelResult = await context.client.callTool({
    name: "agent_cancel",
    arguments: {
      workspaceId,
      agentId: startStructured.agentId,
    },
  });
  const cancelStructured = cancelResult.structuredContent as Record<string, any>;
  assert.equal(cancelStructured.agentId, startStructured.agentId);
  assert.equal(cancelStructured.status, "stopped");
  assert.equal(cancelStructured.terminal, true);
});

test("subagents: continuation fails closed when execution generation changes", async (t) => {
  const context = await fixture(t, { subagents: true });
  const opened = await callOpen(context.client, context.project, "chat-generation-change");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const start = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "generation-bound work",
      attemptKey: "generation-bound-start",
    },
  });
  assert.equal(start.isError, undefined);
  const agentId = structuredContent(start).agentId as string;

  const { LocalAgentStore } = await import("./local-agent-store.js");
  const store = new LocalAgentStore(context.stateDir);
  try {
    const record = store.getById(agentId)!;
    assert.ok(record.executionGeneration?.executionBindingHash, "new durable sessions must persist execution generation");
    const generation = record.lifecycleState!.activeTurn!.generation!;
    const workerToken = record.workerToken!;
    store.claimWorkerCAS(agentId, generation, workerToken, process.pid);
    store.finishTurnCAS({ agentId, generation, workerToken, status: "idle", terminalReason: "completed" });
  } finally {
    store.close();
  }

  await writeFile(join(context.project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Generation changed after start.",
    "provider: codex",
    "effort: high",
    "---",
    "Review changes with a changed profile generation.",
  ].join("\n"));

  const continued = await context.client.callTool({
    name: "agent_continue",
    arguments: { workspaceId, agentId, prompt: "continue after profile mutation" },
  });
  assert.equal(continued.isError, true);
  assert.match(responseText(continued), /REBIND_REQUIRED|requires explicit rebind/i);
});

test("subagents: legacy durable session without execution generation does not silently upgrade", async (t) => {
  const context = await fixture(t, { subagents: true });
  const opened = await callOpen(context.client, context.project, "chat-legacy-generation");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const start = await context.client.callTool({
    name: "agent_start",
    arguments: { workspaceId, profile: "reviewer", prompt: "legacy simulation" },
  });
  const agentId = structuredContent(start).agentId as string;

  const { LocalAgentStore } = await import("./local-agent-store.js");
  const store = new LocalAgentStore(context.stateDir);
  try {
    const record = store.getById(agentId)!;
    const generation = record.lifecycleState!.activeTurn!.generation!;
    const workerToken = record.workerToken!;
    store.claimWorkerCAS(agentId, generation, workerToken, process.pid);
    store.finishTurnCAS({ agentId, generation, workerToken, status: "idle", terminalReason: "completed" });
  } finally {
    store.close();
  }
  const { openDatabase } = await import("./db/client.js");
  const database = openDatabase(context.stateDir);
  try {
    database.sqlite.prepare("update local_agent_sessions set execution_generation = null where id = ?").run(agentId);
  } finally {
    database.close();
  }
  const legacyStore = new LocalAgentStore(context.stateDir);
  try {
    assert.equal(legacyStore.getById(agentId)?.executionGeneration, undefined);
  } finally {
    legacyStore.close();
  }

  const continued = await context.client.callTool({
    name: "agent_continue",
    arguments: { workspaceId, agentId, prompt: "must not silently bind" },
  });
  assert.equal(continued.isError, true);
  assert.match(responseText(continued), /REBIND_REQUIRED|predates execution-generation binding/i);
});

test("subagents: unknown/invalid workspaceId fails closed before durable-agent access", async (t) => {
  const context = await fixture(t, { subagents: true });
  const invalidWorkspaceId = "ws_invalid_nonexistent";

  // 1. agent_start with invalid workspaceId fails closed
  const startRes = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId: invalidWorkspaceId,
      profile: "reviewer",
      prompt: "fail prompt",
    },
  });
  assert.equal(startRes.isError, true);
  assert.match(responseText(startRes), /Unknown workspace/);

  // 2. agent_status with invalid workspaceId fails closed
  const statusRes = await context.client.callTool({
    name: "agent_status",
    arguments: {
      workspaceId: invalidWorkspaceId,
      agentId: "agt_12345678",
    },
  });
  assert.equal(statusRes.isError, true);
  assert.match(responseText(statusRes), /Unknown workspace/);

  // 3. agent_continue with invalid workspaceId fails closed
  const continueRes = await context.client.callTool({
    name: "agent_continue",
    arguments: {
      workspaceId: invalidWorkspaceId,
      agentId: "agt_12345678",
      prompt: "continue prompt",
    },
  });
  assert.equal(continueRes.isError, true);
  assert.match(responseText(continueRes), /Unknown workspace/);

  // 4. agent_cancel with invalid workspaceId fails closed
  const cancelRes = await context.client.callTool({
    name: "agent_cancel",
    arguments: {
      workspaceId: invalidWorkspaceId,
      agentId: "agt_12345678",
    },
  });
  assert.equal(cancelRes.isError, true);
  assert.match(responseText(cancelRes), /Unknown workspace/);

  // 5. agent_list with invalid workspaceId fails closed
  const listRes = await context.client.callTool({
    name: "agent_list",
    arguments: {
      workspaceId: invalidWorkspaceId,
    },
  });
  assert.equal(listRes.isError, true);
  assert.match(responseText(listRes), /Unknown workspace/);
});

test("subagents: agent_preflight returns structured readiness without secrets", async (t) => {
  const context = await fixture(t, { git: true, subagents: true });
  const openResult = await callOpen(context.client, context.project, "chat-preflight");
  const workspaceId = structuredContent(openResult).workspaceId as string;

  const preflightResult = await context.client.callTool({
    name: "agent_preflight",
    arguments: { workspaceId, profile: "reviewer" },
  });
  assert.equal(preflightResult.isError, undefined);
  const preflight = structuredContent(preflightResult);
  assert.equal((preflight.workspace as Record<string, unknown>).isolated, false);
  assert.equal((preflight.workspace as Record<string, unknown>).dirty, false);
  assert.equal((preflight.worker as Record<string, unknown>).profile, "reviewer");
  const readiness = preflight.readiness as Record<string, unknown>;
  assert.equal(readiness.profileResolved, true);
  assert.equal(readiness.authReady, "unknown");
  assert.equal(readiness.providerReachable, "unknown");
  assert.equal(readiness.dispatchState, "UNKNOWN");
  const serialized = JSON.stringify(preflight);
  assert.ok(!serialized.includes("test-owner-token"));
  assert.ok(!serialized.includes("DEVSPACE_OAUTH"));
});

test("subagents: controller dispatchIntent crosses the MCP schema without gaining verification authority", async (t) => {
  const context = await fixture(t, { git: true, subagents: true });
  const openResult = await callOpen(context.client, context.project, "chat-dispatch-intent");
  const workspaceId = structuredContent(openResult).workspaceId as string;
  const intent = {
    taskId: "task-server-r3",
    attemptId: "attempt-server-r3",
    objective: "Perform one bounded change.",
    roleIntent: "DEEP_ENGINEERING",
    readScope: ["src"],
    writeScope: ["src"],
    exclusiveOwnership: true,
    forbiddenChanges: ["Do not claim acceptance authority."],
    acceptanceCriteria: ["Return inspectable evidence."],
    verificationRequired: true,
    expectedEvidence: ["focused test"],
    claimCeiling: "CANDIDATE_READY",
  };

  const startResult = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "bounded work",
      attemptKey: "attempt-server-r3",
      executionContract: { dispatchIntent: intent, writePaths: ["src"] },
    },
  });
  assert.equal(startResult.isError, undefined);
  const start = structuredContent(startResult) as Record<string, unknown>;
  const dispatch = start.dispatch as Record<string, unknown>;
  assert.equal(dispatch.taskId, "task-server-r3");
  assert.equal(dispatch.claimCeiling, "CANDIDATE_READY");
  assert.equal((start as any).verified, undefined);
  assert.equal((start as any).accepted, undefined);

  const invalidClaim = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "invalid authority",
      attemptKey: "attempt-server-r3-invalid",
      executionContract: {
        dispatchIntent: { ...intent, attemptId: "attempt-server-r3-invalid", claimCeiling: "VERIFIED" },
        writePaths: ["src"],
      },
    },
  });
  assert.equal(invalidClaim.isError, true);
});

test("subagents: NEXUS_GOVERNED fails closed at the MCP boundary without complete canonical grant evidence", async (t) => {
  const context = await fixture(t, { git: true, subagents: true });
  const openResult = await callOpen(context.client, context.project, "chat-nexus-governed-missing-grant");
  const workspaceId = structuredContent(openResult).workspaceId as string;
  const head = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: context.project });
  const intent = {
    taskId: "task-server-g9",
    attemptId: "attempt-server-g9",
    objective: "Perform one bounded governed change.",
    roleIntent: "DEEP_ENGINEERING",
    readScope: ["src"],
    writeScope: ["src"],
    exclusiveOwnership: true,
    forbiddenChanges: ["Do not fall back to OWNER_DIRECT."],
    acceptanceCriteria: ["Reject missing Nexus authority before launch."],
    verificationRequired: true,
    expectedEvidence: ["typed rejection"],
    claimCeiling: "CANDIDATE_READY",
  };

  const missingGrant = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "must not launch",
      attemptKey: intent.attemptId,
      executionContract: {
        authorityMode: "NEXUS_GOVERNED",
        dispatchIntent: intent,
        expectedHead: head.stdout.trim(),
        writePaths: ["src"],
      },
    },
  });
  assert.equal(missingGrant.isError, true);
  assert.match(responseText(missingGrant), /NEXUS_GOVERNED.*requires nexusGrant/i);

  const directWithSyntheticGrant = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "must not launch",
      attemptKey: "attempt-server-g9-direct",
      executionContract: {
        authorityMode: "OWNER_DIRECT",
        nexusGrant: {
          repository: "James3014/Nexus-new",
          revision: "a".repeat(40),
          grantPath: "tasks/g9/grant.json",
          grantSha256: "b".repeat(64),
          authorityPath: "tasks/g9/00-task.md",
          authoritySha256: "c".repeat(64),
        },
        dispatchIntent: { ...intent, attemptId: "attempt-server-g9-direct" },
        expectedHead: head.stdout.trim(),
        writePaths: ["src"],
      },
    },
  });
  assert.equal(directWithSyntheticGrant.isError, true);
  assert.match(responseText(directWithSyntheticGrant), /OWNER_DIRECT.*must not carry Nexus grant/i);
});

test("subagents: agent_start executionContract expectedHead mismatch fails closed", async (t) => {
  const context = await fixture(t, { git: true, subagents: true });
  const openResult = await callOpen(context.client, context.project, "chat-contract");
  const workspaceId = structuredContent(openResult).workspaceId as string;

  const staleResult = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "work",
      executionContract: { expectedHead: "a".repeat(40), writePaths: ["src"] },
    },
  });
  assert.equal(staleResult.isError, true);
  assert.match(responseText(staleResult), /expected HEAD|stale workspace/i);

  const head = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: context.project });
  const startResult = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "work",
      executionContract: { expectedHead: head.stdout.trim(), writePaths: ["src"] },
    },
  });
  assert.equal(startResult.isError, undefined);
  assert.equal((structuredContent(startResult) as Record<string, unknown>).status, "starting");
});

test("subagents: agent_reconcile reports physical diff as candidate evidence", async (t) => {
  const context = await fixture(t, { git: true, subagents: true });
  const openResult = await callOpen(context.client, context.project, "chat-reconcile");
  const workspaceId = structuredContent(openResult).workspaceId as string;

  const startResult = await context.client.callTool({
    name: "agent_start",
    arguments: { workspaceId, profile: "reviewer", prompt: "do work" },
  });
  const agentId = (structuredContent(startResult) as Record<string, unknown>).agentId as string;

  await writeFile(join(context.project, "candidate.ts"), "export const x = 1;\n");

  const reconcileResult = await context.client.callTool({
    name: "agent_reconcile",
    arguments: { workspaceId, agentId },
  });
  assert.equal(reconcileResult.isError, undefined);
  const reconciled = structuredContent(reconcileResult);
  assert.equal((reconciled.agentId as string), agentId);
  const candidate = reconciled.candidate as Record<string, unknown>;
  assert.equal(candidate.present, true);
  assert.ok((candidate.changedPaths as string[]).includes("candidate.ts"));
  assert.equal(candidate.scopeState, "UNKNOWN");

  const statusResult = await context.client.callTool({
    name: "agent_status",
    arguments: { workspaceId, agentId },
  });
  const status = structuredContent(statusResult) as Record<string, unknown>;
  assert.ok(typeof status.startedAt === "string");
  assert.ok(typeof status.wallMs === "number");
});

test("subagents: workspace_verify always present, returns structured TOOLCHAIN_UNAVAILABLE without config", async (t) => {
  const context = await fixture(t, { subagents: true });
  const tools = await context.client.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === "workspace_verify"), true);
  const verifyTool = tools.tools.find((tool) => tool.name === "workspace_verify");
  assert.equal(verifyTool?.annotations?.readOnlyHint, false);
  assert.equal(verifyTool?.annotations?.destructiveHint, true);

  const openResult = await callOpen(context.client, context.project, "chat-verify-unconfigured");
  const workspaceId = structuredContent(openResult).workspaceId as string;

  const unconfigured = await context.client.callTool({
    name: "workspace_verify",
    arguments: { workspaceId, toolchainId: "nexus-python", verifier: "pytest", args: [] },
  });
  assert.equal(unconfigured.isError, undefined);
  const body = structuredContent(unconfigured);
  assert.equal(body.ok, false);
  const error = body.error as Record<string, unknown>;
  assert.equal(error.code, "TOOLCHAIN_UNAVAILABLE");
  assert.match(responseText(unconfigured), /TOOLCHAIN_UNAVAILABLE/);
});

test("subagents: workspace_verify structured TOOLCHAIN_UNAVAILABLE when a toolchain exists but the verifier does not", async (t) => {
  const toolchainRoot = await mkdtemp(join(tmpdir(), "devspace-server-toolchain-"));
  const toolchains = JSON.stringify([
    { id: "nexus-python", root: toolchainRoot, verifiers: { pytest: ".venv/bin/pytest" } },
  ]);
  const context = await fixture(t, { subagents: true, toolchains });
  try {
    const tools = await context.client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "workspace_verify"), true);

    const openResult = await callOpen(context.client, context.project, "chat-verify-unresolved");
    const workspaceId = structuredContent(openResult).workspaceId as string;

    const unconfigured = await context.client.callTool({
      name: "workspace_verify",
      arguments: { workspaceId, toolchainId: "nexus-python", verifier: "ruff", args: [] },
    });
    assert.equal(unconfigured.isError, undefined);
    const body = structuredContent(unconfigured);
    assert.equal(body.ok, false);
    assert.equal((body.error as Record<string, unknown>).code, "TOOLCHAIN_UNAVAILABLE");
  } finally {
    await rm(toolchainRoot, { recursive: true, force: true });
  }
});

test("subagents: workspace_verify executes a configured verifier normally", async (t) => {
  const toolchainRoot = await mkdtemp(join(tmpdir(), "devspace-server-toolchain-"));
  const bin = join(toolchainRoot, ".venv", "bin");
  await mkdir(bin, { recursive: true });
  const verifierPath = join(bin, "pytest");
  await writeFile(verifierPath, "#!/bin/sh\necho \"verifier-ran\"\nexit 0\n", { mode: 0o755 });
  chmodSync(verifierPath, 0o755);
  const toolchains = JSON.stringify([
    { id: "nexus-python", root: toolchainRoot, verifiers: { pytest: ".venv/bin/pytest" } },
  ]);
  const context = await fixture(t, { git: true, subagents: true, toolchains });
  try {
    const openResult = await callOpen(context.client, context.project, "chat-verify-ok");
    const workspaceId = structuredContent(openResult).workspaceId as string;

    const result = await context.client.callTool({
      name: "workspace_verify",
      arguments: { workspaceId, toolchainId: "nexus-python", verifier: "pytest", args: ["-q"] },
    });
    assert.equal(result.isError, undefined);
    const body = structuredContent(result);
    assert.equal(body.ok, true);
    assert.equal(body.exitCode, 0);
    assert.equal(body.toolchainId, "nexus-python");
    assert.match(body.stdout as string, /verifier-ran/);
    assert.match(responseText(result), /exited with code 0/);
  } finally {
    await rm(toolchainRoot, { recursive: true, force: true });
  }
});

test("gitCandidates disabled: git tools are absent", async (t) => {
  const context = await fixture(t, { gitCandidates: false });
  const tools = await context.client.listTools();
  const gitTools = tools.tools.filter((tool) => tool.name.startsWith("git_"));
  assert.equal(gitTools.length, 0);
});

test("gitCandidates enabled: git tools are present with schema validation", async (t) => {
  const context = await fixture(t, { git: true, gitCandidates: true });
  const tools = await context.client.listTools();
  const gitTools = tools.tools.filter((tool) => tool.name.startsWith("git_"));
  assert.equal(gitTools.length, 3);

  const commitTool = gitTools.find((tool) => tool.name === "git_commit");
  const pushTool = gitTools.find((tool) => tool.name === "git_push");
  const promoteTool = gitTools.find((tool) => tool.name === "git_promote_candidate");

  assert.ok(commitTool);
  assert.ok(pushTool);
  assert.ok(promoteTool);

  const promoteProps = promoteTool.inputSchema.properties as Record<string, any>;
  assert.equal(promoteProps.canonicalRemote, undefined);
  assert.equal(promoteProps.canonicalHead, undefined);
  assert.equal(promoteProps.requiredCapabilityIds, undefined);
  assert.equal(promoteProps.candidateCapabilityIds, undefined);
  assert.ok(promoteProps.expectedServerInstanceId);
  assert.ok(promoteProps.expectedSourceCommit);
  assert.ok(promoteProps.expectedBuildId);
  assert.ok(promoteProps.expectedCapabilityManifestSha256);

  // Security schemas verification: NO workspaceRoot, cwd, remoteUrl, refspec, rawArgs, force, noVerify, delete, all
  const commitProps = commitTool.inputSchema.properties as Record<string, any>;
  assert.equal(commitProps.workspaceRoot, undefined);
  assert.equal(commitProps.cwd, undefined);
  assert.equal(commitProps.rawArgs, undefined);
  assert.equal(commitProps.force, undefined);
  assert.equal(commitProps.noVerify, undefined);

  const pushProps = pushTool.inputSchema.properties as Record<string, any>;
  assert.equal(pushProps.workspaceRoot, undefined);
  assert.equal(pushProps.remoteUrl, undefined);
  assert.equal(pushProps.refspec, undefined);
  assert.equal(pushProps.force, undefined);
  assert.equal(pushProps.delete, undefined);
  assert.equal(pushProps.all, undefined);

  // Annotations check
  assert.equal(commitTool.annotations?.readOnlyHint, false);
  assert.equal(commitTool.annotations?.destructiveHint, true);
  assert.equal(commitTool.annotations?.idempotentHint, false);
  assert.equal(commitTool.annotations?.openWorldHint, false);

  assert.equal(pushTool.annotations?.readOnlyHint, false);
  assert.equal(pushTool.annotations?.destructiveHint, true);
  assert.equal(pushTool.annotations?.idempotentHint, false);
  assert.equal(pushTool.annotations?.openWorldHint, true);

  // Open workspace in default checkout mode
  const openResult = await callOpen(context.client, context.project, "chat-1", "checkout");
  const workspaceId = structuredContent(openResult).workspaceId as string;
  assert.ok(workspaceId);

  const res = await context.client.callTool({
    name: "git_commit",
    arguments: {
      workspaceId,
      expectedHead: "a".repeat(40),
      message: "test",
      paths: ["README.md"],
    },
  });
  assert.equal(res.isError, true);
  assert.match(responseText(res), /GIT_MANAGED_WORKTREE_REQUIRED/);
});

test("agent_start schema preserves heartbeat, GPT-first selection, and optional Nexus authority capabilities", async (t) => {
  const context = await fixture(t, { subagents: true });
  const tools = await context.client.listTools();
  const start = tools.tools.find((tool) => tool.name === "agent_start");
  assert.ok(start);
  const props = start.inputSchema.properties as Record<string, any>;
  const contract = props.executionContract;
  const contractProps = contract.anyOf?.find((entry: any) => entry.type === "object")?.properties
    ?? contract.properties;
  assert.ok(contractProps.authorityMode);
  assert.ok(contractProps.selection);
  assert.ok(contractProps.nexusGrant);
  assert.ok(contractProps.idleTimeoutMs);
  assert.match(contractProps.idleTimeoutMs.description, /terminated.*no provider activity/i);

  const status = tools.tools.find((tool) => tool.name === "agent_status");
  const reconcile = tools.tools.find((tool) => tool.name === "agent_reconcile");
  assert.ok(status?.outputSchema?.properties?.selection);
  assert.ok(status?.outputSchema?.properties?.dispatchControl);
  assert.ok(reconcile?.outputSchema?.properties?.selection);
  assert.ok(reconcile?.outputSchema?.properties?.dispatchControl);
});

test("git candidates tools - MCP managed worktree end-to-end integration test", async (t) => {
  const context = await fixture(t, { git: true, gitCandidates: true });

  // 1. Create a remote bare repository in the temp root
  const bareDir = join(context.project, "../bare.git");
  await mkdir(bareDir, { recursive: true });
  await execFileAsync("git", ["init", "--bare", "--initial-branch=main"], { cwd: bareDir });

  // 2. Point our local project's origin to this bare repo and push main
  await execFileAsync("git", ["remote", "add", "origin", bareDir], { cwd: context.project });
  await execFileAsync("git", ["push", "origin", "main"], { cwd: context.project });

  // 3. Open via MCP in worktree mode - DevSpace will create a managed worktree internally
  const openRes = await context.client.callTool({
    name: "open_workspace",
    arguments: { path: context.project, mode: "worktree" },
  });
  assert.equal(openRes.isError, undefined);
  const ws = structuredContent(openRes);
  const workspaceId = ws.workspaceId as string;
  assert.ok(workspaceId);
  assert.equal(ws.mode, "worktree");
  assert.equal((ws.worktree as any)?.managed, true);

  // 4. The actual managed worktree path is in ws.root
  const worktreeRoot = ws.root as string;
  assert.ok(worktreeRoot);

  // Configure git identity in the managed worktree
  await execFileAsync("git", ["config", "user.email", "mcp-test@example.com"], { cwd: worktreeRoot });
  await execFileAsync("git", ["config", "user.name", "MCP Test User"], { cwd: worktreeRoot });
  await execFileAsync("git", ["config", "remote.origin.url", bareDir], { cwd: worktreeRoot });

  const initialHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreeRoot })).stdout.trim();

  // 5. Write a file in the managed worktree
  await writeFile(join(worktreeRoot, "mcp-canary.txt"), "mcp content\n");

  // 6. Execute git_commit via MCP
  const commitRes = await context.client.callTool({
    name: "git_commit",
    arguments: {
      workspaceId,
      expectedHead: initialHead,
      message: "feat: add mcp-canary.txt",
      paths: ["mcp-canary.txt"],
    },
  });
  assert.equal(commitRes.isError, undefined);
  const commitResult = structuredContent(commitRes);
  const commitSha = commitResult.commitSha as string;
  assert.ok(commitSha);
  assert.notEqual(commitSha, initialHead);
  assert.equal(commitResult.previousHead, initialHead);

  // 7. Execute git_push via MCP
  const pushRes = await context.client.callTool({
    name: "git_push",
    arguments: {
      workspaceId,
      expectedHead: commitSha,
      remote: "origin",
      branch: "candidate/mcp-test-1",
    },
  });
  assert.equal(pushRes.isError, undefined);
  const pushResult = structuredContent(pushRes);
  assert.equal(pushResult.remote, "origin");
  assert.equal(pushResult.branch, "candidate/mcp-test-1");
  assert.equal(pushResult.pushedSha, commitSha);

  // 8. Verify the bare repo SHA equals the committed & pushed SHA
  const { stdout: bareSha } = await execFileAsync("git", ["rev-parse", "refs/heads/candidate/mcp-test-1"], { cwd: bareDir });
  assert.equal(bareSha.trim(), commitSha);
});

test("bash and command_status: attemptKey reconciliation and idempotent execution", async (t) => {
  const context = await fixture(t);
  const openResult = await callOpen(context.client, context.project, "chat-cmd-reconcile");
  const workspaceId = structuredContent(openResult).workspaceId as string;

  // 0. Missing attemptKey on native bash must fail closed / reject schema
  const missingKeyRes = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: "echo fail_no_attempt_key",
    },
  });
  assert.equal(missingKeyRes.isError, true, "Native bash requires attemptKey");

  // 1. Short command compatibility with required attemptKey
  const shortRes = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: "echo short_cmd_hello",
      attemptKey: "bash:g2:short01",
    },
  });
  assert.equal(shortRes.isError, undefined);
  assert.match(responseText(shortRes), /short_cmd_hello/);
  const shortStructured = structuredContent(shortRes) as Record<string, unknown>;
  assert.equal(shortStructured.running, false);
  assert.equal(shortStructured.exitCode, 0);

  // 2. Long command yields running: true with attemptKey
  const node = process.platform === "win32" ? `"${process.execPath}"` : JSON.stringify(process.execPath);
  const attemptKey = "bash:g2:test01";
  const longRes = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => { console.log('async_done'); process.exit(0); }, 300)"`,
      yieldTimeMs: 50,
      attemptKey,
    },
  });
  assert.equal(longRes.isError, undefined);
  const longStructured = structuredContent(longRes) as Record<string, unknown>;
  assert.equal(longStructured.running, true);
  assert.equal(longStructured.attemptKey, attemptKey);

  // 3. Reconcile via command_status
  const statusRes = await context.client.callTool({
    name: "command_status",
    arguments: {
      workspaceId,
      attemptKey,
      yieldTimeMs: 3_000,
    },
  });
  assert.equal(statusRes.isError, undefined);
  const statusStructured = structuredContent(statusRes) as Record<string, unknown>;
  assert.equal(statusStructured.running, false);
  assert.equal(statusStructured.exitCode, 0);
  assert.match(responseText(statusRes), /async_done/);

  // 4. Replay exact same bash start reuses completed session
  const replayRes = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => { console.log('async_done'); process.exit(0); }, 300)"`,
      yieldTimeMs: 50,
      attemptKey,
    },
  });
  assert.equal(replayRes.isError, undefined);
  const replayStructured = structuredContent(replayRes) as Record<string, unknown>;
  assert.equal(replayStructured.running, false);
  assert.equal(replayStructured.exitCode, 0);

  // 5. Conflicting attemptKey fails closed
  const conflictRes = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: "echo different_command",
      attemptKey,
    },
  });
  assert.equal(conflictRes.isError, true);
  assert.match(responseText(conflictRes), /ATTEMPT_REPLAY_CONFLICT/);
});

test("nexus_gateway_recover exposes only the fixed typed recovery contract", async (t) => {
  const context = await fixture(t, { git: true });
  const tools = await context.client.listTools();
  const gatewayTool = tools.tools.find((tool) => tool.name === "nexus_gateway_recover");
  assert.ok(gatewayTool, "fixed Nexus Gateway recovery tool must be exposed");
  const annotations = (gatewayTool as unknown as { annotations?: Record<string, unknown> }).annotations;
  assert.deepEqual(annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.match(String(gatewayTool.description), /executable, service, PID, launchd label, plist, source root/);

  const schema = gatewayTool.inputSchema as Record<string, unknown>;
  const properties = schema.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(properties).sort(), ["attemptKey", "request"]);
  const requestSchema = properties.request as Record<string, unknown>;
  const requestProperties = requestSchema.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(requestProperties).sort(), [
    "desired_manifest_hash",
    "desired_manifest_id",
    "effect_class",
    "idempotency_fence",
    "operation",
    "predecessor_manifest_hash",
    "predecessor_manifest_id",
    "recovery_authority_hash",
    "recovery_authority_id",
    "request_hash",
    "request_id",
    "schema",
  ]);
  for (const forbidden of ["command", "executable", "pid", "service", "launchdLabel", "plist", "root", "managerPath", "environment", "timeout"]) {
    assert.equal(forbidden in requestProperties, false, `${forbidden} must not be caller-selectable`);
  }
  assert.equal(requestSchema.additionalProperties, false, "recovery request must reject extra process-control fields");

  const invalid = await context.client.callTool({
    name: "nexus_gateway_recover",
    arguments: {
      attemptKey: "server-gateway-invalid",
      request: {
        request_id: "request-1",
        idempotency_fence: "fence-1",
        operation: "gateway-recover",
        effect_class: "GATEWAY_DURABLE_RECOVERY",
        recovery_authority_id: "authority-1",
        recovery_authority_hash: "a".repeat(64),
        desired_manifest_id: `r1-${"b".repeat(40)}`,
        desired_manifest_hash: "c".repeat(64),
        predecessor_manifest_id: `r1-${"d".repeat(40)}`,
        predecessor_manifest_hash: "e".repeat(64),
        request_hash: "f".repeat(64),
        schema: "nexus.gateway.durable_recovery_request.v1",
        command: "launchctl",
      },
    },
  });
  assert.equal(invalid.isError, true, "extra caller-selected process controls must fail schema validation before handler execution");
});

test("OWNER_DIRECT workspace_clone and dependency_sync run through typed MCP tools", async (t) => {
  const context = await fixture(t, { git: true });
  const tools = await context.client.listTools();
  for (const name of ["workspace_clone", "dependency_sync", "operation_status", "operation_reconcile"]) {
    assert.ok(tools.tools.some((tool) => tool.name === name), `${name} must be exposed`);
  }
  const bash = tools.tools.find((tool) => tool.name === "bash");
  assert.match(String(bash?.description), /Do not use bash to create or modify files/);

  const destination = join(context.project, "..", "typed-clone");
  const clone = await context.client.callTool({
    name: "workspace_clone",
    arguments: {
      attemptKey: "server-clone-1",
      remote: context.project,
      destination,
      authorityMode: "OWNER_DIRECT",
    },
  });
  assert.equal(clone.isError, undefined);
  const cloneRecord = structuredContent(clone);
  assert.equal(cloneRecord.status, "succeeded");
  assert.equal((cloneRecord.receipt as Record<string, unknown>).openable, true);

  const replay = await context.client.callTool({
    name: "workspace_clone",
    arguments: {
      attemptKey: "server-clone-1",
      remote: context.project,
      destination,
      authorityMode: "OWNER_DIRECT",
    },
  });
  assert.equal(structuredContent(replay).operationId, cloneRecord.operationId);

  const outside = await mkdtemp(join(tmpdir(), "devspace-server-outside-clone-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const denied = await context.client.callTool({
    name: "workspace_clone",
    arguments: {
      attemptKey: "server-clone-outside",
      remote: context.project,
      destination: join(outside, "clone"),
      authorityMode: "OWNER_DIRECT",
    },
  });
  assert.equal(denied.isError, true);

  await writeFile(join(destination, "package.json"), JSON.stringify({ name: "typed-fixture", version: "1.0.0" }) + "\n");
  await writeFile(join(destination, "package-lock.json"), JSON.stringify({
    name: "typed-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "typed-fixture", version: "1.0.0" } },
  }) + "\n");
  const manifestBefore = await readFile(join(destination, "package.json"), "utf8");
  const lockBefore = await readFile(join(destination, "package-lock.json"), "utf8");
  const opened = await callOpen(context.client, destination, "chat-dependency-sync");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const sync = await context.client.callTool({
    name: "dependency_sync",
    arguments: {
      workspaceId,
      attemptKey: "server-deps-1",
      recipe: "npm_ci",
      authorityMode: "OWNER_DIRECT",
    },
  });
  assert.equal(sync.isError, undefined);
  assert.equal(structuredContent(sync).status, "succeeded");
  assert.equal(await readFile(join(destination, "package.json"), "utf8"), manifestBefore);
  assert.equal(await readFile(join(destination, "package-lock.json"), "utf8"), lockBefore);

  const status = await context.client.callTool({
    name: "operation_status",
    arguments: { operationId: structuredContent(sync).operationId },
  });
  assert.equal(structuredContent(status).status, "succeeded");

  const nexusBlocked = await context.client.callTool({
    name: "workspace_clone",
    arguments: {
      attemptKey: "server-nexus-unvalidated",
      remote: context.project,
      destination: join(context.project, "..", "nexus-unvalidated"),
      authorityMode: "NEXUS_GOVERNED",
    },
  });
  assert.equal(nexusBlocked.isError, true);
});

test("command_status metadata annotations and minimal mode visibility", async (t) => {
  // Test minimal mode tools
  const context = await fixture(t, { toolMode: "minimal" });
  const toolsList = await context.client.listTools();
  const toolNames = toolsList.tools.map((t) => t.name);

  // command_status is visible in minimal mode for read-only reconciliation
  assert.ok(toolNames.includes("command_status"), "command_status should be visible in minimal mode");

  // exec_command and write_stdin remain hidden in minimal mode
  assert.ok(!toolNames.includes("exec_command"), "exec_command must stay hidden in minimal mode");
  assert.ok(!toolNames.includes("write_stdin"), "write_stdin must stay hidden in minimal mode");

  // Verify command_status annotations
  const commandStatusTool = toolsList.tools.find((t) => t.name === "command_status");
  assert.ok(commandStatusTool);
  const annotations = (commandStatusTool as unknown as { annotations?: Record<string, unknown> }).annotations;
  assert.deepEqual(annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
});
