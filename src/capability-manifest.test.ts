import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";
import {
  CAPABILITY_MANIFEST_SCHEMA,
  deriveLoadedCapabilityManifest,
} from "./capability-manifest.js";
import { chatSwarmToolInputShapes } from "./chat-swarm-tools.js";

function agentStartInput(idleDescription = "heartbeat-backed idle supervision"): Record<string, z.ZodType> {
  return {
    workspaceId: z.string(),
    executionContract: z.object({
      authorityMode: z.enum(["OWNER_DIRECT", "NEXUS_GOVERNED"]).optional(),
      nexusGrant: z.object({ revision: z.string() }).optional(),
      idleTimeoutMs: z.number().describe(idleDescription).optional(),
    }).partial().optional(),
  };
}

test("loaded capability manifest is deterministic and derived from the registered agent_start schema", () => {
  const first = deriveLoadedCapabilityManifest({ agent_start: agentStartInput() });
  const second = deriveLoadedCapabilityManifest({ agent_start: agentStartInput() });

  assert.equal(first.schema, CAPABILITY_MANIFEST_SCHEMA);
  assert.deepEqual(first.missing, []);
  assert.deepEqual(first.capabilities, [
    "agent_start.executionContract.authorityMode",
    "agent_start.executionContract.idleTimeoutMs",
    "agent_start.executionContract.nexusGrant",
    "agent_start.tool",
  ]);
  assert.match(first.manifestSha256, /^[0-9a-f]{64}$/);
  assert.match(first.inputSchemaFingerprint ?? "", /^[0-9a-f]{64}$/);
  assert.equal(first.manifestSha256, second.manifestSha256);
});

test("registered input schema fingerprint tracks selector shape while ignoring key order", () => {
  const original = deriveLoadedCapabilityManifest({ agent_start: agentStartInput() });
  const reordered = deriveLoadedCapabilityManifest({
    agent_start: {
      executionContract: agentStartInput().executionContract,
      workspaceId: agentStartInput().workspaceId,
    },
  });
  assert.equal(original.inputSchemaFingerprint, reordered.inputSchemaFingerprint);

  const changed = agentStartInput();
  changed.provider = z.string().optional();
  const changedManifest = deriveLoadedCapabilityManifest({ agent_start: changed });
  assert.notEqual(original.inputSchemaFingerprint, changedManifest.inputSchemaFingerprint);
  assert.notEqual(original.manifestSha256, changedManifest.manifestSha256);
});

test("loaded capability manifest detects removal from the actual registered schema", () => {
  const regressed = agentStartInput();
  regressed.executionContract = z.object({ idleTimeoutMs: z.number().optional() }).partial().optional();

  const manifest = deriveLoadedCapabilityManifest({ agent_start: regressed });
  assert.deepEqual(manifest.missing, [
    "agent_start.executionContract.authorityMode",
    "agent_start.executionContract.nexusGrant",
  ]);
});

test("schema fingerprint includes the exact Chat Swarm registered input shapes", () => {
  const withoutSwarm = deriveLoadedCapabilityManifest({ agent_start: agentStartInput() });
  const withSwarm = deriveLoadedCapabilityManifest({
    agent_start: agentStartInput(),
    ...chatSwarmToolInputShapes({ chatSwarmMaxWorkers: 4, chatSwarmResultMaxChars: 4096 }),
  });
  assert.notEqual(withSwarm.inputSchemaFingerprint, withoutSwarm.inputSchemaFingerprint);
  const changed = chatSwarmToolInputShapes({ chatSwarmMaxWorkers: 5, chatSwarmResultMaxChars: 4096 });
  const changedManifest = deriveLoadedCapabilityManifest({ agent_start: agentStartInput(), ...changed });
  assert.notEqual(changedManifest.inputSchemaFingerprint, withSwarm.inputSchemaFingerprint);
});
