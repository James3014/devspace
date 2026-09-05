import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CutoverStateStore } from "./cutover-state.js";
import { McpCutoverController } from "./mcp-cutover.js";

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
    old.begin({ sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" });
    assert.equal(old.mode(), "drain");
    assert.equal(old.canInitializeTransport(), true);
    assert.throws(() => old.assertToolAllowed("write"), /CUTOVER_RECONCILIATION_REQUIRED/);
    assert.throws(() => old.assertToolAllowed("workspace_verify"), /CUTOVER_RECONCILIATION_REQUIRED/);
    assert.doesNotThrow(() => old.assertToolAllowed("read"));
    assert.doesNotThrow(() => old.assertToolAllowed("cutover_status"));
    assert.doesNotThrow(() => old.assertToolAllowed("agent_status"));
    assert.doesNotThrow(() => old.assertToolAllowed("agent_reconcile"));
    assert.doesNotThrow(() => old.assertToolAllowed("remote_writability_probe"));

    const replacement = new McpCutoverController(
      new CutoverStateStore(stateDir),
      identity("new", "new-source", "new-build"),
    );
    assert.equal(replacement.mode(), "reconcile-only");
    assert.equal(replacement.canInitializeTransport(), true);
    assert.throws(
      () => replacement.recordDrain("cutover-one", { activeSessions: 0, oldestAgeMs: 0 }),
      /only the old server instance/i,
    );
    const recovered = replacement.recoverDrain("cutover-one", { activeSessions: 1, oldestAgeMs: 25 });
    assert.equal(recovered.phase, "recovered");
    assert.equal(recovered.recoveryEvidence?.kind, "REPLACEMENT_RECOVER_DRAIN");
    assert.equal(recovered.recoveryEvidence?.recoveredByServerInstanceId, "new");
    assert.deepEqual(recovered.recoveryEvidence?.transportEvidence, { activeSessions: 1, oldestAgeMs: 25 });
    assert.equal(replacement.recoverDrain("cutover-one", { activeSessions: 999, oldestAgeMs: 999 }).phase, "recovered");
    assert.throws(() => replacement.assertToolAllowed("agent_start"), /CUTOVER_RECONCILIATION_REQUIRED/);
    assert.throws(() => replacement.assertToolAllowed("bash"), /CUTOVER_RECONCILIATION_REQUIRED/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("replacement drain recovery is exact-identity bound and can close through the normal reconciliation witness", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-mcp-recover-drain-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-recover" });
    const old = new McpCutoverController(store, identity("old", "old-source", "old-build"));
    old.begin({ sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" });

    assert.throws(
      () => new McpCutoverController(store, identity("new", "wrong-source", "new-build")).recoverDrain(
        "cutover-recover",
        { activeSessions: 1, oldestAgeMs: 10 },
      ),
      /exact expected source\/build\/capability identity/i,
    );
    assert.throws(
      () => old.recoverDrain("cutover-recover", { activeSessions: 1, oldestAgeMs: 10 }),
      /different serverInstanceId/i,
    );

    const replacement = new McpCutoverController(store, identity("new", "new-source", "new-build"));
    const recovered = replacement.recoverDrain("cutover-recover", { activeSessions: 2, oldestAgeMs: 20 });
    assert.equal(recovered.phase, "recovered");
    const closed = await replacement.finish("cutover-recover", async () => ({
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
    }));
    assert.equal(closed.phase, "closed");
    assert.equal(closed.recoveryEvidence?.kind, "REPLACEMENT_RECOVER_DRAIN");
    assert.equal(replacement.mode(), "normal");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("finish fails closed for old/wrong identities and closes exact cutover idempotently", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-mcp-finish-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-exact" });
    const old = new McpCutoverController(store, identity("old", "old-source", "old-build"));
    old.begin({ sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" });
    const witness = async () => ({
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
    });

    await assert.rejects(
      new McpCutoverController(store, identity("new", "new-source", "new-build")).finish("cutover-exact", witness),
      /durable drain or typed replacement-recovery evidence/i,
    );
    old.recordDrain("cutover-exact", { activeSessions: 1, oldestAgeMs: 10 });
    await assert.rejects(
      new McpCutoverController(store, identity("old", "new-source", "new-build")).finish("cutover-exact", witness),
      /serverInstanceId did not change/,
    );
    await assert.rejects(
      new McpCutoverController(store, identity("new", "wrong-source", "new-build")).finish("cutover-exact", witness),
      /sourceCommit/,
    );
    await assert.rejects(
      new McpCutoverController(store, identity("new", "new-source", "wrong-build")).finish("cutover-exact", witness),
      /buildId/,
    );
    await assert.rejects(
      new McpCutoverController(store, identity("new", "new-source", "new-build", "wrong-cap")).finish("cutover-exact", witness),
      /capability manifest/,
    );
    assert.equal(store.get()?.phase, "drained");

    const expected = new McpCutoverController(store, identity("new", "new-source", "new-build"));
    const closed = await expected.finish("cutover-exact", witness);
    assert.equal(closed.phase, "closed");
    assert.equal((await expected.finish("cutover-exact", witness)).phase, "closed");
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
