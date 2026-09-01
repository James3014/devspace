import {
  matchError,
  Result,
  TaggedError,
  type Result as BetterResult,
} from "better-result";
import {
  isLocalAgentProvider,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

export type AgentTargetErrorCode =
  | "UNKNOWN_TARGET"
  | "AGENT_NOT_FOUND"
  | "PROVIDER_DISABLED"
  | "PROVIDER_NOT_CONFIGURED"
  | "TARGET_RESOLUTION_FAILED";

export class AgentTargetError extends TaggedError("AgentTargetError")<{
  code: AgentTargetErrorCode;
  target: string;
  provider?: LocalAgentProvider;
  operation?: string;
  retryable: boolean;
  cause?: unknown;
  message: string;
}>() {}

export class AgentConflictError extends TaggedError("AgentConflictError")<{
  code: "AGENT_CONFLICT";
  agentId?: string;
  operation: string;
  retryable: boolean;
  message: string;
}>() {}

export type AgentScopeErrorCode =
  | "WORKSPACE_MISMATCH"
  | "WORKSPACE_NOT_ALLOWED"
  | "WORKSPACE_SCOPE_REQUIRED";

export class AgentScopeError extends TaggedError("AgentScopeError")<{
  code: AgentScopeErrorCode;
  agentId?: string;
  workspaceId?: string;
  operation: string;
  retryable: boolean;
  cause?: unknown;
  message: string;
}>() {}

interface AgentProviderErrorFields extends Record<string, unknown> {
  provider: LocalAgentProvider;
  agentId?: string;
  operation: string;
  retryable: boolean;
  cause?: unknown;
  message: string;
}

export class AgentProviderUnavailableError extends TaggedError(
  "AgentProviderUnavailableError",
)<AgentProviderErrorFields & { code: "PROVIDER_UNAVAILABLE" }>() {}

export class AgentProviderCancelledError extends TaggedError(
  "AgentProviderCancelledError",
)<AgentProviderErrorFields & { code: "PROVIDER_CANCELLED" }>() {}

export class AgentProviderProtocolError extends TaggedError(
  "AgentProviderProtocolError",
)<AgentProviderErrorFields & { code: "PROVIDER_PROTOCOL_ERROR" }>() {}

export class AgentProviderExecutionError extends TaggedError(
  "AgentProviderExecutionError",
)<AgentProviderErrorFields & { code: "PROVIDER_EXECUTION_ERROR" }>() {}

/**
 * Root provider failure classes. These preserve the original provider error
 * semantics (exact model, requested variant, retryability) instead of letting
 * an idle timeout shadow the real cause.
 */
export type AgentProviderFailureCode =
  | "PROVIDER_MODEL_UNAVAILABLE"
  | "PROVIDER_VARIANT_UNAVAILABLE"
  | "PROVIDER_AUTH_ERROR"
  | "PROVIDER_CAPACITY_ERROR"
  | "PROVIDER_TIMEOUT"
  | "CLINEPASS_ENTITLEMENT_REQUIRED";

export interface AgentProviderFailureDetails {
  code: string;
  errorClass: string;
  retryable: boolean;
  model?: string;
  variant?: string;
  providerSessionId?: string;
  providerMessage?: string;
}

export type AgentProviderFailureClass =
  | "MODEL_UNAVAILABLE"
  | "VARIANT_UNAVAILABLE"
  | "AUTH_FAILURE"
  | "QUOTA_CAPACITY"
  | "UPSTREAM_TIMEOUT"
  | "ENTITLEMENT_REQUIRED";

export class AgentProviderFailureError extends TaggedError(
  "AgentProviderFailureError",
)<AgentProviderErrorFields & {
  code: AgentProviderFailureCode;
  errorClass: AgentProviderFailureClass;
  model?: string;
  variant?: string;
  providerSessionId?: string;
  providerMessage?: string;
}>() {}

export type AgentProviderError =
  | AgentProviderUnavailableError
  | AgentProviderCancelledError
  | AgentProviderProtocolError
  | AgentProviderExecutionError
  | AgentProviderFailureError;

interface AgentDaemonErrorFields extends Record<string, unknown> {
  operation: string;
  retryable: boolean;
  cause?: unknown;
  message: string;
}

export class AgentDaemonUnavailableError extends TaggedError(
  "AgentDaemonUnavailableError",
)<AgentDaemonErrorFields & { code: "DAEMON_UNAVAILABLE" }>() {}

export class AgentDaemonStartupError extends TaggedError(
  "AgentDaemonStartupError",
)<AgentDaemonErrorFields & { code: "DAEMON_STARTUP_FAILURE" }>() {}

export class AgentDaemonTimeoutError extends TaggedError(
  "AgentDaemonTimeoutError",
)<AgentDaemonErrorFields & { code: "DAEMON_TIMEOUT" }>() {}

export class AgentDaemonProtocolMismatchError extends TaggedError(
  "AgentDaemonProtocolMismatchError",
)<AgentDaemonErrorFields & { code: "DAEMON_PROTOCOL_MISMATCH" }>() {}

export class AgentDaemonUnauthorizedError extends TaggedError(
  "AgentDaemonUnauthorizedError",
)<AgentDaemonErrorFields & { code: "DAEMON_UNAUTHORIZED" }>() {}

export class AgentDaemonInvalidRequestError extends TaggedError(
  "AgentDaemonInvalidRequestError",
)<AgentDaemonErrorFields & { code: "DAEMON_INVALID_REQUEST" }>() {}

export class AgentDaemonInvalidResponseError extends TaggedError(
  "AgentDaemonInvalidResponseError",
)<AgentDaemonErrorFields & { code: "DAEMON_INVALID_RESPONSE" }>() {}

export class AgentDaemonInternalError extends TaggedError(
  "AgentDaemonInternalError",
)<AgentDaemonErrorFields & { code: "DAEMON_INTERNAL_ERROR" }>() {}

export type AgentDaemonError =
  | AgentDaemonUnavailableError
  | AgentDaemonStartupError
  | AgentDaemonTimeoutError
  | AgentDaemonProtocolMismatchError
  | AgentDaemonUnauthorizedError
  | AgentDaemonInvalidRequestError
  | AgentDaemonInvalidResponseError
  | AgentDaemonInternalError;

export class AgentStoreError extends TaggedError("AgentStoreError")<{
  code: "AGENT_STORE_ERROR";
  operation: string;
  retryable: boolean;
  cause: unknown;
  message: string;
}>() {
  constructor(operation: string, cause: unknown, message?: string) {
    super({
      code: "AGENT_STORE_ERROR",
      operation,
      retryable: false,
      cause,
      message: message ?? `Subagent persistence operation failed: ${operation}.`,
    });
  }
}

export type AgentManagerError =
  | AgentTargetError
  | AgentConflictError
  | AgentScopeError
  | AgentProviderError
  | AgentStoreError;

export type LocalAgentError = AgentManagerError | AgentDaemonError;

export interface AgentErrorPayload {
  code: LocalAgentError["code"];
  message: string;
  retryable?: boolean;
  provider?: LocalAgentProvider;
  agentId?: string;
  workspaceId?: string;
  operation?: string;
  target?: string;
}

export function isAgentProviderError(error: unknown): error is AgentProviderError {
  return AgentProviderUnavailableError.is(error)
    || AgentProviderCancelledError.is(error)
    || AgentProviderProtocolError.is(error)
    || AgentProviderExecutionError.is(error)
    || AgentProviderFailureError.is(error);
}

export function describeAgentProviderError(error: AgentProviderError): AgentProviderFailureDetails {
  if (AgentProviderFailureError.is(error)) {
    return {
      code: error.code,
      errorClass: error.errorClass,
      retryable: error.retryable,
      ...(error.model ? { model: error.model } : {}),
      ...(error.variant ? { variant: error.variant } : {}),
      ...(error.providerSessionId ? { providerSessionId: error.providerSessionId } : {}),
      ...(error.providerMessage ? { providerMessage: error.providerMessage } : {}),
    };
  }
  return {
    code: error.code,
    errorClass: error.code,
    retryable: error.retryable,
    providerMessage: safeProviderDiagnostic(error.cause) ?? error.message,
  };
}

function safeProviderDiagnostic(cause: unknown): string | undefined {
  const parts: string[] = [];
  const seen = new Set<object>();
  let current = cause;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    const record = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    const summary = [
      typeof record.name === "string" ? record.name : undefined,
      typeof record.code === "string" ? record.code : undefined,
      typeof record.message === "string" ? record.message : undefined,
    ].filter(Boolean).join(": ");
    if (summary) parts.push(summary);
    current = record.cause;
  }
  const text = parts.join(" <- ").trim();
  if (!text) return undefined;
  return redactProviderDiagnostic(text).slice(0, 400);
}

