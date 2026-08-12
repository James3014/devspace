import assert from "node:assert/strict";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeWarmRuntime,
  type ClaudeQueryLike,
} from "./runtime.js";

class FakeClaudeQuery implements ClaudeQueryLike {
  readonly models: Array<string | undefined> = [];
  closed = false;
  private readonly prompts: AsyncIterator<SDKUserMessage>;
  private turn = 0;

  constructor(
    prompts: AsyncIterable<SDKUserMessage>,
    readonly sessionId: string,
  ) {
    this.prompts = prompts[Symbol.asyncIterator]();
  }

  async next(): Promise<IteratorResult<SDKMessage, void>> {
    const prompt = await this.prompts.next();
    if (prompt.done) return { done: true, value: undefined };
    this.turn += 1;
    const content = prompt.value.message.content;
    const text = typeof content === "string" ? content : JSON.stringify(content);
    return {
      done: false,
      value: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: `response:${text}`,
        session_id: this.sessionId,
      } as SDKMessage,
    };
  }

  async setModel(model?: string): Promise<void> {
    this.models.push(model);
  }

  close(): void {
    this.closed = true;
  }
}

const queries: FakeClaudeQuery[] = [];
const resumes: Array<string | undefined> = [];
const efforts: Array<string | undefined> = [];
const runtime = new ClaudeWarmRuntime((input, prompts, resume) => {
  resumes.push(resume);
  efforts.push(input.thinking);
  const query = new FakeClaudeQuery(prompts, resume ?? `claude_${queries.length + 1}`);
  queries.push(query);
  return query;
});

try {
  const first = await runtime.run({
    agentId: "agt_claude",
    workspace: "/tmp/project",
    prompt: "first",
    model: "sonnet",
    thinking: "high",
  });
  const second = await runtime.run({
    agentId: "agt_claude",
    workspace: "/tmp/project",
    prompt: "second",
    providerSessionId: first.providerSessionId ?? undefined,
    model: "opus",
    thinking: "high",
  });

  assert.equal(queries.length, 1, "same agent and effort should reuse one live Claude query");
  assert.equal(first.providerSessionId, "claude_1");
  assert.equal(second.providerSessionId, "claude_1");
  assert.equal(first.finalResponse, "response:first");
  assert.equal(second.finalResponse, "response:second");
  assert.deepEqual(queries[0]?.models, ["opus"], "model changes should use the live query control channel");

  const changedEffort = await runtime.run({
    agentId: "agt_claude",
    workspace: "/tmp/project",
    prompt: "third",
    providerSessionId: second.providerSessionId ?? undefined,
    model: "opus",
    thinking: "xhigh",
  });

  assert.equal(queries.length, 2, "session-start-only effort changes should replace only the live query");
  assert.equal(queries[0]?.closed, true);
  assert.deepEqual(resumes, [undefined, "claude_1"]);
  assert.deepEqual(efforts, ["high", "xhigh"]);
  assert.equal(changedEffort.providerSessionId, "claude_1");
  assert.equal(changedEffort.finalResponse, "response:third");

  await assert.rejects(
    runtime.run({
      agentId: "agt_claude",
      workspace: "/tmp/other-project",
      prompt: "wrong workspace",
      providerSessionId: changedEffort.providerSessionId ?? undefined,
      thinking: "xhigh",
    }),
    /belongs to workspace \/tmp\/project, not \/tmp\/other-project/,
  );
  assert.equal(queries.length, 2, "workspace mismatch must not create or reuse a query in another cwd");
} finally {
  await runtime.close();
}

assert.equal(queries.at(-1)?.closed, true);
