import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateDeploymentConvergence,
  evaluateSessionConvergence,
  evaluateMultiRoleConvergence,
  assertDeploymentCandidateValid,
  DeploymentConvergenceError,
  type DeploymentIdentitySnapshot,
  type SessionGenerationSnapshot,
  type ServiceRoleDeploymentIdentity,
} from "./deployment-convergence.js";
import { CUTOVER_SAFE_TOOLS } from "./mcp-cutover.js";
import { McpSessionRegistry } from "./mcp-sessions.js";

test("Issue #133: CUTOVER_SAFE_TOOLS includes capability_convergence_status", () => {
  assert.equal(CUTOVER_SAFE_TOOLS.has("capability_convergence_status"), true);
});

test("Issue #133: SessionConvergence detects stale server across restart", () => {
  const current = {
    serverInstanceId: "srv-2",
    sourceCommit: "commit-1",
    buildId: "build-1",
    capabilityManifestSha256: "man-1",
    catalogGeneration: "gen-1",
    cutoverMode: "normal",
    reconciliationRequired: false,
  };
  const session: SessionGenerationSnapshot = {
    serverInstanceId: "srv-1",
    sourceCommit: "commit-1",
    buildId: "build-1",
    capabilityManifestSha256: "man-1",
    catalogGeneration: "gen-1",
    sessionInitializedAt: new Date().toISOString(),
  };

  const evalResult = evaluateSessionConvergence(session, current);
  assert.equal(evalResult.state, "STALE_SERVER");
  assert.equal(evalResult.converged, false);
  assert.equal(evalResult.reconnectRequired, true);
  assert.equal(evalResult.activeDrift, true);
  assert.ok(evalResult.details.includes("Server instance changed"));
});

test("Issue #133: SessionConvergence detects capability manifest change with client listChanged support", () => {
  const current = {
    serverInstanceId: "srv-1",
    sourceCommit: "commit-2",
    buildId: "build-2",
    capabilityManifestSha256: "manifest-new",
    catalogGeneration: "gen-1",
    cutoverMode: "normal",
    reconciliationRequired: false,
  };

  // Client supporting listChanged
  const sessionWithSupport: SessionGenerationSnapshot = {
    serverInstanceId: "srv-1",
    sourceCommit: "commit-1",
    buildId: "build-1",
    capabilityManifestSha256: "manifest-old",
    catalogGeneration: "gen-1",
    sessionInitializedAt: new Date().toISOString(),
    clientSupportsListChanged: true,
  };

  const evalSupported = evaluateSessionConvergence(sessionWithSupport, current);
  assert.equal(evalSupported.state, "STALE_CAPABILITY_MANIFEST");
  assert.equal(evalSupported.converged, false);
  assert.equal(evalSupported.reconnectRequired, false); // client can receive notification
  assert.equal(evalSupported.activeDrift, true);

  // Client without listChanged support
  const sessionWithoutSupport: SessionGenerationSnapshot = {
    ...sessionWithSupport,
    clientSupportsListChanged: false,
  };

  const evalUnsupported = evaluateSessionConvergence(sessionWithoutSupport, current);
  assert.equal(evalUnsupported.state, "RECONNECT_REQUIRED");
  assert.equal(evalUnsupported.reconnectRequired, true);
});

test("Issue #133: McpSessionRegistry preserves and updates generation snapshots & server references", () => {
  const registry = new McpSessionRegistry<{ close(): Promise<void> }>();
  const transport = { close: async () => {} };
  const mockServer = {
    sendToolListChangedCalls: 0,
    async sendToolListChanged() {
      this.sendToolListChangedCalls += 1;
    },
  };

  const snapshot: SessionGenerationSnapshot = {
    serverInstanceId: "inst-1",
    sourceCommit: "sha-1",
    buildId: "devspace-1.0.7",
    capabilityManifestSha256: "hash-1",
    catalogGeneration: "gen-1",
    sessionInitializedAt: new Date().toISOString(),
    clientSupportsListChanged: true,
  };

  registry.register("session-1", transport, { snapshot, server: mockServer });

  assert.deepEqual(registry.getSnapshot("session-1"), snapshot);
  assert.equal(registry.getServer("session-1"), mockServer);
  assert.equal(registry.getAllServers().length, 1);

  // Update snapshot on catalog update
  registry.setSnapshot("session-1", { ...snapshot, catalogGeneration: "gen-2" });
  assert.equal(registry.getSnapshot("session-1")?.catalogGeneration, "gen-2");
});

test("Issue #133: MultiRoleConvergence evaluates 7677 (dev2) and 7678 (dev-c) divergence", () => {
  const roles: ServiceRoleDeploymentIdentity[] = [
    {
      role: "dev2-stable",
      expectedCommit: "commit-main-latest",
      expectedBuildId: "build-latest",
      installedBuild: {
        commit: "commit-main-latest",
        buildId: "build-latest",
        manifestSha256: "manifest-latest",
      },
      runningBuild: {
        commit: "commit-main-latest",
        buildId: "build-latest",
        serverInstanceId: "inst-dev2",
        manifestSha256: "manifest-latest",
        capabilities: [
          "agent_start.tool",
          "agent_start.executionContract.authorityMode",
          "agent_start.executionContract.idleTimeoutMs",
          "agent_start.executionContract.nexusGrant",
        ],
        cutoverMode: "normal",
        reconciliationRequired: false,
      },
    },
    {
      role: "dev-c-canary",
      expectedCommit: "commit-main-latest",
      expectedBuildId: "build-latest",
      installedBuild: {
        commit: "commit-main-latest",
        buildId: "build-latest",
        manifestSha256: "manifest-latest",
      },
      runningBuild: {
        commit: "commit-older",
        buildId: "build-older",
        serverInstanceId: "inst-canary",
        manifestSha256: "manifest-older",
        capabilities: [
          "agent_start.tool",
          "agent_start.executionContract.authorityMode",
          "agent_start.executionContract.idleTimeoutMs",
          "agent_start.executionContract.nexusGrant",
        ],
        cutoverMode: "normal",
        reconciliationRequired: false,
      },
    },
  ];

  const result = evaluateMultiRoleConvergence(roles);
  assert.equal(result.converged, false);
  assert.equal(result.roleStates["dev2-stable"].converged, true);
  assert.equal(result.roleStates["dev-c-canary"].converged, false);
  assert.equal(result.roleStates["dev-c-canary"].state, "ACTIVATION_PENDING");
  assert.ok(result.summary.includes("dev-c-canary (ACTIVATION_PENDING)"));
});
