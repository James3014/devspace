import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ChatSwarmError } from "./chat-swarm-contract.js";
import { ChatSwarmStore } from "./chat-swarm-store.js";
import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";
import { ChatSwarmLifecycle } from "./chat-swarm-lifecycle.js";
import { registerChatSwarmTools } from "./chat-swarm-tools.js";

function fixture(workerLimit = 2) {
  const root = mkdtempSync(join(tmpdir(), "swarm-admission-test-"));
  const store = new ChatSwarmStore(root);
  const coordinator = new ChatSwarmCoordinator(store);
  const ownerMeta = { "openai/session": "owner-session-1" };
  const swarm = coordinator.createSwarm(ownerMeta, { workerLimit, metadata: { name: "test-swarm" } });
  return { root, store, coordinator, ownerMeta, swarm };
}

function cleanup(f: ReturnType<typeof fixture>) {
  f.store.close();
  rmSync(f.root, { recursive: true, force: true });
}

// 1. peer_status reports missing, ambiguous, malformed, unbound, and bound identity states
test("peer_status reports missing, ambiguous, malformed, unbound, and bound identity states", () => {
  const f = fixture();
  try {
    // 1. Missing identity
    const missing = f.coordinator.peerStatus({});
    assert.equal(missing.identity.status, "MISSING");
    assert.equal(missing.state, "BLOCKED");
    assert.equal(missing.blocker?.code, "IDENTITY_MISSING");

    // 2. Ambiguous identity (conflicting headers)
    const ambiguous = f.coordinator.peerStatus({ "openai/session": "a", "openai/conversationId": "b" });
    assert.equal(ambiguous.identity.status, "AMBIGUOUS");
    assert.equal(ambiguous.state, "BLOCKED");
    assert.equal(ambiguous.blocker?.code, "IDENTITY_AMBIGUOUS");

    // 3. Malformed identity (empty string whitespace header)
    const malformed = f.coordinator.peerStatus({ "openai/session": "   " });
    assert.equal(malformed.identity.status, "MALFORMED");
    assert.equal(malformed.state, "BLOCKED");
    assert.equal(malformed.blocker?.code, "IDENTITY_MALFORMED");

    // 4. Resolved identity without swarmId -> UNBOUND
    const peerMeta = { "openai/conversation_id": "peer-chat-1" };
    const unboundNoSwarm = f.coordinator.peerStatus(peerMeta);
    assert.equal(unboundNoSwarm.identity.status, "RESOLVED");
    assert.equal(unboundNoSwarm.state, "UNBOUND");

    // 5. Resolved identity with nonexistent swarmId -> BLOCKED (NOT_FOUND)
    const nonexistent = f.coordinator.peerStatus(peerMeta, "nonexistent-swarm");
    assert.equal(nonexistent.state, "BLOCKED");
    assert.equal(nonexistent.blocker?.code, "NOT_FOUND");

    // 6. Resolved identity in active swarm with no request -> UNBOUND
    const unboundInSwarm = f.coordinator.peerStatus(peerMeta, f.swarm.id);
    assert.equal(unboundInSwarm.state, "UNBOUND");
    assert.equal(unboundInSwarm.deliveryMode, "POLLING_ONLY");
  } finally {
    cleanup(f);
  }
});

// 2. join_request creates bounded nonsecret pending request, identical replay idempotent, changed input conflicts
test("join_request creates bounded nonsecret pending request, identical replay idempotent, changed input conflicts", () => {
  const f = fixture();
  const peerMeta = { "openai/conversation_id": "peer-chat-2" };
  try {
    const req1 = f.coordinator.createJoinRequest(peerMeta, f.swarm.id, "Worker-01", "attempt-key-1");
    assert.equal(req1.created, true);
    assert.equal(req1.request.label, "Worker-01");
    assert.equal(req1.request.version, 1);
    assert.equal(req1.request.status, "PENDING");
    assert.ok(req1.request.id.startsWith("joinreq_"));
    assert.ok(new Date(req1.request.expiresAt).getTime() > Date.now());

    const statusPending = f.coordinator.peerStatus(peerMeta, f.swarm.id);
    assert.equal(statusPending.state, "PENDING_APPROVAL");
    assert.equal(statusPending.pendingRequest?.requestId, req1.request.id);
    assert.equal(statusPending.pendingRequest?.label, "Worker-01");
    assert.equal(statusPending.pendingRequest?.version, 1);

    const replay = f.coordinator.createJoinRequest(peerMeta, f.swarm.id, "Worker-01", "attempt-key-1");
    assert.equal(replay.created, false);
    assert.equal(replay.request.id, req1.request.id);

    assert.throws(
      () => f.coordinator.createJoinRequest(peerMeta, f.swarm.id, "Worker-Different", "attempt-key-1"),
      (err: unknown) => err instanceof ChatSwarmError && err.code === "REPLAY_CONFLICT",
    );
  } finally {
    cleanup(f);
  }
});

