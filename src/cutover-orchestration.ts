import type { BuildReadyProbeResult } from "./cutover-build-ready.js";
import type { SelfRestartActuator } from "./cutover-restart.js";
import type { ExpectedCutoverIdentity } from "./cutover-state.js";
import type { DurableReconciliationWitness, McpCutoverController } from "./mcp-cutover.js";

export type OrchestrationOutcome =
  | { outcome: "noop"; reason: string }
  | { outcome: "awaiting_drain"; reason: string }
  | { outcome: "awaiting_decision"; reason: string }
  | {
      outcome: "restart_scheduled";
      reason: string;
      scheduledFor: string;
      dryRun?: boolean;
    }
  | {
      outcome: "restart_already_scheduled";
      reason: string;
      scheduledFor: string;
    }
  | { outcome: "reconciled_and_finished"; reason: string; dryRun?: boolean }
  | {
      outcome: "blocked";
      code:
        | "CUTOVER_BUILD_NOT_READY"
        | "CUTOVER_RECONCILIATION_REQUIRED"
        | "CUTOVER_ACTUATOR_UNAVAILABLE";
      reason: string;
      probe?: BuildReadyProbeResult;
    };

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
  async advance(options?: { dryRun?: boolean }): Promise<OrchestrationOutcome> {
    const dryRun = Boolean(options?.dryRun);
    const record = this.controller.record();
    if (!record || record.phase === "closed") {
      return { outcome: "noop", reason: "No unresolved cutover requires advancement." };
    }
    const mode = this.controller.mode();

    if (mode === "reconcile-only") {
      return this.advanceReconcileOnly(record, dryRun);
    }

    if (record.phase === "prepared") {
      return {
        outcome: "awaiting_drain",
        reason: `Cutover ${record.cutoverId} is prepared and waiting for the old instance to drain; never auto-drains.`,
      };
    }

    if (record.phase !== "drained") {
      return {
        outcome: "blocked",
        code: "CUTOVER_RECONCILIATION_REQUIRED",
        reason: `Cutover ${record.cutoverId} is in unexpected phase ${record.phase}; operator intervention is required.`,
      };
    }

    const restart = record.restartRequest;
    if (!restart) {
      return {
        outcome: "awaiting_decision",
        reason: `Cutover ${record.cutoverId} is drained; a restart decision is required before it can advance.`,
      };
    }
    if (restart.restartScheduledAt) {
      return {
        outcome: "restart_already_scheduled",
        reason: `Cutover ${record.cutoverId} restart was already durably scheduled; it will never be re-scheduled.`,
        scheduledFor: restart.restartScheduledForServerInstanceId ?? "unknown",
      };
    }
    if (!restart.buildReady) {
      return {
        outcome: "blocked",
        code: "CUTOVER_BUILD_NOT_READY",
        reason: `Cutover ${record.cutoverId} restart lacks build-ready attestation; refusing to schedule until the target build is verified.`,
      };
    }
    if (this.probeBuildReady) {
      const probe = await this.probeBuildReady(record.expectedNewIdentity);
      if (!probe.buildReady) {
        return {
          outcome: "blocked",
          code: "CUTOVER_BUILD_NOT_READY",
          reason: `Cutover ${record.cutoverId} target build is not ready on disk; refusing to schedule the restart.`,
          probe,
        };
      }
    }

    if (dryRun) {
      return {
        outcome: "restart_scheduled",
        reason: `Cutover ${record.cutoverId} restart would be durably marked and scheduled via ${this.actuator.serviceLabel} (startup rehearsal; not enacted).`,
        scheduledFor: this.actuator.serviceLabel,
        dryRun: true,
      };
    }
    const mark = this.controller.markRestartScheduled(record.cutoverId);
    if (!mark.newlyScheduled) {
      return {
        outcome: "restart_already_scheduled",
        reason: `Cutover ${record.cutoverId} restart was durably scheduled by a concurrent actor; it will never be re-scheduled.`,
        scheduledFor: mark.record.restartRequest?.restartScheduledForServerInstanceId ?? "unknown",
      };
    }
    try {
      this.actuator.schedule();
    } catch (error) {
      return {
        outcome: "blocked",
        code: "CUTOVER_ACTUATOR_UNAVAILABLE",
        reason:
          `Restart marker ${"restart-scheduled.json"} for cutover ${record.cutoverId} is durable, ` +
          `but the launchd actuator failed to schedule; the restart will never be re-scheduled. ` +
          (error instanceof Error ? error.message : String(error)),
      };
    }
    return {
      outcome: "restart_scheduled",
      reason: `Cutover ${record.cutoverId} restart is durably marked and scheduled via ${this.actuator.serviceLabel}.`,
      scheduledFor: this.actuator.serviceLabel,
    };
  }

  private async advanceReconcileOnly(
    record: NonNullable<ReturnType<McpCutoverController["record"]>>,
    dryRun: boolean,
  ): Promise<OrchestrationOutcome> {
    if (record.phase !== "drained") {
      return {
        outcome: "blocked",
        code: "CUTOVER_RECONCILIATION_REQUIRED",
        reason:
          `Cutover ${record.cutoverId} has no durable drain evidence and the original drain-lease holder is gone; ` +
          "operator intervention is required before reconciliation can proceed.",
      };
    }
    if (record.restartRequest && !record.restartRequest.restartScheduledAt) {
      return {
        outcome: "blocked",
        code: "CUTOVER_RECONCILIATION_REQUIRED",
        reason:
          `Cutover ${record.cutoverId} restart was requested but no durable schedule marker exists; ` +
          "fail closed because the intended restart may never have executed.",
      };
    }
    if (dryRun) {
      return {
        outcome: "reconciled_and_finished",
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
        reason:
          `Cutover ${record.cutoverId} reconciliation did not close: ` +
          (error instanceof Error ? error.message : String(error)),
      };
    }
    return {
      outcome: "reconciled_and_finished",
      reason: `Cutover ${record.cutoverId} closed on the replacement instance after a fully positive reconciliation witness.`,
    };
  }
}