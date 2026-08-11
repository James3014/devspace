import type { LocalAgentProvider } from "./local-agent-profiles.js";
import type { LocalAgentRunInput, LocalAgentRunResult } from "./local-agent-runtime.js";
import type { HarnessDriver, HarnessRuntime } from "./local-agent-runtime-pool.js";
import { createCodexHarnessDriver } from "./local-agent-codex/runtime.js";
import { createAcpHarnessDriver } from "./local-agent-acp/runtime.js";
import { createPiHarnessDriver } from "./local-agent-pi/runtime.js";
import {
  claudeCommandEnvironment,
  createClaudeHarnessDriver,
} from "./local-agent-claude/runtime.js";
export { claudeCommandEnvironment } from "./local-agent-claude/runtime.js";
export {
  resolveAcpModelConfigUpdate,
  resolveAcpThinkingConfigUpdate,
} from "./local-agent-acp/config.js";

export interface LocalAgentAdapter {
  readonly provider: LocalAgentProvider;
  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult>;
}

const ACP_COMMANDS: Record<"cursor" | "copilot", [string, ...string[]]> = {
  cursor: ["cursor-agent", "acp"],
  copilot: ["copilot", "--acp"],
};

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
      return new PiLocalAgentAdapter();
    case "cursor":
    case "copilot":
      return new AcpLocalAgentAdapter(provider, ACP_COMMANDS[provider]);
  }
}

class CodexLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "codex" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const runtime = await createCodexHarnessDriver().createRuntime(input);
    try {
      return await runtime.run(input);
    } finally {
      await runtime.close();
    }
  }
}

class ClaudeLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "claude" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const runtime = await createClaudeHarnessDriver().createRuntime(input);
    try {
      return await runtime.run({ ...input, agentId: input.agentId ?? "direct" });
    } finally {
      await runtime.close();
    }
  }
}

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}


class OpencodeLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "opencode" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const runtime = await createOpencodeHarnessDriver().createRuntime(input);
    try {
      return await runtime.run(input);
    } finally {
      await runtime.close();
    }
  }
}

class OpencodeHarnessRuntime implements HarnessRuntime {
  private closed = false;
  private failed = false;

  constructor(
    private readonly client: unknown,
    private readonly closeServer: () => void,
  ) {}

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    if (this.closed) throw new Error("OpenCode runtime is closed.");
    try {
      const sessionId = input.providerSessionId ?? await createOpencodeSession(this.client, input);
      const promptResult = await promptOpencodeSession(this.client, sessionId, input);
      await waitForOpencodeSession(this.client, sessionId);
      const messages = await readOpencodeMessages(this.client, sessionId);
      const finalResponse = requireFinalResponse(
        "OpenCode",
        extractOpenCodeFinalResponse(messages) || extractOpenCodeFinalResponse(promptResult),
      );
      return {
        provider: "opencode",
        providerSessionId: sessionId,
        finalResponse,
        items: [promptResult, messages],
      };
    } catch (error) {
      // The SDK does not expose the child server's exit state. Treat a failed
      // turn as poisoning this pooled runtime so the next turn gets a fresh
      // server instead of repeatedly reusing a dead transport.
      this.failed = true;
      throw error;
    }
  }

  isUsable(): boolean {
    return !this.closed && !this.failed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeServer();
  }
}

export function createOpencodeHarnessDriver(): HarnessDriver {
  return {
    provider: "opencode",
    runtimeKey: () => "default",
    createRuntime: async () => {
      const { createOpencode } = await import("@opencode-ai/sdk/v2");
      const { client, server } = await createOpencode();
      return new OpencodeHarnessRuntime(client, () => server.close());
    },
  };
}

class AcpLocalAgentAdapter implements LocalAgentAdapter {
  constructor(
    readonly provider: "cursor" | "copilot",
    private readonly command: [string, ...string[]],
  ) {}

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const runtime = await createAcpHarnessDriver(this.provider, this.command).createRuntime(input);
    try {
      return await runtime.run(input);
    } finally {
      await runtime.close();
    }
  }
}

class PiLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "pi" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const runtime = await createPiHarnessDriver().createRuntime(input);
    try {
      return await runtime.run(input);
    } finally {
      await runtime.close();
    }
  }
}