// 3. inspect allows only exact owner to view roster, swarm revision, and pending requests
test("inspect allows only exact owner to view roster, swarm revision, and pending requests", () => {
  const f = fixture();
  const peerMeta = { "openai/conversation_id": "peer-chat-3" };
  try {
    f.coordinator.createJoinRequest(peerMeta, f.swarm.id, "Worker-01", "attempt-3");

    assert.throws(
      () => f.coordinator.inspect(peerMeta, f.swarm.id),
      (err: unknown) => err instanceof ChatSwarmError && err.code === "OWNERSHIP_CONFLICT",
    );

    const inspection = f.coordinator.inspect(f.ownerMeta, f.swarm.id);
    assert.equal(inspection.swarm.id, f.swarm.id);
    assert.equal(inspection.swarm.revision, 1);
    assert.equal(inspection.roster.length, 0);
    assert.equal(inspection.pendingRequests.length, 1);
    assert.equal(inspection.pendingRequests[0]!.label, "Worker-01");
    assert.equal(inspection.pendingRequests[0]!.version, 1);
    assert.equal(inspection.observedDeliveryMode, "POLLING_ONLY");
  } finally {
    cleanup(f);
  }
});

// 4. approve_join validates owner, request CAS version, swarm revision CAS, capacity limit, and establishes worker binding
test("approve_join validates owner, request CAS version, swarm revision CAS, capacity limit, and establishes worker binding", () => {
  const f = fixture(2);
  const peer1Meta = { "openai/conversation_id": "peer-worker-1" };
  const peer2Meta = { "openai/conversation_id": "peer-worker-2" };
  const peer3Meta = { "openai/conversation_id": "peer-worker-3" };

  try {
    const req1 = f.coordinator.createJoinRequest(peer1Meta, f.swarm.id, "Worker-01", "att-1").request;
    const req2 = f.coordinator.createJoinRequest(peer2Meta, f.swarm.id, "Worker-02", "att-2").request;
    const req3 = f.coordinator.createJoinRequest(peer3Meta, f.swarm.id, "Worker-03", "att-3").request;

    // 1. Non-owner cannot approve
    assert.throws(
      () => f.coordinator.approveJoin(peer1Meta, f.swarm.id, req1.id, 1, 1),
      (err: unknown) => err instanceof ChatSwarmError && err.code === "OWNERSHIP_CONFLICT",
    );

    // 2. Wrong request version fails with VERSION_CONFLICT
    assert.throws(
      () => f.coordinator.approveJoin(f.ownerMeta, f.swarm.id, req1.id, 999, 1),
      (err: unknown) => err instanceof ChatSwarmError && err.code === "VERSION_CONFLICT",
    );

    // 3. Wrong swarm revision fails with CAS_DRIFT
    assert.throws(
      () => f.coordinator.approveJoin(f.ownerMeta, f.swarm.id, req1.id, 1, 999),
      (err: unknown) => err instanceof ChatSwarmError && err.code === "CAS_DRIFT",
    );

    // 4. Owner approves req1 with exact expected versions (1, 1) -> bumps swarm revision to 2
    const app1 = f.coordinator.approveJoin(f.ownerMeta, f.swarm.id, req1.id, 1, 1);
    assert.equal(app1.request.status, "APPROVED");
    assert.equal(app1.request.version, 2);
    assert.ok(app1.worker.id.startsWith("worker_"));
    assert.equal(app1.worker.label, "Worker-01");

    // 5. Worker 1 reads APPROVED and bound workerId via peer_status
    const peer1Status = f.coordinator.peerStatus(peer1Meta, f.swarm.id);
    assert.equal(peer1Status.state, "BOUND");
    assert.equal(peer1Status.boundWorker?.workerId, app1.worker.id);
    assert.equal(peer1Status.boundWorker?.label, "Worker-01");

    // 6. Inspect reflects updated swarm revision = 2
    const inspAfterApp1 = f.coordinator.inspect(f.ownerMeta, f.swarm.id);
    assert.equal(inspAfterApp1.swarm.revision, 2);

    // 7. Stale expectedSwarmVersion (1) is rejected on next approval
    assert.throws(
      () => f.coordinator.approveJoin(f.ownerMeta, f.swarm.id, req2.id, 1, 1),
      (err: unknown) => err instanceof ChatSwarmError && err.code === "CAS_DRIFT",
    );

    // 8. Correct expectedSwarmVersion (2) succeeds -> bumps swarm revision to 3
    const app2 = f.coordinator.approveJoin(f.ownerMeta, f.swarm.id, req2.id, 1, 2);
    assert.equal(app2.request.status, "APPROVED");

    // 9. Approve third worker fails with CAPACITY_FULL (workerLimit = 2)
    assert.throws(
      () => f.coordinator.approveJoin(f.ownerMeta, f.swarm.id, req3.id, 1, 3),
      (err: unknown) => err instanceof ChatSwarmError && err.code === "CAPACITY_FULL",
    );

    // 10. Inspect shows full roster of 2 workers
    const inspection = f.coordinator.inspect(f.ownerMeta, f.swarm.id);
    assert.equal(inspection.roster.length, 2);
    const rosterIds = new Set(inspection.roster.map((w) => w.id));
    assert.ok(rosterIds.has(app1.worker.id));
    assert.ok(rosterIds.has(app2.worker.id));
  } finally {
    cleanup(f);
  }
});

