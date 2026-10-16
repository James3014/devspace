import { createHash } from "node:crypto";

/**
 * Common execution vocabulary shared by DevSpace adapters.
 *
 * This module is deliberately mechanical. It records an already-authorized
 * execution decision; it does not select a worker, validate Nexus policy, or
 * grant acceptance/integration authority.
 */
export const EXECUTION_PROTOCOL_VERSION = "devspace.execution.v1" as const;

export type ExecutionAuthorityMode = "OWNER_DIRECT";
export type CapabilityAccessMode = "native" | "mcp" | "none";
export type ExecutionEffectCeiling = "READ_ONLY" | "WORKSPACE_MUTATION" | "CANDIDATE";

export type DispatchRoleIntent =
  | "EVIDENCE_COLLECTOR"
  | "MECHANICAL_EXECUTOR"
  | "DEEP_ENGINEERING"
  | "TEST_VERIFIER"
  | "INDEPENDENT_REVIEWER"
  | "RECOVERY_RECONCILER";

/**
 * Maximum claim a delegated worker/result is allowed to make. Verification,
 * acceptance, merge, deployment, and release remain controller/governance
 * decisions and are intentionally not representable here.
 */
export type DispatchClaimCeiling = "RESULT_RETURNED" | "IMPLEMENTED" | "CANDIDATE_READY";

export const TOOL_INTENT_NAMESPACE = "devspace.tool_intent.v1" as const;
export const TOOL_PROJECTION_MANIFEST_SCHEMA = "devspace.tool_projection_manifest.v1" as const;

export const TOOL_INTENT_IDS = [
  "workspace.read",
  "workspace.search_text",
  "workspace.search_paths",
  "workspace.list",
  "workspace.mutate",
  "process.execute",
] as const;

export type ToolIntentId = (typeof TOOL_INTENT_IDS)[number];

export type ToolProjectionOrderingMode = "ORDER_INDEPENDENT" | "ORDER_SENSITIVE";

export interface ToolProjectionManifest {
  schema: typeof TOOL_PROJECTION_MANIFEST_SCHEMA;
  namespace: typeof TOOL_INTENT_NAMESPACE;
  identity: {
    taskId: string;
    attemptId: string;
  };
  authority: {
    mode: "OWNER_DIRECT";
    issuer: "owner";
  };
  authorizedToolCeiling: ToolIntentId[];
  candidateTools: ToolIntentId[];
  selectedTools: ToolIntentId[];
  orderingMode: ToolProjectionOrderingMode;
  candidateOrder?: ToolIntentId[];
}

/**
 * Controller-authored semantic contract for one bounded delegated attempt.
 * This is transported/persisted by DevSpace but does not grant routing,
 * admission, verification, acceptance, merge, release, or controller authority.
 */
export interface DispatchIntent {
  taskId: string;
  attemptId: string;
  objective: string;
  roleIntent: DispatchRoleIntent;
  context?: string[];
  readScope?: string[];
  writeScope?: string[];
  exclusiveOwnership: boolean;
  forbiddenChanges?: string[];
  acceptanceCriteria: string[];
  verificationRequired: boolean;
  expectedArtifacts?: string[];
  expectedEvidence?: string[];
  claimCeiling: DispatchClaimCeiling;
}

export interface ExecutionAuthorityRef {
  mode: "OWNER_DIRECT";
  issuer: "owner";
}

export interface ExecutionCapabilityBinding {
  filesystem: CapabilityAccessMode;
  shell: CapabilityAccessMode;
  browser?: CapabilityAccessMode;
  effectCeiling: ExecutionEffectCeiling;
  toolManifestRef?: string;
}

export interface ExecutionIsolationBinding {
  repositoryRoot?: string;
  workspaceId?: string;
  workspaceRoot: string;
  worktreePath?: string;
  expectedHead?: string;
  conversationId?: string;
}

export interface ExecutionWorkerBinding {
  profile: string;
  provider: string;
  model?: string;
  effort?: string;
  runtimeSurface: "cli" | "web" | "desktop" | "api" | "local" | "other";
  sessionMode: "ephemeral" | "durable";
}

export interface ExecutionIdentityBinding {
  taskId: string;
  attemptId: string;
  operationId?: string;
  idempotencyKey?: string;
}

export interface ExecutionBinding {
  version: typeof EXECUTION_PROTOCOL_VERSION;
  authority: ExecutionAuthorityRef;
  identity: ExecutionIdentityBinding;
  worker: ExecutionWorkerBinding;
  capabilities: ExecutionCapabilityBinding;
  isolation: ExecutionIsolationBinding;
}

