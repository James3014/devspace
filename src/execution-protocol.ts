import { createHash } from "node:crypto";

/**
 * Common execution vocabulary shared by DevSpace adapters.
 *
 * This module is deliberately mechanical. It records an already-authorized
 * execution decision; it does not select a worker, validate Nexus policy, or
 * grant acceptance/integration authority.
 */
export const EXECUTION_PROTOCOL_VERSION = "devspace.execution.v1" as const;

export type ExecutionAuthorityMode = "OWNER_DIRECT" | "NEXUS_GOVERNED";
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
  mode: ExecutionAuthorityMode;
  /** Logical issuer only. This is not proof that the issuer authorized the request. */
  issuer: "owner" | "nexus";
  grantId?: string;
  grantHash?: string;
}

/**
 * Evidence supplied by a trusted caller boundary, never by the untrusted
 * execution-binding payload itself.
 */
export type AuthorityValidationEvidence =
  | { kind: "OWNER_DIRECT" }
  | { kind: "NEXUS_VALIDATED"; grantId: string; grantHash: string };

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
  executionBindingHash: string;
}

export class ExecutionProtocolError extends Error {
  constructor(
    readonly code:
      | "INVALID_EXECUTION_BINDING"
      | "INVALID_DISPATCH_INTENT"
      | "NEXUS_AUTHORITY_NOT_VALIDATED"
      | "AUTHORITY_EVIDENCE_MISMATCH"
      | "EXECUTION_GENERATION_MISMATCH"
      | "LEGACY_EXECUTION_BINDING_MISSING",
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

  if (binding.authority.mode === "OWNER_DIRECT") {
    if (binding.authority.issuer !== "owner") {
      throw new ExecutionProtocolError("INVALID_EXECUTION_BINDING", "OWNER_DIRECT bindings must name owner as issuer.");
    }
    if (binding.authority.grantId || binding.authority.grantHash) {
      throw new ExecutionProtocolError("INVALID_EXECUTION_BINDING", "OWNER_DIRECT bindings must not invent Nexus grant references.");
    }
  } else {
    if (binding.authority.issuer !== "nexus") {
      throw new ExecutionProtocolError("INVALID_EXECUTION_BINDING", "NEXUS_GOVERNED bindings must name nexus as issuer.");
    }
    requireText(binding.authority.grantId, "authority.grantId");
    requireText(binding.authority.grantHash, "authority.grantHash");
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

/**
 * Authority is validated outside the binding so a caller cannot self-assert a
 * Nexus grant simply by setting a field in JSON. G9 will supply the real Nexus
 * verifier. Until then NEXUS_GOVERNED fails closed without trusted evidence.
 */
export function assertExecutionAuthority(
  authority: ExecutionAuthorityRef,
  evidence?: AuthorityValidationEvidence,
): void {
  if (authority.mode === "OWNER_DIRECT") {
    if (authority.issuer !== "owner" || evidence?.kind !== "OWNER_DIRECT") {
      throw new ExecutionProtocolError("AUTHORITY_EVIDENCE_MISMATCH", "OWNER_DIRECT execution requires trusted owner-direct evidence.");
    }
    return;
  }

  if (authority.issuer !== "nexus" || evidence?.kind !== "NEXUS_VALIDATED") {
    throw new ExecutionProtocolError("NEXUS_AUTHORITY_NOT_VALIDATED", "NEXUS_GOVERNED execution requires external Nexus validation evidence.");
  }
  if (authority.grantId !== evidence.grantId || authority.grantHash !== evidence.grantHash) {
    throw new ExecutionProtocolError("AUTHORITY_EVIDENCE_MISMATCH", "Nexus validation evidence does not match the bound grant identity.");
  }
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
