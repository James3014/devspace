import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import test, { after, type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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
import {
  createMcpServer,
  createServer,
  permitsCoreCallerRebindGate,
  resolveDurableReconciliationWitnessFromInventory,
} from "./server.js";
import { CUTOVER_ACTIVATION_BINDING_SCHEMA, CutoverStateStore } from "./cutover-state.js";
import { CONSEQUENTIAL_MCP_TOOLS, CUTOVER_SAFE_TOOLS, McpCutoverController } from "./mcp-cutover.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { LocalAgentSessionManager } from "./local-agent-sessions.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { ChatSwarmLifecycle } from "./chat-swarm-lifecycle.js";
import { ChatSwarmRuntimeAlreadyOwnedError } from "./chat-swarm-runtime-owner.js";
import { ChatSwarmStore } from "./chat-swarm-store.js";
import { chatSwarmToolInputShapes } from "./chat-swarm-tools.js";
import type { ControlPlaneInventory } from "./control-plane-convergence.js";
import { mcpToolCatalogGeneration } from "./capability-manifest.js";

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

test("health and identity expose aggregate MCP session lifecycle metrics", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-session-metrics-http-"));
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: join(root, ".state"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:0",
    DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_MS: "1234",
    DEVSPACE_MCP_SESSION_MAX_SESSIONS: "2",
    PORT: "1",
  });
  const running = createServer(config);
  const listener = running.app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("listening", () => resolve());
      listener.once("error", reject);
    });
    const requiredMetrics = [
      "activeSessions",
      "oldestAgeMs",
      "highWaterActiveSessions",
      "registrations",
      "reusedRequests",
      "idleCloses",
      "capacityEvictions",
      "capacityRejections",
      "closeErrors",
      "disposalCallbackErrors",
      "inFlightRequestCount",
      "sessionsWithInFlight",
      "sessionsPendingClose",
      "configuredMaxSessions",
      "configuredIdleTimeoutMs",
    ];
    for (const path of ["healthz", "identity"]) {
      const body = await (await fetch(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/${path}`)).json() as Record<string, any>;
      const mcp = body.mcp as Record<string, unknown>;
      for (const metric of requiredMetrics) assert.equal(metric in mcp, true, `${path} missing ${metric}`);
      assert.equal(mcp.activeSessions, 0);
      assert.equal(mcp.highWaterActiveSessions, 0);
      assert.equal(mcp.disposalCallbackErrors, 0);
      assert.equal(mcp.configuredMaxSessions, 2);
      assert.equal(mcp.configuredIdleTimeoutMs, 1234);
      assert.equal("sessionId" in mcp, false);
      assert.equal(JSON.stringify(mcp).includes("test-owner-token"), false);
    }
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("initialize rejects explicitly when every resident MCP session is in flight", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-session-capacity-http-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  await mkdir(project, { recursive: true });
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: project });
  await writeFile(join(project, "README.md"), "capacity test\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: project });
  await execFileAsync("git", ["-c", "user.name=DevSpace Test", "-c", "user.email=devspace-test@example.com", "commit", "-m", "fixture"], { cwd: project });
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as AddressInfo;
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
    probe.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const mcpUrl = `${baseUrl}/mcp`;
  const accessToken = "session-capacity-access-token";
  const oauthStore = new SqliteOAuthStore(stateDir);
  const clientsStore = new SqliteOAuthClientsStore(oauthStore, ["127.0.0.1", "localhost"]);
  const clientRecord = clientsStore.registerClient({
    redirect_uris: [`${baseUrl}/callback`],
    client_name: "session-capacity-client",
  });
  oauthStore.saveTokenPair({
    accessTokenHash: createHash("sha256").update(accessToken).digest("base64url"),
    accessToken: {
      clientId: clientRecord.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl,
    },
    refreshTokenHash: createHash("sha256").update("session-capacity-refresh").digest("base64url"),
    refreshToken: {
      clientId: clientRecord.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl,
    },
  });
  oauthStore.close();
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: baseUrl,
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_MCP_SESSION_MAX_SESSIONS: "1",
    DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_MS: "600000",
    PORT: String(port),
  });
  const running = createServer(config);
  const httpServer = running.app.listen(port, "127.0.0.1");
  const post = (sessionId: string | undefined, body: unknown) => fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const parseMcpResponse = async (response: globalThis.Response): Promise<Record<string, any>> => {
    const text = await response.text();
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(dataLine ? dataLine.slice(6) : text) as Record<string, any>;
  };
  try {
    await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
    const initialized = await post(undefined, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "session-capacity-client", version: "1.0.0" },
      },
    });
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers.get("mcp-session-id");
    assert.ok(sessionId);

    const opened = await post(sessionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        _meta: { "openai/session": "session-capacity-test" },
        name: "open_workspace",
        arguments: { path: project, mode: "worktree" },
      },
    });
    assert.equal(opened.status, 200);
    const openedPayload = await parseMcpResponse(opened);
    const workspaceId = openedPayload.result?.structuredContent?.workspaceId as string | undefined;
    assert.ok(workspaceId);

    const listed = await post(sessionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {},
    });
    assert.equal(listed.status, 200);

    const slowRequest = post(sessionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        _meta: { "openai/session": "session-capacity-test" },
        name: "exec_command",
        arguments: {
          workspaceId,
          cmd: "tail -f README.md",
          attemptKey: "session-capacity:slow",
          yieldTimeMs: 1000,
        },
      },
    });
    let saturated = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const identity = await fetch(`${baseUrl}/identity`);
      const identityBody = await identity.json() as { mcp?: { activeSessions?: number; inFlightRequestCount?: number } };
      if (identityBody.mcp?.activeSessions === 1 && identityBody.mcp.inFlightRequestCount === 1) {
        saturated = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!saturated) {
      const slowFailure = await slowRequest;
      assert.fail(`first session must be in flight before saturation request; slow status=${slowFailure.status} body=${await slowFailure.text()}`);
    }

    const rejected = await post(undefined, {
      jsonrpc: "2.0",
      id: 4,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "session-capacity-client-2", version: "1.0.0" },
      },
    });
    assert.equal(rejected.status, 503);
    const rejectedPayload = await parseMcpResponse(rejected);
    assert.equal(rejectedPayload.error?.code, -32004);
    assert.match(String(rejectedPayload.error?.message), /capacity exhausted/i);
    for (const path of ["identity", "healthz"]) {
      const readback = await (await fetch(`${baseUrl}/${path}`)).json() as { mcp?: { capacityRejections?: number } };
      assert.equal(readback.mcp?.capacityRejections, 1, `${path} must count the preflight rejection once`);
    }
    assert.equal((await slowRequest).status, 200);
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest-bound production startup requires and binds the launch UUID", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-manifest-bound-server-"));
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(configDir, { recursive: true });
  const serverInstanceId = "123e4567-e89b-42d3-a456-426614174000";
  await writeFile(join(configDir, "control-plane.json"), JSON.stringify({
    schema: "devspace.control_plane_topology_manifest.v1",
    observedAt: new Date().toISOString(),
    maxAgeSeconds: 300,
    inventory: {
      services: [{
        role: "primary",
        roleKind: "AUTHORITATIVE_PRODUCTION",
        serviceIdentity: { serviceName: "primary", serverInstanceId },
        endpoint: { url: "https://primary.invalid", port: 7677 },
        oauth: { clientIds: [] },
        stateDirectory: stateDir,
        allowedRoots: [root],
        buildIdentity: { sourceCommit: "a".repeat(40), buildId: "fixture-build" },
        capabilityManifest: { sha256: "b".repeat(64), catalogGeneration: "fixture-catalog", tools: [] },
        featureFlags: {},
        durableState: {
          workspaceSessions: 0, agentSessions: 0, durableOperations: 0, oauthClients: 0,
          activeSwarms: 0, workers: 0, tasks: 0, inFlightOperations: 0, unknownOperations: 0,
          reconcileRequired: 0,
        },
        runtimeOwner: { held: false },
        routingAuthority: { active: true, endpoint: "https://primary.invalid" },
        configuredMaxCapacity: 5,
      }],
      canonicalRole: "primary",
      retirementCandidateRole: "migration-source",
    },
  }));
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const previousLaunchId = process.env.DEVSPACE_SERVER_INSTANCE_ID;
  let running: ReturnType<typeof createServer> | undefined;
  let listener: ReturnType<ReturnType<typeof createServer>["app"]["listen"]> | undefined;
  try {
    delete process.env.DEVSPACE_SERVER_INSTANCE_ID;
    assert.throws(() => createServer(config), /DEVSPACE_SERVER_INSTANCE_ID is required/);
    process.env.DEVSPACE_SERVER_INSTANCE_ID = "not-a-uuid";
    assert.throws(() => createServer(config), /DEVSPACE_SERVER_INSTANCE_ID must be a valid UUID/);

    process.env.DEVSPACE_SERVER_INSTANCE_ID = serverInstanceId;
    running = createServer(config);
    listener = running.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      listener?.once("listening", resolve);
      listener?.once("error", reject);
    });
    const address = listener.address() as { port: number };
    const identity = await (await fetch(`http://127.0.0.1:${address.port}/identity`)).json() as { serverInstanceId: string };
    assert.equal(identity.serverInstanceId, serverInstanceId);
  } finally {
    if (listener) await new Promise<void>((resolve) => listener?.close(() => resolve()));
    await running?.close();
    if (previousLaunchId === undefined) delete process.env.DEVSPACE_SERVER_INSTANCE_ID;
    else process.env.DEVSPACE_SERVER_INSTANCE_ID = previousLaunchId;
    await rm(root, { recursive: true, force: true });
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

test("same-conversation worktree opens reuse the resolved-base workspace and suppress repeated bootstrap context", async (t) => {
  const context = await fixture(t, { git: true });
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const firstWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const secondWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.equal(structuredContent(firstWorktree).workspaceId, structuredContent(secondWorktree).workspaceId);
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  const firstStructured = structuredContent(firstWorktree);
  assert.equal(firstStructured.mode, "worktree");
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.ok(Array.isArray(firstStructured.availableAgentsFiles));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agentProviders));
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skillDiagnostics));
  assert.match(responseText(firstWorktree), /Opened isolated worktree workspace/);

  const secondStructured = structuredContent(secondWorktree);
  assert.equal(secondStructured.mode, "worktree");
  assert.equal(secondStructured.agentsFiles, undefined);
  assert.equal(secondStructured.availableAgentsFiles, undefined);
  assert.match(responseText(secondWorktree), /Workspace already open as/);
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

test("Issue #194 G2: conversation workspace and durable agent survive MCP transport replacement and server restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-issue194-g2-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  const agentDir = join(root, ".agents");
  await mkdir(project, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");

  const port = await new Promise<number>((resolvePort, reject) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as AddressInfo;
      probe.close((error) => error ? reject(error) : resolvePort(address.port));
    });
    probe.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const mcpUrl = `${baseUrl}/mcp`;
  const accessToken = "issue194-g2-access-token";

  const oauthStore = new SqliteOAuthStore(stateDir);
  const clientsStore = new SqliteOAuthClientsStore(oauthStore, ["127.0.0.1", "localhost"]);
  const clientRecord = clientsStore.registerClient({
    redirect_uris: [`${baseUrl}/callback`],
    client_name: "issue194-g2-client",
  });
  oauthStore.saveTokenPair({
    accessTokenHash: createHash("sha256").update(accessToken).digest("base64url"),
    accessToken: {
      clientId: clientRecord.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl,
    },
    refreshTokenHash: createHash("sha256").update("issue194-g2-refresh").digest("base64url"),
    refreshToken: {
      clientId: clientRecord.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl,
    },
  });
  oauthStore.close();

  const loadedConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: baseUrl,
    DEVSPACE_TOOL_MODE: "full",
    PORT: String(port),
  });
  const config: ServerConfig = {
    ...loadedConfig,
    subagents: {
      enabled: true,
      providers: [{ id: "codex", enabled: true }],
    },
  };

  const post = (sessionId: string | undefined, body: unknown) => fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json, text/event-stream",
      // This raw-fetch fixture models a new transport across restart. Keeping
      // a pooled socket here would test Undici reuse rather than server state.
      "Connection": "close",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const parseMcpResponse = async (response: globalThis.Response): Promise<Record<string, any>> => {
    const raw = await response.text();
    const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(dataLine ? dataLine.slice(6) : raw) as Record<string, any>;
  };
  const initialize = async (id: number): Promise<string> => {
    const response = await post(undefined, {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: `issue194-g2-client-${id}`, version: "1.0.0" },
      },
    });
    assert.equal(response.status, 200);
    const sessionId = response.headers.get("mcp-session-id");
    assert.ok(sessionId);
    return sessionId;
  };
  const callTool = async (
    sessionId: string,
    id: number,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, any>> => {
    const response = await post(sessionId, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        _meta: { "openai/session": "issue194-g2-conversation" },
        name,
        arguments: args,
      },
    });
    assert.equal(response.status, 200);
    return parseMcpResponse(response);
  };
  const durableCounts = (): { workspaceSessions: number; agents: number } => {
    const workspaceStore = new SqliteWorkspaceStore(stateDir);
    const agentStore = new LocalAgentStore(stateDir);
    try {
      return {
        workspaceSessions: workspaceStore.listSessions().length,
        agents: agentStore.count(),
      };
    } finally {
      agentStore.close();
      workspaceStore.close();
    }
  };
  const startServer = async () => {
    const running = createServer(config);
    const listener = running.app.listen(port, "127.0.0.1");
    await new Promise<void>((resolveListening, reject) => {
      listener.once("listening", () => resolveListening());
      listener.once("error", reject);
    });
    return { running, listener };
  };
  const stopServer = async (server: Awaited<ReturnType<typeof startServer>>) => {
    await new Promise<void>((resolveClose) => server.listener.close(() => resolveClose()));
    await server.running.close();
  };

  let server = await startServer();
  let serverRunning = true;
  try {
    const firstSession = await initialize(1);
    const firstOpen = await callTool(firstSession, 2, "open_workspace", { path: project });
    const firstWorkspaceId = firstOpen.result?.structuredContent?.workspaceId as string | undefined;
    assert.ok(firstWorkspaceId);

    const seedStore = new LocalAgentStore(stateDir);
    const seeded = seedStore.create({
      workspaceId: firstWorkspaceId,
      workspaceRoot: project,
      profileName: "continuity-fixture",
      provider: "codex",
    });
    seedStore.update(seeded.id, {
      status: "idle",
      terminalReason: "completed",
      providerContinuityState: "KNOWN_UNVERIFIED",
      latestResponse: "continuity fixture complete",
    });
    seedStore.close();

    const firstStatus = await callTool(firstSession, 3, "agent_status", {
      workspaceId: firstWorkspaceId,
      agentId: seeded.id,
      waitMs: 0,
    });
    assert.equal(firstStatus.result?.structuredContent?.agentId, seeded.id);
    assert.deepEqual(durableCounts(), { workspaceSessions: 1, agents: 1 });

    // Replace only the MCP transport/session. Semantic conversation identity is unchanged.
    const replacementSession = await initialize(4);
    assert.notEqual(replacementSession, firstSession);
    const replacementOpen = await callTool(replacementSession, 5, "open_workspace", { path: project });
    assert.equal(replacementOpen.result?.structuredContent?.workspaceId, firstWorkspaceId);
    const replacementStatus = await callTool(replacementSession, 6, "agent_status", {
      workspaceId: firstWorkspaceId,
      agentId: seeded.id,
      waitMs: 0,
    });
    assert.equal(replacementStatus.result?.structuredContent?.agentId, seeded.id);
    assert.deepEqual(durableCounts(), { workspaceSessions: 1, agents: 1 });

    // Restart the server over the same durable state and reconnect again.
    await stopServer(server);
    serverRunning = false;
    server = await startServer();
    serverRunning = true;

    const restartedSession = await initialize(7);
    const restartedOpen = await callTool(restartedSession, 8, "open_workspace", { path: project });
    assert.equal(restartedOpen.result?.structuredContent?.workspaceId, firstWorkspaceId);
    const restartedStatus = await callTool(restartedSession, 9, "agent_status", {
      workspaceId: firstWorkspaceId,
      agentId: seeded.id,
      waitMs: 0,
    });
    assert.equal(restartedStatus.result?.structuredContent?.agentId, seeded.id);
    assert.deepEqual(durableCounts(), { workspaceSessions: 1, agents: 1 });
  } finally {
    if (serverRunning) await stopServer(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("late nested instructions fail closed across read/write/edit until explicitly read", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-1");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const nestedDir = join(context.project, "packages", "late");
  const instructionPath = join(nestedDir, "AGENTS.md");
  const targetPath = join(nestedDir, "index.ts");

  await mkdir(nestedDir, { recursive: true });
  await writeFile(instructionPath, "late instructions\n");
  await writeFile(targetPath, "export const value = 1;\n");
  await callOpen(context.client, context.project, "chat-1");

  const meta = { "openai/session": "chat-1" };
  const readBlocked = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "packages/late/index.ts" },
    _meta: meta,
  });
  assert.equal(readBlocked.isError, true);
  assert.match(responseText(readBlocked), /NESTED_INSTRUCTION_REBIND_REQUIRED/);
  assert.doesNotMatch(responseText(readBlocked), /export const value/);

  const writeBlocked = await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "packages/late/new.ts", content: "export const fresh = 1;\n" },
    _meta: meta,
  });
  assert.equal(writeBlocked.isError, true);
  assert.equal(existsSync(join(nestedDir, "new.ts")), false);

  const editBlocked = await context.client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      path: "packages/late/index.ts",
      edits: [{ oldText: "value = 1", newText: "value = 2" }],
    },
    _meta: meta,
  });
  assert.equal(editBlocked.isError, true);
  assert.equal(await readFile(targetPath, "utf8"), "export const value = 1;\n");

  const instructionRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "packages/late/AGENTS.md" },
    _meta: meta,
  });
  assert.equal(instructionRead.isError, undefined);

  const readAllowed = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "packages/late/index.ts" },
    _meta: meta,
  });
  assert.equal(readAllowed.isError, undefined);

  const writeAllowed = await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "packages/late/new.ts", content: "export const fresh = 1;\n" },
    _meta: meta,
  });
  assert.equal(writeAllowed.isError, undefined);

  const editAllowed = await context.client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      path: "packages/late/index.ts",
      edits: [{ oldText: "value = 1", newText: "value = 2" }],
    },
    _meta: meta,
  });
  assert.equal(editAllowed.isError, undefined);

  const staleEdit = await context.client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      path: "packages/late/index.ts",
      edits: [{ oldText: "value = 1", newText: "value = 3" }],
    },
    _meta: meta,
  });
  assert.equal(staleEdit.isError, true);
  assert.match(responseText(staleEdit), /Re-read the current target region/);
});