function redactProviderDiagnostic(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_ -]?key|token|authorization|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

export function isAgentDaemonError(error: unknown): error is AgentDaemonError {
  return AgentDaemonUnavailableError.is(error)
    || AgentDaemonStartupError.is(error)
    || AgentDaemonTimeoutError.is(error)
    || AgentDaemonProtocolMismatchError.is(error)
    || AgentDaemonUnauthorizedError.is(error)
    || AgentDaemonInvalidRequestError.is(error)
    || AgentDaemonInvalidResponseError.is(error)
    || AgentDaemonInternalError.is(error);
}

export function isLocalAgentError(error: unknown): error is LocalAgentError {
  return AgentTargetError.is(error)
    || AgentConflictError.is(error)
    || AgentScopeError.is(error)
    || isAgentProviderError(error)
    || AgentStoreError.is(error)
    || isAgentDaemonError(error);
}

export function toAgentErrorPayload(error: LocalAgentError): AgentErrorPayload {
  return matchError(error, {
    AgentTargetError: targetErrorPayload,
    AgentConflictError: conflictErrorPayload,
    AgentScopeError: scopeErrorPayload,
    AgentProviderUnavailableError: providerErrorPayload,
    AgentProviderCancelledError: providerErrorPayload,
    AgentProviderProtocolError: providerErrorPayload,
    AgentProviderExecutionError: providerErrorPayload,
    AgentProviderFailureError: providerErrorPayload,
    AgentDaemonUnavailableError: daemonErrorPayload,
    AgentDaemonStartupError: daemonErrorPayload,
    AgentDaemonTimeoutError: daemonErrorPayload,
    AgentDaemonProtocolMismatchError: daemonErrorPayload,
    AgentDaemonUnauthorizedError: daemonErrorPayload,
    AgentDaemonInvalidRequestError: daemonErrorPayload,
    AgentDaemonInvalidResponseError: daemonErrorPayload,
    AgentDaemonInternalError: daemonErrorPayload,
    AgentStoreError: storeErrorPayload,
  });
}

