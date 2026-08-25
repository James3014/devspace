import type { Result } from "better-result";
import type {
  Codex,
  CodexOptions,
  ModelReasoningEffort,
  RunResult,
  SandboxMode,
  ThreadOptions,
} from "@openai/codex-sdk";
import type { AgentProviderError } from "./local-agent-errors.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";

export type LocalAgentWriteMode = "read_only" | "allowed" | "full_access";

export interface LocalAgentRunInput {
  prompt: string;
  workspaceRoot: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  effort?: string;
  modelOverrideRequested?: boolean;
  effortOverrideRequested?: boolean;
  /** Per-turn environment after any configured read-only toolchain bridge. */
  environment?: NodeJS.ProcessEnv;
}

export interface LocalAgentRunResult {
  provider: string;
  providerSessionId: string | null;
  finalResponse: string;
  items: unknown[];
}

export interface LocalAgentRunCallbacks {
  /**
   * Called as soon as a provider creates or resolves a durable continuation
   * identity. The callback is awaited before the provider starts work that
   * could otherwise lose that identity.
   */
  onSessionId?: (providerSessionId: string) => void | Promise<void>;
  /**
   * Called as soon as the provider runtime is ready and before semantic
   * execution starts.
   */
  onExecutionStarted?: () => void | Promise<void>;
}

export interface LocalAgentRuntimeContext {
  agentId: string;
  provider: LocalAgentProvider;
  workspaceRoot: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  effort?: string;
  agentDir?: string;
}

/**
 * A runtime is deliberately disposable. Nothing from this interface is
 * persisted; the provider session ID in LocalAgentStore is the continuation
 * identity used when a later runtime is created.
 */
export interface LocalAgentRuntime {
  readonly provider: LocalAgentProvider;
  run(
    input: LocalAgentRunInput,
    callbacks?: LocalAgentRunCallbacks,
  ): Promise<Result<LocalAgentRunResult, AgentProviderError>>;
  releaseSession(providerSessionId: string): Promise<void>;
  close(): Promise<void>;
  isAlive(): boolean;
}

export interface LocalAgentDriver {
  readonly provider: LocalAgentProvider;
  runtimeKey(context: LocalAgentRuntimeContext): string;
  createRuntime(context: LocalAgentRuntimeContext): Promise<Result<LocalAgentRuntime, AgentProviderError>>;
  readonly idleTimeoutMs?: number;
}

export class LocalAgentProviderError extends Error {
  readonly providerSessionId?: string;
  readonly finalResponse?: string;

  constructor(
    message: string,
    evidence: { providerSessionId?: string | null; finalResponse?: string } = {},
  ) {
    super(message);
    this.name = "LocalAgentProviderError";
    this.providerSessionId = evidence.providerSessionId ?? undefined;
    this.finalResponse = evidence.finalResponse?.trim() || undefined;
  }
}

interface CodexThreadLike {
  readonly id: string | null;
  run(prompt: string): Promise<RunResult>;
}

interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

type CodexFactory = (options?: CodexOptions) => CodexClientLike;

function sandboxModeFor(writeMode: LocalAgentWriteMode | undefined): SandboxMode {
  switch (writeMode) {
    case "allowed":
      return "workspace-write";
    case "full_access":
      return "danger-full-access";
    case "read_only":
    case undefined:
      return "read-only";
  }
}

function threadOptionsFor(input: LocalAgentRunInput): ThreadOptions {
  return {
    workingDirectory: input.workspaceRoot,
    sandboxMode: sandboxModeFor(input.writeMode),
    approvalPolicy: "never",
    model: input.model,
    modelReasoningEffort: input.effort as ModelReasoningEffort | undefined,
  };
}

export class CodexSdkLocalAgentRuntime {
  readonly provider = "codex" as const;
  private readonly codex: CodexClientLike;

  constructor(codex: CodexClientLike) {
    this.codex = codex;
  }

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const options = threadOptionsFor(input);
    const thread = input.providerSessionId
      ? this.codex.resumeThread(input.providerSessionId, options)
      : this.codex.startThread(options);
    let turn: RunResult;
    try {
      turn = await thread.run(input.prompt);
    } catch (error) {
      throw new LocalAgentProviderError(
        error instanceof Error ? error.message : String(error),
        { providerSessionId: thread.id },
      );
    }

    return {
      provider: this.provider,
      providerSessionId: thread.id,
      finalResponse: turn.finalResponse,
      items: turn.items,
    };
  }
}

export async function createCodexSdkLocalAgentRuntime(
  options?: CodexOptions,
  codexFactory?: CodexFactory,
): Promise<CodexSdkLocalAgentRuntime> {
  const factory = codexFactory ?? (await defaultCodexFactory());
  return new CodexSdkLocalAgentRuntime(factory(options));
}

async function defaultCodexFactory(): Promise<CodexFactory> {
  const module = await import("@openai/codex-sdk");
  return (options) => new module.Codex(options) as Codex;
}
