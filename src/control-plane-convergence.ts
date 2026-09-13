import { createHash } from "node:crypto";

/** The only production authority role permitted by this contract. */
export type ControlPlaneRoleKind =
  | "AUTHORITATIVE_PRODUCTION"
  | "NON_AUTHORITATIVE_CANARY"
  | "NON_AUTHORITATIVE_MIGRATION_SOURCE"
  | "NON_AUTHORITATIVE_TEST";

export const CANONICAL_CHAT_SWARM_RUNTIME_TOOLS = [
  "chat_swarm_runtime_status",
  "chat_swarm_runtime_ensure",
  "chat_swarm_runtime_scale",
  "chat_swarm_runtime_recover",
  "chat_swarm_runtime_stop",
  "chat_swarm_runtime_bootstrap",
] as const;

export type ControlPlaneDomain =
  | "workspace_sessions"
  | "agent_sessions"
  | "durable_operations"
  | "chat_swarm_records"
  | "oauth_authority";

export interface DurableStateInventory {
  workspaceSessions: number;
  agentSessions: number;
  durableOperations: number;
  oauthClients: number;
  activeSwarms: number;
  workers: number;
  tasks: number;
  inFlightOperations: number;
  unknownOperations: number;
  reconcileRequired: number;
  /** Operational reconcile-required work; historical task rows are not counted here. */
  activeReconcileRequired?: number;
}

export interface RetiredReadOnlyAuthorityAttestation {
  schema: "devspace.retired_read_only_authority_attestation.v1";
  state: "RETIRED_READ_ONLY";
  operationId: string;
  requestHash: string;
  sourceRole: string;
  destinationRole: string;
  readOnly: true;
  historicalStateQueryable: true;
  routingAuthorityReleased: true;
  oauthAuthorityReleased: true;
  runtimeOwnerReleased: true;
  activeSessions: 0;
  contentHash?: string;
}

export interface PhysicalServiceInventory {
  role: string;
  roleKind: ControlPlaneRoleKind;
  serviceIdentity: {
    serviceName: string;
    serverInstanceId: string;
  };
  endpoint: { url: string; port: number };
  oauth: {
    callback?: string;
    clientIds: string[];
    authorityRole?: string;
  };
  stateDirectory: string;
  allowedRoots: string[];
  buildIdentity: { sourceCommit: string; buildId: string };
  capabilityManifest: {
    sha256: string;
    catalogGeneration: string;
    tools: string[];
  };
  featureFlags: Record<string, boolean | string | number>;
  durableState: DurableStateInventory;
  runtimeOwner: { held: boolean; pid?: number };
  routingAuthority: { active: boolean; endpoint?: string };
  configuredMaxCapacity: number;
  /** Explicit proof that this service is retained as queryable history only. */
  retiredReadOnlyAttestation?: RetiredReadOnlyAuthorityAttestation;
  sourceDrift?: boolean;
  /** Optional expected identity/catalog values supplied by a fresh probe. */
  expected?: {
    sourceCommit?: string;
    buildId?: string;
    capabilityManifestSha256?: string;
    catalogGeneration?: string;
  };
}

export interface ControlPlaneInventory {
  services: PhysicalServiceInventory[];
  canonicalRole: string;
  retirementCandidateRole: string;
  /** Explicitly selected durable-state owners; derived from the role only when omitted. */
  canonicalStateDirectory?: string;
  retirementCandidateStateDirectory?: string;
  /** Exact typed reconciliation proof required before retirement can be committed. */
  retirementReceipt?: ControlPlaneReconciliationReceipt;
  /** Freshness attestation for a production-loaded topology manifest. */
  observedAt?: string;
  maxAgeSeconds?: number;
  manifestRequired?: boolean;
}

export interface ControlPlaneTopologyManifest {
  schema: "devspace.control_plane_topology_manifest.v1";
  observedAt: string;
  maxAgeSeconds: number;
  inventory: Omit<ControlPlaneInventory, "observedAt" | "maxAgeSeconds" | "manifestRequired">;
}

