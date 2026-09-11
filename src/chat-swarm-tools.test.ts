import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import test from "node:test";
import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";
import { ChatSwarmStore } from "./chat-swarm-store.js";
import { registerChatSwarmTools } from "./chat-swarm-tools.js";

const config = { chatSwarmEnabled: true, chatSwarmMaxWorkers: 4, chatSwarmQueueLimit: 20, chatSwarmResultMaxChars: 4096, chatSwarmInviteTtlSeconds: 900 } as const;
function fixture() { const root = mkdtempSync(join(tmpdir(), "devspace-swarm-tools-")); const store = new ChatSwarmStore(root); const coordinator = new ChatSwarmCoordinator(store); return { root, store, coordinator }; }
function close(f: ReturnType<typeof fixture>) { f.store.close(); rmSync(f.root, { recursive: true, force: true }); }
function tools(server: McpServer): Record<string, { handler: (input: any, extra: any) => Promise<any>; inputSchema: any }> { return (server as any)._registeredTools; }
const now = () => new Date().toISOString();

test("registers ten typed swarm tools and disabled config registers none", async () => {
  const f = fixture();
  try {
    const disabled = new McpServer({ name: "disabled", version: "1" });
    assert.equal(registerChatSwarmTools(disabled, { coordinator: f.coordinator, config: { ...config, chatSwarmEnabled: false }, authorizeInvite: () => true }), 0);
    assert.deepEqual(Object.keys(tools(disabled)), []);
    const server = new McpServer({ name: "enabled", version: "1" });
    assert.equal(registerChatSwarmTools(server, { coordinator: f.coordinator, config, authorizeInvite: () => true }), 14);
    assert.deepEqual(Object.keys(tools(server)).sort(), [
      "chat_swarm_approve_join",
      "chat_swarm_cancel",
      "chat_swarm_close",
      "chat_swarm_collect",
      "chat_swarm_create",
      "chat_swarm_dispatch",
      "chat_swarm_inspect",
      "chat_swarm_join",
      "chat_swarm_join_request",
      "chat_swarm_next",
      "chat_swarm_peer_status",
      "chat_swarm_reconcile",
      "chat_swarm_status",
      "chat_swarm_submit",
    ]);
    assert.throws(() => tools(server).chat_swarm_submit.inputSchema.parse({ workerId: "w", taskId: "t", result: "x".repeat(config.chatSwarmResultMaxChars + 1) }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "swarm-tools-client", version: "1" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), Object.keys(tools(server)).sort());
    assert.equal(listed.tools.find((tool) => tool.name === "chat_swarm_status")?.annotations?.readOnlyHint, true);
    const protocolCreate = await client.callTool({ name: "chat_swarm_create", arguments: { workerLimit: 1 } , _meta: { "openai/session": "protocol-owner" } });
    assert.equal(protocolCreate.isError, undefined);
    const created = protocolCreate.structuredContent as any;
    const nearBoundary = await client.callTool({ name: "chat_swarm_create", arguments: { workerLimit: 1, metadata: { near: "x".repeat(58 * 1024) } }, _meta: { "openai/session": "boundary-owner" } });
    assert.equal(nearBoundary.isError, undefined);
    const deniedBoundary = await client.callTool({ name: "chat_swarm_create", arguments: { workerLimit: 1, metadata: { huge: "x".repeat(64 * 1024) } }, _meta: { "openai/session": "boundary-owner" } });
    assert.equal(deniedBoundary.isError, true);
    const joined = await client.callTool({ name: "chat_swarm_join", arguments: { swarmId: created.swarm.id, inviteCredential: created.inviteCredential, label: "peer", runtimeKind: "mcp_peer" }, _meta: { "openai/session": "protocol-worker" } });
    const worker = joined.structuredContent as any;
    const dispatched = await client.callTool({ name: "chat_swarm_dispatch", arguments: { swarmId: created.swarm.id, taskKey: "protocol-task", prompt: "protocol" }, _meta: { "openai/session": "protocol-owner" } });
    const task = dispatched.structuredContent as any;
    const next = await client.callTool({ name: "chat_swarm_next", arguments: { workerId: worker.id }, _meta: { "openai/session": "protocol-worker" } });
    assert.equal((next.structuredContent as any).task.id, task.id);
    const status = await client.callTool({ name: "chat_swarm_status", arguments: { swarmId: created.swarm.id, taskId: task.id }, _meta: { "openai/session": "protocol-owner" } });
    assert.equal((status.structuredContent as any).id, task.id);
    await client.callTool({ name: "chat_swarm_submit", arguments: { workerId: worker.id, taskId: task.id, result: "done" }, _meta: { "openai/session": "protocol-worker" } });
    const invalidEvidence = await client.callTool({ name: "chat_swarm_reconcile", arguments: { swarmId: created.swarm.id, taskId: task.id, decision: "REQUEUE", evidence: { taskId: task.id } }, _meta: { "openai/session": "protocol-owner" } });
    assert.equal(invalidEvidence.isError, true);
    const oversizedResult = await client.callTool({ name: "chat_swarm_submit", arguments: { workerId: worker.id, taskId: task.id, result: "x".repeat(config.chatSwarmResultMaxChars + 1) }, _meta: { "openai/session": "protocol-worker" } });
    assert.equal(oversizedResult.isError, true);
    const collected = await client.callTool({ name: "chat_swarm_collect", arguments: { swarmId: created.swarm.id, taskId: task.id }, _meta: { "openai/session": "protocol-owner" } });
    assert.equal((collected.structuredContent as any).lifecycleState, "COLLECTED");
    const closed = await client.callTool({ name: "chat_swarm_close", arguments: { swarmId: created.swarm.id }, _meta: { "openai/session": "protocol-owner" } });
    assert.equal((closed.structuredContent as any).status, "CLOSED");
    await client.close();
    await server.close();
    const queueServer = new McpServer({ name: "queue", version: "1" });
    registerChatSwarmTools(queueServer, { coordinator: f.coordinator, config: { ...config, chatSwarmQueueLimit: 1 }, authorizeInvite: () => true });
    const queueTools = tools(queueServer);
    const queueSwarm = await queueTools.chat_swarm_create.handler({ workerLimit: 1 }, { _meta: { "openai/session": "queue-owner" } });
    const queueSwarmId = queueSwarm.structuredContent.swarm.id;
    const firstQueue = await queueTools.chat_swarm_dispatch.handler({ swarmId: queueSwarmId, taskKey: "q1", prompt: "p" }, { _meta: { "openai/session": "queue-owner" } });
    assert.equal(firstQueue.structuredContent.lifecycleState, "QUEUED");
    const replay = await queueTools.chat_swarm_dispatch.handler({ swarmId: queueSwarmId, taskKey: "q1", prompt: "p" }, { _meta: { "openai/session": "queue-owner" } });
    assert.equal(replay.structuredContent.id, firstQueue.structuredContent.id);
    const concurrent = await Promise.all(["q2", "q3"].map((taskKey) => queueTools.chat_swarm_dispatch.handler({ swarmId: queueSwarmId, taskKey, prompt: "p" }, { _meta: { "openai/session": "queue-owner" } })));
    assert.equal(concurrent.filter((item) => item.isError).length, 2);
  } finally { close(f); }
});

