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

export const NEXUS_EXECUTION_GRANT_SCHEMA = "nexus.devspace.execution_grant.v1" as const;
export const NEXUS_TOOL_AUTHORITY_SCHEMA = "nexus.devspace.tool_authority.v1" as const;
export const NEXUS_CANONICAL_REPOSITORY = "James3014/Nexus-new" as const;
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
    mode: ExecutionAuthorityMode;
    issuer: "owner" | "nexus";
  };
  authorizedToolCeiling: ToolIntentId[];
  candidateTools: ToolIntentId[];
  selectedTools: ToolIntentId[];
  orderingMode: ToolProjectionOrderingMode;
  candidateOrder?: ToolIntentId[];
}

export interface NexusToolAuthority {
  schema: typeof NEXUS_TOOL_AUTHORITY_SCHEMA;
  namespace: typeof TOOL_INTENT_NAMESPACE;
  plannerDecisionHash: string;
  plannerPlanHash: string;
  policyHash: string;
  authorizedToolCeiling: ToolIntentId[];
}

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
  toolAuthority?: NexusToolAuthority;
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
      | "INVALID_DISPATCH_INTENT"
      | "NEXUS_AUTHORITY_NOT_VALIDATED"
      | "INVALID_NEXUS_EXECUTION_GRANT"
      | "AUTHORITY_EVIDENCE_MISMATCH"
      | "INVALID_TOOL_PROJECTION_MANIFEST"
      | "TOOL_MANIFEST_REF_MISMATCH"
      | "EXECUTION_GENERATION_MISMATCH"
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

export function parseNexusToolAuthority(value: unknown): NexusToolAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", "toolAuthority must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "authorizedToolCeiling,namespace,plannerDecisionHash,plannerPlanHash,policyHash,schema") {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", "toolAuthority must contain the exact governed tool-authority fields.");
  }
  if (record.schema !== NEXUS_TOOL_AUTHORITY_SCHEMA || record.namespace !== TOOL_INTENT_NAMESPACE) {
    throw new ExecutionProtocolError("INVALID_NEXUS_EXECUTION_GRANT", "toolAuthority schema/namespace mismatch.");
  }
  requireHex(record.plannerDecisionHash as string, 64, "toolAuthority.plannerDecisionHash");
  requireHex(record.plannerPlanHash as string, 64, "toolAuthority.plannerPlanHash");
  requireHex(record.policyHash as string, 64, "toolAuthority.policyHash");
  const normalized = normalizeToolIntentSet(
    record.authorizedToolCeiling as string[],
    "toolAuthority.authorizedToolCeiling",
  );
  const present = new Set(normalized);
  const canonical = TOOL_INTENT_IDS.filter((tool) => present.has(tool));
  return {
    schema: NEXUS_TOOL_AUTHORITY_SCHEMA,
    namespace: TOOL_INTENT_NAMESPACE,
    plannerDecisionHash: record.plannerDecisionHash as string,
    plannerPlanHash: record.plannerPlanHash as string,
    policyHash: record.policyHash as string,
    authorizedToolCeiling: canonical,
  };
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
    ...(record.toolAuthority === undefined ? {} : { toolAuthority: parseNexusToolAuthority(record.toolAuthority) }),
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
  authorizedToolCeiling?: ToolIntentId[];
  toolProjectionManifest?: ToolProjectionManifest;
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
  assertNexusGrantToolProjection({
    grant,
    dispatchIntent,
    authorizedToolCeiling: input.authorizedToolCeiling,
    toolProjectionManifest: input.toolProjectionManifest,
  });
  return { kind: "NEXUS_VALIDATED", grantId: grant.grantId, grantHash: grant.grantHash };
}