test("late nested instructions also fence codex apply_patch until explicitly read", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const opened = await callOpen(context.client, context.project, "chat-codex");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const nestedDir = join(context.project, "packages", "late-patch");
  const targetPath = join(nestedDir, "new.ts");

  await mkdir(nestedDir, { recursive: true });
  await writeFile(join(nestedDir, "AGENTS.md"), "late patch instructions\n");
  await callOpen(context.client, context.project, "chat-codex");

  const patch = [
    "*** Begin Patch",
    "*** Add File: packages/late-patch/new.ts",
    "+export const patched = 1;",
    "*** End Patch",
  ].join("\n");
  const meta = { "openai/session": "chat-codex" };

  const blocked = await context.client.callTool({
    name: "apply_patch",
    arguments: { workspaceId, patch },
    _meta: meta,
  });
  assert.equal(blocked.isError, true);
  assert.match(responseText(blocked), /NESTED_INSTRUCTION_REBIND_REQUIRED/);
  assert.equal(existsSync(targetPath), false);

  const instructionRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "packages/late-patch/AGENTS.md" },
    _meta: meta,
  });
  assert.equal(instructionRead.isError, undefined);

  const applied = await context.client.callTool({
    name: "apply_patch",
    arguments: { workspaceId, patch },
    _meta: meta,
  });
  assert.equal(applied.isError, undefined);
  assert.equal(await readFile(targetPath, "utf8"), "export const patched = 1;\n");
});

