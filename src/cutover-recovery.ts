import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import {
  BUILD_IDENTITY_RELATIVE_PATH,
  probeBuildReady,
  type BuildReadyProbeResult,
} from "./cutover-build-ready.js";
import {
  CutoverStateError,
  CutoverStateStore,
  type BuildReadyReceipt,
  type CutoverDrainEvidence,
  type CutoverServerIdentity,
  type DurableCutoverRecord,
  type DurableReconciliationWitness,
  type ExpectedCutoverIdentity,
} from "./cutover-state.js";

import { recoverCutoverWithStore } from "./mcp-cutover.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Out-of-process cutover recovery seam. It reads only the configured DevSpace
 * state directory and the build-ready probe root; it never starts an MCP
 * server, never accepts arbitrary filesystem paths, and never performs the
 * restart itself. The stale runtime running the pre-recovery build never
 * exposes these entry points; the operator runs this seat from the accepted
 * build after installation.
 */

export interface CutoverRecoveryResult {
  terminal: DurableCutoverRecord;
  successor: DurableCutoverRecord;
  newlyRecovered: boolean;
  drainRecord: DurableCutoverRecord;
  restartRequested: boolean;
  restartScheduled: boolean;
  buildReadyVerifiedBy: string;
}

export interface CutoverRecoveryDependencies {
  store: CutoverStateStore;
  /** Identity of the recovering control surface (the accepted build). */
  requesterIdentity: CutoverServerIdentity;
  /** Stale cutover id being superseded. */
  cutoverId: string;
  expectedNewIdentity: ExpectedCutoverIdentity;
  /** Aggregate transport drain evidence measured at recovery time. */
  drainEvidence: CutoverDrainEvidence;
  /** Physical probe of the installed/bound target build (positive required). */
  buildReadyProbe?: (expected: ExpectedCutoverIdentity) => BuildReadyProbeResult;
  /** Operator attestation fallback when no probe root is configured. */
  buildReadyAttestation?: Omit<BuildReadyReceipt, "verifiedAt">;
  expiresAt?: string;
  witness?: DurableReconciliationWitness;
  now?: () => number;
}

export interface NativeObservedReplacementOptions {
  /** The local MCP endpoint; never taken from a caller-provided executable or path. */
  serverUrl: URL;
  stateDir: string;
  cutoverId: string;
  workspaceId: string;
  agentId: string;
  ownerToken: string;
  /** Provenance of the accepted package executing this adapter, read locally. */
  requesterIdentity: CutoverServerIdentity;
  fetch?: typeof globalThis.fetch;
}

export interface NativeObservedReplacementResult {
  cutover: DurableCutoverRecord;
  newlyRecovered: boolean;
  serverInstanceId: string;
  expectedNewIdentity: ExpectedCutoverIdentity;
  witness: DurableReconciliationWitness;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CutoverStateError(`${label} response is not an object.`);
  }
  return value as JsonRecord;
}

function structuredResult(result: unknown, label: string): JsonRecord {
  const record = asRecord(result, label);
  if (record.isError === true) {
    throw new CutoverStateError(`${label} failed: ${JSON.stringify(record.structuredContent ?? record.content ?? {})}`);
  }
  return asRecord(record.structuredContent, `${label} structuredContent`);
}

function requiredStringField(record: JsonRecord, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new CutoverStateError(`${label} is missing ${field}.`);
  }
  return value;
}

function requiredRecordField(record: JsonRecord, field: string, label: string): JsonRecord {
  return asRecord(record[field], `${label}.${field}`);
}

interface MemoryOAuthProvider {
  readonly clientMetadata: {
    client_name: string;
    redirect_uris: string[];
    grant_types: string[];
    response_types: string[];
    token_endpoint_auth_method: "none";
  };
  readonly clientId: string;
  readonly tokens: { access_token: string; token_type: string; refresh_token?: string; scope?: string };
}

