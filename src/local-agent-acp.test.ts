import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  AcpLocalAgentDriver,
  AcpRuntime,
  appendAcpQueueValue,
  acpCommandArgs,
  resolveAcpCommand,
  selectAcpPermissionOption,
} from "./local-agent-acp.js";
import { GrokPromptCompletionRegistry } from "./local-agent-grok.js";

const requests: Array<{ method: string; params?: unknown }> = [];
const queues = new Map<string, { values: unknown[] }>();
const connection = {
  agent: {
    async request(method: string, params?: unknown): Promise<unknown> {
      requests.push({ method, params });
      const input = params as { sessionId?: string } | undefined;
      if (method === "session/new") {
        const sessionId = "cursor_session_1";
        queues.set(sessionId, { values: [] });
        return {
          sessionId,
          configOptions: [
            { type: "select", category: "model", id: "model", options: [{ value: "model-a" }] },
            { type: "select", category: "thought_level", id: "effort", options: [{ value: "high" }] },
          ],
        };
      }
      if (method === "session/resume") {
        const sessionId = input?.sessionId ?? "cursor_session_1";
        queues.set(sessionId, { values: [] });
        return { sessionId };
      }
      if (method === "session/prompt") {
        const queue = queues.get(input?.sessionId ?? "");
        queue?.values.push({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ACP response" },
          },
        });
        return { stopReason: "end_turn" };
      }
      return {};
    },
  },
  close() {},
  closed: new Promise<void>(() => undefined),
};

const sessionIds: string[] = [];
const runtime = new AcpRuntime({
  provider: "cursor",
  command: "cursor-agent",
  args: ["acp"],
  env: {},
  capabilities: { resume: true, close: true, additionalDirectories: true },
  queues,
}, connection);

const firstResult = await runtime.run({
  prompt: "first",
  workspaceRoot: "/tmp/project",
  model: "model-a",
  effort: "high",
  writeMode: "read_only",
}, {
  onSessionId: (sessionId) => { sessionIds.push(sessionId); },
});
assert.equal(firstResult.isOk(), true);
if (firstResult.isErr()) throw firstResult.error;
const first = firstResult.value;
const warmResult = await runtime.run({
  prompt: "warm",
  workspaceRoot: "/tmp/project",
  providerSessionId: first.providerSessionId ?? undefined,
  model: "model-a",
  effort: "high",
  writeMode: "full_access",
}, {
  onSessionId: (sessionId) => { sessionIds.push(sessionId); },
});
assert.equal(warmResult.isOk(), true);
if (warmResult.isErr()) throw warmResult.error;
const warm = warmResult.value;

assert.equal(first.providerSessionId, "cursor_session_1");
assert.equal(warm.finalResponse, "ACP response");
assert.deepEqual(sessionIds, ["cursor_session_1", "cursor_session_1"]);
assert.equal(requests.filter(({ method }) => method === "session/new").length, 1);
assert.equal(requests.filter(({ method }) => method === "session/resume").length, 0);
assert.equal(requests.filter(({ method }) => method === "session/set_config_option").length, 4);
assert.equal(
  Object.hasOwn(requests.find(({ method }) => method === "session/new")?.params as object, "additionalDirectories"),
  false,
);

await runtime.releaseSession("cursor_session_1");
assert.equal(queues.has("cursor_session_1"), false);
assert.equal(requests.filter(({ method }) => method === "session/close").length, 1);
assert.equal(runtime.isAlive(), true);

const resumedRuntime = new AcpRuntime({
  provider: "cursor",
  command: "cursor-agent",
  args: ["acp"],
  env: {},
  capabilities: { resume: true, close: false },
  queues,
}, connection);
const resumedPersistedResult = await resumedRuntime.run({
  prompt: "resumed with persisted config",
  workspaceRoot: "/tmp/project",
  providerSessionId: first.providerSessionId ?? undefined,
  model: "model-a",
  effort: "high",
});
assert.equal(resumedPersistedResult.isOk(), true);
if (resumedPersistedResult.isErr()) throw resumedPersistedResult.error;
const resumedPersisted = resumedPersistedResult.value;
assert.equal(resumedPersisted.finalResponse, "ACP response");
assert.equal(
  requests.filter(({ method }) => method === "session/set_config_option").length,
  4,
  "cold resume must not require config metadata just to preserve prior model/effort state",
);
const resumeFailure = await resumedRuntime.run({
  prompt: "resumed",
  workspaceRoot: "/tmp/project",
  providerSessionId: first.providerSessionId ?? undefined,
  model: "model-that-is-not-advertised-after-resume",
  modelOverrideRequested: true,
});
assert.equal(resumeFailure.isErr(), true);
if (resumeFailure.isErr()) assert.equal(resumeFailure.error.code, "PROVIDER_PROTOCOL_ERROR");
assert.equal(requests.filter(({ method }) => method === "session/resume").length, 1);
assert.equal(requests.filter(({ method }) => method === "session/set_config_option").length, 4);
await resumedRuntime.releaseSession("cursor_session_1");
assert.equal(queues.has("cursor_session_1"), false);
assert.equal(requests.filter(({ method }) => method === "session/close").length, 1);

const closeOnlyRuntime = new AcpRuntime({
  provider: "cursor",
  command: "cursor-agent",
  args: ["acp"],
  env: {},
  capabilities: { resume: false, close: true },
}, connection);
await closeOnlyRuntime.releaseSession("close_only_session");
assert.equal(
  requests.filter(({ method, params }) => method === "session/close" && (params as { sessionId?: string })?.sessionId === "close_only_session").length,
  1,
  "session close support must not depend on resume support",
);
await closeOnlyRuntime.close();

