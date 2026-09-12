import { createHash, randomUUID } from "node:crypto";

export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_RESULT_BYTES = 256 * 1024;
export const MAX_JSON_BYTES = 256 * 1024;
export const MAX_ID_BYTES = 256;

export const TASK_STATES = [
  "QUEUED", "CLAIMED", "RUNNING", "RESULT_READY", "COLLECTED",
  "CANCEL_REQUESTED", "CANCELLED", "FAILED", "RECONCILE_REQUIRED",
] as const;
export type ChatSwarmTaskState = (typeof TASK_STATES)[number];
export type ChatSwarmStatus = "ACTIVE" | "CLOSED";
export type ChatSwarmWorkerState = "AVAILABLE" | "BUSY" | "DISABLED" | "RECONCILE_REQUIRED";
export type ChatSwarmRuntimeKind = "mcp_peer" | "opencli_web" | "openai_api" | (string & {});

export interface ChatSwarm {
  id: string; status: ChatSwarmStatus; ownerIdentityFingerprint: string; workerLimit: number;
  inviteCredentialHash?: string; metadata: Record<string, unknown>; revision: number; createdAt: string; updatedAt: string;
}
export interface ChatSwarmWorker {
  id: string; swarmId: string; label: string; runtimeKind: ChatSwarmRuntimeKind;
  sessionIdentityFingerprint?: string; carrierConversationFingerprint?: string;
  lifecycleState: ChatSwarmWorkerState; currentTaskId?: string; lease?: Record<string, unknown>;
  checkpoint?: Record<string, unknown>; continuationEpoch: number; createdAt: string; updatedAt: string;
}
export interface ChatSwarmTask {
  id: string; swarmId: string; taskKey: string; requestHash: string; prompt: string;
  payload: Record<string, unknown>; preferredWorkerId?: string; assignedWorkerId?: string;
  lifecycleState: ChatSwarmTaskState; result?: string; errorCode?: string; errorMessage?: string;
  retrySafe: boolean; reconciliation?: Record<string, unknown>; createdAt: string; updatedAt: string;
  completedAt?: string; collectedAt?: string;
}
export interface ChatSwarmAttempt {
  id: string; taskId: string; attemptNumber: number; runtimeKind: ChatSwarmRuntimeKind;
  effectState: string; runtimeReceipt?: Record<string, unknown>; startedAt?: string;
  acknowledgedAt?: string; finishedAt?: string; createdAt: string;
}

export interface TaskRequest {
  swarmId: string; taskKey: string; prompt: string; payload?: Record<string, unknown>;
  preferredWorkerId?: string;
}

export interface ChatSwarmTaskSummary {
  taskId: string;
  taskKey: string;
  preferredWorkerId?: string;
  assignedWorkerId?: string;
  lifecycleState: ChatSwarmTaskState;
  latestAttemptNumber?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  collectedAt?: string;
  hasResult: boolean;
  resultHash?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface ChatSwarmTaskListResult {
  swarmId: string;
  tasks: ChatSwarmTaskSummary[];
  nextCursor?: string;
  totalCount: number;
}
export interface ReconciliationEvidence {
  taskId: string;
  attemptId: string;
  disposition: "NO_EFFECT";
  evidenceRef: string;
}

export const JOIN_REQUEST_STATES = ["PENDING", "APPROVED", "EXPIRED"] as const;
export type ChatSwarmJoinRequestStatus = (typeof JOIN_REQUEST_STATES)[number];

export interface ChatSwarmJoinRequest {
  id: string;
  swarmId: string;
  attemptKey: string;
  requestHash: string;
  requesterFingerprint: string;
  label: string;
  version: number;
  status: ChatSwarmJoinRequestStatus;
  approvedWorkerId?: string;
  requestedAt: string;
  expiresAt: string;
  approvedAt?: string;
}

export const SWARM_ERROR_CODES = [
  "INVALID_INPUT",
  "REPLAY_CONFLICT",
  "NOT_FOUND",
  "OWNERSHIP_CONFLICT",
  "INVALID_STATE",
  "TERMINAL_IMMUTABLE",
  "RECONCILIATION_REQUIRED",
  "HOST_REPORTED_ACTION_BLOCK",
  "HOST_CONVERSATION_UNSUPPORTED",
  "TOOL_SCHEMA_STALE",
  "TRANSPORT_UNKNOWN",
  "IDENTITY_MISSING",
  "IDENTITY_AMBIGUOUS",
  "IDENTITY_MALFORMED",
  "INVITE_EXPIRED",
  "OWNER_MISMATCH",
  "VERSION_CONFLICT",
  "CAS_DRIFT",
  "CAPACITY_FULL",
  "REQUEST_EXPIRED",
  "EXPIRED",
  "REQUEST_NOT_FOUND",
] as const;
export type ChatSwarmErrorCode = (typeof SWARM_ERROR_CODES)[number];

export type ChatSwarmErrorLayer = "contract" | "store" | "coordinator" | "transport" | "host";
export type ChatSwarmErrorStage = "received" | "identity_validated" | "admission_denied" | "committed" | "response_produced";

export interface ChatSwarmErrorDetails {
  code: ChatSwarmErrorCode;
  layer: ChatSwarmErrorLayer;
  stage: ChatSwarmErrorStage;
  operation?: string;
  message: string;
}

export class ChatSwarmError extends Error {
  readonly code: ChatSwarmErrorCode;
  readonly layer: ChatSwarmErrorLayer;
  readonly stage: ChatSwarmErrorStage;
  readonly operation?: string;