export interface ControlPlaneBlocker {
  code:
    | "DUPLICATE_PRODUCTION_OWNERS"
    | "MISSING_INVENTORY"
    | "CANONICAL_ROLE_INVALID"
    | "RETIREMENT_CANDIDATE_INVALID"
    | "IDENTITY_DRIFT"
    | "CAPABILITY_MANIFEST_DRIFT"
    | "SESSION_CATALOG_DRIFT"
    | "SOURCE_DRIFT"
    | "CAPACITY_BELOW_MINIMUM"
    | "MISSING_CANONICAL_TOOL"
    | "STRANDED_DURABLE_STATE"
    | "RECONCILE_REQUIRED_STATE"
    | "RUNTIME_OWNER_HELD"
    | "OAUTH_AUTHORITY_STRANDED"
    | "OAUTH_AUTHORITY_MISMATCH"
    | "ROUTING_AUTHORITY_STRANDED"
    | "RETIREMENT_ATTESTATION_INVALID"
    | "TOPOLOGY_MANIFEST_STALE";
  role?: string;
  detail: string;
}

export interface ControlPlaneConvergenceEvaluation {
  schema: "devspace.control_plane_convergence.v1";
  converged: boolean;
  canonicalRole: string;
  retirementCandidateRole: string;
  canonicalStateDirectory?: string;
  retirementCandidateStateDirectory?: string;
  retirementReceipt?: ControlPlaneReconciliationReceipt;
  authoritativeProductionRoles: string[];
  nonAuthoritativeRoles: string[];
  eligibleToRetire: boolean;
  blockers: ControlPlaneBlocker[];
  services: PhysicalServiceInventory[];
}

export class ControlPlaneConvergenceError extends Error {
  constructor(
    readonly code: ControlPlaneBlocker["code"] | "REPLAY_CONFLICT" | "RECONCILE_REQUIRED" | "INVALID_PLAN",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ControlPlaneConvergenceError";
  }
}

export interface ControlPlaneReconciliationStep {
  stepId: string;
  kind: "DOMAIN_RECORD_RECONCILIATION";
  domain: ControlPlaneDomain;
  sourceRole: string;
  destinationRole: string;
  recordCount: number;
  authority: "CANONICAL_STATE_ONLY";
  oauthSecretsCopied: false;
}

export interface ControlPlaneReconciliationPlan {
  schema: "devspace.control_plane_reconciliation_plan.v1";
  operationId: string;
  requestHash: string;
  sourceRole: string;
  destinationRole: string;
  sourceBinding: ControlPlaneServiceBinding;
  destinationBinding: ControlPlaneServiceBinding;
  domains: ControlPlaneDomain[];
  steps: ControlPlaneReconciliationStep[];
  retrySafe: false;
  rawSqliteMerge: false;
}

export interface ControlPlaneServiceBinding {
  serverInstanceId: string;
  sourceCommit: string;
  buildId: string;
  capabilityManifestSha256: string;
  catalogGeneration: string;
  stateDirectory: string;
}

export type ControlPlaneReconciliationState =
  | "PLANNED"
  | "IN_FLIGHT"
  | "SUCCEEDED"
  | "FAILED"
  | "OUTCOME_UNKNOWN"
  | "RECONCILE_REQUIRED";

export interface ControlPlaneReconciliationReceipt {
  schema: "devspace.control_plane_reconciliation_receipt.v1";
  operationId: string;
  requestHash: string;
  sourceRole: string;
  destinationRole: string;
  sourceBinding: ControlPlaneServiceBinding;
  destinationBinding: ControlPlaneServiceBinding;
  state: ControlPlaneReconciliationState;
  retryAllowed: boolean;
  effectCount: number;
  /** Optional domain-bundle content hash carried into retirement proof binding. */
  contentHash?: string;
  detail?: string;
  evidenceRef?: string;
}

