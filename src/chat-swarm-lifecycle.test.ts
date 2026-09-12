import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatSwarmError } from "./chat-swarm-contract.js";
import { ChatSwarmLifecycle, type ChatSwarmLifecycleMode } from "./chat-swarm-lifecycle.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devspace-chat-swarm-lifecycle-"));
  let mode: ChatSwarmLifecycleMode = "normal";
  const lifecycle = new ChatSwarmLifecycle({ stateDir: root, mode: () => mode });
  return { root, lifecycle, setMode: (next: ChatSwarmLifecycleMode) => { mode = next; } };
}

function cleanup(f: ReturnType<typeof fixture>): void {
  f.lifecycle.close();
  rmSync(f.root, { recursive: true, force: true });
}

test("shares one coordinator and keeps startup recovery explicit", () => {
  const f = fixture();
  try {
    const owner = { "openai/session": "owner" };
    const workerMeta = { "openai/session": "worker" };
    const swarm = f.lifecycle.coordinator!.createSwarm(owner, { workerLimit: 1 });
    const worker = f.lifecycle.coordinator!.joinWorker(workerMeta, swarm.id, { label: "peer", runtimeKind: "mcp_peer" });
    const task = f.lifecycle.coordinator!.dispatch(owner, { swarmId: swarm.id, taskKey: "running", prompt: "p" });
    assert.equal(task.assignedWorkerId, worker.id);

    const second = new ChatSwarmLifecycle({ stateDir: f.root });
    try {
      assert.equal(second.store!.getTask(task.id)?.lifecycleState, "CLAIMED");
      assert.equal(second.recoverAfterStartup(), 1);
      assert.equal(f.lifecycle.store!.getTask(task.id)?.lifecycleState, "RECONCILE_REQUIRED");
    } finally {
      second.close();
    }
  } finally {
    cleanup(f);
  }
});

test("drain permits current-task next and uncertainty-safe completion, but rejects new claims", () => {
  const f = fixture();
  try {
    f.setMode("drain");
    for (const action of ["create", "join", "dispatch", "close"] as const) {
      assert.throws(() => f.lifecycle.admit(action), (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_STATE");
    }
    assert.doesNotThrow(() => f.lifecycle.admit("next", { existingTask: true }));
    assert.throws(() => f.lifecycle.admit("next", { existingTask: false }), ChatSwarmError);
    for (const action of ["submit", "status", "list_tasks", "collect", "cancel", "reconcile"] as const) {
      assert.doesNotThrow(() => f.lifecycle.admit(action));
    }
  } finally {
    cleanup(f);
  }
});

test("reconcile-only permits inspection and explicit recovery actions only", () => {
  const f = fixture();
  try {
    f.setMode("reconcile-only");
    for (const action of ["status", "list_tasks", "collect", "cancel", "reconcile", "submit"] as const) {
      assert.doesNotThrow(() => f.lifecycle.admit(action));
    }
    for (const action of ["create", "join", "dispatch", "next", "close"] as const) {
      assert.throws(() => f.lifecycle.admit(action), ChatSwarmError);
    }
  } finally {
    cleanup(f);
  }
});

test("disabled lifecycle has no store and closes safely", () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-chat-swarm-disabled-"));
  const lifecycle = new ChatSwarmLifecycle({ stateDir: root, enabled: false });
  try {
    assert.equal(lifecycle.store, undefined);
    assert.equal(lifecycle.coordinator, undefined);
    assert.throws(() => lifecycle.recoverAfterStartup(), ChatSwarmError);
    assert.throws(() => lifecycle.admit("status"), ChatSwarmError);
  } finally {
    lifecycle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
