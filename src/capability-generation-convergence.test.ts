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

test("Issue #133: SessionConvergence keeps manifest drift stale until tools/list acknowledgement", () => {
  const current = {
    serverInstanceId: "srv-1",
    sourceCommit: "commit-1",
    buildId: "build-1",
    capabilityManifestSha256: "manifest-new",
    catalogGeneration: "gen-1",
    cutoverMode: "normal",
    reconciliationRequired: false,
  };

  const session: SessionGenerationSnapshot = {
    serverInstanceId: "srv-1",
    sourceCommit: "commit-1",
    buildId: "build-1",
    capabilityManifestSha256: "manifest-old",
    catalogGeneration: "gen-1",
    sessionInitializedAt: new Date().toISOString(),
  };

  const evaluation = evaluateSessionConvergence(session, current);
  assert.equal(evaluation.state, "STALE_CAPABILITY_MANIFEST");
  assert.equal(evaluation.converged, false);
  assert.equal(evaluation.reconnectRequired, false);
  assert.equal(evaluation.activeDrift, true);
});

test("Issue #133: session catalog generations remain exact per session and tools/list acknowledgement clears only the bound generation", () => {
  const current = {
    serverInstanceId: "srv-1",
    sourceCommit: "commit-1",
    buildId: "build-1",
    capabilityManifestSha256: "manifest-1",
    catalogGeneration: "workspace-generation-2",
    sessionInitializedAt: new Date().toISOString(),
    cutoverMode: "normal",
    reconciliationRequired: false,
  };
  const snapshot: SessionGenerationSnapshot = {
    ...current,
    catalogGeneration: "workspace-generation-1",
    sessionInitializedAt: new Date().toISOString(),
  };
  const stale = evaluateSessionConvergence(snapshot, current);
  assert.equal(stale.state, "STALE_SESSION_CATALOG");
  assert.equal(stale.reconnectRequired, false);

  const registry = new McpSessionRegistry<{ close(): Promise<void> }>();
  registry.register("session-scoped", { close: async () => {} }, { snapshot });
  assert.equal(registry.acknowledgeToolsList("session-scoped", current), true);
  assert.equal(evaluateSessionConvergence(registry.getSnapshot("session-scoped"), current).state, "CURRENT");
  assert.equal(registry.getSnapshot("session-scoped")?.catalogGeneration, "workspace-generation-2");
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
      roleKind: "AUTHORITATIVE_PRODUCTION",
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
      roleKind: "NON_AUTHORITATIVE_CANARY",
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
