import type {
  BuildReadyProbeResult,
} from "./cutover-build-ready.js";
import { CutoverBuildNotReadyError } from "./cutover-build-ready.js";
import type { SelfRestartActuator } from "./cutover-restart.js";
import type {
  BuildReadyReceipt,
  CutoverCoordinationBinding,
  CutoverBindingRepairReceipt,
  CutoverDrainEvidence,
  CutoverReconciliationReceipt,
  CutoverServerIdentity,
  DurableCutoverRecord,
  ExpectedCutoverIdentity,
} from "./cutover-state.js";
import { CutoverStateError, CutoverStateStore, effectiveExpectedIdentity } from "./cutover-state.js";
import type { NextFunction, Request, Response } from "express";
import type { OrchestrationOutcome } from "./cutover-orchestration.js";

export type CutoverMode = "normal" | "drain" | "reconcile-only";

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
  /** Optional generation binding carried only by observed-replacement recovery. */
  witnessCutoverId?: string;
  witnessServerInstanceId?: string;
  witnessExpectedIdentity?: ExpectedCutoverIdentity;
}

export interface CutoverIdentityComparison {
  serverInstanceChanged: boolean;
  sourceMatches: boolean;
  buildMatches: boolean;
  capabilityManifestMatches: boolean;
}

/**
 * Authoritative fail-closed allowlist for tools allowed to execute during
 * cutover drain or reconcile-only modes. Any tool not in this set is strictly
 * blocked with CUTOVER_RECONCILIATION_REQUIRED.
 */
export const CUTOVER_SAFE_TOOLS: ReadonlySet<string> = new Set([
  // Core cutover control & recovery
  "cutover_status",
  "cutover_start", // Guarded handler admits only authorized starts or exact replay.
  "cutover_drain",
  "cutover_restart_self",
  "cutover_reconcile",
  "cutover_finish",
  "cutover_recover",
  "cutover_repair_binding",

  // Agent inspection & reconciliation
  "agent_status",
  "agent_reconcile",
  "agent_list",
  "agent_preflight",

  // Workspace & file inspection (read-only)
  "workspace_inspect",
  "read",
  "grep",
  "glob",
  "ls",
  "show_changes",

  // Existing-task completion only; lifecycle admission still rejects new claims.
  "chat_swarm_next",
  "chat_swarm_submit",
  "chat_swarm_status",
  "chat_swarm_collect",
  "chat_swarm_reconcile",
  "chat_swarm_cancel",

  // Operation & command inspection
  "coordination_handoff_readback",
  "coordination_handoff", // Existing lease only; no new effect or grant.
  "operation_status",
  "operation_reconcile",
  "command_status",
  "codex_goal_status",

  // Safe read/preflight inspection
  "nexus_gateway_recovery_preflight",
  "candidate_integration_readiness",
  "remote_writability_probe",
]);

export function isCutoverSafeTool(toolName: string): boolean {
  return CUTOVER_SAFE_TOOLS.has(toolName);
}

export const CONSEQUENTIAL_MCP_TOOLS = new Set([
  "chat_swarm_create",
  "chat_swarm_join",
  "chat_swarm_dispatch",
  "chat_swarm_close",
  "open_workspace",
  "write",
  "edit",
  "apply_patch",
  "bash",
  "write_stdin",
  "exec_command",
  "workspace_clone",
  "dependency_sync",
  "workspace_verify",
  "nexus_gateway_recover",
  "codex_goal_start",
  "codex_goal_continue",
  "codex_goal_cancel",
  "agent_start",
  "agent_continue",
  "agent_cancel",
  "candidate_integrate",
  "git_promote_candidate",
  "git_commit",
  "git_push",
  "chat_swarm_create",
  "chat_swarm_join",
  "chat_swarm_dispatch",
]);


export class CutoverBlockedError extends Error {
  readonly code = "CUTOVER_RECONCILIATION_REQUIRED";

  constructor(readonly cutoverId: string, readonly mode: Exclude<CutoverMode, "normal">) {
    super(
      `[CUTOVER_RECONCILIATION_REQUIRED] Cutover ${cutoverId} is ${mode}; ` +
      "new consequential mutation is blocked until exact reconciliation closes it.",
    );
    this.name = "CutoverBlockedError";
  }
}

export class McpCutoverController {
  constructor(
    private readonly store: CutoverStateStore,
    readonly currentIdentity: CutoverServerIdentity,
    private readonly now: () => number = Date.now,
  ) {}

