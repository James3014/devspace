import type { LocalAgentRunInput, LocalAgentRunResult, LocalAgentWriteMode } from "../local-agent-runtime.js";
import type { HarnessDriver, HarnessRuntime } from "../local-agent-runtime-pool.js";
import {
  startCodexAppServer,
  type CodexAppServerConnection,
} from "./app-server-transport.js";
import { resolveCodexCommand } from "./command.js";

type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
const CODEX_THREAD_IDLE_MS = 5 * 60 * 1_000;

interface PendingTurn {
  turnId?: string;
  items: unknown[];
  promise: Promise<TurnCompletion>;
  resolve(value: TurnCompletion): void;
  reject(error: Error): void;
}

interface TurnCompletion {
  status: "completed" | "interrupted" | "failed";
  error?: string;
  items: unknown[];
}

/**
 * One runtime owns one App Server connection and can host many Codex threads.
 * Thread ids remain durable outside this module, so closing this runtime never
 * destroys the logical DevSpace agents that were using it.
 */
export class CodexAppServerRuntime implements HarnessRuntime {
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly threadActivity = new Map<string, { active: boolean; lastUsedAt: number }>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeClose: () => void;
  private closed = false;

  constructor(private readonly connection: CodexAppServerConnection) {
    this.unsubscribe = connection.onNotification((method, params) => {
      this.handleNotification(method, params);
    });
    this.unsubscribeClose = connection.onClose((error) => {
      this.rejectPendingTurns(error);
    });
  }

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    if (!this.isUsable()) throw new Error("Codex app-server runtime is closed.");

    const threadId = input.providerSessionId
      ? await this.resumeThread(input.providerSessionId, input)
      : await this.startThread(input);
    if (this.pendingTurns.has(threadId)) {
      throw new Error(`Codex thread ${threadId} already has a turn in progress.`);
    }

    const activity = this.threadActivity.get(threadId) ?? { active: false, lastUsedAt: Date.now() };
    activity.active = true;
    this.threadActivity.set(threadId, activity);
    const pending = createPendingTurn();
    this.pendingTurns.set(threadId, pending);
    try {
      const response = await this.connection.request("turn/start", {
        threadId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        cwd: input.workspace,
        approvalPolicy: "never",
        model: input.model,
        effort: input.thinking,
      });
      pending.turnId = parseTurnStartResponse(response);
      const completion = await pending.promise;
      if (completion.status !== "completed") {
        throw new Error(
          completion.error
            ? `Codex turn ${completion.status}: ${completion.error}`
            : `Codex turn ${completion.status}.`,
        );
      }
      const items = mergeItems(pending.items, completion.items);
      const finalResponse = finalAgentMessage(items);
      if (!finalResponse) throw new Error("Codex completed without a final response.");
      return {
        provider: "codex",
        providerSessionId: threadId,
        finalResponse,
        items,
      };
    } catch (error) {
      if (this.pendingTurns.get(threadId) === pending) this.pendingTurns.delete(threadId);
      throw error;
    } finally {
      activity.active = false;
      activity.lastUsedAt = Date.now();
    }
  }

  isUsable(): boolean {
    return !this.closed && this.connection.isUsable();
  }

  async reapIdleSessions(now: number): Promise<void> {
    for (const [threadId, activity] of this.threadActivity) {
      if (activity.active || now - activity.lastUsedAt < CODEX_THREAD_IDLE_MS) continue;
      try {
        await this.connection.request("thread/unsubscribe", { threadId });
        this.threadActivity.delete(threadId);
      } catch {
        // Keep it tracked so a later reap can retry if the connection recovers.
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.unsubscribeClose();
    const error = new Error("Codex app-server runtime closed.");
    this.rejectPendingTurns(error);
    this.threadActivity.clear();
    await this.connection.close();
  }

  private async startThread(input: LocalAgentRunInput): Promise<string> {
    const response = await this.connection.request("thread/start", {
      cwd: input.workspace,
      approvalPolicy: "never",
      sandbox: sandboxModeFor(input.writeMode),
      model: input.model,
    });
    return parseThreadResponse(response, "thread/start");
  }

  private async resumeThread(threadId: string, input: LocalAgentRunInput): Promise<string> {
    const response = await this.connection.request("thread/resume", {
      threadId,
      cwd: input.workspace,
      approvalPolicy: "never",
      sandbox: sandboxModeFor(input.writeMode),
      model: input.model,
    });
    return parseThreadResponse(response, "thread/resume");
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "item/completed") {
      const item = parseCompletedItem(params);
      if (!item) return;
      const pending = this.pendingTurns.get(item.threadId);
      if (!pending) return;
      if (pending.turnId && pending.turnId !== item.turnId) return;
      pending.items.push(item.item);
      return;
    }
    if (method !== "turn/completed") return;
    const completion = parseTurnCompletion(params);
    if (!completion) return;
    const pending = this.pendingTurns.get(completion.threadId);
    if (!pending) return;
    if (pending.turnId && pending.turnId !== completion.turnId) return;
    this.pendingTurns.delete(completion.threadId);
    pending.resolve(completion.result);
  }

  private rejectPendingTurns(error: Error): void {
    for (const pending of this.pendingTurns.values()) pending.reject(error);
    this.pendingTurns.clear();
  }
}

