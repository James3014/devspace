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