  begin(expectedNewIdentity: ExpectedCutoverIdentity, expiresAt?: string, coordinationBinding?: CutoverCoordinationBinding): DurableCutoverRecord {
    return this.store.begin({
      oldServerIdentity: this.currentIdentity,
      expectedNewIdentity,
      expiresAt,
      coordinationBinding,
    });
  }

  recordDrain(cutoverId: string, evidence: CutoverDrainEvidence): DurableCutoverRecord {
    const record = this.store.get();
    if (!record) throw new CutoverStateError("No durable cutover record exists.");
    if (record.cutoverId !== cutoverId) {
      throw new CutoverStateError(`Cutover id mismatch: active cutover is ${record.cutoverId}.`);
    }
    if (record.oldServerIdentity.serverInstanceId !== this.currentIdentity.serverInstanceId) {
      throw new CutoverStateError(
        "Only the old server instance that owns the cutover lease may record drain evidence.",
      );
    }
    return this.store.recordDrain(cutoverId, evidence);
  }

  requestRestart(cutoverId: string, buildReady?: BuildReadyReceipt): {
    record: DurableCutoverRecord;
    newlyRequested: boolean;
  } {
    const record = this.store.get();
    if (!record) throw new CutoverStateError("No durable cutover record exists.");
    if (record.cutoverId !== cutoverId) {
      throw new CutoverStateError(`Cutover id mismatch: active cutover is ${record.cutoverId}.`);
    }
    if (record.oldServerIdentity.serverInstanceId !== this.currentIdentity.serverInstanceId) {
      throw new CutoverStateError(
        "Only the old server instance that owns the drain lease may request its restart.",
      );
    }
    return this.store.recordRestartRequest(cutoverId, {
      actuator: "launchd-self",
      requestedByServerInstanceId: this.currentIdentity.serverInstanceId,
      ...(buildReady ? { buildReady } : {}),
    });
  }

  markRestartScheduled(cutoverId: string): {
    record: DurableCutoverRecord;
    newlyScheduled: boolean;
  } {
    const record = this.store.get();
    if (!record) throw new CutoverStateError("No durable cutover record exists.");
    if (record.cutoverId !== cutoverId) {
      throw new CutoverStateError(`Cutover id mismatch: active cutover is ${record.cutoverId}.`);
    }
    if (record.oldServerIdentity.serverInstanceId !== this.currentIdentity.serverInstanceId) {
      throw new CutoverStateError(
        "Only the old server instance that owns the drain lease may schedule its restart.",
      );
    }
    return this.store.recordRestartScheduled(cutoverId, this.currentIdentity.serverInstanceId);
  }

  recordBindingRepair(
    cutoverId: string,
    repair: CutoverBindingRepairReceipt,
  ): DurableCutoverRecord {
    const record = this.store.get();
    if (!record) throw new CutoverStateError("No durable cutover record exists.");
    if (record.cutoverId !== cutoverId) {
      throw new CutoverStateError(`Cutover id mismatch: active cutover is ${record.cutoverId}.`);
    }
    return this.store.recordBindingRepair(cutoverId, repair).record;
  }

  record(): DurableCutoverRecord | undefined {
    return this.store.get();
  }

  mode(): CutoverMode {
    const record = this.store.get();
    if (!record || record.phase === "closed") return "normal";
    return record.oldServerIdentity.serverInstanceId === this.currentIdentity.serverInstanceId
      ? "drain"
      : "reconcile-only";
  }

  canInitializeTransport(): boolean {
    return true;
  }

  assertToolAllowed(toolName: string): void {
    const mode = this.mode();
    if (mode === "normal") return;
    if (CUTOVER_SAFE_TOOLS.has(toolName)) return;
    throw new CutoverBlockedError(this.store.get()!.cutoverId, mode);
  }

  status(transportEvidence: CutoverDrainEvidence): Record<string, unknown> {
    const record = this.store.get();
    const superseded = this.store.supersededRecord();
    const repairObservability = record?.bindingRepair
      ? {
          originalExpectedIdentity: record.expectedNewIdentity,
          effectiveExpectedIdentity: effectiveExpectedIdentity(record),
          bindingRepair: record.bindingRepair,
        }
      : {};
    return {
      cutover: record,
      supersededCutover:
        superseded && (!record || record.supersedesCutoverId === undefined)
          ? superseded
          : undefined,
      currentServerIdentity: this.currentIdentity,
      comparison: record ? compareServerIdentity(record, this.currentIdentity) : undefined,
      ...repairObservability,
      transportEvidence,
      mode: this.mode(),
      reconciliationRequired: Boolean(record && record.phase !== "closed"),
    };
  }

