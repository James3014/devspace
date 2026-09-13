import {
  assertBounded,
  canonicalize,
  ChatSwarmError,
  hashContent,
  MAX_ID_BYTES,
  MAX_JSON_BYTES,
  type ChatSwarmWorker,
} from "./chat-swarm-contract.js";

export const WORKER_AUTO_COMPACT_CAPSULE_SCHEMA = "chat_swarm.worker_auto_compact_capsule.v1" as const;
export const WORKER_AUTO_COMPACT_CAPSULE_MAX_BYTES = 48 * 1024;

const PRESSURE_PRECISIONS = ["ESTIMATED", "EXACT"] as const;
const PRESSURE_SOURCES = ["DEVSPACE_ESTIMATE", "CARRIER_ESTIMATE", "HOST_NATIVE"] as const;
const CAPSULE_KEYS = [
  "schema",
  "swarmId",
  "workerId",
  "sourceEpoch",
  "checkpointHash",
  "pressure",
  "prepareAtRatio",
  "roleInstructions",
  "contextSummary",
  "summaryAuthority",
  "taskRefs",
  "resultRefs",
  "evidenceRefs",
  "blockers",
  "claimCeiling",
  "createdAt",
  "capsuleHash",
] as const;
const PRESSURE_KEYS = ["precision", "source", "utilizationRatio", "provenance", "observedAt"] as const;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_PROVENANCE_BYTES = 2 * 1024;
const MAX_ROLE_BYTES = 8 * 1024;
const MAX_SUMMARY_BYTES = 16 * 1024;
const MAX_CLAIM_CEILING_BYTES = 2 * 1024;
const MAX_REF_BYTES = 512;
const MAX_BLOCKER_BYTES = 2 * 1024;
const MAX_REFS_PER_KIND = 32;
const MAX_BLOCKERS = 16;
const MAX_TIMESTAMP_BYTES = 128;

export type WorkerContextPressurePrecision = (typeof PRESSURE_PRECISIONS)[number];
export type WorkerContextPressureSource = (typeof PRESSURE_SOURCES)[number];

export interface WorkerContextPressureSignal {
  precision: WorkerContextPressurePrecision;
  source: WorkerContextPressureSource;
  utilizationRatio: number;
  provenance: string;
  observedAt: string;
}

export type WorkerAutoCompactDecisionState =
  | "NOT_REQUIRED"
  | "WAIT_SAFE_BOUNDARY"
  | "BLOCKED_RECONCILIATION"
  | "BLOCKED_CHECKPOINT"
  | "BLOCKED_DISABLED"
  | "PREPARE_REQUIRED";

export interface WorkerAutoCompactDecisionInput {
  worker: Pick<
    ChatSwarmWorker,
    "id" | "swarmId" | "lifecycleState" | "currentTaskId" | "continuationEpoch" | "checkpoint"
  >;
  pressure: WorkerContextPressureSignal;
  prepareAtRatio: number;
  hasPendingContinuation?: boolean;
  hasUnknownEffect?: boolean;
}

export interface WorkerAutoCompactDecision {
  state: WorkerAutoCompactDecisionState;
  compactRequired: boolean;
  safeToPrepare: boolean;
  reason: string;
  sourceEpoch: number;
  prepareAtRatio: number;
  checkpointHash?: string;
}

export interface WorkerAutoCompactCapsule {
  schema: typeof WORKER_AUTO_COMPACT_CAPSULE_SCHEMA;
  swarmId: string;
  workerId: string;
  sourceEpoch: number;
  checkpointHash: string;
  pressure: WorkerContextPressureSignal;
  prepareAtRatio: number;
  roleInstructions: string;
  contextSummary: string;
  summaryAuthority: "CONTEXT_ONLY";
  taskRefs: string[];
  resultRefs: string[];
  evidenceRefs: string[];
  blockers: string[];
  claimCeiling: string;
  createdAt: string;
  capsuleHash: string;
}

export interface WorkerAutoCompactPrepareInput extends WorkerAutoCompactDecisionInput {
  roleInstructions: string;
  contextSummary: string;
  taskRefs?: string[];
  resultRefs?: string[];
  evidenceRefs?: string[];
  blockers?: string[];
  claimCeiling: string;
  createdAt: string;
}

export interface WorkerAutoCompactReplacementIntent {
  kind: "REQUEST_REPLACEMENT_CARRIER";
  authority: "NON_AUTHORIZING";
  swarmId: string;
  workerId: string;
  sourceEpoch: number;
  capsuleHash: string;
}

