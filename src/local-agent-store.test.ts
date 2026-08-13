import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgentStore } from "./local-agent-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-local-agent-store-test-"));
const stores: LocalAgentStore[] = [];

try {
  const store = new LocalAgentStore(root);
  stores.push(store);
  const created = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "reviewer",
    provider: "codex",
    model: "gpt-5.4",
    thinking: "high",
  });

  assert.match(created.id, /^agt_[a-f0-9]{8}$/);
  assert.equal(created.status, "starting");
  assert.equal(store.get(created.id)?.thinking, "high");
  assert.equal(store.get(created.id)?.profileName, "reviewer");
  assert.equal(store.get(created.id.slice(0, 7))?.id, created.id);

  const updated = store.update(created.id, {
    status: "idle",
    latestResponse: "done",
    providerSessionId: "thread_123",
    thinking: "medium",
  });

  assert.equal(updated.status, "idle");
  assert.equal(updated.thinking, "medium");
  assert.equal(store.get("thread_123")?.id, created.id);
  assert.equal(store.get(created.id)?.thinking, "medium");
  assert.equal(store.update(created.id, { latestResponse: undefined }).latestResponse, undefined);
  assert.deepEqual(
    store.list({ workspaceRoot: join(root, "project") }).map((agent) => agent.latestResponse),
    [undefined],
  );
  assert.deepEqual(store.list({ workspaceId: "ws_1" }).map((agent) => agent.id), [created.id]);
  assert.deepEqual(store.list({ workspaceId: "ws_other" }), []);
  assert.deepEqual(store.list({ workspaceRoot: join(root, "other") }), []);

  const failedContinuation = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "continued-worker",
    provider: "omp",
  });
  store.update(failedContinuation.id, {
    providerSessionId: "omp-session-existing",
    status: "starting",
  });
  store.prepareWorker(failedContinuation.id, "token-failure");
  store.claimWorker(failedContinuation.id, "token-failure", 1000);
  const failed = store.finishWorker(failedContinuation.id, "token-failure", {
    status: "error",
    error: "provider failed",
  });
  assert.equal(failed.providerSessionId, "omp-session-existing");

  const fenced = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "omp-worker",
    provider: "omp",
  });
  const prepared = store.prepareWorker(fenced.id, "token-a");
  assert.equal(prepared.workerToken, "token-a");
  assert.equal(prepared.workerPid, undefined);
  assert.equal(store.claimWorker(fenced.id, "wrong-token", 1001), undefined);
  const claimed = store.claimWorker(fenced.id, "token-a", 1001);
  assert.equal(claimed?.status, "running");
  assert.equal(claimed?.workerPid, 1001);
  const cancelled = store.cancelActive(fenced.id);
  assert.equal(cancelled.previous.workerToken, "token-a");
  assert.equal(cancelled.previous.workerPid, 1001);
  assert.equal(cancelled.current.status, "stopped");
  assert.equal(cancelled.current.workerToken, undefined);
  assert.equal(cancelled.current.workerPid, undefined);
  assert.equal(
    store.finishWorker(fenced.id, "token-a", {
      status: "idle",
      latestResponse: "late completion",
    }).status,
    "stopped",
  );

  const otherStore = new LocalAgentStore(root);
  stores.push(otherStore);
  const createdFromOtherStore = otherStore.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "explorer",
    provider: "claude",
  });

  assert.deepEqual(
    store.list({ workspaceId: "ws_1" }).map((agent) => agent.id).sort(),
    [created.id, failedContinuation.id, fenced.id, createdFromOtherStore.id].sort(),
  );
} finally {
  for (const store of stores) {
    store.close();
  }
  rmSync(root, { recursive: true, force: true });
}
