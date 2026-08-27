import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { loadConfig, type ServerConfig } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { MINIMUM_CODEX_RUNTIME_VERSION } from "./codex-runtime.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import {
  createMcpServer,
  createServer,
  NEXUS_PYTHON_EXECUTABLE,
  NEXUS_GATEWAY_MANAGER_EXECUTABLE,
  NEXUS_GATEWAY_REQUEST_STORE,
  NEXUS_GATEWAY_EVIDENCE_STORE,
  NEXUS_GATEWAY_DIRECT_ROOT,
  NEXUS_GATEWAY_RECOVERY_ARGV,
  NEXUS_GATEWAY_RECOVERY_PATH,
  NEXUS_GATEWAY_RECOVERY_TMPDIR,
  NEXUS_GATEWAY_RECOVERY_ACTION,
  EXPECTED_NEXUS_GATEWAY_MANAGER_SHA256,
  DEDICATED_GATEWAY_REBIND_SCOPE,
  DEDICATED_GATEWAY_REBIND_SCOPES,
  type CreateServerOptions,
  type GatewayRecoveryOptions,
} from "./server.js";
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
    oauthScopes?: string[];
    authInfo?: AuthInfo;
    gatewayRecovery?: GatewayRecoveryOptions;
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
    ...(options.oauthScopes ? { DEVSPACE_OAUTH_SCOPES: options.oauthScopes.join(",") } : {}),
  });
  let config: ServerConfig = {
    ...loadedConfig,
    oauth: {
      ...loadedConfig.oauth,
      ...(options.oauthScopes ? { scopes: options.oauthScopes } : {}),
    },
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
    ? new LocalAgentSessionManager(config, async () => {})
    : undefined;
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    resolveLocalAgentProviders,
    [],
    agentSessionManager,
    undefined,
    options.gatewayRecovery,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  if (options.authInfo) {
    const origOnMessage = serverTransport.onmessage;
    if (origOnMessage) {
      serverTransport.onmessage = (msg, extra) => {
        origOnMessage(msg, { ...extra, authInfo: options.authInfo });
      };
    }
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
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

  const cancelProps = cancelTool.inputSchema.properties as Record<string, any>;
  assert.equal(cancelProps.workspaceRoot, undefined);
  assert.equal(cancelProps.workerPid, undefined);
  assert.equal(cancelProps.workerToken, undefined);
  assert.equal(cancelProps.signal, undefined);

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
    store.update(startStructured.agentId, { status: "idle" });
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

test("gitCandidates disabled: git tools and candidate promotion are absent", async (t) => {
  const context = await fixture(t, { gitCandidates: false });
  const tools = await context.client.listTools();
  const gitTools = tools.tools.filter((tool) => tool.name.startsWith("git_"));
  assert.equal(gitTools.length, 0);
  assert.equal(tools.tools.some((tool) => tool.name === "candidate_promote"), false);
});

test("gitCandidates enabled: git tools are present with schema validation", async (t) => {
  const context = await fixture(t, { git: true, gitCandidates: true });
  const tools = await context.client.listTools();
  const gitTools = tools.tools.filter((tool) => tool.name.startsWith("git_"));
  assert.equal(gitTools.length, 2);

  const commitTool = gitTools.find((tool) => tool.name === "git_commit");
  const pushTool = gitTools.find((tool) => tool.name === "git_push");
  const promoteTool = tools.tools.find((tool) => tool.name === "candidate_promote");

  assert.ok(commitTool);
  assert.ok(pushTool);
  assert.ok(promoteTool);

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

  const promoteProps = promoteTool.inputSchema.properties as Record<string, any>;
  assert.equal(promoteProps.workspaceRoot, undefined);
  assert.equal(promoteProps.ref, undefined);
  assert.equal(promoteProps.force, undefined);
  assert.equal(promoteProps.remote, undefined);
  assert.equal(promoteProps.branch, undefined);
  assert.ok(promoteProps.sourceWorkspaceId);
  assert.ok(promoteProps.destinationWorkspaceId);
  assert.ok(promoteProps.candidateTree);
  assert.ok(promoteProps.expectedDestinationBranch);
  assert.ok(promoteProps.expectedDestinationHead);
  assert.ok(promoteProps.confirmPromote);
  assert.equal(promoteTool.annotations?.readOnlyHint, false);
  assert.equal(promoteTool.annotations?.destructiveHint, true);
  assert.equal(promoteTool.annotations?.idempotentHint, true);
  assert.equal(promoteTool.annotations?.openWorldHint, false);

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

test("candidate_promote - MCP promotes exact accepted Candidate onto attached local branch and replays idempotently", async (t) => {
  const context = await fixture(t, { git: true, gitCandidates: true });

  const destinationOpen = await callOpen(context.client, context.project, "chat-promote-destination", "checkout");
  const destinationWorkspaceId = structuredContent(destinationOpen).workspaceId as string;
  const destinationHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: context.project })).stdout.trim();
  const destinationBranch = (await execFileAsync("git", ["branch", "--show-current"], { cwd: context.project })).stdout.trim();
  assert.equal(destinationBranch, "main");

  const sourceOpen = await context.client.callTool({
    name: "open_workspace",
    arguments: { path: context.project, mode: "worktree", baseRef: destinationHead },
  });
  assert.equal(sourceOpen.isError, undefined);
  const sourceBody = structuredContent(sourceOpen);
  const sourceWorkspaceId = sourceBody.workspaceId as string;
  const sourceRoot = sourceBody.root as string;
  assert.equal(sourceBody.mode, "worktree");
  assert.equal((sourceBody.worktree as any)?.managed, true);

  await execFileAsync("git", ["config", "user.email", "mcp-test@example.com"], { cwd: sourceRoot });
  await execFileAsync("git", ["config", "user.name", "MCP Test User"], { cwd: sourceRoot });
  await writeFile(join(sourceRoot, "promoted-canary.txt"), "candidate promotion content\n");

  const commitRes = await context.client.callTool({
    name: "git_commit",
    arguments: {
      workspaceId: sourceWorkspaceId,
      expectedHead: destinationHead,
      message: "feat: add promotion canary",
      paths: ["promoted-canary.txt"],
    },
  });
  assert.equal(commitRes.isError, undefined);
  const candidate = structuredContent(commitRes);
  const candidateHead = candidate.commitSha as string;
  const candidateTree = candidate.treeSha as string;

  const promoteArgs = {
    sourceWorkspaceId,
    candidateBase: destinationHead,
    candidateHead,
    candidateTree,
    destinationWorkspaceId,
    expectedDestinationBranch: destinationBranch,
    expectedDestinationHead: destinationHead,
    confirmPromote: true,
  };
  const promoteRes = await context.client.callTool({ name: "candidate_promote", arguments: promoteArgs });
  assert.equal(promoteRes.isError, undefined);
  const promoted = structuredContent(promoteRes);
  assert.equal(promoted.success, true);
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.alreadyPromoted, false);
  assert.equal(promoted.currentHead, candidateHead);
  assert.equal(promoted.candidateTree, candidateTree);
  assert.equal(promoted.acceptanceStatus, "external_not_granted_here");
  assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: context.project })).stdout.trim(), candidateHead);
  assert.equal((await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: context.project })).stdout.trim(), candidateTree);
  assert.equal((await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: context.project })).stdout.trim(), "");
  assert.equal(await readFile(join(context.project, "promoted-canary.txt"), "utf8"), "candidate promotion content\n");

  const replayRes = await context.client.callTool({ name: "candidate_promote", arguments: promoteArgs });
  assert.equal(replayRes.isError, undefined);
  const replay = structuredContent(replayRes);
  assert.equal(replay.success, true);
  assert.equal(replay.promoted, false);
  assert.equal(replay.alreadyPromoted, true);
  assert.equal(replay.currentHead, candidateHead);
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

