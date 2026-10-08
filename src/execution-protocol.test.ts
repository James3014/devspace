import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTION_PROTOCOL_VERSION,
  TOOL_INTENT_NAMESPACE,
  TOOL_PROJECTION_MANIFEST_SCHEMA,
  ExecutionProtocolError,
  assertExecutionBindingToolManifest,
  assertToolManifestRef,
  assertSameExecutionGeneration,
  buildExecutionGenerationBinding,
  buildHostGenerationBinding,
  hashDispatchIntent,
  hashExecutionBinding,
  hashToolProjectionManifest,
  parseDispatchIntent,
  parseToolProjectionManifest,
  renderDispatchIntentForWorker,
  toolProjectionManifestRef,
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

test("OWNER_DIRECT binding hashes deterministically and rejects retired authority shapes", () => {
  const binding = ownerBinding();
  const first = hashExecutionBinding(binding);
  const second = hashExecutionBinding({ ...binding, identity: { ...binding.identity } });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert.throws(
    () => hashExecutionBinding({
      ...binding,
      authority: { mode: "NEXUS_GOVERNED", issuer: "nexus" },
    } as unknown as ExecutionBinding),
    (error: unknown) => error instanceof ExecutionProtocolError && error.code === "INVALID_EXECUTION_BINDING",
  );
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

test("execution generation accepts exact generation and rejects substitution, cross-host continuation, or legacy absence", () => {
  const hostA = buildHostGenerationBinding({
    hostName: "m5-control",
    platform: "darwin",
    arch: "arm64",
    homeDir: "/Users/james",
    pathEnv: "/opt/homebrew/bin:/usr/bin",
    nodeVersion: "24.8.0",
    stateRoot: "/Users/james/.devspace",
    capabilityManifestSha256: "a".repeat(64),
    adapterGeneration: "local-agent:herdr:v1",
  });
  const generation = buildExecutionGenerationBinding({
    profileCatalogGeneration: "catalog-a",
    provider: "codex",
    model: "gpt-5.6-sol",
    executionIdentity: "/opt/codex/bin/codex.js",
    runtimeVersion: "0.152.0",
    devspaceBuildId: "devspace-1.0.7-deadbeef",
    devspaceSourceCommit: "deadbeef",
    hostGeneration: hostA,
    authReadiness: "UNKNOWN",
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
    hostGeneration: hostA,
    authReadiness: "UNKNOWN",
  });
  assert.throws(
    () => assertSameExecutionGeneration(generation, changed),
    (error: unknown) => error instanceof ExecutionProtocolError && error.code === "EXECUTION_GENERATION_MISMATCH",
  );

  const hostB = buildHostGenerationBinding({
    hostName: "m4-console",
    platform: "darwin",
    arch: "arm64",
    homeDir: "/Users/jameschen",
    pathEnv: "/usr/local/bin:/usr/bin",
    nodeVersion: "24.8.0",
    stateRoot: "/Users/jameschen/.devspace",
    capabilityManifestSha256: "a".repeat(64),
    adapterGeneration: "local-agent:herdr:v1",
  });
  const crossHost = buildExecutionGenerationBinding({
    profileCatalogGeneration: "catalog-a",
    provider: "codex",
    model: "gpt-5.6-sol",
    executionIdentity: "/opt/codex/bin/codex.js",
    runtimeVersion: "0.152.0",
    devspaceBuildId: "devspace-1.0.7-deadbeef",
    devspaceSourceCommit: "deadbeef",
    hostGeneration: hostB,
    authReadiness: "UNKNOWN",
  });
  assert.throws(
    () => assertSameExecutionGeneration(generation, crossHost),
    (error: unknown) => error instanceof ExecutionProtocolError && error.code === "CROSS_HOST_CONTINUATION_REJECTED",
  );

  assert.throws(
    () => assertSameExecutionGeneration(undefined, generation),
    (error: unknown) => error instanceof ExecutionProtocolError && error.code === "LEGACY_EXECUTION_BINDING_MISSING",
  );
});

function ownerToolManifest() {
  return parseToolProjectionManifest({
    schema: TOOL_PROJECTION_MANIFEST_SCHEMA,
    namespace: TOOL_INTENT_NAMESPACE,
    identity: { taskId: "task-1", attemptId: "attempt-1" },
    authority: { mode: "OWNER_DIRECT", issuer: "owner" },
    authorizedToolCeiling: ["workspace.read", "workspace.search_text", "process.execute"],
    candidateTools: ["process.execute", "workspace.read", "workspace.search_text"],
    selectedTools: ["workspace.read", "process.execute"],
    orderingMode: "ORDER_INDEPENDENT",
  });
}

test("ToolProjectionManifest canonicalizes order-independent sets and hashes deterministically", () => {
  const manifest = ownerToolManifest();
  assert.deepEqual(manifest.authorizedToolCeiling, ["process.execute", "workspace.read", "workspace.search_text"]);
  assert.deepEqual(manifest.selectedTools, ["process.execute", "workspace.read"]);
  assert.match(hashToolProjectionManifest(manifest), /^[a-f0-9]{64}$/);
  assert.equal(toolProjectionManifestRef(manifest), `sha256:${hashToolProjectionManifest(manifest)}`);
});

test("ToolProjectionManifest rejects widening, unknown ids, duplicates, and hidden order", () => {
  const base = ownerToolManifest();
  for (const invalid of [
    { ...base, candidateTools: [...base.candidateTools, "workspace.mutate"] },
    { ...base, selectedTools: [...base.selectedTools, "workspace.list"] },
    { ...base, selectedTools: ["workspace.read", "workspace.read"] },
    { ...base, selectedTools: ["provider.native.magic"] },
    { ...base, candidateOrder: [...base.candidateTools] },
  ]) {
    assert.throws(
      () => parseToolProjectionManifest(invalid),
      (error: unknown) => error instanceof ExecutionProtocolError
        && error.code === "INVALID_TOOL_PROJECTION_MANIFEST",
    );
  }
});

test("ToolProjectionManifest preserves explicit order-sensitive candidate order only when it is an exact permutation", () => {
  const base = ownerToolManifest();
  const ordered = parseToolProjectionManifest({
    ...base,
    orderingMode: "ORDER_SENSITIVE",
    candidateOrder: ["workspace.search_text", "process.execute", "workspace.read"],
  });
  assert.deepEqual(ordered.candidateOrder, ["workspace.search_text", "process.execute", "workspace.read"]);
  assert.throws(
    () => parseToolProjectionManifest({
      ...base,
      orderingMode: "ORDER_SENSITIVE",
      candidateOrder: ["workspace.read"],
    }),
    (error: unknown) => error instanceof ExecutionProtocolError
      && error.code === "INVALID_TOOL_PROJECTION_MANIFEST",
  );
});

test("ExecutionBinding tool manifest reference is content, identity, and authority bound", () => {
  const manifest = ownerToolManifest();
  const binding = ownerBinding();
  binding.capabilities.toolManifestRef = toolProjectionManifestRef(manifest);
  assert.doesNotThrow(() => assertExecutionBindingToolManifest(binding, manifest));

  assert.throws(
    () => assertToolManifestRef("sha256:" + "0".repeat(64), manifest),
    (error: unknown) => error instanceof ExecutionProtocolError
      && error.code === "TOOL_MANIFEST_REF_MISMATCH",
  );
  assert.throws(
    () => assertExecutionBindingToolManifest({
      ...binding,
      identity: { ...binding.identity, attemptId: "other-attempt" },
    }, manifest),
    (error: unknown) => error instanceof ExecutionProtocolError
      && error.code === "TOOL_MANIFEST_REF_MISMATCH",
  );
});
