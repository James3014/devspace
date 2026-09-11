import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateDeploymentConvergence,
  assertDeploymentCandidateValid,
  DeploymentConvergenceError,
  type DeploymentIdentitySnapshot,
} from "./deployment-convergence.js";

function baseSnapshot(): DeploymentIdentitySnapshot {
  return {
    remoteMain: { commit: "aabd562" },
    acceptedDeployment: { commit: "aabd562", buildId: "devspace-1.0.7-aabd562" },
    installedBuild: {
      commit: "aabd562",
      buildId: "devspace-1.0.7-aabd562",
      manifestSha256: "hash-aabd",
      capabilities: [
        "agent_start.tool",
        "agent_start.executionContract.authorityMode",
        "agent_start.executionContract.idleTimeoutMs",
        "agent_start.executionContract.nexusGrant",
      ],
    },
    runningBuild: {
      commit: "aabd562",
      buildId: "devspace-1.0.7-aabd562",
      serverInstanceId: "inst-1",
      manifestSha256: "hash-aabd",
      capabilities: [
        "agent_start.tool",
        "agent_start.executionContract.authorityMode",
        "agent_start.executionContract.idleTimeoutMs",
        "agent_start.executionContract.nexusGrant",
      ],
      cutoverMode: "normal",
      reconciliationRequired: false,
    },
    hostBinding: {
      advertisedManifestSha256: "hash-aabd",
    },
  };
}

test("State: CONVERGED when all 5 identities match and required capabilities are present", () => {
  const snapshot = baseSnapshot();
  const evaluation = evaluateDeploymentConvergence(snapshot);
  assert.equal(evaluation.state, "CONVERGED");
  assert.equal(evaluation.converged, true);
  assert.equal(evaluation.reconciliationRequired, false);
  assert.equal(evaluation.activeDrift, false);
  assert.equal(evaluation.missingCapabilities.length, 0);
});

test("State: RECONCILIATION_REQUIRED when runtime requires reconciliation or is draining", () => {
  const s1 = baseSnapshot();
  s1.runningBuild.reconciliationRequired = true;
  assert.equal(evaluateDeploymentConvergence(s1).state, "RECONCILIATION_REQUIRED");

  const s2 = baseSnapshot();
  s2.runningBuild.cutoverMode = "drain";
  assert.equal(evaluateDeploymentConvergence(s2).state, "RECONCILIATION_REQUIRED");
});

test("State: INTENTIONALLY_PINNED when accepted target matches running but differs from remote main", () => {
  const s = baseSnapshot();
  s.remoteMain = { commit: "new-upstream-commit" };
  s.acceptedDeployment = { commit: "pinned-commit", pinned: true };
  s.installedBuild.commit = "pinned-commit";
  s.runningBuild.commit = "pinned-commit";

  const evaluation = evaluateDeploymentConvergence(s);
  assert.equal(evaluation.state, "INTENTIONALLY_PINNED");
  assert.equal(evaluation.converged, true);
});

test("State: DEPLOYMENT_DRIFT when installed build differs from accepted deployment", () => {
  const s = baseSnapshot();
  s.acceptedDeployment = { commit: "new-approved-commit" };
  // installedBuild is still aabd562
  const evaluation = evaluateDeploymentConvergence(s);
  assert.equal(evaluation.state, "DEPLOYMENT_DRIFT");
  assert.equal(evaluation.converged, false);
  assert.equal(evaluation.activeDrift, true);
});

test("State: ACTIVATION_PENDING when installed build matches accepted target but running instance is older", () => {
  const s = baseSnapshot();
  s.acceptedDeployment = { commit: "aabd562", buildId: "devspace-1.0.7-aabd562" };
  s.installedBuild = {
    commit: "aabd562",
    buildId: "devspace-1.0.7-aabd562",
    manifestSha256: "hash-new",
  };
  s.runningBuild.commit = "1c0dacc";
  s.runningBuild.buildId = "devspace-1.0.7-1c0dacc";

  const evaluation = evaluateDeploymentConvergence(s);
  assert.equal(evaluation.state, "ACTIVATION_PENDING");
  assert.equal(evaluation.converged, false);
  assert.equal(evaluation.activeDrift, true);
});

test("State: HOST_BINDING_STALE when host-advertised manifest differs from running instance", () => {
  const s = baseSnapshot();
  s.hostBinding = { advertisedManifestSha256: "stale-host-hash" };

  const evaluation = evaluateDeploymentConvergence(s);
  assert.equal(evaluation.state, "HOST_BINDING_STALE");
  assert.equal(evaluation.converged, false);
  assert.equal(evaluation.activeDrift, false);
});

test("Negative test: assertDeploymentCandidateValid rejects diverged/stale candidate missing capabilities (Issue #30 reproduction)", () => {
  const currentAccepted = {
    commit: "458bb443",
    capabilities: [
      "agent_start.tool",
      "agent_start.executionContract.authorityMode",
      "agent_start.executionContract.idleTimeoutMs",
      "agent_start.executionContract.nexusGrant",
    ],
  };

  // Regression candidate 1f626813: not a descendant of main and dropped authorityMode/nexusGrant
  const staleCandidate = {
    commit: "1f626813",
    isDescendantOfCanonicalMain: false,
    capabilities: ["agent_start.tool", "agent_start.executionContract.idleTimeoutMs"],
  };

  assert.throws(
    () => assertDeploymentCandidateValid(staleCandidate, currentAccepted),
    (e: any) => e instanceof DeploymentConvergenceError && e.code === "LINEAGE_DRIFT",
  );

  // Even if claimed to descend, dropping capabilities is rejected with CAPABILITY_REGRESSION
  const regressionCandidate = {
    ...staleCandidate,
    isDescendantOfCanonicalMain: true,
  };
  assert.throws(
    () => assertDeploymentCandidateValid(regressionCandidate, currentAccepted),
    (e: any) => e instanceof DeploymentConvergenceError && e.code === "CAPABILITY_REGRESSION",
  );
});

test("Positive test: assertDeploymentCandidateValid accepts valid candidate descending from canonical main with preserved capabilities", () => {
  const currentAccepted = {
    commit: "458bb443",
    capabilities: [
      "agent_start.tool",
      "agent_start.executionContract.authorityMode",
      "agent_start.executionContract.idleTimeoutMs",
      "agent_start.executionContract.nexusGrant",
    ],
  };

  const validCandidate = {
    commit: "aabd562",
    isDescendantOfCanonicalMain: true,
    capabilities: [
      "agent_start.tool",
      "agent_start.executionContract.authorityMode",
      "agent_start.executionContract.idleTimeoutMs",
      "agent_start.executionContract.nexusGrant",
      "agent_start.selection",
    ],
  };

  assert.doesNotThrow(() => assertDeploymentCandidateValid(validCandidate, currentAccepted));
});
