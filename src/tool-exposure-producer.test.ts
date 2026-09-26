import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TOOL_EXPOSURE_RECEIPT_SCHEMA,
  buildToolExposureReceipt,
  parseToolExposureReceipt,
  buildHerdrToolExposureReceipt,
  mapSelectedIntentsToOpencodeTools,
  canonicalJson,
  ToolExposureWidenedError,
  ToolExposureIdentityError,
} from "./tool-exposure-receipt.js";
import { LocalAgentStore } from "./local-agent-store.js";
import {
  HerdrThinGateway,
  type HerdrExternalHandle,
  normalizeHerdrHandleAuthority,
  assertExactDurableHerdrHandle,
  defaultHerdrGatewayRegistry,
} from "./local-agent-herdr.js";
import { LocalAgentSessionManager } from "./local-agent-sessions.js";
import { hashDispatchIntent } from "./execution-protocol.js";

test("H1: buildToolExposureReceipt rejects selected_tools exceeding candidate_tools (ceiling violation)", () => {
  assert.throws(
    () =>
      buildToolExposureReceipt({
        operation_id: "op-1",
        attempt_id: "att-1",
        provider: "opencode",
        backend_id: "herdr",
        planner_decision_hash: "0".repeat(64),
        projection_hash: "1".repeat(64),
        enforcement_mode: "ENFORCED_MANAGED_BRIDGE",
        candidate_tools: ["read", "glob"],
        selected_tools: ["read", "edit"], // 'edit' not in candidates
        actual_exposed_tools: ["read"],
      }),
    (err: unknown) =>
      err instanceof ToolExposureWidenedError &&
      err.message === "SELECTED_TOOLS_EXCEED_CANDIDATE_TOOLS",
  );
});

test("H2: buildToolExposureReceipt rejects actual_exposed_tools exceeding selected_tools (widening violation)", () => {
  assert.throws(
    () =>
      buildToolExposureReceipt({
        operation_id: "op-1",
        attempt_id: "att-1",
        provider: "opencode",
        backend_id: "herdr",
        planner_decision_hash: "0".repeat(64),
        projection_hash: "1".repeat(64),
        enforcement_mode: "ENFORCED_MANAGED_BRIDGE",
        candidate_tools: ["read", "edit", "glob"],
        selected_tools: ["read"],
        actual_exposed_tools: ["read", "edit"], // 'edit' not in selected
      }),
    (err: unknown) =>
      err instanceof ToolExposureWidenedError &&
      err.message === "ACTUAL_EXPOSED_TOOLS_EXCEED_SELECTED_TOOLS",
  );
});

test("H3: Unsupported CLI providers (agy, codex, grok, cline) produce fail-closed REQUEST_ONLY_NOT_ENFORCED receipt", () => {
  const providers = ["agy", "codex", "grok", "cline"] as const;
  for (const prov of providers) {
    const receipt = buildHerdrToolExposureReceipt({
      agentKind: prov,
      attemptKey: `attempt-${prov}`,
      dispatchIntentHash: "a".repeat(64),
      selectedToolIntents: ["workspace.read", "workspace.mutate"],
      writeMode: "allowed",
    });

    assert.equal(receipt.schema, TOOL_EXPOSURE_RECEIPT_SCHEMA);
    assert.equal(receipt.provider, prov);
    assert.equal(receipt.backend_id, "herdr");
    assert.equal(receipt.enforcement_mode, "REQUEST_ONLY_NOT_ENFORCED");
    assert.deepEqual(receipt.actual_exposed_tools, []);
    assert.equal(receipt.actual_exposed_tool_count, 0);
    assert.equal(receipt.authority_kind, "DERIVED_EXPOSURE_EVIDENCE_ONLY");
    assert.match(receipt.exposure_hash, /^[0-9a-f]{64}$/);

    // Ensure parseToolExposureReceipt verifies hash and structure
    const parsed = parseToolExposureReceipt(receipt);
    assert.ok(parsed);
    assert.deepEqual(parsed, receipt);
  }
});