export interface ReconciliationPlanRequest {
  operationId: string;
  request: {
    sourceRole: string;
    destinationRole: string;
    domains: ControlPlaneDomain[];
  };
}

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REQUIRED_TOOLS = new Set<string>(CANONICAL_CHAT_SWARM_RUNTIME_TOOLS);
const ROLE_KINDS = new Set<ControlPlaneRoleKind>([
  "AUTHORITATIVE_PRODUCTION",
  "NON_AUTHORITATIVE_CANARY",
  "NON_AUTHORITATIVE_MIGRATION_SOURCE",
  "NON_AUTHORITATIVE_TEST",
]);

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Parse the only production topology input. No role or connector-name inference is permitted. */
export function parseControlPlaneTopologyManifest(raw: unknown): ControlPlaneInventory {
  const manifest = recordValue(raw);
  const inventory = recordValue(manifest?.inventory);
  if (manifest?.schema !== "devspace.control_plane_topology_manifest.v1" || !inventory) {
    throw new ControlPlaneConvergenceError("MISSING_INVENTORY", "topology manifest schema or inventory is invalid");
  }
  if (typeof manifest.observedAt !== "string" || !Number.isSafeInteger(manifest.maxAgeSeconds) || Number(manifest.maxAgeSeconds) <= 0) {
    throw new ControlPlaneConvergenceError("MISSING_INVENTORY", "topology manifest freshness binding is invalid");
  }
  if (!Array.isArray(inventory.services) || typeof inventory.canonicalRole !== "string" || typeof inventory.retirementCandidateRole !== "string") {
    throw new ControlPlaneConvergenceError("MISSING_INVENTORY", "topology manifest must select canonical and retirement roles");
  }
  for (const service of inventory.services) {
    const item = recordValue(service);
    if (!item || typeof item.role !== "string" || typeof item.roleKind !== "string" || !ROLE_KINDS.has(item.roleKind as ControlPlaneRoleKind)) {
      throw new ControlPlaneConvergenceError("MISSING_INVENTORY", "every physical service must declare an explicit roleKind");
    }
    if (/secret|token/i.test(JSON.stringify(item))) {
      throw new ControlPlaneConvergenceError("MISSING_INVENTORY", "topology manifests cannot contain OAuth secrets or tokens");
    }
  }
  return {
    ...inventory as unknown as Omit<ControlPlaneInventory, "observedAt" | "maxAgeSeconds" | "manifestRequired">,
    observedAt: manifest.observedAt,
    maxAgeSeconds: Number(manifest.maxAgeSeconds),
    manifestRequired: true,
  };
}