// 5. swarm revision CAS / stale swarm revision blocks concurrent or outdated approvals
test("swarm revision CAS / stale swarm revision blocks concurrent or outdated approvals", () => {
  const f = fixture(5);
  const peer1 = { "openai/conversation_id": "cas-peer-1" };
  const peer2 = { "openai/conversation_id": "cas-peer-2" };
  try {
    const req1 = f.coordinator.createJoinRequest(peer1, f.swarm.id, "W1", "att-cas-1").request;
    const req2 = f.coordinator.createJoinRequest(peer2, f.swarm.id, "W2", "att-cas-2").request;

    // Both observe swarm revision = 1
    const initialInsp = f.coordinator.inspect(f.ownerMeta, f.swarm.id);
    assert.equal(initialInsp.swarm.revision, 1);

    // Winner approves req1 with revision 1 -> revision becomes 2
    f.coordinator.approveJoin(f.ownerMeta, f.swarm.id, req1.id, 1, 1);

    // Competitor attempting to approve req2 with stale revision 1 must fail with CAS_DRIFT
    assert.throws(
      () => f.coordinator.approveJoin(f.ownerMeta, f.swarm.id, req2.id, 1, 1),
      (err: unknown) => err instanceof ChatSwarmError && err.code === "CAS_DRIFT",
    );

    // After fetching fresh revision = 2, approval of req2 succeeds -> revision becomes 3
    const freshInsp = f.coordinator.inspect(f.ownerMeta, f.swarm.id);
    assert.equal(freshInsp.swarm.revision, 2);
    const app2 = f.coordinator.approveJoin(f.ownerMeta, f.swarm.id, req2.id, 1, 2);
    assert.equal(app2.request.status, "APPROVED");

    const finalInsp = f.coordinator.inspect(f.ownerMeta, f.swarm.id);
    assert.equal(finalInsp.swarm.revision, 3);
  } finally {
    cleanup(f);
  }
});

