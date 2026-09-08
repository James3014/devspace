import assert from "node:assert/strict";
import {
  computeOpencodeCatalogGeneration,
  acquireOpencodeCatalog,
  fetchOpencodeCatalog,
  getActiveOpencodeCatalogSnapshot,
  parseOpencodeCliModels,
  refreshOpencodeCatalog,
  setActiveOpencodeCatalogSnapshot,
  validateOpencodeModelAndVariant,
  type OpencodeCatalogEntry,
  type OpencodeCatalogSnapshot,
} from "./local-agent-opencode-catalog.js";

// Test 1: Validation of known active models
const mockEntries: OpencodeCatalogEntry[] = [
  {
    providerId: "opencode",
    modelId: "big-pickle",
    fullName: "opencode/big-pickle",
    variants: ["none", "minimal", "low", "medium", "high"],
    status: "active",
  },
  {
    providerId: "opencode",
    modelId: "muse-spark-1.2-contributor-free",
    fullName: "opencode/muse-spark-1.2-contributor-free",
    variants: ["none", "minimal", "low", "medium", "high"],
    status: "active",
  },
  {
    providerId: "opencode-go",
    modelId: "mimo-v2.5",
    fullName: "opencode-go/mimo-v2.5",
    variants: ["none", "low", "medium"],
    status: "active",
  },
];

const testSnapshot: OpencodeCatalogSnapshot = {
  entries: mockEntries,
  fetchedAt: new Date().toISOString(),
  source: "sdk",
  generation: computeOpencodeCatalogGeneration(mockEntries, 1),
  version: "1.0.0",
  freshness: "fresh",
  lastSuccessAt: new Date().toISOString(),
};

setActiveOpencodeCatalogSnapshot(testSnapshot);

// Valid model without variant
assert.deepEqual(validateOpencodeModelAndVariant("opencode/big-pickle"), { valid: true });
assert.deepEqual(validateOpencodeModelAndVariant("big-pickle"), { valid: true });

// Valid model with valid variant
assert.deepEqual(validateOpencodeModelAndVariant("opencode/muse-spark-1.2-contributor-free", "high"), { valid: true });

// Non-existent model fails fast with EXACT_MODEL_UNAVAILABLE
const invalidModel = validateOpencodeModelAndVariant("opencode/nonexistent-model-xyz");
assert.equal(invalidModel.valid, false);
assert.equal(invalidModel.blockerCode, "EXACT_MODEL_UNAVAILABLE");

// Stale model (e.g. hy3-free) fails fast
const staleModel = validateOpencodeModelAndVariant("opencode/hy3-free");
assert.equal(staleModel.valid, false);
assert.equal(staleModel.blockerCode, "EXACT_MODEL_UNAVAILABLE");

// Invalid variant for existing model fails fast with VARIANT_UNAVAILABLE
const invalidVariant = validateOpencodeModelAndVariant("opencode-go/mimo-v2.5", "max");
assert.equal(invalidVariant.valid, false);
assert.equal(invalidVariant.blockerCode, "VARIANT_UNAVAILABLE");

// Test 2: CLI models output parsing
const sampleCliOutput = `
opencode/big-pickle
opencode/ling-3.0-flash-fin-free
opencode-go/deepseek-v4-flash
`;
const parsed = parseOpencodeCliModels(sampleCliOutput);
assert.equal(parsed.length, 3);
assert.equal(parsed[0].fullName, "opencode/big-pickle");
assert.equal(parsed[0].providerId, "opencode");
assert.equal(parsed[0].modelId, "big-pickle");
assert.equal(parsed[2].providerId, "opencode-go");
assert.equal(parsed[2].modelId, "deepseek-v4-flash");
assert.deepEqual(parsed[0].variants, [], "CLI output must not fabricate reasoning variants");
assert.deepEqual(parseOpencodeCliModels("Models:\nopencode/good-model  (active)\n\u001b[31mopencode/red\u001b[0m\nopencode/good-model"), [
  { providerId: "opencode", modelId: "good-model", fullName: "opencode/good-model", variants: [], variantsKnown: false, status: "active" },
]);

