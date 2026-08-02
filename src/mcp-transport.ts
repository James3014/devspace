import {
  createMcpHandler,
  isLegacyRequest,
  legacyStatelessFallback,
  type AuthInfo,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { toNodeHandler, type NodeMcpRequestHandler } from "@modelcontextprotocol/node";

export const MODERN_MCP_PROTOCOL_VERSION = "2026-07-28";

export type McpProtocolMode = "dual" | "legacy" | "modern";

export interface McpTransportBoundary {
  mode: McpProtocolMode;
  fetch: McpHttpHandler["fetch"];
  node: NodeMcpRequestHandler;
  close(): Promise<void>;
}

export interface McpRequestTraceContext {
  requestId?: string;
  traceparent?: string;
  tracestate?: string;
  baggage?: string;
  clientId?: string;
  principal?: string;
  protocolVersion?: string;
  toolName?: string;
  taskId?: string;
  attemptId?: string;
}

function unsupportedModernResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: {
          supportedProtocolVersions: ["2025-11-25", "2025-06-18", "2025-03-26"],
          disposition: "LEGACY_ROLLBACK_ACTIVE",
        },
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

function legacyOnlyHandler(factory: McpServerFactory, onerror?: (error: Error) => void): McpHttpHandler {
  const legacy = legacyStatelessFallback(factory, onerror);
  let closed = false;

  return {
    async fetch(request: Request, options?: McpHandlerRequestOptions): Promise<Response> {
      if (closed) return new Response("Handler closed", { status: 503 });
      if (!(await isLegacyRequest(request, options?.parsedBody))) {
        return unsupportedModernResponse();
      }
      return legacy(request, options);
    },
    async close(): Promise<void> {
      closed = true;
    },
    notify: {
      promptsChanged() {},
      resourcesChanged() {},
      resourceUpdated() {},
      toolsChanged() {},
    },
    bus: {
      publish() {},
      subscribe() {
        throw new Error("Subscriptions are unavailable in legacy rollback mode");
      },
    },
  } as McpHttpHandler;
}

export function createMcpTransportBoundary(
  factory: McpServerFactory,
  mode: McpProtocolMode,
  onerror?: (error: Error) => void,
): McpTransportBoundary {
  const handler = mode === "legacy"
    ? legacyOnlyHandler(factory, onerror)
    : createMcpHandler(factory, {
        legacy: mode === "modern" ? "reject" : "stateless",
        onerror,
      });
  const node = toNodeHandler(handler, { onerror });

  return {
    mode,
    fetch: handler.fetch,
    node,
    close: () => handler.close(),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(source: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = source?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Extract the non-secret correlation envelope used by Nexus logs and proxy
 * calls. Access tokens and authorization headers are intentionally excluded.
 */
export function extractMcpRequestTraceContext(
  request: Request,
  parsedBody?: unknown,
  authInfo?: AuthInfo,
): McpRequestTraceContext {
  const body = record(parsedBody);
  const params = record(body?.params);
  const meta = record(params?._meta);
  const arguments_ = record(params?.arguments);
  const extra = record(authInfo?.extra);

  return {
    requestId: request.headers.get("x-request-id") ?? undefined,
    traceparent: request.headers.get("traceparent") ?? stringField(meta, "traceparent"),
    tracestate: request.headers.get("tracestate") ?? stringField(meta, "tracestate"),
    baggage: request.headers.get("baggage") ?? stringField(meta, "baggage"),
    clientId: authInfo?.clientId,
    principal: stringField(extra, "principal") ?? stringField(extra, "subject"),
    protocolVersion:
      request.headers.get("mcp-protocol-version")
      ?? stringField(meta, "io.modelcontextprotocol/protocolVersion"),
    toolName: stringField(params, "name"),
    taskId: stringField(arguments_, "task_id") ?? stringField(params, "task_id"),
    attemptId: stringField(arguments_, "attempt_id") ?? stringField(params, "attempt_id"),
  };
}
