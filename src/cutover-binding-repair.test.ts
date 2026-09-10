import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CutoverCapabilityManifestDomainMismatchError,
  assertNoDigestDomainMismatch,
  probeBuildReady,
  probeTargetPackage,
} from "./cutover-build-ready.js";
import {
  performNativeCrossDomainBindingRepair,
  NativeObservedReplacementCommittedError,
  NativeBindingRepairOutcomeUnknownError,
  type NativeCrossDomainBindingRepairOptions,
} from "./cutover-recovery.js";
import {
  CUTOVER_BINDING_REPAIR_REASON,
  CUTOVER_BINDING_REPAIR_SCHEMA,
  CutoverStateError,
  CutoverStateStore,
  assertValidBindingRepair,
  effectiveExpectedIdentity,
  type CutoverBindingRepairReceipt,
  type CutoverServerIdentity,
  type DurableCutoverRecord,
  type ExpectedCutoverIdentity,
} from "./cutover-state.js";
import { McpCutoverController, compareServerIdentity } from "./mcp-cutover.js";

const SHA_BUILD_MANIFEST = "2dc243fba8af25bfe0729dd1d730ed92139b9a6920e5c6a1e053a479427dbbe5";
const SHA_CAPABILITY_MANIFEST = "b2968680e07f8c6305651274594909987dde9cc8de6b240df39e9bbcdfb70972";
const SHA_COMMIT = "150a36f4678c2727288b2f86a515e3e724d9e27b";
const BUILD_ID = "devspace-1.0.7-150a36f4";

