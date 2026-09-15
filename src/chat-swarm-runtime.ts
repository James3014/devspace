import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  ChatSwarmError,
  canonicalize,
  hashContent,
  type ChatSwarmTask,
  type ChatSwarmWorker,
} from "./chat-swarm-contract.js";
import {
  ChatSwarmCarrierManager,
  type CarrierCallInput,
  type CarrierEnsureEvidence,
  type CarrierWakeEvidence,
  type ChatSwarmCarrierAdapter,
} from "./chat-swarm-carrier.js";
import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";
import { resolveChatSwarmIdentity } from "./request-meta.js";

const SLOT_KIND = "chat_swarm_managed_carrier";
const PROVISION_KIND = "chat_swarm_runtime_provision";
const STOP_KIND = "chat_swarm_runtime_stop";
const SLOT_SCHEMA = "devspace.chat_swarm_managed_carrier.v1";
const SLOT_RECEIPT_SCHEMA = "devspace.chat_swarm_managed_carrier_receipt.v1";
const PROVISION_SCHEMA = "devspace.chat_swarm_runtime_provision.v1";
const PROVISION_RECEIPT_SCHEMA = "devspace.chat_swarm_runtime_provision_receipt.v1";
const STOP_SCHEMA = "devspace.chat_swarm_runtime_stop.v1";
const STOP_RECEIPT_SCHEMA = "devspace.chat_swarm_runtime_stop_receipt.v1";
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_RUNTIME_WORKERS = 64;
const DEFAULT_RUNTIME_WORKERS = 3;
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;
const DEFAULT_BOOTSTRAP_WAIT_MS = 45_000;
const DEFAULT_PROVISION_STAGGER_MS = 8_000;
const MAX_RUNTIME_TIMEOUT_MS = 120_000;

type Row = Record<string, unknown>;

export type ChatSwarmRuntimeState =
  | "DISABLED"
  | "CONFIGURED_NOT_READY"
  | "READY"
  | "DEGRADED"
  | "RECONCILE_REQUIRED";

export type ManagedCarrierState =
  | "PROVISIONING"
  | "CARRIER_CREATED"
  | "BOOTSTRAPPING"
  | "SETUP_REQUIRED"
  | "SWARM_BOUND"
  | "PARKED"
  | "BUSY"
  | "STOPPING"
  | "RECONCILE_REQUIRED"
  | "STOPPED";

export interface ChatSwarmRuntimeConfig {
  enabled: boolean;
  stateDir: string;
  maxWorkers: number;
  poolDefault: number;
  projectUrl?: string;
  transport: "cdp" | "opencli";
  openCliExecutable: string;
  cdpEndpoint: string;
  browserExecutable?: string;
  browserProfileDir: string;
  appLabel: string;
  operationTimeoutMs: number;
  bootstrapWaitMs: number;
  provisionStaggerMs: number;
}

export interface ManagedCarrierSlot {
  managedCarrierId: string;
  swarmId: string;
  runtimeSlot: number;
  generation: number;
  state: ManagedCarrierState;
  projectUrl: string;
  browserProfileId: string;
  workerId?: string;
  conversationUrl?: string;
  conversationFingerprint?: string;
  authenticatedPeerFingerprint?: string;
  continuationEpoch?: number;
  lastOperationId?: string;
  blocker?: string;
  updatedAt: string;
}

interface SlotRequest {
  schema: typeof SLOT_SCHEMA;
  swarmId: string;
  runtimeSlot: number;
  projectUrl: string;
  browserProfileId: string;
}

interface SlotReceipt {
  schema: typeof SLOT_RECEIPT_SCHEMA;
  generation: number;
  state: ManagedCarrierState;
  workerId?: string;
  conversationUrl?: string;
  conversationFingerprint?: string;
  authenticatedPeerFingerprint?: string;
  continuationEpoch?: number;
  lastOperationId?: string;
  blocker?: string;
  updatedAt: string;
}

interface ProvisionRequest {
  schema: typeof PROVISION_SCHEMA;
  swarmId: string;
  runtimeSlot: number;
  generation: number;
  projectUrl: string;
  browserProfileId: string;
  requestedAt: string;
  expiresAt: string;
}

interface ProvisionReceipt {
  schema: typeof PROVISION_RECEIPT_SCHEMA;
  disposition:
    | "PREPARED"
    | "TRANSPORT_OBSERVED"
    | "CARRIER_CREATED"
    | "BOOTSTRAPPING"
    | "BOUND"
    | "SETUP_REQUIRED"
    | "UNKNOWN";
  conversationUrl?: string;
  conversationFingerprint?: string;
  authenticatedPeerFingerprint?: string;
  workerId?: string;
  remoteMayContinue: boolean;
  observedAt: string;
}

interface StopRequest {
  schema: typeof STOP_SCHEMA;
  swarmId: string;
  runtimeSlot: number;
  generation: number;
  workerId?: string;
  conversationFingerprint?: string;
  requestedAt: string;
}

interface StopReceipt {
  schema: typeof STOP_RECEIPT_SCHEMA;
  disposition: "PREPARED" | "STOPPED" | "UNKNOWN";
  remoteMayContinue: boolean;
  observedAt: string;
}

export interface RuntimeProvisionRecord {
  operationId: string;
  status: string;
  request: ProvisionRequest;
  receipt?: ProvisionReceipt;
}

export interface RuntimeStopRecord {
  operationId: string;
  status: string;
  request: StopRequest;
  receipt?: StopReceipt;
}

export interface RuntimePreflight {
  ready: boolean;
  state: "READY" | "CONFIGURED_NOT_READY" | "SETUP_REQUIRED";
  controlMechanism: "CDP" | "OPENCLI";
  browserVersion?: string;
  appBinding: "READY" | "UNKNOWN" | "DISABLED" | "STALE";
  blocker?: string;
}

export interface RuntimeStatusResult {
  swarmId: string;
  state: ChatSwarmRuntimeState;
  enabled: boolean;
  desiredDefault: number;
  maxWorkers: number;
  adapter: {
    kind: "mac_web_chatgpt";
    controlMechanism: RuntimePreflight["controlMechanism"];
    projectConfigured: boolean;
    appBinding: RuntimePreflight["appBinding"];
    blocker?: string;
  };
  slots: ManagedCarrierSlot[];
}

export interface TransportConversationEvidence {
  conversationUrl: string;
  conversationFingerprint: string;
}

export interface ManagedConversationEvidence extends TransportConversationEvidence {
  authenticatedPeerFingerprint?: string;
  appBinding: "READY" | "UNKNOWN" | "DISABLED" | "STALE";
}

export interface ChatSwarmManagedCarrierAdapter extends ChatSwarmCarrierAdapter {
  readonly configHash?: string;
  preflight(): Promise<RuntimePreflight>;
  provision(input: {
    operationId: string;
    swarmId: string;
    runtimeSlot: number;
    projectUrl: string;
    deadlineAt: string;
  }): Promise<ManagedConversationEvidence>;
  bootstrap(input: {
    operationId: string;
    swarmId: string;
    runtimeSlot: number;
    conversationUrl: string;
    workerLabel: string;
    deadlineAt: string;
  }): Promise<{
    disposition: "DELIVERED" | "UNKNOWN" | "SETUP_REQUIRED";
    remoteMayContinue: boolean;
  }>;
  recover(slot: ManagedCarrierSlot): Promise<{ ready: boolean; blocker?: string }>;
  stop(slot: ManagedCarrierSlot): Promise<void>;
}

interface CdpTarget {
  id: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface MacWebDriver {
  preflight(): Promise<RuntimePreflight>;
  createManagedConversation(
    projectUrl: string,
    deadlineAt: string,
    onTransportObserved?: (evidence: TransportConversationEvidence) => void,
  ): Promise<ManagedConversationEvidence>;
  sendPrompt(
    conversationUrl: string,
    prompt: string,
    deadlineAt: string,
  ): Promise<{ delivered: boolean; remoteMayContinue: boolean; blocker?: string }>;
  recoverConversation(
    conversationUrl: string,
    deadlineAt: string,
  ): Promise<{ ready: boolean; blocker?: string }>;
  closeConversation(conversationUrl: string): Promise<void>;
}

function boolEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function boundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function requireChatGptUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "chatgpt.com" && url.hostname !== "www.chatgpt.com")
  ) {
    throw new Error("DEVSPACE_CHAT_SWARM_PROJECT_URL must be an https://chatgpt.com URL");
  }
  return url.toString();
}

export function loadChatSwarmRuntimeConfig(
  server: { stateDir: string; chatSwarmMaxWorkers: number },
  env: NodeJS.ProcessEnv = process.env,
): ChatSwarmRuntimeConfig {
  const maxWorkers = Math.min(server.chatSwarmMaxWorkers, MAX_RUNTIME_WORKERS);
  const poolDefault = boundedInt(
    env.DEVSPACE_CHAT_SWARM_POOL_DEFAULT,
    Math.min(DEFAULT_RUNTIME_WORKERS, maxWorkers),
    1,
    maxWorkers,
    "DEVSPACE_CHAT_SWARM_POOL_DEFAULT",
  );
  const transport = (env.DEVSPACE_CHAT_SWARM_TRANSPORT?.trim().toLowerCase() || "cdp");
  if (transport !== "cdp" && transport !== "opencli") {
    throw new Error("DEVSPACE_CHAT_SWARM_TRANSPORT must be cdp or opencli");
  }
  const openCliExecutable = env.DEVSPACE_CHAT_SWARM_OPENCLI_BIN?.trim() || "opencli";
  const cdpEndpoint = (
    env.DEVSPACE_CHAT_SWARM_CDP_ENDPOINT?.trim() || "http://127.0.0.1:9222"
  ).replace(/\/$/, "");
  const cdp = new URL(cdpEndpoint);
  if (!["http:", "https:"].includes(cdp.protocol)) {
    throw new Error("DEVSPACE_CHAT_SWARM_CDP_ENDPOINT must be http(s)");
  }
  const appLabel = env.DEVSPACE_CHAT_SWARM_APP_LABEL?.trim() || "dev";
  if (appLabel.length > 128) {
    throw new Error("DEVSPACE_CHAT_SWARM_APP_LABEL exceeds 128 characters");
  }
  return {
    enabled: boolEnv(env.DEVSPACE_CHAT_SWARM_RUNTIME),
    stateDir: server.stateDir,
    maxWorkers,
    poolDefault,
    projectUrl: requireChatGptUrl(env.DEVSPACE_CHAT_SWARM_PROJECT_URL),
    transport,
    openCliExecutable,
    cdpEndpoint,
    browserExecutable: env.DEVSPACE_CHAT_SWARM_BROWSER_BIN?.trim() || undefined,
    browserProfileDir: resolve(
      env.DEVSPACE_CHAT_SWARM_BROWSER_PROFILE_DIR?.trim() ||
        join(homedir(), ".devspace", "chat-swarm-browser"),
    ),
    appLabel,
    operationTimeoutMs: boundedInt(
      env.DEVSPACE_CHAT_SWARM_RUNTIME_TIMEOUT_MS,
      DEFAULT_OPERATION_TIMEOUT_MS,
      1_000,
      MAX_RUNTIME_TIMEOUT_MS,
      "DEVSPACE_CHAT_SWARM_RUNTIME_TIMEOUT_MS",
    ),
    bootstrapWaitMs: boundedInt(
      env.DEVSPACE_CHAT_SWARM_BOOTSTRAP_WAIT_MS,
      DEFAULT_BOOTSTRAP_WAIT_MS,
      1_000,
      MAX_RUNTIME_TIMEOUT_MS,
      "DEVSPACE_CHAT_SWARM_BOOTSTRAP_WAIT_MS",
    ),
    provisionStaggerMs: boundedInt(
      env.DEVSPACE_CHAT_SWARM_PROVISION_STAGGER_MS,
      DEFAULT_PROVISION_STAGGER_MS,
      0,
      MAX_RUNTIME_TIMEOUT_MS,
      "DEVSPACE_CHAT_SWARM_PROVISION_STAGGER_MS",
    ),
  };
}

