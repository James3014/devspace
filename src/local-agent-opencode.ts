import type {
  ModelRef,
  OpencodeClient,
  PromptInput,
  PermissionConfig,
  ServerOptions,
  SessionMessagesResponse,
  SessionV2Info,
} from "@opencode-ai/sdk/v2";
import {
  AgentProviderFailureError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
  type AgentProviderFailureClass,
  type AgentProviderFailureCode,
} from "./local-agent-errors.js";
import { getOpencodeCatalogGeneration } from "./local-agent-opencode-catalog.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";

const OPENCODE_SESSION_POLL_INTERVAL_MS = 250;
const OPENCODE_SESSION_POLL_TIMEOUT_MS = 5 * 60_000;
const MAX_OPENCODE_RETAINED_HISTORY_MESSAGES = 256;
const MAX_OPENCODE_RETAINED_TURN_MESSAGES = 128;
const MAX_OPENCODE_RETAINED_HISTORY_BYTES = 512 * 1024;
const MAX_OPENCODE_RETAINED_TURN_BYTES = 512 * 1024;
const MAX_OPENCODE_REQUIRED_EVIDENCE_BYTES = 1024 * 1024;

interface OpencodeRetentionEvidence {
  suppressedMessages: number;
  suppressedBytes: number;
  suppressedBytesAreEstimate: true;
}

export type OpencodeClientLike = Pick<OpencodeClient, "v2">;

export interface OpencodeServerLike {
  close(): void;
}

export type OpencodeFactory = (context?: LocalAgentRuntimeContext) => Promise<{
  client: OpencodeClientLike;
  server: OpencodeServerLike;
}>;

export class OpencodeRuntime implements LocalAgentRuntime {
  readonly provider = "opencode" as const;
  private alive = true;
  private closed = false;

  constructor(
    private readonly client: OpencodeClientLike,
    private readonly server: OpencodeServerLike,
  ) {}

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks) {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "run",
      run: async (): Promise<LocalAgentRunResult> => {
        if (!this.alive) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            operation: "run",
            retryable: true,
            message: "OpenCode runtime is not running.",
          });
        }
        try {
          const notifyActivity = bestEffortActivityNotifier(callbacks?.onActivity);
          await assertOpencodeHealthy(this.client);
          notifyActivity();
          const resumed = Boolean(input.providerSessionId);
          const initialModel = input.model ? parseOpencodeModel(input.model, input.effort) : undefined;
          const sessionId = input.providerSessionId ?? await createOpencodeSession(this.client, input, initialModel);
          await callbacks?.onSessionId?.(sessionId);
          notifyActivity();
          await this.client.v2.session.switchAgent({
            sessionID: sessionId,
            agent: opencodeAgentFor(input.writeMode),
          }, { throwOnError: true });

          const model = initialModel ?? (input.effort ? await modelWithEffort(this.client, sessionId, input.effort) : undefined);
          if (model && (resumed || !initialModel)) {
            await this.client.v2.session.switchModel({ sessionID: sessionId, model }, { throwOnError: true });
          }
          const promptResult = await promptOpencodeSession(this.client, sessionId, input);
          notifyActivity();
          const modelInfo = {
            model: input.model,
            variant: initialModel?.variant ?? input.effort,
          };
          const promptFailure = extractOpencodeFailureFromPayload(promptResult, sessionId, modelInfo);
          if (promptFailure) throw promptFailure;
          const promptId = extractOpenCodePromptId(promptResult);
          if (!promptId) {
            throw new AgentProviderProtocolError({
              code: "PROVIDER_PROTOCOL_ERROR",
              provider: this.provider,
              operation: "run",
              retryable: false,
              message: "OpenCode did not acknowledge the current prompt with a message id.",
            });
          }
          await waitForOpencodeSession(this.client, sessionId, promptResult, notifyActivity, modelInfo);
          const messages = await readOpencodeMessages(this.client, sessionId, promptId);
          const finalResponse = requireFinalResponse(
            extractOpenCodeFinalResponseForPrompt(messages, promptId),
            {
            sessionId,
            promptId,
            model: modelInfo.model,
            finish: extractLatestOpenCodeAssistantFinish(messages, promptId),
            messageCount: messages.data?.length ?? 0,
            },
          );
          return {
            provider: this.provider,
            providerSessionId: sessionId,
            finalResponse,
            items: [promptResult, messages],
          };
        } catch (error) {
          if (isOpenCodeTransportFailure(error)) {
            this.alive = false;
            throw new AgentProviderUnavailableError({
              code: "PROVIDER_UNAVAILABLE",
              provider: this.provider,
              operation: "run",
              retryable: true,
              cause: error,
              message: "OpenCode provider is unavailable.",
            });
          }
          throw error;
        }
      },
    });
  }

  async releaseSession(_providerSessionId: string): Promise<void> {
    // OpenCode keeps durable sessions independently of this process.
  }

  isAlive(): boolean {
    return this.alive && !this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    this.server.close();
  }
}

