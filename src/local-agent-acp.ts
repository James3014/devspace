import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentProviderFailureError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
  isProgrammerDefect,
  type AgentProviderError,
} from "./local-agent-errors.js";
import { terminateProcessTree } from "./process-platform.js";
import { createThrottledActivityTouch } from "./local-agent-activity.js";
import {
  GrokPromptCompletionRegistry,
  GROK_DEFAULT_MODEL,
  parseGrokPromptCompletion,
  readGrokSessionState,
  resolveGrokEffort,
  resolveGrokModelId,
} from "./local-agent-grok.js";
import {
  resolveGrokExecutable,
  resolveClineExecutable,
} from "./local-agent-availability.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
  LocalAgentWriteMode,
} from "./local-agent-runtime.js";

export type AcpProvider = "cursor" | "copilot" | "grok" | "cline";
type ClineCliProviderId = "cline" | "cline-pass";

function clineCliProviderId(context: LocalAgentRuntimeContext): ClineCliProviderId {
  const value = context.cliProviderId;
  if (value === undefined || value === "cline") return "cline";
  if (value === "cline-pass") return value;
  throw new Error(`Unsupported Cline CLI provider '${String(value)}'.`);
}

const MAX_ACP_QUEUE_ITEMS = 10_000;
const MAX_ACP_QUEUE_BYTES = 8 * 1024 * 1024;
const MAX_ACP_REQUIRED_OUTPUT_BYTES = 1 * 1024 * 1024;
const MAX_ACP_REQUIRED_EVIDENCE_ITEMS = 4_096;
const MAX_ACP_VALUE_ESTIMATE_DEPTH = 64;
const MAX_ACP_VALUE_ESTIMATE_NODES = 100_000;
const MAX_ACP_STDERR_BYTES = 32 * 1024;
const ACP_INITIALIZE_TIMEOUT_MS = 10_000;
const ACP_GROK_PROMPT_COMPLETION_TIMEOUT_MS = 10 * 60_000;
const require = createRequire(import.meta.url);
const spawn = require("cross-spawn") as typeof import("node:child_process").spawn;
const DEVSPACE_VERSION = readDevspaceVersion();

const observeChildError = (): void => {};

const ACP_COMMANDS: Record<AcpProvider, [string, ...string[]]> = {
  cursor: ["cursor-agent", "acp"],
  copilot: ["copilot", "--acp"],
  grok: ["grok", "agent", "stdio"],
  cline: ["cline", "acp"],
};

interface AcpConnectionLike {
  agent: {
    request(method: string, params?: unknown): Promise<unknown>;
  };
  close(error?: unknown): void;
  closed: Promise<void>;
}

interface AcpCapabilities {
  resume: boolean;
  close: boolean;
  additionalDirectories?: boolean;
}

export interface AcpSessionQueue {
  values: unknown[];
  previewBytes?: number;
  suppressedPreviewItems?: number;
  suppressedPreviewBytes?: number;
  requiredEvidence?: unknown[];
  requiredEvidenceBytes?: number;
  requiredOutputParts?: string[];
  requiredOutputBytes?: number;
  requiredOutputTruncated?: boolean;
  requiredEvidenceTruncated?: boolean;
}

export interface AcpOutputRetentionSummary {
  previewSuppressedItems: number;
  previewSuppressedBytes: number;
  requiredEvidenceItems: number;
  requiredEvidenceBytes: number;
  requiredOutputBytes: number;
  requiredOutputTruncated: boolean;
  requiredEvidenceTruncated: boolean;
}

export interface AcpDiagnosticObservation {
  provider: AcpProvider;
  sessionId: string;
  responseKeys: string[];
  stopReason?: string;
  updateTypes: string[];
  updateContentTypes: string[];
  updateContentBytes: number;
  outputRetention: AcpOutputRetentionSummary;
  classifiedErrorCode?: string;
}

export interface AcpRuntimeOptions {
  provider: AcpProvider;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  child?: ChildProcessWithoutNullStreams;
  capabilities?: AcpCapabilities;
  queues?: Map<string, AcpSessionQueue>;
  liveSessions?: Set<string>;
  sessionWriteModes?: Map<string, LocalAgentWriteMode>;
  sessionMetadata?: Map<string, unknown>;
  grokCompletionRegistry?: GrokPromptCompletionRegistry;
  promptCompletionTimeoutMs?: number;
  activityCallbacks?: Map<string, () => void | Promise<void>>;
  stderrTail?: () => string;
  diagnosticObserver?: (observation: AcpDiagnosticObservation) => void;
}

export class AcpRuntime implements LocalAgentRuntime {
  readonly provider: AcpProvider;
  private readonly child?: ChildProcessWithoutNullStreams;
  private readonly connection: AcpConnectionLike;
  private readonly capabilities: AcpCapabilities;
  private readonly queues: Map<string, AcpSessionQueue>;
  private readonly liveSessions: Set<string>;
  private readonly sessionWriteModes: Map<string, LocalAgentWriteMode>;
  private readonly sessionMetadata: Map<string, unknown>;
  private readonly grokCompletionRegistry?: GrokPromptCompletionRegistry;
  private readonly promptCompletionTimeoutMs: number;
  private readonly activeSessions = new Set<string>();
  private promptSequence = 0;
  private alive = true;
  private closed = false;
  private readonly activityCallbacks: Map<string, () => void | Promise<void>>;
  private readonly stderrTail?: () => string;
  private readonly diagnosticObserver?: (observation: AcpDiagnosticObservation) => void;