const GATEWAY_REBIND_REQUEST_ID = "issue526-g4a-test-request";
const GATEWAY_REBIND_REQUEST_HASH =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GATEWAY_REBIND_ARGS = {
  requestId: GATEWAY_REBIND_REQUEST_ID,
  requestHash: GATEWAY_REBIND_REQUEST_HASH,
};
const GATEWAY_REBIND_STORE = {
  schema: "nexus.gateway.deployment.v1",
  operation: "gateway-recover",
  request_id: GATEWAY_REBIND_REQUEST_ID,
  request_hash: GATEWAY_REBIND_REQUEST_HASH,
};

function dedicatedRebindAuth() {
  return {
    oauthScopes: [DEDICATED_GATEWAY_REBIND_SCOPE],
    authInfo: {
      token: "dedicated-gateway-rebind-token",
      clientId: "chatgpt-main-controller",
      scopes: [DEDICATED_GATEWAY_REBIND_SCOPE],
    } satisfies AuthInfo,
  };
}

type ForbiddenCreateServerSeams = Extract<
  keyof CreateServerOptions,
  | "gatewayRecovery"
  | "verifyManagerHashFn"
  | "execFileFn"
  | "readManagerBytesFn"
  | "readRequestStoreFn"
  | "timeoutMs"
>;
const productionCreateServerHasNoGatewaySeams: ForbiddenCreateServerSeams extends never ? true : never = true;