// Test 3: Catalog generation updates on refresh
const gen1 = computeOpencodeCatalogGeneration(mockEntries, 1);
const gen2 = computeOpencodeCatalogGeneration(mockEntries, 2);
assert.notEqual(gen1, gen2);
assert.notEqual(
  computeOpencodeCatalogGeneration([{ ...mockEntries[0], enabled: false, variantsKnown: true }], 3),
  computeOpencodeCatalogGeneration([{ ...mockEntries[0], enabled: true, variantsKnown: true }], 3),
  "generation must bind enabled state",
);
assert.equal(
  computeOpencodeCatalogGeneration([...mockEntries].reverse(), 4),
  computeOpencodeCatalogGeneration([...mockEntries], 4),
  "generation must be stable across entry order",
);

// The installed SDK exposes v2.model.list() with data.data and real variants.
let sdkCalls = 0;
const sdkClient = {
  v2: {
    model: {
      list: async () => {
        sdkCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          data: {
            data: [{
              id: "muse-spark-1.3-contributor-free",
              providerID: "opencode",
              variants: [{ id: "high" }],
              status: "active",
            }],
          },
        };
      },
    },
  },
} as never;
const concurrentRefresh = await Promise.all([
  refreshOpencodeCatalog(sdkClient),
  refreshOpencodeCatalog(sdkClient),
  refreshOpencodeCatalog(sdkClient),
]);
assert.equal(sdkCalls, 1, "concurrent refreshes must share one SDK probe");
assert.equal(new Set(concurrentRefresh.map((result) => result.generation)).size, 1);
assert.equal(concurrentRefresh[0]?.source, "sdk");
assert.deepEqual(concurrentRefresh[0]?.entries[0]?.variants, ["high"]);
assert.equal(validateOpencodeModelAndVariant("opencode/muse-spark-1.3-contributor-free", "low", concurrentRefresh[0]).variantStatus, "unsupported");
assert.equal(validateOpencodeModelAndVariant("opencode/big-pickle", undefined, concurrentRefresh[0]).blockerCode, "EXACT_MODEL_UNAVAILABLE", "removed live model must be rejected");

// A live model entry without variants is UNKNOWN, not proof of unsupported.
const cliSnapshot: OpencodeCatalogSnapshot = {
  entries: parsed,
  fetchedAt: new Date().toISOString(),
  source: "cli",
  generation: computeOpencodeCatalogGeneration(parsed),
  version: "test",
  freshness: "fresh",
};
const unknownVariant = validateOpencodeModelAndVariant("opencode/big-pickle", "high", cliSnapshot);
assert.equal(unknownVariant.variantStatus, "unknown");
assert.equal(validateOpencodeModelAndVariant("opencode/big-pickle", "high", {
  ...cliSnapshot,
  source: "sdk",
  entries: [{ ...parsed[0], variants: [], variantsKnown: true }],
}).variantStatus, "unsupported");
assert.equal(validateOpencodeModelAndVariant("opencode/big-pickle", undefined, {
  ...cliSnapshot,
  source: "sdk",
  entries: [{ ...parsed[0], variantsKnown: true, enabled: false }],
}).valid, false);
assert.equal(validateOpencodeModelAndVariant("opencode/big-pickle", undefined, {
  ...cliSnapshot,
  fetchedAt: new Date(Date.now() + 60_000).toISOString(),
}).catalogStatus, "unknown");
assert.equal(validateOpencodeModelAndVariant("opencode/big-pickle", undefined, {
  ...testSnapshot,
  source: "fallback",
}).catalogStatus, "unknown", "fallback provenance cannot gain live authority from freshness");

// If a refresh cannot reach either source, preserve the last live catalog but
// make its stale provenance explicit for the next integration worker.
setActiveOpencodeCatalogSnapshot(concurrentRefresh[0]);
const stale = await refreshOpencodeCatalog(undefined, { PATH: "" });
assert.equal(stale.freshness, "unknown");
assert.equal(stale.source, "fallback");
assert.equal(stale.failure?.code, "FALLBACK_ONLY");
setActiveOpencodeCatalogSnapshot(testSnapshot);