test("cutover MCP control exposes bounded lease lifecycle and schedules self restart once", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-cutover-mcp-control-"));
  const stateDir = join(root, ".state");
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_TOOL_MODE: "full",
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
      ensureActivationBound: (cutoverId) => ({
        schema: CUTOVER_ACTIVATION_BINDING_SCHEMA,
        cutoverId,
        sourceCommit: "b".repeat(40),
        buildId: "new-build",
        releaseSha256: "e".repeat(64),
        releasePath: join(root, "releases", "release-" + "b".repeat(40) + "-" + "e".repeat(16)),
        pointerPath: join(root, "current-release.json"),
        boundAt: "2026-10-06T00:00:00.000Z",
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
    const drainTool = tools.tools.find((tool) => tool.name === "cutover_drain");
    assert.ok(drainTool);
    assert.ok(
      (drainTool.inputSchema as { properties?: Record<string, unknown> }).properties?.carrierCredential,
      "cutover_drain must expose inline carrierCredential for fresh-session rebind",
    );
    const restartTool = tools.tools.find((tool) => tool.name === "cutover_restart_self");
    assert.ok(restartTool);
    assert.ok(
      (restartTool.inputSchema as { properties?: Record<string, unknown> }).properties?.carrierCredential,
      "cutover_restart_self must expose inline carrierCredential for fresh-session rebind",
    );
    const reconcileTool = tools.tools.find((tool) => tool.name === "cutover_reconcile");
    assert.ok(reconcileTool);
    assert.ok(
      (reconcileTool.inputSchema as { properties?: Record<string, unknown> }).properties?.carrierCredential,
      "cutover_reconcile must expose inline carrierCredential for fresh-session rebind",
    );

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
    DEVSPACE_TOOL_MODE: "full",
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
  processSessions: ProcessSessionManager;
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
    toolMode?: "full" | "minimal" | "codex" | "dispatch";
    chatSwarm?: boolean;
    controlPlaneInventory?: ControlPlaneInventory;
    coreMutation?: boolean | "enforced_missing";
    coreMutationRecoveryOwnerClientId?: string;
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
    DEVSPACE_CORE_MUTATION_RECOVERY_OWNER_CLIENT_ID: options.coreMutationRecoveryOwnerClientId,
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
  const processSessions = new ProcessSessionManager();
  const chatSwarmLifecycle = config.chatSwarmEnabled ? new ChatSwarmLifecycle({ stateDir }) : undefined;
  chatSwarmLifecycle?.recoverAfterStartup();
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    processSessions,
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
    undefined,
    undefined,
    options.controlPlaneInventory,
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
    processSessions.shutdown();
    chatSwarmLifecycle?.close();
    agentSessionManager?.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project, config, stateDir, processSessions, close };
}

function testControlPlaneInventory(): ControlPlaneInventory {
  const service = (
    role: string,
    roleKind: "AUTHORITATIVE_PRODUCTION" | "NON_AUTHORITATIVE_MIGRATION_SOURCE",
    stateDirectory: string,
  ) => ({
    role,
    roleKind,
    serviceIdentity: { serviceName: `${role}-service`, serverInstanceId: `${role}-server` },
    endpoint: { url: `https://${role}.invalid`, port: roleKind === "AUTHORITATIVE_PRODUCTION" ? 7677 : 7678 },
    oauth: { clientIds: [] },
    stateDirectory,
    allowedRoots: [stateDirectory],
    buildIdentity: { sourceCommit: "a".repeat(40), buildId: `${role}-build` },
    capabilityManifest: {
      sha256: "b".repeat(64),
      catalogGeneration: `${role}-catalog`,
      tools: [
        "chat_swarm_runtime_status",
        "chat_swarm_runtime_ensure",
        "chat_swarm_runtime_scale",
        "chat_swarm_runtime_recover",
        "chat_swarm_runtime_stop",
        "chat_swarm_runtime_bootstrap",
      ],
    },
    featureFlags: { chatSwarm: true },
    durableState: {
      workspaceSessions: 0,
      agentSessions: 0,
      durableOperations: 0,
      oauthClients: 0,
      activeSwarms: 0,
      workers: 0,
      tasks: 0,
      inFlightOperations: 0,
      unknownOperations: 0,
      reconcileRequired: 0,
    },
    runtimeOwner: { held: false },
    routingAuthority: { active: roleKind === "AUTHORITATIVE_PRODUCTION", endpoint: `https://${role}.invalid` },
    configuredMaxCapacity: roleKind === "AUTHORITATIVE_PRODUCTION" ? 5 : 0,
  });
  return {
    services: [
      service("primary", "AUTHORITATIVE_PRODUCTION", "/state/primary"),
      service("migration-source", "NON_AUTHORITATIVE_MIGRATION_SOURCE", "/state/migration-source"),
    ],
    canonicalRole: "primary",
    retirementCandidateRole: "migration-source",
    observedAt: new Date().toISOString(),
    maxAgeSeconds: 300,
    manifestRequired: true,
  };
}

test("Chat Swarm production registration is opt-in and uses the shared lifecycle", async (t) => {
  const disabled = await fixture(t);
  assert.equal((await disabled.client.listTools()).tools.some((tool) => tool.name === "chat_swarm_create"), false);
  await disabled.close();

  const enabled = await fixture(t, { chatSwarm: true });
  const tools = await enabled.client.listTools();
  const swarmTools = tools.tools.filter((tool) => tool.name.startsWith("chat_swarm_"));
  assert.equal(swarmTools.length, 21);
  for (const name of [
    "chat_swarm_migration_export",
    "chat_swarm_migration_prepare",
    "chat_swarm_migration_status",
    "chat_swarm_migration_apply",
    "chat_swarm_migration_reconcile",
    "control_plane_retirement_readiness",
  ]) {
    assert.equal(tools.tools.some((tool) => tool.name === name), false, `unvalidated inventory must not register ${name}`);
  }
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

test("manifest-bound Chat Swarm servers expose control-plane migration tools", async (t) => {
  const manifestBound = await fixture(t, { chatSwarm: true, controlPlaneInventory: testControlPlaneInventory() });
  const manifestTools = await manifestBound.client.listTools();
  const manifestSwarmTools = manifestTools.tools.filter((tool) => tool.name.startsWith("chat_swarm_"));
  assert.equal(manifestSwarmTools.length, 26);
  for (const name of [
    "chat_swarm_migration_export",
    "chat_swarm_migration_prepare",
    "chat_swarm_migration_status",
    "chat_swarm_migration_apply",
    "chat_swarm_migration_reconcile",
    "control_plane_retirement_readiness",
  ]) {
    assert.ok(manifestTools.tools.some((tool) => tool.name === name), `validated inventory should register ${name}`);
  }
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

async function addMutatorProfile(project: string): Promise<void> {
  await writeFile(join(project, ".devspace", "agents", "mutator.md"), [
    "---",
    "name: mutator",
    "description: Performs bounded repository mutations.",
    "provider: codex",
    "write_mode: allowed",
    "---",
    "Implement the bounded change.",
  ].join("\n"));
}

async function installGitHook(workspaceRoot: string, name: "post-commit" | "pre-push", body: string): Promise<void> {
  const commonRaw = (await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd: workspaceRoot })).stdout.trim();
  const commonDirectory = await realpath(isAbsolute(commonRaw) ? commonRaw : resolve(workspaceRoot, commonRaw));
  const ownedHooksDirectory = join(commonDirectory, "devspace-test-hooks");
  await mkdir(ownedHooksDirectory, { recursive: true, mode: 0o700 });
  const canonicalHooksDirectory = await realpath(ownedHooksDirectory);
  await execFileAsync("git", ["config", "--local", "core.hooksPath", canonicalHooksDirectory], { cwd: workspaceRoot });

  const hookRaw = (await execFileAsync("git", ["rev-parse", "--git-path", `hooks/${name}`], { cwd: workspaceRoot })).stdout.trim();
  const hookPath = isAbsolute(hookRaw) ? hookRaw : resolve(workspaceRoot, hookRaw);
  const canonicalParent = await realpath(dirname(hookPath));
  const contained = relative(canonicalHooksDirectory, hookPath);
  assert.equal(canonicalParent, canonicalHooksDirectory, "Git hook parent must be the fixture-owned canonical hooks directory");
  assert.ok(contained && !contained.startsWith("..") && !isAbsolute(contained), "Git hook path must stay inside the fixture-owned hooks directory");
  assert.equal(resolve(canonicalHooksDirectory, contained), hookPath);

  await writeFile(hookPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(hookPath, 0o755);
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












test("fresh direct workspace can edit and test without Core mutation session", async (t) => {
  const conversation = { "openai/session": "direct-workspace-sinks" };
  const full = await fixture(t, { coreMutation: true, subagents: true });
  await addMutatorProfile(full.project);
  const opened = await callOpen(full.client, full.project, conversation["openai/session"]);
  const workspaceId = structuredContent(opened).workspaceId as string;

  const bashMarker = join(full.project, "bash-direct.txt");
  const bash = await full.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('bash-direct.txt','ok')"`,
      attemptKey: "direct-bash",
    },
    _meta: conversation,
  });
  assert.equal(bash.isError, undefined, responseText(bash));
  assert.doesNotMatch(responseText(bash), /CORE_BOUND_SESSION_REQUIRED/);
  assert.equal(existsSync(bashMarker), true, "direct bash must spawn and write");
  assert.equal(structuredContent(bash).coreMutation, undefined);

  const write = await full.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "write-direct.txt", content: "ok\n" },
    _meta: conversation,
  });
  assert.equal(write.isError, undefined, responseText(write));
  assert.doesNotMatch(responseText(write), /CORE_BOUND_SESSION_REQUIRED/);
  assert.equal(readFileSync(join(full.project, "write-direct.txt"), "utf8"), "ok\n");
  assert.equal(structuredContent(write).coreMutation, undefined);

  const edit = await full.client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      path: "AGENTS.md",
      edits: [{ oldText: "project instructions", newText: "direct mutation" }],
    },
    _meta: conversation,
  });
  assert.equal(edit.isError, undefined, responseText(edit));
  assert.doesNotMatch(responseText(edit), /CORE_BOUND_SESSION_REQUIRED/);
  assert.match(readFileSync(join(full.project, "AGENTS.md"), "utf8"), /direct mutation/);
  assert.equal(structuredContent(edit).coreMutation, undefined);

  // OWNER_DIRECT delegated work keeps execution safety without requiring Core governance.
  const agent = await full.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "mutator",
      prompt: "launch bounded direct worker",
      attemptKey: "core-unbound-agent-start",
      executionContract: { authorityMode: "OWNER_DIRECT", writePaths: ["AGENTS.md"] },
    },
    _meta: conversation,
  });
  assert.equal(agent.isError, undefined, responseText(agent));
  assert.ok(structuredContent(agent).agentId);
  assert.equal(structuredContent(agent).coreMutation, undefined);

  const codex = await fixture(t, { coreMutation: true, toolMode: "codex" });
  const codexOpened = await callOpen(codex.client, codex.project, conversation["openai/session"]);
  const codexWorkspaceId = structuredContent(codexOpened).workspaceId as string;

  const patch = await codex.client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId: codexWorkspaceId,
      patch: "*** Begin Patch\n*** Add File: patch-direct.txt\n+ok\n*** End Patch",
    },
    _meta: conversation,
  });
  assert.equal(patch.isError, undefined, responseText(patch));
  assert.doesNotMatch(responseText(patch), /CORE_BOUND_SESSION_REQUIRED/);
  assert.equal(readFileSync(join(codex.project, "patch-direct.txt"), "utf8"), "ok\n");

  const execMarker = join(codex.project, "exec-direct.txt");
  const execResult = await codex.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId: codexWorkspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('exec-direct.txt','ok')"`,
      attemptKey: "direct-exec",
    },
    _meta: conversation,
  });
  assert.equal(execResult.isError, undefined, responseText(execResult));
  assert.doesNotMatch(responseText(execResult), /CORE_BOUND_SESSION_REQUIRED/);
  assert.equal(existsSync(execMarker), true, "direct exec_command must spawn and write");

  const directProc = await codex.processSessions.start({
    workspaceId: codexWorkspaceId,
    workspaceRoot: codex.project,
    cwd: codex.project,
    command: `${JSON.stringify(process.execPath)} -e "process.stdin.once('data',()=>require('node:fs').writeFileSync('stdin-direct.txt','ok'));setInterval(()=>{},1000)"`,
    yieldTimeMs: 10,
  });
  assert.ok(directProc.sessionId);
  try {
    const stdin = await codex.client.callTool({
      name: "write_stdin",
      arguments: { workspaceId: codexWorkspaceId, sessionId: directProc.sessionId, chars: "go\n" },
      _meta: conversation,
    });
    assert.equal(stdin.isError, undefined, responseText(stdin));
    assert.doesNotMatch(responseText(stdin), /CORE_BOUND_SESSION_REQUIRED/);
    assert.equal(existsSync(join(codex.project, "stdin-direct.txt")), true);
  } finally {
    codex.processSessions.terminate(codexWorkspaceId, directProc.sessionId!);
  }
});




test("agent continuation does not retroactively require Core binding for a direct read-only selection", async (t) => {
  const conversationScopeId = "direct-readonly-continuation";
  const conversation = { "openai/session": conversationScopeId };
  const context = await fixture(t, { git: true, coreMutation: true, subagents: true });
  const opened = await callOpen(context.client, context.project, conversationScopeId);
  const workspaceId = structuredContent(opened).workspaceId as string;

  const agents = new LocalAgentStore(context.stateDir);
  let agentId: string;
  try {
    const record = agents.create({
      workspaceId,
      workspaceRoot: context.project,
      profileName: "__direct__codex__default__gpt-test__default",
      provider: "codex",
      model: "gpt-test",
      executionContract: {
        directSelection: {
          provider: "codex",
          model: "gpt-test",
          writeMode: "read_only",
        },
      },
      lifecycleKind: "detached_worker_v2",
    });
    agentId = record.id;
    const generation = record.lifecycleState!.activeTurn!.generation!;
    const workerToken = "direct-readonly-test-worker";
    assert.equal(agents.prepareWorkerCAS(agentId, generation, workerToken).applied, true);
    assert.equal(agents.claimWorkerCAS(agentId, generation, workerToken, process.pid).applied, true);
    assert.equal(agents.finishTurnCAS({
      agentId,
      generation,
      workerToken,
      status: "idle",
      terminalReason: "completed",
    }).applied, true);
  } finally {
    agents.close();
  }

  const result = await context.client.callTool({
    name: "agent_continue",
    arguments: { workspaceId, agentId: agentId!, prompt: "continue read-only direct selection" },
    _meta: conversation,
  });

  assert.equal(result.isError, true);
  assert.doesNotMatch(responseText(result), /CORE_BOUND_SESSION_REQUIRED/);
  assert.match(responseText(result), /requires explicit rebind/);
});

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
  assert.ok(
    (startTool.inputSchema.required as string[] | undefined)?.includes("attemptKey"),
    "agent_start must require a physical replay identity before any provider side effect",
  );

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
      attemptKey: "invalid-selector-attempt",
    },
  });
  assert.equal(invalidSelector.isError, true);
  assert.match(responseText(invalidSelector), /either profile|both provider and model/i);

  for (const arguments_ of [
    { workspaceId, prompt: "missing selector", attemptKey: "missing-selector-attempt" },
    { workspaceId, provider: "codex", prompt: "missing model", attemptKey: "missing-model-attempt" },
    { workspaceId, profile: "reviewer", effort: "high", prompt: "profile effort mismatch", attemptKey: "profile-effort-attempt" },
    { workspaceId, provider: "codex", model: "", prompt: "empty model", attemptKey: "empty-model-attempt" },
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
    arguments: { workspaceId, profile: "reviewer", prompt: "legacy simulation", attemptKey: "legacy-generation-start" },
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
      attemptKey: "invalid-workspace-start",
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
  const worker = preflight.worker as Record<string, any>;
  assert.equal(worker.profile, "reviewer");
  const executionGeneration = worker.executionGeneration as Record<string, any>;
  assert.ok(executionGeneration, "preflight must expose the exact execution-generation qualification");
  assert.equal(executionGeneration.authReadiness, "UNKNOWN");
  assert.match(executionGeneration.executionBindingHash, /^[0-9a-f]{64}$/);
  const hostGeneration = executionGeneration.hostGeneration as Record<string, unknown>;
  assert.equal(hostGeneration.schema, "devspace.host_generation.v1");
  assert.match(String(hostGeneration.hostId), /^local:[0-9a-f]{64}$/);
  assert.match(String(hostGeneration.homeSha256), /^[0-9a-f]{64}$/);
  assert.match(String(hostGeneration.pathSha256), /^[0-9a-f]{64}$/);
  assert.match(String(hostGeneration.stateRootSha256), /^[0-9a-f]{64}$/);
  assert.match(String(hostGeneration.capabilityManifestSha256), /^[0-9a-f]{64}$/);
  assert.notEqual(hostGeneration.capabilityManifestSha256, "0".repeat(64));
  assert.match(String(hostGeneration.hostGenerationHash), /^[0-9a-f]{64}$/);
  assert.ok(Number.parseInt(String(hostGeneration.nodeMajor), 10) > 0);
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

test("subagents: OWNER_DIRECT write-capable start does not require Core or capability discovery", async (t) => {
  const conversationScopeId = "issue350-owner-direct-start";
  const context = await fixture(t, { git: true, coreMutation: true, subagents: true });
  await addMutatorProfile(context.project);
  await execFileAsync("git", ["add", ".devspace/agents/mutator.md"], { cwd: context.project });
  await execFileAsync("git", ["commit", "-m", "test fixture mutator profile"], { cwd: context.project });
  const openResult = await callOpen(context.client, context.project, conversationScopeId);
  const workspaceId = structuredContent(openResult).workspaceId as string;

  const started = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "mutator",
      prompt: "perform one bounded owner-direct change",
      attemptKey: "issue350-owner-direct-start",
      executionContract: {
        authorityMode: "OWNER_DIRECT",
        writePaths: ["src"],
      },
    },
    _meta: { "openai/session": conversationScopeId },
  });

  assert.equal(started.isError, undefined, responseText(started));
  assert.ok(structuredContent(started).agentId);
  assert.equal(structuredContent(started).coreMutation, undefined);
});

