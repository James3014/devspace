import type { LocalAgentRunInput, LocalAgentRunResult } from "../local-agent-runtime.js";
import type { HarnessDriver, HarnessRuntime } from "../local-agent-runtime-pool.js";

interface PiSessionLike {
  readonly sessionId: string;
  readonly messages: unknown[];
  listModels(): unknown[];
  prompt(text: string): Promise<void>;
  setModel(model: unknown): Promise<void>;
  setThinkingLevel(level: string): void;
  dispose(): void;
}

type PiSessionFactory = (
  input: LocalAgentRunInput,
  providerSessionId?: string,
) => Promise<PiSessionLike>;

interface PiSessionEntry {
  workspace: string;
  session: PiSessionLike;
  tail: Promise<void>;
}

type PiSessionSlot =
  | { status: "starting"; workspace: string; promise: Promise<PiSessionEntry> }
  | { status: "ready"; entry: PiSessionEntry };

export class PiHarnessRuntime implements HarnessRuntime {
  private readonly sessions = new Map<string, PiSessionSlot>();
  private closed = false;

  constructor(private readonly createSession: PiSessionFactory) {}

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    if (this.closed) throw new Error("Pi runtime is closed.");
    const entry = await this.ensureSession(input);
    const turn = entry.tail
      .catch(() => undefined)
      .then(() => this.runTurn(entry.session, input));
    entry.tail = turn.then(() => undefined, () => undefined);
    return turn;
  }

  private async runTurn(
    session: PiSessionLike,
    input: LocalAgentRunInput,
  ): Promise<LocalAgentRunResult> {
    if (input.model) {
      await session.setModel(resolvePiModel(session.listModels(), input.model));
    }
    if (input.thinking) session.setThinkingLevel(input.thinking);

    const startIndex = session.messages.length;
    await session.prompt(input.prompt);
    const turnMessages = session.messages.slice(startIndex);
    const finalResponse = finalPiAssistantMessage(turnMessages);
    if (!finalResponse) throw new Error("Pi completed without a final response.");
    return {
      provider: "pi",
      providerSessionId: session.sessionId,
      finalResponse,
      items: turnMessages,
    };
  }

  isUsable(): boolean {
    return !this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const slots = Array.from(this.sessions.values());
    this.sessions.clear();

    const entries = await Promise.all(slots.map(async (slot) => {
      if (slot.status === "ready") return slot.entry;
      return slot.promise.catch(() => undefined);
    }));
    let firstError: unknown;
    for (const entry of entries) {
      if (!entry) continue;
      await entry.tail.catch(() => undefined);
      try {
        entry.session.dispose();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  private async ensureSession(input: LocalAgentRunInput): Promise<PiSessionEntry> {
    if (input.providerSessionId) {
      const existing = this.sessions.get(input.providerSessionId);
      if (existing) {
        const workspace = existing.status === "ready" ? existing.entry.workspace : existing.workspace;
        if (workspace !== input.workspace) {
          throw new Error(
            `Pi session ${input.providerSessionId} belongs to workspace ${workspace}, not ${input.workspace}.`,
          );
        }
        return existing.status === "ready" ? existing.entry : existing.promise;
      }

      let starting!: Extract<PiSessionSlot, { status: "starting" }>;
      const promise = this.createSession(input, input.providerSessionId)
        .then((session) => this.finishSessionStart(input.workspace, input.providerSessionId!, session, starting));
      starting = { status: "starting", workspace: input.workspace, promise };
      this.sessions.set(input.providerSessionId, starting);
      try {
        return await promise;
      } catch (error) {
        if (this.sessions.get(input.providerSessionId) === starting) {
          this.sessions.delete(input.providerSessionId);
        }
        throw error;
      }
    }

    const session = await this.createSession(input, input.providerSessionId);
    const entry = createPiSessionEntry(input.workspace, session);
    this.sessions.set(session.sessionId, { status: "ready", entry });
    return entry;
  }

  private finishSessionStart(
    workspace: string,
    requestedSessionId: string,
    session: PiSessionLike,
    starting: Extract<PiSessionSlot, { status: "starting" }>,
  ): PiSessionEntry {
    const entry = createPiSessionEntry(workspace, session);
    if (this.sessions.get(requestedSessionId) === starting) {
      this.sessions.delete(requestedSessionId);
      this.sessions.set(session.sessionId, { status: "ready", entry });
    }
    return entry;
  }
}

function createPiSessionEntry(workspace: string, session: PiSessionLike): PiSessionEntry {
  return { workspace, session, tail: Promise.resolve() };
}

export function createPiHarnessDriver(): HarnessDriver {
  return {
    provider: "pi",
    runtimeKey: () => "in-process",
    createRuntime: async () => {
      const {
        AuthStorage,
        ModelRegistry,
        SessionManager,
        createAgentSession,
      } = await import("@earendil-works/pi-coding-agent");
      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);

      return new PiHarnessRuntime(async (input, providerSessionId) => {
        const sessionManager = providerSessionId
          ? await openPiSessionManager(SessionManager, input.workspace, providerSessionId)
          : SessionManager.create(input.workspace);
        const { session } = await createAgentSession({
          cwd: input.workspace,
          authStorage,
          modelRegistry,
          sessionManager,
        });
        return {
          get sessionId() {
            return session.sessionId;
          },
          get messages() {
            return session.messages;
          },
          listModels: () => session.modelRegistry.getAll(),
          prompt: (text) => session.prompt(text),
          setModel: (model) => session.setModel(model as Parameters<typeof session.setModel>[0]),
          setThinkingLevel: (level) => session.setThinkingLevel(
            level as Parameters<typeof session.setThinkingLevel>[0],
          ),
          dispose: () => session.dispose(),
        };
      });
    },
  };
}

async function openPiSessionManager(
  SessionManager: typeof import("@earendil-works/pi-coding-agent").SessionManager,
  cwd: string,
  sessionId: string,
): Promise<ReturnType<typeof SessionManager.create>> {
  const sessions = await SessionManager.list(cwd);
  const match = sessions.find((candidate) => candidate.id === sessionId);
  if (!match) {
    throw new Error(`Pi session ${sessionId} was not found for workspace ${cwd}.`);
  }
  return SessionManager.open(match.path, undefined, cwd);
}

function resolvePiModel(models: unknown[], reference: string): unknown {
  const normalized = reference.trim().toLowerCase();
  const matches = models.filter((model) => {
    const record = asRecord(model);
    const provider = stringValue(record?.provider);
    const id = stringValue(record?.id);
    if (!provider || !id) return false;
    const canonical = `${provider}/${id}`.toLowerCase();
    return canonical === normalized || id.toLowerCase() === normalized;
  });
  if (matches.length === 1) return matches[0];

  const fuzzy = models.filter((model) => {
    const record = asRecord(model);
    const provider = stringValue(record?.provider);
    const id = stringValue(record?.id);
    if (!provider || !id) return false;
    return `${provider}/${id}`.toLowerCase().includes(normalized);
  });
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1 || matches.length > 1) {
    throw new Error(`Pi model '${reference}' is ambiguous. Use a provider/model id.`);
  }
  throw new Error(`Pi model '${reference}' was not found.`);
}

function finalPiAssistantMessage(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message?.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .map((part) => {
        const record = asRecord(part);
        return record?.type === "text" ? stringValue(record.text) ?? "" : "";
      })
      .join("")
      .trim();
    if (text) return text;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