test("production-shaped handlers enforce owner, worker, invite TTL, and drain admission", async () => {
  const f = fixture();
  try {
    const owner = { "openai/session": "owner" };
    const workerMeta = { "openai/session": "worker" };
    const server = new McpServer({ name: "enabled", version: "1" });
    const denied: string[] = [];
    registerChatSwarmTools(server, { coordinator: f.coordinator, config, authorizeInvite: ({ credential }) => credential === "invite", admit: (action, context) => { denied.push(action); if (["create", "join", "dispatch", "worker_next"].includes(action) && !context?.existingTask) throw new Error("cutover draining"); } });
    const registered = tools(server);
    const created = await registered.chat_swarm_create.handler({ workerLimit: 1 }, { _meta: owner });
    assert.equal(created.isError, true);
    const normalServer = new McpServer({ name: "normal", version: "1" });
    registerChatSwarmTools(normalServer, { coordinator: f.coordinator, config, authorizeInvite: () => true });
    const normal = tools(normalServer);
    const swarmResult = await normal.chat_swarm_create.handler({ workerLimit: 1 }, { _meta: owner });
    const swarmId = swarmResult.structuredContent.swarm.id;
    const sqlite = (f.store as any).sqlite;
    sqlite.prepare("update chat_swarms set metadata_json=? where id=?").run(JSON.stringify({ chatSwarmInviteIssuedAt: new Date(Date.now() - 2_000_000).toISOString() }), swarmId);
    const stale = await normal.chat_swarm_join.handler({ swarmId, inviteCredential: swarmResult.structuredContent.inviteCredential, label: "peer", runtimeKind: "mcp_peer" }, { _meta: workerMeta });
    assert.equal(stale.isError, true);
    const fresh = await normal.chat_swarm_create.handler({ workerLimit: 1 }, { _meta: owner });
    const freshSwarmId = fresh.structuredContent.swarm.id;
    const invalidFresh = await normal.chat_swarm_join.handler({ swarmId: freshSwarmId, inviteCredential: "wrong", label: "peer", runtimeKind: "mcp_peer" }, { _meta: workerMeta });
    assert.equal(invalidFresh.isError, true);
    const joined = await normal.chat_swarm_join.handler({ swarmId: freshSwarmId, inviteCredential: fresh.structuredContent.inviteCredential, label: "peer", runtimeKind: "mcp_peer" }, { _meta: workerMeta });
    const swarmIdForTask = freshSwarmId;
    const workerId = joined.structuredContent.id;
    const wrongOwner = await normal.chat_swarm_dispatch.handler({ swarmId: swarmIdForTask, taskKey: "wrong", prompt: "p" }, { _meta: { "openai/session": "other" } });
    assert.equal(wrongOwner.isError, true);
    const task = await normal.chat_swarm_dispatch.handler({ swarmId: swarmIdForTask, taskKey: "owned", prompt: "p" }, { _meta: owner });
    assert.equal(task.structuredContent.assignedWorkerId, workerId);
    const drainServer = new McpServer({ name: "drain", version: "1" });
    registerChatSwarmTools(drainServer, { coordinator: f.coordinator, config, authorizeInvite: () => true, admit: (action, context) => { if (["create", "join", "dispatch", "worker_next"].includes(action) && !context?.existingTask) throw new Error("draining"); } });
    const [drainClientTransport, drainServerTransport] = InMemoryTransport.createLinkedPair();
    const drainClient = new Client({ name: "drain-client", version: "1" });
    await Promise.all([drainClient.connect(drainClientTransport), drainServer.connect(drainServerTransport)]);
    const drainSubmit = await drainClient.callTool({ name: "chat_swarm_submit", arguments: { workerId, taskId: task.structuredContent.id, result: "x" }, _meta: workerMeta });
    assert.equal(drainSubmit.isError, undefined);
    const blockedDispatch = await drainClient.callTool({ name: "chat_swarm_dispatch", arguments: { swarmId: swarmIdForTask, taskKey: "drain-blocked", prompt: "p" }, _meta: owner });
    assert.equal(blockedDispatch.isError, true);
    await drainClient.close();
    await drainServer.close();
    const wrongWorker = await normal.chat_swarm_submit.handler({ workerId, taskId: task.structuredContent.id, result: "x" }, { _meta: { "openai/session": "other" } });
    assert.equal(wrongWorker.isError, true);
    const terminal = await normal.chat_swarm_submit.handler({ workerId, taskId: task.structuredContent.id, result: "x" }, { _meta: workerMeta });
    assert.equal(terminal.structuredContent.lifecycleState, "RESULT_READY");
    assert.deepEqual((await normal.chat_swarm_next.handler({ workerId }, { _meta: workerMeta })).structuredContent, { task: null });
    assert.ok(denied.includes("create"));
  } finally { close(f); }
});