test("subagents: OWNER_DIRECT write-capable continuation does not require Core binding", async (t) => {
  const conversationScopeId = "issue350-owner-direct-continue";
  const context = await fixture(t, { git: true, coreMutation: true, subagents: true });
  await addMutatorProfile(context.project);
  await execFileAsync("git", ["add", ".devspace/agents/mutator.md"], { cwd: context.project });
  await execFileAsync("git", ["commit", "-m", "test fixture mutator profile"], { cwd: context.project });
  const openResult = await callOpen(context.client, context.project, conversationScopeId);
  const workspaceId = structuredContent(openResult).workspaceId as string;

  const started = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "mutator",
      prompt: "perform one bounded owner-direct change",
      attemptKey: "issue350-owner-direct-continue",
      executionContract: {
        authorityMode: "OWNER_DIRECT",
        writePaths: ["src"],
      },
    },
    _meta: { "openai/session": conversationScopeId },
  });
  assert.equal(started.isError, undefined, responseText(started));
  const agentId = structuredContent(started).agentId as string;

  const agents = new LocalAgentStore(context.stateDir);
  try {
    const record = agents.getById(agentId)!;
    const generation = record.lifecycleState!.activeTurn!.generation!;
    const workerToken = record.workerToken!;
    agents.claimWorkerCAS(agentId, generation, workerToken, process.pid);
    agents.finishTurnCAS({
      agentId,
      generation,
      workerToken,
      status: "idle",
      terminalReason: "completed",
    });
  } finally {
    agents.close();
  }

  const continued = await context.client.callTool({
    name: "agent_continue",
    arguments: {
      workspaceId,
      agentId,
      prompt: "continue the same bounded owner-direct task",
    },
    _meta: { "openai/session": conversationScopeId },
  });

  assert.equal(continued.isError, undefined, responseText(continued));
  assert.equal(structuredContent(continued).agentId, agentId);
  assert.equal(structuredContent(continued).continued, true);
  assert.equal(structuredContent(continued).coreMutation, undefined);
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
      attemptKey: "expected-head-stale",
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
      attemptKey: "expected-head-current",
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
    arguments: { workspaceId, profile: "reviewer", prompt: "do work", attemptKey: "reconcile-physical-diff" },
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

test("gitCandidates disabled hides candidate mutations but keeps explicit ref-fetch recovery", async (t) => {
  const context = await fixture(t, { gitCandidates: false });
  const tools = await context.client.listTools();
  const gitTools = tools.tools.filter((tool) => tool.name.startsWith("git_"));
  assert.deepEqual(gitTools.map((tool) => tool.name).sort(), ["git_fetch_ref"]);
});

test("Issue #238: MCP tool catalog identity changes with conditional Git Candidate actions", async (t) => {
  const withoutGitCandidates = await fixture(t, { gitCandidates: false });
  const withGitCandidates = await fixture(t, { git: true, gitCandidates: true });

  const withoutTools = (await withoutGitCandidates.client.listTools()).tools.map((tool) => tool.name);
  const withTools = (await withGitCandidates.client.listTools()).tools.map((tool) => tool.name);

  assert.equal(withoutTools.includes("git_commit"), false);
  assert.equal(withTools.includes("git_commit"), true);
  assert.notEqual(
    mcpToolCatalogGeneration(withoutTools),
    mcpToolCatalogGeneration(withTools),
  );
});

test("gitCandidates enabled: git tools are present with schema validation", async (t) => {
  const context = await fixture(t, { git: true, gitCandidates: true });
  const tools = await context.client.listTools();
  const gitTools = tools.tools.filter((tool) => tool.name.startsWith("git_"));
  assert.equal(gitTools.length, 4);

  const fetchTool = gitTools.find((tool) => tool.name === "git_fetch_ref");
  const commitTool = gitTools.find((tool) => tool.name === "git_commit");
  const pushTool = gitTools.find((tool) => tool.name === "git_push");
  const promoteTool = gitTools.find((tool) => tool.name === "git_promote_candidate");

  assert.ok(fetchTool);
  assert.ok(commitTool);
  assert.ok(pushTool);
  assert.ok(promoteTool);

  assert.deepEqual(fetchTool.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });

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
  assert.equal(pushTool.annotations?.idempotentHint, true);
  assert.ok(pushProps.attemptKey);
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
  assert.ok(contractProps.coreMutation, "write-capable agent_start must expose the exact durable Core pointer");
  assert.ok(contractProps.idleTimeoutMs);
  assert.match(contractProps.idleTimeoutMs.description, /terminated.*no provider activity/i);
  assert.ok(contractProps.authorizedToolCeiling, "agent_start must expose the durable tool authority ceiling");
  assert.deepEqual((contractProps.authorizedToolCeiling.items.enum as string[]).slice().sort(), [
    "process.execute",
    "workspace.list",
    "workspace.mutate",
    "workspace.read",
    "workspace.search_paths",
    "workspace.search_text",
  ]);
  assert.ok(contractProps.toolProjectionManifest, "agent_start must expose the derived ToolProjectionManifest");
  const manifestProps = contractProps.toolProjectionManifest.anyOf?.find((entry: any) => entry.type === "object")?.properties
    ?? contractProps.toolProjectionManifest.properties;
  assert.equal(manifestProps.schema.const, "devspace.tool_projection_manifest.v1");
  assert.equal(manifestProps.namespace.const, "devspace.tool_intent.v1");
  assert.ok(manifestProps.selectedTools);
  assert.ok(contractProps.effectProjection, "agent_start must expose the local hard-effect projection");
  const effectProps = contractProps.effectProjection.anyOf?.find((entry: any) => entry.type === "object")?.properties
    ?? contractProps.effectProjection.properties;
  assert.equal(effectProps.schema.const, "devspace.local_effect_projection.v1");
  assert.equal(effectProps.process.properties.mode.const, "DENY");
  assert.equal(effectProps.network.properties.egress.const, "DENY");
  assert.equal(effectProps.git.properties.mode.const, "DENY");
});

test("agent_start MCP transports durable tool authority and projection into the stored execution contract", async (t) => {
  const context = await fixture(t, { subagents: true });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "tool-projection-roundtrip"),
  ).workspaceId as string;

  const manifest = {
    schema: "devspace.tool_projection_manifest.v1",
    namespace: "devspace.tool_intent.v1",
    identity: { taskId: "task-tool-projection", attemptId: "attempt-tool-projection" },
    authority: { mode: "OWNER_DIRECT", issuer: "owner" },
    authorizedToolCeiling: ["workspace.read", "workspace.search_text"],
    candidateTools: ["workspace.read", "workspace.search_text"],
    selectedTools: ["workspace.read"],
    orderingMode: "ORDER_INDEPENDENT",
  };

  const start = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "transport the bounded tool projection",
      attemptKey: "tool-projection-start",
      executionContract: {
        authorityMode: "OWNER_DIRECT",
        authorizedToolCeiling: ["workspace.search_text", "workspace.read"],
        toolProjectionManifest: manifest,
        effectProjection: {
          schema: "devspace.local_effect_projection.v1",
          process: { mode: "DENY" },
          network: { egress: "DENY" },
          git: { mode: "DENY" },
        },
      },
    },
  });
  assert.equal(start.isError, undefined, responseText(start));
  const agentId = structuredContent(start).agentId as string;
  assert.ok(agentId);

  const { LocalAgentStore } = await import("./local-agent-store.js");
  const store = new LocalAgentStore(context.stateDir);
  try {
    const record = store.getById(agentId);
    assert.ok(record);
    assert.deepEqual(record.executionContract?.authorizedToolCeiling, [
      "workspace.read",
      "workspace.search_text",
    ]);
    assert.deepEqual(record.executionContract?.toolProjectionManifest?.selectedTools, ["workspace.read"]);
    assert.equal(record.executionContract?.toolProjectionManifest?.authority.mode, "OWNER_DIRECT");
    assert.deepEqual(record.executionContract?.effectProjection, {
      schema: "devspace.local_effect_projection.v1",
      process: { mode: "DENY" },
      network: { egress: "DENY" },
      git: { mode: "DENY" },
    });
  } finally {
    store.close();
  }

  const providerNativeId = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "reject provider-native tool id",
      attemptKey: "provider-native-tool-reject",
      executionContract: {
        authorizedToolCeiling: ["codex.shell"],
      },
    },
  });
  assert.equal(providerNativeId.isError, true);
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
    arguments: { workspaceId, provider: "claude", model: "claude-test", prompt: "must be rejected", attemptKey: "disabled-provider-start" },
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
      attemptKey: "mcp-test-push",
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

test("OWNER_DIRECT dependency_sync bypasses carrier only for a managed isolated worktree", async (t) => {
  const context = await fixture(t, { git: true });
  await writeFile(join(context.project, "package.json"), JSON.stringify({ name: "isolated-fixture", version: "1.0.0" }) + "\n");
  await writeFile(join(context.project, "package-lock.json"), JSON.stringify({
    name: "isolated-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "isolated-fixture", version: "1.0.0" } },
  }) + "\n");
  await git(context.project, ["add", "package.json", "package-lock.json"]);
  await git(context.project, ["commit", "-m", "add dependency fixture"]);

  const isolated = await callOpen(context.client, context.project, "isolated-dependency-sync", "worktree");
  const isolatedWorkspaceId = structuredContent(isolated).workspaceId as string;
  const isolatedResult = await context.client.callTool({
    name: "dependency_sync",
    arguments: {
      workspaceId: isolatedWorkspaceId,
      attemptKey: "isolated-owner-direct-deps",
      recipe: "npm_ci",
      authorityMode: "OWNER_DIRECT",
    },
    _meta: { "openai/session": "isolated-dependency-sync" },
  });
  assert.equal(isolatedResult.isError, undefined, JSON.stringify(isolatedResult));
  assert.equal(structuredContent(isolatedResult).status, "succeeded");
  assert.equal(
    ((structuredContent(isolatedResult).request as Record<string, unknown>) ?? {}).ownerDirectIsolated,
    true,
  );

  const checkout = await callOpen(context.client, context.project, "checkout-dependency-sync", "checkout");
  const checkoutWorkspaceId = structuredContent(checkout).workspaceId as string;
  const checkoutResult = await context.client.callTool({
    name: "dependency_sync",
    arguments: {
      workspaceId: checkoutWorkspaceId,
      attemptKey: "checkout-owner-direct-deps",
      recipe: "npm_ci",
      authorityMode: "OWNER_DIRECT",
    },
    _meta: { "openai/session": "checkout-dependency-sync" },
  });
  assert.equal(checkoutResult.isError, true);
  assert.match(JSON.stringify(checkoutResult), /authenticated MCP client context is required/);
});