// The default command adapter is asynchronous; a slow probe must leave the
// event loop available for status/reconciliation work.
let ticks = 0;
const ticker = setInterval(() => { ticks += 1; }, 1);
await fetchOpencodeCatalog(undefined, {}, async (_file, _args, options) => {
  await new Promise((resolve) => setTimeout(resolve, Math.min(20, options.timeoutMs)));
  return { stdout: "opencode/async-model", executable: "/usr/local/bin/opencode" };
});
clearInterval(ticker);
assert.ok(ticks > 0, "catalog probes must not block the event loop");

// TTL prevents repeated probes; a failed attempt is retained with a backoff.
setActiveOpencodeCatalogSnapshot({ ...testSnapshot, source: "sdk", freshness: "fresh", lastSuccessAt: new Date().toISOString() });
let acquireCalls = 0;
const clock = Date.now() + 60_000;
const probe = async () => {
  acquireCalls += 1;
  throw new Error("probe unavailable");
};
const firstAcquire = await acquireOpencodeCatalog({ now: () => clock, ttlMs: 1_000, retryMs: 5_000, runCommand: probe });
assert.equal(firstAcquire.freshness, "stale");
const secondAcquire = await acquireOpencodeCatalog({ now: () => clock + 1_000, ttlMs: 1_000, retryMs: 5_000, runCommand: probe });
assert.equal(secondAcquire.freshness, "stale");
assert.equal(acquireCalls, 2, "version and models are one bounded refresh attempt");

