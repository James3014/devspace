import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CAPABILITY_DISCOVERY_INDEX_PATH,
  CAPABILITY_DISCOVERY_RECEIPT_SCHEMA,
  CapabilityDiscoveryError,
  parseCapabilityDiscoveryReceipt,
  renderCapabilityDiscoveryForWorker,
  verifyCapabilityDiscoveryReceipt,
} from "./capability-discovery.js";

const revision = "a".repeat(40);
const index = JSON.stringify({
  schema: "nexus.capability_discovery_index.v1",
  capabilities: [
    {
      id: "existing_transport",
      canonicalOwnerRepository: "James3014/example-runtime",
      components: ["existing seam"],
      evidenceRefs: ["docs/example.md"],
      doNotDuplicateBeforeEvaluation: ["parallel implementation"],
    },
  ],
});
const indexSha256 = createHash("sha256").update(index).digest("hex");

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    schema: CAPABILITY_DISCOVERY_RECEIPT_SCHEMA,
    repository: "James3014/Nexus-new",
    indexRevision: revision,
    indexPath: CAPABILITY_DISCOVERY_INDEX_PATH,
    indexSha256,
    intent: "Reuse an existing transport before inventing another one.",
    disposition: "EXTEND_EXISTING",
    matchedCapabilityIds: ["existing_transport"],
    evidence: {
      architecture: ["capability index inspected"],
      source: ["current owner source inspected"],
      history: ["prior acceptance evidence inspected"],
      runtime: ["live runtime state inspected"],
    },
    ...overrides,
  };
}

test("capability discovery receipt validates current-main index identity and donor membership", async () => {
  const parsed = parseCapabilityDiscoveryReceipt(receipt());
  const verified = await verifyCapabilityDiscoveryReceipt(parsed, {
    observeCanonicalMain: () => revision,
    fetchIndex: async () => index,
  });
  assert.equal(verified.matchedCapabilities.length, 1);
  assert.equal(verified.matchedCapabilities[0]?.id, "existing_transport");
  assert.match(renderCapabilityDiscoveryForWorker(verified), /existing_transport/);
});

test("capability discovery rejects stale, blocked, and unjustified-new mutation receipts", async () => {
  const parsed = parseCapabilityDiscoveryReceipt(receipt());
  await assert.rejects(
    verifyCapabilityDiscoveryReceipt(parsed, {
      observeCanonicalMain: () => "b".repeat(40),
      fetchIndex: async () => index,
    }),
    (error: unknown) => error instanceof CapabilityDiscoveryError && error.code === "CAPABILITY_DISCOVERY_STALE",
  );

  const blocked = parseCapabilityDiscoveryReceipt(receipt({ disposition: "BLOCKED_UNKNOWN", matchedCapabilityIds: [] }));
  await assert.rejects(
    verifyCapabilityDiscoveryReceipt(blocked, {
      observeCanonicalMain: () => revision,
      fetchIndex: async () => index,
    }),
    (error: unknown) => error instanceof CapabilityDiscoveryError && error.code === "CAPABILITY_DISCOVERY_REQUIRED",
  );

  assert.throws(
    () => parseCapabilityDiscoveryReceipt(receipt({ disposition: "NEW_CAPABILITY_JUSTIFIED", matchedCapabilityIds: [] })),
    /explicit justification/i,
  );
});
