import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import { removeDevspaceNodeModulesBinFromPath } from "./local-agent-path.js";
import {
  createCodexSdkLocalAgentRuntime,
  type LocalAgentRunInput,
  type LocalAgentRunResult,
} from "./local-agent-runtime.js";
import { isObject, isString } from "./value-types.js";

type ProviderValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ProviderValue[]
  | ProviderRecord;
type ProviderRecord = { [key: string]: ProviderValue };
type ProviderRequest = { [key: string]: ProviderValue };

interface OpenCodeClient {
  session: {
    create(parameters?: ProviderRequest, options?: ProviderRequest): Promise<ProviderValue>;
    prompt(parameters?: ProviderRequest, options?: ProviderRequest): Promise<ProviderValue>;
    wait?(parameters?: ProviderRequest, options?: ProviderRequest): Promise<ProviderValue>;
    messages?(parameters?: ProviderRequest, options?: ProviderRequest): Promise<ProviderValue>;
  };
}

export interface LocalAgentAdapter {
  readonly provider: LocalAgentProvider;
  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult>;
}

const ACP_COMMANDS = {
  cursor: ["cursor-agent", "acp"],
  copilot: ["copilot", "--acp"],
} satisfies Record<"cursor" | "copilot", [string, ...string[]]>;
const PI_AGENT_TIMEOUT_MS = 120_000;

export async function runLocalAgentProvider(
  provider: LocalAgentProvider,
  input: LocalAgentRunInput,
): Promise<LocalAgentRunResult> {
  return createLocalAgentAdapter(provider).run(input);
}

export function createLocalAgentAdapter(provider: LocalAgentProvider): LocalAgentAdapter {
  switch (provider) {
    case "codex":
      return new CodexLocalAgentAdapter();
    case "claude":
      return new ClaudeLocalAgentAdapter();
    case "opencode":
      return new OpencodeLocalAgentAdapter();
    case "pi":
      return new PiRpcLocalAgentAdapter();
    case "cursor":
    case "copilot":
      return new AcpLocalAgentAdapter(provider, ACP_COMMANDS[provider]);
  }
}

class CodexLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "codex" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const runtime = await createCodexSdkLocalAgentRuntime();
    return runtime.run(input);
  }
}

class ClaudeLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "claude" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const claudeExecutable = process.env.CLAUDE_COMMAND ?? resolveExecutable("claude");
    const messages = query({
      prompt: input.prompt,
      options: {
        cwd: input.workspace,
        model: input.model,
        // SAFETY: Claude's SDK accepts the adaptive thinking object when the profile enables thinking.
        thinking: input.thinking ? { type: "adaptive" } as const : undefined,
        // SAFETY: Claude's SDK uses EffortLevel for the profile's validated thinking value.
        effort: input.thinking as EffortLevel | undefined,
        resume: input.providerSessionId,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        env: claudeCommandEnvironment(process.env),
        pathToClaudeCodeExecutable: claudeExecutable,
      },
    });

    let providerSessionId = input.providerSessionId ?? null;
    let finalResponse = "";
    const items: unknown[] = [];
    for await (const message of messages) {
      items.push(message);
      // SAFETY: Claude emits JSON-shaped result messages; only the fields below are consumed.
      const record = message as ProviderRecord;
      if (isString(record.session_id)) providerSessionId = record.session_id;
      if (record.type === "result" && isString(record.result)) {
        const resultError = claudeResultError(record);
        if (resultError) throw new Error(resultError);
        finalResponse = record.result;
      }
    }

    finalResponse = requireFinalResponse("Claude", finalResponse);
    return {
      provider: this.provider,
      providerSessionId,
      finalResponse,
      items,
    };
  }
}

function claudeResultError(record: ProviderRecord): string | undefined {
  const subtype = isString(record.subtype) ? record.subtype : undefined;
  const isError = record.is_error === true || subtype?.startsWith("error");
  if (!isError) return undefined;
  const message =
    directString(record.error) ??
    directString(record.message) ??
    directString(record.result) ??
    subtype ??
    "Claude returned an error result.";
  return `Claude returned an error result: ${message}`;
}

function directString(value: ProviderValue): string | undefined {
  return isString(value) && value.trim() ? value.trim() : undefined;
}