export const parseControlPlaneInventory = parseControlPlaneTopologyManifest;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function inventoryBlockers(service: PhysicalServiceInventory, canonical: PhysicalServiceInventory | undefined, minimumCapacity: number): ControlPlaneBlocker[] {
  const blockers: ControlPlaneBlocker[] = [];
  const isCanonicalProduction = canonical?.role === service.role && canonical.roleKind === "AUTHORITATIVE_PRODUCTION" && service.roleKind === "AUTHORITATIVE_PRODUCTION";
  const missing = [
    ["service identity", service.serviceIdentity?.serviceName],
    ["server instance identity", service.serviceIdentity?.serverInstanceId],
    ["endpoint", service.endpoint?.url],
    ["state directory", service.stateDirectory],
    ["build source commit", service.buildIdentity?.sourceCommit],
    ["build id", service.buildIdentity?.buildId],
    ["capability manifest", service.capabilityManifest?.sha256],
    ["catalog generation", service.capabilityManifest?.catalogGeneration],
  ].filter(([, value]) => typeof value !== "string" || value.length === 0 || value === "unknown");
  const durableCounts = service.durableState && [
    service.durableState.workspaceSessions,
    service.durableState.agentSessions,
    service.durableState.durableOperations,
    service.durableState.oauthClients,
    service.durableState.activeSwarms,
    service.durableState.workers,
    service.durableState.tasks,
    service.durableState.inFlightOperations,
    service.durableState.unknownOperations,
    service.durableState.reconcileRequired,
  ];
  const invalidDurableCounts = !durableCounts || durableCounts.some((count) => !nonNegativeInteger(count));
  if (
    missing.length > 0 ||
    !Array.isArray(service.allowedRoots) ||
    service.allowedRoots.length === 0 ||
    !Array.isArray(service.oauth?.clientIds) ||
    !service.durableState ||
    invalidDurableCounts ||
    !service.runtimeOwner ||
    !service.routingAuthority ||
    typeof service.routingAuthority.active !== "boolean" ||
    (service.durableState.activeReconcileRequired !== undefined && !nonNegativeInteger(service.durableState.activeReconcileRequired))
  ) {
    blockers.push({ code: "MISSING_INVENTORY", role: service.role, detail: `inventory is incomplete (${missing.map(([label]) => label).join(", ") || "nested state"})` });
    return blockers;
  }
  if (!COMMIT.test(service.buildIdentity.sourceCommit)) blockers.push({ code: "IDENTITY_DRIFT", role: service.role, detail: "sourceCommit is not a full commit identity" });
  if (!SHA256.test(service.capabilityManifest.sha256)) blockers.push({ code: "CAPABILITY_MANIFEST_DRIFT", role: service.role, detail: "capability manifest fingerprint is not SHA-256" });
  if (isCanonicalProduction && (!nonNegativeInteger(service.configuredMaxCapacity) || service.configuredMaxCapacity < minimumCapacity)) blockers.push({ code: "CAPACITY_BELOW_MINIMUM", role: service.role, detail: `configured max capacity ${service.configuredMaxCapacity} is below ${minimumCapacity}` });
  if (isCanonicalProduction && (!service.capabilityManifest.tools || ![...REQUIRED_TOOLS].every((tool) => service.capabilityManifest.tools.includes(tool)))) {
    blockers.push({ code: "MISSING_CANONICAL_TOOL", role: service.role, detail: "canonical Chat Swarm runtime tool surface is incomplete" });
  }
  if (service.sourceDrift === true) blockers.push({ code: "SOURCE_DRIFT", role: service.role, detail: "fresh source probe differs from the bound build" });
  if (canonical && service.role === canonical.role) {
    if (service.buildIdentity.sourceCommit !== canonical.buildIdentity.sourceCommit || service.buildIdentity.buildId !== canonical.buildIdentity.buildId || service.serviceIdentity.serviceName !== canonical.serviceIdentity.serviceName) {
      blockers.push({ code: "IDENTITY_DRIFT", role: service.role, detail: "canonical service identity/build differs from its selected binding" });
    }
  }
  if (service.expected) {
    if (service.expected.sourceCommit && service.expected.sourceCommit !== service.buildIdentity.sourceCommit) blockers.push({ code: "IDENTITY_DRIFT", role: service.role, detail: "source commit does not match the expected identity" });
    if (service.expected.buildId && service.expected.buildId !== service.buildIdentity.buildId) blockers.push({ code: "IDENTITY_DRIFT", role: service.role, detail: "build id does not match the expected identity" });
    if (service.expected.capabilityManifestSha256 && service.expected.capabilityManifestSha256 !== service.capabilityManifest.sha256) blockers.push({ code: "CAPABILITY_MANIFEST_DRIFT", role: service.role, detail: "capability manifest does not match the expected identity" });
    if (service.expected.catalogGeneration && service.expected.catalogGeneration !== service.capabilityManifest.catalogGeneration) blockers.push({ code: "SESSION_CATALOG_DRIFT", role: service.role, detail: "catalog generation does not match the expected identity" });
  }
  return blockers;
}

function retirementBlockers(service: PhysicalServiceInventory, receipt: ControlPlaneReconciliationReceipt | undefined): ControlPlaneBlocker[] {
  if (!service.durableState || !service.oauth || !service.runtimeOwner || !service.routingAuthority) {
    return [{ code: "MISSING_INVENTORY", role: service.role, detail: "retirement inventory is incomplete" }];
  }
  const state = service.durableState;
  const blockers: ControlPlaneBlocker[] = [];
  if (state.workspaceSessions > 0 || state.agentSessions > 0) blockers.push({ code: "STRANDED_DURABLE_STATE", role: service.role, detail: "retirement candidate still owns active workspace or agent sessions" });
  if (state.inFlightOperations > 0 || state.unknownOperations > 0 || (state.activeReconcileRequired ?? 0) > 0) blockers.push({ code: "RECONCILE_REQUIRED_STATE", role: service.role, detail: "active, unknown, in-flight, or operational reconcile-required work remains" });
  if (service.runtimeOwner.held) blockers.push({ code: "RUNTIME_OWNER_HELD", role: service.role, detail: `runtime owner is still held${service.runtimeOwner.pid ? ` by pid ${service.runtimeOwner.pid}` : ""}` });
  if (service.routingAuthority.active) blockers.push({ code: "ROUTING_AUTHORITY_STRANDED", role: service.role, detail: "routing authority remains bound to the retirement candidate" });
  if (state.oauthClients > 0 || service.oauth.clientIds.length > 0 || service.oauth.authorityRole) blockers.push({ code: "OAUTH_AUTHORITY_STRANDED", role: service.role, detail: "OAuth/client authority remains bound to the retirement candidate; secrets/tokens require explicit revocation, never copying" });
  const attestation = service.retiredReadOnlyAttestation;
  const attestationValid = Boolean(
    attestation &&
      receipt &&
      attestation.schema === "devspace.retired_read_only_authority_attestation.v1" &&
      attestation.state === "RETIRED_READ_ONLY" &&
      attestation.readOnly === true &&
      attestation.historicalStateQueryable === true &&
      attestation.routingAuthorityReleased === true &&
      attestation.oauthAuthorityReleased === true &&
      attestation.runtimeOwnerReleased === true &&
      attestation.activeSessions === 0 &&
      attestation.operationId === receipt.operationId &&
      attestation.requestHash === receipt.requestHash &&
      attestation.sourceRole === receipt.sourceRole &&
      attestation.destinationRole === receipt.destinationRole &&
      (!receipt.contentHash || attestation.contentHash === receipt.contentHash),
  );
  if (!attestationValid) blockers.push({ code: "RETIREMENT_ATTESTATION_INVALID", role: service.role, detail: "retirement requires a read-only historical-state attestation bound to the exact succeeded migration receipt" });
  return blockers;
}

