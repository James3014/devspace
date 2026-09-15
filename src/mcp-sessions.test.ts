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
  highWaterActiveSessions: 2,
  registrations: 2,
  reusedRequests: 1,
  idleCloses: 0,
  capacityEvictions: 0,
  capacityRejections: 0,
  closeErrors: 0,
  disposalCallbackErrors: 0,
  inFlightRequestCount: 0,
  sessionsWithInFlight: 0,
  sessionsPendingClose: 0,
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
  idleTimeoutMs: 100,
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
const boundedOverflow = createTransport();
assert.deepEqual(boundedRegistry.register("overflow", boundedOverflow), {
  accepted: false,
  reason: "capacity_exhausted",
});
assert.equal(boundedRegistry.size, 3);
assert.equal(boundedRegistry.get("oldest"), oldest);
assert.equal(oldest.closeCalls, 0);
assert.equal(boundedRegistry.get("middle"), middle);

boundedNow = 40;
boundedRegistry.beginRequest("middle");
boundedNow = 50;
const boundedOverflowTwo = createTransport();
assert.deepEqual(boundedRegistry.register("overflow-two", boundedOverflowTwo), {
  accepted: false,
  reason: "capacity_exhausted",
});
assert.equal(boundedRegistry.get("oldest"), oldest);
assert.equal(boundedRegistry.get("newest"), newest);
assert.equal(boundedRegistry.get("middle"), middle);

await boundedRegistry.endRequest("middle");
assert.equal(boundedRegistry.size, 3);
assert.equal(boundedRegistry.get("middle"), middle);

boundedNow = 200;
const boundedAccepted = createTransport();
assert.deepEqual(boundedRegistry.register("accepted-after-idle", boundedAccepted), {
  accepted: true,
  evicted: 1,
});
assert.equal(boundedRegistry.get("oldest"), undefined);
assert.equal(oldest.closeCalls, 1);
assert.equal(boundedRegistry.get("newest"), newest);
assert.equal(boundedRegistry.get("accepted-after-idle"), boundedAccepted);

const pendingRegistry = new McpSessionRegistry<FakeTransport>({
  now: () => pendingNow,
  maxSessions: 2,
  idleTimeoutMs: 100,
});
let pendingNow = 0;
const pendingTransport = createTransport();
pendingRegistry.register("pending", pendingTransport);
assert.equal(pendingRegistry.beginRequest("pending"), true);
await pendingRegistry.closeAll();
const pendingReplacement = createTransport();
pendingRegistry.register("replacement", pendingReplacement);
pendingNow = 200;
const pendingAccepted = createTransport();
assert.deepEqual(pendingRegistry.register("accepted-with-pending", pendingAccepted), {
  accepted: true,
  evicted: 1,
});
assert.equal(pendingRegistry.get("pending"), pendingTransport);
assert.equal(pendingRegistry.get("replacement"), undefined);
assert.equal(pendingReplacement.closeCalls, 1);
await pendingRegistry.endRequest("pending");

let lifecycleNow = 0;
const lifecycleRegistry = new McpSessionRegistry<FakeTransport>({
  now: () => lifecycleNow,
  maxSessions: 2,
  idleTimeoutMs: 1_000,
});
const lifecycleFirst = createTransport();
const lifecycleSecond = createTransport();
lifecycleRegistry.register("lifecycle-first", lifecycleFirst);
lifecycleNow = 100;
lifecycleRegistry.register("lifecycle-second", lifecycleSecond);
assert.equal(lifecycleRegistry.get("lifecycle-second"), lifecycleSecond);
lifecycleNow = 2_000;
assert.equal(lifecycleRegistry.beginRequest("lifecycle-second"), true);
const lifecycleThird = createTransport();
const lifecycleRegistration = lifecycleRegistry.register("lifecycle-third", lifecycleThird);
assert.deepEqual(lifecycleRegistration, { accepted: true, evicted: 1 });
assert.equal(lifecycleRegistry.get("lifecycle-first"), undefined);
assert.equal(lifecycleFirst.closeCalls, 1);
assert.equal(lifecycleRegistry.size, 2);