export type NormalizedExecutionState =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "outcome_unknown"
  | "reconciling";

export interface ExecutionStatus {
  version: typeof EXECUTION_PROTOCOL_VERSION;
  bindingHash: string;
  state: NormalizedExecutionState;
  retrySafe: boolean;
  reconciliationRequired: boolean;
  reasonCode?: string;
  updatedAt: string;
}

export interface ExecutionResult {
  version: typeof EXECUTION_PROTOCOL_VERSION;
  bindingHash: string;
  status: ExecutionStatus;
  output?: string;
  evidenceRefs: string[];
  startedAt?: string;
  completedAt?: string;
  errorCode?: string;
  error?: string;
}

export const HOST_GENERATION_SCHEMA = "devspace.host_generation.v1" as const;

export type ExecutionAuthReadiness = "READY" | "NOT_READY" | "UNKNOWN";

export interface HostGenerationBinding {
  schema: typeof HOST_GENERATION_SCHEMA;
  hostId: string;
  platform: string;
  arch: string;
  homeSha256: string;
  pathSha256: string;
  nodeMajor: string;
  stateRootSha256: string;
  capabilityManifestSha256: string;
  adapterGeneration: string;
  hostGenerationHash: string;
}

/** Material runtime generation pinned to one durable local-agent session. */
export interface ExecutionGenerationBinding {
  profileCatalogGeneration: string;
  provider: string;
  model?: string;
  executionIdentity: string;
  runtimeVersion?: string;
  devspaceBuildId: string;
  devspaceSourceCommit: string;
  capabilitySurfaceDigest: string;
  hostGeneration?: HostGenerationBinding;
  authReadiness?: ExecutionAuthReadiness;
  executionBindingHash: string;
}

export class ExecutionProtocolError extends Error {
  constructor(
    readonly code:
      | "INVALID_EXECUTION_BINDING"
      | "INVALID_DISPATCH_INTENT"
      | "INVALID_TOOL_PROJECTION_MANIFEST"
      | "TOOL_MANIFEST_REF_MISMATCH"
      | "EXECUTION_GENERATION_MISMATCH"
      | "CROSS_HOST_CONTINUATION_REJECTED"
      | "LEGACY_EXECUTION_BINDING_MISSING"
      | "INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE",
    message: string,
  ) {
    super(message);
    this.name = "ExecutionProtocolError";
  }
}

export function parseDispatchIntent(value: unknown): DispatchIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionProtocolError("INVALID_DISPATCH_INTENT", "dispatchIntent must be an object.");
  }
  const record = value as Record<string, unknown>;
  const intent: DispatchIntent = {
    taskId: record.taskId as string,
    attemptId: record.attemptId as string,
    objective: record.objective as string,
    roleIntent: record.roleIntent as DispatchRoleIntent,
    exclusiveOwnership: record.exclusiveOwnership as boolean,
    acceptanceCriteria: stringArrayOrUndefined(record.acceptanceCriteria) ?? [],
    verificationRequired: record.verificationRequired as boolean,
    claimCeiling: record.claimCeiling as DispatchClaimCeiling,
  };
  const optionalArrays: Array<[keyof DispatchIntent, unknown]> = [
    ["context", record.context],
    ["readScope", record.readScope],
    ["writeScope", record.writeScope],
    ["forbiddenChanges", record.forbiddenChanges],
    ["expectedArtifacts", record.expectedArtifacts],
    ["expectedEvidence", record.expectedEvidence],
  ];
  for (const [key, raw] of optionalArrays) {
    const parsed = stringArrayOrUndefined(raw);
    if (parsed !== undefined) (intent as unknown as Record<string, unknown>)[key] = parsed;
  }
  validateDispatchIntent(intent);
  return intent;
}

export function hashDispatchIntent(intent: DispatchIntent): string {
  validateDispatchIntent(intent);
  return sha256(canonicalJson(intent));
}