export interface WorkerAutoCompactPlan {
  decision: WorkerAutoCompactDecision;
  capsule?: WorkerAutoCompactCapsule;
  replacementIntent?: WorkerAutoCompactReplacementIntent;
}

export function evaluateWorkerAutoCompact(input: WorkerAutoCompactDecisionInput): WorkerAutoCompactDecision {
  validateWorkerIdentity(input.worker);
  validatePressure(input.pressure);
  validateThreshold(input.prepareAtRatio);
  validateEpoch(input.worker.continuationEpoch);

  if (input.pressure.utilizationRatio < input.prepareAtRatio) {
    return decision(input, "NOT_REQUIRED", false, false, "context pressure is below the configured prepare threshold");
  }

  if (input.hasUnknownEffect || input.hasPendingContinuation || input.worker.lifecycleState === "RECONCILE_REQUIRED") {
    return decision(
      input,
      "BLOCKED_RECONCILIATION",
      true,
      false,
      "worker has unresolved effect or continuation state and must reconcile before Auto Compact",
    );
  }

  if (input.worker.lifecycleState === "DISABLED") {
    return decision(input, "BLOCKED_DISABLED", true, false, "disabled worker cannot prepare Auto Compact");
  }

  if (input.worker.lifecycleState === "BUSY" || input.worker.currentTaskId) {
    if (input.worker.currentTaskId) assertBounded(input.worker.currentTaskId, MAX_ID_BYTES, "currentTaskId");
    return decision(input, "WAIT_SAFE_BOUNDARY", true, false, "worker must reach an idle safe boundary before Auto Compact");
  }

  const checkpointHash = computeCheckpointHash(input.worker.checkpoint);
  if (!checkpointHash) {
    return decision(input, "BLOCKED_CHECKPOINT", true, false, "worker requires a bounded checkpoint before Auto Compact");
  }

  return {
    state: "PREPARE_REQUIRED",
    compactRequired: true,
    safeToPrepare: true,
    reason: "context pressure reached the configured threshold at a safe worker boundary",
    sourceEpoch: input.worker.continuationEpoch,
    prepareAtRatio: input.prepareAtRatio,
    checkpointHash,
  };
}

export function prepareWorkerAutoCompact(input: WorkerAutoCompactPrepareInput): WorkerAutoCompactPlan {
  const decisionResult = evaluateWorkerAutoCompact(input);
  if (!decisionResult.safeToPrepare || decisionResult.state !== "PREPARE_REQUIRED" || !decisionResult.checkpointHash) {
    return { decision: decisionResult };
  }

  assertBounded(input.roleInstructions, MAX_ROLE_BYTES, "roleInstructions");
  assertBounded(input.contextSummary, MAX_SUMMARY_BYTES, "contextSummary");
  assertBounded(input.claimCeiling, MAX_CLAIM_CEILING_BYTES, "claimCeiling");
  validateTimestamp(input.createdAt, "createdAt");
  if (Date.parse(input.createdAt) < Date.parse(input.pressure.observedAt)) {
    throw new ChatSwarmError("INVALID_INPUT", "createdAt cannot precede the pressure observation");
  }

  const taskRefs = validateRefs(input.taskRefs ?? [], "taskRefs");
  const resultRefs = validateRefs(input.resultRefs ?? [], "resultRefs");
  const evidenceRefs = validateRefs(input.evidenceRefs ?? [], "evidenceRefs");
  const blockers = validateBlockers(input.blockers ?? []);

  const payload = {
    schema: WORKER_AUTO_COMPACT_CAPSULE_SCHEMA,
    swarmId: input.worker.swarmId,
    workerId: input.worker.id,
    sourceEpoch: input.worker.continuationEpoch,
    checkpointHash: decisionResult.checkpointHash,
    pressure: input.pressure,
    prepareAtRatio: input.prepareAtRatio,
    roleInstructions: input.roleInstructions,
    contextSummary: input.contextSummary,
    summaryAuthority: "CONTEXT_ONLY" as const,
    taskRefs,
    resultRefs,
    evidenceRefs,
    blockers,
    claimCeiling: input.claimCeiling,
    createdAt: input.createdAt,
  };

  const canonicalJson = JSON.stringify(canonicalize(payload));
  if (Buffer.byteLength(canonicalJson, "utf8") > WORKER_AUTO_COMPACT_CAPSULE_MAX_BYTES) {
    throw new ChatSwarmError(
      "INVALID_INPUT",
      `Auto Compact capsule exceeds ${WORKER_AUTO_COMPACT_CAPSULE_MAX_BYTES} bytes`,
    );
  }

  const capsule: WorkerAutoCompactCapsule = {
    ...payload,
    capsuleHash: hashContent(canonicalJson),
  };

  return {
    decision: decisionResult,
    capsule,
    replacementIntent: {
      kind: "REQUEST_REPLACEMENT_CARRIER",
      authority: "NON_AUTHORIZING",
      swarmId: input.worker.swarmId,
      workerId: input.worker.id,
      sourceEpoch: input.worker.continuationEpoch,
      capsuleHash: capsule.capsuleHash,
    },
  };
}

