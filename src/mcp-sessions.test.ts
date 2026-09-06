import assert from "node:assert/strict";
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

assert.deepEqual(registry.metrics(), {
  activeSessions: 2,
  oldestAgeMs: 2_000,
});
assert.equal(JSON.stringify(registry.metrics()).includes("stale"), false);

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

const inFlightRegistry = new McpSessionRegistry<FakeTransport>({ now: () => inFlightNow });
const inFlightTransport = createTransport();
const idleTransport = createTransport();
let inFlightNow = 0;
inFlightRegistry.register("idle", idleTransport);
inFlightNow = 1_000;
inFlightRegistry.register("in-flight", inFlightTransport);
inFlightNow = 2_000;
assert.equal(inFlightRegistry.beginRequest("in-flight"), true);
assert.equal(inFlightRegistry.beginRequest("missing"), false);
assert.deepEqual(inFlightRegistry.inFlightStats(), {
  inFlightRequestCount: 1,
  sessionsWithInFlight: 1,
});

const skipIdleResults = await inFlightRegistry.closeIdle(1_500);
assert.deepEqual(skipIdleResults, [{ sessionId: "idle" }]);
assert.equal(inFlightTransport.closeCalls, 0);
assert.equal(inFlightRegistry.size, 1);
assert.equal(inFlightRegistry.get("in-flight"), inFlightTransport);

const closeAllWithInflight = inFlightRegistry.closeAll();
const pendingResults = await closeAllWithInflight;
assert.deepEqual(pendingResults, []);
assert.equal(inFlightTransport.closeCalls, 0);
assert.equal(inFlightRegistry.size, 1);

const endCloseResult = await inFlightRegistry.endRequest("in-flight");
assert.equal(endCloseResult?.sessionId, "in-flight");
assert.equal(inFlightTransport.closeCalls, 1);
assert.equal(inFlightRegistry.size, 0);
assert.deepEqual(inFlightRegistry.inFlightStats(), {
  inFlightRequestCount: 0,
  sessionsWithInFlight: 0,
});

const unboundedEnd = await inFlightRegistry.endRequest("missing");
assert.equal(unboundedEnd, undefined);

let boundedNow = 0;
const boundedRegistry = new McpSessionRegistry<FakeTransport>({
  now: () => boundedNow,
  maxSessions: 3,
});
const oldest = createTransport();
const middle = createTransport();
const newest = createTransport();
boundedRegistry.register("oldest", oldest);
boundedNow = 10;
boundedRegistry.register("middle", middle);
boundedNow = 20;
boundedRegistry.register("newest", newest);
boundedNow = 30;
boundedRegistry.register("overflow", createTransport());
assert.equal(boundedRegistry.size, 3);
assert.equal(boundedRegistry.get("oldest"), undefined);
assert.equal(oldest.closeCalls, 1);
assert.equal(boundedRegistry.get("middle"), middle);

boundedNow = 40;
boundedRegistry.beginRequest("middle");
boundedNow = 50;
boundedRegistry.register("overflow-two", createTransport());
assert.equal(boundedRegistry.get("newest"), undefined);
assert.equal(boundedRegistry.get("middle"), middle);

await boundedRegistry.endRequest("middle");
assert.equal(boundedRegistry.size, 3);
assert.equal(boundedRegistry.get("middle"), middle);
