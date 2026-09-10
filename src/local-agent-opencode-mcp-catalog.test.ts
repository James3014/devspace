import assert from "node:assert/strict";
import { createMcpOpencodeCatalogSource } from "./local-agent-opencode-mcp-catalog.js";

function fakeClient(model = "mcp-model") {
  return { v2: { model: { list: async () => ({ data: { data: [{ id: model, providerID: "opencode", variants: [], status: "active", enabled: true }] } }) } } } as never;
}

let factoryCalls = 0;
let closeCalls = 0;
const source = createMcpOpencodeCatalogSource(async () => {
  factoryCalls += 1;
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { client: fakeClient(), server: { close: () => { closeCalls += 1; } } };
});
const snapshots = await Promise.all([source.acquire(), source.acquire(), source.acquire()]);
assert.equal(factoryCalls, 1, "concurrent catalog requests share one lazy startup");
assert.equal(new Set(snapshots.map((snapshot) => snapshot.generation)).size, 1);
source.close();
source.close();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(closeCalls, 1, "close is idempotent");

let lateResolve: ((value: { client: never; server: { close: () => void } }) => void) | undefined;
let lateClosed = 0;
const lateSource = createMcpOpencodeCatalogSource(() => new Promise((resolve) => { lateResolve = resolve; }));
const lateAcquire = lateSource.acquire();
lateSource.close();
assert.equal(lateClosed, 0, "close returns without waiting for startup");
lateResolve?.({ client: fakeClient() as never, server: { close: () => { lateClosed += 1; } } });
await assert.rejects(lateAcquire, /closed/);
assert.equal(lateClosed, 1, "late-created server is closed immediately");
await assert.rejects(lateSource.acquire(), /closed/);

let failedFactoryCalls = 0;
const failedSource = createMcpOpencodeCatalogSource(async () => {
  failedFactoryCalls += 1;
  throw new Error("startup failed");
}, { retryMs: 60_000 });
await failedSource.acquire();
await failedSource.acquire();
assert.equal(failedFactoryCalls, 1, "failed startup is backed off instead of caching a rejected promise or storming");
failedSource.close();

console.log("local-agent-opencode-mcp-catalog tests passed!");
