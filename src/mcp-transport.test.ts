import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { loadConfig } from "./config.js";
import {
  createMcpTransportBoundary,
  extractMcpRequestTraceContext,
  MODERN_MCP_PROTOCOL_VERSION,
  type McpProtocolMode,
} from "./mcp-transport.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { createServer } from "./server.js";
import { readPackageBuildIdentity } from "./nexus-tools.js";

function createTestServer(): McpServer {
  const server = new McpServer(
    { name: "nexus-transport-test", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    "echo",
    {
      description: "Echo a bounded value.",
      inputSchema: z.object({ value: z.string() }),
    },
    async ({ value }) => ({
      content: [{ type: "text", text: value }],
      structuredContent: { value },
    }),
  );
  return server;
}

function modernRequest(method: string, params: Record<string, unknown>, id: number): Request {
  return new Request("http://test.local/mcp", {
    method: "POST",
    headers: {
      "accept": "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": MODERN_MCP_PROTOCOL_VERSION,
      "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "transport-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
          ...(params._meta as Record<string, unknown> | undefined),
        },
      },
    }),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (raw.startsWith("event:")) {
    const data = raw.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    if (!data) throw new Error(`SSE response did not contain data: ${raw}`);
    return JSON.parse(data) as Record<string, unknown>;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

for (const mode of ["dual", "modern"] satisfies McpProtocolMode[]) {
  const boundary = createMcpTransportBoundary(() => createTestServer(), mode);
  const discover = await boundary.fetch(modernRequest("server/discover", {}, 1));
  assert.equal(discover.status, 200, `${mode} discover status: ${await discover.clone().text()}`);
  assert.equal(discover.headers.has("mcp-session-id"), false);
  const discoverPayload = await json(discover);
  const discoverResult = discoverPayload.result as Record<string, unknown>;
  assert.equal(
    (discoverResult.supportedVersions as string[] | undefined)?.[0],
    MODERN_MCP_PROTOCOL_VERSION,
    JSON.stringify(discoverPayload),
  );
  assert.equal(discoverResult.resultType, "complete");
  assert.equal(typeof discoverResult.ttlMs, "number");
  assert.equal(typeof discoverResult.cacheScope, "string");

  for (let index = 0; index < 20; index += 1) {
    const response = await boundary.fetch(modernRequest("tools/list", {}, index + 2));
    assert.equal(response.status, 200, `${mode} modern call ${index + 1}`);
    assert.equal(response.headers.has("mcp-session-id"), false);
    const payload = await json(response);
    const result = payload.result as Record<string, unknown>;
    assert.equal(typeof result.resultType, "string");
    const tools = result.tools as Array<Record<string, unknown>>;
    assert.deepEqual(tools.map((tool) => tool.name), ["echo"]);
  }
  await boundary.close();
}

const legacyBoundary = createMcpTransportBoundary(() => createTestServer(), "dual");
const legacyInitialize = await legacyBoundary.fetch(new Request("http://test.local/mcp", {
  method: "POST",
  headers: {
    "accept": "application/json, text/event-stream",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "legacy-test", version: "1.0.0" },
    },
  }),
}));
assert.equal(legacyInitialize.status, 200);
assert.equal(legacyInitialize.headers.has("mcp-session-id"), false);
assert.equal((await json(legacyInitialize)).error, undefined);
await legacyBoundary.close();

const rollbackBoundary = createMcpTransportBoundary(() => createTestServer(), "legacy");
const modernRejected = await rollbackBoundary.fetch(modernRequest("server/discover", {}, 1));
assert.equal(modernRejected.status, 400);
assert.equal(((await json(modernRejected)).error as Record<string, unknown>).code, -32022);
await rollbackBoundary.close();

const traceBody = {
  method: "tools/call",
  params: {
    name: "nexus_task_status",
    arguments: { task_id: "task-1", attempt_id: "attempt-1" },
    _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_MCP_PROTOCOL_VERSION },
  },
};
const trace = extractMcpRequestTraceContext(
  new Request("http://test.local/mcp", {
    headers: {
      "x-request-id": "request-1",
      "traceparent": "trace-parent",
      "tracestate": "trace-state",
      "baggage": "tenant=nexus",
    },
  }),
  traceBody,
  {
    token: "must-not-leak",
    clientId: "client-1",
    scopes: ["devspace"],
    extra: { principal: "owner" },
  },
);
assert.deepEqual(trace, {
  requestId: "request-1",
  traceparent: "trace-parent",
  tracestate: "trace-state",
  baggage: "tenant=nexus",
  clientId: "client-1",
  principal: "owner",
  protocolVersion: MODERN_MCP_PROTOCOL_VERSION,
  toolName: "nexus_task_status",
  taskId: "task-1",
  attemptId: "attempt-1",
});
assert.equal(JSON.stringify(trace).includes("must-not-leak"), false);

