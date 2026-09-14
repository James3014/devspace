import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_CHAT_SWARM_RUNTIME_TOOLS,
  ControlPlaneConvergenceError,
  SESSION_SCOPED_CATALOG_GENERATION,
  type ControlPlaneCatalogGenerationScope,
  type ControlPlaneInventory,
  type PhysicalServiceInventory,
  evaluateControlPlaneConvergence,
  parseControlPlaneTopologyManifest,
  planControlPlaneReconciliation,
  recordControlPlaneOutcome,
  assertRetirementSafe,
} from "./control-plane-convergence.js";

const syntheticMigrationSource: PhysicalServiceInventory = {
  role: "migration-source",
  roleKind: "NON_AUTHORITATIVE_MIGRATION_SOURCE",
  serviceIdentity: { serviceName: "synthetic-migration", serverInstanceId: "migration-server" },
  endpoint: { url: "https://migration.invalid", port: 17678 },
  oauth: { callback: "migration-callback", clientIds: [] },
  stateDirectory: "/state/migration",
  allowedRoots: ["/state/migration"],
  buildIdentity: { sourceCommit: "c".repeat(40), buildId: "migration-build" },
  capabilityManifest: { sha256: "d".repeat(64), catalogGeneration: "catalog-migration", tools: [...CANONICAL_CHAT_SWARM_RUNTIME_TOOLS] },
  featureFlags: { chatSwarm: true },
  durableState: { workspaceSessions: 0, agentSessions: 0, durableOperations: 0, oauthClients: 0, activeSwarms: 2, workers: 2, tasks: 22, inFlightOperations: 0, unknownOperations: 0, reconcileRequired: 1 },
  runtimeOwner: { held: true, pid: 1234 },
  routingAuthority: { active: true, endpoint: "https://migration.invalid" },
  configuredMaxCapacity: 5,
};

function service(overrides: Partial<PhysicalServiceInventory> = {}): PhysicalServiceInventory {
  return {
    role: "dev2",
    roleKind: "AUTHORITATIVE_PRODUCTION",
    serviceIdentity: {
      serviceName: "com.jameschen.devspace-chatgpt",
      serverInstanceId: "server-dev2",
    },
    endpoint: { url: "https://devspace.snowskill.app", port: 7677 },
    oauth: { callback: "K0nbkOe2VVA0", clientIds: ["client-dev2"] },
    stateDirectory: "/state/dev2",
    allowedRoots: ["/workspace"],
    buildIdentity: { sourceCommit: "a".repeat(40), buildId: "devspace-1.0.7-a" },
    capabilityManifest: {
      sha256: "b".repeat(64),
      catalogGeneration: "catalog-1",
      tools: [...CANONICAL_CHAT_SWARM_RUNTIME_TOOLS],
    },
    featureFlags: { chatSwarm: true },
    durableState: {
      workspaceSessions: 0,
      agentSessions: 0,
      durableOperations: 0,
      oauthClients: 1,
      activeSwarms: 0,
      workers: 0,
      tasks: 0,
      inFlightOperations: 0,
      unknownOperations: 0,
      reconcileRequired: 0,
    },
    runtimeOwner: { held: false },
    routingAuthority: { active: true, endpoint: "https://devspace.snowskill.app" },
    configuredMaxCapacity: 5,
    ...overrides,
  };
}

function inventory(overrides: Partial<ControlPlaneInventory> = {}): ControlPlaneInventory {
  return {
    services: [service()],
    canonicalRole: "dev2",
    retirementCandidateRole: "dev-c",
    ...overrides,
  };
}

test("single-authority control plane accepts one production owner and named migration source", () => {
  const result = evaluateControlPlaneConvergence({
    services: [
      service(),
      syntheticMigrationSource,
    ],
    canonicalRole: "dev2",
    retirementCandidateRole: "migration-source",
  });

  assert.equal(result.authoritativeProductionRoles.length, 1);
  assert.equal(result.canonicalRole, "dev2");
  assert.equal(result.retirementCandidateRole, "migration-source");
  assert.equal(result.eligibleToRetire, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === "RUNTIME_OWNER_HELD"));
});