assert.equal(lifecycleRegistry.beginRequest("lifecycle-third"), true);
const rejectedTransport = createTransport();
const rejectedRegistration = lifecycleRegistry.register("lifecycle-rejected", rejectedTransport);
assert.deepEqual(rejectedRegistration, { accepted: false, reason: "capacity_exhausted" });
assert.equal(lifecycleRegistry.size, 2);
assert.equal(lifecycleRegistry.get("lifecycle-rejected"), undefined);
await Promise.resolve();
assert.equal(rejectedTransport.closeCalls, 1);

lifecycleNow = 4_000;
const protectedIdleResults = await lifecycleRegistry.closeIdle(1_000);
assert.deepEqual(protectedIdleResults, []);
assert.equal(lifecycleSecond.closeCalls, 0);
assert.equal(lifecycleThird.closeCalls, 0);
assert.deepEqual(lifecycleRegistry.metrics(), {
  activeSessions: 2,
  oldestAgeMs: 2_000,
  highWaterActiveSessions: 2,
  registrations: 3,
  reusedRequests: 1,
  idleCloses: 0,
  capacityEvictions: 1,
  capacityRejections: 1,
  closeErrors: 0,
  disposalCallbackErrors: 0,
  inFlightRequestCount: 2,
  sessionsWithInFlight: 2,
  sessionsPendingClose: 0,
  configuredMaxSessions: 2,
  configuredIdleTimeoutMs: 1_000,
});
assert.equal(JSON.stringify(lifecycleRegistry.metrics()).includes("lifecycle"), false);

const duplicateRegistry = new McpSessionRegistry<FakeTransport>();
const residentTransport = createTransport();
const duplicateTransport = createTransport();
assert.deepEqual(duplicateRegistry.register("resident", residentTransport), { accepted: true, evicted: 0 });
assert.deepEqual(duplicateRegistry.register("resident", duplicateTransport), {
  accepted: false,
  reason: "duplicate_session",
});
await Promise.resolve();
assert.equal(duplicateTransport.closeCalls, 1);
assert.equal(duplicateRegistry.get("resident"), residentTransport);
assert.equal(duplicateRegistry.size, 1);
assert.equal(duplicateRegistry.metrics().closeErrors, 0);

const failingDuplicateTransport = createTransport(new Error("duplicate close failed"));
assert.deepEqual(duplicateRegistry.register("resident", failingDuplicateTransport), {
  accepted: false,
  reason: "duplicate_session",
});
await Promise.resolve();
await Promise.resolve();
assert.equal(failingDuplicateTransport.closeCalls, 1);
assert.equal(duplicateRegistry.get("resident"), residentTransport);
assert.equal(duplicateRegistry.metrics().closeErrors, 1);

const raceRegistry = new McpSessionRegistry<FakeTransport>();
const raceWinner = createTransport();
const raceLoser = createTransport();
raceRegistry.register("race", raceWinner);
const loserCloseResults = await Promise.all([
  Promise.resolve().then(() => raceRegistry.remove("race", raceLoser)),
  Promise.resolve().then(() => raceRegistry.remove("race", raceLoser)),
]);
assert.deepEqual(loserCloseResults, [false, false]);
assert.equal(raceRegistry.get("race"), raceWinner);
assert.equal(raceRegistry.remove("race", raceWinner), true);

const closeErrorRegistry = new McpSessionRegistry<FakeTransport>({ now: () => lifecycleNow });
const closeErrorTransport = createTransport(new Error("close failed"));
closeErrorRegistry.register("close-error", closeErrorTransport);
lifecycleNow = 5_000;
const closeErrorResults = await closeErrorRegistry.closeIdle(1);
assert.equal(closeErrorResults.length, 1);
assert.equal(closeErrorResults[0]?.error instanceof Error, true);
assert.equal(closeErrorRegistry.size, 0);
assert.equal(closeErrorRegistry.metrics().closeErrors, 1);

