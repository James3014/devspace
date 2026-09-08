import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { ChatSwarmError } from "./chat-swarm-contract.js";
import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";
import type { ServerConfig } from "./config.js";

export type ChatSwarmAdmissionAction =
  | "create"
  | "join"
  | "dispatch"
  | "worker_next"
  | "submit"
  | "cancel"
  | "reconcile"
  | "collect"
  | "status"
  | "close";

export interface ChatSwarmToolRegistrationOptions {
  coordinator: ChatSwarmCoordinator;
  config: Pick<ServerConfig, "chatSwarmEnabled" | "chatSwarmMaxWorkers" | "chatSwarmQueueLimit" | "chatSwarmResultMaxChars" | "chatSwarmInviteTtlSeconds">;
  admit?: (action: ChatSwarmAdmissionAction, context?: { existingTask?: boolean }) => void;
  authorizeInvite?: (input: { swarmId: string; credential: string; issuedAt: string; ttlSeconds: number }) => boolean;
}

const id = z.string().min(1).max(256);
const boundedObject = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 64 * 1024) ctx.addIssue({ code: "custom", message: "object exceeds 64 KiB" });
});
const metadata = boundedObject.optional();
const createMetadata = boundedObject.refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 60 * 1024, "metadata leaves room for invite issuance metadata").optional();
const taskResult = z.object({ id, swarmId: id, taskKey: id, requestHash: z.string(), prompt: z.string(), payload: boundedObject, preferredWorkerId: id.optional(), assignedWorkerId: id.optional(), lifecycleState: z.string(), result: z.string().optional(), errorCode: z.string().optional(), errorMessage: z.string().optional(), retrySafe: z.boolean(), reconciliation: boundedObject.optional(), createdAt: z.string(), updatedAt: z.string(), completedAt: z.string().optional(), collectedAt: z.string().optional() });
const workerResult = z.object({ id, swarmId: id, label: id, runtimeKind: z.literal("mcp_peer"), sessionIdentityFingerprint: z.string().optional(), carrierConversationFingerprint: z.string().optional(), lifecycleState: z.string(), currentTaskId: id.optional(), lease: boundedObject.optional(), checkpoint: boundedObject.optional(), continuationEpoch: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string() });
const swarmResult = z.object({ id, status: z.enum(["ACTIVE", "CLOSED"]), ownerIdentityFingerprint: z.string().regex(/^[0-9a-f]{64}$/), workerLimit: z.number().int().positive(), inviteCredentialHash: z.string().optional(), metadata: boundedObject, createdAt: z.string(), updatedAt: z.string() });
const createResult = z.object({ swarm: swarmResult, inviteCredential: z.string(), inviteIssuedAt: z.string() });
const nextResult = z.object({ task: taskResult.nullable() });
const evidence = z.object({ taskId: id, attemptId: id, disposition: z.literal("NO_EFFECT"), evidenceRef: z.string().min(1).max(1024) });

export function chatSwarmToolInputShapes(config: Pick<ServerConfig, "chatSwarmMaxWorkers" | "chatSwarmResultMaxChars">): Record<string, Record<string, z.ZodType>> {
  const swarmId = id.describe("Swarm identifier.");
  const taskId = id.describe("Task identifier.");
  const workerId = id.describe("Worker identifier.");
  return {
    chat_swarm_create: { workerLimit: z.number().int().min(1).max(config.chatSwarmMaxWorkers), metadata: createMetadata },
    chat_swarm_dispatch: { swarmId, taskKey: id, prompt: z.string().min(1).max(64 * 1024), payload: metadata, preferredWorkerId: workerId.optional(), id: id.optional() },
    chat_swarm_status: { swarmId, taskId },
    chat_swarm_collect: { swarmId, taskId },
    chat_swarm_cancel: { swarmId, taskId },
    chat_swarm_reconcile: { swarmId, taskId, decision: z.enum(["REQUEUE", "FAILED", "RESULT_READY"]), result: z.string().max(config.chatSwarmResultMaxChars).optional(), evidence: evidence.optional() },
    chat_swarm_close: { swarmId },
    chat_swarm_join: { swarmId, inviteCredential: z.string().min(1).max(4096), id: id.optional(), label: id, runtimeKind: z.literal("mcp_peer"), sessionIdentityFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional() },
    chat_swarm_next: { workerId },
    chat_swarm_submit: { workerId, taskId, result: z.string().min(1).max(config.chatSwarmResultMaxChars) },
  };
}

