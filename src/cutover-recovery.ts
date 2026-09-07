import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import {
  BUILD_IDENTITY_RELATIVE_PATH,
  probeBuildReady,
  type BuildReadyProbeResult,
} from "./cutover-build-ready.js";
import {
  CutoverStateError,
  CutoverStateStore,
  type BuildReadyReceipt,
  type CutoverDrainEvidence,
  type CutoverServerIdentity,
  type DurableCutoverRecord,
  type ExpectedCutoverIdentity,
} from "./cutover-state.js";
import { recoverCutoverWithStore } from "./mcp-cutover.js";

/**
 * Out-of-process cutover recovery seam. It reads only the configured DevSpace
 * state directory and the build-ready probe root; it never starts an MCP
 * server, never accepts arbitrary filesystem paths, and never performs the
 * restart itself. The stale runtime running the pre-recovery build never
 * exposes these entry points; the operator runs this seat from the accepted
 * build after installation.
 */

export interface CutoverRecoveryResult {
  terminal: DurableCutoverRecord;
  successor: DurableCutoverRecord;
  newlyRecovered: boolean;
  drainRecord: DurableCutoverRecord;
  restartRequested: boolean;
  restartScheduled: boolean;
  buildReadyVerifiedBy: string;
}

export interface CutoverRecoveryDependencies {
  store: CutoverStateStore;
  /** Identity of the recovering control surface (the accepted build). */
  requesterIdentity: CutoverServerIdentity;
  /** Stale cutover id being superseded. */
  cutoverId: string;
  expectedNewIdentity: ExpectedCutoverIdentity;
  /** Aggregate transport drain evidence measured at recovery time. */
  drainEvidence: CutoverDrainEvidence;
  /** Physical probe of the installed/bound target build (positive required). */
  buildReadyProbe?: (expected: ExpectedCutoverIdentity) => BuildReadyProbeResult;
  /** Operator attestation fallback when no probe root is configured. */
  buildReadyAttestation?: Omit<BuildReadyReceipt, "verifiedAt">;
  expiresAt?: string;
  now?: () => number;
}

/** Perform terminal supersession + successor drain/restart scheduling durably. */
export function performCutoverRecovery(
  dependencies: CutoverRecoveryDependencies,
): CutoverRecoveryResult {
  const {
    store,
    requesterIdentity,
    cutoverId,
    expectedNewIdentity,
    drainEvidence,
    now = Date.now,
  } = dependencies;

  const current = store.get();
  if (!current) throw new CutoverStateError("No durable cutover record exists.");

  let buildReadyReceipt: Omit<BuildReadyReceipt, "verifiedAt">;
  if (dependencies.buildReadyProbe) {
    const probe = dependencies.buildReadyProbe(expectedNewIdentity);
    if (!probe.buildReady) {
      throw new CutoverStateError(`[CUTOVER_BUILD_NOT_READY] ${probe.detail}`);
    }
    buildReadyReceipt = { verifiedBy: probe.verifiedBy, evidence: probe.detail };
  } else if (dependencies.buildReadyAttestation) {
    buildReadyReceipt = dependencies.buildReadyAttestation;
  } else {
    throw new CutoverStateError(
      "Cutover recovery requires either a physical build-ready probe or an operator build-ready attestation; refusing to recover without one.",
    );
  }
  const buildReady: BuildReadyReceipt = {
    ...buildReadyReceipt,
    verifiedAt: new Date(now()).toISOString(),
  };

  const recovered = recoverCutoverWithStore(store, requesterIdentity, {
    cutoverId,
    expectedNewIdentity,
    ...(dependencies.expiresAt ? { expiresAt: dependencies.expiresAt } : {}),
  });

  const drainRecord = store.recordDrain(recovered.successor.cutoverId, drainEvidence);
  const requested = store.recordRestartRequest(recovered.successor.cutoverId, {
    actuator: "launchd-self",
    requestedByServerInstanceId: requesterIdentity.serverInstanceId,
    buildReady,
  });
  const scheduled = store.recordRestartScheduled(
    recovered.successor.cutoverId,
    requesterIdentity.serverInstanceId,
  );

  return {
    terminal: recovered.terminal,
    successor: recovered.successor,
    newlyRecovered: recovered.newlyRecovered,
    drainRecord,
    restartRequested: requested.newlyRequested,
    restartScheduled: scheduled.newlyScheduled,
    buildReadyVerifiedBy: buildReady.verifiedBy,
  };
}

/** Identity of the recovering runtime read from its own generated build identity. */
export function readRunningBuildIdentity(packageRoot: string): CutoverServerIdentity | undefined {
  try {
    const raw = readFileSync(join(packageRoot, BUILD_IDENTITY_RELATIVE_PATH), "utf8");
    const parsed = JSON.parse(raw) as { source_commit?: unknown; build_id?: unknown };
    if (typeof parsed.source_commit === "string" && typeof parsed.build_id === "string") {
      return {
        serverInstanceId: randomUUID(),
        sourceCommit: parsed.source_commit,
        buildId: parsed.build_id,
      };
    }
  } catch {
    // fall through; identity becomes unknown
  }
  return undefined;
}

/** Package root containing the currently executing build (dist or repo). */
export function runningPackageRoot(): string {
  return resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
}

/** Read-only status of the durable cutover store for the seam. */
export function cutoverSeamStatus(stateDir: string): Record<string, unknown> {
  const store = new CutoverStateStore(stateDir);
  return {
    active: store.get(),
    superseded: store.supersededRecord(),
  };
}

/** Resolve state from the same config chain the server uses; never a caller path. */
export function resolveSeamStateDir(): string {
  return loadConfig().stateDir;
}