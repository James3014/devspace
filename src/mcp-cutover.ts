import type {
  BuildReadyProbeResult,
} from "./cutover-build-ready.js";
import { CutoverBuildNotReadyError } from "./cutover-build-ready.js";
import type { SelfRestartActuator } from "./cutover-restart.js";
import type {
  BuildReadyReceipt,
  CutoverCoordinationBinding,
  CutoverBindingRepairReceipt,
  CutoverActivationBinding,
  CutoverDrainEvidence,
  CutoverReconciliationReceipt,
  CutoverServerIdentity,
  DurableCutoverRecord,
  ExpectedCutoverIdentity,
} from "./cutover-state.js";
import { CutoverStateError, CutoverStateStore, effectiveExpectedIdentity } from "./cutover-state.js";
import type { NextFunction, Request, Response } from "express";
import type { OrchestrationOutcome } from "./cutover-orchestration.js";
import { canonicalizePath, isPathInsideRoot } from "./roots.js";

/** Legacy entrypoints cannot mutate a generation owned by the coordination consumer. */
export function assertLegacyCutoverUnbound(record: DurableCutoverRecord | undefined): void {
  if(record?.coordinationBinding) throw new CutoverStateError("[COORDINATION_REQUIRED] This cutover requires an explicitly authorized coordination lifecycle action; legacy mutation is unavailable.");
}

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
  releaseMatches: boolean;
}

/**
 * Only known cutover lifecycle operations get their own coordination-path
 * admission. Ordinary inspection and unrelated work are never admitted by
 * a global safe-tool allowlist; effect classification below owns the fence.
 */
const CUTOVER_LIFECYCLE_TOOLS: ReadonlySet<string> = new Set([
  "cutover_status",
  "cutover_start",
  "cutover_drain",
  "cutover_restart_self",
  "cutover_reconcile",
  "cutover_finish",
  "cutover_recover",
  "cutover_repair_binding",
  "cutover_advance",
]);

export type CutoverEffectDomain =
  | "CUTOVER_CONTROL_OR_OBSERVATION"
  | "DEPLOYMENT_CONFLICT"
  | "INDEPENDENT";

export interface CutoverEffectTarget {
  /** Exact physical paths the requested effect may mutate. */
  mutationPaths?: readonly string[];
  /** Workspace-wide effect root when exact mutation paths cannot be known. */
  workspaceRoot?: string;
  /** True only when the tool may mutate arbitrary content within workspaceRoot. */
  broadWorkspaceMutation?: boolean;
  /** Exact deployment/state roots whose evidence must survive reconciliation. */
  protectedPaths?: readonly string[];
}

/**
 * Effects that can invalidate the exact deployment/release evidence needed to
 * reconcile an unresolved DevSpace activation. Everything else keeps its own
 * normal authority, lease, workspace, Git, agent, or host-operation checks.
 */
export const CUTOVER_DEPLOYMENT_CONFLICT_TOOLS: ReadonlySet<string> = new Set([
  // Retention may delete release/evidence artifacts while deployment truth is unresolved.
  "storage_gc",
  // These direct shell/process-control surfaces have host-wide effect scope. A
  // tool-name-only fence cannot prove they will stay away from launchd, the
  // canonical release pointer, or retained deployment evidence.
  "bash",
  "exec_command",
  "write_stdin",
]);

const DEPLOYMENT_CONFLICT_PREFIXES = [
  "activation_",
  "deployment_",
  "host_activation_",
  "release_",
  "service_restart_",
] as const;

export function classifyCutoverEffect(
  toolName: string,
  target: CutoverEffectTarget = {},
): CutoverEffectDomain {
  if (CUTOVER_LIFECYCLE_TOOLS.has(toolName)) return "CUTOVER_CONTROL_OR_OBSERVATION";
  if (CUTOVER_DEPLOYMENT_CONFLICT_TOOLS.has(toolName)) return "DEPLOYMENT_CONFLICT";
  // Unknown future cutover/deployment primitives fail closed by namespace. A
  // future unrelated tool does not inherit global deployment authority merely
  // because it mutates something elsewhere.
  if (toolName.startsWith("cutover_") || DEPLOYMENT_CONFLICT_PREFIXES.some((prefix) => toolName.startsWith(prefix))) {
    return "DEPLOYMENT_CONFLICT";
  }
  if (cutoverTargetOverlapsProtectedEvidence(target)) return "DEPLOYMENT_CONFLICT";
  return "INDEPENDENT";
}

