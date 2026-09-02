import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTION_PROTOCOL_VERSION,
  ExecutionProtocolError,
  assertExecutionAuthority,
  assertSameExecutionGeneration,
  buildExecutionGenerationBinding,
  hashDispatchIntent,
  hashExecutionBinding,
  parseDispatchIntent,
  renderDispatchIntentForWorker,
  type DispatchIntent,
  type ExecutionBinding,
} from "./execution-protocol.js";

function controllerIntent(): DispatchIntent {
  return {
    taskId: "task-controller-1",
    attemptId: "attempt-controller-1",
    objective: "Implement one bounded controller-contract seam.",
    roleIntent: "DEEP_ENGINEERING",
    context: ["Preserve existing execution mechanics."],
    readScope: ["src"],
    writeScope: ["src/execution-protocol.ts", "src/execution-protocol.test.ts"],
    exclusiveOwnership: true,
    forbiddenChanges: ["Do not add route or acceptance authority to Dev MCP."],
    acceptanceCriteria: ["Typed controller intent is durable and independently inspectable."],
    verificationRequired: true,
    expectedArtifacts: ["source diff"],
    expectedEvidence: ["focused tests"],
    claimCeiling: "CANDIDATE_READY",
  };
}

function ownerBinding(): ExecutionBinding {
  return {
    version: EXECUTION_PROTOCOL_VERSION,
    authority: { mode: "OWNER_DIRECT", issuer: "owner" },
    identity: { taskId: "task-1", attemptId: "attempt-1", operationId: "op-1" },
    worker: {
      profile: "codex-implement",
      provider: "codex",
      model: "gpt-5.6-sol",
      runtimeSurface: "cli",
      sessionMode: "durable",
    },
    capabilities: {
      filesystem: "native",
      shell: "native",
      effectCeiling: "WORKSPACE_MUTATION",
    },
    isolation: {
      workspaceId: "ws_1",
      workspaceRoot: "/tmp/project",
      worktreePath: "/tmp/project",
    },
  };
}

test("controller DispatchIntent is deterministic, model-neutral, and cannot express verification/acceptance authority", () => {
  const intent = controllerIntent();
  assert.match(hashDispatchIntent(intent), /^[a-f0-9]{64}$/);
  assert.equal(hashDispatchIntent(intent), hashDispatchIntent({ ...intent, writeScope: [...(intent.writeScope ?? [])] }));
  assert.deepEqual(parseDispatchIntent(intent), intent);
  assert.match(renderDispatchIntentForWorker(intent), /Do not broaden scope or claim VERIFIED, ACCEPTED, MERGED, DEPLOYED, or RELEASED/);

  assert.throws(
    () => parseDispatchIntent({ ...intent, claimCeiling: "VERIFIED" }),
    (error: unknown) => error instanceof ExecutionProtocolError && error.code === "INVALID_DISPATCH_INTENT",
  );
  assert.throws(
    () => parseDispatchIntent({ ...intent, exclusiveOwnership: false }),
    (error: unknown) => error instanceof ExecutionProtocolError && error.code === "INVALID_DISPATCH_INTENT",
  );
  assert.throws(
    () => parseDispatchIntent({ ...intent, writeScope: ["../outside"] }),
    (error: unknown) => error instanceof ExecutionProtocolError && error.code === "INVALID_DISPATCH_INTENT",
  );
});

test("OWNER_DIRECT binding hashes deterministically and requires trusted owner evidence", () => {
  const binding = ownerBinding();
  const first = hashExecutionBinding(binding);
  const second = hashExecutionBinding({ ...binding, identity: { ...binding.identity } });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert.doesNotThrow(() => assertExecutionAuthority(binding.authority, { kind: "OWNER_DIRECT" }));
  assert.throws(
    () => assertExecutionAuthority(binding.authority),
    (error: unknown) => error instanceof ExecutionProtocolError && error.code === "AUTHORITY_EVIDENCE_MISMATCH",
  );
});

test("NEXUS_GOVERNED cannot self-validate or silently accept mismatched grant evidence", () => {
  const authority = {
    mode: "NEXUS_GOVERNED" as const,
    issuer: "nexus" as const,
    grantId: "grant-1",
    grantHash: "abc123",
  };
  assert.throws(
    () => assertExecutionAuthority(authority),
    (error: unknown) => error instanceof ExecutionProtocolError && error.code === "NEXUS_AUTHORITY_NOT_VALIDATED",
  );
  assert.throws(
    () => assertExecutionAuthority(authority, { kind: "NEXUS_VALIDATED", grantId: "grant-2", grantHash: "abc123" }),
    (error: unknown) => error instanceof ExecutionProtocolError && error.code === "AUTHORITY_EVIDENCE_MISMATCH",
  );
  assert.doesNotThrow(() => assertExecutionAuthority(authority, {
    kind: "NEXUS_VALIDATED",
    grantId: "grant-1",
    grantHash: "abc123",
  }));
});

test("mutating execution binding fails closed without explicit isolation", () => {
  const binding = ownerBinding();
  binding.isolation.workspaceId = undefined;
  binding.isolation.worktreePath = undefined;
  assert.throws(
    () => hashExecutionBinding(binding),
    (error: unknown) => error instanceof ExecutionProtocolError && error.code === "INVALID_EXECUTION_BINDING",
  );
});

test("execution generation accepts exact generation and rejects substitution or legacy absence", () => {
  const generation = buildExecutionGenerationBinding({
    profileCatalogGeneration: "catalog-a",
    provider: "codex",
    model: "gpt-5.6-sol",
    executionIdentity: "/opt/codex/bin/codex.js",
    runtimeVersion: "0.152.0",
    devspaceBuildId: "devspace-1.0.7-deadbeef",
    devspaceSourceCommit: "deadbeef",
  });
  assert.doesNotThrow(() => assertSameExecutionGeneration(generation, { ...generation }));

  const changed = buildExecutionGenerationBinding({
    profileCatalogGeneration: "catalog-b",
    provider: "codex",
    model: "gpt-5.6-sol",
    executionIdentity: "/opt/codex/bin/codex.js",
    runtimeVersion: "0.152.0",
    devspaceBuildId: "devspace-1.0.7-deadbeef",
    devspaceSourceCommit: "deadbeef",
  });
  assert.throws(
    () => assertSameExecutionGeneration(generation, changed),
    (error: unknown) => error instanceof ExecutionProtocolError && error.code === "EXECUTION_GENERATION_MISMATCH",
  );
  assert.throws(
    () => assertSameExecutionGeneration(undefined, generation),
    (error: unknown) => error instanceof ExecutionProtocolError && error.code === "LEGACY_EXECUTION_BINDING_MISSING",
  );
});
