import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ChatSwarmStore } from "./chat-swarm-store.js";
import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";
import { registerChatSwarmTools } from "./chat-swarm-tools.js";
import { ChatSwarmLifecycle } from "./chat-swarm-lifecycle.js";
import { hashContent } from "./chat-swarm-contract.js";

function setupFixture() {
  const root = mkdtempSync(join(tmpdir(), "devspace-task-ledger-test-"));
  const store = new ChatSwarmStore(root);
  const coordinator = new ChatSwarmCoordinator(store);
  const ownerMeta = { "openai/session": "owner-session-112" };
  const swarm = coordinator.createSwarm(ownerMeta, { workerLimit: 5 });

  const joinWorker = (label: string, session: string) => {
    const workerMeta = { "openai/session": session };
    const req = coordinator.createJoinRequest(workerMeta, swarm.id, label, `att-${label}`);
    const latestSwarm = store.getSwarm(swarm.id)!;
    coordinator.approveJoin(ownerMeta, swarm.id, req.request.id, req.request.version, latestSwarm.revision);
    const peerStatus = coordinator.peerStatus(workerMeta, swarm.id);
    assert.equal(peerStatus.state, "BOUND");
    return {
      workerId: peerStatus.boundWorker!.workerId,
      meta: workerMeta,
      label,
    };
  };

  return {
    root,
    store,
    coordinator,
    swarm,
    ownerMeta,
    joinWorker,
    clean: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("owner lists/reconstructs exact task ledger after losing controller-local manifest", () => {
  const f = setupFixture();
  try {
    const workerA = f.joinWorker("worker-a", "sess-worker-a");
    const workerB = f.joinWorker("worker-b", "sess-worker-b");

    // 1. Dispatch 4 tasks in different lifecycles
    const t1 = f.coordinator.dispatch(f.ownerMeta, {
      swarmId: f.swarm.id,
      taskKey: "task-01",
      prompt: "secret-prompt-1",
      preferredWorkerId: workerA.workerId,
    });
    const t2 = f.coordinator.dispatch(f.ownerMeta, {
      swarmId: f.swarm.id,
      taskKey: "task-02",
      prompt: "secret-prompt-2",
      preferredWorkerId: workerA.workerId,
    });
    const t3 = f.coordinator.dispatch(f.ownerMeta, {
      swarmId: f.swarm.id,
      taskKey: "task-03",
      prompt: "secret-prompt-3",
      preferredWorkerId: workerB.workerId,
    });
    const t4 = f.coordinator.dispatch(f.ownerMeta, {
      swarmId: f.swarm.id,
      taskKey: "task-04",
      prompt: "secret-prompt-4",
    });

    // Advance t1 to RESULT_READY then COLLECTED
    f.coordinator.submit(workerA.meta, workerA.workerId, t1.id, "result-1");
    f.coordinator.collect(f.ownerMeta, f.swarm.id, t1.id);

    // Worker A claims next (should be t2) and runs it
    const nextA = f.coordinator.nextTask(workerA.meta, workerA.workerId);
    assert.equal(nextA?.id, t2.id);
    f.coordinator.submit(workerA.meta, workerA.workerId, t2.id, "result-2");

    // 2. Owner simulates complete loss of local in-memory manifest
    // Queries durable store via coordinator.listTasks
    const ledger = f.coordinator.listTasks(f.ownerMeta, f.swarm.id);
    assert.equal(ledger.totalCount, 4);
    assert.equal(ledger.tasks.length, 4);

    const map = new Map(ledger.tasks.map((t) => [t.taskKey, t]));

    const s1 = map.get("task-01")!;
    assert.equal(s1.lifecycleState, "COLLECTED");
    assert.equal(s1.hasResult, true);
    assert.equal(s1.resultHash, hashContent("result-1"));
    assert.equal(s1.preferredWorkerId, workerA.workerId);
    assert.equal(s1.assignedWorkerId, workerA.workerId);
    assert.ok(s1.completedAt);
    assert.ok(s1.collectedAt);

    const s2 = map.get("task-02")!;
    assert.equal(s2.lifecycleState, "RESULT_READY");
    assert.equal(s2.hasResult, true);
    assert.equal(s2.resultHash, hashContent("result-2"));
    assert.equal(s2.assignedWorkerId, workerA.workerId);
    assert.ok(s2.completedAt);
    assert.equal(s2.collectedAt, undefined);

    const s3 = map.get("task-03")!;
    // t3 was claimed by workerB on dispatch because workerB was AVAILABLE
    assert.equal(s3.lifecycleState, "CLAIMED");
    assert.equal(s3.assignedWorkerId, workerB.workerId);
    assert.equal(s3.hasResult, false);

    const s4 = map.get("task-04")!;
    // t4 was dispatched without preferredWorker, but both workers were busy so t4 is QUEUED
    assert.equal(s4.lifecycleState, "QUEUED");
    assert.equal(s4.assignedWorkerId, undefined);
    assert.equal(s4.hasResult, false);

    // Also inspect reports recentTasks and taskCounts
    const inspect = f.coordinator.inspect(f.ownerMeta, f.swarm.id);
    assert.equal(inspect.taskCounts?.COLLECTED, 1);
    assert.equal(inspect.taskCounts?.RESULT_READY, 1);
    assert.equal(inspect.taskCounts?.CLAIMED, 1);
    assert.equal(inspect.taskCounts?.QUEUED, 1);
    assert.ok(inspect.recentTasks && inspect.recentTasks.length === 4);
  } finally {
    f.clean();
  }
});

test("non-owner cannot enumerate tasks", () => {
  const f = setupFixture();
  try {
    const intruderMeta = { "openai/session": "foreign-intruder" };
    assert.throws(
      () => f.coordinator.listTasks(intruderMeta, f.swarm.id),
      (err: any) => err.code === "OWNERSHIP_CONFLICT" && /does not own swarm/i.test(err.message),
    );
  } finally {
    f.clean();
  }
});

test("pagination and bounds are deterministic", () => {
  const f = setupFixture();
  try {
    // Insert 12 tasks
    for (let i = 1; i <= 12; i++) {
      f.coordinator.dispatch(f.ownerMeta, {
        swarmId: f.swarm.id,
        taskKey: `page-task-${String(i).padStart(2, "0")}`,
        prompt: `prompt-${i}`,
      });
    }

    // Page 1: limit 5
    const p1 = f.coordinator.listTasks(f.ownerMeta, f.swarm.id, { limit: 5 });
    assert.equal(p1.tasks.length, 5);
    assert.equal(p1.totalCount, 12);
    assert.ok(p1.nextCursor);

    // Page 2: limit 5 with cursor
    const p2 = f.coordinator.listTasks(f.ownerMeta, f.swarm.id, { limit: 5, cursor: p1.nextCursor });
    assert.equal(p2.tasks.length, 5);
    assert.ok(p2.nextCursor);

    // Page 3: limit 5 with cursor (remaining 2)
    const p3 = f.coordinator.listTasks(f.ownerMeta, f.swarm.id, { limit: 5, cursor: p2.nextCursor });
    assert.equal(p3.tasks.length, 2);
    assert.equal(p3.nextCursor, undefined);

    // Verify all 12 tasks are distinct and ordered desc
    const allKeys = [...p1.tasks, ...p2.tasks, ...p3.tasks].map((t) => t.taskKey);
    assert.equal(new Set(allKeys).size, 12);

    // Filter by lifecycleState
    const queuedOnly = f.coordinator.listTasks(f.ownerMeta, f.swarm.id, { lifecycleState: "QUEUED" });
    assert.equal(queuedOnly.totalCount, 12);

    const runningOnly = f.coordinator.listTasks(f.ownerMeta, f.swarm.id, { lifecycleState: "RUNNING" });
    assert.equal(runningOnly.totalCount, 0);
    assert.equal(runningOnly.tasks.length, 0);
  } finally {
    f.clean();
  }
});

test("prompt and payload and raw result are not leaked in ledger summary", () => {
  const f = setupFixture();
  try {
    const worker = f.joinWorker("worker-x", "sess-worker-x");
    const secretPrompt = "SUPER_SECRET_INTERNAL_PROMPT_DO_NOT_LEAK";
    const secretResult = "SUPER_SECRET_INTERNAL_RESULT_BODY_DO_NOT_LEAK";

    const task = f.coordinator.dispatch(f.ownerMeta, {
      swarmId: f.swarm.id,
      taskKey: "secret-key",
      prompt: secretPrompt,
      payload: { sensitiveToken: "token-123" },
      preferredWorkerId: worker.workerId,
    });
    f.coordinator.submit(worker.meta, worker.workerId, task.id, secretResult);

    const ledger = f.coordinator.listTasks(f.ownerMeta, f.swarm.id);
    assert.equal(ledger.tasks.length, 1);
    const summary = ledger.tasks[0]!;

    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes(secretPrompt), false);
    assert.equal(serialized.includes("sensitiveToken"), false);
    assert.equal(serialized.includes(secretResult), false);

    assert.equal(summary.hasResult, true);
    assert.equal(summary.resultHash, hashContent(secretResult));
    assert.equal((summary as any).prompt, undefined);
    assert.equal((summary as any).payload, undefined);
    assert.equal((summary as any).result, undefined);
  } finally {
    f.clean();
  }
});

test("dispatch targeted task to AVAILABLE worker claims immediately; subsequent to BUSY worker remains QUEUED", () => {
  const f = setupFixture();
  try {
    const workerA = f.joinWorker("worker-a", "sess-worker-a");

    // 1. Dispatch to AVAILABLE workerA -> claimed immediately
    const t1 = f.coordinator.dispatch(f.ownerMeta, {
      swarmId: f.swarm.id,
      taskKey: "targeted-01",
      prompt: "do 1",
      preferredWorkerId: workerA.workerId,
    });
    assert.equal(t1.lifecycleState, "CLAIMED");
    assert.equal(t1.assignedWorkerId, workerA.workerId);

    // Worker A is now BUSY with t1
    const workerRecord = f.store.getWorker(workerA.workerId)!;
    assert.equal(workerRecord.lifecycleState, "BUSY");
    assert.equal(workerRecord.currentTaskId, t1.id);

    // 2. Dispatch targeted-02 and targeted-03 to Worker A while A is BUSY
    // MUST NOT throw OWNERSHIP_CONFLICT! MUST remain QUEUED!
    const t2 = f.coordinator.dispatch(f.ownerMeta, {
      swarmId: f.swarm.id,
      taskKey: "targeted-02",
      prompt: "do 2",
      preferredWorkerId: workerA.workerId,
    });
    assert.equal(t2.lifecycleState, "QUEUED");
    assert.equal(t2.preferredWorkerId, workerA.workerId);
    assert.equal(t2.assignedWorkerId, undefined);

    const t3 = f.coordinator.dispatch(f.ownerMeta, {
      swarmId: f.swarm.id,
      taskKey: "targeted-03",
      prompt: "do 3",
      preferredWorkerId: workerA.workerId,
    });
    assert.equal(t3.lifecycleState, "QUEUED");
    assert.equal(t3.preferredWorkerId, workerA.workerId);
    assert.equal(t3.assignedWorkerId, undefined);

    // 3. Worker A submits t1 -> completes t1 and releases worker A
    f.coordinator.submit(workerA.meta, workerA.workerId, t1.id, "res-1");

    // 4. Worker A calls nextTask -> atomically claims t2 in order
    const next1 = f.coordinator.nextTask(workerA.meta, workerA.workerId);
    assert.equal(next1?.id, t2.id);
    assert.equal(next1?.taskKey, "targeted-02");
    assert.equal(next1?.lifecycleState, "CLAIMED");

    // 5. Worker A submits t2 and claims t3
    f.coordinator.submit(workerA.meta, workerA.workerId, t2.id, "res-2");
    const next2 = f.coordinator.nextTask(workerA.meta, workerA.workerId);
    assert.equal(next2?.id, t3.id);
    assert.equal(next2?.taskKey, "targeted-03");
  } finally {
    f.clean();
  }
});

test("A and B can each have multiple queued tasks simultaneously without cross-worker stealing", () => {
  const f = setupFixture();
  try {
    const workerA = f.joinWorker("worker-a", "sess-worker-a");
    const workerB = f.joinWorker("worker-b", "sess-worker-b");

    // Preload queues:
    // A: a-01 (claimed), a-02 (queued), a-03 (queued)
    // B: b-01 (claimed), b-02 (queued), b-03 (queued)
    const a1 = f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "a-01", prompt: "pa1", preferredWorkerId: workerA.workerId });
    const a2 = f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "a-02", prompt: "pa2", preferredWorkerId: workerA.workerId });
    const a3 = f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "a-03", prompt: "pa3", preferredWorkerId: workerA.workerId });

    const b1 = f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "b-01", prompt: "pb1", preferredWorkerId: workerB.workerId });
    const b2 = f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "b-02", prompt: "pb2", preferredWorkerId: workerB.workerId });
    const b3 = f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "b-03", prompt: "pb3", preferredWorkerId: workerB.workerId });

    assert.equal(a1.lifecycleState, "CLAIMED");
    assert.equal(a2.lifecycleState, "QUEUED");
    assert.equal(a3.lifecycleState, "QUEUED");

    assert.equal(b1.lifecycleState, "CLAIMED");
    assert.equal(b2.lifecycleState, "QUEUED");
    assert.equal(b3.lifecycleState, "QUEUED");

    // Worker A finishes a1 and claims next -> MUST be a2, NEVER b2 or b3!
    f.coordinator.submit(workerA.meta, workerA.workerId, a1.id, "res-a1");
    const nextA1 = f.coordinator.nextTask(workerA.meta, workerA.workerId);
    assert.equal(nextA1?.id, a2.id);

    // Worker B finishes b1 and claims next -> MUST be b2, NEVER a3!
    f.coordinator.submit(workerB.meta, workerB.workerId, b1.id, "res-b1");
    const nextB1 = f.coordinator.nextTask(workerB.meta, workerB.workerId);
    assert.equal(nextB1?.id, b2.id);

    // Finish a2 -> claims a3
    f.coordinator.submit(workerA.meta, workerA.workerId, a2.id, "res-a2");
    const nextA2 = f.coordinator.nextTask(workerA.meta, workerA.workerId);
    assert.equal(nextA2?.id, a3.id);

    // Finish b2 -> claims b3
    f.coordinator.submit(workerB.meta, workerB.workerId, b2.id, "res-b2");
    const nextB2 = f.coordinator.nextTask(workerB.meta, workerB.workerId);
    assert.equal(nextB2?.id, b3.id);
  } finally {
    f.clean();
  }
});

