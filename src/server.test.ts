import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as z from "zod/v4";
import { loadConfig, type ServerConfig } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { MINIMUM_CODEX_RUNTIME_VERSION } from "./codex-runtime.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { DurableOperationManager } from "./durable-operations.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { createMcpServer, createServer, resolveDurableReconciliationWitnessFromInventory } from "./server.js";
import { CutoverStateStore } from "./cutover-state.js";
import { McpCutoverController } from "./mcp-cutover.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { LocalAgentSessionManager } from "./local-agent-sessions.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { ChatSwarmLifecycle } from "./chat-swarm-lifecycle.js";
import { ChatSwarmRuntimeAlreadyOwnedError } from "./chat-swarm-runtime-owner.js";
import { ChatSwarmStore } from "./chat-swarm-store.js";
import { chatSwarmToolInputShapes } from "./chat-swarm-tools.js";

import { SqliteOAuthStore, SqliteOAuthClientsStore } from "./oauth-store.js";

const execFileAsync = promisify(execFile);

function normalizedSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedSchema);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const normalized = Object.fromEntries(Object.entries(object)
    .filter(([key]) => key !== "$schema")
    .map(([key, child]) => [key, normalizedSchema(child)]));
  return normalized;
}

function assertRegisteredChatSwarmSchemaParity(
  actualTools: readonly { name: string; inputSchema?: unknown }[],
  expectedShapes: Record<string, Record<string, z.ZodType>>,
): void {
  const actual = Object.fromEntries(actualTools.map((tool) => [tool.name, tool.inputSchema]));
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expectedShapes).sort());
  for (const [name, shape] of Object.entries(expectedShapes)) {
    const expected = normalizedSchema(z.toJSONSchema(z.object(shape), { io: "input", target: "draft-7" }));
    assert.deepEqual(normalizedSchema(actual[name]), expected);
  }
}

// Hermetic Codex runtime so dispatch gates see a valid, inspectable runtime
// and spawned workers fail fast locally instead of invoking a real provider.
const originalDependencyRoot = process.env.DEVSPACE_DEPENDENCY_ROOT;
const codexRuntimeRoot = mkdtempSync(join(tmpdir(), "devspace-server-codex-runtime-"));
mkdirSync(join(codexRuntimeRoot, "node_modules", "@openai", "codex-sdk"), { recursive: true });
writeFileSync(
  join(codexRuntimeRoot, "node_modules", "@openai", "codex-sdk", "package.json"),
  JSON.stringify({ name: "@openai/codex-sdk", version: MINIMUM_CODEX_RUNTIME_VERSION }),
);
const codexExecutable = process.platform === "win32"
  ? join(codexRuntimeRoot, "node_modules", "@openai", process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64", "vendor", process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc", "bin", "codex.exe")
  : join(codexRuntimeRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
mkdirSync(dirname(codexExecutable), { recursive: true });
if (process.platform === "win32") {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const compiler = systemRoot
    ? join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
    : "";
  if (!compiler || !existsSync(compiler)) throw new Error(`Windows PE fixture compiler is unavailable: ${compiler || "SystemRoot"}`);
  const source = `${codexExecutable}.cs`;
  writeFileSync(source, `using System; class Program { static void Main() { Console.WriteLine("codex-cli ${MINIMUM_CODEX_RUNTIME_VERSION}"); } }`);
  try {
    execFileSync(compiler, ["/nologo", "/target:exe", `/out:${codexExecutable}`, source], { stdio: "ignore" });
  } finally {
    rmSync(source, { force: true });
  }
} else {
  writeFileSync(
    codexExecutable,
    `#!/bin/sh\necho 'codex-cli ${MINIMUM_CODEX_RUNTIME_VERSION}'\n`,
    { mode: 0o755 },
  );
}
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
      inspectWorkspace: (workspaceId) => workspaces.inspectWorkspace(workspaceId),
      listWorkspaceSessions: () => workspaces.listSessions(),
      advance: async () => ({
        outcome: "restart_already_scheduled",
        reason: "restart already durably scheduled",
        scheduledFor: "com.example.devspace",
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
      "workspace_inspect",
      "cutover_reconcile",
    ]) {
      assert.ok(tools.tools.some((tool) => tool.name === name), `missing ${name}`);
    }

    const deniedStart = await client.callTool({
      name: "cutover_start",
      arguments: {
        expectedSourceCommit: "b".repeat(40),
        expectedBuildId: "new-build",
        expectedCapabilityManifestSha256: "a".repeat(64),
      },
    });
    assert.equal(deniedStart.isError,true);
    assert.equal(cutoverController.record(),undefined);
    // Trusted fixture setup for the following lifecycle-handler checks.
    cutoverController.begin({sourceCommit:"b".repeat(40),buildId:"new-build",capabilityManifestSha256:"a".repeat(64)});

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
      arguments: {
        cutoverId: "cutover-mcp-control",
        buildReady: { verifiedBy: "test-operator", verifiedAt: "2025-01-01T00:00:00.000Z" },
      },
    }));
    assert.equal((firstRestart.restart as Record<string, unknown>).scheduled, true);
    assert.equal((firstRestart.restart as Record<string, unknown>).alreadyRequested, false);
    assert.equal((firstRestart.restart as Record<string, unknown>).scheduleBlocked, false);
    assert.equal(restartSchedules, 1);

    const duplicateRestart = structuredContent(await client.callTool({
      name: "cutover_restart_self",
      arguments: {
        cutoverId: "cutover-mcp-control",
        buildReady: { verifiedBy: "test-operator", verifiedAt: "2025-01-01T00:00:00.000Z" },
      },
    }));
    assert.equal((duplicateRestart.restart as Record<string, unknown>).scheduled, false);
    assert.equal((duplicateRestart.restart as Record<string, unknown>).alreadyRequested, true);
    assert.equal((duplicateRestart.restart as Record<string, unknown>).scheduleBlocked, false);
    assert.equal(restartSchedules, 1);

    const inspectAll = structuredContent(await client.callTool({
      name: "workspace_inspect",
      arguments: {},
    }));
    assert.equal(inspectAll.workspaceSessions, 0);

    const inspectMissing = structuredContent(await client.callTool({
      name: "workspace_inspect",
      arguments: { workspaceId: "ws-does-not-exist" },
    }));
    assert.equal(inspectMissing.workspaceSessions, 0);
    assert.equal(
      (inspectMissing.detail as Array<Record<string, unknown>>)[0].loaded,
      false,
    );

    const reconciled = structuredContent(await client.callTool({
      name: "cutover_reconcile",
      arguments: {},
    }));
    assert.equal(
      (reconciled.outcome as Record<string, unknown>).outcome,
      "restart_already_scheduled",
    );
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
    chatSwarm?: boolean;
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
    DEVSPACE_CHAT_SWARM: options.chatSwarm ? "1" : "0",
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
  const chatSwarmLifecycle = config.chatSwarmEnabled ? new ChatSwarmLifecycle({ stateDir }) : undefined;
  chatSwarmLifecycle?.recoverAfterStartup();
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
    undefined,
    undefined,
    undefined,
    chatSwarmLifecycle,
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
    chatSwarmLifecycle?.close();
    agentSessionManager?.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project, config, stateDir, close };
}

test("Chat Swarm production registration is opt-in and uses the shared lifecycle", async (t) => {
  const disabled = await fixture(t);
  assert.equal((await disabled.client.listTools()).tools.some((tool) => tool.name === "chat_swarm_create"), false);
  await disabled.close();

  const enabled = await fixture(t, { chatSwarm: true });
  const tools = await enabled.client.listTools();
  const swarmTools = tools.tools.filter((tool) => tool.name.startsWith("chat_swarm_"));
  assert.equal(swarmTools.length, 10);
  assert.ok(swarmTools.every((tool) => tool.inputSchema));
  const expectedShapes = chatSwarmToolInputShapes(enabled.config);
  assertRegisteredChatSwarmSchemaParity(swarmTools, expectedShapes);
  assert.throws(() => assertRegisteredChatSwarmSchemaParity(swarmTools.slice(1), expectedShapes));
  assert.throws(() => assertRegisteredChatSwarmSchemaParity(swarmTools, {
    ...expectedShapes,
    chat_swarm_next: { workerId: z.string().min(1) },
  }));
  assert.ok(swarmTools.find((tool) => tool.name === "chat_swarm_status")?.annotations?.readOnlyHint);
  const owner = { "openai/session": "server-owner" };
  const created = await enabled.client.callTool({ name: "chat_swarm_create", arguments: { workerLimit: 1 }, _meta: owner });
  assert.equal(created.isError, undefined);
  const createdValue = created.structuredContent as Record<string, any>;
  assert.equal(createdValue.swarm.status, "ACTIVE");
  const workerCall = await enabled.client.callTool({
    name: "chat_swarm_join",
    arguments: { swarmId: createdValue.swarm.id, inviteCredential: createdValue.inviteCredential, label: "server-peer", runtimeKind: "mcp_peer" },
    _meta: { "openai/session": "server-peer" },
  });
  assert.equal(workerCall.isError, undefined);
  const worker = workerCall.structuredContent as Record<string, any>;
  const dispatched = await enabled.client.callTool({
    name: "chat_swarm_dispatch",
    arguments: { swarmId: createdValue.swarm.id, taskKey: "server-task", prompt: "server protocol" },
    _meta: owner,
  });
  assert.equal(dispatched.isError, undefined);
  const task = dispatched.structuredContent as Record<string, any>;
  const next = await enabled.client.callTool({ name: "chat_swarm_next", arguments: { workerId: worker.id }, _meta: { "openai/session": "server-peer" } });
  assert.equal((next.structuredContent as Record<string, any>).task.id, task.id);
  const submitted = await enabled.client.callTool({ name: "chat_swarm_submit", arguments: { workerId: worker.id, taskId: task.id, result: "server-result" }, _meta: { "openai/session": "server-peer" } });
  assert.equal((submitted.structuredContent as Record<string, any>).lifecycleState, "RESULT_READY");
  const collected = await enabled.client.callTool({ name: "chat_swarm_collect", arguments: { swarmId: createdValue.swarm.id, taskId: task.id }, _meta: owner });
  assert.equal((collected.structuredContent as Record<string, any>).lifecycleState, "COLLECTED");
  const closed = await enabled.client.callTool({ name: "chat_swarm_close", arguments: { swarmId: createdValue.swarm.id }, _meta: owner });
  assert.equal((closed.structuredContent as Record<string, any>).status, "CLOSED");
});

