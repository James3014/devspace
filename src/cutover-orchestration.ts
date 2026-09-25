import { isDeepStrictEqual } from "node:util";
import type { BuildReadyProbeResult } from "./cutover-build-ready.js";
import type { SelfRestartActuator } from "./cutover-restart.js";
import type { ExpectedCutoverIdentity } from "./cutover-state.js";
import {
  assertLegacyCutoverUnbound,
  compareServerIdentity,
  type CutoverIdentityComparison,
  type DurableReconciliationWitness,
  type McpCutoverController,
} from "./mcp-cutover.js";

export type CutoverBlocker =
  | "AWAITING_EXTERNAL_DRAIN"
  | "AWAITING_RESTART_DECISION"
  | "AWAITING_RECONNECT"
  | "RECONCILIATION_REQUIRED"
  | "BUILD_NOT_READY";

export type OrchestrationProgressionStatus = "TERMINAL" | "BLOCKED" | "ADVANCED";

export type OrchestrationOutcome = {
  outcome:
    | "noop"
    | "awaiting_drain"
    | "awaiting_decision"
    | "restart_scheduled"
    | "restart_already_scheduled"
    | "reconciled_and_finished"
    | "blocked";
  code?:
    | "CUTOVER_BUILD_NOT_READY"
    | "CUTOVER_RECONCILIATION_REQUIRED"
    | "CUTOVER_ACTUATOR_UNAVAILABLE";
  reason: string;
  status?: OrchestrationProgressionStatus;
  blocker?: CutoverBlocker;
  cutover_phase?: string;
  server_generation_relation?: CutoverIdentityComparison;
  caller_continuity?: Record<string, unknown>;
  client_projection_relation?: Record<string, unknown>;
  reconciliation_required?: boolean;
  scheduledFor?: string;
  dryRun?: boolean;
  probe?: BuildReadyProbeResult;
};

export interface AdvanceOptions {
  dryRun?: boolean;
  callerContinuity?: Record<string, unknown>;
  clientProjectionRelation?: Record<string, unknown>;
}

export interface CutoverOrchestratorDependencies {
  controller: McpCutoverController;
  actuator: SelfRestartActuator;
  enumerateAll: () => Promise<DurableReconciliationWitness>;
  probeBuildReady?: (
    expected: ExpectedCutoverIdentity,
  ) => Promise<BuildReadyProbeResult> | BuildReadyProbeResult;
}

export class CutoverOrchestrator {
  private readonly controller: McpCutoverController;
  private readonly actuator: SelfRestartActuator;
  private readonly enumerateAll: () => Promise<DurableReconciliationWitness>;
  private readonly probeBuildReady?:
    | ((expected: ExpectedCutoverIdentity) => Promise<BuildReadyProbeResult> | BuildReadyProbeResult)
    | undefined;

  constructor(dependencies: CutoverOrchestratorDependencies) {
    this.controller = dependencies.controller;
    this.actuator = dependencies.actuator;
    this.enumerateAll = dependencies.enumerateAll;
    this.probeBuildReady = dependencies.probeBuildReady;
  }

