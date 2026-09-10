import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { loadConfig } from "./config.js";
import {
  BUILD_IDENTITY_RELATIVE_PATH,
  CutoverCapabilityManifestDomainMismatchError,
  probeBuildReady,
  probeTargetPackage,
  type BuildReadyProbeResult,
  type TargetPackageIdentity,
} from "./cutover-build-ready.js";
import {
  CUTOVER_BINDING_REPAIR_REASON,
  CUTOVER_BINDING_REPAIR_SCHEMA,
  CutoverStateError,
  CutoverStateStore,
  effectiveExpectedIdentity,
  type BuildReadyReceipt,
  type CutoverBindingRepairReceipt,
  type CutoverDrainEvidence,
  type CutoverReconciliationReceipt,
  type CutoverServerIdentity,
  type DurableCutoverRecord,
  type DurableReconciliationWitness,
  type ExpectedCutoverIdentity,
} from "./cutover-state.js";
import { CAPABILITY_MANIFEST_SCHEMA } from "./capability-manifest.js";

import { recoverCutoverWithStore, assertLegacyCutoverUnbound } from "./mcp-cutover.js";
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
  /** Configured public origin used for OAuth resource and issuer pinning. */
  publicBaseUrl: URL;
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

export class NativeObservedReplacementCommittedError extends CutoverStateError {
  constructor(readonly committedRecord: DurableCutoverRecord, message: string) {
    super(message);
  }
}