function trackServerStoreCloses(t: TestContext) {
  const counts = new Map<object, number>();
  for (const prototype of [DurableOperationManager.prototype, SqliteWorkspaceStore.prototype, SingleUserOAuthProvider.prototype]) {
    const original = prototype.close;
    t.mock.method(prototype, "close", function (this: typeof prototype) {
      counts.set(this, (counts.get(this) ?? 0) + 1);
      return original.call(this);
    });
  }
  return counts;
}

test("enabled createServer instances share one runtime owner", async (t) => {
  const closes = trackServerStoreCloses(t);
  const root = await mkdtemp(join(tmpdir(), "devspace-server-swarm-owner-"));
  const stateDir = join(root, ".state");
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: join(root, ".agents"),
    DEVSPACE_CHAT_SWARM: "1",
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const first = createServer(config);
  try {
    assert.throws(() => createServer(config), ChatSwarmRuntimeAlreadyOwnedError);
    assert.equal(closes.size, 3, "failed construction closes each newly owned store");
    assert.deepEqual([...closes.values()], [1, 1, 1]);
    assert.throws(() => createServer(config), ChatSwarmRuntimeAlreadyOwnedError,
      "failed construction must not release the existing server owner");
    assert.equal(closes.size, 6);
    assert.ok([...closes.values()].every(count => count === 1));
  } finally {
    await first.close();
  }
  const afterRelease = createServer(config);
  await afterRelease.close();
  assert.equal(closes.size, 12);
  assert.ok([...closes.values()].every(count => count === 1));
  await rm(root, { recursive: true, force: true });
});

