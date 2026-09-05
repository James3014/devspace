import assert from "node:assert/strict";
import {
  computeOpencodeCatalogGeneration,
  fallbackOpencodeCatalogSnapshot,
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

// Test 4: Shared fallback snapshot includes the contributor-free baseline and
// accepts it for direct dispatch validation (muse-spark-1.3 was missing from
// the previous fallback; the shared builder mirrors the sync AND async paths).
const fallback = fallbackOpencodeCatalogSnapshot();
assert.equal(fallback.source, "fallback");
assert.equal(fallback.version, "unknown");
assert.ok(
  fallback.entries.some((entry) => entry.fullName === "opencode/muse-spark-1.3-contributor-free"),
  "fallback must include opencode/muse-spark-1.3-contributor-free",
);
assert.ok(
  fallback.entries.some((entry) => entry.fullName === "opencode/big-pickle"),
  "fallback must include opencode/big-pickle",
);
assert.deepEqual(
  validateOpencodeModelAndVariant("opencode/muse-spark-1.3-contributor-free", "high", fallback),
  { valid: true },
);

console.log("local-agent-opencode-catalog tests passed!");