export class OpencodeLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "opencode" as const;
  readonly executionActivityCapability = "TRUSTWORTHY" as const;
  readonly idleTimeoutMs = 5 * 60_000;

  constructor(
    factory?: OpencodeFactory,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.factory = factory ?? ((context) => defaultOpencodeFactory(this.env, context));
  }

  private readonly factory: OpencodeFactory;

  runtimeKey(_context: LocalAgentRuntimeContext): string {
    return `opencode:default:${getOpencodeCatalogGeneration()}`;
  }

  async createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({
      provider: this.provider,
      agentId: context.agentId,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
        const { client, server } = await this.factory(context);
        return new OpencodeRuntime(client, server);
      },
    });
  }
}

export const DEFAULT_OPENCODE_STARTUP_TIMEOUT_MS = 30_000;
export const MAX_OPENCODE_STARTUP_TIMEOUT_MS = 120_000;

export function resolveOpencodeStartupTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DEVSPACE_OPENCODE_STARTUP_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_OPENCODE_STARTUP_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_OPENCODE_STARTUP_TIMEOUT_MS;
  }
  return Math.min(parsed, MAX_OPENCODE_STARTUP_TIMEOUT_MS);
}

export type OpencodeSdkModuleLike = {
  createOpencode: (options?: ServerOptions) => Promise<{
    client: OpencodeClientLike;
    server: OpencodeServerLike;
  }>;
};

export async function defaultOpencodeFactory(
  env: NodeJS.ProcessEnv = process.env,
  _context?: LocalAgentRuntimeContext,
  loadSdk: () => Promise<OpencodeSdkModuleLike> = () => import("@opencode-ai/sdk/v2"),
): Promise<{ client: OpencodeClientLike; server: OpencodeServerLike }> {
  const { createOpencode } = await loadSdk();
  return createOpencode({
    timeout: resolveOpencodeStartupTimeoutMs(env),
    config: {
      agent: {
        devspace_read_only: opencodeAgentConfig("read_only"),
        devspace_allowed: opencodeAgentConfig("allowed"),
        devspace_full_access: opencodeAgentConfig("full_access"),
      },
    },
  });
}

export function opencodeAgentConfig(writeMode: LocalAgentRunInput["writeMode"]): {
  mode: "primary";
  permission: PermissionConfig;
} {
  return {
    mode: "primary",
    permission: opencodePermissionFor(writeMode),
  };
}

async function createOpencodeSession(
  client: OpencodeClientLike,
  input: LocalAgentRunInput,
  model?: ModelRef,
): Promise<string> {
  const result = await client.v2.session.create({
    location: { directory: input.workspaceRoot },
    agent: opencodeAgentFor(input.writeMode),
    ...(model ? { model } : {}),
  }, { throwOnError: true });
  return requireSessionId(result.data.data);
}

export function opencodeAgentFor(writeMode: LocalAgentRunInput["writeMode"]): string {
  switch (writeMode) {
    case "read_only": return "devspace_read_only";
    case "full_access": return "devspace_full_access";
    case "allowed":
    case undefined: return "devspace_allowed";
  }
}

export function opencodePermissionFor(writeMode: LocalAgentRunInput["writeMode"]): PermissionConfig {
  const allowed = writeMode !== "read_only";
  const unrestricted = writeMode === "full_access";
  return {
    read: "allow",
    edit: allowed ? "allow" : "deny",
    glob: "allow",
    grep: "allow",
    list: "allow",
    bash: allowed ? "allow" : "deny",
    task: "deny",
    external_directory: unrestricted ? "allow" : "deny",
  };
}

async function assertOpencodeHealthy(client: OpencodeClientLike): Promise<void> {
  const health = client.v2.health;
  if (!health) return;
  try {
    await health.get({ throwOnError: true });
  } catch (error) {
    throw new OpencodeHealthError(errorMessage(error));
  }
}

function isOpenCodeTransportFailure(error: unknown): boolean {
  if (error instanceof OpencodeHealthError) return true;
  const code = transportErrorCode(error);
  return code === "ECONNREFUSED"
    || code === "ECONNRESET"
    || code === "EPIPE"
    || code === "ENETDOWN"
    || code === "ENETUNREACH"
    || code === "ETIMEDOUT";
}

function transportErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string") return code;
  const cause = (error as Error & { cause?: unknown }).cause;
  return cause && typeof cause === "object" && typeof (cause as NodeJS.ErrnoException).code === "string"
    ? (cause as NodeJS.ErrnoException).code
    : undefined;
}

class OpencodeHealthError extends Error {
  constructor(message: string) {
    super(`OpenCode server health check failed: ${message}`);
    this.name = "OpencodeHealthError";
  }
}

async function modelWithEffort(
  client: OpencodeClientLike,
  sessionId: string,
  effort: string,
): Promise<ModelRef> {
  const result = await client.v2.session.get({ sessionID: sessionId }, { throwOnError: true });
  const model = result.data.data.model;
  if (!model) {
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "opencode",
      operation: "resolve_model",
      retryable: false,
      message: "OpenCode did not return the current session model for an effort override.",
    });
  }
  return { ...model, variant: effort };
}

async function promptOpencodeSession(
  client: OpencodeClientLike,
  sessionId: string,
  input: LocalAgentRunInput,
): Promise<unknown> {
  const prompt: PromptInput = { text: input.prompt };
  return client.v2.session.prompt({
    sessionID: sessionId,
    prompt,
  }, { throwOnError: true });
}

async function waitForOpencodeSession(
  client: OpencodeClientLike,
  sessionId: string,
  promptResult: unknown,
  onActivity?: () => void,
  modelInfo: { model?: string; variant?: string } = {},
): Promise<void> {
  // OpenCode 1.18 accepts the prompt before its foreground drain is ready.
  // Its wait endpoint rejects that state and can keep rejecting after the
  // session has completed, so use the v2 active-session lifecycle instead.
  const active = typeof client.v2.session.active === "function"
    ? client.v2.session.active.bind(client.v2.session)
    : undefined;
  if (!active) {
    await client.v2.session.wait({ sessionID: sessionId }, { throwOnError: true });
    return;
  }

  const promptId = extractOpenCodePromptId(promptResult);
  const deadline = Date.now() + OPENCODE_SESSION_POLL_TIMEOUT_MS;
  let observedActive = false;
  let previousActivityFingerprint: string | undefined;
  while (true) {
    const messages = await readOpencodeMessages(client, sessionId, promptId);
    // Root-cause fail-fast: any provider-reported failure terminal-immediately
    // with the original failure class. Never wait for an idle timeout shadow.
    const failure = extractOpencodeFailureFromMessages(messages, sessionId, modelInfo, promptId)
      ?? extractOpencodeFailureFromPayload(promptResult, sessionId, modelInfo);
    if (failure) throw failure;
    const activity = await active({ throwOnError: true });
    const running = isOpenCodeSessionActive(activity, sessionId);
    if (running) observedActive = true;
    const latestMessage = messages.data?.at(-1);
    const activityFingerprint = JSON.stringify({
      running,
      messageCount: messages.data?.length ?? 0,
      latestMessage,
    });
    if (activityFingerprint !== previousActivityFingerprint) {
      previousActivityFingerprint = activityFingerprint;
      onActivity?.();
    }

    const completed = hasCompletedOpenCodeTurn(messages, promptId);
    if (completed && (promptId !== undefined || (observedActive && !running))) return;
    if (Date.now() >= deadline) {
      throw new AgentProviderProtocolError({
        code: "PROVIDER_PROTOCOL_ERROR",
        provider: "opencode",
        operation: "wait_for_session",
        retryable: false,
        message: "OpenCode did not finish the session before the provider timeout.",
      });
    }
    await delay(OPENCODE_SESSION_POLL_INTERVAL_MS);
  }
}

function bestEffortActivityNotifier(callback?: () => void | Promise<void>): () => void {
  let pending = false;
  return () => {
    if (!callback || pending) return;
    pending = true;
    try {
      Promise.resolve(callback()).catch(() => undefined).finally(() => { pending = false; });
    } catch {
      pending = false;
    }
  };
}

