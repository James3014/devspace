import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCleanCanary,
  assertOuterProjectionGeneration,
  directStartRequest,
  inspectLiveProjection,
  requireCanaryReady,
  validateDirectAgentStartSchema,
} from "./wave3-329-direct-canary.mjs";

const directContractProperties = Object.fromEntries([
  "expectedHead", "writePaths", "maxFiles", "toolchainId", "maxWallMs",
  "maxStartupMs", "maxExecutionMs", "idleTimeoutMode", "idleTimeoutMs",
].map((key) => [key, {}]));

function startTool(overrides = {}) {
  return {
    name: "agent_start",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: {}, profile: {}, provider: {}, model: {}, effort: {}, cliProviderId: {},
        prompt: {}, attemptKey: {},
        executionContract: { type: "object", properties: { ...directContractProperties } },
        ...overrides,
      },
      required: ["workspaceId", "prompt", "attemptKey"],
    },
  };
}

function liveClient({ toolOverrides } = {}) {
  const tools = [
    startTool(toolOverrides),
    { name: "open_workspace", inputSchema: { type: "object", properties: {} } },
    { name: "agent_preflight", inputSchema: { type: "object", properties: {} } },
    { name: "agent_status", inputSchema: { type: "object", properties: {} } },
    { name: "agent_reconcile", inputSchema: { type: "object", properties: {} } },
  ];
  return {
    tools,
    async listTools() { return { tools }; },
  };
}

test("live schema sentinel accepts only the #422 direct agent_start shape", () => {
  assert.doesNotThrow(() => validateDirectAgentStartSchema(startTool()));
});

test("live schema sentinel rejects retired Core-bound top-level and executionContract fields", () => {
  assert.throws(
    () => validateDirectAgentStartSchema(startTool({ core_mutation_session_id: {} })),
    /schema keys differ/,
  );
  const contract = { type: "object", properties: { ...directContractProperties, dispatchIntent: {} } };
  assert.throws(
    () => validateDirectAgentStartSchema(startTool({ executionContract: contract })),
    /schema keys differ/,
  );
});

test("direct request has no legacy fields and carries the exact bounded write scope", () => {
  const request = directStartRequest("workspace-1", "profile-a", "wave3:attempt-1", "a".repeat(40), "toolchain-a");
  assert.deepEqual(Object.keys(request).sort(), [
    "attemptKey", "executionContract", "profile", "prompt", "workspaceId",
  ]);
  assert.deepEqual(request.executionContract, {
    expectedHead: "a".repeat(40),
    writePaths: ["effect.txt"],
    maxFiles: 1,
    toolchainId: "toolchain-a",
    maxWallMs: 120_000,
    maxStartupMs: 30_000,
    maxExecutionMs: 120_000,
  });
});

test("direct catalog inspection works without the hidden control-plane tool and rejects stale schemas", async () => {
  const evidence = await inspectLiveProjection(liveClient());
  assert.equal(evidence.outerCallerEvidence, "REQUIRED_BEFORE_DISPATCH");
  assert.match(evidence.catalogGeneration, /^[0-9a-f]{64}$/);
  assert.match(evidence.agentStartSchemaSha256, /^[0-9a-f]{64}$/);
  assert.equal(evidence.agentStartSchema.executionContractProperties.length, 9);

  const staleSchema = liveClient({ toolOverrides: { executionContract: {
    type: "object", properties: { ...directContractProperties, dispatchIntent: {} },
  } } });
  await assert.rejects(() => inspectLiveProjection(staleSchema), /schema keys differ/);
});

test("outer caller must match both live tool names and agent_start schema before dispatch", async () => {
  const evidence = await inspectLiveProjection(liveClient());
  const generation = evidence.catalogGeneration;
  const schemaHash = evidence.agentStartSchemaSha256;
  assert.doesNotThrow(() => assertOuterProjectionGeneration(generation, schemaHash, evidence));
  assert.throws(() => assertOuterProjectionGeneration(undefined, schemaHash, evidence), /projection generation does not match/);
  assert.throws(() => assertOuterProjectionGeneration("b".repeat(64), schemaHash, evidence), /projection generation does not match/);
  assert.throws(() => assertOuterProjectionGeneration(generation, "b".repeat(64), evidence), /agent_start schema does not match/);
  assert.throws(() => assertOuterProjectionGeneration(generation, undefined, evidence), /agent_start schema does not match/);
});

test("preflight and workspace checks fail closed on local blockers while preserving provider UNKNOWN", () => {
  const opened = {
    mode: "checkout",
    devspaceBuild: { sourceCommit: "a".repeat(40) },
    conversationSafety: { mutationAllowed: true },
  };
  const preflight = {
    worker: { profile: "profile-a" },
    readiness: {
      profileResolved: true, providerConfigured: true, runtimeReady: true,
      capacityAvailable: true, dispatchState: "UNKNOWN",
    },
    capacity: { providerState: "UNKNOWN" },
    toolchain: { id: "toolchain-a", available: true, executables: { verifier: "/bin/verifier" } },
    blockers: [],
  };
  assert.doesNotThrow(() => requireCanaryReady(opened, preflight, "a".repeat(40), "toolchain-a"));
  assert.throws(() => requireCanaryReady(opened, {
    ...preflight,
    readiness: { ...preflight.readiness, capacityAvailable: false },
  }, "a".repeat(40), "toolchain-a"), /local\/profile\/runtime blocker/);
  assert.throws(() => requireCanaryReady(opened, {
    ...preflight,
    toolchain: { ...preflight.toolchain, available: false },
  }, "a".repeat(40), "toolchain-a"), /toolchain is not available/);
  assert.throws(() => assertCleanCanary({ status: " M file", effectExists: false, head: "a".repeat(40) }), /must be clean/);
  assert.throws(() => assertCleanCanary({ status: "", effectExists: true, head: "a".repeat(40) }), /already exists/);
});