export function createChatSwarmToolInputSchemas(config: Pick<ServerConfig, "chatSwarmMaxWorkers" | "chatSwarmResultMaxChars">): Record<string, z.ZodObject<any>> {
  return Object.fromEntries(Object.entries(chatSwarmToolInputShapes(config)).map(([name, shape]) => [name, z.object(shape)])) as Record<string, z.ZodObject<any>>;
}
type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function success(value: unknown): ToolResult {
  return { structuredContent: value as Record<string, unknown>, content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

function meta(extra: { _meta?: unknown }): unknown { return extra._meta ?? {}; }

function requireFreshInvite(
  coordinator: ChatSwarmCoordinator,
  authorizeInvite: ChatSwarmToolRegistrationOptions["authorizeInvite"],
  swarmId: string,
  credential: string,
  ttlSeconds: number,
): void {
  const swarm = coordinator.store.getSwarm(swarmId);
  const issuedAt = swarm?.metadata.chatSwarmInviteIssuedAt;
  if (typeof issuedAt !== "string") throw new ChatSwarmError("OWNERSHIP_CONFLICT", "swarm invite is unavailable");
  const issuedMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedMs) || issuedMs > Date.now() || Date.now() - issuedMs > ttlSeconds * 1000) {
    throw new ChatSwarmError("INVALID_INPUT", "invite credential is expired or has an invalid issue time");
  }
  if (!coordinator.store.verifyInviteCredential(swarmId, credential)) {
    throw new ChatSwarmError("OWNERSHIP_CONFLICT", "invite credential is not authorized");
  }
  if (authorizeInvite && !authorizeInvite({ swarmId, credential, issuedAt, ttlSeconds })) throw new ChatSwarmError("OWNERSHIP_CONFLICT", "invite credential is not admitted");
}

