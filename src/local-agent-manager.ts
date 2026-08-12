import type { ServerConfig } from "./config.js";
import { runLocalAgentProvider } from "./local-agent-adapters.js";
import { assertLocalAgentProviderAvailable } from "./local-agent-availability.js";
import {
  isLocalAgentProvider,
  loadLocalAgentProfiles,
  type LocalAgentProfile,
} from "./local-agent-profiles.js";
import {
  formatAvailableLocalAgentTargets,
  resolveLocalAgentTarget,
} from "./local-agent-targets.js";
import {
  createLocalAgentStore,
  type LocalAgentRecord,
  type LocalAgentStore,
} from "./local-agent-store.js";
import type { LocalAgentRunResult } from "./local-agent-runtime.js";
import { assertAllowedPath } from "./roots.js";

export interface LocalAgentRunCommand {
  workspaceId?: string;
  workspaceRoot: string;
  target: string;
  prompt: string;
  model?: string;
  thinking?: string;
}

type RunProvider = (
  provider: LocalAgentProfile["provider"],
  input: Parameters<typeof runLocalAgentProvider>[1],
) => Promise<LocalAgentRunResult>;

interface LocalAgentManagerOptions {
  store?: LocalAgentStore;
  runProvider?: RunProvider;
  assertProviderAvailable?: typeof assertLocalAgentProviderAvailable;
}

interface QueuedTurn {
  prompt: string;
  model?: string;
  thinking?: string;
}

interface AgentQueue {
  tail: Promise<void>;
  pending: number;
}

/**
 * Owns logical subagent turn serialization and durable state updates.
 *
 * Provider runtimes are intentionally not durable state: the store owns the
 * provider session id, while live provider resources may be recreated later.
 */
export class LocalAgentManager {
  private readonly store: LocalAgentStore;
  private readonly runProvider: RunProvider;
  private readonly assertProviderAvailable: typeof assertLocalAgentProviderAvailable;
  private readonly queues = new Map<string, AgentQueue>();
  private closing = false;

  constructor(
    private readonly config: ServerConfig,
    options: LocalAgentManagerOptions = {},
  ) {
    this.store = options.store ?? createLocalAgentStore(config);
    this.runProvider = options.runProvider ?? runLocalAgentProvider;
    this.assertProviderAvailable = options.assertProviderAvailable ?? assertLocalAgentProviderAvailable;
  }

  async enqueue(command: LocalAgentRunCommand): Promise<LocalAgentRecord> {
    if (this.closing) throw new Error("DevSpace subagent manager is shutting down.");

    const normalizedCommand = {
      ...command,
      workspaceRoot: assertAllowedPath(command.workspaceRoot, this.config.allowedRoots),
    };
    const existing = this.store.getByAgentId(normalizedCommand.target);
    const record = existing
      ? this.prepareExistingAgent(existing, normalizedCommand)
      : await this.createAgent(normalizedCommand);

    this.schedule(record.id, {
      prompt: normalizedCommand.prompt,
      model: normalizedCommand.model ?? record.model,
      thinking: normalizedCommand.thinking ?? record.thinking,
    });

    return this.store.update(record.id, { status: "running" });
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await Promise.allSettled(Array.from(this.queues.values(), (queue) => queue.tail));
    this.store.close();
  }

  private prepareExistingAgent(
    existing: LocalAgentRecord,
    command: LocalAgentRunCommand,
  ): LocalAgentRecord {
    const workspaceRoot = assertAllowedPath(existing.workspaceRoot, this.config.allowedRoots);
    if (workspaceRoot !== command.workspaceRoot) {
      throw new Error(`Subagent ${existing.id} belongs to a different workspace.`);
    }
    if (command.workspaceId && existing.workspaceId && command.workspaceId !== existing.workspaceId) {
      throw new Error(`Subagent ${existing.id} belongs to a different workspace.`);
    }
    if (!isLocalAgentProvider(existing.provider)) {
      throw new Error(`Unknown subagent provider for existing session: ${existing.provider}`);
    }
    this.assertProviderAvailable(existing.provider);
    return this.store.update(existing.id, {
      status: "starting",
      model: command.model ?? existing.model,
      thinking: command.thinking ?? existing.thinking,
      latestResponse: undefined,
      error: undefined,
    });
  }

  private async createAgent(command: LocalAgentRunCommand): Promise<LocalAgentRecord> {
    const profiles = await loadLocalAgentProfiles(this.config, command.workspaceRoot);
    const target = resolveLocalAgentTarget(command.target, profiles, command.model, command.thinking);
    if (!target) {
      throw new Error(
        `Unknown subagent profile, provider, or id: ${command.target}. Available ${formatAvailableLocalAgentTargets(profiles)}`,
      );
    }
    this.assertProviderAvailable(target.provider);
    return this.store.create({
      workspaceId: command.workspaceId,
      workspaceRoot: command.workspaceRoot,
      profileName: target.name,
      provider: target.provider,
      model: target.model,
      thinking: target.thinking,
    });
  }

  private schedule(agentId: string, turn: QueuedTurn): void {
    const current = this.queues.get(agentId);
    const previous = current?.tail ?? Promise.resolve();
    const queue: AgentQueue = current ?? { tail: Promise.resolve(), pending: 0 };
    queue.pending += 1;

    const next = previous
      .catch(() => undefined)
      .then(async () => {
        this.store.update(agentId, { status: "running", error: undefined });
        await this.executeTurn(agentId, turn);
      })
      .catch((error) => {
        try {
          this.store.update(agentId, {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // The store may already be unavailable during shutdown.
        }
      })
      .finally(() => {
        queue.pending -= 1;
        if (queue.pending === 0 && this.queues.get(agentId) === queue) {
          this.queues.delete(agentId);
        }
      });

    queue.tail = next;
    this.queues.set(agentId, queue);
  }

  private async executeTurn(agentId: string, turn: QueuedTurn): Promise<void> {
    const record = this.store.getByAgentId(agentId);
    if (!record) throw new Error(`Unknown subagent id: ${agentId}`);
    if (!isLocalAgentProvider(record.provider)) {
      throw new Error(`Unknown subagent provider for existing session: ${record.provider}`);
    }

    const workspaceRoot = assertAllowedPath(record.workspaceRoot, this.config.allowedRoots);
    const profiles = await loadLocalAgentProfiles(this.config, workspaceRoot);
    const profile = profiles.find((candidate) => candidate.name === record.profileName);
    const prompt = profile ? profilePrompt(profile, turn.prompt) : rawProviderPrompt(record, turn.prompt);
    const result = await this.runProvider(record.provider, {
      prompt,
      workspace: workspaceRoot,
      providerSessionId: record.providerSessionId,
      writeMode: "allowed",
      model: turn.model,
      thinking: turn.thinking,
    });
    this.store.update(record.id, {
      providerSessionId: result.providerSessionId ?? undefined,
      status: "idle",
      latestResponse: result.finalResponse,
      error: undefined,
    });
  }
}

function profilePrompt(profile: LocalAgentProfile, prompt: string): string {
  const body = profile.body.trim();
  return body ? `${body}\n\nTask:\n${prompt}` : prompt;
}

function rawProviderPrompt(record: LocalAgentRecord, prompt: string): string {
  if (record.profileName !== record.provider || !isLocalAgentProvider(record.provider)) {
    throw new Error(`Subagent profile not found: ${record.profileName}`);
  }
  return prompt;
}