test("duplicate authoritative production owners fail closed", () => {
  const result = evaluateControlPlaneConvergence(inventory({
    services: [service(), service({ role: "dev3", serviceIdentity: { serviceName: "other", serverInstanceId: "server-dev3" } })],
    canonicalRole: "dev2",
    retirementCandidateRole: "dev3",
  }));
  assert.equal(result.converged, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === "DUPLICATE_PRODUCTION_OWNERS"));
  assert.throws(() => assertRetirementSafe(inventory({
    services: [service(), service({ role: "dev3", serviceIdentity: { serviceName: "other", serverInstanceId: "server-dev3" } })],
    canonicalRole: "dev2",
    retirementCandidateRole: "dev3",
  })), (error: unknown) => error instanceof ControlPlaneConvergenceError && error.code === "DUPLICATE_PRODUCTION_OWNERS");
});

test("topology manifests fail closed when role kind is missing or freshness is stale", () => {
  const base = {
    schema: "devspace.control_plane_topology_manifest.v1",
    observedAt: new Date(Date.now() - 10_000).toISOString(),
    maxAgeSeconds: 1,
    inventory: { services: [service()], canonicalRole: "dev2", retirementCandidateRole: "dev2" },
  };
  assert.throws(() => parseControlPlaneTopologyManifest({ ...base, inventory: { ...base.inventory, services: [{ ...service(), roleKind: undefined }] } }), /roleKind/);
  assert.throws(() => parseControlPlaneTopologyManifest({ ...base, inventory: { ...base.inventory, services: [{ ...service(), roleKind: "UNKNOWN" }] } }), /roleKind/);
  const stale = parseControlPlaneTopologyManifest(base);
  const result = evaluateControlPlaneConvergence(stale);
  assert.ok(result.blockers.some((blocker) => blocker.code === "TOPOLOGY_MANIFEST_STALE"));
});

test("catalog generation scope is explicit, backward compatible, and rejects ambiguous topology", () => {
  const base = {
    schema: "devspace.control_plane_topology_manifest.v1",
    observedAt: new Date().toISOString(),
    maxAgeSeconds: 60,
    inventory: { services: [service()], canonicalRole: "dev2", retirementCandidateRole: "dev2" },
  };
  const legacy = parseControlPlaneTopologyManifest(base);
  assert.equal(legacy.services[0]?.capabilityManifest.catalogGenerationScope, undefined);

  const sessionScoped = parseControlPlaneTopologyManifest({
    ...base,
    inventory: {
      ...base.inventory,
      services: [{
        ...service(),
        capabilityManifest: {
          ...service().capabilityManifest,
          catalogGeneration: SESSION_SCOPED_CATALOG_GENERATION,
          catalogGenerationScope: "SESSION_SCOPED",
        },
      }],
    },
  });
  assert.equal(sessionScoped.services[0]?.capabilityManifest.catalogGeneration, SESSION_SCOPED_CATALOG_GENERATION);
  assert.equal(sessionScoped.services[0]?.capabilityManifest.catalogGenerationScope, "SESSION_SCOPED");

  assert.throws(() => parseControlPlaneTopologyManifest({
    ...base,
    inventory: {
      ...base.inventory,
      services: [{
        ...service(),
        capabilityManifest: { ...service().capabilityManifest, catalogGenerationScope: "SESSION_SCOPED", catalogGeneration: "volatile-generation" },
      }],
    },
  }), /stable SESSION_SCOPED/);
  assert.throws(() => parseControlPlaneTopologyManifest({
    ...base,
    inventory: {
      ...base.inventory,
      services: [{
        ...service(),
        capabilityManifest: { ...service().capabilityManifest, catalogGenerationScope: "SESSION_SCOPED", catalogGeneration: SESSION_SCOPED_CATALOG_GENERATION },
        expected: { catalogGeneration: "volatile-generation" },
      }],
    },
  }), /cannot claim an exact/);
  assert.throws(() => parseControlPlaneTopologyManifest({
    ...base,
    inventory: {
      ...base.inventory,
      services: [{
        ...service(),
        capabilityManifest: { ...service().capabilityManifest, catalogGenerationScope: "EXACT_SERVICE", catalogGeneration: SESSION_SCOPED_CATALOG_GENERATION },
      }],
    },
  }), /EXACT_SERVICE topology/);
  assert.throws(() => parseControlPlaneTopologyManifest({
    ...base,
    inventory: {
      ...base.inventory,
      services: [{
        ...service(),
        capabilityManifest: { ...service().capabilityManifest, catalogGeneration: SESSION_SCOPED_CATALOG_GENERATION, catalogGenerationScope: "BROKEN" as ControlPlaneCatalogGenerationScope },
      }],
    },
  }), /catalogGenerationScope/);
});