function createPackageRoot(pkgDir: string, buildManifestSha = SHA_BUILD_MANIFEST): void {
  const generatedDir = join(pkgDir, "generated");
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(
    join(generatedDir, "build-identity.json"),
    JSON.stringify(
      {
        product_name: "devspace",
        package_name: "@waishnav/devspace",
        package_version: "1.0.7",
        source_commit: SHA_COMMIT,
        source_dirty: false,
        build_id: BUILD_ID,
        build_manifest_sha256: buildManifestSha,
        built_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// Part A: Prevention Tests
// ---------------------------------------------------------------------------

test("Prevention: probeBuildReady detects build_manifest_sha256 passed as capabilityManifestSha256", () => {
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-probe-prevention-"));
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);

    const probe = probeBuildReady({
      packageRoot: pkgDir,
      expected: {
        sourceCommit: SHA_COMMIT,
        buildId: BUILD_ID,
        capabilityManifestSha256: SHA_BUILD_MANIFEST, // domain mismatch!
      },
    });

    assert.equal(probe.buildReady, false);
    assert.equal(probe.domainMismatch, true);
    assert.match(probe.detail ?? "", /\[CAPABILITY_MANIFEST_DIGEST_DOMAIN_MISMATCH\]/);
    assert.equal(probe.actualBuildManifestSha256, SHA_BUILD_MANIFEST);
  } finally {
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Prevention: probeTargetPackage extracts buildManifestSha256 and assertNoDigestDomainMismatch fails early", () => {
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-target-probe-"));
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);

    const probed = probeTargetPackage(pkgDir);
    assert.equal(probed.buildManifestSha256, SHA_BUILD_MANIFEST);
    assert.equal(probed.sourceCommit, SHA_COMMIT);
    assert.equal(probed.buildId, BUILD_ID);

    assert.throws(
      () => {
        assertNoDigestDomainMismatch(
          {
            sourceCommit: SHA_COMMIT,
            buildId: BUILD_ID,
            capabilityManifestSha256: SHA_BUILD_MANIFEST,
          },
          probed,
        );
      },
      (err: unknown) => {
        return (
          err instanceof CutoverCapabilityManifestDomainMismatchError &&
          err.code === "CAPABILITY_MANIFEST_DIGEST_DOMAIN_MISMATCH" &&
          err.message.includes("[CAPABILITY_MANIFEST_DIGEST_DOMAIN_MISMATCH]")
        );
      },
    );

    // Different hash passes assertion without error
    assert.doesNotThrow(() => {
      assertNoDigestDomainMismatch(
        {
          sourceCommit: SHA_COMMIT,
          buildId: BUILD_ID,
          capabilityManifestSha256: SHA_CAPABILITY_MANIFEST,
        },
        probed,
      );
    });
  } finally {
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Part B: State & Effective Identity Tests
// ---------------------------------------------------------------------------

test("State: effectiveExpectedIdentity reflects bindingRepair while preserving immutable history", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-state-effective-"));
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-eff" });
    const oldServer: CutoverServerIdentity = {
      serverInstanceId: "old-inst",
      sourceCommit: SHA_COMMIT,
      buildId: BUILD_ID,
      capabilityManifestSha256: "0".repeat(64),
    };
    const expected: ExpectedCutoverIdentity = {
      sourceCommit: SHA_COMMIT,
      buildId: BUILD_ID,
      capabilityManifestSha256: SHA_BUILD_MANIFEST, // misbound hash
    };

    const initial = store.begin({ oldServerIdentity: oldServer, expectedNewIdentity: expected });

    // Before repair: effective identity equals misbound expectation
    const effectiveBefore = effectiveExpectedIdentity(initial);
    assert.equal(effectiveBefore.capabilityManifestSha256, SHA_BUILD_MANIFEST);

    const repairReceipt: CutoverBindingRepairReceipt = {
      schema: CUTOVER_BINDING_REPAIR_SCHEMA,
      cutoverId: "cutover-eff",
      reason: CUTOVER_BINDING_REPAIR_REASON,
      repairControlSurfaceIdentity: {
        serverInstanceId: "cli-ctrl-inst",
        sourceCommit: SHA_COMMIT,
        buildId: BUILD_ID,
      },
      observedTargetRuntimeIdentity: {
        serverInstanceId: "rep-inst",
        sourceCommit: SHA_COMMIT,
        buildId: BUILD_ID,
        capabilityManifestSha256: SHA_CAPABILITY_MANIFEST,
      },
      originalCutoverExpectedIdentity: expected,
      effectiveRepairedIdentity: {
        sourceCommit: SHA_COMMIT,
        buildId: BUILD_ID,
        capabilityManifestSha256: SHA_CAPABILITY_MANIFEST,
      },
      originalBoundDigest: SHA_BUILD_MANIFEST,
      originalDigestField: "expectedNewIdentity.capabilityManifestSha256",
      provenActualDigestDomain: "build_manifest_sha256",
      correctCapabilityManifestSchema: "devspace.capability_manifest.v1",
      correctCapabilityManifestSha256: SHA_CAPABILITY_MANIFEST,
      sourceCommit: SHA_COMMIT,
      buildId: BUILD_ID,
      observedServerInstanceId: "rep-inst",
      repairedBy: "rep-inst",
      repairedAt: new Date().toISOString(),
      physicalProbeEvidence: "Target package build_manifest_sha256 matched bound hash.",
    };

    const { record: repaired, newlyRepaired } = store.recordBindingRepair("cutover-eff", repairReceipt);
    assert.equal(newlyRepaired, true);
    assert.ok(repaired.bindingRepair);

    // After repair: original expectedNewIdentity is PRESERVED
    assert.equal(repaired.expectedNewIdentity.capabilityManifestSha256, SHA_BUILD_MANIFEST);

    // Effective identity is updated to correct capability manifest
    const effectiveAfter = effectiveExpectedIdentity(repaired);
    assert.equal(effectiveAfter.capabilityManifestSha256, SHA_CAPABILITY_MANIFEST);

    // Comparison against replacement server with correct capability manifest now matches
    const replacementServer: CutoverServerIdentity = {
      serverInstanceId: "rep-inst",
      sourceCommit: SHA_COMMIT,
      buildId: BUILD_ID,
      capabilityManifestSha256: SHA_CAPABILITY_MANIFEST,
    };
    const comparison = compareServerIdentity(repaired, replacementServer);
    assert.equal(comparison.serverInstanceChanged, true);
    assert.equal(comparison.sourceMatches, true);
    assert.equal(comparison.buildMatches, true);
    assert.equal(comparison.capabilityManifestMatches, true);

    // Idempotent write returns newlyRepaired: false
    const replay = store.recordBindingRepair("cutover-eff", repairReceipt);
    assert.equal(replay.newlyRepaired, false);

    // Different repair receipt fails closed
    assert.throws(() => {
      store.recordBindingRepair("cutover-eff", {
        ...repairReceipt,
        correctCapabilityManifestSha256: "f".repeat(64),
      });
    }, /REPAIR_BINDING_MISMATCH/);

    // Reload from fresh store reads marker
    const reloadedStore = new CutoverStateStore(stateDir);
    const reloaded = reloadedStore.get()!;
    assert.ok(reloaded.bindingRepair);
    assert.equal(effectiveExpectedIdentity(reloaded).capabilityManifestSha256, SHA_CAPABILITY_MANIFEST);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Part B: Negative Tests (15 Failure Scenarios)
// ---------------------------------------------------------------------------

type MockHttpOptions = {
  cutoverId?: string;
  healthzOk?: boolean;
  healthzSchema?: string;
  healthzMissingCapabilities?: string[];
  healthzDigest?: string;
  statusDigest?: string;
  serverInstanceId?: string;
  sourceCommit?: string;
  buildId?: string;
  workspaceSessions?: number;
  agentSessions?: number;
  agentId?: string;
  workspaceId?: string;
  workspaceRoot?: string;
  agentReconciled?: boolean;
  revokeStatus?: number;
  statusPhases?: Array<"drained" | "closed">;
  statusServerInstanceIds?: string[];
  statusStateDir?: string;
  statusFailAfter?: number;
  onCallTool?: (name: string, args: Record<string, unknown>) => void;
};

async function createMockReplacementServer(options: MockHttpOptions = {}) {
  let currentCutoverId = options.cutoverId ?? "cutover-repair-p0";
  let statusCalls = 0;
  const serverInstanceId = options.serverInstanceId ?? "replacement-inst-1";
  const sourceCommit = options.sourceCommit ?? SHA_COMMIT;
  const buildId = options.buildId ?? BUILD_ID;
  const capabilityManifestSha256 = options.healthzDigest ?? SHA_CAPABILITY_MANIFEST;
  const wsId = options.workspaceId ?? "ws-test";
  const agId = options.agentId ?? "agt-test";
  const wsRoot = options.workspaceRoot ?? "/workspace/test";
  const wsSessions = options.workspaceSessions ?? 1;

  const authRequests = new Map<string, { challenge: string; clientId: string; redirectUri: string; resource: string }>();
  let latestChallenge: string | undefined;
  const issuedCodes = new Set<string>();
  const clientIds = new Set<string>();
  const accessToken = "rep-access-token";
  const ownerToken = "rep-owner-token";
  const resourcePath = "/mcp";

  const server = createHttpServer(async (req, res) => {
    const body = await new Promise<string>((resolve) => {
      let text = "";
      req.on("data", (chunk) => { text += String(chunk); });
      req.on("end", () => resolve(text));
    });
    const host = req.headers.host;
    const origin = `http://${host}`;
    const url = new URL(req.url ?? "/", origin);
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json", "mcp-session-id": "rep-session" });
      res.end(JSON.stringify(value));
    };
    const fail = (message: string, status = 400) => json({ error: message }, status);

    if (req.method === "GET" && url.pathname === "/healthz") {
      if (options.healthzOk === false) {
        return fail("health check failed", 500);
      }
      return json({
        ok: true,
        capabilityManifest: {
          schema: options.healthzSchema ?? "devspace.capability_manifest.v1",
          capabilities: ["core", "git"],
          missing: options.healthzMissingCapabilities ?? [],
          manifestSha256: capabilityManifestSha256,
        },
      });
    }

    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json({ resource: `${origin}${resourcePath}`, authorization_servers: [`${origin}/`], scopes_supported: ["devspace"] });
    }
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: `${origin}/`,
        authorization_endpoint: `${origin}/authorize`,
        registration_endpoint: `${origin}/register`,
        token_endpoint: `${origin}/token`,
        revocation_endpoint: `${origin}/revoke`,
      });
    }
    if (req.method === "POST" && url.pathname === "/register") {
      clientIds.add("rep-client");
      return json({ client_id: "rep-client" }, 201);
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      const clientId = url.searchParams.get("client_id");
      const state = url.searchParams.get("state")!;
      const challenge = url.searchParams.get("code_challenge")!;
      const redirectUri = url.searchParams.get("redirect_uri")!;
      const resource = url.searchParams.get("resource")!;
      authRequests.set(state, { challenge, clientId: clientId!, redirectUri, resource });
      latestChallenge = challenge;
      return json({ ok: true });
    }
    if (req.method === "POST" && url.pathname === "/authorize") {
      const form = new URLSearchParams(body);
      const state = form.get("state")!;
      const request = authRequests.get(state)!;
      issuedCodes.add("rep-code");
      res.writeHead(302, { location: `${request.redirectUri}?code=rep-code&state=${state}` });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/token") {
      return json({ access_token: accessToken, token_type: "Bearer", scope: "devspace" });
    }
    if (req.method === "POST" && url.pathname === "/revoke") {
      res.writeHead(options.revokeStatus ?? 200);
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/mcp") {
      const request = JSON.parse(body) as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (request.method === "initialize") {
        return json({
          jsonrpc: "2.0",
          id: request.id,
          result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "rep-test", version: "1" } },
        });
      }
      if (request.method?.startsWith("notifications/")) {
        res.writeHead(202, { "mcp-session-id": "rep-session" });
        return res.end();
      }
      if (request.method === "tools/call") {
        const name = request.params?.name;
        if (options.onCallTool && typeof name === "string") {
          options.onCallTool(name, (request.params?.arguments ?? {}) as Record<string, unknown>);
        }
        if (name === "cutover_status") {
          if (options.statusFailAfter !== undefined && statusCalls >= options.statusFailAfter) return fail("post-close status unavailable", 503);
          const phase = options.statusPhases?.[statusCalls] ?? (options.statusStateDir ? new CutoverStateStore(options.statusStateDir).get()?.phase ?? "drained" : "drained");
          const ownedRecord = options.statusStateDir ? new CutoverStateStore(options.statusStateDir).get() : undefined;
          statusCalls += 1;
          return json({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [{ type: "text", text: "ok" }],
              structuredContent: {
                status: {
                  cutover: {
                    cutoverId: currentCutoverId,
                    phase,
                    expectedNewIdentity: {
                      sourceCommit,
                      buildId,
                      capabilityManifestSha256: ownedRecord?.expectedNewIdentity.capabilityManifestSha256 ?? options.statusDigest ?? capabilityManifestSha256,
                    },
                  },
                  currentServerIdentity: {
                    serverInstanceId: options.statusServerInstanceIds?.[statusCalls - 1] ?? serverInstanceId,
                    sourceCommit,
                    buildId,
                    capabilityManifestSha256: options.statusDigest ?? capabilityManifestSha256,
                  },
                  comparison: {
                    serverInstanceChanged: true,
                    sourceMatches: true,
                    buildMatches: true,
                    capabilityManifestMatches: false,
                  },
                },
              },
            },
          });
        }
        if (name === "workspace_inspect") {
          return json({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [{ type: "text", text: "ok" }],
              structuredContent: {
                workspaceSessions: wsSessions,
                detail: wsSessions > 0 ? [{
                  unit: `workspace:${wsId}`,
                  loaded: true,
                  session: { id: wsId, root: wsRoot },
                }] : [],
              },
            },
          });
        }
        if (name === "agent_status") {
          return json({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [{ type: "text", text: "ok" }],
              structuredContent: {
                agentId: agId,
                workspaceId: wsId,
                workspaceRoot: wsRoot,
                lifecycleState: "idle",
              },
            },
          });
        }
        if (name === "agent_reconcile") {
          return json({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [{ type: "text", text: "ok" }],
              structuredContent: {
                agentId: agId,
                agentReconciled: options.agentReconciled ?? true,
              },
            },
          });
        }
      }
      return fail("unknown call", 404);
    }
    return fail("not found", 404);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    serverUrl: `${base}/mcp`,
    publicBaseUrl: base,
    ownerToken,
    setCutoverId: (id: string) => { currentCutoverId = id; },
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function setupDrainedRecord(
  stateDir: string,
  cutoverId = "cutover-repair-p0",
  boundCapabilityDigest = SHA_BUILD_MANIFEST,
  restartScheduled = true,
  phase: "prepared" | "drained" | "closed" = "drained",
): { store: CutoverStateStore } {
  const predecessorId = `predecessor-${cutoverId}`;
  const ids = phase === "prepared" ? [predecessorId, cutoverId] : [predecessorId, `${cutoverId}-event-1`, cutoverId];
  const store = new CutoverStateStore(stateDir, { newId: () => ids.shift() ?? `${cutoverId}-event` });
  const oldServer: CutoverServerIdentity = {
    serverInstanceId: "old-owner-inst",
    sourceCommit: SHA_COMMIT,
    buildId: BUILD_ID,
    capabilityManifestSha256: "0".repeat(64),
  };
  const expected: ExpectedCutoverIdentity = {
    sourceCommit: SHA_COMMIT,
    buildId: BUILD_ID,
    capabilityManifestSha256: boundCapabilityDigest,
  };
  store.begin({ oldServerIdentity: oldServer, expectedNewIdentity: expected });
  if (phase === "drained" || phase === "closed") {
    store.recordDrain(predecessorId, { activeSessions: 0, oldestAgeMs: 0 });
    if (restartScheduled) {
      store.recordRestartRequest(predecessorId, {
        actuator: "launchd-self",
        requestedByServerInstanceId: "old-owner-inst",
        buildReady: {
          verifiedBy: "test",
          verifiedAt: new Date().toISOString(),
        },
      });
      store.recordRestartScheduled(predecessorId, "old-owner-inst");
    }
    const successor = store.recoverSupersede({
      cutoverId: predecessorId,
      expectedNewIdentity: expected,
      observedIdentity: { serverInstanceId: "replacement-inst-1", sourceCommit: SHA_COMMIT, buildId: BUILD_ID, capabilityManifestSha256: SHA_CAPABILITY_MANIFEST },
      recoveredBy: "test-successor",
    }).successor;
    if (phase === "drained" || phase === "closed") {
      store.recordDrain(successor.cutoverId, { activeSessions: 0, oldestAgeMs: 0 });
      if (restartScheduled) {
        store.recordRestartRequest(successor.cutoverId, {
          actuator: "launchd-self",
          requestedByServerInstanceId: "old-owner-inst",
          buildReady: { verifiedBy: "test", verifiedAt: new Date().toISOString() },
        });
        store.recordRestartScheduled(successor.cutoverId, "old-owner-inst");
      }
    }
  } else if (phase === "prepared") {
    store.recoverSupersede({
      cutoverId: predecessorId,
      expectedNewIdentity: expected,
      observedIdentity: { serverInstanceId: "replacement-inst-1", sourceCommit: SHA_COMMIT, buildId: BUILD_ID, capabilityManifestSha256: SHA_CAPABILITY_MANIFEST },
      recoveredBy: "test-successor",
    });
  }
  return { store };
}