  /**
   * Terminally supersede one stale unresolved cutover whose expected target
   * became obsolete and whose original drain-lease owner is gone. Bounded and
   * idempotent; a different expected target on retry fails closed.
   */
  recoverCutover(input: {
    cutoverId: string;
    expectedNewIdentity: ExpectedCutoverIdentity;
    expiresAt?: string;
    witness?: DurableReconciliationWitness;
  }): {
    terminal: DurableCutoverRecord;
    successor?: DurableCutoverRecord;
    newlyRecovered: boolean;
  } {
    return recoverCutoverWithStore(this.store, this.currentIdentity, input);
  }

  async finish(
    cutoverId: string,
    reconcile: () => Promise<DurableReconciliationWitness>,
  ): Promise<DurableCutoverRecord> {
    const record = this.store.get();
    if (!record) throw new CutoverStateError("No durable cutover record exists.");
    if (record.cutoverId !== cutoverId) {
      throw new CutoverStateError(`Cutover id mismatch: active cutover is ${record.cutoverId}.`);
    }
    if (record.phase === "closed") return record;

    const comparison = compareServerIdentity(record, this.currentIdentity);
    if (!comparison.serverInstanceChanged) {
      throw new CutoverStateError("Cannot finish cutover: serverInstanceId did not change from the old server.");
    }
    if (!comparison.sourceMatches) {
      throw new CutoverStateError("Cannot finish cutover: current sourceCommit does not match the expected target.");
    }
    if (!comparison.buildMatches) {
      throw new CutoverStateError("Cannot finish cutover: current buildId does not match the expected target.");
    }
    if (!comparison.capabilityManifestMatches) {
      throw new CutoverStateError("Cannot finish cutover: capability manifest does not match the bound target.");
    }

    if (record.phase !== "drained") {
      throw new CutoverStateError(
        `Cutover ${cutoverId} must have durable drain evidence before it can be finished.`,
      );
    }


    const witness = await reconcile();
    if (!witness.workspaceQueryable || !witness.agentQueryable || !witness.agentReconciled) {
      throw new CutoverStateError(
        "Cannot finish cutover: durable agent/workspace reconciliation witness is not fully positive.",
      );
    }
    const receipt: CutoverReconciliationReceipt = {
      closedByServerInstanceId: this.currentIdentity.serverInstanceId,
      ...witness,
      reconciledAt: new Date(this.now()).toISOString(),
    };
    return this.store.close(cutoverId, receipt);
  }
}


export function compareServerIdentity(
  record: DurableCutoverRecord,
  current: CutoverServerIdentity,
): CutoverIdentityComparison {
  const expected = effectiveExpectedIdentity(record);
  return {
    serverInstanceChanged:
      current.serverInstanceId !== record.oldServerIdentity.serverInstanceId,
    sourceMatches: current.sourceCommit === expected.sourceCommit,
    buildMatches: current.buildId === expected.buildId,
    capabilityManifestMatches:
      expected.capabilityManifestSha256 === undefined ||
      current.capabilityManifestSha256 === expected.capabilityManifestSha256,
  };
}

export type CutoverRecoveryEligibility =
  | { eligible: true; mode: "stale_target" | "observed_replacement" }
  | { eligible: false; reason: string };

/**
 * Shared terminal-recovery entry used by both the in-process controller and
 * the out-of-process recovery seam so eligibility and idempotent rendezvous
 * never diverge between the two control surfaces.
 */