function resolveExecutable(command: string): string | undefined {
  const args = process.platform === "win32" ? [command] : ["-v", command];
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "command", args, {
    encoding: "utf8",
    shell: process.platform !== "win32",
  });
  const executable = result.stdout?.split(/\r?\n/).find((line) => line.trim());
  return executable?.trim() || undefined;
}

export function claudeCommandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_AGENT_SDK_VERSION",
  ]) {
    delete next[key];
  }
  return next;
}

class OpencodeLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "opencode" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const { createOpencode } = await import("@opencode-ai/sdk/v2");
    const { client, server } = await createOpencode();
    const providerClient: OpenCodeClient = {
      session: {
        async create(parameters, options) {
          // SAFETY: OpenCode accepts the JSON request assembled by this adapter.
          const result = await client.session.create(
            // SAFETY: OpenCode's generated client accepts this JSON-shaped request.
            parameters as never,
            // SAFETY: OpenCode's generated client accepts these request options.
            options as never,
          );
          return decodeProviderResponse(result);
        },
        async prompt(parameters, options) {
          // SAFETY: OpenCode accepts the JSON request assembled by this adapter.
          const result = await client.session.prompt(
            // SAFETY: OpenCode's generated client accepts this JSON-shaped request.
            parameters as never,
            // SAFETY: OpenCode's generated client accepts these request options.
            options as never,
          );
          return decodeProviderResponse(result);
        },
        wait: undefined,
        async messages(parameters, options) {
          if (!client.session.messages) return undefined;
          // SAFETY: OpenCode accepts the JSON request assembled by this adapter.
          const result = await client.session.messages(parameters as never, options as never);
          return decodeProviderResponse(result);
        },
      },
    };
    try {
      const sessionId = input.providerSessionId ?? await createOpencodeSession(providerClient, input);
      const promptResult = await promptOpencodeSession(providerClient, sessionId, input);
      await waitForOpencodeSession(providerClient, sessionId);
      const messages = await readOpencodeMessages(providerClient, sessionId);
      const finalResponse = requireFinalResponse(
        "OpenCode",
        extractOpenCodeFinalResponse(messages) || extractOpenCodeFinalResponse(promptResult),
      );
      return {
        provider: this.provider,
        providerSessionId: sessionId,
        finalResponse,
        items: [promptResult, messages],
      };
    } finally {
      server.close();
    }
  }
}

class AcpLocalAgentAdapter implements LocalAgentAdapter {
  constructor(
    readonly provider: "cursor" | "copilot",
    private readonly command: [string, ...string[]],
  ) {}

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const { client } = await import("@agentclientprotocol/sdk");
    const { methods } = await import("@agentclientprotocol/sdk");
    const { ndJsonStream } = await import("@agentclientprotocol/sdk");
    const [command, ...args] = this.command;
    const child = spawn(command, args, {
      cwd: input.workspace,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    assertPipedChild(child);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const stream = ndJsonStream(
      // SAFETY: assertPipedChild verified the child streams are writable/readable Node streams.
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      // SAFETY: assertPipedChild verified the child streams are writable/readable Node streams.
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    try {
      let providerSessionId = input.providerSessionId ?? null;
      const finalResponse = await client({ name: "DevSpace" })
        .onRequest(methods.client.session.requestPermission, (context) => {
          const selected = selectAcpAllowPermissionOption(context.params.options);
          return selected
            ? { outcome: { outcome: "selected", optionId: selected.optionId } }
            : { outcome: { outcome: "cancelled" } };
        })
        .connectWith(stream, async (context) => {
          const session = await context.buildSession(input.workspace).start();
          providerSessionId = session.sessionId;
          try {
            if (input.model) {
              const config = resolveAcpModelConfigUpdate(decodeProviderResponse(session), input.model, this.provider);
              await context.request(methods.agent.session.setConfigOption, config);
            }
            if (input.thinking) {
              const config = resolveAcpThinkingConfigUpdate(decodeProviderResponse(session), input.thinking, this.provider);
              await context.request(methods.agent.session.setConfigOption, config);
            }
            const prompt = session.prompt(input.prompt);
            const textParts: string[] = [];
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") {
                await prompt;
                return textParts.join("").trim();
              }

              const update = message.update;
              if (update.sessionUpdate !== "agent_message_chunk") continue;
              const content = update.content;
              if (content.type === "text") textParts.push(content.text);
            }
          } finally {
            session.dispose();
          }
        });
      return {
        provider: this.provider,
        providerSessionId,
        finalResponse: finalResponse.trim(),
        items: [],
      };
    } catch (error) {
      throw new Error(`${this.provider} ACP run failed: ${errorMessage(error)}${stderr ? `\n${stderr.trim()}` : ""}`);
    } finally {
      child.kill();
    }
  }
}

