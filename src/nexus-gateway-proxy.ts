import { createHash, randomUUID } from "node:crypto";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { CANONICAL_PROXY_LOCAL_PROTECTED_TOOLS, type ServerConfig } from "./config.js";
import {
  createTrustedIntegrationTargetResolver,
  defaultGitMergeTransportFactory,
  gitMergePullRequestTool,
  type GitHubCompletionTransport,
  type GitHubPullRequestTransport,
  type IntegrationTargetResolver,
  type TrustedIntegrationTarget,
} from "./git-pr-merge.js";
import { runGitHubCompletionTool } from "./github-completion-host.js";

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

export interface NexusGatewayToolManifest extends Array<NexusGatewayToolSpec> {
  readonly revision: string;
  readonly sha256: string;
}

export interface NexusGatewayManifestIdentity {
  count: number;
  revision: string;
  sha256: string;
}

/**
 * Server-controlled trusted integration target for the public proxy surface.
 * The canonical collaboration checkout (`NEXUS_CANONICAL_SOURCE_ROOT`)
 * observes `origin` -> James3014/Nexus-new; this binding is distinct from the
 * raw surface's `nexus-new` default target and is never caller-selectable.
 */
export const PUBLIC_NEXUS_TRUSTED_INTEGRATION_TARGET: TrustedIntegrationTarget = {
  remoteName: "origin",
  repository: "James3014/Nexus-new",
  defaultBranch: "main",
};

export function createPublicNexusIntegrationTargetResolver(): IntegrationTargetResolver {
  return createTrustedIntegrationTargetResolver([PUBLIC_NEXUS_TRUSTED_INTEGRATION_TARGET]);
}

export interface NexusGatewayProxyConstructionOptions {
  /** Test seams. Production callers omit them. */
  gitMergeTransportFactory?: () => GitHubPullRequestTransport;
  gitCompletionTransportFactory?: () => GitHubCompletionTransport;
}

/**
 * Shared compatibility gate for the hybrid public surface. The server-local
 * protected extension (`git_merge_pull_request`) must never silently shadow,
 * duplicate, or coexist ambiguously with a Gateway-owned action of the same
 * name. A colliding manifest is rejected deterministically.
 *
 * This single function protects BOTH the startup/readiness path (server.ts
 * gatewayManifestReady) and direct proxy construction
 * (`createNexusGatewayProxyServer(preparedManifest)`); the rule lives here
 * exactly once.
 */
export function assertCanonicalGatewayProxyManifestCompatible(
  tools: readonly NexusGatewayToolSpec[],
): void {
  const collision = tools.find((tool) =>
    CANONICAL_PROXY_LOCAL_PROTECTED_TOOLS.includes(tool.name as (typeof CANONICAL_PROXY_LOCAL_PROTECTED_TOOLS)[number]),
  );
  if (collision) {
    throw new NexusGatewayProxyError(
      `collision: canonical gateway manifest now exposes ${collision.name}, which conflicts with the server-local protected extension; refusing to shadow, replace, duplicate, or pick one implementation. An explicit migration decision is required before the public proxy may register the local extension.`,
    );
  }
}

export interface NexusGatewayForwardContext {
  requestId?: string;
  traceparent?: string;
  tracestate?: string;
  baggage?: string;
  clientId?: string;
  principal?: string;
  protocolVersion?: string;
  taskId?: string;
  attemptId?: string;
}

const RAW_DEVSPACE_TOOL_NAMES = new Set([
  "open_workspace",
  "read",
  "write",
  "edit",
  "shell",
  "grep",
  "glob",
  "ls",
  "open_worktree",
  "show_changes",
]);

type JsonRpcResponse = {
  result?: unknown;
  error?: { code?: number; message?: string };
};

export class NexusGatewayProxyError extends Error {}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function nexusGatewayToolManifestSha256(tools: readonly NexusGatewayToolSpec[]): string {
  return createHash("sha256").update(stableJson(tools)).digest("hex");
}

export function nexusGatewayManifestIdentity(
  tools: readonly NexusGatewayToolSpec[],
  revision?: string,
): NexusGatewayManifestIdentity {
  const sha256 = nexusGatewayToolManifestSha256(tools);
  return {
    count: tools.length,
    revision: revision?.trim() || `sha256:${sha256}`,
    sha256,
  };
}