// 6. concurrent approvals strictly obey workerLimit without overflow
test("concurrent approvals strictly obey workerLimit without overflow", () => {
  const f = fixture(1); // workerLimit is 1!
  const peer1 = { "openai/conversation_id": "limit-peer-1" };
  const peer2 = { "openai/conversation_id": "limit-peer-2" };
  try {
    const req1 = f.coordinator.createJoinRequest(peer1, f.swarm.id, "W1", "att-limit-1").request;
    const req2 = f.coordinator.createJoinRequest(peer2, f.swarm.id, "W2", "att-limit-2").request;

    // First approval takes the only slot
    f.coordinator.approveJoin(f.ownerMeta, f.swarm.id, req1.id, 1, 1);

    // Second approval fails with CAPACITY_FULL even with up-to-date revision
    assert.throws(
      () => f.coordinator.approveJoin(f.ownerMeta, f.swarm.id, req2.id, 1, 2),
      (err: unknown) => err instanceof ChatSwarmError && err.code === "CAPACITY_FULL",
    );

    const inspection = f.coordinator.inspect(f.ownerMeta, f.swarm.id);
    assert.equal(inspection.roster.length, 1);
  } finally {
    cleanup(f);
  }
});

// 7. caller fingerprint substitution / spoofed sessionIdentityFingerprint cannot hijack worker binding or reuse
test("caller fingerprint substitution / spoofed sessionIdentityFingerprint cannot hijack worker binding or reuse", () => {
  const f = fixture(5);
  const legitimatePeer = { "openai/conversation_id": "legit-peer-99" };
  const legitimateFingerprint = (f.coordinator as any).identity(legitimatePeer).fingerprint;

  try {
    // A legacy or attacker worker joins with an invite and sets sessionIdentityFingerprint equal to legitimatePeer's fingerprint
    // BUT carrierConversationFingerprint belongs to attacker-session
    const attackerMeta = { "openai/conversation_id": "attacker-session" };
    const attackerWorker = f.coordinator.joinWorker(attackerMeta, f.swarm.id, {
      label: "Attacker-Worker",
      runtimeKind: "mcp_peer",
      sessionIdentityFingerprint: legitimateFingerprint, // Spoofed evidence!
    });

    // Verify attackerWorker is in DB
    assert.equal(attackerWorker.sessionIdentityFingerprint, legitimateFingerprint);

    // Legitimate peer checks peer_status -> MUST NOT be BOUND to attackerWorker!
    const legitStatus = f.coordinator.peerStatus(legitimatePeer, f.swarm.id);
    assert.equal(legitStatus.state, "UNBOUND");
    assert.equal(legitStatus.boundWorker, undefined);

    // Legitimate peer creates a join request
    const req = f.coordinator.createJoinRequest(legitimatePeer, f.swarm.id, "Legit-Worker", "att-legit-1").request;

    // Owner approves legitimate peer's join request -> MUST NOT reuse attackerWorker! Must create a distinct worker!
    const app = f.coordinator.approveJoin(f.ownerMeta, f.swarm.id, req.id, 1, 1);
    assert.notEqual(app.worker.id, attackerWorker.id);
    assert.equal(app.worker.carrierConversationFingerprint, legitimateFingerprint);

    // Now legitimate peer checks status -> BOUND to the new worker
    const legitStatus2 = f.coordinator.peerStatus(legitimatePeer, f.swarm.id);
    assert.equal(legitStatus2.state, "BOUND");
    assert.equal(legitStatus2.boundWorker?.workerId, app.worker.id);
  } finally {
    cleanup(f);
  }
});