test("session-scoped catalogs are accepted for convergence but refuse new migration plans", () => {
  const scopedCanonical = service({
    capabilityManifest: {
      ...service().capabilityManifest,
      catalogGeneration: SESSION_SCOPED_CATALOG_GENERATION,
      catalogGenerationScope: "SESSION_SCOPED",
    },
  });
  const scopedInventory = { services: [scopedCanonical], canonicalRole: "dev2", retirementCandidateRole: "dev2" } satisfies ControlPlaneInventory;
  const evaluation = evaluateControlPlaneConvergence(scopedInventory);
  assert.equal(evaluation.blockers.some((blocker) => blocker.code === "MISSING_INVENTORY"), false);
  assert.throws(() => planControlPlaneReconciliation(scopedInventory, {
    operationId: "session-scoped-refusal",
    request: { sourceRole: "dev2", destinationRole: "dev2", domains: [] },
  }), (error: unknown) => error instanceof ControlPlaneConvergenceError && error.code === "SESSION_CATALOG_DRIFT");

  const malformed = evaluateControlPlaneConvergence({
    ...scopedInventory,
    services: [{ ...scopedCanonical, expected: { catalogGeneration: "volatile-generation" } }],
  });
  assert.ok(malformed.blockers.some((blocker) => blocker.code === "MISSING_INVENTORY"));
});

test("retirement is blocked while active state, owner lease, routing, or OAuth authority is stranded", () => {
  const candidate = service({
    role: "migration-source",
    roleKind: "NON_AUTHORITATIVE_MIGRATION_SOURCE",
    runtimeOwner: { held: true, pid: 7882 },
    durableState: {
      workspaceSessions: 1,
      agentSessions: 1,
      durableOperations: 1,
      oauthClients: 1,
      activeSwarms: 1,
      workers: 2,
      tasks: 1,
      inFlightOperations: 1,
      unknownOperations: 1,
      reconcileRequired: 1,
    },
  });
  const result = evaluateControlPlaneConvergence({ services: [service(), candidate], canonicalRole: "dev2", retirementCandidateRole: "migration-source" });
  assert.equal(result.eligibleToRetire, false);
  for (const code of ["STRANDED_DURABLE_STATE", "RUNTIME_OWNER_HELD", "ROUTING_AUTHORITY_STRANDED", "OAUTH_AUTHORITY_STRANDED", "RECONCILE_REQUIRED_STATE", "RETIREMENT_ATTESTATION_INVALID"]) {
    assert.ok(result.blockers.some((blocker) => blocker.code === code), code);
  }
});