async function readOpencodeMessages(
  client: OpencodeClientLike,
  sessionId: string,
  promptId?: string,
): Promise<SessionMessagesResponse> {
  const messages: SessionMessagesResponse["data"] = [];
  const seenCursors = new Set<string>();
  const retention: OpencodeRetentionEvidence = { suppressedMessages: 0, suppressedBytes: 0, suppressedBytesAreEstimate: true };
  let cursor: string | undefined;

  while (true) {
    const result = await client.v2.session.messages({
      sessionID: sessionId,
      limit: 100,
      ...(cursor ? { cursor } : { order: "asc" }),
    }, { throwOnError: true });
    const page = result.data;
    for (const message of page.data) {
      messages.push(message);
      retainBoundedOpencodeMessages(messages, promptId, retention);
    }

    // A prompt-specific read can stop as soon as the submitted turn is
    // complete. Reads without a prompt id still walk the full history because
    // they are used to extract the final response after the wait fallback.
    if (promptId !== undefined && hasCompletedOpenCodeTurn({ data: messages }, promptId)) {
      break;
    }

    const nextCursor = page.cursor?.next;
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  if (promptId !== undefined && hasOpenCodeLaterUserTurn(messages, promptId)
    && !hasCompletedOpenCodeTurn({ data: messages }, promptId)) {
    throw opencodeRetentionFailure("current-turn final response was not retained before a later user turn");
  }

  return { data: messages, cursor: {}, retention } as SessionMessagesResponse & { retention: OpencodeRetentionEvidence };
}

function hasOpenCodeLaterUserTurn(messages: SessionMessagesResponse["data"], promptId: string): boolean {
  const promptIndex = messages.findIndex((message) => {
    const record = asRecord(message);
    const info = asRecord(record?.info) ?? record;
    return info?.id === promptId && (info?.role === "user" || record?.type === "user");
  });
  if (promptIndex < 0) return false;
  return messages.slice(promptIndex + 1).some((message) => {
    const record = asRecord(message);
    const info = asRecord(record?.info) ?? record;
    return info?.role === "user" || record?.type === "user";
  });
}

function retainBoundedOpencodeMessages(
  messages: SessionMessagesResponse["data"],
  promptId?: string,
  retention: OpencodeRetentionEvidence = { suppressedMessages: 0, suppressedBytes: 0, suppressedBytesAreEstimate: true },
): void {
  const promptIndex = promptId === undefined ? -1 : messages.findIndex((message) => {
    const record = asRecord(message);
    const info = asRecord(record?.info) ?? record;
    return info?.id === promptId && (info?.role === "user" || record?.type === "user");
  });
  const nextUserIndex = promptIndex < 0 ? -1 : messages.slice(promptIndex + 1).findIndex((message) => {
    const record = asRecord(message);
    const info = asRecord(record?.info) ?? record;
    return info?.role === "user" || record?.type === "user";
  });
  const turnEnd = nextUserIndex < 0 ? messages.length : promptIndex + 1 + nextUserIndex;
  if (promptIndex >= 0) {
    const currentTurn = messages.slice(promptIndex, turnEnd);
    let terminalIndex = -1;
    for (let index = currentTurn.length - 1; index >= 0; index -= 1) {
      const message = currentTurn[index];
      const record = asRecord(message);
      const info = asRecord(record?.info) ?? record;
      const role = typeof info?.role === "string" ? info.role : record?.type;
      const finish = typeof info?.finish === "string" ? info.finish : record?.finish;
      if (role === "assistant" && isTerminalOpenCodeFinish(finish)) { terminalIndex = index; break; }
    }
    const terminal = terminalIndex >= 0 ? currentTurn[terminalIndex] : undefined;
    const finalText = terminal === undefined ? "" : extractOpenCodeAssistantMessageText(terminal);
    if (terminal !== undefined && boundedMessageBytes(terminal, MAX_OPENCODE_REQUIRED_EVIDENCE_BYTES + 1) > MAX_OPENCODE_REQUIRED_EVIDENCE_BYTES) {
      throw opencodeRetentionFailure("current-turn terminal evidence exceeds the retained evidence bound");
    }
    if (Buffer.byteLength(finalText, "utf8") > MAX_OPENCODE_RETAINED_TURN_BYTES) {
      throw opencodeRetentionFailure("current-turn final response exceeds the retained evidence bound");
    }
    const prompt = currentTurn[0]!;
    const promptBytes = boundedMessageBytes(prompt, MAX_OPENCODE_RETAINED_TURN_BYTES + 1);
    if (promptBytes > MAX_OPENCODE_RETAINED_TURN_BYTES) {
      throw opencodeRetentionFailure("current-turn prompt exceeds the retained evidence bound");
    }
    const progress = currentTurn.filter((_, index) => index !== 0 && index !== terminalIndex);
    const requiredErrors = progress.filter((message) => {
      const record = asRecord(message);
      const info = asRecord(record?.info);
      return record?.error !== undefined || info?.error !== undefined;
    });
    if (requiredErrors.length > MAX_OPENCODE_RETAINED_TURN_MESSAGES) {
      throw opencodeRetentionFailure("current-turn error evidence exceeds the retained item bound");
    }
    const requiredErrorBytes = requiredErrors.reduce((total, message) => total + boundedMessageBytes(message, MAX_OPENCODE_REQUIRED_EVIDENCE_BYTES + 1), 0);
    if (requiredErrorBytes > MAX_OPENCODE_REQUIRED_EVIDENCE_BYTES) {
      throw opencodeRetentionFailure("current-turn error evidence exceeds the retained evidence bound");
    }
    const retainedProgress: SessionMessagesResponse["data"] = [...requiredErrors];
    let progressBytes = requiredErrorBytes;
    const progressLimit = MAX_OPENCODE_RETAINED_TURN_MESSAGES - 1 - (terminal === undefined ? 0 : 1);
    for (let index = progress.length - 1; index >= 0 && retainedProgress.length < progressLimit; index -= 1) {
      const message = progress[index]!;
      if (requiredErrors.includes(message)) continue;
      const bytes = boundedMessageBytes(message, MAX_OPENCODE_RETAINED_TURN_BYTES + 1);
      if (bytes > MAX_OPENCODE_RETAINED_TURN_BYTES - promptBytes - progressBytes) continue;
      retainedProgress.push(message);
      progressBytes += bytes;
    }
    retainedProgress.reverse();
    retainedProgress.sort((left, right) => currentTurn.indexOf(left) - currentTurn.indexOf(right));
    const retainedTurn = [prompt, ...retainedProgress, ...(terminal === undefined ? [] : [terminal])];
    const nextUser = nextUserIndex >= 0 ? messages[turnEnd] : undefined;
    if (nextUser !== undefined && boundedMessageBytes(nextUser, MAX_OPENCODE_REQUIRED_EVIDENCE_BYTES + 1) > MAX_OPENCODE_REQUIRED_EVIDENCE_BYTES) {
      throw opencodeRetentionFailure("later-user boundary evidence exceeds the retained evidence bound");
    }
    const droppedBefore = messages.slice(0, promptIndex);
    const retainedSet = new Set(retainedTurn);
    const droppedCurrent = currentTurn.filter((message) => !retainedSet.has(message));
    const droppedAfterBoundary = messages.slice(turnEnd + (nextUserIndex >= 0 ? 1 : 0));
    const dropped = [...droppedBefore, ...droppedCurrent, ...droppedAfterBoundary];
    retention.suppressedMessages += dropped.length;
    retention.suppressedBytes += dropped.reduce((total, message) => total + boundedMessageBytes(message), 0);
    messages.splice(0, messages.length, ...retainedTurn, ...(nextUser ? [nextUser] : []));
    return;
  }
  if (messages.length <= MAX_OPENCODE_RETAINED_HISTORY_MESSAGES
    && messages.reduce((total, message) => total + boundedMessageBytes(message), 0) <= MAX_OPENCODE_RETAINED_HISTORY_BYTES) return;
  const retained: SessionMessagesResponse["data"] = [];
  let retainedBytes = 0;
  for (let index = messages.length - 1; index >= 0 && retained.length < MAX_OPENCODE_RETAINED_HISTORY_MESSAGES; index -= 1) {
    const message = messages[index]!;
    const bytes = boundedMessageBytes(message, MAX_OPENCODE_RETAINED_HISTORY_BYTES + 1);
    if (bytes > MAX_OPENCODE_RETAINED_HISTORY_BYTES - retainedBytes) continue;
    retained.push(message);
    retainedBytes += bytes;
  }
  retained.reverse();
  const retainedSet = new Set(retained);
  const dropped = messages.filter((message) => !retainedSet.has(message));
  retention.suppressedMessages += dropped.length;
  retention.suppressedBytes += dropped.reduce((total, message) => total + boundedMessageBytes(message), 0);
  messages.splice(0, messages.length, ...retained);
}

function boundedMessageBytes(message: unknown, limit = MAX_OPENCODE_RETAINED_HISTORY_BYTES + 1): number {
  return boundedValueBytes(message, limit);
}

function boundedValueBytes(value: unknown, limit: number, depth = 0, state = { nodes: 0 }): number {
  if (limit <= 0) return 0;
  if (state.nodes++ > 2048) return limit + 1;
  if (value === null || value === undefined) return 4;
  if (typeof value === "string") return Math.min(limit, Buffer.byteLength(value, "utf8"));
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return Math.min(limit, String(value).length);
  if (depth >= 6) return limit + 1;
  if (Array.isArray(value)) {
    let total = 2;
    if (value.length > 512) return limit + 1;
    for (const item of value) {
      total += boundedValueBytes(item, limit - total, depth + 1, state);
      if (total >= limit) return limit;
    }
    return Math.min(limit, total);
  }
  const record = asRecord(value);
  if (!record) return 16;
  let total = 2;
  let entryCount = 0;
  for (const key in record) {
    if (++entryCount > 128) return limit + 1;
    const item = record[key];
    total += Buffer.byteLength(key, "utf8") + boundedValueBytes(item, limit - total, depth + 1, state);
    if (total >= limit) return limit;
  }
  return Math.min(limit, total);
}

function opencodeRetentionFailure(message: string): AgentProviderProtocolError {
  return new AgentProviderProtocolError({
    code: "PROVIDER_PROTOCOL_ERROR",
    provider: "opencode",
    operation: "retain_session_messages",
    retryable: false,
    message: `OpenCode retained evidence is incomplete: ${message}.`,
  });
}

function extractOpenCodePromptId(value: unknown): string | undefined {
  const id = asRecord(unwrapProviderPayload(value))?.id;
  return typeof id === "string" ? id : undefined;
}

function isOpenCodeSessionActive(value: unknown, sessionId: string): boolean {
  const activeSessions = asRecord(unwrapProviderPayload(value));
  return activeSessions?.[sessionId] !== undefined;
}

function hasCompletedOpenCodeTurn(value: unknown, promptId?: string): boolean {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (!messages) return false;

  let promptSeen = promptId === undefined;
  for (const message of messages) {
    const record = asRecord(message);
    if (!record) continue;
    const info = asRecord(record.info) ?? record;
    const role = typeof info.role === "string" ? info.role : record.type;
    if (promptId !== undefined && info.id === promptId && role === "user") {
      promptSeen = true;
      continue;
    }
    if (promptId !== undefined && promptSeen && role === "user") return false;
    if (!promptSeen || role !== "assistant") continue;

    const time = asRecord(info.time) ?? asRecord(record.time);
    const finish = typeof info.finish === "string"
      ? info.finish
      : typeof record.finish === "string" ? record.finish : undefined;
    if (isTerminalOpenCodeFinish(finish)) return true;
    if (info.error !== undefined || record.error !== undefined) return true;
  }
  return false;
}

function isTerminalOpenCodeFinish(value: unknown): boolean {
  return typeof value === "string" && value !== "tool-calls";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseOpencodeModel(model: string, variant?: string): ModelRef {
  const separator = model.indexOf("/");
  const reference = separator === -1
    ? { providerID: "opencode", id: model }
    : { providerID: model.slice(0, separator), id: model.slice(separator + 1) };
  return variant ? { ...reference, variant } : reference;
}

function requireSessionId(session: SessionV2Info): string {
  if (!session.id) {
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "opencode",
      operation: "create_session",
      retryable: false,
      message: "OpenCode did not return a session id.",
    });
  }
  return session.id;
}

