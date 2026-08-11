import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { LocalAgentManager } from "./local-agent-manager.js";
import { LocalAgentStore } from "./local-agent-store.js";
import type { LocalAgentRunInput, LocalAgentRunResult } from "./local-agent-runtime.js";

const root = mkdtempSync(join(tmpdir(), "devspace-local-agent-manager-test-"));
const config = loadConfig({
  ...process.env,
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: join(root, "state"),
  DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-long-enough",
  DEVSPACE_SUBAGENTS: "1",
});
const store = new LocalAgentStore(config.stateDir);
const firstRun = deferred<LocalAgentRunResult>();
const secondRun = deferred<LocalAgentRunResult>();
const calls: Array<{ provider: string; input: LocalAgentRunInput }> = [];

const manager = new LocalAgentManager(config, {
  store,
  assertProviderAvailable: () => undefined,
  runProvider: async (provider, input) => {
    calls.push({ provider, input });
    return calls.length === 1 ? firstRun.promise : secondRun.promise;
  },
});

try {
  const first = await manager.enqueue({
    workspaceId: "ws_test",
    workspaceRoot: root,
    target: "codex",
    prompt: "first",
    model: "gpt-test",
  });
  await waitFor(() => calls.length === 1);

  const queued = await manager.enqueue({
    workspaceId: "ws_test",
    workspaceRoot: root,
    target: first.id,
    prompt: "second",
    thinking: "high",
  });
  assert.equal(queued.id, first.id);
  await immediate();
  assert.equal(calls.length, 1, "a second turn for the same agent must wait for the first");

  firstRun.resolve({
    provider: "codex",
    providerSessionId: "thread_first",
    finalResponse: "first result",
    items: [],
  });
  await waitFor(() => calls.length === 2);

  assert.equal(calls[0]?.provider, "codex");
  assert.equal(calls[0]?.input.prompt, "first");
  assert.equal(calls[0]?.input.model, "gpt-test");
  assert.equal(calls[1]?.input.prompt, "second");
  assert.equal(calls[1]?.input.providerSessionId, "thread_first");
  assert.equal(calls[1]?.input.thinking, "high");

  secondRun.resolve({
    provider: "codex",
    providerSessionId: "thread_second",
    finalResponse: "second result",
    items: [],
  });
  await waitFor(() => store.get(first.id)?.status === "idle");

  const completed = store.get(first.id);
  assert.equal(completed?.providerSessionId, "thread_second");
  assert.equal(completed?.latestResponse, "second result");
} finally {
  await manager.shutdown();
  rmSync(root, { recursive: true, force: true });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await immediate();
  }
  throw new Error("Timed out waiting for local agent manager state.");
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
