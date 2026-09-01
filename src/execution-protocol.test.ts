import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTION_PROTOCOL_VERSION,
  ExecutionProtocolError,
  assertExecutionAuthority,
  assertSameExecutionGeneration,
  buildExecutionGenerationBinding,
  hashExecutionBinding,
  type ExecutionBinding,
} from "./execution-protocol.js";

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