export function createCodexHarnessDriver(
  env: NodeJS.ProcessEnv = process.env,
): HarnessDriver {
  return {
    provider: "codex",
    runtimeKey: () => resolveCodexCommand(env)?.runtimeKey ?? "unavailable",
    createRuntime: async () => {
      const command = resolveCodexCommand(env);
      if (!command) {
        throw new Error(
          `${env.CODEX_COMMAND?.trim() || "codex"} executable not found. Install Codex or set CODEX_COMMAND.`,
        );
      }
      return new CodexAppServerRuntime(await startCodexAppServer(command));
    },
  };
}

function sandboxModeFor(writeMode: LocalAgentWriteMode | undefined): CodexSandboxMode {
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

function createPendingTurn(): PendingTurn {
  let resolve!: (value: TurnCompletion) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<TurnCompletion>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { items: [], promise, resolve, reject };
}

function parseThreadResponse(value: unknown, method: string): string {
  const result = asRecord(value);
  const thread = asRecord(result?.thread);
  const id = stringValue(thread?.id);
  if (!id) throw new Error(`Codex ${method} response is missing thread.id.`);
  return id;
}

function parseTurnStartResponse(value: unknown): string {
  const result = asRecord(value);
  const turn = asRecord(result?.turn);
  const id = stringValue(turn?.id);
  if (!id) throw new Error("Codex turn/start response is missing turn.id.");
  return id;
}

function parseCompletedItem(value: unknown): { threadId: string; turnId: string; item: unknown } | undefined {
  const params = asRecord(value);
  const threadId = stringValue(params?.threadId);
  const turnId = stringValue(params?.turnId);
  if (!threadId || !turnId || params?.item === undefined) return undefined;
  return { threadId, turnId, item: params.item };
}

function parseTurnCompletion(value: unknown): {
  threadId: string;
  turnId: string;
  result: TurnCompletion;
} | undefined {
  const params = asRecord(value);
  const threadId = stringValue(params?.threadId);
  const turn = asRecord(params?.turn);
  const turnId = stringValue(turn?.id);
  const status = turn?.status;
  if (!threadId || !turn || !turnId || (status !== "completed" && status !== "interrupted" && status !== "failed")) {
    return undefined;
  }
  const error = asRecord(turn.error);
  const errorMessage = stringValue(error?.message) ?? stringValue(error?.additionalDetails);
  return {
    threadId,
    turnId,
    result: {
      status,
      error: errorMessage,
      items: Array.isArray(turn.items) ? turn.items : [],
    },
  };
}

function mergeItems(completed: unknown[], turnItems: unknown[]): unknown[] {
  if (completed.length === 0) return turnItems;
  if (turnItems.length === 0) return completed;
  const merged = [...completed];
  const ids = new Set(completed.map(itemId).filter((id): id is string => Boolean(id)));
  for (const item of turnItems) {
    const id = itemId(item);
    if (id && ids.has(id)) continue;
    if (id) ids.add(id);
    merged.push(item);
  }
  return merged;
}

function finalAgentMessage(items: unknown[]): string | undefined {
  let fallback: string | undefined;
  let final: string | undefined;
  for (const item of items) {
    const record = asRecord(item);
    if (record?.type !== "agentMessage") continue;
    const text = stringValue(record.text);
    if (!text) continue;
    fallback = text;
    if (record.phase === "final_answer") final = text;
  }
  return final ?? fallback;
}

function itemId(value: unknown): string | undefined {
  return stringValue(asRecord(value)?.id);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