test("H4: OpenCode managed bridge produces ENFORCED_MANAGED_BRIDGE with correct tool exposure subset", () => {
  // Scenario A: read_only writeMode suppresses 'edit' and 'bash' even if selected
  const readOnlyReceipt = buildHerdrToolExposureReceipt({
    agentKind: "opencode",
    attemptKey: "attempt-oc-ro",
    dispatchIntentHash: "b".repeat(64),
    selectedToolIntents: [
      "workspace.read",
      "workspace.mutate",
      "process.execute",
      "workspace.search_paths",
    ],
    writeMode: "read_only",
  });

  assert.equal(readOnlyReceipt.enforcement_mode, "ENFORCED_MANAGED_BRIDGE");
  assert.equal(readOnlyReceipt.provider, "opencode");
  assert.equal(readOnlyReceipt.backend_id, "herdr");
  assert.deepEqual(readOnlyReceipt.candidate_tools, [
    "bash",
    "edit",
    "glob",
    "grep",
    "list",
    "read",
  ]);
  // selected_tools has bash, edit, glob, read
  assert.deepEqual(readOnlyReceipt.selected_tools, ["bash", "edit", "glob", "read"]);
  // actual_exposed_tools in read_only mode only has glob, read (edit and bash excluded)
  assert.deepEqual(readOnlyReceipt.actual_exposed_tools, ["glob", "read"]);
  assert.equal(readOnlyReceipt.actual_exposed_tool_count, 2);

  // Invariant verification: actual <= selected <= candidates
  const actualSet = new Set(readOnlyReceipt.actual_exposed_tools);
  const selectedSet = new Set(readOnlyReceipt.selected_tools);
  const candidateSet = new Set(readOnlyReceipt.candidate_tools);
  for (const a of actualSet) assert.ok(selectedSet.has(a));
  for (const s of selectedSet) assert.ok(candidateSet.has(s));

  // Scenario B: allowed writeMode exposes edit and bash when selected
  const writeReceipt = buildHerdrToolExposureReceipt({
    agentKind: "opencode",
    attemptKey: "attempt-oc-rw",
    dispatchIntentHash: "c".repeat(64),
    selectedToolIntents: [
      "workspace.read",
      "workspace.mutate",
      "process.execute",
      "workspace.search_text",
      "workspace.list",
    ],
    writeMode: "allowed",
  });

  assert.equal(writeReceipt.enforcement_mode, "ENFORCED_MANAGED_BRIDGE");
  assert.deepEqual(writeReceipt.actual_exposed_tools, [
    "bash",
    "edit",
    "grep",
    "list",
    "read",
  ]);
  assert.equal(writeReceipt.actual_exposed_tool_count, 5);
});

test("H5: mapSelectedIntentsToOpencodeTools handles undefined (default all)", () => {
  const defaultRo = mapSelectedIntentsToOpencodeTools(undefined, "read_only");
  assert.deepEqual(defaultRo, ["glob", "grep", "list", "read"]);

  const defaultRw = mapSelectedIntentsToOpencodeTools(undefined, "allowed");
  assert.deepEqual(defaultRw, ["bash", "edit", "glob", "grep", "list", "read"]);
});

test("H6: parseToolExposureReceipt detects tampering or malformed hashes", () => {
  const receipt = buildHerdrToolExposureReceipt({
    agentKind: "opencode",
    attemptKey: "attempt-tamper",
    dispatchIntentHash: "d".repeat(64),
    selectedToolIntents: ["workspace.read"],
    writeMode: "read_only",
  });

  // Tampered actual_exposed_tools
  const tampered1 = { ...receipt, actual_exposed_tools: ["read", "edit"] };
  assert.equal(parseToolExposureReceipt(tampered1), undefined);

  // Tampered hash
  const tampered2 = { ...receipt, exposure_hash: "e".repeat(64) };
  assert.equal(parseToolExposureReceipt(tampered2), undefined);

  // Count mismatch
  const tampered3 = { ...receipt, actual_exposed_tool_count: 99 };
  assert.equal(parseToolExposureReceipt(tampered3), undefined);
});

test("H7: HerdrExternalHandle retains toolExposureReceipt across handle normalization and assertion", () => {
  const receipt = buildHerdrToolExposureReceipt({
    agentKind: "opencode",
    attemptKey: "attempt-handle-1",
    dispatchIntentHash: "f".repeat(64),
    selectedToolIntents: ["workspace.read"],
    writeMode: "read_only",
  });

  const handle: HerdrExternalHandle = {
    schemaVersion: 1,
    runtimeKind: "HERDR",
    agentId: "agent-1",
    herdrSocketPath: "/tmp/herdr.sock",
    herdrWorkspaceId: "ws-1",
    herdrPaneId: "pane-1",
    herdrAgentIdentity: "agent-name",
    herdrAgentKind: "opencode",
    promptNonce: "nonce-1",
    canonicalWorktreePath: "/tmp/worktree",
    workspaceId: "ws-local-1",
    gitHeadBefore: "1".repeat(40),
    attemptKey: "attempt-handle-1",
    dispatchIntentHash: "f".repeat(64),
    launchTimestamp: new Date().toISOString(),
    enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    toolExposureReceipt: receipt,
  };

  const norm = normalizeHerdrHandleAuthority(handle);
  assert.equal(norm.toolExposureHash, receipt.exposure_hash);

  // Matching handle passes assertExactDurableHerdrHandle
  assert.doesNotThrow(() => assertExactDurableHerdrHandle(handle, handle));

  // Handle with tampered toolExposureReceipt fails assertExactDurableHerdrHandle
  const tamperedHandle: HerdrExternalHandle = {
    ...handle,
    toolExposureReceipt: { ...receipt, exposure_hash: "0".repeat(64) },
  };
  assert.throws(
    () => assertExactDurableHerdrHandle(tamperedHandle, handle),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes("toolExposureHash"),
  );
});

