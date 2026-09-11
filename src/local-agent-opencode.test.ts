import assert from "node:assert/strict";
import http from "node:http";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import {
  DEFAULT_OPENCODE_STARTUP_TIMEOUT_MS,
  MAX_OPENCODE_STARTUP_TIMEOUT_MS,
  defaultOpencodeFactory,
  opencodeAgentConfig,
  OpencodeLocalAgentDriver,
  opencodeAgentFor,
  opencodePermissionFor,
  resolveOpencodeStartupTimeoutMs,
  type OpencodeClientLike,
  type OpencodeFactory,
} from "./local-agent-opencode.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";

let sessionNumber = 0;
const createInputs: unknown[] = [];
const promptInputs: unknown[] = [];
const switchInputs: unknown[] = [];
const agentInputs: unknown[] = [];
let healthAvailable = true;
const client = {
  v2: {
    session: {
    async create(input: unknown) {
      createInputs.push(input);
      sessionNumber += 1;
      return { data: { data: { id: `session_${sessionNumber}` } } };
    },
    async prompt(input: unknown) {
      promptInputs.push(input);
      const sessionId = (input as { sessionID: string }).sessionID;
      return { data: { data: { id: `prompt_${sessionId}` } } };
    },
    async wait() {},
      async messages(input: unknown) {
        const sessionId = (input as { sessionID: string }).sessionID;
        return {
        data: { data: [{ type: "user", id: `prompt_${sessionId}` }, {
          info: { role: "assistant", finish: "stop" },
          parts: [{ type: "text", text: `response:${sessionId}` }],
        }] },
      };
    },
    async get() {
      return { data: { data: { model: { providerID: "anthropic", id: "sonnet" } } } };
    },
    async switchAgent(input: unknown) { agentInputs.push(input); },
    async switchModel(input: unknown) { switchInputs.push(input); },
    },
    health: { async get() {
      if (!healthAvailable) throw new Error("server unavailable");
      return { data: { healthy: true } };
    } },
  },
} as unknown as OpencodeClientLike;
let factoryCalls = 0;
let closeCalls = 0;
const factory: OpencodeFactory = async () => {
  factoryCalls += 1;
  return {
    client,
    server: { close: () => { closeCalls += 1; } },
  };
};
const driver = new OpencodeLocalAgentDriver(factory);
const pool = new LocalAgentRuntimePool();

const first = await pool.run(driver, {
  agentId: "agt_one",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
  }, {
    prompt: "first",
    workspaceRoot: "/tmp/project",
    model: "anthropic/sonnet",
    effort: "high",
  });