test("drain admission cannot turn a vanished current task into a queued claim", async () => {
  const f=fixture(); const server=new McpServer({name:"drain-race",version:"1"});
  const owner={"openai/session":"race-owner"}; const workerMeta={"openai/session":"race-worker"};
  try {
    const swarm=f.coordinator.createSwarm(owner,{workerLimit:1});
    const worker=f.coordinator.joinWorker(workerMeta,swarm.id,{label:"worker",runtimeKind:"mcp_peer"});
    const first=f.coordinator.dispatch(owner,{swarmId:swarm.id,taskKey:"first",prompt:"first"});
    const second=f.coordinator.dispatch(owner,{swarmId:swarm.id,taskKey:"second",prompt:"second"});
    assert.equal(second.lifecycleState,"QUEUED");
    registerChatSwarmTools(server,{coordinator:f.coordinator,config,admit:(action,context)=>{
      assert.equal(action,"worker_next"); assert.equal(context?.existingTask,true);
      f.coordinator.submit(workerMeta,worker.id,first.id,"done");
      f.coordinator.collect(owner,swarm.id,first.id);
    }});
    const result=await tools(server).chat_swarm_next.handler({workerId:worker.id},{_meta:workerMeta});
    assert.equal(result.isError,undefined);
    assert.equal(result.structuredContent.task,null);
    assert.equal(f.store.getTask(second.id)?.lifecycleState,"QUEUED");
    assert.equal(f.store.getTask(second.id)?.assignedWorkerId,undefined);
    assert.equal(f.coordinator.nextTask(workerMeta,worker.id)?.id,second.id);
  } finally {await server.close();close(f);}
});
