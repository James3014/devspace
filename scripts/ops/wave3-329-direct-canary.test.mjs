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

function liveClient({ toolOverrides, convergence } = {}) {
  const tools = [
    startTool(toolOverrides),
    { name: "capability_convergence_status", inputSchema: { type: "object", properties: {} } },
    { name: "open_workspace", inputSchema: { type: "object", properties: {} } },
    { name: "agent_preflight", inputSchema: { type: "object", properties: {} } },
    { name: "agent_status", inputSchema: { type: "object", properties: {} } },
    { name: "agent_reconcile", inputSchema: { type: "object", properties: {} } },
  ];
  return {
    tools,
    async listTools() { return { tools }; },
    async callTool({ name }) {
      assert.equal(name, "capability_convergence_status");
      return {
        structuredContent: convergence ?? {
          clientProjectionConvergence: {
            state: "CURRENT",
            converged: true,
            clientProjectionGeneration: "a".repeat(64),
          },
          sessionConvergence: {
            controllerDisposition: "CURRENT",
            converged: true,
            activeDrift: false,
            serverGeneration: { catalogGeneration: "a".repeat(64) },
          },
        },
      };
    },
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

test("live projection gate requires a current server session and rejects stale schemas/projections", async () => {
  const evidence = await inspectLiveProjection(liveClient());
  assert.equal(evidence.convergence.state, "CURRENT");
  assert.equal(evidence.agentStartSchema.executionContractProperties.length, 9);

  let statusCalls = 0;
  const staleSchema = liveClient({ toolOverrides: { executionContract: {
    type: "object", properties: { ...directContractProperties, dispatchIntent: {} },
  } } });
  staleSchema.callTool = async () => { statusCalls += 1; return {}; };
  await assert.rejects(() => inspectLiveProjection(staleSchema), /schema keys differ/);
  assert.equal(statusCalls, 0, "schema mismatch must stop before a convergence or dispatch call");

  await assert.rejects(() => inspectLiveProjection(liveClient({ convergence: {
    clientProjectionConvergence: { state: "SERVER_AHEAD_OF_CLIENT", converged: false },
    sessionConvergence: { controllerDisposition: "STALE_RECONNECT_REQUIRED", converged: false, activeDrift: true },
  } })), /not proven CURRENT/);
});

test("outer caller generation must match the current live catalog before dispatch", () => {
  const catalogGeneration = "a".repeat(64);
  assert.doesNotThrow(() => assertOuterProjectionGeneration(catalogGeneration, { catalogGeneration }));
  assert.throws(() => assertOuterProjectionGeneration(undefined, { catalogGeneration }), /does not match/);
  assert.throws(() => assertOuterProjectionGeneration("b".repeat(64), { catalogGeneration }), /does not match/);
  assert.throws(() => assertOuterProjectionGeneration(catalogGeneration, {}), /does not match/);
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