// A transport restart must not invalidate an already durable workspace handle.
const root = await mkdtemp(join(tmpdir(), "devspace-mcp-restart-test-"));
try {
  const stateDir = join(root, ".state");
  const agentDir = join(root, ".agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(root, "README.md"), "restart-safe\n");
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".empty-config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    NEXUS_MCP_SURFACE_PROFILE: "raw_devspace",
    MCP_PROTOCOL_MODE: "dual",
  });
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const firstRegistry = new WorkspaceRegistry(config, firstStore);
  const opened = await firstRegistry.openWorkspace(root);
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  const secondRegistry = new WorkspaceRegistry(config, secondStore);
  const restored = secondRegistry.getWorkspace(opened.workspace.id);
  assert.equal(secondRegistry.resolvePath(restored, "README.md"), join(root, "README.md"));
  secondStore.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

// The real Express boundary publishes truthful identity and types an OAuth
// token lost across a process restart as an explicit reauthentication case.
const serverRoot = await mkdtemp(join(tmpdir(), "devspace-mcp-server-test-"));
try {
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(serverRoot, ".empty-config"),
    DEVSPACE_ALLOWED_ROOTS: serverRoot,
    DEVSPACE_STATE_DIR: join(serverRoot, ".state"),
    DEVSPACE_AGENT_DIR: join(serverRoot, ".agent"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_LOG_LEVEL: "silent",
    NEXUS_MCP_SURFACE_PROFILE: "raw_devspace",
    MCP_PROTOCOL_MODE: "dual",
  });
  const running = createServer(config);
  const listener = await new Promise<ReturnType<typeof running.app.listen>>((resolve) => {
    const instance = running.app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      name: "devspace",
      surface_profile: "raw_devspace",
      protocol_mode: "dual",
      tool_source: "devspace_builtin",
      observed_manifest_count: null,
      observed_manifest_revision: null,
      observed_manifest_sha256: null,
      effective_tool_count: null,
      local_protected_tool_count: null,
      local_protected_tools: null,
      proxy_mode: false,
      gateway_url: null,
      manifest_status: "not_applicable",
      build: readPackageBuildIdentity(),
    });

    const unauthenticated = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get("x-nexus-auth-disposition"), "REAUTH_REQUIRED");
  } finally {
    if (listener.listening) {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
    await running.close();
  }
} finally {
  await rm(serverRoot, { recursive: true, force: true });
}