export function agentErrorFromPayload(payload: {
  code: string;
  message: string;
  retryable?: boolean;
  provider?: string;
  agentId?: string;
  workspaceId?: string;
  operation?: string;
  target?: string;
}): LocalAgentError | undefined {
  const retryable = payload.retryable ?? false;
  const provider = payload.provider && isLocalAgentProvider(payload.provider)
    ? payload.provider
    : undefined;
  switch (payload.code) {
    case "UNKNOWN_TARGET":
    case "AGENT_NOT_FOUND":
    case "PROVIDER_DISABLED":
    case "PROVIDER_NOT_CONFIGURED":
    case "TARGET_RESOLUTION_FAILED":
      return new AgentTargetError({
        code: payload.code,
        target: payload.target ?? payload.agentId ?? payload.provider ?? "unknown",
        provider,
        operation: payload.operation,
        retryable,
        message: payload.message,
      });
    case "AGENT_CONFLICT":
      return new AgentConflictError({
        code: payload.code,
        agentId: payload.agentId,
        operation: payload.operation ?? "request",
        retryable,
        message: payload.message,
      });
    case "WORKSPACE_MISMATCH":
    case "WORKSPACE_NOT_ALLOWED":
    case "WORKSPACE_SCOPE_REQUIRED":
      return new AgentScopeError({
        code: payload.code,
        agentId: payload.agentId,
        workspaceId: payload.workspaceId,
        operation: payload.operation ?? "request",
        retryable,
        message: payload.message,
      });
    case "PROVIDER_UNAVAILABLE":
    case "PROVIDER_CANCELLED":
    case "PROVIDER_PROTOCOL_ERROR":
    case "PROVIDER_EXECUTION_ERROR": {
      if (!provider) return undefined;
      const fields = {
        provider,
        agentId: payload.agentId,
        operation: payload.operation ?? "run",
        retryable,
        message: payload.message,
      };
      if (payload.code === "PROVIDER_UNAVAILABLE") {
        return new AgentProviderUnavailableError({ code: payload.code, ...fields });
      }
      if (payload.code === "PROVIDER_CANCELLED") {
        return new AgentProviderCancelledError({ code: payload.code, ...fields });
      }
      if (payload.code === "PROVIDER_PROTOCOL_ERROR") {
        return new AgentProviderProtocolError({ code: payload.code, ...fields });
      }
      return new AgentProviderExecutionError({ code: payload.code, ...fields });
    }
    case "AGENT_STORE_ERROR":
      return new AgentStoreError(payload.operation ?? "request", undefined, payload.message);
    case "DAEMON_UNAVAILABLE":
      return new AgentDaemonUnavailableError({
        code: payload.code,
        operation: payload.operation ?? "request",
        retryable,
        message: payload.message,
      });
    case "DAEMON_STARTUP_FAILURE":
      return new AgentDaemonStartupError({
        code: payload.code,
        operation: payload.operation ?? "startup",
        retryable,
        message: payload.message,
      });
    case "DAEMON_TIMEOUT":
      return new AgentDaemonTimeoutError({
        code: payload.code,
        operation: payload.operation ?? "request",
        retryable,
        message: payload.message,
      });
    case "DAEMON_PROTOCOL_MISMATCH":
      return new AgentDaemonProtocolMismatchError({
        code: payload.code,
        operation: payload.operation ?? "hello",
        retryable,
        message: payload.message,
      });
    case "DAEMON_UNAUTHORIZED":
      return new AgentDaemonUnauthorizedError({
        code: payload.code,
        operation: payload.operation ?? "request",
        retryable,
        message: payload.message,
      });
    case "DAEMON_INVALID_REQUEST":
      return new AgentDaemonInvalidRequestError({
        code: payload.code,
        operation: payload.operation ?? "request",
        retryable,
        message: payload.message,
      });
    case "DAEMON_INVALID_RESPONSE":
      return new AgentDaemonInvalidResponseError({
        code: payload.code,
        operation: payload.operation ?? "request",
        retryable,
        message: payload.message,
      });
    case "DAEMON_INTERNAL_ERROR":
      return new AgentDaemonInternalError({
        code: payload.code,
        operation: payload.operation ?? "request",
        retryable,
        message: payload.message,
      });
    default:
      return undefined;
  }
}

