import type {
  Codex,
  CodexOptions,
  ModelReasoningEffort,
  RunResult,
  SandboxMode,
  ThreadOptions,
} from "@openai/codex-sdk";

export type LocalAgentWriteMode = "read_only" | "allowed" | "full_access";

export interface LocalAgentRunInput {
  prompt: string;
  workspace: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  thinking?: string;
}

export interface LocalAgentRunResult {
  provider: string;
  providerSessionId: string | null;
  finalResponse: string;
  items: unknown[];
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

export interface LocalAgentRuntime {
  readonly provider: string;
  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult>;
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
    workingDirectory: input.workspace,
    sandboxMode: sandboxModeFor(input.writeMode),
    approvalPolicy: "never",
    model: input.model,
    modelReasoningEffort: input.thinking as ModelReasoningEffort | undefined,
  };
}

export class CodexSdkLocalAgentRuntime implements LocalAgentRuntime {
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
