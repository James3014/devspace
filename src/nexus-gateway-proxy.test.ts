import assert from "node:assert/strict";
import {
  NexusGatewayProxyError,
  createNexusGatewayProxyServer,
  fetchNexusGatewayToolManifest,
  forwardNexusGatewayTool,
} from "./nexus-gateway-proxy.js";
import type { ServerConfig } from "./config.js";

const config = {
  gatewayProxyUrl: "http://127.0.0.1:8766",
  gatewayProxyToken: "gateway-token-that-is-long-enough",
} as ServerConfig;

const originalFetch = globalThis.fetch;
let request: { url: string; init?: RequestInit } | undefined;
globalThis.fetch = (async (input, init) => {
  const body = JSON.parse(String(init?.body));
  request = { url: String(input), init };
  if (body.method === "tools/list") {
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: {
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
  assert.deepEqual(manifest.map((tool) => tool.name), ["nexus_gateway_status", "nexus_candidate_approve"]);
  assert.equal(manifest[1]?.inputSchema.properties?.approval?.properties?.schema?.const, "nexus.approval.v2");

  const proxyServer = await createNexusGatewayProxyServer(config);
  const registeredTools = (proxyServer as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
  assert.deepEqual(Object.keys(registeredTools ?? {}).sort(), ["nexus_candidate_approve", "nexus_gateway_status"]);

  const result = await forwardNexusGatewayTool(config, "nexus_gateway_status", { detail: true });
  assert.deepEqual(result, { content: [{ type: "text", text: "ok" }] });
  assert.equal(request?.url, "http://127.0.0.1:8766/mcp");
  assert.equal(request?.init?.method, "POST");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), `Bearer ${config.gatewayProxyToken}`);
  assert.deepEqual(JSON.parse(String(request?.init?.body)).params, {
    name: "nexus_gateway_status",
    arguments: { detail: true },
  });

  globalThis.fetch = (async () => new Response("not-json", { status: 502 })) as typeof fetch;
  await assert.rejects(
    () => forwardNexusGatewayTool(config, "nexus_gateway_status", {}),
    (error: unknown) => error instanceof NexusGatewayProxyError && /non-JSON HTTP 502/.test(error.message),
  );
} finally {
  globalThis.fetch = originalFetch;
}
