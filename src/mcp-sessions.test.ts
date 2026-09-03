import assert from "node:assert/strict";
import test from "node:test";
import { McpSessionRegistry } from "./mcp-sessions.js";

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

let now = 0;
const registry = new McpSessionRegistry<FakeTransport>({ now: () => now });
const staleTransport = createTransport();
const activeTransport = createTransport();

registry.register("stale", staleTransport);
now = 1_000;
registry.register("active", activeTransport);
now = 1_500;
assert.equal(registry.get("active"), activeTransport);
now = 2_000;

const idleResults = await registry.closeIdle(1_500);
assert.deepEqual(idleResults, [{ sessionId: "stale" }]);
assert.equal(staleTransport.closeCalls, 1);
assert.equal(activeTransport.closeCalls, 0);
assert.equal(registry.size, 1);
assert.equal(registry.get("stale"), undefined);
assert.equal(registry.get("active"), activeTransport);

const closeError = new Error("close failed");
const failingTransport = createTransport(closeError);
registry.register("failing", failingTransport);
now = 10_000;

const failingResults = await registry.closeIdle(1);
assert.equal(failingResults.length, 2);
assert.deepEqual(failingResults.map((result) => result.sessionId).sort(), ["active", "failing"]);
assert.equal(failingResults.find((result) => result.sessionId === "failing")?.error, closeError);
assert.equal(failingTransport.closeCalls, 1);
assert.equal(registry.size, 0);

const first = createTransport();
const second = createTransport();
registry.register("first", first);
registry.register("second", second);
registry.remove("first");

const shutdownResults = await registry.closeAll();
assert.deepEqual(shutdownResults, [{ sessionId: "second" }]);
assert.equal(first.closeCalls, 0);
assert.equal(second.closeCalls, 1);
assert.equal(registry.size, 0);

let finishDelayedClose: (() => void) | undefined;
let delayedCloseResolved = false;
const delayedTransport: FakeTransport = {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishDelayedClose = resolve;
    });
  },
};
registry.register("delayed", delayedTransport);
const delayedClose = registry.closeAll();
void delayedClose.then(() => {
  delayedCloseResolved = true;
});

await Promise.resolve();
assert.equal(delayedCloseResolved, false);
assert.equal(delayedTransport.closeCalls, 1);
finishDelayedClose?.();
await delayedClose;
assert.equal(delayedCloseResolved, true);
assert.equal(registry.size, 0);
test("observe exposes transport count, age buckets, and generation without session ids", () => {
  const nowref = { value: 0 };
  const gen = new McpSessionRegistry<FakeTransport>({
    now: () => nowref.value,
    generation: "gen-1",
  });
  gen.register("secret-session-id", createTransport());
  nowref.value =10 * 60 * 1_000 + 1;
  gen.register("another-secret", createTransport());
  const obs = gen.observe();
  assert.equal(obs.count, 2);
  assert.equal(obs.serverGeneration, "gen-1");
  assert.equal(obs.oldestAgeMs, 0);
  const byAge = Object.fromEntries(obs.byAgeBucket.map((b) => [b.bucket,b.count]));
  assert.equal(byAge["1m-15m"], 1);
  assert.equal(byAge["<1m"], 1);
  const serialized = JSON.stringify(obs);

  assert.ok(!serialized.includes("secret-session-id"));
  assert.ok(!serialized.includes("another-secret"));
});

test("closeAll leaves durable session state in separate registries intact", async () => {
  const nowref = { value: 0 };
  const transports = new McpSessionRegistry<FakeTransport>({ now: () => nowref.value });
  const durable = new Map<string, string>();
  durable.set("durable-agent-1", "still-running");
  transports.register("transport-1", createTransport());
  const results = await transports.closeAll();

  assert.equal(transports.size, 0);
  assert.equal(results.length, 1);
  assert.equal(durable.size, 1);
});