export function validateDispatchIntent(intent: DispatchIntent): void {
  requireDispatchText(intent.taskId, "taskId");
  requireDispatchText(intent.attemptId, "attemptId");
  requireDispatchText(intent.objective, "objective");
  if (![
    "EVIDENCE_COLLECTOR",
    "MECHANICAL_EXECUTOR",
    "DEEP_ENGINEERING",
    "TEST_VERIFIER",
    "INDEPENDENT_REVIEWER",
    "RECOVERY_RECONCILER",
  ].includes(intent.roleIntent)) {
    throw new ExecutionProtocolError("INVALID_DISPATCH_INTENT", `Unsupported roleIntent: ${intent.roleIntent}`);
  }
  if (!["RESULT_RETURNED", "IMPLEMENTED", "CANDIDATE_READY"].includes(intent.claimCeiling)) {
    throw new ExecutionProtocolError("INVALID_DISPATCH_INTENT", `Unsupported claimCeiling: ${intent.claimCeiling}`);
  }
  if (!Array.isArray(intent.acceptanceCriteria) || intent.acceptanceCriteria.length === 0) {
    throw new ExecutionProtocolError("INVALID_DISPATCH_INTENT", "acceptanceCriteria must contain at least one independently checkable criterion.");
  }
  for (const [index, criterion] of intent.acceptanceCriteria.entries()) {
    requireDispatchText(criterion, `acceptanceCriteria[${index}]`);
  }
  if (typeof intent.verificationRequired !== "boolean" || typeof intent.exclusiveOwnership !== "boolean") {
    throw new ExecutionProtocolError("INVALID_DISPATCH_INTENT", "verificationRequired and exclusiveOwnership must be boolean values.");
  }
  validateDispatchStringArray(intent.context, "context");
  validateDispatchScope(intent.readScope, "readScope", true);
  validateDispatchScope(intent.writeScope, "writeScope", false);
  validateDispatchStringArray(intent.forbiddenChanges, "forbiddenChanges");
  validateDispatchStringArray(intent.expectedArtifacts, "expectedArtifacts");
  validateDispatchStringArray(intent.expectedEvidence, "expectedEvidence");

  const mutating = Boolean(intent.writeScope?.length);
  if (mutating && !intent.exclusiveOwnership) {
    throw new ExecutionProtocolError(
      "INVALID_DISPATCH_INTENT",
      "Mutating dispatch intent requires exclusiveOwnership=true; controllers must serialize or isolate overlapping mutation.",
    );
  }
  if (!mutating && intent.exclusiveOwnership) {
    throw new ExecutionProtocolError(
      "INVALID_DISPATCH_INTENT",
      "Read-only dispatch intent must not claim exclusive mutation ownership.",
    );
  }
}

const TOOL_INTENT_ID_SET = new Set<ToolIntentId>(TOOL_INTENT_IDS);

export function normalizeToolIntentSet(value: readonly string[], field = "tool intent set"): ToolIntentId[] {
  if (!Array.isArray(value)) {
    throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", `${field} must be an array.`);
  }
  const seen = new Set<string>();
  const normalized: ToolIntentId[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !TOOL_INTENT_ID_SET.has(raw as ToolIntentId)) {
      throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", `${field} contains unknown tool intent: ${String(raw)}`);
    }
    if (seen.has(raw)) {
      throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", `${field} contains duplicate tool intent: ${raw}`);
    }
    seen.add(raw);
    normalized.push(raw as ToolIntentId);
  }
  return normalized.sort((a, b) => a.localeCompare(b));
}

function toolIntentOrder(value: unknown, field: string): ToolIntentId[] {
  if (!Array.isArray(value)) {
    throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", `${field} must be an array.`);
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    if (typeof raw !== "string" || !TOOL_INTENT_ID_SET.has(raw as ToolIntentId)) {
      throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", `${field} contains unknown tool intent: ${String(raw)}`);
    }
    if (seen.has(raw)) {
      throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", `${field} contains duplicate tool intent: ${raw}`);
    }
    seen.add(raw);
    return raw as ToolIntentId;
  });
}