async function authorizeNativeClient(
  serverUrl: URL,
  ownerToken: string,
  fetchFn: typeof globalThis.fetch,
): Promise<MemoryOAuthProvider> {
  const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", serverUrl.origin);
  const resourceResponse = await fetchFn(resourceMetadataUrl);
  if (!resourceResponse.ok) throw new CutoverStateError(`OAuth resource metadata failed: HTTP ${resourceResponse.status}.`);
  const resourceMetadata = asRecord(await resourceResponse.json(), "OAuth resource metadata");
  const resource = requiredStringField(resourceMetadata, "resource", "OAuth resource metadata");
  const servers = resourceMetadata.authorization_servers;
  if (!Array.isArray(servers) || typeof servers[0] !== "string") {
    throw new CutoverStateError("OAuth resource metadata has no authorization server.");
  }
  const issuer = new URL(servers[0]);
  const authMetadataResponse = await fetchFn(new URL(".well-known/oauth-authorization-server", issuer));
  if (!authMetadataResponse.ok) throw new CutoverStateError(`OAuth authorization metadata failed: HTTP ${authMetadataResponse.status}.`);
  const authMetadata = asRecord(await authMetadataResponse.json(), "OAuth authorization metadata");
  const endpoint = (name: string): string => requiredStringField(authMetadata, name, "OAuth authorization metadata");
  const redirectUri = "http://127.0.0.1:9/devspace-native-cutover";
  const clientMetadata: MemoryOAuthProvider["clientMetadata"] = {
    client_name: "devspace-native-cutover",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  const registration = await fetchFn(endpoint("registration_endpoint"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(clientMetadata),
  });
  if (!registration.ok) throw new CutoverStateError(`OAuth dynamic registration failed: HTTP ${registration.status}.`);
  const client = asRecord(await registration.json(), "OAuth client registration");
  const clientId = requiredStringField(client, "client_id", "OAuth client registration");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomUUID();
  const params = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: "S256", scope: "devspace offline_access",
    resource, state,
  });
  const authorizationUrl = new URL(endpoint("authorization_endpoint"));
  authorizationUrl.search = params.toString();
  const authorization = await fetchFn(authorizationUrl, { redirect: "manual" });
  if (!authorization.ok && authorization.status !== 302 && authorization.status !== 303) {
    throw new CutoverStateError(`OAuth authorization page failed: HTTP ${authorization.status}.`);
  }
  const form = new URL(endpoint("authorization_endpoint"));
  const approval = await fetchFn(form, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams([...params, ["owner_token", ownerToken]]),
  });
  const location = approval.headers.get("location");
  if (!location) throw new CutoverStateError(`OAuth owner authorization failed: HTTP ${approval.status}.`);
  const callback = new URL(location);
  const code = callback.searchParams.get("code");
  if (!code || callback.searchParams.get("state") !== state) throw new CutoverStateError("OAuth authorization response has no valid code/state.");
  const token = await fetchFn(endpoint("token_endpoint"), {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri, code, code_verifier: verifier, resource }),
  });
  if (!token.ok) throw new CutoverStateError(`OAuth token exchange failed: HTTP ${token.status}.`);
  const tokenBody = asRecord(await token.json(), "OAuth token response");
  const accessToken = requiredStringField(tokenBody, "access_token", "OAuth token response");
  return {
    clientMetadata, clientId,
    tokens: { access_token: accessToken, token_type: typeof tokenBody.token_type === "string" ? tokenBody.token_type : "Bearer", ...(typeof tokenBody.refresh_token === "string" ? { refresh_token: tokenBody.refresh_token } : {}), ...(typeof tokenBody.scope === "string" ? { scope: tokenBody.scope } : {}) },
  };
}

/**
 * Authenticate against the live native MCP endpoint, collect one exact pair,
 * then close only the existing prepared observed-replacement record locally.
 * No MCP mutation tool, drain, restart, or caller-supplied expected identity is used.
 */