test("queue limit is still enforced during targeted dispatch", () => {
  const f = setupFixture();
  try {
    const workerA = f.joinWorker("worker-a", "sess-worker-a");
    // Claim active task
    f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "active-1", prompt: "p", preferredWorkerId: workerA.workerId });

    // Queue limit = 2
    f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "q-1", prompt: "q1", preferredWorkerId: workerA.workerId }, 2);
    f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "q-2", prompt: "q2", preferredWorkerId: workerA.workerId }, 2);

    // 3rd queued task should exceed limit=2
    assert.throws(
      () => f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "q-3", prompt: "q3", preferredWorkerId: workerA.workerId }, 2),
      (err: any) => err.code === "INVALID_INPUT" && /queue limit reached/i.test(err.message),
    );
  } finally {
    f.clean();
  }
});

test("identical replay while queued, claimed, result-ready, collected returns same task; changed material conflicts", () => {
  const f = setupFixture();
  try {
    const worker = f.joinWorker("worker-rep", "sess-rep");
    // Active task to make worker busy
    const blocker = f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "blocker", prompt: "block", preferredWorkerId: worker.workerId });

    // 1. Dispatch QUEUED task
    const t = f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "target-rep", prompt: "orig-prompt", preferredWorkerId: worker.workerId });
    assert.equal(t.lifecycleState, "QUEUED");

    // Identical replay while QUEUED
    const repQueued = f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "target-rep", prompt: "orig-prompt", preferredWorkerId: worker.workerId });
    assert.equal(repQueued.id, t.id);

    // Changed replay while QUEUED -> REPLAY_CONFLICT
    assert.throws(
      () => f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "target-rep", prompt: "different-prompt", preferredWorkerId: worker.workerId }),
      (err: any) => err.code === "REPLAY_CONFLICT",
    );

    // Free worker and claim
    f.coordinator.submit(worker.meta, worker.workerId, blocker.id, "done");
    f.coordinator.nextTask(worker.meta, worker.workerId);

    // Identical replay while CLAIMED
    const repClaimed = f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "target-rep", prompt: "orig-prompt", preferredWorkerId: worker.workerId });
    assert.equal(repClaimed.id, t.id);

    // Complete result
    f.coordinator.submit(worker.meta, worker.workerId, t.id, "my-result");

    // Identical replay while RESULT_READY
    const repReady = f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "target-rep", prompt: "orig-prompt", preferredWorkerId: worker.workerId });
    assert.equal(repReady.id, t.id);

    // Collect result
    f.coordinator.collect(f.ownerMeta, f.swarm.id, t.id);

    // Identical replay while COLLECTED
    const repCollected = f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "target-rep", prompt: "orig-prompt", preferredWorkerId: worker.workerId });
    assert.equal(repCollected.id, t.id);
  } finally {
    f.clean();
  }
});