export function evaluateControlPlaneConvergence(
  inventory: ControlPlaneInventory,
  options: { minimumCapacity?: number } = {},
): ControlPlaneConvergenceEvaluation {
  const minimumCapacity = options.minimumCapacity ?? 5;
  const blockers: ControlPlaneBlocker[] = [];
  const services = Array.isArray(inventory.services) ? inventory.services : [];
  const authoritative = services.filter((service) => service.roleKind === "AUTHORITATIVE_PRODUCTION");
  const nonAuthoritative = services.filter((service) => service.roleKind !== "AUTHORITATIVE_PRODUCTION");
  if (inventory.manifestRequired || inventory.observedAt !== undefined || inventory.maxAgeSeconds !== undefined) {
    const observedAtMs = inventory.observedAt ? Date.parse(inventory.observedAt) : NaN;
    if (!Number.isFinite(observedAtMs) || !Number.isSafeInteger(inventory.maxAgeSeconds) || (Date.now() - observedAtMs) > Number(inventory.maxAgeSeconds) * 1000 || observedAtMs > Date.now() + 30_000) {
      blockers.push({ code: "TOPOLOGY_MANIFEST_STALE", detail: "topology inventory is missing a fresh observedAt/maxAgeSeconds attestation" });
    }
  }
  if (authoritative.length !== 1) blockers.push({ code: "DUPLICATE_PRODUCTION_OWNERS", detail: `expected exactly one AUTHORITATIVE_PRODUCTION role, observed ${authoritative.length}` });
  const canonical = services.find((service) => service.role === inventory.canonicalRole);
  const retirement = services.find((service) => service.role === inventory.retirementCandidateRole);
  if (!canonical) blockers.push({ code: "CANONICAL_ROLE_INVALID", detail: `canonical role '${inventory.canonicalRole}' is absent from the physical inventory` });
  if (!retirement) blockers.push({ code: "RETIREMENT_CANDIDATE_INVALID", detail: `retirement candidate '${inventory.retirementCandidateRole}' is absent from the physical inventory` });
  if (canonical && canonical.roleKind !== "AUTHORITATIVE_PRODUCTION") blockers.push({ code: "CANONICAL_ROLE_INVALID", role: canonical.role, detail: "canonical role must be AUTHORITATIVE_PRODUCTION" });
  if (retirement && retirement.role === inventory.canonicalRole) blockers.push({ code: "RETIREMENT_CANDIDATE_INVALID", role: retirement.role, detail: "the canonical production service cannot also be its retirement candidate" });
  if (retirement && retirement.roleKind === "AUTHORITATIVE_PRODUCTION" && retirement.role !== inventory.canonicalRole) blockers.push({ code: "RETIREMENT_CANDIDATE_INVALID", role: retirement.role, detail: "an authoritative production owner cannot be a retirement candidate" });
  if (canonical && inventory.canonicalStateDirectory !== undefined && inventory.canonicalStateDirectory !== canonical.stateDirectory) {
    blockers.push({ code: "CANONICAL_ROLE_INVALID", role: canonical.role, detail: "selected canonical state directory does not match the canonical physical service" });
  }
  if (retirement && inventory.retirementCandidateStateDirectory !== undefined && inventory.retirementCandidateStateDirectory !== retirement.stateDirectory) {
    blockers.push({ code: "RETIREMENT_CANDIDATE_INVALID", role: retirement.role, detail: "selected retirement state directory does not match the retirement physical service" });
  }
  for (const service of services) {
    if (!service.roleKind || !ROLE_KINDS.has(service.roleKind)) blockers.push({ code: "MISSING_INVENTORY", role: service.role, detail: "roleKind is required and must be an explicit known role; topology roles are never inferred from names" });
    blockers.push(...inventoryBlockers(service, canonical, minimumCapacity));
  }
  const oauthClientOwners = new Map<string, string>();
  for (const service of services) {
    if (service.oauth?.authorityRole && service.oauth.authorityRole !== service.role) blockers.push({ code: "OAUTH_AUTHORITY_MISMATCH", role: service.role, detail: "OAuth authority binding names a different role" });
    for (const clientId of service.oauth?.clientIds ?? []) {
      const priorOwner = oauthClientOwners.get(clientId);
      if (priorOwner && priorOwner !== service.role) blockers.push({ code: "OAUTH_AUTHORITY_MISMATCH", role: service.role, detail: `OAuth client authority '${clientId}' is also bound to ${priorOwner}` });
      else oauthClientOwners.set(clientId, service.role);
    }
  }
  const retirementReceipt = inventory.retirementReceipt;
  const retirementProofValid = Boolean(
    retirementReceipt &&
      retirementReceipt.state === "SUCCEEDED" &&
      retirementReceipt.sourceRole === inventory.retirementCandidateRole &&
      retirementReceipt.destinationRole === inventory.canonicalRole &&
      retirement &&
      canonical &&
      JSON.stringify(canonicalize(retirementReceipt.sourceBinding)) === JSON.stringify(canonicalize(serviceBinding(retirement))) &&
      JSON.stringify(canonicalize(retirementReceipt.destinationBinding)) === JSON.stringify(canonicalize(serviceBinding(canonical))) &&
      typeof retirementReceipt.evidenceRef === "string" &&
      retirementReceipt.evidenceRef.length > 0 &&
      retirementReceipt.retryAllowed === false &&
      typeof retirementReceipt.contentHash === "string" &&
      SHA256.test(retirementReceipt.contentHash),
  );
  if (retirement) blockers.push(...retirementBlockers(retirement, retirementReceipt));
  if (retirement && retirementBlockers(retirement, retirementReceipt).length === 0 && !retirementProofValid) {
    blockers.push({ code: "RECONCILE_REQUIRED_STATE", role: retirement.role, detail: "retirement requires an exact succeeded reconciliation receipt with physical evidence" });
  }
  if (authoritative.some((service) => service.role !== inventory.canonicalRole)) blockers.push({ code: "DUPLICATE_PRODUCTION_OWNERS", detail: "the selected canonical role does not own the sole authoritative production identity" });
  const uniqueCodes = new Set<string>();
  const deduped = blockers.filter((blocker) => {
    const key = `${blocker.code}:${blocker.role ?? ""}:${blocker.detail}`;
    if (uniqueCodes.has(key)) return false;
    uniqueCodes.add(key);
    return true;
  });
  const eligibleToRetire = Boolean(retirement && deduped.length === 0 && retirementBlockers(retirement, retirementReceipt).length === 0 && retirementProofValid);
  return {
    schema: "devspace.control_plane_convergence.v1",
    converged: deduped.length === 0,
    canonicalRole: inventory.canonicalRole,
    retirementCandidateRole: inventory.retirementCandidateRole,
    canonicalStateDirectory: canonical?.stateDirectory ?? inventory.canonicalStateDirectory,
    retirementCandidateStateDirectory: retirement?.stateDirectory ?? inventory.retirementCandidateStateDirectory,
    ...(retirementReceipt ? { retirementReceipt } : {}),
    authoritativeProductionRoles: authoritative.map((service) => service.role),
    nonAuthoritativeRoles: nonAuthoritative.map((service) => service.role),
    eligibleToRetire,
    blockers: deduped,
    services,
  };
}