export async function performNativeObservedReplacementRecovery(
  options: NativeObservedReplacementOptions,
): Promise<NativeObservedReplacementResult> {
  if (options.ownerToken.length === 0) throw new CutoverStateError("OAuth owner token is not configured.");
  const fetchFn = options.fetch ?? globalThis.fetch;
  const oauth = await authorizeNativeClient(options.serverUrl, options.ownerToken, fetchFn);
  const transport = new StreamableHTTPClientTransport(options.serverUrl, {
    requestInit: { headers: { Authorization: `Bearer ${oauth.tokens.access_token}` } },
    fetch: fetchFn,
  });
  const client = new Client({ name: "devspace-native-cutover", version: "1.0.0" });
  try {
    await client.connect(transport);
    const statusResult = structuredResult(await client.callTool({ name: "cutover_status", arguments: {} }), "cutover_status");
    const status = requiredRecordField(statusResult, "status", "cutover_status");
    const current = requiredRecordField(status, "currentServerIdentity", "cutover_status");
    const cutover = requiredRecordField(status, "cutover", "cutover_status");
    if (requiredStringField(cutover, "cutoverId", "cutover_status") !== options.cutoverId) throw new CutoverStateError("Live cutover id does not match the requested cutover.");
    if (cutover.phase !== "prepared" || cutover.drainEvidence !== undefined) throw new CutoverStateError("Observed recovery requires a prepared cutover without drain evidence.");
    const serverInstanceId = requiredStringField(current, "serverInstanceId", "cutover_status");
    const sourceCommit = requiredStringField(current, "sourceCommit", "cutover_status");
    const buildId = requiredStringField(current, "buildId", "cutover_status");
    const capabilityManifestSha256 = requiredStringField(current, "capabilityManifestSha256", "cutover_status");
    const workspace = structuredResult(await client.callTool({ name: "workspace_inspect", arguments: { workspaceId: options.workspaceId } }), "workspace_inspect");
    const agentStatus = structuredResult(await client.callTool({ name: "agent_status", arguments: { workspaceId: options.workspaceId, agentId: options.agentId } }), "agent_status");
    const agent = structuredResult(await client.callTool({ name: "agent_reconcile", arguments: { workspaceId: options.workspaceId, agentId: options.agentId } }), "agent_reconcile");
    const workspaceSessions = typeof workspace.workspaceSessions === "number" ? workspace.workspaceSessions : 0;
    if (workspaceSessions < 1 || workspace.detail === undefined) throw new CutoverStateError("workspace_inspect did not prove a durable workspace.");
    if (requiredStringField(agent, "agentId", "agent_reconcile") !== options.agentId || requiredStringField(agentStatus, "agentId", "agent_status") !== options.agentId) throw new CutoverStateError("Live agent identity drifted during reconciliation.");
    const witness: DurableReconciliationWitness = {
      witnessCutoverId: options.cutoverId, witnessServerInstanceId: serverInstanceId,
      witnessExpectedIdentity: { sourceCommit, buildId, capabilityManifestSha256 },
      workspaceQueryable: true, agentQueryable: true, agentReconciled: true,
      witnessWorkspaceId: options.workspaceId, witnessAgentId: options.agentId,
      workspaceSessions, agentSessions: 1, witnessWorkspaceSessions: workspaceSessions, witnessAgentSessions: 1,
      witnessKind: "exact-pair", detail: [{ unit: "native-mcp", ok: true, detail: "authenticated status, workspace, agent status, and reconciliation agree" }],
    };
    const store = new CutoverStateStore(options.stateDir);
    const active = store.get();
    if (!active || active.cutoverId !== options.cutoverId) throw new CutoverStateError("Local durable cutover record does not match live cutover.");
    const recovered = store.recoverObservedReplacement({
      cutoverId: options.cutoverId,
      expectedNewIdentity: { sourceCommit, buildId, capabilityManifestSha256 },
      observedIdentity: { serverInstanceId, sourceCommit, buildId, capabilityManifestSha256 },
      recoveredBy: options.requesterIdentity.serverInstanceId,
      witness,
    });
    return { cutover: recovered.record, newlyRecovered: recovered.newlyRecovered, serverInstanceId, expectedNewIdentity: { sourceCommit, buildId, capabilityManifestSha256 }, witness };
  } finally {
    await client.close().catch(() => undefined);
    if (oauth.tokens.refresh_token) {
      const metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", options.serverUrl.origin);
      try {
        const metadata = asRecord(await fetchFn(metadataUrl).then((response) => response.json()), "OAuth resource metadata");
        const servers = metadata.authorization_servers;
        const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? new URL(servers[0]) : undefined;
        if (issuer) {
          const authMetadata = asRecord(await fetchFn(new URL(".well-known/oauth-authorization-server", issuer)).then((response) => response.json()), "OAuth authorization metadata");
          const endpoint = authMetadata.revocation_endpoint;
          if (typeof endpoint === "string") await fetchFn(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: oauth.tokens.refresh_token, token_type_hint: "refresh_token", client_id: oauth.clientId }) });
        }
      } catch { /* revocation is best effort; no token is persisted */ }
    }
  }
}