// 8. expired request not counted in pending roster or per-peer pending limit and recovers exhaustion
test("expired request not counted in pending roster or per-peer pending limit and recovers exhaustion", () => {
  const f = fixture(5);
  const peerMeta = { "openai/conversation_id": "peer-expiry-1" };
  const peerFp = (f.coordinator as any).identity(peerMeta).fingerprint;

  try {
    // 1. Manually insert 10 expired requests for this peer directly into DB
    const pastTime = new Date(Date.now() - 3600 * 1000).toISOString();
    const olderTime = new Date(Date.now() - 7200 * 1000).toISOString();

    for (let i = 0; i < 10; i++) {
      (f.store as any).sqlite.prepare(`
        insert into chat_swarm_join_requests (
          id, swarm_id, attempt_key, request_hash, requester_fingerprint,
          label, version, status, approved_worker_id, requested_at, expires_at, approved_at
        ) values (?, ?, ?, 'hash', ?, 'Expired-W', 1, 'PENDING', null, ?, ?, null)
      `).run(`expired_req_${i}`, f.swarm.id, `att-exp-${i}`, peerFp, olderTime, pastTime);
    }

    // 2. inspect MUST NOT list expired requests in pendingRequests
    const inspection = f.coordinator.inspect(f.ownerMeta, f.swarm.id);
    assert.equal(inspection.pendingRequests.length, 0);

    // 3. peer_status MUST NOT show expired request as pending
    const status = f.coordinator.peerStatus(peerMeta, f.swarm.id);
    assert.equal(status.state, "UNBOUND");
    assert.equal(status.pendingRequest, undefined);

    // 4. Peer can still create a new request! The 10 expired requests do not block the peer from creating requests!
    const newReq = f.coordinator.createJoinRequest(peerMeta, f.swarm.id, "Fresh-W", "att-fresh-1");
    assert.equal(newReq.created, true);
    assert.equal(newReq.request.status, "PENDING");

    // 5. inspect now shows exactly the 1 fresh pending request
    const inspection2 = f.coordinator.inspect(f.ownerMeta, f.swarm.id);
    assert.equal(inspection2.pendingRequests.length, 1);
    assert.equal(inspection2.pendingRequests[0]!.requestId, newReq.request.id);

    // 6. Attempting to approve an expired request fails with EXPIRED
    assert.throws(
      () => f.coordinator.approveJoin(f.ownerMeta, f.swarm.id, "expired_req_0", 1, 1),
      (err: unknown) => err instanceof ChatSwarmError && err.code === "EXPIRED",
    );
  } finally {
    cleanup(f);
  }
});