export class NativeBindingRepairOutcomeUnknownError extends CutoverStateError {
  constructor(readonly cutoverId: string, message: string) {
    super(message);
  }
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

export function validateNativeOAuthMetadata(
  metadata: JsonRecord,
  authorizationMetadata: JsonRecord,
  publicBaseUrl: URL,
  redirectUri: URL,
): { resource: URL; issuer: URL } {
  const expectedResource = new URL("/mcp", publicBaseUrl);
  const resource = new URL(requiredStringField(metadata, "resource", "OAuth resource metadata"));
  if (resource.href !== expectedResource.href) throw new CutoverStateError("OAuth resource does not match the configured public endpoint.");
  const servers = metadata.authorization_servers;
  if (!Array.isArray(servers) || typeof servers[0] !== "string") throw new CutoverStateError("OAuth resource metadata has no authorization server.");
  const issuer = new URL(servers[0]);
  if (issuer.origin !== publicBaseUrl.origin) throw new CutoverStateError("OAuth issuer origin is not the configured public origin.");
  if (authorizationMetadata.issuer !== issuer.href) throw new CutoverStateError("OAuth authorization metadata issuer does not match the protected-resource issuer.");
  for (const field of ["authorization_endpoint", "registration_endpoint", "token_endpoint", "revocation_endpoint"]) {
    const endpoint = new URL(requiredStringField(authorizationMetadata, field, "OAuth authorization metadata"));
    if (endpoint.origin !== publicBaseUrl.origin) throw new CutoverStateError(`OAuth ${field} origin is not the configured public origin.`);
  }
  if (redirectUri.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(redirectUri.hostname)) {
    throw new CutoverStateError("OAuth redirect URI must be a fixed loopback callback.");
  }
  return { resource, issuer };
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
  readonly revocationEndpoint: URL;
  readonly tokens: { access_token: string; token_type: string; refresh_token?: string; scope?: string };
}

async function authorizeNativeClient(
  serverUrl: URL,
  publicBaseUrl: URL,
  ownerToken: string,
  fetchFn: typeof globalThis.fetch,
): Promise<MemoryOAuthProvider> {
  const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", serverUrl.origin);
  const resourceResponse = await fetchFn(resourceMetadataUrl);
  if (!resourceResponse.ok) throw new CutoverStateError(`OAuth resource metadata failed: HTTP ${resourceResponse.status}.`);
  const resourceMetadata = asRecord(await resourceResponse.json(), "OAuth resource metadata");
  const servers = resourceMetadata.authorization_servers;
  if (!Array.isArray(servers) || typeof servers[0] !== "string") throw new CutoverStateError("OAuth resource metadata has no authorization server.");
  const issuer = new URL(servers[0]);
  const authMetadataResponse = await fetchFn(new URL(".well-known/oauth-authorization-server", issuer));
  if (!authMetadataResponse.ok) throw new CutoverStateError(`OAuth authorization metadata failed: HTTP ${authMetadataResponse.status}.`);
  const authMetadata = asRecord(await authMetadataResponse.json(), "OAuth authorization metadata");
  const endpoint = (name: string): string => requiredStringField(authMetadata, name, "OAuth authorization metadata");
  const redirectUri = "http://127.0.0.1:9/devspace-native-cutover";
  const metadataBinding = validateNativeOAuthMetadata(resourceMetadata, authMetadata, publicBaseUrl, new URL(redirectUri));
  const clientMetadata: MemoryOAuthProvider["clientMetadata"] = {
    client_name: "devspace-native-cutover",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  const registration = await fetchFn(endpoint("registration_endpoint"), {
    method: "POST",
    redirect: "manual",
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
    code_challenge: challenge, code_challenge_method: "S256", scope: "devspace",
    resource: metadataBinding.resource.href, state,
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
  if (callback.origin !== new URL(redirectUri).origin || callback.pathname !== new URL(redirectUri).pathname || callback.hash !== "") throw new CutoverStateError("OAuth authorization callback origin/path binding failed.");
  const code = callback.searchParams.get("code");
  if (!code || callback.searchParams.get("state") !== state) throw new CutoverStateError("OAuth authorization response has no valid code/state.");
  const token = await fetchFn(endpoint("token_endpoint"), {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri, code, code_verifier: verifier, resource: metadataBinding.resource.href }),
  });
  if (!token.ok) throw new CutoverStateError(`OAuth token exchange failed: HTTP ${token.status}.`);
  const tokenBody = asRecord(await token.json(), "OAuth token response");
  const accessToken = requiredStringField(tokenBody, "access_token", "OAuth token response");
  return {
    clientMetadata, clientId, revocationEndpoint: new URL(endpoint("revocation_endpoint")),
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
  assertLegacyCutoverUnbound(new CutoverStateStore(options.stateDir).get());
  if (options.ownerToken.length === 0) throw new CutoverStateError("OAuth owner token is not configured.");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(options.serverUrl.hostname);
  if (options.serverUrl.origin !== options.publicBaseUrl.origin && !loopback) throw new CutoverStateError("Native MCP endpoint must be the configured public origin or a loopback endpoint.");
  const fetchFn = options.fetch ?? globalThis.fetch;
  const oauth = await authorizeNativeClient(options.serverUrl, options.publicBaseUrl, options.ownerToken, fetchFn);
  const transport = new StreamableHTTPClientTransport(options.serverUrl, {
    requestInit: { headers: { Authorization: `Bearer ${oauth.tokens.access_token}` } },
    fetch: fetchFn,
  });
  const client = new Client({ name: "devspace-native-cutover", version: "1.0.0" });
  let operationError: unknown;
  let committedRecord: DurableCutoverRecord | undefined;
  try {
    await client.connect(transport);
    const statusResult = structuredResult(await client.callTool({ name: "cutover_status", arguments: {} }), "cutover_status");
    const status = requiredRecordField(statusResult, "status", "cutover_status");
    const current = requiredRecordField(status, "currentServerIdentity", "cutover_status");
    const cutover = requiredRecordField(status, "cutover", "cutover_status");
    if (requiredStringField(cutover, "cutoverId", "cutover_status") !== options.cutoverId) throw new CutoverStateError("Live cutover id does not match the requested cutover.");
    if (cutover.phase !== "closed" && (cutover.phase !== "prepared" || cutover.drainEvidence !== undefined)) throw new CutoverStateError("Observed recovery requires a prepared cutover without drain evidence.");
    const serverInstanceId = requiredStringField(current, "serverInstanceId", "cutover_status");
    const sourceCommit = requiredStringField(current, "sourceCommit", "cutover_status");
    const buildId = requiredStringField(current, "buildId", "cutover_status");
    const capabilityManifestSha256 = requiredStringField(current, "capabilityManifestSha256", "cutover_status");
    const store = new CutoverStateStore(options.stateDir);
    const before = store.get();
    assertLegacyCutoverUnbound(before);
    if (!before || before.cutoverId !== options.cutoverId) throw new CutoverStateError("Local durable cutover record does not match live cutover.");
    const liveExpected = requiredRecordField(cutover, "expectedNewIdentity", "cutover_status");
    const liveOld = requiredRecordField(cutover, "oldServerIdentity", "cutover_status");
    if (before.expectedNewIdentity.sourceCommit !== sourceCommit || before.expectedNewIdentity.buildId !== buildId || before.expectedNewIdentity.capabilityManifestSha256 !== capabilityManifestSha256 || liveExpected.sourceCommit !== sourceCommit || liveExpected.buildId !== buildId || liveExpected.capabilityManifestSha256 !== capabilityManifestSha256 || liveOld.serverInstanceId !== before.oldServerIdentity.serverInstanceId || liveOld.sourceCommit !== before.oldServerIdentity.sourceCommit || liveOld.buildId !== before.oldServerIdentity.buildId || liveOld.capabilityManifestSha256 !== before.oldServerIdentity.capabilityManifestSha256) throw new CutoverStateError("Local and live cutover generation bindings do not agree.");
    if (before.phase === "closed") {
      if (cutover.phase !== "closed" || cutover.drainEvidence !== undefined || cutover.restartRequest !== undefined) throw new CutoverStateError("Closed local replay requires an agreeing closed native cutover.");
      const observed = before.observedReplacement?.observedIdentity;
      if (!observed || observed.serverInstanceId !== serverInstanceId || observed.sourceCommit !== sourceCommit || observed.buildId !== buildId || observed.capabilityManifestSha256 !== capabilityManifestSha256) throw new CutoverStateError("Closed replay identity does not match the authenticated replacement.");
      const receipt = before.reconciliationReceipt;
      if (!receipt) throw new CutoverStateError("Closed replay is missing its durable reconciliation receipt.");
      if (receipt.witnessWorkspaceId !== options.workspaceId || receipt.witnessAgentId !== options.agentId) throw new CutoverStateError("Closed replay pair does not match the stored reconciliation receipt.");
      committedRecord = before;
      return { cutover: before, newlyRecovered: false, serverInstanceId, expectedNewIdentity: { sourceCommit, buildId, capabilityManifestSha256 }, witness: { workspaceQueryable: receipt.workspaceQueryable, agentQueryable: receipt.agentQueryable, agentReconciled: receipt.agentReconciled, witnessCutoverId: options.cutoverId, witnessServerInstanceId: serverInstanceId, witnessExpectedIdentity: { sourceCommit, buildId, capabilityManifestSha256 }, witnessWorkspaceId: receipt.witnessWorkspaceId, witnessAgentId: receipt.witnessAgentId, witnessWorkspaceSessions: receipt.witnessWorkspaceSessions, witnessAgentSessions: receipt.witnessAgentSessions, witnessKind: receipt.witnessKind } };
    }
    if (before.phase !== "prepared" || before.drainEvidence || before.restartRequest || existsSync(join(options.stateDir, "cutover", "active", "restart-requested.json")) || existsSync(join(options.stateDir, "cutover", "active", "restart-scheduled.json"))) throw new CutoverStateError("Observed recovery requires a prepared local cutover with no drain or restart evidence.");
    if (cutover.phase !== "prepared" || cutover.drainEvidence !== undefined || cutover.restartRequest !== undefined) throw new CutoverStateError("Observed recovery requires a prepared live cutover with no drain or restart evidence.");
    const workspace = structuredResult(await client.callTool({ name: "workspace_inspect", arguments: { workspaceId: options.workspaceId } }), "workspace_inspect");
    const agentStatus = structuredResult(await client.callTool({ name: "agent_status", arguments: { workspaceId: options.workspaceId, agentId: options.agentId } }), "agent_status");
    assertLegacyCutoverUnbound(store.get());
    const agent = structuredResult(await client.callTool({ name: "agent_reconcile", arguments: { workspaceId: options.workspaceId, agentId: options.agentId } }), "agent_reconcile");
    const workspaceSessions = typeof workspace.workspaceSessions === "number" ? workspace.workspaceSessions : 0;
    const details = Array.isArray(workspace.detail) ? workspace.detail : [];
    const matchingWorkspace = details.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const item = entry as JsonRecord;
      const session = item.session;
      return item.unit === `workspace:${options.workspaceId}` && !!session && typeof session === "object" && (session as JsonRecord).id === options.workspaceId && typeof (session as JsonRecord).root === "string";
    });
    const selectedSession = details.find((entry) => entry && typeof entry === "object" && (entry as JsonRecord).unit === `workspace:${options.workspaceId}`) as JsonRecord | undefined;
    const selectedRoot = selectedSession && (selectedSession.session as JsonRecord | undefined)?.root;
    if (workspaceSessions < 1 || !matchingWorkspace || typeof selectedRoot !== "string") throw new CutoverStateError("workspace_inspect did not prove the requested durable workspace identity and root.");
    if (requiredStringField(agent, "agentId", "agent_reconcile") !== options.agentId || requiredStringField(agentStatus, "agentId", "agent_status") !== options.agentId || requiredStringField(agentStatus, "workspaceId", "agent_status") !== options.workspaceId || requiredStringField(agentStatus, "workspaceRoot", "agent_status") !== selectedRoot) throw new CutoverStateError("Live agent identity or workspace binding drifted during reconciliation.");
    const witness: DurableReconciliationWitness = {
      witnessCutoverId: options.cutoverId, witnessServerInstanceId: serverInstanceId,
      witnessExpectedIdentity: { sourceCommit, buildId, capabilityManifestSha256 },
      workspaceQueryable: true, agentQueryable: true, agentReconciled: true,
      witnessWorkspaceId: options.workspaceId, witnessAgentId: options.agentId,
      workspaceSessions, agentSessions: 1, witnessWorkspaceSessions: workspaceSessions, witnessAgentSessions: 1,
      witnessKind: "exact-pair", detail: [{ unit: "native-mcp", ok: true, detail: "authenticated status, workspace, agent status, and reconciliation agree" }],
    };
    if (!before || before.cutoverId !== options.cutoverId) throw new CutoverStateError("Local cutover state changed before observed recovery.");
    const activeDir = join(options.stateDir, "cutover", "active");
    if (existsSync(join(activeDir, "restart-requested.json")) || existsSync(join(activeDir, "restart-scheduled.json"))) throw new CutoverStateError("Observed recovery refuses existing restart markers.");
    if (before.phase !== "prepared" || before.restartRequest || before.drainEvidence) throw new CutoverStateError("Local cutover state changed before observed recovery.");
    const commitStatusResult = structuredResult(await client.callTool({ name: "cutover_status", arguments: {} }), "cutover_status before commit");
    const commitStatus = requiredRecordField(commitStatusResult, "status", "cutover_status before commit");
    const commitIdentity = requiredRecordField(commitStatus, "currentServerIdentity", "cutover_status before commit");
    const commitCutover = requiredRecordField(commitStatus, "cutover", "cutover_status before commit");
    if (requiredStringField(commitCutover, "cutoverId", "cutover_status before commit") !== options.cutoverId || commitIdentity.serverInstanceId !== serverInstanceId || commitIdentity.sourceCommit !== sourceCommit || commitIdentity.buildId !== buildId || commitIdentity.capabilityManifestSha256 !== capabilityManifestSha256 || commitCutover.phase !== "prepared") throw new CutoverStateError("Live generation drifted before durable observed recovery.");
    assertLegacyCutoverUnbound(store.get());
    const refreshed = store.get();
    const refreshedExpected = refreshed?.expectedNewIdentity;
    const refreshedOld = refreshed?.oldServerIdentity;
    const commitExpected = requiredRecordField(commitCutover, "expectedNewIdentity", "cutover_status before commit");
    const commitOld = requiredRecordField(commitCutover, "oldServerIdentity", "cutover_status before commit");
    if (!refreshed || refreshed.cutoverId !== options.cutoverId || refreshed.phase !== "prepared" || refreshed.drainEvidence || refreshed.restartRequest || commitCutover.drainEvidence !== undefined || commitCutover.restartRequest !== undefined || existsSync(join(options.stateDir, "cutover", "active", "restart-requested.json")) || existsSync(join(options.stateDir, "cutover", "active", "restart-scheduled.json")) || !refreshedExpected || !refreshedOld || refreshedExpected.sourceCommit !== before.expectedNewIdentity.sourceCommit || refreshedExpected.buildId !== before.expectedNewIdentity.buildId || refreshedExpected.capabilityManifestSha256 !== before.expectedNewIdentity.capabilityManifestSha256 || refreshedOld.serverInstanceId !== before.oldServerIdentity.serverInstanceId || refreshedOld.sourceCommit !== before.oldServerIdentity.sourceCommit || refreshedOld.buildId !== before.oldServerIdentity.buildId || refreshedOld.capabilityManifestSha256 !== before.oldServerIdentity.capabilityManifestSha256 || commitExpected.sourceCommit !== refreshedExpected.sourceCommit || commitExpected.buildId !== refreshedExpected.buildId || commitExpected.capabilityManifestSha256 !== refreshedExpected.capabilityManifestSha256 || commitOld.serverInstanceId !== refreshedOld.serverInstanceId || commitOld.sourceCommit !== refreshedOld.sourceCommit || commitOld.buildId !== refreshedOld.buildId || commitOld.capabilityManifestSha256 !== refreshedOld.capabilityManifestSha256) throw new CutoverStateError("Cutover generation or local state drifted before durable observed recovery.");
    const recovered = store.recoverObservedReplacement({
      cutoverId: options.cutoverId,
      expectedNewIdentity: { sourceCommit, buildId, capabilityManifestSha256 },
      observedIdentity: { serverInstanceId, sourceCommit, buildId, capabilityManifestSha256 },
      recoveredBy: options.requesterIdentity.serverInstanceId,
      witness,
    });
    committedRecord = recovered.record;
    let after: DurableCutoverRecord;
    try {
      const readback = store.get();
      if (!readback || readback.phase !== "closed" || readback.observedReplacement?.observedIdentity.serverInstanceId !== serverInstanceId || readback.restartRequest || readback.drainEvidence) throw new Error("durable readback did not match the authenticated witness");
      after = readback;
    } catch (error) {
      throw new NativeObservedReplacementCommittedError(committedRecord, `Native observed recovery committed but durable readback failed; reconcile before retry: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const postStatusResult = structuredResult(await client.callTool({ name: "cutover_status", arguments: {} }), "cutover_status after commit");
      const postStatus = requiredRecordField(postStatusResult, "status", "cutover_status after commit");
      const postIdentity = requiredRecordField(postStatus, "currentServerIdentity", "cutover_status after commit");
      const postCutover = requiredRecordField(postStatus, "cutover", "cutover_status after commit");
      const postExpected = requiredRecordField(postCutover, "expectedNewIdentity", "cutover_status after commit");
      if (requiredStringField(postCutover, "cutoverId", "cutover_status after commit") !== options.cutoverId || postCutover.phase !== "closed" || postIdentity.serverInstanceId !== serverInstanceId || postIdentity.sourceCommit !== sourceCommit || postIdentity.buildId !== buildId || postIdentity.capabilityManifestSha256 !== capabilityManifestSha256 || postExpected.sourceCommit !== sourceCommit || postExpected.buildId !== buildId || postExpected.capabilityManifestSha256 !== capabilityManifestSha256) throw new Error("post-commit live status does not match committed observed generation");
    } catch (error) {
      throw new NativeObservedReplacementCommittedError(after, `Native observed recovery committed locally but post-commit status failed; reconcile before retry: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { cutover: after, newlyRecovered: recovered.newlyRecovered, serverInstanceId, expectedNewIdentity: { sourceCommit, buildId, capabilityManifestSha256 }, witness };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    await client.close().catch(() => undefined);
    const revocationErrors: string[] = [];
    for (const [kind, token] of [["access", oauth.tokens.access_token], ["refresh", oauth.tokens.refresh_token]] as const) {
      if (!token) continue;
      try {
        const response = await fetchFn(oauth.revocationEndpoint, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token, token_type_hint: `${kind}_token`, client_id: oauth.clientId }) });
        if (!response.ok || response.status >= 300) revocationErrors.push(`${kind}:HTTP ${response.status}`);
      } catch (error) { revocationErrors.push(`${kind}:${error instanceof Error ? error.message : String(error)}`); }
    }
    if (revocationErrors.length > 0 && operationError instanceof Error) {
      Object.defineProperty(operationError, "cleanupErrors", { value: revocationErrors, enumerable: true, configurable: true });
    }
    if (revocationErrors.length > 0 && !operationError) {
      if (committedRecord) throw new NativeObservedReplacementCommittedError(committedRecord, `OAuth token revocation failed after commit; reconcile before retry: ${revocationErrors.join(",")}.`);
      throw new CutoverStateError(`OAuth token revocation failed: ${revocationErrors.join(",")}.`);
    }
  }
}

