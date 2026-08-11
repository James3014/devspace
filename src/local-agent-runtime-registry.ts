import type { LocalAgentProvider } from "./local-agent-profiles.js";
import type { LocalAgentRunInput, LocalAgentRunResult } from "./local-agent-runtime.js";
import { createLocalAgentAdapter, createOpencodeHarnessDriver } from "./local-agent-adapters.js";
import {
  HarnessRuntimePool,
  type HarnessDriver,
} from "./local-agent-runtime-pool.js";

interface LocalAgentRuntimeRegistryOptions {
  pool?: HarnessRuntimePool;
  opencodeDriver?: HarnessDriver;
}

/**
 * Routes providers to their cheapest safe live-runtime scope. Providers that
 * have not opted into pooling keep their existing one-shot adapter behavior.
 */
export class LocalAgentRuntimeRegistry {
  private readonly pool: HarnessRuntimePool;
  private readonly opencodeDriver: HarnessDriver;

  constructor(options: LocalAgentRuntimeRegistryOptions = {}) {
    this.pool = options.pool ?? new HarnessRuntimePool();
    this.opencodeDriver = options.opencodeDriver ?? createOpencodeHarnessDriver();
  }

  async run(
    provider: LocalAgentProvider,
    input: LocalAgentRunInput,
  ): Promise<LocalAgentRunResult> {
    if (provider === "opencode") {
      return this.pool.run(this.opencodeDriver, input);
    }
    return createLocalAgentAdapter(provider).run(input);
  }

  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }
}