test("command_status metadata annotations and minimal mode visibility", async (t) => {
  const context = await fixture(t, {
    toolMode: "minimal",
    subagents: true,
    gitCandidates: true,
    chatSwarm: true,
    coreMutation: true,
  });
  const toolsList = await context.client.listTools();
  const toolNames = toolsList.tools.map((t) => t.name).sort();

  assert.deepEqual(toolNames, [
    "apply_patch",
    "bash",
    "command_status",
    "edit",
    "git_commit",
    "git_fetch_ref",
    "git_push",
    "glob",
    "grep",
    "host_capability_snapshot",
    "ls",
    "open_workspace",
    "read",
    "workspace_copy_file",
    "workspace_list_verifiers",
    "workspace_verify",
    "write",
  ]);

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

test("dispatch mode exposes only the direct worker lifecycle and simple instructions", async (t) => {
  const context = await fixture(t, {
    git: true,
    toolMode: "dispatch",
    subagents: true,
    gitCandidates: true,
    chatSwarm: true,
    coreMutation: true,
  });
  const toolsList = await context.client.listTools();
  const names = toolsList.tools.map((tool) => tool.name).sort();

  assert.deepEqual(names, [
    "agent_cancel",
    "agent_catalog",
    "agent_continue",
    "agent_list",
    "agent_preflight",
    "agent_reconcile",
    "agent_start",
    "agent_status",
    "git_fetch_ref",
    "host_operation_external_status",
    "open_workspace",
    "read",
    "work_resume_prepare",
  ]);
  assert.equal(names.length, 13);

  const resumePrepare = toolsList.tools.find((tool) => tool.name === "work_resume_prepare");
  assert.ok(resumePrepare);
  const resumePrepareSchema = JSON.stringify(resumePrepare);
  assert.match(resumePrepareSchema, /carrierCredential/);
  assert.doesNotMatch(
    resumePrepareSchema,
    /Core|Nexus|coordination|cutover|host.?operation|#62|P0/i,
    "direct-dispatch admission metadata must stay implementation-neutral",
  );

  assert.deepEqual(
    names.filter(
      (name) =>
        /core|coordination|cutover|candidate|repository_intelligence|^bash$|^write$|^edit$|apply_patch|^git_(?!fetch_ref$)/.test(name) ||
        (name.startsWith("host_operation") && name !== "host_operation_external_status"),
    ),
    [],
  );

  const gitFetchRef = toolsList.tools.find((tool) => tool.name === "git_fetch_ref");
  assert.ok(gitFetchRef);
  assert.deepEqual(gitFetchRef.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });

  const agentStart = toolsList.tools.find((tool) => tool.name === "agent_start");
  assert.ok(agentStart);
  const agentStartSchema = JSON.stringify(agentStart.inputSchema);
  assert.match(agentStartSchema, /attemptKey/);
  assert.match(agentStartSchema, /expectedHead/);
  assert.match(agentStartSchema, /writePaths/);
  assert.match(agentStartSchema, /resumableWork/);
  assert.doesNotMatch(
    agentStartSchema,
    /nexusGrant|coreMutation|capabilityDiscovery|authorizedToolCeiling|toolProjectionManifest|effectProjection/,
  );
  assert.doesNotMatch(agentStartSchema, /Core|Nexus|coordination|cutover|host.?operation/i);

  const instructions = context.client.getInstructions() ?? "";
  assert.match(instructions, /open_workspace/);
  assert.match(instructions, /GIT_BASE_REF_NOT_LOCAL/);
  assert.match(instructions, /git_fetch_ref/);
  assert.match(instructions, /agent_catalog/);
  assert.match(instructions, /agent_preflight/);
  assert.match(instructions, /work_resume_prepare/);
  assert.match(instructions, /agent_start/);
  assert.match(instructions, /OWNER_DIRECT/);
  assert.match(instructions, /attemptKey/);
  assert.match(instructions, /agent_status/);
  assert.match(instructions, /agent_reconcile/);
  assert.match(instructions, /read/);
  assert.doesNotMatch(instructions, /Core|Nexus|coordination|cutover|host.?operation/i);
});

test("git_fetch_ref recovery is projected in every worktree-capable tool mode", async (t) => {
  for (const toolMode of ["minimal", "dispatch", "codex", "full"] as const) {
    const context = await fixture(t, { git: true, toolMode });
    const toolsList = await context.client.listTools();
    const names = toolsList.tools.map((tool) => tool.name);
    assert.ok(
      names.includes("git_fetch_ref"),
      `git_fetch_ref must be callable when ${toolMode} mode can emit GIT_BASE_REF_NOT_LOCAL`,
    );
    const instructions = context.client.getInstructions() ?? "";
    assert.match(instructions, /GIT_BASE_REF_NOT_LOCAL/);
    assert.match(instructions, /git_fetch_ref/);
  }
});

test("dispatch mode rebinds an approved writer credential and admits enrolled agent_start", async () => {
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { CarrierBindingStore } = await import("./carrier-binding.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "devspace-dispatch-admission-http-")));
  const project = join(root, "project");
  const stateDir = join(root, "state");
  const agentDir = join(root, "agents");
  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(join(project, ".nexus-core"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(project, "README.md"), "dispatch admission fixture\n");
  await writeFile(join(project, ".nexus-core", "config.toml"), "schema_version = 1\n");
  await addMutatorProfile(project);
  await git(project, ["init"]);
  await git(project, ["config", "user.email", "devspace@example.com"]);
  await git(project, ["config", "user.name", "DevSpace Test"]);
  await git(project, ["add", "."]);
  await git(project, ["commit", "-m", "dispatch admission fixture"]);
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: project })).stdout.trim();

  const loadedConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_TOOL_MODE: "dispatch",
    PORT: "1",
  });
  const config: ServerConfig = {
    ...loadedConfig,
    toolMode: "dispatch",
    subagents: {
      ...loadedConfig.subagents,
      enabled: true,
      providers: [{ id: "codex", enabled: true }],
    },
  };

  const provider = new SingleUserOAuthProvider(config.oauth, new URL("/mcp", config.publicBaseUrl), config.stateDir);
  const oauthClient = await provider.clientsStore.registerClient!({
    redirect_uris: ["http://localhost/callback"],
    client_name: "dispatch admission fixture",
    token_endpoint_auth_method: "none",
  });
  let redirect = "";
  await provider.authorize(
    oauthClient,
    {
      redirectUri: "http://localhost/callback",
      codeChallenge: "fixture",
      scopes: config.oauth.scopes,
      resource: new URL("/mcp", config.publicBaseUrl),
    },
    {
      req: { method: "POST", body: { owner_token: config.oauth.ownerToken } },
      redirect: (_status: number, url: string) => { redirect = url; },
    } as never,
  );
  const tokens = await provider.exchangeAuthorizationCode(
    oauthClient,
    new URL(redirect).searchParams.get("code")!,
  );

  const running = createServer(config);
  const listener = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const address = listener.address() as { port: number };
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } },
  );
  const client = new Client({ name: "dispatch-admission-fixture", version: "1" });
  let approver: InstanceType<typeof CarrierBindingStore> | undefined;
  try {
    await client.connect(transport);
    const conversationScopeId = "issue396-dispatch-admission";
    const opened = await callOpen(client, project, conversationScopeId);
    const workspaceId = structuredContent(opened).workspaceId as string;
    const tools = await client.listTools();
    const prepareTool = tools.tools.find((tool) => tool.name === "work_resume_prepare");
    assert.ok(prepareTool);
    assert.ok(
      (prepareTool.inputSchema as { properties?: Record<string, unknown> }).properties?.carrierCredential,
      "direct dispatch must expose only the narrow credential-rebind input on work_resume_prepare",
    );
    assert.equal(tools.tools.some((tool) => tool.name === "coordination_resume"), false);

    const unbound = await client.callTool({
      name: "work_resume_prepare",
      arguments: { workspaceId, contractPurpose: "issue396-positive-admission" },
      _meta: { "openai/session": conversationScopeId },
    });
    assert.equal(unbound.isError, true);
    assert.match(responseText(unbound), /current paired carrier is required/i);

    assert.ok(transport.sessionId);
    approver = new CarrierBindingStore(stateDir);
    const pairing = approver.requestPairing({
      clientId: oauthClient.client_id,
      sessionId: transport.sessionId,
    });
    approver.approveLocal(pairing.pendingId, {
      repository: "James3014/devspace",
      goal: "issue-396",
      role: "controller",
      scope: [project],
      baseRevision: head,
      operations: ["worktree_write"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const prepared = await client.callTool({
      name: "work_resume_prepare",
      arguments: {
        workspaceId,
        contractPurpose: "issue396-positive-admission",
        carrierCredential: pairing.credential,
      },
      _meta: { "openai/session": conversationScopeId },
    });
    assert.equal(prepared.isError, undefined, responseText(prepared));
    assert.doesNotMatch(JSON.stringify(prepared), new RegExp(pairing.credential));
    const resumableWork = structuredContent(prepared).resumableWork as {
      workKey: string;
      leaseId: string;
      expectedLeaseVersion: number;
      baseRevisionSha: string;
    };
    assert.match(resumableWork.workKey, /^wk_[0-9a-f]{32}$/);
    assert.equal(resumableWork.baseRevisionSha, head);

    const attemptKey = "issue396-positive-agent";
    const started = await client.callTool({
      name: "agent_start",
      arguments: {
        workspaceId,
        profile: "mutator",
        prompt: "perform one bounded direct change",
        attemptKey,
        executionContract: {
          authorityMode: "OWNER_DIRECT",
          expectedHead: head,
          writePaths: ["README.md"],
          resumableWork: { ...resumableWork, effectHandle: attemptKey },
          maxFiles: 1,
        },
      },
      _meta: { "openai/session": conversationScopeId },
    });
    assert.equal(started.isError, undefined, responseText(started));
    assert.ok(structuredContent(started).agentId);
    assert.equal(structuredContent(started).coreMutation, undefined);
  } finally {
    await client.close().catch(() => {});
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await running.close();
    approver?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch mode requires bounded write scope and launches OWNER_DIRECT without governance inputs", async (t) => {
  const conversationScopeId = "issue350-dispatch-worker";
  const context = await fixture(t, {
    git: true,
    toolMode: "dispatch",
    subagents: true,
    coreMutation: true,
  });
  await addMutatorProfile(context.project);
  await execFileAsync("git", ["add", ".devspace/agents/mutator.md"], { cwd: context.project });
  await execFileAsync("git", ["commit", "-m", "test fixture mutator profile"], { cwd: context.project });
  const opened = await callOpen(context.client, context.project, conversationScopeId);
  const workspaceId = structuredContent(opened).workspaceId as string;
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: context.project })).stdout.trim();

  const unbounded = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "mutator",
      prompt: "perform one bounded direct change",
      attemptKey: "issue350-dispatch-unbounded",
    },
    _meta: { "openai/session": conversationScopeId },
  });
  assert.equal(unbounded.isError, true);
  assert.match(responseText(unbounded), /DIRECT_DISPATCH_WRITE_SCOPE_REQUIRED/);

  const started = await context.client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "mutator",
      prompt: "perform one bounded direct change",
      attemptKey: "issue350-dispatch-bounded",
      executionContract: {
        authorityMode: "OWNER_DIRECT",
        expectedHead: head,
        writePaths: ["src"],
        maxFiles: 2,
      },
    },
    _meta: { "openai/session": conversationScopeId },
  });
  assert.equal(started.isError, undefined, responseText(started));
  assert.ok(structuredContent(started).agentId);
  assert.equal(structuredContent(started).coreMutation, undefined);
});

test("minimal mode is direct coding", async (t) => {
  const direct = await fixture(t, {
    git: true,
    toolMode: "minimal",
    subagents: true,
    gitCandidates: true,
  });
  const opened = await callOpen(direct.client, direct.project, "issue300-direct");
  const workspaceId = structuredContent(opened).workspaceId as string;
  assert.ok(
    (structuredContent(opened).agentsFiles as Array<{ path: string }>).some((file) => file.path.endsWith("AGENTS.md")),
    "Direct Coding must preserve repository instruction loading",
  );
  assert.deepEqual(structuredContent(opened).agentProfileStatuses, []);
  assert.deepEqual(structuredContent(opened).agentProviders, []);
  assert.deepEqual(structuredContent(opened).agents, []);

  const write = await direct.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "direct.txt", content: "first\n" },
    _meta: { "openai/session": "issue300-direct" },
  });
  assert.equal(write.isError, undefined, responseText(write));

  const edit = await direct.client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      path: "direct.txt",
      edits: [{ oldText: "first\n", newText: "second\n" }],
    },
    _meta: { "openai/session": "issue300-direct" },
  });
  assert.equal(edit.isError, undefined, responseText(edit));
  assert.equal(readFileSync(join(direct.project, "direct.txt"), "utf8"), "second\n");

  const shell = await direct.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('direct-ok')"`,
      attemptKey: "issue300-direct-shell",
    },
    _meta: { "openai/session": "issue300-direct" },
  });
  assert.equal(shell.isError, undefined, responseText(shell));
  assert.match(responseText(shell), /direct-ok/);

  const escapedPath = join(dirname(direct.project), "issue300-escape.txt");
  const escaped = await direct.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "../issue300-escape.txt", content: "escape\n" },
    _meta: { "openai/session": "issue300-direct" },
  });
  assert.equal(escaped.isError, true);
  assert.equal(existsSync(escapedPath), false);
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
      DEVSPACE_TOOL_MODE: "full",
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
      DEVSPACE_TOOL_MODE: "full",
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