export interface NativeCrossDomainBindingRepairOptions {
  serverUrl: URL | string;
  publicBaseUrl?: URL | string;
  stateDir: string;
  cutoverId: string;
  workspaceId: string;
  agentId: string;
  ownerToken: string;
  requesterIdentity: CutoverServerIdentity;
  packageRoot?: string;
  fetch?: typeof globalThis.fetch;
}

export interface NativeCrossDomainBindingRepairResult {
  cutover: DurableCutoverRecord;
  newlyRecovered: boolean;
  serverInstanceId: string;
  bindingRepair: CutoverBindingRepairReceipt;
  witness: DurableReconciliationWitness;
  mode: "normal";
}

async function validateClosedBindingRepair(
  store: CutoverStateStore,
  client: Client,
  options: NativeCrossDomainBindingRepairOptions,
  record: DurableCutoverRecord,
  serverInstanceId: string,
  sourceCommit: string,
  buildId: string,
  capabilityManifestSha256: string,
  repairReceipt: CutoverBindingRepairReceipt,
): Promise<DurableCutoverRecord> {
  const durable = store.get();
  if (!durable || durable.cutoverId !== options.cutoverId || durable.phase !== "closed" || !durable.bindingRepair || !isDeepStrictEqual(durable.bindingRepair, repairReceipt) || durable.reconciliationReceipt?.witnessWorkspaceId !== options.workspaceId || durable.reconciliationReceipt?.witnessAgentId !== options.agentId || durable.expectedNewIdentity.capabilityManifestSha256 !== record.expectedNewIdentity.capabilityManifestSha256) {
    throw new NativeObservedReplacementCommittedError(record, "Binding repair committed but durable closed readback did not match the exact receipt and witness pair; reconcile before retry.");
  }
  const result = structuredResult(await client.callTool({ name: "cutover_status", arguments: {} }), "cutover_status post-close");
  const status = requiredRecordField(result, "status", "cutover_status post-close");
  const cutover = requiredRecordField(status, "cutover", "cutover_status post-close");
  const current = requiredRecordField(status, "currentServerIdentity", "cutover_status post-close");
  const expected = requiredRecordField(cutover, "expectedNewIdentity", "cutover_status post-close");
  if (requiredStringField(cutover, "cutoverId", "cutover_status post-close") !== options.cutoverId || cutover.phase !== "closed" || requiredStringField(current, "serverInstanceId", "cutover_status post-close") !== serverInstanceId || requiredStringField(current, "sourceCommit", "cutover_status post-close") !== sourceCommit || requiredStringField(current, "buildId", "cutover_status post-close") !== buildId || requiredStringField(current, "capabilityManifestSha256", "cutover_status post-close") !== capabilityManifestSha256 || requiredStringField(expected, "sourceCommit", "cutover_status post-close") !== record.expectedNewIdentity.sourceCommit || requiredStringField(expected, "buildId", "cutover_status post-close") !== record.expectedNewIdentity.buildId || requiredStringField(expected, "capabilityManifestSha256", "cutover_status post-close") !== record.expectedNewIdentity.capabilityManifestSha256) {
    throw new NativeObservedReplacementCommittedError(record, "Binding repair committed but fresh native closed status did not match the exact authenticated identity; reconcile before retry.");
  }
  return durable;
}