let disposalNow = 0;
const disposalEvents: Array<{ sessionId: string; transport: FakeTransport; reason: string }> = [];
const disposalCarrierBindings = new Set<string>();
const disposalReboundSessions = new Set<string>();
const disposalRegistry = new McpSessionRegistry<FakeTransport>({
  now: () => disposalNow,
  maxSessions: 1,
  idleTimeoutMs: 100,
  onDispose: (sessionId, transport, reason) => {
    disposalEvents.push({ sessionId, transport, reason });
    disposalCarrierBindings.delete(sessionId);
    disposalReboundSessions.delete(sessionId);
  },
});
const capacityEvictedTransport = createTransport();
disposalRegistry.register("capacity-evicted", capacityEvictedTransport);
disposalCarrierBindings.add("capacity-evicted");
disposalReboundSessions.add("capacity-evicted");
disposalNow = 200;
disposalRegistry.register("capacity-survivor", createTransport());
await Promise.resolve();
assert.deepEqual(disposalEvents, [{
  sessionId: "capacity-evicted",
  transport: capacityEvictedTransport,
  reason: "capacity_eviction",
}]);
assert.equal(disposalCarrierBindings.has("capacity-evicted"), false);
assert.equal(disposalReboundSessions.has("capacity-evicted"), false);

const idleDisposedTransport = createTransport();
disposalRegistry.remove("capacity-survivor");
disposalRegistry.register("idle-disposed", idleDisposedTransport);
disposalCarrierBindings.add("idle-disposed");
disposalReboundSessions.add("idle-disposed");
disposalNow = 400;
await disposalRegistry.closeIdle(100);
assert.deepEqual(disposalEvents.slice(1), [{
  sessionId: "idle-disposed",
  transport: idleDisposedTransport,
  reason: "idle_timeout",
}]);
assert.equal(disposalCarrierBindings.has("idle-disposed"), false);
assert.equal(disposalReboundSessions.has("idle-disposed"), false);

const shutdownDisposedTransport = createTransport();
disposalRegistry.register("shutdown-disposed", shutdownDisposedTransport);
disposalCarrierBindings.add("shutdown-disposed");
disposalReboundSessions.add("shutdown-disposed");
await disposalRegistry.closeAll();
assert.deepEqual(disposalEvents.slice(2), [{
  sessionId: "shutdown-disposed",
  transport: shutdownDisposedTransport,
  reason: "server_shutdown",
}]);
assert.equal(disposalCarrierBindings.has("shutdown-disposed"), false);
assert.equal(disposalReboundSessions.has("shutdown-disposed"), false);

const duplicateBefore = disposalEvents.length;
disposalRegistry.register("duplicate-survivor", createTransport());
disposalRegistry.register("duplicate-survivor", createTransport());
await Promise.resolve();
assert.equal(disposalEvents.length, duplicateBefore);

const pendingDisposalEvents: string[] = [];
const pendingDisposalRegistry = new McpSessionRegistry<FakeTransport>({
  onDispose: (sessionId, _transport, reason) => pendingDisposalEvents.push(`${sessionId}:${reason}`),
});
pendingDisposalRegistry.register("pending-shutdown", createTransport());
assert.equal(pendingDisposalRegistry.beginRequest("pending-shutdown"), true);
assert.deepEqual(await pendingDisposalRegistry.closeAll(), []);
assert.deepEqual(pendingDisposalEvents, []);
await pendingDisposalRegistry.endRequest("pending-shutdown");
assert.deepEqual(pendingDisposalEvents, ["pending-shutdown:server_shutdown"]);

let throwingCapacityNow = 0;
const throwingDisposalCallback = () => {
  throw new Error("disposal callback failed");
};
const throwingCapacityRegistry = new McpSessionRegistry<FakeTransport>({
  now: () => throwingCapacityNow,
  maxSessions: 1,
  idleTimeoutMs: 100,
  onDispose: throwingDisposalCallback,
});
const throwingCapacityTransport = createTransport();
throwingCapacityRegistry.register("throwing-capacity", throwingCapacityTransport);
throwingCapacityNow = 200;
assert.deepEqual(throwingCapacityRegistry.register("capacity-survivor", createTransport()), {
  accepted: true,
  evicted: 1,
});
await Promise.resolve();
assert.equal(throwingCapacityRegistry.size, 1);
assert.equal(throwingCapacityTransport.closeCalls, 1);
const throwingCapacityMetrics = throwingCapacityRegistry.metrics();
assert.equal(throwingCapacityMetrics.disposalCallbackErrors, 1);
assert.equal(throwingCapacityMetrics.closeErrors, 0);
assert.equal(JSON.stringify(throwingCapacityMetrics).includes("throwing-capacity"), false);
assert.equal(JSON.stringify(throwingCapacityMetrics).includes("disposal callback failed"), false);