function cutoverTargetOverlapsProtectedEvidence(target: CutoverEffectTarget): boolean {
  const protectedPaths = (target.protectedPaths ?? []).map((path) => canonicalizePath(path));
  if (protectedPaths.length === 0) return false;

  const overlaps = (path: string): boolean => {
    const candidate = canonicalizePath(path);
    return protectedPaths.some((protectedPath) =>
      isPathInsideRoot(candidate, protectedPath) ||
      isPathInsideRoot(protectedPath, candidate),
    );
  };

  if ((target.mutationPaths ?? []).some(overlaps)) return true;
  return target.broadWorkspaceMutation === true &&
    typeof target.workspaceRoot === "string" &&
    overlaps(target.workspaceRoot);
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
      "the requested deployment-conflicting effect is blocked until exact reconciliation closes it.",
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

  assertToolAllowed(toolName: string, target: CutoverEffectTarget = {}): void {
    const record = this.store.get();
    if (!record || record.phase === "closed") return;
    if (classifyCutoverEffect(toolName, target) !== "DEPLOYMENT_CONFLICT") return;
    const observedGeneration = record.oldServerIdentity.serverInstanceId === this.currentIdentity.serverInstanceId
      ? "drain"
      : "reconcile-only";
    throw new CutoverBlockedError(record.cutoverId, observedGeneration);
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
      cutover_phase: record?.phase ?? "closed",
      server_generation_relation: record ? compareServerIdentity(record, this.currentIdentity) : undefined,
      reconciliation_required: Boolean(record && record.phase !== "closed"),
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

  private finishableRecord(cutoverId: string): DurableCutoverRecord {
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
    if (!comparison.releaseMatches) {
      throw new CutoverStateError(
        "Cannot finish cutover: live release identity does not match the bound activation release.",
      );
    }

    if (record.phase !== "drained") {
      throw new CutoverStateError(
        `Cutover ${cutoverId} must have durable drain evidence before it can be finished.`,
      );
    }

    return record;
  }

  async finish(cutoverId: string, reconcile: () => Promise<DurableReconciliationWitness>): Promise<DurableCutoverRecord> {
    assertLegacyCutoverUnbound(this.store.get());
    const record=this.finishableRecord(cutoverId);
    if(record.phase==="closed") return record;
    const witness=await reconcile();
    assertLegacyCutoverUnbound(this.store.get());
    return this.finishWithWitness(cutoverId,witness);
  }

  finishWithWitness(cutoverId: string, witness: DurableReconciliationWitness): DurableCutoverRecord {
    const record=this.finishableRecord(cutoverId);
    if(record.phase==="closed") return record;
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

  finishExpiredPreparedRecoveryWithWitness(cutoverId: string, witness: DurableReconciliationWitness): DurableCutoverRecord {
    const record=this.store.get();
    if(!record) throw new CutoverStateError("No durable cutover record exists.");
    if(record.cutoverId!==cutoverId) throw new CutoverStateError(`Cutover id mismatch: active cutover is ${record.cutoverId}.`);
    if(record.phase==="closed") return record;
    if(record.phase!=="prepared" || record.drainEvidence || record.restartRequest) {
      throw new CutoverStateError("Expired prepared recovery requires an untouched prepared cutover with no drain or restart evidence.");
    }
    const comparison=compareServerIdentity(record,this.currentIdentity);
    if(!Object.values(comparison).every(Boolean)) {
      throw new CutoverStateError("Expired prepared recovery requires an exact replacement runtime identity with a changed serverInstanceId.");
    }
    if(!witness.workspaceQueryable || !witness.agentQueryable || !witness.agentReconciled) {
      throw new CutoverStateError("Expired prepared recovery requires a fully positive durable agent/workspace reconciliation witness.");
    }
    const receipt: CutoverReconciliationReceipt={
      closedByServerInstanceId:this.currentIdentity.serverInstanceId,
      ...witness,
      reconciledAt:new Date(this.now()).toISOString(),
    };
    return this.store.close(cutoverId,receipt);
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
    releaseMatches:
      record.activationBinding === undefined ||
      (
        current.releaseSha256 === record.activationBinding.releaseSha256 &&
        current.releasePath === record.activationBinding.releasePath &&
        current.activationCutoverId === record.cutoverId
      ),
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
  assertLegacyCutoverUnbound(store.get());
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
  ensureActivationBound?: (cutoverId: string) => CutoverActivationBinding;
  probeBuildReady?: (
    expected: ExpectedCutoverIdentity,
  ) => Promise<BuildReadyProbeResult> | BuildReadyProbeResult;
  advance?: () => Promise<OrchestrationOutcome>;
}

interface RouteRegistrar {
  get(path: string, ...handlers: Array<(req: Request, res: Response, next: NextFunction) => unknown>): unknown;
  post(path: string, ...handlers: Array<(req: Request, res: Response, next: NextFunction) => unknown>): unknown;
}

/** Read-only legacy HTTP observability; mutations use the governed MCP lifecycle. */
export function registerCutoverHttpRoutes(
  app: RouteRegistrar,
  dependencies: CutoverHttpDependencies,
): void {
  app.get("/api/cutover/status", dependencies.authenticate, (_req, res) => {
    res.json(dependencies.controller.status(dependencies.transportEvidence()));
  });
}