// Cline ACP route selection is session-scoped and must read back both the
// exact provider family and model before any prompt is dispatched.
{
  const requestedModel = "deepseek/deepseek-v4-flash";
  const sessionId = "cline_route_selection";
  const calls: Array<{ method: string; params?: unknown }> = [];
  const queues = new Map<string, { values: unknown[] }>();
  const response = (provider: string, model: string, models = [requestedModel, "anthropic/claude-sonnet-5"]) => ({
    sessionId,
    models: { currentModelId: model, availableModels: models.map((modelId) => ({ modelId })) },
    configOptions: [
      { type: "select", id: "provider", currentValue: provider, options: [{ value: "cline" }, { value: "cline-pass" }] },
      { type: "select", id: "model", currentValue: model, options: models.map((value) => ({ value })) },
    ],
  });
  const connection = {
    agent: {
      async request(method: string, params?: unknown): Promise<unknown> {
        calls.push({ method, params });
        const input = params as { sessionId?: string; configId?: string; value?: string } | undefined;
        if (method === "session/new") {
          queues.set(sessionId, { values: [] });
          return response("cline", "anthropic/claude-sonnet-5");
        }
        if (method === "session/set_config_option") {
          return response(input?.configId === "provider" ? input.value ?? "unknown" : input?.configId === "model" ? "cline-pass" : "cline", input?.configId === "model" ? input.value ?? "unknown" : "anthropic/claude-sonnet-5");
        }
        if (method === "session/prompt") {
          queues.get(sessionId)?.values.push({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } });
          return { stopReason: "end_turn" };
        }
        return {};
      },
    },
    close() {},
    closed: new Promise<void>(() => undefined),
  };
  const routeRuntime = new AcpRuntime({ provider: "cline", command: "cline", args: ["--acp"], env: {}, queues, capabilities: { resume: false, close: false } }, connection);
  const routeResult = await routeRuntime.run({ prompt: "route", workspaceRoot: "/tmp/project", model: requestedModel, cliProviderId: "cline-pass" });
  assert.equal(routeResult.isOk(), true);
  assert.deepEqual(calls.filter(({ method }) => method === "session/set_config_option").map(({ params }) => params), [
    { sessionId, configId: "provider", value: "cline-pass" },
    { sessionId, configId: "model", value: requestedModel },
  ]);
  assert.equal(calls.filter(({ method }) => method === "session/prompt").length, 1);
}

// ACP output retention keeps authoritative assistant text separate from bounded
// disposable previews and reports suppression through both result items and the
// opt-in diagnostic surface.
{
  const boundedQueues = new Map<string, { values: unknown[] }>();
  const observations: Array<Record<string, unknown>> = [];
  const boundedConnection = {
    agent: {
      async request(method: string, params?: unknown): Promise<unknown> {
        const sessionId = (params as { sessionId?: string } | undefined)?.sessionId ?? "bounded-session";
        if (method === "session/new") {
          boundedQueues.set(sessionId, { values: [] });
          return { sessionId };
        }
        if (method === "session/prompt") {
          const queue = boundedQueues.get(sessionId);
          for (let index = 0; index < 10_001; index += 1) {
            appendAcpQueueValue(queue!, {
              update: {
                sessionUpdate: "plan",
                content: { type: "text", text: `preview-${index}` },
              },
            });
          }
          appendAcpQueueValue(queue!, {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "authoritative final" },
            },
          });
          return { stopReason: "end_turn" };
        }
        return {};
      },
    },
    close() {},
    closed: new Promise<void>(() => undefined),
  };
  const boundedRuntime = new AcpRuntime({
    provider: "cursor",
    command: "cursor-agent",
    args: ["acp"],
    env: {},
    capabilities: { resume: false, close: false },
    queues: boundedQueues,
    diagnosticObserver: (observation) => { observations.push(observation as unknown as Record<string, unknown>); },
  }, boundedConnection);
  const boundedResult = await boundedRuntime.run({ prompt: "bounded", workspaceRoot: "/tmp/project" });
  assert.equal(boundedResult.isOk(), true);
  if (boundedResult.isErr()) throw boundedResult.error;
  assert.equal(boundedResult.value.finalResponse, "authoritative final");
  const retentionItem = boundedResult.value.items.at(-1) as Record<string, unknown>;
  assert.equal(retentionItem.kind, "devspace_acp_output_retention");
  assert.equal((retentionItem.previewSuppressedItems as number) > 0, true);
  assert.equal(observations.length, 1);
  const retention = observations[0].outputRetention as Record<string, unknown>;
  assert.equal((retention.previewSuppressedItems as number) > 0, true);
  assert.equal(retention.requiredOutputTruncated, false);
  assert.doesNotMatch(JSON.stringify(observations[0]), /preview-10000/);
  await boundedRuntime.close();
}