function trackingExec(
  state: { count: number; file?: string; args?: readonly string[]; opts?: any },
  callbackImpl?: (
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => void,
): GatewayRecoveryOptions["execFileFn"] {
  return (file, args, opts, callback) => {
    state.count += 1;
    state.file = file;
    state.args = args;
    state.opts = opts;
    if (callbackImpl) {
      callbackImpl(callback);
      return;
    }
    callback(null, JSON.stringify({ ok: true }), "");
  };
}

test("nexus.gateway_rebind.reload.v1: tool is registered with exact fixed name, schema, and non-read-only destructive non-idempotent annotations", async (t) => {
  const context = await fixture(t);
  const tools = await context.client.listTools();
  const rebindTool = tools.tools.find((tool) => tool.name === "nexus.gateway_rebind.reload.v1");
  assert.ok(rebindTool, "nexus.gateway_rebind.reload.v1 tool must be registered");

  // F5: timeout is UNCERTAIN_EFFECT / do-not-blind-retry, so the transport
  // must not advertise idempotentHint=true.
  assert.equal(rebindTool.annotations?.readOnlyHint, false);
  assert.equal(rebindTool.annotations?.destructiveHint, true);
  assert.equal(rebindTool.annotations?.idempotentHint, false);
  assert.equal(rebindTool.annotations?.openWorldHint, false);

  const inputSchema = rebindTool.inputSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const inputProps = inputSchema.properties ?? {};
  const required = inputSchema.required ?? [];
  assert.ok("requestHash" in inputProps);
  assert.ok("requestId" in inputProps);
  assert.ok(required.includes("requestHash"));
  assert.ok(required.includes("requestId"));
  assert.equal("executable" in inputProps, false);
  assert.equal("cmd" in inputProps, false);
  assert.equal("command" in inputProps, false);
  assert.equal("action" in inputProps, false);
  assert.equal("root" in inputProps, false);
  assert.equal("sourceRoot" in inputProps, false);
  assert.equal("cwd" in inputProps, false);
  assert.equal("plist" in inputProps, false);
  assert.equal("label" in inputProps, false);
  assert.equal("pid" in inputProps, false);
  assert.equal("endpoint" in inputProps, false);
  assert.equal("service" in inputProps, false);
  assert.equal("env" in inputProps, false);
  assert.equal("managerExecutable" in inputProps, false);
  assert.equal("pythonExecutable" in inputProps, false);
  assert.equal("requestStorePath" in inputProps, false);
  assert.equal("evidenceStorePath" in inputProps, false);
  assert.equal("expectedHash" in inputProps, false);
  assert.equal("managerHash" in inputProps, false);

  assert.equal(
    EXPECTED_NEXUS_GATEWAY_MANAGER_SHA256,
    "6625224ab881cdbd68f66607d190b1b0b7608c9175a1e69f0222653af467c125",
  );
  assert.deepEqual([...DEDICATED_GATEWAY_REBIND_SCOPES], [DEDICATED_GATEWAY_REBIND_SCOPE]);
  assert.equal(DEDICATED_GATEWAY_REBIND_SCOPE, "nexus.gateway_rebind.reload.v1");
  assert.equal(NEXUS_GATEWAY_RECOVERY_ACTION, "gateway-recover");
  assert.deepEqual([...NEXUS_GATEWAY_RECOVERY_ARGV], [
    NEXUS_GATEWAY_MANAGER_EXECUTABLE,
    "gateway-recover",
    "--gateway-request",
    NEXUS_GATEWAY_REQUEST_STORE,
    "--gateway-evidence",
    NEXUS_GATEWAY_EVIDENCE_STORE,
  ]);
});

test("nexus.gateway_rebind.reload.v1: public createServer construction cannot override manager verification", () => {
  assert.equal(productionCreateServerHasNoGatewaySeams, true);
  assert.doesNotMatch(
    Function.prototype.toString.call(createServer),
    /\bgatewayRecovery\b/,
  );
  assert.doesNotMatch(
    Function.prototype.toString.call(createServer),
    /\bverifyManagerHashFn\b/,
  );
  assert.doesNotMatch(
    Function.prototype.toString.call(createServer),
    /\breadManagerBytesFn\b/,
  );
  assert.doesNotMatch(
    Function.prototype.toString.call(createServer),
    /\breadRequestStoreFn\b/,
  );
  assert.doesNotMatch(
    Function.prototype.toString.call(createServer),
    /\bexecFileFn\b/,
  );

  const productionOptions: CreateServerOptions = { incomingArtifactAdapters: [] };
  assert.equal("gatewayRecovery" in productionOptions, false);

  const accepted: CreateServerOptions = {
    incomingArtifactAdapters: [],
    // @ts-expect-error production CreateServerOptions cannot include gatewayRecovery
    gatewayRecovery: {
      verifyManagerHashFn: () => true,
      execFileFn: () => undefined,
      readManagerBytesFn: () => Buffer.from("evil-manager"),
      readRequestStoreFn: () => "{}",
      timeoutMs: 1,
    },
  };
  void accepted;
  assert.doesNotMatch(
    Function.prototype.toString.call(createServer),
    /options\.gatewayRecovery/,
  );
});

test("nexus.gateway_rebind.reload.v1: missing dedicated OAuth scope fails closed before any filesystem read or exec", async (t) => {
  let readCalled = false;
  let execCalled = false;
  const context = await fixture(t, {
    gatewayRecovery: {
      readManagerBytesFn: () => {
        readCalled = true;
        return Buffer.from("must-not-read");
      },
      execFileFn: (_file, _args, _opts, callback) => {
        execCalled = true;
        callback(null, JSON.stringify({ success: true }), "");
      },
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: GATEWAY_REBIND_ARGS,
  });

  assert.equal(res.isError, true);
  assert.equal(readCalled, false, "must not read manager without dedicated scope");
  assert.equal(execCalled, false, "execFile must never be called without dedicated scope");
  const structured = structuredContent(res);
  assert.equal(structured.ok, false);
  assert.equal((structured.error as Record<string, unknown>).code, "GATEWAY_REBIND_SCOPE_NOT_CONFIGURED");
  assert.match(responseText(res), /GATEWAY_REBIND_SCOPE_NOT_CONFIGURED/);
});

test("nexus.gateway_rebind.reload.v1: ordinary devspace OAuth scope alone is insufficient", async (t) => {
  let readCalled = false;
  let execCalled = false;
  const context = await fixture(t, {
    oauthScopes: ["devspace"],
    authInfo: {
      token: "ordinary-devspace-token",
      clientId: "chatgpt",
      scopes: ["devspace"],
    },
    gatewayRecovery: {
      readManagerBytesFn: () => {
        readCalled = true;
        return Buffer.from("must-not-read");
      },
      execFileFn: (_file, _args, _opts, callback) => {
        execCalled = true;
        callback(null, JSON.stringify({ success: true }), "");
      },
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: GATEWAY_REBIND_ARGS,
  });

  assert.equal(res.isError, true);
  assert.equal(readCalled, false);
  assert.equal(execCalled, false, "execFile must not be called with only ordinary devspace scope");
  const structured = structuredContent(res);
  assert.equal(structured.ok, false);
  assert.equal((structured.error as Record<string, unknown>).code, "GATEWAY_REBIND_SCOPE_NOT_CONFIGURED");
});

test("nexus.gateway_rebind.reload.v1: configured dedicated scope still requires the token scope", async (t) => {
  let readCalled = false;
  let execCalled = false;
  const context = await fixture(t, {
    oauthScopes: [DEDICATED_GATEWAY_REBIND_SCOPE, "devspace"],
    authInfo: {
      token: "ordinary-devspace-token",
      clientId: "chatgpt",
      scopes: ["devspace"],
    },
    gatewayRecovery: {
      readManagerBytesFn: () => {
        readCalled = true;
        return Buffer.from("must-not-read");
      },
      execFileFn: (_file, _args, _opts, callback) => {
        execCalled = true;
        callback(null, "{}", "");
      },
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: GATEWAY_REBIND_ARGS,
  });

  assert.equal(res.isError, true);
  assert.equal(readCalled, false);
  assert.equal(execCalled, false);
  assert.equal((structuredContent(res).error as Record<string, unknown>).code, "GATEWAY_REBIND_SCOPE_NOT_CONFIGURED");
});

test("nexus.gateway_rebind.reload.v1: empty arguments fail closed before read or exec", async (t) => {
  let readCalled = false;
  let execCalled = false;
  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => {
        readCalled = true;
        return Buffer.from("must-not-read");
      },
      execFileFn: (_file, _args, _opts, callback) => {
        execCalled = true;
        callback(null, "{}", "");
      },
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: {},
  });

  assert.equal(res.isError, true);
  assert.equal(readCalled, false, "omitted fence must not read the host manager");
  assert.equal(execCalled, false, "omitted fence must not execute the host manager");
});

test("nexus.gateway_rebind.reload.v1: wrong manager bytes fails closed with MANAGER_HASH_MISMATCH before exec (F1)", async (t) => {
  let execCalled = false;
  const alteredManagerContent = Buffer.from("#!/usr/bin/env python3\n# altered manager content\n");
  assert.notEqual(
    createHash("sha256").update(alteredManagerContent).digest("hex"),
    EXPECTED_NEXUS_GATEWAY_MANAGER_SHA256,
  );

  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => alteredManagerContent,
      execFileFn: (_file, _args, _opts, callback) => {
        execCalled = true;
        callback(null, "{}", "");
      },
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: GATEWAY_REBIND_ARGS,
  });

  assert.equal(res.isError, true);
  assert.equal(execCalled, false, "execFile must never be called on manager hash mismatch");
  const structured = structuredContent(res);
  assert.equal(structured.ok, false);
  assert.equal((structured.error as Record<string, unknown>).code, "MANAGER_HASH_MISMATCH");
  assert.match(responseText(res), /MANAGER_HASH_MISMATCH/);
});