export function resolveAcpModelConfigUpdate(
  session: ProviderValue,
  model: string,
  provider: string,
): { sessionId: string; configId: string; value: string } {
  return resolveAcpSelectConfigUpdate(session, {
    category: "model",
    label: "model",
    provider,
    value: model,
  });
}

export function resolveAcpThinkingConfigUpdate(
  session: ProviderValue,
  thinking: string,
  provider: string,
): { sessionId: string; configId: string; value: string } {
  return resolveAcpSelectConfigUpdate(session, {
    category: "thought_level",
    label: "thinking option",
    provider,
    value: thinking,
  });
}

function resolveAcpSelectConfigUpdate(
  session: ProviderValue,
  options: {
    category: string;
    label: string;
    provider: string;
    value: string;
  },
) {
  const record = asRecord(session);
  if (!record) throw new Error(`${options.provider} ACP session did not return session metadata.`);
  const sessionId = isString(record?.sessionId) ? record.sessionId : undefined;
  if (!sessionId) throw new Error(`${options.provider} ACP session did not return a session id.`);

  const response = asRecord(record.newSessionResponse);
  const configOptions = response ? readArray(response, "configOptions") ?? [] : [];
  const config = configOptions
    .map(asRecord)
    .find((option) => option?.type === "select" && option.category === options.category);
  if (!config) {
    throw new Error(`${options.provider} ACP server does not expose a ${options.label}.`);
  }

  const configId = directString(config.id);
  if (!configId) throw new Error(`${options.provider} ACP ${options.label} is missing an id.`);

  const available = flattenAcpSelectValues(config);
  if (!available.includes(options.value)) {
    const suffix = available.length > 0 ? ` Available values: ${available.join(", ")}.` : "";
    throw new Error(`${options.provider} ACP ${options.label} does not support '${options.value}'.${suffix}`);
  }

  return { sessionId, configId, value: options.value };
}

function flattenAcpSelectValues(option: ProviderRecord): string[] {
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

function selectAcpAllowPermissionOption(options: Array<{ optionId: string; kind: string }>): { optionId: string } | undefined {
  return (
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind === "allow_always")
  );
}

class PiRpcLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "pi" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const args = ["--mode", "rpc"];
    if (input.model) args.push("--model", input.model);
    if (input.thinking) args.push("--thinking", input.thinking);
    if (input.providerSessionId) args.push("--session", input.providerSessionId);
    const child = spawn(process.env.PI_COMMAND ?? "pi", args, {
      cwd: input.workspace,
      env: piCommandEnvironment(process.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    assertPipedChild(child);
    const rpc = new JsonLineRpc(child);
    const events: ProviderValue[] = [];
    rpc.onEvent((event) => events.push(event));
    try {
      const state = await rpc.request({ type: "get_state" });
      const providerSessionId = readNestedString(state, ["sessionId"]) ?? input.providerSessionId ?? null;
      const done = rpc.waitForEvent((event) => asRecord(event)?.type === "agent_end", PI_AGENT_TIMEOUT_MS);
      await rpc.request({ type: "prompt", message: input.prompt });
      const agentEnd = await done;
      const sessionMessages = await rpc.request({ type: "get_messages" });
      const finalResponse =
        extractPiFinalResponse(agentEnd) ||
        extractPiFinalResponse(sessionMessages) ||
        extractPiStreamingText(events);
      if (!finalResponse) {
        const providerError =
          extractPiProviderError(agentEnd) ||
          extractPiProviderError(sessionMessages) ||
          extractPiProviderError(events);
        if (providerError) throw new Error(`Pi returned an error: ${providerError}`);
      }
      requireFinalResponse("Pi", finalResponse);
      return {
        provider: this.provider,
        providerSessionId,
        finalResponse,
        items: [...events, sessionMessages],
      };
    } finally {
      child.kill();
    }
  }
}

export function piCommandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.PI_COMMAND) return env;
  const path = env.PATH;
  if (!path) return env;

  return {
    ...env,
    PATH: removeDevspaceNodeModulesBinFromPath(path),
  };
}