export function verifyWorkerAutoCompactCapsule(value: unknown): WorkerAutoCompactCapsule {
  const record = requireRecord(value, "capsule");
  assertExactKeys(record, CAPSULE_KEYS, "capsule");
  if (record.schema !== WORKER_AUTO_COMPACT_CAPSULE_SCHEMA) {
    invalidCapsule("unsupported schema");
  }

  const pressureRecord = requireRecord(record.pressure, "pressure");
  assertExactKeys(pressureRecord, PRESSURE_KEYS, "pressure");
  const pressure: WorkerContextPressureSignal = {
    precision: requireString(pressureRecord.precision, "pressure.precision") as WorkerContextPressurePrecision,
    source: requireString(pressureRecord.source, "pressure.source") as WorkerContextPressureSource,
    utilizationRatio: requireNumber(pressureRecord.utilizationRatio, "pressure.utilizationRatio"),
    provenance: requireString(pressureRecord.provenance, "pressure.provenance"),
    observedAt: requireString(pressureRecord.observedAt, "pressure.observedAt"),
  };

  const capsule: WorkerAutoCompactCapsule = {
    schema: WORKER_AUTO_COMPACT_CAPSULE_SCHEMA,
    swarmId: requireString(record.swarmId, "swarmId"),
    workerId: requireString(record.workerId, "workerId"),
    sourceEpoch: requireNumber(record.sourceEpoch, "sourceEpoch"),
    checkpointHash: requireString(record.checkpointHash, "checkpointHash"),
    pressure,
    prepareAtRatio: requireNumber(record.prepareAtRatio, "prepareAtRatio"),
    roleInstructions: requireString(record.roleInstructions, "roleInstructions"),
    contextSummary: requireString(record.contextSummary, "contextSummary"),
    summaryAuthority: requireString(record.summaryAuthority, "summaryAuthority") as "CONTEXT_ONLY",
    taskRefs: requireStringArray(record.taskRefs, "taskRefs"),
    resultRefs: requireStringArray(record.resultRefs, "resultRefs"),
    evidenceRefs: requireStringArray(record.evidenceRefs, "evidenceRefs"),
    blockers: requireStringArray(record.blockers, "blockers"),
    claimCeiling: requireString(record.claimCeiling, "claimCeiling"),
    createdAt: requireString(record.createdAt, "createdAt"),
    capsuleHash: requireString(record.capsuleHash, "capsuleHash"),
  };

  try {
    assertBounded(capsule.swarmId, MAX_ID_BYTES, "swarmId");
    assertBounded(capsule.workerId, MAX_ID_BYTES, "workerId");
    validateEpoch(capsule.sourceEpoch);
    validatePressure(capsule.pressure);
    validateThreshold(capsule.prepareAtRatio);
    assertBounded(capsule.roleInstructions, MAX_ROLE_BYTES, "roleInstructions");
    assertBounded(capsule.contextSummary, MAX_SUMMARY_BYTES, "contextSummary");
    assertBounded(capsule.claimCeiling, MAX_CLAIM_CEILING_BYTES, "claimCeiling");
    validateTimestamp(capsule.createdAt, "createdAt");
    validateRefs(capsule.taskRefs, "taskRefs");
    validateRefs(capsule.resultRefs, "resultRefs");
    validateRefs(capsule.evidenceRefs, "evidenceRefs");
    validateBlockers(capsule.blockers);
  } catch (error) {
    if (error instanceof ChatSwarmError) invalidCapsule(error.message);
    throw error;
  }

  if (capsule.summaryAuthority !== "CONTEXT_ONLY") invalidCapsule("summaryAuthority must be CONTEXT_ONLY");
  if (!SHA256.test(capsule.checkpointHash)) invalidCapsule("checkpointHash must be a SHA-256 hash");
  if (!SHA256.test(capsule.capsuleHash)) invalidCapsule("capsuleHash must be a SHA-256 hash");
  if (Date.parse(capsule.createdAt) < Date.parse(capsule.pressure.observedAt)) {
    invalidCapsule("createdAt precedes the pressure observation");
  }

  const { capsuleHash, ...payload } = capsule;
  const canonicalJson = JSON.stringify(canonicalize(payload));
  if (Buffer.byteLength(canonicalJson, "utf8") > WORKER_AUTO_COMPACT_CAPSULE_MAX_BYTES) {
    invalidCapsule(`capsule exceeds ${WORKER_AUTO_COMPACT_CAPSULE_MAX_BYTES} bytes`);
  }
  if (hashContent(canonicalJson) !== capsuleHash) invalidCapsule("capsule hash mismatch");

  return capsule;
}

