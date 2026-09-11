import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  CodexAppServerRuntime,
  CodexLocalAgentDriver,
  MAX_CODEX_FRAME_BYTES,
  codexCommandEnvironment,
  parseCodexVersion,
  resolveCodexCommand,
  sandboxFor,
} from "./local-agent-codex.js";
import { toAgentErrorPayload } from "./local-agent-errors.js";

let resolverCalls = 0;
const cachedDriver = new CodexLocalAgentDriver(
  { CODEX_HOME: "/tmp/codex-home" },
  () => {
    resolverCalls += 1;
    return { executable: "/usr/local/bin/codex", version: "1.2.3" };
  },
);
const cachedContext = { agentId: "agt_test", provider: "codex" as const, workspaceRoot: "/tmp/project" };
const resolvedCodexHome = resolve("/tmp/codex-home");
assert.equal(cachedDriver.runtimeKey(cachedContext), `codex:/usr/local/bin/codex:${resolvedCodexHome}`);
assert.equal(cachedDriver.runtimeKey(cachedContext), `codex:/usr/local/bin/codex:${resolvedCodexHome}`);
assert.equal(resolverCalls, 1, "Codex executable identity is resolved once per driver lifecycle");

assert.equal(parseCodexVersion("codex-cli 0.9.1"), "0.9.1");
assert.equal(sandboxFor("read_only"), "read-only");
assert.equal(sandboxFor("allowed"), "workspace-write");
assert.equal(sandboxFor("full_access"), "danger-full-access");
assert.equal(
  codexCommandEnvironment({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "test", PATH: "/tmp/bin" }).CODEX_INTERNAL_ORIGINATOR_OVERRIDE,
  undefined,
);