export function assertNexusGrantToolProjection(input: {
  grant: NexusExecutionGrant;
  dispatchIntent: DispatchIntent;
  authorizedToolCeiling?: ToolIntentId[];
  toolProjectionManifest?: ToolProjectionManifest;
}): void {
  const participates = input.authorizedToolCeiling !== undefined || input.toolProjectionManifest !== undefined;
  if (!participates) return;
  if (!input.authorizedToolCeiling || !input.toolProjectionManifest) {
    throw new ExecutionProtocolError(
      "AUTHORITY_EVIDENCE_MISMATCH",
      "Governed tool projection requires both authorizedToolCeiling and ToolProjectionManifest.",
    );
  }
  if (!input.grant.toolAuthority) {
    throw new ExecutionProtocolError(
      "AUTHORITY_EVIDENCE_MISMATCH",
      "Governed tool projection requires tracked Nexus grant toolAuthority.",
    );
  }

  const grantAuthority = parseNexusToolAuthority(input.grant.toolAuthority);
  const executionCeiling = normalizeToolIntentSet(input.authorizedToolCeiling, "execution authorizedToolCeiling");
  const manifest = parseToolProjectionManifest(input.toolProjectionManifest);
  const sameSet = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((value) => right.includes(value));

  if (!sameSet(executionCeiling, grantAuthority.authorizedToolCeiling)) {
    throw new ExecutionProtocolError(
      "AUTHORITY_EVIDENCE_MISMATCH",
      "Execution authorizedToolCeiling does not match tracked Nexus grant toolAuthority.",
    );
  }
  if (manifest.authority.mode !== "NEXUS_GOVERNED" || manifest.authority.issuer !== "nexus") {
    throw new ExecutionProtocolError(
      "AUTHORITY_EVIDENCE_MISMATCH",
      "Governed ToolProjectionManifest must be issued by Nexus.",
    );
  }
  if (manifest.identity.taskId !== input.dispatchIntent.taskId
    || manifest.identity.attemptId !== input.dispatchIntent.attemptId) {
    throw new ExecutionProtocolError(
      "AUTHORITY_EVIDENCE_MISMATCH",
      "ToolProjectionManifest task/attempt does not match governed dispatch intent.",
    );
  }
  if (!sameSet(manifest.authorizedToolCeiling, executionCeiling)) {
    throw new ExecutionProtocolError(
      "AUTHORITY_EVIDENCE_MISMATCH",
      "ToolProjectionManifest ceiling does not match execution authorizedToolCeiling.",
    );
  }
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
  if (grant.toolAuthority) {
    const normalized = parseNexusToolAuthority(grant.toolAuthority);
    if (normalized.authorizedToolCeiling.join("\n") !== grant.toolAuthority.authorizedToolCeiling.join("\n")) {
      throw new ExecutionProtocolError(
        "INVALID_NEXUS_EXECUTION_GRANT",
        "toolAuthority.authorizedToolCeiling must use canonical DevSpace tool-intent order.",
      );
    }
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
    || (authority.mode !== "OWNER_DIRECT" && authority.mode !== "NEXUS_GOVERNED")
    || (authority.issuer !== "owner" && authority.issuer !== "nexus")) {
    throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", "ToolProjectionManifest authority is invalid.");
  }
  if ((authority.mode === "OWNER_DIRECT" && authority.issuer !== "owner")
    || (authority.mode === "NEXUS_GOVERNED" && authority.issuer !== "nexus")) {
    throw new ExecutionProtocolError("INVALID_TOOL_PROJECTION_MANIFEST", "ToolProjectionManifest authority mode/issuer mismatch.");
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
    authority: { mode: authority.mode, issuer: authority.issuer },
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

export const DIRECT_CANDIDATE_EXECUTION_SCHEMA = "devspace.direct_candidate_execution.v1" as const;

export interface DirectCandidateExecutionAuthority {
  authority_mode: "OWNER_DIRECT";
  execution_lane: "DIRECT_DELEGATED";
  task_id: string;
  attempt_id: string;
  dispatch_intent: DispatchIntent;
  dispatch_intent_hash: string;
  authority_ref: string;
  core_authority_hash: string;
}

export interface DirectCandidateExecutionDetails {
  protocol: typeof EXECUTION_PROTOCOL_VERSION;
  execution_binding_hash: string;
  agent_id: string;
  profile: string;
  provider: string;
  model: string | null;
  effort: string | null;
  provider_session_id: string | null;
  execution_generation: ExecutionGenerationBinding;
  workspace_id: string;
  workspace_root: string;
  state: "completed";
  terminal_reason: "completed";
  retry_safe: false;
  reconciliation_required: false;
  scope_state: "WITHIN_SCOPE";
  started_at: string;
  completed_at: string;
}

export interface DirectCandidateExecutionCoreBinding {
  session_id: string;
  binding: Record<string, unknown>;
  binding_hash: string;
  acceptance_contract_hash: string;
}

export interface DirectCandidateExecutionCandidate {
  present: true;
  required: true;
  source_commit: string;
  source_tree: string;
  commit_sha: string;
  tree_sha: string;
  changed_paths: string[];
  deleted_paths: string[];
  diff_hash: string;
  change_manifest?: {
    source_tree: string;
    target_tree: string;
    entries: Array<{
      path: string;
      change_type: "ADD" | "MODIFY" | "DELETE";
      before_oid: string | null;
      after_oid: string | null;
      before_mode: string | null;
      after_mode: string | null;
    }>;
  };
  provenance_created_at: string;
}

export interface DirectCandidateExecutionClaim {
  status: "CANDIDATE_CAPTURED_PENDING_CORE_VERIFICATION_AND_ACCEPTANCE";
  claim_ceiling: "CANDIDATE_READY";
  core_verified: false;
  certified: false;
  accepted: false;
  approved: false;
  merged: false;
  released: false;
  deployed: false;
  public_claim_allowed: false;
}

export interface DirectCandidateExecutionEvidence {
  schema: typeof DIRECT_CANDIDATE_EXECUTION_SCHEMA;
  evidence_id: string;
  created_at: string;
  authority: DirectCandidateExecutionAuthority;
  execution: DirectCandidateExecutionDetails;
  core_binding: DirectCandidateExecutionCoreBinding;
  candidate: DirectCandidateExecutionCandidate;
  claim: DirectCandidateExecutionClaim;
  integrity: {
    sha256: string;
  };
}

export function computeDirectCandidateEvidenceId(input: {
  agentId: string;
  attemptId: string;
  commitSha: string;
  diffHash: string;
}): string {
  const raw = `${input.agentId}:${input.attemptId}:${input.commitSha}:${input.diffHash}`;
  return `dce_${sha256(raw).slice(0, 32)}`;
}

export function computeDispatchIntentHash(intent: DispatchIntent): string {
  return hashDispatchIntent(intent);
}

export function computeDirectCandidateEvidenceIntegrity(
  evidence: Omit<DirectCandidateExecutionEvidence, "integrity"> & {
    integrity?: { sha256: string };
  },
): string {
  const cloned = {
    ...evidence,
    integrity: { sha256: "0".repeat(64) },
  };
  return sha256(canonicalJson(cloned));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  prefix: string,
): void {
  const actualKeys = Object.keys(record);
  if (actualKeys.length !== expected.length || !expected.every((k) => Object.prototype.hasOwnProperty.call(record, k))) {
    throw new ExecutionProtocolError(
      "INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE",
      `${prefix} keys mismatch. Expected exact keys: [${expected.join(", ")}], got: [${actualKeys.join(", ")}].`,
    );
  }
}

const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const CORE_HASH_RE = /^sha256:[0-9a-f]{64}$/;

export function validateDirectCandidateExecutionEvidence(value: unknown): DirectCandidateExecutionEvidence {
  if (!isRecord(value)) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "Direct evidence must be an object.");
  }

  assertExactKeys(
    value,
    ["schema", "evidence_id", "created_at", "authority", "execution", "core_binding", "candidate", "claim", "integrity"],
    "Direct candidate execution evidence",
  );

  if (value.schema !== DIRECT_CANDIDATE_EXECUTION_SCHEMA) {
    throw new ExecutionProtocolError(
      "INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE",
      `Invalid schema: expected ${DIRECT_CANDIDATE_EXECUTION_SCHEMA}, got ${String(value.schema)}.`,
    );
  }

  if (typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "created_at must be a valid ISO date string.");
  }

  // 1. Authority
  const auth = value.authority;
  if (!isRecord(auth)) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "authority must be an object.");
  }
  assertExactKeys(
    auth,
    ["authority_mode", "execution_lane", "task_id", "attempt_id", "dispatch_intent", "dispatch_intent_hash", "authority_ref", "core_authority_hash"],
    "authority",
  );
  if (auth.authority_mode !== "OWNER_DIRECT") {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "authority.authority_mode must be OWNER_DIRECT.");
  }
  if (auth.execution_lane !== "DIRECT_DELEGATED") {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "authority.execution_lane must be DIRECT_DELEGATED.");
  }
  if (typeof auth.task_id !== "string" || !auth.task_id.trim()) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "authority.task_id must be non-empty.");
  }
  if (typeof auth.attempt_id !== "string" || !auth.attempt_id.trim()) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "authority.attempt_id must be non-empty.");
  }
  const parsedIntent = parseDispatchIntent(auth.dispatch_intent);
  if (parsedIntent.taskId !== auth.task_id || parsedIntent.attemptId !== auth.attempt_id) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "authority task_id/attempt_id does not match dispatch_intent.");
  }
  if (parsedIntent.claimCeiling !== "CANDIDATE_READY") {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "dispatch_intent.claimCeiling must be CANDIDATE_READY.");
  }
  const expectedIntentHash = computeDispatchIntentHash(parsedIntent);
  if (auth.dispatch_intent_hash !== expectedIntentHash) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "authority.dispatch_intent_hash mismatch.");
  }
  if (typeof auth.authority_ref !== "string" || !auth.authority_ref.trim()) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "authority.authority_ref must be non-empty.");
  }
  if (auth.core_authority_hash !== `sha256:${expectedIntentHash}`) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "authority.core_authority_hash mismatch.");
  }

  // 2. Execution
  const exec = value.execution;
  if (!isRecord(exec)) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "execution must be an object.");
  }
  assertExactKeys(
    exec,
    [
      "protocol",
      "execution_binding_hash",
      "agent_id",
      "profile",
      "provider",
      "model",
      "effort",
      "provider_session_id",
      "execution_generation",
      "workspace_id",
      "workspace_root",
      "state",
      "terminal_reason",
      "retry_safe",
      "reconciliation_required",
      "scope_state",
      "started_at",
      "completed_at",
    ],
    "execution",
  );
  if (exec.protocol !== EXECUTION_PROTOCOL_VERSION) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", `execution.protocol must be ${EXECUTION_PROTOCOL_VERSION}.`);
  }
  if (typeof exec.execution_binding_hash !== "string" || !HEX64_RE.test(exec.execution_binding_hash)) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "execution.execution_binding_hash must be 64-hex.");
  }
  for (const field of ["agent_id", "profile", "provider", "workspace_id", "workspace_root"]) {
    if (typeof exec[field] !== "string" || !(exec[field] as string).trim()) {
      throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", `execution.${field} must be non-empty string.`);
    }
  }
  for (const field of ["model", "effort", "provider_session_id"]) {
    if (exec[field] !== null && (typeof exec[field] !== "string" || !(exec[field] as string).trim())) {
      throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", `execution.${field} must be null or non-empty string.`);
    }
  }
  if (exec.state !== "completed" || exec.terminal_reason !== "completed") {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "execution state and terminal_reason must be completed.");
  }
  if (exec.retry_safe !== false) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "execution.retry_safe must be false.");
  }
  if (exec.reconciliation_required !== false) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "execution.reconciliation_required must be false.");
  }
  if (exec.scope_state !== "WITHIN_SCOPE") {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "execution.scope_state must be WITHIN_SCOPE.");
  }
  if (typeof exec.started_at !== "string" || !Number.isFinite(Date.parse(exec.started_at))) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "execution.started_at must be valid date.");
  }
  if (typeof exec.completed_at !== "string" || !Number.isFinite(Date.parse(exec.completed_at))) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "execution.completed_at must be valid date.");
  }

  // Execution generation validation
  const gen = exec.execution_generation;
  if (!isRecord(gen)) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "execution.execution_generation must be an object.");
  }
  const requiredGenKeys = ["profileCatalogGeneration", "provider", "executionIdentity", "devspaceBuildId", "devspaceSourceCommit", "capabilitySurfaceDigest", "executionBindingHash"];
  for (const key of requiredGenKeys) {
    if (typeof gen[key] !== "string" || !gen[key]) {
      throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", `execution_generation.${key} must be a non-empty string.`);
    }
  }
  const expectedCapabilityDigest = sha256(canonicalJson({
    profileCatalogGeneration: gen.profileCatalogGeneration,
    devspaceBuildId: gen.devspaceBuildId,
    devspaceSourceCommit: gen.devspaceSourceCommit,
  }));
  if (gen.capabilitySurfaceDigest !== expectedCapabilityDigest) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "execution_generation.capabilitySurfaceDigest mismatch.");
  }
  const genPayload: Record<string, unknown> = {
    profileCatalogGeneration: gen.profileCatalogGeneration,
    provider: gen.provider,
    executionIdentity: gen.executionIdentity,
    devspaceBuildId: gen.devspaceBuildId,
    devspaceSourceCommit: gen.devspaceSourceCommit,
    capabilitySurfaceDigest: expectedCapabilityDigest,
  };
  if (gen.model !== undefined) genPayload.model = gen.model;
  if (gen.runtimeVersion !== undefined) genPayload.runtimeVersion = gen.runtimeVersion;
  const expectedGenHash = sha256(canonicalJson(genPayload));
  if (gen.executionBindingHash !== expectedGenHash) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "execution_generation.executionBindingHash mismatch.");
  }
  if (gen.executionBindingHash !== exec.execution_binding_hash) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "execution_generation.executionBindingHash does not match execution.execution_binding_hash.");
  }
  if (gen.provider !== exec.provider) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "execution_generation.provider mismatch.");
  }
  if (exec.model !== null && gen.model !== exec.model) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "execution_generation.model mismatch.");
  }
  if (exec.model === null && gen.model !== undefined) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "execution_generation must omit model when execution.model is null.");
  }

  // 3. Core binding
  const core = value.core_binding;
  if (!isRecord(core)) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "core_binding must be an object.");
  }
  assertExactKeys(core, ["session_id", "binding", "binding_hash", "acceptance_contract_hash"], "core_binding");
  if (typeof core.session_id !== "string" || !/^cms_[0-9a-f]{32}$/.test(core.session_id)) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "core_binding.session_id must match cms_<32 hex>.");
  }
  if (!isRecord(core.binding)) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "core_binding.binding must be an object.");
  }
  if (typeof core.binding_hash !== "string" || !CORE_HASH_RE.test(core.binding_hash)) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "core_binding.binding_hash must be sha256:<64 hex>.");
  }
  if (typeof core.acceptance_contract_hash !== "string" || !CORE_HASH_RE.test(core.acceptance_contract_hash)) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "core_binding.acceptance_contract_hash must be sha256:<64 hex>.");
  }

  // 4. Candidate
  const cand = value.candidate;
  if (!isRecord(cand)) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "candidate must be an object.");
  }
  assertExactKeys(
    cand,
    ["present", "required", "source_commit", "source_tree", "commit_sha", "tree_sha", "changed_paths", "deleted_paths", "diff_hash", "change_manifest", "provenance_created_at"],
    "candidate",
  );
  if (cand.present !== true || cand.required !== true) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "candidate present and required must be true.");
  }
  for (const field of ["source_commit", "source_tree", "commit_sha", "tree_sha"]) {
    if (typeof cand[field] !== "string" || !HEX40_RE.test(cand[field] as string)) {
      throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", `candidate.${field} must be 40-hex Git OID.`);
    }
  }
  if (!Array.isArray(cand.changed_paths) || !cand.changed_paths.every((p) => typeof p === "string")) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "candidate.changed_paths must be string array.");
  }
  if (!Array.isArray(cand.deleted_paths) || !cand.deleted_paths.every((p) => typeof p === "string")) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "candidate.deleted_paths must be string array.");
  }
  if (typeof cand.diff_hash !== "string" || !CORE_HASH_RE.test(cand.diff_hash)) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "candidate.diff_hash must be sha256:<64 hex>.");
  }
  if (typeof cand.provenance_created_at !== "string" || !Number.isFinite(Date.parse(cand.provenance_created_at))) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "candidate.provenance_created_at must be valid date.");
  }
  if (cand.provenance_created_at !== value.created_at) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "created_at must equal candidate.provenance_created_at.");
  }

  // 5. Claim
  const claim = value.claim;
  if (!isRecord(claim)) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "claim must be an object.");
  }
  assertExactKeys(
    claim,
    ["status", "claim_ceiling", "core_verified", "certified", "accepted", "approved", "merged", "released", "deployed", "public_claim_allowed"],
    "claim",
  );
  if (claim.status !== "CANDIDATE_CAPTURED_PENDING_CORE_VERIFICATION_AND_ACCEPTANCE") {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "claim.status mismatch.");
  }
  if (claim.claim_ceiling !== "CANDIDATE_READY") {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "claim.claim_ceiling must be CANDIDATE_READY.");
  }
  for (const flag of ["core_verified", "certified", "accepted", "approved", "merged", "released", "deployed", "public_claim_allowed"]) {
    if (claim[flag] !== false) {
      throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", `claim.${flag} must be false.`);
    }
  }

  // 6. Evidence ID
  const expectedEvidenceId = computeDirectCandidateEvidenceId({
    agentId: exec.agent_id as string,
    attemptId: auth.attempt_id as string,
    commitSha: cand.commit_sha as string,
    diffHash: cand.diff_hash as string,
  });
  if (value.evidence_id !== expectedEvidenceId) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", `evidence_id mismatch: expected ${expectedEvidenceId}, got ${String(value.evidence_id)}.`);
  }

  // 7. Integrity
  const integrity = value.integrity;
  if (!isRecord(integrity)) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", "integrity must be an object.");
  }
  assertExactKeys(integrity, ["sha256"], "integrity");
  const expectedIntegrity = computeDirectCandidateEvidenceIntegrity(value as unknown as DirectCandidateExecutionEvidence);
  if (integrity.sha256 !== expectedIntegrity) {
    throw new ExecutionProtocolError("INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE", `integrity.sha256 mismatch: expected ${expectedIntegrity}, got ${String(integrity.sha256)}.`);
  }

  return value as unknown as DirectCandidateExecutionEvidence;
}
