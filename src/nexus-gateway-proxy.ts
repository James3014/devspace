import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";

export const NEXUS_GATEWAY_TOOL_NAMES = [
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
] as const;

const GATEWAY_TOOL_DESCRIPTIONS: Record<string, string> = {
  nexus_gateway_status: "Read the canonical Nexus gateway identity and lifecycle counts.",
  nexus_workspace_snapshot: "Read the canonical Nexus checkout snapshot without creating a Target.",
  nexus_read: "Read a bounded file inside the canonical Nexus checkout.",
  nexus_search: "Search bounded literal text inside the canonical Nexus checkout.",
  nexus_git_diff: "Read a bounded canonical Git diff.",
  nexus_task_run: "Route one bounded task through CapabilityPlanner and the governed three-lane lifecycle.",
  nexus_task_status: "Read one governed task status and next action.",
  nexus_task_wait: "Poll one bounded governed task until attention, terminal, or timeout.",
  nexus_task_finish: "Finish a Direct receipt or owner-finish an exact isolated Candidate binding.",
  nexus_task_cancel: "Cancel one governed task through formal lifecycle cleanup.",
};

export class NexusGatewayProxyError extends Error {}

export async function forwardNexusGatewayTool(
  config: ServerConfig,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<CallToolResult> {
  if (!config.gatewayProxyUrl || !config.gatewayProxyToken) {
    throw new NexusGatewayProxyError("gateway proxy is not configured");
  }

  const response = await fetch(`${config.gatewayProxyUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.gatewayProxyToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: { name, arguments: arguments_ },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const raw = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new NexusGatewayProxyError(`gateway returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new NexusGatewayProxyError(`gateway returned HTTP ${response.status}`);
  }
  if (!payload || typeof payload !== "object" || !("result" in payload)) {
    throw new NexusGatewayProxyError("gateway returned an invalid JSON-RPC response");
  }
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== "object") {
    throw new NexusGatewayProxyError("gateway returned a missing tool result");
  }
  return result as CallToolResult;
}

/**
 * Build the only public tool server exposed by DevSpace proxy mode.
 * The outer OAuth/Streamable HTTP transport remains DevSpace's responsibility;
 * all workspace and lifecycle semantics are owned by the canonical gateway.
 */
export function createNexusGatewayProxyServer(config: ServerConfig): McpServer {
  const server = new McpServer(
    {
      name: "nexus-mcp-gateway",
      title: "Nexus MCP Gateway",
      version: "0.1.0",
      description: "Authenticated proxy for the canonical Nexus three-lane MCP gateway.",
    },
    {
      instructions:
        "This endpoint exposes only the canonical Nexus gateway. Do not open a second workspace or use legacy DevSpace workspace/edit/shell tools.",
    },
  );

  for (const name of NEXUS_GATEWAY_TOOL_NAMES) {
    server.registerTool(
      name,
      {
        description: GATEWAY_TOOL_DESCRIPTIONS[name],
        inputSchema: z.object({}).passthrough(),
      },
      async (arguments_) => {
        try {
          return await forwardNexusGatewayTool(config, name, arguments_ as Record<string, unknown>);
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  schema: "nexus.gateway_proxy_error.v1",
                  error: error instanceof Error ? error.message : String(error),
                }),
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}