export function parseToolProjectionManifest(value: unknown): ToolProjectionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", "ToolProjectionManifest must be an object.");
  }
  const record = value as Record<string, unknown>;
  const identity = record.identity as Record<string, unknown> | undefined;
  const authority = record.authority as Record<string, unknown> | undefined;
  if (record.schema !== TOOL_PROJECTION_MANIFEST_SCHEMA || record.namespace !== TOOL_INTENT_NAMESPACE) {
    throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", "ToolProjectionManifest schema/namespace mismatch.");
  }
  if (!identity || typeof identity !== "object" || Array.isArray(identity)
    || typeof identity.taskId !== "string" || !identity.taskId.trim()
    || typeof identity.attemptId !== "string" || !identity.attemptId.trim()) {
    throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", "ToolProjectionManifest requires taskId and attemptId.");
  }
  if (!authority || typeof authority !== "object" || Array.isArray(authority)
    || authority.mode !== "OWNER_DIRECT"
    || authority.issuer !== "owner") {
    throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", "ToolProjectionManifest authority must be OWNER_DIRECT/owner.");
  }

  const authorizedToolCeiling = normalizeToolIntentSet(record.authorizedToolCeiling as string[], "authorizedToolCeiling");
  const candidateTools = normalizeToolIntentSet(record.candidateTools as string[], "candidateTools");
  const selectedTools = normalizeToolIntentSet(record.selectedTools as string[], "selectedTools");
  const ceiling = new Set(authorizedToolCeiling);
  const candidates = new Set(candidateTools);
  if (!candidateTools.every((tool) => ceiling.has(tool))) {
    throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", "candidateTools exceed authorizedToolCeiling.");
  }
  if (!selectedTools.every((tool) => candidates.has(tool))) {
    throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", "selectedTools exceed candidateTools.");
  }

  const orderingMode = record.orderingMode as ToolProjectionOrderingMode;
  if (orderingMode !== "ORDER_INDEPENDENT" && orderingMode !== "ORDER_SENSITIVE") {
    throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", "orderingMode must be ORDER_INDEPENDENT or ORDER_SENSITIVE.");
  }
  let candidateOrder: ToolIntentId[] | undefined;
  if (orderingMode === "ORDER_INDEPENDENT") {
    if (record.candidateOrder !== undefined) {
      throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", "ORDER_INDEPENDENT manifest must not carry candidateOrder.");
    }
  } else {
    candidateOrder = toolIntentOrder(record.candidateOrder, "candidateOrder");
    if (candidateOrder.length !== candidateTools.length
      || !candidateTools.every((tool) => candidateOrder!.includes(tool))) {
      throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", "candidateOrder must be an exact permutation of candidateTools.");
    }
  }

  return {
    schema: TOOL_PROJECTION_MANIFEST_SCHEMA,
    namespace: TOOL_INTENT_NAMESPACE,
    identity: { taskId: identity.taskId.trim(), attemptId: identity.attemptId.trim() },
    authority: { mode: "OWNER_DIRECT", issuer: "owner" },
    authorizedToolCeiling,
    candidateTools,
    selectedTools,
    orderingMode,
    ...(candidateOrder ? { candidateOrder } : {}),
  };
}

export function hashToolProjectionManifest(value: ToolProjectionManifest): string {
  return sha256(canonicalJson(parseToolProjectionManifest(value)));
}

export function toolProjectionManifestRef(value: ToolProjectionManifest): string {
  return `sha256:${hashToolProjectionManifest(value)}`;
}

export function assertToolManifestRef(ref: string, manifest: ToolProjectionManifest): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(ref) || ref !== toolProjectionManifestRef(manifest)) {
    throw new ExecutionProtocolError("TOOL_MANIFEST_REF_MISMATCH", "toolManifestRef does not match ToolProjectionManifest content identity.");
  }
}

export function assertExecutionBindingToolManifest(binding: ExecutionBinding, manifestValue: ToolProjectionManifest): void {
  const manifest = parseToolProjectionManifest(manifestValue);
  if (binding.identity.taskId !== manifest.identity.taskId || binding.identity.attemptId !== manifest.identity.attemptId) {
    throw new ExecutionProtocolError("TOOL_MANIFEST_REF_MISMATCH", "ExecutionBinding task/attempt does not match ToolProjectionManifest.");
  }
  if (binding.authority.mode !== manifest.authority.mode || binding.authority.issuer !== manifest.authority.issuer) {
    throw new ExecutionProtocolError("TOOL_MANIFEST_REF_MISMATCH", "ExecutionBinding authority does not match ToolProjectionManifest.");
  }
  if (!binding.capabilities.toolManifestRef) {
    throw new ExecutionProtocolError("TOOL_MANIFEST_REF_MISMATCH", "ExecutionBinding is missing toolManifestRef.");
  }
  assertToolManifestRef(binding.capabilities.toolManifestRef, manifest);
}

export function renderDispatchIntentForWorker(intent: DispatchIntent): string {
  validateDispatchIntent(intent);
  return [
    "DEVSPACE DISPATCH CONTRACT — controller-authored, bounded execution only.",
    "Do not broaden scope or claim VERIFIED, ACCEPTED, MERGED, DEPLOYED, or RELEASED authority.",
    canonicalJson(intent),
  ].join("\n");
}

