import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const CUTOVER_STATE_SCHEMA = "devspace.cutover.v1" as const;
const CUTOVER_RESTART_SCHEMA = "devspace.cutover_restart.v1" as const;
const CUTOVER_RESTART_SCHEDULED_SCHEMA = "devspace.cutover_restart_scheduled.v1" as const;
export const CUTOVER_RECOVERY_INTENT_SCHEMA = "devspace.cutover_recovery_intent.v1" as const;
export const CUTOVER_SUPERSEDED_SCHEMA = "devspace.cutover_superseded.v1" as const;
export const CUTOVER_OBSERVED_REPLACEMENT_SCHEMA = "devspace.cutover_observed_replacement.v1" as const;

export const CUTOVER_SUPERSEDED_REASON = "STALE_TARGET_SUPERSEDED" as const;
export const CUTOVER_OBSERVED_REPLACEMENT_REASON = "OBSERVED_REPLACEMENT_WITHOUT_DRAIN" as const;
export const CUTOVER_BINDING_REPAIR_SCHEMA = "devspace.cutover_binding_repair.v1" as const;
export const CUTOVER_BINDING_REPAIR_REASON = "CROSS_DOMAIN_DIGEST_MISBINDING" as const;

/**
 * A stale unresolved cutover cannot be retried, replaced, or deleted. It can
 * only be closed as a terminal supersession that establishes one successor
 * record owning a fresh cutover id. The receipt binds the abandoned expected
 * identity, the observed recovering identity, and the historical restart
 * ambiguity so the successor can never be mistaken for a retry of the old
 * target.
 */
export interface CutoverSupersessionReceipt {
  schema: typeof CUTOVER_SUPERSEDED_SCHEMA;
  supersededCutoverId: string;
  oldServerIdentity: CutoverServerIdentity;
  oldExpectedIdentity: ExpectedCutoverIdentity;
  observedIdentity: CutoverServerIdentity;
  terminalReason: typeof CUTOVER_SUPERSEDED_REASON;
  supersededAt: string;
  recoveredBy: string;
  successorCutoverId: string;
  successorExpectedIdentity: ExpectedCutoverIdentity;
  restartAmbiguity: {
    restartRequested: boolean;
    restartScheduled: boolean;
    oldRestartEffect: "ambiguous_historical";
  };
}

/** Durable intent bound before any supersession side effect; exclusive per cutover. */
export interface CutoverRecoveryIntent {
  schema: typeof CUTOVER_RECOVERY_INTENT_SCHEMA;
  version: 1;
  supersedesCutoverId: string;
  expectedNewIdentity: ExpectedCutoverIdentity;
  requestedByServerInstanceId: string;
  requestedAt: string;
}

export interface CutoverServerIdentity {
  serverInstanceId: string;
  sourceCommit: string;
  buildId: string;
  capabilityManifestSha256?: string;
}

export interface ExpectedCutoverIdentity {
  sourceCommit: string;
  buildId: string;
  capabilityManifestSha256?: string;
}

/**
 * Returns the effective target identity for comparison and gating.
 * When a verified CROSS_DOMAIN_DIGEST_MISBINDING receipt exists, the effective
 * capability manifest expectation is corrected while preserving the original
 * bound digest in the durable record as immutable historical evidence.
 */
export function effectiveExpectedIdentity(record: DurableCutoverRecord): ExpectedCutoverIdentity {
  if (record.bindingRepair) {
    assertValidBindingRepair(record.bindingRepair, record);
    return {
      sourceCommit: record.expectedNewIdentity.sourceCommit,
      buildId: record.expectedNewIdentity.buildId,
      capabilityManifestSha256: record.bindingRepair.correctCapabilityManifestSha256,
    };
  }
  return record.expectedNewIdentity;
}

export interface CutoverDrainEvidence {
  activeSessions: number;
  oldestAgeMs: number;
}

export interface DurableReconciliationWitness {
  workspaceQueryable: boolean;
  agentQueryable: boolean;
  agentReconciled: boolean;
  witnessWorkspaceId?: string;
  witnessAgentId?: string;
  workspaceSessions?: number;
  agentSessions?: number;
  witnessWorkspaceSessions?: number;
  witnessAgentSessions?: number;
  witnessKind?: string;
  detail?: Array<{ unit: string; ok: boolean; detail?: string }>;
  witnessCutoverId?: string;
  witnessServerInstanceId?: string;
  witnessExpectedIdentity?: ExpectedCutoverIdentity;
}

export interface CutoverReconciliationReceipt {
  closedByServerInstanceId: string;
  workspaceQueryable: boolean;
  agentQueryable: boolean;
  agentReconciled: boolean;
  reconciledAt: string;
  terminalReason?: typeof CUTOVER_OBSERVED_REPLACEMENT_REASON;
  preRestartDrainObserved?: boolean;
  witnessWorkspaceId?: string;
  witnessAgentId?: string;
  witnessWorkspaceSessions?: number;
  witnessAgentSessions?: number;
  witnessKind?: string;
}

export interface CutoverObservedReplacementReceipt {
  schema: typeof CUTOVER_OBSERVED_REPLACEMENT_SCHEMA;
  cutoverId: string;
  terminalReason: typeof CUTOVER_OBSERVED_REPLACEMENT_REASON;
  preRestartDrainObserved: false;
  oldServerIdentity: CutoverServerIdentity;
  expectedIdentity: ExpectedCutoverIdentity;
  observedIdentity: CutoverServerIdentity;
  recoveredBy: string;
  recoveredAt: string;
  witnessWorkspaceId: string;
  witnessAgentId: string;
  witnessWorkspaceSessions: number;
  witnessAgentSessions: number;
  witnessKind: string;
  reconciliationReceipt: CutoverReconciliationReceipt;
}

export interface BuildReadyReceipt {
  verifiedBy: string;
  verifiedAt: string;
  evidence?: string;
}

export interface CutoverRestartRequest {
  actuator: "launchd-self";
  requestedByServerInstanceId: string;
  requestedAt: string;
  buildReady?: BuildReadyReceipt;
  restartScheduledAt?: string;
  restartScheduledForServerInstanceId?: string;
}

interface CutoverRestartMarker {
  schema: typeof CUTOVER_RESTART_SCHEMA;
  cutoverId: string;
  request: CutoverRestartRequest;
}

interface CutoverRestartScheduledMarker {
  schema: typeof CUTOVER_RESTART_SCHEDULED_SCHEMA;
  cutoverId: string;
  scheduledForServerInstanceId: string;
  scheduledAt: string;
}

export interface CutoverBindingRepairReceipt {
  schema: typeof CUTOVER_BINDING_REPAIR_SCHEMA;
  cutoverId: string;
  reason: typeof CUTOVER_BINDING_REPAIR_REASON;
  // 4 distinct identities required by G71-R1
  repairControlSurfaceIdentity: CutoverServerIdentity;
  observedTargetRuntimeIdentity: CutoverServerIdentity;
  originalCutoverExpectedIdentity: ExpectedCutoverIdentity;
  effectiveRepairedIdentity: ExpectedCutoverIdentity;