test("nexus.gateway_rebind.reload.v1: missing manager fails closed with MANAGER_NOT_INSTALLED before exec", async (t) => {
  let execCalled = false;
  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => {
        const error = new Error("ENOENT: no such file or directory");
        (error as any).code = "ENOENT";
        throw error;
      },
      execFileFn: (_file, _args, _opts, callback) => {
        execCalled = true;
        callback(null, "{}", "");
      },
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: GATEWAY_REBIND_ARGS,
  });

  assert.equal(res.isError, true);
  assert.equal(execCalled, false, "execFile must never be called when manager is not installed");
  const structured = structuredContent(res);
  assert.equal(structured.ok, false);
  assert.equal((structured.error as Record<string, unknown>).code, "MANAGER_NOT_INSTALLED");
  assert.match(responseText(res), /MANAGER_NOT_INSTALLED/);
});

test("nexus.gateway_rebind.reload.v1: missing request store fails closed with REQUEST_STORE_MISSING before exec", async (t) => {
  let execCalled = false;
  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => Buffer.from("mock-manager-bytes"),
      verifyManagerHashFn: () => true,
      readRequestStoreFn: () => {
        const error = new Error("ENOENT: no such file or directory");
        (error as any).code = "ENOENT";
        throw error;
      },
      execFileFn: (_file, _args, _opts, callback) => {
        execCalled = true;
        callback(null, "{}", "");
      },
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: GATEWAY_REBIND_ARGS,
  });

  assert.equal(res.isError, true);
  assert.equal(execCalled, false, "execFile must never be called when request store is missing");
  const structured = structuredContent(res);
  assert.equal(structured.ok, false);
  assert.equal((structured.error as Record<string, unknown>).code, "REQUEST_STORE_MISSING");
  assert.match(responseText(res), /REQUEST_STORE_MISSING/);
});