// B-light v2 readiness gate: a Gateway tools/list manifest that collides with
// the server-local protected extension must fail closed at /healthz (503,
// ok=false, manifest_status=unavailable, disposition=PUBLIC_SURFACE_FAIL_CLOSED),
// NOT report a false-green healthy surface. A non-colliding manifest stays
// healthy with the hybrid identity.
{
  async function listenOnPort(running: ReturnType<typeof createServer>): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const listener = await new Promise<ReturnType<typeof running.app.listen>>((resolve) => {
      const instance = running.app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      close: async () => {
        if (listener.listening) {
          await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
        }
        await running.close();
      },
    };
  }

  async function proxyServer(base: string): Promise<ReturnType<typeof createServer>> {
    const stateDir = join(base, ".state");
    return createServer(loadConfig({
      DEVSPACE_CONFIG_DIR: join(base, ".empty-config"),
      DEVSPACE_ALLOWED_ROOTS: base,
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_AGENT_DIR: join(base, ".agent"),
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      DEVSPACE_LOG_LEVEL: "silent",
      NEXUS_MCP_SURFACE_PROFILE: "canonical_gateway_proxy",
      NEXUS_GATEWAY_PROXY_URL: "http://127.0.0.1:8766",
      NEXUS_GATEWAY_PROXY_TOKEN: "gateway-token-that-is-long-enough",
      MCP_PROTOCOL_MODE: "dual",
    }));
  }

  function stubGatewayManifest(tools: Array<Record<string, unknown>>): typeof fetch {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (!url.startsWith("http://127.0.0.1:8766")) {
        return originalFetch(input, init);
      }
      const bodyText = init ? String(init.body ?? "") : "";
      let body: { method?: string; id?: unknown } | undefined;
      try {
        body = bodyText ? JSON.parse(bodyText) : undefined;
      } catch {
        body = undefined;
      }
      if (body?.method === "tools/list") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { manifest_revision: "gateway-revision-7", tools },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return originalFetch;
  }

  const readinessRoot = await mkdtemp(join(tmpdir(), "devspace-mcp-readiness-test-"));
  const originalFetch = globalThis.fetch;
  try {
    // Colliding manifest -> fail-closed readiness.
    {
      stubGatewayManifest([
        { name: "nexus_gateway_status", description: "status", inputSchema: { type: "object", properties: {} } },
        { name: "git_merge_pull_request", description: "gateway-owned", inputSchema: { type: "object", properties: {} } },
      ]);
      const running = await proxyServer(join(readinessRoot, "collision"));
      const bound = await listenOnPort(running);
      try {
        const health = await fetch(`${bound.baseUrl}/healthz`);
        assert.equal(health.status, 503, "colliding manifest must not be healthy");
        const body = await health.json();
        assert.equal(body.ok, false);
        assert.equal(body.manifest_status, "unavailable");
        assert.equal(body.disposition, "PUBLIC_SURFACE_FAIL_CLOSED");
        assert.equal(body.observed_manifest_count, null, "readiness must not claim an observed manifest on collision");
      } finally {
        await bound.close();
      }
    }

    // Non-colliding manifest -> healthy with hybrid identity.
    {
      stubGatewayManifest([
        { name: "nexus_gateway_status", description: "status", inputSchema: { type: "object", properties: {} } },
        { name: "nexus_candidate_approve", description: "approve", inputSchema: { type: "object", properties: {} } },
      ]);
      const running = await proxyServer(join(readinessRoot, "healthy"));
      const bound = await listenOnPort(running);
      try {
        const health = await fetch(`${bound.baseUrl}/healthz`);
        assert.equal(health.status, 200, "non-colliding manifest must stay healthy");
        const body = await health.json();
        assert.equal(body.ok, true);
        assert.equal(body.manifest_status, "verified");
        assert.equal(body.tool_source, "canonical_gateway_manifest_plus_local_protected");
        assert.equal(body.observed_manifest_count, 2);
        assert.equal(body.effective_tool_count, 4);
        assert.equal(body.local_protected_tool_count, 2);
        assert.deepEqual(body.local_protected_tools, [
          "git_merge_pull_request",
          "github_complete_pull_request",
        ]);
      } finally {
        await bound.close();
      }
    }

    // D2: the running proxy must converge from M1 -> M2 in-process. The same
    // process may never remain health-200 on the stale M1 identity after the
    // inner Gateway advertises M2, and a later unreadable Gateway fails closed.
    {
      let revision = "gateway-revision-m1";
      let tools = [
        { name: "nexus_gateway_status", description: "status", inputSchema: { type: "object", properties: {} } },
      ];
      let unavailable = false;
      let toolsListCalls = 0;
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (!url.startsWith("http://127.0.0.1:8766")) {
          return originalFetch(input, init);
        }
        if (unavailable) {
          throw new Error("inner gateway unavailable");
        }
        const bodyText = init ? String(init.body ?? "") : "";
        const body = bodyText ? JSON.parse(bodyText) as { method?: string; id?: unknown } : undefined;
        if (body?.method === "tools/list") {
          toolsListCalls += 1;
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { manifest_revision: revision, tools },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const running = await proxyServer(join(readinessRoot, "manifest-rebind"));
      const bound = await listenOnPort(running);
      try {
        const m1 = await fetch(`${bound.baseUrl}/healthz`);
        assert.equal(m1.status, 200);
        const m1Body = await m1.json();
        assert.equal(m1Body.observed_manifest_revision, "gateway-revision-m1");
        assert.equal(m1Body.observed_manifest_count, 1);

        revision = "gateway-revision-m2";
        tools = [
          { name: "nexus_gateway_status", description: "status", inputSchema: { type: "object", properties: {} } },
          { name: "nexus_owner_standing_grant_issue", description: "issue grant", inputSchema: { type: "object", properties: {} } },
        ];

        const m2 = await fetch(`${bound.baseUrl}/healthz`);
        assert.equal(m2.status, 200, "M2 must replace the stale registered M1 boundary in-process");
        const m2Body = await m2.json();
        assert.equal(m2Body.observed_manifest_revision, "gateway-revision-m2");
        assert.equal(m2Body.observed_manifest_count, 2);
        assert.equal(m2Body.effective_tool_count, 4);
        assert.ok(toolsListCalls >= 3, "health must fresh-read Gateway identity rather than reuse startup Promise");

        unavailable = true;
        const failed = await fetch(`${bound.baseUrl}/healthz`);
        assert.equal(failed.status, 503, "fresh Gateway read failure must fail closed");
        const failedBody = await failed.json();
        assert.equal(failedBody.ok, false);
        assert.equal(failedBody.manifest_status, "unavailable");
        assert.equal(failedBody.disposition, "PUBLIC_SURFACE_FAIL_CLOSED");

        unavailable = false;
        const recovered = await fetch(`${bound.baseUrl}/healthz`);
        assert.equal(recovered.status, 200, "same process must recover after the inner Gateway is readable");
        const recoveredBody = await recovered.json();
        assert.equal(recoveredBody.observed_manifest_revision, "gateway-revision-m2");
      } finally {
        await bound.close();
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(readinessRoot, { recursive: true, force: true });
  }
}
