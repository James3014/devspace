import type {
  BuildReadyProbeResult,
} from "./cutover-build-ready.js";
import { CutoverBuildNotReadyError } from "./cutover-build-ready.js";
import type { SelfRestartActuator } from "./cutover-restart.js";
import type {
  BuildReadyReceipt,
  CutoverDrainEvidence,
  CutoverReconciliationReceipt,
  CutoverServerIdentity,
  DurableCutoverRecord,
  ExpectedCutoverIdentity,
} from "./cutover-state.js";
import { CutoverStateError, CutoverStateStore } from "./cutover-state.js";
import type { NextFunction, Request, Response } from "express";
import type { OrchestrationOutcome } from "./cutover-orchestration.js";

export type CutoverMode = "normal" | "drain" | "reconcile-only";

export interface DurableReconciliationWitness {
  workspaceQueryable: boolean;
  agentQueryable: boolean;
  agentReconciled: boolean;
}

export interface CutoverIdentityComparison {
  serverInstanceChanged: boolean;
  sourceMatches: boolean;
  buildMatches: boolean;
  capabilityManifestMatches: boolean;
}

export const CONSEQUENTIAL_MCP_TOOLS = new Set([
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

  begin(expectedNewIdentity: ExpectedCutoverIdentity, expiresAt?: string): DurableCutoverRecord {
    return this.store.begin({
      oldServerIdentity: this.currentIdentity,
      expectedNewIdentity,
      expiresAt,
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
    return this.mode() !== "drain";
  }

  assertToolAllowed(toolName: string): void {
    const mode = this.mode();
    if (mode === "normal" || !CONSEQUENTIAL_MCP_TOOLS.has(toolName)) return;
    throw new CutoverBlockedError(this.store.get()!.cutoverId, mode);
  }

  status(transportEvidence: CutoverDrainEvidence): Record<string, unknown> {
    const record = this.store.get();
    return {
      cutover: record,
      currentServerIdentity: this.currentIdentity,
      comparison: record ? compareServerIdentity(record, this.currentIdentity) : undefined,
      transportEvidence,
      mode: this.mode(),
      reconciliationRequired: Boolean(record && record.phase !== "closed"),
    };
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
    if (record.phase !== "drained") {
      throw new CutoverStateError(
        `Cutover ${cutoverId} must have durable drain evidence before it can be finished.`,
      );
    }

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
  return {
    serverInstanceChanged:
      current.serverInstanceId !== record.oldServerIdentity.serverInstanceId,
    sourceMatches: current.sourceCommit === record.expectedNewIdentity.sourceCommit,
    buildMatches: current.buildId === record.expectedNewIdentity.buildId,
    capabilityManifestMatches:
      record.expectedNewIdentity.capabilityManifestSha256 === undefined ||
      current.capabilityManifestSha256 === record.expectedNewIdentity.capabilityManifestSha256,
  };
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