// Required assistant text is bounded in UTF-8 bytes, coalesced into one part,
// and an overflow is an explicit protocol failure rather than partial success.
{
  const requiredQueues = new Map<string, { values: unknown[] }>();
  const requiredConnection = {
    agent: {
      async request(method: string, params?: unknown): Promise<unknown> {
        const sessionId = (params as { sessionId?: string } | undefined)?.sessionId ?? "required-session";
        if (method === "session/new") {
          requiredQueues.set(sessionId, { values: [] });
          return { sessionId };
        }
        if (method === "session/prompt") {
          const queue = requiredQueues.get(sessionId)!;
          const prompt = (params as { prompt?: Array<{ text?: string }> } | undefined)?.prompt?.[0]?.text;
          if (prompt === "exact") {
            appendAcpQueueValue(queue, {
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a".repeat(1_048_574) } },
            });
            appendAcpQueueValue(queue, {
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "é" } },
            });
            appendAcpQueueValue(queue, {
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
            });
            return { stopReason: "end_turn" };
          }
          appendAcpQueueValue(queue, {
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a".repeat(1_048_575) } },
          });
          appendAcpQueueValue(queue, {
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "é" } },
          });
          return { stopReason: "end_turn" };
        }
        return {};
      },
    },
    close() {},
    closed: new Promise<void>(() => undefined),
  };
  const requiredRuntime = new AcpRuntime({
    provider: "cursor",
    command: "cursor-agent",
    args: ["acp"],
    env: {},
    capabilities: { resume: false, close: false },
    queues: requiredQueues,
  }, requiredConnection);
  const exactResult = await requiredRuntime.run({ prompt: "exact", workspaceRoot: "/tmp/project" });
  assert.equal(exactResult.isOk(), true);
  if (exactResult.isOk()) assert.equal(Buffer.byteLength(exactResult.value.finalResponse, "utf8"), 1_048_576);
  const requiredResult = await requiredRuntime.run({ prompt: "required", workspaceRoot: "/tmp/project" });
  assert.equal(requiredResult.isErr(), true);
  if (requiredResult.isErr()) {
    assert.equal(requiredResult.error.code, "PROVIDER_PROTOCOL_ERROR");
    assert.match(requiredResult.error.message, /requiredOutputBytes=1048575/);
    assert.match(requiredResult.error.message, /requiredEvidenceBytes=0/);
  }
  await requiredRuntime.close();
}

// Unknown/non-text updates are required evidence. Exceeding their bounded
// retention fails closed instead of treating them as disposable previews.
{
  const evidenceQueues = new Map<string, { values: unknown[] }>();
  const evidenceConnection = {
    agent: {
      async request(method: string, params?: unknown): Promise<unknown> {
        const sessionId = (params as { sessionId?: string } | undefined)?.sessionId ?? "evidence-session";
        if (method === "session/new") {
          evidenceQueues.set(sessionId, { values: [] });
          return { sessionId };
        }
        if (method === "session/prompt") {
          const queue = evidenceQueues.get(sessionId)!;
          let deeplyNested: Record<string, unknown> = { leaf: true };
          for (let depth = 0; depth < 256; depth += 1) deeplyNested = { child: deeplyNested };
          appendAcpQueueValue(queue, { update: { sessionUpdate: "vendor_required_event", deeplyNested } });
          for (let index = 0; index < 4_097; index += 1) {
            appendAcpQueueValue(queue, { update: { sessionUpdate: "vendor_required_event", index } });
          }
          appendAcpQueueValue(queue, {
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "must not succeed" } },
          });
          return { stopReason: "end_turn" };
        }
        return {};
      },
    },
    close() {},
    closed: new Promise<void>(() => undefined),
  };
  const evidenceRuntime = new AcpRuntime({
    provider: "cursor",
    command: "cursor-agent",
    args: ["acp"],
    env: {},
    capabilities: { resume: false, close: false },
    queues: evidenceQueues,
  }, evidenceConnection);
  const evidenceResult = await evidenceRuntime.run({ prompt: "evidence", workspaceRoot: "/tmp/project" });
  assert.equal(evidenceResult.isErr(), true);
  if (evidenceResult.isErr()) assert.match(evidenceResult.error.message, /requiredEvidenceItems=4096/);
  await evidenceRuntime.close();
}

{
  const requestedModel = "deepseek/deepseek-v4-flash";
  const queues = new Map<string, { values: unknown[] }>();
  let promptCalls = 0;
  const connection = {
    agent: {
      async request(method: string, params?: unknown): Promise<unknown> {
        const input = params as { sessionId?: string; configId?: string } | undefined;
        if (method === "session/new") {
          queues.set("cline_model_mismatch", { values: [] });
          return { sessionId: "cline_model_mismatch", models: { currentModelId: "anthropic/claude-sonnet-5", availableModels: [{ modelId: requestedModel }] }, configOptions: [
            { type: "select", id: "provider", currentValue: "cline", options: [{ value: "cline" }] },
            { type: "select", id: "model", currentValue: "anthropic/claude-sonnet-5", options: [{ value: requestedModel }] },
          ] };
        }
        if (method === "session/set_config_option") return { sessionId: input?.sessionId, configOptions: [
          { type: "select", id: "provider", currentValue: "cline", options: [{ value: "cline" }] },
          { type: "select", id: "model", currentValue: "anthropic/claude-sonnet-5", options: [{ value: requestedModel }] },
        ] };
        if (method === "session/prompt") promptCalls += 1;
        return { stopReason: "end_turn" };
      },
    },
    close() {},
    closed: new Promise<void>(() => undefined),
  };
  const runtime = new AcpRuntime({ provider: "cline", command: "cline", args: ["--acp"], env: {}, queues, capabilities: { resume: false, close: false } }, connection);
  const result = await runtime.run({ prompt: "route", workspaceRoot: "/tmp/project", model: requestedModel });
  assert.equal(result.isErr(), true);
  assert.equal(promptCalls, 0, "mismatched model readback must prevent prompt dispatch");
}

{
  const queues = new Map<string, { values: unknown[] }>();
  let promptCalls = 0;
  const connection = {
    agent: {
      async request(method: string): Promise<unknown> {
        if (method === "session/new") return { sessionId: "cline_unadvertised", models: { currentModelId: "anthropic/claude-sonnet-5", availableModels: [{ modelId: "anthropic/claude-sonnet-5" }] }, configOptions: [
          { type: "select", id: "provider", currentValue: "cline", options: [{ value: "cline" }] },
          { type: "select", id: "model", currentValue: "anthropic/claude-sonnet-5", options: [{ value: "anthropic/claude-sonnet-5" }] },
        ] };
        if (method === "session/prompt") promptCalls += 1;
        return { stopReason: "end_turn" };
      },
    },
    close() {},
    closed: new Promise<void>(() => undefined),
  };
  const runtime = new AcpRuntime({ provider: "cline", command: "cline", args: ["--acp"], env: {}, queues, capabilities: { resume: false, close: false } }, connection);
  const result = await runtime.run({ prompt: "route", workspaceRoot: "/tmp/project", model: "deepseek/deepseek-v4-flash" });
  assert.equal(result.isErr(), true);
  assert.equal(promptCalls, 0, "unadvertised model must prevent prompt dispatch");
}

