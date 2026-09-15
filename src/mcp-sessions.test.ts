import assert from "node:assert/strict";
import { evaluateSessionConvergence, type SessionGenerationSnapshot } from "./deployment-convergence.js";
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

// Snapshot and server registration tests
const snapshotRegistry = new McpSessionRegistry<FakeTransport>();
const t1 = createTransport();
const initialSnapshot = {
  serverInstanceId: "srv-1",
  sourceCommit: "commit-1",
  buildId: "build-1",
  capabilityManifestSha256: "man-1",
  catalogGeneration: "gen-1",
  sessionInitializedAt: new Date().toISOString(),
};
snapshotRegistry.register("sess-1", t1, { snapshot: initialSnapshot, server: { id: "mock-server" } });
assert.deepEqual(snapshotRegistry.getSnapshot("sess-1"), initialSnapshot);
assert.deepEqual(snapshotRegistry.getServer("sess-1"), { id: "mock-server" });
assert.equal(snapshotRegistry.getAllServers().length, 1);

snapshotRegistry.setSnapshot("sess-1", { ...initialSnapshot, catalogGeneration: "gen-2" });
assert.equal(snapshotRegistry.getSnapshot("sess-1")?.catalogGeneration, "gen-2");

// A listChanged notification is only a hint: any active session's subsequent
// tools/list request is the acknowledgement that advances that exact snapshot.
const currentSnapshot: SessionGenerationSnapshot = {
  ...initialSnapshot,
  capabilityManifestSha256: "man-2",
  catalogGeneration: "gen-3",
};
const acknowledgementRegistry = new McpSessionRegistry<FakeTransport>();
acknowledgementRegistry.register("active", createTransport(), { snapshot: initialSnapshot });
acknowledgementRegistry.register("another-active", createTransport(), { snapshot: initialSnapshot });
const staleServer = { ...currentSnapshot, cutoverMode: "normal", reconciliationRequired: false };
assert.equal(evaluateSessionConvergence(acknowledgementRegistry.getSnapshot("active")!, staleServer).state, "STALE_CAPABILITY_MANIFEST");
// Exercise the actual MCP request sequence: notification is only a hint, and
// the client's subsequent tools/list request is the authoritative acknowledgement.
const requestSequence = [
  { method: "notifications/tools/list_changed" },
  { method: "tools/list" },
] as const;
for (const request of requestSequence) {
  if (request.method === "tools/list") {
    assert.equal(acknowledgementRegistry.acknowledgeToolsList("active", currentSnapshot), true);
  }
}
assert.equal(acknowledgementRegistry.getSnapshot("active")?.catalogGeneration, "gen-3");
const currentServer = { ...currentSnapshot, cutoverMode: "normal", reconciliationRequired: false };
assert.equal(evaluateSessionConvergence(acknowledgementRegistry.getSnapshot("active")!, currentServer).state, "CURRENT");
assert.equal(acknowledgementRegistry.acknowledgeToolsList("another-active", currentSnapshot), true);
assert.equal(acknowledgementRegistry.acknowledgeToolsList("missing", currentSnapshot), false);
const reconnectServer = { ...currentServer, serverInstanceId: "srv-new", sourceCommit: "commit-new", buildId: "build-new", freshness: "fresh-new" };
assert.equal(acknowledgementRegistry.acknowledgeToolsList("another-active", reconnectServer), false);
assert.equal(evaluateSessionConvergence(acknowledgementRegistry.getSnapshot("another-active")!, reconnectServer).state, "STALE_SERVER");
assert.equal(evaluateSessionConvergence(undefined, reconnectServer).state, "RECONNECT_REQUIRED");

// A tools/list refresh may rebind an existing active transport whose snapshot
// was lost during a server restart, but it must not create or revive sessions.
const rebindRegistry = new McpSessionRegistry<FakeTransport>();
rebindRegistry.register("active-without-snapshot", createTransport());
assert.equal(rebindRegistry.acknowledgeToolsList("active-without-snapshot", currentSnapshot), true);
assert.deepEqual(rebindRegistry.getSnapshot("active-without-snapshot"), currentSnapshot);
assert.equal(evaluateSessionConvergence(rebindRegistry.getSnapshot("active-without-snapshot"), currentServer).state, "CURRENT");
rebindRegistry.register("removed-before-refresh", createTransport());
assert.equal(rebindRegistry.remove("removed-before-refresh"), true);
assert.equal(rebindRegistry.acknowledgeToolsList("removed-before-refresh", currentSnapshot), false);
const closingRegistry = new McpSessionRegistry<FakeTransport>();
closingRegistry.register("closing", createTransport());
assert.equal(closingRegistry.beginRequest("closing"), true);
void closingRegistry.closeAll();
assert.equal(closingRegistry.acknowledgeToolsList("closing", currentSnapshot), false);
