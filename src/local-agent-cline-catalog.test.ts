import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ClineCatalogService, CLINE_RECOMMENDED_MODELS_ENDPOINT, parseClineCatalogFeed, validateClineModelAndThinking, type ClineRuntimeIdentity } from "./local-agent-cline-catalog.js";

const runtime: ClineRuntimeIdentity = {
  command: "cline", cliProviderId: "cline", version: "3.0.61", supportsProviderFlag: true, supportsModelFlag: true,
  supportedThinking: ["none", "low", "medium", "high", "xhigh"],
};

const feed = { clinePass: [
  { id: "anthropic/claude-sonnet-4-6", capabilities: { supportsReasoning: true, thinkingLevels: ["none", "low", "high"] }, pricing: { input: 1, output: 2 } },
], free: [{ id: "minimax/minimax-m2.5", supportsReasoning: false }] };
assert.equal(parseClineCatalogFeed({ clinePass: [{ id: "openai/gpt-6-astra", tags: ["NEW"] }], free: [{ id: "deepseek/deepseek-v4-flash" }] })[0]?.free, "unknown");

const entries = parseClineCatalogFeed(feed);
assert.equal(entries[0]?.fullName, "anthropic/claude-sonnet-4-6");
assert.deepEqual(entries[0]?.thinking, ["none", "low", "high"]);
assert.equal(entries[0]?.free, "unknown");
assert.equal(entries[1]?.free, "known-free");
assert.equal(entries[1]?.thinking.length, 0, "thinking variants must not be invented");
assert.equal(entries[0]?.modelProviderId, "anthropic");
assert.equal(entries[0]?.thinkingKnown, true);
const feedSnapshot = {
  state: "READY" as const, entries, fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), generation: "fixture", runtime, source: "fixture" as const,
};
assert.equal(validateClineModelAndThinking("anthropic/claude-sonnet-4-6", "cline-pass", "high", feedSnapshot).valid, false, "feed thinking metadata is not executable readiness");
assert.equal(validateClineModelAndThinking("anthropic/claude-sonnet-4-6", "cline-pass", undefined, feedSnapshot).valid, true);
assert.equal(validateClineModelAndThinking("anthropic/claude-sonnet-4-6", "cline-pass", "high", { ...feedSnapshot, runtime: { ...runtime, thinkingVerified: true } }).valid, true);
const verifiedSnapshot = { ...feedSnapshot, runtime: { ...runtime, thinkingVerified: true } };
assert.equal(validateClineModelAndThinking("anthropic/claude-sonnet-4-6", "cline-pass", "high", { ...verifiedSnapshot, expiresAt: new Date(Date.now() - 1).toISOString() }).valid, false, "stale snapshot must not admit effort");
assert.equal(validateClineModelAndThinking("anthropic/claude-sonnet-4-6", "cline-pass", "high", { ...verifiedSnapshot, expiresAt: undefined }).valid, false, "missing expiry must fail closed");
assert.equal(validateClineModelAndThinking("anthropic/claude-sonnet-4-6", "cline-pass", "high", { ...verifiedSnapshot, fetchedAt: new Date(Date.now() + 60_000).toISOString() }).valid, false, "future snapshot must fail closed");
assert.throws(() => parseClineCatalogFeed({ data: [{ id: "claude-sonnet-4-6" }] }));
assert.throws(() => parseClineCatalogFeed({ clinePass: [{ id: "x/a\nb" }], free: [] }), /invalid/);
const overlap = parseClineCatalogFeed({ clinePass: [{ id: "x/a" }], free: [{ id: "x/a" }] });
assert.deepEqual(overlap.map((entry) => entry.routeKey), ["cline-pass:x/a", "cline:x/a"]);
assert.throws(() => parseClineCatalogFeed({ clinePass: [{ id: "x/a" }, { id: "x/a" }], free: [] }), /duplicate pass/);

let fetchCalls = 0;
let resolveFeed: (() => void) | undefined;
const service = new ClineCatalogService({
  endpoint: "https://api.cline.bot/api/v1/models",
  probeRuntime: async () => runtime,
  fetchCatalog: async () => { fetchCalls += 1; await new Promise<void>((resolve) => { resolveFeed = resolve; }); return { status: 200, json: async () => feed }; },
});
const first = service.refresh();
const second = service.refresh();
assert.equal(first, second, "refreshes must share one in-flight request");
assert.equal(fetchCalls, 0);
await Promise.resolve();
resolveFeed?.();
const ready = await first;
assert.equal(fetchCalls, 1);
assert.equal(ready.state, "READY");
assert.equal(ready.source, "cline-api");
assert.equal(service.getSnapshot().state, "READY");

