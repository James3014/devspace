import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITY_MANIFEST_SCHEMA,
  REQUIRED_HOST_CAPABILITIES,
  computeCapabilityManifest,
  diffCapabilityManifests,
  recordToolSchemaEvidence,
  resetToolSchemaEvidence,
} from "./capability-manifest.js";

const ALL_CAPABILITY_IDS = REQUIRED_HOST_CAPABILITIES.map((capability) => capability.id).sort();

function recordFullyLoadedAgentStart(): void {
  recordToolSchemaEvidence("agent_start", [
    "workspaceId",
    "profile",
    "prompt",
    "attemptKey",
    "executionContract",
    "executionContract.authorityMode",
    "executionContract.nexusGrant",
    "executionContract.dispatchIntent",
    "executionContract.expectedHead",
    "executionContract.writePaths",
    "executionContract.maxFiles",
    "executionContract.toolchainId",
    "executionContract.maxWallMs",
    "executionContract.maxStartupMs",
    "executionContract.maxExecutionMs",
    "executionContract.idleTimeoutMs",
  ]);
}

test("capability manifest is deterministic and fingerprints only present required capabilities", () => {
  resetToolSchemaEvidence();
  recordFullyLoadedAgentStart();
  const first = computeCapabilityManifest();
  const second = computeCapabilityManifest();

  assert.equal(first.schema, CAPABILITY_MANIFEST_SCHEMA);
  assert.deepEqual(first.capabilities, ALL_CAPABILITY_IDS);
  assert.deepEqual(first.missing, []);
  assert.match(first.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(first.manifestSha256, second.manifestSha256, "same evidence must produce the same fingerprint");
});

test("capability manifest detects removal of the agent_start G9 authority seam", () => {
  resetToolSchemaEvidence();
  // A recovery lineage built from a pre-G9 base registers agent_start without
  // the authorityMode / nexusGrant contract fields.
  recordToolSchemaEvidence("agent_start", [
    "workspaceId",
    "profile",
    "prompt",
    "executionContract.dispatchIntent",
    "executionContract.expectedHead",
  ]);

  const manifest = computeCapabilityManifest();
  assert.deepEqual(
    manifest.missing.sort(),
    [
      "agent_start.executionContract.authorityMode",
      "agent_start.executionContract.nexusGrant",
    ],
  );
  assert.deepEqual(manifest.capabilities, ["agent_start.tool"]);

  const loaded = computeCapabilityManifest();
  resetToolSchemaEvidence();
  recordFullyLoadedAgentStart();
  const canonical = computeCapabilityManifest();
  const diff = diffCapabilityManifests({
    requiredCapabilityIds: canonical.capabilities,
    candidateCapabilityIds: loaded.capabilities,
  });
  assert.equal(diff.preserved, false);
  assert.ok(diff.missing.includes("agent_start.executionContract.nexusGrant"));
  assert.ok(diff.missing.includes("agent_start.executionContract.authorityMode"));
});

test("capability manifest detects removal of the whole agent_start action", () => {
  resetToolSchemaEvidence();
  const manifest = computeCapabilityManifest();
  assert.deepEqual(manifest.capabilities, []);
  assert.deepEqual(manifest.missing.sort(), ALL_CAPABILITY_IDS);
});

test("capability preservation diff passes when the candidate preserves required capabilities", () => {
  const diff = diffCapabilityManifests({
    requiredCapabilityIds: ALL_CAPABILITY_IDS,
    candidateCapabilityIds: [...ALL_CAPABILITY_IDS].reverse(),
  });
  assert.equal(diff.preserved, true);
  assert.deepEqual(diff.missing, []);
});
