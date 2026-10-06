import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { LocalAgentStore } from "./local-agent-store.js";
import {
  LocalAgentSessionManager,
  AgentSessionError,
  computeModelAttestation,
} from "./local-agent-sessions.js";
import { buildLocalEffectEnforcementReceipt } from "./local-effect-enforcement.js";
import type { ExecutionContract } from "./local-agent-contract.js";
import type { DispatchIntent } from "./execution-protocol.js";

const mockProfiles = [
  {
    name: "direct-opus",
    description: "Opus profile",
    provider: "agy" as const,
    model: "claude-opus-4-6",
    write_mode: "allowed" as const,
    filePath: "<test>",
    body: "",
    disabled: false,
  },
  {
    name: "reviewer",
    description: "Reviewer profile",
    provider: "agy" as const,
    model: "claude-sonnet-4-6",
    write_mode: "read_only" as const,
    filePath: "<test>",
    body: "",
    disabled: false,
  },
];

function setupEnv() {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-p2-state-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "devspace-p2-project-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: projectRoot });
  writeFileSync(join(projectRoot, "README.md"), "# P2 Telemetry Test\n");
  execFileSync("git", ["add", "."], { cwd: projectRoot });
  execFileSync("git", ["commit", "-m", "init"], { cwd: projectRoot });

  const config = {
    stateDir,
    subagents: true,
    oauth: { scopes: ["devspace"] },
    agentExecutionBackend: "local",
    allowedRoots: [projectRoot],
    toolchains: [],
    agentMaxConcurrent: 4,
    port: 7676,
  } as any;

  const manager = new LocalAgentSessionManager(
    config,
    async () => {},
  );

  return {
    stateDir,
    projectRoot,
    manager,
    cleanup: () => {
      manager.close();
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

test("P2-F: DISPATCH_CONTRACT_REJECTED raised when attemptKey does not match dispatchIntent.attemptId", async () => {
  const { projectRoot, manager, cleanup } = setupEnv();
  try {
    const dispatchIntent: DispatchIntent = {
      taskId: "task-p2-1",
      attemptId: "att-expected-123",
      roleIntent: "EVIDENCE_COLLECTOR",
      objective: "read telemetry",
      writeScope: [],
      forbiddenChanges: [],
      acceptanceCriteria: ["reject mismatched attemptKey"],
      verificationRequired: false,
      expectedArtifacts: [],
      exclusiveOwnership: false,
      claimCeiling: "RESULT_RETURNED",
    };

    await assert.rejects(
      async () => {
        await manager.startAgent({
          workspaceId: "ws_p2_1",
          workspaceRoot: projectRoot,
          profileName: "reviewer",
          prompt: "check contract mismatch",
          profiles: mockProfiles,
          attemptKey: "att-DIFFERENT-456",
          executionContract: { dispatchIntent },
        });
      },
      (err: any) => {
        assert.ok(err instanceof AgentSessionError, "must be AgentSessionError");
        assert.equal(err.code, "DISPATCH_CONTRACT_REJECTED");
        assert.match(err.message, /attemptKey.*does not match/);
        assert.match(err.message, /provider_effect=false/);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("P2-F: DISPATCH_CONTRACT_REJECTED raised when dispatch and execution write scopes disagree", async () => {
  const { projectRoot, manager, cleanup } = setupEnv();
  try {
    const dispatchIntent: DispatchIntent = {
      taskId: "task-p2-2",
      attemptId: "att-scope-mismatch-123",
      roleIntent: "MECHANICAL_EXECUTOR",
      objective: "mutate code",
      writeScope: ["README.md"],
      forbiddenChanges: [],
      acceptanceCriteria: ["scope must match"],
      verificationRequired: true,
      expectedArtifacts: [],
      exclusiveOwnership: true,
      claimCeiling: "IMPLEMENTED",
    };

    await assert.rejects(
      async () => {
        await manager.startAgent({
          workspaceId: "ws_p2_2",
          workspaceRoot: projectRoot,
          profileName: "direct-opus",
          prompt: "mismatched scope",
          profiles: mockProfiles,
          attemptKey: "att-scope-mismatch-123",
          executionContract: {
            dispatchIntent,
            writePaths: ["src/other.ts"],
          },
        });
      },
      (err: any) => {
        assert.ok(err instanceof AgentSessionError);
        assert.equal(err.code, "DISPATCH_CONTRACT_REJECTED");
        assert.match(err.message, /writeScope must exactly match/);
        assert.match(err.message, /provider_effect=false/);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("P2-A: requested/resolved metadata is not fabricated as physical model attestation", async () => {
  const { projectRoot, manager, cleanup } = setupEnv();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_p2_3",
      workspaceRoot: projectRoot,
      profileName: "direct-opus",
      prompt: "smoke test",
      profiles: mockProfiles,
      attemptKey: "att-opus-smoke",
      executionContract: {
        directSelection: {
          provider: "agy",
          model: "claude-opus-4-6",
          writeMode: "allowed",
        },
      },
    });

    const status = await manager.getAgentStatus({
      workspaceId: "ws_p2_3",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
    });

    assert.ok(status.modelAttestation);
    assert.equal(status.modelAttestation.requestedModel, "claude-opus-4-6");
    assert.equal(status.modelAttestation.resolvedModel, "claude-opus-4-6");
    assert.equal(status.modelAttestation.observedModel, null);
    assert.equal(status.modelAttestation.attestationSource, "metadata_only");
    assert.equal(status.modelAttestation.attestationState, "ATTESTATION_UNAVAILABLE");
  } finally {
    cleanup();
  }
});

test("P2-D: Dispatcher heartbeat is separated from providerProcessState and timeline", async () => {
  const { projectRoot, manager, cleanup } = setupEnv();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_p2_4",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      prompt: "heartbeat check",
      profiles: mockProfiles,
      attemptKey: "att-heartbeat-check",
    });

    const status = await manager.getAgentStatus({
      workspaceId: "ws_p2_4",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
    });

    assert.equal(status.dispatcherHeartbeatAt, undefined, "updatedAt must not be aliased as a dispatcher heartbeat");
    assert.equal(status.providerProcessState, "unknown", "heartbeat/status must not fabricate physical provider liveness");
    assert.ok(status.operationTimeline, "operationTimeline must be populated");
    assert.ok(status.operationTimeline.queuedAt, "queuedAt must be populated");
    assert.equal(status.operationTimeline.providerStartedAt, undefined, "createdAt is not provider-start evidence");
  } finally {
    cleanup();
  }
});

test("P2-E: Quota exhaustion failure classification distinguishes pre-effect from post-effect", async () => {
  const { projectRoot, manager, cleanup } = setupEnv();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_p2_5",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      prompt: "quota failure check",
      profiles: mockProfiles,
      attemptKey: "att-quota-failure-check",
    });

    const store = (manager as any).store as LocalAgentStore;

    // Positive no-effect evidence (WITHIN_SCOPE, no changed paths) => safe pre-effect classification
    (store as any).database.sqlite.prepare(
      "update local_agent_sessions set status='error', error_code='PROVIDER_CAPACITY_ERROR', error='429 Rate limit exceeded / daily quota exhausted', scope_state='WITHIN_SCOPE' where id=?"
    ).run(started.agentId);

    let status = await manager.getAgentStatus({
      workspaceId: "ws_p2_5",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
    });

    assert.ok(status.dispatchFailure);
    assert.equal(status.dispatchFailure.failureClass, "PROVIDER_QUOTA_EXHAUSTED_PRE_EFFECT");
    assert.equal(status.dispatchFailure.providerEffect, false);

    // Unknown scope: no proof of "no effect" => must NOT be offered as a clean retry
    (store as any).database.sqlite.prepare(
      "update local_agent_sessions set scope_state='UNKNOWN' where id=?"
    ).run(started.agentId);
    status = await manager.getAgentStatus({
      workspaceId: "ws_p2_5",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
    });
    assert.equal(status.dispatchFailure?.failureClass, "PROVIDER_QUOTA_EXHAUSTED_AFTER_EFFECT");
    assert.equal(status.dispatchFailure?.providerEffect, true);

    // Now simulate quota error with source effect (after mutating files)
    const lifecycle = JSON.stringify({
      cumulativeChangedPaths: ["src/modified.ts"],
    });
    (store as any).database.sqlite.prepare(
      "update local_agent_sessions set status='error', error_code='PROVIDER_CAPACITY_ERROR', error='429 Rate limit exceeded after partial file edits', lifecycle_state=? where id=?"
    ).run(lifecycle, started.agentId);

    status = await manager.getAgentStatus({
      workspaceId: "ws_p2_5",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
    });

    assert.ok(status.dispatchFailure);
    assert.equal(status.dispatchFailure.failureClass, "PROVIDER_QUOTA_EXHAUSTED_AFTER_EFFECT");
    assert.equal(status.dispatchFailure.providerEffect, true);
  } finally {
    cleanup();
  }
});

test("P2-E2: failure taxonomy preserves distinct control-plane/provider states", async () => {
  const { projectRoot, manager, cleanup } = setupEnv();
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_p2_taxonomy",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      prompt: "taxonomy check",
      profiles: mockProfiles,
      attemptKey: "att-taxonomy-check",
    });
    const store = (manager as any).store as LocalAgentStore;
    const sqlite = (store as any).database.sqlite;

    // [errorCode, message, effect knowledge, expected class, expected providerEffect]
    // Messages deliberately contain misleading keywords: classification must use errorCode only.
    const cases = [
      ["WORKTREE_LEASE_CONFLICT", "anything", "none", "WORKTREE_LEASE_CONFLICT", false],
      ["DUPLICATE_EFFECT_SUPPRESSED", "anything", "none", "DUPLICATE_EFFECT_SUPPRESSED", false],
      ["RECONCILIATION_REQUIRED", "anything", "none", "TRANSPORT_LOST_ACK", false],
      ["RECONCILIATION_REQUIRED", "anything", "present", "EFFECT_OUTCOME_UNKNOWN", true],
      ["RECONCILIATION_REQUIRED", "anything", "unknown", "EFFECT_OUTCOME_UNKNOWN", true],
      ["PROVIDER_AUTH_ERROR", "author field", "none", "PROVIDER_AUTH_ERROR", false],
      ["WORKER_LAUNCH_FAILED", "anything", "none", "PROVIDER_STARTUP_FAILED", false],
      ["PROVIDER_TIMEOUT", "permission denied scope", "none", "PROVIDER_EXECUTION_FAILED", false],
      ["PROVIDER_EXECUTION_ERROR", "quota", "none", "PROVIDER_EXECUTION_FAILED", false],
      ["PROVIDER_PROTOCOL_ERROR", "quota exhausted after partial edits", "none", "PROVIDER_EXECUTION_FAILED", false],
      ["PROVIDER_PROTOCOL_ERROR", "authentication succeeded with no changes", "unknown", "PROVIDER_EXECUTION_FAILED", true],
      ["PROVIDER_PROTOCOL_ERROR", "preflight rejected before provider start", "present", "PROVIDER_EXECUTION_FAILED", true],
      ["PROVIDER_CANCELLED", "quota exhausted after partial edits", "none", "PROVIDER_EXECUTION_FAILED", false],
      ["CLINEPASS_ENTITLEMENT_REQUIRED", "provider unavailable after partial edits", "unknown", "PROVIDER_AUTH_ERROR", true],
      ["VERIFIER_PLAN_PERSIST_FAILED", "anything", "none", "INTERNAL_CONTROL_PLANE_ERROR", false],
      ["SOME_UNMAPPED_CODE", "provider quota 429 auth denied", "none", "UNKNOWN", false],
      ["SOME_UNMAPPED_CODE", "anything", "unknown", "UNKNOWN", true],
    ] as const;

    for (const [errorCode, error, effect, expectedClass, expectedEffect] of cases) {
      const lifecycle = JSON.stringify({
        cumulativeChangedPaths: effect === "present" ? ["src/partial.ts"] : [],
      });
      const scopeState = effect === "none" ? "WITHIN_SCOPE" : effect === "unknown" ? "UNKNOWN" : "WITHIN_SCOPE";
      sqlite.prepare(
        "update local_agent_sessions set status='error', error_code=?, error=?, lifecycle_state=?, scope_state=? where id=?",
      ).run(errorCode, error, lifecycle, scopeState, started.agentId);
      const status = await manager.getAgentStatus({
        workspaceId: "ws_p2_taxonomy",
        workspaceRoot: projectRoot,
        agentId: started.agentId,
      });
      assert.ok(status.dispatchFailure, `${errorCode}/${effect}`);
      assert.equal(status.dispatchFailure.failureClass, expectedClass, `${errorCode}/${effect}`);
      assert.equal(status.dispatchFailure.providerEffect, expectedEffect, `${errorCode}/${effect}`);
    }
  } finally {
    cleanup();
  }
});

test("P2-G: Effect policy enforcement status accurately distinguishes request_only from enforced", async () => {
  const { projectRoot, manager, cleanup } = setupEnv();
  try {
    // 1. Started with advisory effect projection and toolProjectionManifest
    const contract: ExecutionContract = {
      authorizedToolCeiling: [],
      effectProjection: {
        schema: "devspace.local_effect_projection.v1",
        process: { mode: "DENY" },
        network: { egress: "DENY" },
        git: { mode: "DENY" },
      },
      toolProjectionManifest: {
        schema: "devspace.tool_projection_manifest.v1",
        namespace: "devspace.tool_intent.v1",
        identity: { taskId: "task-1", attemptId: "att-effect-policy-check" },
        authority: { mode: "OWNER_DIRECT", issuer: "owner" },
        authorizedToolCeiling: [],
        candidateTools: [],
        selectedTools: [],
        orderingMode: "ORDER_INDEPENDENT",
      },
    };

    const started = await manager.startAgent({
      workspaceId: "ws_p2_6",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      prompt: "effect policy check",
      profiles: mockProfiles,
      attemptKey: "att-effect-policy-check",
      executionContract: contract,
    });

    let status = await manager.getAgentStatus({
      workspaceId: "ws_p2_6",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
    });

    assert.ok(status.effectPolicyStatus);
    assert.equal(status.effectPolicyStatus.overallEnforcement, "REQUEST_ONLY_NOT_ENFORCED");
    assert.equal(status.effectPolicyStatus.process, "request_only");
    assert.equal(status.effectPolicyStatus.network, "request_only");
    assert.equal(status.effectPolicyStatus.git, "request_only");

    // 2. Simulated with physically enforced receipt
    const store = (manager as any).store as LocalAgentStore;
    const receipt = buildLocalEffectEnforcementReceipt({
      provider: "omp",
      model: "claude-sonnet-4-6",
      writeMode: "read_only",
      selectedToolIntents: [],
      writePaths: [],
      effectProjection: {
        schema: "devspace.local_effect_projection.v1",
        process: { mode: "DENY" },
        network: { egress: "DENY" },
        git: { mode: "DENY" },
      },
      enforcementSurface: {},
    });
    const lifecycle = JSON.stringify({
      lastEffectEnforcementReceipt: receipt,
    });
    (store as any).database.sqlite.prepare(
      "update local_agent_sessions set lifecycle_state=? where id=?"
    ).run(lifecycle, started.agentId);

    status = await manager.getAgentStatus({
      workspaceId: "ws_p2_6",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
    });

    assert.ok(status.effectPolicyStatus);
    assert.equal(status.effectPolicyStatus.overallEnforcement, "PHYSICALLY_ENFORCED");
    assert.equal(status.effectPolicyStatus.process, "enforced");
    assert.equal(status.effectPolicyStatus.network, "enforced");
    assert.equal(status.effectPolicyStatus.git, "enforced");
  } finally {
    cleanup();
  }
});

test("P2 follow-up (Item A): model attestation compares provider-reported identity with requested model", async () => {
  const { projectRoot, manager, cleanup } = setupEnv();
  try {
    // 1. Pure function tests
    const mismatch = computeModelAttestation({
      requestedModel: "claude-opus-4-6",
      resolvedModel: "claude-opus-4-6",
      observedModel: "gemini-3.8-flash",
      attestationSource: "provider_reported",
      attestedAt: "2026-10-05T00:00:00.000Z",
    });
    assert.equal(mismatch.attestationState, "MODEL_ATTESTATION_MISMATCH");
    assert.equal(mismatch.observedModel, "gemini-3.8-flash");
    assert.equal(mismatch.requestedModel, "claude-opus-4-6");
    assert.equal(mismatch.attestationSource, "provider_reported");

    const match = computeModelAttestation({
      requestedModel: "claude-opus-4-6",
      resolvedModel: "claude-opus-4-6",
      observedModel: "claude-opus-4-6",
      attestationSource: "claude_stream",
    });
    assert.equal(match.attestationState, "MATCH");
    assert.equal(match.observedModel, "claude-opus-4-6");

    const unavailable = computeModelAttestation({
      requestedModel: "claude-opus-4-6",
      resolvedModel: "claude-opus-4-6",
      observedModel: null,
    });
    assert.equal(unavailable.attestationState, "ATTESTATION_UNAVAILABLE");

    // 2. Integration via store finishTurnCAS
    const store = (manager as any).store as LocalAgentStore;
    const started = await manager.startAgent({
      workspaceId: "ws_p2_attest",
      workspaceRoot: projectRoot,
      profileName: "direct-opus",
      prompt: "attestation test",
      profiles: mockProfiles,
      attemptKey: "att-attest-test",
    });

    const current = store.getById(started.agentId)!;
    const generation = current.lifecycleState?.activeTurn?.generation;
    assert.ok(generation);
    const workerToken = "tok-attest";
    store.prepareWorkerCAS(started.agentId, generation, workerToken);
    store.claimWorkerCAS(started.agentId, generation, workerToken, 99999);
    store.markExecutionStarted(started.agentId, workerToken);
    store.finishTurnCAS({
      agentId: started.agentId,
      generation,
      workerToken,
      status: "idle",
      modelAttestation: mismatch,
      providerProcessState: "not_running",
    });

    const status = await manager.getAgentStatus({
      workspaceId: "ws_p2_attest",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
    });

    assert.ok(status.modelAttestation);
    assert.equal(status.modelAttestation.attestationState, "MODEL_ATTESTATION_MISMATCH");
    assert.equal(status.modelAttestation.observedModel, "gemini-3.8-flash");
    assert.equal(status.modelAttestation.requestedModel, "claude-opus-4-6");
    assert.equal(status.modelAttestation.attestationSource, "provider_reported");
  } finally {
    cleanup();
  }
});

test("P2 follow-up (Item H): stream activity and first effect update activeTurn and persist to operationTimeline", async () => {
  const { projectRoot, manager, cleanup } = setupEnv();
  try {
    const store = (manager as any).store as LocalAgentStore;
    const started = await manager.startAgent({
      workspaceId: "ws_p2_stream",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      prompt: "stream timeline test",
      profiles: mockProfiles,
      attemptKey: "att-stream-timeline-test",
    });

    // Before execution started
    let rec = store.getById(started.agentId)!;
    assert.ok(rec.lifecycleState?.operationTimeline?.queuedAt);
    assert.equal(rec.lifecycleState?.operationTimeline?.providerStartedAt, undefined);

    const generation = rec.lifecycleState?.activeTurn?.generation;
    assert.ok(generation);
    const workerToken = "tok-stream";
    store.prepareWorkerCAS(started.agentId, generation, workerToken);
    store.claimWorkerCAS(started.agentId, generation, workerToken, process.pid);

    // Provider started
    store.markExecutionStarted(started.agentId, workerToken);
    rec = store.getById(started.agentId)!;
    assert.ok(rec.lifecycleState?.operationTimeline?.providerStartedAt);
    const startedAt = rec.lifecycleState!.operationTimeline!.providerStartedAt;

    // Stream activity
    store.touchStreamActivityCAS(started.agentId, generation, workerToken);
    rec = store.getById(started.agentId)!;
    assert.ok(rec.lifecycleState?.operationTimeline?.firstStreamActivityAt);
    assert.ok(rec.lifecycleState?.activeTurn?.providerStreamLastActivityAt);
    const streamAt = rec.lifecycleState!.operationTimeline!.firstStreamActivityAt;

    // Subsequent stream activity touches lastActivityAt without overriding firstStreamActivityAt
    store.touchStreamActivityCAS(started.agentId, generation, workerToken);
    rec = store.getById(started.agentId)!;
    assert.equal(rec.lifecycleState!.operationTimeline!.firstStreamActivityAt, streamAt);

    // First effect
    store.recordFirstEffectCAS(started.agentId, generation, workerToken);
    rec = store.getById(started.agentId)!;
    assert.ok(rec.lifecycleState?.operationTimeline?.firstEffectAt);
    assert.ok(rec.lifecycleState?.activeTurn?.firstEffectAt);
    const effectAt = rec.lifecycleState!.operationTimeline!.firstEffectAt;

    // Subsequent effect calls do not overwrite firstEffectAt
    store.recordFirstEffectCAS(started.agentId, generation, workerToken);
    rec = store.getById(started.agentId)!;
    assert.equal(rec.lifecycleState!.operationTimeline!.firstEffectAt, effectAt);

    // Reconciled
    store.recordReconciledAtCAS(started.agentId);
    rec = store.getById(started.agentId)!;
    assert.ok(rec.lifecycleState?.operationTimeline?.reconciledAt);

    // Terminal finish
    store.finishTurnCAS({
      agentId: started.agentId,
      generation,
      workerToken,
      status: "idle",
      providerProcessState: "not_running",
    });

    const status = await manager.getAgentStatus({
      workspaceId: "ws_p2_stream",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
    });

    assert.ok(status.operationTimeline);
    assert.equal(status.operationTimeline.providerStartedAt, startedAt);
    assert.equal(status.operationTimeline.firstStreamActivityAt, streamAt);
    assert.equal(status.operationTimeline.firstEffectAt, effectAt);
    assert.ok(status.operationTimeline.reconciledAt);
    assert.ok(status.operationTimeline.terminalAt);
  } finally {
    cleanup();
  }
});

test("P2 follow-up (Item D/H): supervisor writes heartbeat/effect evidence without treating workerPid as providerPid", async () => {
  const { projectRoot, manager, cleanup } = setupEnv();
  try {
    const store = (manager as any).store as LocalAgentStore;
    const started = await manager.startAgent({
      workspaceId: "ws_p2_proc",
      workspaceRoot: projectRoot,
      profileName: "direct-opus",
      prompt: "proc/effect evidence test",
      profiles: mockProfiles,
      attemptKey: "att-proc-probe-test",
      executionContract: {
        writePaths: ["README.md"],
        maxFiles: 1,
      },
    });

    const current = store.getById(started.agentId)!;
    const generation = current.lifecycleState?.activeTurn?.generation;
    assert.ok(generation);
    const workerToken = "tok-proc";
    store.prepareWorkerCAS(started.agentId, generation, workerToken);
    store.claimWorkerCAS(started.agentId, generation, workerToken, process.pid);
    store.markExecutionStarted(started.agentId, workerToken);
    const baselineHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    store.updateTurnEvidenceCAS(started.agentId, generation, workerToken, {
      scopeBaseline: {
        changedPaths: [],
        head: baselineHead,
        fingerprints: {},
      },
    });

    let status = await manager.getAgentStatus({
      workspaceId: "ws_p2_proc",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
    });
    assert.equal(
      status.providerProcessState,
      "unknown",
      "DevSpace workerPid is not positive evidence of the provider process",
    );
    assert.equal(status.dispatcherHeartbeatAt, undefined);

    writeFileSync(join(projectRoot, "README.md"), "# P2 Telemetry Test\nprovider effect\n");
    await manager.superviseActiveAgents();

    status = await manager.getAgentStatus({
      workspaceId: "ws_p2_proc",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
    });
    assert.ok(status.dispatcherHeartbeatAt, "supervision must write a real dispatcher heartbeat");
    assert.ok(status.operationTimeline?.firstEffectAt, "physical source delta must write firstEffectAt");
    assert.equal(
      status.providerProcessState,
      "unknown",
      "heartbeat/source evidence must not fabricate provider process liveness",
    );

    store.finishTurnCAS({
      agentId: started.agentId,
      generation,
      workerToken,
      status: "idle",
    });

    status = await manager.getAgentStatus({
      workspaceId: "ws_p2_proc",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
    });
    assert.equal(status.providerProcessState, "unknown");
  } finally {
    cleanup();
  }
});

test("P2 follow-up (Item E): durable dispatchFailure is persisted into database record at settlement", async () => {
  const { projectRoot, manager, cleanup } = setupEnv();
  try {
    const store = (manager as any).store as LocalAgentStore;
    const started = await manager.startAgent({
      workspaceId: "ws_p2_fail",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      prompt: "fail check",
      profiles: mockProfiles,
      attemptKey: "att-fail-persist-check",
    });

    const current = store.getById(started.agentId)!;
    const generation = current.lifecycleState?.activeTurn?.generation;
    assert.ok(generation);
    const workerToken = "tok-fail";
    store.prepareWorkerCAS(started.agentId, generation, workerToken);
    store.claimWorkerCAS(started.agentId, generation, workerToken, 99999);
    store.markExecutionStarted(started.agentId, workerToken);

    const dispatchFailure = {
      failureCode: "PROVIDER_CAPACITY_ERROR",
      failureClass: "PROVIDER_QUOTA_EXHAUSTED_AFTER_EFFECT" as const,
      retryable: false,
      providerEffect: true,
      phase: "execution" as const,
      detail: "Daily quota exhausted after modifying code",
      classifiedAt: new Date().toISOString(),
    };

    store.failTurnCAS({
      agentId: started.agentId,
      generation,
      workerToken,
      error: "Daily quota exhausted after modifying code",
      errorCode: "PROVIDER_CAPACITY_ERROR",
      errorRetryable: false,
      dispatchFailure,
      providerProcessState: "not_running",
    });

    // 1. Verify on LocalAgentRecord
    const record = store.getById(started.agentId)!;
    assert.ok(record.lifecycleState?.dispatchFailure);
    assert.deepEqual(record.lifecycleState.dispatchFailure, dispatchFailure);

    // 2. Verify in raw SQLite database row
    const row = (store as any).database.sqlite.prepare(
      "select lifecycle_state from local_agent_sessions where id=?"
    ).get(started.agentId) as { lifecycle_state: string };
    const parsed = JSON.parse(row.lifecycle_state);
    assert.ok(parsed.dispatchFailure);
    assert.equal(parsed.dispatchFailure.failureClass, "PROVIDER_QUOTA_EXHAUSTED_AFTER_EFFECT");
    assert.equal(parsed.dispatchFailure.providerEffect, true);

    // 3. Verify in getAgentStatus
    const status = await manager.getAgentStatus({
      workspaceId: "ws_p2_fail",
      workspaceRoot: projectRoot,
      agentId: started.agentId,
    });
    assert.ok(status.dispatchFailure);
    assert.deepEqual(status.dispatchFailure, dispatchFailure);
  } finally {
    cleanup();
  }
});