test("retirement is eligible only after the named non-authoritative source is empty and unbound", () => {
  const candidate = service({
    role: "migration-source",
    roleKind: "NON_AUTHORITATIVE_MIGRATION_SOURCE",
    oauth: { callback: "ASL8H7jj-9BS", clientIds: [] },
    routingAuthority: { active: false },
    durableState: {
      workspaceSessions: 0,
      agentSessions: 0,
      durableOperations: 0,
      oauthClients: 0,
      activeSwarms: 0,
      workers: 0,
      tasks: 0,
      inFlightOperations: 0,
      unknownOperations: 0,
      reconcileRequired: 0,
    },
  });
  const candidateInventory = { services: [service(), candidate], canonicalRole: "dev2", retirementCandidateRole: "migration-source" } satisfies ControlPlaneInventory;
  const plan = planControlPlaneReconciliation(candidateInventory, {
    operationId: "retire-dev-c-proof",
    request: { sourceRole: "migration-source", destinationRole: "dev2", domains: [] },
  });
  const inFlight = recordControlPlaneOutcome(plan, undefined, { state: "IN_FLIGHT" });
  const receipt = recordControlPlaneOutcome(plan, inFlight, { state: "SUCCEEDED", evidenceRef: "migration:readback:dev-c:empty", contentHash: "e".repeat(64) });
  const attestedCandidate = { ...candidate, retiredReadOnlyAttestation: {
    schema: "devspace.retired_read_only_authority_attestation.v1" as const,
    state: "RETIRED_READ_ONLY" as const,
    operationId: receipt.operationId,
    requestHash: receipt.requestHash,
    sourceRole: receipt.sourceRole,
    destinationRole: receipt.destinationRole,
    readOnly: true as const,
    historicalStateQueryable: true as const,
    routingAuthorityReleased: true as const,
    oauthAuthorityReleased: true as const,
    runtimeOwnerReleased: true as const,
    activeSessions: 0 as const,
    contentHash: receipt.contentHash,
  } } satisfies PhysicalServiceInventory;
  const attestedInventory = { ...candidateInventory, services: [service(), attestedCandidate], retirementReceipt: receipt } satisfies ControlPlaneInventory;
  const result = evaluateControlPlaneConvergence(attestedInventory);
  assert.equal(result.converged, true);
  assert.equal(result.eligibleToRetire, true);
  assert.doesNotThrow(() => assertRetirementSafe(attestedInventory));
});

test("retirement preserves queryable historical swarms, workers, tasks, and reconcile-required rows", () => {
  const candidate = service({
    role: "migration-source",
    roleKind: "NON_AUTHORITATIVE_MIGRATION_SOURCE",
    oauth: { callback: "ASL8H7jj-9BS", clientIds: [] },
    routingAuthority: { active: false },
    capabilityManifest: { sha256: "d".repeat(64), catalogGeneration: "historical-catalog", tools: [] },
    configuredMaxCapacity: 0,
    durableState: {
      workspaceSessions: 0,
      agentSessions: 0,
      durableOperations: 7,
      oauthClients: 0,
      activeSwarms: 2,
      workers: 2,
      tasks: 22,
      inFlightOperations: 0,
      unknownOperations: 0,
      reconcileRequired: 1,
      activeReconcileRequired: 0,
    },
  });
  const candidateInventory = { services: [service(), candidate], canonicalRole: "dev2", retirementCandidateRole: "migration-source" } satisfies ControlPlaneInventory;
  const plan = planControlPlaneReconciliation(candidateInventory, {
    operationId: "retire-history-proof",
    request: { sourceRole: "migration-source", destinationRole: "dev2", domains: ["chat_swarm_records"] },
  });
  const receipt = recordControlPlaneOutcome(plan, recordControlPlaneOutcome(plan, undefined, { state: "IN_FLIGHT" }), { state: "SUCCEEDED", evidenceRef: "migration:readback:history", contentHash: "f".repeat(64) });
  const attestedCandidate = { ...candidate, retiredReadOnlyAttestation: {
    schema: "devspace.retired_read_only_authority_attestation.v1" as const,
    state: "RETIRED_READ_ONLY" as const,
    operationId: receipt.operationId,
    requestHash: receipt.requestHash,
    sourceRole: receipt.sourceRole,
    destinationRole: receipt.destinationRole,
    readOnly: true as const,
    historicalStateQueryable: true as const,
    routingAuthorityReleased: true as const,
    oauthAuthorityReleased: true as const,
    runtimeOwnerReleased: true as const,
    activeSessions: 0 as const,
    contentHash: receipt.contentHash,
  } } satisfies PhysicalServiceInventory;
  const result = evaluateControlPlaneConvergence({ ...candidateInventory, services: [service(), attestedCandidate], retirementReceipt: receipt });
  assert.equal(result.eligibleToRetire, true);
  assert.equal(result.blockers.some((blocker) => blocker.code === "STRANDED_DURABLE_STATE"), false);
  assert.doesNotThrow(() => assertRetirementSafe({ ...candidateInventory, services: [service(), attestedCandidate], retirementReceipt: receipt }));
  const canonicalMissingRequirements = service({ configuredMaxCapacity: 0, capabilityManifest: { sha256: "c".repeat(64), catalogGeneration: "canonical-old", tools: [] } });
  const blockedCanonical = evaluateControlPlaneConvergence({ ...candidateInventory, services: [canonicalMissingRequirements, attestedCandidate], retirementReceipt: receipt });
  assert.equal(blockedCanonical.eligibleToRetire, false);
  assert.ok(blockedCanonical.blockers.some((blocker) => blocker.role === "dev2" && blocker.code === "CAPACITY_BELOW_MINIMUM"));
  assert.ok(blockedCanonical.blockers.some((blocker) => blocker.role === "dev2" && blocker.code === "MISSING_CANONICAL_TOOL"));
});

