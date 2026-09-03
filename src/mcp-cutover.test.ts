import assert from "node:assert/strict";
import test from "node:test";
import { McpSessionRegistry } from "./mcp-sessions.js";
import {
  compareServerIdentity,
  createMcpCutoverCoordinator,
} from "./mcp-cutover.js";

interface FakeTransport {
  closeCalls: number;
  close(): Promise<void>;
}

function createTransport(closeError?: Error): FakeTransport {
  return {
    closeCalls: 0,
    async close() {
      this.closeCalls += 1;
      if (closeError) throw closeError;
    },
  };
}

const server = {
  serverInstanceId: "instance-a",
  sourceCommit: "1".repeat(40),
  buildId: "devspace-1.0.7-1f626813",
};

test("coordinator drains many simultaneous transports and reports counts", async () => {
  const nowref = { value: 0 };
  const transports = new McpSessionRegistry<FakeTransport>({ now: () => nowref.value });
  for (let i = 0; i < 20; i++) {
    transports.register(`session-${i}`, createTransport());
  }
  const coordinator = createMcpCutoverCoordinator({ transports, server });
  assert.equal(coordinator.isDraining(), false);

  const result = await coordinator.beginDrain();
  assert.equal(result.status, "drained");
  assert.equal(result.transportsDrained, 20);
  assert.equal(result.closeFailures, 0);
  assert.equal(result.observation.count, 0);
  assert.equal(result.oldServer.serverInstanceId, "instance-a");
  assert.equal(coordinator.isDraining(), true);

  const again = await coordinator.beginDrain();
  assert.equal(again.status, "already_draining");
  assert.equal(again.transportsDrained, 0);
});

test("coordinator counts close failures without losing the drain result", async () => {
  const transports = new McpSessionRegistry<FakeTransport>({});
  transports.register("ok", createTransport());
  transports.register("bad", createTransport(new Error("close failed")));
  const coordinator = createMcpCutoverCoordinator({ transports, server });
  const result = await coordinator.beginDrain();
  assert.equal(result.transportsDrained, 2);
  assert.equal(result.closeFailures, 1);
});

test("fresh transport can bind to the new server instance after cutover (reconnect)", async () => {
  const transports = new McpSessionRegistry<FakeTransport>({});
  transports.register("old", createTransport());
  const coordinator = createMcpCutoverCoordinator({ transports, server });
  await coordinator.beginDrain();
  coordinator.finishDrain();

  const next = new McpSessionRegistry<FakeTransport>({});
  next.register("new", createTransport());
  assert.equal(next.size, 1);
  assert.equal(next.get("new")?.closeCalls, 0);
});

test("active durable work remains queryable after transport replacement", async () => {
  const transports = new McpSessionRegistry<FakeTransport>({});
  const durable = new Map<string, string>();
  durable.set("agent-1", "running");
  durable.set("agent-2", "running");
  transports.register("transport-1", createTransport());
  const coordinator = createMcpCutoverCoordinator({ transports, server });
  await coordinator.beginDrain();
  assert.equal(transports.size, 0);
  assert.equal(durable.size, 2);
  assert.equal(durable.get("agent-1"), "running");
});

test("compareServerIdentity detects mismatches for restart reconciliation", () => {
  const expected = server;
  assert.deepEqual(
    compareServerIdentity({ expected, actual: server }),
    { match: true, mismatches: [] },
  );
  assert.deepEqual(
    compareServerIdentity({
      expected,
      actual: { ...server, serverInstanceId: "instance-b" },
    }),
    { match: false, mismatches: ["serverInstanceId"] },
  );
  assert.deepEqual(
    compareServerIdentity({
      expected,
      actual: { ...server, sourceCommit: "2".repeat(40), buildId: "other" },
    }),
    { match: false, mismatches: ["sourceCommit", "buildId"] },
  );
});