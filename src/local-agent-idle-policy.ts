import { getLocalAgentExecutionActivityCapability } from "./local-agent-adapters.js";
import type {
  EffectiveExecutionIdlePolicy,
  ExecutionContract,
} from "./local-agent-contract.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";

const DEFAULT_EXECUTION_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MIN_EXPLICIT_IDLE_OVERRIDE_MS = 30_000;

export class ExecutionIdlePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionIdlePolicyError";
  }
}

export function resolveEffectiveExecutionIdlePolicy(
  profile: LocalAgentProfile,
  contract: ExecutionContract | undefined,
): EffectiveExecutionIdlePolicy {
  const activityCapability = getLocalAgentExecutionActivityCapability(profile.provider);
  const explicitOverride = contract?.idleTimeoutMode === "EXPLICIT_OVERRIDE";
  const requestedTimeoutMs = contract?.idleTimeoutMs;
  const profileDefaultMs = profile.execution_idle_timeout_ms
    ?? (activityCapability === "TRUSTWORTHY" ? DEFAULT_EXECUTION_IDLE_TIMEOUT_MS : undefined);
  const minOverrideMs = profile.execution_idle_min_override_ms
    ?? DEFAULT_MIN_EXPLICIT_IDLE_OVERRIDE_MS;

  if (explicitOverride) {
    if (requestedTimeoutMs === undefined) {
      throw new ExecutionIdlePolicyError(
        "idleTimeoutMode=EXPLICIT_OVERRIDE requires idleTimeoutMs.",
      );
    }
    if (activityCapability !== "TRUSTWORTHY") {
      throw new ExecutionIdlePolicyError(
        `Provider '${profile.provider}' does not expose trustworthy mid-run activity; use maxExecutionMs instead of a terminating idle timeout.`,
      );
    }
    if (requestedTimeoutMs < minOverrideMs) {
      throw new ExecutionIdlePolicyError(
        `Explicit idleTimeoutMs ${requestedTimeoutMs}ms is below profile minimum ${minOverrideMs}ms.`,
      );
    }
    return {
      source: "EXPLICIT_OVERRIDE",
      activityCapability,
      timeoutMs: requestedTimeoutMs,
    };
  }

  if (requestedTimeoutMs !== undefined) {
    throw new ExecutionIdlePolicyError(
      "idleTimeoutMs is an explicit task-contract override and requires idleTimeoutMode=EXPLICIT_OVERRIDE.",
    );
  }
  if (profileDefaultMs !== undefined && activityCapability !== "TRUSTWORTHY") {
    throw new ExecutionIdlePolicyError(
      `Profile '${profile.name}' configures an execution idle timeout, but provider '${profile.provider}' lacks trustworthy mid-run activity. Use maxExecutionMs instead.`,
    );
  }
  return {
    source: "PROFILE_DEFAULT",
    activityCapability,
    ...(profileDefaultMs === undefined ? {} : { timeoutMs: profileDefaultMs }),
  };
}