export function providerErrorFromCause(input: {
  provider: LocalAgentProvider;
  agentId?: string;
  operation: string;
  cause: unknown;
}): AgentProviderError | undefined {
  if (isAgentProviderError(input.cause)) return input.cause;
  if (isLocalAgentError(input.cause)) return undefined;
  const unavailable = unavailableCauseKind(input.cause);
  if (unavailable) {
    return new AgentProviderUnavailableError({
      code: "PROVIDER_UNAVAILABLE",
      provider: input.provider,
      agentId: input.agentId,
      operation: input.operation,
      retryable: unavailable === "transient",
      cause: input.cause,
      message: `${displayProvider(input.provider)} provider is unavailable.`,
    });
  }
  if (isProgrammerDefect(input.cause)) return undefined;
  if (isAbortError(input.cause)) {
    return new AgentProviderCancelledError({
      code: "PROVIDER_CANCELLED",
      provider: input.provider,
      agentId: input.agentId,
      operation: input.operation,
      retryable: false,
      cause: input.cause,
      message: `${displayProvider(input.provider)} agent turn was cancelled.`,
    });
  }
  return new AgentProviderExecutionError({
    code: "PROVIDER_EXECUTION_ERROR",
    provider: input.provider,
    agentId: input.agentId,
    operation: input.operation,
    retryable: false,
    cause: input.cause,
    message: `${displayProvider(input.provider)} agent execution failed.`,
  });
}

