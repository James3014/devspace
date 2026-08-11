import type {
  EffortLevel,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { LocalAgentRunInput, LocalAgentRunResult } from "../local-agent-runtime.js";
import type { HarnessDriver, HarnessRuntime } from "../local-agent-runtime-pool.js";
import { resolveLocalAgentExecutable } from "../local-agent-path.js";

export interface ClaudeQueryLike {
  next(): Promise<IteratorResult<SDKMessage, void>>;
  setModel(model?: string): Promise<void>;
  close(): void;
}

export type ClaudeQueryFactory = (
  input: LocalAgentRunInput,
  prompts: AsyncIterable<SDKUserMessage>,
  resume: string | undefined,
) => ClaudeQueryLike;

interface LiveClaudeQuery {
  query: ClaudeQueryLike;
  prompts: AsyncPromptQueue<SDKUserMessage>;
  effort: string | undefined;
  model: string | undefined;
}

/**
 * Keeps one streaming Claude SDK query warm for a logical DevSpace agent.
 * If session-start-only configuration changes, only that query is replaced;
 * the durable Claude session id is used to resume the conversation.
 */
export class ClaudeWarmRuntime implements HarnessRuntime {
  private live: LiveClaudeQuery | undefined;
  private providerSessionId: string | undefined;
  private closed = false;

  constructor(private readonly createQuery: ClaudeQueryFactory) {}

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    if (this.closed) throw new Error("Claude runtime is closed.");
    this.providerSessionId = input.providerSessionId ?? this.providerSessionId;

    const live = this.ensureQuery(input);
    if (input.model !== undefined && input.model !== live.model) {
      await live.query.setModel(input.model);
      live.model = input.model;
    }

    live.prompts.push(userMessage(input.prompt, this.providerSessionId));
    const items: unknown[] = [];
    try {
      for (;;) {
        const next = await live.query.next();
        if (next.done) {
          this.resetQuery();
          throw new Error("Claude session ended before returning a result.");
        }
        const message = next.value;
        items.push(message);
        if (typeof message.session_id === "string") {
          this.providerSessionId = message.session_id;
        }
        if (message.type !== "result") continue;
        const error = claudeResultError(message as unknown as Record<string, unknown>);
        if (error) throw new Error(error);
        if (typeof message.result !== "string" || !message.result.trim()) {
          throw new Error("Claude completed without a final response.");
        }
        return {
          provider: "claude",
          providerSessionId: this.providerSessionId ?? null,
          finalResponse: message.result,
          items,
        };
      }
    } catch (error) {
      // A failed iterator is not safe to reuse. The next explicit turn will
      // recreate the query and resume from the persisted provider session id.
      this.resetQuery();
      throw error;
    }
  }

  isUsable(): boolean {
    return !this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.resetQuery();
  }

  private ensureQuery(input: LocalAgentRunInput): LiveClaudeQuery {
    if (this.live && this.live.effort === input.thinking) return this.live;
    this.resetQuery();
    const prompts = new AsyncPromptQueue<SDKUserMessage>();
    const query = this.createQuery(input, prompts, this.providerSessionId);
    this.live = {
      query,
      prompts,
      effort: input.thinking,
      model: input.model,
    };
    return this.live;
  }

  private resetQuery(): void {
    const live = this.live;
    this.live = undefined;
    if (!live) return;
    live.prompts.close();
    live.query.close();
  }
}

export function createClaudeHarnessDriver(
  env: NodeJS.ProcessEnv = process.env,
): HarnessDriver {
  return {
    provider: "claude",
    runtimeKey: (input) => {
      if (!input.agentId) {
        throw new Error("Claude pooled runtime requires a DevSpace agent id.");
      }
      return input.agentId;
    },
    createRuntime: async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      return new ClaudeWarmRuntime((input, prompts, resume) => {
        const claudeExecutable = env.CLAUDE_COMMAND?.trim()
          || resolveLocalAgentExecutable("claude", env);
        return query({
          prompt: prompts,
          options: {
            cwd: input.workspace,
            model: input.model,
            ...(input.thinking
              ? {
                  thinking: { type: "adaptive" } as const,
                  effort: input.thinking as EffortLevel,
                }
              : {}),
            resume,
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            env: claudeCommandEnvironment(env),
            ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
          },
        }) as Query;
      });
    },
  };
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

function userMessage(prompt: string, sessionId: string | undefined): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

function claudeResultError(record: Record<string, unknown>): string | undefined {
  const subtype = typeof record.subtype === "string" ? record.subtype : undefined;
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

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

class AsyncPromptQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) throw new Error("Claude prompt stream is closed.");
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