test("retirement receipt destination proof survives canonical generation upgrades but not state or binding drift", () => {
  const candidate = service({
    role: "migration-source",
    roleKind: "NON_AUTHORITATIVE_MIGRATION_SOURCE",
    oauth: { callback: "ASL8H7jj-9BS", clientIds: [] },
    routingAuthority: { active: false },
    durableState: {
      workspaceSessions: 0,
      agentSessions: 0,
      durableOperations: 0,
      oauthClients: 0,
      activeSwarms: 0,
      workers: 0,
      tasks: 0,
      inFlightOperations: 0,
      unknownOperations: 0,
      reconcileRequired: 0,
    },
  });
  const originalCanonical = service();
  const base = { services: [originalCanonical, candidate], canonicalRole: "dev2", retirementCandidateRole: "migration-source" } satisfies ControlPlaneInventory;
  const plan = planControlPlaneReconciliation(base, {
    operationId: "retire-historical-destination",
    request: { sourceRole: "migration-source", destinationRole: "dev2", domains: ["chat_swarm_records"] },
  });
  const receipt = recordControlPlaneOutcome(
    plan,
    recordControlPlaneOutcome(plan, undefined, { state: "IN_FLIGHT" }),
    { state: "SUCCEEDED", evidenceRef: "migration:readback:historical-destination", contentHash: "e".repeat(64) },
  );
  const attestedCandidate = { ...candidate, retiredReadOnlyAttestation: {
    schema: "devspace.retired_read_only_authority_attestation.v1" as const,
    state: "RETIRED_READ_ONLY" as const,
    operationId: receipt.operationId,
    requestHash: receipt.requestHash,
    sourceRole: receipt.sourceRole,
    destinationRole: receipt.destinationRole,
    readOnly: true as const,
    historicalStateQueryable: true as const,
    routingAuthorityReleased: true as const,
    oauthAuthorityReleased: true as const,
    runtimeOwnerReleased: true as const,
    activeSessions: 0 as const,
    contentHash: receipt.contentHash,
  } } satisfies PhysicalServiceInventory;
  const retired = { ...base, services: [originalCanonical, attestedCandidate], retirementReceipt: receipt } satisfies ControlPlaneInventory;
  assert.equal(evaluateControlPlaneConvergence(retired).eligibleToRetire, true);

  const advancedCanonical = service({
    buildIdentity: { sourceCommit: "c".repeat(40), buildId: "devspace-2.0-c" },
    capabilityManifest: { sha256: "d".repeat(64), catalogGeneration: "catalog-2", tools: [...CANONICAL_CHAT_SWARM_RUNTIME_TOOLS] },
  });
  const advanced = evaluateControlPlaneConvergence({ ...retired, services: [advancedCanonical, attestedCandidate] });
  assert.equal(advanced.eligibleToRetire, true);
  assert.equal(advanced.blockers.length, 0);

  const sessionScopedCanonical = service({
    buildIdentity: { sourceCommit: "c".repeat(40), buildId: "devspace-2.0-d" },
    capabilityManifest: {
      sha256: "d".repeat(64),
      catalogGeneration: SESSION_SCOPED_CATALOG_GENERATION,
      catalogGenerationScope: "SESSION_SCOPED",
      tools: [...CANONICAL_CHAT_SWARM_RUNTIME_TOOLS],
    },
  });
  const sessionScopedReady = evaluateControlPlaneConvergence({ ...retired, services: [sessionScopedCanonical, attestedCandidate] });
  assert.equal(sessionScopedReady.eligibleToRetire, true);

  const changedStateDirectory = evaluateControlPlaneConvergence({
    ...retired,
    services: [{ ...advancedCanonical, stateDirectory: "/state/dev2-new" }, attestedCandidate],
  });
  assert.equal(changedStateDirectory.eligibleToRetire, false);
  assert.ok(changedStateDirectory.blockers.some((blocker) => blocker.code === "RECONCILE_REQUIRED_STATE"));

  const malformedReceipt = evaluateControlPlaneConvergence({
    ...retired,
    services: [advancedCanonical, attestedCandidate],
    retirementReceipt: { ...receipt, destinationBinding: { ...receipt.destinationBinding, capabilityManifestSha256: "invalid" } },
  });
  assert.equal(malformedReceipt.eligibleToRetire, false);
  assert.ok(malformedReceipt.blockers.some((blocker) => blocker.code === "RECONCILE_REQUIRED_STATE"));

  const failedReceipt = evaluateControlPlaneConvergence({
    ...retired,
    services: [advancedCanonical, attestedCandidate],
    retirementReceipt: { ...receipt, state: "FAILED" },
  });
  assert.equal(failedReceipt.eligibleToRetire, false);
  assert.ok(failedReceipt.blockers.some((blocker) => blocker.code === "RECONCILE_REQUIRED_STATE"));

  const sourceBindingDrift = evaluateControlPlaneConvergence({
    ...retired,
    services: [{ ...advancedCanonical }, { ...attestedCandidate, sourceDrift: true, stateDirectory: "/state/migration-drift" }],
  });
  assert.equal(sourceBindingDrift.eligibleToRetire, false);
  assert.ok(sourceBindingDrift.blockers.some((blocker) => blocker.code === "SOURCE_DRIFT"));
});