export async function captureAgentProviderResult<T>(input: {
  provider: LocalAgentProvider;
  agentId?: string;
  operation: string;
  run: () => T | Promise<T>;
}): Promise<BetterResult<T, AgentProviderError>> {
  try {
    return Result.ok(await input.run());
  } catch (cause) {
    const error = providerErrorFromCause({
      provider: input.provider,
      agentId: input.agentId,
      operation: input.operation,
      cause,
    });
    if (!error) throw cause;
    return Result.err(error);
  }
}

export function isProgrammerDefect(error: unknown): boolean {
  if (unavailableCauseKind(error)) return false;
  return error instanceof TypeError
    || error instanceof ReferenceError
    || error instanceof SyntaxError
    || error instanceof RangeError
    || (error instanceof Error && error.name === "AssertionError");
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "name" in error
      && String((error as { name?: unknown }).name) === "AbortError",
  );
}

function unavailableCauseKind(error: unknown): "permanent" | "transient" | undefined {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = "code" in current ? String((current as { code?: unknown }).code) : "";
    if (code === "ENOENT") return "permanent";
    if (code === "ECONNREFUSED" || code === "ENOTFOUND") return "transient";
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

function displayProvider(provider: LocalAgentProvider): string {
  switch (provider) {
    case "codex": return "Codex";
    case "claude": return "Claude";
    case "opencode": return "OpenCode";
    case "omp": return "OMP";
    case "pi": return "Pi";
    case "cursor": return "Cursor";
    case "copilot": return "Copilot";
    case "grok": return "Grok";
    case "agy": return "Agy";
    case "cline": return "Cline";
  }
}

function targetErrorPayload(error: AgentTargetError): AgentErrorPayload {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    target: error.target,
    ...(error.provider ? { provider: error.provider } : {}),
    ...(error.operation ? { operation: error.operation } : {}),
  };
}

function conflictErrorPayload(error: AgentConflictError): AgentErrorPayload {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    operation: error.operation,
    ...(error.agentId ? { agentId: error.agentId } : {}),
  };
}

function scopeErrorPayload(error: AgentScopeError): AgentErrorPayload {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    operation: error.operation,
    ...(error.agentId ? { agentId: error.agentId } : {}),
    ...(error.workspaceId ? { workspaceId: error.workspaceId } : {}),
  };
}

function providerErrorPayload(error: AgentProviderError): AgentErrorPayload {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    provider: error.provider,
    operation: error.operation,
    ...(error.agentId ? { agentId: error.agentId } : {}),
    ...("errorClass" in error && error.errorClass
      ? {
          errorClass: error.errorClass,
          model: (error as AgentProviderFailureError).model,
          variant: (error as AgentProviderFailureError).variant,
          providerSessionId: (error as AgentProviderFailureError).providerSessionId,
        }
      : {}),
  };
}

function daemonErrorPayload(error: AgentDaemonError): AgentErrorPayload {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    operation: error.operation,
  };
}

function storeErrorPayload(error: AgentStoreError): AgentErrorPayload {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    operation: error.operation,
  };
}