/** Perform terminal supersession + successor drain/restart scheduling durably. */
export function performCutoverRecovery(
  dependencies: CutoverRecoveryDependencies,
): CutoverRecoveryResult {
  const {
    store,
    requesterIdentity,
    cutoverId,
    expectedNewIdentity,
    drainEvidence,
    now = Date.now,
  } = dependencies;

  const current = store.get();
  if (!current) throw new CutoverStateError("No durable cutover record exists.");

  let buildReadyReceipt: Omit<BuildReadyReceipt, "verifiedAt">;
  if (dependencies.buildReadyProbe) {
    const probe = dependencies.buildReadyProbe(expectedNewIdentity);
    if (!probe.buildReady) {
      throw new CutoverStateError(`[CUTOVER_BUILD_NOT_READY] ${probe.detail}`);
    }
    buildReadyReceipt = { verifiedBy: probe.verifiedBy, evidence: probe.detail };
  } else if (dependencies.buildReadyAttestation) {
    buildReadyReceipt = dependencies.buildReadyAttestation;
  } else {
    throw new CutoverStateError(
      "Cutover recovery requires either a physical build-ready probe or an operator build-ready attestation; refusing to recover without one.",
    );
  }
  const buildReady: BuildReadyReceipt = {
    ...buildReadyReceipt,
    verifiedAt: new Date(now()).toISOString(),
  };

  const recovered = recoverCutoverWithStore(store, requesterIdentity, {
    cutoverId,
    expectedNewIdentity,
    ...(dependencies.expiresAt ? { expiresAt: dependencies.expiresAt } : {}),
    ...(dependencies.witness ? { witness: dependencies.witness } : {}),
  });

  if (!recovered.successor) {
    return {
      terminal: recovered.terminal,
      successor: recovered.terminal,
      newlyRecovered: recovered.newlyRecovered,
      drainRecord: recovered.terminal,
      restartRequested: false,
      restartScheduled: false,
      buildReadyVerifiedBy: buildReady.verifiedBy,
    };
  }

  const drainRecord = store.recordDrain(recovered.successor.cutoverId, drainEvidence);
  const requested = store.recordRestartRequest(recovered.successor.cutoverId, {
    actuator: "launchd-self",
    requestedByServerInstanceId: requesterIdentity.serverInstanceId,
    buildReady,
  });
  const scheduled = store.recordRestartScheduled(
    recovered.successor.cutoverId,
    requesterIdentity.serverInstanceId,
  );

  return {
    terminal: recovered.terminal,
    successor: recovered.successor,
    newlyRecovered: recovered.newlyRecovered,
    drainRecord,
    restartRequested: requested.newlyRequested,
    restartScheduled: scheduled.newlyScheduled,
    buildReadyVerifiedBy: buildReady.verifiedBy,
  };
}


/** Identity of the recovering runtime read from its own generated build identity. */
export function readRunningBuildIdentity(packageRoot: string): CutoverServerIdentity | undefined {
  try {
    const raw = readFileSync(join(packageRoot, BUILD_IDENTITY_RELATIVE_PATH), "utf8");
    const parsed = JSON.parse(raw) as { source_commit?: unknown; build_id?: unknown };
    if (typeof parsed.source_commit === "string" && typeof parsed.build_id === "string") {
      return {
        serverInstanceId: randomUUID(),
        sourceCommit: parsed.source_commit,
        buildId: parsed.build_id,
      };
    }
  } catch {
    // fall through; identity becomes unknown
  }
  return undefined;
}

/** Package root containing the currently executing build (dist or repo). */
export function runningPackageRoot(): string {
  return resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
}

/** Read-only status of the durable cutover store for the seam. */
export function cutoverSeamStatus(stateDir: string): Record<string, unknown> {
  const store = new CutoverStateStore(stateDir);
  return {
    active: store.get(),
    superseded: store.supersededRecord(),
  };
}

/** Resolve state from the same config chain the server uses; never a caller path. */
export function resolveSeamStateDir(): string {
  return loadConfig().stateDir;
}