test("late server initialization failure releases the Chat Swarm owner", async (t) => {
  const closes = trackServerStoreCloses(t);
  const root = await mkdtemp(join(tmpdir(), "devspace-server-swarm-owner-failure-"));
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: join(root, ".agents"),
    DEVSPACE_CHAT_SWARM: "1",
    DEVSPACE_STATE_DIR: join(root, ".state"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  assert.throws(
    () => createServer(config, { chatSwarmInitializationHook: () => { throw new Error("late init fault"); } }),
    /late init fault/,
  );
  assert.equal(closes.size, 3, "late initialization failure closes all owned stores");
  assert.deepEqual([...closes.values()], [1, 1, 1]);
  const recovered = createServer(config);
  await recovered.close();
  assert.equal(closes.size, 6);
  assert.ok([...closes.values()].every(count => count === 1));
  await rm(root, { recursive: true, force: true });
});

test("enabled server startup explicitly reconciles a previously claimed task", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-swarm-recovery-"));
  const stateDir = join(root, ".state");
  const store = new ChatSwarmStore(stateDir);
  const swarm = store.createSwarm({ ownerIdentity: "owner", inviteCredential: "invite", workerLimit: 1 });
  const worker = store.createWorker({ swarmId: swarm.id, label: "peer", runtimeKind: "mcp_peer" });
  const task = store.createTask({ swarmId: swarm.id, taskKey: "restart", prompt: "restart" }).task;
  store.claimTask(task.id, worker.id);
  store.close();
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: join(root, ".agents"),
    DEVSPACE_CHAT_SWARM: "1",
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const running = createServer(config);
  try {
    const afterRestart = new ChatSwarmStore(stateDir);
    try {
      assert.equal(afterRestart.getTask(task.id)?.lifecycleState, "RECONCILE_REQUIRED");
    } finally {
      afterRestart.close();
    }
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
  const context = await fixture(t, {
    subagents: { enabled: true, providers: [{ id: "codex", enabled: true }] },
  });
  const tools = await context.client.listTools();
  const agentTools = tools.tools.filter((tool) => tool.name.startsWith("agent_"));
  assert.equal(agentTools.length, 8);

  const startTool = agentTools.find((tool) => tool.name === "agent_start");
  const continueTool = agentTools.find((tool) => tool.name === "agent_continue");
  const statusTool = agentTools.find((tool) => tool.name === "agent_status");
  const cancelTool = agentTools.find((tool) => tool.name === "agent_cancel");
  const listTool = agentTools.find((tool) => tool.name === "agent_list");
  const preflightTool = agentTools.find((tool) => tool.name === "agent_preflight");
  const reconcileTool = agentTools.find((tool) => tool.name === "agent_reconcile");
  const catalogTool = agentTools.find((tool) => tool.name === "agent_catalog");

  assert.ok(startTool);
  assert.ok(continueTool);
  assert.ok(statusTool);
  assert.ok(cancelTool);
  assert.ok(listTool);
  assert.ok(preflightTool);
  assert.ok(reconcileTool);
  assert.ok(catalogTool);

  // Verify start annotations
  assert.equal(startTool.annotations?.readOnlyHint, false);
  assert.equal(startTool.annotations?.destructiveHint, true);
  assert.equal(startTool.annotations?.idempotentHint, false);
  assert.equal(startTool.annotations?.openWorldHint, true);

  // Open workspace to get workspaceId
  const openResult = await callOpen(context.client, context.project, "chat-1");
  const workspaceId = structuredContent(openResult).workspaceId as string;
  assert.ok(workspaceId);

  const catalogResult = await context.client.callTool({
    name: "agent_catalog",
    arguments: { workspaceId, provider: "opencode", limit: 2 },
  });
  assert.equal(catalogResult.isError, undefined);
  const catalogPayload = structuredContent(catalogResult);
  assert.ok((catalogPayload.snapshot as Record<string, unknown>).generation);
  assert.equal((catalogPayload.entitlement as Record<string, unknown>).state, "UNKNOWN");
  const opencodeSnapshot = catalogPayload.snapshot as Record<string, any>;
  assert.equal(opencodeSnapshot.runtime.source, opencodeSnapshot.source);
  assert.ok(opencodeSnapshot.freshness === "fresh" || opencodeSnapshot.freshness === "stale" || opencodeSnapshot.freshness === "unknown");
  const opencodeEntries = catalogPayload.entries as Array<Record<string, unknown>>;
  assert.ok(opencodeEntries.length > 0, "OpenCode regression requires a non-empty catalog result");
  assert.ok(opencodeEntries.every((entry) => entry.thinkingVerified === undefined), "Cline-only thinking evidence must not be added to OpenCode entries");
  const clineCatalogResult = await context.client.callTool({
    name: "agent_catalog",
    arguments: { workspaceId, provider: "cline", model: "cline-pass:openai/gpt-6-astra" },
  });
  assert.equal(clineCatalogResult.isError, undefined);
  const clineCatalogPayload = structuredContent(clineCatalogResult);
  const clineSnapshot = clineCatalogPayload.snapshot as Record<string, any>;
  assert.equal((clineCatalogPayload.entitlement as Record<string, unknown>).state, "UNKNOWN");
  assert.equal(clineSnapshot.runtime.cliProviderId, "cline");
  assert.equal(clineSnapshot.freshness, "unknown");

  // Schema Security Checks: verify no workspaceRoot or provider/profile leakage
  const startProps = startTool.inputSchema.properties as Record<string, any>;
  assert.equal(startProps.workspaceRoot, undefined);
  assert.ok(startProps.provider, "agent_start must advertise direct provider selection");
  assert.ok(startProps.model, "agent_start must advertise direct model selection");
  assert.ok(startProps.effort, "agent_start must advertise direct effort selection");
  assert.ok(!(startTool.inputSchema.required as string[] | undefined)?.includes("profile"), "profile must be optional for direct dispatch");
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

  const invalidSelector = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      provider: "codex",
      model: "gpt-test",
      prompt: "invalid selector",
    },
  });
  assert.equal(invalidSelector.isError, true);
  assert.match(responseText(invalidSelector), /either profile|both provider and model/i);

  for (const arguments_ of [
    { workspaceId, prompt: "missing selector" },
    { workspaceId, provider: "codex", prompt: "missing model" },
    { workspaceId, profile: "reviewer", effort: "high", prompt: "profile effort mismatch" },
    { workspaceId, provider: "codex", model: "", prompt: "empty model" },
  ]) {
    const rejected = await context.client.callTool({ name: "agent_start", arguments: arguments_ });
    assert.equal(rejected.isError, true);
  }

  const directPreflight = await context.client.callTool({
    name: "agent_preflight",
    arguments: {
      workspaceId,
      provider: "codex",
      model: "gpt-test",
      effort: "high",
    },
  });
  assert.equal(directPreflight.isError, undefined, responseText(directPreflight));
  assert.equal((structuredContent(directPreflight).worker as Record<string, unknown>).provider, "codex");
  assert.equal((structuredContent(directPreflight).worker as Record<string, unknown>).model, "gpt-test");
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
  const verifierRelative = process.platform === "win32" ? ".venv/bin/pytest.exe" : ".venv/bin/pytest";
  const verifierPath = join(toolchainRoot, verifierRelative);
  if (process.platform === "win32") {
    copyFileSync(process.execPath, verifierPath);
  } else {
    await writeFile(verifierPath, "#!/bin/sh\necho \"verifier-ran\"\nexit 0\n", { mode: 0o755 });
    chmodSync(verifierPath, 0o755);
  }
  const toolchains = JSON.stringify([
    { id: "nexus-python", root: toolchainRoot, verifiers: { pytest: verifierRelative } },
  ]);
  const context = await fixture(t, { git: true, subagents: true, toolchains });
  try {
    const openResult = await callOpen(context.client, context.project, "chat-verify-ok");
    const workspaceId = structuredContent(openResult).workspaceId as string;

    const result = await context.client.callTool({
      name: "workspace_verify",
      arguments: {
        workspaceId,
        toolchainId: "nexus-python",
        verifier: "pytest",
        args: process.platform === "win32" ? ["-e", "console.log('verifier-ran')"] : ["-q"],
      },
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

test("agent_start schema preserves #28 heartbeat and G9/G10 authority capabilities", async (t) => {
  const context = await fixture(t, { subagents: true });
  const tools = await context.client.listTools();
  const start = tools.tools.find((tool) => tool.name === "agent_start");
  assert.ok(start);
  const props = start.inputSchema.properties as Record<string, any>;
  const contract = props.executionContract;
  const contractProps = contract.anyOf?.find((entry: any) => entry.type === "object")?.properties
    ?? contract.properties;
  assert.ok(contractProps.authorityMode);
  assert.ok(contractProps.nexusGrant);
  assert.ok(contractProps.idleTimeoutMs);
  assert.match(contractProps.idleTimeoutMs.description, /terminated.*no provider activity/i);
});

test("direct agent selectors reject disabled providers before preflight", async (t) => {
  const context = await fixture(t, {
    subagents: { enabled: true, providers: [{ id: "codex", enabled: true }] },
  });
  const workspaceId = structuredContent(await callOpen(context.client, context.project, "direct-disabled")).workspaceId as string;
  const result = await context.client.callTool({
    name: "agent_preflight",
    arguments: { workspaceId, provider: "claude", model: "claude-test" },
  });
  assert.equal(result.isError, true);
  assert.match(responseText(result), /provider 'claude' is disabled/i);
  const start = await context.client.callTool({
    name: "agent_start",
    arguments: { workspaceId, provider: "claude", model: "claude-test", prompt: "must be rejected" },
  });
  assert.equal(start.isError, true);
  assert.match(responseText(start), /provider 'claude' is disabled/i);
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

test("OWNER_DIRECT workspace_clone works and dependency_sync denies unauthenticated MCP context", async (t) => {
  const context = await fixture(t, { git: true });
  const tools = await context.client.listTools();
  for (const name of ["workspace_clone", "dependency_sync", "operation_status", "operation_reconcile"]) {
    assert.ok(tools.tools.some((tool) => tool.name === name), `${name} must be exposed`);
  }
  assert.equal((await context.client.callTool({name:"coordination_completion_read",arguments:{goal:"g",candidate:"c",subject:"s"},_meta:{clientId:"forged"}})).isError,true);
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
  assert.equal(sync.isError, true);
  assert.match(JSON.stringify(sync), /authenticated MCP client context/);
  assert.equal(await readFile(join(destination, "package.json"), "utf8"), manifestBefore);
  assert.equal(await readFile(join(destination, "package-lock.json"), "utf8"), lockBefore);

  const status = await context.client.callTool({
    name: "operation_status",
    arguments: { operationId: cloneRecord.operationId },
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

test("C3 authenticated HTTP MCP uses host-bound worker authority for real dependency execution", async () => {
  const {realpath}=await import("node:fs/promises");
  const {createHash}=await import("node:crypto");
  const {SingleUserOAuthProvider}=await import("./oauth-provider.js");
  const {StreamableHTTPClientTransport}=await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const root=await realpath(await mkdtemp(join(tmpdir(),"devspace-c3-http-")));
  const project=join(root,"project");
  await mkdir(project);
  await git(project,["init"]);
  await git(project,["-c","user.name=Fixture","-c","user.email=fixture@example.test","commit","--allow-empty","-m","fixture"]);
  await writeFile(join(project,"package.json"),'{"name":"fixture","version":"1.0.0"}');
  await writeFile(join(project,"package-lock.json"),'{"lockfileVersion":3,"packages":{}}');
  const base=(await execFileAsync("git",["rev-parse","HEAD"],{cwd:project})).stdout.trim();
  const config=loadConfig({DEVSPACE_CONFIG_DIR:join(root,"config"),DEVSPACE_ALLOWED_ROOTS:root,DEVSPACE_STATE_DIR:join(root,"state"),DEVSPACE_WORKTREE_ROOT:join(root,"worktrees"),DEVSPACE_PUBLIC_BASE_URL:"http://127.0.0.1:1",DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-that-is-long-enough",PORT:"1"});
  const provider=new SingleUserOAuthProvider(config.oauth,new URL("/mcp",config.publicBaseUrl),config.stateDir);
  const oauthClient=await provider.clientsStore.registerClient!({redirect_uris:["http://localhost/callback"],client_name:"C3 fixture",token_endpoint_auth_method:"none"});
  let redirect="";
  await provider.authorize(oauthClient,{redirectUri:"http://localhost/callback",codeChallenge:"fixture",scopes:config.oauth.scopes,resource:new URL("/mcp",config.publicBaseUrl)}, {req:{method:"POST",body:{owner_token:config.oauth.ownerToken}},redirect:(_status:number,url:string)=>{redirect=url;}} as never);
  const tokens=await provider.exchangeAuthorizationCode(oauthClient,new URL(redirect).searchParams.get("code")!);
  const grant={repository:"owner/repo",goal:"http-fixture",coordinatorThread:"controller",evidenceHash:"external-fixture-proof"};
  let approvedHash=""; let leaseId=""; let readerClient:unknown; let successorClientId=""; let cutoverLeaseId=""; let cutoverHash=""; let lastAuthenticatedContext:unknown; let originalAuthenticatedContext:unknown; let approvedDrainId="";
  let ownership: import("./control-plane-ownership.js").ControlPlaneOwnershipStore;
  const authenticated=(c:unknown)=>!!c && (c as {clientId?:string}).clientId===oauthClient.client_id && typeof (c as {sessionId?:string}).sessionId==="string";
  const coordination:import("./control-plane-consumer.js").ControlPlaneConsumerOptions={
    approveCutoverLifecycle:(c,subject,action)=>(c as {clientId?:string})?.clientId===successorClientId && subject.requestHash===cutoverHash && action.action==="drain" && action.cutoverId===approvedDrainId && action.currentIdentity.serverInstanceId.length>0,
    readCompletionContract:(c,selection)=>{
      if(!authenticated(c)) throw new Error("unauthorized reader");
      return {...selection,source:"issue62-fixture",requiredLayers:["SOURCE","NATIVE_SINGLE"],criteria:["SOURCE","NATIVE_SINGLE"].map(layer=>({id:`AC-${layer}`,layer,sourceRevision:base,environment:"darwin",surface:"installed-mcp",independent:true,maxAgeMs:60000}))};
    },
    readCompletionEvidence:(c,selection)=>{
      if(!authenticated(c)) throw new Error("unauthorized reader");
      return [{...selection,goal:undefined,criterionId:"AC-SOURCE",layer:"SOURCE",sourceRevision:base,source:"fixture-receipt",command:"real HTTP MCP",result:"PASS",artifactSha256:"a".repeat(64),environment:"darwin",surface:"installed-mcp",verifier:"reviewer",implementer:"worker",verificationState:"INDEPENDENTLY_VERIFIED",observedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+30000).toISOString(),limitations:[],nextGate:"native witness"}];
    },
    readDependencyReconciliation:c=>{if(authenticated(c)) originalAuthenticatedContext=c;readerClient=(c as {clientId:string}).clientId;lastAuthenticatedContext=c;return undefined;},
    resolveHandoffRecipient:(c,handle)=>authenticated(c)&&handle==="other-client"?lastAuthenticatedContext:(c as {clientId?:string})?.clientId===successorClientId && handle==="original-client"?originalAuthenticatedContext:undefined,
    resolveOwnerContext:c=>authenticated(c)?{ownerThread:"delegated-cli-worker"}:successorClientId && (c as {clientId?:string})?.clientId===successorClientId ? {ownerThread:"successor"}:undefined,
    verifyGrantEvidence:g=>JSON.stringify(g)===JSON.stringify(grant),
    resolveEffectBinding:(c,subject)=>subject.operation==="cutover_start" && (c as {clientId?:string})?.clientId===successorClientId && cutoverHash && subject.requestHash===cutoverHash ? {leaseId:cutoverLeaseId,leaseVersion:ownership.get(cutoverLeaseId)!.version,requestHash:cutoverHash,role:"controller"} : authenticated(c) && subject.workspaceRoot===project && subject.baseRevision===base && subject.requestHash===approvedHash ? {leaseId,leaseVersion:ownership.get(leaseId)!.version,requestHash:approvedHash,role:"worker"}:undefined,
  };
  const running=createServer(config,{coordination});
  const manager=new DurableOperationManager(config,undefined,undefined,undefined,coordination);
  ownership=manager.store.createOwnershipStore(coordination);
  const listener=running.app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve=>listener.once("listening",resolve));
  const address=listener.address() as {port:number};
  const transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${tokens.access_token}`}}});
  const client=new Client({name:"fixture-cli-worker",version:"1"});
  try {
    await client.connect(transport);
    const opened=await callOpen(client,project,"http-fixture-conversation");
    const workspaceId=structuredContent(opened).workspaceId as string;
    assert.equal(typeof workspaceId,"string",JSON.stringify(opened));
    const input={workspaceId,attemptKey:"http-fixture",recipe:"npm_ci",authorityMode:"OWNER_DIRECT"};
    const denied=await client.callTool({name:"dependency_sync",arguments:input,_meta:{ownerThread:"controller",role:"controller"}});
    assert.equal(denied.isError,true);
    const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
    approvedHash=sha(JSON.stringify({baseRevision:base,frozenInputs:{"package-lock.json":sha(await readFile(join(project,"package-lock.json"))),"package.json":sha(await readFile(join(project,"package.json")))},recipe:"npm_ci",version:"devspace.execution.v1",workspaceId,workspaceRoot:project}));
    const trustedContext={clientId:oauthClient.client_id,sessionId:transport.sessionId};
    ownership.putGrantEvidence(trustedContext,grant,0);
    leaseId=ownership.acquire(trustedContext,{repositoryKey:grant.repository,resourceKind:"workspace",resourceId:project,resource:project,scope:[project],operation:"dependency_sync",baseRevision:base,expiresAt:new Date(Date.now()+60000).toISOString(),idempotencyKey:"http-fixture",grant}).leaseId;
    const result=await client.callTool({name:"dependency_sync",arguments:input});
    assert.equal(result.isError,undefined,JSON.stringify(result));
    assert.equal(structuredContent(result).status,"succeeded");
    assert.equal(ownership.get(leaseId)?.ownerThread,"delegated-cli-worker");
    const initialReplay=await client.callTool({name:"dependency_sync",arguments:input});
    assert.equal(initialReplay.isError,undefined);
    assert.equal(structuredContent(initialReplay).operationId,structuredContent(result).operationId);
    const unprovedReconcile=await client.callTool({name:"operation_reconcile",arguments:{operationId:structuredContent(result).operationId},_meta:{ownerThread:"controller",role:"controller"}});
    assert.equal(unprovedReconcile.isError,true);
    assert.match(JSON.stringify(unprovedReconcile),/terminal witness is unavailable/);
    assert.equal(readerClient,oauthClient.client_id);
    const otherOAuth=await provider.clientsStore.registerClient!({redirect_uris:["http://localhost/callback"],client_name:"Other client",token_endpoint_auth_method:"none"});
    await provider.authorize(otherOAuth,{redirectUri:"http://localhost/callback",codeChallenge:"fixture",scopes:config.oauth.scopes,resource:new URL("/mcp",config.publicBaseUrl)}, {req:{method:"POST",body:{owner_token:config.oauth.ownerToken}},redirect:(_status:number,url:string)=>{redirect=url;}} as never);
    const otherTokens=await provider.exchangeAuthorizationCode(otherOAuth,new URL(redirect).searchParams.get("code")!);
    const otherClient=new Client({name:"other-client",version:"1"});
    try {
      await otherClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${otherTokens.access_token}`}}}));
      const otherSync=await otherClient.callTool({name:"dependency_sync",arguments:input,_meta:{clientId:oauthClient.client_id,ownerThread:"controller"}});
      assert.equal(otherSync.isError,true);
      const otherReconcile=await otherClient.callTool({name:"operation_reconcile",arguments:{operationId:structuredContent(result).operationId},_meta:{clientId:oauthClient.client_id,ownerThread:"controller"}});
      assert.equal(otherReconcile.isError,true);
      assert.equal(readerClient,otherOAuth.client_id);
      successorClientId=otherOAuth.client_id;
      const current=ownership.get(leaseId)!;
      const handoffInput={
        resource:current.resource,baseRevision:current.baseRevision,scope:current.scope,candidateRevision:base,liveOperation:current.operation,liveHandle:current.operationHandle??"",
        checkpoint:"installed-workspace-checkpoint",grantDependency:current.grant,grantVersion:current.grantVersion,recipientGrant:current.grant,recipientGrantVersion:current.grantVersion,
        forbiddenOverlap:[project],tests:["http-witness"],evidence:["terminal-operation"],remainingGap:"next revision",nextGate:"readback",expiresAt:current.expiresAt,
      };
      const handoffArgs={leaseId,expectedVersion:current.version,recipientHandle:"other-client",receipt:handoffInput};
      const beforeHandoff=JSON.stringify(ownership.get(leaseId));
      for(const invalid of [{...handoffArgs,recipientHandle:"unknown"},{...handoffArgs,expectedVersion:current.version-1},{...handoffArgs,receipt:{...handoffInput,baseRevision:"wrong"}}]) {
        assert.equal((await client.callTool({name:"coordination_handoff",arguments:invalid})).isError,true);
        assert.equal(JSON.stringify(ownership.get(leaseId)),beforeHandoff);
      }
      assert.equal((await otherClient.callTool({name:"coordination_handoff",arguments:handoffArgs,_meta:{clientId:oauthClient.client_id,ownerThread:"delegated-cli-worker"}})).isError,true);
      assert.equal(JSON.stringify(ownership.get(leaseId)),beforeHandoff);
      const transferred=await client.callTool({name:"coordination_handoff",arguments:handoffArgs});
      assert.equal(transferred.isError,undefined,JSON.stringify(transferred));
      const handoff=structuredContent(transferred).receipt as unknown as import("./control-plane-ownership.js").HandoffReceipt;
      const readArgs={leaseId,previousVersion:handoff.previousVersion,expectedCurrentVersion:handoff.newVersion};
      const startArgs={expectedSourceCommit:"a".repeat(40),expectedBuildId:"handoff-fixture",attemptKey:"http-cutover"};
      const missingGrant=await otherClient.callTool({name:"cutover_start",arguments:startArgs});
      assert.equal(missingGrant.isError,true);
      assert.equal(new CutoverStateStore(config.stateDir).get(),undefined);
      const status=structuredContent(await otherClient.callTool({name:"cutover_status",arguments:{}})).status as {currentServerIdentity:import("./cutover-state.js").CutoverServerIdentity};
      const currentIdentity=status.currentServerIdentity;
      const expectedIdentity={sourceCommit:startArgs.expectedSourceCommit,buildId:startArgs.expectedBuildId,capabilityManifestSha256:currentIdentity.capabilityManifestSha256};
      const sorted=(v:any):any=>v&&typeof v==="object"?Object.fromEntries(Object.entries(v).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,sorted(v)])):v;
      cutoverHash=sha(JSON.stringify(sorted({version:"devspace.execution.v1",baseRevision:currentIdentity.sourceCommit,stateRoot:config.stateDir,currentIdentity,expectedIdentity})));
      const cutoverContext={clientId:successorClientId,sessionId:"fixture-recipient"};
      cutoverLeaseId=ownership.acquire(cutoverContext,{repositoryKey:grant.repository,resourceKind:"filesystem",resourceId:config.stateDir,resource:config.stateDir,operation:"cutover_start",scope:[config.stateDir],baseRevision:currentIdentity.sourceCommit,expiresAt:new Date(Date.now()+60000).toISOString(),idempotencyKey:"cutover-http",grant}).leaseId;
      const started=await otherClient.callTool({name:"cutover_start",arguments:startArgs});
      assert.equal(started.isError,undefined,JSON.stringify(started));
      const cutoverId=(structuredContent(started).cutover as {cutoverId:string}).cutoverId;
      const operationId=structuredContent(started).operationId as string;
      assert.equal(typeof operationId,"string");
      assert.equal(ownership.get(cutoverLeaseId)?.operationHandle,operationId);
      const replayStart=await otherClient.callTool({name:"cutover_start",arguments:startArgs});
      assert.equal((structuredContent(replayStart).cutover as {cutoverId:string}).cutoverId,cutoverId);
      const wrongStart=await client.callTool({name:"cutover_start",arguments:startArgs,_meta:{clientId:successorClientId,ownerThread:"successor"}});
      assert.equal(wrongStart.isError,true);
      const beforeDenied=JSON.stringify([ownership.get(cutoverLeaseId),new CutoverStateStore(config.stateDir).get()]);
      assert.equal((await otherClient.callTool({name:"cutover_start",arguments:{...startArgs,attemptKey:"new-attempt"}})).isError,true);
      assert.equal((await otherClient.callTool({name:"cutover_start",arguments:{...startArgs,expectedBuildId:"changed-target"}})).isError,true);
      assert.equal(manager.store.getByAttempt(config.stateDir,"new-attempt"),undefined);
      assert.equal(JSON.stringify([ownership.get(cutoverLeaseId),new CutoverStateStore(config.stateDir).get()]),beforeDenied);
      assert.equal((await client.callTool({name:"operation_reconcile",arguments:{operationId},_meta:{clientId:successorClientId}})).isError,true);

      const reconciledStart=await otherClient.callTool({name:"operation_reconcile",arguments:{operationId}});
      assert.equal(reconciledStart.isError,undefined,JSON.stringify(reconciledStart));
      assert.equal(structuredContent(reconciledStart).kind,"cutover_start");
      assert.equal((new CutoverStateStore(config.stateDir).get()?.coordinationBinding)?.operationHandle,operationId);

      const beforeDrain=JSON.stringify(new CutoverStateStore(config.stateDir).get());
      assert.equal((await client.callTool({name:"cutover_drain",arguments:{cutoverId},_meta:{clientId:successorClientId}})).isError,true);
      assert.equal(JSON.stringify(new CutoverStateStore(config.stateDir).get()),beforeDrain);
      assert.equal((await otherClient.callTool({name:"cutover_drain",arguments:{cutoverId}})).isError,true);
      assert.equal(JSON.stringify(new CutoverStateStore(config.stateDir).get()),beforeDrain);
      approvedDrainId=cutoverId;
      const drained=await otherClient.callTool({name:"cutover_drain",arguments:{cutoverId}});
      assert.equal(drained.isError,undefined,JSON.stringify(drained));
      const cutoverStore=new CutoverStateStore(config.stateDir);
      const beforeCutover=JSON.stringify(cutoverStore.get());
      for(const endpoint of ["start","drain","restart","advance","recover","finish"]) {
        const denied=await fetch(`http://127.0.0.1:${address.port}/api/cutover/${endpoint}`,{method:"POST",headers:{Authorization:`Bearer ${tokens.access_token}`,"Content-Type":"application/json"},body:JSON.stringify({cutoverId})});
        assert.equal(denied.status,409,endpoint);assert.match(await denied.text(),/COORDINATION_REQUIRED/);
      }
      for(const request of [{name:"cutover_recover",arguments:{cutoverId,expectedSourceCommit:"a".repeat(40),expectedBuildId:"fixture"}},{name:"cutover_repair_binding",arguments:{cutoverId,workspaceId:"ws",agentId:"agent"}}]) {
        const denied=await otherClient.callTool(request);assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/COORDINATION_REQUIRED/);
      }
      assert.equal(JSON.stringify(cutoverStore.get()),beforeCutover);

      const finishArgs={cutoverId,workspaceId:"unverified-workspace",agentId:"unverified-agent"};
      assert.equal((await otherClient.callTool({name:"cutover_finish",arguments:finishArgs})).isError,true);
      assert.equal((await client.callTool({name:"cutover_finish",arguments:finishArgs,_meta:{clientId:successorClientId}})).isError,true);
      assert.equal(JSON.stringify(cutoverStore.get()),beforeCutover);
      assert.equal(ownership.get(cutoverLeaseId)?.operationHandle,operationId);

      assert.equal((await otherClient.callTool({name:"cutover_drain",arguments:{cutoverId}})).isError,undefined);
      assert.equal(JSON.stringify(cutoverStore.get()),beforeCutover);

      const beforeRead=JSON.stringify(ownership.get(leaseId));
      const completionArgs={goal:"http-fixture",candidate:base,subject:"full-delivery"};
      const completion=await client.callTool({name:"coordination_completion_read",arguments:completionArgs});
      assert.equal(completion.isError,undefined,JSON.stringify(completion));
      const projection=structuredContent(completion).projection as any;
      assert.equal(projection.status,"INCOMPLETE");
      assert.equal(projection.layers.SOURCE.status,"PASS");
      assert.equal(projection.layers.NATIVE_SINGLE.status,"BLOCKED");
      assert.equal(projection.contractSource,"issue62-fixture");
      const spoofedCompletion=await otherClient.callTool({name:"coordination_completion_read",arguments:completionArgs,_meta:{clientId:oauthClient.client_id}});
      assert.equal((structuredContent(spoofedCompletion).projection as any).status,"BLOCKED");
      assert.equal(JSON.stringify(ownership.get(leaseId)),beforeRead);
      assert.equal(JSON.stringify(cutoverStore.get()),beforeCutover);

      const recovered=await otherClient.callTool({name:"coordination_handoff_readback",arguments:readArgs});
      assert.equal(recovered.isError,undefined,JSON.stringify(recovered));
      assert.deepEqual(structuredContent(recovered).receipt,handoff);
      assert.equal((structuredContent(recovered).currentLease as {ownerThread:string}).ownerThread,"successor");
      const repeated=await otherClient.callTool({name:"coordination_handoff_readback",arguments:readArgs});
      assert.deepEqual(structuredContent(repeated),structuredContent(recovered));
      const former=await client.callTool({name:"coordination_handoff_readback",arguments:readArgs,_meta:{clientId:successorClientId,ownerThread:"successor"}});
      assert.equal(former.isError,true);
      const stale=await otherClient.callTool({name:"coordination_handoff_readback",arguments:{...readArgs,expectedCurrentVersion:handoff.previousVersion}});
      assert.equal(stale.isError,true);
      assert.equal(JSON.stringify(ownership.get(leaseId)),beforeRead);
      assert.equal(JSON.stringify(cutoverStore.get()),beforeCutover);
      // Drain admission cannot transfer an unresolved effect, even with an exact receipt.
      const pinned=ownership.get(cutoverLeaseId)!;
      const {openDatabase}=await import("./db/client.js");
      const handoffDb=openDatabase(config.stateDir);
      const receiptSnapshot=()=>JSON.stringify(handoffDb.sqlite.prepare("select * from control_plane_handoff_receipts order by receipt_id").all());
      const receiptsBefore=receiptSnapshot();
      const pinnedReceipt={...handoffInput,resource:pinned.resource,scope:pinned.scope,baseRevision:pinned.baseRevision,liveOperation:pinned.operation,liveHandle:operationId,grantDependency:pinned.grant,grantVersion:pinned.grantVersion,recipientGrant:pinned.grant,recipientGrantVersion:pinned.grantVersion,expiresAt:pinned.expiresAt};
      const pinTransfer=await otherClient.callTool({name:"coordination_handoff",arguments:{leaseId:cutoverLeaseId,expectedVersion:pinned.version,recipientHandle:"original-client",receipt:pinnedReceipt}});
      assert.equal(pinTransfer.isError,true,JSON.stringify(pinTransfer));
      assert.deepEqual(ownership.get(cutoverLeaseId),pinned);
      assert.equal(receiptSnapshot(),receiptsBefore);
      handoffDb.sqlite.close();
      assert.equal((await otherClient.callTool({name:"cutover_drain",arguments:{cutoverId}})).isError,true);
      assert.equal(JSON.stringify(cutoverStore.get()),beforeCutover);
      assert.equal((await otherClient.callTool({name:"operation_reconcile",arguments:{operationId}})).isError,true);
      // The rejected recipient still has no cutover authority.
      assert.equal((await client.callTool({name:"operation_reconcile",arguments:{operationId}})).isError,true);
      await assert.rejects(otherClient.callTool({name:"dependency_sync",arguments:input}),/CUTOVER_RECONCILIATION_REQUIRED/);

    } finally {await otherClient.close();}

    await assert.rejects(client.callTool({name:"dependency_sync",arguments:input}),/CUTOVER_RECONCILIATION_REQUIRED/);
  } finally {
    await client.close(); await running.close(); manager.close(); provider.close();
    await new Promise<void>((resolve,reject)=>listener.close(e=>e?reject(e):resolve()));
  }
});

