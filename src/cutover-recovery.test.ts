import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NativeObservedReplacementCommittedError, performCutoverRecovery, performNativeObservedReplacementRecovery, validateNativeOAuthMetadata } from "./cutover-recovery.js";
import { CutoverStateStore, type CutoverServerIdentity, type ExpectedCutoverIdentity, type DurableReconciliationWitness } from "./cutover-state.js";
import type { BuildReadyProbeResult } from "./cutover-build-ready.js";

const staleIdentity: CutoverServerIdentity = {
  serverInstanceId: "stale-old-owner",
  sourceCommit: "stale-source",
  buildId: "stale-build",
  capabilityManifestSha256: "cap-shared",
};
const targetIdentity: CutoverServerIdentity = {
  serverInstanceId: "target-server",
  sourceCommit: "target-source",
  buildId: "target-build",
  capabilityManifestSha256: "cap-shared",
};
const expectedTarget: ExpectedCutoverIdentity = {
  sourceCommit: "target-source",
  buildId: "target-build",
  capabilityManifestSha256: "cap-shared",
};
const goodProbe = (): BuildReadyProbeResult => ({
  buildReady: true,
  verifiedBy: "build-identity-file",
  verifiedAt: new Date().toISOString(),
  expectedSourceCommit: expectedTarget.sourceCommit,
  expectedBuildId: expectedTarget.buildId,
  actualSourceCommit: expectedTarget.sourceCommit,
  actualBuildId: expectedTarget.buildId,
  detail: "installed build identity matches the bound recovery target",
});

type NativeFixtureOptions = {
  status?: () => Record<string, unknown>;
  tokenMode?: "access-only" | "both";
  pair?: { workspaceId: string; agentId: string; root: string };
  revokeFailure?: boolean;
  callbackOverride?: string;
  authorizationIssuerOverride?: string;
  pairAvailable?: boolean;
};