export function extractOpenCodeFinalResponse(value: unknown): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (messages) return extractLastOpenCodeAssistantMessageText(messages);
  return extractOpenCodeAssistantMessageText(root);
}

function extractOpenCodeFinalResponseForPrompt(value: unknown, promptId?: string): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (!messages || promptId === undefined) return extractOpenCodeFinalResponse(value);
  return extractLastOpenCodeAssistantMessageText(messagesAfterPrompt(messages, promptId), true);
}

function extractLastOpenCodeAssistantMessageText(messages: unknown[], terminalOnly = false): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    const info = asRecord(message.info);
    const role = typeof info?.role === "string" ? info.role : message.role;
    const type = typeof message.type === "string" ? message.type : undefined;
    if (role !== "assistant" && type !== "assistant") continue;
    if (terminalOnly) {
      const finish = typeof info?.finish === "string" ? info.finish : message.finish;
      if (!isTerminalOpenCodeFinish(finish)) continue;
      return extractOpenCodeAssistantMessageText(message);
    }
    const text = extractOpenCodeAssistantMessageText(message);
    if (text) return text;
  }
  return "";
}

function extractOpenCodeAssistantMessageText(value: unknown): string {
  const message = asRecord(value);
  if (!message) return "";
  for (const key of ["content", "parts"] as const) {
    const parts = readArray(message, key);
    if (!parts) continue;
    const text = parts
      .map((part) => {
        const record = asRecord(part);
        return record?.type === "text" && typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text.trim()) return text.trim();
  }
  const info = asRecord(message.info) ?? message;
  return stringifyStructuredMessage(info.structured);
}

function extractLatestOpenCodeAssistantFinish(value: unknown, promptId?: string): string | undefined {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (!messages) return undefined;
  const scopedMessages = promptId === undefined ? messages : messagesAfterPrompt(messages, promptId);
  for (let index = scopedMessages.length - 1; index >= 0; index -= 1) {
    const record = asRecord(scopedMessages[index]);
    if (!record) continue;
    const info = asRecord(record.info) ?? record;
    const role = typeof info.role === "string" ? info.role : record.type;
    if (role !== "assistant") continue;
    const finish = typeof info.finish === "string"
      ? info.finish
      : typeof record.finish === "string" ? record.finish : undefined;
    if (finish !== undefined) return finish;
  }
  return undefined;
}

function messagesAfterPrompt(messages: unknown[], promptId: string): unknown[] {
  const promptIndex = messages.findIndex((message) => {
    const record = asRecord(message);
    if (!record) return false;
    const info = asRecord(record.info) ?? record;
    const role = typeof info.role === "string" ? info.role : record.type;
    return role === "user" && info.id === promptId;
  });
  if (promptIndex < 0) return [];
  const nextPromptOffset = messages.slice(promptIndex + 1).findIndex((message) => {
    const record = asRecord(message);
    if (!record) return false;
    const info = asRecord(record.info) ?? record;
    const role = typeof info.role === "string" ? info.role : record.type;
    return role === "user";
  });
  return nextPromptOffset < 0
    ? messages.slice(promptIndex + 1)
    : messages.slice(promptIndex + 1, promptIndex + 1 + nextPromptOffset);
}

function stringifyStructuredMessage(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  return JSON.stringify(value);
}

function unwrapProviderPayload(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    const record = asRecord(current);
    if (!record) return current;
    if (record.data !== undefined) {
      current = record.data;
      continue;
    }
    if (record.result !== undefined) {
      current = record.result;
      continue;
    }
    return current;
  }
  return current;
}