{
  const requestedModel = "deepseek/deepseek-v4-flash";
  const queues = new Map<string, { values: unknown[] }>();
  let promptCalls = 0;
  const connection = {
    agent: {
      async request(method: string, params?: unknown): Promise<unknown> {
        const input = params as { sessionId?: string } | undefined;
        if (method === "session/resume") return { sessionId: input?.sessionId, models: { currentModelId: "anthropic/claude-sonnet-5", availableModels: [{ modelId: requestedModel }] }, configOptions: [
          { type: "select", id: "provider", currentValue: "cline", options: [{ value: "cline" }] },
          { type: "select", id: "model", currentValue: "anthropic/claude-sonnet-5", options: [{ value: requestedModel }] },
        ] };
        if (method === "session/set_config_option") return { sessionId: input?.sessionId, configOptions: [
          { type: "select", id: "provider", currentValue: "cline", options: [{ value: "cline" }] },
          { type: "select", id: "model", currentValue: "anthropic/claude-sonnet-5", options: [{ value: requestedModel }] },
        ] };
        if (method === "session/prompt") promptCalls += 1;
        return { stopReason: "end_turn" };
      },
    },
    close() {},
    closed: new Promise<void>(() => undefined),
  };
  const runtime = new AcpRuntime({ provider: "cline", command: "cline", args: ["--acp"], env: {}, queues, capabilities: { resume: true, close: false } }, connection);
  const result = await runtime.run({ prompt: "resume", workspaceRoot: "/tmp/project", providerSessionId: "persisted-cline", model: requestedModel });
  assert.equal(result.isErr(), true);
  assert.equal(promptCalls, 0, "resumed identity mismatch must prevent prompt dispatch");
}

{
  const queues = new Map<string, { values: unknown[] }>();
  let promptCalls = 0;
  const connection = {
    agent: {
      async request(method: string): Promise<unknown> {
        if (method === "session/new") return { sessionId: "cline_conflicting_identity", models: { currentModelId: "deepseek/deepseek-v4-flash", availableModels: [{ modelId: "deepseek/deepseek-v4-flash" }] }, configOptions: [
          { type: "select", id: "provider", currentValue: "cline", options: [{ value: "cline" }] },
          { type: "select", id: "model", currentValue: "anthropic/claude-sonnet-5", options: [{ value: "deepseek/deepseek-v4-flash" }] },
        ] };
        if (method === "session/prompt") promptCalls += 1;
        return { stopReason: "end_turn" };
      },
    },
    close() {},
    closed: new Promise<void>(() => undefined),
  };
  const runtime = new AcpRuntime({ provider: "cline", command: "cline", args: ["--acp"], env: {}, queues, capabilities: { resume: false, close: false } }, connection);
  const result = await runtime.run({ prompt: "route", workspaceRoot: "/tmp/project", model: "deepseek/deepseek-v4-flash" });
  assert.equal(result.isErr(), true);
  assert.equal(promptCalls, 0, "conflicting model identities must prevent prompt dispatch");
}

{
  const requestedModel = "deepseek/deepseek-v4-flash";
  const queues = new Map<string, { values: unknown[] }>();
  let promptCalls = 0;
  const connection = {
    agent: {
      async request(method: string): Promise<unknown> {
        if (method === "session/new") {
          queues.set("cline_effort_unsupported", { values: [] });
          return {
            sessionId: "cline_effort_unsupported",
            models: { currentModelId: requestedModel, availableModels: [{ modelId: requestedModel }] },
            configOptions: [
              { type: "select", id: "provider", currentValue: "cline", options: [{ value: "cline" }] },
              { type: "select", id: "model", currentValue: requestedModel, options: [{ value: requestedModel }] },
            ],
          };
        }
        if (method === "session/prompt") promptCalls += 1;
        return { stopReason: "end_turn" };
      },
    },
    close() {},
    closed: new Promise<void>(() => undefined),
  };
  const runtime = new AcpRuntime({ provider: "cline", command: "cline", args: ["--acp"], env: {}, queues, capabilities: { resume: false, close: false } }, connection);
  const result = await runtime.run({ prompt: "route", workspaceRoot: "/tmp/project", model: requestedModel, effort: "high" });
  assert.equal(result.isErr(), true);
  if (result.isErr()) assert.match(result.error.message, /thinking\/effort/);
  assert.equal(promptCalls, 0, "unsupported Cline effort must fail before prompt dispatch");
}

assert.deepEqual(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], "allowed"),
  { optionId: "allow" },
);
assert.deepEqual(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], "read_only"),
  { optionId: "reject" },
);
assert.equal(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], "allowed", "copilot"),
  undefined,
  "sandboxed Copilot permission requests must fail closed",
);
assert.equal(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], undefined),
  undefined,
  "permission requests for unknown ACP sessions must fail closed",
);
assert.deepEqual(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], "full_access", "copilot"),
  { optionId: "allow" },
);