  constructor(options: AcpRuntimeOptions, connection: AcpConnectionLike) {
    this.provider = options.provider;
    this.child = options.child;
    this.connection = connection;
    this.capabilities = options.capabilities ?? { resume: false, close: false };
    this.queues = options.queues ?? new Map();
    this.liveSessions = options.liveSessions ?? new Set();
    this.sessionWriteModes = options.sessionWriteModes ?? new Map();
    this.sessionMetadata = options.sessionMetadata ?? new Map();
    this.grokCompletionRegistry = options.grokCompletionRegistry;
    this.promptCompletionTimeoutMs = options.promptCompletionTimeoutMs ?? ACP_GROK_PROMPT_COMPLETION_TIMEOUT_MS;
    this.activityCallbacks = options.activityCallbacks ?? new Map();
    this.stderrTail = options.stderrTail;
    this.diagnosticObserver = options.diagnosticObserver;
    void this.connection.closed.then(() => {
      if (!this.closed) this.alive = false;
      this.grokCompletionRegistry?.rejectAll(new Error(`${this.provider} ACP connection closed.`));
    }).catch(() => {
      if (!this.closed) this.alive = false;
      this.grokCompletionRegistry?.rejectAll(new Error(`${this.provider} ACP connection closed.`));
    });
    this.child?.once("exit", () => {
      this.alive = false;
      this.connection.close(new Error(`${this.provider} ACP process exited.`));
    });
    this.child?.once("error", (error) => {
      this.alive = false;
      this.connection.close(error);
    });
  }

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks) {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "run",
      run: async (): Promise<LocalAgentRunResult> => {
        if (!this.isAlive()) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            operation: "run",
            retryable: true,
            message: `${this.provider} ACP runtime is not running.`,
          });
        }
        const sessionId = await this.openSession(input, callbacks);
        if (this.activeSessions.has(sessionId)) {
          throw new TypeError(`${this.provider} ACP session ${sessionId} already has an active turn.`);
        }
        this.activeSessions.add(sessionId);
        // Raw-byte heartbeat: any output from the provider process is proof of
        // life even when the protocol emits no session/update (e.g. silent
        // model reasoning). Throttled; detached when the turn ends.
        const activityTouch = createThrottledActivityTouch(() => {
          void callbacks?.onActivity?.();
        });
        const onProviderBytes = () => activityTouch.touch();
        this.child?.stdout?.on("data", onProviderBytes);
        this.child?.stderr?.on("data", onProviderBytes);
        const queue = this.queues.get(sessionId) ?? { values: [] };
        this.queues.set(sessionId, queue);
        const promptId = this.provider === "grok" ? this.nextPromptId() : undefined;
        const completion = promptId && this.grokCompletionRegistry
          ? this.grokCompletionRegistry.wait(
              sessionId,
              promptId,
              this.promptCompletionTimeoutMs,
              () => new AgentProviderProtocolError({
                code: "PROVIDER_PROTOCOL_ERROR",
                provider: this.provider,
                operation: "run",
                retryable: true,
                message: "Grok ACP did not report completion for the prompt before the timeout.",
              }),
            )
          : undefined;
        try {
          if (callbacks?.onActivity) this.activityCallbacks.set(sessionId, callbacks.onActivity);
          await callbacks?.onActivity?.();
          resetAcpQueue(queue);
          const standardResponse = this.connection.agent.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: input.prompt }],
            ...(promptId ? { _meta: { promptId, requestId: promptId } } : {}),
          });
          let response: unknown;
          try {
            response = completion
              ? await Promise.race([standardResponse, completion])
              : await standardResponse;
          } catch (cause) {
            const classified = classifyAcpError(
              cause,
              this.provider,
              sessionId,
              { model: input.model, variant: input.effort },
              this.stderrTail?.(),
            );
            this.emitDiagnostic(sessionId, undefined, queue.values, classified?.code, acpOutputRetention(queue));
            if (classified) throw classified;
            throw cause;
          }
          if (completion && isGrokPromptCompletion(response)) {
            await yieldToAcpQueue();
          } else if (promptId) {
            this.grokCompletionRegistry?.markCompleted(sessionId, promptId);
          }
          const updates = queue.values.splice(0);
          const retention = acpOutputRetention(queue);
          if (retention.requiredOutputTruncated || retention.requiredEvidenceTruncated) {
            this.emitDiagnostic(sessionId, response, updates, "PROVIDER_PROTOCOL_ERROR", retention);
            throw new AgentProviderProtocolError({
              code: "PROVIDER_PROTOCOL_ERROR",
              provider: this.provider,
              operation: "run",
              retryable: false,
              cause: retention,
              message: `${this.provider} ACP output exceeded the bounded required-evidence retention limit (requiredOutputBytes=${retention.requiredOutputBytes}, requiredEvidenceBytes=${retention.requiredEvidenceBytes}, requiredEvidenceItems=${retention.requiredEvidenceItems}).`,
            });
          }
          const finalResponse = extractAcpText(queue.requiredOutputParts ?? [], updates);
          if (!finalResponse) {
            const classified = classifyAcpError(
              response,
              this.provider,
              sessionId,
              { model: input.model, variant: input.effort },
              this.stderrTail?.(),
            );
            this.emitDiagnostic(sessionId, response, updates, classified?.code ?? "PROVIDER_PROTOCOL_ERROR", retention);
            if (classified) throw classified;
            throw new AgentProviderProtocolError({
              code: "PROVIDER_PROTOCOL_ERROR",
              provider: this.provider,
              operation: "run",
              retryable: false,
              cause: response,
              message: `${this.provider} ACP did not return a final assistant response.`,
            });
          }
          if (retention.previewSuppressedItems > 0) {
            this.emitDiagnostic(sessionId, response, updates, undefined, retention);
          }
          const retentionItem = retention.previewSuppressedItems > 0
            ? [{ kind: "devspace_acp_output_retention", ...retention }]
            : [];
          const requiredAssistantItem = queue.requiredOutputParts?.length
            ? [{ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: finalResponse } } }]
            : [];
          return {
            provider: this.provider,
            providerSessionId: sessionId,
            finalResponse,
            // Items are bounded provider evidence for callers that retain them;
            // durable finalResponse persistence remains the authoritative sink.
            items: [...(queue.requiredEvidence ?? []), ...updates, ...requiredAssistantItem, ...retentionItem],
          };
        } finally {
          this.child?.stdout?.off("data", onProviderBytes);
          this.child?.stderr?.off("data", onProviderBytes);
          this.activityCallbacks.delete(sessionId);
          if (promptId) this.grokCompletionRegistry?.remove(sessionId, promptId);
          this.activeSessions.delete(sessionId);
        }
      },
    });
  }

  private emitDiagnostic(
    sessionId: string,
    response: unknown,
    updates: unknown[],
    classifiedErrorCode?: string,
    outputRetention: AcpOutputRetentionSummary = emptyAcpOutputRetention(),
  ): void {
    if (!this.diagnosticObserver) return;
    const observation: AcpDiagnosticObservation = {
      provider: this.provider,
      sessionId: diagnosticSessionId(sessionId),
      responseKeys: diagnosticResponseKeys(response),
      ...(diagnosticStopReason(response) ? { stopReason: diagnosticStopReason(response) } : {}),
      ...diagnosticUpdateSummary(updates),
      outputRetention,
      ...(classifiedErrorCode ? { classifiedErrorCode } : {}),
    };
    try {
      this.diagnosticObserver(observation);
    } catch {
      // Diagnostics are strictly observational and must never alter execution.
    }
  }

  async releaseSession(providerSessionId: string): Promise<void> {
    this.queues.delete(providerSessionId);
    this.liveSessions.delete(providerSessionId);
    this.sessionWriteModes.delete(providerSessionId);
    this.sessionMetadata.delete(providerSessionId);
    if (!this.capabilities.close || !this.isAlive()) return;
    await this.connection.agent.request("session/close", { sessionId: providerSessionId });
  }

  isAlive(): boolean {
    return this.alive && !this.closed && (!this.child || (this.child.exitCode === null && !this.child.killed));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    this.queues.clear();
    this.liveSessions.clear();
    this.sessionWriteModes.clear();
    this.sessionMetadata.clear();
    this.activeSessions.clear();
    this.activityCallbacks.clear();
    this.grokCompletionRegistry?.rejectAll(new Error(`${this.provider} ACP runtime closed.`));
    this.connection.close(new Error(`${this.provider} ACP runtime closed.`));
    if (this.child && this.child.exitCode === null) {
      const detached = process.platform !== "win32";
      terminateProcessTree(this.child, "SIGTERM", detached);
      if (!await waitForProcessExit(this.child, 1_000)) {
        terminateProcessTree(this.child, "SIGKILL", detached);
      }
    }
  }

  private async openSession(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks): Promise<string> {
    if (input.providerSessionId) {
      if (this.liveSessions.has(input.providerSessionId)) {
        this.sessionWriteModes.set(input.providerSessionId, input.writeMode ?? "allowed");
        await callbacks?.onSessionId?.(input.providerSessionId);
        await this.configureSession(
          input.providerSessionId,
          input,
          this.sessionMetadata.get(input.providerSessionId),
          false,
        );
        return input.providerSessionId;
      }
      if (!this.capabilities.resume) {
        throw new AgentProviderProtocolError({
          code: "PROVIDER_PROTOCOL_ERROR",
          provider: this.provider,
          operation: "resume_session",
          retryable: false,
          message: `${this.provider} ACP does not advertise session resume support.`,
        });
      }
      const response = await this.connection.agent.request("session/resume", {
        sessionId: input.providerSessionId,
        cwd: input.workspaceRoot,
        mcpServers: [],
        ...this.additionalDirectoryParams(),
      });
      this.cacheSessionMetadata(input.providerSessionId, response);
      this.queues.set(input.providerSessionId, { values: [] });
      this.liveSessions.add(input.providerSessionId);
      this.sessionWriteModes.set(input.providerSessionId, input.writeMode ?? "allowed");
      await callbacks?.onSessionId?.(input.providerSessionId);
      await this.configureSession(input.providerSessionId, input, response, false);
      return input.providerSessionId;
    }

    const response = await this.connection.agent.request("session/new", {
      cwd: input.workspaceRoot,
      mcpServers: [],
      ...this.additionalDirectoryParams(),
    });
    const sessionId = readString(response, "sessionId");
    if (!sessionId) {
      throw new AgentProviderProtocolError({
        code: "PROVIDER_PROTOCOL_ERROR",
        provider: this.provider,
        operation: "create_session",
        retryable: false,
        cause: response,
        message: `${this.provider} ACP did not return a session id.`,
      });
    }
    this.cacheSessionMetadata(sessionId, response);
    this.queues.set(sessionId, { values: [] });
    this.liveSessions.add(sessionId);
    this.sessionWriteModes.set(sessionId, input.writeMode ?? "allowed");
    await callbacks?.onSessionId?.(sessionId);
    await this.configureSession(sessionId, input, response, true);
    return sessionId;
  }

  private cacheSessionMetadata(sessionId: string, response: unknown): void {
    if (hasAcpConfigOptions(response) || (this.provider === "grok" && readGrokSessionState(response))) {
      this.sessionMetadata.set(sessionId, response);
    }
  }

  private async configureSession(
    sessionId: string,
    input: LocalAgentRunInput,
    response?: unknown,
    isNewSession = false,
  ): Promise<void> {
    const metadata = response ?? this.sessionMetadata.get(sessionId);
    if (this.provider === "grok") {
      await this.configureGrokSession(sessionId, input, metadata, isNewSession);
      return;
    }
    if (this.provider === "cline") {
      await this.configureClineSession(sessionId, input, metadata);
      return;
    }

    const canConfigure = isNewSession || hasAcpConfigOptions(metadata);
    if (!canConfigure) {
      const requested = [
        input.model && input.modelOverrideRequested ? "model" : undefined,
        input.effort && input.effortOverrideRequested ? "effort" : undefined,
      ]
        .filter(Boolean)
        .join(" and ");
      if (requested) {
        throw new AgentProviderProtocolError({
          code: "PROVIDER_PROTOCOL_ERROR",
          provider: this.provider,
          operation: "configure_session",
          retryable: false,
          message: `${this.provider} ACP cannot apply the requested ${requested} override because the resumed session did not advertise configurable options.`,
        });
      }
      // A durable resumed session keeps its previously selected provider
      // configuration. If resume does not re-advertise config options, do not
      // force a redundant set operation for persisted model/effort values.
      return;
    }
    if (input.model) {
      const config = resolveAcpModelConfigUpdate(metadata, input.model, this.provider, sessionId);
      await this.connection.agent.request("session/set_config_option", config);
    }
    if (input.effort) {
      const config = resolveAcpEffortConfigUpdate(metadata, input.effort, this.provider, sessionId);
      await this.connection.agent.request("session/set_config_option", config);
    }
  }

  private async configureClineSession(
    sessionId: string,
    input: LocalAgentRunInput,
    metadata: unknown,
  ): Promise<void> {
    if (input.effort !== undefined) {
      throw clineSelectionError("Cline ACP does not advertise a session thinking/effort config or readback.");
    }
    const requestedProvider = input.cliProviderId ?? "cline";
    let current = readClineSessionIdentity(metadata);
    if (current.provider !== requestedProvider) {
      const providerConfig = current.providerConfig;
      if (!providerConfig || !flattenAcpSelectValues(providerConfig).includes(requestedProvider)) {
        throw clineSelectionError(`provider '${requestedProvider}' is not advertised by the ACP session.`);
      }
      const providerConfigId = directString(providerConfig.id);
      if (!providerConfigId) throw clineSelectionError("Cline ACP provider config option is missing an id.");
      const providerResponse = await this.connection.agent.request("session/set_config_option", {
        sessionId,
        configId: providerConfigId,
        value: requestedProvider,
      });
      current = readClineSessionIdentity(providerResponse);
      if (current.provider !== requestedProvider) {
        throw clineSelectionError(`provider readback '${current.provider ?? "unknown"}' did not match requested '${requestedProvider}'.`);
      }
    }
    if (!input.model) return;
    if (!current.models.includes(input.model)) {
      throw clineSelectionError(`model '${input.model}' is not advertised by the ACP session.`);
    }
    if (current.model === input.model) return;
    const modelConfig = current.modelConfig;
    if (!modelConfig) throw clineSelectionError("Cline ACP did not advertise a model config option.");
    const modelConfigId = directString(modelConfig.id);
    if (!modelConfigId) throw clineSelectionError("Cline ACP model config option is missing an id.");
    const modelResponse = await this.connection.agent.request("session/set_config_option", {
      sessionId,
      configId: modelConfigId,
      value: input.model,
    });
    const readback = readClineSessionIdentity(modelResponse);
    if (readback.provider !== requestedProvider) {
      throw clineSelectionError(`provider readback '${readback.provider ?? "unknown"}' did not match requested '${requestedProvider}'.`);
    }
    if (readback.model !== input.model) {
      throw clineSelectionError(`model readback '${readback.model ?? "unknown"}' did not match requested '${input.model}'.`);
    }
  }

  private async configureGrokSession(
    sessionId: string,
    input: LocalAgentRunInput,
    response: unknown,
    isNewSession: boolean,
  ): Promise<void> {
    const state = readGrokSessionState(response);
    if (!state) {
      const requested = [
        input.model && (isNewSession || input.modelOverrideRequested) ? "model" : undefined,
        input.effort && (isNewSession || input.effortOverrideRequested) ? "effort" : undefined,
      ].filter(Boolean).join(" and ");
      if (requested) {
        throw new AgentProviderProtocolError({
          code: "PROVIDER_PROTOCOL_ERROR",
          provider: this.provider,
          operation: "configure_session",
          retryable: false,
          message: `${this.provider} ACP did not advertise typed model metadata required for the requested ${requested} override.`,
        });
      }
      return;
    }

    const currentModel = state.currentModelId;
    const requestedModel = input.model
      ? resolveGrokModelId(input.model, state)
      : currentModel ?? state.availableModels[0]?.id ?? GROK_DEFAULT_MODEL;
    const effort = input.effort
      ? resolveGrokEffort(input.effort, state, requestedModel)
      : undefined;
    const shouldSetModel = Boolean(input.model && requestedModel !== currentModel) || effort !== undefined;
    if (!shouldSetModel) return;

    try {
      await this.connection.agent.request("session/set_model", {
        sessionId,
        modelId: requestedModel,
        ...(effort ? { _meta: { reasoningEffort: effort } } : {}),
      });
    } catch (cause) {
      throw new AgentProviderProtocolError({
        code: "PROVIDER_PROTOCOL_ERROR",
        provider: this.provider,
        operation: "configure_session",
        retryable: false,
        cause,
        message: `${this.provider} ACP could not select model '${requestedModel}'.`,
      });
    }
  }

  private additionalDirectoryParams(): { additionalDirectories?: string[] } {
    // DevSpace currently authorizes exactly one workspace root per agent turn.
    // Do not advertise an empty additional-directory scope to ACP providers.
    return {};
  }

  private nextPromptId(): string {
    this.promptSequence += 1;
    return `devspace-grok-prompt-${this.promptSequence}`;
  }
}