test("P0-2: durable reconciliation witness fails closed on empty inventory, mismatches, or missing records", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-p0-2-witness-"));
  const project = join(root, "project");
  const secondProject = join(root, "second-project");
  const stateDir = join(root, ".state");
  await mkdir(project, { recursive: true });
  await mkdir(secondProject, { recursive: true });
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });

  const wsStore = new SqliteWorkspaceStore(stateDir);
  const agentStore = new LocalAgentStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, wsStore);
  const agentManager = new LocalAgentSessionManager(config, async () => {}, async () => true);

  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-p02" });
    const oldIdentity = { serverInstanceId: "old", sourceCommit: "old", buildId: "old" };
    const expectedIdentity = { sourceCommit: "new", buildId: "new", capabilityManifestSha256: "cap" };
    const replacementIdentity = { serverInstanceId: "new", sourceCommit: "new", buildId: "new", capabilityManifestSha256: "cap" };
    store.begin({ oldServerIdentity: oldIdentity, expectedNewIdentity: expectedIdentity });

    const emptyNormalWitness = await resolveDurableReconciliationWitnessFromInventory({
      workspaceStore: wsStore,
      workspaces,
      agentSessionManager: agentManager,
    });
    assert.equal(emptyNormalWitness.workspaceQueryable, true);
    assert.equal(emptyNormalWitness.agentQueryable, true);
    assert.equal(emptyNormalWitness.agentReconciled, true);

    // 1. Zero workspaces, zero agents -> recovery MUST NOT close
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-p02",
        observedIdentity: replacementIdentity,
        witness: {
          witnessCutoverId: "cutover-p02", witnessServerInstanceId: "new", witnessExpectedIdentity: expectedIdentity,
          workspaceQueryable: true,
          agentQueryable: true,
          agentReconciled: true,
          witnessWorkspaceSessions: 0,
          witnessAgentSessions: 0,
        },
        recoveredBy: "new",
      }),
      /witness is not fully positive/i,
    );
    assert.equal(store.get()?.phase, "prepared");

    // 2. Create workspace session; zero agents in agent store -> recovery MUST NOT close
    wsStore.createSession({ id: "ws_p02", root: project });
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-p02",
        observedIdentity: replacementIdentity,
        witness: {
          witnessCutoverId: "cutover-p02", witnessServerInstanceId: "new", witnessExpectedIdentity: expectedIdentity,
          workspaceQueryable: true,
          agentQueryable: true,
          agentReconciled: true,
          witnessWorkspaceId: "ws_p02",
          witnessWorkspaceSessions: 1,
          witnessAgentSessions: 0,
        },
        recoveredBy: "new",
      }),
      /witness is not fully positive/i,
    );
    assert.equal(store.get()?.phase, "prepared");

    // 3. Create agent session belonging to ws_p02
    const agent = agentStore.create({
      workspaceId: "ws_p02",
      workspaceRoot: project,
      profileName: "p02-reviewer",
      provider: "codex",
    });

    // Failure-first regression: a valid first agent must not hide a second,
    // unbound durable record from the full reconciliation inventory.
    const unrelatedAgent = agentStore.create({
      workspaceRoot: secondProject,
      profileName: "p02-unbound",
      provider: "codex",
    });
    const inventoryWitness = await resolveDurableReconciliationWitnessFromInventory({
      workspaceStore: wsStore,
      workspaces,
      agentSessionManager: agentManager,
    });
    assert.equal(inventoryWitness.agentQueryable, false);
    assert.equal(inventoryWitness.agentReconciled, false);
    assert.ok(inventoryWitness.detail?.some((entry) => entry.detail?.includes("unbound")));

    // Explicit manual pair selection must query only the supplied pair. The
    // unrelated malformed record remains untouched and cannot poison this
    // exact-pair witness, while automatic inventory remains fail-closed above.
    const unrelatedBefore = agentStore.getById(unrelatedAgent.id);
    const exactPairWitness = await resolveDurableReconciliationWitnessFromInventory(
      { workspaceStore: wsStore, workspaces, agentSessionManager: agentManager },
      { workspaceId: "ws_p02", agentId: agent.id },
      true,
    );
    assert.equal(exactPairWitness.workspaceQueryable, true);
    assert.equal(exactPairWitness.agentQueryable, true);
    assert.equal(exactPairWitness.agentReconciled, true);
    assert.equal(exactPairWitness.witnessWorkspaceSessions, 1);
    assert.equal(exactPairWitness.witnessAgentSessions, 1);
    assert.equal(exactPairWitness.witnessKind, "exact-pair");
    assert.ok(!exactPairWitness.detail?.some((entry) => entry.unit.includes(unrelatedAgent.id)));
    assert.deepEqual(agentStore.getById(unrelatedAgent.id), unrelatedBefore);

    // Mismatched pair -> fails closed
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-p02",
        observedIdentity: replacementIdentity,
        witness: {
          witnessCutoverId: "cutover-p02", witnessServerInstanceId: "new", witnessExpectedIdentity: expectedIdentity,
          workspaceQueryable: true,
          agentQueryable: false,
          agentReconciled: false,
          witnessWorkspaceId: "ws_other",
          witnessAgentId: agent.id,
          witnessWorkspaceSessions: 1,
          witnessAgentSessions: 1,
        },
        recoveredBy: "new",
      }),
      /witness is not fully positive/i,
    );
    assert.equal(store.get()?.phase, "prepared");

    // Stale/missing agent record -> fails closed
    assert.throws(
      () => store.recoverObservedReplacement({
        cutoverId: "cutover-p02",
        observedIdentity: replacementIdentity,
        witness: {
          witnessCutoverId: "cutover-p02", witnessServerInstanceId: "new", witnessExpectedIdentity: expectedIdentity,
          workspaceQueryable: true,
          agentQueryable: false,
          agentReconciled: false,
          witnessWorkspaceId: "ws_p02",
          witnessAgentId: "agent-missing",
          witnessWorkspaceSessions: 1,
          witnessAgentSessions: 1,
        },
        recoveredBy: "new",
      }),
      /witness is not fully positive/i,
    );
    assert.equal(store.get()?.phase, "prepared");

    // One valid exact pair -> eligible and succeeds
    const recovered = store.recoverObservedReplacement({
      cutoverId: "cutover-p02",
      expectedNewIdentity: expectedIdentity,
      observedIdentity: replacementIdentity,
      witness: {
        ...exactPairWitness,
          witnessCutoverId: "cutover-p02", witnessServerInstanceId: "new", witnessExpectedIdentity: expectedIdentity,
      },
      recoveredBy: "new",
    });
    assert.equal(recovered.newlyRecovered, true);
    assert.equal(recovered.record.phase, "closed");
    assert.equal(recovered.record.observedReplacement?.witnessWorkspaceId, "ws_p02");
    assert.equal(recovered.record.observedReplacement?.witnessAgentId, agent.id);
    assert.equal(recovered.record.observedReplacement?.witnessWorkspaceSessions, 1);
    assert.equal(recovered.record.observedReplacement?.witnessAgentSessions, 1);
  } finally {
    agentManager.close();
    agentStore.close();
    wsStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("manual exact-pair witness bypasses aggregate enumeration and accepts reconciled error state", async () => {
  let aggregateWorkspaceCalled = false;
  let aggregateAgentCalled = false;
  let reconcileMode: "ok" | "fail" = "ok";
  const dependencies = {
    workspaceStore: {
      getSession: (id: string) => id === "ws-exact" ? ({ id, root: "/tmp/exact", status: "active", mode: "checkout" } as any) : undefined,
      listSessions: () => { aggregateWorkspaceCalled = true; throw new Error("aggregate workspace enumeration must not run"); },
    },
    workspaces: {
      inspectWorkspace: () => ({ loaded: true }),
      getWorkspace: () => ({ id: "ws-exact", root: "/tmp/exact", mode: "checkout" }),
    },
    agentSessionManager: {
      getRecordByPrefixOrId: (id: string) => id === "agt-exact" ? ({ id, workspaceId: "ws-exact", workspaceRoot: "/tmp/exact", status: "error" } as any) : undefined,
      listAllAgentRecords: () => { aggregateAgentCalled = true; throw new Error("aggregate agent enumeration must not run"); },
      getAgentStatus: async () => ({ agentId: "agt-exact", workspaceId: "ws-exact", workspaceRoot: "/tmp/exact", status: "error" } as any),
      reconcileAgent: async () => {
        if (reconcileMode === "fail") throw new Error("reconcile failed");
        return { agentId: "agt-exact" } as any;
      },
    },
  };

  const exact = await resolveDurableReconciliationWitnessFromInventory(
    dependencies as any,
    { workspaceId: "ws-exact", agentId: "agt-exact" },
    true,
  );
  assert.equal(exact.workspaceQueryable, true);
  assert.equal(exact.agentQueryable, true);
  assert.equal(exact.agentReconciled, true);
  assert.equal(exact.witnessWorkspaceSessions, 1);
  assert.equal(exact.witnessAgentSessions, 1);
  assert.equal(aggregateWorkspaceCalled, false);
  assert.equal(aggregateAgentCalled, false);

  const missingRoot = await resolveDurableReconciliationWitnessFromInventory(
    dependencies as any,
    { workspaceId: "ws-missing", agentId: "agt-exact" },
    true,
  );
  assert.equal(missingRoot.workspaceQueryable, false);

  const wrongAssociation = await resolveDurableReconciliationWitnessFromInventory(
    dependencies as any,
    { workspaceId: "ws-exact", agentId: "agt-missing" },
    true,
  );
  assert.equal(wrongAssociation.agentQueryable, false);

  reconcileMode = "fail";
  const failedReconcile = await resolveDurableReconciliationWitnessFromInventory(
    dependencies as any,
    { workspaceId: "ws-exact", agentId: "agt-exact" },
    true,
  );
  assert.equal(failedReconcile.agentReconciled, false);
});

test("P0-3: recovery and finish share identical semantics and idempotently rendezvous without second effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-p0-3-shared-"));
  const targetCommit = "a".repeat(40);

  // Scenario 1: recover first -> finish replay
  {
    const root1 = join(root, "scenario-1");
    const project1 = join(root1, "project");
    const stateDir1 = join(root1, ".state");
    await mkdir(project1, { recursive: true });
    const config1 = loadConfig({
      DEVSPACE_CONFIG_DIR: join(root1, ".config"),
      DEVSPACE_ALLOWED_ROOTS: root1,
      DEVSPACE_STATE_DIR: stateDir1,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });

    const seedWs1 = new SqliteWorkspaceStore(stateDir1);
    const seedAgent1 = new LocalAgentStore(stateDir1);
    seedWs1.createSession({ id: "ws_shared", root: project1 });
    const seededAgent1 = seedAgent1.create({
      workspaceId: "ws_shared",
      workspaceRoot: project1,
      profileName: "shared-worker",
      provider: "codex",
    });
    seedAgent1.close();
    seedWs1.close();

    const store1 = new CutoverStateStore(stateDir1, { newId: () => "cutover-r-then-f" });
    const old = new McpCutoverController(store1, { serverInstanceId: "old-server", sourceCommit: "old", buildId: "old" });
    old.begin({ sourceCommit: targetCommit, buildId: "target-build", capabilityManifestSha256: "a".repeat(64) });

    const replacement = new McpCutoverController(store1, { serverInstanceId: "new-server", sourceCommit: targetCommit, buildId: "target-build", capabilityManifestSha256: "a".repeat(64) });
    const wsStore = new SqliteWorkspaceStore(stateDir1);
    const agentStore = new LocalAgentStore(stateDir1);
    const workspaces = new WorkspaceRegistry(config1, wsStore);
    const agentManager = new LocalAgentSessionManager(config1, async () => {}, async () => true);

    const server = createMcpServer(
      config1,
      workspaces,
      createReviewCheckpointManager(),
      new ProcessSessionManager(),
      () => [],
      [],
      agentManager,
      undefined,
      undefined,
      undefined,
      {
        controller: replacement,
        transportEvidence: () => ({ activeSessions: 0, oldestAgeMs: 0 }),
        reconcileDurableState: async ({ workspaceId, agentId }) => ({
          workspaceQueryable: true,
          agentQueryable: true,
          agentReconciled: true,
          witnessWorkspaceId: workspaceId,
          witnessAgentId: agentId,
          witnessWorkspaceSessions: 1,
          witnessAgentSessions: 1,
          witnessKind: "exact-pair",
        }),
        executeObservedReplacementRecovery: async (input) => {
          const active = replacement.record()!;
          if (active.phase === "closed") {
            return { terminal: active, newlyRecovered: false, mode: replacement.mode() };
          }
          const rec = replacement.recoverCutover({
            cutoverId: input.cutoverId,
            expectedNewIdentity: input.expectedNewIdentity ?? active.expectedNewIdentity,
            witness: {
              witnessCutoverId: active.cutoverId, witnessServerInstanceId: replacement.currentIdentity.serverInstanceId, witnessExpectedIdentity: active.expectedNewIdentity,
              workspaceQueryable: true,
              agentQueryable: true,
              agentReconciled: true,
              witnessWorkspaceId: "ws_shared",
              witnessAgentId: seededAgent1.id,
              witnessWorkspaceSessions: 1,
              witnessAgentSessions: 1,
              witnessKind: "exact-pair",
            },
          });
          return { terminal: rec.terminal, newlyRecovered: rec.newlyRecovered, mode: replacement.mode() };
        },
      },
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client-rf", version: "1.0.0" });
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      // 1. First call: cutover_recover
      const recoverResult = structuredContent(await client.callTool({
        name: "cutover_recover",
        arguments: {
          cutoverId: "cutover-r-then-f",
          expectedSourceCommit: targetCommit,
          expectedBuildId: "target-build",
          expectedCapabilityManifestSha256: "a".repeat(64),
        },
      }));
      assert.equal(recoverResult.newlyRecovered, true);
      assert.equal((recoverResult.terminal as Record<string, unknown>).phase, "closed");
      assert.equal(replacement.mode(), "normal");

      // 2. Second call: cutover_finish replay on the already-closed cutover
      const finishReplay = structuredContent(await client.callTool({
        name: "cutover_finish",
        arguments: {
          cutoverId: "cutover-r-then-f",
          workspaceId: "ws_shared",
          agentId: seededAgent1.id,
        },
      }));
      assert.equal((finishReplay.cutover as Record<string, unknown>).phase, "closed");
      assert.equal(
        (finishReplay.cutover as Record<string, unknown>).cutoverId,
        (recoverResult.terminal as Record<string, unknown>).cutoverId,
      );
      assert.equal(replacement.mode(), "normal");
    } finally {
      await client.close();
      await server.close();
      agentManager.close();
      agentStore.close();
      wsStore.close();
    }
  }

  // Scenario 2: finish first -> recover replay
  {
    const root2 = join(root, "scenario-2");
    const project2 = join(root2, "project");
    const stateDir2 = join(root2, ".state");
    await mkdir(project2, { recursive: true });
    const config2 = loadConfig({
      DEVSPACE_CONFIG_DIR: join(root2, ".config"),
      DEVSPACE_ALLOWED_ROOTS: root2,
      DEVSPACE_STATE_DIR: stateDir2,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });

    const seedWs2 = new SqliteWorkspaceStore(stateDir2);
    const seedAgent2 = new LocalAgentStore(stateDir2);
    seedWs2.createSession({ id: "ws_shared", root: project2 });
    const seededAgent2 = seedAgent2.create({
      workspaceId: "ws_shared",
      workspaceRoot: project2,
      profileName: "shared-worker",
      provider: "codex",
    });
    seedAgent2.close();
    seedWs2.close();

    const store2 = new CutoverStateStore(stateDir2, { newId: () => "cutover-f-then-r" });
    const old = new McpCutoverController(store2, { serverInstanceId: "old-server-2", sourceCommit: "old", buildId: "old" });
    old.begin({ sourceCommit: targetCommit, buildId: "target-build", capabilityManifestSha256: "a".repeat(64) });

    const replacement = new McpCutoverController(store2, { serverInstanceId: "new-server-2", sourceCommit: targetCommit, buildId: "target-build", capabilityManifestSha256: "a".repeat(64) });
    const wsStore = new SqliteWorkspaceStore(stateDir2);
    const agentStore = new LocalAgentStore(stateDir2);
    const workspaces = new WorkspaceRegistry(config2, wsStore);
    const agentManager = new LocalAgentSessionManager(config2, async () => {}, async () => true);

    const server = createMcpServer(
      config2,
      workspaces,
      createReviewCheckpointManager(),
      new ProcessSessionManager(),
      () => [],
      [],
      agentManager,
      undefined,
      undefined,
      undefined,
      {
        controller: replacement,
        transportEvidence: () => ({ activeSessions: 0, oldestAgeMs: 0 }),
        reconcileDurableState: async ({ workspaceId, agentId }) => ({
          workspaceQueryable: true,
          agentQueryable: true,
          agentReconciled: true,
          witnessWorkspaceId: workspaceId,
          witnessAgentId: agentId,
          witnessWorkspaceSessions: 1,
          witnessAgentSessions: 1,
          witnessKind: "exact-pair",
        }),
        executeObservedReplacementRecovery: async (input) => {
          const active = replacement.record()!;
          if (active.phase === "closed") {
            return { terminal: active, newlyRecovered: false, mode: replacement.mode() };
          }
          const rec = replacement.recoverCutover({
            cutoverId: input.cutoverId,
            expectedNewIdentity: input.expectedNewIdentity ?? active.expectedNewIdentity,
            witness: {
              witnessCutoverId: active.cutoverId, witnessServerInstanceId: replacement.currentIdentity.serverInstanceId, witnessExpectedIdentity: active.expectedNewIdentity,
              workspaceQueryable: true,
              agentQueryable: true,
              agentReconciled: true,
              witnessWorkspaceId: "ws_shared",
              witnessAgentId: seededAgent2.id,
              witnessWorkspaceSessions: 1,
              witnessAgentSessions: 1,
              witnessKind: "exact-pair",
            },
          });
          return { terminal: rec.terminal, newlyRecovered: rec.newlyRecovered, mode: replacement.mode() };
        },
      },
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client-fr", version: "1.0.0" });
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      // 1. First call: cutover_finish
      const finishResult = structuredContent(await client.callTool({
        name: "cutover_finish",
        arguments: {
          cutoverId: "cutover-f-then-r",
          workspaceId: "ws_shared",
          agentId: seededAgent2.id,
        },
      }));
      assert.equal((finishResult.cutover as Record<string, unknown>).phase, "closed");
      assert.equal(replacement.mode(), "normal");

      // 2. Second call: cutover_recover replay
      const recoverReplay = structuredContent(await client.callTool({
        name: "cutover_recover",
        arguments: {
          cutoverId: "cutover-f-then-r",
          expectedSourceCommit: targetCommit,
          expectedBuildId: "target-build",
          expectedCapabilityManifestSha256: "a".repeat(64),
        },
      }));
      assert.equal(recoverReplay.newlyRecovered, false);
      assert.equal((recoverReplay.terminal as Record<string, unknown>).phase, "closed");
      assert.equal(
        (recoverReplay.terminal as Record<string, unknown>).cutoverId,
        (finishResult.cutover as Record<string, unknown>).cutoverId,
      );
      assert.equal(replacement.mode(), "normal");
    } finally {
      await client.close();
      await server.close();
      agentManager.close();
      agentStore.close();
      wsStore.close();
    }
  }

  await rm(root, { recursive: true, force: true });
});