test("nexus.gateway_rebind.reload.v1: malformed or missing request fence in store fails closed before exec (F3)", async (t) => {
  let execCalled = false;
  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => Buffer.from("mock-manager-bytes"),
      verifyManagerHashFn: () => true,
      readRequestStoreFn: () => JSON.stringify({ invalid: "schema" }),
      execFileFn: (_file, _args, _opts, callback) => {
        execCalled = true;
        callback(null, "{}", "");
      },
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: GATEWAY_REBIND_ARGS,
  });

  assert.equal(res.isError, true);
  assert.equal(execCalled, false, "execFile must never be called on invalid request fence");
  const structured = structuredContent(res);
  assert.equal(structured.ok, false);
  assert.equal((structured.error as Record<string, unknown>).code, "REQUEST_FENCE_REJECTED");
  assert.match(responseText(res), /REQUEST_FENCE_REJECTED/);
});

test("nexus.gateway_rebind.reload.v1: missing stored request_id fails closed before exec", async (t) => {
  let execCalled = false;
  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => Buffer.from("mock-manager-bytes"),
      verifyManagerHashFn: () => true,
      readRequestStoreFn: () => JSON.stringify({
        schema: "nexus.gateway.deployment.v1",
        operation: "gateway-recover",
        request_hash: GATEWAY_REBIND_REQUEST_HASH,
      }),
      execFileFn: (_file, _args, _opts, callback) => {
        execCalled = true;
        callback(null, "{}", "");
      },
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: GATEWAY_REBIND_ARGS,
  });

  assert.equal(res.isError, true);
  assert.equal(execCalled, false);
  assert.equal((structuredContent(res).error as Record<string, unknown>).code, "REQUEST_FENCE_REJECTED");
});