async function createOpencodeSession(client: unknown, input: LocalAgentRunInput): Promise<string> {
  const sessionClient = client as {
    session: {
      create(parameters?: unknown, options?: unknown): Promise<unknown>;
    };
  };
  const result = await sessionClient.session.create({
    directory: input.workspace,
    location: { directory: input.workspace },
    ...(input.model ? { model: parseOpencodeModel(input.model) } : {}),
  }, { throwOnError: true });
  const id =
    readNestedString(result, ["id"]) ??
    readNestedString(result, ["data", "id"]) ??
    readNestedString(result, ["session", "id"]) ??
    readNestedString(result, ["data", "session", "id"]);
  if (typeof id !== "string") {
    throw new Error("OpenCode did not return a session id.");
  }
  return id;
}

async function promptOpencodeSession(
  client: unknown,
  sessionId: string,
  input: LocalAgentRunInput,
): Promise<unknown> {
  const session = (client as {
    session: {
      prompt(parameters?: unknown, options?: unknown): Promise<unknown>;
    };
  }).session;
  const promptInput = {
    sessionID: sessionId,
    directory: input.workspace,
    prompt: { parts: [{ type: "text", text: input.prompt }] },
    parts: [{ type: "text", text: input.prompt }],
    ...(input.model ? { model: parseOpencodeModel(input.model) } : {}),
    ...(input.thinking ? { variant: input.thinking } : {}),
  };
  return session.prompt(promptInput, { throwOnError: true });
}

async function waitForOpencodeSession(client: unknown, sessionId: string): Promise<void> {
  const session = (client as {
    session?: { wait?: (parameters?: unknown, options?: unknown) => Promise<unknown> };
  }).session;
  if (!session?.wait) return;
  await session.wait({ sessionID: sessionId }, { throwOnError: true });
}

async function readOpencodeMessages(client: unknown, sessionId: string): Promise<unknown> {
  const session = (client as {
    session?: {
      messages?: (parameters?: unknown, options?: unknown) => Promise<unknown>;
    };
  }).session;
  if (!session?.messages) return undefined;
  return session.messages({ sessionID: sessionId, order: "asc", limit: 100 }, { throwOnError: true });
}

function parseOpencodeModel(model: string): { providerID: string; modelID: string } {
  const separator = model.indexOf("/");
  if (separator === -1) return { providerID: "opencode", modelID: model };
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

export function extractOpenCodeFinalResponse(value: unknown): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (messages) return extractLastOpenCodeAssistantMessageText(messages);
  return extractOpenCodeAssistantMessageText(root);
}

function extractLastOpenCodeAssistantMessageText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    const info = asRecord(message.info);
    const role = typeof info?.role === "string" ? info.role : message.role;
    const type = typeof message.type === "string" ? message.type : undefined;
    if (role !== "assistant" && type !== "assistant") continue;
    const text = extractOpenCodeAssistantMessageText(message);
    if (text) return text;
  }
  return "";
}

function extractOpenCodeAssistantMessageText(value: unknown): string {
  const message = asRecord(value);
  if (!message) return "";

  const content = readArray(message, "content");
  if (content) {
    const text = content
      .map((part) => {
        const partRecord = asRecord(part);
        if (!partRecord || partRecord.type !== "text") return "";
        return typeof partRecord.text === "string" ? partRecord.text : "";
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
        return typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text.trim()) return text.trim();
  }

  const info = asRecord(message.info) ?? message;
  return stringifyStructuredAssistantMessage(info.structured);
}

function stringifyStructuredAssistantMessage(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  return JSON.stringify(value);
}

function unwrapProviderPayload(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  return record.data ?? record.result ?? value;
}

function readArray(record: unknown, key: string): unknown[] | undefined {
  const value = asRecord(record)?.[key];
  return Array.isArray(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)?.[key];
  }
  return typeof current === "string" ? current : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireFinalResponse(provider: string, response: string): string {
  const trimmed = response.trim();
  if (!trimmed) {
    throw new Error(`${provider} did not return a final assistant response.`);
  }
  return trimmed;
}
