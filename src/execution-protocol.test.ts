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
  DIRECT_CANDIDATE_EXECUTION_SCHEMA,
  computeDirectCandidateEvidenceId,
  computeDispatchIntentHash,
  computeDirectCandidateEvidenceIntegrity,
  validateDirectCandidateExecutionEvidence,
  type DispatchIntent,
  type DirectCandidateExecutionEvidence,
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


function sampleDirectEvidence(): DirectCandidateExecutionEvidence {
  const intent = controllerIntent();
  const intentHash = computeDispatchIntentHash(intent);
  const gen = buildExecutionGenerationBinding({
    profileCatalogGeneration: "gen-test-1",
    provider: "gemini",
    model: "gemini-2.5-pro",
    executionIdentity: "agt_12345678",
    runtimeVersion: "1.0.7",
    devspaceBuildId: "build-1",
    devspaceSourceCommit: "cd907f81b46781d5a265c748374efeaab93d00cb",
    hostGeneration: buildHostGenerationBinding({
      hostName: "evidence-host",
      platform: "darwin",
      arch: "arm64",
      homeDir: "/Users/evidence",
      pathEnv: "/usr/bin",
      nodeVersion: "24.8.0",
      stateRoot: "/Users/evidence/.devspace",
      capabilityManifestSha256: "c".repeat(64),
      adapterGeneration: "local-agent:herdr:v1",
    }),
    authReadiness: "UNKNOWN",
  });
  const now = "2026-09-23T12:00:00.000Z";
  const evidenceWithoutIntegrity: Omit<DirectCandidateExecutionEvidence, "integrity"> = {
    schema: DIRECT_CANDIDATE_EXECUTION_SCHEMA,
    evidence_id: computeDirectCandidateEvidenceId({
      agentId: "agt_12345678",
      attemptId: intent.attemptId,
      commitSha: "a".repeat(40),
      diffHash: `sha256:${"b".repeat(64)}`,
    }),
    created_at: now,
    authority: {
      authority_mode: "OWNER_DIRECT",
      execution_lane: "DIRECT_DELEGATED",
      task_id: intent.taskId,
      attempt_id: intent.attemptId,
      dispatch_intent: intent,
      dispatch_intent_hash: intentHash,
      authority_ref: "James3014/devspace#231",
      core_authority_hash: `sha256:${intentHash}`,
    },
    execution: {
      protocol: EXECUTION_PROTOCOL_VERSION,
      execution_binding_hash: gen.executionBindingHash,
      agent_id: "agt_12345678",
      profile: "gemini-pro",
      provider: "gemini",
      model: "gemini-2.5-pro",
      effort: "high",
      provider_session_id: "sess_123456",
      execution_generation: gen,
      workspace_id: "ws_test_1",
      workspace_root: "/test/workspace",
      state: "completed",
      terminal_reason: "completed",
      retry_safe: false,
      reconciliation_required: false,
      scope_state: "WITHIN_SCOPE",
      started_at: "2026-09-23T11:50:00.000Z",
      completed_at: now,
    },
    core_binding: {
      session_id: `cms_${"c".repeat(32)}`,
      binding: {
        schema: "nexus.repository_mutation_binding.v1",
        binding_id: "bind-1",
      },
      binding_hash: `sha256:${"d".repeat(64)}`,
      acceptance_contract_hash: `sha256:${"e".repeat(64)}`,
    },
    candidate: {
      present: true,
      required: true,
      source_commit: "1".repeat(40),
      source_tree: "2".repeat(40),
      commit_sha: "a".repeat(40),
      tree_sha: "3".repeat(40),
      changed_paths: ["src/execution-protocol.ts"],
      deleted_paths: [],
      diff_hash: `sha256:${"b".repeat(64)}`,
      change_manifest: {
        source_tree: `git-tree:${"2".repeat(40)}`,
        target_tree: `git-tree:${"3".repeat(40)}`,
        entries: [{
          path: "src/execution-protocol.ts",
          change_type: "MODIFY",
          before_oid: "4".repeat(40),
          after_oid: "5".repeat(40),
          before_mode: "100644",
          after_mode: "100644",
        }],
      },
      provenance_created_at: now,
    },
    claim: {
      status: "CANDIDATE_CAPTURED_PENDING_CORE_VERIFICATION_AND_ACCEPTANCE",
      claim_ceiling: "CANDIDATE_READY",
      core_verified: false,
      certified: false,
      accepted: false,
      approved: false,
      merged: false,
      released: false,
      deployed: false,
      public_claim_allowed: false,
    },
  };
  return {
    ...evidenceWithoutIntegrity,
    integrity: {
      sha256: computeDirectCandidateEvidenceIntegrity(evidenceWithoutIntegrity),
    },
  };
}

test("DirectCandidateExecutionEvidence - valid exact direct evidence, deterministic identity, and integrity validation", () => {
  const evidence = sampleDirectEvidence();
  const validated = validateDirectCandidateExecutionEvidence(evidence);
  assert.equal(validated.schema, DIRECT_CANDIDATE_EXECUTION_SCHEMA);
  assert.equal(validated.evidence_id, evidence.evidence_id);
  assert.equal(validated.integrity.sha256, evidence.integrity.sha256);

  // Determinism
  const second = sampleDirectEvidence();
  assert.equal(evidence.evidence_id, second.evidence_id);
  assert.equal(evidence.integrity.sha256, second.integrity.sha256);
});

test("DirectCandidateExecutionEvidence - tampered integrity rejection", () => {
  const evidence = sampleDirectEvidence();
  const tampered = {
    ...evidence,
    integrity: { sha256: "0".repeat(64) },
  };
  assert.throws(
    () => validateDirectCandidateExecutionEvidence(tampered),
    (err: unknown) => err instanceof ExecutionProtocolError && err.code === "INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE" && /integrity\.sha256 mismatch/.test(err.message),
  );
});