test("nexus.gateway_rebind.reload.v1: missing stored request_hash fails closed before exec", async (t) => {
  let execCalled = false;
  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => Buffer.from("mock-manager-bytes"),
      verifyManagerHashFn: () => true,
      readRequestStoreFn: () => JSON.stringify({
        schema: "nexus.gateway.deployment.v1",
        operation: "gateway-recover",
        request_id: GATEWAY_REBIND_REQUEST_ID,
      }),
      execFileFn: (_file, _args, _opts, callback) => {
        execCalled = true;
        callback(null, "{}", "");
      },
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: GATEWAY_REBIND_ARGS,
  });

  assert.equal(res.isError, true);
  assert.equal(execCalled, false);
  assert.equal((structuredContent(res).error as Record<string, unknown>).code, "REQUEST_FENCE_REJECTED");
});

test("nexus.gateway_rebind.reload.v1: stale host request schema fails closed before exec", async (t) => {
  let execCalled = false;
  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => Buffer.from("mock-manager-bytes"),
      verifyManagerHashFn: () => true,
      readRequestStoreFn: () => JSON.stringify({
        schema: "nexus.gateway.durable_recovery_request.v1",
        operation: "gateway-recover",
        request_id: GATEWAY_REBIND_REQUEST_ID,
        request_hash: GATEWAY_REBIND_REQUEST_HASH,
      }),
      execFileFn: (_file, _args, _opts, callback) => {
        execCalled = true;
        callback(null, "{}", "");
      },
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: GATEWAY_REBIND_ARGS,
  });

  assert.equal(res.isError, true);
  assert.equal(execCalled, false);
  assert.equal((structuredContent(res).error as Record<string, unknown>).code, "REQUEST_FENCE_REJECTED");
});

test("nexus.gateway_rebind.reload.v1: caller requestId mismatch against stored request fails closed before exec (F3)", async (t) => {
  let execCalled = false;
  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => Buffer.from("mock-manager-bytes"),
      verifyManagerHashFn: () => true,
      readRequestStoreFn: () => JSON.stringify(GATEWAY_REBIND_STORE),
      execFileFn: (_file, _args, _opts, callback) => {
        execCalled = true;
        callback(null, "{}", "");
      },
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: {
      requestId: "wrong-request-id",
      requestHash: GATEWAY_REBIND_REQUEST_HASH,
    },
  });

  assert.equal(res.isError, true);
  assert.equal(execCalled, false, "execFile must never be called when caller requestId does not match stored request");
  const structured = structuredContent(res);
  assert.equal(structured.ok, false);
  assert.equal((structured.error as Record<string, unknown>).code, "REQUEST_FENCE_REJECTED");
});

test("nexus.gateway_rebind.reload.v1: caller requestHash mismatch against stored request fails closed before exec (F3)", async (t) => {
  let execCalled = false;
  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => Buffer.from("mock-manager-bytes"),
      verifyManagerHashFn: () => true,
      readRequestStoreFn: () => JSON.stringify(GATEWAY_REBIND_STORE),
      execFileFn: (_file, _args, _opts, callback) => {
        execCalled = true;
        callback(null, "{}", "");
      },
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: {
      requestId: GATEWAY_REBIND_REQUEST_ID,
      requestHash: "0000000000000000000000000000000000000000000000000000000000000000",
    },
  });

  assert.equal(res.isError, true);
  assert.equal(execCalled, false, "execFile must never be called when caller requestHash does not match stored request");
  const structured = structuredContent(res);
  assert.equal(structured.ok, false);
  assert.equal((structured.error as Record<string, unknown>).code, "REQUEST_FENCE_REJECTED");
});

test("nexus.gateway_rebind.reload.v1: file SHA is not an accepted requestHash meaning", async (t) => {
  let execCalled = false;
  const content = JSON.stringify(GATEWAY_REBIND_STORE);
  const fileSha = createHash("sha256").update(content).digest("hex");
  assert.notEqual(fileSha, GATEWAY_REBIND_REQUEST_HASH);

  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => Buffer.from("mock-manager-bytes"),
      verifyManagerHashFn: () => true,
      readRequestStoreFn: () => content,
      execFileFn: (_file, _args, _opts, callback) => {
        execCalled = true;
        callback(null, "{}", "");
      },
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: {
      requestId: GATEWAY_REBIND_REQUEST_ID,
      requestHash: fileSha,
    },
  });

  assert.equal(res.isError, true);
  assert.equal(execCalled, false, "file SHA must not satisfy the request_hash fence");
  assert.equal((structuredContent(res).error as Record<string, unknown>).code, "REQUEST_FENCE_REJECTED");
});

