import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Result } from "better-result";
import { AcpRuntime, appendAcpQueueValue } from "./local-agent-acp.js";
import { createLocalAgentAdapter } from "./local-agent-adapters.js";
import { CodexAppServerRuntime } from "./local-agent-codex.js";
import { OpencodeRuntime, type OpencodeClientLike } from "./local-agent-opencode.js";
import { LocalAgentSessionManager } from "./local-agent-sessions.js";
import { presentAgentObservation } from "./local-agent-presentation.js";
import { cleanupProviderScratch, createProviderScratch } from "./provider-scratch.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import type { LocalAgentRuntime } from "./local-agent-runtime.js";

const secret = "synthetic-secret-value-9f3a";

type FailureMode = "malformed" | "eof" | "nonzero" | "fatal" | "cancel";

async function runtimeFor(provider: LocalAgentProvider, root: string, failure?: FailureMode): Promise<LocalAgentRuntime> {
  if (provider === "agy") {
    const scratch = createProviderScratch(`redaction-${process.pid}`);
    const originalHome = join(root, "original-home");
    mkdirSync(join(originalHome, ".gemini", "antigravity-cli", "conversations"), { recursive: true });
    writeFileSync(join(originalHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "fixture-token");
    const command = join(root, "fake-agy.js");
    writeFileSync(command, `#!${process.execPath}\nprocess.stderr.write("diagnostic Bearer synthetic-secret-value-9f3a\\n");\n${failure === "nonzero" ? "process.exit(7);" : failure === "malformed" ? "console.log(\"{malformed\");" : failure === "eof" ? "process.stdout.write(JSON.stringify({status:\"SUCCESS\",conversation_id:\"agy-session\",response:\"token=synthetic-secret-value-9f3a\"}).slice(0,-2));" : "console.log(JSON.stringify({status:\"SUCCESS\",conversation_id:\"agy-session\",response:\"done Bearer synthetic-secret-value-9f3a\"}));"}\n`, { mode: 0o700 });
    chmodSync(command, 0o700);
    const adapter = createLocalAgentAdapter("agy");
    return { provider: "agy", isAlive: () => true, releaseSession: async () => {}, close: async () => { cleanupProviderScratch(scratch.root); }, run: async (input, callbacks) => Result.ok(await adapter.run({ ...input, environment: { ...input.environment, HOME: originalHome, AGY_COMMAND: command, DEVSPACE_PROVIDER_SCRATCH: scratch.root } }, callbacks)) };
  }
  if (provider === "cursor") {
    const queues = new Map<string, { values: unknown[] }>();
    const connection = { agent: { async request(method: string, params?: any) { if (method === "session/new") { queues.set("cursor-session", { values: [] }); return { sessionId: "cursor-session" }; } if (method === "session/prompt") { const queue = queues.get(params.sessionId); for (const text of ["done Bearer syn", "thetic-secret-", "value-9f3a"]) appendAcpQueueValue(queue!, { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }); return { stopReason: "end_turn" }; } return {}; } }, close() {}, closed: new Promise<void>(() => undefined) };
    return new AcpRuntime({ provider: "cursor", command: "cursor-agent", args: [], env: {}, queues }, connection as any);
  }
  if (provider === "opencode") {
    const client = { v2: { health: { async get() { return { data: { healthy: true } }; } }, session: { async create() { return { data: { data: { id: "opencode-session" } } }; }, async switchAgent() {}, async switchModel() {}, async get() { return { data: { data: {} } }; }, async prompt() { return { data: { data: { id: "opencode-prompt" } } }; }, async wait() {}, async messages() { return { data: { data: [{ type: "user", id: "opencode-prompt" }, { info: { role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "done Bearer synthetic-secret-value-9f3a" }] }] } }; } } } } as unknown as OpencodeClientLike;
    return new OpencodeRuntime(client, { close() {} });
  }
  const command = join(root, "fake-codex.js");
  writeFileSync(command, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"; import readline from "node:readline"; const out=v=>{const b=Buffer.from(JSON.stringify(v)+"\\n"); for(let i=0;i<b.length;i+=3) process.stdout.write(b.subarray(i,i+3));}; readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line); if(m.method==="initialize") return out({id:m.id,result:{}}); if(m.method==="thread/start") return out({id:m.id,result:{thread:{id:"codex-session"}}}); if(m.method==="turn/start"){process.stderr.write("diagnostic Bearer syn"); process.stderr.write("thetic-secret-value-9f3a\\n"); out({id:m.id,result:{turn:{id:"turn-1"}}}); ${failure === "cancel" ? `writeFileSync(${JSON.stringify(join(root, "READY"))}, "ready"); setTimeout(() => process.exit(0), 8000);` : `setImmediate(()=>{${failure ? "out({method:\"turn/completed\",params:{threadId:m.params.threadId,turn:{id:\"turn-1\",status:\"failed\",error:{message:\"provider failed Bearer synthetic-secret-value-9f3a\"}}}});" : "const item={type:\"agentMessage\",text:\"done Bearer synthetic-secret-value-9f3a\"}; out({method:\"item/completed\",params:{threadId:m.params.threadId,turnId:\"turn-1\",item}}); out({method:\"turn/completed\",params:{threadId:m.params.threadId,turn:{id:\"turn-1\",status:\"completed\",items:[item]}}});"}});`}}});\n`, { mode: 0o700 });
  chmodSync(command, 0o700);
  const runtime = new CodexAppServerRuntime({ command, env: process.env });
  await runtime.initialize();
  return runtime;
}