export function assertRetirementSafe(inventory: ControlPlaneInventory, options?: { minimumCapacity?: number }): void {
  const evaluation = evaluateControlPlaneConvergence(inventory, options);
  const blocker = evaluation.blockers.find((item) => item.role === evaluation.retirementCandidateRole || item.code === "DUPLICATE_PRODUCTION_OWNERS" || item.code === "CANONICAL_ROLE_INVALID");
  if (!evaluation.eligibleToRetire || blocker) {
    throw new ControlPlaneConvergenceError(blocker?.code ?? "RECONCILE_REQUIRED", blocker?.detail ?? "retirement candidate has not passed exact physical reconciliation");
  }
}

function recordCount(service: PhysicalServiceInventory, domain: ControlPlaneDomain): number {
  if (domain === "workspace_sessions") return service.durableState.workspaceSessions;
  if (domain === "agent_sessions") return service.durableState.agentSessions;
  if (domain === "durable_operations") return service.durableState.durableOperations;
  if (domain === "chat_swarm_records") return service.durableState.activeSwarms + service.durableState.workers + service.durableState.tasks;
  return service.durableState.oauthClients;
}

function serviceBinding(service: PhysicalServiceInventory): ControlPlaneServiceBinding {
  return {
    serverInstanceId: service.serviceIdentity.serverInstanceId,
    sourceCommit: service.buildIdentity.sourceCommit,
    buildId: service.buildIdentity.buildId,
    capabilityManifestSha256: service.capabilityManifest.sha256,
    catalogGeneration: service.capabilityManifest.catalogGeneration,
    stateDirectory: service.stateDirectory,
  };
}