  constructor(
    code: ChatSwarmErrorCode,
    message: string,
    options?: {
      layer?: ChatSwarmErrorLayer;
      stage?: ChatSwarmErrorStage;
      operation?: string;
    },
  ) {
    super(message);
    this.name = "ChatSwarmError";
    this.code = code;
    this.layer = options?.layer ?? "coordinator";
    this.stage = options?.stage ?? "admission_denied";
    this.operation = options?.operation;
  }

  toDetails(): ChatSwarmErrorDetails {
    return {
      code: this.code,
      layer: this.layer,
      stage: this.stage,
      operation: this.operation,
      message: this.message,
    };
  }
}

export function newId(prefix: string): string { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

export function requestHash(request: Pick<TaskRequest, "prompt"> & Partial<Pick<TaskRequest, "payload" | "preferredWorkerId" | "swarmId" | "taskKey">>): string {
  return createHash("sha256").update(JSON.stringify(canonicalize({
    prompt: request.prompt, payload: request.payload ?? {}, preferredWorkerId: request.preferredWorkerId ?? null,
  }))).digest("hex");
}

export function joinRequestHash(input: { swarmId: string; label: string; requesterFingerprint: string }): string {
  return createHash("sha256").update(JSON.stringify(canonicalize({
    swarmId: input.swarmId,
    label: input.label,
    requesterFingerprint: input.requesterFingerprint,
  }))).digest("hex");
}

export function hashCredential(value: string): string {
  if (!value || value.length > 4096) throw new ChatSwarmError("INVALID_INPUT", "credential is empty or exceeds the safe input limit");
  return createHash("sha256").update(value).digest("hex");
}

export function hashContent(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertBounded(value: string, limit: number, label: string): void {
  if (!value.trim()) throw new ChatSwarmError("INVALID_INPUT", `${label} must not be blank`);
  if (Buffer.byteLength(value, "utf8") > limit) throw new ChatSwarmError("INVALID_INPUT", `${label} exceeds ${limit} bytes`);
}

export function assertTaskState(value: string): asserts value is ChatSwarmTaskState {
  if (!(TASK_STATES as readonly string[]).includes(value)) throw new ChatSwarmError("INVALID_STATE", `unknown task state '${value}'`);
}

export function isTerminal(state: ChatSwarmTaskState): boolean {
  return state === "RESULT_READY" || state === "COLLECTED" || state === "CANCELLED" || state === "FAILED";
}
export function isExecutionActive(state: ChatSwarmTaskState): boolean {
  return state === "CLAIMED" || state === "RUNNING" || state === "CANCEL_REQUESTED";
}
