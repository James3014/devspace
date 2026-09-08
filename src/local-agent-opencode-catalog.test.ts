import assert from "node:assert/strict";
import {
  computeOpencodeCatalogGeneration,
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
  source: "fallback",
  generation: computeOpencodeCatalogGeneration(mockEntries, 1),
  version: "1.0.0",
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

// Test 3: Catalog generation updates on refresh
const gen1 = computeOpencodeCatalogGeneration(mockEntries, 1);
const gen2 = computeOpencodeCatalogGeneration(mockEntries, 2);
assert.notEqual(gen1, gen2);

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