export function planControlPlaneReconciliation(inventory: ControlPlaneInventory, input: ReconciliationPlanRequest): ControlPlaneReconciliationPlan {
  const evaluation = evaluateControlPlaneConvergence(inventory);
  const source = inventory.services.find((service) => service.role === input.request.sourceRole);
  const destination = inventory.services.find((service) => service.role === input.request.destinationRole);
  if (!source || !destination) throw new ControlPlaneConvergenceError("INVALID_PLAN", "reconciliation source and destination must be present in the physical inventory");
  if (!ROLE_KINDS.has(source.roleKind) || !ROLE_KINDS.has(destination.roleKind)) throw new ControlPlaneConvergenceError("MISSING_INVENTORY", "reconciliation requires explicit known role kinds for source and destination");
  if (source.roleKind === "AUTHORITATIVE_PRODUCTION" && source.role !== inventory.canonicalRole) throw new ControlPlaneConvergenceError("DUPLICATE_PRODUCTION_OWNERS", "cannot reconcile from a competing production owner");
  if (destination.role !== inventory.canonicalRole) throw new ControlPlaneConvergenceError("CANONICAL_ROLE_INVALID", "reconciliation destination must be the selected canonical role");
  if (input.request.domains.some((domain) => !["workspace_sessions", "agent_sessions", "durable_operations", "chat_swarm_records", "oauth_authority"].includes(domain))) throw new ControlPlaneConvergenceError("INVALID_PLAN", "unknown reconciliation domain");
  if (input.operationId.trim().length === 0) throw new ControlPlaneConvergenceError("INVALID_PLAN", "operationId is required");
  const hash = requestHash({ operationId: input.operationId, request: input.request });
  const steps = input.request.domains.map((domain, index) => ({
    stepId: `${input.operationId}:step:${index + 1}`,
    kind: "DOMAIN_RECORD_RECONCILIATION" as const,
    domain,
    sourceRole: source.role,
    destinationRole: destination.role,
    recordCount: recordCount(source, domain),
    authority: "CANONICAL_STATE_ONLY" as const,
    oauthSecretsCopied: false as const,
  }));
  // A plan can exist while migration blockers remain; execution/retirement stays fail-closed.
  void evaluation;
  return {
    schema: "devspace.control_plane_reconciliation_plan.v1",
    operationId: input.operationId,
    requestHash: hash,
    sourceRole: source.role,
    destinationRole: destination.role,
    sourceBinding: serviceBinding(source),
    destinationBinding: serviceBinding(destination),
    domains: [...input.request.domains],
    steps,
    retrySafe: false,
    rawSqliteMerge: false,
  };
}