  /** Drive one exact step with fail-closed semantics. Never drains automatically. */
  async advance(options?: AdvanceOptions): Promise<OrchestrationOutcome> {
    const dryRun = Boolean(options?.dryRun);
    const record = this.controller.record();
    if (!record || record.phase === "closed") {
      return {
        outcome: "noop",
        status: "TERMINAL",
        cutover_phase: record?.phase ?? "closed",
        reconciliation_required: false,
        reason: "No unresolved cutover requires advancement.",
        caller_continuity: options?.callerContinuity,
        client_projection_relation: options?.clientProjectionRelation,
      };
    }
    assertLegacyCutoverUnbound(record);
    const mode = this.controller.mode();
    const comparison = compareServerIdentity(record, this.controller.currentIdentity);

    if (mode === "reconcile-only") {
      return this.advanceReconcileOnly(record, comparison, options);
    }

    if (record.phase === "prepared") {
      return {
        outcome: "awaiting_drain",
        status: "BLOCKED",
        blocker: "AWAITING_EXTERNAL_DRAIN",
        cutover_phase: "prepared",
        reconciliation_required: true,
        server_generation_relation: comparison,
        caller_continuity: options?.callerContinuity,
        client_projection_relation: options?.clientProjectionRelation,
        reason: `Cutover ${record.cutoverId} is prepared and waiting for the old instance to drain; never auto-drains.`,
      };
    }

    if (record.phase !== "drained") {
      return {
        outcome: "blocked",
        code: "CUTOVER_RECONCILIATION_REQUIRED",
        status: "BLOCKED",
        blocker: "RECONCILIATION_REQUIRED",
        cutover_phase: record.phase,
        reconciliation_required: true,
        server_generation_relation: comparison,
        caller_continuity: options?.callerContinuity,
        client_projection_relation: options?.clientProjectionRelation,
        reason: `Cutover ${record.cutoverId} is in unexpected phase ${record.phase}; operator intervention is required.`,
      };
    }

    const restart = record.restartRequest;
    if (!restart) {
      return {
        outcome: "awaiting_decision",
        status: "BLOCKED",
        blocker: "AWAITING_RESTART_DECISION",
        cutover_phase: "drained",
        reconciliation_required: true,
        server_generation_relation: comparison,
        caller_continuity: options?.callerContinuity,
        client_projection_relation: options?.clientProjectionRelation,
        reason: `Cutover ${record.cutoverId} is drained; a restart decision is required before it can advance.`,
      };
    }
    if (restart.restartScheduledAt) {
      return {
        outcome: "restart_already_scheduled",
        status: "BLOCKED",
        blocker: "AWAITING_RECONNECT",
        cutover_phase: "drained",
        reconciliation_required: true,
        server_generation_relation: comparison,
        caller_continuity: options?.callerContinuity,
        client_projection_relation: options?.clientProjectionRelation,
        reason: `Cutover ${record.cutoverId} restart was already durably scheduled; client must reconnect to successor instance.`,
        scheduledFor: restart.restartScheduledForServerInstanceId ?? "unknown",
      };
    }
    if (!restart.buildReady) {
      return {
        outcome: "blocked",
        code: "CUTOVER_BUILD_NOT_READY",
        status: "BLOCKED",
        blocker: "BUILD_NOT_READY",
        cutover_phase: "drained",
        reconciliation_required: true,
        server_generation_relation: comparison,
        caller_continuity: options?.callerContinuity,
        client_projection_relation: options?.clientProjectionRelation,
        reason: `Cutover ${record.cutoverId} restart lacks build-ready attestation; refusing to schedule until the target build is verified.`,
      };
    }
    if (this.probeBuildReady) {
      const probe = await this.probeBuildReady(record.expectedNewIdentity);
      if (!probe.buildReady) {
        return {
          outcome: "blocked",
          code: "CUTOVER_BUILD_NOT_READY",
          status: "BLOCKED",
          blocker: "BUILD_NOT_READY",
          cutover_phase: "drained",
          reconciliation_required: true,
          server_generation_relation: comparison,
          caller_continuity: options?.callerContinuity,
          client_projection_relation: options?.clientProjectionRelation,
          reason: `Cutover ${record.cutoverId} target build is not ready on disk; refusing to schedule the restart.`,
          probe,
        };
      }
    }

    const current = this.controller.record();
    assertLegacyCutoverUnbound(current);
    if (!isDeepStrictEqual(current, record)) {
      return {
        outcome: "blocked",
        code: "CUTOVER_RECONCILIATION_REQUIRED",
        status: "BLOCKED",
        blocker: "RECONCILIATION_REQUIRED",
        cutover_phase: "drained",
        reconciliation_required: true,
        server_generation_relation: comparison,
        caller_continuity: options?.callerContinuity,
        client_projection_relation: options?.clientProjectionRelation,
        reason: "Cutover generation changed during the build probe; reconcile before advancement.",
      };
    }

    if (dryRun) {
      return {
        outcome: "restart_scheduled",
        status: "ADVANCED",
        blocker: "AWAITING_RECONNECT",
        cutover_phase: "drained",
        reconciliation_required: true,
        server_generation_relation: comparison,
        caller_continuity: options?.callerContinuity,
        client_projection_relation: options?.clientProjectionRelation,
        reason: `Cutover ${record.cutoverId} restart would be durably marked and scheduled via ${this.actuator.serviceLabel} (startup rehearsal; not enacted).`,
        scheduledFor: this.actuator.serviceLabel,
        dryRun: true,
      };
    }
    const mark = this.controller.markRestartScheduled(record.cutoverId);
    if (!mark.newlyScheduled) {
      return {
        outcome: "restart_already_scheduled",
        status: "BLOCKED",
        blocker: "AWAITING_RECONNECT",
        cutover_phase: "drained",
        reconciliation_required: true,
        server_generation_relation: comparison,
        caller_continuity: options?.callerContinuity,
        client_projection_relation: options?.clientProjectionRelation,
        reason: `Cutover ${record.cutoverId} restart was durably scheduled by a concurrent actor; client must reconnect to successor instance.`,
        scheduledFor: mark.record.restartRequest?.restartScheduledForServerInstanceId ?? "unknown",
      };
    }
    try {
      this.actuator.schedule();
    } catch (error) {
      return {
        outcome: "blocked",
        code: "CUTOVER_ACTUATOR_UNAVAILABLE",
        status: "BLOCKED",
        blocker: "RECONCILIATION_REQUIRED",
        cutover_phase: "drained",
        reconciliation_required: true,
        server_generation_relation: comparison,
        caller_continuity: options?.callerContinuity,
        client_projection_relation: options?.clientProjectionRelation,
        reason:
          `Restart marker restart-scheduled.json for cutover ${record.cutoverId} is durable, ` +
          `but the launchd actuator failed to schedule; the restart will never be re-scheduled. ` +
          (error instanceof Error ? error.message : String(error)),
      };
    }
    return {
      outcome: "restart_scheduled",
      status: "ADVANCED",
      blocker: "AWAITING_RECONNECT",
      cutover_phase: "drained",
      reconciliation_required: true,
      server_generation_relation: comparison,
      caller_continuity: options?.callerContinuity,
      client_projection_relation: options?.clientProjectionRelation,
      reason: `Cutover ${record.cutoverId} restart is durably marked and scheduled via ${this.actuator.serviceLabel}; client must reconnect to successor instance.`,
      scheduledFor: this.actuator.serviceLabel,
    };
  }