export function hashExecutionBinding(binding: ExecutionBinding): string {
  validateExecutionBinding(binding);
  return sha256(canonicalJson(binding));
}

export function validateExecutionBinding(binding: ExecutionBinding): void {
  if (binding.version !== EXECUTION_PROTOCOL_VERSION) {
    throw new ExecutionProtocolError("INVALID_EXECUTION_BINDING", `Unsupported execution binding version: ${binding.version}`);
  }
  requireText(binding.identity.taskId, "identity.taskId");
  requireText(binding.identity.attemptId, "identity.attemptId");
  requireText(binding.worker.profile, "worker.profile");
  requireText(binding.worker.provider, "worker.provider");
  requireText(binding.isolation.workspaceRoot, "isolation.workspaceRoot");

  if (binding.authority.mode !== "OWNER_DIRECT" || binding.authority.issuer !== "owner") {
    throw new ExecutionProtocolError("INVALID_EXECUTION_BINDING", "Execution binding authority must be OWNER_DIRECT/owner.");
  }

  if (binding.capabilities.effectCeiling !== "READ_ONLY") {
    if (binding.capabilities.filesystem === "none") {
      throw new ExecutionProtocolError("INVALID_EXECUTION_BINDING", "Mutating execution requires a declared filesystem capability path.");
    }
    if (!binding.isolation.workspaceId && !binding.isolation.worktreePath) {
      throw new ExecutionProtocolError("INVALID_EXECUTION_BINDING", "Mutating execution requires explicit workspace/worktree isolation identity.");
    }
  }
}

export function buildHostGenerationBinding(input: {
  hostName: string;
  platform: string;
  arch: string;
  homeDir: string;
  pathEnv: string;
  nodeVersion: string;
  stateRoot: string;
  capabilityManifestSha256: string;
  adapterGeneration: string;
}): HostGenerationBinding {
  const homeSha256 = sha256(input.homeDir);
  const pathSha256 = sha256(input.pathEnv);
  const stateRootSha256 = sha256(input.stateRoot);
  const nodeMajor = input.nodeVersion.split(".")[0] || input.nodeVersion;
  const hostId = `local:${sha256(canonicalJson({
    hostName: input.hostName,
    platform: input.platform,
    arch: input.arch,
    homeSha256,
    stateRootSha256,
  }))}`;
  const withoutHash = {
    schema: HOST_GENERATION_SCHEMA,
    hostId,
    platform: input.platform,
    arch: input.arch,
    homeSha256,
    pathSha256,
    nodeMajor,
    stateRootSha256,
    capabilityManifestSha256: input.capabilityManifestSha256,
    adapterGeneration: input.adapterGeneration,
  };
  return {
    ...withoutHash,
    hostGenerationHash: sha256(canonicalJson(withoutHash)),
  };
}

function hostGenerationIsValid(value: unknown): value is HostGenerationBinding {
  if (!isRecord(value)) return false;
  if (
    value.schema !== HOST_GENERATION_SCHEMA ||
    typeof value.hostId !== "string" ||
    !/^local:[0-9a-f]{64}$/.test(value.hostId) ||
    typeof value.platform !== "string" ||
    typeof value.arch !== "string" ||
    typeof value.homeSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.homeSha256) ||
    typeof value.pathSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.pathSha256) ||
    typeof value.nodeMajor !== "string" ||
    !/^\d+$/.test(value.nodeMajor) ||
    typeof value.stateRootSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.stateRootSha256) ||
    typeof value.capabilityManifestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.capabilityManifestSha256) ||
    typeof value.adapterGeneration !== "string" ||
    value.adapterGeneration.length === 0 ||
    typeof value.hostGenerationHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.hostGenerationHash)
  ) return false;
  const { hostGenerationHash: _ignored, ...withoutHash } = value;
  return value.hostGenerationHash === sha256(canonicalJson(withoutHash));
}