test("H8: End-to-end LocalAgentSessionManager binds and exposes ToolExposureReceipt in start, status, and reconcile", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-receipt-session-state-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "devspace-receipt-session-repo-"));

  try {
    const config = {
      stateDir,
      subagents: true,
      oauth: { scopes: ["devspace"] },
    } as any;

    const manager = new LocalAgentSessionManager(
      config,
      async () => {},
      async () => true,
    );

    const dispatchIntent = {
      taskId: "task-receipt-1",
      attemptId: "attempt-receipt-1",
      objective: "Physical tool exposure test",
      roleIntent: "DEEP_ENGINEERING" as const,
      claimCeiling: "CANDIDATE_READY" as const,
      context: ["test"],
      readScope: ["src"],
      writeScope: ["src/test.txt"],
      exclusiveOwnership: true,
      forbiddenChanges: [],
      acceptanceCriteria: ["pass"],
      verificationRequired: true,
      expectedArtifacts: [],
    };
    const intentHash = hashDispatchIntent(dispatchIntent);

    const store = (manager as any).store as LocalAgentStore;
    const record = store.create({
      workspaceId: "ws-receipt-test",
      workspaceRoot: projectRoot,
      profileName: "opencode-worker",
      provider: "opencode",
      lifecycleKind: "detached_worker_v2",
      startReplay: {
        key: "attempt-receipt-1",
        requestHash: "req-hash-1",
      },
      executionContract: {
        writePaths: ["src/test.txt"],
        dispatchIntent,
      },
    });

    const receipt = buildHerdrToolExposureReceipt({
      agentKind: "opencode",
      attemptKey: "attempt-receipt-1",
      dispatchIntent,
      dispatchIntentHash: intentHash,
      selectedToolIntents: ["workspace.read", "workspace.mutate"],
      writeMode: "allowed",
    });

    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: "HERDR",
      agentId: record.id,
      herdrSocketPath: "/tmp/herdr.sock",
      herdrWorkspaceId: "ws-herdr-1",
      herdrPaneId: "pane-1",
      herdrAgentIdentity: "ds-attempt-receipt-1",
      herdrAgentKind: "opencode",
      promptNonce: "HERDR-DISPATCH-receipt-1",
      canonicalWorktreePath: projectRoot,
      workspaceId: "ws-receipt-test",
      gitHeadBefore: "0".repeat(40),
      attemptKey: "attempt-receipt-1",
      dispatchIntentHash: intentHash,
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
      toolExposureReceipt: receipt,
    };

    // Bind handle
    manager.bindHerdrExternalHandle(record.id, handle);

    // 1. Check getAgentStatus exposes toolExposureReceipt
    const status = await manager.getAgentStatus({
      workspaceId: "ws-receipt-test",
      workspaceRoot: projectRoot,
      agentId: record.id,
    });
    assert.ok(status.toolExposureReceipt);
    assert.deepEqual(status.toolExposureReceipt, receipt);
    assert.equal(status.toolExposureReceipt.enforcement_mode, "ENFORCED_MANAGED_BRIDGE");

    // 2. Check reconcileAgent exposes toolExposureReceipt
    const reconcile = await manager.reconcileAgent({
      workspaceId: "ws-receipt-test",
      workspaceRoot: projectRoot,
      isolated: false,
      agentId: record.id,
    });
    assert.ok(reconcile.toolExposureReceipt);
    assert.deepEqual(reconcile.toolExposureReceipt, receipt);
    assert.equal(reconcile.toolExposureReceipt.exposure_hash, receipt.exposure_hash);

    // 3. Check durable store recovery survives new session manager
    const manager2 = new LocalAgentSessionManager(
      config,
      async () => {},
      async () => true,
    );
    const recoveredHandle = manager2.getHerdrExternalHandle(record.id);
    assert.ok(recoveredHandle);
    assert.ok(recoveredHandle.toolExposureReceipt);
    assert.deepEqual(recoveredHandle.toolExposureReceipt, receipt);

    const recoveredStatus = await manager2.getAgentStatus({
      workspaceId: "ws-receipt-test",
      workspaceRoot: projectRoot,
      agentId: record.id,
    });
    assert.deepEqual(recoveredStatus.toolExposureReceipt, receipt);
  } finally {
    defaultHerdrGatewayRegistry.releaseHandle("attempt-receipt-1");
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