// acquire itself must reject a future observation and honor a custom expiry.
const futureEnv = { PATH: "/future", HOME: "/future" };
setActiveOpencodeCatalogSnapshot({ ...testSnapshot, freshness: "fresh", lastSuccessAt: new Date(Date.now() + 3600_000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }, undefined, futureEnv);
const futureAcquire = await acquireOpencodeCatalog({ env: futureEnv, now: () => Date.now(), ttlMs: 10_000, runCommand: async () => ({ stdout: "opencode/future", executable: "/future/opencode" }) });
assert.equal(futureAcquire.entries[0]?.fullName, "opencode/future", "future cache must not short-circuit acquire");
let customCalls = 0;
const customClient = { v2: { model: { list: async () => { customCalls += 1; return { data: { data: [{ id: "custom", providerID: "opencode", variants: [], status: "active", enabled: true }] } }; } } } } as never;
const customEnv = { PATH: "/custom", HOME: "/custom" };
const customClock = Date.now() + 120_000;
const customFirst = await acquireOpencodeCatalog({ client: customClient, env: customEnv, now: () => customClock, ttlMs: 1_000, runCommand: async () => ({ stdout: "", executable: "/custom/opencode" }) });
assert.ok(customFirst.expiresAt && Date.parse(customFirst.expiresAt) - customClock <= 1_000);
await acquireOpencodeCatalog({ client: customClient, env: customEnv, now: () => customClock + 500, ttlMs: 1_000, runCommand: async () => ({ stdout: "", executable: "/custom/opencode" }) });
assert.equal(customCalls, 1, "custom TTL should shortcut within expiry");
await acquireOpencodeCatalog({ client: customClient, env: customEnv, now: () => customClock + 1_500, ttlMs: 1_000, runCommand: async () => ({ stdout: "", executable: "/custom/opencode" }) });
assert.equal(customCalls, 2, "custom TTL should reacquire after expiry");

// Distinct SDK clients and execution environments must not share snapshots.
const clientA = { v2: { model: { list: async () => ({ data: { data: [{ id: "a", providerID: "opencode", variants: [], status: "active", enabled: true }] } }) } } } as never;
const clientB = { v2: { model: { list: async () => ({ data: { data: [{ id: "b", providerID: "opencode", variants: [], status: "active", enabled: true }] } }) } } } as never;
const scopedA = await acquireOpencodeCatalog({ client: clientA, env: { PATH: "/scope-a" }, now: () => Date.now() + 60_000 });
const scopedB = await acquireOpencodeCatalog({ client: clientB, env: { PATH: "/scope-b" }, now: () => Date.now() + 60_000 });
assert.equal(scopedA.entries[0]?.fullName, "opencode/a");
assert.equal(scopedB.entries[0]?.fullName, "opencode/b");

// Issue #58: exact identity must not accept a suffixed model path.
for (const model of ["opencode/big-pickle/extra", "opencode/big-pickle/"]) {
  const result = validateOpencodeModelAndVariant(model, undefined, testSnapshot);
  assert.equal(result.valid, false, `Non-exact model '${model}' must be rejected`);
  assert.equal(result.blockerCode, "EXACT_MODEL_UNAVAILABLE");
}

// Preserve unique legacy aliases, but never choose the first ambiguous route.
const sharedEntries: OpencodeCatalogEntry[] = [
  { providerId: "first", modelId: "shared", fullName: "first/shared", variants: [], status: "active" },
  { providerId: "second", modelId: "shared", fullName: "second/shared", variants: [], status: "active" },
];
const sharedSnapshot = { ...testSnapshot, entries: sharedEntries };
assert.equal(validateOpencodeModelAndVariant("shared", undefined, sharedSnapshot).valid, false);
for (const entry of sharedEntries) {
  assert.deepEqual(validateOpencodeModelAndVariant(entry.fullName, undefined, sharedSnapshot), { valid: true });
}
assert.deepEqual(validateOpencodeModelAndVariant("big-pickle", undefined, testSnapshot), { valid: true });
// Runtime bare IDs default to provider 'opencode', so a unique non-default
// alias must still require qualification rather than select the wrong route.
assert.equal(validateOpencodeModelAndVariant("shared", undefined, { ...testSnapshot, entries: [sharedEntries[0]] }).valid, false);

// Nested model IDs remain usable only with their exact provider-qualified ID.
const nestedEntry: OpencodeCatalogEntry = {
  providerId: "first", modelId: "family/model", fullName: "first/family/model", variants: [], status: "active",
};
const nestedSnapshot = { ...testSnapshot, entries: [nestedEntry] };
assert.deepEqual(validateOpencodeModelAndVariant(nestedEntry.fullName, undefined, nestedSnapshot), { valid: true });
assert.equal(validateOpencodeModelAndVariant("family/model", undefined, nestedSnapshot).valid, false);
assert.equal(validateOpencodeModelAndVariant(`${nestedEntry.fullName}/extra`, undefined, nestedSnapshot).valid, false);

// Preserve SDK lifecycle metadata: deprecated alone does not prove unavailable.
// Unknown or explicitly inactive states must not be admitted.
for (const status of ["active", "alpha", "beta", "deprecated"]) {
  const snapshot = { ...testSnapshot, entries: [{ ...mockEntries[0], status }] };
  assert.deepEqual(validateOpencodeModelAndVariant("opencode/big-pickle", undefined, snapshot), { valid: true });
}
for (const status of ["inactive", "disabled", "retired", "unknown", ""]) {
  const snapshot = { ...testSnapshot, entries: [{ ...mockEntries[0], status }] };
  const result = validateOpencodeModelAndVariant("opencode/big-pickle", undefined, snapshot);
  assert.equal(result.valid, false, `Status '${status}' must not be admitted`);
  assert.equal(result.blockerCode, "EXACT_MODEL_UNAVAILABLE");
}

// Duplicate exact identities are corrupt/ambiguous catalog evidence.
const duplicateSnapshot = { ...testSnapshot, entries: [mockEntries[0], { ...mockEntries[0] }] };
assert.equal(validateOpencodeModelAndVariant("opencode/big-pickle", undefined, duplicateSnapshot).valid, false);

console.log("local-agent-opencode-catalog tests passed!");