test("nexus.gateway_rebind.reload.v1: successful manager invocation parses receipt and verifies immutable paths and minimal safe environment (F2, F6, F9)", async (t) => {
  const execState: { count: number; file?: string; args?: readonly string[]; opts?: any } = { count: 0 };
  const receipt = {
    profile: "com.nexus.mcp.gateway.direct",
    operation: "gateway-recover",
    success: true,
    reloaded: true,
    observed: { head: "99ebab77a1324543523da116e27334f2e565277d" },
  };

  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => Buffer.from("mock-manager-bytes"),
      verifyManagerHashFn: () => true,
      readRequestStoreFn: () => JSON.stringify(GATEWAY_REBIND_STORE),
      execFileFn: trackingExec(execState, (callback) => {
        callback(null, JSON.stringify(receipt), "");
      }),
      ...({
        managerExecutable: "/tmp/evil-manager.py",
        pythonExecutable: "/tmp/evil-python",
        requestStorePath: "/tmp/evil-request.json",
        evidenceStorePath: "/tmp/evil-evidence.json",
        action: "launchctl",
      } as any),
    },
  });

  const originalPath = process.env.PATH;
  process.env.PATH = "/tmp/evil-bin:/usr/bin";
  process.env.USER = "attacker";
  process.env.LOGNAME = "attacker";
  process.env.LANG = "evil";
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    delete process.env.USER;
    delete process.env.LOGNAME;
    delete process.env.LANG;
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: GATEWAY_REBIND_ARGS,
  });

  assert.equal(res.isError, undefined);
  const structured = structuredContent(res);
  assert.equal(structured.ok, true);
  assert.deepEqual(structured.receipt, receipt);
  assert.match(responseText(res), /completed successfully/);
  assert.equal(execState.count, 1);
  assert.equal(execState.file, NEXUS_PYTHON_EXECUTABLE);
  assert.deepEqual(execState.args, [...NEXUS_GATEWAY_RECOVERY_ARGV]);
  assert.equal(execState.opts.cwd, NEXUS_GATEWAY_DIRECT_ROOT);
  assert.equal(execState.opts.shell, false);
  const capturedEnv = execState.opts.env as Record<string, string>;
  assert.deepEqual(Object.keys(capturedEnv).sort(), [
    "HOME",
    "PATH",
    "PYTHONDONTWRITEBYTECODE",
    "PYTHONUNBUFFERED",
    "TMPDIR",
  ]);
  assert.equal(capturedEnv.PATH, NEXUS_GATEWAY_RECOVERY_PATH);
  assert.equal(capturedEnv.TMPDIR, NEXUS_GATEWAY_RECOVERY_TMPDIR);
  assert.equal(capturedEnv.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(capturedEnv.PYTHONUNBUFFERED, "1");
  assert.equal("USER" in capturedEnv, false);
  assert.equal("LOGNAME" in capturedEnv, false);
  assert.equal("LANG" in capturedEnv, false);
  assert.notEqual(capturedEnv.PATH, process.env.PATH);
});

test("nexus.gateway_rebind.reload.v1: non-zero manager exit preserves error without retry (F7)", async (t) => {
  const execState: { count: number; file?: string; args?: readonly string[]; opts?: any } = { count: 0 };
  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => Buffer.from("mock-manager-bytes"),
      verifyManagerHashFn: () => true,
      readRequestStoreFn: () => JSON.stringify(GATEWAY_REBIND_STORE),
      execFileFn: trackingExec(execState, (callback) => {
        const error = new Error("Command failed: python manager.py") as Error & { code: number };
        error.code = 2;
        callback(error, "request hash mismatch in manager stderr", "GateError: launchctl command failed");
      }),
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: GATEWAY_REBIND_ARGS,
  });

  assert.equal(res.isError, true);
  assert.equal(execState.count, 1, "Must not retry on non-zero exit");
  const structured = structuredContent(res);
  assert.equal(structured.ok, false);
  assert.equal((structured.error as Record<string, unknown>).code, "MANAGER_EXIT_NON_ZERO");
  assert.equal(structured.exitCode, 2);
});

test("nexus.gateway_rebind.reload.v1: malformed manager JSON fails closed", async (t) => {
  const execState: { count: number; file?: string; args?: readonly string[]; opts?: any } = { count: 0 };
  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => Buffer.from("mock-manager-bytes"),
      verifyManagerHashFn: () => true,
      readRequestStoreFn: () => JSON.stringify(GATEWAY_REBIND_STORE),
      execFileFn: trackingExec(execState, (callback) => {
        callback(null, "NON_JSON_PLAIN_TEXT_OUTPUT\n", "");
      }),
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: GATEWAY_REBIND_ARGS,
  });

  assert.equal(res.isError, true);
  assert.equal(execState.count, 1);
  const structured = structuredContent(res);
  assert.equal(structured.ok, false);
  assert.equal((structured.error as Record<string, unknown>).code, "MALFORMED_MANAGER_JSON");
});