// 9. restart persistence preserves join requests and revision state across store restart
test("restart persistence preserves join requests and revision state across store restart", () => {
  const f = fixture(5);
  const peerMeta = { "openai/conversation_id": "peer-restart-1" };
  try {
    const req = f.coordinator.createJoinRequest(peerMeta, f.swarm.id, "Restart-Worker", "att-restart-1").request;
    assert.equal(req.version, 1);

    // Close store and reopen with new instance
    f.store.close();
    const reopenedStore = new ChatSwarmStore(f.root);
    const reopenedCoordinator = new ChatSwarmCoordinator(reopenedStore);

    // Verify swarm revision is preserved
    const swarm = reopenedStore.getSwarm(f.swarm.id)!;
    assert.equal(swarm.revision, 1);

    // Verify join request is preserved
    const loadedReq = reopenedStore.getJoinRequest(req.id)!;
    assert.equal(loadedReq.id, req.id);
    assert.equal(loadedReq.status, "PENDING");
    assert.equal(loadedReq.label, "Restart-Worker");

    // Approve join via reopened coordinator works seamlessly
    const app = reopenedCoordinator.approveJoin(f.ownerMeta, f.swarm.id, req.id, 1, 1);
    assert.equal(app.request.status, "APPROVED");

    // Verify updated revision is preserved
    const updatedSwarm = reopenedStore.getSwarm(f.swarm.id)!;
    assert.equal(updatedSwarm.revision, 2);

    reopenedStore.close();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// 10. approve commit followed by response loss allows identical replay and safe readback
test("approve commit followed by response loss allows identical replay and safe readback", () => {
  const f = fixture(5);
  const peerMeta = { "openai/conversation_id": "peer-readback-1" };
  try {
    const req = f.coordinator.createJoinRequest(peerMeta, f.swarm.id, "Readback-W", "att-readback-1").request;

    // Approve succeeds
    const app1 = f.coordinator.approveJoin(f.ownerMeta, f.swarm.id, req.id, 1, 1);
    assert.equal(app1.request.status, "APPROVED");
    const workerId = app1.worker.id;

    // Simulated lost response: client replays approveJoin with same requestId
    const app1Replay = f.coordinator.approveJoin(f.ownerMeta, f.swarm.id, req.id, 1, 2);
    assert.equal(app1Replay.request.status, "APPROVED");
    assert.equal(app1Replay.worker.id, workerId);

    // Swarm revision was not double-incremented on idempotent replay
    const insp = f.coordinator.inspect(f.ownerMeta, f.swarm.id);
    assert.equal(insp.swarm.revision, 2);

    // Worker reads back bound state
    const peerStatus = f.coordinator.peerStatus(peerMeta, f.swarm.id);
    assert.equal(peerStatus.state, "BOUND");
    assert.equal(peerStatus.boundWorker?.workerId, workerId);
  } finally {
    cleanup(f);
  }
});

// 11. readonly peer_status and inspect do not mutate database state or bump versions
test("readonly peer_status and inspect do not mutate database state or bump versions", () => {
  const f = fixture(5);
  const peerMeta = { "openai/conversation_id": "peer-readonly-1" };
  try {
    f.coordinator.createJoinRequest(peerMeta, f.swarm.id, "Readonly-W", "att-ro-1");

    const getSwarmUpdatedAt = () => (f.store as any).sqlite.prepare("select updated_at, revision from chat_swarms where id = ?").get(f.swarm.id) as { updated_at: string; revision: number };
    const getRequestsCount = () => (f.store as any).sqlite.prepare("select count(*) as cnt from chat_swarm_join_requests").get().cnt;

    const beforeSwarm = getSwarmUpdatedAt();
    const beforeCount = getRequestsCount();

    // Call readonly methods repeatedly
    for (let i = 0; i < 5; i++) {
      f.coordinator.peerStatus(peerMeta, f.swarm.id);
      f.coordinator.inspect(f.ownerMeta, f.swarm.id);
    }

    const afterSwarm = getSwarmUpdatedAt();
    const afterCount = getRequestsCount();

    assert.equal(afterSwarm.revision, beforeSwarm.revision);
    assert.equal(afterSwarm.updated_at, beforeSwarm.updated_at);
    assert.equal(afterCount, beforeCount);
  } finally {
    cleanup(f);
  }
});

// 12. lifecycle drain admission permits peer_status and inspect but blocks join_request and approve_join
test("lifecycle drain admission permits peer_status and inspect but blocks join_request and approve_join", () => {
  let mode: "normal" | "drain" = "normal";
  const f = fixture();
  const lifecycle = new ChatSwarmLifecycle({
    stateDir: f.root,
    enabled: true,
    mode: () => mode,
  });

  try {
    assert.doesNotThrow(() => lifecycle.admit("peer_status"));
    assert.doesNotThrow(() => lifecycle.admit("inspect"));
    assert.doesNotThrow(() => lifecycle.admit("join_request"));
    assert.doesNotThrow(() => lifecycle.admit("approve_join"));

    mode = "drain";
    assert.doesNotThrow(() => lifecycle.admit("peer_status"));
    assert.doesNotThrow(() => lifecycle.admit("inspect"));
    assert.throws(
      () => lifecycle.admit("join_request"),
      (err: unknown) => err instanceof ChatSwarmError && err.code === "INVALID_STATE",
    );
    assert.throws(
      () => lifecycle.admit("approve_join"),
      (err: unknown) => err instanceof ChatSwarmError && err.code === "INVALID_STATE",
    );
  } finally {
    cleanup(f);
  }
});

// 13. end-to-end MCP protocol tools execution for peer admission and typed error structure
test("end-to-end MCP protocol tools execution for peer admission and typed error structure", async () => {
  const f = fixture();
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerChatSwarmTools(server, {
    coordinator: f.coordinator,
    config: {
      chatSwarmEnabled: true,
      chatSwarmMaxWorkers: 2,
      chatSwarmQueueLimit: 10,
      chatSwarmResultMaxChars: 1000,
      chatSwarmInviteTtlSeconds: 900,
    },
    admit: () => {},
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-test-client", version: "1" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  try {
    // 1. Peer status via MCP tool call
    const statusRes = await client.callTool({
      name: "chat_swarm_peer_status",
      arguments: { swarmId: f.swarm.id },
      _meta: { "openai/conversation_id": "worker-mcp-chat" },
    });
    const statusData = (statusRes.structuredContent ?? JSON.parse(((statusRes as any).content[0] as { text: string }).text)) as Record<string, any>;
    assert.equal(statusData.state, "UNBOUND");
    assert.equal(statusData.identity.status, "RESOLVED");

    // 2. Join request via MCP tool call
    const reqRes = await client.callTool({
      name: "chat_swarm_join_request",
      arguments: {
        swarmId: f.swarm.id,
        label: "Worker-MCP",
        attemptKey: "att-mcp-1",
      },
      _meta: { "openai/conversation_id": "worker-mcp-chat" },
    });
    const reqData = (reqRes.structuredContent ?? JSON.parse(((reqRes as any).content[0] as { text: string }).text)) as Record<string, any>;
    assert.equal(reqData.created, true);
    assert.equal(reqData.request.status, "PENDING");
    const requestId = reqData.request.id;

    // 3. Inspect via MCP tool call (by owner)
    const inspectRes = await client.callTool({
      name: "chat_swarm_inspect",
      arguments: { swarmId: f.swarm.id },
      _meta: f.ownerMeta,
    });
    const inspectData = (inspectRes.structuredContent ?? JSON.parse(((inspectRes as any).content[0] as { text: string }).text)) as Record<string, any>;
    assert.equal(inspectData.pendingRequests.length, 1);
    assert.equal(inspectData.pendingRequests[0].requestId, requestId);
    assert.equal(inspectData.swarm.revision, 1);

    // 4. Approve join via MCP tool call (by owner)
    const approveRes = await client.callTool({
      name: "chat_swarm_approve_join",
      arguments: {
        swarmId: f.swarm.id,
        requestId,
        expectedRequestVersion: 1,
        expectedSwarmVersion: 1,
      },
      _meta: f.ownerMeta,
    });
    const approveData = (approveRes.structuredContent ?? JSON.parse(((approveRes as any).content[0] as { text: string }).text)) as Record<string, any>;
    assert.equal(approveData.request.status, "APPROVED");
    const workerId = approveData.worker.id;
    assert.ok(workerId);

    // 5. Worker checks peer_status again and sees BOUND
    const statusRes2 = await client.callTool({
      name: "chat_swarm_peer_status",
      arguments: { swarmId: f.swarm.id },
      _meta: { "openai/conversation_id": "worker-mcp-chat" },
    });
    const statusData2 = (statusRes2.structuredContent ?? JSON.parse(((statusRes2 as any).content[0] as { text: string }).text)) as Record<string, any>;
    assert.equal(statusData2.state, "BOUND");
    assert.equal(statusData2.boundWorker.workerId, workerId);

    // 6. Test typed error structure on unauthorized call
    const failRes = await client.callTool({
      name: "chat_swarm_approve_join",
      arguments: {
        swarmId: f.swarm.id,
        requestId,
        expectedRequestVersion: 1,
        expectedSwarmVersion: 2,
      },
      _meta: { "openai/conversation_id": "unauthorized-peer" },
    });
    assert.equal(failRes.isError, true);
    const failContent = (failRes.structuredContent ?? JSON.parse(((failRes as any).content[0] as { text: string }).text)) as Record<string, any>;
    assert.equal(failContent.error.code, "OWNERSHIP_CONFLICT");
    assert.equal(failContent.error.layer, "coordinator");
    assert.equal(failContent.error.stage, "admission_denied");
    assert.equal(failContent.error.operation, "approve_join");

    // 7. Test identity malformed tool error structure
    const malformedRes = await client.callTool({
      name: "chat_swarm_join_request",
      arguments: {
        swarmId: f.swarm.id,
        label: "Worker-Bad",
        attemptKey: "att-bad-1",
      },
      _meta: { "openai/session": "   " },
    });
    assert.equal(malformedRes.isError, true);
    const malformedContent = (malformedRes.structuredContent ?? JSON.parse(((malformedRes as any).content[0] as { text: string }).text)) as Record<string, any>;
    assert.equal(malformedContent.error.code, "IDENTITY_MALFORMED");
    assert.equal(malformedContent.error.layer, "HOST");
  } finally {
    await client.close();
    await server.close();
    cleanup(f);
  }
});
