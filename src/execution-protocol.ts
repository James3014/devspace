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
export type ExecutionSelectionSource = "GPT" | "NEXUS" | "OWNER_EXPLICIT";
export type CapabilityAccessMode = "native" | "mcp" | "none";
export type ExecutionEffectCeiling = "READ_ONLY" | "WORKSPACE_MUTATION" | "CANDIDATE";
export type ExecutionEffectState =
  | "NONE_OBSERVED"
  | "POSSIBLE"
  | "OBSERVED"
  | "RECONCILED_NO_EFFECT"
  | "RECONCILED_EFFECT";

/**
 * Explicit worker selection made by the host/Owner or by Nexus only when the
 * host has deliberately entered the Nexus-governed lane. DevSpace validates
 * this binding against the resolved profile; it never chooses or substitutes a
 * worker on the caller's behalf.
 */
export interface ExecutionSelection {
  selectedBy: ExecutionSelectionSource;
  profile: string;
  provider: string;
  model?: string;
  effort?: string;
  decisionRef?: string;
}

export interface ExecutionDispatchControl {
  decisionOwner: "HOST_GPT";
  silentFallbackAllowed: false;
  freshNexusAuthorityRequired: boolean;
  effectState: ExecutionEffectState;
  retrySafe: boolean;
  reconciliationRequired: boolean;
  reasonCode: string;
}

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

export const NEXUS_EXECUTION_GRANT_SCHEMA = "nexus.devspace.execution_grant.v1" as const;
export const NEXUS_CANONICAL_REPOSITORY = "James3014/Nexus-new" as const;

/**
 * Caller-supplied pointer to immutable Nexus authority. The pointer is not
 * authority by itself: the runtime must prove that revision is the current
 * canonical Nexus main revision and load the exact tracked bytes before use.
 */
export interface NexusExecutionGrantRef {
  repository: typeof NEXUS_CANONICAL_REPOSITORY;
  revision: string;
  grantPath: string;
  grantSha256: string;
  authorityPath: string;
  authoritySha256: string;
}

/**
 * Canonical Nexus-owned authorization for one DevSpace attempt. This contract
 * can only narrow execution. Verification/acceptance/merge/release authority
 * is deliberately not representable.
 */
export interface NexusExecutionGrant {
  schema: typeof NEXUS_EXECUTION_GRANT_SCHEMA;
  grantId: string;
  issuer: "nexus";
  taskId: string;
  attemptId: string;
  devspaceBaseRevision: string;
  dispatchIntentHash: string;
  profile: string;
  writeScope: string[];
  effectCeiling: ExecutionEffectCeiling;
  claimCeiling: DispatchClaimCeiling;
  authorityPath: string;
  authoritySha256: string;
  issuedAt: string;
  expiresAt: string;
  revocationState: "NOT_REVOKED" | "REVOKED";
  revokedAt: string | null;
  revocationReason: string | null;
  grantHash: string;
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
      | "INVALID_EXECUTION_SELECTION"
      | "INVALID_DISPATCH_INTENT"
      | "NEXUS_AUTHORITY_NOT_VALIDATED"
      | "INVALID_NEXUS_EXECUTION_GRANT"
      | "AUTHORITY_EVIDENCE_MISMATCH"
      | "EXECUTION_GENERATION_MISMATCH"
      | "LEGACY_EXECUTION_BINDING_MISSING",
    message: string,
  ) {
    super(message);
    this.name = "ExecutionProtocolError";
  }
}

export function parseExecutionSelection(value: unknown): ExecutionSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionProtocolError("INVALID_EXECUTION_SELECTION", "selection must be an object.");
  }
  const record = value as Record<string, unknown>;
  const selection: ExecutionSelection = {
    selectedBy: record.selectedBy as ExecutionSelectionSource,
    profile: record.profile as string,
    provider: record.provider as string,
  };
  if (record.model !== undefined) selection.model = record.model as string;
  if (record.effort !== undefined) selection.effort = record.effort as string;
  if (record.decisionRef !== undefined) selection.decisionRef = record.decisionRef as string;
  validateExecutionSelection(selection);
  return selection;
}