function readArray(value: unknown, key: string): unknown[] | undefined {
  const result = asRecord(value)?.[key];
  return Array.isArray(result) ? result : undefined;
}

function readNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) current = asRecord(current)?.[key];
  return typeof current === "string" ? current : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export interface OpencodeFailureInfo {
  code: AgentProviderFailureCode;
  errorClass: AgentProviderFailureClass;
  retryable: boolean;
  message: string;
}

/**
 * Classifies a provider-reported failure string into the typed root-cause
 * taxonomy. Provider class names (SessionRunnerModel.*Error) take precedence,
 * then generic provider error text. Unknown failures return undefined so the
 * caller keeps existing semantics instead of inventing a wrong class.
 */
export function classifyOpencodeProviderError(raw: string): OpencodeFailureInfo | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (/VariantUnavailable/i.test(text)
    || /variant.{0,24}(unavailable|not (found|supported)|unknown variant)/i.test(text)) {
    return {
      code: "PROVIDER_VARIANT_UNAVAILABLE",
      errorClass: "VARIANT_UNAVAILABLE",
      retryable: false,
      message: `Requested reasoning variant is unavailable on this model: ${truncateErrorText(text)}`,
    };
  }
  if (/ModelUnavailable/i.test(text)
    || /model.{0,24}(unavailable|not (found|supported)|unknown model|does not exist)/i.test(text)) {
    return {
      code: "PROVIDER_MODEL_UNAVAILABLE",
      errorClass: "MODEL_UNAVAILABLE",
      retryable: false,
      message: `Requested model is unavailable on this provider: ${truncateErrorText(text)}`,
    };
  }
  if (/(unauthorized|unauthenticated|authentication|invalid api key|invalid token|permission denied|401|403)/i.test(text)) {
    return {
      code: "PROVIDER_AUTH_ERROR",
      errorClass: "AUTH_FAILURE",
      retryable: false,
      message: `Provider authentication failed: ${truncateErrorText(text)}`,
    };
  }
  if (/(quota|capacity|rate limit|resource_exhausted|overloaded|insufficient credits|429|503)/i.test(text)) {
    return {
      code: "PROVIDER_CAPACITY_ERROR",
      errorClass: "QUOTA_CAPACITY",
      retryable: true,
      message: `Provider quota or capacity failure: ${truncateErrorText(text)}`,
    };
  }
  if (/(timeout|timed out|deadline exceeded|etimedout)/i.test(text)) {
    return {
      code: "PROVIDER_TIMEOUT",
      errorClass: "UPSTREAM_TIMEOUT",
      retryable: true,
      message: `Provider upstream timeout: ${truncateErrorText(text)}`,
    };
  }
  return undefined;
}