const overlapQueues = new Map<string, { values: unknown[] }>();
let releaseOverlappingPrompt!: () => void;
let markPromptEntered!: () => void;
const overlappingPrompt = new Promise<void>((resolvePrompt) => { releaseOverlappingPrompt = resolvePrompt; });
const promptEntered = new Promise<void>((resolveEntered) => { markPromptEntered = resolveEntered; });
const overlapConnection = {
  agent: {
    async request(method: string, params?: unknown): Promise<unknown> {
      const input = params as { sessionId?: string } | undefined;
      if (method === "session/new") {
        overlapQueues.set("overlap_session", { values: [] });
        return { sessionId: "overlap_session" };
      }
      if (method === "session/prompt") {
        markPromptEntered();
        await overlappingPrompt;
        overlapQueues.get(input?.sessionId ?? "")?.values.push({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "overlap response" },
          },
        });
        return { stopReason: "end_turn" };
      }
      return {};
    },
  },
  close() {},
  closed: new Promise<void>(() => undefined),
};
const overlapRuntime = new AcpRuntime({
  provider: "cursor",
  command: "cursor-agent",
  args: ["acp"],
  env: {},
  queues: overlapQueues,
}, overlapConnection);
let overlapSessionId: string | undefined;
const firstOverlappingTurn = overlapRuntime.run({
  prompt: "first overlapping turn",
  workspaceRoot: "/tmp/project",
}, { onSessionId: (sessionId) => { overlapSessionId = sessionId; } });
await promptEntered;
await assert.rejects(
  overlapRuntime.run({
    prompt: "second overlapping turn",
    workspaceRoot: "/tmp/project",
    providerSessionId: overlapSessionId,
  }),
  /already has an active turn/,
);
releaseOverlappingPrompt();
const completedOverlappingTurn = await firstOverlappingTurn;
assert.equal(completedOverlappingTurn.isOk(), true);
if (completedOverlappingTurn.isErr()) throw completedOverlappingTurn.error;
assert.equal(completedOverlappingTurn.value.finalResponse, "overlap response");
await overlapRuntime.close();

let resolverCalls = 0;
const cachedDriver = new AcpLocalAgentDriver("cursor", {}, () => {
  resolverCalls += 1;
  return "/usr/local/bin/cursor-agent";
});
const cachedContext = {
  agentId: "agt_acp",
  provider: "cursor" as const,
  workspaceRoot: "/tmp/project",
  writeMode: "allowed" as const,
};
const resolvedProject = resolve("/tmp/project");
assert.equal(cachedDriver.runtimeKey(cachedContext), `acp:cursor:/usr/local/bin/cursor-agent:allowed:${resolvedProject}`);
assert.equal(cachedDriver.runtimeKey(cachedContext), `acp:cursor:/usr/local/bin/cursor-agent:allowed:${resolvedProject}`);
for (const writeMode of ["read_only", "allowed", "full_access"] as const) {
  assert.notEqual(
    cachedDriver.runtimeKey({ ...cachedContext, writeMode, workspaceRoot: "/tmp/other-project" }),
    cachedDriver.runtimeKey({ ...cachedContext, writeMode }),
    `${writeMode} ACP runtimes are scoped to one workspace root`,
  );
}
assert.equal(resolverCalls, 1, "ACP executable identity is resolved once per driver lifecycle");
assert.deepEqual(acpCommandArgs("cursor", cachedContext), [
  "acp", "--sandbox", "enabled", "--workspace", resolvedProject,
]);
assert.deepEqual(acpCommandArgs("grok", {
  ...cachedContext,
  provider: "grok",
  effort: "low",
}), ["agent", "--reasoning-effort", "low", "stdio"]);
assert.deepEqual(acpCommandArgs("grok", {
  ...cachedContext,
  provider: "grok",
  effort: "low",
}, { GROK_AGENT_PROFILE: " /tmp/grok-coding-only.md " }), [
  "agent", "--agent-profile", "/tmp/grok-coding-only.md", "--reasoning-effort", "low", "stdio",
]);
assert.deepEqual(acpCommandArgs("copilot", cachedContext), [
  "--acp", "--experimental", "--sandbox", "--allow-all-tools", "--add-dir", resolvedProject, "-C", resolvedProject,
]);
assert.deepEqual(acpCommandArgs("copilot", { ...cachedContext, writeMode: "read_only" }), [
  "--acp", "--experimental", "--sandbox", "--allow-all-tools", "--add-dir", resolvedProject, "-C", resolvedProject, "--mode", "plan",
]);
assert.deepEqual(acpCommandArgs("copilot", { ...cachedContext, writeMode: "full_access" }), [
  "--acp", "--no-sandbox", "--allow-all", "-C", resolvedProject,
]);
assert.deepEqual(acpCommandArgs("cline", {
  ...cachedContext,
  provider: "cline",
  model: "cline-pass/glm-5.3-flash",
  effort: "high",
  writeMode: "read_only",
}), ["--acp", "--provider", "cline", "--model", "cline-pass/glm-5.3-flash", "--thinking", "high", "--plan", "--auto-approve"]);
assert.deepEqual(acpCommandArgs("cline", {
  ...cachedContext,
  provider: "cline",
  cliProviderId: "cline-pass",
  model: "same-model",
  effort: "medium",
} as unknown as typeof cachedContext & { cliProviderId: "cline-pass" }), ["--acp", "--provider", "cline-pass", "--model", "same-model", "--thinking", "medium", "--auto-approve"]);
assert.throws(() => acpCommandArgs("cline", {
  ...cachedContext,
  provider: "cline",
  cliProviderId: "unexpected-provider",
} as unknown as typeof cachedContext & { cliProviderId?: "cline" | "cline-pass" }), /Unsupported Cline CLI provider/);

const missingCommandDriver = new AcpLocalAgentDriver(
  "cursor",
  process.env,
  () => join(tmpdir(), "devspace-definitely-missing-acp-command"),
);
const missingCommand = await missingCommandDriver.createRuntime(cachedContext);
assert.equal(missingCommand.isErr(), true);
if (missingCommand.isErr()) {
  assert.equal(missingCommand.error.code, "PROVIDER_PROTOCOL_ERROR");
  assert.equal(missingCommand.error.retryable, true);
}

