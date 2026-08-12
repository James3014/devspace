import assert from "node:assert/strict";
import { PiHarnessRuntime } from "./runtime.js";

class FakePiSession {
  messages: unknown[] = [];
  selectedModel: string | undefined;
  thinking: string | undefined;
  disposed = false;

  constructor(readonly sessionId: string) {}

  listModels(): unknown[] {
    return [
      { provider: "openai", id: "gpt-test" },
      { provider: "anthropic", id: "claude-test" },
    ];
  }

  async prompt(text: string): Promise<void> {
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
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
    this.disposed = true;
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
  assert.equal(sessions.get("pi_1")?.selectedModel, "openai/gpt-test");
  assert.equal(sessions.get("pi_1")?.thinking, "high");
} finally {
  await runtime.close();
}