test("P0-4: real server /mcp HTTP boundary permits transport reconnect during drain, allows safe tools, blocks consequential tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-p0-4-http-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  await mkdir(project, { recursive: true });

  // Get dynamic free port
  const port = await new Promise<number>((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close((err) => (err ? reject(err) : resolve(p)));
    });
  });

  const ownerToken = "test-owner-token-that-is-long-enough";
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
    DEVSPACE_PUBLIC_BASE_URL: baseUrl,
    PORT: String(port),
  });

  // Seed valid OAuth access token for HTTP bearerAuth
  const testAccessToken = "valid-test-bearer-access-token";
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  const oauthStore = new SqliteOAuthStore(stateDir);
  const clientsStore = new SqliteOAuthClientsStore(oauthStore, ["127.0.0.1", "localhost"]);
  const clientRecord = clientsStore.registerClient({
    redirect_uris: [`http://127.0.0.1:${port}/callback`],
    client_name: "chatgpt-client",
  });
  oauthStore.saveTokenPair({
    accessTokenHash: createHash("sha256").update(testAccessToken).digest("base64url"),
    accessToken: {
      clientId: clientRecord.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl,
    },
    refreshTokenHash: createHash("sha256").update("dummy-refresh-hash").digest("base64url"),
    refreshToken: {
      clientId: clientRecord.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl,
    },
  });
  oauthStore.close();

  const running = createServer(config);
  const httpServer = running.app.listen(port);

  try {
    // 1. Client 1 initializes MCP session
    const init1Res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${testAccessToken}`,
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "chatgpt-connector-1", version: "1.0.0" },
        },
      }),
    });
    assert.equal(init1Res.status, 200);
    const session1Id = init1Res.headers.get("mcp-session-id");
    assert.ok(session1Id, "Session 1 id header present");

    // 2. Client 1 starts cutover -> enters drain
    const startRes = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${testAccessToken}`,
        "mcp-session-id": session1Id,
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "cutover_start",
          arguments: {
            expectedSourceCommit: "a".repeat(40),
            expectedBuildId: "build-p04",
          },
        },
      }),
    });
    assert.equal(startRes.status, 200);
    const startText=await startRes.text();
    const startData=startText.split("\n").find(line=>line.startsWith("data: "));
    assert.equal(JSON.parse(startData?startData.slice(6):startText).result.isError,true);
    assert.equal(new CutoverStateStore(stateDir).get(),undefined);
    // Arrange drain through the trusted fixture API; this test covers reconnect.
    const runtime=await (await fetch(`http://127.0.0.1:${port}/identity`)).json() as any;
    new CutoverStateStore(stateDir).begin({oldServerIdentity:{serverInstanceId:runtime.serverInstanceId,sourceCommit:runtime.sourceCommit,buildId:runtime.buildId,capabilityManifestSha256:runtime.capabilityManifest.manifestSha256},expectedNewIdentity:{sourceCommit:"a".repeat(40),buildId:"build-p04"}});


    // 3. Client 2 (reconnecting ChatGPT connector after drop, starting new session during drain)
    const init2Res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${testAccessToken}`,
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "chatgpt-connector-reconnected", version: "1.0.0" },
        },
      }),
    });
    // Transport initialization itself MUST SUCCEED (reversing 2026-09-09 deadlock!)
    assert.equal(init2Res.status, 200, "Transport initialization during drain must succeed");
    const session2Id = init2Res.headers.get("mcp-session-id");
    assert.ok(session2Id, "Session 2 id header present");

    const parseMcpResponse = async (res: globalThis.Response) => {
      const text = await res.text();
      const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) {
        return JSON.parse(dataLine.slice(6));
      }
      return JSON.parse(text);
    };

    // 4. Client 2 calls safe control tool (cutover_status) -> SUCCEEDS
    const statusRes = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${testAccessToken}`,
        "mcp-session-id": session2Id,
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "cutover_status",
          arguments: {},
        },
      }),
    });
    assert.equal(statusRes.status, 200, "Safe control tool must succeed during drain");
    const statusJson = (await parseMcpResponse(statusRes)) as { result?: { structuredContent?: { status?: { mode?: string; cutover?: { cutoverId?: string } } } } };
    assert.equal(statusJson.result?.structuredContent?.status?.mode, "drain");
    const activeCutoverId = statusJson.result?.structuredContent?.status?.cutover?.cutoverId;
    assert.ok(activeCutoverId);

    // A reconnecting client must reach the real drain handler, not merely read
    // status; this is the durable transition that makes restart coordination
    // possible while transport remains available.
    const drainRes = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${testAccessToken}`,
        "mcp-session-id": session2Id,
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 111,
        method: "tools/call",
        params: {
          name: "cutover_drain",
          arguments: { cutoverId: activeCutoverId },
        },
      }),
    });
    assert.equal(drainRes.status, 200, "Reconnected transport must reach cutover_drain");
    const drainJson = (await parseMcpResponse(drainRes)) as { result?: { structuredContent?: { cutover?: { phase?: string } } } };
    assert.equal(drainJson.result?.structuredContent?.cutover?.phase, "drained");

    // 5. Client 2 calls consequential mutation tool (open_workspace) -> BLOCKED with 409
    const openRes = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${testAccessToken}`,
        "mcp-session-id": session2Id,
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "open_workspace",
          arguments: { path: project },
        },
      }),
    });
    assert.equal(openRes.status, 409, "Consequential tool must be blocked with 409 during drain");
    const openJson = (await parseMcpResponse(openRes)) as { error?: { code?: number; message?: string } };
    assert.equal(openJson.error?.code, -32002);
    assert.ok(openJson.error?.message?.includes("CUTOVER_RECONCILIATION_REQUIRED"));
  } finally {
    await new Promise<void>((res) => httpServer.close(() => res()));
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("prepared finish rejects each wrong replacement identity without durable mutation", async () => {
  const mismatches = [
    { label: "source", sourceCommit: "e".repeat(40), buildId: "target-build", capabilityManifestSha256: "a".repeat(64) },
    { label: "build", sourceCommit: "b".repeat(40), buildId: "wrong-build", capabilityManifestSha256: "a".repeat(64) },
    { label: "capability", sourceCommit: "b".repeat(40), buildId: "target-build", capabilityManifestSha256: "c".repeat(64) },
  ];
  const failures: string[] = [];
  const snapshotTree = (root: string): Record<string, string> => {
    const snapshot: Record<string, string> = {};
    const visit = (current: string, relative = "") => {
      if (!existsSync(current)) return;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const child = join(current, entry.name);
        const childRelative = relative ? join(relative, entry.name) : entry.name;
        if (entry.isDirectory()) visit(child, childRelative);
        else snapshot[childRelative] = readFileSync(child).toString("base64");
      }
    };
    visit(root);
    return snapshot;
  };

  for (const mismatch of mismatches) {
    const root = await mkdtemp(join(tmpdir(), `devspace-prepared-finish-${mismatch.label}-`));
    const stateDir = join(root, ".state");
    const config = loadConfig({ DEVSPACE_CONFIG_DIR: join(root, ".config"), DEVSPACE_ALLOWED_ROOTS: root,
      DEVSPACE_STATE_DIR: stateDir, DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough", PORT: "1" });
    const wsStore = new SqliteWorkspaceStore(stateDir);
    const workspaces = new WorkspaceRegistry(config, wsStore);
    let sequence = 0;
    const store = new CutoverStateStore(stateDir, { newId: () => `prepared-finish-${mismatch.label}-${++sequence}` });
    const old = new McpCutoverController(store, { serverInstanceId: "old-server", sourceCommit: "d".repeat(40), buildId: "old", capabilityManifestSha256: "d".repeat(64) });
    const targetIdentity = { sourceCommit: "b".repeat(40), buildId: "target-build", capabilityManifestSha256: "a".repeat(64) };
    const initial = old.begin(targetIdentity);
    const replacement = new McpCutoverController(store, { serverInstanceId: "replacement-server", ...mismatch });
    let executorInvoked = false;
    const server = createMcpServer(config, workspaces, createReviewCheckpointManager(), new ProcessSessionManager(),
      () => [], [], undefined, undefined, undefined, undefined, {
        controller: replacement,
        transportEvidence: () => ({ activeSessions: 0, oldestAgeMs: 0 }),
        reconcileDurableState: async ({ workspaceId, agentId }) => ({
          workspaceQueryable: true, agentQueryable: true, agentReconciled: true,
          witnessWorkspaceId: workspaceId, witnessAgentId: agentId,
          witnessWorkspaceSessions: 1, witnessAgentSessions: 1, witnessKind: "exact-pair",
        }),
        executeObservedReplacementRecovery: async (input) => {
          executorInvoked = true;
          const recovered = replacement.recoverCutover({
            cutoverId: input.cutoverId,
            expectedNewIdentity: input.expectedNewIdentity ?? targetIdentity,
            witness: { witnessCutoverId: initial.cutoverId, witnessServerInstanceId: replacement.currentIdentity.serverInstanceId,
              witnessExpectedIdentity: targetIdentity, workspaceQueryable: true, agentQueryable: true, agentReconciled: true,
              witnessWorkspaceId: "ws_shared", witnessAgentId: "agent_shared", witnessWorkspaceSessions: 1,
              witnessAgentSessions: 1, witnessKind: "exact-pair" },
          });
          return { ...recovered, mode: replacement.mode() };
        },
      });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `prepared-finish-${mismatch.label}`, version: "1.0.0" });
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const before = snapshotTree(join(stateDir, "cutover"));
      const result = await client.callTool({ name: "cutover_finish", arguments: {
        cutoverId: initial.cutoverId, workspaceId: "ws_shared", agentId: "agent_shared",
      } });
      assert.equal(result.isError, true, `${mismatch.label} mismatch must be denied`);
      assert.match(JSON.stringify(result.content), /RECOVERY_BINDING_MISMATCH|replacement identity/i);
      assert.equal(executorInvoked, false, `${mismatch.label} mismatch must not invoke recovery`);
      assert.deepEqual(snapshotTree(join(stateDir, "cutover")), before);
      assert.equal(store.get()?.phase, "prepared");
      assert.equal(readdirSync(join(stateDir, "cutover", "active")).some((name) => name.includes("recovery-intent")), false);
    } catch (error) {
      failures.push(`${mismatch.label}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client.close(); await server.close(); wsStore.close();
      await rm(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("prepared stale-target MCP recovery preserves successor and supersession summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-stale-recovery-"));
  const stateDir = join(root, ".state");
  const config = loadConfig({ DEVSPACE_CONFIG_DIR: join(root, ".config"), DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir, DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough", PORT: "1" });
  const wsStore = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, wsStore);
  let sequence = 0;
  const store = new CutoverStateStore(stateDir, { newId: () => `stale-${++sequence}` });
  const initial = store.begin({ oldServerIdentity: { serverInstanceId: "gone", sourceCommit: "old", buildId: "old" },
    expectedNewIdentity: { sourceCommit: "b".repeat(40), buildId: "stale-build" } });
  const controller = new McpCutoverController(store, { serverInstanceId: "current", sourceCommit: "current", buildId: "current" });
  const server = createMcpServer(config, workspaces, createReviewCheckpointManager(), new ProcessSessionManager(),
    () => [], [], undefined, undefined, undefined, undefined, {
      controller, transportEvidence: () => ({ activeSessions: 0, oldestAgeMs: 0 }),
      reconcileDurableState: async () => ({ workspaceQueryable: true, agentQueryable: true, agentReconciled: true }),
      executeObservedReplacementRecovery: async (input) => {
        const result = controller.recoverCutover({ cutoverId: input.cutoverId, expectedNewIdentity: input.expectedNewIdentity! });
        return { ...result, mode: controller.mode() };
      },
    });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "stale-recovery", version: "1.0.0" });
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const result = await client.callTool({ name: "cutover_recover", arguments: {
      cutoverId: initial.cutoverId, expectedSourceCommit: "a".repeat(40), expectedBuildId: "fresh-build",
    } });
    const content = structuredContent(result);
    assert.equal((content.terminal as Record<string, unknown>).phase, "superseded");
    assert.equal((content.successor as Record<string, unknown>)?.cutoverId, store.get()?.cutoverId);
    assert.notEqual(store.get()?.cutoverId, initial.cutoverId);
    assert.match(JSON.stringify(result.content), /Superseded stale cutover/);
    assert.doesNotMatch(JSON.stringify(result.content), /Recovered observed replacement/);
  } finally {
    await client.close(); await server.close(); wsStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("C3 bound cutover rejects unfenced automatic advance before its callback",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devspace-bound-advance-"));
  const config=loadConfig({DEVSPACE_CONFIG_DIR:join(root,"config"),DEVSPACE_ALLOWED_ROOTS:root,DEVSPACE_STATE_DIR:join(root,"state"),DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-that-is-long-enough",PORT:"1"});
  const store=new SqliteWorkspaceStore(config.stateDir);const workspaces=new WorkspaceRegistry(config,store);
  const cutoverStore=new CutoverStateStore(config.stateDir);
  const controller=new McpCutoverController(cutoverStore,{serverInstanceId:"old",sourceCommit:"old",buildId:"old"});
  controller.begin({sourceCommit:"target",buildId:"target"},undefined,{leaseId:"lease",pinnedLeaseVersion:1,operationHandle:"operation",requestHash:"a".repeat(64),ownerThread:"owner"});
  let advances=0;
  const server=createMcpServer(config,workspaces,createReviewCheckpointManager(),new ProcessSessionManager(),()=>[],[],undefined,undefined,undefined,undefined,{controller,transportEvidence:()=>({activeSessions:0,oldestAgeMs:0}),reconcileDurableState:async()=>({workspaceQueryable:false,agentQueryable:false,agentReconciled:false}),advance:async()=>{advances++;return {outcome:"restart_already_scheduled",reason:"fixture",scheduledFor:"fixture"};}});
  const [ct,st]=InMemoryTransport.createLinkedPair();const client=new Client({name:"bound-advance-test",version:"1"});
  try {
    await Promise.all([client.connect(ct),server.connect(st)]);const before=JSON.stringify(cutoverStore.get());
    const result=await client.callTool({name:"cutover_reconcile",arguments:{}});
    assert.equal(result.isError,true);assert.equal(advances,0);assert.equal(JSON.stringify(cutoverStore.get()),before);
  } finally {await client.close();await server.close();store.close();}
});