  private async advanceReconcileOnly(
    record: NonNullable<ReturnType<McpCutoverController["record"]>>,
    comparison: CutoverIdentityComparison,
    options?: AdvanceOptions,
  ): Promise<OrchestrationOutcome> {
    const dryRun = Boolean(options?.dryRun);
    if (record.phase === "superseded") {
      return {
        outcome: "blocked",
        code: "CUTOVER_RECONCILIATION_REQUIRED",
        status: "BLOCKED",
        blocker: "RECONCILIATION_REQUIRED",
        cutover_phase: "superseded",
        reconciliation_required: true,
        server_generation_relation: comparison,
        caller_continuity: options?.callerContinuity,
        client_projection_relation: options?.clientProjectionRelation,
        reason:
          `Cutover ${record.cutoverId} was terminally superseded while its recovery successor is pending establishment; ` +
          "the durable recovery seam must be resumed to establish the successor. This orchestrator never auto-establishes or retries a supersession.",
      };
    }
    if (record.phase !== "drained") {
      return {
        outcome: "blocked",
        code: "CUTOVER_RECONCILIATION_REQUIRED",
        status: "BLOCKED",
        blocker: "RECONCILIATION_REQUIRED",
        cutover_phase: record.phase,
        reconciliation_required: true,
        server_generation_relation: comparison,
        caller_continuity: options?.callerContinuity,
        client_projection_relation: options?.clientProjectionRelation,
        reason:
          `Cutover ${record.cutoverId} has no durable drain evidence and the original drain-lease holder is gone; ` +
          "operator intervention is required before reconciliation can proceed.",
      };
    }
    if (record.restartRequest && !record.restartRequest.restartScheduledAt) {
      return {
        outcome: "blocked",
        code: "CUTOVER_RECONCILIATION_REQUIRED",
        status: "BLOCKED",
        blocker: "RECONCILIATION_REQUIRED",
        cutover_phase: "drained",
        reconciliation_required: true,
        server_generation_relation: comparison,
        caller_continuity: options?.callerContinuity,
        client_projection_relation: options?.clientProjectionRelation,
        reason:
          `Cutover ${record.cutoverId} restart was requested but no durable schedule marker exists; ` +
          "fail closed because the intended restart may never have executed.",
      };
    }
    if (
      !comparison.sourceMatches ||
      !comparison.buildMatches ||
      !comparison.capabilityManifestMatches
    ) {
      return {
        outcome: "blocked",
        code: "CUTOVER_RECONCILIATION_REQUIRED",
        status: "BLOCKED",
        blocker: "RECONCILIATION_REQUIRED",
        cutover_phase: "drained",
        reconciliation_required: true,
        server_generation_relation: comparison,
        caller_continuity: options?.callerContinuity,
        client_projection_relation: options?.clientProjectionRelation,
        reason:
          `Replacement server identity does not match approved cutover target for ${record.cutoverId}; ` +
          "reconciliation required.",
      };
    }
    if (dryRun) {
      return {
        outcome: "reconciled_and_finished",
        status: "TERMINAL",
        cutover_phase: "closed",
        reconciliation_required: false,
        server_generation_relation: comparison,
        caller_continuity: options?.callerContinuity,
        client_projection_relation: options?.clientProjectionRelation,
        reason:
          `Cutover ${record.cutoverId} would close on the replacement instance after a fully positive ` +
          "reconciliation witness (startup rehearsal; not enacted).",
        dryRun: true,
      };
    }
    try {
      await this.controller.finish(record.cutoverId, this.enumerateAll);
    } catch (error) {
      return {
        outcome: "blocked",
        code: "CUTOVER_RECONCILIATION_REQUIRED",
        status: "BLOCKED",
        blocker: "RECONCILIATION_REQUIRED",
        cutover_phase: "drained",
        reconciliation_required: true,
        server_generation_relation: comparison,
        caller_continuity: options?.callerContinuity,
        client_projection_relation: options?.clientProjectionRelation,
        reason:
          `Cutover ${record.cutoverId} reconciliation did not close: ` +
          (error instanceof Error ? error.message : String(error)),
      };
    }
    return {
      outcome: "reconciled_and_finished",
      status: "TERMINAL",
      cutover_phase: "closed",
      reconciliation_required: false,
      server_generation_relation: comparison,
      caller_continuity: options?.callerContinuity,
      client_projection_relation: options?.clientProjectionRelation,
      reason: `Cutover ${record.cutoverId} closed on the replacement instance after a fully positive reconciliation witness.`,
    };
  }
}