class JsonLineRpc {
  private readonly pending = new Map<string, {
    resolve: (value: ProviderValue) => void;
    reject: (error: Error) => void;
  }>();
  private readonly eventSubscribers = new Set<(event: ProviderValue) => void>();
  private buffer = "";
  private nextId = 1;
  private stderr = "";
  private fatalError: Error | undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      this.failAll(new Error(`Pi RPC process exited with code ${code ?? "null"} and signal ${signal ?? "null"}\n${this.stderr}`.trim()));
    });
  }

  request(command: ProviderRequest): Promise<ProviderValue> {
    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }
    const id = `req_${this.nextId}`;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  onEvent(callback: (event: ProviderValue) => void): () => void {
    this.eventSubscribers.add(callback);
    return () => this.eventSubscribers.delete(callback);
  }

  waitForEvent(predicate: (event: ProviderValue) => boolean, timeoutMs: number): Promise<ProviderValue> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Pi RPC timed out waiting for agent completion\n${this.stderr}`.trim()));
      }, timeoutMs);
      const unsubscribe = this.onEvent((event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      });
    });
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: ProviderRecord;
      try {
        // SAFETY: the RPC transport emits one JSON object per line.
        message = JSON.parse(line) as ProviderRecord;
      } catch {
        this.stderr += `${line}\n`;
        this.failAll(new Error(`Pi RPC emitted malformed JSON on stdout: ${line}`));
        return;
      }
      if (message.type !== "response") {
        for (const subscriber of this.eventSubscribers) subscriber(message);
        continue;
      }

      const id = isString(message.id) ? message.id : undefined;
      if (!id) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      if (message.success === false || message.error) {
        pending.reject(new Error(errorMessage(message.error ?? `Pi RPC request failed: ${message.command ?? id}`)));
      } else {
        pending.resolve(message.data ?? message.result ?? message);
      }
    }
  }

  private failAll(error: Error): void {
    this.fatalError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function createOpencodeSession(client: OpenCodeClient, input: LocalAgentRunInput): Promise<string> {
  const sessionClient = client;
  const result = await sessionClient.session.create({
    directory: input.workspace,
    location: { directory: input.workspace },
    model: input.model ? parseOpencodeModel(input.model) : undefined,
  }, { throwOnError: true });
  const id =
    readNestedString(result, ["id"]) ??
    readNestedString(result, ["data", "id"]) ??
    readNestedString(result, ["session", "id"]) ??
    readNestedString(result, ["data", "session", "id"]);
  if (!id) {
    throw new Error("OpenCode did not return a session id.");
  }
  return id;
}

async function promptOpencodeSession(
  client: OpenCodeClient,
  sessionId: string,
  input: LocalAgentRunInput,
): Promise<ProviderValue> {
  const session = client.session;
  const promptInput = {
    sessionID: sessionId,
    directory: input.workspace,
    prompt: { parts: [{ type: "text", text: input.prompt }] },
    parts: [{ type: "text", text: input.prompt }],
    model: input.model ? parseOpencodeModel(input.model) : undefined,
    variant: input.thinking,
  };
  return session.prompt(promptInput, { throwOnError: true });
}

async function waitForOpencodeSession(client: OpenCodeClient, sessionId: string): Promise<void> {
  const session = client.session;
  if (!session?.wait) return;
  await session.wait({ sessionID: sessionId }, { throwOnError: true });
}

async function readOpencodeMessages(client: OpenCodeClient, sessionId: string): Promise<ProviderValue> {
  const session = client.session;
  if (!session?.messages) return undefined;
  return session.messages({ sessionID: sessionId, order: "asc", limit: 100 }, { throwOnError: true });
}

function parseOpencodeModel(model: string) {
  const separator = model.indexOf("/");
  if (separator === -1) return { providerID: "opencode", modelID: model };
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

function decodeProviderResponse<T>(value: T): ProviderValue {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : JSON.parse(serialized);
}

export function extractLocalAgentResponseText(value: ProviderValue): string {
  return extractOpenCodeFinalResponse(value) || extractPiFinalResponse(value);
}

function assertPipedChild(child: ReturnType<typeof spawn>): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Agent process did not expose stdio pipes.");
  }
}

export function extractOpenCodeFinalResponse(value: ProviderValue): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (messages) return extractLastOpenCodeAssistantMessageText(messages);
  return extractOpenCodeAssistantMessageText(root);
}

export function extractPiFinalResponse(value: ProviderValue): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (!messages) return "";

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message || message.role !== "assistant") continue;
    const text = extractPiAssistantMessageText(message);
    if (text) return text;
  }
  return "";
}

export function extractPiStreamingText(events: ProviderValue[]): string {
  return events
    .map((event) => {
      const record = asRecord(event);
      if (!record || record.type !== "message_update") return "";
      const update = asRecord(record.assistantMessageEvent);
      if (!update || update.type !== "text_delta") return "";
      return isString(update.delta) ? update.delta : "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}

export function extractPiProviderError(value: ProviderValue): string {
  const root = unwrapProviderPayload(value);
  if (Array.isArray(root)) {
    for (let index = root.length - 1; index >= 0; index -= 1) {
      const error = extractPiProviderError(root[index]);
      if (error) return error;
    }
    return "";
  }

  const messages = readArray(root, "messages");
  if (messages) return extractPiProviderError(messages);

  const message = asRecord(root)?.message ?? root;
  const record = asRecord(message);
  if (!record) return "";
  const error = record.errorMessage ?? record.error;
  return isString(error) ? error.trim() : "";
}

function extractLastOpenCodeAssistantMessageText(messages: ProviderValue[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    const info = asRecord(message.info);
    const role = isString(info?.role) ? info.role : message.role;
    const type = isString(message.type) ? message.type : undefined;
    if (role !== "assistant" && type !== "assistant") continue;
    const text = extractOpenCodeAssistantMessageText(message);
    if (text) return text;
  }
  return "";
}

function extractOpenCodeAssistantMessageText(value: ProviderValue): string {
  const message = asRecord(value);
  if (!message) return "";

  const content = readArray(message, "content");
  if (content) {
    const text = content
      .map((part) => {
        const partRecord = asRecord(part);
        if (!partRecord || partRecord.type !== "text") return "";
        return isString(partRecord.text) ? partRecord.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text.trim()) return text.trim();
  }

  const parts = readArray(message, "parts");
  if (parts) {
    const text = parts
      .map((part) => {
        const partRecord = asRecord(part);
        if (!partRecord || partRecord.type !== "text") return "";
        return isString(partRecord.text) ? partRecord.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text.trim()) return text.trim();
  }

  const info = asRecord(message.info) ?? message;
  return stringifyStructuredAssistantMessage(info.structured);
}

function extractPiAssistantMessageText(message: ProviderRecord): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const partRecord = asRecord(part);
      if (!partRecord || partRecord.type !== "text") return "";
      return isString(partRecord.text) ? partRecord.text : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function stringifyStructuredAssistantMessage(value: ProviderValue): string {
  if (value === undefined || value === null) return "";
  if (isString(value)) return value.trim();
  return JSON.stringify(value);
}

function unwrapProviderPayload(value: ProviderValue): ProviderValue {
  const record = asRecord(value);
  if (!record) return value;
  return record.data ?? record.result ?? value;
}

function readArray(record: ProviderValue, key: string): ProviderValue[] | undefined {
  const value = asRecord(record)?.[key];
  return Array.isArray(value) ? value : undefined;
}

function asRecord(value: ProviderValue): ProviderRecord | undefined {
  if (!isObject(value)) return undefined;
  // SAFETY: provider payload records are JSON-shaped objects and are accessed only by optional keys.
  return value as ProviderRecord;
}

function readNestedString(value: ProviderValue, path: string[]): string | undefined {
  let current: ProviderValue = value;
  for (const key of path) {
    current = asRecord(current)?.[key];
  }
  return isString(current) ? current : undefined;
}

function errorMessage<T>(error: T): string {
  return error instanceof Error ? error.message : String(error);
}

function requireFinalResponse(provider: string, response: string): string {
  const trimmed = response.trim();
  if (!trimmed) {
    throw new Error(`${provider} did not return a final assistant response.`);
  }
  return trimmed;
}