export function recoverCutoverWithStore(
  store: CutoverStateStore,
  currentIdentity: CutoverServerIdentity,
  input: {
    cutoverId: string;
    expectedNewIdentity: ExpectedCutoverIdentity;
    expiresAt?: string;
    witness?: DurableReconciliationWitness;
  },
): {
  terminal: DurableCutoverRecord;
  successor?: DurableCutoverRecord;
  newlyRecovered: boolean;
} {
  const record = store.get();
  if (!record) throw new CutoverStateError("No durable cutover record exists.");
  if (
    record.cutoverId !== input.cutoverId &&
    record.supersedesCutoverId !== input.cutoverId
  ) {
    throw new CutoverStateError(`Cutover id mismatch: active cutover is ${record.cutoverId}.`);
  }
  if (record.supersedesCutoverId === input.cutoverId && record.cutoverId !== input.cutoverId) {
    return store.recoverSupersede({
      cutoverId: input.cutoverId,
      expectedNewIdentity: input.expectedNewIdentity,
      observedIdentity: currentIdentity,
      recoveredBy: currentIdentity.serverInstanceId,
      expiresAt: input.expiresAt,
    });
  }
  if (record.phase === "superseded" && record.cutoverId === input.cutoverId) {
    return store.recoverSupersede({
      cutoverId: input.cutoverId,
      expectedNewIdentity: input.expectedNewIdentity,
      observedIdentity: currentIdentity,
      recoveredBy: currentIdentity.serverInstanceId,
      expiresAt: input.expiresAt,
    });
  }
  if (record.phase === "closed" && record.cutoverId === input.cutoverId) {
    if (record.observedReplacement?.cutoverId === input.cutoverId) {
      const receipt = record.observedReplacement;
      const res = store.recoverObservedReplacement({
        cutoverId: input.cutoverId,
        expectedNewIdentity: input.expectedNewIdentity,
        observedIdentity: currentIdentity,
        witness: input.witness ?? {
          ...receipt.reconciliationReceipt,
          witnessWorkspaceId: receipt.witnessWorkspaceId,
          witnessAgentId: receipt.witnessAgentId,
          witnessWorkspaceSessions: receipt.witnessWorkspaceSessions,
          witnessAgentSessions: receipt.witnessAgentSessions,
          witnessKind: receipt.witnessKind,
        },
        recoveredBy: currentIdentity.serverInstanceId,
      });
      return { terminal: res.record, newlyRecovered: res.newlyRecovered };
    }
  }
  const eligibility = assessRecoveryEligibility(record, currentIdentity, input.expectedNewIdentity);
  if (!eligibility.eligible) {
    throw new CutoverStateError(`Cutover ${input.cutoverId} is not recoverable: ${eligibility.reason}`);
  }
  if (eligibility.mode === "observed_replacement") {
    if (
      !input.expectedNewIdentity.capabilityManifestSha256 &&
      currentIdentity.capabilityManifestSha256
    ) {
      throw new CutoverStateError(
        "Cannot recover cutover: observed replacement requires an explicitly bound capability manifest.",
      );
    }
    if (!input.witness) {
      throw new CutoverStateError(
        "Cannot recover cutover: durable agent/workspace reconciliation witness is not fully positive.",
      );
    }
    const result = store.recoverObservedReplacement({
      cutoverId: input.cutoverId,
      expectedNewIdentity: input.expectedNewIdentity,
      observedIdentity: currentIdentity,
      witness: input.witness,
      recoveredBy: currentIdentity.serverInstanceId,
    });
    return {
      terminal: result.record,
      successor: undefined,
      newlyRecovered: result.newlyRecovered,
    };
  }
  return store.recoverSupersede({
    cutoverId: input.cutoverId,
    expectedNewIdentity: input.expectedNewIdentity,
    observedIdentity: currentIdentity,
    recoveredBy: currentIdentity.serverInstanceId,
    expiresAt: input.expiresAt,
  });
}

/**
 * A stale cutover is recoverable only when it is unresolved at a terminal-
 * recovery phase, the original drain-lease owner is gone, the current runtime
 * is not already the abandoned expected target, and recovery has not already
 * produced a successor. Never grants retry, deletion, or takeover.
 */
export function assessRecoveryEligibility(
  record: DurableCutoverRecord,
  current: CutoverServerIdentity,
  expectedNewIdentity?: ExpectedCutoverIdentity,
): CutoverRecoveryEligibility {
  if (record.phase === "closed") {
    return { eligible: false, reason: "the cutover is already closed; normal archive applies." };
  }
  if (record.phase === "superseded") {
    return { eligible: false, reason: "the cutover was already terminally superseded." };
  }
  if (record.phase === "prepared" || record.phase === "drained") {
    // intentionally the only recoverable phases
  } else {
    return { eligible: false, reason: `unknown phase ${record.phase}.` };
  }
  if (record.oldServerIdentity.serverInstanceId === current.serverInstanceId) {
    return {
      eligible: false,
      reason: "the original drain-lease owner is still running; use the normal drain/restart/finish path instead.",
    };
  }
  const comparison = compareServerIdentity(record, current);
  if (
    comparison.serverInstanceChanged &&
    comparison.sourceMatches &&
    comparison.buildMatches &&
    (record.expectedNewIdentity.capabilityManifestSha256 === undefined ||
      comparison.capabilityManifestMatches)
  ) {
    const isTargetingSameIdentity =
      expectedNewIdentity === undefined ||
      (expectedNewIdentity.sourceCommit === record.expectedNewIdentity.sourceCommit &&
        expectedNewIdentity.buildId === record.expectedNewIdentity.buildId &&
        (record.expectedNewIdentity.capabilityManifestSha256 === undefined ||
          expectedNewIdentity.capabilityManifestSha256 === record.expectedNewIdentity.capabilityManifestSha256));

    if (record.phase === "prepared" && !record.drainEvidence && isTargetingSameIdentity) {
      return { eligible: true, mode: "observed_replacement" };
    }
    return {
      eligible: false,
      reason: "the current runtime already matches the bound expected target; finish the cutover normally.",
    };
  }
  if (record.supersedesCutoverId !== undefined) {
    return { eligible: false, reason: "the active cutover is its own successor, not a stale predecessor." };
  }
  return { eligible: true, mode: "stale_target" };
}