test("retirement rejects an attestation bound to another migration receipt", () => {
  const candidate = service({ role: "migration-source", roleKind: "NON_AUTHORITATIVE_MIGRATION_SOURCE", oauth: { clientIds: [] }, routingAuthority: { active: false } });
  const base = { services: [service(), candidate], canonicalRole: "dev2", retirementCandidateRole: "migration-source" } satisfies ControlPlaneInventory;
  const plan = planControlPlaneReconciliation(base, { operationId: "retire-attestation", request: { sourceRole: "migration-source", destinationRole: "dev2", domains: [] } });
  const receipt = recordControlPlaneOutcome(plan, recordControlPlaneOutcome(plan, undefined, { state: "IN_FLIGHT" }), { state: "SUCCEEDED", evidenceRef: "migration:readback", contentHash: "a".repeat(64) });
  const mismatched = { ...candidate, retiredReadOnlyAttestation: {
    schema: "devspace.retired_read_only_authority_attestation.v1" as const,
    state: "RETIRED_READ_ONLY" as const,
    operationId: "different-operation",
    requestHash: receipt.requestHash,
    sourceRole: receipt.sourceRole,
    destinationRole: receipt.destinationRole,
    readOnly: true as const,
    historicalStateQueryable: true as const,
    routingAuthorityReleased: true as const,
    oauthAuthorityReleased: true as const,
    runtimeOwnerReleased: true as const,
    activeSessions: 0 as const,
  } } satisfies PhysicalServiceInventory;
  const result = evaluateControlPlaneConvergence({ ...base, services: [service(), mismatched], retirementReceipt: receipt });
  assert.equal(result.eligibleToRetire, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === "RETIREMENT_ATTESTATION_INVALID"));
});

test("identity, manifest, catalog, source, and capacity drift are explicit blockers", () => {
  const drifted = service({
    buildIdentity: { sourceCommit: "c".repeat(40), buildId: "wrong-build" },
    capabilityManifest: { sha256: "d".repeat(64), catalogGeneration: "catalog-old", tools: [] },
    expected: {
      sourceCommit: "a".repeat(40),
      buildId: "devspace-1.0.7-a",
      capabilityManifestSha256: "b".repeat(64),
      catalogGeneration: "catalog-1",
    },
    sourceDrift: true,
    configuredMaxCapacity: 4,
  });
  const result = evaluateControlPlaneConvergence(inventory({ services: [drifted], canonicalRole: "dev2", retirementCandidateRole: "dev2" }));
  for (const code of ["IDENTITY_DRIFT", "CAPABILITY_MANIFEST_DRIFT", "SESSION_CATALOG_DRIFT", "SOURCE_DRIFT", "CAPACITY_BELOW_MINIMUM"]) {
    assert.ok(result.blockers.some((blocker) => blocker.code === code), code);
  }
});