test("DirectCandidateExecutionEvidence - wrong schema and claim ceiling rejection", () => {
  const evidence = sampleDirectEvidence();
  assert.throws(
    () => validateDirectCandidateExecutionEvidence({ ...evidence, schema: "wrong.schema.v1" }),
    (err: unknown) => err instanceof ExecutionProtocolError && err.code === "INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE" && /Invalid schema/.test(err.message),
  );

  const wrongCeiling = sampleDirectEvidence();
  wrongCeiling.claim.claim_ceiling = "IMPLEMENTED" as any;
  wrongCeiling.integrity.sha256 = computeDirectCandidateEvidenceIntegrity(wrongCeiling);
  assert.throws(
    () => validateDirectCandidateExecutionEvidence(wrongCeiling),
    (err: unknown) => err instanceof ExecutionProtocolError && err.code === "INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE" && /claim\.claim_ceiling must be CANDIDATE_READY/.test(err.message),
  );
});

test("DirectCandidateExecutionEvidence - invalid DispatchIntent and task/attempt mismatch rejection", () => {
  const evidence = sampleDirectEvidence();
  const badIntent = sampleDirectEvidence();
  (badIntent.authority.dispatch_intent as any).claimCeiling = "RESULT_RETURNED";
  badIntent.authority.dispatch_intent_hash = computeDispatchIntentHash(badIntent.authority.dispatch_intent);
  badIntent.authority.core_authority_hash = `sha256:${badIntent.authority.dispatch_intent_hash}`;
  badIntent.integrity.sha256 = computeDirectCandidateEvidenceIntegrity(badIntent);
  assert.throws(
    () => validateDirectCandidateExecutionEvidence(badIntent),
    (err: unknown) => err instanceof ExecutionProtocolError && err.code === "INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE" && /claimCeiling must be CANDIDATE_READY/.test(err.message),
  );

  const mismatchAttempt = sampleDirectEvidence();
  mismatchAttempt.authority.attempt_id = "attempt-mismatch";
  mismatchAttempt.integrity.sha256 = computeDirectCandidateEvidenceIntegrity(mismatchAttempt);
  assert.throws(
    () => validateDirectCandidateExecutionEvidence(mismatchAttempt),
    (err: unknown) => err instanceof ExecutionProtocolError && err.code === "INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE" && /authority task_id\/attempt_id does not match dispatch_intent/.test(err.message),
  );
});

test("DirectCandidateExecutionEvidence - malformed execution generation rejection", () => {
  const badGen = sampleDirectEvidence();
  (badGen.execution.execution_generation as any).provider = "tampered-provider";
  badGen.integrity.sha256 = computeDirectCandidateEvidenceIntegrity(badGen);
  assert.throws(
    () => validateDirectCandidateExecutionEvidence(badGen),
    (err: unknown) => err instanceof ExecutionProtocolError && err.code === "INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE" && /execution_generation\.executionBindingHash mismatch/.test(err.message),
  );

  const badHost = sampleDirectEvidence();
  (badHost.execution.execution_generation.hostGeneration as any).pathSha256 = "0".repeat(64);
  badHost.integrity.sha256 = computeDirectCandidateEvidenceIntegrity(badHost);
  assert.throws(
    () => validateDirectCandidateExecutionEvidence(badHost),
    (err: unknown) => err instanceof ExecutionProtocolError && err.code === "INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE" && /hostGeneration is invalid or self-inconsistent/.test(err.message),
  );
});

test("DirectCandidateExecutionEvidence - illegal positive authority flags rejection", () => {
  const forbiddenFlags: Array<keyof DirectCandidateExecutionEvidence["claim"]> = [
    "core_verified",
    "certified",
    "accepted",
    "approved",
    "merged",
    "released",
    "deployed",
    "public_claim_allowed",
  ];

  for (const flag of forbiddenFlags) {
    const evidence = sampleDirectEvidence();
    (evidence.claim as any)[flag] = true;
    evidence.integrity.sha256 = computeDirectCandidateEvidenceIntegrity(evidence);
    assert.throws(
      () => validateDirectCandidateExecutionEvidence(evidence),
      (err: unknown) => err instanceof ExecutionProtocolError && err.code === "INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE" && err.message.includes(`claim.${flag} must be false`),
      `Expected claim.${flag} to be rejected when true`,
    );
  }
});

test("DirectCandidateExecutionEvidence - forged or missing Candidate subject rejection", () => {
  const evidence = sampleDirectEvidence();
  const missingSubject = sampleDirectEvidence();
  (missingSubject.candidate as any).present = false;
  missingSubject.integrity.sha256 = computeDirectCandidateEvidenceIntegrity(missingSubject);
  assert.throws(
    () => validateDirectCandidateExecutionEvidence(missingSubject),
    (err: unknown) => err instanceof ExecutionProtocolError && err.code === "INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE" && /candidate present and required must be true/.test(err.message),
  );

  const dateMismatch = sampleDirectEvidence();
  dateMismatch.candidate.provenance_created_at = "2026-09-23T11:00:00.000Z";
  dateMismatch.integrity.sha256 = computeDirectCandidateEvidenceIntegrity(dateMismatch);
  assert.throws(
    () => validateDirectCandidateExecutionEvidence(dateMismatch),
    (err: unknown) => err instanceof ExecutionProtocolError && err.code === "INVALID_DIRECT_CANDIDATE_EXECUTION_EVIDENCE" && /created_at must equal candidate\.provenance_created_at/.test(err.message),
  );
});