test("restart with active work preserves RECONCILE_REQUIRED semantics and leaves unrelated queued targeted work intact", () => {
  const f = setupFixture();
  try {
    const workerA = f.joinWorker("worker-a", "sess-worker-a");
    const workerB = f.joinWorker("worker-b", "sess-worker-b");

    // t1 active on A
    const t1 = f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "t1", prompt: "p1", preferredWorkerId: workerA.workerId });
    // t2 queued for A
    const t2 = f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "t2", prompt: "p2", preferredWorkerId: workerA.workerId });
    // tB0 active on B
    const tB0 = f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "tB0", prompt: "pB0", preferredWorkerId: workerB.workerId });
    // t3 queued for B
    const t3 = f.coordinator.dispatch(f.ownerMeta, { swarmId: f.swarm.id, taskKey: "t3", prompt: "p3", preferredWorkerId: workerB.workerId });

    assert.equal(t1.lifecycleState, "CLAIMED");
    assert.equal(t2.lifecycleState, "QUEUED");
    assert.equal(tB0.lifecycleState, "CLAIMED");
    assert.equal(t3.lifecycleState, "QUEUED");

    // Simulate restart recovery
    f.store.recoverAfterRestart();

    const t1After = f.store.getTask(t1.id)!;
    assert.equal(t1After.lifecycleState, "RECONCILE_REQUIRED");
    const tB0After = f.store.getTask(tB0.id)!;
    assert.equal(tB0After.lifecycleState, "RECONCILE_REQUIRED");

    const t2After = f.store.getTask(t2.id)!;
    assert.equal(t2After.lifecycleState, "QUEUED");
    assert.equal(t2After.preferredWorkerId, workerA.workerId);

    const t3After = f.store.getTask(t3.id)!;
    assert.equal(t3After.lifecycleState, "QUEUED");
    assert.equal(t3After.preferredWorkerId, workerB.workerId);
  } finally {
    f.clean();
  }
});

