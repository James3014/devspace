import assert from "node:assert/strict";
import { PiHarnessRuntime } from "./runtime.js";

class FakePiSession {
  messages: unknown[] = [];
  selectedModel: string | undefined;
  thinking: string | undefined;
  disposed = false;
  disposeError: Error | undefined;

  constructor(readonly sessionId: string) {}

  listModels(): unknown[] {
    return [
      { provider: "openai", id: "gpt-test" },
      { provider: "anthropic", id: "claude-test" },
    ];
  }

  async prompt(text: string): Promise<void> {
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    if (text === "silent") return;
    this.messages.push({
      role: "assistant",
      content: [{ type: "text", text: `response:${text}` }],
    });
  }

  async setModel(model: unknown): Promise<void> {
    const record = model as { provider?: unknown; id?: unknown };
    this.selectedModel = `${String(record.provider)}/${String(record.id)}`;
  }

  setThinkingLevel(level: string): void {
    this.thinking = level;
  }

  dispose(): void {
    if (this.disposeError) throw this.disposeError;
    this.disposed = true;
  }
}

class BlockingPiSession extends FakePiSession {
  readonly promptStarts: string[] = [];
  readonly firstPromptGate = deferred<void>();

  override async prompt(text: string): Promise<void> {
    this.promptStarts.push(text);
    if (text === "first queued") await this.firstPromptGate.promise;
    await super.prompt(text);
  }
}

let created = 0;
const sessions = new Map<string, FakePiSession>();
const runtime = new PiHarnessRuntime(async (_input, providerSessionId) => {
  created += 1;
  const session = new FakePiSession(providerSessionId ?? `pi_${created}`);
  sessions.set(session.sessionId, session);
  return session;
});

try {
  const first = await runtime.run({
    workspace: "/tmp/a",
    prompt: "first",
    model: "openai/gpt-test",
    thinking: "high",
  });
  const second = await runtime.run({
    workspace: "/tmp/a",
    prompt: "second",
    providerSessionId: first.providerSessionId ?? undefined,
  });
  const third = await runtime.run({
    workspace: "/tmp/b",
    prompt: "third",
  });

  await assert.rejects(
    runtime.run({
      workspace: "/tmp/b",
      prompt: "wrong workspace",
      providerSessionId: first.providerSessionId ?? undefined,
    }),
    /belongs to workspace \/tmp\/a, not \/tmp\/b/,
  );

  assert.equal(created, 2, "one in-process Pi runtime should retain active logical sessions");
  assert.equal(first.providerSessionId, "pi_1");
  assert.equal(second.providerSessionId, "pi_1");
  assert.equal(third.providerSessionId, "pi_2");
  assert.equal(first.finalResponse, "response:first");
  assert.equal(second.finalResponse, "response:second");
  assert.equal(first.items.length, 2);
  assert.equal(second.items.length, 2, "continued turns should return only messages produced by that turn");
  assert.equal(sessions.get("pi_1")?.selectedModel, "openai/gpt-test");
  assert.equal(sessions.get("pi_1")?.thinking, "high");

  await assert.rejects(
    runtime.run({
      workspace: "/tmp/a",
      prompt: "silent",
      providerSessionId: first.providerSessionId ?? undefined,
    }),
    /completed without a final response/,
  );
} finally {
  await runtime.close();
}

{
  let coldCreates = 0;
  const creationGate = deferred<void>();
  const coldRuntime = new PiHarnessRuntime(async (_input, providerSessionId) => {
    coldCreates += 1;
    await creationGate.promise;
    return new FakePiSession(providerSessionId ?? `cold_${coldCreates}`);
  });

  try {
    const first = coldRuntime.run({
      workspace: "/tmp/a",
      prompt: "first resume",
      providerSessionId: "pi_existing",
    });
    const second = coldRuntime.run({
      workspace: "/tmp/a",
      prompt: "second resume",
      providerSessionId: "pi_existing",
    });
    await immediate();
    assert.equal(coldCreates, 1, "concurrent cold resumes of one Pi session should share session creation");
    creationGate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.finalResponse, "response:first resume");
    assert.equal(secondResult.finalResponse, "response:second resume");
  } finally {
    await coldRuntime.close();
  }
}

{
  const session = new BlockingPiSession("pi_serialized");
  const serializedRuntime = new PiHarnessRuntime(async () => session);

  try {
    const first = serializedRuntime.run({
      workspace: "/tmp/a",
      prompt: "first queued",
      providerSessionId: session.sessionId,
    });
    await immediate();
    const second = serializedRuntime.run({
      workspace: "/tmp/a",
      prompt: "second queued",
      providerSessionId: session.sessionId,
    });
    await immediate();
    assert.deepEqual(session.promptStarts, ["first queued"], "turns on one Pi session must not overlap");

    session.firstPromptGate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(session.promptStarts, ["first queued", "second queued"]);
  } finally {
    await serializedRuntime.close();
  }
}

{
  const first = new FakePiSession("pi_dispose_1");
  const second = new FakePiSession("pi_dispose_2");
  first.disposeError = new Error("dispose failed");
  const byId = new Map([[first.sessionId, first], [second.sessionId, second]]);
  const cleanupRuntime = new PiHarnessRuntime(async (_input, providerSessionId) => {
    const session = providerSessionId ? byId.get(providerSessionId) : undefined;
    if (!session) throw new Error("missing test session");
    return session;
  });

  await cleanupRuntime.run({ workspace: "/tmp/a", prompt: "one", providerSessionId: first.sessionId });
  await cleanupRuntime.run({ workspace: "/tmp/a", prompt: "two", providerSessionId: second.sessionId });
  await assert.rejects(cleanupRuntime.close(), /dispose failed/);
  assert.equal(second.disposed, true, "one dispose failure must not strand later Pi sessions");
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise as (value?: T) => void;
  });
  return { promise, resolve };
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