async function nativeHttpFixture(options: NativeFixtureOptions = {}) {
  const pair = options.pair ?? { workspaceId: "ws-native", agentId: "agt-native", root: "/tmp/native-project" };
  const oldIdentity: CutoverServerIdentity = { serverInstanceId: "old-native", sourceCommit: "old-source", buildId: "old-build", capabilityManifestSha256: "m".repeat(64) };
  const expected: ExpectedCutoverIdentity = { sourceCommit: "target-source", buildId: "target-build", capabilityManifestSha256: "n".repeat(64) };
  const current: CutoverServerIdentity = { serverInstanceId: "new-native", ...expected };
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-native-http-state-"));
  const store = new CutoverStateStore(stateDir, { newId: () => "cutover-native" });
  store.begin({ oldServerIdentity: oldIdentity, expectedNewIdentity: expected });
  let statusReads = 0;
  let pairAvailable = options.pairAvailable ?? true;
  const revoked: string[] = [];
  const toolCalls: string[] = [];
  const authRequests = new Map<string, { challenge: string; clientId: string; redirectUri: string; resource: string }>();
  let latestChallenge: string | undefined;
  const issuedCodes = new Set<string>();
  const clientIds = new Set<string>();
  const accessToken = "native-access";
  const ownerToken = "fixture-owner";
  const resourcePath = "/mcp";
  const server = createHttpServer(async (req, res) => {
    const body = await new Promise<string>((resolve) => { let text = ""; req.on("data", (chunk) => { text += String(chunk); }); req.on("end", () => resolve(text)); });
    const host = req.headers.host;
    const origin = `http://${host}`;
    const url = new URL(req.url ?? "/", origin);
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", "mcp-session-id": "native-test-session", ...headers }); res.end(JSON.stringify(value)); };
    const fail = (message: string, status = 400) => json({ error: message }, status);
    const bearer = req.headers.authorization;
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp") return json({ resource: `${origin}${resourcePath}`, authorization_servers: [`${origin}/`], scopes_supported: ["devspace"] });
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") return json({ issuer: options.authorizationIssuerOverride ?? `${origin}/`, authorization_endpoint: `${origin}/authorize`, registration_endpoint: `${origin}/register`, token_endpoint: `${origin}/token`, revocation_endpoint: `${origin}/revoke` });
    if (req.method === "POST" && url.pathname === "/register") {
      const metadata = JSON.parse(body) as Record<string, unknown>;
      const redirects = metadata.redirect_uris;
      if (!Array.isArray(redirects) || !redirects.includes("http://127.0.0.1:9/devspace-native-cutover") || !(metadata.grant_types as unknown[] | undefined)?.includes("authorization_code") || !(metadata.response_types as unknown[] | undefined)?.includes("code") || metadata.token_endpoint_auth_method !== "none") return fail("invalid client metadata");
      clientIds.add("native-test-client");
      return json({ client_id: "native-test-client" }, 201);
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      const clientId = url.searchParams.get("client_id");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      const redirectUri = url.searchParams.get("redirect_uri");
      const resource = url.searchParams.get("resource");
      if (!clientId || !clientIds.has(clientId) || !state || !challenge || url.searchParams.get("code_challenge_method") !== "S256" || !redirectUri || !resource) return fail("invalid authorization request");
      authRequests.set(state, { challenge, clientId, redirectUri, resource });
      latestChallenge = challenge;
      return json({ ok: true });
    }
    if (req.method === "POST" && url.pathname === "/authorize") {
      const form = new URLSearchParams(body);
      const state = form.get("state");
      const request = state ? authRequests.get(state) : undefined;
      if (form.get("owner_token") !== ownerToken || !request || form.get("client_id") !== request.clientId || form.get("redirect_uri") !== request.redirectUri || form.get("resource") !== request.resource) return fail("authorization denied", 403);
      issuedCodes.add("native-code");
      const callback = options.callbackOverride ?? request.redirectUri;
      res.writeHead(302, { location: `${callback}?code=native-code&state=${state}` }); return res.end();
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams(body);
      const request = [...authRequests.values()].at(-1);
      const expectedChallenge = latestChallenge ?? request?.challenge;
      const verifier = form.get("code_verifier") ?? "";
      const digest = Buffer.from(await import("node:crypto").then(({ createHash }) => createHash("sha256").update(verifier).digest())).toString("base64url");
      if (!issuedCodes.has(form.get("code") ?? "") || form.get("client_id") !== "native-test-client" || form.get("redirect_uri") !== "http://127.0.0.1:9/devspace-native-cutover" || digest !== expectedChallenge || form.get("resource") !== `${origin}${resourcePath}`) return fail("invalid token exchange", 401);
      return json(options.tokenMode === "access-only" ? { access_token: accessToken, token_type: "Bearer", scope: "devspace" } : { access_token: accessToken, refresh_token: "native-refresh", token_type: "Bearer", scope: "devspace" });
    }
    if (req.method === "POST" && url.pathname === "/revoke") {
      const token = new URLSearchParams(body).get("token") ?? "";
      if ((new URLSearchParams(body).get("client_id") ?? "") !== "native-test-client" || (token !== accessToken && token !== "native-refresh")) return fail("unknown token", 401);
      revoked.push(token);
      if (options.revokeFailure) { res.writeHead(503); return res.end(); }
      res.writeHead(200); return res.end();
    }
    if (req.method === "POST" && url.pathname === "/mcp") {
      if (bearer !== `Bearer ${accessToken}`) return fail("missing bearer", 401);
      const request = JSON.parse(body) as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (request.method === "initialize") return json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "native-test", version: "1" } } });
      if (request.method?.startsWith("notifications/")) { res.writeHead(202, { "mcp-session-id": "native-test-session" }); return res.end(); }
      if (request.method === "tools/call") {
        const name = request.params?.name;
        const args = request.params?.arguments ?? {};
        if (name === "cutover_status" && Object.keys(args).length === 0) {
          toolCalls.push(name); statusReads += 1;
          const record = store.get();
          const status = options.status?.() ?? { cutover: record, currentServerIdentity: current, mode: record?.phase === "closed" ? "normal" : "reconcile-only", reconciliationRequired: record?.phase !== "closed" };
          return json({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { status }, content: [] } });
        }
        if (!pairAvailable) return fail("selected pair unavailable", 503);
        if (name === "workspace_inspect" && JSON.stringify(args) === JSON.stringify({ workspaceId: pair.workspaceId })) {
          toolCalls.push(name); return json({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { workspaceSessions: 1, detail: [{ unit: `workspace:${pair.workspaceId}`, session: { id: pair.workspaceId, root: pair.root } }] }, content: [] } });
        }
        if (name === "agent_status" && JSON.stringify(args) === JSON.stringify({ workspaceId: pair.workspaceId, agentId: pair.agentId })) {
          toolCalls.push(name); return json({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { agentId: pair.agentId, workspaceId: pair.workspaceId, workspaceRoot: pair.root, status: "running" }, content: [] } });
        }
        if (name === "agent_reconcile" && JSON.stringify(args) === JSON.stringify({ workspaceId: pair.workspaceId, agentId: pair.agentId })) {
          toolCalls.push(name); return json({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { agentId: pair.agentId, workspace: { head: "test-head", dirty: false }, candidate: { present: false, changedPaths: [], unexpectedPaths: [], scopeState: "clean" } }, content: [] } });
        }
        return fail("unexpected tool arguments");
      }
    }
    return fail("not found", 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  const base = new URL(`http://127.0.0.1:${address.port}/`);
  return { server, base, stateDir, store, current, expected, pair, revoked, toolCalls, getStatusReads: () => statusReads, setPairAvailable: (value: boolean) => { pairAvailable = value; }, async close() { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(stateDir, { recursive: true, force: true }); } };
}

