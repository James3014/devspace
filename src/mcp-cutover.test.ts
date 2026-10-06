import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CutoverStateStore } from "./cutover-state.js";
import { CUTOVER_SAFE_TOOLS, CONSEQUENTIAL_MCP_TOOLS, classifyCutoverEffect, McpCutoverController, type DurableReconciliationWitness } from "./mcp-cutover.js";

const identity = (serverInstanceId: string, sourceCommit: string, buildId: string, capability = "cap") => ({
  serverInstanceId,
  sourceCommit,
  buildId,
  capabilityManifestSha256: capability,
});

test("old instance drains and replacement instance is reconcile-only across restart", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-mcp-cutover-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-one" });
    const old = new McpCutoverController(store, identity("old", "old-source", "old-build"));
    const binding={leaseId:"lease",pinnedLeaseVersion:2,operationHandle:"operation",requestHash:"a".repeat(64),ownerThread:"controller"};
    old.begin({ sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" },undefined,binding);
    assert.deepEqual(old.record()?.coordinationBinding,binding);
    assert.equal(old.mode(), "drain");
    assert.doesNotThrow(() => old.assertToolAllowed("write"));
    assert.doesNotThrow(() => old.assertToolAllowed("workspace_verify"));
    assert.doesNotThrow(() => old.assertToolAllowed("read"));
    assert.doesNotThrow(() => old.assertToolAllowed("cutover_status"));
    assert.doesNotThrow(() => old.assertToolAllowed("agent_status"));
    assert.doesNotThrow(() => old.assertToolAllowed("agent_reconcile"));
    assert.doesNotThrow(() => old.assertToolAllowed("remote_writability_probe"));
    for (const tool of ["chat_swarm_create", "chat_swarm_join", "chat_swarm_dispatch", "chat_swarm_close"]) {
      assert.doesNotThrow(() => old.assertToolAllowed(tool));
    }
    assert.throws(() => old.assertToolAllowed("storage_gc"), /CUTOVER_RECONCILIATION_REQUIRED/);
    assert.throws(() => old.assertToolAllowed("deployment_activate_next"), /CUTOVER_RECONCILIATION_REQUIRED/);
    // `next` is admitted to the handler because it must distinguish a
    // worker's already-owned task from a new claim.
    assert.doesNotThrow(() => old.assertToolAllowed("chat_swarm_next"));
    for (const tool of ["chat_swarm_submit", "chat_swarm_status", "chat_swarm_collect", "chat_swarm_reconcile", "chat_swarm_cancel"]) {
      assert.doesNotThrow(() => old.assertToolAllowed(tool));
    }

    const replacement = new McpCutoverController(
      new CutoverStateStore(stateDir),
      identity("new", "new-source", "new-build"),
    );
    assert.equal(replacement.mode(), "reconcile-only");
    assert.deepEqual(replacement.record()?.coordinationBinding,binding);
    assert.equal(replacement.canInitializeTransport(), true);
    assert.throws(
      () => replacement.recordDrain("cutover-one", { activeSessions: 0, oldestAgeMs: 0 }),
      /only the old server instance/i,
    );
    assert.doesNotThrow(() => replacement.assertToolAllowed("agent_start"));
    assert.throws(() => replacement.assertToolAllowed("bash"), /CUTOVER_RECONCILIATION_REQUIRED/);
    assert.doesNotThrow(() => replacement.assertToolAllowed("chat_swarm_create"));
    assert.throws(() => replacement.assertToolAllowed("storage_gc"), /CUTOVER_RECONCILIATION_REQUIRED/);
    assert.doesNotThrow(() => replacement.assertToolAllowed("chat_swarm_next"));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("finish fails closed for old/wrong identities and closes exact cutover idempotently", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-mcp-finish-"));
  try {
    const store = new CutoverStateStore(stateDir, {
      newId: (() => { let n = 0; return () => `cutover-${n += 1}`; })(),
    });
    const old = new McpCutoverController(store, identity("old", "old-source", "old-build"));
    old.begin({ sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" });
    const witness = async () => ({
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
    });

    await assert.rejects(
      new McpCutoverController(store, identity("new", "new-source", "new-build")).finish("cutover-1", witness),
      /durable drain evidence/i,
    );
    old.recordDrain("cutover-1", { activeSessions: 1, oldestAgeMs: 10 });
    await assert.rejects(
      new McpCutoverController(store, identity("old", "new-source", "new-build")).finish("cutover-1", witness),
      /serverInstanceId did not change/,
    );
    await assert.rejects(
      new McpCutoverController(store, identity("new", "wrong-source", "new-build")).finish("cutover-1", witness),
      /sourceCommit/,
    );
    await assert.rejects(
      new McpCutoverController(store, identity("new", "new-source", "wrong-build")).finish("cutover-1", witness),
      /buildId/,
    );
    await assert.rejects(
      new McpCutoverController(store, identity("new", "new-source", "new-build", "wrong-cap")).finish("cutover-1", witness),
      /capability manifest/,
    );
    assert.equal(store.get()?.phase, "drained");

    const expected = new McpCutoverController(store, identity("new", "new-source", "new-build"));
    const closed = await expected.finish("cutover-1", witness);
    assert.equal(closed.phase, "closed");
    assert.equal((await expected.finish("cutover-1", witness)).phase, "closed");
    assert.equal(expected.mode(), "normal");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("restart authority is drain-bound, idempotent, and cannot transfer to replacement instance", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-mcp-restart-authority-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-restart" });
    const old = new McpCutoverController(store, identity("old", "old-source", "old-build"));
    old.begin({ sourceCommit: "new-source", buildId: "new-build" });
    assert.throws(() => old.requestRestart("cutover-restart"), /must be drained/i);

    old.recordDrain("cutover-restart", { activeSessions: 1, oldestAgeMs: 100 });
    assert.equal(old.requestRestart("cutover-restart").newlyRequested, true);
    assert.equal(old.requestRestart("cutover-restart").newlyRequested, false);

    const replacement = new McpCutoverController(
      new CutoverStateStore(stateDir),
      identity("new", "new-source", "new-build"),
    );
    assert.throws(
      () => replacement.requestRestart("cutover-restart"),
      /only the old server instance/i,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("markRestartScheduled is owner-bound, attestation-gated, idempotent, and fail-closed", () => {
  const ungatedDir = mkdtempSync(join(tmpdir(), "devspace-mcp-mark-ungated-"));
  try {
    const store = new CutoverStateStore(ungatedDir, { newId: () => "cutover-ungated" });
    const old = new McpCutoverController(store, identity("old", "old-source", "old-build"));
    old.begin({ sourceCommit: "new-source", buildId: "new-build" });
    assert.throws(
      () => old.markRestartScheduled("cutover-ungated"),
      /requires a drained cutover/i,
    );

    old.recordDrain("cutover-ungated", { activeSessions: 1, oldestAgeMs: 100 });
    old.requestRestart("cutover-ungated");
    assert.throws(
      () => old.markRestartScheduled("cutover-ungated"),
      /build-ready attestation/i,
    );
    assert.throws(
      () => old.markRestartScheduled("cutover-ungated"),
      /CUTOVER_BUILD_NOT_READY/i,
    );
    assert.equal(old.record()?.restartRequest?.restartScheduledAt, undefined);

    const aGatedDir = mkdtempSync(join(tmpdir(), "devspace-mcp-mark-gated-"));
    try {
      const gatedStore = new CutoverStateStore(aGatedDir, { newId: () => "cutover-gated" });
      const gated = new McpCutoverController(gatedStore, identity("old", "old-source", "old-build"));
      gated.begin({ sourceCommit: "new-source", buildId: "new-build" });
      gated.recordDrain("cutover-gated", { activeSessions: 1, oldestAgeMs: 100 });
      gated.requestRestart("cutover-gated", {
        verifiedBy: "op",
        verifiedAt: new Date().toISOString(),
      });
      assert.equal(gated.markRestartScheduled("cutover-gated").newlyScheduled, true);
      assert.equal(gated.markRestartScheduled("cutover-gated").newlyScheduled, false);
      assert.equal(
        gated.record()?.restartRequest?.restartScheduledForServerInstanceId,
        "old",
      );

      const replacement = new McpCutoverController(
        new CutoverStateStore(aGatedDir),
        identity("new", "new-source", "new-build"),
      );
      assert.throws(
        () => replacement.markRestartScheduled("cutover-gated"),
        /only the old server instance/i,
      );
    } finally {
      rmSync(aGatedDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(ungatedDir, { recursive: true, force: true });
  }
});

test("finish requires a real positive durable reconciliation witness", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-mcp-witness-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-witness" });
    const old = new McpCutoverController(store, identity("old", "old", "old-build"));
    old.begin({ sourceCommit: "new", buildId: "new-build" });
    old.recordDrain("cutover-witness", { activeSessions: 1, oldestAgeMs: 10 });
    const current = new McpCutoverController(store, identity("new", "new", "new-build"));
    await assert.rejects(
      current.finish("cutover-witness", async () => ({
        workspaceQueryable: true,
        agentQueryable: false,
        agentReconciled: false,
      })),
      /durable agent.*reconciliation/i,
    );
    assert.equal(current.mode(), "reconcile-only");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("recoverCutover supersedes only when the old owner and target are both gone", () => {
  const eligibleDir = mkdtempSync(join(tmpdir(), "devspace-mcp-recover-eligible-"));
  try {
    const store = new CutoverStateStore(eligibleDir, {
      newId: (() => { let n = 0; return () => `cutover-${n += 1}`; })(),
    });
    const old = new McpCutoverController(store, identity("old", "old-source", "old-build"));
    old.begin({ sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" });

    // The original drain-lease owner is still running: not recoverable.
    assert.throws(
      () => old.recoverCutover({
        cutoverId: "cutover-1",
        expectedNewIdentity: { sourceCommit: "target-source", buildId: "target-build" },
      }),
      /original drain-lease owner is still running/i,
    );

    // A replacement runtime that already matches the bound target: normal finish applies.
    const atTarget = new McpCutoverController(store, identity("new", "new-source", "new-build", "cap"));
    assert.throws(
      () => atTarget.recoverCutover({
        cutoverId: "cutover-1",
        expectedNewIdentity: { sourceCommit: "target-source", buildId: "target-build" },
      }),
      /already matches the bound expected target/i,
    );

    // A distinct control-plane runtime with neither the old identity nor the target.
    const recovering = new McpCutoverController(store, identity("reconciler", "old-source", "old-build"));
    const recovered = recovering.recoverCutover({
      cutoverId: "cutover-1",
      expectedNewIdentity: { sourceCommit: "target-source", buildId: "target-build", capabilityManifestSha256: "cap2" },
    });
    assert.equal(recovered.newlyRecovered, true);
    assert.equal(recovered.terminal.phase, "superseded");
    assert.equal(recovered.terminal.supersession?.recoveredBy, "reconciler");
    assert.ok(recovered.successor);
    assert.equal(recovered.successor.supersedesCutoverId, "cutover-1");
    assert.equal(recovered.successor.expectedNewIdentity.sourceCommit, "target-source");
    assert.equal(recovering.mode(), "reconcile-only");

  } finally {
    rmSync(eligibleDir, { recursive: true, force: true });
  }
});

test("recoverCutover is idempotent, rejects wrong ids, and never touches a closed cutover", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-mcp-recover-idempotent-"));
  try {
    const store = new CutoverStateStore(stateDir, {
      newId: (() => { let n = 0; return () => `cutover-${n += 1}`; })(),
    });
    const old = new McpCutoverController(store, identity("old", "old-source", "old-build"));
    old.begin({ sourceCommit: "new-source", buildId: "new-build" });
    const recovering = new McpCutoverController(store, identity("reconciler", "old-source", "old-build"));

    assert.throws(
      () => recovering.recoverCutover({
        cutoverId: "some-other-id",
        expectedNewIdentity: { sourceCommit: "target-source", buildId: "target-build" },
      }),
      /mismatch/i,
    );

    const first = recovering.recoverCutover({
      cutoverId: "cutover-1",
      expectedNewIdentity: { sourceCommit: "target-source", buildId: "target-build" },
    });
    assert.equal(first.newlyRecovered, true);
    assert.ok(first.successor);
    const second = recovering.recoverCutover({
      cutoverId: "cutover-1",
      expectedNewIdentity: { sourceCommit: "target-source", buildId: "target-build" },
    });
    assert.equal(second.newlyRecovered, false);
    assert.ok(second.successor);
    assert.equal(second.successor.cutoverId, first.successor.cutoverId);

    // After the successor fully closes, recovery of the stale predecessor still
    // rendezvouses idempotently to the same closed successor (no re-supersession).
    store.recordDrain(first.successor.cutoverId, { activeSessions: 0, oldestAgeMs: 0 });
    store.recordRestartRequest(first.successor.cutoverId, {
      actuator: "launchd-self",
      requestedByServerInstanceId: "target-reconciler",
      buildReady: { verifiedBy: "seam", verifiedAt: new Date().toISOString() },
    });
    store.recordRestartScheduled(first.successor.cutoverId, "target-reconciler");
    store.close(first.successor.cutoverId, {
      closedByServerInstanceId: "target-reconciler",
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
      reconciledAt: new Date().toISOString(),
    });
    const afterClose = recovering.recoverCutover({
      cutoverId: "cutover-1",
      expectedNewIdentity: { sourceCommit: "target-source", buildId: "target-build" },
    });
    assert.equal(afterClose.newlyRecovered, false);
    assert.ok(afterClose.successor);
    assert.equal(afterClose.successor.cutoverId, first.successor.cutoverId);
    assert.equal(afterClose.successor.phase, "closed");

  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("recoverCutover rejects a closed cutover with no supersession lineage", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-mcp-recover-closed-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-closed" });
    const old = new McpCutoverController(store, identity("old", "old-source", "old-build"));
    old.begin({ sourceCommit: "new-source", buildId: "new-build" });
    old.recordDrain("cutover-closed", { activeSessions: 0, oldestAgeMs: 0 });
    old.requestRestart("cutover-closed", { verifiedBy: "op", verifiedAt: new Date().toISOString() });
    old.markRestartScheduled("cutover-closed");
    const newOwner = new McpCutoverController(store, identity("new", "new-source", "new-build"));
    const closed = await newOwner.finish("cutover-closed", async () => ({
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
    }));
    assert.equal(closed.phase, "closed");

    const recovering = new McpCutoverController(store, identity("reconciler", "old-source", "old-build"));
    assert.throws(
      () => recovering.recoverCutover({
        cutoverId: "cutover-closed",
        expectedNewIdentity: { sourceCommit: "target-source", buildId: "target-build" },
      }),
      /already closed/i,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#386 reconnect during drain admits new transport, control tools, and unrelated independently-governed mutation", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-mcp-reconnect-drain-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-reconnect" });
    const old = new McpCutoverController(store, identity("old-server", "old-source", "old-build"));
    old.begin({ sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" });
    assert.equal(old.mode(), "drain");

    // Simulating a reconnecting / newly initialized MCP transport
    assert.equal(old.canInitializeTransport(), true);

    // Control and reconciliation tools must reach handler
    assert.doesNotThrow(() => old.assertToolAllowed("cutover_status"));
    assert.doesNotThrow(() => old.assertToolAllowed("cutover_drain"));
    assert.doesNotThrow(() => old.assertToolAllowed("cutover_reconcile"));
    assert.doesNotThrow(() => old.assertToolAllowed("cutover_finish"));
    assert.doesNotThrow(() => old.assertToolAllowed("cutover_recover"));
    assert.doesNotThrow(() => old.assertToolAllowed("agent_status"));
    assert.doesNotThrow(() => old.assertToolAllowed("agent_reconcile"));
    assert.doesNotThrow(() => old.assertToolAllowed("workspace_inspect"));
    assert.doesNotThrow(() => old.assertToolAllowed("storage_inventory"));
    assert.doesNotThrow(() => old.assertToolAllowed("host_capability_snapshot"));
    assert.doesNotThrow(() => old.assertToolAllowed("read"));

    // Unrelated mutations remain governed by their own authority instead of
    // inheriting a global deployment outage.
    const consequential = [
      "open_workspace", "workspace_clone", "write", "edit", "apply_patch",
      "dependency_sync", "agent_start", "agent_continue",
      "codex_goal_start", "candidate_integrate", "git_commit", "git_push",
      "chat_swarm_create", "chat_swarm_join", "chat_swarm_dispatch",
    ];
    for (const tool of consequential) {
      assert.doesNotThrow(() => old.assertToolAllowed(tool));
    }
    for (const tool of ["bash", "exec_command", "write_stdin"]) {
      assert.equal(classifyCutoverEffect(tool), "DEPLOYMENT_CONFLICT");
      assert.throws(() => old.assertToolAllowed(tool), /CUTOVER_RECONCILIATION_REQUIRED/);
    }
    assert.throws(() => old.assertToolAllowed("storage_gc"), /CUTOVER_RECONCILIATION_REQUIRED/);
    assert.throws(() => old.assertToolAllowed("release_delete"), /CUTOVER_RECONCILIATION_REQUIRED/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Test 2 & 3 (controller) — recoverCutover on replacement with missing drain resolves deadlock", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-mcp-ctrl-deadlock-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-ctrl-dl" });
    const old = new McpCutoverController(store, identity("old-inst", "old-source", "old-build"));
    old.begin({ sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" });

    const replacement = new McpCutoverController(store, identity("new-inst", "new-source", "new-build", "cap"));
    const witness: DurableReconciliationWitness = {
      witnessCutoverId: "cutover-ctrl-dl", witnessServerInstanceId: "new-inst", witnessExpectedIdentity: { sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" },
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
      witnessWorkspaceId: "ws-ctrl",
      witnessAgentId: "agent-ctrl",
      witnessWorkspaceSessions: 1,
      witnessAgentSessions: 1,
      witnessKind: "exact-pair",
    };

    const recovered = replacement.recoverCutover({
      cutoverId: "cutover-ctrl-dl",
      expectedNewIdentity: { sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" },
      witness,
    });

    assert.equal(recovered.newlyRecovered, true);
    assert.equal(recovered.terminal.phase, "closed");
    assert.equal(recovered.terminal.drainEvidence, undefined);
    assert.equal(recovered.successor, undefined);
    assert.equal(replacement.mode(), "normal");

    // Idempotent retry
    const retry = replacement.recoverCutover({
      cutoverId: "cutover-ctrl-dl",
      expectedNewIdentity: { sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" },
      witness,
    });
    assert.equal(retry.newlyRecovered, false);
    assert.equal(retry.terminal.phase, "closed");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("closed observed recovery validates identity even when replay has no witness", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-mcp-closed-replay-binding-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-closed-binding" });
    const old = new McpCutoverController(store, identity("old", "old-source", "old-build"));
    old.begin({ sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" });
    const replacement = new McpCutoverController(store, identity("new", "new-source", "new-build"));
    const witness: DurableReconciliationWitness = {
      witnessCutoverId: "cutover-closed-binding", witnessServerInstanceId: "new", witnessExpectedIdentity: { sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" },
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
      witnessWorkspaceId: "ws-closed",
      witnessAgentId: "agent-closed",
      witnessWorkspaceSessions: 1,
      witnessAgentSessions: 1,
      witnessKind: "exact-pair",
    };
    replacement.recoverCutover({
      cutoverId: "cutover-closed-binding",
      expectedNewIdentity: { sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" },
      witness,
    });
    assert.throws(
      () => new McpCutoverController(store, identity("other", "new-source", "new-build"))
        .recoverCutover({
          cutoverId: "cutover-closed-binding",
          expectedNewIdentity: { sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" },
        }),
      /identity|binding/i,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Test 7 (controller) — recoverCutover without witness fails closed", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-mcp-ctrl-nowit-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-ctrl-nowit" });
    const old = new McpCutoverController(store, identity("old-inst", "old-source", "old-build"));
    old.begin({ sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" });

    const replacement = new McpCutoverController(store, identity("new-inst", "new-source", "new-build", "cap"));

    assert.throws(
      () => replacement.recoverCutover({
        cutoverId: "cutover-ctrl-nowit",
        expectedNewIdentity: { sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" },
      }),
      /witness is not fully positive/i,
    );
    assert.equal(replacement.mode(), "reconcile-only");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#386: cutover fencing is deployment-effect scoped while unrelated mutation keeps its own authority", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-mcp-allowlist-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-allowlist" });
    const old = new McpCutoverController(store, identity("old-inst", "old-source", "old-build"));
    old.begin({ sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" });

    assert.equal(old.mode(), "drain");

    // Unknown / newly registered unrelated tools do not inherit deployment
    // authority merely because they mutate something elsewhere.
    const unrelatedTools = [
      "some_unregistered_mutation_tool",
      "future_workspace_mutation_tool",
      "delete_workspace_database",
    ];
    for (const tool of unrelatedTools) {
      assert.equal(classifyCutoverEffect(tool), "INDEPENDENT");
      assert.doesNotThrow(() => old.assertToolAllowed(tool));
    }

    // Structured workspace mutations are independent only when their physical
    // target stays outside the exact deployment/state evidence domain.
    const unrelatedPath = join(dirname(stateDir), "project", "note.txt");
    const protectedPath = join(stateDir, "cutover", "active.json");
    assert.equal(
      classifyCutoverEffect("write", {
        mutationPaths: [unrelatedPath],
        protectedPaths: [stateDir],
      }),
      "INDEPENDENT",
    );
    assert.equal(
      classifyCutoverEffect("write", {
        mutationPaths: [protectedPath],
        protectedPaths: [stateDir],
      }),
      "DEPLOYMENT_CONFLICT",
    );
    assert.doesNotThrow(() => old.assertToolAllowed("write", {
      mutationPaths: [unrelatedPath],
      protectedPaths: [stateDir],
    }));
    assert.throws(() => old.assertToolAllowed("write", {
      mutationPaths: [protectedPath],
      protectedPaths: [stateDir],
    }), /CUTOVER_RECONCILIATION_REQUIRED/);
    assert.throws(() => old.assertToolAllowed("agent_start", {
      workspaceRoot: dirname(stateDir),
      broadWorkspaceMutation: true,
      protectedPaths: [stateDir],
    }), /CUTOVER_RECONCILIATION_REQUIRED/);
    assert.throws(() => old.assertToolAllowed("host_operation_start", {
      mutationPaths: [join(stateDir, "host-effect.txt")],
      protectedPaths: [stateDir],
    }), /CUTOVER_RECONCILIATION_REQUIRED/);
    assert.doesNotThrow(() => old.assertToolAllowed("host_operation_start", {
      mutationPaths: [join(dirname(stateDir), "other-host-effect.txt")],
      protectedPaths: [stateDir],
    }));

    // Known control/read tools remain reachable so the exact deployment effect
    // can be reconciled or terminalized. Removed governance tools must not remain
    // as dead cutover allowlist entries.
    for (const removedTool of ["coordination_recovery_request", "coordination_handoff_readback"]) {
      assert.equal(CUTOVER_SAFE_TOOLS.has(removedTool), false);
      assert.equal(CONSEQUENTIAL_MCP_TOOLS.has(removedTool), false);
    }
    for (const safeTool of CUTOVER_SAFE_TOOLS) {
      assert.doesNotThrow(
        () => old.assertToolAllowed(safeTool),
        `Expected safe tool ${safeTool} to be allowed during drain`,
      );
    }

    // Previously blanket-blocked workspace/Git/agent/process operations now
    // stay governed by their own normal authority instead of this cutover.
    for (const consequentialTool of CONSEQUENTIAL_MCP_TOOLS) {
      if (classifyCutoverEffect(consequentialTool) === "DEPLOYMENT_CONFLICT") {
        assert.throws(() => old.assertToolAllowed(consequentialTool), /CUTOVER_RECONCILIATION_REQUIRED/);
      } else {
        assert.doesNotThrow(() => old.assertToolAllowed(consequentialTool));
      }
    }

    // Deployment/release namespaces and retention that can destroy exact
    // deployment evidence remain fenced, including future unknown primitives.
    for (const tool of ["storage_gc", "deployment_activate_next", "release_delete", "activation_switch", "cutover_future_mutation"]) {
      assert.equal(classifyCutoverEffect(tool), "DEPLOYMENT_CONFLICT");
      assert.throws(() => old.assertToolAllowed(tool), /CUTOVER_RECONCILIATION_REQUIRED/);
    }

    // 4. In normal mode, everything is allowed
    const normalStore = new CutoverStateStore(mkdtempSync(join(tmpdir(), "devspace-mcp-normal-")));
    const normal = new McpCutoverController(normalStore, identity("norm-inst", "s", "b", "c"));
    assert.equal(normal.mode(), "normal");
    assert.doesNotThrow(() => normal.assertToolAllowed("some_unregistered_mutation_tool"));
    assert.doesNotThrow(() => normal.assertToolAllowed("bash"));
    assert.doesNotThrow(() => normal.assertToolAllowed("write"));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#386: consumed wrong-generation restart terminalizes as FAILED_ACTIVATION with retry permanently disabled", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-mcp-failed-activation-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-failed-activation" });
    const oldIdentity = identity("old-inst", "a".repeat(40), "old-build", "c".repeat(64));
    const expected = { sourceCommit: "b".repeat(40), buildId: "target-build", capabilityManifestSha256: "d".repeat(64) };
    const binding = { leaseId: "lease_failed", pinnedLeaseVersion: 2, operationHandle: "op_failed", requestHash: "e".repeat(64), ownerThread: "carrier_failed" };
    const record = store.begin({ oldServerIdentity: oldIdentity, expectedNewIdentity: expected, coordinationBinding: binding });
    store.recordDrain(record.cutoverId, { activeSessions: 0, oldestAgeMs: 0 });
    store.recordRestartRequest(record.cutoverId, {
      actuator: "launchd-self",
      requestedByServerInstanceId: oldIdentity.serverInstanceId,
      buildReady: { verifiedBy: "test", verifiedAt: new Date().toISOString() },
    });
    store.recordRestartScheduled(record.cutoverId, oldIdentity.serverInstanceId);

    const observed = identity("replacement-inst", "f".repeat(40), "wrong-build", "c".repeat(64));
    const recovered = store.recoverFailedActivation({ cutoverId: record.cutoverId, recoveredBy: binding.ownerThread, observedIdentity: observed });
    assert.equal(recovered.newlyRecovered, true);
    assert.equal(recovered.record.phase, "closed");
    assert.equal(recovered.record.failedActivation?.terminalReason, "FAILED_ACTIVATION");
    assert.equal(recovered.record.failedActivation?.restartConsumed, true);
    assert.equal(recovered.record.failedActivation?.retryAllowed, false);
    assert.equal(recovered.record.failedActivation?.successorRequired, true);
    assert.deepEqual(recovered.record.failedActivation?.approvedTarget, expected);
    assert.deepEqual(recovered.record.failedActivation?.observedIdentity, observed);
    assert.ok(recovered.record.restartRequest?.restartScheduledAt);

    const current = new McpCutoverController(new CutoverStateStore(stateDir), observed);
    assert.equal(current.mode(), "normal");
    assert.doesNotThrow(() => current.assertToolAllowed("git_commit"));

    const replay = store.recoverFailedActivation({ cutoverId: record.cutoverId, recoveredBy: binding.ownerThread, observedIdentity: observed });
    assert.equal(replay.newlyRecovered, false);
    assert.equal(replay.record.failedActivation?.retryAllowed, false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#386: failed activation also captures a replacement with the right source/build but wrong bound release", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-mcp-failed-release-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-failed-release" });
    const oldIdentity = identity("old-inst", "a".repeat(40), "old-build", "c".repeat(64));
    const expected = { sourceCommit: "b".repeat(40), buildId: "target-build", capabilityManifestSha256: "d".repeat(64) };
    const binding = { leaseId: "lease_release", pinnedLeaseVersion: 2, operationHandle: "op_release", requestHash: "e".repeat(64), ownerThread: "carrier_release" };
    const record = store.begin({ oldServerIdentity: oldIdentity, expectedNewIdentity: expected, coordinationBinding: binding });
    store.recordDrain(record.cutoverId, { activeSessions: 0, oldestAgeMs: 0 });
    const activation = store.recordActivationBinding(record.cutoverId, {
      schema: "devspace.cutover_activation_binding.v1",
      cutoverId: record.cutoverId,
      sourceCommit: expected.sourceCommit,
      buildId: expected.buildId,
      releaseSha256: "1".repeat(64),
      releasePath: join(stateDir, "releases", "target"),
      pointerPath: join(stateDir, "current-release.json"),
      boundAt: new Date().toISOString(),
    }).record.activationBinding!;
    store.recordRestartRequest(record.cutoverId, {
      actuator: "launchd-self",
      requestedByServerInstanceId: oldIdentity.serverInstanceId,
      buildReady: { verifiedBy: "test", verifiedAt: new Date().toISOString() },
    });
    store.recordRestartScheduled(record.cutoverId, oldIdentity.serverInstanceId);

    const observed = {
      ...identity("replacement-inst", expected.sourceCommit, expected.buildId, expected.capabilityManifestSha256),
      releaseSha256: "2".repeat(64),
      releasePath: join(stateDir, "releases", "wrong"),
      activationCutoverId: activation.cutoverId,
    };
    const recovered = store.recoverFailedActivation({ cutoverId: record.cutoverId, recoveredBy: binding.ownerThread, observedIdentity: observed });
    assert.equal(recovered.record.phase, "closed");
    assert.equal(recovered.record.failedActivation?.terminalReason, "FAILED_ACTIVATION");
    assert.deepEqual(recovered.record.activationBinding, activation);
    assert.deepEqual(recovered.record.failedActivation?.observedIdentity, observed);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("C3 legacy finish rechecks bound generation after awaited reconciliation",async()=>{
  const stateDir=mkdtempSync(join(tmpdir(),"devspace-bound-finish-race-"));const store=new CutoverStateStore(stateDir);
  const old=identity("old","old","old"),replacement=identity("new","target","target");
  const initial=store.begin({oldServerIdentity:old,expectedNewIdentity:{sourceCommit:"target",buildId:"target",capabilityManifestSha256:"cap"}});
  store.recordDrain(initial.cutoverId,{activeSessions:0,oldestAgeMs:0});
  const controller=new McpCutoverController(store,replacement);
  let nextId="";
  await assert.rejects(controller.finish(initial.cutoverId,async()=>{
    store.close(initial.cutoverId,{closedByServerInstanceId:"new",workspaceQueryable:true,agentQueryable:true,agentReconciled:true,reconciledAt:new Date().toISOString()});
    nextId=store.begin({oldServerIdentity:replacement,expectedNewIdentity:{sourceCommit:"next",buildId:"next"},coordinationBinding:{leaseId:"lease",pinnedLeaseVersion:1,operationHandle:"operation",requestHash:"a".repeat(64),ownerThread:"owner"}}).cutoverId;
    return {workspaceQueryable:true,agentQueryable:true,agentReconciled:true};
  }),/COORDINATION_REQUIRED/);
  assert.equal(store.get()?.cutoverId,nextId);assert.equal(store.get()?.phase,"prepared");
});
