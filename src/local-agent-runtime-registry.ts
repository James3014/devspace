import type { LocalAgentProvider } from "./local-agent-profiles.js";
import type { LocalAgentRunInput, LocalAgentRunResult } from "./local-agent-runtime.js";
import { createLocalAgentAdapter, createOpencodeHarnessDriver } from "./local-agent-adapters.js";
import { createCodexHarnessDriver } from "./local-agent-codex/runtime.js";
import { createAcpHarnessDriver } from "./local-agent-acp/runtime.js";
import { createPiHarnessDriver } from "./local-agent-pi/runtime.js";
import { createClaudeHarnessDriver } from "./local-agent-claude/runtime.js";
import {
  HarnessRuntimePool,
  type HarnessDriver,
} from "./local-agent-runtime-pool.js";

interface LocalAgentRuntimeRegistryOptions {
  pool?: HarnessRuntimePool;
  codexDriver?: HarnessDriver;
  opencodeDriver?: HarnessDriver;
  cursorDriver?: HarnessDriver;
  copilotDriver?: HarnessDriver;
  piDriver?: HarnessDriver;
  claudeDriver?: HarnessDriver;
}

/**
 * Routes providers to their cheapest safe live-runtime scope. Providers that
 * have not opted into pooling keep their existing one-shot adapter behavior.
 */
export class LocalAgentRuntimeRegistry {
  private readonly pool: HarnessRuntimePool;
  private readonly codexDriver: HarnessDriver;
  private readonly opencodeDriver: HarnessDriver;
  private readonly cursorDriver: HarnessDriver;
  private readonly copilotDriver: HarnessDriver;
  private readonly piDriver: HarnessDriver;
  private readonly claudeDriver: HarnessDriver;

  constructor(options: LocalAgentRuntimeRegistryOptions = {}) {
    this.pool = options.pool ?? new HarnessRuntimePool();
    this.codexDriver = options.codexDriver ?? createCodexHarnessDriver();
    this.opencodeDriver = options.opencodeDriver ?? createOpencodeHarnessDriver();
    this.cursorDriver = options.cursorDriver ?? createAcpHarnessDriver("cursor", ["cursor-agent", "acp"]);
    this.copilotDriver = options.copilotDriver ?? createAcpHarnessDriver("copilot", ["copilot", "--acp"]);
    this.piDriver = options.piDriver ?? createPiHarnessDriver();
    this.claudeDriver = options.claudeDriver ?? createClaudeHarnessDriver();
  }

  async run(
    provider: LocalAgentProvider,
    input: LocalAgentRunInput,
  ): Promise<LocalAgentRunResult> {
    if (provider === "codex") {
      return this.pool.run(this.codexDriver, input);
    }
    if (provider === "opencode") {
      return this.pool.run(this.opencodeDriver, input);
    }
    if (provider === "cursor") {
      return this.pool.run(this.cursorDriver, input);
    }
    if (provider === "copilot") {
      return this.pool.run(this.copilotDriver, input);
    }
    if (provider === "pi") {
      return this.pool.run(this.piDriver, input);
    }
    if (provider === "claude") {
      return this.pool.run(this.claudeDriver, input);
    }
    return createLocalAgentAdapter(provider).run(input);
  }

  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }
}