function makeStateDir(manifest?: string): { stateDir: string; store: CutoverStateStore } {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-seam-"));
  const store = new CutoverStateStore(stateDir, {
    newId: (() => { let n = 0; return () => `cutover-${n += 1}`; })(),
  });
  store.begin({
    oldServerIdentity: staleIdentity,
    expectedNewIdentity: { sourceCommit: "stale-target", buildId: "stale-target-build", ...(manifest ? { capabilityManifestSha256: manifest } : {}) },
  });
  return { stateDir, store };
}

test("seam performs a durable probe-gated recovery with successor drain and restart scheduling", () => {
  const { stateDir, store } = makeStateDir();
  try {
    const result = performCutoverRecovery({
      store,
      requesterIdentity: targetIdentity,
      cutoverId: "cutover-1",
      expectedNewIdentity: expectedTarget,
      drainEvidence: { activeSessions: 5, oldestAgeMs: 211_548_160 },
      buildReadyProbe: goodProbe,
    });

    assert.equal(result.newlyRecovered, true);
    assert.equal(result.terminal.phase, "superseded");
    assert.equal(result.terminal.supersession?.observedIdentity.serverInstanceId, "target-server");
    assert.equal(result.successor.supersedesCutoverId, "cutover-1");
    assert.equal(result.successor.phase, "prepared");
    assert.deepEqual(result.drainRecord.drainEvidence, { activeSessions: 5, oldestAgeMs: 211_548_160 });
    assert.equal(result.drainRecord.phase, "drained");
    assert.equal(result.restartRequested, true);
    assert.equal(result.restartScheduled, true);
    assert.equal(result.buildReadyVerifiedBy, "build-identity-file");

    const replayed = new CutoverStateStore(stateDir).get();
    assert.equal(replayed?.phase, "drained");
    assert.equal(replayed?.supersedesCutoverId, "cutover-1");
    assert.equal(replayed?.restartRequest?.buildReady?.verifiedBy, "build-identity-file");
    assert.equal(replayed?.restartRequest?.restartScheduledForServerInstanceId, "target-server");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("seam rerun is idempotent and refuses a changed target", () => {
  const { stateDir, store } = makeStateDir();
  try {
    const first = performCutoverRecovery({
      store,
      requesterIdentity: targetIdentity,
      cutoverId: "cutover-1",
      expectedNewIdentity: expectedTarget,
      drainEvidence: { activeSessions: 2, oldestAgeMs: 10_000 },
      buildReadyProbe: goodProbe,
    });
    const second = performCutoverRecovery({
      store,
      requesterIdentity: targetIdentity,
      cutoverId: "cutover-1",
      expectedNewIdentity: expectedTarget,
      drainEvidence: { activeSessions: 2, oldestAgeMs: 10_000 },
      buildReadyProbe: goodProbe,
    });
    assert.equal(second.newlyRecovered, false);
    assert.equal(second.successor.cutoverId, first.successor.cutoverId);
    assert.equal(second.restartScheduled, false);

    assert.throws(
      () => performCutoverRecovery({
        store,
        requesterIdentity: targetIdentity,
        cutoverId: "cutover-1",
        expectedNewIdentity: { sourceCommit: "different-source", buildId: "target-build" },
        drainEvidence: { activeSessions: 2, oldestAgeMs: 10_000 },
        buildReadyProbe: goodProbe,
      }),
      /RECOVERY_BINDING_MISMATCH/i,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("seam fails closed without either a probe or an operator attestation", () => {
  const { stateDir, store } = makeStateDir();
  try {
    assert.throws(
      () => performCutoverRecovery({
        store,
        requesterIdentity: targetIdentity,
        cutoverId: "cutover-1",
        expectedNewIdentity: expectedTarget,
        drainEvidence: { activeSessions: 0, oldestAgeMs: 0 },
      }),
      /requires either a physical build-ready probe or an operator build-ready attestation/i,
    );
    assert.equal(new CutoverStateStore(stateDir).get()?.phase, "prepared");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("seam fails closed on a negative build-ready probe with no mutation", () => {
  const { stateDir, store } = makeStateDir();
  try {
    const badProbe = (): BuildReadyProbeResult => ({
      buildReady: false,
      verifiedBy: "build-identity-file",
      verifiedAt: new Date().toISOString(),
      expectedSourceCommit: expectedTarget.sourceCommit,
      expectedBuildId: expectedTarget.buildId,
      actualSourceCommit: "wrong-source",
      actualBuildId: "wrong-build",
      detail: "installed build identity does not match the bound recovery target",
    });
    assert.throws(
      () => performCutoverRecovery({
        store,
        requesterIdentity: targetIdentity,
        cutoverId: "cutover-1",
        expectedNewIdentity: expectedTarget,
        drainEvidence: { activeSessions: 0, oldestAgeMs: 0 },
        buildReadyProbe: badProbe,
      }),
      /CUTOVER_BUILD_NOT_READY/i,
    );
    assert.equal(new CutoverStateStore(stateDir).get()?.phase, "prepared");
    assert.equal(new CutoverStateStore(stateDir).supersededRecord(), undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("native OAuth metadata rejects foreign resource, issuer, endpoint, and redirect origins", () => {
  const publicBase = new URL("https://devspace.example.test");
  const metadata = { resource: "https://devspace.example.test/mcp", authorization_servers: ["https://devspace.example.test/"] };
  const auth = {
    issuer: "https://devspace.example.test/",
    authorization_endpoint: "https://devspace.example.test/authorize",
    registration_endpoint: "https://devspace.example.test/register",
    token_endpoint: "https://devspace.example.test/token",
    revocation_endpoint: "https://devspace.example.test/revoke",
  };
  assert.deepEqual(validateNativeOAuthMetadata(metadata, auth, publicBase, new URL("http://127.0.0.1:9/devspace-native-cutover")).resource.href, "https://devspace.example.test/mcp");
  assert.throws(() => validateNativeOAuthMetadata({ ...metadata, resource: "https://foreign.example/mcp" }, auth, publicBase, new URL("http://127.0.0.1:9/devspace-native-cutover")), /resource does not match/i);
  assert.throws(() => validateNativeOAuthMetadata(metadata, { ...auth, token_endpoint: "https://foreign.example/token" }, publicBase, new URL("http://127.0.0.1:9/devspace-native-cutover")), /token_endpoint origin/i);
  assert.throws(() => validateNativeOAuthMetadata(metadata, auth, publicBase, new URL("https://foreign.example/callback")), /redirect URI/i);
  assert.throws(() => validateNativeOAuthMetadata(metadata, { ...auth, authorization_endpoint: "https://foreign.example/authorize" }, publicBase, new URL("http://127.0.0.1:9/devspace-native-cutover")), /authorization_endpoint origin/i);
});

function nativeOptions(fixture: Awaited<ReturnType<typeof nativeHttpFixture>>) {
  return { serverUrl: new URL("/mcp", fixture.base), publicBaseUrl: fixture.base, stateDir: fixture.stateDir, cutoverId: "cutover-native", workspaceId: fixture.pair.workspaceId, agentId: fixture.pair.agentId, ownerToken: "fixture-owner", requesterIdentity: { serverInstanceId: "accepted-native", sourceCommit: "accepted-source", buildId: "accepted-build" } };
}

test("native adapter closes one exact pair through real OAuth and MCP HTTP, preserving restart markers", async () => {
  const fixture = await nativeHttpFixture();
  try {
    const result = await performNativeObservedReplacementRecovery(nativeOptions(fixture));
    assert.equal(result.cutover.phase, "closed");
    assert.equal(result.newlyRecovered, true);
    assert.equal(fixture.getStatusReads(), 3);
    assert.deepEqual(fixture.revoked.sort(), ["native-access", "native-refresh"]);
    assert.equal(existsSync(join(fixture.stateDir, "cutover", "active", "restart-requested.json")), false);
    assert.equal(existsSync(join(fixture.stateDir, "cutover", "active", "restart-scheduled.json")), false);
  } finally { await fixture.close(); }
});

test("native adapter supports access-only cleanup and exact closed replay, then rejects changed replay", async () => {
  const fixture = await nativeHttpFixture({ tokenMode: "access-only" });
  try {
    const first = await performNativeObservedReplacementRecovery(nativeOptions(fixture));
    assert.equal(first.newlyRecovered, true);
    assert.deepEqual(fixture.revoked, ["native-access"]);
    assert.equal(new CutoverStateStore(fixture.stateDir).get()?.phase, "closed", "durable reopen must preserve the committed receipt");
    fixture.setPairAvailable(false);
    const replay = await performNativeObservedReplacementRecovery(nativeOptions(fixture));
    assert.deepEqual(fixture.toolCalls.filter((name) => name !== "cutover_status"), ["workspace_inspect", "agent_status", "agent_reconcile"], "closed replay must not query the selected pair");
    assert.equal(replay.newlyRecovered, false);
    assert.equal(replay.cutover.observedReplacement?.observedIdentity.serverInstanceId, fixture.current.serverInstanceId);
    const changed = await nativeHttpFixture({ status: () => ({ cutover: { cutoverId: "cutover-native", phase: "closed", oldServerIdentity: { serverInstanceId: "old-native" }, expectedNewIdentity: fixture.expected }, currentServerIdentity: { ...fixture.current, serverInstanceId: "changed-native" }, mode: "normal", reconciliationRequired: false }) });
    try { await assert.rejects(() => performNativeObservedReplacementRecovery({ ...nativeOptions(changed), stateDir: fixture.stateDir }), /Closed replay identity|generation/); } finally { await changed.close(); }
  } finally { await fixture.close(); }
});

test("native adapter rejects a changed selected pair on closed replay without querying any pair", async () => {
  const fixture = await nativeHttpFixture({ tokenMode: "access-only" });
  try {
    await performNativeObservedReplacementRecovery(nativeOptions(fixture));
    const before = fixture.toolCalls.filter((name) => name !== "cutover_status").length;
    fixture.setPairAvailable(false);
    await assert.rejects(
      () => performNativeObservedReplacementRecovery({ ...nativeOptions(fixture), agentId: "different-agent" }),
      /closed replay|pair|agent/i,
    );
    assert.equal(fixture.toolCalls.filter((name) => name !== "cutover_status").length, before);
  } finally { await fixture.close(); }
});

test("native adapter rejects foreign callback paths and issuer mismatches before MCP effects", async () => {
  for (const options of [
    { callbackOverride: "http://127.0.0.1:9/foreign-callback" },
    { authorizationIssuerOverride: "http://127.0.0.1:9/" },
  ]) {
    const fixture = await nativeHttpFixture(options);
    try {
      await assert.rejects(() => performNativeObservedReplacementRecovery(nativeOptions(fixture)), /redirect|issuer|origin/i);
      assert.deepEqual(fixture.toolCalls, []);
      assert.equal(fixture.store.get()?.phase, "prepared");
    } finally { await fixture.close(); }
  }
});

test("native adapter rejects pair mismatch, missing manifest, stale generation, and local store mismatch before write", async () => {
  for (const [name, status, localMismatch] of [
    ["pair mismatch", undefined, false],
    ["missing manifest", () => ({ cutover: { cutoverId: "cutover-native", phase: "prepared", oldServerIdentity: { serverInstanceId: "old-native" }, expectedNewIdentity: { sourceCommit: "target-source", buildId: "target-build" } }, currentServerIdentity: { ...({ serverInstanceId: "new-native", sourceCommit: "target-source", buildId: "target-build" }) }, mode: "reconcile-only", reconciliationRequired: true }), false],
    ["local store mismatch", undefined, true],
  ] as const) {
    const fixture = await nativeHttpFixture({ ...(name === "pair mismatch" ? { pair: { workspaceId: "ws-native", agentId: "agt-native", root: "/tmp/native-project" } } : {}), ...(status ? { status } : {}) });
    try {
      const options = nativeOptions(fixture);
      if (name === "pair mismatch") options.agentId = "wrong-agent";
      if (localMismatch) options.cutoverId = "wrong-cutover";
      await assert.rejects(() => performNativeObservedReplacementRecovery(options));
      assert.equal(fixture.store.get()?.phase, "prepared", name);
    } finally { await fixture.close(); }
  }
});

test("native adapter rejects stale live generation and divergent stores for the same cutover id", async () => {
  const fixture = await nativeHttpFixture({
    status: () => ({
      cutover: {
        cutoverId: "cutover-native",
        phase: "prepared",
        oldServerIdentity: { serverInstanceId: "old-native", sourceCommit: "old-source", buildId: "old-build", capabilityManifestSha256: "m".repeat(64) },
        expectedNewIdentity: { sourceCommit: "different-source", buildId: "target-build", capabilityManifestSha256: "n".repeat(64) },
      },
      currentServerIdentity: { serverInstanceId: "new-native", sourceCommit: "different-source", buildId: "target-build", capabilityManifestSha256: "n".repeat(64) },
      mode: "reconcile-only",
      reconciliationRequired: true,
    }),
  });
  try {
    await assert.rejects(() => performNativeObservedReplacementRecovery(nativeOptions(fixture)), /generation|expected|binding/i);
    assert.equal(fixture.store.get()?.phase, "prepared");
    assert.deepEqual(fixture.toolCalls.filter((name) => name !== "cutover_status"), []);
  } finally { await fixture.close(); }
});

test("native adapter reports committed outcome when post-commit live readback fails", async () => {
  let reads = 0;
  const fixtureExpected = { sourceCommit: "target-source", buildId: "target-build", capabilityManifestSha256: "n".repeat(64) };
  const fixtureCurrent = { serverInstanceId: "new-native", ...fixtureExpected };
  const fixtureOld = { serverInstanceId: "old-native", sourceCommit: "old-source", buildId: "old-build", capabilityManifestSha256: "m".repeat(64) };
  const fixture = await nativeHttpFixture({ status: () => {
    reads += 1;
    return {
      cutover: { cutoverId: "cutover-native", phase: "prepared", oldServerIdentity: fixtureOld, expectedNewIdentity: fixtureExpected },
      currentServerIdentity: reads >= 3 ? { ...fixtureCurrent, serverInstanceId: "post-commit-different" } : fixtureCurrent,
      mode: "reconcile-only",
      reconciliationRequired: true,
    };
  } });
  try {
    await assert.rejects(() => performNativeObservedReplacementRecovery(nativeOptions(fixture)), NativeObservedReplacementCommittedError);
    assert.equal(fixture.store.get()?.phase, "closed");
  } finally { await fixture.close(); }
});

test("native adapter preserves primary failure together with independent revocation cleanup failures", async () => {
  const fixture = await nativeHttpFixture({ revokeFailure: true });
  try {
    await assert.rejects(
      () => performNativeObservedReplacementRecovery({ ...nativeOptions(fixture), agentId: "wrong-agent" }),
      (error: unknown) => error instanceof Error && Array.isArray((error as Error & { cleanupErrors?: unknown }).cleanupErrors),
    );
    assert.equal(fixture.store.get()?.phase, "prepared");
  } finally { await fixture.close(); }
});

test("seam accepts an operator build-ready attestation when no probe root is configured", () => {
  const { stateDir, store } = makeStateDir();
  try {
    const result = performCutoverRecovery({
      store,
      requesterIdentity: targetIdentity,
      cutoverId: "cutover-1",
      expectedNewIdentity: expectedTarget,
      drainEvidence: { activeSessions: 3, oldestAgeMs: 40_000 },
      buildReadyAttestation: {
        verifiedBy: "verified-accepted-build-install",
        evidence: "installed FINAL_ACCEPTED_BUILD matches the recovery binding",
      },
    });
    assert.equal(result.buildReadyVerifiedBy, "verified-accepted-build-install");
    const replayed = new CutoverStateStore(stateDir).get();
    assert.equal(replayed?.phase, "drained");
    assert.equal(replayed?.restartRequest?.buildReady?.verifiedBy, "verified-accepted-build-install");
    assert.equal(replayed?.restartRequest?.buildReady?.evidence?.includes("FINAL_ACCEPTED_BUILD"), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Test 10 — restart replay prevention: replacement exists, recovery creates no restart markers", () => {
  const { stateDir, store } = makeStateDir("cap-shared");
  try {
    const target = {
      serverInstanceId: "new-instance-b",
      sourceCommit: "stale-target",
      buildId: "stale-target-build",
      capabilityManifestSha256: "cap-shared",
    };
    const expected = {
      sourceCommit: "stale-target",
      buildId: "stale-target-build",
      capabilityManifestSha256: "cap-shared",
    };
    const probe = (): BuildReadyProbeResult => ({
      buildReady: true,
      verifiedBy: "build-identity-file",
      verifiedAt: new Date().toISOString(),
      expectedSourceCommit: expected.sourceCommit,
      expectedBuildId: expected.buildId,
      actualSourceCommit: expected.sourceCommit,
      actualBuildId: expected.buildId,
      detail: "ready",
    });

    const witness: DurableReconciliationWitness = {
      witnessCutoverId: "cutover-1", witnessServerInstanceId: target.serverInstanceId, witnessExpectedIdentity: expected,
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
      witnessWorkspaceId: "ws-rec",
      witnessAgentId: "agent-rec",
      witnessWorkspaceSessions: 1,
      witnessAgentSessions: 1,
      witnessKind: "exact-pair",
    };

    const preRecoveryRecord = store.get();
    const preRestartRequest = preRecoveryRecord?.restartRequest;
    const activeDir = join(stateDir, "cutover", "active");
    assert.equal(existsSync(join(activeDir, "restart-requested.json")), false);
    assert.equal(existsSync(join(activeDir, "restart-scheduled.json")), false);

    const result = performCutoverRecovery({
      store,
      requesterIdentity: target,
      cutoverId: "cutover-1",
      expectedNewIdentity: expected,
      drainEvidence: { activeSessions: 0, oldestAgeMs: 0 },
      buildReadyProbe: probe,
      witness,
    });

    assert.equal(result.restartRequested, false);
    assert.equal(result.restartScheduled, false);
    assert.equal(result.terminal.phase, "closed");
    assert.equal(result.terminal.drainEvidence, undefined);
    assert.equal(result.terminal.observedReplacement?.preRestartDrainObserved, false);

    const active = store.get();
    assert.deepEqual(
      active?.restartRequest,
      preRestartRequest,
      "restartRequest state must remain unchanged",
    );
    assert.equal(existsSync(join(activeDir, "restart-requested.json")), false);
    assert.equal(existsSync(join(activeDir, "restart-scheduled.json")), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