export function recordControlPlaneOutcome(
  plan: ControlPlaneReconciliationPlan,
  previous: ControlPlaneReconciliationReceipt | undefined,
  outcome: { state: ControlPlaneReconciliationState; detail?: string; evidenceRef?: string; effectCount?: number; contentHash?: string },
): ControlPlaneReconciliationReceipt {
  const allowedTransitions: Record<ControlPlaneReconciliationState, readonly ControlPlaneReconciliationState[]> = {
    PLANNED: ["PLANNED", "IN_FLIGHT"],
    IN_FLIGHT: ["IN_FLIGHT", "SUCCEEDED", "FAILED", "OUTCOME_UNKNOWN", "RECONCILE_REQUIRED"],
    OUTCOME_UNKNOWN: ["OUTCOME_UNKNOWN", "RECONCILE_REQUIRED", "SUCCEEDED", "FAILED"],
    RECONCILE_REQUIRED: ["RECONCILE_REQUIRED", "SUCCEEDED", "FAILED"],
    SUCCEEDED: ["SUCCEEDED"],
    FAILED: ["FAILED"],
  };
  if (!Object.hasOwn(allowedTransitions, outcome.state)) throw new ControlPlaneConvergenceError("INVALID_PLAN", "unknown reconciliation state");
  if (previous) {
    if (previous.operationId !== plan.operationId || previous.requestHash !== plan.requestHash) throw new ControlPlaneConvergenceError("REPLAY_CONFLICT", "reconciliation receipt does not match the exact operation identity");
    if (previous.state === "OUTCOME_UNKNOWN" || previous.state === "RECONCILE_REQUIRED") {
      if (outcome.state === previous.state && outcome.detail === previous.detail && outcome.evidenceRef === previous.evidenceRef) return previous;
      if (!outcome.evidenceRef || !["RECONCILE_REQUIRED", "SUCCEEDED", "FAILED"].includes(outcome.state)) throw new ControlPlaneConvergenceError("RECONCILE_REQUIRED", "OUTCOME_UNKNOWN is not retry permission; exact physical evidence is required before another effect");
    }
    if (previous.state === "SUCCEEDED" || previous.state === "FAILED") {
      if (outcome.state !== previous.state || outcome.detail !== previous.detail) throw new ControlPlaneConvergenceError("REPLAY_CONFLICT", "terminal reconciliation receipt is immutable");
      return previous;
    }
    if (outcome.state === "IN_FLIGHT" && previous.state === "IN_FLIGHT") return previous;
    if (previous.state === "IN_FLIGHT" && outcome.state === "PLANNED") throw new ControlPlaneConvergenceError("RECONCILE_REQUIRED", "an in-flight reconciliation cannot move backwards to PLANNED");
    if (!allowedTransitions[previous.state].includes(outcome.state)) throw new ControlPlaneConvergenceError("RECONCILE_REQUIRED", `invalid reconciliation transition ${previous.state} -> ${outcome.state}`);
  }
  const retryAllowed = outcome.state === "PLANNED" || outcome.state === "IN_FLIGHT" ? true : false;
  if ((outcome.state === "SUCCEEDED" || outcome.state === "FAILED") && previous?.state === "OUTCOME_UNKNOWN") throw new ControlPlaneConvergenceError("RECONCILE_REQUIRED", "unknown physical outcome must be reconciled before terminalization");
  return {
    schema: "devspace.control_plane_reconciliation_receipt.v1",
    operationId: plan.operationId,
    requestHash: plan.requestHash,
    sourceRole: plan.sourceRole,
    destinationRole: plan.destinationRole,
    sourceBinding: structuredClone(plan.sourceBinding),
    destinationBinding: structuredClone(plan.destinationBinding),
    state: outcome.state,
    retryAllowed,
    effectCount: outcome.effectCount ?? (outcome.state === "SUCCEEDED" ? plan.steps.reduce((sum, step) => sum + step.recordCount, 0) : 0),
    ...(outcome.contentHash ? { contentHash: outcome.contentHash } : {}),
    ...(outcome.detail ? { detail: outcome.detail } : {}),
    ...(outcome.evidenceRef ? { evidenceRef: outcome.evidenceRef } : {}),
  };
}

export const buildControlPlaneInventory = evaluateControlPlaneConvergence;
export const evaluateSingleAuthorityControlPlane = evaluateControlPlaneConvergence;
export const buildControlPlaneReconciliationPlan = planControlPlaneReconciliation;
export const assertRetirementCandidateSafe = assertRetirementSafe;