export class AcpLocalAgentDriver implements LocalAgentDriver {
  readonly provider: AcpProvider;
  readonly executionActivityCapability = "TRUSTWORTHY" as const;
  // Keep ACP warm briefly, then let the generic pool close the process so the
  // daemon can reach its own idle shutdown state.
  readonly idleTimeoutMs = 5 * 60_000;
  private commandResolved = false;
  private resolvedCommand?: string;

  constructor(
    provider: AcpProvider,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly commandResolver: AcpCommandResolver = resolveAcpCommand,
    private readonly diagnosticObserver?: (observation: AcpDiagnosticObservation) => void,
  ) {
    this.provider = provider;
  }

  runtimeKey(context: LocalAgentRuntimeContext): string {
    const command = this.resolveCommand() ?? ACP_COMMANDS[this.provider][0];
    const writeMode = context.writeMode ?? "allowed";
    const processConfig = this.provider === "cline"
      ? `:${clineCliProviderId(context)}:${context.model ?? "default"}:${context.effort ?? "default"}`
      : "";
    return `acp:${this.provider}:${command}:${writeMode}${processConfig}:${resolve(context.workspaceRoot)}`;
  }

  async createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({
      provider: this.provider,
      agentId: context.agentId,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
        const command = this.resolveCommand();
        if (!command) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            agentId: context.agentId,
            operation: "create_runtime",
            retryable: false,
            message: `${this.provider} executable was not found.`,
          });
        }
        const args = acpCommandArgs(this.provider, context, this.env);
        const child = spawn(command, args, {
          cwd: resolve(context.workspaceRoot),
          env: this.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        });
        let resolveStartupError!: (error: Error) => void;
        const startupError = new Promise<Error>((resolveError) => { resolveStartupError = resolveError; });
        const onStartupError = (error: Error) => { resolveStartupError(error); };
        child.once("error", onStartupError);
        if (!child.stdin || !child.stdout || !child.stderr) {
          child.on("error", observeChildError);
          child.removeListener("error", onStartupError);
          if (child.exitCode === null) {
            const detached = process.platform !== "win32";
            terminateProcessTree(child, "SIGTERM", detached);
            if (!await waitForProcessExit(child, 1_000)) {
              terminateProcessTree(child, "SIGKILL", detached);
            }
          }
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            agentId: context.agentId,
            operation: "create_runtime",
            retryable: false,
            message: `${this.provider} ACP process did not expose stdio pipes.`,
          });
        }

        let connection: AcpConnectionLike | undefined;
        child.stderr.setEncoding("utf8");
        let stderrTail = "";
        child.stderr.on("data", (chunk: string) => {
          stderrTail = appendTail(stderrTail, chunk, MAX_ACP_STDERR_BYTES);
        });
        try {
          const { client, methods, ndJsonStream } = await import("@agentclientprotocol/sdk");
          const queues = new Map<string, AcpSessionQueue>();
          const sessionWriteModes = new Map<string, LocalAgentWriteMode>();
          const activityCallbacks = new Map<string, () => void | Promise<void>>();
          const grokCompletionRegistry = this.provider === "grok"
            ? new GrokPromptCompletionRegistry()
            : undefined;
          const app = client({ name: "DevSpace" })
            .onRequest(methods.client.session.requestPermission, (context) => {
              const writeMode = sessionWriteModes.get(context.params.sessionId);
              const selected = selectAcpPermissionOption(context.params.options, writeMode, this.provider);
              return selected
                ? { outcome: { outcome: "selected", optionId: selected.optionId } }
                : { outcome: { outcome: "cancelled" } };
            })
            .onNotification(methods.client.session.update, (context) => {
              void activityCallbacks.get(context.params.sessionId)?.();
              const sessionId = context.params.sessionId;
              const queue = queues.get(sessionId);
              if (queue) appendAcpQueueValue(queue, context.params);
            });
          if (grokCompletionRegistry) {
            for (const method of [
              "x.ai/session/prompt_complete",
              "_x.ai/session/prompt_complete",
              "x.ai/session/update",
              "_x.ai/session/update",
            ]) {
              app.onNotification(method, parseGrokPromptCompletion, (context) => {
                if (context.params) grokCompletionRegistry.resolve(context.params);
              });
            }
          }
          const stream = ndJsonStream(
            Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
          );
          connection = app.connect(stream) as unknown as AcpConnectionLike;
          const init = await withTimeout(Promise.race([
            connection.agent.request(methods.agent.initialize, {
              protocolVersion: 1,
              clientInfo: { name: "DevSpace", version: DEVSPACE_VERSION },
              clientCapabilities: {},
            }),
            startupError.then((error) => { throw error; }),
          ]),
          ACP_INITIALIZE_TIMEOUT_MS,
          `${this.provider} ACP initialize timed out.`,
          );
          const capabilities = readAcpCapabilities(init);
          const runtime = new AcpRuntime({
            provider: this.provider,
            command,
            args,
            env: this.env,
            child,
            capabilities,
            queues,
            sessionWriteModes,
            grokCompletionRegistry,
            activityCallbacks,
            stderrTail: () => stderrTail,
            diagnosticObserver: this.diagnosticObserver,
          }, connection);
          // AcpRuntime installs the long-lived child error listener before this
          // startup-only listener is removed, so there is no unobserved gap.
          child.removeListener("error", onStartupError);
          return runtime;
        } catch (error) {
          child.on("error", observeChildError);
          child.removeListener("error", onStartupError);
          try {
            connection?.close(error);
          } catch {
            // The child still needs to be terminated if the protocol failed early.
          }
          if (child.exitCode === null) {
            const detached = process.platform !== "win32";
            terminateProcessTree(child, "SIGTERM", detached);
            if (!await waitForProcessExit(child, 1_000)) {
              terminateProcessTree(child, "SIGKILL", detached);
            }
          }
          if (isProgrammerDefect(error)) throw error;
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            agentId: context.agentId,
            operation: "create_runtime",
            retryable: true,
            cause: { error, stderr: stderrTail.trim() || undefined },
            message: `${this.provider} ACP initialization failed.`,
          });
        }
      },
    });
  }

  private resolveCommand(): string | undefined {
    if (!this.commandResolved) {
      this.resolvedCommand = this.commandResolver(this.provider, this.env);
      this.commandResolved = true;
    }
    return this.resolvedCommand;
  }
}