function canonicalHash(value: unknown): string {
  return hashContent(JSON.stringify(canonicalize(value)));
}
function nowIso(): string { return new Date().toISOString(); }
function profileId(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex");
}
function runtimeProvisionLeaseMs(config: ChatSwarmRuntimeConfig): number {
  return config.operationTimeoutMs * 2 + config.bootstrapWaitMs;
}
function slotAttemptKey(swarmId: string, runtimeSlot: number): string {
  return `chat-swarm-runtime-slot:${swarmId}:${runtimeSlot}`;
}
function provisionAttemptKey(
  swarmId: string,
  runtimeSlot: number,
  generation: number,
): string {
  return `chat-swarm-runtime-provision:${swarmId}:${runtimeSlot}:${generation}`;
}
function stopAttemptKey(
  swarmId: string,
  runtimeSlot: number,
  generation: number,
): string {
  return `chat-swarm-runtime-stop:${swarmId}:${runtimeSlot}:${generation}`;
}
function parseJson<T>(value: unknown, label: string): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    throw new ChatSwarmError("INVALID_STATE", `corrupt ${label}`);
  }
}
function assertFingerprint(value: string, label: string): void {
  if (!SHA256.test(value)) {
    throw new ChatSwarmError("INVALID_STATE", `${label} is not a SHA-256 fingerprint`);
  }
}

export class ChatSwarmRuntimeStore {
  private readonly database: DatabaseHandle;
  private readonly scopeRoot: string;
  private closed = false;

  constructor(readonly stateDir: string) {
    this.database = openDatabase(stateDir);
    this.scopeRoot = resolve(stateDir);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  listSlots(swarmId: string): ManagedCarrierSlot[] {
    const rows = this.database.sqlite
      .prepare("select * from durable_operations where kind=? and scope_root=? order by created_at asc")
      .all(SLOT_KIND, this.scopeRoot) as Row[];
    return rows
      .map((row) => this.slotFrom(row))
      .filter((slot) => slot.swarmId === swarmId)
      .sort((a, b) => a.runtimeSlot - b.runtimeSlot);
  }

  getSlot(swarmId: string, runtimeSlot: number): ManagedCarrierSlot | undefined {
    const row = this.database.sqlite
      .prepare("select * from durable_operations where kind=? and scope_root=? and attempt_key=?")
      .get(SLOT_KIND, this.scopeRoot, slotAttemptKey(swarmId, runtimeSlot)) as Row | undefined;
    return row ? this.slotFrom(row) : undefined;
  }

  getSlotByWorker(swarmId: string, workerId: string): ManagedCarrierSlot | undefined {
    return this.listSlots(swarmId).find(
      (slot) => slot.workerId === workerId && slot.state !== "STOPPED",
    );
  }

  getSlotByFingerprint(fingerprint: string): ManagedCarrierSlot | undefined {
    const rows = this.database.sqlite
      .prepare("select * from durable_operations where kind=? and scope_root=?")
      .all(SLOT_KIND, this.scopeRoot) as Row[];
    for (const row of rows) {
      const slot = this.slotFrom(row);
      if (
        slot.conversationFingerprint === fingerprint &&
        slot.state !== "STOPPED"
      ) return slot;
    }
    return undefined;
  }

  getSlotByAuthenticatedPeerFingerprint(
    fingerprint: string,
  ): ManagedCarrierSlot | undefined {
    const rows = this.database.sqlite
      .prepare("select * from durable_operations where kind=? and scope_root=?")
      .all(SLOT_KIND, this.scopeRoot) as Row[];
    for (const row of rows) {
      const slot = this.slotFrom(row);
      if (
        slot.authenticatedPeerFingerprint === fingerprint &&
        slot.state !== "STOPPED"
      ) return slot;
    }
    return undefined;
  }

  ensureSlot(
    swarmId: string,
    runtimeSlot: number,
    projectUrl: string,
    browserProfileId: string,
  ): ManagedCarrierSlot {
    if (
      !Number.isSafeInteger(runtimeSlot) ||
      runtimeSlot < 1 ||
      runtimeSlot > MAX_RUNTIME_WORKERS
    ) {
      throw new ChatSwarmError("INVALID_INPUT", "runtimeSlot is out of range");
    }
    const tx = this.database.sqlite.transaction(() => {
      const existing = this.getSlot(swarmId, runtimeSlot);
      if (existing) {
        if (
          existing.projectUrl !== projectUrl ||
          existing.browserProfileId !== browserProfileId
        ) {
          throw new ChatSwarmError(
            "REPLAY_CONFLICT",
            "managed runtime slot is bound to different carrier config",
          );
        }
        return existing;
      }
      const request: SlotRequest = {
        schema: SLOT_SCHEMA,
        swarmId,
        runtimeSlot,
        projectUrl,
        browserProfileId,
      };
      const receipt: SlotReceipt = {
        schema: SLOT_RECEIPT_SCHEMA,
        generation: 0,
        state: "STOPPED",
        updatedAt: nowIso(),
      };
      const operationId = `managed_carrier_${randomUUID().replaceAll("-", "")}`;
      this.database.sqlite.prepare(`
        insert into durable_operations (
          operation_id,attempt_key,request_hash,kind,authority_mode,scope_root,
          workspace_id,status,retry_safe,request_json,receipt_json,error_code,
          error_message,created_at,updated_at
        ) values (?,?,?,?,?,?,null,'cancelled','false',?,?,null,null,?,?)
      `).run(
        operationId,
        slotAttemptKey(swarmId, runtimeSlot),
        canonicalHash(request),
        SLOT_KIND,
        "OWNER_DIRECT",
        this.scopeRoot,
        JSON.stringify(request),
        JSON.stringify(receipt),
        receipt.updatedAt,
        receipt.updatedAt,
      );
      return this.getSlot(swarmId, runtimeSlot)!;
    });
    return tx.immediate();
  }

  prepareProvision(
    slot: ManagedCarrierSlot,
    ttlMs: number,
  ): { slot: ManagedCarrierSlot; operation?: RuntimeProvisionRecord; created: boolean } {
    const tx = this.database.sqlite.transaction(() => {
      const current = this.getSlot(slot.swarmId, slot.runtimeSlot);
      if (!current) {
        throw new ChatSwarmError("NOT_FOUND", "managed carrier slot disappeared");
      }
      if (["SWARM_BOUND", "PARKED", "BUSY"].includes(current.state) && current.workerId) {
        return { slot: current, created: false };
      }
      if (
        current.lastOperationId &&
        [
          "PROVISIONING",
          "CARRIER_CREATED",
          "BOOTSTRAPPING",
          "SETUP_REQUIRED",
          "RECONCILE_REQUIRED",
        ].includes(current.state)
      ) {
        const operation = this.getProvision(current.lastOperationId);
        if (!operation) {
          throw new ChatSwarmError(
            "INVALID_STATE",
            "managed carrier references missing provision operation",
          );
        }
        return { slot: current, operation, created: false };
      }

      const generation = current.generation + 1;
      const requestedAt = nowIso();
      const request: ProvisionRequest = {
        schema: PROVISION_SCHEMA,
        swarmId: current.swarmId,
        runtimeSlot: current.runtimeSlot,
        generation,
        projectUrl: current.projectUrl,
        browserProfileId: current.browserProfileId,
        requestedAt,
        expiresAt: new Date(Date.parse(requestedAt) + ttlMs).toISOString(),
      };
      const operationId = `runtime_provision_${randomUUID().replaceAll("-", "")}`;
      const receipt: ProvisionReceipt = {
        schema: PROVISION_RECEIPT_SCHEMA,
        disposition: "PREPARED",
        remoteMayContinue: false,
        observedAt: requestedAt,
      };
      this.database.sqlite.prepare(`
        insert into durable_operations (
          operation_id,attempt_key,request_hash,kind,authority_mode,scope_root,
          workspace_id,status,retry_safe,request_json,receipt_json,error_code,
          error_message,created_at,updated_at
        ) values (?,?,?,?,?,?,null,'prepared','false',?,?,null,null,?,?)
      `).run(
        operationId,
        provisionAttemptKey(current.swarmId, current.runtimeSlot, generation),
        canonicalHash(request),
        PROVISION_KIND,
        "OWNER_DIRECT",
        this.scopeRoot,
        JSON.stringify(request),
        JSON.stringify(receipt),
        requestedAt,
        requestedAt,
      );
      this.updateSlotReceipt(
        current,
        {
          schema: SLOT_RECEIPT_SCHEMA,
          generation,
          state: "PROVISIONING",
          lastOperationId: operationId,
          updatedAt: requestedAt,
        },
        "started",
      );
      return {
        slot: this.getSlot(current.swarmId, current.runtimeSlot)!,
        operation: this.getProvision(operationId)!,
        created: true,
      };
    });
    return tx.immediate();
  }

  getProvision(operationId: string): RuntimeProvisionRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from durable_operations where operation_id=? and kind=? and scope_root=?")
      .get(operationId, PROVISION_KIND, this.scopeRoot) as Row | undefined;
    if (!row) return undefined;
    const request = parseJson<ProvisionRequest>(row.request_json, "runtime provision request");
    if (
      request.schema !== PROVISION_SCHEMA ||
      canonicalHash(request) !== String(row.request_hash)
    ) {
      throw new ChatSwarmError(
        "INVALID_STATE",
        "runtime provision request integrity mismatch",
      );
    }
    const receipt = row.receipt_json == null
      ? undefined
      : parseJson<ProvisionReceipt>(row.receipt_json, "runtime provision receipt");
    if (receipt && receipt.schema !== PROVISION_RECEIPT_SCHEMA) {
      throw new ChatSwarmError(
        "INVALID_STATE",
        "runtime provision receipt schema mismatch",
      );
    }
    return {
      operationId: String(row.operation_id),
      status: String(row.status),
      request,
      receipt,
    };
  }

  claimProvision(operationId: string): boolean {
    const result = this.database.sqlite
      .prepare("update durable_operations set status='started',updated_at=? where operation_id=? and kind=? and scope_root=? and status='prepared'")
      .run(nowIso(), operationId, PROVISION_KIND, this.scopeRoot);
    return result.changes === 1;
  }

  markTransportObserved(
    operationId: string,
    evidence: TransportConversationEvidence,
  ): ManagedCarrierSlot {
    assertFingerprint(evidence.conversationFingerprint, "conversation fingerprint");
    const tx = this.database.sqlite.transaction(() => {
      const operation = this.requireProvision(operationId);
      if (operation.status === "outcome_unknown") {
        throw new ChatSwarmError(
          "RECONCILIATION_REQUIRED",
          "provision outcome is unknown; do not create another carrier",
        );
      }
      if (operation.status !== "started") {
        if (
          operation.receipt?.conversationFingerprint === evidence.conversationFingerprint &&
          operation.receipt?.conversationUrl === evidence.conversationUrl
        ) {
          return this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
        }
        throw new ChatSwarmError("INVALID_STATE", "provision operation is not active");
      }
      const conflicting = this.getSlotByFingerprint(evidence.conversationFingerprint);
      if (
        conflicting &&
        (conflicting.swarmId !== operation.request.swarmId ||
          conflicting.runtimeSlot !== operation.request.runtimeSlot)
      ) {
        throw new ChatSwarmError(
          "OWNERSHIP_CONFLICT",
          "conversation is already managed by another runtime slot",
        );
      }
      const observedAt = nowIso();
      const receipt: ProvisionReceipt = {
        schema: PROVISION_RECEIPT_SCHEMA,
        disposition: "TRANSPORT_OBSERVED",
        conversationUrl: evidence.conversationUrl,
        conversationFingerprint: evidence.conversationFingerprint,
        remoteMayContinue: true,
        observedAt,
      };
      this.updateProvision(operationId, "started", receipt);
      const slot = this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
      this.updateSlotReceipt(
        slot,
        {
          schema: SLOT_RECEIPT_SCHEMA,
          generation: operation.request.generation,
          state: "PROVISIONING",
          conversationUrl: evidence.conversationUrl,
          conversationFingerprint: evidence.conversationFingerprint,
          lastOperationId: operationId,
          updatedAt: observedAt,
        },
        "started",
      );
      return this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
    });
    return tx.immediate();
  }