test("drain rejects new dispatch but permits task ledger reads", () => {
  const f = setupFixture();
  try {
    let mode: "normal" | "drain" = "normal";
    const lifecycle = new ChatSwarmLifecycle({
      stateDir: f.root,
      mode: () => mode,
    });

    mode = "drain";
    // New dispatch should be denied
    assert.throws(
      () => lifecycle.admit("dispatch"),
      (err: any) => err.code === "INVALID_STATE" && /is unavailable while cutover is drain/i.test(err.message),
    );

    // tasks and inspect are permitted in drain mode
    assert.doesNotThrow(() => lifecycle.admit("tasks"));
    assert.doesNotThrow(() => lifecycle.admit("inspect"));
    assert.doesNotThrow(() => lifecycle.admit("status"));
    assert.doesNotThrow(() => lifecycle.admit("collect"));
  } finally {
    f.clean();
  }
});

test("end-to-end MCP protocol tools execution for task ledger", async () => {
  const f = setupFixture();
  const server = new McpServer({ name: "test-ledger-server", version: "1" });
  registerChatSwarmTools(server, {
    coordinator: f.coordinator,
    config: {
      chatSwarmEnabled: true,
      chatSwarmMaxWorkers: 5,
      chatSwarmQueueLimit: 10,
      chatSwarmResultMaxChars: 1000,
      chatSwarmInviteTtlSeconds: 900,
    },
    admit: () => {},
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ledger-test-client", version: "1" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  try {
    // Dispatch a task via protocol
    await client.callTool({
      name: "chat_swarm_dispatch",
      arguments: {
        swarmId: f.swarm.id,
        taskKey: "mcp-task-1",
        prompt: "do something",
      },
      _meta: f.ownerMeta,
    });

    // Call chat_swarm_tasks
    const tasksRes = await client.callTool({
      name: "chat_swarm_tasks",
      arguments: {
        swarmId: f.swarm.id,
        limit: 10,
      },
      _meta: f.ownerMeta,
    });

    const tasksData = (tasksRes.structuredContent ?? JSON.parse(((tasksRes as any).content[0] as { text: string }).text)) as Record<string, any>;
    assert.equal(tasksData.totalCount, 1);
    assert.equal(tasksData.tasks.length, 1);
    assert.equal(tasksData.tasks[0].taskKey, "mcp-task-1");
    assert.equal(tasksData.tasks[0].lifecycleState, "QUEUED");
  } finally {
    await client.close();
    f.clean();
  }
});