test("#386: real server /mcp keeps unrelated workspace mutation usable during drain while deployment-conflicting effects stay fenced", async () => {
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
    DEVSPACE_TOOL_MODE: "full",
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

    // 5. An unrelated workspace operation keeps its own admission/authority and
    // is not converted into a global deployment outage.
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
    assert.equal(openRes.status, 200, "Unrelated workspace operation must remain reachable during drain");
    const openJson = (await parseMcpResponse(openRes)) as { result?: { isError?: boolean; structuredContent?: { workspaceId?: string } } };
    assert.equal(openJson.result?.isError, undefined);
    assert.equal(typeof openJson.result?.structuredContent?.workspaceId, "string");
    const projectWorkspaceId = openJson.result?.structuredContent?.workspaceId as string;

    const unrelatedWriteRes = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${testAccessToken}`,
        "mcp-session-id": session2Id,
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 121,
        method: "tools/call",
        params: {
          name: "write",
          arguments: { workspaceId: projectWorkspaceId, path: "unrelated.txt", content: "still usable\n" },
        },
      }),
    });
    assert.equal(unrelatedWriteRes.status, 200, "Unrelated file mutation must remain usable during drain");
    const unrelatedWriteJson = (await parseMcpResponse(unrelatedWriteRes)) as { result?: { isError?: boolean } };
    assert.equal(unrelatedWriteJson.result?.isError, undefined);

    // A workspace may legitimately cover a broad allowed root. The cutover
    // fence therefore needs the exact physical mutation target, not merely the
    // tool name or workspace id: unrelated paths stay usable, but mutation of
    // the cutover evidence root is blocked before the write handler executes.
    const rootOpenRes = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${testAccessToken}`,
        "mcp-session-id": session2Id,
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 122,
        method: "tools/call",
        params: { name: "open_workspace", arguments: { path: root } },
      }),
    });
    assert.equal(rootOpenRes.status, 200);
    const rootOpenJson = (await parseMcpResponse(rootOpenRes)) as { result?: { structuredContent?: { workspaceId?: string } } };
    const rootWorkspaceId = rootOpenJson.result?.structuredContent?.workspaceId;
    assert.equal(typeof rootWorkspaceId, "string");

    const evidenceWriteRes = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${testAccessToken}`,
        "mcp-session-id": session2Id,
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 123,
        method: "tools/call",
        params: {
          name: "write",
          arguments: {
            workspaceId: rootWorkspaceId,
            path: ".state/reconciliation-probe.txt",
            content: "must never be written\n",
          },
        },
      }),
    });
    assert.equal(evidenceWriteRes.status, 409, "Mutation of cutover evidence must remain fenced");
    const evidenceWriteJson = (await parseMcpResponse(evidenceWriteRes)) as { error?: { code?: number; message?: string } };
    assert.equal(evidenceWriteJson.error?.code, -32002);
    assert.match(evidenceWriteJson.error?.message ?? "", /CUTOVER_RECONCILIATION_REQUIRED/);

    const evidenceCopyRes = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${testAccessToken}`,
        "mcp-session-id": session2Id,
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 124,
        method: "tools/call",
        params: {
          name: "workspace_copy_file",
          arguments: {
            sourceWorkspaceId: projectWorkspaceId,
            sourcePath: "unrelated.txt",
            destinationWorkspaceId: rootWorkspaceId,
            destinationPath: ".state/reconciliation-copy.txt",
            expectedDestinationAbsent: true,
          },
        },
      }),
    });
    assert.equal(
      evidenceCopyRes.status,
      409,
      "workspace_copy_file must not mutate cutover evidence through a destination-only workspace id",
    );
    const evidenceCopyJson = (await parseMcpResponse(evidenceCopyRes)) as { error?: { code?: number; message?: string } };
    assert.equal(evidenceCopyJson.error?.code, -32002);
    assert.match(evidenceCopyJson.error?.message ?? "", /CUTOVER_RECONCILIATION_REQUIRED/);

    // 6. A release-retention mutation can destroy exact deployment evidence,
    // so it stays fenced before its own handler sees the request.
    const gcRes = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${testAccessToken}`,
        "mcp-session-id": session2Id,
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: {
          name: "storage_gc",
          arguments: { expectedPlanId: `sha256:${"0".repeat(64)}`, confirm: true },
        },
      }),
    });
    assert.equal(gcRes.status, 409, "Deployment-conflicting storage GC must remain fenced during drain");
    const gcJson = (await parseMcpResponse(gcRes)) as { error?: { code?: number; message?: string } };
    assert.equal(gcJson.error?.code, -32002);
    assert.ok(gcJson.error?.message?.includes("CUTOVER_RECONCILIATION_REQUIRED"));
  } finally {
    await new Promise<void>((res) => httpServer.close(() => res()));
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Issue #15 Wave 4B: capability convergence resolves the initialized request session without an explicit sessionId", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-wave4b-session-"));
  const stateDir = join(root, ".state");
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as AddressInfo;
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
    probe.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const mcpUrl = `${baseUrl}/mcp`;
  const accessToken = "wave4b-access-token";
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: baseUrl,
    DEVSPACE_TOOL_MODE: "full",
    PORT: String(port),
  });
  const oauthStore = new SqliteOAuthStore(stateDir);
  const clientsStore = new SqliteOAuthClientsStore(oauthStore, ["127.0.0.1", "localhost"]);
  const clientRecord = clientsStore.registerClient({
    redirect_uris: [`${baseUrl}/callback`],
    client_name: "wave4b-client",
  });
  oauthStore.saveTokenPair({
    accessTokenHash: createHash("sha256").update(accessToken).digest("base64url"),
    accessToken: {
      clientId: clientRecord.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl,
    },
    refreshTokenHash: createHash("sha256").update("wave4b-refresh").digest("base64url"),
    refreshToken: {
      clientId: clientRecord.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl,
    },
  });
  oauthStore.close();

  const post = (sessionId: string, body: unknown) => fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json, text/event-stream",
      "mcp-protocol-version": "2024-11-05",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const parseResponse = async (response: globalThis.Response): Promise<Record<string, any>> => {
    const body = await response.text();
    const messages = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, any>);
    if (messages.length > 0) {
      return messages.find((message) => "result" in message || "error" in message) ?? messages[0]!;
    }
    return JSON.parse(body) as Record<string, any>;
  };

  const running = createServer(config);
  const listener = running.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  try {
    const initialized = await post("", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "wave4b-client", version: "1.0.0" },
      },
    });
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers.get("mcp-session-id");
    assert.match(sessionId ?? "", /^[0-9a-f-]{36}$/);

    const secondInitialized = await post("", {
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "wave4b-client-second-session", version: "1.0.0" },
      },
    });
    assert.equal(secondInitialized.status, 200);
    const secondSessionId = secondInitialized.headers.get("mcp-session-id");
    assert.match(secondSessionId ?? "", /^[0-9a-f-]{36}$/);
    assert.notEqual(secondSessionId, sessionId);

    const convergence = await post(sessionId!, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "capability_convergence_status",
        arguments: {},
        _meta: { "openai/session": "issue-240-caller-a" },
      },
    });
    assert.equal(convergence.status, 200);
    const payload = await parseResponse(convergence);
    const session = payload.result?.structuredContent?.sessionConvergence as {
      state?: string;
      controllerDisposition?: string;
      converged?: boolean;
      sessionSnapshot?: {
        serverInstanceId?: string;
        catalogGeneration?: string;
        callerIdentityFingerprint?: string;
        conversationIdentityFingerprint?: string;
      };
      serverGeneration?: { serverInstanceId?: string; catalogGeneration?: string; toolNames?: string[] };
    } | undefined;
    assert.equal(session?.state, "CURRENT");
    assert.equal(session?.controllerDisposition, "CLIENT_PROJECTION_UNPROVEN");
    assert.equal(session?.converged, false);
    assert.equal(
      payload.result?.structuredContent?.clientProjectionConvergence?.state,
      "CLIENT_PROJECTION_UNPROVEN",
    );
    assert.equal(payload.result?.structuredContent?.refresh?.requested, "AUTO_UNPROVEN");
    assert.equal(payload.result?.structuredContent?.refresh?.notificationSent, true);
    assert.equal(payload.result?.structuredContent?.refresh?.nextAction, "RELIST_TOOLS");
    assert.equal(session?.sessionSnapshot?.serverInstanceId, session?.serverGeneration?.serverInstanceId);
    assert.equal(session?.sessionSnapshot?.catalogGeneration, session?.serverGeneration?.catalogGeneration);
    assert.match(session?.sessionSnapshot?.callerIdentityFingerprint ?? "", /^mcp:[0-9a-f]{64}$/);
    assert.match(session?.sessionSnapshot?.conversationIdentityFingerprint ?? "", /^openai:[0-9a-f]{64}$/);
    assert.ok(session?.serverGeneration?.toolNames?.includes("open_workspace"));

    const stillUnprovenProjection = await post(secondSessionId!, {
      jsonrpc: "2.0",
      id: 19,
      method: "tools/call",
      params: {
        name: "capability_convergence_status",
        arguments: {},
        _meta: { "openai/session": "issue-240-caller-a" },
      },
    });
    assert.equal(stillUnprovenProjection.status, 200);
    const stillUnprovenPayload = await parseResponse(stillUnprovenProjection);
    assert.equal(
      stillUnprovenPayload.result?.structuredContent?.clientProjectionConvergence?.state,
      "CLIENT_PROJECTION_UNPROVEN",
    );
    assert.equal(stillUnprovenPayload.result?.structuredContent?.refresh?.notificationSent, true);
    assert.equal(stillUnprovenPayload.result?.structuredContent?.refresh?.alreadyAttempted, false);
    assert.equal(stillUnprovenPayload.result?.structuredContent?.refresh?.nextAction, "RELIST_TOOLS");
    assert.equal(
      stillUnprovenPayload.result?.structuredContent?.sessionConvergence?.controllerDisposition,
      "CLIENT_PROJECTION_UNPROVEN",
    );
    assert.equal(
      stillUnprovenPayload.result?.structuredContent?.sessionConvergence?.reconnectRequired,
      false,
    );
    assert.equal(
      stillUnprovenPayload.result?.structuredContent?.sessionConvergence?.sessionSnapshot?.callerIdentityFingerprint,
      session?.sessionSnapshot?.callerIdentityFingerprint,
    );
    assert.equal(
      stillUnprovenPayload.result?.structuredContent?.sessionConvergence?.sessionSnapshot?.conversationIdentityFingerprint,
      session?.sessionSnapshot?.conversationIdentityFingerprint,
    );

    const failedToolsListAcknowledgement = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
        "mcp-protocol-version": "2024-11-05",
        "mcp-session-id": secondSessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 23,
        method: "tools/list",
        params: {},
      }),
    });
    assert.equal(failedToolsListAcknowledgement.status, 406);

    const thirdInitialized = await post("", {
      jsonrpc: "2.0",
      id: 24,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "wave4b-client-third-session", version: "1.0.0" },
      },
    });
    assert.equal(thirdInitialized.status, 200);
    const thirdSessionId = thirdInitialized.headers.get("mcp-session-id");
    assert.match(thirdSessionId ?? "", /^[0-9a-f-]{36}$/);

    const stillUnacknowledgedConversationRefresh = await post(thirdSessionId!, {
      jsonrpc: "2.0",
      id: 25,
      method: "tools/call",
      params: {
        name: "capability_convergence_status",
        arguments: {},
        _meta: { "openai/session": "issue-240-caller-a" },
      },
    });
    assert.equal(stillUnacknowledgedConversationRefresh.status, 200);
    const stillUnacknowledgedConversationPayload = await parseResponse(stillUnacknowledgedConversationRefresh);
    assert.equal(stillUnacknowledgedConversationPayload.result?.structuredContent?.refresh?.notificationSent, true);
    assert.equal(stillUnacknowledgedConversationPayload.result?.structuredContent?.refresh?.alreadyAttempted, false);
    assert.equal(stillUnacknowledgedConversationPayload.result?.structuredContent?.refresh?.nextAction, "RELIST_TOOLS");

    const batchedToolsListAcknowledgement = await post(thirdSessionId!, [
      {
        jsonrpc: "2.0",
        id: 26,
        method: "tools/list",
        params: {},
      },
    ]);
    assert.equal(batchedToolsListAcknowledgement.status, 200);

    const fourthInitialized = await post("", {
      jsonrpc: "2.0",
      id: 27,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "wave4b-client-fourth-session", version: "1.0.0" },
      },
    });
    assert.equal(fourthInitialized.status, 200);
    const fourthSessionId = fourthInitialized.headers.get("mcp-session-id");
    assert.match(fourthSessionId ?? "", /^[0-9a-f-]{36}$/);

    const acknowledgedConversationRefresh = await post(fourthSessionId!, {
      jsonrpc: "2.0",
      id: 28,
      method: "tools/call",
      params: {
        name: "capability_convergence_status",
        arguments: {},
        _meta: { "openai/session": "issue-240-caller-a" },
      },
    });
    assert.equal(acknowledgedConversationRefresh.status, 200);
    const acknowledgedConversationPayload = await parseResponse(acknowledgedConversationRefresh);
    assert.equal(acknowledgedConversationPayload.result?.structuredContent?.refresh?.notificationSent, false);
    assert.equal(acknowledgedConversationPayload.result?.structuredContent?.refresh?.alreadyAttempted, true);
    assert.equal(acknowledgedConversationPayload.result?.structuredContent?.refresh?.nextAction, "RECONNECT_REQUIRED");

    const staleProjection = await post(sessionId!, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "capability_convergence_status",
        arguments: {
          clientProjectionToolNames: ["capability_convergence_status", "workspace_inspect"],
          requestRefresh: true,
        },
        _meta: { "openai/session": "issue-240-caller-a" },
      },
    });
    assert.equal(staleProjection.status, 200);
    const staleProjectionPayload = await parseResponse(staleProjection);
    assert.equal(
      staleProjectionPayload.result?.structuredContent?.clientProjectionConvergence?.state,
      "SERVER_AHEAD_OF_CLIENT",
    );
    assert.equal(
      staleProjectionPayload.result?.structuredContent?.sessionConvergence?.controllerDisposition,
      "STALE_RECONNECT_REQUIRED",
    );
    assert.equal(staleProjectionPayload.result?.structuredContent?.refresh?.notificationSent, false);
    assert.equal(staleProjectionPayload.result?.structuredContent?.refresh?.alreadyAttempted, true);
    assert.equal(staleProjectionPayload.result?.structuredContent?.refresh?.sameActorPreserved, true);
    assert.equal(staleProjectionPayload.result?.structuredContent?.refresh?.nextAction, "RECONNECT_REQUIRED");

    const crossSessionRefresh = await post(sessionId!, {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "capability_convergence_status",
        arguments: {
          sessionId: secondSessionId,
          clientProjectionToolNames: ["capability_convergence_status", "workspace_inspect"],
          requestRefresh: true,
        },
        _meta: { "openai/session": "issue-240-caller-a" },
      },
    });
    assert.equal(crossSessionRefresh.status, 200);
    const crossSessionPayload = await parseResponse(crossSessionRefresh);
    assert.equal(crossSessionPayload.result?.structuredContent?.refresh?.eligible, true);
    assert.equal(crossSessionPayload.result?.structuredContent?.refresh?.notificationSent, false);
    assert.equal(crossSessionPayload.result?.structuredContent?.refresh?.sameActorPreserved, false);
    assert.equal(crossSessionPayload.result?.structuredContent?.refresh?.nextAction, "RECONNECT_REQUIRED");

    const refreshedProjection = await post(sessionId!, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "capability_convergence_status",
        arguments: {
          clientProjectionToolNames: session!.serverGeneration!.toolNames!,
          requestRefresh: false,
        },
        _meta: { "openai/session": "issue-240-caller-a" },
      },
    });
    assert.equal(refreshedProjection.status, 200);
    const refreshedProjectionPayload = await parseResponse(refreshedProjection);
    assert.equal(
      refreshedProjectionPayload.result?.structuredContent?.clientProjectionConvergence?.state,
      "CURRENT",
    );
    assert.equal(
      refreshedProjectionPayload.result?.structuredContent?.sessionConvergence?.controllerDisposition,
      "CURRENT",
    );

    const changedCaller = await post(sessionId!, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "capability_convergence_status",
        arguments: {},
        _meta: { "openai/session": "issue-240-caller-b" },
      },
    });
    assert.equal(changedCaller.status, 200);
    const changedPayload = await parseResponse(changedCaller);
    assert.equal(
      changedPayload.result?.structuredContent?.sessionConvergence?.controllerDisposition,
      "CALLER_REBIND_REQUIRED",
    );


    const blockedDifferentCaller = await post(sessionId!, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "workspace_inspect",
        arguments: {},
        _meta: { "openai/session": "issue-240-caller-b" },
      },
    });
    assert.equal(blockedDifferentCaller.status, 409);
    const blockedPayload = await blockedDifferentCaller.json() as Record<string, any>;
    assert.match(blockedPayload.error?.message ?? "", /CALLER_REBIND_REQUIRED/);
    assert.equal(blockedPayload.error?.data?.controllerDisposition, "CALLER_REBIND_REQUIRED");
    assert.equal(blockedPayload.error?.data?.callerRebindRequired, true);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Issue #159: authenticated old session can rebind after server restart through tools/list", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-159-http-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  await mkdir(project, { recursive: true });
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as AddressInfo;
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
    probe.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const mcpUrl = `${baseUrl}/mcp`;
  const accessToken = "issue-159-access-token";
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: baseUrl,
    PORT: String(port),
  });
  const oauthStore = new SqliteOAuthStore(stateDir);
  const clientsStore = new SqliteOAuthClientsStore(oauthStore, ["127.0.0.1", "localhost"]);
  const clientRecord = clientsStore.registerClient({
    redirect_uris: [`${baseUrl}/callback`],
    client_name: "issue-159-client",
  });
  oauthStore.saveTokenPair({
    accessTokenHash: createHash("sha256").update(accessToken).digest("base64url"),
    accessToken: {
      clientId: clientRecord.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl,
    },
    refreshTokenHash: createHash("sha256").update("issue-159-refresh").digest("base64url"),
    refreshToken: {
      clientId: clientRecord.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl,
    },
  });
  oauthStore.close();

  const post = (sessionId: string, body: unknown, token = accessToken) => fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json, text/event-stream",
      "Connection": "close",
      "mcp-protocol-version": "2024-11-05",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const parseResponse = async (response: globalThis.Response): Promise<Record<string, any>> => {
    const text = await response.text();
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(dataLine ? dataLine.slice(6) : text) as Record<string, any>;
  };
  let firstListener: ReturnType<ReturnType<typeof createServer>["app"]["listen"]> | undefined;
  let secondListener: ReturnType<ReturnType<typeof createServer>["app"]["listen"]> | undefined;
  let thirdListener: ReturnType<ReturnType<typeof createServer>["app"]["listen"]> | undefined;
  let first: ReturnType<typeof createServer> | undefined;
  let second: ReturnType<typeof createServer> | undefined;
  let third: ReturnType<typeof createServer> | undefined;
  try {
    first = createServer(config);
    firstListener = first.app.listen(port, "127.0.0.1");
    await new Promise<void>((resolve) => firstListener?.once("listening", resolve));
    const initialized = await post("", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "issue-159-client", version: "1.0.0" },
      },
    });
    assert.equal(initialized.status, 200);
    const oldSessionId = initialized.headers.get("mcp-session-id");
    assert.match(oldSessionId ?? "", /^[0-9a-f-]{36}$/);

    await new Promise<void>((resolve) => firstListener?.close(() => resolve()));
    await first.close();
    firstListener = undefined;
    first = undefined;

    second = createServer(config);
    secondListener = second.app.listen(port, "127.0.0.1");
    await new Promise<void>((resolve) => secondListener?.once("listening", resolve));

    const reboundTools = await post(oldSessionId!, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(reboundTools.status, 200);
    const reboundPayload = await parseResponse(reboundTools);
    assert.ok(Array.isArray(reboundPayload.result?.tools));
    const reboundSessionId = reboundTools.headers.get("mcp-session-id") ?? oldSessionId!;

    const originalTransportClose = StreamableHTTPServerTransport.prototype.close;
    // Hold the first displaced transport close after removal so the second
    // HTTP rebind can install the survivor before the loser close callback.
    let releaseClosingTransport!: () => void;
    let observeClosingTransport!: () => void;
    const releaseClose = new Promise<void>((resolve) => { releaseClosingTransport = resolve; });
    const closeStarted = new Promise<void>((resolve) => { observeClosingTransport = resolve; });
    let blockNextClose = true;
    StreamableHTTPServerTransport.prototype.close = async function () {
      if (blockNextClose) {
        blockNextClose = false;
        observeClosingTransport();
        await releaseClose;
      }
      await originalTransportClose.call(this);
    };
    try {
      const firstConcurrentRebind = post(reboundSessionId, { jsonrpc: "2.0", id: 20, method: "tools/list", params: {} });
      await closeStarted;
      const secondConcurrentRebind = post(reboundSessionId, { jsonrpc: "2.0", id: 21, method: "tools/list", params: {} });
      const secondConcurrentResponse = await secondConcurrentRebind;
      assert.ok([200, 503].includes(secondConcurrentResponse.status));
      await secondConcurrentResponse.text();
      releaseClosingTransport();
      const firstConcurrentResponse = await firstConcurrentRebind;
      assert.ok([200, 503].includes(firstConcurrentResponse.status));
      await firstConcurrentResponse.text();
      assert.deepEqual(
        [firstConcurrentResponse.status, secondConcurrentResponse.status].sort((a, b) => a - b),
        [200, 503],
      );
    } finally {
      StreamableHTTPServerTransport.prototype.close = originalTransportClose;
      releaseClosingTransport();
    }
    const survivor = await post(reboundSessionId, { jsonrpc: "2.0", id: 22, method: "tools/list", params: {} });
    assert.equal(survivor.status, 200);
    const survivorPayload = await parseResponse(survivor);
    assert.ok(Array.isArray(survivorPayload.result?.tools));

    const consequential = await post(reboundSessionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "open_workspace", arguments: { path: project } },
    });
    const consequentialText = await consequential.text();
    assert.equal(consequential.status, 200, consequentialText);
    const consequentialDataLine = consequentialText.split("\n").find((line) => line.startsWith("data: "));
    const consequentialPayload = JSON.parse(consequentialDataLine ? consequentialDataLine.slice(6) : consequentialText) as Record<string, any>;
    assert.doesNotMatch(JSON.stringify(consequentialPayload), /RECONNECT_REQUIRED|STALE_MCP_SESSION/);

    const unauthenticatedUnknown = await post("22222222-2222-4222-8222-222222222222", { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }, "");
    assert.equal(unauthenticatedUnknown.status, 401);
    const malformed = await post("not-a-session-id", { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
    assert.notEqual(malformed.status, 200);

    const closed = await fetch(mcpUrl, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json, text/event-stream",
        "Connection": "close",
        "mcp-protocol-version": "2024-11-05",
        "mcp-session-id": reboundSessionId,
      },
    });
    const closedText = await closed.text();
    assert.equal(closed.status, 200, closedText);
    const afterClose = await post(reboundSessionId, { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} });
    assert.notEqual(afterClose.status, 200);

    await new Promise<void>((resolve) => secondListener?.close(() => resolve()));
    await second.close();
    secondListener = undefined;
    second = undefined;
    new CutoverStateStore(stateDir).begin({
      oldServerIdentity: { serverInstanceId: "issue-159-old", sourceCommit: "old", buildId: "old" },
      expectedNewIdentity: { sourceCommit: "new", buildId: "new" },
    });
    third = createServer(config);
    thirdListener = third.app.listen(port, "127.0.0.1");
    await new Promise<void>((resolve) => thirdListener?.once("listening", resolve));
    const nonNormal = await post("11111111-1111-4111-8111-111111111111", { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
    assert.notEqual(nonNormal.status, 200);
  } finally {
    if (thirdListener) await new Promise<void>((resolve) => thirdListener?.close(() => resolve()));
    await third?.close();
    if (secondListener) await new Promise<void>((resolve) => secondListener?.close(() => resolve()));
    await second?.close();
    if (firstListener) await new Promise<void>((resolve) => firstListener?.close(() => resolve()));
    await first?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Issue #163: restart preserves durable refresh rotation and classifies token failures without secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-163-oauth-http-"));
  const stateDir = join(root, "state");
  const ownerToken = "issue-163-owner-token-that-is-long-enough";
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as AddressInfo;
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const mcpUrl = `${baseUrl}/mcp`;
  const redirectUri = `${baseUrl}/callback`;
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
    DEVSPACE_PUBLIC_BASE_URL: baseUrl,
    PORT: String(port),
  });
  const seed = new SingleUserOAuthProvider(config.oauth, new URL("/mcp", config.publicBaseUrl), stateDir);
  const registeredClient = await seed.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "issue-163-client",
    token_endpoint_auth_method: "none",
  });
  assert.ok(registeredClient);
  const client = registeredClient;
  const seedCode = "issue-163-seed-code";
  const codeVerifier = "issue-163-code-verifier";
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  seed["codes"].set(seedCode, {
    clientId: client.client_id,
    params: {
      redirectUri,
      codeChallenge,
      scopes: config.oauth.scopes,
      resource: new URL(mcpUrl),
    },
    expiresAtMs: Date.now() + 60_000,
  });
  const initial = await seed.exchangeAuthorizationCode(client, seedCode, undefined, redirectUri, new URL(mcpUrl));
  seed.close();

  const encode = (body: Record<string, string>) => new URLSearchParams(body).toString();
  const postToken = (body: Record<string, string>, contentType: "form" | "json" = "form") => fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: {
      "Content-Type": contentType === "form" ? "application/x-www-form-urlencoded" : "application/json",
      Accept: "application/json",
      Connection: "close",
    },
    body: contentType === "form" ? encode(body) : JSON.stringify(body),
  });
  const noSecrets = async (response: Response, secrets: string[]) => {
    const text = await response.text();
    for (const secret of secrets) assert.equal(text.includes(secret), false, `response leaked ${secret}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
  const start = async () => {
    const running = createServer(config);
    const listener = running.app.listen(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      listener.once("listening", () => resolve());
      listener.once("error", reject);
    });
    return { running, listener };
  };

  let first: Awaited<ReturnType<typeof start>> | undefined;
  let second: Awaited<ReturnType<typeof start>> | undefined;
  try {
    first = await start();
    const rotatedResponse = await postToken({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: initial.refresh_token!,
      resource: mcpUrl,
    });
    assert.equal(rotatedResponse.status, 200);
    const rotated = await rotatedResponse.json() as { refresh_token?: string };
    assert.ok(rotated.refresh_token);

    const replay = await postToken({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: initial.refresh_token!,
      resource: mcpUrl,
    });
    assert.equal(replay.status, 400);
    const replayBody = await noSecrets(replay, [initial.refresh_token!, ownerToken, client.client_id]);
    assert.equal(replayBody.error, "invalid_grant");
    assert.equal(replayBody.failure_class, "invalid_refresh_token");

    await new Promise<void>((resolve) => first?.listener.close(() => resolve()));
    await first.running.close();
    first = undefined;

    second = await start();
    const afterRestart = await postToken({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: rotated.refresh_token!,
      resource: mcpUrl,
    }, "json");
    assert.equal(afterRestart.status, 200);
    const afterRestartBody = await afterRestart.json() as { refresh_token?: string };
    assert.ok(afterRestartBody.refresh_token);

    const replayAfterRestart = await postToken({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: initial.refresh_token!,
      resource: mcpUrl,
    }, "json");
    assert.equal(replayAfterRestart.status, 400);
    const replayAfterRestartBody = await noSecrets(replayAfterRestart, [initial.refresh_token!, ownerToken, client.client_id]);
    assert.equal(replayAfterRestartBody.error, "invalid_grant");
    assert.equal(replayAfterRestartBody.failure_class, "invalid_refresh_token");

    const scopeEscalation = await postToken({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: afterRestartBody.refresh_token!,
      resource: mcpUrl,
      scope: "devspace escalated",
    });
    assert.equal(scopeEscalation.status, 400);
    const scopeEscalationBody = await noSecrets(scopeEscalation, [afterRestartBody.refresh_token!, ownerToken, client.client_id]);
    assert.equal(scopeEscalationBody.error, "access_denied");
    assert.equal(scopeEscalationBody.error_description, "Refresh token cannot grant requested scopes");
    assert.equal(Object.hasOwn(scopeEscalationBody, "failure_class"), false);

    const invalidResource = await postToken({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: afterRestartBody.refresh_token!,
      resource: "https://attacker.invalid/mcp?secret=redirect-query",
    });
    assert.equal(invalidResource.status, 400);
    const invalidResourceBody = await noSecrets(invalidResource, [afterRestartBody.refresh_token!, ownerToken, "redirect-query"]);
    assert.equal(invalidResourceBody.error, "invalid_grant");
    assert.equal(invalidResourceBody.failure_class, "invalid_resource");

    const invalidCode = await postToken({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code: "stale-authorization-code",
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      resource: mcpUrl,
    });
    assert.equal(invalidCode.status, 400);
    const invalidCodeBody = await noSecrets(invalidCode, ["stale-authorization-code", ownerToken, client.client_id]);
    assert.equal(invalidCodeBody.error, "invalid_grant");
    assert.equal(invalidCodeBody.failure_class, "invalid_authorization_code");

    const authorizationParams = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      scope: config.oauth.scopes.join(" "),
      resource: mcpUrl,
    };
    const authorizationPage = await fetch(`${baseUrl}/authorize?${encode(authorizationParams)}`);
    assert.equal(authorizationPage.status, 200);
    const authorization = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: encode({ ...authorizationParams, owner_token: ownerToken }),
    });
    assert.equal(authorization.status, 302);
    const issuedCode = new URL(authorization.headers.get("location") ?? "https://invalid.invalid").searchParams.get("code");
    assert.ok(issuedCode);

    const wrongVerifier = await postToken({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code: issuedCode,
      code_verifier: "issue-163-wrong-verifier",
      redirect_uri: redirectUri,
      resource: mcpUrl,
    });
    assert.equal(wrongVerifier.status, 400);
    const wrongVerifierBody = await noSecrets(wrongVerifier, [issuedCode, ownerToken, client.client_id]);
    assert.equal(wrongVerifierBody.error, "invalid_grant");
    assert.equal(wrongVerifierBody.error_description, "code_verifier does not match the challenge");
    assert.equal(Object.hasOwn(wrongVerifierBody, "failure_class"), false);

    const invalidRedirect = await postToken({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code: issuedCode,
      code_verifier: codeVerifier,
      redirect_uri: `${baseUrl}/wrong?redirect-secret=query-value`,
      resource: mcpUrl,
    });
    assert.equal(invalidRedirect.status, 400);
    const invalidRedirectBody = await noSecrets(invalidRedirect, [issuedCode, ownerToken, "query-value"]);
    assert.equal(invalidRedirectBody.error, "invalid_grant");
    assert.equal(invalidRedirectBody.failure_class, "invalid_redirect");

    const malformed = await postToken({ client_id: client.client_id });
    assert.equal(malformed.status, 400);
    const malformedBody = await noSecrets(malformed, [ownerToken, client.client_id]);
    assert.equal(malformedBody.error, "invalid_request");
    assert.equal(malformedBody.failure_class, "request_shape_validation");

    const malformedJson = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Connection: "close",
      },
      body: `{"grant_type":"refresh_token","refresh_token":"malformed-json-token",`,
    });
    assert.equal(malformedJson.status, 400);
    const malformedJsonBody = await noSecrets(malformedJson, ["malformed-json-token", ownerToken, client.client_id]);
    assert.equal(malformedJsonBody.error, "invalid_request");
    assert.equal(malformedJsonBody.failure_class, "request_shape_validation");
  } finally {
    if (second) {
      await new Promise<void>((resolve) => second?.listener.close(() => resolve()));
      await second.running.close();
    }
    if (first) {
      await new Promise<void>((resolve) => first?.listener.close(() => resolve()));
      await first.running.close();
    }
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
      DEVSPACE_STATE_DIR: stateDir, DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      DEVSPACE_TOOL_MODE: "full", PORT: "1" });
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
    DEVSPACE_STATE_DIR: stateDir, DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_TOOL_MODE: "full", PORT: "1" });
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

