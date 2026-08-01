import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";

type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  additionalProperties?: boolean | JsonSchema;
  default?: unknown;
  [key: string]: unknown;
};

export interface NexusGatewayToolSpec {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}

type JsonRpcResponse = {
  result?: unknown;
  error?: { code?: number; message?: string };
};

export class NexusGatewayProxyError extends Error {}

async function gatewayJsonRpc(
  config: ServerConfig,
  method: string,
  params: Record<string, unknown>,
): Promise<JsonRpcResponse> {
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
      method,
      params,
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
  if (!payload || typeof payload !== "object") {
    throw new NexusGatewayProxyError("gateway returned an invalid JSON-RPC response");
  }
  const result = payload as JsonRpcResponse;
  if (result.error) {
    throw new NexusGatewayProxyError(`gateway JSON-RPC error ${result.error.code ?? "unknown"}: ${result.error.message ?? "unknown"}`);
  }
  return result;
}

/**
 * Read the canonical gateway manifest at runtime.  The external connector does
 * not maintain a second tool-name or schema registry: if the canonical gateway
 * cannot be reached, initialization fails closed instead of advertising stale
 * tools to ChatGPT.
 */
export async function fetchNexusGatewayToolManifest(config: ServerConfig): Promise<NexusGatewayToolSpec[]> {
  const response = await gatewayJsonRpc(config, "tools/list", {});
  const result = response.result;
  if (!result || typeof result !== "object" || !Array.isArray((result as { tools?: unknown }).tools)) {
    throw new NexusGatewayProxyError("gateway tools/list returned an invalid manifest");
  }
  const tools = (result as { tools: unknown[] }).tools.map((tool): NexusGatewayToolSpec => {
    if (!tool || typeof tool !== "object") {
      throw new NexusGatewayProxyError("gateway tools/list contains a malformed tool");
    }
    const value = tool as Record<string, unknown>;
    if (typeof value.name !== "string" || !value.name || !value.inputSchema || typeof value.inputSchema !== "object") {
      throw new NexusGatewayProxyError("gateway tools/list contains a tool without a valid name/schema");
    }
    return {
      name: value.name,
      description: typeof value.description === "string" ? value.description : undefined,
      inputSchema: value.inputSchema as JsonSchema,
    };
  });
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new NexusGatewayProxyError(`gateway tools/list contains duplicate tool ${tool.name}`);
    names.add(tool.name);
  }
  if (tools.length === 0) throw new NexusGatewayProxyError("gateway tools/list returned an empty manifest");
  return tools;
}

function schemaToZod(schema: JsonSchema): any {
  let result: any;
  if (schema.const !== undefined) {
    result = z.literal(schema.const as any);
  } else if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    result = schema.enum.length === 1
      ? z.literal(schema.enum[0] as any)
      : z.union(schema.enum.map((value) => z.literal(value as any)) as [any, any, ...any[]]);
  } else if (Array.isArray(schema.type)) {
    const variants = schema.type.map((type) => schemaToZod({ type }));
    result = variants.length === 1 ? variants[0] : z.union(variants as [any, any, ...any[]]);
  } else {
    switch (schema.type) {
      case "string":
        result = z.string();
        break;
      case "integer":
        result = z.number().int();
        break;
      case "number":
        result = z.number();
        break;
      case "boolean":
        result = z.boolean();
        break;
      case "array":
        result = z.array(schema.items ? schemaToZod(schema.items) : z.unknown());
        break;
      case "object":
      default: {
        const shape: Record<string, any> = {};
        for (const [name, property] of Object.entries(schema.properties ?? {})) {
          const required = (schema.required ?? []).includes(name);
          shape[name] = required ? schemaToZod(property) : schemaToZod(property).optional();
        }
        result = z.object(shape);
        if (schema.additionalProperties === false) result = result.strict();
        else result = result.passthrough();
        break;
      }
    }
  }
  if (schema.description) result = result.describe(schema.description);
  if (schema.default !== undefined) result = result.default(schema.default as any);
  return result;
}

export async function forwardNexusGatewayTool(
  config: ServerConfig,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<CallToolResult> {
  const payload = await gatewayJsonRpc(config, "tools/call", { name, arguments: arguments_ });
  const result = payload.result;
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
export async function createNexusGatewayProxyServer(config: ServerConfig): Promise<McpServer> {
  const toolSpecs = await fetchNexusGatewayToolManifest(config);
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

  for (const spec of toolSpecs) {
    const name = spec.name;
    // The manifest is runtime JSON and therefore cannot preserve a static
    // Zod callback type.  The SDK registration itself still receives the
    // generated Zod schema; only the compile-time callback boundary is erased.
    (server.registerTool as any)(
      name,
      {
        description: spec.description ?? `Forward ${name} to the canonical Nexus gateway.`,
        inputSchema: schemaToZod(spec.inputSchema),
      },
      async (arguments_: Record<string, unknown>): Promise<CallToolResult> => {
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