  markCarrierCreated(
    operationId: string,
    evidence: ManagedConversationEvidence,
  ): ManagedCarrierSlot {
    assertFingerprint(evidence.conversationFingerprint, "conversation fingerprint");
    if (evidence.authenticatedPeerFingerprint) {
      assertFingerprint(
        evidence.authenticatedPeerFingerprint,
        "authenticated peer fingerprint",
      );
    }
    const tx = this.database.sqlite.transaction(() => {
      const operation = this.requireProvision(operationId);
      if (operation.status === "succeeded" && operation.receipt?.workerId) {
        return this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
      }
      if (operation.status === "outcome_unknown") {
        throw new ChatSwarmError(
          "RECONCILIATION_REQUIRED",
          "provision outcome is unknown; do not create another carrier",
        );
      }
      if (operation.status !== "started") {
        throw new ChatSwarmError("INVALID_STATE", "provision operation is not active");
      }
      const conflicting = this.getSlotByFingerprint(evidence.conversationFingerprint);
      if (
        conflicting &&
        (conflicting.swarmId !== operation.request.swarmId ||
          conflicting.runtimeSlot !== operation.request.runtimeSlot)
      ) {
        throw new ChatSwarmError(
          "OWNERSHIP_CONFLICT",
          "conversation is already managed by another runtime slot",
        );
      }
      const peerConflict = evidence.authenticatedPeerFingerprint
        ? this.getSlotByAuthenticatedPeerFingerprint(
            evidence.authenticatedPeerFingerprint,
          )
        : undefined;
      if (
        peerConflict &&
        (peerConflict.swarmId !== operation.request.swarmId ||
          peerConflict.runtimeSlot !== operation.request.runtimeSlot)
      ) {
        throw new ChatSwarmError(
          "OWNERSHIP_CONFLICT",
          "authenticated peer is already managed by another runtime slot",
        );
      }
      const observedAt = nowIso();
      const setupRequired =
        evidence.appBinding === "DISABLED" || evidence.appBinding === "STALE";
      const receipt: ProvisionReceipt = {
        schema: PROVISION_RECEIPT_SCHEMA,
        disposition: setupRequired ? "SETUP_REQUIRED" : "CARRIER_CREATED",
        conversationUrl: evidence.conversationUrl,
        conversationFingerprint: evidence.conversationFingerprint,
        authenticatedPeerFingerprint: evidence.authenticatedPeerFingerprint,
        remoteMayContinue: false,
        observedAt,
      };
      this.updateProvision(
        operationId,
        setupRequired ? "outcome_unknown" : "carrier_created",
        receipt,
        setupRequired ? "HOST_APP_BINDING_SETUP_REQUIRED" : undefined,
        setupRequired ? `HOST_APP_BINDING_${evidence.appBinding}` : undefined,
      );
      const slot = this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
      this.updateSlotReceipt(
        slot,
        {
          schema: SLOT_RECEIPT_SCHEMA,
          generation: operation.request.generation,
          state: setupRequired ? "SETUP_REQUIRED" : "CARRIER_CREATED",
          conversationUrl: evidence.conversationUrl,
          conversationFingerprint: evidence.conversationFingerprint,
          authenticatedPeerFingerprint: evidence.authenticatedPeerFingerprint,
          lastOperationId: operationId,
          ...(setupRequired
            ? { blocker: `HOST_APP_BINDING_${evidence.appBinding}` }
            : {}),
          updatedAt: observedAt,
        },
        setupRequired ? "outcome_unknown" : "started",
      );
      return this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
    });
    return tx.immediate();
  }

  claimBootstrap(operationId: string): boolean {
    const observedAt = nowIso();
    const tx = this.database.sqlite.transaction(() => {
      const operation = this.requireProvision(operationId);
      if (operation.status !== "carrier_created") return false;
      const receipt: ProvisionReceipt = {
        schema: PROVISION_RECEIPT_SCHEMA,
        disposition: "BOOTSTRAPPING",
        conversationUrl: operation.receipt?.conversationUrl,
        conversationFingerprint: operation.receipt?.conversationFingerprint,
        authenticatedPeerFingerprint:
          operation.receipt?.authenticatedPeerFingerprint,
        remoteMayContinue: true,
        observedAt,
      };
      const updated = this.database.sqlite
        .prepare("update durable_operations set status='bootstrapping',receipt_json=?,updated_at=? where operation_id=? and kind=? and scope_root=? and status='carrier_created'")
        .run(
          JSON.stringify(receipt),
          observedAt,
          operationId,
          PROVISION_KIND,
          this.scopeRoot,
        );
      if (updated.changes !== 1) return false;
      const slot = this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
      this.updateSlotReceipt(
        slot,
        {
          schema: SLOT_RECEIPT_SCHEMA,
          generation: operation.request.generation,
          state: "BOOTSTRAPPING",
          conversationUrl: operation.receipt?.conversationUrl,
          conversationFingerprint: operation.receipt?.conversationFingerprint,
          authenticatedPeerFingerprint:
            operation.receipt?.authenticatedPeerFingerprint,
          lastOperationId: operationId,
          updatedAt: observedAt,
        },
        "started",
      );
      return true;
    });
    return tx.immediate();
  }

  markProvisionUnknown(operationId: string, blocker: string): ManagedCarrierSlot {
    const tx = this.database.sqlite.transaction(() => {
      const operation = this.requireProvision(operationId);
      if (operation.status === "succeeded") {
        return this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
      }
      const observedAt = nowIso();
      const receipt: ProvisionReceipt = {
        schema: PROVISION_RECEIPT_SCHEMA,
        disposition: "UNKNOWN",
        conversationUrl: operation.receipt?.conversationUrl,
        conversationFingerprint: operation.receipt?.conversationFingerprint,
        authenticatedPeerFingerprint:
          operation.receipt?.authenticatedPeerFingerprint,
        workerId: operation.receipt?.workerId,
        remoteMayContinue: true,
        observedAt,
      };
      this.updateProvision(
        operationId,
        "outcome_unknown",
        receipt,
        "RUNTIME_RECONCILIATION_REQUIRED",
        blocker,
      );
      const slot = this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
      this.updateSlotReceipt(
        slot,
        {
          schema: SLOT_RECEIPT_SCHEMA,
          generation: operation.request.generation,
          state: "RECONCILE_REQUIRED",
          workerId: slot.workerId,
          conversationUrl: operation.receipt?.conversationUrl,
          conversationFingerprint: operation.receipt?.conversationFingerprint,
          authenticatedPeerFingerprint:
            operation.receipt?.authenticatedPeerFingerprint,
          continuationEpoch: slot.continuationEpoch,
          lastOperationId: operationId,
          blocker,
          updatedAt: observedAt,
        },
        "outcome_unknown",
      );
      return this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
    });
    return tx.immediate();
  }

  bindWorker(operationId: string, worker: ChatSwarmWorker): ManagedCarrierSlot {
    const tx = this.database.sqlite.transaction(() => {
      const operation = this.requireProvision(operationId);
      if (operation.status === "succeeded" && operation.receipt?.workerId) {
        if (operation.receipt.workerId !== worker.id) {
          throw new ChatSwarmError(
            "OWNERSHIP_CONFLICT",
            "provision operation is already bound to another worker",
          );
        }
        return this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
      }
      if (!operation.receipt?.conversationFingerprint) {
        throw new ChatSwarmError(
          "INVALID_STATE",
          "carrier identity is not established",
        );
      }
      const expectedPeerFingerprint =
        operation.receipt.authenticatedPeerFingerprint ??
        operation.receipt.conversationFingerprint;
      if (
        !["carrier_created", "bootstrapping"].includes(operation.status) ||
        worker.swarmId !== operation.request.swarmId ||
        worker.carrierConversationFingerprint !== expectedPeerFingerprint
      ) {
        throw new ChatSwarmError(
          "OWNERSHIP_CONFLICT",
          "worker does not match managed provision identity",
        );
      }
      const observedAt = nowIso();
      const receipt: ProvisionReceipt = {
        schema: PROVISION_RECEIPT_SCHEMA,
        disposition: "BOUND",
        conversationUrl: operation.receipt.conversationUrl,
        conversationFingerprint: operation.receipt.conversationFingerprint,
        authenticatedPeerFingerprint:
          operation.receipt.authenticatedPeerFingerprint,
        workerId: worker.id,
        remoteMayContinue: false,
        observedAt,
      };
      this.updateProvision(operationId, "succeeded", receipt);
      const slot = this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
      this.updateSlotReceipt(
        slot,
        {
          schema: SLOT_RECEIPT_SCHEMA,
          generation: operation.request.generation,
          state: "PARKED",
          workerId: worker.id,
          conversationUrl: operation.receipt.conversationUrl,
          conversationFingerprint: operation.receipt.conversationFingerprint,
          authenticatedPeerFingerprint:
            operation.receipt.authenticatedPeerFingerprint,
          continuationEpoch: worker.continuationEpoch,
          lastOperationId: operationId,
          updatedAt: observedAt,
        },
        "succeeded",
      );
      return this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
    });
    return tx.immediate();
  }

  markRecovered(slot: ManagedCarrierSlot): ManagedCarrierSlot {
    const current = this.getSlot(slot.swarmId, slot.runtimeSlot);
    if (!current) throw new ChatSwarmError("NOT_FOUND", "managed carrier slot not found");
    const receipt: SlotReceipt = {
      schema: SLOT_RECEIPT_SCHEMA,
      generation: current.generation,
      state: current.workerId ? "PARKED" : "CARRIER_CREATED",
      workerId: current.workerId,
      conversationUrl: current.conversationUrl,
      conversationFingerprint: current.conversationFingerprint,
      authenticatedPeerFingerprint: current.authenticatedPeerFingerprint,
      continuationEpoch: current.continuationEpoch,
      lastOperationId: current.lastOperationId,
      updatedAt: nowIso(),
    };
    this.updateSlotReceipt(current, receipt, current.workerId ? "succeeded" : "started");
    return this.getSlot(slot.swarmId, slot.runtimeSlot)!;
  }