if (process.platform === "win32") {
  const shimRoot = await mkdtemp(join(tmpdir(), "devspace-acp-shim-test-"));
  const binDir = join(shimRoot, "node_modules", ".bin");
  const marker = join(shimRoot, "args.json");
  const recorder = join(binDir, "record-args.cjs");
  const command = join(binDir, "copilot.cmd");
  const workspaceRoot = join(shimRoot, "workspace & harmless");
  try {
    await mkdir(binDir, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(
      recorder,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    await writeFile(command, `@ECHO OFF\r\n"${process.execPath}" "${recorder}" %*\r\n`);
    const shimDriver = new AcpLocalAgentDriver("copilot", process.env, () => command);
    const shimStartup = await shimDriver.createRuntime({ ...cachedContext, provider: "copilot", workspaceRoot });
    assert.equal(shimStartup.isErr(), true);
    if (shimStartup.isErr()) assert.equal(shimStartup.error.code, "PROVIDER_PROTOCOL_ERROR");
    const forwarded = JSON.parse(await readFile(marker, "utf8")) as string[];
    assert.equal(
      forwarded.filter((argument) => argument === resolve(workspaceRoot)).length,
      2,
      "Windows command shims must receive workspace paths containing shell metacharacters as literal arguments",
    );
  } finally {
    await rm(shimRoot, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  const commandRoot = await mkdtemp(join(tmpdir(), "devspace-acp-command-test-"));
  const candidate = join(commandRoot, "cursor-agent");
  const marker = join(commandRoot, "executed");
  try {
    await writeFile(candidate, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o700 });
    await chmod(candidate, 0o700);
    assert.equal(resolveAcpCommand("cursor", { PATH: commandRoot }), candidate);
    assert.equal(existsSync(marker), false, "ACP command discovery must not execute PATH candidates");
  } finally {
    await rm(commandRoot, { recursive: true, force: true });
  }
}

const grokRequests: Array<{ method: string; params?: unknown }> = [];
const grokQueues = new Map<string, { values: unknown[] }>();
const grokCompletionRegistry = new GrokPromptCompletionRegistry();
const grokConnection = {
  agent: {
    async request(method: string, params?: unknown): Promise<unknown> {
      grokRequests.push({ method, params });
      const input = params as { sessionId?: string; _meta?: { promptId?: string } } | undefined;
      if (method === "session/new") {
        grokQueues.set("grok_session_1", { values: [] });
        return {
          sessionId: "grok_session_1",
          models: {
            currentModelId: "grok-4.5",
            availableModels: [{
              modelId: "grok-4.5",
              _meta: { reasoningEfforts: [{ id: "low", value: "low" }] },
            }],
          },
        };
      }
      if (method === "session/set_model") return {};
      if (method === "session/prompt") {
        grokQueues.get(input?.sessionId ?? "")?.values.push({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Grok response" },
          },
        });
        setImmediate(() => grokCompletionRegistry.resolve({
          sessionId: input?.sessionId ?? "",
          promptId: input?._meta?.promptId,
          stopReason: "end_turn",
        }));
        return new Promise(() => undefined);
      }
      return {};
    },
  },
  close() {},
  closed: new Promise<void>(() => undefined),
};
const grokRuntime = new AcpRuntime({
  provider: "grok",
  command: "grok",
  args: ["agent", "--reasoning-effort", "low", "stdio"],
  env: {},
  capabilities: { resume: true, close: true },
  queues: grokQueues,
  grokCompletionRegistry,
  promptCompletionTimeoutMs: 100,
}, grokConnection);
const grokResult = await grokRuntime.run({
  prompt: "which model are you",
  workspaceRoot: "/tmp/project",
  model: "grok-4.5",
  effort: "low",
});
assert.equal(grokResult.isOk(), true);
if (grokResult.isErr()) throw grokResult.error;
assert.equal(grokResult.value.finalResponse, "Grok response");
assert.deepEqual(
  grokRequests.filter(({ method }) => method === "session/set_model").map(({ params }) => params),
  [{ sessionId: "grok_session_1", modelId: "grok-4.5", _meta: { reasoningEffort: "low" } }],
);
assert.equal(grokCompletionRegistry.size, 0);
await grokRuntime.close();

const grokConfigurationConnection = {
  agent: {
    async request(method: string): Promise<unknown> {
      if (method === "session/new") {
        return {
          sessionId: "grok_configuration_session",
          models: {
            currentModelId: "grok-4.5",
            availableModels: [{
              modelId: "grok-4.5",
              _meta: { reasoningEfforts: [{ id: "low", value: "low" }] },
            }],
          },
        };
      }
      return {};
    },
  },
  close() {},
  closed: new Promise<void>(() => undefined),
};
const grokConfigurationRuntime = new AcpRuntime({
  provider: "grok",
  command: "grok",
  args: ["agent", "stdio"],
  env: {},
}, grokConfigurationConnection);
const invalidGrokModel = await grokConfigurationRuntime.run({
  prompt: "invalid model",
  workspaceRoot: "/tmp/project",
  model: "grok-unknown",
});
assert.equal(invalidGrokModel.isErr(), true);
if (invalidGrokModel.isErr()) {
  assert.equal(invalidGrokModel.error.code, "PROVIDER_PROTOCOL_ERROR");
  assert.equal(invalidGrokModel.error.retryable, false);
  assert.match(invalidGrokModel.error.message, /Available models: grok-4\.5/);
}
const invalidGrokEffort = await grokConfigurationRuntime.run({
  prompt: "invalid effort",
  workspaceRoot: "/tmp/project",
  effort: "high",
});
assert.equal(invalidGrokEffort.isErr(), true);
if (invalidGrokEffort.isErr()) {
  assert.equal(invalidGrokEffort.error.code, "PROVIDER_PROTOCOL_ERROR");
  assert.equal(invalidGrokEffort.error.retryable, false);
  assert.match(invalidGrokEffort.error.message, /Available efforts: low/);
}
await grokConfigurationRuntime.close();

await resumedRuntime.close();
await resumedRuntime.close();
assert.equal(resumedRuntime.isAlive(), false);

// Cline entitlement emitted on stderr must survive the ACP runtime boundary.
{
  const clineQueues = new Map<string, { values: unknown[] }>();
  let clineSetConfigCalls = 0;
  const clineConnection = {
    agent: {
      async request(method: string, params?: unknown): Promise<unknown> {
        const input = params as { sessionId?: string } | undefined;
        if (method === "session/new") {
          const sessionId = "cline_entitlement_session";
          clineQueues.set(sessionId, { values: [] });
          return {
            sessionId,
            models: {
              currentModelId: "cline-pass/glm-5.3-flash",
              availableModels: [{ modelId: "cline-pass/glm-5.3-flash" }],
            },
            configOptions: [
              {
                type: "select",
                category: "model",
                id: "provider",
                currentValue: "cline",
                options: [{ value: "cline" }],
              },
              {
                type: "select",
                category: "model",
                id: "model",
                currentValue: "cline-pass/glm-5.3-flash",
                options: [{ value: "cline-pass/glm-5.3-flash" }],
              },
              {
                type: "select",
                category: "thought_level",
                id: "effort",
                options: [{ value: "high" }],
              },
            ],
          };
        }
        if (method === "session/set_config_option") {
          clineSetConfigCalls += 1;
          return {};
        }
        if (method === "session/prompt") return { stopReason: "error" };
        const sessionId = input?.sessionId;
        if (sessionId && !clineQueues.has(sessionId)) clineQueues.set(sessionId, { values: [] });
        return {};
      },
    },
    close() {},
    closed: new Promise<void>(() => undefined),
  };
  const clineRuntime = new AcpRuntime({
    provider: "cline",
    command: "cline",
    args: ["--acp"],
    env: {},
    queues: clineQueues,
    stderrTail: () => "No access to ClinePass subscription models yet. Please upgrade your subscription.",
  }, clineConnection);
  const clineEntitlement = await clineRuntime.run({
    prompt: "read only",
    workspaceRoot: "/tmp/project",
    model: "cline-pass/glm-5.3-flash",
    writeMode: "read_only",
  });
  assert.equal(clineEntitlement.isErr(), true);
  if (clineEntitlement.isErr()) {
    assert.equal(clineEntitlement.error.code, "CLINEPASS_ENTITLEMENT_REQUIRED");
    assert.equal(clineEntitlement.error.retryable, false);
    assert.equal(clineEntitlement.error.errorClass, "ENTITLEMENT_REQUIRED");
    assert.equal(clineEntitlement.error.providerSessionId, "cline_entitlement_session");
  }
  assert.equal(clineSetConfigCalls, 0, "Cline exact CLI model/effort must not be re-applied through ACP config options");
  await clineRuntime.close();

  const clineDriver = new AcpLocalAgentDriver("cline", {}, () => "cline");
  const clineKeyHigh = clineDriver.runtimeKey({
    agentId: "cline-high",
    provider: "cline",
    workspaceRoot: "/tmp/project",
    model: "cline-pass/glm-5.3-flash",
    effort: "high",
    writeMode: "read_only",
  });
  const clineKeyMedium = clineDriver.runtimeKey({
    agentId: "cline-medium",
    provider: "cline",
    workspaceRoot: "/tmp/project",
    model: "cline-pass/glm-5.3-flash",
    effort: "medium",
    writeMode: "read_only",
  });
  assert.notEqual(clineKeyHigh, clineKeyMedium, "Cline process runtime keys must bind process-level model/effort");
  const clineFreeKey = clineDriver.runtimeKey({
    agentId: "cline-free",
    provider: "cline",
    cliProviderId: "cline",
    workspaceRoot: "/tmp/project",
    model: "same-model",
    effort: "high",
    writeMode: "read_only",
  } as any);
  const clinePassKey = clineDriver.runtimeKey({
    agentId: "cline-pass",
    provider: "cline",
    cliProviderId: "cline-pass",
    workspaceRoot: "/tmp/project",
    model: "same-model",
    effort: "high",
    writeMode: "read_only",
  } as any);
  assert.notEqual(clineFreeKey, clinePassKey, "Cline runtime keys must bind CLI provider family");
  assert.throws(() => clineDriver.runtimeKey({
    agentId: "cline-invalid",
    provider: "cline",
    cliProviderId: "unexpected-provider",
    workspaceRoot: "/tmp/project",
  } as any), /Unsupported Cline CLI provider/);
}

// Regression tests for Grok & Cline canonical resolver parity
{
  const tempHome = await mkdtemp(join(tmpdir(), "devspace-acp-resolver-test-"));
  try {
    const grokBinDir = join(tempHome, ".grok", "bin");
    await mkdir(grokBinDir, { recursive: true });
    const grokBin = join(grokBinDir, "grok");
    await writeFile(grokBin, "#!/bin/sh\nexit 0\n");
    await chmod(grokBin, 0o755);

    const clineBinDir = join(tempHome, ".npm-global", "lib", "node_modules", "cline", "bin");
    await mkdir(clineBinDir, { recursive: true });
    const clineBin = join(clineBinDir, ".cline");
    await writeFile(clineBin, "#!/bin/sh\nexit 0\n");
    await chmod(clineBin, 0o755);

    const testEnv: NodeJS.ProcessEnv = {
      HOME: tempHome,
      PATH: "/usr/bin:/bin", // explicitly does NOT contain grok or cline in PATH
    };

    // Grok resolution parity: ~/.grok/bin/grok is resolved through resolveAcpCommand
    assert.equal(resolveAcpCommand("grok", testEnv), grokBin);
    // Explicit GROK_COMMAND has highest priority
    const explicitGrok = join(tempHome, "custom-grok");
    await writeFile(explicitGrok, "#!/bin/sh\nexit 0\n");
    await chmod(explicitGrok, 0o755);
    assert.equal(resolveAcpCommand("grok", { ...testEnv, GROK_COMMAND: explicitGrok }), explicitGrok);

    // Cline resolution parity: ~/.npm-global/.../.cline is resolved through resolveAcpCommand
    assert.equal(resolveAcpCommand("cline", testEnv), clineBin);
    // Explicit CLINE_COMMAND has highest priority
    const explicitCline = join(tempHome, "custom-cline");
    await writeFile(explicitCline, "#!/bin/sh\nexit 0\n");
    await chmod(explicitCline, 0o755);
    assert.equal(resolveAcpCommand("cline", { ...testEnv, CLINE_COMMAND: explicitCline }), explicitCline);
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
}

// Raw-byte heartbeat: provider stdout bytes must touch activity even when the
// protocol emits no session/update mid-run (Nexus issue 731).
{
  const { EventEmitter } = await import("node:events");
  const fakeChild = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null,
    killed: false,
  }) as unknown as ChildProcessWithoutNullStreams;
  const heartbeatRuntime = new AcpRuntime({
    provider: "cursor",
    command: "cursor-agent",
    args: ["acp"],
    env: {},
    capabilities: { resume: false, close: false },
    queues,
    child: fakeChild,
  }, connection);
  let heartbeatTouches = 0;
  const heartbeatRun = heartbeatRuntime.run({
    prompt: "heartbeat",
    workspaceRoot: "/tmp/project",
    writeMode: "read_only",
  }, {
    onActivity: () => { heartbeatTouches += 1; },
  });
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  fakeChild.stdout.emit("data", Buffer.from("reasoning-bytes"));
  fakeChild.stdout.emit("data", Buffer.from("more-bytes"));
  const heartbeatResult = await heartbeatRun;
  assert.equal(heartbeatResult.isOk(), true);
  if (heartbeatResult.isErr()) throw heartbeatResult.error;
  assert.ok(heartbeatTouches >= 1, `expected byte heartbeat activity touches, got ${heartbeatTouches}`);
}

// Opt-in ACP diagnostics stay schema-only and are emitted only for a failed
// or no-final-response turn. Provider text, prompts, and arbitrary keys never
// cross the observation boundary.
{
  const diagnosticQueues = new Map<string, { values: unknown[] }>();
  const diagnosticConnection = {
    agent: {
      async request(method: string, params?: unknown): Promise<unknown> {
        const sessionId = (params as { sessionId?: string } | undefined)?.sessionId ?? "diagnostic-session";
        if (method === "session/new") {
          const createdSessionId = "s".repeat(300);
          diagnosticQueues.set(createdSessionId, { values: [] });
          return { sessionId: createdSessionId };
        }
        if (method === "session/prompt") {
          diagnosticQueues.get(sessionId)?.values.push(
            { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `${"x".repeat(100_000)} secret prompt response` } } },
            { update: { sessionUpdate: "secret-token", content: { type: "secret", text: "api-key-value" } } },
          );
          return { stopReason: "secret-stop", apiKey: "must-not-be-observed" };
        }
        return {};
      },
    },
    close() {},
    closed: new Promise<void>(() => undefined),
  };
  const observations: Array<Record<string, unknown>> = [];
  const diagnosticRuntime = new AcpRuntime({
    provider: "cursor",
    command: "cursor-agent",
    args: ["acp"],
    env: {},
    capabilities: { resume: false, close: false },
    queues: diagnosticQueues,
      diagnosticObserver: (observation) => { observations.push(observation as unknown as Record<string, unknown>); throw new Error("observer must not affect run"); },
  }, diagnosticConnection);
  const diagnosticResult = await diagnosticRuntime.run({ prompt: "secret prompt", workspaceRoot: "/tmp/project" });
  assert.equal(diagnosticResult.isErr(), true);
  assert.equal(observations.length, 1);
  const observation = observations[0];
  assert.match(observation.sessionId as string, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(observation.responseKeys, ["stopReason"]);
  assert.equal(observation.stopReason, "unknown");
  assert.deepEqual(observation.updateTypes, ["agent_thought_chunk", "unknown"]);
  assert.deepEqual(observation.updateContentTypes, ["text", "unknown"]);
  assert.equal(observation.updateContentBytes, 64 * 1024);
  assert.equal(Object.hasOwn(observation, "apiKey"), false);
  assert.equal(JSON.stringify(observation).includes("secret"), false);
}