  originalBoundDigest: string;
  originalDigestField: "expectedNewIdentity.capabilityManifestSha256";
  provenActualDigestDomain: "build_manifest_sha256";
  correctCapabilityManifestSchema: "devspace.capability_manifest.v1";
  correctCapabilityManifestSha256: string;
  sourceCommit: string;
  buildId: string;
  observedServerInstanceId: string;
  repairedBy: string;
  repairedAt: string;
  physicalProbeEvidence: string;
  reconciliationWitness?: DurableReconciliationWitness;
}

export interface DurableCutoverRecord {
  schema: typeof CUTOVER_STATE_SCHEMA;
  cutoverId: string;
  phase: "prepared" | "drained" | "closed" | "superseded";
  oldServerIdentity: CutoverServerIdentity;
  expectedNewIdentity: ExpectedCutoverIdentity;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  expired?: boolean;
  drainEvidence?: CutoverDrainEvidence;
  restartRequest?: CutoverRestartRequest;
  reconciliationReceipt?: CutoverReconciliationReceipt;
  /** Present only on a successor record established by terminal supersession. */
  supersedesCutoverId?: string;
  /** Present only on a terminal superseded record. */
  supersession?: CutoverSupersessionReceipt;
  /** Present only on a record closed via observed replacement recovery without drain. */
  observedReplacement?: CutoverObservedReplacementReceipt;
  /** Present only on a record with a verified cross-domain digest repair. */
  bindingRepair?: CutoverBindingRepairReceipt;
}

export interface CutoverStateStoreOptions {
  now?: () => number;
  newId?: () => string;
}

export class CutoverStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutoverStateError";
  }
}

/**
 * A fixed-path, atomically created durable record is the exclusivity fence.
 * Expiry is projected as diagnostic evidence only and never authorizes unlink,
 * replacement, or ownership transfer of an unresolved record.
 */
export class CutoverStateStore {
  private readonly cutoverRoot: string;
  private readonly activeDir: string;
  private readonly createdPath: string;
  private readonly restartRequestedPath: string;
  private readonly restartScheduledPath: string;
  private readonly recoveryIntentPath: string;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(stateDir: string, options: CutoverStateStoreOptions = {}) {
    this.cutoverRoot = join(stateDir, "cutover");
    this.activeDir = join(this.cutoverRoot, "active");
    this.createdPath = join(this.activeDir, "created.json");
    this.restartRequestedPath = join(this.activeDir, "restart-requested.json");
    this.restartScheduledPath = join(this.activeDir, "restart-scheduled.json");
    this.recoveryIntentPath = join(this.cutoverRoot, "recovery-intent.json");
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  get(): DurableCutoverRecord | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.createdPath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT") && !existsSync(this.activeDir)) return undefined;
      if (isErrno(error, "ENOENT")) {
        throw new CutoverStateError(
          "Durable cutover fence exists without a readable creation record; reconciliation is required.",
        );
      }
      throw error;
    }
    let record = parseRecord(raw);
    const events = readdirSync(this.activeDir).filter((name) => name.endsWith(".json"))
      .sort();