let throwingIdleNow = 0;
const throwingIdleRegistry = new McpSessionRegistry<FakeTransport>({
  now: () => throwingIdleNow,
  onDispose: throwingDisposalCallback,
});
const throwingIdleFirst = createTransport();
const throwingIdleSecond = createTransport();
throwingIdleRegistry.register("throwing-idle-first", throwingIdleFirst);
throwingIdleRegistry.register("throwing-idle-second", throwingIdleSecond);
throwingIdleNow = 200;
const throwingIdleResults = await throwingIdleRegistry.closeIdle(100);
assert.deepEqual(throwingIdleResults.map((result) => result.sessionId), [
  "throwing-idle-first",
  "throwing-idle-second",
]);
assert.equal(throwingIdleFirst.closeCalls, 1);
assert.equal(throwingIdleSecond.closeCalls, 1);
assert.equal(throwingIdleRegistry.size, 0);
assert.equal(throwingIdleRegistry.metrics().disposalCallbackErrors, 2);
assert.equal(throwingIdleRegistry.metrics().closeErrors, 0);

const throwingShutdownRegistry = new McpSessionRegistry<FakeTransport>({
  onDispose: throwingDisposalCallback,
});
const throwingShutdownFirst = createTransport();
const throwingShutdownSecond = createTransport();
throwingShutdownRegistry.register("throwing-shutdown-first", throwingShutdownFirst);
throwingShutdownRegistry.register("throwing-shutdown-second", throwingShutdownSecond);
const throwingShutdownResults = await throwingShutdownRegistry.closeAll();
assert.deepEqual(throwingShutdownResults.map((result) => result.sessionId), [
  "throwing-shutdown-first",
  "throwing-shutdown-second",
]);
assert.equal(throwingShutdownFirst.closeCalls, 1);
assert.equal(throwingShutdownSecond.closeCalls, 1);
assert.equal(throwingShutdownRegistry.size, 0);
assert.equal(throwingShutdownRegistry.metrics().disposalCallbackErrors, 2);
assert.equal(throwingShutdownRegistry.metrics().closeErrors, 0);

const throwingPendingShutdownRegistry = new McpSessionRegistry<FakeTransport>({
  onDispose: throwingDisposalCallback,
});
const throwingPendingShutdownTransport = createTransport();
throwingPendingShutdownRegistry.register("throwing-pending-shutdown", throwingPendingShutdownTransport);
assert.equal(throwingPendingShutdownRegistry.beginRequest("throwing-pending-shutdown"), true);
assert.deepEqual(await throwingPendingShutdownRegistry.closeAll(), []);
const throwingPendingEndResult = await throwingPendingShutdownRegistry.endRequest("throwing-pending-shutdown");
assert.equal(throwingPendingEndResult?.sessionId, "throwing-pending-shutdown");
assert.equal(throwingPendingShutdownTransport.closeCalls, 1);
assert.equal(throwingPendingShutdownRegistry.size, 0);
assert.equal(throwingPendingShutdownRegistry.metrics().disposalCallbackErrors, 1);

const preflightRegistry = new McpSessionRegistry<FakeTransport>({
  now: () => preflightNow,
  maxSessions: 1,
  idleTimeoutMs: 100,
});
let preflightNow = 0;
preflightRegistry.register("preflight-resident", createTransport());
preflightNow = 50;
assert.equal(preflightRegistry.admitRegistration(), false);
assert.equal(preflightRegistry.metrics().capacityRejections, 1);
const postPreflightTransport = createTransport();
assert.deepEqual(preflightRegistry.register("post-preflight", postPreflightTransport), {
  accepted: false,
  reason: "capacity_exhausted",
});
await Promise.resolve();
assert.equal(preflightRegistry.metrics().capacityRejections, 2);
assert.equal(postPreflightTransport.closeCalls, 1);

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