export function validateExecutionSelection(selection: ExecutionSelection): void {
  if (!["GPT", "NEXUS", "OWNER_EXPLICIT"].includes(selection.selectedBy)) {
    throw new ExecutionProtocolError(
      "INVALID_EXECUTION_SELECTION",
      `Unsupported selection.selectedBy: ${selection.selectedBy}`,
    );
  }
  requireSelectionText(selection.profile, "selection.profile");
  requireSelectionText(selection.provider, "selection.provider");
  if (selection.model !== undefined) requireSelectionText(selection.model, "selection.model");
  if (selection.effort !== undefined) requireSelectionText(selection.effort, "selection.effort");
  if (selection.decisionRef !== undefined) requireSelectionText(selection.decisionRef, "selection.decisionRef");
  if (selection.selectedBy === "NEXUS" && !selection.decisionRef) {
    throw new ExecutionProtocolError(
      "INVALID_EXECUTION_SELECTION",
      "NEXUS selection requires selection.decisionRef so the host-visible routing decision is explicit.",
    );
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

export function parseNexusExecutionGrantRef(value: unknown): NexusExecutionGrantRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", "nexusGrant must be an object.");
  }
  const record = value as Record<string, unknown>;
  const ref: NexusExecutionGrantRef = {
    repository: record.repository as typeof NEXUS_CANONICAL_REPOSITORY,
    revision: record.revision as string,
    grantPath: record.grantPath as string,
    grantSha256: record.grantSha256 as string,
    authorityPath: record.authorityPath as string,
    authoritySha256: record.authoritySha256 as string,
  };
  validateNexusExecutionGrantRef(ref);
  return ref;
}

export function validateNexusExecutionGrantRef(ref: NexusExecutionGrantRef): void {
  if (ref.repository !== NEXUS_CANONICAL_REPOSITORY) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", "Nexus execution grant repository is not canonical.");
  }
  requireHex(ref.revision, 40, "nexusGrant.revision");
  requireHex(ref.grantSha256, 64, "nexusGrant.grantSha256");
  requireHex(ref.authoritySha256, 64, "nexusGrant.authoritySha256");
  validateNexusAuthorityPath(ref.grantPath, "nexusGrant.grantPath", ".json");
  validateNexusAuthorityPath(ref.authorityPath, "nexusGrant.authorityPath");
}

export function parseNexusExecutionGrant(value: unknown): NexusExecutionGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", "Tracked Nexus execution grant must be an object.");
  }
  const record = value as Record<string, unknown>;
  const grant: NexusExecutionGrant = {
    schema: record.schema as typeof NEXUS_EXECUTION_GRANT_SCHEMA,
    grantId: record.grantId as string,
    issuer: record.issuer as "nexus",
    taskId: record.taskId as string,
    attemptId: record.attemptId as string,
    devspaceBaseRevision: record.devspaceBaseRevision as string,
    dispatchIntentHash: record.dispatchIntentHash as string,
    profile: record.profile as string,
    writeScope: stringArrayForGrant(record.writeScope, "writeScope"),
    effectCeiling: record.effectCeiling as ExecutionEffectCeiling,
    claimCeiling: record.claimCeiling as DispatchClaimCeiling,
    authorityPath: record.authorityPath as string,
    authoritySha256: record.authoritySha256 as string,
    issuedAt: record.issuedAt as string,
    expiresAt: record.expiresAt as string,
    revocationState: record.revocationState as "NOT_REVOKED" | "REVOKED",
    revokedAt: record.revokedAt as string | null,
    revocationReason: record.revocationReason as string | null,
    grantHash: record.grantHash as string,
  };
  validateNexusExecutionGrant(grant);
  return grant;
}

export function hashNexusExecutionGrant(grant: Omit<NexusExecutionGrant, "grantHash"> | NexusExecutionGrant): string {
  const { grantHash: _grantHash, ...payload } = grant as NexusExecutionGrant;
  return sha256(canonicalJson(payload));
}