    const successorCreatedPath = join(this.activeDir, SUCCESSOR_CREATED_FILE);
    const successorCreatedRaw = readOptionalFile(successorCreatedPath);
    if (successorCreatedRaw !== undefined) {
      const successorCreated = parseRecord(successorCreatedRaw);
      const successorClosed = latestEvent(events, "successor-closed-");
      const successorDrained = latestEvent(events, "successor-drained-");
      if (successorClosed) record = parseRecord(readFileSync(join(this.activeDir, successorClosed), "utf8"));
      else if (successorDrained) record = parseRecord(readFileSync(join(this.activeDir, successorDrained), "utf8"));
      else record = successorCreated;
    } else {
      const superseded = latestEvent(events, "superseded-");
      if (superseded) {
        record = parseRecord(readFileSync(join(this.activeDir, superseded), "utf8"));
      } else {
        const closed = latestEvent(events, "closed-");
        const drained = latestEvent(events, "drained-");
        if (closed) record = parseRecord(readFileSync(join(this.activeDir, closed), "utf8"));
        else if (drained) record = parseRecord(readFileSync(join(this.activeDir, drained), "utf8"));
      }
    }
    const markers = this.markerPaths(record);
    const restartRequest = readRestartMarker(markers.restartRequested, record.cutoverId)
      ?? record.restartRequest;
    const restartScheduled = restartRequest
      ? readRestartScheduledMarker(markers.restartScheduled, record.cutoverId)
      : undefined;
    const mergedRestartRequest = restartRequest && restartScheduled
      ? {
          ...restartRequest,
          restartScheduledAt: restartScheduled.scheduledAt,
          restartScheduledForServerInstanceId: restartScheduled.scheduledForServerInstanceId,
        }
      : restartRequest;
    const bindingRepair = readBindingRepairMarker(markers.bindingRepair, record.cutoverId)
      ?? record.bindingRepair;
    return {
      ...record,
      ...(bindingRepair ? { bindingRepair } : {}),
      ...(mergedRestartRequest ? {
        restartRequest: mergedRestartRequest,
        updatedAt: mergedRestartRequest.requestedAt > record.updatedAt
          ? mergedRestartRequest.requestedAt
          : record.updatedAt,
      } : {}),
      expired: record.expiresAt === undefined
        ? false
        : this.now() >= Date.parse(record.expiresAt),
    };
  }

  begin(input: {
    oldServerIdentity: CutoverServerIdentity;
    expectedNewIdentity: ExpectedCutoverIdentity;
    expiresAt?: string;
  }): DurableCutoverRecord {
    mkdirSync(this.cutoverRoot, { recursive: true, mode: 0o700 });
    const now = new Date(this.now()).toISOString();
    const record: DurableCutoverRecord = {
      schema: CUTOVER_STATE_SCHEMA,
      cutoverId: this.newId(),
      phase: "prepared",
      oldServerIdentity: input.oldServerIdentity,
      expectedNewIdentity: input.expectedNewIdentity,
      createdAt: now,
      updatedAt: now,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };

    for (;;) {
      const existing = this.get();
      if (existing && existing.phase !== "closed") {
        throw new CutoverStateError(
          `Unresolved cutover ${existing.cutoverId} already owns the durable cutover fence.`,
        );
      }
      if (existing?.phase === "closed") {
        const archived = join(this.cutoverRoot, `closed-${existing.cutoverId}-${this.newId()}`);
        try {
          renameSync(this.activeDir, archived);
        } catch (error) {
          if (isErrno(error, "ENOENT")) continue;
          throw error;
        }
      }

      try {
        mkdirSync(this.activeDir, { mode: 0o700 });
        writeExclusiveDurable(this.createdPath, serializeRecord(record));
        syncDirectory(this.activeDir);
        syncDirectory(this.cutoverRoot);
        return record;
      } catch (error) {
        if (isErrno(error, "EEXIST")) continue;
        throw error;
      }
    }
  }

  recordDrain(cutoverId: string, evidence: CutoverDrainEvidence): DurableCutoverRecord {
    const record = this.requireExact(cutoverId);
    if (record.phase === "closed") return record;
    return this.replace({
      ...withoutDiagnostic(record),
      phase: "drained",
      drainEvidence: evidence,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  recordRestartRequest(
    cutoverId: string,
    request: Omit<CutoverRestartRequest, "requestedAt">,
  ): { record: DurableCutoverRecord; newlyRequested: boolean } {
    const record = this.requireExact(cutoverId);
    if (record.phase !== "drained") {
      throw new CutoverStateError(
        `Cutover ${cutoverId} must be drained before restart can be requested.`,
      );
    }
    if (record.restartRequest) {
      return { record, newlyRequested: false };
    }
    if (request.buildReady !== undefined && !isBuildReadyReceipt(request.buildReady)) {
      throw new CutoverStateError(
        "Restart build-ready attestation is invalid; reconciliation is required.",
      );
    }
    const requestedAt = new Date(this.now()).toISOString();
    const marker: CutoverRestartMarker = {
      schema: CUTOVER_RESTART_SCHEMA,
      cutoverId,
      request: { ...request, requestedAt },
    };
    const markers = this.markerPaths(record);
    try {
      writeExclusiveDurable(markers.restartRequested, `${JSON.stringify(marker, null, 2)}\n`);
      syncDirectory(this.activeDir);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const current = this.requireExact(cutoverId);
      if (!current.restartRequest) {
        throw new CutoverStateError(
          "Durable restart fence exists without a readable restart request; reconciliation is required.",
        );
      }
      return { record: current, newlyRequested: false };
    }
    return { record: this.requireExact(cutoverId), newlyRequested: true };
  }

  recordRestartScheduled(
    cutoverId: string,
    scheduledForServerInstanceId: string,
  ): { record: DurableCutoverRecord; newlyScheduled: boolean } {
    const record = this.requireExact(cutoverId);
    if (record.phase !== "drained") {
      throw new CutoverStateError(
        `Cutover ${cutoverId} restart scheduling requires a drained cutover.`,
      );
    }
    if (!record.restartRequest?.buildReady) {
      throw new CutoverStateError(
        `Restart scheduling requires a build-ready attestation; refusing to schedule cutover ${cutoverId}. [CUTOVER_BUILD_NOT_READY]`,
      );
    }
    if (record.restartRequest?.restartScheduledAt) {
      return { record, newlyScheduled: false };
    }
    const marker: CutoverRestartScheduledMarker = {
      schema: CUTOVER_RESTART_SCHEDULED_SCHEMA,
      cutoverId,
      scheduledForServerInstanceId,
      scheduledAt: new Date(this.now()).toISOString(),
    };
    const markers = this.markerPaths(record);
    try {
      writeExclusiveDurable(markers.restartScheduled, `${JSON.stringify(marker, null, 2)}\n`);
      syncDirectory(this.activeDir);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      readRestartScheduledMarker(markers.restartScheduled, cutoverId);
      return { record: this.requireExact(cutoverId), newlyScheduled: false };
    }
    return { record: this.requireExact(cutoverId), newlyScheduled: true };
  }

  close(cutoverId: string, receipt: CutoverReconciliationReceipt): DurableCutoverRecord {
    const record = this.requireExact(cutoverId);
    if (record.phase === "closed") return record;
    return this.replace({
      ...withoutDiagnostic(record),
      phase: "closed",
      reconciliationReceipt: receipt,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  private requireExact(cutoverId: string): DurableCutoverRecord {
    const record = this.get();
    if (!record) throw new CutoverStateError("No durable cutover record exists.");
    if (record.cutoverId !== cutoverId) {
      throw new CutoverStateError(
        `Cutover id mismatch: active cutover is ${record.cutoverId}.`,
      );
    }
    return record;
  }

  private replace(record: DurableCutoverRecord): DurableCutoverRecord {
    const sequence = String(this.now()).padStart(16, "0");
    const eventPath = join(
      this.activeDir,
      this.eventFileName(record, record.phase, sequence),
    );
    writeExclusiveDurable(eventPath, serializeRecord(record));
    syncDirectory(this.activeDir);
    return record;
  }

  private eventFileName(record: DurableCutoverRecord, phase: string, sequence: string): string {
    const prefix = record.supersedesCutoverId !== undefined ? `successor-${phase}` : phase;
    return `${prefix}-${sequence}-${this.newId()}.json`;
  }

  /**
   * Restart markers are per-generation so the successor can never bind the old
   * cutover's restart fence and the old record can never bind the successor's.
   */
  private markerPaths(record: DurableCutoverRecord): {
    restartRequested: string;
    restartScheduled: string;
    bindingRepair: string;
  } {
    if (record.supersedesCutoverId === undefined) {
      return {
        restartRequested: this.restartRequestedPath,
        restartScheduled: this.restartScheduledPath,
        bindingRepair: join(this.activeDir, "binding-repair.json"),
      };
    }
    return {
      restartRequested: join(this.activeDir, `restart-requested-${record.cutoverId}.json`),
      restartScheduled: join(this.activeDir, `restart-scheduled-${record.cutoverId}.json`),
      bindingRepair: join(this.activeDir, `binding-repair-${record.cutoverId}.json`),
    };
  }

  recordBindingRepair(
    cutoverId: string,
    repair: CutoverBindingRepairReceipt,
  ): { record: DurableCutoverRecord; newlyRepaired: boolean } {
    const record = this.requireExact(cutoverId);
    if (!isBindingRepairReceipt(repair) || repair.cutoverId !== cutoverId) {
      throw new CutoverStateError("Binding repair receipt is malformed; reconciliation is required.");
    }
    const markers = this.markerPaths(record);
    if (record.bindingRepair) {
      if (!isDeepStrictEqual(record.bindingRepair, repair)) {
        throw new CutoverStateError(
          "[REPAIR_BINDING_MISMATCH] Active cutover already has a different durable binding repair receipt.",
        );
      }
      return { record, newlyRepaired: false };
    }
    try {
      writeExclusiveDurable(markers.bindingRepair, `${JSON.stringify(repair, null, 2)}\n`);
      syncDirectory(this.activeDir);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const current = this.requireExact(cutoverId);
      if (!current.bindingRepair) {
        throw new CutoverStateError(
          "Durable binding repair fence exists without a readable receipt; reconciliation is required.",
        );
      }
      if (!isDeepStrictEqual(current.bindingRepair, repair)) {
        throw new CutoverStateError(
          "[REPAIR_BINDING_MISMATCH] Concurrent binding repair recorded a different receipt.",
        );
      }
      return { record: current, newlyRepaired: false };
    }
    return { record: this.requireExact(cutoverId), newlyRepaired: true };
  }

  /** Terminal supersession record for a stale resolved cutover, if any. */
  supersededRecord(): DurableCutoverRecord | undefined {
    let events: string[];
    try {
      events = readdirSync(this.activeDir).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    const superseded = latestEvent(events, "superseded-");
    if (!superseded) return undefined;
    return parseRecord(readFileSync(join(this.activeDir, superseded), "utf8"));
  }

  /**
   * Terminally supersede a stale unresolved cutover and establish exactly one
   * successor record with a fresh cutover id. Crash-consistent and idempotent:
   * the recovery intent and the superseded event are written before the
   * successor is established, so being window between A-superseded and
   * B-created still owns the durable fence. A different target on retry fails
   * with [RECOVERY_BINDING_MISMATCH].
   */
  recoverSupersede(input: {
    cutoverId: string;
    expectedNewIdentity: ExpectedCutoverIdentity;
    observedIdentity: CutoverServerIdentity;
    recoveredBy: string;
    expiresAt?: string;
  }): { terminal: DurableCutoverRecord; successor: DurableCutoverRecord; newlyRecovered: boolean } {
    mkdirSync(this.cutoverRoot, { recursive: true, mode: 0o700 });
    const active = this.get();

    if (
      active &&
      active.supersedesCutoverId === input.cutoverId &&
      active.cutoverId !== input.cutoverId
    ) {
      const terminal = this.requireSuperseded(input.cutoverId);
      this.assertRecoveryBinding(input);
      return { terminal, successor: active, newlyRecovered: false };
    }

    if (active?.phase === "superseded") {
      const terminal = this.requireSuperseded(input.cutoverId);
      this.assertRecoveryBinding(input);
      const successor = this.establishSuccessor(terminal, input);
      return { terminal, successor, newlyRecovered: true };
    }

    if (!active) throw new CutoverStateError("No durable cutover record exists.");
    if (active.cutoverId !== input.cutoverId) {
      throw new CutoverStateError(
        `Cutover id mismatch: active cutover is ${active.cutoverId}.`,
      );
    }
    if (active.phase === "closed") {
      throw new CutoverStateError(
        `Cutover ${input.cutoverId} is already closed; normal begin() or archive applies, not supersession.`,
      );
    }
    if (active.supersession) {
      const terminal = this.requireSuperseded(input.cutoverId);
      this.assertRecoveryBinding(input);
      return { terminal, successor: active, newlyRecovered: false };
    }

    this.writeRecoveryIntent(input);

    const supersededAt = new Date(this.now()).toISOString();
    const successorCutoverId = this.newId();
    const terminal: DurableCutoverRecord = {
      ...withoutDiagnostic(active),
      phase: "superseded",
      expectedNewIdentity: input.expectedNewIdentity,
      supersedesCutoverId: undefined,
      supersession: {
        schema: CUTOVER_SUPERSEDED_SCHEMA,
        supersededCutoverId: input.cutoverId,
        oldServerIdentity: active.oldServerIdentity,
        oldExpectedIdentity: active.expectedNewIdentity,
        observedIdentity: input.observedIdentity,
        terminalReason: CUTOVER_SUPERSEDED_REASON,
        supersededAt,
        recoveredBy: input.recoveredBy,
        successorCutoverId,
        successorExpectedIdentity: input.expectedNewIdentity,
        restartAmbiguity: {
          restartRequested: Boolean(active.restartRequest),
          restartScheduled: Boolean(active.restartRequest?.restartScheduledAt),
          oldRestartEffect: "ambiguous_historical",
        },
      },
      updatedAt: supersededAt,
    };
    this.replace(terminal);
    const successor: DurableCutoverRecord = {
      schema: CUTOVER_STATE_SCHEMA,
      cutoverId: successorCutoverId,
      phase: "prepared",
      oldServerIdentity: active.oldServerIdentity,
      expectedNewIdentity: input.expectedNewIdentity,
      supersedesCutoverId: input.cutoverId,
      createdAt: supersededAt,
      updatedAt: supersededAt,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    this.writeSuccessorCreated(successor);
    return { terminal, successor, newlyRecovered: true };
  }

  private writeRecoveryIntent(input: {
    cutoverId: string;
    expectedNewIdentity: ExpectedCutoverIdentity;
    recoveredBy: string;
  }): void {
    const intent: CutoverRecoveryIntent = {
      schema: CUTOVER_RECOVERY_INTENT_SCHEMA,
      version: 1,
      supersedesCutoverId: input.cutoverId,
      expectedNewIdentity: input.expectedNewIdentity,
      requestedByServerInstanceId: input.recoveredBy,
      requestedAt: new Date(this.now()).toISOString(),
    };
    try {
      writeExclusiveDurable(this.recoveryIntentPath, `${JSON.stringify(intent, null, 2)}\n`);
      syncDirectory(this.cutoverRoot);
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        this.assertRecoveryBinding(input);
        return;
      }
      throw error;
    }
  }

  private assertRecoveryBinding(input: {
    cutoverId: string;
    expectedNewIdentity: ExpectedCutoverIdentity;
  }): void {
    const intent = readRecoveryIntent(this.recoveryIntentPath);
    if (
      intent.supersedesCutoverId !== input.cutoverId ||
      intent.expectedNewIdentity.sourceCommit !== input.expectedNewIdentity.sourceCommit ||
      intent.expectedNewIdentity.buildId !== input.expectedNewIdentity.buildId ||
      (intent.expectedNewIdentity.capabilityManifestSha256 ?? undefined) !==
        (input.expectedNewIdentity.capabilityManifestSha256 ?? undefined)
    ) {
      throw new CutoverStateError(
        `Recovery intent binds cutover ${intent.supersedesCutoverId} to a different target; ` +
        "refusing to supersede. [RECOVERY_BINDING_MISMATCH]",
      );
    }
  }

  private requireSuperseded(cutoverId: string): DurableCutoverRecord {
    const terminal = this.supersededRecord();
    if (!terminal || terminal.cutoverId !== cutoverId) {
      throw new CutoverStateError(`Cutover ${cutoverId} has no terminal supersession record.`);
    }
    return terminal;
  }

  private establishSuccessor(
    terminal: DurableCutoverRecord,
    input: {
      expectedNewIdentity: ExpectedCutoverIdentity;
      expiresAt?: string;
    },
  ): DurableCutoverRecord {
    const successor: DurableCutoverRecord = {
      schema: CUTOVER_STATE_SCHEMA,
      cutoverId: this.newId(),
      phase: "prepared",
      oldServerIdentity: terminal.oldServerIdentity,
      expectedNewIdentity: input.expectedNewIdentity,
      supersedesCutoverId: terminal.cutoverId,
      createdAt: terminal.updatedAt,
      updatedAt: terminal.updatedAt,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    this.writeSuccessorCreated(successor);
    return successor;
  }

  private writeSuccessorCreated(record: DurableCutoverRecord): void {
    mkdirSync(this.activeDir, { mode: 0o700, recursive: true });
    const path = join(this.activeDir, SUCCESSOR_CREATED_FILE);
    try {
      writeExclusiveDurable(path, serializeRecord(record));
      syncDirectory(this.activeDir);
      syncDirectory(this.cutoverRoot);
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        const existing = readOptionalFile(path);
        if (existing === undefined) {
          throw new CutoverStateError(
            "Durable successor fence exists but is unreadable; reconciliation is required.",
          );
        }
        const parsed = parseRecord(existing);
        if (parsed.cutoverId !== record.cutoverId) {
          throw new CutoverStateError(
            "Successor fence is bound to a different successor; refusing to double-establish. [RECOVERY_BINDING_MISMATCH]",
          );
        }
        return;
      }
      throw error;
    }
  }

  /**
   * Terminally close one cutover where the replacement server is already running with
   * exact expected source/build/capability identity, but pre-restart drain evidence
   * was absent (e.g. transport initialization rejection before cutover_drain reached handler).
   *
   * Invariants:
   * - Requires phase "prepared" with drainEvidence absent.
   * - Never fabricates drainEvidence (remains undefined).
   * - Never alters phase to "drained".
   * - Never creates a successor cutover.
   * - Never schedules or requests a restart.
   * - Does not read or write the stale-target supersession recovery intent.
   * - Requires fully positive reconciliation witness (workspaceQueryable, agentQueryable, agentReconciled).
   * - Idempotent rendezvous if already closed via this exact recovery.
   * - Fail closed on wrong cutoverId or wrong active/observed identity.
   */
  recoverObservedReplacement(input: {
    cutoverId: string;
    expectedNewIdentity?: ExpectedCutoverIdentity;
    observedIdentity: CutoverServerIdentity;
    witness: DurableReconciliationWitness;
    recoveredBy: string;
  }): { record: DurableCutoverRecord; newlyRecovered: boolean } {
    mkdirSync(this.cutoverRoot, { recursive: true, mode: 0o700 });
    const active = this.get();
    if (!active) throw new CutoverStateError("No durable cutover record exists.");
    if (active.cutoverId !== input.cutoverId) {
      throw new CutoverStateError(
        `Cutover id mismatch: active cutover is ${active.cutoverId}.`,
      );
    }

    if (input.expectedNewIdentity) {
      if (
        input.expectedNewIdentity.sourceCommit !== active.expectedNewIdentity.sourceCommit ||
        input.expectedNewIdentity.buildId !== active.expectedNewIdentity.buildId ||
        (active.expectedNewIdentity.capabilityManifestSha256 !== undefined &&
          input.expectedNewIdentity.capabilityManifestSha256 !== active.expectedNewIdentity.capabilityManifestSha256)
      ) {
        throw new CutoverStateError(
          "[RECOVERY_BINDING_MISMATCH] Recovery expected identity does not match active cutover expected identity.",
        );
      }
    }

    // Validate the observed generation before idempotent closed replay. A
    // closed receipt is only a rendezvous for the same replacement identity;
    // it must not become an oracle for a stale or changed instance.
    if (active.oldServerIdentity.serverInstanceId === input.observedIdentity.serverInstanceId) {
      throw new CutoverStateError(
        "Cannot recover cutover: observed serverInstanceId did not change from the old server.",
      );
    }
    if (input.observedIdentity.sourceCommit !== active.expectedNewIdentity.sourceCommit) {
      throw new CutoverStateError(
        `Cannot recover cutover: observed sourceCommit ${input.observedIdentity.sourceCommit} does not match expected ${active.expectedNewIdentity.sourceCommit}.`,
      );
    }
    if (input.observedIdentity.buildId !== active.expectedNewIdentity.buildId) {
      throw new CutoverStateError(
        `Cannot recover cutover: observed buildId ${input.observedIdentity.buildId} does not match expected ${active.expectedNewIdentity.buildId}.`,
      );
    }
    if (
      !active.expectedNewIdentity.capabilityManifestSha256?.trim() ||
      input.observedIdentity.capabilityManifestSha256 !== active.expectedNewIdentity.capabilityManifestSha256
    ) {
      throw new CutoverStateError(
        "Cannot recover cutover: observed capability manifest does not match expected target.",
      );
    }

    if (active.phase === "closed") {
      if (active.observedReplacement?.cutoverId === input.cutoverId) {
        const observed = active.observedReplacement.observedIdentity;
        if (
          observed.serverInstanceId !== input.observedIdentity.serverInstanceId ||
          observed.sourceCommit !== input.observedIdentity.sourceCommit ||
          observed.buildId !== input.observedIdentity.buildId ||
          observed.capabilityManifestSha256 !== input.observedIdentity.capabilityManifestSha256
        ) {
          throw new CutoverStateError(
            "[RECOVERY_BINDING_MISMATCH] Observed replacement identity does not match the closed receipt.",
          );
        }
        return { record: active, newlyRecovered: false };
      }
      throw new CutoverStateError(
        `Cutover ${input.cutoverId} is already closed; normal archive applies.`,
      );
    }

    if (active.phase !== "prepared" || active.drainEvidence !== undefined) {
      throw new CutoverStateError(
        `Cutover ${input.cutoverId} requires prepared state without durable drain evidence for observed replacement recovery.`,
      );
    }

    const wsSessions = input.witness.witnessWorkspaceSessions ?? input.witness.workspaceSessions ?? 0;
    const agSessions = input.witness.witnessAgentSessions ?? input.witness.agentSessions ?? 0;
    const witnessWsId = input.witness.witnessWorkspaceId;
    const witnessAgId = input.witness.witnessAgentId;
    const witnessKind = input.witness.witnessKind ?? "exact-pair";

    if (
      input.witness.witnessCutoverId !== input.cutoverId
    ) {
      throw new CutoverStateError("[RECOVERY_BINDING_MISMATCH] Witness belongs to a different cutover generation.");
    }
    if (
      input.witness.witnessServerInstanceId !== input.observedIdentity.serverInstanceId
    ) {
      throw new CutoverStateError("[RECOVERY_BINDING_MISMATCH] Witness belongs to a different replacement instance.");
    }
    const witnessExpected = input.witness.witnessExpectedIdentity;
    if (
      !witnessExpected ||
      !witnessExpected.capabilityManifestSha256?.trim() ||
      (witnessExpected.sourceCommit !== active.expectedNewIdentity.sourceCommit ||
        witnessExpected.buildId !== active.expectedNewIdentity.buildId ||
        witnessExpected.capabilityManifestSha256 !== active.expectedNewIdentity.capabilityManifestSha256)
    ) {
      throw new CutoverStateError("[RECOVERY_BINDING_MISMATCH] Witness expected identity does not match the cutover generation.");
    }

    if (
      !input.witness.workspaceQueryable ||
      !input.witness.agentQueryable ||
      !input.witness.agentReconciled ||
      !Number.isSafeInteger(wsSessions) ||
      wsSessions < 1 ||
      !Number.isSafeInteger(agSessions) ||
      agSessions < 1 ||
      !witnessWsId ||
      !witnessAgId
    ) {
      throw new CutoverStateError(
        "Cannot recover cutover: durable agent/workspace reconciliation witness is not fully positive or missing exact non-empty binding.",
      );
    }

    const nowIso = new Date(this.now()).toISOString();
    const reconciliationReceipt: CutoverReconciliationReceipt = {
      closedByServerInstanceId: input.observedIdentity.serverInstanceId,
      workspaceQueryable: input.witness.workspaceQueryable,
      agentQueryable: input.witness.agentQueryable,
      agentReconciled: input.witness.agentReconciled,
      reconciledAt: nowIso,
      terminalReason: CUTOVER_OBSERVED_REPLACEMENT_REASON,
      preRestartDrainObserved: false,
      witnessWorkspaceId: witnessWsId,
      witnessAgentId: witnessAgId,
      witnessWorkspaceSessions: wsSessions,
      witnessAgentSessions: agSessions,
      witnessKind,
    };

    const observedReplacement: CutoverObservedReplacementReceipt = {
      schema: CUTOVER_OBSERVED_REPLACEMENT_SCHEMA,
      cutoverId: input.cutoverId,
      terminalReason: CUTOVER_OBSERVED_REPLACEMENT_REASON,
      preRestartDrainObserved: false,
      oldServerIdentity: active.oldServerIdentity,
      expectedIdentity: active.expectedNewIdentity,
      observedIdentity: input.observedIdentity,
      recoveredBy: input.recoveredBy,
      recoveredAt: nowIso,
      witnessWorkspaceId: witnessWsId,
      witnessAgentId: witnessAgId,
      witnessWorkspaceSessions: wsSessions,
      witnessAgentSessions: agSessions,
      witnessKind,
      reconciliationReceipt,
    };

    const closedRecord: DurableCutoverRecord = {
      ...withoutDiagnostic(active),
      phase: "closed",
      drainEvidence: undefined,
      reconciliationReceipt,
      observedReplacement,
      updatedAt: nowIso,
    };

    const closed = this.replace(closedRecord);
    return { record: closed, newlyRecovered: true };
  }
}

function withoutDiagnostic(record: DurableCutoverRecord): DurableCutoverRecord {
  const { expired: _expired, ...durable } = record;
  return durable;
}

function serializeRecord(record: DurableCutoverRecord): string {
  return `${JSON.stringify(withoutDiagnostic(record), null, 2)}\n`;
}

function parseRecord(raw: string): DurableCutoverRecord {
  const value = JSON.parse(raw) as Partial<DurableCutoverRecord>;
  if (
    value.schema !== CUTOVER_STATE_SCHEMA ||
    typeof value.cutoverId !== "string" ||
    !["prepared", "drained", "closed", "superseded"].includes(value.phase ?? "") ||
    !isIdentity(value.oldServerIdentity) ||
    !isExpectedIdentity(value.expectedNewIdentity) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.restartRequest !== undefined && !isRestartRequest(value.restartRequest)) ||
    (value.supersedesCutoverId !== undefined &&
      (typeof value.supersedesCutoverId !== "string" ||
        value.supersedesCutoverId.trim() === "" ||
        value.supersedesCutoverId === value.cutoverId)) ||
    (value.supersession !== undefined && !isSupersessionReceipt(value.supersession)) ||
    (value.reconciliationReceipt !== undefined && !isReconciliationReceipt(value.reconciliationReceipt)) ||
    (value.observedReplacement !== undefined && !isObservedReplacementReceipt(value.observedReplacement)) ||
    (value.bindingRepair !== undefined && !isBindingRepairReceipt(value.bindingRepair))
  ) {
    throw new CutoverStateError("Durable cutover record is malformed; reconciliation is required.");
  }
  const record = value as DurableCutoverRecord;
  if (record.bindingRepair) {
    assertValidBindingRepair(record.bindingRepair, record);
  }
  if (record.observedReplacement) {
    const receipt = record.observedReplacement;
    if (
      receipt.cutoverId !== record.cutoverId ||
      receipt.observedIdentity.serverInstanceId === receipt.oldServerIdentity.serverInstanceId ||
      !receipt.expectedIdentity.capabilityManifestSha256?.trim() ||
      !isDeepStrictEqual(record.reconciliationReceipt, receipt.reconciliationReceipt) ||
      !identitiesEqual(receipt.oldServerIdentity, record.oldServerIdentity) ||
      !expectedIdentitiesEqual(receipt.expectedIdentity, record.expectedNewIdentity) ||
      receipt.observedIdentity.sourceCommit !== receipt.expectedIdentity.sourceCommit ||
      receipt.observedIdentity.buildId !== receipt.expectedIdentity.buildId ||
      (receipt.expectedIdentity.capabilityManifestSha256 !== undefined &&
        receipt.observedIdentity.capabilityManifestSha256 !== receipt.expectedIdentity.capabilityManifestSha256) ||
      receipt.reconciliationReceipt.closedByServerInstanceId !== receipt.observedIdentity.serverInstanceId ||
      receipt.reconciliationReceipt.preRestartDrainObserved !== false ||
      receipt.reconciliationReceipt.witnessWorkspaceId !== receipt.witnessWorkspaceId ||
      receipt.reconciliationReceipt.witnessAgentId !== receipt.witnessAgentId ||
      receipt.reconciliationReceipt.witnessWorkspaceSessions !== receipt.witnessWorkspaceSessions ||
      receipt.reconciliationReceipt.witnessAgentSessions !== receipt.witnessAgentSessions ||
      record.phase !== "closed" ||
      record.drainEvidence !== undefined
    ) {
      throw new CutoverStateError("Durable cutover record is malformed; observed replacement binding is inconsistent.");
    }
  }
  return record;
}

function identitiesEqual(a: CutoverServerIdentity, b: CutoverServerIdentity): boolean {
  return a.serverInstanceId === b.serverInstanceId &&
    a.sourceCommit === b.sourceCommit &&
    a.buildId === b.buildId &&
    a.capabilityManifestSha256 === b.capabilityManifestSha256;
}

function expectedIdentitiesEqual(a: ExpectedCutoverIdentity, b: ExpectedCutoverIdentity): boolean {
  return a.sourceCommit === b.sourceCommit &&
    a.buildId === b.buildId &&
    a.capabilityManifestSha256 === b.capabilityManifestSha256;
}

function isReconciliationReceipt(value: unknown): value is CutoverReconciliationReceipt {
  const receipt = value as Partial<CutoverReconciliationReceipt> | undefined;
  return Boolean(
    receipt &&
    typeof receipt.closedByServerInstanceId === "string" &&
    receipt.closedByServerInstanceId.length > 0 &&
    typeof receipt.workspaceQueryable === "boolean" &&
    typeof receipt.agentQueryable === "boolean" &&
    typeof receipt.agentReconciled === "boolean" &&
    typeof receipt.reconciledAt === "string" &&
    Number.isFinite(Date.parse(receipt.reconciledAt)) &&
    (receipt.preRestartDrainObserved === undefined || typeof receipt.preRestartDrainObserved === "boolean") &&
    (receipt.terminalReason === undefined || receipt.terminalReason === CUTOVER_OBSERVED_REPLACEMENT_REASON),
  );
}

function isObservedReplacementReceipt(value: unknown): value is CutoverObservedReplacementReceipt {
  const receipt = value as Partial<CutoverObservedReplacementReceipt> | undefined;
  return Boolean(
    receipt &&
    receipt.schema === CUTOVER_OBSERVED_REPLACEMENT_SCHEMA &&
    typeof receipt.cutoverId === "string" &&
    receipt.cutoverId.length > 0 &&
    receipt.terminalReason === CUTOVER_OBSERVED_REPLACEMENT_REASON &&
    receipt.preRestartDrainObserved === false &&
    isIdentity(receipt.oldServerIdentity) &&
    isExpectedIdentity(receipt.expectedIdentity) &&
    isIdentity(receipt.observedIdentity) &&
    typeof receipt.recoveredBy === "string" &&
    receipt.recoveredBy.length > 0 &&
    typeof receipt.recoveredAt === "string" &&
    Number.isFinite(Date.parse(receipt.recoveredAt)) &&
    typeof receipt.witnessWorkspaceId === "string" &&
    receipt.witnessWorkspaceId.length > 0 &&
    typeof receipt.witnessAgentId === "string" &&
    receipt.witnessAgentId.length > 0 &&
    typeof receipt.witnessWorkspaceSessions === "number" &&
    receipt.witnessWorkspaceSessions >= 1 &&
    typeof receipt.witnessAgentSessions === "number" &&
    receipt.witnessAgentSessions >= 1 &&
    typeof receipt.witnessKind === "string" &&
    receipt.reconciliationReceipt !== undefined &&
    isReconciliationReceipt(receipt.reconciliationReceipt),
  );
}

function isBindingRepairReceipt(value: unknown): value is CutoverBindingRepairReceipt {
  const receipt = value as Partial<CutoverBindingRepairReceipt> | undefined;
  return Boolean(
    receipt &&
    receipt.schema === CUTOVER_BINDING_REPAIR_SCHEMA &&
    typeof receipt.cutoverId === "string" &&
    receipt.cutoverId.length > 0 &&
    receipt.reason === CUTOVER_BINDING_REPAIR_REASON &&
    typeof receipt.originalBoundDigest === "string" &&
    /^[0-9a-f]{64}$/.test(receipt.originalBoundDigest) &&
    receipt.originalDigestField === "expectedNewIdentity.capabilityManifestSha256" &&
    receipt.provenActualDigestDomain === "build_manifest_sha256" &&
    receipt.correctCapabilityManifestSchema === "devspace.capability_manifest.v1" &&
    typeof receipt.correctCapabilityManifestSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(receipt.correctCapabilityManifestSha256) &&
    typeof receipt.sourceCommit === "string" &&
    /^[0-9a-f]{40}$/.test(receipt.sourceCommit) &&
    typeof receipt.buildId === "string" &&
    receipt.buildId.length > 0 &&
    typeof receipt.observedServerInstanceId === "string" &&
    receipt.observedServerInstanceId.length > 0 &&
    typeof receipt.repairedBy === "string" &&
    receipt.repairedBy.length > 0 &&
    typeof receipt.repairedAt === "string" &&
    Number.isFinite(Date.parse(receipt.repairedAt)) &&
    typeof receipt.physicalProbeEvidence === "string" &&
    receipt.physicalProbeEvidence.length > 0 &&
    (!receipt.repairControlSurfaceIdentity || isIdentity(receipt.repairControlSurfaceIdentity)) &&
    (!receipt.observedTargetRuntimeIdentity || isIdentity(receipt.observedTargetRuntimeIdentity)) &&
    (!receipt.originalCutoverExpectedIdentity || isExpectedIdentity(receipt.originalCutoverExpectedIdentity)) &&
    (!receipt.effectiveRepairedIdentity || isExpectedIdentity(receipt.effectiveRepairedIdentity)),
  );
}

export function assertValidBindingRepair(
  repair: CutoverBindingRepairReceipt,
  record: DurableCutoverRecord,
): void {
  if (
    repair.schema !== CUTOVER_BINDING_REPAIR_SCHEMA ||
    repair.cutoverId !== record.cutoverId ||
    repair.reason !== CUTOVER_BINDING_REPAIR_REASON ||
    repair.originalBoundDigest !== record.expectedNewIdentity.capabilityManifestSha256 ||
    repair.sourceCommit !== record.expectedNewIdentity.sourceCommit ||
    repair.buildId !== record.expectedNewIdentity.buildId ||
    (repair.effectiveRepairedIdentity &&
      (repair.effectiveRepairedIdentity.sourceCommit !== record.expectedNewIdentity.sourceCommit ||
        repair.effectiveRepairedIdentity.buildId !== record.expectedNewIdentity.buildId ||
        repair.effectiveRepairedIdentity.capabilityManifestSha256 !== repair.correctCapabilityManifestSha256)) ||
    (repair.observedTargetRuntimeIdentity &&
      (repair.observedTargetRuntimeIdentity.serverInstanceId !== repair.observedServerInstanceId ||
        repair.observedTargetRuntimeIdentity.sourceCommit !== record.expectedNewIdentity.sourceCommit ||
        repair.observedTargetRuntimeIdentity.buildId !== record.expectedNewIdentity.buildId)) ||
    (repair.originalCutoverExpectedIdentity &&
      (repair.originalCutoverExpectedIdentity.sourceCommit !== record.expectedNewIdentity.sourceCommit ||
        repair.originalCutoverExpectedIdentity.buildId !== record.expectedNewIdentity.buildId ||
        repair.originalCutoverExpectedIdentity.capabilityManifestSha256 !== record.expectedNewIdentity.capabilityManifestSha256)) ||
    repair.observedServerInstanceId === record.oldServerIdentity.serverInstanceId
  ) {
    throw new CutoverStateError("Durable cutover record is malformed; binding repair receipt is inconsistent.");
  }
}

function isSupersessionReceipt(value: unknown): value is CutoverSupersessionReceipt {
  const receipt = value as Partial<CutoverSupersessionReceipt> | undefined;
  return Boolean(
    receipt &&
    receipt.schema === CUTOVER_SUPERSEDED_SCHEMA &&
    typeof receipt.supersededCutoverId === "string" &&
    receipt.supersededCutoverId.length > 0 &&
    isIdentity(receipt.oldServerIdentity) &&
    isExpectedIdentity(receipt.oldExpectedIdentity) &&
    isIdentity(receipt.observedIdentity) &&
    receipt.terminalReason === CUTOVER_SUPERSEDED_REASON &&
    typeof receipt.supersededAt === "string" &&
    Number.isFinite(Date.parse(receipt.supersededAt)) &&
    typeof receipt.recoveredBy === "string" &&
    receipt.recoveredBy.length > 0 &&
    typeof receipt.successorCutoverId === "string" &&
    receipt.successorCutoverId.trim() !== "" &&
    isExpectedIdentity(receipt.successorExpectedIdentity) &&
    receipt.restartAmbiguity !== undefined &&
    typeof receipt.restartAmbiguity.restartRequested === "boolean" &&
    typeof receipt.restartAmbiguity.restartScheduled === "boolean" &&
    receipt.restartAmbiguity.oldRestartEffect === "ambiguous_historical",
  );
}

function isIdentity(value: unknown): value is CutoverServerIdentity {
  const identity = value as Partial<CutoverServerIdentity> | undefined;
  return Boolean(
    identity &&
    typeof identity.serverInstanceId === "string" &&
    typeof identity.sourceCommit === "string" &&
    typeof identity.buildId === "string",
  );
}

function isExpectedIdentity(value: unknown): value is ExpectedCutoverIdentity {
  const identity = value as Partial<ExpectedCutoverIdentity> | undefined;
  return Boolean(
    identity &&
    typeof identity.sourceCommit === "string" &&
    typeof identity.buildId === "string",
  );
}

function isRestartRequest(value: unknown): value is CutoverRestartRequest {
  const request = value as Partial<CutoverRestartRequest> | undefined;
  return Boolean(
    request &&
    request.actuator === "launchd-self" &&
    typeof request.requestedByServerInstanceId === "string" &&
    request.requestedByServerInstanceId.length > 0 &&
    typeof request.requestedAt === "string" &&
    Number.isFinite(Date.parse(request.requestedAt)) &&
    (request.buildReady === undefined || isBuildReadyReceipt(request.buildReady)) &&
    (request.restartScheduledAt === undefined ||
      (typeof request.restartScheduledAt === "string" &&
        Number.isFinite(Date.parse(request.restartScheduledAt)))) &&
    (request.restartScheduledForServerInstanceId === undefined ||
      (typeof request.restartScheduledForServerInstanceId === "string" &&
        request.restartScheduledForServerInstanceId.length > 0)),
  );
}

function isBuildReadyReceipt(value: unknown): value is BuildReadyReceipt {
  const receipt = value as Partial<BuildReadyReceipt> | undefined;
  return Boolean(
    receipt &&
    typeof receipt.verifiedBy === "string" &&
    receipt.verifiedBy.length > 0 &&
    typeof receipt.verifiedAt === "string" &&
    Number.isFinite(Date.parse(receipt.verifiedAt)) &&
    (receipt.evidence === undefined || typeof receipt.evidence === "string"),
  );
}

function readRestartScheduledMarker(
  path: string,
  expectedCutoverId: string,
): CutoverRestartScheduledMarker | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  let value: Partial<CutoverRestartScheduledMarker>;
  try {
    value = JSON.parse(raw) as Partial<CutoverRestartScheduledMarker>;
  } catch {
    throw new CutoverStateError(
      "Durable restart-scheduled fence is malformed; reconciliation is required.",
    );
  }
  if (
    value.schema !== CUTOVER_RESTART_SCHEDULED_SCHEMA ||
    value.cutoverId !== expectedCutoverId ||
    typeof value.scheduledForServerInstanceId !== "string" ||
    value.scheduledForServerInstanceId.length === 0 ||
    typeof value.scheduledAt !== "string" ||
    !Number.isFinite(Date.parse(value.scheduledAt))
  ) {
    throw new CutoverStateError(
      "Durable restart-scheduled fence does not match the active cutover; reconciliation is required.",
    );
  }
  return value as CutoverRestartScheduledMarker;
}

function readRestartMarker(
  path: string,
  expectedCutoverId: string,
): CutoverRestartRequest | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  let value: Partial<CutoverRestartMarker>;
  try {
    value = JSON.parse(raw) as Partial<CutoverRestartMarker>;
  } catch {
    throw new CutoverStateError(
      "Durable restart fence is malformed; reconciliation is required.",
    );
  }
  if (
    value.schema !== CUTOVER_RESTART_SCHEMA ||
    value.cutoverId !== expectedCutoverId ||
    !isRestartRequest(value.request)
  ) {
    throw new CutoverStateError(
      "Durable restart fence does not match the active cutover; reconciliation is required.",
    );
  }
  return value.request;
}

function readBindingRepairMarker(
  path: string,
  expectedCutoverId: string,
): CutoverBindingRepairReceipt | undefined {
  const raw = readOptionalFile(path);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isBindingRepairReceipt(parsed) && parsed.cutoverId === expectedCutoverId) {
      return parsed;
    }
  } catch {
    // Malformed marker will throw below.
  }
  throw new CutoverStateError(
    "Durable binding repair fence is malformed; reconciliation is required.",
  );
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

const SUCCESSOR_CREATED_FILE = "successor-created.json";

function latestEvent(events: string[], prefix: string): string | undefined {
  return events.filter((name) => name.startsWith(prefix)).at(-1);
}

function readOptionalFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function readRecoveryIntent(path: string): CutoverRecoveryIntent {
  const raw = readOptionalFile(path);
  if (raw === undefined) {
    throw new CutoverStateError(
      "Durable recovery intent is missing; reconciliation is required.",
    );
  }
  let value: Partial<CutoverRecoveryIntent>;
  try {
    value = JSON.parse(raw) as Partial<CutoverRecoveryIntent>;
  } catch {
    throw new CutoverStateError(
      "Durable recovery intent is malformed; reconciliation is required.",
    );
  }
  if (
    value.schema !== CUTOVER_RECOVERY_INTENT_SCHEMA ||
    value.version !== 1 ||
    typeof value.supersedesCutoverId !== "string" ||
    value.supersedesCutoverId.trim() === "" ||
    !isExpectedIdentity(value.expectedNewIdentity) ||
    typeof value.requestedByServerInstanceId !== "string" ||
    value.requestedByServerInstanceId.trim() === "" ||
    typeof value.requestedAt !== "string" ||
    !Number.isFinite(Date.parse(value.requestedAt))
  ) {
    throw new CutoverStateError(
      "Durable recovery intent is malformed; reconciliation is required.",
    );
  }
  return value as CutoverRecoveryIntent;
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Preserve the original create error.
  }
}

function writeExclusiveDurable(path: string, content: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } finally {
    if (fd !== undefined) closeQuietly(fd);
  }
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    // Windows requires write access for directory fsync; POSIX keeps the
    // read-only directory handle and preserves its existing error behavior.
    fd = openSync(path, process.platform === "win32" ? "r+" : "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeQuietly(fd);
  }
}