async function gatewayJsonRpc(
  config: ServerConfig,
  method: string,
  params: Record<string, unknown>,
  context?: NexusGatewayForwardContext,
): Promise<JsonRpcResponse> {
  if (!config.gatewayProxyUrl || !config.gatewayProxyToken) {
    throw new NexusGatewayProxyError("gateway proxy is not configured");
  }

  const headers = new Headers({
    Authorization: `Bearer ${config.gatewayProxyToken}`,
    "Content-Type": "application/json",
  });
  const propagatedHeaders: Array<[string, string | undefined]> = [
    ["X-Request-ID", context?.requestId],
    ["traceparent", context?.traceparent],
    ["tracestate", context?.tracestate],
    ["baggage", context?.baggage],
    ["X-Nexus-MCP-Client-ID", context?.clientId],
    ["X-Nexus-MCP-Principal", context?.principal],
    ["MCP-Protocol-Version", context?.protocolVersion],
    ["X-Nexus-Task-ID", context?.taskId],
    ["X-Nexus-Attempt-ID", context?.attemptId],
  ];
  for (const [name, value] of propagatedHeaders) {
    if (value && !/[\r\n]/.test(value)) headers.set(name, value);
  }

  const response = await fetch(`${config.gatewayProxyUrl}/mcp`, {
    method: "POST",
    headers,
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
export async function fetchNexusGatewayToolManifest(config: ServerConfig): Promise<NexusGatewayToolManifest> {
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
    if (RAW_DEVSPACE_TOOL_NAMES.has(value.name)) {
      throw new NexusGatewayProxyError(`gateway tools/list exposes raw DevSpace tool ${value.name}`);
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
  const orderedTools = tools.slice().sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const gatewayResult = result as Record<string, unknown>;
  const suppliedRevision = [
    gatewayResult.manifest_revision,
    gatewayResult.manifestRevision,
    gatewayResult.revision,
    (gatewayResult._meta as Record<string, unknown> | undefined)?.manifest_revision,
    (gatewayResult._meta as Record<string, unknown> | undefined)?.revision,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const identity = nexusGatewayManifestIdentity(orderedTools, suppliedRevision);
  const manifest = orderedTools as NexusGatewayToolManifest;
  Object.defineProperties(manifest, {
    revision: { value: identity.revision, enumerable: false },
    sha256: { value: identity.sha256, enumerable: false },
  });
  return manifest;
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
  context?: NexusGatewayForwardContext,
): Promise<CallToolResult> {
  const payload = await gatewayJsonRpc(config, "tools/call", { name, arguments: arguments_ }, context);
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
 *
 * The surface is intentionally hybrid: every canonical Gateway manifest action
 * (forwarded to the gateway) PLUS exactly one server-local protected action,
 * `git_merge_pull_request` (bound to the server-controlled canonical checkout).
 * No other local DevSpace action is exposed.
 */
export async function createNexusGatewayProxyServer(
  config: ServerConfig,
  preparedManifest?: NexusGatewayToolManifest,
  options?: NexusGatewayProxyConstructionOptions,
): Promise<McpServer> {
  const toolSpecs = preparedManifest ?? await fetchNexusGatewayToolManifest(config);

  // Shared compatibility gate (collision check). The same validation is
  // applied earlier on the startup/readiness path in server.ts so a colliding
  // Gateway manifest fails closed before /healthz can declare the surface
  // healthy.
  assertCanonicalGatewayProxyManifestCompatible(toolSpecs);

  const server = new McpServer(
    {
      name: "nexus-mcp-gateway",
      title: "Nexus MCP Gateway",
      version: "0.1.0",
      description: "Authenticated proxy for the canonical Nexus three-lane MCP gateway.",
    },
    {
      instructions:
        "This endpoint exposes the canonical Nexus gateway actions plus two protected local host actions: git_merge_pull_request (exact-head protected merge fallback) and github_complete_pull_request (#599 bounded main-drift completion caller binding). Raw DevSpace workspace, edit, write, and shell tools are NOT available on this surface.",
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
      async (arguments_: Record<string, unknown>, ctx: any): Promise<CallToolResult> => {
        try {
          const request = ctx?.http?.req as Request | undefined;
          const authInfo = ctx?.http?.authInfo as {
            clientId?: string;
            extra?: Record<string, unknown>;
          } | undefined;
          const taskId = typeof arguments_.task_id === "string" ? arguments_.task_id : undefined;
          const attemptId = typeof arguments_.attempt_id === "string" ? arguments_.attempt_id : undefined;
          const extra = authInfo?.extra;
          return await forwardNexusGatewayTool(config, name, arguments_, {
            requestId: request?.headers.get("x-request-id") ?? undefined,
            traceparent: request?.headers.get("traceparent") ?? undefined,
            tracestate: request?.headers.get("tracestate") ?? undefined,
            baggage: request?.headers.get("baggage") ?? undefined,
            clientId: authInfo?.clientId,
            principal:
              (typeof extra?.principal === "string" ? extra.principal : undefined)
              ?? (typeof extra?.subject === "string" ? extra.subject : undefined),
            protocolVersion: request?.headers.get("mcp-protocol-version") ?? undefined,
            taskId,
            attemptId,
          });
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

  {
    const name = "git_merge_pull_request";
    // Existing server-local protected merge authority. This adapter only binds
    // server-controlled inputs; there is no second merge implementation.
    (server.registerTool as any)(
      name,
      {
        description:
          "Merge ONE exact, independently accepted pull request head into the trusted Nexus collaboration repository's default branch. Primary path remains the GitHub connector merge_pull_request(expected_head_sha=...); this action is a bounded fallback for when the GitHub connector is unavailable. The repository and branch are bound server-side to the canonical Nexus checkout (origin -> James3014/Nexus-new -> main); callers cannot select a remote, repository, owner, branch, refspec, URL, or shell command. The exact base and head SHAs are re-verified fresh against GitHub, required checks must all be in reliable terminal success (effective branch rules + classic protection, check runs + commit statuses), and only ownerConfirmation=true authorizes execution. Draft PRs are rejected. Fails closed on any head/base drift, unreadable required checks, or transport gaps.",
        inputSchema: {
          prNumber: z
            .number()
            .int()
            .positive()
            .describe("Pull request number to merge."),
          expectedBaseSha: z
            .string()
            .regex(/^[0-9a-f]{40}$/)
            .describe("Exact full 40-hex SHA of the repository default branch at acceptance time."),
          expectedHeadSha: z
            .string()
            .regex(/^[0-9a-f]{40}$/)
            .describe("Exact full 40-hex SHA of the accepted PR head. This exact head is the only one that may be merged."),
          mergeMethod: z
            .enum(["merge", "squash", "rebase"])
            .describe("GitHub merge method."),
          ownerConfirmation: z
            .boolean()
            .optional()
            .describe("Must be exactly true to authorize the merge. False or missing is rejected."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (arguments_: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          const canonicalRoot = config.nexusCanonicalSourceRoot;
          if (!canonicalRoot) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    schema: "nexus.gateway_proxy_error.v1",
                    code: "PUBLIC_MERGE_ROOT_UNCONFIGURED",
                    error:
                      "public canonical source root is not configured; refusing to run the server-bound PR merge",
                  }),
                },
              ],
              isError: true,
            };
          }
          const transport = options?.gitMergeTransportFactory?.() ?? defaultGitMergeTransportFactory();
          const response = await gitMergePullRequestTool(arguments_, {
            cwd: canonicalRoot,
            transport,
            targetResolver: createPublicNexusIntegrationTargetResolver(),
          });
          return {
            ...response,
            structuredContent: {
              result: response.content.map((part) => part.text).join("\n"),
            },
          };
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

  {
    const name = "github_complete_pull_request";
    (server.registerTool as any)(
      name,
      {
        description:
          "Run Nexus run_github_completion_loop() against the server-bound James3014/Nexus-new checkout. Ordinary main drift may create at most 3 non-force PR integration generations and wait at most 2700 seconds total. Affected semantic/authority/test/transport dimensions fail closed for fresh acceptance. Protected main integration delegates to the existing git_merge_pull_request merge core; this action does not implement a second merge authority.",
        inputSchema: {
          initialEvidence: z.record(z.string(), z.unknown()).describe("Exact accepted nexus.github_orchestration_evidence payload."),
          standingGrantRequest: z.record(z.string(), z.unknown()).describe("Exact nexus.standing_grant_request.v1 payload bound to the durable standing grant."),
          mergeMethod: z.enum(["merge", "squash", "rebase"]).default("merge"),
          ownerConfirmation: z.boolean().describe("Must be exactly true for the host protected merge authority."),
          maxGenerations: z.number().int().min(1).max(3).optional(),
          maxElapsedSeconds: z.number().int().min(1).max(2700).optional(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (arguments_: Record<string, unknown>): Promise<CallToolResult> => {
        const canonicalRoot = config.nexusCanonicalSourceRoot;
        const pythonBin = config.nexusPythonBin;
        if (!canonicalRoot || !pythonBin) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                schema: "nexus.gateway_proxy_error.v1",
                code: "PUBLIC_COMPLETION_RUNTIME_UNCONFIGURED",
                error: "NEXUS_CANONICAL_SOURCE_ROOT and NEXUS_PYTHON_BIN are required for github_complete_pull_request",
              }),
            }],
            isError: true,
          };
        }
        try {
          const result = await runGitHubCompletionTool(arguments_, {
            nexusRoot: canonicalRoot,
            pythonBin,
            ...(options?.gitCompletionTransportFactory
              ? { transport: options.gitCompletionTransportFactory() }
              : {}),
            targetResolver: createPublicNexusIntegrationTargetResolver(),
          });
          const text = JSON.stringify(result, null, 2);
          return { content: [{ type: "text", text }], structuredContent: { result: text } };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                schema: "nexus.gateway_proxy_error.v1",
                code: "PUBLIC_COMPLETION_FAILED",
                error: error instanceof Error ? error.message : String(error),
              }),
            }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}