async function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export function resolveAcpCommand(
  provider: AcpProvider,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (provider === "grok") {
    return resolveGrokExecutable(env);
  }
  if (provider === "cline") {
    return resolveClineExecutable(env);
  }
  const configured = provider === "cursor"
    ? env.CURSOR_COMMAND
    : env.COPILOT_COMMAND;
  const command = configured ?? ACP_COMMANDS[provider][0];
  if (command.includes("/") || command.includes("\\")) return executableExists(command) ? command : undefined;
  const path = env.PATH;
  if (!path) return undefined;
  const extensions = process.platform === "win32"
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`);
      if (executableExists(candidate)) return candidate;
    }
  }
  return undefined;
}

export type AcpCommandResolver = (provider: AcpProvider, env: NodeJS.ProcessEnv) => string | undefined;

export function acpCommandArgs(
  provider: AcpProvider,
  context: LocalAgentRuntimeContext,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const writeMode = context.writeMode ?? "allowed";
  if (provider === "cursor") {
    return [
      "acp",
      "--sandbox", writeMode === "full_access" ? "disabled" : "enabled",
      "--workspace", resolve(context.workspaceRoot),
      ...(writeMode === "read_only" ? ["--mode", "plan"] : []),
      ...(writeMode === "full_access" ? ["--force"] : []),
    ];
  }
  if (provider === "cline") {
    return [
      "--acp",
      "--provider", clineCliProviderId(context),
      ...(context.model ? ["--model", context.model] : []),
      ...(context.effort ? ["--thinking", context.effort] : []),
      ...(writeMode === "read_only" ? ["--plan"] : []),
      "--auto-approve",
    ];
  }
  if (provider === "grok") {
    const agentProfile = env.GROK_AGENT_PROFILE?.trim();
    const effort = context.effort
      ? resolveGrokEffort(context.effort, undefined, undefined)
      : undefined;
    return [
      "agent",
      ...(agentProfile ? ["--agent-profile", agentProfile] : []),
      ...(effort ? ["--reasoning-effort", effort] : []),
      "stdio",
    ];
  }
  const sandboxArgs = writeMode === "full_access"
    ? ["--no-sandbox"]
    : ["--experimental", "--sandbox"];
  return [
    "--acp",
    ...sandboxArgs,
    ...(writeMode === "full_access"
      ? ["--allow-all"]
      : ["--allow-all-tools", "--add-dir", resolve(context.workspaceRoot)]),
    "-C", resolve(context.workspaceRoot),
    ...(writeMode === "read_only" ? ["--mode", "plan"] : []),
  ];
}

export function resolveAcpModelConfigUpdate(
  session: unknown,
  model: string,
  provider: string,
  sessionIdOverride?: string,
): { sessionId: string; configId: string; value: string } {
  return resolveAcpSelectConfigUpdate(session, {
    category: "model",
    label: "model",
    provider,
    value: model,
    sessionIdOverride,
  });
}

export function resolveAcpEffortConfigUpdate(
  session: unknown,
  effort: string,
  provider: string,
  sessionIdOverride?: string,
): { sessionId: string; configId: string; value: string } {
  return resolveAcpSelectConfigUpdate(session, {
    category: "thought_level",
    label: "reasoning effort option",
    provider,
    value: effort,
    sessionIdOverride,
  });
}

function resolveAcpSelectConfigUpdate(
  session: unknown,
  options: {
    category: string;
    label: string;
    provider: string;
    value: string;
    sessionIdOverride?: string;
  },
): { sessionId: string; configId: string; value: string } {
  const record = asRecord(session);
  if (!record) throw new Error(`${options.provider} ACP session metadata is missing.`);
  const sessionId = options.sessionIdOverride ?? directString(record?.sessionId);
  if (!sessionId) throw new Error(`${options.provider} ACP session did not return a session id.`);
  const response = asRecord(record?.newSessionResponse) ?? record;
  const configOptions = readArray(response, "configOptions") ?? [];
  const config = configOptions
    .map(asRecord)
    .find((option) => option?.type === "select" && option.category === options.category);
  if (!config) throw new Error(`${options.provider} ACP server does not expose a ${options.label}.`);
  const configId = directString(config.id);
  if (!configId) throw new Error(`${options.provider} ACP ${options.label} is missing an id.`);
  const available = flattenAcpSelectValues(config);
  if (!available.includes(options.value)) {
    const suffix = available.length > 0 ? ` Available values: ${available.join(", ")}.` : "";
    throw new Error(`${options.provider} ACP ${options.label} does not support '${options.value}'.${suffix}`);
  }
  return { sessionId, configId, value: options.value };
}

export function flattenAcpSelectValues(option: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const item of readArray(option, "options") ?? []) {
    const record = asRecord(item);
    const value = directString(record?.value);
    if (value) {
      values.push(value);
      continue;
    }
    for (const nested of readArray(record, "options") ?? []) {
      const nestedValue = directString(asRecord(nested)?.value);
      if (nestedValue) values.push(nestedValue);
    }
  }
  return values;
}

export function selectAcpAllowPermissionOption(
  options: Array<{ optionId: string; kind: string }>,
): { optionId: string } | undefined {
  return selectAcpPermissionOption(options, "allowed");
}

export function selectAcpPermissionOption(
  options: Array<{ optionId: string; kind: string }>,
  writeMode: LocalAgentWriteMode | undefined,
  provider?: AcpProvider,
): { optionId: string } | undefined {
  if (!writeMode) return undefined;
  // Copilot's native sandbox has a per-command escape hatch enabled by
  // default. Normal turns already pass --allow-all-tools, so any permission
  // request that reaches ACP is an attempted escalation (including a
  // sandbox bypass). Cancel it instead of turning an ACP approval into host
  // authority. Full access deliberately keeps the provider's unrestricted
  // behavior.
  if (provider === "copilot" && writeMode !== "full_access") return undefined;
  const selected = writeMode === "read_only"
    ? options.find((option) => option.kind === "reject_once")
      ?? options.find((option) => option.kind === "reject_always")
    : options.find((option) => option.kind === "allow_once")
      ?? options.find((option) => option.kind === "allow_always");
  return selected ? { optionId: selected.optionId } : undefined;
}

function readAcpCapabilities(value: unknown): AcpCapabilities {
  const capabilities = asRecord(asRecord(value)?.agentCapabilities);
  const sessions = asRecord(capabilities?.sessionCapabilities);
  return {
    resume: Boolean(sessions?.resume),
    close: Boolean(sessions?.close),
    additionalDirectories: Boolean(sessions?.additionalDirectories),
  };
}

export function classifyAcpError(
  error: unknown,
  provider: AcpProvider,
  sessionId?: string,
  modelInfo?: { model?: string; variant?: string },
  stderrTail?: string,
): AgentProviderError | undefined {
  const text = `${error instanceof Error ? error.message : String(error)} ${stderrTail ?? ""}`.trim();
  if (/no access to clinepass subscription models/i.test(text)) {
    return new AgentProviderFailureError({
      code: "CLINEPASS_ENTITLEMENT_REQUIRED",
      errorClass: "ENTITLEMENT_REQUIRED",
      provider,
      operation: "run",
      retryable: false,
      model: modelInfo?.model,
      variant: modelInfo?.variant,
      providerSessionId: sessionId,
      providerMessage: text.slice(0, 400),
      message: `ClinePass subscription entitlement required: ${text.slice(0, 400)}`,
    });
  }
  if (/model.*(?:not found|unavailable|unknown)/i.test(text)) {
    return new AgentProviderFailureError({
      code: "PROVIDER_MODEL_UNAVAILABLE",
      errorClass: "MODEL_UNAVAILABLE",
      provider,
      operation: "run",
      retryable: false,
      model: modelInfo?.model,
      variant: modelInfo?.variant,
      providerSessionId: sessionId,
      providerMessage: text.slice(0, 400),
      message: `Requested model is unavailable: ${text.slice(0, 400)}`,
    });
  }
  if (/(unauthorized|unauthenticated|authentication|invalid token|invalid api key|401|403)/i.test(text)) {
    return new AgentProviderFailureError({
      code: "PROVIDER_AUTH_ERROR",
      errorClass: "AUTH_FAILURE",
      provider,
      operation: "run",
      retryable: false,
      model: modelInfo?.model,
      variant: modelInfo?.variant,
      providerSessionId: sessionId,
      providerMessage: text.slice(0, 400),
      message: `Provider authentication failed: ${text.slice(0, 400)}`,
    });
  }
  if (/(quota|capacity|rate limit|resource_exhausted|overloaded|429|503)/i.test(text)) {
    return new AgentProviderFailureError({
      code: "PROVIDER_CAPACITY_ERROR",
      errorClass: "QUOTA_CAPACITY",
      provider,
      operation: "run",
      retryable: true,
      model: modelInfo?.model,
      variant: modelInfo?.variant,
      providerSessionId: sessionId,
      providerMessage: text.slice(0, 400),
      message: `Provider quota or capacity failure: ${text.slice(0, 400)}`,
    });
  }
  return undefined;
}

function extractAcpText(requiredParts: string[], fallbackUpdates: unknown[] = []): string {
  if (requiredParts.length > 0) return requiredParts.join("").trim();
  return fallbackUpdates
    .map((value) => {
      const update = asRecord(asRecord(value)?.update);
      const content = asRecord(update?.content);
      return update?.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string"
        ? content.text
        : "";
    })
    .join("")
    .trim();
}

type ClineSessionIdentity = {
  provider?: string;
  model?: string;
  models: string[];
  providerConfig?: Record<string, unknown>;
  modelConfig?: Record<string, unknown>;
};

function clineSelectionError(message: string): AgentProviderProtocolError {
  return new AgentProviderProtocolError({
    code: "PROVIDER_PROTOCOL_ERROR",
    provider: "cline",
    operation: "configure_session",
    retryable: false,
    message: `Cline ACP route selection failed closed: ${message}`,
  });
}

function readClineSessionIdentity(value: unknown): ClineSessionIdentity {
  const record = asRecord(value);
  const response = asRecord(record?.newSessionResponse) ?? record;
  const configOptions = readArray(response, "configOptions") ?? [];
  const configs = configOptions.map(asRecord).filter((config): config is Record<string, unknown> => Boolean(config));
  const providerConfigs = configs.filter((config) => config.type === "select" && config.id === "provider");
  const modelConfigs = configs.filter((config) => config.type === "select" && config.id === "model");
  if (providerConfigs.length > 1) throw clineSelectionError("Cline ACP advertised duplicate provider config options.");
  if (modelConfigs.length > 1) throw clineSelectionError("Cline ACP advertised duplicate model config options.");
  const providerConfig = providerConfigs[0];
  const modelConfig = modelConfigs[0];
  const models = new Set(flattenAcpSelectValues(modelConfig ?? {}));
  const modelSet = asRecord(response?.models);
  for (const item of readArray(modelSet, "availableModels") ?? []) {
    const modelId = directString(asRecord(item)?.modelId);
    if (modelId) models.add(modelId);
  }
  const modelFromModels = directString(modelSet?.currentModelId);
  const modelFromConfig = directString(modelConfig?.currentValue);
  if (modelFromModels && modelFromConfig && modelFromModels !== modelFromConfig) {
    throw clineSelectionError(`Cline ACP reported conflicting model identities '${modelFromModels}' and '${modelFromConfig}'.`);
  }
  const model = modelFromModels ?? modelFromConfig;
  const provider = directString(providerConfig?.currentValue);
  return {
    provider,
    model,
    models: [...models],
    ...(providerConfig ? { providerConfig } : {}),
    ...(modelConfig ? { modelConfig } : {}),
  };
}

const DIAGNOSTIC_RESPONSE_KEYS = new Set(["stopReason", "sessionId", "usage", "_meta", "result", "error"]);
const DIAGNOSTIC_UPDATE_TYPES = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
]);
const DIAGNOSTIC_CONTENT_TYPES = new Set(["text", "image", "audio", "resource"]);
const MAX_DIAGNOSTIC_TEXT_BYTES = 64 * 1024;

function diagnosticResponseKeys(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) return [];
  return Object.keys(record).filter((key) => DIAGNOSTIC_RESPONSE_KEYS.has(key)).sort();
}

function diagnosticStopReason(value: unknown): string | undefined {
  const stopReason = asRecord(value)?.stopReason;
  return typeof stopReason === "string" && DIAGNOSTIC_STOP_REASONS.has(stopReason) ? stopReason : stopReason === undefined ? undefined : "unknown";
}

const DIAGNOSTIC_STOP_REASONS = new Set(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]);

function diagnosticSessionId(sessionId: string): string {
  if (sessionId.length <= 256) return sessionId;
  return `sha256:${createHash("sha256").update(sessionId).digest("hex")}`;
}

function diagnosticToken(value: unknown, allowed: Set<string>): string {
  return typeof value === "string" && allowed.has(value) ? value : "unknown";
}

function diagnosticUpdateSummary(updates: unknown[]): Pick<AcpDiagnosticObservation, "updateTypes" | "updateContentTypes" | "updateContentBytes"> {
  const updateTypes = new Set<string>();
  const updateContentTypes = new Set<string>();
  let updateContentBytes = 0;
  for (const value of updates) {
    const update = asRecord(asRecord(value)?.update);
    updateTypes.add(diagnosticToken(update?.sessionUpdate, DIAGNOSTIC_UPDATE_TYPES));
    const content = asRecord(update?.content);
    if (!content) continue;
    updateContentTypes.add(diagnosticToken(content.type, DIAGNOSTIC_CONTENT_TYPES));
    if (typeof content.text === "string" && updateContentBytes < MAX_DIAGNOSTIC_TEXT_BYTES) {
      updateContentBytes = Math.min(MAX_DIAGNOSTIC_TEXT_BYTES, updateContentBytes + Buffer.byteLength(content.text, "utf8"));
    }
  }
  return {
    updateTypes: [...updateTypes].sort(),
    updateContentTypes: [...updateContentTypes].sort(),
    updateContentBytes,
  };
}

function isGrokPromptCompletion(value: unknown): boolean {
  const record = asRecord(value);
  return typeof record?.sessionId === "string";
}

async function yieldToAcpQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function hasAcpConfigOptions(value: unknown): boolean {
  const record = asRecord(value);
  const response = asRecord(record?.newSessionResponse) ?? record;
  return Array.isArray(response?.configOptions);
}

export function appendAcpQueueValue(queue: AcpSessionQueue, value: unknown): void {
  const update = asRecord(asRecord(value)?.update);
  const content = asRecord(update?.content);
  const sessionUpdate = update?.sessionUpdate;
  const text = content?.type === "text" && typeof content.text === "string" ? content.text : undefined;
  const isAssistantText = sessionUpdate === "agent_message_chunk" && text !== undefined;
  const isDisposablePreview = ACP_DISPOSABLE_PREVIEW_UPDATES.has(sessionUpdate)
    && (content === undefined || content.type === "text");

  if (isAssistantText) {
    appendAcpRequiredText(queue, text);
    return;
  }

  const bytes = acpValueBytes(value);
  if (!isDisposablePreview) {
    const requiredEvidence = queue.requiredEvidence ?? (queue.requiredEvidence = []);
    const requiredEvidenceBytes = queue.requiredEvidenceBytes ?? 0;
    if (requiredEvidence.length >= MAX_ACP_REQUIRED_EVIDENCE_ITEMS || requiredEvidenceBytes + bytes > MAX_ACP_QUEUE_BYTES) {
      queue.requiredEvidenceTruncated = true;
      return;
    }
    requiredEvidence.push(value);
    queue.requiredEvidenceBytes = requiredEvidenceBytes + bytes;
    return;
  }

  const previewBytes = queue.previewBytes ?? 0;
  if (queue.values.length >= MAX_ACP_QUEUE_ITEMS || previewBytes + bytes > MAX_ACP_QUEUE_BYTES) {
    queue.suppressedPreviewItems = (queue.suppressedPreviewItems ?? 0) + 1;
    queue.suppressedPreviewBytes = (queue.suppressedPreviewBytes ?? 0) + bytes;
    return;
  }
  queue.values.push(value);
  queue.previewBytes = previewBytes + bytes;
}

const ACP_DISPOSABLE_PREVIEW_UPDATES = new Set<unknown>([
  "agent_thought_chunk",
  "plan",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "usage_update",
  "user_message_chunk",
]);

function resetAcpQueue(queue: AcpSessionQueue): void {
  queue.values.length = 0;
  queue.previewBytes = 0;
  queue.suppressedPreviewItems = 0;
  queue.suppressedPreviewBytes = 0;
  queue.requiredEvidence = [];
  queue.requiredEvidenceBytes = 0;
  queue.requiredOutputParts = [];
  queue.requiredOutputBytes = 0;
  queue.requiredOutputTruncated = false;
  queue.requiredEvidenceTruncated = false;
}

function appendAcpRequiredText(queue: AcpSessionQueue, text: string): void {
  if (!text) return;
  const currentBytes = queue.requiredOutputBytes ?? 0;
  const remainingBytes = MAX_ACP_REQUIRED_OUTPUT_BYTES - currentBytes;
  if (remainingBytes <= 0) {
    queue.requiredOutputTruncated = true;
    return;
  }
  const textBytes = Buffer.byteLength(text, "utf8");
  const accepted = textBytes <= remainingBytes ? text : utf8Prefix(text, remainingBytes);
  const acceptedBytes = Buffer.byteLength(accepted, "utf8");
  if (accepted) {
    const parts = queue.requiredOutputParts ?? (queue.requiredOutputParts = []);
    if (parts.length === 0) parts.push(accepted);
    else parts[0] += accepted;
    queue.requiredOutputBytes = currentBytes + acceptedBytes;
  }
  if (acceptedBytes !== textBytes) queue.requiredOutputTruncated = true;
}

function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let prefix = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    prefix += character;
    bytes += characterBytes;
  }
  return prefix;
}

function acpValueBytes(value: unknown): number {
  return boundedAcpValueBytes(value, new Set<object>(), MAX_ACP_QUEUE_BYTES + 1, 0, { count: 0 });
}

function boundedAcpValueBytes(
  value: unknown,
  seen: Set<object>,
  remaining: number,
  depth: number,
  budget: { count: number },
): number {
  if (remaining <= 0) return MAX_ACP_QUEUE_BYTES + 1;
  if (depth > MAX_ACP_VALUE_ESTIMATE_DEPTH || ++budget.count > MAX_ACP_VALUE_ESTIMATE_NODES) {
    return MAX_ACP_QUEUE_BYTES + 1;
  }
  if (value === null) return 4;
  switch (typeof value) {
    case "string": return Math.min(remaining, Buffer.byteLength(value, "utf8") + 2);
    case "number":
    case "boolean": return Math.min(remaining, 8);
    case "undefined": return 4;
    case "bigint": return Math.min(remaining, 24);
    case "function": return 0;
    case "symbol": return 0;
  }
  if (seen.has(value)) return remaining;
  seen.add(value);
  let total = 2;
  if (Array.isArray(value)) {
    for (const item of value) {
      total += boundedAcpValueBytes(item, seen, remaining - total, depth + 1, budget) + 1;
      if (total >= remaining) return MAX_ACP_QUEUE_BYTES + 1;
    }
    return total;
  }
  const record = value as Record<string, unknown>;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    total += Buffer.byteLength(key, "utf8") + 3;
    total += boundedAcpValueBytes(record[key], seen, remaining - total, depth + 1, budget);
    if (total >= remaining) return MAX_ACP_QUEUE_BYTES + 1;
  }
  return total;
}

function acpOutputRetention(queue: AcpSessionQueue): AcpOutputRetentionSummary {
  return {
    previewSuppressedItems: queue.suppressedPreviewItems ?? 0,
    previewSuppressedBytes: queue.suppressedPreviewBytes ?? 0,
    requiredEvidenceItems: queue.requiredEvidence?.length ?? 0,
    requiredEvidenceBytes: queue.requiredEvidenceBytes ?? 0,
    requiredOutputBytes: queue.requiredOutputBytes ?? 0,
    requiredOutputTruncated: queue.requiredOutputTruncated ?? false,
    requiredEvidenceTruncated: queue.requiredEvidenceTruncated ?? false,
  };
}

function emptyAcpOutputRetention(): AcpOutputRetentionSummary {
  return {
    previewSuppressedItems: 0,
    previewSuppressedBytes: 0,
    requiredEvidenceItems: 0,
    requiredEvidenceBytes: 0,
    requiredOutputBytes: 0,
    requiredOutputTruncated: false,
    requiredEvidenceTruncated: false,
  };
}

function appendTail(current: string, chunk: string, maxBytes: number): string {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  return Buffer.from(next, "utf8").subarray(-maxBytes).toString("utf8");
}

function executableExists(command: string): boolean {
  try {
    accessSync(command, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readDevspaceVersion(): string {
  const packageJson = require("../package.json") as { version?: unknown };
  if (typeof packageJson.version !== "string" || !packageJson.version) {
    throw new Error("Unable to read DevSpace package version.");
  }
  return packageJson.version;
}

function readArray(value: unknown, key: string): unknown[] | undefined {
  const result = asRecord(value)?.[key];
  return Array.isArray(result) ? result : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const result = asRecord(value)?.[key];
  return typeof result === "string" ? result : undefined;
}

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