// Enabling the observer does not change a successful ACP response and does
// not emit a failure observation for a normal assistant text update.
{
  const successQueues = new Map<string, { values: unknown[] }>();
  const successConnection = {
    agent: {
      async request(method: string, params?: unknown): Promise<unknown> {
        const sessionId = (params as { sessionId?: string } | undefined)?.sessionId ?? "success-diagnostic-session";
        if (method === "session/new") {
          successQueues.set(sessionId, { values: [] });
          return { sessionId };
        }
        if (method === "session/prompt") {
          successQueues.get(sessionId)?.values.push({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ACP response" } } });
          return { stopReason: "end_turn" };
        }
        return {};
      },
    },
    close() {},
    closed: new Promise<void>(() => undefined),
  };
  const observations: unknown[] = [];
  const successRuntime = new AcpRuntime({
    provider: "cursor",
    command: "cursor-agent",
    args: ["acp"],
    env: {},
    capabilities: { resume: false, close: false },
    queues: successQueues,
    diagnosticObserver: (observation) => { observations.push(observation); },
  }, successConnection);
  const successResult = await successRuntime.run({ prompt: "safe", workspaceRoot: "/tmp/project" });
  assert.equal(successResult.isOk(), true);
  if (successResult.isErr()) throw successResult.error;
  assert.equal(successResult.value.finalResponse, "ACP response");
  assert.equal(observations.length, 0);
}