export async function performNativeCrossDomainBindingRepair(
  options: NativeCrossDomainBindingRepairOptions,
): Promise<NativeCrossDomainBindingRepairResult> {
  const initialRecord = new CutoverStateStore(options.stateDir).get();
  assertLegacyCutoverUnbound(initialRecord);
  if (options.ownerToken.length === 0) throw new CutoverStateError("OAuth owner token is not configured.");
  const serverUrl = typeof options.serverUrl === "string" ? new URL(options.serverUrl) : options.serverUrl;
  const publicBaseUrl = options.publicBaseUrl
    ? (typeof options.publicBaseUrl === "string" ? new URL(options.publicBaseUrl) : options.publicBaseUrl)
    : serverUrl;
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(serverUrl.hostname);
  if (serverUrl.origin !== publicBaseUrl.origin && !loopback) {
    throw new CutoverStateError("Native MCP endpoint must be the configured public origin or a loopback endpoint.");
  }
  const fetchFn = options.fetch ?? globalThis.fetch;
  const oauth = await authorizeNativeClient(serverUrl, publicBaseUrl, options.ownerToken, fetchFn);
  const transport = new StreamableHTTPClientTransport(serverUrl, {
    requestInit: { headers: { Authorization: `Bearer ${oauth.tokens.access_token}` } },
    fetch: fetchFn,
  });
  const client = new Client({ name: "devspace-native-binding-repair", version: "1.0.0" });
  let operationError: unknown;
  // Preserve observed commit evidence even when the next fresh read fails.
  // This snapshot never authorizes a mutation or replaces fresh validation.
  let committedRecord: DurableCutoverRecord | undefined =
    initialRecord?.cutoverId === options.cutoverId && initialRecord.phase === "closed" ? initialRecord : undefined;
  let repairReceiptForReconciliation: CutoverBindingRepairReceipt | undefined;
  let committedReadbackError: string | undefined;
  let writeAttempted = false;
  try {
    await client.connect(transport);

    const healthUrl = new URL("/healthz", serverUrl);
    const healthRes = await fetchFn(healthUrl);
    if (!healthRes.ok) {
      throw new CutoverStateError(`Live server /healthz responded with ${healthRes.status}.`);
    }
    const health = (await healthRes.json()) as JsonRecord;
    const capabilityManifest = health.capabilityManifest as JsonRecord | undefined;
    if (
      !capabilityManifest ||
      capabilityManifest.schema !== CAPABILITY_MANIFEST_SCHEMA ||
      !Array.isArray(capabilityManifest.capabilities) ||
      !Array.isArray(capabilityManifest.missing) ||
      capabilityManifest.missing.length > 0 ||
      typeof capabilityManifest.manifestSha256 !== "string"
    ) {
      throw new CutoverStateError("Current server capability manifest is malformed or missing required capabilities.");
    }

    const statusResult = structuredResult(await client.callTool({ name: "cutover_status", arguments: {} }), "cutover_status");
    const status = requiredRecordField(statusResult, "status", "cutover_status");
    const current = requiredRecordField(status, "currentServerIdentity", "cutover_status");
    const cutover = requiredRecordField(status, "cutover", "cutover_status");
    if (requiredStringField(cutover, "cutoverId", "cutover_status") !== options.cutoverId) {
      throw new CutoverStateError("Live cutover id does not match the requested cutover.");
    }
    const serverInstanceId = requiredStringField(current, "serverInstanceId", "cutover_status");
    const sourceCommit = requiredStringField(current, "sourceCommit", "cutover_status");
    const buildId = requiredStringField(current, "buildId", "cutover_status");
    const capabilityManifestSha256 = requiredStringField(current, "capabilityManifestSha256", "cutover_status");
    if (capabilityManifestSha256 !== capabilityManifest.manifestSha256) {
      throw new CutoverStateError("Live server capability manifest digest does not match current identity.");
    }

    const store = new CutoverStateStore(options.stateDir);
    const before = store.get();
    assertLegacyCutoverUnbound(before);
    if (!before || before.cutoverId !== options.cutoverId) {
      throw new CutoverStateError("Local durable cutover record does not match live cutover.");
    }
    if (typeof before.supersedesCutoverId !== "string" || before.supersedesCutoverId.length === 0 || before.supersedesCutoverId === before.cutoverId) {
      throw new CutoverStateError("Binding repair requires an established successor cutover record.");
    }
    if (before.phase !== "drained" && before.phase !== "closed") {
      throw new CutoverStateError(`Binding repair requires phase == drained; got ${before.phase}.`);
    }
    if (!before.restartRequest || !before.restartRequest.restartScheduledAt) {
      throw new CutoverStateError("Binding repair requires an existing durably scheduled restart.");
    }
    if (serverInstanceId === before.oldServerIdentity.serverInstanceId) {
      throw new CutoverStateError("Same old server instance is still running; refusing binding repair.");
    }
    if (serverInstanceId === before.restartRequest.requestedByServerInstanceId) {
      throw new CutoverStateError("Current server instance is the restart-scheduling server; restart not effected.");
    }
    if (sourceCommit !== before.expectedNewIdentity.sourceCommit) {
      throw new CutoverStateError(`Live sourceCommit ${sourceCommit} does not match expected target ${before.expectedNewIdentity.sourceCommit}.`);
    }
    if (buildId !== before.expectedNewIdentity.buildId) {
      throw new CutoverStateError(`Live buildId ${buildId} does not match expected target ${before.expectedNewIdentity.buildId}.`);
    }
    if (before.expectedNewIdentity.capabilityManifestSha256 === capabilityManifestSha256) {
      throw new CutoverStateError("Cutover expected target already matches expected; binding repair is not needed.");
    }

    const targetRoot = options.packageRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
    let targetPackage: TargetPackageIdentity;
    try {
      targetPackage = probeTargetPackage(targetRoot);
    } catch (error) {
      throw new CutoverStateError(`Target package cannot be physically probed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!targetPackage.buildManifestSha256) {
      throw new CutoverStateError("Target build manifest identity unavailable.");
    }
    if (
      targetPackage.sourceCommit !== before.expectedNewIdentity.sourceCommit ||
      targetPackage.buildId !== before.expectedNewIdentity.buildId
    ) {
      throw new CutoverStateError("Target package identity does not match expected cutover target.");
    }
    if (targetPackage.buildManifestSha256 !== before.expectedNewIdentity.capabilityManifestSha256) {
      throw new CutoverStateError(
        `Cryptographic attribution failed: expected capability manifest digest ${before.expectedNewIdentity.capabilityManifestSha256} does not equal target build_manifest_sha256 ${targetPackage.buildManifestSha256}. [NOT_A_CROSS_DOMAIN_MISBINDING]`,
      );
    }

    if (before.phase === "closed") {
      if (!before.bindingRepair) {
        throw new CutoverStateError("Closed cutover is missing binding repair receipt.");
      }
      if (
        before.bindingRepair.correctCapabilityManifestSha256 !== capabilityManifestSha256 ||
        before.bindingRepair.observedServerInstanceId !== serverInstanceId ||
        before.bindingRepair.sourceCommit !== sourceCommit ||
        before.bindingRepair.buildId !== buildId
      ) {
        throw new CutoverStateError("[REPAIR_BINDING_MISMATCH] Closed replay identity does not match authenticated replacement.");
      }
      const receipt = before.reconciliationReceipt;
      if (!receipt || receipt.witnessWorkspaceId !== options.workspaceId || receipt.witnessAgentId !== options.agentId) {
        throw new CutoverStateError("[REPAIR_BINDING_MISMATCH] Closed replay pair does not match stored reconciliation receipt.");
      }
      committedRecord = before;
      await validateClosedBindingRepair(store, client, options, before, serverInstanceId, sourceCommit, buildId, capabilityManifestSha256, before.bindingRepair);
      return {
        cutover: before,
        newlyRecovered: false,
        serverInstanceId,
        bindingRepair: before.bindingRepair,
        witness: {
          workspaceQueryable: receipt.workspaceQueryable,
          agentQueryable: receipt.agentQueryable,
          agentReconciled: receipt.agentReconciled,
          witnessCutoverId: options.cutoverId,
          witnessServerInstanceId: serverInstanceId,
          witnessExpectedIdentity: effectiveExpectedIdentity(before),
          witnessWorkspaceId: receipt.witnessWorkspaceId,
          witnessAgentId: receipt.witnessAgentId,
          witnessWorkspaceSessions: receipt.witnessWorkspaceSessions,
          witnessAgentSessions: receipt.witnessAgentSessions,
          witnessKind: receipt.witnessKind,
        },
        mode: "normal",
      };
    }

    const workspace = structuredResult(await client.callTool({ name: "workspace_inspect", arguments: { workspaceId: options.workspaceId } }), "workspace_inspect");
    const agentStatus = structuredResult(await client.callTool({ name: "agent_status", arguments: { workspaceId: options.workspaceId, agentId: options.agentId } }), "agent_status");
    assertLegacyCutoverUnbound(store.get());
    const agent = structuredResult(await client.callTool({ name: "agent_reconcile", arguments: { workspaceId: options.workspaceId, agentId: options.agentId } }), "agent_reconcile");
    const workspaceSessions = typeof workspace.workspaceSessions === "number" ? workspace.workspaceSessions : 0;
    const details = Array.isArray(workspace.detail) ? workspace.detail : [];
    const matchingWorkspace = details.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const item = entry as JsonRecord;
      const session = item.session;
      return (
        item.unit === `workspace:${options.workspaceId}` &&
        !!session &&
        typeof session === "object" &&
        (session as JsonRecord).id === options.workspaceId &&
        typeof (session as JsonRecord).root === "string"
      );
    });
    const selectedSession = details.find(
      (entry) => entry && typeof entry === "object" && (entry as JsonRecord).unit === `workspace:${options.workspaceId}`,
    ) as JsonRecord | undefined;
    const selectedRoot = selectedSession && (selectedSession.session as JsonRecord | undefined)?.root;
    if (workspaceSessions < 1 || !matchingWorkspace || typeof selectedRoot !== "string") {
      throw new CutoverStateError("workspace_inspect did not prove the requested durable workspace identity and root.");
    }
    if (
      requiredStringField(agent, "agentId", "agent_reconcile") !== options.agentId ||
      requiredStringField(agentStatus, "agentId", "agent_status") !== options.agentId ||
      requiredStringField(agentStatus, "workspaceId", "agent_status") !== options.workspaceId ||
      requiredStringField(agentStatus, "workspaceRoot", "agent_status") !== selectedRoot
    ) {
      throw new CutoverStateError("Live agent identity or workspace binding drifted during reconciliation.");
    }
    const agentReconciled = Boolean(agent.agentReconciled ?? true);
    if (!agentReconciled) {
      throw new CutoverStateError("Agent reconciliation failed.");
    }

    const nowIso = new Date().toISOString();
    const proposedRepair: CutoverBindingRepairReceipt = {
      schema: CUTOVER_BINDING_REPAIR_SCHEMA,
      cutoverId: options.cutoverId,
      reason: CUTOVER_BINDING_REPAIR_REASON,
      repairControlSurfaceIdentity: options.requesterIdentity,
      observedTargetRuntimeIdentity: {
        serverInstanceId,
        sourceCommit,
        buildId,
        capabilityManifestSha256,
      },
      originalCutoverExpectedIdentity: before.expectedNewIdentity,
      effectiveRepairedIdentity: {
        sourceCommit,
        buildId,
        capabilityManifestSha256,
      },
      originalBoundDigest: before.expectedNewIdentity.capabilityManifestSha256!,
      originalDigestField: "expectedNewIdentity.capabilityManifestSha256",
      provenActualDigestDomain: "build_manifest_sha256",
      correctCapabilityManifestSchema: CAPABILITY_MANIFEST_SCHEMA,
      correctCapabilityManifestSha256: capabilityManifestSha256,
      sourceCommit,
      buildId,
      observedServerInstanceId: serverInstanceId,
      repairedBy: options.requesterIdentity.serverInstanceId,
      repairedAt: nowIso,
      physicalProbeEvidence: `Target package at ${targetRoot} verified: build_manifest_sha256=${targetPackage.buildManifestSha256} equals expectedNewIdentity.capabilityManifestSha256.`,
    };
    const repairReceipt = before.bindingRepair ?? proposedRepair;
    repairReceiptForReconciliation = repairReceipt;
    if (before.bindingRepair && (
      before.bindingRepair.cutoverId !== options.cutoverId ||
      before.bindingRepair.correctCapabilityManifestSha256 !== capabilityManifestSha256 ||
      before.bindingRepair.observedServerInstanceId !== serverInstanceId ||
      before.bindingRepair.sourceCommit !== sourceCommit ||
      before.bindingRepair.buildId !== buildId ||
      before.bindingRepair.originalCutoverExpectedIdentity.capabilityManifestSha256 !== before.expectedNewIdentity.capabilityManifestSha256
    )) {
      throw new CutoverStateError("[REPAIR_BINDING_MISMATCH] Existing durable binding repair does not match authenticated replacement.");
    }

    // Fresh binding validation before durable write (G71-R6)
    assertLegacyCutoverUnbound(store.get());
    const latest = store.get();
    if (!latest || latest.cutoverId !== before.cutoverId) {
      throw new CutoverStateError("Concurrent modification detected: active cutover changed during repair evaluation.");
    }
    if (latest.supersedesCutoverId !== before.supersedesCutoverId) {
      throw new CutoverStateError("Concurrent modification detected: successor predecessor binding changed during repair evaluation.");
    }
    if (latest.phase !== "drained") {
      throw new CutoverStateError(`Concurrent modification detected: cutover phase transitioned to ${latest.phase}.`);
    }
    if (latest.updatedAt !== before.updatedAt) {
      throw new CutoverStateError("Concurrent modification detected: cutover was updated during repair evaluation.");
    }
    if (latest.expectedNewIdentity.capabilityManifestSha256 !== before.expectedNewIdentity.capabilityManifestSha256) {
      throw new CutoverStateError("Concurrent modification detected: expectedNewIdentity changed during repair evaluation.");
    }
    if (latest.bindingRepair && !isDeepStrictEqual(latest.bindingRepair, repairReceipt)) {
      throw new CutoverStateError("Concurrent modification detected: conflicting bindingRepair already recorded.");
    }

    writeAttempted = true;
    const repaired = store.recordBindingRepair(options.cutoverId, repairReceipt);
    committedRecord = repaired.record;

    const witness: DurableReconciliationWitness = {
      witnessCutoverId: options.cutoverId,
      witnessServerInstanceId: serverInstanceId,
      witnessExpectedIdentity: { sourceCommit, buildId, capabilityManifestSha256 },
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
      witnessWorkspaceId: options.workspaceId,
      witnessAgentId: options.agentId,
      workspaceSessions,
      agentSessions: 1,
      witnessWorkspaceSessions: workspaceSessions,
      witnessAgentSessions: 1,
      witnessKind: "exact-pair",
      detail: [{ unit: "native-mcp", ok: true, detail: "cross-domain digest misbinding repaired and reconciled" }],
    };
    const reconciliationReceipt: CutoverReconciliationReceipt = {
      closedByServerInstanceId: serverInstanceId,
      ...witness,
      reconciledAt: nowIso,
      terminalReason: undefined,
    };
    const closed = store.close(options.cutoverId, reconciliationReceipt);
    committedRecord = closed;
    await validateClosedBindingRepair(store, client, options, closed, serverInstanceId, sourceCommit, buildId, capabilityManifestSha256, repairReceipt);
    return {
      cutover: closed,
      newlyRecovered: true,
      serverInstanceId,
      bindingRepair: repairReceipt,
      witness,
      mode: "normal",
    };
  } catch (error) {
    if (!committedRecord && writeAttempted && repairReceiptForReconciliation) {
      try {
        const reconciled = new CutoverStateStore(options.stateDir).get();
        if (reconciled?.bindingRepair && isDeepStrictEqual(reconciled.bindingRepair, repairReceiptForReconciliation)) {
          committedRecord = reconciled;
        }
      } catch (readbackError) {
        operationError = new NativeBindingRepairOutcomeUnknownError(
          options.cutoverId,
          `Binding repair outcome unknown; reconcile before retry: durable readback failed: ${readbackError instanceof Error ? readbackError.message : String(readbackError)}`,
        );
        throw operationError;
      }
    } else if (committedRecord) {
      try {
        const reconciled = new CutoverStateStore(options.stateDir).get();
        if (reconciled?.cutoverId === options.cutoverId && reconciled.phase === "closed") committedRecord = reconciled;
      } catch (readbackError) {
        committedReadbackError = `durable readback failed: ${readbackError instanceof Error ? readbackError.message : String(readbackError)}`;
      }
    }
    if (committedRecord && !(error instanceof NativeObservedReplacementCommittedError)) {
      operationError = new NativeObservedReplacementCommittedError(
        committedRecord,
        `Binding repair committed partially; reconcile before retry: ${error instanceof Error ? error.message : String(error)}${committedReadbackError ? `; ${committedReadbackError}` : ""}`,
      );
      throw operationError;
    }
    operationError = error;
    throw error;
  } finally {
    await client.close().catch(() => undefined);
    const revocationErrors: string[] = [];
    for (const [kind, token] of [["access", oauth.tokens.access_token], ["refresh", oauth.tokens.refresh_token]] as const) {
      if (!token) continue;
      try {
        const response = await fetchFn(oauth.revocationEndpoint, {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token, token_type_hint: `${kind}_token`, client_id: oauth.clientId }),
        });
        if (!response.ok || response.status >= 300) revocationErrors.push(`${kind}:HTTP ${response.status}`);
      } catch (error) {
        revocationErrors.push(`${kind}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (revocationErrors.length > 0 && operationError instanceof Error) {
      Object.defineProperty(operationError, "cleanupErrors", { value: revocationErrors, enumerable: true, configurable: true });
    }
    if (revocationErrors.length > 0 && !operationError) {
      if (committedRecord) {
        throw new NativeObservedReplacementCommittedError(
          committedRecord,
          `Binding repair committed but OAuth token revocation failed; reconcile before retry: ${revocationErrors.join(",")}.`,
        );
      }
      throw new CutoverStateError(`OAuth token revocation failed: ${revocationErrors.join(",")}.`);
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

  assertLegacyCutoverUnbound(store.get());
  const current = store.get();
  if (!current) throw new CutoverStateError("No durable cutover record exists.");

  let buildReadyReceipt: Omit<BuildReadyReceipt, "verifiedAt">;
  if (dependencies.buildReadyProbe) {
    const probe = dependencies.buildReadyProbe(expectedNewIdentity);
    if (!probe.buildReady) {
      if (probe.domainMismatch) {
        throw new CutoverCapabilityManifestDomainMismatchError(probe.detail);
      }
      throw new CutoverStateError(`[CUTOVER_BUILD_NOT_READY] ${probe.detail}`);
    }
    if (
      probe.actualBuildManifestSha256 !== undefined &&
      expectedNewIdentity.capabilityManifestSha256 !== undefined &&
      probe.actualBuildManifestSha256 === expectedNewIdentity.capabilityManifestSha256
    ) {
      throw new CutoverCapabilityManifestDomainMismatchError();
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

  assertLegacyCutoverUnbound(store.get());
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