  prepareStop(slot: ManagedCarrierSlot): {
    slot: ManagedCarrierSlot;
    operation?: RuntimeStopRecord;
    claimed: boolean;
  } {
    const tx = this.database.sqlite.transaction(() => {
      const current = this.getSlot(slot.swarmId, slot.runtimeSlot);
      if (!current) throw new ChatSwarmError("NOT_FOUND", "managed carrier slot not found");
      if (current.state === "STOPPED") return { slot: current, claimed: false };
      if (current.state === "RECONCILE_REQUIRED" || current.state === "STOPPING") {
        const operation = current.lastOperationId
          ? this.getStop(current.lastOperationId)
          : undefined;
        return { slot: current, operation, claimed: false };
      }
      this.assertWorkerRetirable(current);
      const requestedAt = nowIso();
      const request: StopRequest = {
        schema: STOP_SCHEMA,
        swarmId: current.swarmId,
        runtimeSlot: current.runtimeSlot,
        generation: current.generation,
        workerId: current.workerId,
        conversationFingerprint: current.conversationFingerprint,
        requestedAt,
      };
      const operationId = `runtime_stop_${randomUUID().replaceAll("-", "")}`;
      const receipt: StopReceipt = {
        schema: STOP_RECEIPT_SCHEMA,
        disposition: "PREPARED",
        remoteMayContinue: false,
        observedAt: requestedAt,
      };
      this.database.sqlite.prepare(`
        insert into durable_operations (
          operation_id,attempt_key,request_hash,kind,authority_mode,scope_root,
          workspace_id,status,retry_safe,request_json,receipt_json,error_code,
          error_message,created_at,updated_at
        ) values (?,?,?,?,?,?,null,'prepared','false',?,?,null,null,?,?)
      `).run(
        operationId,
        stopAttemptKey(current.swarmId, current.runtimeSlot, current.generation),
        canonicalHash(request),
        STOP_KIND,
        "OWNER_DIRECT",
        this.scopeRoot,
        JSON.stringify(request),
        JSON.stringify(receipt),
        requestedAt,
        requestedAt,
      );
      if (current.workerId) {
        const disabled = this.database.sqlite
          .prepare("update chat_swarm_workers set lifecycle_state='DISABLED',updated_at=? where id=? and swarm_id=? and lifecycle_state='AVAILABLE' and current_task_id is null")
          .run(requestedAt, current.workerId, current.swarmId);
        if (disabled.changes !== 1) {
          throw new ChatSwarmError("CAS_DRIFT", "worker changed while preparing scale-down");
        }
      }
      this.updateSlotReceipt(
        current,
        {
          schema: SLOT_RECEIPT_SCHEMA,
          generation: current.generation,
          state: "STOPPING",
          workerId: current.workerId,
          conversationUrl: current.conversationUrl,
          conversationFingerprint: current.conversationFingerprint,
          authenticatedPeerFingerprint: current.authenticatedPeerFingerprint,
          continuationEpoch: current.continuationEpoch,
          lastOperationId: operationId,
          updatedAt: requestedAt,
        },
        "started",
      );
      const claimed = this.database.sqlite
        .prepare("update durable_operations set status='started',updated_at=? where operation_id=? and kind=? and scope_root=? and status='prepared'")
        .run(requestedAt, operationId, STOP_KIND, this.scopeRoot).changes === 1;
      return {
        slot: this.getSlot(current.swarmId, current.runtimeSlot)!,
        operation: this.getStop(operationId)!,
        claimed,
      };
    });
    return tx.immediate();
  }

  getStop(operationId: string): RuntimeStopRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from durable_operations where operation_id=? and kind=? and scope_root=?")
      .get(operationId, STOP_KIND, this.scopeRoot) as Row | undefined;
    if (!row) return undefined;
    const request = parseJson<StopRequest>(row.request_json, "runtime stop request");
    if (request.schema !== STOP_SCHEMA || canonicalHash(request) !== String(row.request_hash)) {
      throw new ChatSwarmError("INVALID_STATE", "runtime stop request integrity mismatch");
    }
    const receipt = row.receipt_json == null
      ? undefined
      : parseJson<StopReceipt>(row.receipt_json, "runtime stop receipt");
    if (receipt && receipt.schema !== STOP_RECEIPT_SCHEMA) {
      throw new ChatSwarmError("INVALID_STATE", "runtime stop receipt schema mismatch");
    }
    return { operationId: String(row.operation_id), status: String(row.status), request, receipt };
  }

  completeStop(operationId: string): ManagedCarrierSlot {
    const tx = this.database.sqlite.transaction(() => {
      const operation = this.requireStop(operationId);
      if (operation.status === "succeeded") {
        return this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
      }
      if (operation.status !== "started") {
        throw new ChatSwarmError("INVALID_STATE", "runtime stop is not active");
      }
      const observedAt = nowIso();
      const receipt: StopReceipt = {
        schema: STOP_RECEIPT_SCHEMA,
        disposition: "STOPPED",
        remoteMayContinue: false,
        observedAt,
      };
      this.updateStop(operationId, "succeeded", receipt);
      const slot = this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
      this.updateSlotReceipt(
        slot,
        {
          schema: SLOT_RECEIPT_SCHEMA,
          generation: operation.request.generation,
          state: "STOPPED",
          lastOperationId: operationId,
          updatedAt: observedAt,
        },
        "cancelled",
      );
      return this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
    });
    return tx.immediate();
  }

  markStopUnknown(operationId: string, blocker: string): ManagedCarrierSlot {
    const tx = this.database.sqlite.transaction(() => {
      const operation = this.requireStop(operationId);
      if (operation.status === "succeeded") {
        return this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
      }
      const observedAt = nowIso();
      const receipt: StopReceipt = {
        schema: STOP_RECEIPT_SCHEMA,
        disposition: "UNKNOWN",
        remoteMayContinue: true,
        observedAt,
      };
      this.updateStop(
        operationId,
        "outcome_unknown",
        receipt,
        "RUNTIME_RECONCILIATION_REQUIRED",
        blocker,
      );
      const slot = this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
      this.updateSlotReceipt(
        slot,
        {
          schema: SLOT_RECEIPT_SCHEMA,
          generation: operation.request.generation,
          state: "RECONCILE_REQUIRED",
          workerId: slot.workerId,
          conversationUrl: slot.conversationUrl,
          conversationFingerprint: slot.conversationFingerprint,
          authenticatedPeerFingerprint: slot.authenticatedPeerFingerprint,
          continuationEpoch: slot.continuationEpoch,
          lastOperationId: operationId,
          blocker,
          updatedAt: observedAt,
        },
        "outcome_unknown",
      );
      return this.getSlot(operation.request.swarmId, operation.request.runtimeSlot)!;
    });
    return tx.immediate();
  }

  waitForBound(
    swarmId: string,
    runtimeSlot: number,
    timeoutMs: number,
  ): Promise<ManagedCarrierSlot> {
    return new Promise((resolvePromise, rejectPromise) => {
      const started = Date.now();
      const poll = () => {
        try {
          const slot = this.getSlot(swarmId, runtimeSlot);
          if (!slot) {
            rejectPromise(new ChatSwarmError("NOT_FOUND", "managed carrier slot disappeared"));
            return;
          }
          if ((slot.state === "PARKED" || slot.state === "SWARM_BOUND") && slot.workerId) {
            resolvePromise(slot);
            return;
          }
          if (slot.state === "RECONCILE_REQUIRED" || slot.state === "SETUP_REQUIRED") {
            rejectPromise(
              new ChatSwarmError(
                "RECONCILIATION_REQUIRED",
                slot.blocker ?? slot.state,
              ),
            );
            return;
          }
          if (Date.now() - started >= timeoutMs) {
            rejectPromise(
              new ChatSwarmError(
                "TRANSPORT_UNKNOWN",
                "managed worker bootstrap acknowledgement timed out",
              ),
            );
            return;
          }
          setTimeout(poll, 200);
        } catch (error) {
          rejectPromise(error);
        }
      };
      poll();
    });
  }

  private assertWorkerRetirable(slot: ManagedCarrierSlot): void {
    if (!slot.workerId) return;
    const worker = this.database.sqlite
      .prepare("select lifecycle_state,current_task_id from chat_swarm_workers where id=? and swarm_id=?")
      .get(slot.workerId, slot.swarmId) as
      | { lifecycle_state: string; current_task_id: string | null }
      | undefined;
    if (!worker) throw new ChatSwarmError("INVALID_STATE", "managed worker is missing");
    if (worker.lifecycle_state !== "AVAILABLE" || worker.current_task_id) {
      throw new ChatSwarmError("INVALID_STATE", "busy worker cannot be scaled down");
    }
    const queued = this.database.sqlite
      .prepare("select 1 from chat_swarm_tasks where preferred_worker_id=? and lifecycle_state='QUEUED' limit 1")
      .get(slot.workerId);
    if (queued) {
      throw new ChatSwarmError("INVALID_STATE", "targeted worker cannot be scaled down");
    }
    const carrierUnknown = this.database.sqlite
      .prepare("select 1 from chat_swarm_carrier_operations where worker_id=? and state='RECONCILE_REQUIRED' limit 1")
      .get(slot.workerId);
    if (carrierUnknown) {
      throw new ChatSwarmError(
        "RECONCILIATION_REQUIRED",
        "worker has unresolved carrier operation",
      );
    }
    const continuationRows = this.database.sqlite
      .prepare("select status,request_json from durable_operations where kind='chat_swarm_continuation' and status in ('started','outcome_unknown')")
      .all() as Row[];
    for (const row of continuationRows) {
      const request = parseJson<Record<string, unknown>>(
        row.request_json,
        "continuation request",
      );
      if (request.workerId === slot.workerId) {
        throw new ChatSwarmError(
          "RECONCILIATION_REQUIRED",
          "worker has unresolved continuation",
        );
      }
    }
  }

  private requireProvision(operationId: string): RuntimeProvisionRecord {
    const operation = this.getProvision(operationId);
    if (!operation) {
      throw new ChatSwarmError(
        "REQUEST_NOT_FOUND",
        "runtime provision operation not found",
      );
    }
    return operation;
  }

  private requireStop(operationId: string): RuntimeStopRecord {
    const operation = this.getStop(operationId);
    if (!operation) {
      throw new ChatSwarmError("REQUEST_NOT_FOUND", "runtime stop operation not found");
    }
    return operation;
  }

  private updateProvision(
    operationId: string,
    status: string,
    receipt: ProvisionReceipt,
    errorCode?: string,
    errorMessage?: string,
  ): void {
    this.database.sqlite
      .prepare("update durable_operations set status=?,receipt_json=?,error_code=?,error_message=?,updated_at=? where operation_id=? and kind=? and scope_root=?")
      .run(
        status,
        JSON.stringify(receipt),
        errorCode ?? null,
        errorMessage ?? null,
        receipt.observedAt,
        operationId,
        PROVISION_KIND,
        this.scopeRoot,
      );
  }

  private updateStop(
    operationId: string,
    status: string,
    receipt: StopReceipt,
    errorCode?: string,
    errorMessage?: string,
  ): void {
    this.database.sqlite
      .prepare("update durable_operations set status=?,receipt_json=?,error_code=?,error_message=?,updated_at=? where operation_id=? and kind=? and scope_root=?")
      .run(
        status,
        JSON.stringify(receipt),
        errorCode ?? null,
        errorMessage ?? null,
        receipt.observedAt,
        operationId,
        STOP_KIND,
        this.scopeRoot,
      );
  }

  private updateSlotReceipt(
    slot: ManagedCarrierSlot,
    receipt: SlotReceipt,
    status: string,
  ): void {
    this.database.sqlite
      .prepare("update durable_operations set status=?,receipt_json=?,updated_at=? where operation_id=? and kind=? and scope_root=?")
      .run(
        status,
        JSON.stringify(receipt),
        receipt.updatedAt,
        slot.managedCarrierId,
        SLOT_KIND,
        this.scopeRoot,
      );
  }

  private slotFrom(row: Row): ManagedCarrierSlot {
    const request = parseJson<SlotRequest>(row.request_json, "managed carrier request");
    const receipt = parseJson<SlotReceipt>(row.receipt_json, "managed carrier receipt");
    if (
      request.schema !== SLOT_SCHEMA ||
      receipt.schema !== SLOT_RECEIPT_SCHEMA ||
      canonicalHash(request) !== String(row.request_hash)
    ) {
      throw new ChatSwarmError(
        "INVALID_STATE",
        "managed carrier registry integrity mismatch",
      );
    }
    if (
      !Number.isSafeInteger(request.runtimeSlot) ||
      request.runtimeSlot < 1 ||
      !Number.isSafeInteger(receipt.generation) ||
      receipt.generation < 0
    ) {
      throw new ChatSwarmError(
        "INVALID_STATE",
        "managed carrier registry numeric identity is corrupt",
      );
    }
    if (receipt.conversationFingerprint) {
      assertFingerprint(receipt.conversationFingerprint, "managed carrier fingerprint");
    }
    if (receipt.authenticatedPeerFingerprint) {
      assertFingerprint(
        receipt.authenticatedPeerFingerprint,
        "managed carrier authenticated peer fingerprint",
      );
    }
    return {
      managedCarrierId: String(row.operation_id),
      swarmId: request.swarmId,
      runtimeSlot: request.runtimeSlot,
      generation: receipt.generation,
      state: receipt.state,
      projectUrl: request.projectUrl,
      browserProfileId: request.browserProfileId,
      workerId: receipt.workerId,
      conversationUrl: receipt.conversationUrl,
      conversationFingerprint: receipt.conversationFingerprint,
      authenticatedPeerFingerprint: receipt.authenticatedPeerFingerprint,
      continuationEpoch: receipt.continuationEpoch,
      lastOperationId: receipt.lastOperationId,
      blocker: receipt.blocker,
      updatedAt: receipt.updatedAt,
    };
  }
}