function truncateErrorText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 400 ? `${normalized.slice(0, 400)}...` : normalized;
}

function extractOpencodeFailureFromMessages(
  response: SessionMessagesResponse,
  sessionId: string,
  modelInfo: { model?: string; variant?: string },
  promptId?: string,
): AgentProviderFailureError | undefined {
  const root = unwrapProviderPayload(response);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (!messages) return undefined;
  const scopedMessages = promptId === undefined ? messages : messagesAfterPrompt(messages, promptId);
  for (let index = scopedMessages.length - 1; index >= 0; index -= 1) {
    const record = asRecord(scopedMessages[index]);
    if (!record) continue;
    const info = asRecord(record.info) ?? record;
    const role = typeof info.role === "string" ? info.role : record.type;
    const errorPayload = info.error ?? record.error;
    if (errorPayload === undefined || errorPayload === null) continue;
    if (role !== undefined && role !== "assistant" && role !== "user") continue;
    return buildOpencodeFailure(errorPayload, sessionId, modelInfo);
  }
  return undefined;
}

function extractOpencodeFailureFromPayload(
  payload: unknown,
  sessionId: string,
  modelInfo: { model?: string; variant?: string },
): AgentProviderFailureError | undefined {
  const record = asRecord(unwrapProviderPayload(payload));
  if (!record) return undefined;
  const info = asRecord(record.info) ?? record;
  const errorPayload = info.error ?? record.error;
  if (errorPayload === undefined || errorPayload === null) return undefined;
  return buildOpencodeFailure(errorPayload, sessionId, modelInfo);
}