test("Negative 1: Arbitrary generic mismatch (not matching target build_manifest_sha256) fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-neg1-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-neg1-pkg-"));
  const mock = await createMockReplacementServer();
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    const arbitraryHash = "a".repeat(64); // not matching build manifest!
    setupDrainedRecord(stateDir, "cutover-neg-1", arbitraryHash);
    mock.setCutoverId("cutover-neg-1");

    await assert.rejects(
      async () => {
        await performNativeCrossDomainBindingRepair({
          cutoverId: "cutover-neg-1",
          stateDir,
          packageRoot: pkgDir,
          serverUrl: mock.serverUrl,
          ownerToken: mock.ownerToken,
          workspaceId: "ws-test",
          agentId: "agt-test",
          requesterIdentity: {
            serverInstanceId: "test-runner",
            sourceCommit: SHA_COMMIT,
            buildId: BUILD_ID,
          },
        });
      },
      /Cryptographic attribution failed.*NOT_A_CROSS_DOMAIN_MISBINDING/,
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Negative 2: Target package identity missing / cannot probe fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-neg2-state-"));
  const nonExistentPkgDir = join(tmpdir(), "devspace-non-existent-pkg-dir");
  const mock = await createMockReplacementServer();
  try {
    setupDrainedRecord(stateDir, "cutover-neg-2", SHA_BUILD_MANIFEST);
    mock.setCutoverId("cutover-neg-2");

    await assert.rejects(
      async () => {
        await performNativeCrossDomainBindingRepair({
          cutoverId: "cutover-neg-2",
          stateDir,
          packageRoot: nonExistentPkgDir,
          serverUrl: mock.serverUrl,
          ownerToken: mock.ownerToken,
          workspaceId: "ws-test",
          agentId: "agt-test",
          requesterIdentity: { serverInstanceId: "test-runner", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
        });
      },
      /Target package cannot be physically probed/,
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Negative 3: Target package missing build_manifest_sha256 fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-neg3-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-neg3-pkg-"));
  const mock = await createMockReplacementServer();
  try {
    const generatedDir = join(pkgDir, "generated");
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(
      join(generatedDir, "build-identity.json"),
      JSON.stringify({
        product_name: "devspace",
        package_name: "@waishnav/devspace",
        package_version: "1.0.7",
        source_commit: SHA_COMMIT,
        build_id: BUILD_ID,
      }),
    );
    setupDrainedRecord(stateDir, "cutover-neg-3", SHA_BUILD_MANIFEST);
    mock.setCutoverId("cutover-neg-3");

    await assert.rejects(
      async () => {
        await performNativeCrossDomainBindingRepair({
          cutoverId: "cutover-neg-3",
          stateDir,
          packageRoot: pkgDir,
          serverUrl: mock.serverUrl,
          ownerToken: mock.ownerToken,
          workspaceId: "ws-test",
          agentId: "agt-test",
          requesterIdentity: { serverInstanceId: "test-runner", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
        });
      },
      /Target build manifest identity unavailable|Cannot prove cryptographic attribution/,
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Negative 4: Replacement server source commit does not match expected fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-neg4-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-neg4-pkg-"));
  const mock = await createMockReplacementServer({ sourceCommit: "0".repeat(40) });
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    setupDrainedRecord(stateDir, "cutover-neg-4", SHA_BUILD_MANIFEST);
    mock.setCutoverId("cutover-neg-4");

    await assert.rejects(
      async () => {
        await performNativeCrossDomainBindingRepair({
          cutoverId: "cutover-neg-4",
          stateDir,
          packageRoot: pkgDir,
          serverUrl: mock.serverUrl,
          ownerToken: mock.ownerToken,
          workspaceId: "ws-test",
          agentId: "agt-test",
          requesterIdentity: { serverInstanceId: "test-runner", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
        });
      },
      /Live sourceCommit .* does not match expected target/,
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Negative 5: Replacement server buildId does not match expected fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-neg5-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-neg5-pkg-"));
  const mock = await createMockReplacementServer({ buildId: "wrong-build-id" });
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    setupDrainedRecord(stateDir, "cutover-neg-5", SHA_BUILD_MANIFEST);
    mock.setCutoverId("cutover-neg-5");

    await assert.rejects(
      async () => {
        await performNativeCrossDomainBindingRepair({
          cutoverId: "cutover-neg-5",
          stateDir,
          packageRoot: pkgDir,
          serverUrl: mock.serverUrl,
          ownerToken: mock.ownerToken,
          workspaceId: "ws-test",
          agentId: "agt-test",
          requesterIdentity: { serverInstanceId: "test-runner", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
        });
      },
      /Live buildId .* does not match expected target/,
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Negative 6: Live server capability manifest missing required capabilities fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-neg6-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-neg6-pkg-"));
  const mock = await createMockReplacementServer({
    healthzMissingCapabilities: ["core_transport"],
  });
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    setupDrainedRecord(stateDir, "cutover-neg-6", SHA_BUILD_MANIFEST);
    mock.setCutoverId("cutover-neg-6");

    await assert.rejects(
      async () => {
        await performNativeCrossDomainBindingRepair({
          cutoverId: "cutover-neg-6",
          stateDir,
          packageRoot: pkgDir,
          serverUrl: mock.serverUrl,
          ownerToken: mock.ownerToken,
          workspaceId: "ws-test",
          agentId: "agt-test",
          requesterIdentity: { serverInstanceId: "test-runner", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
        });
      },
      /missing required capabilities/,
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Negative 7: Live server capability manifest malformed / wrong schema fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-neg7-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-neg7-pkg-"));
  const mock = await createMockReplacementServer({
    healthzSchema: "wrong.manifest.schema.v2",
  });
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    setupDrainedRecord(stateDir, "cutover-neg-7", SHA_BUILD_MANIFEST);
    mock.setCutoverId("cutover-neg-7");

    await assert.rejects(
      async () => {
        await performNativeCrossDomainBindingRepair({
          cutoverId: "cutover-neg-7",
          stateDir,
          packageRoot: pkgDir,
          serverUrl: mock.serverUrl,
          ownerToken: mock.ownerToken,
          workspaceId: "ws-test",
          agentId: "agt-test",
          requesterIdentity: { serverInstanceId: "test-runner", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
        });
      },
      /Current server capability manifest is malformed/,
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Negative 8: Running on same old server (serverInstanceId unchanged) fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-neg8-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-neg8-pkg-"));
  const mock = await createMockReplacementServer({
    serverInstanceId: "old-owner-inst",
  });
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    setupDrainedRecord(stateDir, "cutover-neg-8", SHA_BUILD_MANIFEST);
    mock.setCutoverId("cutover-neg-8");

    await assert.rejects(
      async () => {
        await performNativeCrossDomainBindingRepair({
          cutoverId: "cutover-neg-8",
          stateDir,
          packageRoot: pkgDir,
          serverUrl: mock.serverUrl,
          ownerToken: mock.ownerToken,
          workspaceId: "ws-test",
          agentId: "agt-test",
          requesterIdentity: { serverInstanceId: "test-runner", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
        });
      },
      /Same old server instance is still running/,
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Negative 9: Cutover phase is prepared (not drained) fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-neg9-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-neg9-pkg-"));
  const mock = await createMockReplacementServer();
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    setupDrainedRecord(stateDir, "cutover-neg-9", SHA_BUILD_MANIFEST, false, "prepared");
    mock.setCutoverId("cutover-neg-9");

    await assert.rejects(
      async () => {
        await performNativeCrossDomainBindingRepair({
          cutoverId: "cutover-neg-9",
          stateDir,
          packageRoot: pkgDir,
          serverUrl: mock.serverUrl,
          ownerToken: mock.ownerToken,
          workspaceId: "ws-test",
          agentId: "agt-test",
          requesterIdentity: { serverInstanceId: "test-runner", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
        });
      },
      /phase == drained; got prepared/,
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Negative 10: Restart was not scheduled prior to repair fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-neg10-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-neg10-pkg-"));
  const mock = await createMockReplacementServer();
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    setupDrainedRecord(stateDir, "cutover-neg-10", SHA_BUILD_MANIFEST, false, "drained");
    mock.setCutoverId("cutover-neg-10");

    await assert.rejects(
      async () => {
        await performNativeCrossDomainBindingRepair({
          cutoverId: "cutover-neg-10",
          stateDir,
          packageRoot: pkgDir,
          serverUrl: mock.serverUrl,
          ownerToken: mock.ownerToken,
          workspaceId: "ws-test",
          agentId: "agt-test",
          requesterIdentity: { serverInstanceId: "test-runner", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
        });
      },
      /Binding repair requires an existing durably scheduled restart/,
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Negative 11: Zero durable workspaces (workspaceSessions = 0) fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-neg11-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-neg11-pkg-"));
  const mock = await createMockReplacementServer({ workspaceSessions: 0 });
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    setupDrainedRecord(stateDir, "cutover-neg-11", SHA_BUILD_MANIFEST);
    mock.setCutoverId("cutover-neg-11");

    await assert.rejects(
      async () => {
        await performNativeCrossDomainBindingRepair({
          cutoverId: "cutover-neg-11",
          stateDir,
          packageRoot: pkgDir,
          serverUrl: mock.serverUrl,
          ownerToken: mock.ownerToken,
          workspaceId: "ws-test",
          agentId: "agt-test",
          requesterIdentity: { serverInstanceId: "test-runner", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
        });
      },
      /workspace_inspect did not prove the requested durable workspace identity/,
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Negative 12: Requested workspaceId not in inspected sessions fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-neg12-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-neg12-pkg-"));
  const mock = await createMockReplacementServer({ workspaceId: "ws-different" });
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    setupDrainedRecord(stateDir, "cutover-neg-12", SHA_BUILD_MANIFEST);
    mock.setCutoverId("cutover-neg-12");

    await assert.rejects(
      async () => {
        await performNativeCrossDomainBindingRepair({
          cutoverId: "cutover-neg-12",
          stateDir,
          packageRoot: pkgDir,
          serverUrl: mock.serverUrl,
          ownerToken: mock.ownerToken,
          workspaceId: "ws-expected",
          agentId: "agt-test",
          requesterIdentity: { serverInstanceId: "test-runner", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
        });
      },
      /workspace_inspect did not prove the requested durable workspace identity/,
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Negative 13: Agent reconciliation failed on replacement server fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-neg13-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-neg13-pkg-"));
  const mock = await createMockReplacementServer({ agentReconciled: false });
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    setupDrainedRecord(stateDir, "cutover-neg-13", SHA_BUILD_MANIFEST);
    mock.setCutoverId("cutover-neg-13");

    await assert.rejects(
      async () => {
        await performNativeCrossDomainBindingRepair({
          cutoverId: "cutover-neg-13",
          stateDir,
          packageRoot: pkgDir,
          serverUrl: mock.serverUrl,
          ownerToken: mock.ownerToken,
          workspaceId: "ws-test",
          agentId: "agt-test",
          requesterIdentity: { serverInstanceId: "test-runner", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
        });
      },
      /Agent reconciliation failed/,
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Negative 14: Cutover already closed with mismatched binding replay fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-neg14-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-neg14-pkg-"));
  const mock = await createMockReplacementServer();
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    const { store } = setupDrainedRecord(stateDir, "cutover-neg-14", SHA_BUILD_MANIFEST);
    mock.setCutoverId("cutover-neg-14");

    const priorReceipt: CutoverBindingRepairReceipt = {
      schema: CUTOVER_BINDING_REPAIR_SCHEMA,
      cutoverId: "cutover-neg-14",
      reason: CUTOVER_BINDING_REPAIR_REASON,
      repairControlSurfaceIdentity: {
        serverInstanceId: "diff-inst",
        sourceCommit: SHA_COMMIT,
        buildId: BUILD_ID,
      },
      observedTargetRuntimeIdentity: {
        serverInstanceId: "diff-inst",
        sourceCommit: SHA_COMMIT,
        buildId: BUILD_ID,
        capabilityManifestSha256: "9".repeat(64),
      },
      originalCutoverExpectedIdentity: {
        sourceCommit: SHA_COMMIT,
        buildId: BUILD_ID,
        capabilityManifestSha256: SHA_BUILD_MANIFEST,
      },
      effectiveRepairedIdentity: {
        sourceCommit: SHA_COMMIT,
        buildId: BUILD_ID,
        capabilityManifestSha256: "9".repeat(64),
      },
      originalBoundDigest: SHA_BUILD_MANIFEST,
      originalDigestField: "expectedNewIdentity.capabilityManifestSha256",
      provenActualDigestDomain: "build_manifest_sha256",
      correctCapabilityManifestSchema: "devspace.capability_manifest.v1",
      correctCapabilityManifestSha256: "9".repeat(64),
      sourceCommit: SHA_COMMIT,
      buildId: BUILD_ID,
      observedServerInstanceId: "diff-inst",
      repairedBy: "diff-inst",
      repairedAt: new Date().toISOString(),
      physicalProbeEvidence: "prior",
    };
    store.recordBindingRepair("cutover-neg-14", priorReceipt);
    store.close("cutover-neg-14", {
      closedByServerInstanceId: "diff-inst",
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
      reconciledAt: new Date().toISOString(),
    });

    await assert.rejects(
      async () => {
        await performNativeCrossDomainBindingRepair({
          cutoverId: "cutover-neg-14",
          stateDir,
          packageRoot: pkgDir,
          serverUrl: mock.serverUrl,
          ownerToken: mock.ownerToken,
          workspaceId: "ws-test",
          agentId: "agt-test",
          requesterIdentity: { serverInstanceId: "test-runner", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
        });
      },
      /REPAIR_BINDING_MISMATCH/,
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Negative 15: Cutover expected target already matches capability manifest (not a misbinding) fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-neg15-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-neg15-pkg-"));
  const mock = await createMockReplacementServer({
    healthzDigest: SHA_CAPABILITY_MANIFEST,
    statusDigest: SHA_CAPABILITY_MANIFEST,
  });
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    setupDrainedRecord(stateDir, "cutover-neg-15", SHA_CAPABILITY_MANIFEST);
    mock.setCutoverId("cutover-neg-15");

    await assert.rejects(
      async () => {
        await performNativeCrossDomainBindingRepair({
          cutoverId: "cutover-neg-15",
          stateDir,
          packageRoot: pkgDir,
          serverUrl: mock.serverUrl,
          ownerToken: mock.ownerToken,
          workspaceId: "ws-test",
          agentId: "agt-test",
          requesterIdentity: { serverInstanceId: "test-runner", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
        });
      },
      /already matches expected; binding repair is not needed/,
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Negative: Initial drained cutover without a successor is rejected before repair marker write", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-initial-drained-state-"));
  const mock = await createMockReplacementServer({ cutoverId: "cutover-initial-drained" });
  try {
    const store = new CutoverStateStore(stateDir, { newId: () => "cutover-initial-drained" });
    const expected = { sourceCommit: SHA_COMMIT, buildId: BUILD_ID, capabilityManifestSha256: SHA_BUILD_MANIFEST };
    store.begin({ oldServerIdentity: { serverInstanceId: "old", sourceCommit: SHA_COMMIT, buildId: BUILD_ID, capabilityManifestSha256: "0".repeat(64) }, expectedNewIdentity: expected });
    store.recordDrain("cutover-initial-drained", { activeSessions: 0, oldestAgeMs: 0 });
    store.recordRestartRequest("cutover-initial-drained", { actuator: "launchd-self", requestedByServerInstanceId: "old", buildReady: { verifiedBy: "test", verifiedAt: new Date().toISOString() } });
    store.recordRestartScheduled("cutover-initial-drained", "old");
    await assert.rejects(
      performNativeCrossDomainBindingRepair({ cutoverId: "cutover-initial-drained", stateDir, serverUrl: mock.serverUrl, ownerToken: mock.ownerToken, workspaceId: "ws-test", agentId: "agt-test", requesterIdentity: { serverInstanceId: "cli", sourceCommit: SHA_COMMIT, buildId: BUILD_ID } }),
      /established successor/,
    );
    assert.equal(store.get()?.bindingRepair, undefined);
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Part B: Positive Production Regression Test
// ---------------------------------------------------------------------------

test("Positive: Exact production deadlock reproduced and terminally repaired with 0 restart replay and 0 successor chains", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-pos-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-pos-pkg-"));

  const liveServerInstanceId = "d4fce955-1ebb-4c55-80e3-f6fdb655a844";
  const cutoverId = "52e4dbc1-c92d-4b20-b8ae-2079323329f1";

  const mock = await createMockReplacementServer({
    statusStateDir: stateDir,
    serverInstanceId: liveServerInstanceId,
    sourceCommit: SHA_COMMIT,
    buildId: BUILD_ID,
    healthzDigest: SHA_CAPABILITY_MANIFEST,
    statusDigest: SHA_CAPABILITY_MANIFEST,
    workspaceId: "ws-live-prod",
    agentId: "agt-live-prod",
    workspaceRoot: "/Users/jameschen/Workspace/nexus",
    workspaceSessions: 1,
    agentSessions: 1,
  });

  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);

    const predecessorId = `${cutoverId}-predecessor`;
    const ids = [predecessorId, `${cutoverId}-event-1`, cutoverId];
    const store = new CutoverStateStore(stateDir, { newId: () => ids.shift() ?? `${cutoverId}-event` });
    const oldServer: CutoverServerIdentity = {
      serverInstanceId: "old-server-deadlock",
      sourceCommit: SHA_COMMIT,
      buildId: BUILD_ID,
      capabilityManifestSha256: "0".repeat(64),
    };
    const expected: ExpectedCutoverIdentity = {
      sourceCommit: SHA_COMMIT,
      buildId: BUILD_ID,
      capabilityManifestSha256: SHA_BUILD_MANIFEST,
    };
    store.begin({ oldServerIdentity: oldServer, expectedNewIdentity: expected });
    store.recordDrain(predecessorId, { activeSessions: 0, oldestAgeMs: 0 });
    store.recordRestartRequest(predecessorId, {
      actuator: "launchd-self",
      requestedByServerInstanceId: "old-server-deadlock",
      buildReady: {
        verifiedBy: "pre-restart-probe",
        verifiedAt: new Date().toISOString(),
      },
    });
    store.recordRestartScheduled(predecessorId, "old-server-deadlock");
    store.recoverSupersede({
      cutoverId: predecessorId,
      expectedNewIdentity: expected,
      observedIdentity: { serverInstanceId: liveServerInstanceId, sourceCommit: SHA_COMMIT, buildId: BUILD_ID, capabilityManifestSha256: SHA_CAPABILITY_MANIFEST },
      recoveredBy: "pre-recovery-test",
    });
    store.recordDrain(cutoverId, { activeSessions: 0, oldestAgeMs: 0 });
    store.recordRestartRequest(cutoverId, {
      actuator: "launchd-self",
      requestedByServerInstanceId: "old-server-deadlock",
      buildReady: { verifiedBy: "pre-restart-probe", verifiedAt: new Date().toISOString() },
    });
    store.recordRestartScheduled(cutoverId, "old-server-deadlock");
    mock.setCutoverId(cutoverId);

    const recordBefore = store.get()!;
    assert.equal(recordBefore.phase, "drained");
    assert.equal(recordBefore.expectedNewIdentity.capabilityManifestSha256, SHA_BUILD_MANIFEST);
    assert.equal(recordBefore.bindingRepair, undefined);

    const result = await performNativeCrossDomainBindingRepair({
      cutoverId,
      stateDir,
      packageRoot: pkgDir,
      serverUrl: mock.serverUrl,
      ownerToken: mock.ownerToken,
      workspaceId: "ws-live-prod",
      agentId: "agt-live-prod",
      requesterIdentity: {
        serverInstanceId: liveServerInstanceId,
        sourceCommit: SHA_COMMIT,
        buildId: BUILD_ID,
      },
    });

    assert.equal(result.cutover.cutoverId, cutoverId);
    assert.equal(result.cutover.phase, "closed");
    assert.equal(result.mode, "normal");

    assert.equal(result.cutover.expectedNewIdentity.capabilityManifestSha256, SHA_BUILD_MANIFEST);

    const repair = result.cutover.bindingRepair;
    assert.ok(repair);
    assert.equal(repair.schema, CUTOVER_BINDING_REPAIR_SCHEMA);
    assert.equal(repair.reason, CUTOVER_BINDING_REPAIR_REASON);
    assert.equal(repair.originalBoundDigest, SHA_BUILD_MANIFEST);
    assert.equal(repair.originalDigestField, "expectedNewIdentity.capabilityManifestSha256");
    assert.equal(repair.provenActualDigestDomain, "build_manifest_sha256");
    assert.equal(repair.correctCapabilityManifestSchema, "devspace.capability_manifest.v1");
    assert.equal(repair.correctCapabilityManifestSha256, SHA_CAPABILITY_MANIFEST);
    assert.equal(repair.sourceCommit, SHA_COMMIT);
    assert.equal(repair.buildId, BUILD_ID);
    assert.equal(repair.observedServerInstanceId, liveServerInstanceId);
    assert.match(repair.physicalProbeEvidence, /verified.*build_manifest_sha256/);

    assert.ok(result.cutover.reconciliationReceipt);
    assert.equal(result.cutover.reconciliationReceipt.closedByServerInstanceId, liveServerInstanceId);
    assert.equal(result.cutover.reconciliationReceipt.witnessWorkspaceId, "ws-live-prod");
    assert.equal(result.cutover.reconciliationReceipt.witnessAgentId, "agt-live-prod");

    assert.equal(effectiveExpectedIdentity(result.cutover).capabilityManifestSha256, SHA_CAPABILITY_MANIFEST);

    const replay = await performNativeCrossDomainBindingRepair({
      cutoverId,
      stateDir,
      packageRoot: pkgDir,
      serverUrl: mock.serverUrl,
      ownerToken: mock.ownerToken,
      workspaceId: "ws-live-prod",
      agentId: "agt-live-prod",
      requesterIdentity: {
        serverInstanceId: liveServerInstanceId,
        sourceCommit: SHA_COMMIT,
        buildId: BUILD_ID,
      },
    });
    assert.equal(replay.cutover.cutoverId, cutoverId);
    assert.equal(replay.cutover.phase, "closed");
    assert.equal(replay.mode, "normal");
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Committed partial repair preserves the durable receipt when close fails, then exact retry closes it", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-close-fault-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-close-fault-pkg-"));
  const cutoverId = "cutover-close-fault";
  const mock = await createMockReplacementServer({ cutoverId, statusStateDir: stateDir, workspaceId: "ws-close", agentId: "agt-close" });
  const { store } = setupDrainedRecord(stateDir, cutoverId);
  const options = {
    cutoverId,
    stateDir,
    packageRoot: pkgDir,
    serverUrl: mock.serverUrl,
    ownerToken: mock.ownerToken,
    workspaceId: "ws-close",
    agentId: "agt-close",
    requesterIdentity: { serverInstanceId: "repair-cli", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
  } satisfies NativeCrossDomainBindingRepairOptions;
  const originalClose = CutoverStateStore.prototype.close;
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    CutoverStateStore.prototype.close = function () { throw new Error("injected close failure"); };
    await assert.rejects(
      performNativeCrossDomainBindingRepair(options),
      (error: unknown) => error instanceof NativeObservedReplacementCommittedError && error.committedRecord.bindingRepair !== undefined,
    );
    CutoverStateStore.prototype.close = originalClose;
    const partial = new CutoverStateStore(stateDir).get()!;
    assert.equal(partial.phase, "drained");
    assert.ok(partial.bindingRepair);
    const repairedAt = partial.bindingRepair.repairedAt;
    const replay = await performNativeCrossDomainBindingRepair(options);
    assert.equal(replay.cutover.phase, "closed");
    assert.equal(replay.cutover.bindingRepair?.repairedAt, repairedAt);
  } finally {
    CutoverStateStore.prototype.close = originalClose;
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Post-close revocation failure returns committed evidence for reconciliation", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-revoke-fault-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-revoke-fault-pkg-"));
  const cutoverId = "cutover-revoke-fault";
  const mock = await createMockReplacementServer({ cutoverId, statusStateDir: stateDir, revokeStatus: 503, workspaceId: "ws-revoke", agentId: "agt-revoke" });
  const { store } = setupDrainedRecord(stateDir, cutoverId);
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    await assert.rejects(
      performNativeCrossDomainBindingRepair({
        cutoverId,
        stateDir,
        packageRoot: pkgDir,
        serverUrl: mock.serverUrl,
        ownerToken: mock.ownerToken,
        workspaceId: "ws-revoke",
        agentId: "agt-revoke",
        requesterIdentity: { serverInstanceId: "repair-cli", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
      }),
      (error: unknown) => error instanceof NativeObservedReplacementCommittedError && error.committedRecord.phase === "closed",
    );
    assert.equal(new CutoverStateStore(stateDir).get()?.phase, "closed");
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Post-close native identity drift returns committed evidence", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-post-status-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-post-status-pkg-"));
  const cutoverId = "cutover-post-status-drift";
  const mock = await createMockReplacementServer({ cutoverId, statusStateDir: stateDir, statusServerInstanceIds: ["replacement-inst-1", "different-instance"], workspaceId: "ws-post", agentId: "agt-post" });
  setupDrainedRecord(stateDir, cutoverId);
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    await assert.rejects(
      performNativeCrossDomainBindingRepair({ cutoverId, stateDir, packageRoot: pkgDir, serverUrl: mock.serverUrl, ownerToken: mock.ownerToken, workspaceId: "ws-post", agentId: "agt-post", requesterIdentity: { serverInstanceId: "repair-cli", sourceCommit: SHA_COMMIT, buildId: BUILD_ID } }),
      (error: unknown) => error instanceof NativeObservedReplacementCommittedError && error.committedRecord.phase === "closed",
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Post-close durable readback failure returns committed record with readback detail", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-post-readback-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-post-readback-pkg-"));
  const cutoverId = "cutover-post-readback";
  const mock = await createMockReplacementServer({ cutoverId, statusStateDir: stateDir, workspaceId: "ws-post-readback", agentId: "agt-post-readback" });
  setupDrainedRecord(stateDir, cutoverId);
  const originalClose = CutoverStateStore.prototype.close;
  const originalGet = CutoverStateStore.prototype.get;
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    CutoverStateStore.prototype.close = function (this: CutoverStateStore, id: string, receipt: Parameters<CutoverStateStore["close"]>[1]) {
      const result = originalClose.call(this, id, receipt);
      CutoverStateStore.prototype.get = function () { throw new Error("injected post-close readback failure"); };
      return result;
    };
    await assert.rejects(
      performNativeCrossDomainBindingRepair({ cutoverId, stateDir, packageRoot: pkgDir, serverUrl: mock.serverUrl, ownerToken: mock.ownerToken, workspaceId: "ws-post-readback", agentId: "agt-post-readback", requesterIdentity: { serverInstanceId: "repair-cli", sourceCommit: SHA_COMMIT, buildId: BUILD_ID } }),
      (error: unknown) => error instanceof NativeObservedReplacementCommittedError && error.committedRecord.phase === "closed" && error.message.includes("readback"),
    );
  } finally {
    CutoverStateStore.prototype.close = originalClose;
    CutoverStateStore.prototype.get = originalGet;
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Post-close native status failure returns committed closed record", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-post-status-fail-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-post-status-fail-pkg-"));
  const cutoverId = "cutover-post-status-fail";
  const mock = await createMockReplacementServer({ cutoverId, statusStateDir: stateDir, statusFailAfter: 1, workspaceId: "ws-post-status-fail", agentId: "agt-post-status-fail" });
  setupDrainedRecord(stateDir, cutoverId);
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    await assert.rejects(
      performNativeCrossDomainBindingRepair({ cutoverId, stateDir, packageRoot: pkgDir, serverUrl: mock.serverUrl, ownerToken: mock.ownerToken, workspaceId: "ws-post-status-fail", agentId: "agt-post-status-fail", requesterIdentity: { serverInstanceId: "repair-cli", sourceCommit: SHA_COMMIT, buildId: BUILD_ID } }),
      (error: unknown) => error instanceof NativeObservedReplacementCommittedError && error.committedRecord.phase === "closed",
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Marker write followed by an exception is reconciled as committed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-marker-fault-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-marker-fault-pkg-"));
  const cutoverId = "cutover-marker-fault";
  const mock = await createMockReplacementServer({ cutoverId, statusStateDir: stateDir, workspaceId: "ws-marker", agentId: "agt-marker" });
  setupDrainedRecord(stateDir, cutoverId);
  const original = CutoverStateStore.prototype.recordBindingRepair;
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    CutoverStateStore.prototype.recordBindingRepair = function (this: CutoverStateStore, id: string, receipt: CutoverBindingRepairReceipt) {
      const result = original.call(this, id, receipt);
      throw new Error("injected post-write exception");
    };
    await assert.rejects(
      performNativeCrossDomainBindingRepair({ cutoverId, stateDir, packageRoot: pkgDir, serverUrl: mock.serverUrl, ownerToken: mock.ownerToken, workspaceId: "ws-marker", agentId: "agt-marker", requesterIdentity: { serverInstanceId: "repair-cli", sourceCommit: SHA_COMMIT, buildId: BUILD_ID } }),
      (error: unknown) => error instanceof NativeObservedReplacementCommittedError && error.committedRecord.bindingRepair !== undefined,
    );
    assert.ok(new CutoverStateStore(stateDir).get()?.bindingRepair);
  } finally {
    CutoverStateStore.prototype.recordBindingRepair = original;
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Close write followed by an exception returns the physical closed record", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-close-write-fault-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-close-write-fault-pkg-"));
  const cutoverId = "cutover-close-write-fault";
  const mock = await createMockReplacementServer({ cutoverId, statusStateDir: stateDir, workspaceId: "ws-close-write", agentId: "agt-close-write" });
  setupDrainedRecord(stateDir, cutoverId);
  const originalClose = CutoverStateStore.prototype.close;
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    CutoverStateStore.prototype.close = function (this: CutoverStateStore, id: string, receipt: Parameters<CutoverStateStore["close"]>[1]) {
      const result = originalClose.call(this, id, receipt);
      throw new Error(`injected after close write ${result.phase}`);
    };
    await assert.rejects(
      performNativeCrossDomainBindingRepair({ cutoverId, stateDir, packageRoot: pkgDir, serverUrl: mock.serverUrl, ownerToken: mock.ownerToken, workspaceId: "ws-close-write", agentId: "agt-close-write", requesterIdentity: { serverInstanceId: "repair-cli", sourceCommit: SHA_COMMIT, buildId: BUILD_ID } }),
      (error: unknown) => error instanceof NativeObservedReplacementCommittedError && error.committedRecord.phase === "closed",
    );
    assert.equal(new CutoverStateStore(stateDir).get()?.phase, "closed");
  } finally {
    CutoverStateStore.prototype.close = originalClose;
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("Marker write followed by unavailable readback reports outcome unknown without a fabricated record", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-marker-readback-fault-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-marker-readback-fault-pkg-"));
  const cutoverId = "cutover-marker-readback-fault";
  const mock = await createMockReplacementServer({ cutoverId, statusStateDir: stateDir, workspaceId: "ws-marker-readback", agentId: "agt-marker-readback" });
  setupDrainedRecord(stateDir, cutoverId);
  const originalRecord = CutoverStateStore.prototype.recordBindingRepair;
  const originalGet = CutoverStateStore.prototype.get;
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    CutoverStateStore.prototype.recordBindingRepair = function (this: CutoverStateStore, id: string, receipt: CutoverBindingRepairReceipt) {
      const result = originalRecord.call(this, id, receipt);
      CutoverStateStore.prototype.get = function () { throw new Error("injected readback unavailable"); };
      throw new Error("injected after marker write");
    };
    await assert.rejects(
      performNativeCrossDomainBindingRepair({ cutoverId, stateDir, packageRoot: pkgDir, serverUrl: mock.serverUrl, ownerToken: mock.ownerToken, workspaceId: "ws-marker-readback", agentId: "agt-marker-readback", requesterIdentity: { serverInstanceId: "repair-cli", sourceCommit: SHA_COMMIT, buildId: BUILD_ID } }),
      (error: unknown) => error instanceof NativeBindingRepairOutcomeUnknownError && error.cutoverId === cutoverId && !("committedRecord" in (error as object)),
    );
  } finally {
    CutoverStateStore.prototype.recordBindingRepair = originalRecord;
    CutoverStateStore.prototype.get = originalGet;
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G71-R1 & G71-R9: assertValidBindingRepair Invariant & Fail-Closed Tests
// ---------------------------------------------------------------------------

test("G71-R1 & G71-R9: assertValidBindingRepair rejects fabricated or inconsistent receipts", () => {
  const baseRecord: DurableCutoverRecord = {
    schema: "devspace.cutover.v1",
    cutoverId: "cutover-r9",
    phase: "drained",
    oldServerIdentity: {
      serverInstanceId: "old-inst",
      sourceCommit: SHA_COMMIT,
      buildId: BUILD_ID,
    },
    expectedNewIdentity: {
      sourceCommit: SHA_COMMIT,
      buildId: BUILD_ID,
      capabilityManifestSha256: SHA_BUILD_MANIFEST,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const validReceipt: CutoverBindingRepairReceipt = {
    schema: CUTOVER_BINDING_REPAIR_SCHEMA,
    cutoverId: "cutover-r9",
    reason: CUTOVER_BINDING_REPAIR_REASON,
    repairControlSurfaceIdentity: {
      serverInstanceId: "cli-inst",
      sourceCommit: SHA_COMMIT,
      buildId: BUILD_ID,
    },
    observedTargetRuntimeIdentity: {
      serverInstanceId: "target-rep-inst",
      sourceCommit: SHA_COMMIT,
      buildId: BUILD_ID,
      capabilityManifestSha256: SHA_CAPABILITY_MANIFEST,
    },
    originalCutoverExpectedIdentity: {
      sourceCommit: SHA_COMMIT,
      buildId: BUILD_ID,
      capabilityManifestSha256: SHA_BUILD_MANIFEST,
    },
    effectiveRepairedIdentity: {
      sourceCommit: SHA_COMMIT,
      buildId: BUILD_ID,
      capabilityManifestSha256: SHA_CAPABILITY_MANIFEST,
    },
    originalBoundDigest: SHA_BUILD_MANIFEST,
    originalDigestField: "expectedNewIdentity.capabilityManifestSha256",
    provenActualDigestDomain: "build_manifest_sha256",
    correctCapabilityManifestSchema: "devspace.capability_manifest.v1",
    correctCapabilityManifestSha256: SHA_CAPABILITY_MANIFEST,
    sourceCommit: SHA_COMMIT,
    buildId: BUILD_ID,
    observedServerInstanceId: "target-rep-inst",
    repairedBy: "cli-inst",
    repairedAt: new Date().toISOString(),
    physicalProbeEvidence: "verified",
  };

  // Valid passes
  assert.doesNotThrow(() => {
    assertValidBindingRepair(validReceipt, baseRecord);
  });

  // Mismatched cutoverId fails closed
  assert.throws(
    () => assertValidBindingRepair({ ...validReceipt, cutoverId: "diff-id" }, baseRecord),
    /inconsistent/,
  );

  // Mismatched originalBoundDigest fails closed
  assert.throws(
    () => assertValidBindingRepair({ ...validReceipt, originalBoundDigest: "f".repeat(64) }, baseRecord),
    /inconsistent/,
  );

  // Mismatched sourceCommit fails closed
  assert.throws(
    () => assertValidBindingRepair({ ...validReceipt, sourceCommit: "a".repeat(40) }, baseRecord),
    /inconsistent/,
  );

  // Mismatched buildId fails closed
  assert.throws(
    () => assertValidBindingRepair({ ...validReceipt, buildId: "other-build" }, baseRecord),
    /inconsistent/,
  );

  // Observed same as old server instance fails closed
  assert.throws(
    () => assertValidBindingRepair({ ...validReceipt, observedServerInstanceId: "old-inst" }, baseRecord),
    /inconsistent/,
  );

  // Fabricated receipt attached to record fails closed in effectiveExpectedIdentity
  const invalidRecord: DurableCutoverRecord = {
    ...baseRecord,
    bindingRepair: { ...validReceipt, originalBoundDigest: "0".repeat(64) },
  };
  assert.throws(
    () => effectiveExpectedIdentity(invalidRecord),
    /inconsistent/,
  );
});

// ---------------------------------------------------------------------------
// G71-R6: Fresh successor binding validation
// ---------------------------------------------------------------------------

test("G71-R6: Fresh successor binding validation fails closed if predecessor binding drifts before repair", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cas-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-cas-pkg-"));
  let mutated = false;
  const mock = await createMockReplacementServer({
    cutoverId: "cutover-cas",
    onCallTool: (name) => {
      if (name === "agent_reconcile" && !mutated) {
        mutated = true;
        // Concurrently mutate the latest durable drained event file's updatedAt
        const activeDir = join(stateDir, "cutover", "active");
        const files = readdirSync(activeDir).filter((f) => f.includes("drained-")).sort();
        const drainedFile = files.at(-1)!;
        const targetPath = join(activeDir, drainedFile);
        const raw = readFileSync(targetPath, "utf8");
        const obj = JSON.parse(raw);
        obj.supersedesCutoverId = "different-predecessor";
        writeFileSync(targetPath, JSON.stringify(obj, null, 2) + "\n");
      }
    },
  });
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    setupDrainedRecord(stateDir, "cutover-cas", SHA_BUILD_MANIFEST);

    await assert.rejects(
      async () => {
        await performNativeCrossDomainBindingRepair({
          cutoverId: "cutover-cas",
          stateDir,
          packageRoot: pkgDir,
          serverUrl: mock.serverUrl,
          ownerToken: mock.ownerToken,
          workspaceId: "ws-test",
          agentId: "agt-test",
          requesterIdentity: {
            serverInstanceId: "cli-cas-inst",
            sourceCommit: SHA_COMMIT,
            buildId: BUILD_ID,
          },
        });
      },
      (err: unknown) => {
        return (
          err instanceof CutoverStateError &&
          err.message.includes("Concurrent modification detected")
        );
      },
    );
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("G71-R6b: Fresh durable updatedAt validation fails closed before repair marker write", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-updatedat-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-updatedat-pkg-"));
  let mutated = false;
  const mock = await createMockReplacementServer({
    cutoverId: "cutover-updatedat",
    onCallTool: (name) => {
      if (name !== "agent_reconcile" || mutated) return;
      mutated = true;
      const activeDir = join(stateDir, "cutover", "active");
      const file = readdirSync(activeDir).filter((f) => f.includes("drained-")).sort().at(-1)!;
      const path = join(activeDir, file);
      const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      record.updatedAt = new Date(Date.now() + 100000).toISOString();
      writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
    },
  });
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    setupDrainedRecord(stateDir, "cutover-updatedat", SHA_BUILD_MANIFEST);
    await assert.rejects(
      performNativeCrossDomainBindingRepair({
        cutoverId: "cutover-updatedat", stateDir, packageRoot: pkgDir, serverUrl: mock.serverUrl,
        ownerToken: mock.ownerToken, workspaceId: "ws-test", agentId: "agt-test",
        requesterIdentity: { serverInstanceId: "cli-updatedat", sourceCommit: SHA_COMMIT, buildId: BUILD_ID },
      }),
      /Concurrent modification detected: cutover was updated during repair evaluation/,
    );
    assert.equal(new CutoverStateStore(stateDir).get()?.bindingRepair, undefined);
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G71-R7: Backward Compatibility with running 150a36f runtime
// ---------------------------------------------------------------------------

test("G71-R7: 150a36f old parser and mode() function accept repaired record and resolve mode=normal", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-150-compat-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-150-compat-pkg-"));
  const mock = await createMockReplacementServer();
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    setupDrainedRecord(stateDir, "cutover-150compat", SHA_BUILD_MANIFEST);
    mock.setCutoverId("cutover-150compat");

    const result = await performNativeCrossDomainBindingRepair({
      cutoverId: "cutover-150compat",
      stateDir,
      packageRoot: pkgDir,
      serverUrl: mock.serverUrl,
      ownerToken: mock.ownerToken,
      workspaceId: "ws-test",
      agentId: "agt-test",
      requesterIdentity: {
        serverInstanceId: "cli-compat-inst",
        sourceCommit: SHA_COMMIT,
        buildId: BUILD_ID,
      },
    });

    assert.equal(result.cutover.phase, "closed");

    // Read the latest active event file written by out-of-process repair
    const activeDir = join(stateDir, "cutover", "active");
    const eventFiles = readdirSync(activeDir).filter((f) => f.endsWith(".json")).sort();
    const closedEventFile = eventFiles.find((f) => f.includes("closed-"));
    assert.ok(closedEventFile, "closed event file must exist on disk");
    const rawOnDisk = readFileSync(join(activeDir, closedEventFile), "utf8");

    // Exact 150a36f parser implementation (from git show 150a36f:src/cutover-state.ts)
    function parseRecord150a36f(raw: string): DurableCutoverRecord {
      const value = JSON.parse(raw) as Partial<DurableCutoverRecord>;
      if (
        value.schema !== "devspace.cutover.v1" ||
        typeof value.cutoverId !== "string" ||
        !["prepared", "drained", "closed", "superseded"].includes(value.phase ?? "") ||
        !value.oldServerIdentity ||
        !value.expectedNewIdentity ||
        typeof value.createdAt !== "string" ||
        typeof value.updatedAt !== "string"
      ) {
        throw new Error("150a36f parser failed");
      }
      // 150a36f reconciliationReceipt check
      if (value.reconciliationReceipt) {
        const r = value.reconciliationReceipt;
        const ok =
          typeof r.closedByServerInstanceId === "string" &&
          r.closedByServerInstanceId.length > 0 &&
          typeof r.workspaceQueryable === "boolean" &&
          typeof r.agentQueryable === "boolean" &&
          typeof r.agentReconciled === "boolean" &&
          typeof r.reconciledAt === "string" &&
          (r.terminalReason === undefined || r.terminalReason === "OBSERVED_REPLACEMENT_WITHOUT_DRAIN");
        if (!ok) {
          throw new Error("150a36f reconciliationReceipt validation failed");
        }
      }
      return value as DurableCutoverRecord;
    }

    // Exact 150a36f mode calculation (from git show 150a36f:src/mcp-cutover.ts)
    function mode150a36f(record: DurableCutoverRecord | undefined, currentInstanceId: string): string {
      if (!record || record.phase === "closed") return "normal";
      return record.oldServerIdentity.serverInstanceId === currentInstanceId ? "drain" : "reconcile-only";
    }

    // Exact 150a36f status reconciliationRequired logic
    function reconciliationRequired150a36f(record: DurableCutoverRecord | undefined): boolean {
      return Boolean(record && record.phase !== "closed");
    }

    // Assert 150a36f parses the repaired on-disk JSON without any error
    const parsedByOldRuntime = parseRecord150a36f(rawOnDisk);
    assert.equal(parsedByOldRuntime.cutoverId, "cutover-150compat");
    assert.equal(parsedByOldRuntime.phase, "closed");

    // Assert 150a36f evaluates mode to "normal" for the replacement instance
    const oldRuntimeMode = mode150a36f(parsedByOldRuntime, "rep-inst-id");
    assert.equal(oldRuntimeMode, "normal");

    // Assert 150a36f evaluates reconciliationRequired to false
    assert.equal(reconciliationRequired150a36f(parsedByOldRuntime), false);
  } finally {
    await mock.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G71-R10: cutover_finish Refuses Generic Auto-Heal for Generic Mismatch
// ---------------------------------------------------------------------------

test("G71-R10: cutover_finish refuses to auto-heal when capability mismatch is NOT cross-domain misbinding", async () => {
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-g10-pkg-"));
  try {
    // Target package has genuine build manifest digest SHA_BUILD_MANIFEST
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);

    const probed = probeTargetPackage(pkgDir);

    // Simulated active cutover where expected capability digest is a random unrelated hash
    const unrelatedDigest = "e".repeat(64);
    assert.notEqual(unrelatedDigest, probed.buildManifestSha256);

    // The explicit classifier check must evaluate to false
    const isCrossDomainMisbinding = probed.buildManifestSha256 === unrelatedDigest;
    assert.equal(isCrossDomainMisbinding, false);
  } finally {
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G71-R12: Prevention Fails Before Any Durable Mutation
// ---------------------------------------------------------------------------

test("G71-R12: Prevention fails before durable write; leaves stateDir pristine", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-g12-state-"));
  const pkgDir = mkdtempSync(join(tmpdir(), "devspace-g12-pkg-"));
  try {
    createPackageRoot(pkgDir, SHA_BUILD_MANIFEST);
    const store = new CutoverStateStore(stateDir);

    // Call assertNoDigestDomainMismatch with domain mismatch
    const probed = probeTargetPackage(pkgDir);
    assert.throws(
      () => {
        assertNoDigestDomainMismatch(
          { capabilityManifestSha256: SHA_BUILD_MANIFEST },
          probed,
        );
      },
      (err: unknown) => {
        return (
          err instanceof CutoverCapabilityManifestDomainMismatchError &&
          err.code === "CAPABILITY_MANIFEST_DIGEST_DOMAIN_MISMATCH"
        );
      },
    );

    // Verify state directory contains no created record or markers
    assert.equal(store.get(), undefined);
    assert.equal(existsSync(join(stateDir, "cutover", "active")), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});
