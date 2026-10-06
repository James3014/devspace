import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import {
  readExternalHostOperationStatus,
  type HostOperationExternalStatusSuccess,
  type HostOperationExternalStatusNotFound,
} from "./host-operation-external.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { createServer } from "./server.js";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function structured(result: ToolResult): Record<string, any> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  if (result.structuredContent) return result.structuredContent as Record<string, any>;
  const text = (result.content as Array<{ type: string; text?: string }>).find(
    (item) => item.type === "text",
  )?.text;
  assert.ok(text, "expected structured tool output");
  return JSON.parse(text);
}

async function issueToken(
  provider: SingleUserOAuthProvider,
  config: ReturnType<typeof loadConfig>,
  name: string,
) {
  const client = await provider.clientsStore.registerClient!({
    redirect_uris: ["http://localhost/callback"],
    client_name: name,
    token_endpoint_auth_method: "none",
  });
  let redirect = "";
  await provider.authorize(
    client,
    {
      redirectUri: "http://localhost/callback",
      codeChallenge: `${name}-challenge`,
      scopes: config.oauth.scopes,
      resource: new URL("/mcp", config.publicBaseUrl),
    },
    {
      req: { method: "POST", body: { owner_token: config.oauth.ownerToken } },
      redirect: (_status: number, url: string) => {
        redirect = url;
      },
    } as never,
  );
  return {
    clientId: client.client_id,
    accessToken: (
      await provider.exchangeAuthorizationCode(
        client,
        new URL(redirect).searchParams.get("code")!,
      )
    ).access_token,
  };
}