async function runThroughSession(provider: LocalAgentProvider, failure?: FailureMode) {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-redaction-integration-"));
  const workspaceRoot = join(stateDir, "workspace"); mkdirSync(workspaceRoot, { recursive: true });
  const runtime = await runtimeFor(provider, stateDir, failure);
  const manager = new LocalAgentSessionManager({ stateDir, subagents: true, oauth: { scopes: ["devspace"] } } as any, undefined, undefined, async (_profile, record, prompt, callbacks) => { const result = await runtime.run({ prompt, workspaceRoot: record.workspaceRoot, writeMode: "read_only" }, callbacks); if (result.isErr()) throw result.error; return result.value; });
  try {
    const store = (manager as any).store; const record = store.create({ workspaceId: `ws-${provider}`, workspaceRoot, profileName: provider, provider, lifecycleKind: "detached_worker_v2" }); const token = `worker-${provider}`; store.prepareWorker(record.id, token); const promptFile = join(stateDir, "prompt.json"); writeFileSync(promptFile, "synthetic provider fixture"); await manager.runWorkerTurnFromFile(record.id, promptFile, token); const updated = store.getById(record.id)!; return { updated, observation: presentAgentObservation(updated) };
  } finally { await runtime.close(); manager.close(); rmSync(stateDir, { recursive: true, force: true }); }
}

async function runCodexCancellationThroughSession() {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-redaction-cancel-"));
  const workspaceRoot = join(stateDir, "workspace"); mkdirSync(workspaceRoot, { recursive: true });
  const runtime = await runtimeFor("codex", stateDir, "cancel");
  const manager = new LocalAgentSessionManager({ stateDir, subagents: true, oauth: { scopes: ["devspace"] } } as any, undefined, undefined, async (_profile, record, prompt, callbacks) => { const result = await runtime.run({ prompt, workspaceRoot: record.workspaceRoot, writeMode: "read_only" }, callbacks); if (result.isErr()) throw result.error; return result.value; });
  try {
    const store = (manager as any).store; const record = store.create({ workspaceId: "ws-codex-cancel", workspaceRoot, profileName: "codex", provider: "codex", lifecycleKind: "detached_worker_v2" }); const token = "worker-codex-cancel"; store.prepareWorker(record.id, token); const promptFile = join(stateDir, "prompt.json"); writeFileSync(promptFile, "cancel fixture"); const turn = manager.runWorkerTurnFromFile(record.id, promptFile, token);
    const ready = join(stateDir, "READY"); const deadline = Date.now() + 5_000; while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(existsSync(ready), true, "inert child must reach the owned cancellation boundary");
    await runtime.close(); await Promise.race([turn, new Promise((_, reject) => setTimeout(() => reject(new Error("cancel reconciliation timeout")), 5_000))]);
    const updated = store.getById(record.id)!; return { updated, observation: presentAgentObservation(updated), alive: runtime.isAlive() };
  } finally { await runtime.close(); manager.close(); rmSync(stateDir, { recursive: true, force: true }); }
}

for (const provider of ["codex", "agy", "cursor", "opencode"] as const) test(`${provider} real adapter/runtime output is redacted at durable sink`, async () => { const { updated, observation } = await runThroughSession(provider); assert.equal(updated.status, "idle", JSON.stringify({ updated, observation })); assert.ok(updated.providerSessionId, "provider session identity must be durable"); assert.equal(updated.latestResponse, "done Bearer [REDACTED]"); assert.equal(updated.latestResponse?.includes(secret), false); assert.equal(JSON.stringify(observation).includes(secret), false); });

for (const mode of ["malformed", "eof", "nonzero"] as const) test(`agy ${mode} error is durable and redacted`, async () => {
  const { updated, observation } = await runThroughSession("agy", mode);
  assert.equal(updated.status, "error");
  assert.equal(JSON.stringify(updated).includes(secret), false);
  assert.equal(JSON.stringify(observation).includes(secret), false);
});

test("codex fatal is durable and redacted", async () => {
  const { updated, observation } = await runThroughSession("codex", "fatal");
  assert.equal(updated.status, "error"); assert.equal(updated.providerSessionId, "codex-session"); assert.equal(JSON.stringify(updated).includes(secret), false); assert.equal(JSON.stringify(observation).includes(secret), false);
});

test("codex runtime close cancels owned child and preserves redaction", async () => {
  const { updated, observation, alive } = await runCodexCancellationThroughSession();
  assert.equal(alive, false); assert.equal(updated.status, "error"); assert.equal(JSON.stringify(updated).includes(secret), false); assert.equal(JSON.stringify(observation).includes(secret), false);
});