test("nexus.gateway_rebind.reload.v1: timeout produces UNCERTAIN_EFFECT and does not retry (F8)", async (t) => {
  const execState: { count: number; file?: string; args?: readonly string[]; opts?: any } = { count: 0 };
  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => Buffer.from("mock-manager-bytes"),
      verifyManagerHashFn: () => true,
      readRequestStoreFn: () => JSON.stringify(GATEWAY_REBIND_STORE),
      execFileFn: trackingExec(execState, (callback) => {
        const error = new Error("Command timed out") as Error & {
          killed: boolean;
          signal: string;
          code: string;
        };
        error.killed = true;
        error.signal = "SIGTERM";
        error.code = "ETIMEDOUT";
        callback(error, "", "timed out after 30000ms");
      }),
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: GATEWAY_REBIND_ARGS,
  });

  assert.equal(res.isError, true);
  assert.equal(execState.count, 1, "Must not invoke manager a second time on timeout");
  const structured = structuredContent(res);
  assert.equal(structured.ok, false);
  assert.equal(structured.uncertainEffect, true);
  assert.equal(structured.reconciliationRequired, true);
  assert.equal((structured.error as Record<string, unknown>).code, "UNCERTAIN_EFFECT");
  assert.equal((structured.error as Record<string, unknown>).timedOut, true);
});

test("nexus.gateway_rebind.reload.v1: idempotentHint remains false because timeout is UNCERTAIN_EFFECT", async (t) => {
  const context = await fixture(t);
  const tools = await context.client.listTools();
  const rebindTool = tools.tools.find((tool) => tool.name === "nexus.gateway_rebind.reload.v1");
  assert.equal(rebindTool?.annotations?.idempotentHint, false);
  assert.equal(rebindTool?.annotations?.destructiveHint, true);
  assert.equal(rebindTool?.annotations?.readOnlyHint, false);
});

test("nexus.gateway_rebind.reload.v1: caller input regex rejects shell metacharacters and invalid formats without host reads", async (t) => {
  let readCalled = false;
  let execCalled = false;
  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => {
        readCalled = true;
        return Buffer.from("must-not-read");
      },
      readRequestStoreFn: () => {
        readCalled = true;
        return "{}";
      },
      execFileFn: (_file, _args, _opts, callback) => {
        execCalled = true;
        callback(null, "{}", "");
      },
    },
  });

  const resMeta = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: {
      requestId: "req; rm -rf /",
      requestHash: GATEWAY_REBIND_REQUEST_HASH,
    },
  });
  assert.equal(resMeta.isError, true);

  const resHash = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: {
      requestId: GATEWAY_REBIND_REQUEST_ID,
      requestHash: "not-a-valid-64-char-hex-hash",
    },
  });
  assert.equal(resHash.isError, true);
  assert.equal(readCalled, false, "invalid input must not read host manager or request store");
  assert.equal(execCalled, false, "invalid input must not execute host manager");
});

test("nexus.gateway_rebind.reload.v1: no DevSpace restart or launchctl logic is executed", async (t) => {
  const invokedExecutables: string[] = [];
  const invokedArgs: string[][] = [];
  const context = await fixture(t, {
    ...dedicatedRebindAuth(),
    gatewayRecovery: {
      readManagerBytesFn: () => Buffer.from("mock-manager-bytes"),
      verifyManagerHashFn: () => true,
      readRequestStoreFn: () => JSON.stringify(GATEWAY_REBIND_STORE),
      execFileFn: (file, args, _opts, callback) => {
        invokedExecutables.push(file);
        invokedArgs.push([...args]);
        callback(null, JSON.stringify({ success: true, profile: "com.nexus.mcp.gateway.direct" }), "");
      },
    },
  });

  const res = await context.client.callTool({
    name: "nexus.gateway_rebind.reload.v1",
    arguments: GATEWAY_REBIND_ARGS,
  });

  assert.equal(res.isError, undefined);
  assert.equal(invokedExecutables.length, 1);
  assert.equal(invokedExecutables[0], NEXUS_PYTHON_EXECUTABLE);
  assert.ok(!invokedExecutables.includes("launchctl"));
  assert.ok(!invokedExecutables.includes("sh"));
  assert.ok(!invokedExecutables.includes("bash"));
  assert.ok(!invokedArgs.flat().includes("launchctl"));
  assert.ok(!invokedArgs.flat().includes("kickstart"));
});
