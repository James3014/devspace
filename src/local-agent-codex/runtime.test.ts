import assert from "node:assert/strict";
import { CodexAppServerRuntime } from "./runtime.js";
import type { CodexAppServerConnection } from "./app-server-transport.js";

class FakeCodexConnection implements CodexAppServerConnection {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  private readonly handlers = new Set<(method: string, params: unknown) => void>();
  private readonly closeHandlers = new Set<(error: Error) => void>();
  private threadCount = 0;
  private turnCount = 0;
  private usable = true;
  autoCompleteTurns = true;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: `thread_${++this.threadCount}` } };
    }
    if (method === "thread/resume") {
      const record = asRecord(params);
      return { thread: { id: record?.threadId } };
    }
    if (method === "turn/start") {
      const record = asRecord(params);
      const threadId = stringValue(record?.threadId) ?? "missing";
      const prompt = firstPrompt(record?.input);
      const turnId = `turn_${++this.turnCount}`;
      if (this.autoCompleteTurns) queueMicrotask(() => {
        this.emit("item/completed", {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            id: `item_${turnId}`,
            text: `response:${prompt}`,
            phase: "final_answer",
          },
        });
        this.emit("turn/completed", {
          threadId,
          turn: {
            id: turnId,
            status: "completed",
            items: [],
          },
        });
      });
      return { turn: { id: turnId } };
    }
    if (method === "thread/unsubscribe") return {};
    throw new Error(`Unexpected request: ${method}`);
  }

  notify(): void {}

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onClose(handler: (error: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  isUsable(): boolean {
    return this.usable;
  }

  async close(): Promise<void> {
    this.usable = false;
  }

  emitClose(error: Error): void {
    this.usable = false;
    for (const handler of this.closeHandlers) handler(error);
  }

  private emit(method: string, params: unknown): void {
    for (const handler of this.handlers) handler(method, params);
  }
}

const connection = new FakeCodexConnection();
const runtime = new CodexAppServerRuntime(connection);

try {
  const [first, second] = await Promise.all([
    runtime.run({
      workspace: "/tmp/a",
      prompt: "one",
      writeMode: "read_only",
      model: "gpt-test",
      thinking: "high",
    }),
    runtime.run({
      workspace: "/tmp/b",
      prompt: "two",
      writeMode: "allowed",
    }),
  ]);

  assert.equal(first.providerSessionId, "thread_1");
  assert.equal(first.finalResponse, "response:one");
  assert.equal(second.providerSessionId, "thread_2");
  assert.equal(second.finalResponse, "response:two");

  const resumed = await runtime.run({
    workspace: "/tmp/a",
    prompt: "continue",
    providerSessionId: "thread_1",
    writeMode: "full_access",
    model: "gpt-next",
    thinking: "xhigh",
  });
  assert.equal(resumed.providerSessionId, "thread_1");
  assert.equal(resumed.finalResponse, "response:continue");

  const startRequests = connection.requests.filter((request) => request.method === "thread/start");
  assert.equal(startRequests.length, 2, "one App Server runtime should host multiple Codex threads");
  assert.deepEqual(startRequests.map((request) => asRecord(request.params)?.sandbox), [
    "read-only",
    "workspace-write",
  ]);

  const resumeRequest = connection.requests.find((request) => request.method === "thread/resume");
  assert.deepEqual(resumeRequest, {
    method: "thread/resume",
    params: {
      threadId: "thread_1",
      cwd: "/tmp/a",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: "gpt-next",
    },
  });

  const finalTurn = connection.requests.filter((request) => request.method === "turn/start").at(-1);
  assert.equal(asRecord(finalTurn?.params)?.effort, "xhigh");

  await runtime.reapIdleSessions(Date.now() + 5 * 60 * 1_000 + 1);
  const unsubscribes = connection.requests.filter((request) => request.method === "thread/unsubscribe");
  assert.deepEqual(
    unsubscribes.map((request) => asRecord(request.params)?.threadId).sort(),
    ["thread_1", "thread_2"],
    "idle Codex threads should be released while the shared App Server stays alive",
  );
} finally {
  await runtime.close();
}

{
  const closingConnection = new FakeCodexConnection();
  closingConnection.autoCompleteTurns = false;
  const closingRuntime = new CodexAppServerRuntime(closingConnection);
  try {
    const run = closingRuntime.run({
      workspace: "/tmp/a",
      prompt: "wait for close",
      writeMode: "allowed",
    });
    await waitForRequest(closingConnection, "turn/start");
    closingConnection.emitClose(new Error("Codex app-server exited unexpectedly."));
    await assert.rejects(run, /exited unexpectedly/);
  } finally {
    await closingRuntime.close();
  }
}

function firstPrompt(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return stringValue(asRecord(value[0])?.text) ?? "";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function waitForRequest(connection: FakeCodexConnection, method: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (connection.requests.some((request) => request.method === method)) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${method}.`);
}