export function validateResolvedNexusExecutionGrant(
  ref: NexusExecutionGrantRef,
  grantRaw: string,
  authorityRaw: string,
  observedCanonicalMain: string,
): NexusExecutionGrant {
  validateNexusExecutionGrantRef(ref);
  requireHex(observedCanonicalMain, 40, "observedCanonicalMain");
  if (observedCanonicalMain !== ref.revision) {
    throw new ExecutionProtocolError(
      "NEXUS_AUTHORITY_NOT_VALIDATED",
      `Nexus grant revision ${ref.revision} is not current canonical main ${observedCanonicalMain}; rebind required.`,
    );
  }
  if (sha256(grantRaw) !== ref.grantSha256) {
    throw new ExecutionProtocolError("NEXUS_AUTHORITY_NOT_VALIDATED", "Tracked Nexus execution grant bytes do not match grantSha256.");
  }
  if (sha256(authorityRaw) !== ref.authoritySha256) {
    throw new ExecutionProtocolError("NEXUS_AUTHORITY_NOT_VALIDATED", "Tracked Nexus authority bytes do not match authoritySha256.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(grantRaw);
  } catch {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", "Tracked Nexus execution grant is not valid JSON.");
  }
  const grant = parseNexusExecutionGrant(parsed);
  if (grant.authorityPath !== ref.authorityPath || grant.authoritySha256 !== ref.authoritySha256) {
    throw new ExecutionProtocolError("AUTHORITY_EVIDENCE_MISMATCH", "Nexus execution grant authority binding does not match the tracked authority artifact.");
  }
  return grant;
}

export function assertNexusGrantAuthorizesExecution(input: {
  grant: NexusExecutionGrant;
  dispatchIntent: DispatchIntent;
  expectedHead: string;
  profile: string;
  writePaths: string[];
  now?: Date;
}): AuthorityValidationEvidence {
  const { grant, dispatchIntent, expectedHead, profile, writePaths } = input;
  validateNexusExecutionGrant(grant);
  validateDispatchIntent(dispatchIntent);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new ExecutionProtocolError("NEXUS_AUTHORITY_NOT_VALIDATED", "Current time is invalid for Nexus grant validation.");
  }
  if (grant.revocationState !== "NOT_REVOKED" || grant.revokedAt !== null || grant.revocationReason !== null) {
    throw new ExecutionProtocolError("NEXUS_AUTHORITY_NOT_VALIDATED", "Nexus execution grant is revoked.");
  }
  if (now.getTime() < Date.parse(grant.issuedAt) || now.getTime() >= Date.parse(grant.expiresAt)) {
    throw new ExecutionProtocolError("NEXUS_AUTHORITY_NOT_VALIDATED", "Nexus execution grant is not currently valid.");
  }
  if (grant.taskId !== dispatchIntent.taskId || grant.attemptId !== dispatchIntent.attemptId) {
    throw new ExecutionProtocolError("AUTHORITY_EVIDENCE_MISMATCH", "Nexus grant task/attempt does not match dispatch intent.");
  }
  if (grant.devspaceBaseRevision !== expectedHead.toLowerCase()) {
    throw new ExecutionProtocolError("AUTHORITY_EVIDENCE_MISMATCH", "Nexus grant target base does not match execution expectedHead.");
  }
  if (grant.dispatchIntentHash !== hashDispatchIntent(dispatchIntent)) {
    throw new ExecutionProtocolError("AUTHORITY_EVIDENCE_MISMATCH", "Nexus grant dispatch-intent hash mismatch.");
  }
  if (grant.profile !== profile) {
    throw new ExecutionProtocolError("AUTHORITY_EVIDENCE_MISMATCH", "Nexus grant worker profile mismatch.");
  }
  if (!scopeIsNarrowerOrEqual(writePaths, grant.writeScope)) {
    throw new ExecutionProtocolError("AUTHORITY_EVIDENCE_MISMATCH", "Execution write scope exceeds Nexus grant authority.");
  }
  if (writePaths.length > 0 && grant.effectCeiling === "READ_ONLY") {
    throw new ExecutionProtocolError("AUTHORITY_EVIDENCE_MISMATCH", "Mutating execution exceeds Nexus grant effect ceiling.");
  }
  if (claimCeilingRank(dispatchIntent.claimCeiling) > claimCeilingRank(grant.claimCeiling)) {
    throw new ExecutionProtocolError("AUTHORITY_EVIDENCE_MISMATCH", "Dispatch claim ceiling exceeds Nexus grant authority.");
  }
  return { kind: "NEXUS_VALIDATED", grantId: grant.grantId, grantHash: grant.grantHash };
}