function openCliProjectId(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "chatgpt.com" && url.hostname !== "www.chatgpt.com")
  ) {
    throw new ChatSwarmError("INVALID_INPUT", "OpenCLI project must be on chatgpt.com");
  }
  const match = url.pathname.match(/\/g\/g-p-([^/]+)/);
  if (!match?.[1]) {
    throw new ChatSwarmError(
      "IDENTITY_MISSING",
      "ChatGPT project URL does not expose a project identity",
    );
  }
  return decodeURIComponent(match[1]);
}

interface OpenCliConversationRow {
  conversationId?: string;
  conversationUrl?: string;
  response?: string;
}

interface OpenCliStatusRow {
  Status?: string;
  Login?: string;
  Url?: string;
}

interface OpenCliDetailRow {
  Role?: string;
  Text?: string;
  Generating?: boolean;
}

export class OpenCliMacWebDriver implements MacWebDriver {
  constructor(private readonly config: ChatSwarmRuntimeConfig) {}

  async preflight(): Promise<RuntimePreflight> {
    if (process.platform !== "darwin") {
      return {
        ready: false,
        state: "CONFIGURED_NOT_READY",
        controlMechanism: "OPENCLI",
        appBinding: "UNKNOWN",
        blocker: "MACOS_REQUIRED",
      };
    }
    if (!this.config.projectUrl) {
      return {
        ready: false,
        state: "CONFIGURED_NOT_READY",
        controlMechanism: "OPENCLI",
        appBinding: "UNKNOWN",
        blocker: "PROJECT_URL_REQUIRED",
      };
    }
    try {
      const rows = await this.runJson<OpenCliStatusRow[]>(
        ["chatgpt", "status", "--site-session", "ephemeral", "-f", "json"],
        new Date(Date.now() + this.config.operationTimeoutMs).toISOString(),
      );
      const status = rows[0];
      const ready = status?.Status === "Connected" && status?.Login === "Yes";
      return {
        ready,
        state: ready ? "READY" : "CONFIGURED_NOT_READY",
        controlMechanism: "OPENCLI",
        appBinding: "UNKNOWN",
        blocker: ready
          ? undefined
          : `OPENCLI_CHATGPT_NOT_READY:${status?.Status ?? "UNKNOWN"}:${status?.Login ?? "UNKNOWN"}`,
      };
    } catch (error) {
      return {
        ready: false,
        state: "CONFIGURED_NOT_READY",
        controlMechanism: "OPENCLI",
        appBinding: "UNKNOWN",
        blocker: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async createManagedConversation(
    projectUrl: string,
    deadlineAt: string,
    onTransportObserved?: (evidence: TransportConversationEvidence) => void,
  ): Promise<ManagedConversationEvidence> {
    const probePrompt = this.peerIdentityProbePrompt();
    let rows: OpenCliConversationRow[];
    try {
      rows = await this.runJson<OpenCliConversationRow[]>(
        [
          "chatgpt",
          "ask",
          probePrompt,
          "--project",
          openCliProjectId(projectUrl),
          "--new",
          "true",
          "--wait",
          "false",
          "--site-session",
          "ephemeral",
          "--keep-tab",
          "false",
          "-f",
          "json",
        ],
        deadlineAt,
      );
    } catch (error) {
      throw new Error(
        `OPENCLI_CREATE_CONVERSATION_FAILED:${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const conversationUrl = rows[0]?.conversationUrl?.trim();
    if (!conversationUrl) {
      throw new Error("OPENCLI_CREATE_CONVERSATION_FAILED:missing conversation URL");
    }
    const transportEvidence: TransportConversationEvidence = {
      conversationUrl,
      conversationFingerprint: conversationFingerprintFromUrl(conversationUrl),
    };
    onTransportObserved?.(transportEvidence);
    try {
      await this.waitForConversationIdle(conversationUrl, deadlineAt);
      const authenticatedPeerFingerprint = this.peerFingerprintFromDetail(
        await this.detail(conversationUrl, deadlineAt),
        probePrompt,
      );
      return {
        ...transportEvidence,
        authenticatedPeerFingerprint,
        appBinding: "READY",
      };
    } catch (error) {
      throw new Error(
        `OPENCLI_PEER_PROBE_FAILED:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async sendPrompt(
    conversationUrl: string,
    prompt: string,
    deadlineAt: string,
  ): Promise<{ delivered: boolean; remoteMayContinue: boolean; blocker?: string }> {
    try {
      await this.waitForConversationIdle(conversationUrl, deadlineAt);
    } catch (error) {
      return {
        delivered: false,
        remoteMayContinue: false,
        blocker: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      const rows = await this.runJson<OpenCliConversationRow[]>(
        [
          "chatgpt",
          "ask",
          prompt,
          "--conversation",
          conversationIdFromUrl(conversationUrl),
          "--wait",
          "false",
          "--site-session",
          "ephemeral",
          "--keep-tab",
          "false",
          "-f",
          "json",
        ],
        deadlineAt,
      );
      const observedUrl = rows[0]?.conversationUrl?.trim();
      if (
        !observedUrl ||
        conversationFingerprintFromUrl(observedUrl) !==
          conversationFingerprintFromUrl(conversationUrl)
      ) {
        return {
          delivered: false,
          remoteMayContinue: true,
          blocker: "OPENCLI_CONVERSATION_IDENTITY_DRIFT",
        };
      }
      return { delivered: true, remoteMayContinue: true };
    } catch (error) {
      const observed = await this.promptObserved(
        conversationUrl,
        prompt,
        deadlineAt,
      ).catch(() => false);
      return {
        delivered: observed,
        remoteMayContinue: true,
        blocker: observed
          ? undefined
          : error instanceof Error
            ? error.message
            : String(error),
      };
    }
  }

  async recoverConversation(
    conversationUrl: string,
    deadlineAt: string,
  ): Promise<{ ready: boolean; blocker?: string }> {
    try {
      const rows = await this.detail(conversationUrl, deadlineAt);
      return rows.length > 0
        ? { ready: true }
        : { ready: false, blocker: "OPENCLI_CONVERSATION_EMPTY" };
    } catch (error) {
      return {
        ready: false,
        blocker: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async closeConversation(_conversationUrl: string): Promise<void> {
    // Ephemeral OpenCLI sessions do not retain a browser-tab lease after the command.
    // DevSpace stop still fences worker authority before reaching this transport seam.
  }

  private async waitForConversationIdle(
    conversationUrl: string,
    deadlineAt: string,
  ): Promise<void> {
    while (Date.now() < Date.parse(deadlineAt)) {
      const rows = await this.detail(conversationUrl, deadlineAt);
      const last = rows.at(-1);
      if (
        rows.length > 0 &&
        rows.every((row) => row.Generating !== true) &&
        last?.Role === "Assistant"
      ) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    throw new Error("OpenCLI ChatGPT conversation did not become idle before deadline");
  }

  private async promptObserved(
    conversationUrl: string,
    prompt: string,
    deadlineAt: string,
  ): Promise<boolean> {
    const rows = await this.detail(conversationUrl, deadlineAt);
    return rows.some((row) => row.Role === "User" && row.Text === prompt);
  }

  private peerIdentityProbePrompt(): string {
    return (
      `@${this.config.appLabel} Call chat_swarm_peer_status exactly once with no swarmId. ` +
      "Reply only DEVSPACE_PEER_FINGERPRINT=<identity.fingerprint>."
    );
  }

  private peerFingerprintFromDetail(
    rows: OpenCliDetailRow[],
    probePrompt: string,
  ): string {
    let probeIndex = -1;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index]?.Role === "User" && rows[index]?.Text === probePrompt) {
        probeIndex = index;
        break;
      }
    }
    if (probeIndex < 0) {
      throw new Error("OpenCLI peer identity probe prompt was not observed");
    }
    const assistant = rows
      .slice(probeIndex + 1)
      .find((row) => row.Role === "Assistant");
    const match = /^DEVSPACE_PEER_FINGERPRINT=([0-9a-f]{64})$/u.exec(
      assistant?.Text?.trim() ?? "",
    );
    if (!match?.[1]) {
      throw new Error("OpenCLI peer identity probe did not return a valid fingerprint");
    }
    return match[1];
  }

  private detail(
    conversationUrl: string,
    deadlineAt: string,
  ): Promise<OpenCliDetailRow[]> {
    return this.runJson<OpenCliDetailRow[]>(
      [
        "chatgpt",
        "detail",
        conversationIdFromUrl(conversationUrl),
        "--site-session",
        "ephemeral",
        "-f",
        "json",
      ],
      deadlineAt,
    );
  }

  private async runJson<T>(args: string[], deadlineAt: string): Promise<T> {
    const remaining = Math.max(1, Date.parse(deadlineAt) - Date.now());
    return await new Promise<T>((resolvePromise, rejectPromise) => {
      const child = spawn(this.config.openCliExecutable, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        finish(() => rejectPromise(new Error("OpenCLI command exceeded deadline")));
      }, Math.min(remaining, this.config.operationTimeoutMs));
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (error) => finish(() => rejectPromise(error)));
      child.on("close", (code) => finish(() => {
        if (code !== 0) {
          const detail = (stderr.trim() || stdout.trim()).slice(0, 1200);
          rejectPromise(new Error(`OpenCLI command failed (${code ?? "unknown"}): ${detail}`));
          return;
        }
        try {
          resolvePromise(JSON.parse(stdout.trim()) as T);
        } catch (error) {
          rejectPromise(
            new Error(
              `OpenCLI returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      }));
    });
  }
}

export class CdpMacWebDriver implements MacWebDriver {
  constructor(private readonly config: ChatSwarmRuntimeConfig) {}

  async preflight(): Promise<RuntimePreflight> {
    if (process.platform !== "darwin") {
      return {
        ready: false,
        state: "CONFIGURED_NOT_READY",
        controlMechanism: "CDP",
        appBinding: "UNKNOWN",
        blocker: "MACOS_REQUIRED",
      };
    }
    if (!this.config.projectUrl) {
      return {
        ready: false,
        state: "CONFIGURED_NOT_READY",
        controlMechanism: "CDP",
        appBinding: "UNKNOWN",
        blocker: "PROJECT_URL_REQUIRED",
      };
    }
    try {
      const version = await this.fetchJson<{ Browser?: string }>(
        "/json/version",
        new Date(Date.now() + this.config.operationTimeoutMs).toISOString(),
      );
      return {
        ready: true,
        state: "READY",
        controlMechanism: "CDP",
        browserVersion: version.Browser,
        appBinding: "UNKNOWN",
      };
    } catch (error) {
      return {
        ready: false,
        state: "CONFIGURED_NOT_READY",
        controlMechanism: "CDP",
        appBinding: "UNKNOWN",
        blocker: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async createManagedConversation(
    projectUrl: string,
    deadlineAt: string,
    onTransportObserved?: (evidence: TransportConversationEvidence) => void,
  ): Promise<ManagedConversationEvidence> {
    await this.ensureRuntime(deadlineAt);
    const target = await this.newTarget(projectUrl, deadlineAt);
    await this.waitForComposer(target, deadlineAt);
    const appBinding = await this.observeAppBinding(target);
    await this.sendPromptToTarget(
      target,
      "Managed DevSpace worker carrier initialization. Reply exactly READY_FOR_BOOTSTRAP. Do not call tools yet.",
      deadlineAt,
    );
    const conversationUrl = await this.waitForConversationUrl(target, deadlineAt);
    const evidence = {
      conversationUrl,
      conversationFingerprint: conversationFingerprintFromUrl(conversationUrl),
    };
    onTransportObserved?.(evidence);
    return {
      ...evidence,
      appBinding,
    };
  }

  async sendPrompt(
    conversationUrl: string,
    prompt: string,
    deadlineAt: string,
  ): Promise<{ delivered: boolean; remoteMayContinue: boolean; blocker?: string }> {
    try {
      await this.ensureRuntime(deadlineAt);
      const target = await this.openOrReuse(conversationUrl, deadlineAt);
      await this.waitForComposer(target, deadlineAt);
      const binding = await this.observeAppBinding(target);
      if (binding === "DISABLED" || binding === "STALE") {
        return {
          delivered: false,
          remoteMayContinue: false,
          blocker: `HOST_APP_BINDING_${binding}`,
        };
      }
      await this.sendPromptToTarget(target, prompt, deadlineAt);
      return { delivered: true, remoteMayContinue: true };
    } catch (error) {
      return {
        delivered: false,
        remoteMayContinue: true,
        blocker: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async recoverConversation(
    conversationUrl: string,
    deadlineAt: string,
  ): Promise<{ ready: boolean; blocker?: string }> {
    try {
      await this.ensureRuntime(deadlineAt);
      const target = await this.openOrReuse(conversationUrl, deadlineAt);
      await this.waitForComposer(target, deadlineAt);
      const binding = await this.observeAppBinding(target);
      if (binding === "DISABLED" || binding === "STALE") {
        return { ready: false, blocker: `HOST_APP_BINDING_${binding}` };
      }
      return { ready: true };
    } catch (error) {
      return {
        ready: false,
        blocker: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async closeConversation(conversationUrl: string): Promise<void> {
    const deadlineAt = new Date(Date.now() + this.config.operationTimeoutMs).toISOString();
    const targets = await this.targets(deadlineAt);
    const exact = targets.find((target) => target.url === conversationUrl);
    if (!exact) return;
    const response = await this.boundedFetch(
      `${this.config.cdpEndpoint}/json/close/${encodeURIComponent(exact.id)}`,
      { method: "PUT" },
      deadlineAt,
    );
    if (!response.ok) throw new Error(`CDP close target failed: ${response.status}`);
  }

  private async ensureRuntime(deadlineAt: string): Promise<void> {
    const ready = await this.preflight();
    if (ready.ready) return;
    if (!this.config.browserExecutable) {
      throw new ChatSwarmError(
        "HOST_CONVERSATION_UNSUPPORTED",
        ready.blocker ?? "CDP browser runtime is unavailable",
      );
    }
    const endpoint = new URL(this.config.cdpEndpoint);
    const port = endpoint.port || (endpoint.protocol === "https:" ? "443" : "80");
    const child = spawn(
      this.config.browserExecutable,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${this.config.browserProfileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        this.config.projectUrl!,
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    while (Date.now() < Date.parse(deadlineAt)) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      if ((await this.preflight()).ready) return;
    }
    throw new ChatSwarmError(
      "HOST_CONVERSATION_UNSUPPORTED",
      "managed browser did not expose CDP before deadline",
    );
  }

  private async newTarget(url: string, deadlineAt: string): Promise<CdpTarget> {
    const response = await this.boundedFetch(
      `${this.config.cdpEndpoint}/json/new?${encodeURIComponent(url)}`,
      { method: "PUT" },
      deadlineAt,
    );
    if (!response.ok) throw new Error(`CDP new target failed: ${response.status}`);
    return (await response.json()) as CdpTarget;
  }

  private async targets(deadlineAt: string): Promise<CdpTarget[]> {
    return this.fetchJson<CdpTarget[]>("/json/list", deadlineAt);
  }

  private async openOrReuse(url: string, deadlineAt: string): Promise<CdpTarget> {
    return (
      (await this.targets(deadlineAt)).find((target) => target.url === url) ??
      (await this.newTarget(url, deadlineAt))
    );
  }

  private async fetchJson<T>(path: string, deadlineAt: string): Promise<T> {
    const response = await this.boundedFetch(
      `${this.config.cdpEndpoint}${path}`,
      undefined,
      deadlineAt,
    );
    if (!response.ok) throw new Error(`CDP request failed: ${response.status}`);
    return (await response.json()) as T;
  }

  private async boundedFetch(
    url: string,
    init: RequestInit | undefined,
    deadlineAt: string,
  ): Promise<Response> {
    const remaining = Math.max(1, Date.parse(deadlineAt) - Date.now());
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(remaining, this.config.operationTimeoutMs),
    );
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async evaluate<T>(target: CdpTarget, expression: string): Promise<T> {
    if (!target.webSocketDebuggerUrl) {
      target =
        (await this.targets(
          new Date(Date.now() + this.config.operationTimeoutMs).toISOString(),
        )).find((candidate) => candidate.id === target.id) ?? target;
    }
    if (!target.webSocketDebuggerUrl) {
      throw new Error("CDP target has no debugger websocket");
    }
    const WebSocketCtor = (
      globalThis as unknown as { WebSocket?: new (url: string) => any }
    ).WebSocket;
    if (!WebSocketCtor) throw new Error("WebSocket is unavailable in this Node runtime");
    return await new Promise<T>((resolvePromise, rejectPromise) => {
      const ws = new WebSocketCtor(target.webSocketDebuggerUrl!);
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        rejectPromise(new Error("CDP evaluate timed out"));
      }, Math.min(10_000, this.config.operationTimeoutMs));
      ws.onopen = () =>
        ws.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true, awaitPromise: true },
          }),
        );
      ws.onerror = () => {
        clearTimeout(timer);
        rejectPromise(new Error("CDP websocket failed"));
      };
      ws.onmessage = (event: { data: string }) => {
        const payload = JSON.parse(String(event.data)) as {
          id?: number;
          result?: { result?: { value?: T } };
          error?: { message?: string };
        };
        if (payload.id !== 1) return;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        if (payload.error) {
          rejectPromise(new Error(payload.error.message ?? "CDP evaluate failed"));
        } else {
          resolvePromise(payload.result?.result?.value as T);
        }
      };
    });
  }

  private async waitForComposer(target: CdpTarget, deadlineAt: string): Promise<void> {
    while (Date.now() < Date.parse(deadlineAt)) {
      const ready = await this.evaluate<boolean>(
        target,
        `(() => { const visible=(el) => { const rect=el.getBoundingClientRect(); const style=getComputedStyle(el); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; }; return Boolean([...document.querySelectorAll('[contenteditable="true"]')].find(visible) || [...document.querySelectorAll('textarea')].find(visible)); })()`,
      ).catch(() => false);
      if (ready) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    throw new Error("ChatGPT composer was not ready before deadline");
  }

  private async observeAppBinding(
    target: CdpTarget,
  ): Promise<"READY" | "UNKNOWN" | "DISABLED" | "STALE"> {
    const label = JSON.stringify(this.config.appLabel.toLowerCase());
    return this.evaluate<"READY" | "UNKNOWN" | "DISABLED" | "STALE">(
      target,
      `(() => { const text=(document.body?.innerText||'').toLowerCase(); const label=${label}; if (text.includes(label) && !text.includes(label+' disabled')) return 'READY'; if (text.includes(label+' disabled')) return 'DISABLED'; return 'UNKNOWN'; })()`,
    ).catch(() => "UNKNOWN");
  }

  private async sendPromptToTarget(
    target: CdpTarget,
    prompt: string,
    deadlineAt: string,
  ): Promise<void> {
    if (Date.now() >= Date.parse(deadlineAt)) {
      throw new Error("prompt delivery deadline elapsed before send");
    }
    const encoded = JSON.stringify(prompt);
    const result = await this.evaluate<{ ok: boolean; reason?: string }>(
      target,
      `(() => { const prompt=${encoded}; const visible=(el) => { const rect=el.getBoundingClientRect(); const style=getComputedStyle(el); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; }; const editable=[...document.querySelectorAll('[contenteditable="true"]')].find(visible); const textarea=[...document.querySelectorAll('textarea')].find(visible); const el=editable||textarea; if(!el) return {ok:false,reason:'composer_missing'}; el.focus(); if(editable){ editable.textContent=prompt; editable.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:prompt})); } else { const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set; setter?.call(textarea,prompt); textarea.dispatchEvent(new Event('input',{bubbles:true})); } const button=document.querySelector('[data-testid="send-button"]') || [...document.querySelectorAll('button')].find(b => /send/i.test((b.getAttribute('aria-label')||b.textContent||''))); if(!button || button.disabled) return {ok:false,reason:'send_button_missing_or_disabled'}; button.click(); return {ok:true}; })()`,
    );
    if (!result?.ok) {
      throw new Error(result?.reason ?? "ChatGPT prompt delivery failed");
    }
    if (Date.now() > Date.parse(deadlineAt)) {
      throw new Error("prompt delivery exceeded deadline");
    }
  }

  private async waitForConversationUrl(
    target: CdpTarget,
    deadlineAt: string,
  ): Promise<string> {
    while (Date.now() < Date.parse(deadlineAt)) {
      const url = await this.evaluate<string>(target, "location.href").catch(() => "");
      if (url && /\/c\/[^/?#]+/.test(url)) return url;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    throw new Error("ChatGPT conversation identity did not become observable before deadline");
  }
}

function conversationIdFromUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "chatgpt.com" && url.hostname !== "www.chatgpt.com")
  ) {
    throw new ChatSwarmError(
      "INVALID_INPUT",
      "managed conversation URL must be on chatgpt.com",
    );
  }
  const match = url.pathname.match(/\/c\/([^/?#]+)/);
  if (!match?.[1]) {
    throw new ChatSwarmError(
      "IDENTITY_MISSING",
      "conversation URL does not expose a bounded conversation identity",
    );
  }
  return decodeURIComponent(match[1]);
}

export function conversationFingerprintFromUrl(value: string): string {
  return createHash("sha256").update(conversationIdFromUrl(value)).digest("hex");
}

export class MacWebChatCarrierAdapter implements ChatSwarmManagedCarrierAdapter {
  readonly kind = "mac_web_chatgpt";
  readonly configHash: string;

  constructor(
    readonly config: ChatSwarmRuntimeConfig,
    readonly registry: ChatSwarmRuntimeStore,
    readonly driver: MacWebDriver = config.transport === "opencli"
      ? new OpenCliMacWebDriver(config)
      : new CdpMacWebDriver(config),
  ) {
    this.configHash = canonicalHash({
      transport: config.transport,
      openCliExecutable: config.transport === "opencli" ? config.openCliExecutable : null,
      cdpEndpoint: config.transport === "cdp" ? config.cdpEndpoint : null,
      projectUrl: config.projectUrl ?? null,
      browserProfileId: profileId(config.browserProfileDir),
      appLabel: config.appLabel,
      kind: this.kind,
    });
  }

  capabilities() {
    return {
      boundedWait: "SUPPORTED" as const,
      eventWake: "SUPPORTED" as const,
      resultReadback: "SUPPORTED" as const,
      durableReplay: "SUPPORTED" as const,
    };
  }

  preflight(): Promise<RuntimePreflight> { return this.driver.preflight(); }

  provision(input: {
    operationId: string;
    swarmId: string;
    runtimeSlot: number;
    projectUrl: string;
    deadlineAt: string;
  }): Promise<ManagedConversationEvidence> {
    return this.driver.createManagedConversation(
      input.projectUrl,
      input.deadlineAt,
      (evidence) => {
        this.registry.markTransportObserved(input.operationId, evidence);
      },
    );
  }

  async bootstrap(input: {
    operationId: string;
    swarmId: string;
    runtimeSlot: number;
    conversationUrl: string;
    workerLabel: string;
    deadlineAt: string;
  }) {
    const prompt =
      `@${this.config.appLabel} Call chat_swarm_runtime_bootstrap exactly once with operationId=${input.operationId}. ` +
      "Stop after the tool returns.";
    const sent = await this.driver.sendPrompt(
      input.conversationUrl,
      prompt,
      input.deadlineAt,
    );
    if (!sent.delivered) {
      return {
        disposition: sent.blocker?.startsWith("HOST_APP_BINDING_")
          ? ("SETUP_REQUIRED" as const)
          : ("UNKNOWN" as const),
        remoteMayContinue: sent.remoteMayContinue,
      };
    }
    return { disposition: "DELIVERED" as const, remoteMayContinue: true };
  }

  recover(slot: ManagedCarrierSlot): Promise<{ ready: boolean; blocker?: string }> {
    if (!slot.conversationUrl) {
      return Promise.resolve({ ready: false, blocker: "CONVERSATION_URL_MISSING" });
    }
    return this.driver.recoverConversation(
      slot.conversationUrl,
      new Date(Date.now() + this.config.operationTimeoutMs).toISOString(),
    );
  }

  stop(slot: ManagedCarrierSlot): Promise<void> {
    return slot.conversationUrl
      ? this.driver.closeConversation(slot.conversationUrl)
      : Promise.resolve();
  }

  async ensureExisting(input: CarrierCallInput): Promise<CarrierEnsureEvidence> {
    const slot = this.registry.getSlotByWorker(input.swarmId, input.workerId);
    const slotAuthorityFingerprint =
      slot?.authenticatedPeerFingerprint ?? slot?.conversationFingerprint;
    if (
      !slot?.conversationUrl ||
      slot.workerId !== input.workerId ||
      slotAuthorityFingerprint !== input.carrierFingerprint
    ) {
      return {
        disposition: "UNSUPPORTED",
        operationId: input.operationId,
        swarmId: input.swarmId,
        workerId: input.workerId,
        expectedEpoch: input.expectedEpoch,
        carrierKind: input.carrierKind,
        carrierFingerprint: input.carrierFingerprint,
        remoteMayContinue: false,
      };
    }
    const recovered = await this.driver.recoverConversation(
      slot.conversationUrl,
      input.deadlineAt,
    );
    return {
      disposition: recovered.ready ? "READY" : "UNKNOWN",
      operationId: input.operationId,
      swarmId: input.swarmId,
      workerId: input.workerId,
      expectedEpoch: input.expectedEpoch,
      carrierKind: input.carrierKind,
      carrierFingerprint: input.carrierFingerprint,
      remoteMayContinue: !recovered.ready,
    };
  }

  async wake(input: CarrierCallInput): Promise<CarrierWakeEvidence> {
    const slot = this.registry.getSlotByWorker(input.swarmId, input.workerId);
    const slotAuthorityFingerprint =
      slot?.authenticatedPeerFingerprint ?? slot?.conversationFingerprint;
    if (
      !slot?.conversationUrl ||
      slot.workerId !== input.workerId ||
      slotAuthorityFingerprint !== input.carrierFingerprint
    ) {
      return {
        disposition: "UNSUPPORTED",
        operationId: input.operationId,
        swarmId: input.swarmId,
        workerId: input.workerId,
        expectedEpoch: input.expectedEpoch,
        taskId: input.taskId,
        attemptId: input.attemptId,
        carrierKind: input.carrierKind,
        carrierFingerprint: input.carrierFingerprint,
        remoteMayContinue: false,
      };
    }
    const prompt =
      `@${this.config.appLabel} Call chat_swarm_next exactly once with workerId=${input.workerId}. ` +
      "If it returns a task, complete only that task and call chat_swarm_submit exactly once with the returned taskId and this workerId. If it returns no task, stop.";
    const sent = await this.driver.sendPrompt(
      slot.conversationUrl,
      prompt,
      input.deadlineAt,
    );
    return {
      disposition: sent.delivered ? "DELIVERED" : "UNKNOWN",
      operationId: input.operationId,
      swarmId: input.swarmId,
      workerId: input.workerId,
      expectedEpoch: input.expectedEpoch,
      taskId: input.taskId,
      attemptId: input.attemptId,
      carrierKind: input.carrierKind,
      carrierFingerprint: input.carrierFingerprint,
      remoteMayContinue: sent.remoteMayContinue,
    };
  }
}

export class ChatSwarmRuntimeManager {
  readonly runtimeConfig: ChatSwarmRuntimeConfig;
  readonly registry: ChatSwarmRuntimeStore;
  readonly adapter: ChatSwarmManagedCarrierAdapter;
  readonly carrierManager: ChatSwarmCarrierManager;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(
    readonly coordinator: ChatSwarmCoordinator,
    serverConfig: { stateDir: string; chatSwarmMaxWorkers: number },
    options: {
      env?: NodeJS.ProcessEnv;
      adapter?: ChatSwarmManagedCarrierAdapter;
      registry?: ChatSwarmRuntimeStore;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.runtimeConfig = loadChatSwarmRuntimeConfig(serverConfig, options.env);
    this.registry = options.registry ?? new ChatSwarmRuntimeStore(this.runtimeConfig.stateDir);
    this.adapter =
      options.adapter ?? new MacWebChatCarrierAdapter(this.runtimeConfig, this.registry);
    this.sleepFn = options.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
    this.carrierManager = new ChatSwarmCarrierManager(
      coordinator.store,
      coordinator,
      this.adapter,
      this.runtimeConfig.operationTimeoutMs,
    );
  }

  close(): void { this.registry.close(); }

  async status(meta: unknown, swarmId: string): Promise<RuntimeStatusResult> {
    this.coordinator.assertOwnerForLifecycle(meta, swarmId);
    const slots = this.registry.listSlots(swarmId);
    if (!this.runtimeConfig.enabled) {
      return this.statusResult(
        swarmId,
        "DISABLED",
        slots,
        {
          ready: false,
          state: "CONFIGURED_NOT_READY",
          controlMechanism: this.runtimeConfig.transport === "opencli" ? "OPENCLI" : "CDP",
          appBinding: "UNKNOWN",
          blocker: "DEVSPACE_CHAT_SWARM_RUNTIME_DISABLED",
        },
      );
    }
    const preflight = await this.adapter.preflight();
    let state: ChatSwarmRuntimeState = preflight.ready
      ? "READY"
      : "CONFIGURED_NOT_READY";
    if (slots.some((slot) => slot.state === "RECONCILE_REQUIRED")) {
      state = "RECONCILE_REQUIRED";
    } else if (
      slots.some((slot) =>
        ["SETUP_REQUIRED", "PROVISIONING", "CARRIER_CREATED", "BOOTSTRAPPING", "STOPPING"].includes(slot.state),
      ) ||
      slots.some((slot) => slot.blocker)
    ) {
      state = "DEGRADED";
    }
    return this.statusResult(swarmId, state, slots, preflight);
  }

  async ensure(
    meta: unknown,
    swarmId: string,
    desiredWorkers = this.runtimeConfig.poolDefault,
  ): Promise<RuntimeStatusResult> {
    this.assertRuntimeEnabled();
    this.coordinator.assertOwnerForLifecycle(meta, swarmId);
    const swarm = this.coordinator.store.getSwarm(swarmId);
    if (!swarm || swarm.status !== "ACTIVE") {
      throw new ChatSwarmError(
        "INVALID_STATE",
        "runtime ensure requires an active swarm",
      );
    }
    if (
      !Number.isSafeInteger(desiredWorkers) ||
      desiredWorkers < 1 ||
      desiredWorkers > Math.min(swarm.workerLimit, this.runtimeConfig.maxWorkers)
    ) {
      throw new ChatSwarmError(
        "CAPACITY_FULL",
        "desiredWorkers exceeds the configured swarm/runtime bound",
      );
    }
    const preflight = await this.adapter.preflight();
    if (!preflight.ready) {
      throw new ChatSwarmError(
        "HOST_CONVERSATION_UNSUPPORTED",
        preflight.blocker ?? "macOS web carrier is not ready",
      );
    }

    const projectUrl = this.runtimeConfig.projectUrl!;
    const browserProfileId = profileId(this.runtimeConfig.browserProfileDir);
    let createdCarriersThisEnsure = 0;
    for (let runtimeSlot = 1; runtimeSlot <= desiredWorkers; runtimeSlot += 1) {
      let slot = this.registry.ensureSlot(
        swarmId,
        runtimeSlot,
        projectUrl,
        browserProfileId,
      );
      if (
        ["PARKED", "SWARM_BOUND", "BUSY"].includes(slot.state) &&
        slot.workerId
      ) {
        const worker = this.coordinator.store.getWorker(slot.workerId);
        if (
          worker &&
          worker.lifecycleState !== "DISABLED" &&
          worker.lifecycleState !== "RECONCILE_REQUIRED"
        ) continue;
      }

      const prepared = this.registry.prepareProvision(
        slot,
        runtimeProvisionLeaseMs(this.runtimeConfig),
      );
      slot = prepared.slot;
      if (!prepared.operation) continue;
      let operation = prepared.operation;

      if (operation.status === "outcome_unknown" || slot.state === "RECONCILE_REQUIRED") {
        break;
      }
      if (operation.status === "succeeded") {
        continue;
      }

      if (operation.status === "prepared") {
        if (!this.registry.claimProvision(operation.operationId)) {
          await this.waitForPeerInvocation(slot).catch(() => undefined);
          continue;
        }
        operation = this.registry.getProvision(operation.operationId)!;
      } else if (operation.status === "started" && !prepared.created) {
        await this.waitForPeerInvocation(slot).catch(() => undefined);
        continue;
      }

      if (operation.status === "started" && !operation.receipt?.conversationUrl) {
        if (createdCarriersThisEnsure > 0 && this.runtimeConfig.provisionStaggerMs > 0) {
          await this.sleepFn(this.runtimeConfig.provisionStaggerMs);
        }
        let evidence: ManagedConversationEvidence;
        try {
          evidence = await this.adapter.provision({
            operationId: operation.operationId,
            swarmId,
            runtimeSlot,
            projectUrl,
            deadlineAt: new Date(
              Date.now() + this.runtimeConfig.operationTimeoutMs,
            ).toISOString(),
          });
        } catch (error) {
          this.registry.markProvisionUnknown(
            operation.operationId,
            error instanceof Error ? error.message : String(error),
          );
          break;
        }
        slot = this.registry.markCarrierCreated(operation.operationId, evidence);
        operation = this.registry.getProvision(operation.operationId)!;
        createdCarriersThisEnsure += 1;
      }

      if (slot.state === "SETUP_REQUIRED" || !slot.conversationUrl) continue;
      const slotAuthorityFingerprint =
        slot.authenticatedPeerFingerprint ?? slot.conversationFingerprint;
      const existingWorker = slotAuthorityFingerprint
        ? this.coordinator.store.findWorkerByCarrier(
            swarmId,
            slotAuthorityFingerprint,
          )
        : undefined;
      if (existingWorker) {
        this.registry.bindWorker(operation.operationId, existingWorker);
        continue;
      }

      if (operation.status === "carrier_created") {
        if (!this.registry.claimBootstrap(operation.operationId)) {
          await this.waitForPeerInvocation(slot).catch(() => undefined);
          continue;
        }
      } else if (operation.status === "bootstrapping" && !prepared.created) {
        await this.waitForPeerInvocation(slot).catch(() => undefined);
        continue;
      }

      const delivered = await this.adapter.bootstrap({
        operationId: operation.operationId,
        swarmId,
        runtimeSlot,
        conversationUrl: slot.conversationUrl,
        workerLabel: managedWorkerLabel(runtimeSlot),
        deadlineAt: new Date(
          Date.now() + this.runtimeConfig.operationTimeoutMs,
        ).toISOString(),
      });
      if (delivered.disposition !== "DELIVERED") {
        const rebound = this.registry.getSlot(swarmId, runtimeSlot);
        if (!rebound?.workerId) {
          this.registry.markProvisionUnknown(
            operation.operationId,
            delivered.disposition === "SETUP_REQUIRED"
              ? "HOST_APP_BINDING_SETUP_REQUIRED"
              : "BOOTSTRAP_DELIVERY_UNKNOWN",
          );
          break;
        }
        continue;
      }
      try {
        await this.registry.waitForBound(
          swarmId,
          runtimeSlot,
          this.runtimeConfig.bootstrapWaitMs,
        );
      } catch (error) {
        const rebound = this.registry.getSlot(swarmId, runtimeSlot);
        if (!rebound?.workerId) {
          this.registry.markProvisionUnknown(
            operation.operationId,
            error instanceof Error ? error.message : String(error),
          );
          break;
        }
      }
    }
    return this.status(meta, swarmId);
  }

  bootstrap(
    meta: unknown,
    operationId: string,
  ): { slot: ManagedCarrierSlot; worker: ChatSwarmWorker } {
    this.assertRuntimeEnabled();
    const identity = resolveChatSwarmIdentity(meta);
    const operation = this.registry.getProvision(operationId);
    if (!operation) {
      throw new ChatSwarmError(
        "REQUEST_NOT_FOUND",
        "runtime provision operation not found",
      );
    }
    if (Date.parse(operation.request.expiresAt) <= Date.now()) {
      throw new ChatSwarmError(
        "REQUEST_EXPIRED",
        "runtime provision operation expired",
      );
    }
    const transportFingerprint = operation.receipt?.conversationFingerprint;
    if (!transportFingerprint) {
      throw new ChatSwarmError(
        "INVALID_STATE",
        "runtime provision has no observed conversation identity",
      );
    }
    const authenticatedPeerFingerprint =
      operation.receipt?.authenticatedPeerFingerprint ?? transportFingerprint;
    if (identity.fingerprint !== authenticatedPeerFingerprint) {
      throw new ChatSwarmError(
        "OWNERSHIP_CONFLICT",
        "caller authenticated peer does not match the managed carrier created for this operation",
      );
    }
    const existing = this.coordinator.store.findWorkerByCarrier(
      operation.request.swarmId,
      authenticatedPeerFingerprint,
    );
    const worker =
      existing ??
      this.coordinator.store.joinWorkerAtomic(
        operation.request.swarmId,
        authenticatedPeerFingerprint,
        {
          swarmId: operation.request.swarmId,
          label: managedWorkerLabel(operation.request.runtimeSlot),
          runtimeKind: "mcp_peer",
          carrierConversationFingerprint: authenticatedPeerFingerprint,
        },
      );
    return { slot: this.registry.bindWorker(operationId, worker), worker };
  }

  async wakeForDispatchedTask(meta: unknown, task: ChatSwarmTask): Promise<void> {
    if (
      !this.runtimeConfig.enabled ||
      !task.preferredWorkerId ||
      task.lifecycleState !== "QUEUED"
    ) return;
    const slot = this.registry.getSlotByWorker(
      task.swarmId,
      task.preferredWorkerId,
    );
    const worker = this.coordinator.store.getWorker(task.preferredWorkerId);
    if (
      !slot ||
      !worker ||
      !slot.conversationFingerprint ||
      worker.lifecycleState === "DISABLED" ||
      worker.lifecycleState === "RECONCILE_REQUIRED"
    ) return;
    try {
      await this.carrierManager.wake(meta, {
        swarmId: task.swarmId,
        workerId: worker.id,
        expectedEpoch: worker.continuationEpoch,
        taskId: task.id,
        adapterConfigHash:
          this.adapter.configHash ?? canonicalHash({ kind: this.adapter.kind }),
      });
    } catch {
      // Dispatch truth is already durable. The carrier journal owns wake reconciliation.
    }
  }

  async recover(
    meta: unknown,
    swarmId: string,
    workerId: string,
  ): Promise<RuntimeStatusResult> {
    this.assertRuntimeEnabled();
    this.coordinator.assertOwnerForLifecycle(meta, swarmId);
    const slot = this.registry.getSlotByWorker(swarmId, workerId);
    if (!slot) throw new ChatSwarmError("NOT_FOUND", "managed worker carrier not found");
    const worker = this.coordinator.store.getWorker(workerId);
    if (
      !worker ||
      worker.lifecycleState === "RECONCILE_REQUIRED" ||
      worker.currentTaskId
    ) {
      throw new ChatSwarmError(
        "RECONCILIATION_REQUIRED",
        "worker has active or unresolved task state; recover cannot mint retry authority",
      );
    }
    const recovered = await this.adapter.recover(slot);
    if (!recovered.ready) {
      if (slot.lastOperationId) {
        const provision = this.registry.getProvision(slot.lastOperationId);
        if (provision) {
          this.registry.markProvisionUnknown(
            slot.lastOperationId,
            recovered.blocker ?? "CARRIER_RECOVERY_FAILED",
          );
        }
      }
      throw new ChatSwarmError(
        "RECONCILIATION_REQUIRED",
        recovered.blocker ?? "carrier recovery requires explicit reconciliation",
      );
    }
    this.registry.markRecovered(slot);
    return this.status(meta, swarmId);
  }

  async scale(
    meta: unknown,
    swarmId: string,
    desiredWorkers: number,
  ): Promise<RuntimeStatusResult> {
    this.assertRuntimeEnabled();
    this.coordinator.assertOwnerForLifecycle(meta, swarmId);
    if (!Number.isSafeInteger(desiredWorkers) || desiredWorkers < 1) {
      throw new ChatSwarmError("INVALID_INPUT", "desiredWorkers must be positive");
    }
    const active = this.registry
      .listSlots(swarmId)
      .filter((slot) => slot.state !== "STOPPED");
    if (desiredWorkers >= active.length) {
      return this.ensure(meta, swarmId, desiredWorkers);
    }

    let toRetire = active.length - desiredWorkers;
    for (const slot of [...active].sort((a, b) => b.runtimeSlot - a.runtimeSlot)) {
      if (toRetire <= 0) break;
      let stopPlan;
      try {
        stopPlan = this.registry.prepareStop(slot);
      } catch (error) {
        if (
          error instanceof ChatSwarmError &&
          ["INVALID_STATE", "RECONCILIATION_REQUIRED", "CAS_DRIFT"].includes(
            error.code,
          )
        ) continue;
        throw error;
      }
      if (!stopPlan.operation || !stopPlan.claimed) continue;
      try {
        await this.adapter.stop(stopPlan.slot);
        this.registry.completeStop(stopPlan.operation.operationId);
        toRetire -= 1;
      } catch (error) {
        this.registry.markStopUnknown(
          stopPlan.operation.operationId,
          error instanceof Error ? error.message : String(error),
        );
        throw new ChatSwarmError(
          "RECONCILIATION_REQUIRED",
          "managed carrier stop outcome is unknown",
        );
      }
    }
    if (toRetire > 0) {
      throw new ChatSwarmError(
        "INVALID_STATE",
        "not enough safe idle workers can be scaled down",
      );
    }
    return this.status(meta, swarmId);
  }

  async stop(
    meta: unknown,
    swarmId: string,
    workerId: string,
  ): Promise<RuntimeStatusResult> {
    this.assertRuntimeEnabled();
    this.coordinator.assertOwnerForLifecycle(meta, swarmId);
    const slot = this.registry.getSlotByWorker(swarmId, workerId);
    if (!slot) throw new ChatSwarmError("NOT_FOUND", "managed worker carrier not found");
    const plan = this.registry.prepareStop(slot);
    if (!plan.operation) return this.status(meta, swarmId);
    if (!plan.claimed) {
      if (plan.operation.status === "outcome_unknown") {
        throw new ChatSwarmError(
          "RECONCILIATION_REQUIRED",
          "managed carrier stop requires reconciliation",
        );
      }
      return this.status(meta, swarmId);
    }
    try {
      await this.adapter.stop(plan.slot);
      this.registry.completeStop(plan.operation.operationId);
    } catch (error) {
      this.registry.markStopUnknown(
        plan.operation.operationId,
        error instanceof Error ? error.message : String(error),
      );
      throw new ChatSwarmError(
        "RECONCILIATION_REQUIRED",
        "managed carrier stop outcome is unknown",
      );
    }
    return this.status(meta, swarmId);
  }

  private async waitForPeerInvocation(slot: ManagedCarrierSlot): Promise<void> {
    await this.registry.waitForBound(
      slot.swarmId,
      slot.runtimeSlot,
      this.runtimeConfig.bootstrapWaitMs,
    );
  }

  private assertRuntimeEnabled(): void {
    if (!this.runtimeConfig.enabled) {
      throw new ChatSwarmError(
        "INVALID_STATE",
        "managed ChatGPT worker runtime is disabled",
      );
    }
    if (!this.runtimeConfig.projectUrl) {
      throw new ChatSwarmError(
        "HOST_CONVERSATION_UNSUPPORTED",
        "DEVSPACE_CHAT_SWARM_PROJECT_URL is required",
      );
    }
  }

  private statusResult(
    swarmId: string,
    state: ChatSwarmRuntimeState,
    slots: ManagedCarrierSlot[],
    preflight: RuntimePreflight,
  ): RuntimeStatusResult {
    return {
      swarmId,
      state,
      enabled: this.runtimeConfig.enabled,
      desiredDefault: this.runtimeConfig.poolDefault,
      maxWorkers: this.runtimeConfig.maxWorkers,
      adapter: {
        kind: "mac_web_chatgpt",
        controlMechanism: preflight.controlMechanism,
        projectConfigured: Boolean(this.runtimeConfig.projectUrl),
        appBinding: preflight.appBinding,
        blocker: preflight.blocker,
      },
      slots,
    };
  }
}

function managedWorkerLabel(runtimeSlot: number): string {
  return `Runtime-${String(runtimeSlot).padStart(2, "0")}`;
}