export function registerChatSwarmTools(
  server: McpServer,
  { coordinator, config, admit = () => undefined, authorizeInvite }: ChatSwarmToolRegistrationOptions,
): number {
  if (!config.chatSwarmEnabled) return 0;
  const schemas = createChatSwarmToolInputSchemas(config);
  const swarmId = id.describe("Swarm identifier.");
  const taskId = id.describe("Task identifier.");
  const workerId = id.describe("Worker identifier.");

  server.registerTool("chat_swarm_create", { title: "Create ChatGPT swarm", description: "Create an owner-bound ChatGPT peer swarm.", inputSchema: schemas.chat_swarm_create, outputSchema: createResult }, async (input: any, extra) => {
    try { admit("create"); if (input.metadata && Buffer.byteLength(JSON.stringify(input.metadata), "utf8") > 60 * 1024) throw new ChatSwarmError("INVALID_INPUT", "metadata leaves room for invite issuance metadata"); const inviteCredential = randomBytes(32).toString("base64url"); const inviteIssuedAt = new Date().toISOString(); const swarm = coordinator.createSwarm(meta(extra), { ...input, inviteCredential, metadata: { ...(input.metadata ?? {}), chatSwarmInviteIssuedAt: inviteIssuedAt } }); return success({ swarm, inviteCredential, inviteIssuedAt }); } catch (error) { return failure(error); }
  });
  server.registerTool("chat_swarm_dispatch", { title: "Dispatch swarm task", description: "Create or replay a bounded task and dispatch it to an eligible peer worker.", inputSchema: schemas.chat_swarm_dispatch, outputSchema: taskResult }, async (input: any, extra) => {
    try { admit("dispatch"); return success(coordinator.dispatch(meta(extra), input, config.chatSwarmQueueLimit)); } catch (error) { return failure(error); }
  });
  server.registerTool("chat_swarm_status", { title: "Inspect swarm task", description: "Read one task without changing it.", inputSchema: schemas.chat_swarm_status, outputSchema: taskResult, annotations: { readOnlyHint: true, idempotentHint: true } }, async (input: any, extra) => {
    try { admit("status"); return success(coordinator.status(meta(extra), input.swarmId, input.taskId)); } catch (error) { return failure(error); }
  });
  server.registerTool("chat_swarm_collect", { title: "Collect swarm result", description: "Idempotently mark a ready result collected.", inputSchema: schemas.chat_swarm_collect, outputSchema: taskResult, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } }, async (input: any, extra) => {
    try { admit("collect"); return success(coordinator.collect(meta(extra), input.swarmId, input.taskId)); } catch (error) { return failure(error); }
  });
  server.registerTool("chat_swarm_cancel", { title: "Cancel swarm task", description: "Cancel queued work or request cancellation while preserving uncertain worker effects.", inputSchema: schemas.chat_swarm_cancel, outputSchema: taskResult }, async (input: any, extra) => {
    try { admit("cancel"); return success(coordinator.cancel(meta(extra), input.swarmId, input.taskId)); } catch (error) { return failure(error); }
  });
  server.registerTool("chat_swarm_reconcile", { title: "Reconcile swarm task", description: "Apply an explicit bounded reconciliation decision.", inputSchema: schemas.chat_swarm_reconcile, outputSchema: taskResult }, async (input: any, extra) => {
    try { admit("reconcile"); return success(coordinator.reconcile(meta(extra), input.swarmId, input.taskId, input.decision, input.result, input.evidence)); } catch (error) { return failure(error); }
  });
  server.registerTool("chat_swarm_close", { title: "Close ChatGPT swarm", description: "Close an owner swarm after all pending work is terminal.", inputSchema: schemas.chat_swarm_close, outputSchema: swarmResult }, async (input: any, extra) => {
    try { admit("close"); return success(coordinator.close(meta(extra), input.swarmId)); } catch (error) { return failure(error); }
  });
  server.registerTool("chat_swarm_join", { title: "Join ChatGPT swarm", description: "Join a swarm with a verified MCP peer identity and a fresh invite.", inputSchema: schemas.chat_swarm_join, outputSchema: workerResult }, async (input: any, extra) => {
    try { admit("join"); requireFreshInvite(coordinator, authorizeInvite, input.swarmId, input.inviteCredential, config.chatSwarmInviteTtlSeconds); return success(coordinator.joinWorker(meta(extra), input.swarmId, input)); } catch (error) { return failure(error); }
  });
  server.registerTool("chat_swarm_next", { title: "Get next swarm task", description: "Return the worker's current task or atomically claim the next queued task.", inputSchema: schemas.chat_swarm_next, outputSchema: nextResult }, async (input: any, extra) => {
    try { const worker = coordinator.store.getWorker(input.workerId); admit("worker_next", { existingTask: Boolean(worker?.currentTaskId) }); return success({ task: coordinator.nextTask(meta(extra), input.workerId) ?? null }); } catch (error) { return failure(error); }
  });
  server.registerTool("chat_swarm_submit", { title: "Submit swarm result", description: "Submit an owned worker result; terminal replay is idempotent.", inputSchema: schemas.chat_swarm_submit, outputSchema: taskResult }, async (input: any, extra) => {
    try { admit("submit"); return success(coordinator.submit(meta(extra), input.workerId, input.taskId, input.result)); } catch (error) { return failure(error); }
  });
  return 10;
}