test("reconciliation plans are domain-record plans and never authorize raw SQLite merge", () => {
  const source = service({
    role: "migration-source",
    roleKind: "NON_AUTHORITATIVE_MIGRATION_SOURCE",
    durableState: { workspaceSessions: 2, agentSessions: 2, durableOperations: 1, oauthClients: 8, activeSwarms: 2, workers: 2, tasks: 22, inFlightOperations: 1, unknownOperations: 1, reconcileRequired: 1 },
  });
  const plan = planControlPlaneReconciliation({ services: [service(), source], canonicalRole: "dev2", retirementCandidateRole: "migration-source" }, {
    operationId: "reconcile-migration-source-1",
    request: { sourceRole: "migration-source", destinationRole: "dev2", domains: ["workspace_sessions", "agent_sessions", "durable_operations", "chat_swarm_records"] },
  });
  assert.equal(plan.schema, "devspace.control_plane_reconciliation_plan.v1");
  assert.equal(plan.sourceRole, "migration-source");
  assert.equal(plan.destinationRole, "dev2");
  assert.equal(plan.destinationBinding.stateDirectory, "/state/dev2");
  assert.equal(plan.sourceBinding.serverInstanceId, "server-dev2");
  assert.ok(plan.steps.every((step) => step.kind === "DOMAIN_RECORD_RECONCILIATION"));
  assert.equal("sqlitePath" in plan, false);
  assert.equal(plan.retrySafe, false);
});

test("OUTCOME_UNKNOWN cannot be retried and exact replay is idempotent", () => {
  const plan = planControlPlaneReconciliation(inventory(), {
    operationId: "reconcile-1",
    request: { sourceRole: "dev2", destinationRole: "dev2", domains: [] },
  });
  const unknown = recordControlPlaneOutcome(plan, undefined, { state: "OUTCOME_UNKNOWN", detail: "transport lost" });
  assert.equal(unknown.retryAllowed, false);
  assert.throws(() => recordControlPlaneOutcome(plan, unknown, { state: "IN_FLIGHT" }), (error: unknown) => error instanceof ControlPlaneConvergenceError && error.code === "RECONCILE_REQUIRED");
  const replay = recordControlPlaneOutcome(plan, unknown, { state: "OUTCOME_UNKNOWN", detail: "transport lost" });
  assert.deepEqual(replay, unknown);
  assert.throws(() => recordControlPlaneOutcome(plan, unknown, { state: "SUCCEEDED", detail: "guessed" }), (error: unknown) => error instanceof ControlPlaneConvergenceError && error.code === "RECONCILE_REQUIRED");
});

test("typed reconciliation receipts reject terminal transitions before an effect is in flight", () => {
  const plan = planControlPlaneReconciliation(inventory(), {
    operationId: "reconcile-transition",
    request: { sourceRole: "dev2", destinationRole: "dev2", domains: [] },
  });
  const planned = recordControlPlaneOutcome(plan, undefined, { state: "PLANNED" });
  assert.throws(() => recordControlPlaneOutcome(plan, planned, { state: "SUCCEEDED" }), (error: unknown) => error instanceof ControlPlaneConvergenceError && error.code === "RECONCILE_REQUIRED");
  const inFlight = recordControlPlaneOutcome(plan, planned, { state: "IN_FLIGHT" });
  const completed = recordControlPlaneOutcome(plan, inFlight, { state: "SUCCEEDED", effectCount: 0 });
  assert.equal(completed.retryAllowed, false);
  assert.deepEqual(recordControlPlaneOutcome(plan, completed, { state: "SUCCEEDED", effectCount: 99 }), completed);
});

test("synthetic migration fixtures never carry OAuth secrets or token material", () => {
  assert.equal(JSON.stringify(syntheticMigrationSource).includes("secret"), false);
  assert.equal(JSON.stringify(syntheticMigrationSource).includes("token"), false);
});
