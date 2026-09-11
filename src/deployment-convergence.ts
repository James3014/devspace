import { CAPABILITY_MANIFEST_SCHEMA, type CapabilityManifest } from "./capability-manifest.js";

export type DeploymentConvergenceState =
  | "INTENTIONALLY_PINNED"
  | "DEPLOYMENT_DRIFT"
  | "ACTIVATION_PENDING"
  | "HOST_BINDING_STALE"
  | "RECONCILIATION_REQUIRED"
  | "CONVERGED";

export interface RemoteMainIdentity {
  commit: string;
}

export interface AcceptedDeploymentTarget {
  commit: string;
  buildId?: string;
  pinned?: boolean;
}

export interface InstalledBuildIdentity {
  commit: string;
  buildId: string;
  manifestSha256: string;
  capabilities?: string[];
}

export interface RunningBuildIdentity {
  commit: string;
  buildId: string;
  serverInstanceId: string;
  manifestSha256: string;
  capabilities?: string[];
  cutoverMode: string;
  reconciliationRequired: boolean;
}

export interface HostBindingIdentity {
  advertisedManifestSha256?: string;
  supportedCapabilities?: string[];
}

export interface DeploymentIdentitySnapshot {
  remoteMain?: RemoteMainIdentity;
  acceptedDeployment: AcceptedDeploymentTarget;
  installedBuild: InstalledBuildIdentity;
  runningBuild: RunningBuildIdentity;
  hostBinding?: HostBindingIdentity;
}

export interface DeploymentConvergenceEvaluation {
  state: DeploymentConvergenceState;
  converged: boolean;
  reconciliationRequired: boolean;
  activeDrift: boolean;
  missingCapabilities: string[];
  details: string;
  snapshot: DeploymentIdentitySnapshot;
}

export class DeploymentConvergenceError extends Error {
  constructor(
    public readonly code:
      | "CAPABILITY_REGRESSION"
      | "LINEAGE_DRIFT"
      | "RECONCILIATION_REQUIRED"
      | "INVALID_IDENTITY",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "DeploymentConvergenceError";
  }
}

const DEFAULT_REQUIRED_CAPABILITIES = [
  "agent_start.tool",
  "agent_start.executionContract.authorityMode",
  "agent_start.executionContract.idleTimeoutMs",
  "agent_start.executionContract.nexusGrant",
];

export function evaluateDeploymentConvergence(
  snapshot: DeploymentIdentitySnapshot,
  requiredCapabilities: string[] = DEFAULT_REQUIRED_CAPABILITIES,
): DeploymentConvergenceEvaluation {
  const { remoteMain, acceptedDeployment, installedBuild, runningBuild, hostBinding } = snapshot;

  const runningCaps = new Set(runningBuild.capabilities ?? []);
  const missingCaps = requiredCapabilities.filter((c) => !runningCaps.has(c));

  // 1. Reconciliation required
  if (runningBuild.reconciliationRequired || runningBuild.cutoverMode !== "normal") {
    return {
      state: "RECONCILIATION_REQUIRED",
      converged: false,
      reconciliationRequired: true,
      activeDrift: false,
      missingCapabilities: missingCaps,
      details: `Live runtime is in cutover mode '${runningBuild.cutoverMode}' or has reconciliationRequired=true`,
      snapshot,
    };
  }

  // 2. Intentionally pinned: accepted deployment matches running & installed, but is pinned and differs from remote main
  const isInstalledSynced = installedBuild.commit === acceptedDeployment.commit;
  const isRunningSynced = runningBuild.commit === acceptedDeployment.commit;
  if (
    acceptedDeployment.pinned === true &&
    isInstalledSynced &&
    isRunningSynced &&
    remoteMain &&
    acceptedDeployment.commit !== remoteMain.commit
  ) {
    return {
      state: "INTENTIONALLY_PINNED",
      converged: true,
      reconciliationRequired: false,
      activeDrift: false,
      missingCapabilities: missingCaps,
      details: `Accepted deployment ${acceptedDeployment.commit} is intentionally pinned away from remote main ${remoteMain.commit}`,
      snapshot,
    };
  }

  // 3. Deployment drift: installed build differs from accepted deployment target
  if (installedBuild.commit !== acceptedDeployment.commit) {
    return {
      state: "DEPLOYMENT_DRIFT",
      converged: false,
      reconciliationRequired: false,
      activeDrift: true,
      missingCapabilities: missingCaps,
      details: `Installed build commit (${installedBuild.commit}) does not match accepted deployment target (${acceptedDeployment.commit})`,
      snapshot,
    };
  }

  // 4. Activation pending: installed build matches accepted target, but running instance is still on older/different commit or buildId
  if (runningBuild.commit !== installedBuild.commit || runningBuild.buildId !== installedBuild.buildId) {
    return {
      state: "ACTIVATION_PENDING",
      converged: false,
      reconciliationRequired: false,
      activeDrift: true,
      missingCapabilities: missingCaps,
      details: `Running runtime (${runningBuild.commit} / ${runningBuild.buildId}) has not yet activated installed build (${installedBuild.commit} / ${installedBuild.buildId})`,
      snapshot,
    };
  }

  // 5. Host binding stale: host advertised manifest differs from live running manifest
  if (
    hostBinding?.advertisedManifestSha256 &&
    hostBinding.advertisedManifestSha256 !== runningBuild.manifestSha256
  ) {
    return {
      state: "HOST_BINDING_STALE",
      converged: false,
      reconciliationRequired: false,
      activeDrift: false,
      missingCapabilities: missingCaps,
      details: `Host-visible advertised manifest fingerprint (${hostBinding.advertisedManifestSha256}) differs from running runtime (${runningBuild.manifestSha256})`,
      snapshot,
    };
  }

  // 6. Converged
  return {
    state: "CONVERGED",
    converged: missingCaps.length === 0,
    reconciliationRequired: false,
    activeDrift: false,
    missingCapabilities: missingCaps,
    details: missingCaps.length === 0
      ? "Accepted deployment, installed build, running runtime, and host binding are fully converged"
      : `Identities converged but running build lacks required capabilities: ${missingCaps.join(", ")}`,
    snapshot,
  };
}

/**
 * Gate check to prevent staging/deploying a candidate that would cause capability regression
 * or diverges from canonical main lineage.
 */
export function assertDeploymentCandidateValid(
  candidate: {
    commit: string;
    isDescendantOfCanonicalMain: boolean;
    capabilities: string[];
  },
  currentAccepted: {
    commit: string;
    capabilities: string[];
  },
): void {
  // Lineage check
  if (!candidate.isDescendantOfCanonicalMain && candidate.commit !== currentAccepted.commit) {
    throw new DeploymentConvergenceError(
      "LINEAGE_DRIFT",
      `Deployment candidate ${candidate.commit} does not descend from canonical main`,
    );
  }

  // Capability preservation check
  const candidateCaps = new Set(candidate.capabilities);
  const droppedCaps = currentAccepted.capabilities.filter((cap) => !candidateCaps.has(cap));
  if (droppedCaps.length > 0) {
    throw new DeploymentConvergenceError(
      "CAPABILITY_REGRESSION",
      `Candidate ${candidate.commit} removes currently accepted capabilities: ${droppedCaps.join(", ")}`,
    );
  }
}
