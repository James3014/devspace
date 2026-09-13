import { CAPABILITY_MANIFEST_SCHEMA, type CapabilityManifest } from "./capability-manifest.js";

export type DeploymentConvergenceState =
  | "INTENTIONALLY_PINNED"
  | "DEPLOYMENT_DRIFT"
  | "ACTIVATION_PENDING"
  | "HOST_BINDING_STALE"
  | "RECONCILIATION_REQUIRED"
  | "CONVERGED";

export type SessionConvergenceState =
  | "CURRENT"
  | "STALE_SERVER"
  | "STALE_CAPABILITY_MANIFEST"
  | "STALE_SESSION_CATALOG"
  | "RECONNECT_REQUIRED"
  | "RECONCILE_REQUIRED";

export interface SessionGenerationSnapshot {
  serverInstanceId: string;
  sourceCommit: string;
  buildId: string;
  capabilityManifestSha256: string;
  catalogGeneration: string;
  sessionInitializedAt: string;
  freshness?: string;
}

export interface SessionConvergenceEvaluation {
  state: SessionConvergenceState;
  converged: boolean;
  reconnectRequired: boolean;
  reconciliationRequired: boolean;
  activeDrift: boolean;
  details: string;
  sessionSnapshot?: SessionGenerationSnapshot;
  serverGeneration: {
    serverInstanceId: string;
    sourceCommit: string;
    buildId: string;
    capabilityManifestSha256: string;
    catalogGeneration: string;
    freshness?: string;
    cutoverMode: string;
    reconciliationRequired: boolean;
  };
}


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

export function evaluateSessionConvergence(
  sessionSnapshot: SessionGenerationSnapshot | undefined,
  currentServer: {
    serverInstanceId: string;
    sourceCommit: string;
    buildId: string;
    capabilityManifestSha256: string;
    catalogGeneration: string;
    freshness?: string;
    cutoverMode: string;
    reconciliationRequired: boolean;
  },
): SessionConvergenceEvaluation {
  const base = {
    sessionSnapshot,
    serverGeneration: currentServer,
  };

  // 1. Server is draining or requires reconciliation
  if (currentServer.reconciliationRequired || currentServer.cutoverMode !== "normal") {
    return {
      ...base,
      state: "RECONCILE_REQUIRED",
      converged: false,
      reconnectRequired: false,
      reconciliationRequired: true,
      activeDrift: false,
      details: "Live runtime is in cutover mode '" + currentServer.cutoverMode + "' or reconciliationRequired=true",
    };
  }

  // 2. No session snapshot provided or unknown session
  if (!sessionSnapshot) {
    return {
      ...base,
      state: "RECONNECT_REQUIRED",
      converged: false,
      reconnectRequired: true,
      reconciliationRequired: false,
      activeDrift: true,
      details: "No active session generation snapshot bound to this request context; reconnect required",
    };
  }

  // 3. Server instance changed (e.g. process restarted)
  if (sessionSnapshot.serverInstanceId !== currentServer.serverInstanceId) {
    return {
      ...base,
      state: "STALE_SERVER",
      converged: false,
      reconnectRequired: true,
      reconciliationRequired: false,
      activeDrift: true,
      details: "Server instance changed from " + sessionSnapshot.serverInstanceId + " to " + currentServer.serverInstanceId + "; session reconnect required",
    };
  }

  // Source/build identity is part of the session binding. A process may keep
  // the same instance id while loading a different artifact, so this is still
  // a stale server rather than a tool-not-found condition.
  if (
    sessionSnapshot.sourceCommit !== currentServer.sourceCommit ||
    sessionSnapshot.buildId !== currentServer.buildId ||
    // A current process that exposes freshness must not silently accept a
    // legacy/unbound session.  The binding is deliberately fail-closed when
    // either side has a freshness marker and the values differ (including an
    // absent marker on the session).
    ((sessionSnapshot.freshness !== undefined || currentServer.freshness !== undefined) &&
      sessionSnapshot.freshness !== currentServer.freshness)
  ) {
    return {
      ...base,
      state: "STALE_SERVER",
      converged: false,
      reconnectRequired: true,
      reconciliationRequired: false,
      activeDrift: true,
      details: "Server source/build/freshness identity changed; session reconnect required",
    };
  }

  // 4. Capability manifest digest changed
  if (sessionSnapshot.capabilityManifestSha256 !== currentServer.capabilityManifestSha256) {
    return {
      ...base,
      state: "STALE_CAPABILITY_MANIFEST",
      converged: false,
      reconnectRequired: false,
      reconciliationRequired: false,
      activeDrift: true,
      details: "Capability manifest digest changed from " + sessionSnapshot.capabilityManifestSha256 + " to " + currentServer.capabilityManifestSha256,
    };
  }

  // 5. Tool catalog generation changed
  if (sessionSnapshot.catalogGeneration !== currentServer.catalogGeneration) {
    return {
      ...base,
      state: "STALE_SESSION_CATALOG",
      converged: false,
      reconnectRequired: false,
      reconciliationRequired: false,
      activeDrift: true,
      details: "Tool catalog generation changed from " + sessionSnapshot.catalogGeneration + " to " + currentServer.catalogGeneration,
    };
  }

  // 6. Fully converged
  return {
    ...base,
    state: "CURRENT",
    converged: true,
    reconnectRequired: false,
    reconciliationRequired: false,
    activeDrift: false,
    details: "Session generation is fully synchronized with live server identity and tool catalog",
  };
}

