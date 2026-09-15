import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { ChatSwarmError } from "./chat-swarm-contract.js";
import { ChatSwarmIdentityError } from "./request-meta.js";
import type { ChatSwarmRuntimeManager } from "./chat-swarm-runtime.js";
import {
  ensureManagedRuntime,
  readManagedRuntimeStatus,
} from "./chat-swarm-runtime-delivery.js";

const id = z.string().min(1).max(256);
const sha = z.string().regex(/^[0-9a-f]{64}$/);

const slotSchema = z.object({
  managedCarrierId: id,
  swarmId: id,
  runtimeSlot: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
  state: z.enum([
    "PROVISIONING", "CARRIER_CREATED", "BOOTSTRAPPING", "SETUP_REQUIRED",
    "SWARM_BOUND", "PARKED", "BUSY", "STOPPING", "RECONCILE_REQUIRED", "STOPPED",
  ]),
  projectUrl: z.string(),
  browserProfileId: sha,
  workerId: id.optional(),
  conversationUrl: z.string().optional(),
  conversationFingerprint: sha.optional(),
  authenticatedPeerFingerprint: sha.optional(),
  continuationEpoch: z.number().int().nonnegative().optional(),
  lastOperationId: id.optional(),
  blocker: z.string().optional(),
  updatedAt: z.string(),
});

const runtimeStatusSchema = z.object({
  swarmId: id,
  state: z.enum(["DISABLED", "CONFIGURED_NOT_READY", "READY", "DEGRADED", "RECONCILE_REQUIRED"]),
  enabled: z.boolean(),
  desiredDefault: z.number().int().positive(),
  maxWorkers: z.number().int().positive(),
  adapter: z.object({
    kind: z.literal("mac_web_chatgpt"),
    controlMechanism: z.enum(["CDP", "OPENCLI"]),
    projectConfigured: z.boolean(),
    appBinding: z.enum(["READY", "UNKNOWN", "DISABLED", "STALE"]),
    blocker: z.string().optional(),
  }),
  slots: z.array(slotSchema),
});

const bootstrapResultSchema = z.object({
  slot: slotSchema,
  worker: z.object({
    id, swarmId: id, label: id, runtimeKind: z.string(),
    sessionIdentityFingerprint: sha.optional(),
    carrierConversationFingerprint: sha.optional(),
    lifecycleState: z.string(), currentTaskId: id.optional(),
    lease: z.record(z.string(), z.unknown()).optional(),
    checkpoint: z.record(z.string(), z.unknown()).optional(),
    continuationEpoch: z.number().int().nonnegative(),
    createdAt: z.string(), updatedAt: z.string(),
  }),
});

export function chatSwarmRuntimeToolInputShapes(
  config: { chatSwarmMaxWorkers: number },
): Record<string, Record<string, z.ZodType>> {
  const swarmId = id.describe("Swarm identifier.");
  const workerId = id.describe("Managed logical worker identifier.");
  const desiredWorkers = z.number().int().min(1).max(config.chatSwarmMaxWorkers)
    .describe("Desired managed worker capacity, bounded by the existing Swarm worker limit.");
  return {
    chat_swarm_runtime_status: { swarmId },
    chat_swarm_runtime_ensure: { swarmId, desiredWorkers: desiredWorkers.optional() },
    chat_swarm_runtime_scale: { swarmId, desiredWorkers },
    chat_swarm_runtime_recover: { swarmId, workerId },
    chat_swarm_runtime_stop: { swarmId, workerId },
    chat_swarm_runtime_bootstrap: {
      operationId: id.describe("Exact managed provisioning operation created by runtime_ensure."),
    },
  };
}

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

