import assert from "node:assert/strict";
import { NEXUS_GATEWAY_TOOL_NAMES, NexusGatewayProxyError, forwardNexusGatewayTool } from "./nexus-gateway-proxy.js";
import type { ServerConfig } from "./config.js";

const config = {
  gatewayProxyUrl: "http://127.0.0.1:8766",
  gatewayProxyToken: "gateway-token-that-is-long-enough",
} as ServerConfig;

assert.deepEqual(NEXUS_GATEWAY_TOOL_NAMES, [
  "nexus_gateway_status",
  "nexus_workspace_snapshot",
  "nexus_read",
  "nexus_search",
  "nexus_git_diff",
  "nexus_task_run",
  "nexus_task_status",
  "nexus_task_wait",
  "nexus_task_finish",
  "nexus_task_cancel",
]);

const originalFetch = globalThis.fetch;
let request: { url: string; init?: RequestInit } | undefined;
globalThis.fetch = (async (input, init) => {
  request = { url: String(input), init };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "test", result: { content: [{ type: "text", text: "ok" }] } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

try {
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