if (process.platform !== "win32") {
  const root = await mkdtemp(join(tmpdir(), "devspace-codex-app-server-test-"));
  const badBin = join(root, "bad-bin");
  const goodBin = join(root, "good-bin");
  await mkdir(badBin);
  await mkdir(goodBin);
  const badCandidate = join(badBin, "codex");
  const goodCandidate = join(goodBin, "codex");
  await writeFile(badCandidate, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  await writeFile(goodCandidate, "#!/bin/sh\necho 'codex-cli 9.8.7'\n", { mode: 0o700 });
  await chmod(badCandidate, 0o700);
  await chmod(goodCandidate, 0o700);
  assert.deepEqual(
    resolveCodexCommand({ PATH: `${badBin}:${goodBin}` }),
    { executable: goodCandidate, version: "9.8.7" },
    "command resolution must skip candidates whose version probe exits non-zero",
  );

  const command = join(root, "fake-codex");
  await writeFile(command, `#!/usr/bin/env node
import readline from "node:readline";
let turn = 0;
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const outputChunked = (value) => {
  const bytes = Buffer.from(JSON.stringify(value) + "\\n", "utf8");
  for (let offset = 0; offset < bytes.length; offset += 3) process.stdout.write(bytes.subarray(offset, offset + 3));
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    output({ id: message.id, result: { userAgent: "fake" } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    output({ id: message.id, result: { thread: { id: message.params.threadId || "thread_new" } } });
    return;
  }
  if (message.method === "thread/unsubscribe") {
    output({ id: message.id, result: {} });
    return;
  }
  if (message.method === "turn/start") {
    turn += 1;
    const turnId = "turn_" + turn;
    output({ id: message.id, result: { turn: { id: turnId } } });
    setImmediate(() => {
      if (message.params.input[0].text === "fail") {
        output({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "failed", error: { message: "fake failure" } } } });
        return;
      }
      if (message.params.input[0].text === "empty") {
        output({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
        return;
      }
      if (message.params.input[0].text === "oversized-no-newline") {
        process.stdout.write("x".repeat(${MAX_CODEX_FRAME_BYTES + 1}));
        return;
      }
      if (message.params.input[0].text === "oversized-jsonl") {
        process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: message.params.threadId, turnId, item: { type: "agentMessage", text: "x".repeat(${MAX_CODEX_FRAME_BYTES}) } } }) + "\\n");
        return;
      }
      if (message.params.input[0].text === "boundary-unicode") {
        const item = { type: "agentMessage", text: "🙂".repeat(2048) };
        outputChunked({ method: "item/completed", params: { threadId: message.params.threadId, turnId, item } });
        outputChunked({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed", items: [item] } } });
        return;
      }
      if (message.params.input[0].text === "boundary-exact") {
        const item = { type: "agentMessage", text: "🙂".repeat(2048) };
        const event = { method: "item/completed", params: { threadId: message.params.threadId, turnId, item } };
        const encoded = () => Buffer.byteLength(JSON.stringify(event), "utf8");
        item.text += "a".repeat(${MAX_CODEX_FRAME_BYTES} - encoded());
        if (encoded() !== ${MAX_CODEX_FRAME_BYTES}) throw new Error("fixture could not reach exact frame boundary");
        output(event);
        output({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
        return;
      }
      if (message.params.input[0].text === "eof-final") {
        const item = { type: "agentMessage", text: "EOF response" };
        process.stdout.end(JSON.stringify({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed", items: [item] } } }), () => process.exit(0));
        return;
      }
      if (message.params.input[0].text === "invalid-byte-oversize") {
        process.stdout.write(Buffer.concat([Buffer.alloc(${MAX_CODEX_FRAME_BYTES}, 0x78), Buffer.from([0xff])]));
        return;
      }
      const item = { type: "agentMessage", text: "fake response " + turn };
      output({ method: "item/completed", params: { threadId: message.params.threadId, turnId, item } });
      output({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed", items: [item] } } });
    });
  }
});
`, { mode: 0o700 });
  await chmod(command, 0o700);

  const runtime = new CodexAppServerRuntime({ command, env: process.env });
  try {
    await runtime.initialize();
    let callbackSessionId: string | undefined;
    const firstResult = await runtime.run({
      prompt: "first",
      workspaceRoot: "/tmp/project",
      writeMode: "read_only",
      model: "gpt-5.4",
      effort: "high",
    }, { onSessionId: (id) => { callbackSessionId = id; } });
    assert.equal(firstResult.isOk(), true);
    if (firstResult.isErr()) throw firstResult.error;
    const first = firstResult.value;
    const resumedResult = await runtime.run({
      prompt: "resumed",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(resumedResult.isOk(), true);
    if (resumedResult.isErr()) throw resumedResult.error;
    const resumed = resumedResult.value;
    assert.equal(first.providerSessionId, "thread_new");
    assert.equal(callbackSessionId, "thread_new");
    assert.equal(first.finalResponse, "fake response 1");
    assert.equal(resumed.providerSessionId, "thread_new");
    assert.equal(resumed.finalResponse, "fake response 2");
    const failed = await runtime.run({
      prompt: "fail",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(failed.isErr(), true);
    if (failed.isErr()) {
      assert.equal(failed.error.code, "PROVIDER_EXECUTION_ERROR");
      assert.equal(failed.error.provider, "codex");
      assert.equal(failed.error.retryable, false);
    }
    const protocolFailure = await runtime.run({
      prompt: "empty",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(protocolFailure.isErr(), true);
    if (protocolFailure.isErr()) {
      assert.equal(protocolFailure.error.code, "PROVIDER_PROTOCOL_ERROR");
      assert.equal(protocolFailure.error.provider, "codex");
      assert.equal(protocolFailure.error.retryable, false);
      assert.ok(protocolFailure.error.cause, "provider protocol cause remains available internally");
      assert.equal("cause" in toAgentErrorPayload(protocolFailure.error), false);
    }
    await runtime.releaseSession("thread_new");
  } finally {
    await runtime.close();
    await runtime.close();
  }

  for (const prompt of ["oversized-no-newline", "oversized-jsonl"] as const) {
    const oversizedRuntime = new CodexAppServerRuntime({ command, env: process.env });
    try {
      await oversizedRuntime.initialize();
      const result = await oversizedRuntime.run({ prompt, workspaceRoot: "/tmp/project" });
      assert.equal(result.isErr(), true, `${prompt} must fail`);
      if (result.isErr()) {
        assert.equal(result.error.code, "PROVIDER_PROTOCOL_ERROR");
        assert.match(result.error.message, /frame exceeds/);
      }
      const deadline = Date.now() + 1_000;
      while (oversizedRuntime.isAlive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(oversizedRuntime.isAlive(), false, `${prompt} must terminate the child`);
    } finally {
      await oversizedRuntime.close();
    }
  }

  const boundaryRuntime = new CodexAppServerRuntime({ command, env: process.env });
  try {
    await boundaryRuntime.initialize();
    const result = await boundaryRuntime.run({ prompt: "boundary-unicode", workspaceRoot: "/tmp/project" });
    assert.equal(result.isOk(), true);
    if (result.isOk()) assert.equal(result.value.finalResponse, "🙂".repeat(2048));
  } finally {
    await boundaryRuntime.close();
  }

  const exactBoundaryRuntime = new CodexAppServerRuntime({ command, env: process.env });
  try {
    await exactBoundaryRuntime.initialize();
    const result = await exactBoundaryRuntime.run({ prompt: "boundary-exact", workspaceRoot: "/tmp/project" });
    assert.equal(result.isOk(), true);
    if (result.isOk()) {
      assert.ok(result.value.finalResponse.startsWith("🙂"));
      assert.ok(result.value.finalResponse.endsWith("a"));
      assert.equal(Buffer.byteLength(JSON.stringify({ method: "item/completed", params: { threadId: "thread_new", turnId: "turn_1", item: { type: "agentMessage", text: result.value.finalResponse } } }), "utf8"), MAX_CODEX_FRAME_BYTES);
    }
  } finally {
    await exactBoundaryRuntime.close();
  }

  const eofRuntime = new CodexAppServerRuntime({ command, env: process.env });
  try {
    await eofRuntime.initialize();
    const result = await eofRuntime.run({ prompt: "eof-final", workspaceRoot: "/tmp/project" });
    assert.equal(result.isOk(), true);
    if (result.isOk()) assert.equal(result.value.finalResponse, "EOF response");
  } finally {
    await eofRuntime.close();
  }

  const invalidByteRuntime = new CodexAppServerRuntime({ command, env: process.env });
  try {
    await invalidByteRuntime.initialize();
    const result = await invalidByteRuntime.run({ prompt: "invalid-byte-oversize", workspaceRoot: "/tmp/project" });
    assert.equal(result.isErr(), true);
    if (result.isErr()) assert.equal(result.error.code, "PROVIDER_PROTOCOL_ERROR");
  } finally {
    await invalidByteRuntime.close();
  }

  await rm(root, { recursive: true, force: true });
}

const unavailable = await new CodexLocalAgentDriver({}, () => undefined).createRuntime(cachedContext);
assert.equal(unavailable.isErr(), true);
if (unavailable.isErr()) {
  assert.equal(unavailable.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(unavailable.error.retryable, false);
}