function decision(
  input: WorkerAutoCompactDecisionInput,
  state: WorkerAutoCompactDecisionState,
  compactRequired: boolean,
  safeToPrepare: boolean,
  reason: string,
): WorkerAutoCompactDecision {
  return {
    state,
    compactRequired,
    safeToPrepare,
    reason,
    sourceEpoch: input.worker.continuationEpoch,
    prepareAtRatio: input.prepareAtRatio,
  };
}

function validateWorkerIdentity(worker: WorkerAutoCompactDecisionInput["worker"]): void {
  assertBounded(worker.id, MAX_ID_BYTES, "workerId");
  assertBounded(worker.swarmId, MAX_ID_BYTES, "swarmId");
}

function validatePressure(pressure: WorkerContextPressureSignal): void {
  if (!(PRESSURE_PRECISIONS as readonly string[]).includes(pressure.precision)) {
    throw new ChatSwarmError("INVALID_INPUT", "unknown context pressure precision");
  }
  if (!(PRESSURE_SOURCES as readonly string[]).includes(pressure.source)) {
    throw new ChatSwarmError("INVALID_INPUT", "unknown context pressure source");
  }
  if (!Number.isFinite(pressure.utilizationRatio) || pressure.utilizationRatio < 0 || pressure.utilizationRatio > 1) {
    throw new ChatSwarmError("INVALID_INPUT", "context utilizationRatio must be between 0 and 1");
  }
  assertBounded(pressure.provenance, MAX_PROVENANCE_BYTES, "pressure provenance");
  validateTimestamp(pressure.observedAt, "pressure observedAt");
  if (pressure.precision === "EXACT" && pressure.source !== "HOST_NATIVE") {
    throw new ChatSwarmError("INVALID_INPUT", "exact context pressure requires a host-native source");
  }
}

function validateThreshold(value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new ChatSwarmError("INVALID_INPUT", "prepareAtRatio must be greater than 0 and at most 1");
  }
}

function validateEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ChatSwarmError("INVALID_INPUT", "continuationEpoch must be a non-negative integer");
  }
}

function computeCheckpointHash(checkpoint: Record<string, unknown> | undefined): string | undefined {
  if (!checkpoint || Array.isArray(checkpoint) || typeof checkpoint !== "object") return undefined;
  const checkpointJson = JSON.stringify(canonicalize(checkpoint));
  if (Buffer.byteLength(checkpointJson, "utf8") > MAX_JSON_BYTES) {
    throw new ChatSwarmError("INVALID_INPUT", `worker checkpoint exceeds ${MAX_JSON_BYTES} bytes`);
  }
  return hashContent(checkpointJson);
}

function validateRefs(values: string[], label: string): string[] {
  if (values.length > MAX_REFS_PER_KIND) {
    throw new ChatSwarmError("INVALID_INPUT", `${label} exceeds ${MAX_REFS_PER_KIND} entries`);
  }
  return values.map((value, index) => {
    assertBounded(value, MAX_REF_BYTES, `${label}[${index}]`);
    return value;
  });
}

function validateBlockers(values: string[]): string[] {
  if (values.length > MAX_BLOCKERS) {
    throw new ChatSwarmError("INVALID_INPUT", `blockers exceeds ${MAX_BLOCKERS} entries`);
  }
  return values.map((value, index) => {
    assertBounded(value, MAX_BLOCKER_BYTES, `blockers[${index}]`);
    return value;
  });
}

function validateTimestamp(value: string, label: string): void {
  assertBounded(value, MAX_TIMESTAMP_BYTES, label);
  if (!Number.isFinite(Date.parse(value))) {
    throw new ChatSwarmError("INVALID_INPUT", `${label} must be a valid timestamp`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") invalidCapsule(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") invalidCapsule(`${label} must be a string`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number") invalidCapsule(`${label} must be a number`);
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    invalidCapsule(`${label} must be an array of strings`);
  }
  return [...value] as string[];
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const extras = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (extras.length > 0) invalidCapsule(`${label} contains unsupported fields: ${extras.join(",")}`);
}

function invalidCapsule(message: string): never {
  throw new ChatSwarmError("INVALID_STATE", `invalid Auto Compact capsule: ${message}`);
}