function success(value: unknown): ToolResult {
  return { structuredContent: value as Record<string, unknown>, content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(error: unknown, operation: string): ToolResult {
  if (error instanceof ChatSwarmError) {
    const details = { code: error.code, layer: error.layer, stage: error.stage, operation, message: error.message };
    return { isError: true, _meta: { "devspace/error": details }, content: [{ type: "text", text: `[${details.code}] ${details.message}` }] };
  }
  if (error instanceof ChatSwarmIdentityError) {
    const details = { code: `IDENTITY_${error.code}`, layer: "HOST", stage: "identity_validated", operation, message: error.message };
    return { isError: true, _meta: { "devspace/error": details }, content: [{ type: "text", text: `[${details.code}] ${details.message}` }] };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    _meta: { "devspace/error": { code: "INTERNAL_ERROR", layer: "SYSTEM", stage: "EXECUTE", operation, message } },
    content: [{ type: "text", text: `[INTERNAL_ERROR] ${message}` }],
  };
}

function requestMeta(extra: { _meta?: unknown }): unknown { return extra._meta ?? {}; }
type RuntimeManagerFactory = () => ChatSwarmRuntimeManager;

async function withManager<T>(
  factory: RuntimeManagerFactory,
  fn: (manager: ChatSwarmRuntimeManager) => Promise<T> | T,
): Promise<T> {
  const manager = factory();
  try { return await fn(manager); }
  finally { manager.close(); }
}

export function registerChatSwarmRuntimeTools(
  server: McpServer,
  managerFactory: RuntimeManagerFactory,
  config: { chatSwarmMaxWorkers: number },
  admit: (action: "status" | "dispatch" | "join" | "close") => void,
): number {
  const schemas = Object.fromEntries(
    Object.entries(chatSwarmRuntimeToolInputShapes(config)).map(([name, shape]) => [name, z.object(shape)]),
  ) as Record<string, z.ZodObject<any>>;

  server.registerTool("chat_swarm_runtime_status", {
    title: "Inspect managed ChatGPT worker runtime",
    description: "Read the zero-touch macOS worker pool, carrier health, and setup blockers without side effects.",
    inputSchema: schemas.chat_swarm_runtime_status,
    outputSchema: runtimeStatusSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input: any, extra) => {
    try {
      admit("status");
      return success(
        await withManager(managerFactory, (manager) =>
          readManagedRuntimeStatus(manager, requestMeta(extra), input.swarmId),
        ),
      );
    } catch (error) { return failure(error, "runtime_status"); }
  });

  server.registerTool("chat_swarm_runtime_ensure", {
    title: "Ensure managed ChatGPT worker capacity",
    description: "Idempotently reconcile existing exact carriers, then create/restore only missing managed workers and park them for targeted wake.",
    inputSchema: schemas.chat_swarm_runtime_ensure,
    outputSchema: runtimeStatusSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input: any, extra) => {
    try {
      admit("dispatch");
      return success(
        await withManager(managerFactory, (manager) =>
          ensureManagedRuntime(
            manager,
            requestMeta(extra),
            input.swarmId,
            input.desiredWorkers,
          ),
        ),
      );
    } catch (error) { return failure(error, "runtime_ensure"); }
  });

  server.registerTool("chat_swarm_runtime_scale", {
    title: "Scale managed ChatGPT worker capacity",
    description: "Scale the managed pool up or down without evicting busy, targeted, continuation-pending, or reconcile-required workers.",
    inputSchema: schemas.chat_swarm_runtime_scale,
    outputSchema: runtimeStatusSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input: any, extra) => {
    try { admit("dispatch"); return success(await withManager(managerFactory, (manager) => manager.scale(requestMeta(extra), input.swarmId, input.desiredWorkers))); }
    catch (error) { return failure(error, "runtime_scale"); }
  });

  server.registerTool("chat_swarm_runtime_recover", {
    title: "Recover exact managed worker carrier",
    description: "Reopen the persisted exact conversation for one logical worker without changing task truth or silently creating a replacement attempt.",
    inputSchema: schemas.chat_swarm_runtime_recover,
    outputSchema: runtimeStatusSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input: any, extra) => {
    try { admit("dispatch"); return success(await withManager(managerFactory, (manager) => manager.recover(requestMeta(extra), input.swarmId, input.workerId))); }
    catch (error) { return failure(error, "runtime_recover"); }
  });

  server.registerTool("chat_swarm_runtime_stop", {
    title: "Stop owned idle managed worker carrier",
    description: "Stop only a safe owned idle carrier; busy, targeted, continuation-pending, and unresolved workers fail closed.",
    inputSchema: schemas.chat_swarm_runtime_stop,
    outputSchema: runtimeStatusSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input: any, extra) => {
    try { admit("close"); return success(await withManager(managerFactory, (manager) => manager.stop(requestMeta(extra), input.swarmId, input.workerId))); }
    catch (error) { return failure(error, "runtime_stop"); }
  });

  server.registerTool("chat_swarm_runtime_bootstrap", {
    title: "Bind managed worker bootstrap",
    description: "Bind only the exact ChatGPT conversation created by an Owner-authorized provisioning operation. Operation ID knowledge alone is insufficient.",
    inputSchema: schemas.chat_swarm_runtime_bootstrap,
    outputSchema: bootstrapResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input: any, extra) => {
    try { admit("join"); return success(await withManager(managerFactory, (manager) => manager.bootstrap(requestMeta(extra), input.operationId))); }
    catch (error) { return failure(error, "runtime_bootstrap"); }
  });

  return 6;
}