function buildOpencodeFailure(
  errorPayload: unknown,
  sessionId: string,
  modelInfo: { model?: string; variant?: string },
): AgentProviderFailureError {
  const text = stringifyOpencodeErrorPayload(errorPayload);
  const classification = classifyOpencodeProviderError(text);
  const resolved = classification ?? {
    code: "PROVIDER_EXECUTION_ERROR" as const,
    errorClass: "PROVIDER_EXECUTION_ERROR" as string,
    retryable: false,
    message: `OpenCode provider reported a session failure: ${truncateErrorText(text)}`,
  };
  return new AgentProviderFailureError({
    code: resolved.code as AgentProviderFailureCode,
    provider: "opencode",
    operation: "run",
    retryable: resolved.retryable,
    errorClass: resolved.errorClass as AgentProviderFailureClass,
    ...(modelInfo.model ? { model: modelInfo.model } : {}),
    ...(modelInfo.variant ? { variant: modelInfo.variant } : {}),
    providerSessionId: sessionId,
    providerMessage: truncateErrorText(text),
    message: resolved.message,
  });
}

function stringifyOpencodeErrorPayload(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (record) {
    const name = typeof record.name === "string" ? record.name : undefined;
    const message = typeof record.message === "string" ? record.message : undefined;
    const dataText = record.data !== undefined ? stringifyOpencodeErrorPayload(record.data) : undefined;
    return [name, message, dataText].filter(Boolean).join(" ");
  }
  return JSON.stringify(value);
}

function requireFinalResponse(
  response: string,
  evidence: { sessionId?: string; model?: string; promptId?: string; finish?: string; messageCount?: number } = {},
): string {
  const trimmed = response.trim();
  if (!trimmed) {
    const diagnostic = [
      evidence.sessionId ? `session=${evidence.sessionId}` : undefined,
      evidence.model ? `model=${evidence.model}` : undefined,
      evidence.promptId ? `prompt=${evidence.promptId}` : undefined,
      evidence.finish ? `finish=${evidence.finish}` : undefined,
      typeof evidence.messageCount === "number" ? `messages=${evidence.messageCount}` : undefined,
    ].filter(Boolean).join(", ");
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "opencode",
      operation: "run",
      retryable: false,
      cause: {
        sessionId: evidence.sessionId,
        model: evidence.model,
        promptId: evidence.promptId,
        finish: evidence.finish,
        messageCount: evidence.messageCount,
      },
      message: `OpenCode did not return a final assistant response${diagnostic ? ` (${diagnostic})` : ""}.`,
    });
  }
  if (evidence.finish && evidence.finish !== "stop" && evidence.finish !== "end_turn") {
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "opencode",
      operation: "run",
      retryable: false,
      message: `OpenCode ended the current turn without a final assistant response (finish=${evidence.finish}).`,
    });
  }
  return trimmed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