const second = await pool.run(driver, {
  agentId: "agt_two",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, {
  prompt: "second",
  workspaceRoot: "/tmp/project",
});

assert.equal(factoryCalls, 1, "OpenCode agents share one server runtime");
assert.equal(first.isOk(), true);
assert.equal(second.isOk(), true);
if (first.isErr()) throw first.error;
if (second.isErr()) throw second.error;
const firstRecord = first.value;
const secondRecord = second.value;
assert.equal(firstRecord.providerSessionId, "session_1");
assert.equal(secondRecord.providerSessionId, "session_2");
assert.equal(secondRecord.finalResponse, "response:session_2");
assert.deepEqual(createInputs[0], {
  location: { directory: "/tmp/project" },
  agent: "devspace_allowed",
  model: { providerID: "anthropic", id: "sonnet", variant: "high" },
});
assert.deepEqual(promptInputs[0], {
  sessionID: "session_1",
  prompt: { text: "first" },
});

let callbackSessionId: string | undefined;
await pool.run(driver, {
  agentId: "agt_one",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, {
  prompt: "effort override",
  workspaceRoot: "/tmp/project",
  providerSessionId: firstRecord.providerSessionId ?? undefined,
  effort: "low",
}, {
  onSessionId: (id) => { callbackSessionId = id; },
});
assert.equal(callbackSessionId, firstRecord.providerSessionId);
const requiredSessionCallbackFailure = await pool.run(driver, {
  agentId: "agt_required_callback_failure",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, { prompt: "required callback failure", workspaceRoot: "/tmp/project" }, {
  onSessionId: () => { throw new Error("required session callback failed"); },
});
assert.equal(requiredSessionCallbackFailure.isErr(), true, "required session identity callback must fail closed");
assert.deepEqual(switchInputs[0], {
  sessionID: "session_1",
  model: { providerID: "anthropic", id: "sonnet", variant: "low" },
});
assert.deepEqual(agentInputs[0], { sessionID: "session_1", agent: "devspace_allowed" });

let readinessActiveCalls = 0;
let readinessWaitCalls = 0;
let readinessActivityCalls = 0;
const readinessRaceClient = {
  v2: {
    session: {
      async create() {
        return { data: { data: { id: "session_readiness" } } };
      },
      async switchAgent() {},
      async prompt() {
        return { data: { data: { id: "prompt_readiness" } } };
      },
      async wait() {
        readinessWaitCalls += 1;
        throw new Error("Session wait is not available yet");
      },
      async active() {
        readinessActiveCalls += 1;
        return {
          data: {
            data: readinessActiveCalls < 3
              ? { session_readiness: { type: "running" } }
              : {},
          },
        };
      },
      async messages() {
        const data = readinessActiveCalls >= 3
          ? [
            { type: "user", id: "prompt_readiness" },
            {
              type: "assistant",
              id: "assistant_readiness",
              time: { created: 1, completed: 2 },
              finish: "stop",
              content: [{ type: "text", id: "part_readiness", text: "ready response" }],
            },
          ]
          : [{ type: "user", id: "prompt_readiness" }];
        return { data: { data } };
      },
    },
    health: { async get() { return { data: { healthy: true } }; } },
  },
} as unknown as OpencodeClientLike;
const readinessPool = new LocalAgentRuntimePool();
const readinessDriver = new OpencodeLocalAgentDriver(async () => ({
  client: readinessRaceClient,
  server: { close: () => undefined },
}));
const readinessResult = await readinessPool.run(readinessDriver, {
  agentId: "agt_readiness",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, { prompt: "readiness", workspaceRoot: "/tmp/project" }, { onActivity: () => { readinessActivityCalls += 1; } });
assert.equal(readinessResult.isOk(), true, "OpenCode should wait for the active session to finish");
if (readinessResult.isOk()) {
  assert.equal(readinessResult.value.finalResponse, "ready response");
}
assert.equal(readinessWaitCalls, 0, "OpenCode should not rely on the unavailable wait endpoint");
assert.equal(readinessActivityCalls, 6, "OpenCode should touch setup plus changed provider evidence, not every unchanged poll");
await readinessPool.close();

for (const [observer, neverSettles] of [
  [() => new Promise<void>(() => undefined), true],
  [async () => { throw new Error("best-effort observer rejected asynchronously"); }, false],
] as const) {
  let observerCalls = 0;
  const isolatedPool = new LocalAgentRuntimePool();
  const result = await Promise.race([
    isolatedPool.run(readinessDriver, {
      agentId: `agt_observer_${observerCalls++}`,
      provider: "opencode",
      workspaceRoot: "/tmp/project",
    }, { prompt: "observer isolation", workspaceRoot: "/tmp/project" }, {
      onActivity: () => { observerCalls += 1; return observer(); },
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("OpenCode observer isolation timed out")), 2_000)),
  ]);
  assert.equal(result.isOk(), true, "best-effort observer must not block OpenCode completion");
  if (neverSettles) assert.ok(observerCalls <= 2, `observer should be coalesced, got ${observerCalls}`);
  await isolatedPool.close();
}

const longSessionRequests: Array<{ cursor?: string; order?: string }> = [];
const longSessionClient = {
  v2: {
    session: {
      async create() {
        return { data: { data: { id: "session_long" } } };
      },
      async switchAgent() {},
      async prompt() {
        return { data: { data: { id: "prompt_long" } } };
      },
      async active() {
        return { data: { data: {} } };
      },
      async messages(input: unknown) {
        const request = input as { cursor?: string; order?: string };
        longSessionRequests.push({ cursor: request.cursor, order: request.order });
        if (!request.cursor) {
          return {
            data: {
              data: Array.from({ length: 100 }, (_, index) => ({
                type: "assistant",
                id: `old-assistant-${index}`,
                finish: "stop",
                content: [{ type: "text", text: `old response ${index}` }],
              })),
              cursor: { next: "long-session-next" },
            },
          };
        }
        return {
          data: {
            data: [
              { type: "user", id: "prompt_long" },
              {
                type: "assistant",
                id: "assistant_long",
                finish: "stop",
                content: [{ type: "text", text: "long response" }],
              },
            ],
            cursor: {},
          },
        };
      },
    },
  },
} as unknown as OpencodeClientLike;
const longSessionPool = new LocalAgentRuntimePool();
const longSessionDriver = new OpencodeLocalAgentDriver(async () => ({
  client: longSessionClient,
  server: { close: () => undefined },
}));
const longSessionResult = await longSessionPool.run(longSessionDriver, {
  agentId: "agt_long_session",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, { prompt: "long session", workspaceRoot: "/tmp/project" });
assert.equal(longSessionResult.isOk(), true, "OpenCode should find completions past the first message page");
if (longSessionResult.isOk()) {
  assert.equal(longSessionResult.value.finalResponse, "long response");
}
assert.ok(
  longSessionRequests.some((request) => request.cursor === "long-session-next"),
  "OpenCode should follow the continuation cursor",
);
await longSessionPool.close();

const oversizedClient = {
  v2: {
    session: {
      async create() { return { data: { data: { id: "session_oversized" } } }; },
      async switchAgent() {},
      async prompt() { return { data: { data: { id: "prompt_oversized" } } }; },
      async active() { return { data: { data: {} } }; },
      async messages(input: unknown) {
        if (!(input as { cursor?: string }).cursor) {
          return {
            data: {
              data: Array.from({ length: 400 }, (_, index) => ({
                type: "assistant", id: `stale-${index}`, finish: "stop",
                content: [{ type: "text", text: `stale result ${index} ${"x".repeat(5000)}` }],
                metadata: index === 0 ? { trace: "y".repeat(600_000) } : undefined,
              })),
              cursor: { next: "oversized-next" },
            },
          };
        }
        return {
          data: {
            data: [
              { type: "user", id: "prompt_oversized" },
              ...Array.from({ length: 400 }, (_, index) => ({
                type: "assistant", id: `progress-${index}`, finish: "tool-calls",
                content: [{ type: "text", text: index === 0 ? "z".repeat(600_000) : `progress ${index}` }],
              })),
              { type: "assistant", id: "final_oversized", finish: "stop", content: [{ type: "text", text: "current final" }] },
            ],
            cursor: {},
          },
        };
      },
    },
  },
} as unknown as OpencodeClientLike;
const oversizedPool = new LocalAgentRuntimePool();
const oversizedDriver = new OpencodeLocalAgentDriver(async () => ({
  client: oversizedClient,
  server: { close: () => undefined },
}));
const oversizedResult = await oversizedPool.run(oversizedDriver, {
  agentId: "agt_oversized_session",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, { prompt: "oversized session", workspaceRoot: "/tmp/project" });
assert.equal(oversizedResult.isOk(), true);
if (oversizedResult.isOk()) {
  assert.equal(oversizedResult.value.finalResponse, "current final");
  const retained = oversizedResult.value.items[1] as { data?: unknown[] };
  assert.ok((retained.data?.length ?? 0) <= 129, "history/progress retention must remain bounded");
  assert.equal(retained.data?.some((message) => (message as { id?: string }).id === "stale-0"), false, "an oversized historical record must be suppressed");
  const retention = retained as { retention?: { suppressedMessages?: number; suppressedBytes?: number; suppressedBytesAreEstimate?: boolean } };
  assert.ok((retention.retention?.suppressedMessages ?? 0) > 0, "suppression count must be visible");
  assert.ok((retention.retention?.suppressedBytes ?? 0) > 0, "suppression bytes must be visible");
  assert.equal(retention.retention?.suppressedBytesAreEstimate, true, "suppression byte semantics must be explicit");
}
await oversizedPool.close();

const boundaryClient = {
  v2: {
    session: {
      async create() { return { data: { data: { id: "session_boundary" } } }; },
      async switchAgent() {},
      async prompt() { return { data: { data: { id: "prompt_boundary" } } }; },
      async active() { return { data: { data: {} } }; },
      async messages(input: unknown) {
        if (!(input as { cursor?: string }).cursor) return {
          data: { data: [
            { type: "user", id: "prompt_boundary" },
            { type: "assistant", id: "current_progress", finish: "tool-calls", content: [{ type: "text", text: "progress" }] },
          ], cursor: { next: "boundary-next" } },
        };
        return {
          data: { data: [
            { type: "user", id: "next-user", metadata: { trace: "q".repeat(1_100_000) } },
            ...Array.from({ length: 300 }, (_, index) => ({
              type: "assistant", id: `foreign-progress-${index}`, finish: "tool-calls",
              content: [{ type: "text", text: `foreign progress ${index}` }],
            })),
            { type: "assistant", id: "foreign-final", finish: "stop", content: [{ type: "text", text: "foreign final" }] },
          ], cursor: {} },
        };
      },
    },
  },
} as unknown as OpencodeClientLike;
const boundaryPool = new LocalAgentRuntimePool();
const boundaryDriver = new OpencodeLocalAgentDriver(async () => ({
  client: boundaryClient,
  server: { close: () => undefined },
}));
const boundaryResult = await boundaryPool.run(boundaryDriver, {
  agentId: "agt_boundary_session",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, { prompt: "boundary session", workspaceRoot: "/tmp/project" });
assert.equal(boundaryResult.isErr(), true, "a later user turn must not satisfy the current prompt");
if (boundaryResult.isErr()) {
  assert.equal(boundaryResult.error.code, "PROVIDER_PROTOCOL_ERROR");
  assert.doesNotMatch(boundaryResult.error.message, /foreign final/);
}
await boundaryPool.close();

let oversizedFinalText = "x".repeat(512 * 1024);
let oversizedFinalMetadata: unknown;
const oversizedFinalClient = {
  v2: {
    session: {
      async create() { return { data: { data: { id: "session_oversized_final" } } }; },
      async switchAgent() {},
      async prompt() { return { data: { data: { id: "prompt_oversized_final" } } }; },
      async active() { return { data: { data: {} } }; },
      async messages() {
        return { data: { data: [
          { type: "user", id: "prompt_oversized_final" },
          { type: "assistant", id: "final_too_large", finish: "stop", metadata: oversizedFinalMetadata, content: [{ type: "text", text: oversizedFinalText }] },
        ], cursor: {} } };
      },
    },
  },
} as unknown as OpencodeClientLike;
const oversizedFinalPool = new LocalAgentRuntimePool();
const oversizedFinalDriver = new OpencodeLocalAgentDriver(async () => ({
  client: oversizedFinalClient,
  server: { close: () => undefined },
}));
const exactFinalResult = await oversizedFinalPool.run(oversizedFinalDriver, {
  agentId: "agt_oversized_final",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, { prompt: "exact final", workspaceRoot: "/tmp/project" });
assert.equal(exactFinalResult.isOk(), true, "a final exactly at the retained byte bound must pass");
oversizedFinalMetadata = { trace: "m".repeat(1_100_000) };
const oversizedFinalMetadataResult = await oversizedFinalPool.run(oversizedFinalDriver, {
  agentId: "agt_oversized_final_metadata",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, { prompt: "oversized final metadata", workspaceRoot: "/tmp/project" });
assert.equal(oversizedFinalMetadataResult.isErr(), true, "oversized terminal metadata must fail closed");
oversizedFinalText = "x".repeat(512 * 1024 + 1);
const oversizedFinalResult = await oversizedFinalPool.run(oversizedFinalDriver, {
  agentId: "agt_oversized_final",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, { prompt: "oversized final", workspaceRoot: "/tmp/project" });
assert.equal(oversizedFinalResult.isErr(), true, "an oversized current final must fail closed");
if (oversizedFinalResult.isErr()) assert.equal(oversizedFinalResult.error.code, "PROVIDER_PROTOCOL_ERROR");
await oversizedFinalPool.close();

// Exercise the generated SDK against a mock HTTP server using the actual v2
// response shape. An earlier turn and a tool-call assistant step must not
// satisfy the current prompt; only the final assistant stop does.
const promptBodies: unknown[] = [];
let activeReads = 0;
const sdkServer = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/health") {
      response.end(JSON.stringify({ healthy: true }));
      return;
    }
    if (request.url === "/api/session") {
      response.end(JSON.stringify({ data: { id: "session_sdk" } }));
      return;
    }
    if (request.url === "/api/session/session_sdk/prompt") {
      promptBodies.push(JSON.parse(body));
      response.end(JSON.stringify({ data: {
        admittedSeq: 1,
        id: "prompt_sdk",
        sessionID: "session_sdk",
        prompt: { text: "current prompt" },
        delivery: "queue",
        timeCreated: 1,
      } }));
      return;
    }
    if (request.url === "/api/session/active") {
      activeReads += 1;
      response.end(JSON.stringify({ data: activeReads < 2 ? { session_sdk: { type: "running" } } : {} }));
      return;
    }
    if (request.url === "/api/session/session_sdk/message?limit=100&order=asc") {
      response.end(JSON.stringify({
        data: [
          { type: "user", id: "old_prompt", time: { created: 1 }, text: "old" },
          { type: "assistant", id: "old_assistant", time: { created: 2, completed: 3 },
            agent: "devspace_allowed", model: { providerID: "opencode", id: "mimo" }, content: [{ type: "text", id: "old_text", text: "old result" }], finish: "stop" },
          { type: "user", id: "prompt_sdk", time: { created: 4 }, text: "current prompt" },
          { type: "assistant", id: "tool_step", time: { created: 5, completed: 6 },
            agent: "devspace_allowed", model: { providerID: "opencode", id: "mimo" }, content: [{ type: "tool", id: "tool_part", name: "read", state: { status: "completed", input: {}, content: [], structured: {} }, time: { created: 5, completed: 6 } }], finish: "tool-calls" },
        ],
        cursor: { next: "sdk-next" },
      }));
      return;
    }
    if (request.url === "/api/session/session_sdk/message?limit=100&cursor=sdk-next") {
      response.end(JSON.stringify({
        data: [
          { type: "tool", id: "tool_result", time: { created: 7, completed: 8 }, name: "read", state: { status: "completed", input: {}, content: [], structured: {} } },
          { type: "assistant", id: "final_assistant", time: { created: 9, completed: 10 },
            agent: "devspace_allowed", model: { providerID: "opencode", id: "mimo" }, content: [{ type: "text", id: "final_text", text: "current result" }], finish: "stop" },
        ],
        cursor: {},
      }));
      return;
    }
    response.statusCode = 204;
    response.end();
  });
});
await new Promise<void>((resolve) => sdkServer.listen(0, "127.0.0.1", resolve));
const sdkPort = (sdkServer.address() as { port: number }).port;
const sdkClient = createOpencodeClient({ baseUrl: `http://127.0.0.1:${sdkPort}` });
const sdkPool = new LocalAgentRuntimePool();
const sdkDriver = new OpencodeLocalAgentDriver(async () => ({
  client: sdkClient,
  server: { close: () => undefined },
}));
const sdkResult = await sdkPool.run(sdkDriver, {
  agentId: "agt_sdk_shape",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, { prompt: "current prompt", workspaceRoot: "/tmp/project" });
assert.equal(sdkResult.isOk(), true, "OpenCode should wait through tool steps and use the current prompt");
if (sdkResult.isOk()) assert.equal(sdkResult.value.finalResponse, "current result");
assert.deepEqual(promptBodies, [{ prompt: { text: "current prompt" } }], "SDK prompt serialization must be exact and single-shot");
assert.ok(activeReads >= 1);
await sdkPool.close();
await new Promise<void>((resolve) => sdkServer.close(() => resolve()));

const emptyResultClient = {
  v2: { session: {
    async create() { return { data: { data: { id: "session_empty_result" } } }; },
    async switchAgent() {},
    async prompt() { return { data: { data: { id: "prompt_empty_result" } } }; },
    async active() { return { data: { data: { session_empty_result: { type: "running" } } } }; },
    async messages() { return { data: { data: [
      { type: "user", id: "old_prompt_empty_result" },
      { type: "assistant", id: "old_assistant_empty_result", finish: "stop", content: [{ type: "text", text: "old task result" }] },
      { type: "user", id: "prompt_empty_result" },
      { type: "assistant", id: "assistant_earlier_result", finish: "stop", content: [{ type: "text", text: "earlier current result" }] },
      { type: "assistant", id: "assistant_empty_result", finish: "stop", content: [] },
    ], cursor: {} } }; },
  } },
} as unknown as OpencodeClientLike;
const emptyResultPool = new LocalAgentRuntimePool();
const emptyResultDriver = new OpencodeLocalAgentDriver(async () => ({ client: emptyResultClient, server: { close: () => undefined } }));
const emptyResult = await emptyResultPool.run(emptyResultDriver, {
  agentId: "agt_empty_result", provider: "opencode", workspaceRoot: "/tmp/project",
}, { prompt: "empty result", workspaceRoot: "/tmp/project" });
assert.equal(emptyResult.isErr(), true, "an empty OpenCode result must remain a protocol failure");
if (emptyResult.isErr()) {
  assert.equal(emptyResult.error.code, "PROVIDER_PROTOCOL_ERROR");
  assert.match(emptyResult.error.message, /session=session_empty_result, prompt=prompt_empty_result, finish=stop, messages=3/);
  assert.doesNotMatch(emptyResult.error.message, /old task result/);
}
await emptyResultPool.close();

assert.equal(opencodeAgentFor("read_only"), "devspace_read_only");
assert.equal(opencodeAgentFor("full_access"), "devspace_full_access");
assert.deepEqual(opencodePermissionFor("allowed"), {
  read: "allow",
  edit: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  bash: "allow",
  task: "deny",
  external_directory: "deny",
});
const readOnlyPermissions = opencodePermissionFor("read_only");
assert.equal(typeof readOnlyPermissions === "object" ? readOnlyPermissions.bash : undefined, "deny");
for (const writeMode of ["read_only", "allowed", "full_access"] as const) {
  const config = opencodeAgentConfig(writeMode);
  assert.equal(config.mode, "primary");
  assert.equal(typeof config.permission === "object" ? config.permission.task : undefined, "deny");
}

let promptFailureCount = 0;
const applicationErrorClient = {
  v2: {
    session: {
      async create() { return { data: { data: { id: "session_app_error" } } }; },
      async switchAgent() {},
      async prompt() {
        promptFailureCount += 1;
        if (promptFailureCount === 1) throw new Error("server rejected invalid input");
        return { data: { data: { id: "prompt_session_app_error" } } };
      },
      async wait() {},
      async messages() {
        return { data: { data: [{ type: "user", id: "prompt_session_app_error" }, { info: { role: "assistant" }, parts: [{ type: "text", text: "ok" }], finish: "stop" }] } };
      },
    },
    health: { async get() { return { data: { healthy: true } }; } },
  },
} as unknown as OpencodeClientLike;
const applicationErrorPool = new LocalAgentRuntimePool();
const applicationErrorDriver = new OpencodeLocalAgentDriver(async () => ({
  client: applicationErrorClient,
  server: { close: () => undefined },
}));
const applicationFailure = await applicationErrorPool.run(applicationErrorDriver, {
  agentId: "agt_app_error",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, { prompt: "bad input", workspaceRoot: "/tmp/project" });
assert.equal(applicationFailure.isErr(), true);
if (applicationFailure.isErr()) {
  assert.equal(applicationFailure.error.code, "PROVIDER_EXECUTION_ERROR");
  assert.equal(applicationFailure.error.retryable, false);
}
assert.equal(applicationErrorPool.size, 1, "ordinary provider errors must not evict a healthy server runtime");
const recoveredApplicationTurn = await applicationErrorPool.run(applicationErrorDriver, {
  agentId: "agt_app_error",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, { prompt: "valid input", workspaceRoot: "/tmp/project" });
assert.equal(recoveredApplicationTurn.isOk(), true);
if (recoveredApplicationTurn.isErr()) throw recoveredApplicationTurn.error;
assert.equal(recoveredApplicationTurn.value.finalResponse, "ok");
await applicationErrorPool.close();

let recoveringFactoryCalls = 0;
const recoveringDriver = new OpencodeLocalAgentDriver(async () => {
  recoveringFactoryCalls += 1;
  healthAvailable = true;
  return { client, server: { close: () => undefined } };
});
const recoveringPool = new LocalAgentRuntimePool();
await recoveringPool.run(recoveringDriver, {
  agentId: "agt_dead",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, {
  prompt: "initial",
  workspaceRoot: "/tmp/project",
});
healthAvailable = false;
const deadRuntime = await recoveringPool.run(recoveringDriver, {
  agentId: "agt_dead",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, {
  prompt: "dead runtime",
  workspaceRoot: "/tmp/project",
});
assert.equal(deadRuntime.isErr(), true);
if (deadRuntime.isErr()) {
  assert.equal(deadRuntime.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(deadRuntime.error.retryable, true);
}
assert.equal(recoveringPool.size, 0, "a failed health check removes the dead runtime immediately");
await recoveringPool.run(recoveringDriver, {
  agentId: "agt_dead",
  provider: "opencode",
  workspaceRoot: "/tmp/project",
}, {
  prompt: "recreated",
  workspaceRoot: "/tmp/project",
});
assert.equal(recoveringFactoryCalls, 2, "the next turn creates a fresh OpenCode server");
await recoveringPool.close();

await pool.close();
await pool.close();
assert.equal(closeCalls, 1, "shared OpenCode server closes once");

// OpenCode SDK startup readiness timeout must be explicit and bounded.
assert.equal(DEFAULT_OPENCODE_STARTUP_TIMEOUT_MS, 30_000);
assert.equal(MAX_OPENCODE_STARTUP_TIMEOUT_MS, 120_000);
assert.equal(resolveOpencodeStartupTimeoutMs({}), 30_000);
for (const raw of ["", "   ", "invalid", "NaN", "Infinity", "0", "-1", "15.5"]) {
  assert.equal(resolveOpencodeStartupTimeoutMs({ DEVSPACE_OPENCODE_STARTUP_TIMEOUT_MS: raw }), 30_000, raw);
}
assert.equal(resolveOpencodeStartupTimeoutMs({ DEVSPACE_OPENCODE_STARTUP_TIMEOUT_MS: "45000" }), 45_000);
assert.equal(resolveOpencodeStartupTimeoutMs({ DEVSPACE_OPENCODE_STARTUP_TIMEOUT_MS: "120000" }), 120_000);
assert.equal(resolveOpencodeStartupTimeoutMs({ DEVSPACE_OPENCODE_STARTUP_TIMEOUT_MS: "120001" }), 120_000);
assert.equal(resolveOpencodeStartupTimeoutMs({ DEVSPACE_OPENCODE_TIMEOUT_MS: "10000" }), 30_000);

let capturedTimeout: number | undefined;
const mockSdkLoader = async () => ({
  createOpencode: async (options?: { timeout?: number; config?: unknown }) => {
    capturedTimeout = options?.timeout;
    assert.deepEqual(options?.config, {
      agent: {
        devspace_read_only: opencodeAgentConfig("read_only"),
        devspace_allowed: opencodeAgentConfig("allowed"),
        devspace_full_access: opencodeAgentConfig("full_access"),
      },
    });
    return { client, server: { close: () => undefined } };
  },
});
await defaultOpencodeFactory({}, undefined, mockSdkLoader as any);
assert.equal(capturedTimeout, 30_000);
await defaultOpencodeFactory({ DEVSPACE_OPENCODE_STARTUP_TIMEOUT_MS: "55000" }, undefined, mockSdkLoader as any);
assert.equal(capturedTimeout, 55_000);
