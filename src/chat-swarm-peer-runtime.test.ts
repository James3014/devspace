import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";
import { ChatSwarmPeerRuntime } from "./chat-swarm-peer-runtime.js";
import { ChatSwarmStore } from "./chat-swarm-store.js";

test("peer runtime delegates join, next, checkpoint, and submit through coordinator", () => { const root = mkdtempSync(join(tmpdir(), "devspace-peer-runtime-")); const store = new ChatSwarmStore(root); try { const coordinator = new ChatSwarmCoordinator(store); const runtime = new ChatSwarmPeerRuntime(coordinator); const owner = { "openai/session": "owner" }; const workerMeta = { "openai/session": "worker" }; const swarm = coordinator.createSwarm(owner, { workerLimit: 1 }); const worker = runtime.join(workerMeta, swarm.id, { label: "peer", runtimeKind: "mcp_peer" }); const task = coordinator.dispatch(owner, { swarmId: swarm.id, taskKey: "runtime", prompt: "p" }); assert.equal(runtime.next(workerMeta, worker.id)?.id, task.id); assert.equal(runtime.checkpoint(workerMeta, worker.id, worker.continuationEpoch, new Date(Date.now() + 60_000).toISOString(), { cursor: "x" }).checkpoint?.cursor, "x"); assert.equal(runtime.submit(workerMeta, worker.id, task.id, "done").result, "done"); } finally { store.close(); rmSync(root, { recursive: true, force: true }); } });