export interface CutoverHttpDependencies {
  controller: McpCutoverController;
  authenticate: (req: Request, res: Response, next: NextFunction) => void;
  transportEvidence: () => CutoverDrainEvidence;
  reconcileDurableState: (input: {
    workspaceId: string;
    agentId: string;
  }) => Promise<DurableReconciliationWitness>;
  restartSelf?: SelfRestartActuator;
  probeBuildReady?: (
    expected: ExpectedCutoverIdentity,
  ) => Promise<BuildReadyProbeResult> | BuildReadyProbeResult;
  advance?: () => Promise<OrchestrationOutcome>;
}

interface RouteRegistrar {
  get(path: string, ...handlers: Array<(req: Request, res: Response, next: NextFunction) => unknown>): unknown;
  post(path: string, ...handlers: Array<(req: Request, res: Response, next: NextFunction) => unknown>): unknown;
}

/** Authenticated controller recovery API. Responses contain aggregate metrics only. */
export function registerCutoverHttpRoutes(
  app: RouteRegistrar,
  dependencies: CutoverHttpDependencies,
): void {
  const {
    controller,
    authenticate,
    transportEvidence,
    reconcileDurableState,
    restartSelf,
    probeBuildReady,
    advance,
  } = dependencies;

  app.get("/api/cutover/status", authenticate, (_req, res) => {
    res.json(controller.status(transportEvidence()));
  });

  app.post("/api/cutover/start", authenticate, (req, res) => {
    try {
      const body = objectBody(req.body);
      const sourceCommit = requiredString(body.expectedSourceCommit, "expectedSourceCommit");
      const buildId = requiredString(body.expectedBuildId, "expectedBuildId");
      const capabilityManifestSha256 = optionalString(body.expectedCapabilityManifestSha256)
        ?? controller.currentIdentity.capabilityManifestSha256;
      const record = controller.begin(
        { sourceCommit, buildId, ...(capabilityManifestSha256 ? { capabilityManifestSha256 } : {}) },
        optionalString(body.expiresAt),
      );
      res.status(201).json({ cutover: record, mode: controller.mode() });
    } catch (error) {
      sendCutoverError(res, error);
    }
  });

  app.post("/api/cutover/drain", authenticate, (req, res) => {
    try {
      const cutoverId = requiredString(objectBody(req.body).cutoverId, "cutoverId");
      const record = controller.recordDrain(cutoverId, transportEvidence());
      res.json({ cutover: record, mode: controller.mode() });
    } catch (error) {
      sendCutoverError(res, error);
    }
  });

  app.post("/api/cutover/restart", authenticate, async (req, res) => {
    try {
      const body = objectBody(req.body);
      const cutoverId = requiredString(body.cutoverId, "cutoverId");
      if (body.buildReady === undefined) {
        throw new CutoverBuildNotReadyError(`Restart request ${cutoverId} lacks a build-ready attestation.`);
      }
      const buildReady = buildReadyReceipt(body.buildReady);
      const request = controller.requestRestart(cutoverId, buildReady);
      const restart = request.record.restartRequest;
      if (!restart?.buildReady) {
        throw new CutoverBuildNotReadyError(
          `Restart request ${cutoverId} lacks a build-ready attestation.`,
        );
      }
      if (restart.restartScheduledAt) {
        res.status(200).json({
          cutover: request.record,
          mode: controller.mode(),
          restart: { scheduled: false, alreadyRequested: true, scheduleBlocked: false },
        });
        return;
      }
      if (probeBuildReady) {
        const probe = await probeBuildReady(request.record.expectedNewIdentity);
        if (!probe.buildReady) {
          throw new CutoverBuildNotReadyError(probe.detail);
        }
      }
      if (!restartSelf) {
        throw new CutoverStateError("Restart scheduling is unavailable in this environment.");
      }
      const mark = controller.markRestartScheduled(cutoverId);
      const scheduled = mark.newlyScheduled ? restartSelf.schedule() : undefined;
      if (!scheduled) {
        res.status(200).json({
          cutover: mark.record,
          mode: controller.mode(),
          restart: { scheduled: false, alreadyRequested: true, scheduleBlocked: false },
        });
        return;
      }
      res.status(200).json({
        cutover: mark.record,
        mode: controller.mode(),
        restart: {
          scheduled: true,
          alreadyRequested: false,
          actuator: "launchd-self",
          serviceLabel: restartSelf.serviceLabel,
          launchdTarget: restartSelf.launchdTarget,
        },
      });
    } catch (error) {
      sendCutoverError(res, error);
    }
  });

  app.post("/api/cutover/advance", authenticate, async (_req, res) => {
    if (!advance) {
      sendCutoverError(
        res,
        new CutoverStateError("Cutover orchestration is unavailable in this environment."),
      );
      return;
    }
    try {
      const outcome = await advance();
      if (outcome.outcome === "blocked") {
        res.status(409).json({
          error: { code: outcome.code, message: outcome.reason },
          outcome,
        });
        return;
      }
      res.status(200).json({ outcome });
    } catch (error) {
      sendCutoverError(res, error);
    }
  });

  app.post("/api/cutover/recover", authenticate, (req, res) => {
    try {
      const body = objectBody(req.body);
      const cutoverId = requiredString(body.cutoverId, "cutoverId");
      const sourceCommit = requiredString(body.expectedSourceCommit, "expectedSourceCommit");
      const buildId = requiredString(body.expectedBuildId, "expectedBuildId");
      const capabilityManifestSha256 = optionalString(body.expectedCapabilityManifestSha256);
      const recovered = controller.recoverCutover({
        cutoverId,
        expectedNewIdentity: {
          sourceCommit,
          buildId,
          ...(capabilityManifestSha256 ? { capabilityManifestSha256 } : {}),
        },
        ...(optionalString(body.expiresAt) ? { expiresAt: body.expiresAt as string } : {}),
      });
      res.json({
        terminal: recovered.terminal,
        successor: recovered.successor,
        newlyRecovered: recovered.newlyRecovered,
        mode: controller.mode(),
      });
    } catch (error) {
      sendCutoverError(res, error);
    }
  });

  app.post("/api/cutover/finish", authenticate, async (req, res) => {
    try {
      const body = objectBody(req.body);
      const cutoverId = requiredString(body.cutoverId, "cutoverId");
      const workspaceId = requiredString(body.workspaceId, "workspaceId");
      const agentId = requiredString(body.agentId, "agentId");
      const record = await controller.finish(
        cutoverId,
        () => reconcileDurableState({ workspaceId, agentId }),
      );
      res.json({ cutover: record, mode: controller.mode() });
    } catch (error) {
      sendCutoverError(res, error);
    }
  });
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CutoverStateError("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CutoverStateError(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function buildReadyReceipt(value: unknown): BuildReadyReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CutoverStateError("buildReady must be a build-ready attestation object.");
  }
  const receipt = value as Partial<BuildReadyReceipt>;
  if (
    typeof receipt.verifiedBy !== "string" ||
    receipt.verifiedBy.trim() === "" ||
    typeof receipt.verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.verifiedAt)) ||
    (receipt.evidence !== undefined && typeof receipt.evidence !== "string")
  ) {
    throw new CutoverStateError("buildReady must contain a non-empty verifiedBy and an ISO verifiedAt.");
  }
  return {
    verifiedBy: receipt.verifiedBy,
    verifiedAt: receipt.verifiedAt,
    ...(receipt.evidence !== undefined ? { evidence: receipt.evidence } : {}),
  };
}

function sendCutoverError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CutoverBuildNotReadyError) {
    res.status(409).json({
      error: { code: "CUTOVER_BUILD_NOT_READY", message },
    });
    return;
  }
  res.status(error instanceof CutoverStateError ? 409 : 500).json({
    error: {
      code: error instanceof CutoverStateError ? "CUTOVER_RECONCILIATION_REQUIRED" : "CUTOVER_INTERNAL_ERROR",
      message,
    },
  });
}