let now = Date.parse(ready.fetchedAt!);
let staleNow = now;
const stale = new ClineCatalogService({ endpoint: "fixture", probeRuntime: async () => runtime, now: () => new Date(staleNow), fetchCatalog: async () => ({ status: 200, json: async () => feed }) });
await stale.refresh();
staleNow += 360_001;
assert.equal(stale.getSnapshot().state, "UNKNOWN");

const missingFeed = new ClineCatalogService({ endpoint: "", probeRuntime: async () => runtime });
assert.equal((await missingFeed.refresh()).state, "UNKNOWN");
assert.equal(missingFeed.getSnapshot().source, "cli-capability");

const unsupported = new ClineCatalogService({ probeRuntime: async () => ({ ...runtime, supportsModelFlag: false }) });
assert.equal((await unsupported.refresh()).state, "BLOCKED");

const previousClineCommand = process.env.CLINE_COMMAND;
try {
  process.env.CLINE_COMMAND = process.execPath;
  const resolvedCommandService = new ClineCatalogService({
    endpoint: "fixture",
    fetchCatalog: async () => ({ status: 200, json: async () => feed }),
  });
  const resolvedCommandSnapshot = await resolvedCommandService.refresh();
  assert.equal(
    resolvedCommandSnapshot.runtime.command,
    process.execPath,
    "catalog runtime probe must use the shared Cline executable resolver",
  );
  assert.equal(resolvedCommandSnapshot.state, "BLOCKED", "node is not a Cline runtime; this fixture only proves executable resolution");
} finally {
  if (previousClineCommand === undefined) delete process.env.CLINE_COMMAND;
  else process.env.CLINE_COMMAND = previousClineCommand;
}

const malformed = new ClineCatalogService({ endpoint: "fixture", probeRuntime: async () => runtime, fetchCatalog: async () => ({ status: 200, json: async () => ({ data: [{ id: "bad" }] }) }) });
assert.equal((await malformed.refresh()).state, "BLOCKED");

const non2xx = new ClineCatalogService({ endpoint: CLINE_RECOMMENDED_MODELS_ENDPOINT, probeRuntime: async () => runtime, fetchCatalog: async () => ({ status: 401, json: async () => ({}) }) });
assert.equal((await non2xx.refresh()).state, "BLOCKED");
const probeError = new ClineCatalogService({ probeRuntime: async () => { throw new Error("probe unavailable"); } });
assert.equal((await probeError.refresh()).state, "UNKNOWN");

const refreshed = parseClineCatalogFeed({ clinePass: [], free: [{ id: "google/gemini-3.7-flash" }] });
assert.deepEqual(refreshed.map((entry) => entry.routeKey), ["cline:google/gemini-3.7-flash"], "empty pass group exposes only the cline free route");
const refreshedWithPass = parseClineCatalogFeed({ clinePass: [{ id: "x/pass" }], free: [{ id: "google/gemini-3.7-flash" }] });
assert.deepEqual(refreshedWithPass.map((entry) => entry.routeKey), ["cline-pass:x/pass", "cline:google/gemini-3.7-flash", "cline-pass:google/gemini-3.7-flash"], "nonempty pass group enables the pass fallback route");

assert.throws(() => parseClineCatalogFeed({ free: [{ id: "x/a" }] }), /clinePass\/free/);
let backoffNow = Date.now();
let shouldFail = false;
const staleFailure = new ClineCatalogService({ endpoint: "fixture", probeRuntime: async () => runtime, now: () => new Date(backoffNow), failureBackoffMs: 60_000, fetchCatalog: async () => shouldFail ? ({ status: 500, json: async () => ({}) }) : ({ status: 200, json: async () => feed }) });
const retained = await staleFailure.refresh();
shouldFail = true;
backoffNow += 360_001;
const failed = await staleFailure.refresh(true);
assert.equal(failed.state, "BLOCKED");
assert.deepEqual(failed.entries.map((entry) => entry.fullName), retained.entries.map((entry) => entry.fullName), "failed refresh retains last successful entries");

const server = createServer((request, response) => {
  if (request.url === "/timeout") return;
  if (request.url === "/oversize") { response.writeHead(200); response.end("x".repeat(1_100_000)); return; }
  response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(feed));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const address = server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
const timeoutService = new ClineCatalogService({ endpoint: `${base}/timeout`, probeRuntime: async () => runtime, timeoutMs: 20 });
assert.equal((await timeoutService.refresh()).state, "BLOCKED");
const oversizeService = new ClineCatalogService({ endpoint: `${base}/oversize`, probeRuntime: async () => runtime, maxBodyBytes: 1024 });
assert.equal((await oversizeService.refresh()).state, "BLOCKED");
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

console.log("local-agent-cline-catalog tests passed!");