async function connect(url: URL, accessToken: string, name: string): Promise<Client> {
  const client = new Client({ name, version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
  return client;
}

test("readExternalHostOperationStatus reads canonical operations, redacts identities, and checks lease/retry safety", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-ext-op-test-"));
  const opRoot = join(root, "operations_root");
  const leasesDir = join(root, "leases");
  await mkdir(join(opRoot, "operations"), { recursive: true });
  await mkdir(leasesDir, { recursive: true });

  // 1. DSH-wave Operation 1 (Completed, Gemini)
  const op1Dir = join(opRoot, "operations", "agyop_a5d29c430378469da9a8fa79d6fe84a8");
  await mkdir(op1Dir, { recursive: true });
  writeFileSync(
    join(op1Dir, "operation.json"),
    JSON.stringify({
      schema: "nexus.agy_operation.v1",
      operation_id: "agyop_a5d29c430378469da9a8fa79d6fe84a8",
      attempt_id: "attempt_7c3a929f9ad24741a14e6bf3b1025de5",
      status: "COMPLETED",
      phase: "TERMINAL",
      exit_code: 0,
      model: "gemini-3.8-flash-low",
      observed_model: "gemini-3.8-flash-low",
      observed_provider: "agy",
      account_alias_hash: "4dcaafa917e1",
      lease_id_hash: "c1aba82d2d75",
      quota_preflight_progress: {
        admission_state: "KNOWN_ELIGIBLE",
        phase: "PREFLIGHT_ADMITTED",
      },
      provider_session_id: "7f46cb8f-6437-4c5e-a71b-1de55d2f0ec0",
      rotations: 0,
      failure_kind: null,
      has_unresolved_external_effect: false,
      runtime_revision: "3bdc41c2b9a449b67c7ecf808319e9db9facc0cc",
      tool_event_count: 0,
      observed_changed_paths: [],
      stdout_path: join(op1Dir, "stdout.log"),
      stderr_path: join(op1Dir, "stderr.log"),
    }),
  );
  writeFileSync(join(op1Dir, "stdout.log"), "MULTI_A_OK\n");
  writeFileSync(
    join(op1Dir, "stderr.log"),
    'NEXUS_AGY_DISPATCH {"account_alias_hash": "4dcaafa917e1", "status": "completed"}\n',
  );

  // 2. DSH-wave Operation 2 (Completed, Gemini second slot)
  const op2Dir = join(opRoot, "operations", "agyop_67c6950aaff347eb95e3357ed498c39a");
  await mkdir(op2Dir, { recursive: true });
  writeFileSync(
    join(op2Dir, "operation.json"),
    JSON.stringify({
      schema: "nexus.agy_operation.v1",
      operation_id: "agyop_67c6950aaff347eb95e3357ed498c39a",
      attempt_id: "attempt_9990ca2704b54adfb9aac2edba4bfc41",
      status: "COMPLETED",
      phase: "TERMINAL",
      exit_code: 0,
      model: "gemini-3.8-flash-low",
      observed_model: "gemini-3.8-flash-low",
      observed_provider: "agy",
      account_alias_hash: "b342e984c538",
      lease_id_hash: "a0d2b96f8c19",
      quota_preflight_progress: {
        admission_state: "UNVERIFIED_POLICY_ALLOWED",
      },
      provider_session_id: "25caede3-c093-4e82-a033-af3177536445",
      rotations: 0,
      failure_kind: null,
      has_unresolved_external_effect: false,
      runtime_revision: "3bdc41c2b9a449b67c7ecf808319e9db9facc0cc",
      tool_event_count: 0,
      observed_changed_paths: [],
    }),
  );

  // 3. DSH-wave Operation 3 (Failed, model contract rejected)
  const op3Dir = join(opRoot, "operations", "agyop_452a8b4217b24fc58118a3e6439a5f8f");
  await mkdir(op3Dir, { recursive: true });
  writeFileSync(
    join(op3Dir, "operation.json"),
    JSON.stringify({
      schema: "nexus.agy_operation.v1",
      operation_id: "agyop_452a8b4217b24fc58118a3e6439a5f8f",
      attempt_id: "attempt_c5819ad999a14b40a711f18748ac94bc",
      status: "FAILED",
      phase: "TERMINAL",
      exit_code: 1,
      model: "claude-sonnet-5-5-low",
      observed_model: null,
      observed_provider: null,
      account_alias_hash: "d034504225b1",
      lease_id_hash: "c72a3c7f4c8a",
      failure_kind: "DISPATCH_MODEL_CONTRACT_REJECTED",
      has_unresolved_external_effect: false,
      runtime_revision: "3bdc41c2b9a449b67c7ecf808319e9db9facc0cc",
      tool_event_count: 0,
      observed_changed_paths: [],
      stderr_path: join(op3Dir, "stderr.log"),
    }),
  );
  writeFileSync(
    join(op3Dir, "stderr.log"),
    'error: invalid model selection (--model "claude-sonnet-5-5-low")\n',
  );

  // 4. OUTCOME_UNKNOWN operation
  const op4Dir = join(opRoot, "operations", "agyop_outcome_unknown_test");
  await mkdir(op4Dir, { recursive: true });
  writeFileSync(
    join(op4Dir, "operation.json"),
    JSON.stringify({
      schema: "nexus.agy_operation.v1",
      operation_id: "agyop_outcome_unknown_test",
      attempt_id: "attempt_unknown",
      status: "OUTCOME_UNKNOWN",
      phase: "TERMINAL",
      exit_code: null,
      failure_kind: "PROCESS_NOT_RUNNING_WITHOUT_TERMINAL_RECEIPT",
      reconciliation: {
        retry_permitted: false,
        pid_alive: false,
      },
    }),
  );

  // 5. Operation with residual lease state (terminal, but receipt still present)
  const op5Dir = join(opRoot, "operations", "agyop_residual_lease_test");
  await mkdir(op5Dir, { recursive: true });
  writeFileSync(
    join(op5Dir, "operation.json"),
    JSON.stringify({
      schema: "nexus.agy_operation.v1",
      operation_id: "agyop_residual_lease_test",
      attempt_id: "attempt_residual",
      status: "COMPLETED",
      phase: "TERMINAL",
      exit_code: 0,
      account_alias_hash: "abcdef123456",
      lease_id_hash: "123456abcdef",
    }),
  );
  // Write active receipt with matching canonical hash identities.
  writeFileSync(
    join(leasesDir, "abcdef123456.receipt.json"),
    JSON.stringify({
      account_alias_hash: "abcdef123456",
      lease_id_hash: "123456abcdef",
      pid: process.pid,
    }),
  );

  // 6. Terminal FAILED operation whose canonical journal explicitly proves source-scoped retry safety.
  const retrySafeDir = join(opRoot, "operations", "agyop_retry_safe_source_proof");
  await mkdir(retrySafeDir, { recursive: true });
  writeFileSync(
    join(retrySafeDir, "operation.json"),
    JSON.stringify({
      schema: "nexus.agy_operation.v1",
      operation_id: "agyop_retry_safe_source_proof",
      status: "FAILED",
      phase: "TERMINAL",
      exit_code: 1,
      reconciliation: {
        result: "SOURCE_NO_DURABLE_EFFECT_PROVEN",
        reconciliation_scope: "SOURCE_ONLY",
        retry_permitted: true,
      },
    }),
  );

  // 7. Sparse canonical record: missing observations must stay unknown rather than defaulting false/0/[].
  const sparseDir = join(opRoot, "operations", "agyop_sparse_evidence");
  await mkdir(sparseDir, { recursive: true });
  writeFileSync(
    join(sparseDir, "operation.json"),
    JSON.stringify({
      schema: "nexus.agy_operation.v1",
      operation_id: "agyop_sparse_evidence",
      status: "RUNNING",
      phase: "EXECUTING",
    }),
  );

  // 8. Tampered identity/schema records must fail closed.
  const mismatchDir = join(opRoot, "operations", "agyop_identity_mismatch");
  await mkdir(mismatchDir, { recursive: true });
  writeFileSync(
    join(mismatchDir, "operation.json"),
    JSON.stringify({
      schema: "nexus.agy_operation.v1",
      operation_id: "agyop_different_identity",
      status: "COMPLETED",
      phase: "TERMINAL",
    }),
  );
  const schemaDir = join(opRoot, "operations", "agyop_schema_mismatch");
  await mkdir(schemaDir, { recursive: true });
  writeFileSync(
    join(schemaDir, "operation.json"),
    JSON.stringify({
      schema: "nexus.other_operation.v1",
      operation_id: "agyop_schema_mismatch",
      status: "COMPLETED",
      phase: "TERMINAL",
    }),
  );

  // 9. Malformed hash material must never become a lease filesystem path.
  const badHashDir = join(opRoot, "operations", "agyop_bad_hash_material");
  await mkdir(badHashDir, { recursive: true });
  writeFileSync(
    join(badHashDir, "operation.json"),
    JSON.stringify({
      schema: "nexus.agy_operation.v1",
      operation_id: "agyop_bad_hash_material",
      status: "RUNNING",
      phase: "EXECUTING",
      account_alias_hash: "../../escape",
      lease_id_hash: "not-a-hash",
    }),
  );

  // 10. A journal-controlled log symlink may not project content outside the operation directory.
  const symlinkDir = join(opRoot, "operations", "agyop_log_symlink_escape");
  await mkdir(symlinkDir, { recursive: true });
  const secretPath = join(root, "outside-secret.txt");
  writeFileSync(secretPath, "secret=must-not-project\n");
  await symlink(secretPath, join(symlinkDir, "stdout.log"));
  writeFileSync(
    join(symlinkDir, "operation.json"),
    JSON.stringify({
      schema: "nexus.agy_operation.v1",
      operation_id: "agyop_log_symlink_escape",
      status: "COMPLETED",
      phase: "TERMINAL",
      stdout_path: join(symlinkDir, "stdout.log"),
    }),
  );

  try {
    // Test 1: Read Operation 1
    const res1 = (await readExternalHostOperationStatus(
      "agyop_a5d29c430378469da9a8fa79d6fe84a8",
      { operationRoot: opRoot, leasesDir },
    )) as HostOperationExternalStatusSuccess;
    assert.equal(res1.found, true);
    assert.equal(res1.operation_id, "agyop_a5d29c430378469da9a8fa79d6fe84a8");
    assert.equal(res1.status, "COMPLETED");
    assert.equal(res1.exit_code, 0);
    assert.equal(res1.requested_model, "gemini-3.8-flash-low");
    assert.equal(res1.observed_model, "gemini-3.8-flash-low");
    assert.equal(res1.account_alias_hash, "4dcaafa917e1");
    assert.equal(res1.lease_id_hash, "c1aba82d2d75");
    assert.equal(res1.backend.kind, "nexus_agy");
    assert.equal(res1.backend.journal_schema, "nexus.agy_operation.v1");
    assert.equal(res1.lease_state.status, "released");
    assert.equal(res1.lease_state.residual, false);
    assert.equal(res1.output_projection.stdout, "MULTI_A_OK\n");
    assert.equal(res1.retry_safety.retry_permitted, false);

    // Test 2: Read Operation 2
    const res2 = (await readExternalHostOperationStatus(
      "agyop_67c6950aaff347eb95e3357ed498c39a",
      { operationRoot: opRoot, leasesDir },
    )) as HostOperationExternalStatusSuccess;
    assert.equal(res2.found, true);
    assert.equal(res2.status, "COMPLETED");
    assert.equal(res2.exit_code, 0);
    assert.equal(res2.account_alias_hash, "b342e984c538");
    assert.equal(res2.lease_state.status, "released");
    assert.equal(res2.lease_state.residual, false);

    // Test 3: Read Operation 3 (Failed, model contract rejected)
    const res3 = (await readExternalHostOperationStatus(
      "agyop_452a8b4217b24fc58118a3e6439a5f8f",
      { operationRoot: opRoot, leasesDir },
    )) as HostOperationExternalStatusSuccess;
    assert.equal(res3.found, true);
    assert.equal(res3.status, "FAILED");
    assert.equal(res3.exit_code, 1);
    assert.equal(res3.failure_kind, "DISPATCH_MODEL_CONTRACT_REJECTED");
    assert.equal(res3.lease_state.status, "released");
    assert.equal(res3.retry_safety.retry_permitted, false);
    assert.ok(res3.output_projection.stderr?.includes("invalid model selection"));

    // Test 4: OUTCOME_UNKNOWN operation must not gain retry permission (Criterion 5)
    const res4 = (await readExternalHostOperationStatus(
      "agyop_outcome_unknown_test",
      { operationRoot: opRoot, leasesDir },
    )) as HostOperationExternalStatusSuccess;
    assert.equal(res4.found, true);
    assert.equal(res4.status, "OUTCOME_UNKNOWN");
    assert.equal(res4.retry_safety.retry_permitted, false);
    assert.equal(res4.retry_safety.journal_retry_permitted, false);
    assert.equal(res4.retry_safety.reconciliation_required, true);

    // Test 5: Residual lease state check (Criterion 4)
    const res5 = (await readExternalHostOperationStatus(
      "agyop_residual_lease_test",
      { operationRoot: opRoot, leasesDir },
    )) as HostOperationExternalStatusSuccess;
    assert.equal(res5.found, true);
    assert.equal(res5.lease_state.status, "active");
    assert.equal(res5.lease_state.residual, true); // Terminal operation with active receipt -> residual is true!
    assert.equal(res5.lease_state.holder_alive, true);

    // Test 6: Canonical retry-safe evidence is projected but this read-only tool grants no retry authority.
    const retrySafe = (await readExternalHostOperationStatus(
      "agyop_retry_safe_source_proof",
      { operationRoot: opRoot, leasesDir },
    )) as HostOperationExternalStatusSuccess;
    assert.equal(retrySafe.found, true);
    assert.equal(retrySafe.retry_safety.journal_retry_permitted, true);
    assert.equal(retrySafe.retry_safety.retry_permitted, false);
    assert.equal(retrySafe.retry_safety.reconciliation_required, false);

    // Test 7: Missing evidence remains unknown, never false/zero/empty by default.
    const sparse = (await readExternalHostOperationStatus(
      "agyop_sparse_evidence",
      { operationRoot: opRoot, leasesDir },
    )) as HostOperationExternalStatusSuccess;
    assert.equal(sparse.found, true);
    assert.equal(sparse.rotations, null);
    assert.equal(sparse.has_unresolved_external_effect, null);
    assert.equal(sparse.tool_event_count, null);
    assert.equal(sparse.observed_changed_paths, null);

    // Test 8: Canonical record identity and schema are integrity-bound.
    const identityMismatch = await readExternalHostOperationStatus(
      "agyop_identity_mismatch",
      { operationRoot: opRoot, leasesDir },
    );
    assert.equal(identityMismatch.found, false);
    assert.equal(identityMismatch.status, "CORRUPTED");

    const schemaMismatch = await readExternalHostOperationStatus(
      "agyop_schema_mismatch",
      { operationRoot: opRoot, leasesDir },
    );
    assert.equal(schemaMismatch.found, false);
    assert.equal(schemaMismatch.status, "CORRUPTED");

    // Test 9: Malformed hash fields cannot escape the lease directory.
    const badHash = (await readExternalHostOperationStatus(
      "agyop_bad_hash_material",
      { operationRoot: opRoot, leasesDir },
    )) as HostOperationExternalStatusSuccess;
    assert.equal(badHash.found, true);
    assert.equal(badHash.account_alias_hash, null);
    assert.equal(badHash.lease_id_hash, null);
    assert.equal(badHash.lease_state.status, "unknown");

    // Test 10: Symlinked logs are not projected.
    const symlinkEscape = (await readExternalHostOperationStatus(
      "agyop_log_symlink_escape",
      { operationRoot: opRoot, leasesDir },
    )) as HostOperationExternalStatusSuccess;
    assert.equal(symlinkEscape.found, true);
    assert.equal(symlinkEscape.output_projection.stdout, null);

    // Test 11: Unknown / missing operation fails closed (Criterion 6)
    const resNotFound = (await readExternalHostOperationStatus(
      "agyop_nonexistent_1234567890",
      { operationRoot: opRoot, leasesDir },
    )) as HostOperationExternalStatusNotFound;
    assert.equal(resNotFound.found, false);
    assert.equal(resNotFound.status, "NOT_FOUND");
    assert.equal(resNotFound.retry_safety.retry_permitted, false);

    // Test 12: Invalid operation ID format fails closed
    const resInvalid = (await readExternalHostOperationStatus(
      "../../etc/passwd",
      { operationRoot: opRoot, leasesDir },
    )) as HostOperationExternalStatusNotFound;
    assert.equal(resInvalid.found, false);
    assert.equal(resInvalid.status, "INVALID_OPERATION_ID");
    assert.equal(resInvalid.retry_safety.retry_permitted, false);

    // Test 13: Replaying reads is side-effect free (Criterion 7)
    const replay1 = await readExternalHostOperationStatus(
      "agyop_a5d29c430378469da9a8fa79d6fe84a8",
      { operationRoot: opRoot, leasesDir },
    );
    const replay2 = await readExternalHostOperationStatus(
      "agyop_a5d29c430378469da9a8fa79d6fe84a8",
      { operationRoot: opRoot, leasesDir },
    );
    assert.deepEqual(replay1, replay2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP HTTP host_operation_external_status tool covers DSH-wave scenario and workspace containment", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-mcp-ext-op-"));
  const configRoot = join(root, "config");
  const stateRoot = join(root, "state");
  const workspaceRoot = join(root, "workspace");
  const opRoot = join(root, "host_ops");
  const leasesDir = join(root, "leases");

  await mkdir(configRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(join(opRoot, "operations"), { recursive: true });
  await mkdir(leasesDir, { recursive: true });

  execFileSync("git", ["init", "-q", workspaceRoot]);
  execFileSync(
    "git",
    ["-C", workspaceRoot, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"],
    { stdio: "ignore" },
  );

  // Setup three DSH-wave operations:
  const ops = [
    {
      id: "agyop_a5d29c430378469da9a8fa79d6fe84a8",
      status: "COMPLETED",
      exit_code: 0,
      model: "gemini-3.8-flash-low",
      acct: "4dcaafa917e1",
      lease: "c1aba82d2d75",
    },
    {
      id: "agyop_67c6950aaff347eb95e3357ed498c39a",
      status: "COMPLETED",
      exit_code: 0,
      model: "gemini-3.8-flash-low",
      acct: "b342e984c538",
      lease: "a0d2b96f8c19",
    },
    {
      id: "agyop_452a8b4217b24fc58118a3e6439a5f8f",
      status: "FAILED",
      exit_code: 1,
      model: "claude-sonnet-5-5-low",
      failure_kind: "DISPATCH_MODEL_CONTRACT_REJECTED",
      acct: "d034504225b1",
      lease: "c72a3c7f4c8a",
    },
  ];

  for (const op of ops) {
    const dir = join(opRoot, "operations", op.id);
    await mkdir(dir, { recursive: true });
    writeFileSync(
      join(dir, "operation.json"),
      JSON.stringify({
        schema: "nexus.agy_operation.v1",
        operation_id: op.id,
        status: op.status,
        phase: "TERMINAL",
        exit_code: op.exit_code,
        model: op.model,
        observed_model: op.exit_code === 0 ? op.model : null,
        observed_provider: op.exit_code === 0 ? "agy" : null,
        account_alias_hash: op.acct,
        lease_id_hash: op.lease,
        failure_kind: op.failure_kind ?? null,
      }),
    );
  }

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configRoot,
    DEVSPACE_STATE_DIR: stateRoot,
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot, // opRoot and leasesDir are OUTSIDE allowed roots!
    DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
    DEVSPACE_SUBAGENTS: "false",
    DEVSPACE_TOOL_MODE: "dispatch",
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    NEXUS_AGY_OPERATION_ROOT: opRoot,
    NEXUS_AGY_LEASES_DIR: leasesDir,
  });

  const provider = new SingleUserOAuthProvider(
    config.oauth,
    new URL("/mcp", config.publicBaseUrl),
    config.stateDir,
  );
  const owner = await issueToken(provider, config, "ext-status-client");
  const running = createServer(config);
  const listener = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const client = await connect(
    new URL(`http://127.0.0.1:${(listener.address() as { port: number }).port}/mcp`),
    owner.accessToken,
    "ext-status-test-http",
  );

  try {
    // Verify tool is available
    const tools = await client.listTools();
    assert.ok(
      tools.tools.some((t) => t.name === "host_operation_external_status"),
      "host_operation_external_status tool must be listed in dispatch mode",
    );
    assert.equal(
      tools.tools.some((t) => t.name === "host_operation_start"),
      false,
      "read-only external status must not depend on the host mutation actuator",
    );

    // Acceptance criterion 1, 2, 3, 4, 9:
    // Read all three pre-existing DSH operations without redispatch
    for (const op of ops) {
      const res = structured(
        await client.callTool({
          name: "host_operation_external_status",
          arguments: { operation_id: op.id },
        }),
      );

      assert.equal(res.found, true);
      assert.equal(res.operation_id, op.id);
      assert.equal(res.status, op.status);
      assert.equal(res.exit_code, op.exit_code);
      assert.equal(res.account_alias_hash, op.acct);
      assert.equal(res.lease_id_hash, op.lease);
      assert.equal(res.lease_state.status, "released");
      assert.equal(res.lease_state.residual, false);
      assert.equal(res.backend.kind, "nexus_agy");
      assert.equal(res.backend.journal_schema, "nexus.agy_operation.v1");
      assert.equal(res.retry_safety.retry_permitted, false);
    }

    // Acceptance criterion 6: unknown operation fails closed as not found
    const missingRes = structured(
      await client.callTool({
        name: "host_operation_external_status",
        arguments: { operation_id: "agyop_unknown_missing_9999" },
      }),
    );
    assert.equal(missingRes.found, false);
    assert.equal(missingRes.status, "NOT_FOUND");
    assert.equal(missingRes.retry_safety.retry_permitted, false);

    // Acceptance criterion 8: Workspace containment STILL rejects direct access to the host-state roots
    const openOpRoot = await client.callTool({
      name: "open_workspace",
      arguments: { path: opRoot, mode: "checkout" },
    });
    assert.equal(openOpRoot.isError, true);
    const errText = (openOpRoot.content as Array<{ type: string; text?: string }>).find(
      (c) => c.type === "text",
    )?.text;
    assert.ok(
      errText?.includes("Path is outside allowed roots"),
      `Expected 'Path is outside allowed roots', got: ${errText}`,
    );

    const openLeases = await client.callTool({
      name: "open_workspace",
      arguments: { path: leasesDir, mode: "checkout" },
    });
    assert.equal(openLeases.isError, true);
  } finally {
    await client.close().catch(() => {});
    await running.close();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "Live host journal readback verifies actual DSH operations on the current machine",
  { skip: process.env.DEVSPACE_RUN_LIVE_AGY_JOURNAL_TEST !== "1" },
  async () => {
  const liveOp1 = "agyop_a5d29c430378469da9a8fa79d6fe84a8";
  const liveOp2 = "agyop_67c6950aaff347eb95e3357ed498c39a";
  const liveOp3 = "agyop_452a8b4217b24fc58118a3e6439a5f8f";

  // Test against canonical default paths
  const res1 = await readExternalHostOperationStatus(liveOp1);
  if (!res1.found) {
    // If not running on the specific machine where DSH ran, skip live verification
    return;
  }

  assert.equal(res1.found, true);
  assert.equal(res1.status, "COMPLETED");
  assert.equal(res1.exit_code, 0);
  assert.equal(res1.requested_model, "gemini-3.8-flash-low");
  assert.equal(res1.account_alias_hash, "4dcaafa917e1");
  assert.equal(res1.lease_id_hash, "c1aba82d2d75");
  assert.equal(res1.lease_state.status, "released");
  assert.equal(res1.lease_state.residual, false);
  assert.equal(res1.retry_safety.retry_permitted, false);
  assert.equal(res1.output_projection.stdout?.trim(), "MULTI_A_OK");

  const res2 = await readExternalHostOperationStatus(liveOp2);
  assert.equal(res2.found, true);
  assert.equal(res2.status, "COMPLETED");
  assert.equal(res2.exit_code, 0);
  assert.equal(res2.requested_model, "gemini-3.8-flash-low");
  assert.equal(res2.account_alias_hash, "b342e984c538");
  assert.equal(res2.lease_state.status, "released");

  const res3 = await readExternalHostOperationStatus(liveOp3);
  assert.equal(res3.found, true);
  assert.equal(res3.status, "FAILED");
  assert.equal(res3.exit_code, 1);
  assert.equal(res3.failure_kind, "DISPATCH_MODEL_CONTRACT_REJECTED");
  assert.equal(res3.account_alias_hash, "d034504225b1");
  assert.equal(res3.lease_state.status, "released");
  assert.equal(res3.retry_safety.retry_permitted, false);
  },
);