export interface ServiceRoleDeploymentIdentity {
  role: string;
  /** Explicit topology role; omitted values fail topology convergence. */
  roleKind?: "AUTHORITATIVE_PRODUCTION" | "NON_AUTHORITATIVE_CANARY" | "NON_AUTHORITATIVE_MIGRATION_SOURCE" | "NON_AUTHORITATIVE_TEST";
  expectedCommit: string;
  expectedBuildId?: string;
  runningBuild?: RunningBuildIdentity;
  installedBuild?: InstalledBuildIdentity;
  hostBinding?: HostBindingIdentity;
  pinned?: boolean;
}

export interface MultiRoleDeploymentEvaluation {
  converged: boolean;
  activeDrift: boolean;
  reconciliationRequired: boolean;
  topologyValid: boolean;
  authoritativeRole?: string;
  authoritativeProductionRoles: string[];
  nonAuthoritativeRoles: string[];
  missingRoleKindRoles: string[];
  roleStates: Record<string, DeploymentConvergenceEvaluation>;
  summary: string;
}

function explicitRoleKind(role: ServiceRoleDeploymentIdentity): ServiceRoleDeploymentIdentity["roleKind"] {
  const candidate = role.roleKind;
  return candidate && new Set(["AUTHORITATIVE_PRODUCTION", "NON_AUTHORITATIVE_CANARY", "NON_AUTHORITATIVE_MIGRATION_SOURCE", "NON_AUTHORITATIVE_TEST"]).has(candidate)
    ? candidate
    : undefined;
}

export function evaluateMultiRoleConvergence(
  roles: ServiceRoleDeploymentIdentity[],
  remoteMain?: RemoteMainIdentity,
  requiredCapabilities?: string[],
): MultiRoleDeploymentEvaluation {
  const roleStates: Record<string, DeploymentConvergenceEvaluation> = {};
  let converged = true;
  let activeDrift = false;
  let reconciliationRequired = false;
  const driftedRoles: string[] = [];
  const missingRoleKindRoles = roles.filter((role) => !explicitRoleKind(role)).map((role) => role.role);
  const authoritativeProductionRoles = roles
    .filter((role) => explicitRoleKind(role) === "AUTHORITATIVE_PRODUCTION")
    .map((role) => role.role);
  const nonAuthoritativeRoles = roles
    .filter((role) => explicitRoleKind(role) !== undefined && explicitRoleKind(role) !== "AUTHORITATIVE_PRODUCTION")
    .map((role) => role.role);
  const topologyValid = authoritativeProductionRoles.length === 1 && missingRoleKindRoles.length === 0;
  if (!topologyValid) {
    converged = false;
    reconciliationRequired = true;
    driftedRoles.push(`topology (expected exactly one explicit AUTHORITATIVE_PRODUCTION and explicit roleKind for every role; found ${authoritativeProductionRoles.length}, missing ${missingRoleKindRoles.length})`);
  }

  for (const roleDef of roles) {
    const snapshot: DeploymentIdentitySnapshot = {
      remoteMain,
      acceptedDeployment: {
        commit: roleDef.expectedCommit,
        buildId: roleDef.expectedBuildId,
        pinned: roleDef.pinned,
      },
      installedBuild: roleDef.installedBuild ?? {
        commit: roleDef.runningBuild?.commit ?? "uninstalled",
        buildId: roleDef.runningBuild?.buildId ?? "uninstalled",
        manifestSha256: roleDef.runningBuild?.manifestSha256 ?? "",
      },
      runningBuild: roleDef.runningBuild ?? {
        commit: "unknown",
        buildId: "unknown",
        serverInstanceId: "unknown",
        manifestSha256: "",
        cutoverMode: "drain",
        reconciliationRequired: true,
      },
      hostBinding: roleDef.hostBinding,
    };

    const evalResult = evaluateDeploymentConvergence(snapshot, requiredCapabilities);
    roleStates[roleDef.role] = evalResult;

    if (!evalResult.converged) {
      converged = false;
      driftedRoles.push(roleDef.role + " (" + evalResult.state + ")");
    }
    if (evalResult.activeDrift) activeDrift = true;
    if (evalResult.reconciliationRequired) reconciliationRequired = true;
  }

  return {
    converged,
    activeDrift,
    reconciliationRequired,
    topologyValid,
    authoritativeRole: authoritativeProductionRoles[0],
    authoritativeProductionRoles,
    nonAuthoritativeRoles,
    missingRoleKindRoles,
    roleStates,
    summary: converged
      ? `Authoritative role ${authoritativeProductionRoles[0]} is converged; ${nonAuthoritativeRoles.length} non-authoritative role(s) are explicitly named.`
      : "Drift detected in roles: " + driftedRoles.join(", ") + ".",
  };
}