test("Issue #378: coordination-bound cutover reconcile remains fail-closed without carrier binding",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devspace-bound-advance-"));
  const config=loadConfig({DEVSPACE_CONFIG_DIR:join(root,"config"),DEVSPACE_ALLOWED_ROOTS:root,DEVSPACE_STATE_DIR:join(root,"state"),DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-that-is-long-enough",DEVSPACE_TOOL_MODE:"full",PORT:"1"});
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

test("Issue #338: Direct Coding canary completes open -> inspect -> edit -> test -> commit -> push without Core mutation tool calls", async (t) => {
  const conversation = { "openai/session": "chatgpt-direct-coding-canary" };
  const context = await fixture(t, {
    git: true,
    gitCandidates: true,
    coreMutation: true,
    toolMode: "minimal",
  });

  const bare = join(dirname(context.project), "canary-remote.git");
  await execFileAsync("git", ["init", "--bare", "--initial-branch=main", bare]);
  await execFileAsync("git", ["remote", "add", "origin", bare], { cwd: context.project });
  await execFileAsync("git", ["push", "origin", "main"], { cwd: context.project });

  // 1. open_workspace (worktree mode)
  const opened = await callOpen(context.client, context.project, conversation["openai/session"], "worktree");
  assert.equal(opened.isError, undefined);
  const workspace = structuredContent(opened) as Record<string, any>;
  const workspaceId = workspace.workspaceId as string;
  const worktreeRoot = workspace.root as string;
  assert.ok(workspaceId);
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreeRoot })).stdout.trim();

  // 2. inspect (read)
  const readRes = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "README.md" },
    _meta: conversation,
  });
  assert.equal(readRes.isError, undefined);
  assert.match(responseText(readRes), /hello/);

  // 3. edit / write (bounded file mutation)
  const writeRes = await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "feature.js", content: "module.exports = { version: 1 };\n" },
    _meta: conversation,
  });
  assert.equal(writeRes.isError, undefined);
  assert.equal(structuredContent(writeRes).coreMutation, undefined);

  const editRes = await context.client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      path: "feature.js",
      edits: [{ oldText: "version: 1", newText: "version: 2" }],
    },
    _meta: conversation,
  });
  assert.equal(editRes.isError, undefined);
  assert.equal(structuredContent(editRes).coreMutation, undefined);
  assert.equal(readFileSync(join(worktreeRoot, "feature.js"), "utf8"), "module.exports = { version: 2 };\n");

  // 4. test (bash execution, exitCode 0)
  const testRes = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${JSON.stringify(process.execPath)} -e "const f = require('./feature.js'); if (f.version !== 2) process.exit(1); console.log('PASS');"`,
      attemptKey: "canary-test-run",
    },
    _meta: conversation,
  });
  assert.equal(testRes.isError, undefined);
  assert.equal(structuredContent(testRes).coreMutation, undefined);
  assert.equal(structuredContent(testRes).exitCode, 0);

  // Negative control: wrong expectedHead blocks commit
  const badCommit = await context.client.callTool({
    name: "git_commit",
    arguments: {
      workspaceId,
      attemptKey: "canary-bad-head-push",
      expectedHead: "0".repeat(40),
      message: "bad commit",
      paths: ["feature.js"],
    },
    _meta: conversation,
  });
  assert.equal(badCommit.isError, true);
  assert.match(responseText(badCommit), /expected/i);

  // Negative control: out of root file write blocks
  const badWrite = await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "../outside.txt", content: "escape\n" },
    _meta: conversation,
  });
  assert.equal(badWrite.isError, true);

  // 5. git_commit (with expectedHead)
  const commitRes = await context.client.callTool({
    name: "git_commit",
    arguments: {
      workspaceId,
      expectedHead: head,
      message: "feat: add feature module",
      paths: ["feature.js"],
    },
    _meta: conversation,
  });
  assert.equal(commitRes.isError, undefined, responseText(commitRes));
  const commitData = structuredContent(commitRes) as Record<string, any>;
  assert.equal(commitData.created, true);
  assert.equal(commitData.coreMutation, undefined);
  const commitSha = commitData.commitSha as string;
  assert.ok(commitSha);

  // Negative control: wrong expectedHead blocks push
  const badPush = await context.client.callTool({
    name: "git_push",
    arguments: {
      workspaceId,
      expectedHead: "0".repeat(40),
      remote: "origin",
      branch: "feat/canary-branch",
    },
    _meta: conversation,
  });
  assert.equal(badPush.isError, true);
  assert.match(responseText(badPush), /expected/i);

  // Negative control: push to default branch is blocked
  const defaultBranchPush = await context.client.callTool({
    name: "git_push",
    arguments: {
      workspaceId,
      attemptKey: "canary-default-branch-push",
      expectedHead: commitSha,
      remote: "origin",
      branch: "main",
    },
    _meta: conversation,
  });
  assert.equal(defaultBranchPush.isError, true);
  assert.match(responseText(defaultBranchPush), /default branch/i);

  // 6. git_push (to non-default branch)
  const pushRes = await context.client.callTool({
    name: "git_push",
    arguments: {
      workspaceId,
      attemptKey: "canary-valid-push",
      expectedHead: commitSha,
      remote: "origin",
      branch: "feat/canary-branch",
    },
    _meta: conversation,
  });
  assert.equal(pushRes.isError, undefined, responseText(pushRes));
  const pushData = structuredContent(pushRes) as Record<string, any>;
  assert.equal(pushData.branch, "feat/canary-branch");
  assert.equal(pushData.pushedSha, commitSha);
  assert.equal(pushData.coreMutation, undefined);

  // Verify the push reached the remote bare repository
  const remoteSha = (await execFileAsync("git", ["rev-parse", "refs/heads/feat/canary-branch"], { cwd: bare })).stdout.trim();
  assert.equal(remoteSha, commitSha);
});