export function buildExecutionGenerationBinding(input: Omit<ExecutionGenerationBinding, "capabilitySurfaceDigest" | "executionBindingHash"> & {
  capabilitySurfaceDigest?: string;
}): ExecutionGenerationBinding {
  const capabilitySurfaceDigest = input.capabilitySurfaceDigest ?? sha256(canonicalJson({
    profileCatalogGeneration: input.profileCatalogGeneration,
    devspaceBuildId: input.devspaceBuildId,
    devspaceSourceCommit: input.devspaceSourceCommit,
  }));
  const withoutHash = {
    profileCatalogGeneration: input.profileCatalogGeneration,
    provider: input.provider,
    model: input.model,
    executionIdentity: input.executionIdentity,
    runtimeVersion: input.runtimeVersion,
    devspaceBuildId: input.devspaceBuildId,
    devspaceSourceCommit: input.devspaceSourceCommit,
    capabilitySurfaceDigest,
    ...(input.hostGeneration ? { hostGeneration: input.hostGeneration } : {}),
    ...(input.authReadiness ? { authReadiness: input.authReadiness } : {}),
  };
  return {
    ...withoutHash,
    executionBindingHash: sha256(canonicalJson(withoutHash)),
  };
}

export function assertSameExecutionGeneration(
  stored: ExecutionGenerationBinding | undefined,
  current: ExecutionGenerationBinding,
): void {
  if (!stored) {
    throw new ExecutionProtocolError(
      "LEGACY_EXECUTION_BINDING_MISSING",
      "Durable agent predates execution-generation binding and requires explicit rebind instead of silent continuation.",
    );
  }
  if (current.hostGeneration) {
    if (!stored.hostGeneration) {
      throw new ExecutionProtocolError(
        "CROSS_HOST_CONTINUATION_REJECTED",
        "Durable execution generation predates host-generation binding; cross-host-equivalent continuation cannot be proven.",
      );
    }
    if (stored.hostGeneration.hostGenerationHash !== current.hostGeneration.hostGenerationHash) {
      throw new ExecutionProtocolError(
        "CROSS_HOST_CONTINUATION_REJECTED",
        `Host generation changed (stored ${stored.hostGeneration.hostGenerationHash}, current ${current.hostGeneration.hostGenerationHash}); explicit rebind required.`,
      );
    }
  }
  if (stored.executionBindingHash !== current.executionBindingHash) {
    throw new ExecutionProtocolError(
      "EXECUTION_GENERATION_MISMATCH",
      `Durable execution generation changed (stored ${stored.executionBindingHash}, current ${current.executionBindingHash}); rebind required.`,
    );
  }
}

export function serializeExecutionGenerationBinding(binding: ExecutionGenerationBinding | undefined): string | null {
  return binding ? JSON.stringify(binding) : null;
}

export function deserializeExecutionGenerationBinding(value: string | null | undefined): ExecutionGenerationBinding | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<ExecutionGenerationBinding>;
    if (
      typeof parsed.profileCatalogGeneration !== "string" ||
      typeof parsed.provider !== "string" ||
      typeof parsed.executionIdentity !== "string" ||
      typeof parsed.devspaceBuildId !== "string" ||
      typeof parsed.devspaceSourceCommit !== "string" ||
      typeof parsed.capabilitySurfaceDigest !== "string" ||
      typeof parsed.executionBindingHash !== "string"
    ) return undefined;
    if (parsed.hostGeneration !== undefined && !hostGenerationIsValid(parsed.hostGeneration)) return undefined;
    if (
      parsed.authReadiness !== undefined &&
      !["READY", "NOT_READY", "UNKNOWN"].includes(parsed.authReadiness)
    ) return undefined;
    return parsed as ExecutionGenerationBinding;
  } catch {
    return undefined;
  }
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ExecutionProtocolError("INVALID_EXECUTION_BINDING", `${field} must be a non-empty string.`);
  }
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new ExecutionProtocolError("INVALID_DISPATCH_INTENT", "Expected an array of strings.");
  }
  return value.map((entry) => entry.trim());
}

function requireDispatchText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ExecutionProtocolError("INVALID_DISPATCH_INTENT", `${field} must be a non-empty string.`);
  }
}

function validateDispatchStringArray(value: string[] | undefined, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new ExecutionProtocolError("INVALID_DISPATCH_INTENT", `${field} must be an array of strings.`);
  }
  value.forEach((entry, index) => requireDispatchText(entry, `${field}[${index}]`));
}

function validateDispatchScope(value: string[] | undefined, field: string, allowRoot: boolean): void {
  validateDispatchStringArray(value, field);
  for (const entry of value ?? []) {
    const path = entry.trim().replaceAll("\\", "/");
    if ((!allowRoot && path === ".") || path.startsWith("/") || path.split("/").includes("..")) {
      throw new ExecutionProtocolError("INVALID_DISPATCH_INTENT", `${field} contains an invalid workspace-relative path: ${entry}`);
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
