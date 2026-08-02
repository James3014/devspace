import assert from "node:assert/strict";
import {
  NexusGatewayProxyError,
  createNexusGatewayProxyServer,
  fetchNexusGatewayToolManifest,
  forwardNexusGatewayTool,
  nexusGatewayManifestIdentity,
  nexusGatewayToolManifestSha256,
} from "./nexus-gateway-proxy.js";
import type { ServerConfig } from "./config.js";
import { createMcpTransportBoundary, MODERN_MCP_PROTOCOL_VERSION } from "./mcp-transport.js";

const config = {
  gatewayProxyUrl: "http://127.0.0.1:8766",
  gatewayProxyToken: "gateway-token-that-is-long-enough",
} as ServerConfig;

const originalFetch = globalThis.fetch;
let request: { url: string; init?: RequestInit } | undefined;
let manifestFetches = 0;
globalThis.fetch = (async (input, init) => {
  const body = JSON.parse(String(init?.body));
  request = { url: String(input), init };
  if (body.method === "tools/list") {
    manifestFetches += 1;
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        manifest_revision: "gateway-revision-7",
        tools: [
          {
            name: "nexus_gateway_status",
            description: "Read the canonical gateway status.",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "nexus_candidate_approve",
            description: "Approve an exact candidate.",
            inputSchema: {
              type: "object",
              required: ["task_id", "approval"],
              properties: {
                task_id: { type: "string" },
                approval: {
                  type: "object",
                  required: ["schema"],
                  properties: { schema: { const: "nexus.approval.v2" } },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
          },
        ],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "test", result: { content: [{ type: "text", text: "ok" }] } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

try {
  const manifest = await fetchNexusGatewayToolManifest(config);
  assert.deepEqual(manifest.map((tool) => tool.name), ["nexus_candidate_approve", "nexus_gateway_status"]);
  assert.equal(manifest.revision, "gateway-revision-7");
  assert.equal(manifest.sha256, nexusGatewayToolManifestSha256(manifest));
  assert.deepEqual(nexusGatewayManifestIdentity(manifest), {
    count: 2,
    revision: `sha256:${manifest.sha256}`,
    sha256: manifest.sha256,
  });
  assert.equal(
    manifest.find((tool) => tool.name === "nexus_candidate_approve")?.inputSchema.properties?.approval?.properties?.schema?.const,
    "nexus.approval.v2",
  );

  const proxyServer = await createNexusGatewayProxyServer(config, manifest);
  assert.equal(manifestFetches, 1, "prepared startup manifest must be reused by every request factory");
  const registeredTools = (proxyServer as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
  assert.deepEqual(Object.keys(registeredTools ?? {}).sort(), ["nexus_candidate_approve", "nexus_gateway_status"]);

  const publicBoundary = createMcpTransportBoundary(
    () => createNexusGatewayProxyServer(config, manifest),
    "dual",
  );
  const toolsResponse = await publicBoundary.fetch(new Request("http://test.local/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": "tools/list",
      "mcp-protocol-version": MODERN_MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "proxy-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  }));
  assert.equal(toolsResponse.status, 200);
  assert.equal(toolsResponse.headers.has("mcp-session-id"), false);
  const publicPayload = JSON.parse(await toolsResponse.text());
  assert.deepEqual(
    publicPayload.result.tools.map((tool: { name: string }) => tool.name),
    ["nexus_candidate_approve", "nexus_gateway_status"],
  );
  assert.equal(publicPayload.result.resultType, "complete");
  await publicBoundary.close();

  const result = await forwardNexusGatewayTool(config, "nexus_gateway_status", { detail: true }, {
    requestId: "request-1",
    traceparent: "trace-parent",
    tracestate: "trace-state",
    baggage: "tenant=nexus",
    clientId: "client-1",
    principal: "owner",
    protocolVersion: "2026-07-28",
    taskId: "task-1",
    attemptId: "attempt-1",
  });
  assert.deepEqual(result, { content: [{ type: "text", text: "ok" }] });
  assert.equal(request?.url, "http://127.0.0.1:8766/mcp");
  assert.equal(request?.init?.method, "POST");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), `Bearer ${config.gatewayProxyToken}`);
  assert.equal(new Headers(request?.init?.headers).get("x-request-id"), "request-1");
  assert.equal(new Headers(request?.init?.headers).get("traceparent"), "trace-parent");
  assert.equal(new Headers(request?.init?.headers).get("tracestate"), "trace-state");
  assert.equal(new Headers(request?.init?.headers).get("baggage"), "tenant=nexus");
  assert.equal(new Headers(request?.init?.headers).get("x-nexus-mcp-client-id"), "client-1");
  assert.equal(new Headers(request?.init?.headers).get("x-nexus-mcp-principal"), "owner");
  assert.equal(new Headers(request?.init?.headers).get("mcp-protocol-version"), "2026-07-28");
  assert.equal(new Headers(request?.init?.headers).get("x-nexus-task-id"), "task-1");
  assert.equal(new Headers(request?.init?.headers).get("x-nexus-attempt-id"), "attempt-1");
  assert.deepEqual(JSON.parse(String(request?.init?.body)).params, {
    name: "nexus_gateway_status",
    arguments: { detail: true },
  });

  const acceptedByKey = new Map<string, { task_id: string; attempt_id: string }>();
  let mutationApplications = 0;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const params = body.params as { name: string; arguments: Record<string, unknown> };
    if (params.name === "nexus_submit_task") {
      const key = String(params.arguments.idempotency_key);
      let identity = acceptedByKey.get(key);
      if (!identity) {
        mutationApplications += 1;
        identity = { task_id: "task-long-1", attempt_id: "attempt-long-1" };
        acceptedByKey.set(key, identity);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: identity }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const identity = acceptedByKey.get(String(params.arguments.idempotency_key));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: identity }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const mutationArguments = { idempotency_key: "mutation-key-1", objective: "bounded long task" };
  const submitted = await forwardNexusGatewayTool(config, "nexus_submit_task", mutationArguments);
  const duplicate = await forwardNexusGatewayTool(config, "nexus_submit_task", mutationArguments);
  const recovered = await forwardNexusGatewayTool(config, "nexus_get_task", { idempotency_key: "mutation-key-1" });
  assert.deepEqual(submitted, { task_id: "task-long-1", attempt_id: "attempt-long-1" });
  assert.deepEqual(duplicate, submitted);
  assert.deepEqual(recovered, submitted);
  assert.equal(mutationApplications, 1, "existing downstream idempotency contract must apply once");

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        tools: [{ name: "write", inputSchema: { type: "object" } }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await assert.rejects(
    () => fetchNexusGatewayToolManifest(config),
    (error: unknown) => error instanceof NexusGatewayProxyError && /raw DevSpace tool write/.test(error.message),
  );

  globalThis.fetch = (async () => new Response("not-json", { status: 502 })) as typeof fetch;
  await assert.rejects(
    () => forwardNexusGatewayTool(config, "nexus_gateway_status", {}),
    (error: unknown) => error instanceof NexusGatewayProxyError && /non-JSON HTTP 502/.test(error.message),
  );
} finally {
  globalThis.fetch = originalFetch;
}