export function validateNexusExecutionGrant(grant: NexusExecutionGrant): void {
  if (grant.schema !== NEXUS_EXECUTION_GRANT_SCHEMA || grant.issuer !== "nexus") {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", "Nexus execution grant schema/issuer mismatch.");
  }
  requireGrantText(grant.grantId, "grantId");
  requireGrantText(grant.taskId, "taskId");
  requireGrantText(grant.attemptId, "attemptId");
  requireHex(grant.devspaceBaseRevision, 40, "devspaceBaseRevision");
  requireHex(grant.dispatchIntentHash, 64, "dispatchIntentHash");
  requireGrantText(grant.profile, "profile");
  validateGrantScope(grant.writeScope);
  if (!["READ_ONLY", "WORKSPACE_MUTATION", "CANDIDATE"].includes(grant.effectCeiling)) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", `Unsupported effectCeiling: ${grant.effectCeiling}`);
  }
  if (!["RESULT_RETURNED", "IMPLEMENTED", "CANDIDATE_READY"].includes(grant.claimCeiling)) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", `Unsupported claimCeiling: ${grant.claimCeiling}`);
  }
  validateNexusAuthorityPath(grant.authorityPath, "authorityPath");
  requireHex(grant.authoritySha256, 64, "authoritySha256");
  requireIsoDate(grant.issuedAt, "issuedAt");
  requireIsoDate(grant.expiresAt, "expiresAt");
  if (Date.parse(grant.issuedAt) >= Date.parse(grant.expiresAt)) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", "Nexus execution grant expiry must be after issuance.");
  }
  if (!["NOT_REVOKED", "REVOKED"].includes(grant.revocationState)) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", "Nexus execution grant revocationState is invalid.");
  }
  if (grant.revocationState === "NOT_REVOKED" && (grant.revokedAt !== null || grant.revocationReason !== null)) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", "Active Nexus execution grant must not carry revocation metadata.");
  }
  if (grant.revocationState === "REVOKED" && (!grant.revokedAt || !grant.revocationReason)) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", "Revoked Nexus execution grant requires revocation metadata.");
  }
  requireHex(grant.grantHash, 64, "grantHash");
  if (grant.grantHash !== hashNexusExecutionGrant(grant)) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", "Nexus execution grant hash mismatch.");
  }
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

function stringArrayForGrant(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", `${field} must be an array of strings.`);
  }
  return value.map((entry) => entry.trim());
}

function requireGrantText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", `${field} must be a non-empty string.`);
  }
}

function requireHex(value: unknown, length: 40 | 64, field: string): asserts value is string {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", `${field} must be lowercase ${length}-hex.`);
  }
}

function requireIsoDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", `${field} must be an ISO timestamp.`);
  }
}

function validateNexusAuthorityPath(value: unknown, field: string, suffix?: string): asserts value is string {
  requireGrantText(value, field);
  const path = value.replaceAll("\\", "/");
  if (!path.startsWith("tasks/") || path.startsWith("/") || path.split("/").includes("..") || (suffix && !path.endsWith(suffix))) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", `${field} must be a canonical tasks/ repository path${suffix ? ` ending in ${suffix}` : ""}.`);
  }
}

function claimCeilingRank(value: DispatchClaimCeiling): number {
  return value === "RESULT_RETURNED" ? 0 : value === "IMPLEMENTED" ? 1 : 2;
}

function normalizeWorkspacePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function scopeIsNarrowerOrEqual(requested: string[], authorized: string[]): boolean {
  const ceilings = authorized.map(normalizeWorkspacePath);
  return requested.map(normalizeWorkspacePath).every((path) =>
    ceilings.some((ceiling) => path === ceiling || path.startsWith(`${ceiling}/`)),
  );
}

function validateGrantScope(value: string[]): void {
  for (const entry of value) {
    requireGrantText(entry, "writeScope entry");
    const path = entry.replaceAll("\\", "/");
    if (path === "." || path.startsWith("/") || path.split("/").includes("..")) {
      throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", `writeScope contains an invalid workspace-relative path: ${entry}`);
    }
  }
}

function requireSelectionText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ExecutionProtocolError("INVALID_EXECUTION_SELECTION", `${field} must be a non-empty string.`);
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
