import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, unlinkSync, rmdirSync, writeFileSync } from "node:fs";
import { copyFile, cp, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { arch, homedir, hostname, platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath, sep } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config.js";
import {
  createLocalAgentStore,
  isDetachedLifecycle,
  LocalAgentReplayConflictError,
  LocalAgentStore,
  type LocalAgentRecord,
  type LocalAgentStatus,
} from "./local-agent-store.js";
import { isLocalAgentProvider, loadLocalAgentProfiles, type LocalAgentProfile } from "./local-agent-profiles.js";
import {
  checkLocalAgentProviderAvailability,
  getLocalAgentProviderRuntimeVersion,
  resolveLocalAgentProviderExecutable,
} from "./local-agent-availability.js";
import { runLocalAgentProvider } from "./local-agent-adapters.js";
import { resolveEffectiveExecutionIdlePolicy } from "./local-agent-idle-policy.js";
import { LocalAgentProviderError, type LocalAgentRunCallbacks, type LocalAgentRunResult } from "./local-agent-runtime.js";
import {
  inspectOwnedProcessTree,
  signalOwnedProcessTree,
  terminateProcessTree,
  type KillableProcess,
  type OwnedProcessIdentity,
  type OwnedProcessTreeState,
} from "./process-platform.js";
import {
  type AgentTerminalReason,
  type EffectiveExecutionIdlePolicy,
  type ExecutionContract,
  type ScopeState,
  type OperationTimeline,
  type ModelAttestation,
  type DispatchFailureClassification,
} from "./local-agent-contract.js";
import {
  buildToolchainEnvironment,
  describeToolchainExecutables,
  runToolchainVerifier,
  type ToolchainVerificationResult,
} from "./local-agent-toolchains.js";
import type { WorkResumeStore } from "./work-resume.js";
import { inspectCodexRuntime, type CodexRuntimeIdentity } from "./codex-runtime.js";
import {
  cleanupProviderScratch,
  createProviderScratch,
  SCRATCH_DIR_PREFIX,
  type CleanupResult,
  type ScratchHandle,
} from "./provider-scratch.js";
import type { ProfileCatalog } from "./local-agent-profile-source.js";
import {
  AgentProviderFailureError,
  describeAgentProviderError,
  isAgentProviderError,
  redactSensitiveText,
  type AgentProviderFailureDetails,
} from "./local-agent-errors.js";
import { validateOpencodeModelAndVariant, type OpencodeCatalogSnapshot } from "./local-agent-opencode-catalog.js";
import { isClineCatalogFresh, type ClineCatalogSnapshot } from "./local-agent-cline-catalog.js";
import type { ClineCatalogService } from "./local-agent-cline-catalog.js";
import { ClineCatalogService as ClineCatalogServiceImpl } from "./local-agent-cline-catalog.js";
import { createMcpOpencodeCatalogSource } from "./local-agent-opencode-mcp-catalog.js";
import { canonicalizePath, isPathInsideRoot, isSameWorktreePath } from "./roots.js";
import {
  assertNexusGrantAuthorizesExecution,
  assertSameExecutionGeneration,
  buildExecutionGenerationBinding,
  buildHostGenerationBinding,
  hashDispatchIntent,
  renderDispatchIntentForWorker,
  validateDispatchIntent,
  validateResolvedNexusExecutionGrant,
  type AuthorityValidationEvidence,
  type DispatchIntent,
  type ExecutionAuthReadiness,
  type ExecutionGenerationBinding,
  type HostGenerationBinding,
  type NexusExecutionGrant,
  type NexusExecutionGrantRef,
  ExecutionProtocolError,
} from "./execution-protocol.js";
import { describeRuntimeBuildIdentity, type RuntimeBuildIdentity } from "./build-identity.js";
import { withInstalledNexusCertifyOnPath } from "./local-agent-path.js";
import type { LocalEffectEnforcementReceipt } from "./local-effect-enforcement.js";
import { devspaceConfigDir } from "./user-config.js";
import {
  classifyScopeState,
  computeWorkerDelta,
  inspectWorkspacePhysicalState,
  readWorkspaceHead,
  type WorkerAttribution,
} from "./workspace-reconciliation.js";
import {
  type HerdrAgentKind,
  type HerdrExternalHandle,
  type HerdrPromptResult,
  HerdrThinGateway,
  defaultHerdrGatewayRegistry,
  HERDR_RUNTIME_KIND,
  HERDR_DEFAULT_SOCKET_PATH,
  normalizeHerdrSocketPath,
} from "./local-agent-herdr.js";

function catalogSnapshotIsFresh(fetchedAt: string | undefined, expiresAt: string | undefined): boolean {
  const fetched = Date.parse(fetchedAt ?? "");
  const expires = expiresAt ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(fetched) && fetched <= Date.now() && (!expiresAt || (Number.isFinite(expires) && Date.now() < expires));
}

// ─── Error codes ────────────────────────────────────────────────────────────

export type AgentErrorCode =
  | "UNKNOWN_WORKSPACE"
  | "UNKNOWN_PROFILE"
  | "PROFILE_DISABLED"
  | "UNTRACKED_REPOSITORY_PROFILE"
  | "PROFILE_AUTHORITY_CONFLICT"
  | "PROVIDER_DISABLED"
  | "PROVIDER_UNAVAILABLE"
  | "EXACT_MODEL_UNAVAILABLE"
  | "VARIANT_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN_AGENT"
  | "AGENT_WORKSPACE_MISMATCH"
  | "AGENT_ALREADY_RUNNING"
  | "AGENT_TERMINATION_PENDING"
  | "AGENT_LIFECYCLE_CORRUPT"
  | "AGENT_LIFECYCLE_UNSUPPORTED"
  | "INVALID_WAIT_MS"
  | "WORKER_LAUNCH_FAILED"
  | "WORKER_TERMINATION_FAILED"
  | "STALE_WORKSPACE"
  | "NO_EXECUTION_CAPACITY"
  | "TOOLCHAIN_UNAVAILABLE"
  | "INVALID_EXECUTION_CONTRACT"
  | "OVERLAPPING_MUTATION_OWNERSHIP"
  | "INVALID_ATTEMPT_KEY"
  | "ATTEMPT_REPLAY_CONFLICT"
  | "CONTINUATION_ADMISSION_FAILED"
  | "NEXUS_AUTHORITY_REJECTED"
  | "REBIND_REQUIRED"
  | "DISPATCH_CONTRACT_REJECTED"
  | "MODEL_ATTESTATION_MISMATCH";

export class AgentSessionError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentSessionError";
  }
}

/** Raised when the worker workspace fails the canonical containment gate. */
export class WorkspaceContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceContainmentError";
  }
}

/**
 * Canonical containment gate for worker execution: the workspace root must
 * resolve to its canonical physical path and stay inside one configured
 * allowed root. Git linked worktrees are legitimate: their canonical path is
 * the linked worktree itself, which may be a configured allowed root.
 */
function assertWorkspaceContainment(config: ServerConfig, workspaceRoot: string): void {
  let canonical: string;
  try {
    canonical = canonicalizePath(workspaceRoot);
  } catch (error) {
    throw new Error(
      `Workspace root could not be canonicalized: ${workspaceRoot} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const roots = config.allowedRoots ?? [];
  const contained = roots.some((root) => isPathInsideRoot(canonical, canonicalizePath(root)));
  if (roots.length > 0 && !contained) {
    throw new Error(
      `Workspace root ${canonical} is outside every configured allowed root; refusing to run a worker against it.`,
    );
  }
}

// ─── Input / Output types ────────────────────────────────────────────────────

export interface StartAgentInput {
  workspaceId: string;
  workspaceRoot: string;
  profileName: string;
  prompt: string;
  profiles: LocalAgentProfile[];
  profileCatalog?: ProfileCatalog;
  executionContract?: ExecutionContract;
  attemptKey?: string;
}

export interface ContinueAgentInput {
  workspaceId: string;
  workspaceRoot: string;
  agentId: string;
  prompt: string;
  /** Omitted means resolve the new turn from current profile/provider policy. */
  idleTimeoutMode?: "EXPLICIT_OVERRIDE";
  idleTimeoutMs?: number;
  profiles?: LocalAgentProfile[];
  profileCatalog?: ProfileCatalog;
  opencodeCatalog?: OpencodeCatalogSnapshot;
  clineCatalog?: ClineCatalogSnapshot;
}

export interface GetAgentStatusInput {
  workspaceId: string;
  workspaceRoot: string;
  agentId: string;
  waitMs?: number;
}

export interface CancelAgentInput {
  workspaceId: string;
  workspaceRoot: string;
  agentId: string;
}

export interface ListAgentsInput {
  workspaceId: string;
  workspaceRoot?: string;
  limit?: number;
}

export const AGENT_STATUS_MAX_WAIT_MS = 15_000;
export const AGENT_LIST_DEFAULT_LIMIT = 20;
export const AGENT_LIST_MAX_LIMIT = 100;
const TERMINATION_RETRY_BACKOFF_MS = 30_000;

export interface DispatchContractOutput {
  taskId: string;
  attemptId: string;
  roleIntent: string;
  claimCeiling: string;
  verificationRequired: boolean;
  exclusiveOwnership: boolean;
  intentHash: string;
}

export interface AgentRuntimeOutput {
  runtimeKind: "HERDR";
  socketPath: string;
  workspaceId: string;
  paneId: string;
  agentIdentity: string;
  agentKind: HerdrAgentKind;
}

export interface AgentStatusOutput {
  agentId: string;
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  effort?: string;
  providerSessionId?: string;
  status: LocalAgentStatus;
  terminal: boolean;
  latestResponse?: string;
  error?: string;
  errorCode?: string;
  errorRetryable?: boolean;
  errorDetails?: AgentProviderFailureDetails;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  lastActivityAt?: string;
  lastFileMutationAt?: number;
  wallMs?: number;
  idleMs?: number;
  changedPaths?: string[];
  terminalReason?: AgentTerminalReason;
  scopeState?: ScopeState;
  dispatch?: DispatchContractOutput;
  executionIdlePolicy?: EffectiveExecutionIdlePolicy;
  effectEnforcementReceipt?: LocalEffectEnforcementReceipt;
  lineage?: {
    role?: "IMPLEMENT" | "REPAIR" | "VERIFY" | "RECONCILE";
    parentEffectKey?: string;
    supersedes?: string;
  };
  automatedVerifierResult?: Record<string, unknown>;
  automatedVerifierEffects?: Record<string, Record<string, unknown>>;
  automatedVerifierPlan?: Record<string, unknown>;
  automatedVerifierPlans?: Record<string, Record<string, unknown>>;
  /** P2-H: Operation timeline tracking elapsed phases. */
  operationTimeline?: OperationTimeline;
  /** P2-A: Model attestation detailing requested, resolved, and physically observed model identities. */
  modelAttestation?: ModelAttestation;
  /** P2-E/F: Structured dispatch/turn failure classification. */
  dispatchFailure?: DispatchFailureClassification;
  /** P2-D: Separate provider child process state from dispatcher heartbeat. */
  providerProcessState?: "running" | "not_running" | "unknown";
  /** P2-D: Dedicated dispatcher heartbeat timestamp. */
  dispatcherHeartbeatAt?: string;
  /** P2-G: Effect policy enforcement breakdown. */
  effectPolicyStatus?: {
    process: "enforced" | "request_only" | "unknown";
    network: "enforced" | "request_only" | "unknown";
    git: "enforced" | "request_only" | "unknown";
    toolCeiling: "enforced" | "request_only" | "unknown";
    overallEnforcement: "PHYSICALLY_ENFORCED" | "REQUEST_ONLY_NOT_ENFORCED" | "UNKNOWN";
  };
  termination?: {
    pending: boolean;
    generation?: string;
    requestedAt?: string;
    failure?: string;
    corrupt?: boolean;
    blocked?: boolean;
    reason?: string;
  };
  herdrHandle?: HerdrExternalHandle;
  runtime?: AgentRuntimeOutput;
}

export interface ReconcileAgentInput {
  workspaceId: string;
  workspaceRoot: string;
  isolated: boolean;
  agentId: string;
}

export interface ReconcileAgentOutput {
  agentId: string;
  herdrHandle?: HerdrExternalHandle;
  runtime?: AgentRuntimeOutput;
  dispatch?: DispatchContractOutput;
  agentState: LocalAgentStatus;
  providerState?: string;
  providerSessionId?: string;
  terminalReason?: AgentTerminalReason;
  effectEnforcementReceipt?: LocalEffectEnforcementReceipt;
  workspace: {
    head?: string;
    dirty: boolean;
  };
  candidate: {
    present: boolean;
    changedPaths: string[];
    unexpectedPaths: string[];
    diffHash?: string;
    scopeState: ScopeState;
  };
  activity: {
    startedAt: string;
    lastActivityAt: string;
    lastFileMutationAt?: number;
    wallMs: number;
    idleMs: number;
  };
}

export type ReadinessValue = boolean | "unknown";

export type DispatchReadinessState = "READY" | "BLOCKED" | "UNKNOWN";

export interface AgentPreflightInput {
  workspaceId: string;
  workspaceRoot: string;
  isolated: boolean;
  profileName: string;
  profiles: LocalAgentProfile[];
  profileCatalog?: ProfileCatalog;
  toolchainId?: string;
}

export interface AgentPreflightOutput {
  workspace: {
    workspaceId: string;
    root: string;
    head?: string;
    dirty: boolean;
    isolated: boolean;
  };
  worker: {
    profile: string;
    provider: string;
    model?: string;
    effort?: string;
    executionIdentity: string;
    runtimeVersion?: string;
    executionGeneration?: ExecutionGenerationBinding;
  };
  readiness: {
    profileResolved: boolean;
    providerConfigured: boolean;
    authReady: ReadinessValue;
    providerReachable: ReadinessValue;
    runtimeReady: boolean;
    capacityAvailable: boolean;
    dispatchState: DispatchReadinessState;
  };
  capacity: {
    used: number;
    max?: number;
    activeInWorkspace: number;
    activeOtherWorkspaces: number;
    localState: "AVAILABLE" | "EXHAUSTED";
    providerState: "UNKNOWN";
    liveActive?: number;
    unreconciledStale?: number;
  };
  toolchain: {
    id: string;
    available: boolean;
    executables?: Record<string, string>;
  };
  blockers: Array<{ code: string; detail: string }>;
  unknowns: string[];
}

export function summarizeExecutionCapacity(
  used: number,
  configuredMax: number | undefined | null,
  activeInWorkspace: number,
  liveActive?: number,
  unreconciledStale?: number,
): AgentPreflightOutput["capacity"] {
  const boundedMax = configuredMax !== undefined && configuredMax !== null && configuredMax > 0
    ? configuredMax
    : undefined;
  return {
    used,
    ...(boundedMax === undefined ? {} : { max: boundedMax }),
    activeInWorkspace,
    activeOtherWorkspaces: Math.max(0, used - activeInWorkspace),
    localState: boundedMax !== undefined && used >= boundedMax ? "EXHAUSTED" : "AVAILABLE",
    providerState: "UNKNOWN",
    ...(liveActive !== undefined ? { liveActive } : {}),
    ...(unreconciledStale !== undefined ? { unreconciledStale } : {}),
  };
}

export interface AgentSummary {
  agentId: string;
  profileName: string;
  provider: string;
  model?: string;
  effort?: string;
  status: LocalAgentStatus;
  terminationPending?: boolean;
  terminationBlocked?: boolean;
  updatedAt: string;
}

interface LifecycleEvidence {
  startedAt: string;
  lastActivityAt: string;
  lastFileMutationAt?: number;
  wallMs: number;
  idleMs: number;
  changedPaths?: string[];
  terminalReason?: AgentTerminalReason;
  scopeState?: ScopeState;
}

function computeSessionTiming(record: LocalAgentRecord, now = Date.now()): { wallMs: number; idleMs: number } {
  const createdAtMs = Date.parse(record.createdAt);
  const terminalStable = isTerminalStatus(record.status) &&
    !record.lifecycleState?.terminationPending &&
    !record.lifecycleState?.lifecycleCorrupt &&
    !record.lifecycleState?.terminationBlocked;
  // updatedAt is the row-mutation clock, not an execution clock: reconciliation
  // and dispatcher-heartbeat writes may legitimately advance it after a turn is
  // terminal. Use explicit lifecycle clocks when available and keep updatedAt
  // only as a compatibility fallback for legacy rows.
  const terminalAtMs = Date.parse(record.lifecycleState?.operationTimeline?.terminalAt ?? record.updatedAt);
  const lastActivityAtMs = Date.parse(record.lifecycleState?.activeTurn?.lastActivityAt ?? record.updatedAt);
  const referenceMs = terminalStable ? terminalAtMs : now;
  return {
    wallMs: Math.max(0, referenceMs - createdAtMs),
    idleMs: terminalStable ? 0 : Math.max(0, now - lastActivityAtMs),
  };
}

export interface StartAgentOutput {
  agentId: string;
  dispatch?: DispatchContractOutput;
  status: LocalAgentStatus;
  profileName: string;
  provider: string;
  model?: string;
  effort?: string;
  workspaceId?: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  executionIdlePolicy?: EffectiveExecutionIdlePolicy;
  herdrHandle?: HerdrExternalHandle;
  runtime?: AgentRuntimeOutput;
}

export interface ContinueAgentOutput extends StartAgentOutput {
  continued: true;
}

// ─── Worker launcher type ────────────────────────────────────────────────────

/**
 * Async contract: resolves when the worker process has successfully spawned,
 * rejects if the OS-level spawn fails. Does NOT wait for the worker to finish.
 */
export type WorkerLauncher = (
  agentId: string,
  promptFile: string,
  workerToken: string,
) => Promise<number | void>;
export type WorkerTerminator = (record: LocalAgentRecord) => Promise<boolean>;
export type AgentTurnRunner = (
  profile: LocalAgentProfile | undefined,
  record: LocalAgentRecord,
  prompt: string,
  callbacks?: LocalAgentRunCallbacks,
) => Promise<LocalAgentRunResult>;

export type NexusGrantResolver = (ref: NexusExecutionGrantRef) => Promise<NexusExecutionGrant>;

// ─── Owned temp cleanup ──────────────────────────────────────────────────────

/**
 * Secure cleanup of a prompt temp file and its owned parent directory.
 *
 * Only removes files that match the owned-temp contract:
 *   - resolved parent is inside os.tmpdir()
 *   - parent basename matches devspace-agent-prompt-*
 *   - file basename is exactly prompt.txt
 *
 * Does NOT throw; best-effort only.
 */
function cleanupOwnedPromptFile(promptFile: string): void {
  try {
    const resolvedFile = resolvePath(promptFile);
    const parentDir = dirname(resolvedFile);
    const resolvedParent = resolvePath(parentDir);
    const resolvedTmpdir = resolvePath(tmpdir());

    // parent must be a direct child of tmpdir() (not nested deeper)
    if (dirname(resolvedParent) !== resolvedTmpdir) return;
    if (!basename(resolvedParent).startsWith("devspace-agent-prompt-")) return;
    if (basename(resolvedFile) !== "prompt.txt") return;

    try { unlinkSync(resolvedFile); } catch { /* ignore */ }
    try { rmdirSync(resolvedParent); } catch { /* ignore */ }
  } catch {
    // Best-effort: never throw from cleanup
  }
}

// ─── Main class ─────────────────────────────────────────────────────────────

export class LocalAgentSessionManager {
  private readonly store: LocalAgentStore;
  private readonly launcher: WorkerLauncher;
  private readonly terminator: WorkerTerminator;
  private readonly turnRunner?: AgentTurnRunner;
  private readonly runtimeBuildIdentity: RuntimeBuildIdentity;
  private capabilityManifestSha256?: string;
  private readonly nexusGrantResolver: NexusGrantResolver;
  private readonly clineCatalogService?: ClineCatalogService;
  private readonly opencodeCatalogSource: ReturnType<typeof createMcpOpencodeCatalogSource>;
  private readonly ownsOpencodeCatalogSource: boolean;
  private readonly herdrGateway: HerdrThinGateway;
  private readonly herdrHandles = new Map<string, HerdrExternalHandle>();
  private readonly herdrTurnTasks = new Map<string, Promise<void>>();
  private readonly herdrVerifierTasks = new Map<string, Promise<Record<string, unknown>>>();
  private readonly herdrVerifiedLive = new Set<string>();
  private closed = false;
  private readonly terminationAttempts = new Map<string, Promise<boolean>>();
  private workResumeStore?: WorkResumeStore;
  private readonly toolchainVerifier: typeof runToolchainVerifier;

  constructor(
    private readonly config: ServerConfig,
    testLauncher?: WorkerLauncher,
    testTerminator?: WorkerTerminator,
    testTurnRunner?: AgentTurnRunner,
    runtimeBuildIdentity?: RuntimeBuildIdentity,
    nexusGrantResolver?: NexusGrantResolver,
    clineCatalogService?: ClineCatalogService,
    opencodeCatalogSource?: ReturnType<typeof createMcpOpencodeCatalogSource>,
    herdrGateway?: HerdrThinGateway,
    workResumeStore?: WorkResumeStore,
    testToolchainVerifier?: typeof runToolchainVerifier,
  ) {
    this.store = createLocalAgentStore(config.stateDir);
    this.launcher = testLauncher ?? defaultWorkerLauncher;
    this.terminator = testTerminator ?? terminateOwnedWorker;
    this.turnRunner = testTurnRunner;
    this.nexusGrantResolver = nexusGrantResolver ?? resolveCanonicalNexusExecutionGrant;
    this.clineCatalogService = clineCatalogService ?? new ClineCatalogServiceImpl();
    this.opencodeCatalogSource = opencodeCatalogSource ?? createMcpOpencodeCatalogSource();
    this.ownsOpencodeCatalogSource = opencodeCatalogSource === undefined;
    this.herdrGateway = herdrGateway ?? new HerdrThinGateway(HERDR_DEFAULT_SOCKET_PATH, defaultHerdrGatewayRegistry, this.store);
    this.workResumeStore = workResumeStore;
    this.toolchainVerifier = testToolchainVerifier ?? runToolchainVerifier;
    this.runtimeBuildIdentity = runtimeBuildIdentity ?? describeRuntimeBuildIdentity({
      env: process.env,
      listenPort: config.port,
      configRoot: devspaceConfigDir(process.env),
      stateRoot: config.stateDir,
      profileCatalogGeneration: "unresolved",
    });
  }

  setWorkResumeStore(workResumeStore: WorkResumeStore): void {
    this.workResumeStore = workResumeStore;
  }

  bindCapabilityManifestSha256(manifestSha256: string): void {
    if (!/^[0-9a-f]{64}$/.test(manifestSha256)) {
      throw new AgentSessionError("INVALID_EXECUTION_CONTRACT", "Capability manifest digest must be lowercase 64-hex.");
    }
    this.capabilityManifestSha256 = manifestSha256;
  }

  /** Close the manager's durable store. Safe to call from multiple cleanup paths. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store.close();
    if (this.ownsOpencodeCatalogSource) this.opencodeCatalogSource.close();
  }


  /**
   * Bind an immutable HerdrExternalHandle to an active agent record.
   * Enforces N1 (duplicate prevention), N2 (conflicting replay prevention),
   * and N8 (REQUEST_ONLY_NOT_ENFORCED).
   * Enforces B1 (provider_session_id remains native provider identity)
   * and B2 (first-class store CAS persistence without private DB bypass).
   */
  bindHerdrExternalHandle(agentId: string, handle: HerdrExternalHandle): void {
    const record = this.store.getById(agentId);
    if (!record) {
      throw new AgentSessionError("UNKNOWN_AGENT", `Unknown agent id: ${agentId}`);
    }
    if (record.startReplay?.key && record.startReplay.key !== handle.attemptKey) {
      throw new AgentSessionError(
        "ATTEMPT_REPLAY_CONFLICT",
        `Cannot bind handle with attemptKey '${handle.attemptKey}' to agent ${agentId} bound to attemptKey '${record.startReplay.key}'`,
      );
    }
    if ((handle.enforcementState as string) === "PHYSICALLY_ENFORCED") {
      throw new AgentSessionError(
        "INVALID_EXECUTION_CONTRACT",
        `HerdR runtime handle cannot claim PHYSICALLY_ENFORCED; enforcement state must be REQUEST_ONLY_NOT_ENFORCED`,
      );
    }

    handle.agentId = agentId;

    // B1 / B2: Durable persistence via store CAS. Fail closed if CAS fails.
    const existingLaunch = record.externalRuntimeBinding?.launch;
    const cas = this.store.bindExternalRuntimeBindingCAS({
      agentId,
      expectedAttemptKey: handle.attemptKey,
      expectedDispatchIntentHash: handle.dispatchIntentHash,
      expectedUpdatedAt: record.updatedAt,
      binding: {
        runtimeKind: HERDR_RUNTIME_KIND,
        launch: existingLaunch ?? {
          state: "AGENT_OBSERVED",
          launchRequestId: `HERDR-LAUNCH:${handle.attemptKey}:${handle.dispatchIntentHash.slice(0, 16)}`,
          attemptKey: handle.attemptKey,
          dispatchIntentHash: handle.dispatchIntentHash,
          canonicalWorktreePath: handle.canonicalWorktreePath,
          gitHeadBefore: handle.gitHeadBefore,
          agentKind: handle.herdrAgentKind,
          herdrSocketPath: handle.herdrSocketPath,
          promptNonce: handle.promptNonce,
          herdrWorkspaceId: handle.herdrWorkspaceId,
          herdrPaneId: handle.herdrPaneId,
          herdrAgentIdentity: handle.herdrAgentIdentity,
          fencedAt: handle.launchTimestamp,
        },
        handle: handle as unknown as Record<string, unknown>,
      },
    });

    if (!cas.applied) {
      throw new AgentSessionError(
        "ATTEMPT_REPLAY_CONFLICT",
        `Failed to bind external runtime handle to agent ${agentId} due to durable CAS mismatch.`,
      );
    }

    defaultHerdrGatewayRegistry.registerHandle(handle);
    this.herdrHandles.set(agentId, handle);
  }

  /**
   * Retrieve a bound HerdrExternalHandle by exact durable agentId.
   *
   * attemptKey is only workspace-scoped replay identity. It is not a globally
   * unique handle key and must never be used to recover another record's
   * external runtime authority.
   */
  getHerdrExternalHandle(agentIdOrAttemptKey: string): HerdrExternalHandle | undefined {
    let rec = this.store.getById(agentIdOrAttemptKey);

    // Restart/recovery callers may know only attemptKey. That lookup is safe
    // only when it identifies exactly one durable record. attemptKey is scoped
    // to a physical workspace, so a multi-workspace collision must fail closed
    // rather than selecting the first record.
    if (!rec) {
      const matches = this.store.list().filter(
        (candidate) => candidate.startReplay?.key === agentIdOrAttemptKey,
      );
      if (matches.length !== 1) return undefined;
      rec = matches[0];
    }

    const binding = rec.externalRuntimeBinding;
    const rawHandle =
      binding?.runtimeKind === HERDR_RUNTIME_KIND &&
      binding.handle &&
      typeof binding.handle === "object" &&
      binding.handle.attemptKey
        ? binding.handle
        : undefined;

    if (rawHandle) {
      const handle = rawHandle as unknown as HerdrExternalHandle;
      handle.agentId = rec.id;
      defaultHerdrGatewayRegistry.registerHandle(handle);
      if (
        binding?.promptState?.consequentialPromptFenced &&
        binding.promptState.promptNonce === handle.promptNonce
      ) {
        defaultHerdrGatewayRegistry.markPromptSubmitted(
          handle.attemptKey,
          handle.promptNonce,
          handle.workspaceId,
        );
      }
      this.herdrHandles.set(rec.id, handle);
      return handle;
    }

    return this.herdrHandles.get(rec.id);
  }

  private usesHerdrBackend(): boolean {
    return this.config.agentExecutionBackend === "herdr";
  }

  private herdrAgentKind(provider: string): HerdrAgentKind {
    if (provider === "opencode" || provider === "agy" || provider === "codex" || provider === "cline" || provider === "grok") {
      return provider;
    }
    throw new AgentSessionError(
      "PROVIDER_UNAVAILABLE",
      `Provider '${provider}' is not enabled for the HerdR production backend.`,
    );
  }

  private runtimeOutput(handle: HerdrExternalHandle): AgentRuntimeOutput {
    return {
      runtimeKind: "HERDR",
      socketPath: handle.herdrSocketPath,
      workspaceId: handle.herdrWorkspaceId,
      paneId: handle.herdrPaneId,
      agentIdentity: handle.herdrAgentIdentity,
      agentKind: handle.herdrAgentKind,
    };
  }

  private herdrPromptTimeoutMs(record: LocalAgentRecord): number {
    const configured = record.executionContract?.maxExecutionMs ?? record.executionContract?.maxWallMs;
    return Math.max(30_000, Math.min(configured ?? 300_000, 300_000));
  }

  private async settleHerdrTurn(
    record: LocalAgentRecord,
    handle: HerdrExternalHandle,
    promptResult?: HerdrPromptResult,
  ): Promise<boolean> {
    const generation = record.lifecycleState?.activeTurn?.generation;
    if (!generation) return true;

    const reconciliation = await this.herdrGateway.reconcileExternalAgent(
      handle,
      record.executionContract?.writePaths,
      false,
      promptResult,
      { store: this.store },
    );
    if (!reconciliation.settled) {
      if (reconciliation.executionState === "RUNNING") {
        this.store.touchExternalRuntimeActivityCAS(record.id, generation);
        return false;
      }
      if (reconciliation.executionState === "BLOCKED") {
        const error = reconciliation.reason ?? "HerdR agent is blocked.";
        const errorCode = "BLOCKED_ON_PERMISSION_ADMISSION";
        const failureClassification = classifyDispatchFailure({
          ...record,
          status: "error",
          error,
          errorCode,
          scopeState: "UNKNOWN",
          updatedAt: new Date().toISOString(),
        });
        this.store.failExternalRuntimeTurnCAS({
          agentId: record.id,
          generation,
          error,
          errorCode,
          errorRetryable: false,
          latestResponse: promptResult?.paneOutput,
          terminalReason: "provider_error",
          scopeState: "UNKNOWN",
          dispatchFailure: failureClassification,
        });
        return true;
      }
      throw new AgentSessionError(
        "PROVIDER_UNAVAILABLE",
        reconciliation.reason ?? "HerdR execution outcome is unknown; retry is forbidden until reconciliation succeeds.",
      );
    }

    const physical = await inspectWorkspacePhysicalState(record.workspaceRoot);
    const delta = computeWorkerDelta(physical, record.scopeBaseline);
    const scope = this.classifyWorkerScope(
      delta.changedPaths,
      record.executionContract?.writePaths,
      record.executionContract?.maxFiles,
      delta.attribution,
    );
    const terminalScope = reconciliation.completionStatus === "SCOPE_VIOLATION"
      ? "SCOPE_VIOLATION"
      : reportableHerdrScopeState(scope.scopeState, reconciliation.enforcementState);
    const cumulative = Array.from(new Set([
      ...(record.lifecycleState?.cumulativeChangedPaths ?? []),
      ...delta.changedPaths,
    ])).sort();

    const automatedVerifierResults: Record<string, unknown>[] = [];
    for (const plan of this.buildHerdrVerifierPlans(record, generation)) {
      const result = await this.runHerdrTerminalVerifier(record, generation, physical, plan);
      if (!result) continue;
      automatedVerifierResults.push(result);
      if (result.effectState === "OUTCOME_UNKNOWN" || result.effectState === "RUNNING") break;
    }
    const automatedVerifierResult = automatedVerifierResults.at(-1);
    const blockingVerifierResult = automatedVerifierResults.find((result) =>
      result.effectState === "OUTCOME_UNKNOWN" || result.effectState === "RUNNING")
      ?? automatedVerifierResults.find((result) =>
        result.effectState === "COMPLETED" && result.passed === false);
    const verifierUnknown = blockingVerifierResult?.effectState === "OUTCOME_UNKNOWN"
      || blockingVerifierResult?.effectState === "RUNNING";
    const verifierFailed = blockingVerifierResult?.effectState === "COMPLETED"
      && blockingVerifierResult.passed === false;

    const isError = terminalScope === "SCOPE_VIOLATION" || verifierUnknown || verifierFailed;
    const herdrErrorMessage = terminalScope === "SCOPE_VIOLATION"
      ? `Agent modified paths outside authorized scope: ${scope.unexpectedPaths.join(", ")}`
      : verifierUnknown
        ? `Automated verifier effect ${String(blockingVerifierResult?.effectKey ?? "unknown")} has OUTCOME_UNKNOWN; continuation is blocked until that exact effect is reconciled.`
        : verifierFailed
          ? `Automated verifier ${String(blockingVerifierResult?.verifier ?? "unknown")} failed for effect ${String(blockingVerifierResult?.effectKey ?? "unknown")}.`
      : undefined;
    const herdrErrorCode = terminalScope === "SCOPE_VIOLATION"
      ? "SCOPE_VIOLATION"
      : verifierUnknown ? "VERIFIER_OUTCOME_UNKNOWN" : verifierFailed ? "VERIFIER_FAILED" : undefined;
    const requestedModel = record.executionContract?.directSelection?.model;
    const resolvedModel = record.model ?? undefined;
    const observedModel = (promptResult as any)?.observedModel ?? (handle as any)?.observedModel ?? null;
    const modelAttestation = computeModelAttestation({
      requestedModel,
      resolvedModel,
      observedModel,
      attestationSource: observedModel ? "herdr_observed" : undefined,
    });
    const failureClassification = isError ? classifyDispatchFailure({
      ...record,
      status: "error",
      error: herdrErrorMessage,
      errorCode: herdrErrorCode,
      scopeState: terminalScope,
      updatedAt: new Date().toISOString(),
    }) : undefined;

    const completed = this.store.finishExternalRuntimeTurnCAS({
      agentId: record.id,
      generation,
      status: isError ? "error" : "idle",
      providerSessionId: promptResult?.nativeProviderSessionId ?? handle.nativeProviderSessionId,
      latestResponse: promptResult?.finalResponse ?? promptResult?.paneOutput,
      error: herdrErrorMessage,
      errorCode: herdrErrorCode,
      errorRetryable: isError ? false : undefined,
      terminalReason: terminalScope === "SCOPE_VIOLATION"
        ? "scope_violation"
        : verifierUnknown ? "unknown" : verifierFailed ? "provider_error" : undefined,
      scopeState: terminalScope,
      cumulativeChangedPaths: cumulative,
      turnEndBaseline: {
        changedPaths: physical.changedPaths,
        head: physical.head ?? null,
        fingerprints: physical.fingerprints,
      },
      automatedVerifierResult,
      modelAttestation,
      dispatchFailure: failureClassification,
    });
    if (!completed.applied) {
      const current = this.store.getById(record.id);
      if (!current?.lifecycleState?.activeTurn) return true;
      throw new AgentSessionError(
        "AGENT_LIFECYCLE_CORRUPT",
        `HerdR turn for agent ${record.id} settled physically but durable completion CAS failed.`,
      );
    }
    return true;
  }

  /**
   * Run HerdR's mechanical verifier as its own durable VERIFY effect. The
   * RUNNING identity is committed before invoking the executable, so restart
   * after that fence reports OUTCOME_UNKNOWN and cannot rerun the command.
   */
  private buildHerdrVerifierPlan(
    record: LocalAgentRecord,
    generation: string,
  ): Record<string, unknown> | undefined {
    return this.buildHerdrVerifierPlans(record, generation)[0];
  }

  private buildHerdrVerifierPlans(
    record: LocalAgentRecord,
    generation: string,
  ): Record<string, unknown>[] {
    const contract = record.executionContract;
    const configuredToolchains = this.config.toolchains ?? [];
    const toolchainId = contract?.toolchainId
      ?? (configuredToolchains.length > 0 ? configuredToolchains[0]?.id : undefined);
    if (!toolchainId || !contract?.toolchainId ||
      (contract.role !== undefined && contract.role !== "IMPLEMENT" && contract.role !== "REPAIR")) {
      return [];
    }
    const toolchain = configuredToolchains.find((candidate) => candidate.id === toolchainId);
    const verifiers = Object.keys(toolchain?.verifiers ?? {}).sort();
    if (!toolchain || verifiers.length === 0) return [];

    const parentEffectKey = record.startReplay?.key ?? contract.dispatchIntent?.attemptId;
    if (!parentEffectKey) {
      throw new AgentSessionError(
        "AGENT_LIFECYCLE_CORRUPT",
        `HerdR verifier for agent ${record.id} has no durable parent effect identity.`,
      );
    }
    const parentRole = contract.role ?? "IMPLEMENT";
    return verifiers.map((verifier) => {
      const executable = toolchain.verifiers[verifier];
      const planKey = `verify-plan:${createHash("sha256")
        .update(JSON.stringify([parentEffectKey, parentRole, toolchainId, verifier, toolchain.root, executable]))
        .digest("hex")
        .slice(0, 40)}`;
      return {
        planKey,
        role: "VERIFY",
        parentEffectKey,
        parentRole,
        toolchainId,
        verifier,
        toolchainRoot: toolchain.root,
        executable,
        args: [],
        turnGeneration: generation,
      };
    });
  }

  /** Materialize the exact terminal candidate away from the worker's source. */
  private async prepareIsolatedHerdrVerifierWorkspace(
    record: LocalAgentRecord,
    physical: Awaited<ReturnType<typeof inspectWorkspacePhysicalState>>,
  ): Promise<{ root: string; directory: string }> {
    const sourceRoot = await realpath(record.workspaceRoot);
    const stateRoot = await realpath(this.config.stateDir);
    if (stateRoot === sourceRoot || stateRoot.startsWith(`${sourceRoot}${sep}`)) {
      throw new AgentSessionError(
        "AGENT_LIFECYCLE_CORRUPT",
        "Verifier state directory must be outside the source workspace.",
      );
    }
    if (!physical.head || !physical.diffHash) {
      throw new AgentSessionError(
        "AGENT_LIFECYCLE_CORRUPT",
        "Verifier candidate is missing an exact Git head or physical diff hash.",
      );
    }
    // The verifier may write its isolated Candidate copy, so keep that copy
    // outside durable state before denying writes to the state directory.
    const directory = await mkdtemp(join(tmpdir(), "herdr-verifier-"));
    const root = join(directory, "candidate");
    try {
      execFileSync("git", ["clone", "--quiet", "--local", "--shared", "--no-checkout", sourceRoot, root], {
        encoding: "utf8",
        timeout: 30_000,
      });
      execFileSync("git", ["-C", root, "update-ref", "HEAD", physical.head], { timeout: 15_000 });
      const sourceIndex = execFileSync(
        "git", ["-C", sourceRoot, "rev-parse", "--path-format=absolute", "--git-path", "index"],
        { encoding: "utf8", timeout: 15_000 },
      ).trim();
      await copyFile(sourceIndex, join(root, ".git", "index"), constants.COPYFILE_FICLONE);
      for (const name of await readdir(sourceRoot)) {
        if (name === ".git") continue;
        await cp(join(sourceRoot, name), join(root, name), {
          recursive: true,
          verbatimSymlinks: true,
          mode: constants.COPYFILE_FICLONE,
        });
      }
      const [original, isolated] = await Promise.all([
        inspectWorkspacePhysicalState(sourceRoot),
        inspectWorkspacePhysicalState(root),
      ]);
      if (
        original.head !== physical.head || original.diffHash !== physical.diffHash ||
        isolated.head !== physical.head || isolated.diffHash !== physical.diffHash ||
        JSON.stringify(isolated.changedPaths) !== JSON.stringify(physical.changedPaths)
      ) {
        throw new AgentSessionError(
          "AGENT_LIFECYCLE_CORRUPT",
          "Verifier isolation copy does not match the exact terminal candidate snapshot.",
        );
      }
      return { root, directory };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private async runHerdrTerminalVerifier(
    record: LocalAgentRecord,
    generation: string,
    physical: Awaited<ReturnType<typeof inspectWorkspacePhysicalState>>,
    planned?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const plan = planned ?? this.buildHerdrVerifierPlan(record, generation);
    if (!plan) return undefined;

    const parentEffectKey = String(plan.parentEffectKey);
    const toolchainId = String(plan.toolchainId);
    const verifier = String(plan.verifier);
    const configuredToolchains = this.config.toolchains ?? [];
    const current = this.store.getById(record.id);
    const currentPlan = current?.lifecycleState?.automatedVerifierPlans?.[String(plan.planKey)]
      ?? (current?.lifecycleState?.automatedVerifierPlan?.planKey === plan.planKey
        ? current?.lifecycleState?.automatedVerifierPlan
        : undefined);
    const ledger = current?.lifecycleState?.automatedVerifierEffects ?? {};
    const planMatches = currentPlan?.planKey === plan.planKey
      && currentPlan?.turnGeneration === generation
      && currentPlan?.parentEffectKey === parentEffectKey
      && currentPlan?.toolchainId === toolchainId
      && currentPlan?.verifier === verifier;
    const boundCandidate = planMatches && currentPlan?.boundCandidate && typeof currentPlan.boundCandidate === "object"
      ? currentPlan.boundCandidate as Record<string, unknown>
      : undefined;
    const boundEffectKey = typeof boundCandidate?.effectKey === "string" ? boundCandidate.effectKey : undefined;
    const existingBoundEffect = boundEffectKey
      ? ledger[boundEffectKey]
        ?? (current?.lifecycleState?.automatedVerifierResult?.effectKey === boundEffectKey
          ? current.lifecycleState.automatedVerifierResult
          : undefined)
      : undefined;
    if (existingBoundEffect) {
      if (existingBoundEffect.effectState !== "RUNNING") return existingBoundEffect;
      const inFlight = this.herdrVerifierTasks.get(`${record.id}:${boundEffectKey}`);
      if (inFlight) return inFlight;
      return this.reconcileOrSettleHerdrVerifier(record.id, generation, existingBoundEffect);
    }

    // Older records may have persisted RUNNING before candidate binding existed.
    // Only the same durable turn generation can be classified from that record;
    // completed effects from earlier turns do not suppress a new candidate.
    const unboundRunningEffect = Object.values(ledger).find((effect) =>
      effect.planKey === plan.planKey
      && effect.turnGeneration === generation
      && effect.effectState === "RUNNING",
    );
    if (unboundRunningEffect) {
      return this.reconcileOrSettleHerdrVerifier(record.id, generation, unboundRunningEffect);
    }
    const physicalSnapshot = {
      head: physical.head ?? null,
      diffHash: physical.diffHash ?? null,
      changedPaths: [...physical.changedPaths].sort(),
      fingerprints: physical.fingerprints ?? {},
    };
    let sourceSnapshot = physicalSnapshot;
    let effectKey: string;
    if (planMatches) {
      const stored = currentPlan?.boundCandidate;
      if (stored && typeof stored === "object" && typeof (stored as Record<string, unknown>).effectKey === "string") {
        sourceSnapshot = (stored as Record<string, unknown>).sourceSnapshot as typeof physicalSnapshot;
        effectKey = String((stored as Record<string, unknown>).effectKey);
      } else {
        const candidateSourceHash = createHash("sha256").update(JSON.stringify(physicalSnapshot)).digest("hex");
        const material = {
          role: "VERIFY",
          planKey: plan.planKey,
          parentEffectKey,
          parentRole: plan.parentRole,
          toolchainId,
          verifier,
          toolchainRoot: plan.toolchainRoot,
          executable: plan.executable,
          args: plan.args,
          sourceSnapshot: physicalSnapshot,
        };
        const candidateKey = `verify:${createHash("sha256")
          .update(JSON.stringify(material))
          .digest("hex")
          .slice(0, 40)}`;
        const candidate = {
          effectKey: candidateKey,
          sourceSnapshot: physicalSnapshot,
          sourceSnapshotSha256: candidateSourceHash,
          semanticMaterialSha256: createHash("sha256").update(JSON.stringify(material)).digest("hex"),
        };
        const bound = this.store.bindExternalRuntimeVerifierCandidateCAS({
          agentId: record.id,
          generation,
          planKey: String(plan.planKey),
          candidate,
        });
        const afterBind = bound.current?.lifecycleState?.automatedVerifierPlans?.[String(plan.planKey)]
          ?? (bound.current?.lifecycleState?.automatedVerifierPlan?.planKey === plan.planKey
            ? bound.current?.lifecycleState?.automatedVerifierPlan
            : undefined);
        const persisted = afterBind?.boundCandidate;
        if (!bound.applied || !persisted || typeof persisted !== "object") {
          throw new AgentSessionError(
            "AGENT_LIFECYCLE_CORRUPT",
            `HerdR verifier candidate for plan ${String(plan.planKey)} could not be durably bound before launch.`,
          );
        }
        sourceSnapshot = (persisted as Record<string, unknown>).sourceSnapshot as typeof physicalSnapshot;
        effectKey = String((persisted as Record<string, unknown>).effectKey);
      }
    } else {
      const material = {
        role: "VERIFY",
        planKey: plan.planKey,
        parentEffectKey,
        parentRole: plan.parentRole,
        toolchainId,
        verifier,
        toolchainRoot: plan.toolchainRoot,
        executable: plan.executable,
        args: plan.args,
        sourceSnapshot: physicalSnapshot,
      };
      effectKey = `verify:${createHash("sha256")
        .update(JSON.stringify(material))
        .digest("hex")
        .slice(0, 40)}`;
    }
    const sourceSnapshotSha256 = createHash("sha256").update(JSON.stringify(sourceSnapshot)).digest("hex");
    if (effectKey === parentEffectKey) {
      throw new AgentSessionError("AGENT_LIFECYCLE_CORRUPT", "Verifier lineage cycle: effectKey equals parentEffectKey.");
    }
    const taskKey = `${record.id}:${effectKey}`;
    const identity = {
      effectKind: "toolchain-verifier",
      effectKey,
      role: "VERIFY",
      planKey: plan.planKey,
      parentEffectKey,
      parentRole: plan.parentRole,
      turnGeneration: generation,
      toolchainId,
      verifier,
      toolchainRoot: plan.toolchainRoot,
      executable: plan.executable,
      args: plan.args,
      sourceSnapshotSha256,
      workspaceHead: sourceSnapshot.head,
      diffHash: sourceSnapshot.diffHash,
      changedPaths: sourceSnapshot.changedPaths,
    };
    const existing = ledger[effectKey]
      ?? (current?.lifecycleState?.automatedVerifierResult?.effectKey === effectKey
        ? current.lifecycleState.automatedVerifierResult
        : undefined);
    if (existing) {
      if (existing.effectState !== "RUNNING") return existing;
      const inFlight = this.herdrVerifierTasks.get(taskKey);
      if (inFlight) return inFlight;
      return this.reconcileOrSettleHerdrVerifier(record.id, generation, existing);
    }

    const unresolved = Object.values(ledger).find((effect) =>
      effect.effectState === "RUNNING" || effect.effectState === "OUTCOME_UNKNOWN");
    if (unresolved) {
      const blocked = {
        ...identity,
        effectState: "OUTCOME_UNKNOWN",
        completedAt: new Date().toISOString(),
        reason: `A prior verifier effect ${String(unresolved.effectKey ?? "unknown")} remains unresolved; no verifier command was launched.`,
      };
      const recorded = this.store.beginExternalRuntimeVerifierCAS({
        agentId: record.id,
        generation,
        effectKey,
        result: blocked,
      });
      if (recorded.applied) this.persistHerdrVerifierResult(record, blocked);
      return recorded.current?.lifecycleState?.automatedVerifierEffects?.[effectKey] ?? blocked;
    }

    const pending = {
      ...identity,
      effectState: "RUNNING",
      startedAt: new Date().toISOString(),
    };
    if (!planMatches) {
      const unknown = {
        ...identity,
        effectState: "OUTCOME_UNKNOWN",
        completedAt: new Date().toISOString(),
        reason: "No matching durable verifier obligation was recorded before provider execution; absence does not establish that the verifier did not run.",
      };
      const recorded = this.store.beginExternalRuntimeVerifierCAS({
        agentId: record.id,
        generation,
        effectKey,
        result: unknown,
      });
      if (!recorded.applied) {
        const durable = this.store.getById(record.id)?.lifecycleState?.automatedVerifierEffects?.[effectKey];
        if (durable) return durable;
        throw new AgentSessionError(
          "AGENT_LIFECYCLE_CORRUPT",
          `HerdR verifier effect ${effectKey} lacks its pre-execution obligation and could not be durably marked unknown.`,
        );
      }
      this.persistHerdrVerifierResult(record, unknown);
      return unknown;
    }

    const claimed = this.store.beginExternalRuntimeVerifierCAS({
      agentId: record.id,
      generation,
      effectKey,
      result: pending,
    });
    if (!claimed.applied) {
      const latest = this.store.getById(record.id);
      const durable = latest?.lifecycleState?.automatedVerifierResult;
      if (durable?.effectKey === effectKey && durable.effectState !== "RUNNING") return durable;
      const inFlight = this.herdrVerifierTasks.get(taskKey);
      if (durable?.effectKey === effectKey && inFlight) return inFlight;
      if (durable?.effectKey === effectKey && durable.effectState === "RUNNING") {
        return this.reconcileOrSettleHerdrVerifier(record.id, generation, durable);
      }
      throw new AgentSessionError(
        "AGENT_LIFECYCLE_CORRUPT",
        `HerdR verifier effect ${effectKey} could not be durably claimed; command was not started.`,
      );
    }
    if (!claimed.started) {
      const durable = claimed.current?.lifecycleState?.automatedVerifierResult ?? pending;
      const inFlight = this.herdrVerifierTasks.get(taskKey);
      if (inFlight) return inFlight;
      if (durable.effectState !== "RUNNING") return durable;
      return this.reconcileOrSettleHerdrVerifier(record.id, generation, durable);
    }

    this.persistHerdrVerifierResult(record, pending);
    const task = (async (): Promise<Record<string, unknown>> => {
      let result: Record<string, unknown>;
      try {
        const isolated = await this.prepareIsolatedHerdrVerifierWorkspace(record, physical);
        let verification: ToolchainVerificationResult;
        try {
          verification = await this.toolchainVerifier({
            toolchains: configuredToolchains,
            toolchainId,
            verifier,
            args: [],
            cwd: isolated.root,
            denyWriteRoots: [record.workspaceRoot, this.config.stateDir],
          });
        } finally {
          await rm(isolated.directory, { recursive: true, force: true });
        }
        const sourceAfter = await inspectWorkspacePhysicalState(record.workspaceRoot);
        const sourceMutationDetected = sourceAfter.head !== sourceSnapshot.head
          || sourceAfter.diffHash !== sourceSnapshot.diffHash
          || JSON.stringify(sourceAfter.changedPaths) !== JSON.stringify(sourceSnapshot.changedPaths);
        result = {
          ...identity,
          effectState: "COMPLETED",
          completedAt: new Date().toISOString(),
          exitCode: verification.exitCode,
          passed: verification.exitCode === 0 && !sourceMutationDetected,
          durationMs: verification.durationMs,
          timedOut: verification.timedOut,
          launchFailed: Boolean(verification.launchError),
          sourceIsolation: "ISOLATED_COPY_SANDBOXED_ORIGINAL",
          sourceMutationDetected,
          stdout: verification.stdout,
          stderr: verification.stderr,
        };
      } catch (error) {
        result = {
          ...identity,
          effectState: "COMPLETED",
          completedAt: new Date().toISOString(),
          passed: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      // A restart between executable exit and the database CAS must reconcile
      // the same completed effect from this fsynced receipt, never rerun it.
      try {
        this.writeHerdrVerifierReceipt(record.id, generation, effectKey, result);
      } catch (error) {
        return this.settleUnknownHerdrVerifier(record.id, generation, identity, {
          ...pending,
          reason: `Verifier ran but its durable receipt could not be written: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const completed = this.store.finishExternalRuntimeVerifierCAS({
        agentId: record.id,
        generation,
        effectKey,
        result,
      });
      if (!completed.applied) {
        const durable = this.store.getById(record.id)?.lifecycleState?.automatedVerifierResult;
        if (durable?.effectKey === effectKey && durable.effectState !== "RUNNING") return durable;
        throw new AgentSessionError(
          "AGENT_LIFECYCLE_CORRUPT",
          `HerdR verifier ${effectKey} ran but its terminal outcome could not be durably recorded.`,
        );
      }
      this.persistHerdrVerifierResult(record, result);
      return result;
    })();
    this.herdrVerifierTasks.set(taskKey, task);
    try {
      return await task;
    } finally {
      if (this.herdrVerifierTasks.get(taskKey) === task) this.herdrVerifierTasks.delete(taskKey);
    }
  }

  private herdrVerifierReceiptPath(agentId: string, effectKey: string): { directory: string; path: string } {
    const directory = join(this.config.stateDir, "herdr-verifier-receipts");
    const name = createHash("sha256").update(JSON.stringify([agentId, effectKey])).digest("hex");
    return { directory, path: join(directory, `${name}.json`) };
  }

  private writeHerdrVerifierReceipt(
    agentId: string,
    generation: string,
    effectKey: string,
    result: Record<string, unknown>,
  ): void {
    const { directory, path } = this.herdrVerifierReceiptPath(agentId, effectKey);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const resultJson = JSON.stringify(result);
    const receipt = JSON.stringify({
      schema: "devspace.herdr_verifier_receipt.v1",
      agentId,
      generation,
      effectKey,
      result,
      resultSha256: createHash("sha256").update(resultJson).digest("hex"),
    });
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, receipt, { flag: "wx", mode: 0o600 });
      const file = openSync(temporary, "r");
      try { fsyncSync(file); } finally { closeSync(file); }
      renameSync(temporary, path);
      const parent = openSync(directory, "r");
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally {
      try { unlinkSync(temporary); } catch { /* rename consumed the temporary file */ }
    }
  }

  private reconcileOrSettleHerdrVerifier(
    agentId: string,
    generation: string,
    pending: Record<string, unknown>,
  ): Record<string, unknown> {
    const effectKey = String(pending.effectKey);
    const { path } = this.herdrVerifierReceiptPath(agentId, effectKey);
    let receipt: Record<string, unknown> | undefined;
    try {
      receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch { /* absent or malformed receipt leaves the effect unknown */ }
    const result = receipt?.result;
    if (
      receipt?.schema === "devspace.herdr_verifier_receipt.v1"
      && receipt.agentId === agentId
      && receipt.generation === generation
      && receipt.effectKey === effectKey
      && result && typeof result === "object" && !Array.isArray(result)
      && (result as Record<string, unknown>).effectState === "COMPLETED"
      && receipt.resultSha256 === createHash("sha256").update(JSON.stringify(result)).digest("hex")
    ) {
      const completed = this.store.finishExternalRuntimeVerifierCAS({
        agentId,
        generation,
        effectKey,
        result: result as Record<string, unknown>,
      });
      if (completed.applied) {
        if (completed.current) this.persistHerdrVerifierResult(completed.current, result as Record<string, unknown>);
        return result as Record<string, unknown>;
      }
    }
    return this.settleUnknownHerdrVerifier(agentId, generation, pending, pending);
  }

  private settleUnknownHerdrVerifier(
    agentId: string,
    generation: string,
    identity: Record<string, unknown>,
    pending: Record<string, unknown>,
  ): Record<string, unknown> {
    const unknown = {
      ...identity,
      ...pending,
      effectState: "OUTCOME_UNKNOWN",
      completedAt: new Date().toISOString(),
      reason: typeof pending.reason === "string"
        ? pending.reason
        : "A durable verifier start exists without a terminal result; command replay is forbidden.",
    };
    const settled = this.store.finishExternalRuntimeVerifierCAS({
      agentId,
      generation,
      effectKey: String(identity.effectKey),
      result: unknown,
    });
    if (settled.applied) {
      if (settled.current) this.persistHerdrVerifierResult(settled.current, unknown);
      return unknown;
    }
    const durable = this.store.getById(agentId)?.lifecycleState?.automatedVerifierResult;
    if (durable && durable.effectKey === identity.effectKey && durable.effectState !== "RUNNING") return durable;
    throw new AgentSessionError(
      "AGENT_LIFECYCLE_CORRUPT",
      `HerdR verifier ${String(identity.effectKey)} is unresolved and could not be recorded as unknown.`,
    );
  }

  private persistHerdrVerifierResult(record: LocalAgentRecord, result: Record<string, unknown>): void {
    const workKey = record.executionContract?.resumableWork?.workKey;
    if (!workKey || !this.workResumeStore) return;
    try {
      this.workResumeStore.recordAutomatedVerifierResult(workKey, result);
    } catch {
      // The lifecycle CAS is canonical for this external runtime. Preserve the
      // work-resume projection's existing best-effort behavior.
    }
  }

  private async runHerdrTurn(agentId: string, prompt: string): Promise<void> {
    const initial = this.store.getById(agentId);
    if (!initial) return;
    const generation = initial.lifecycleState?.activeTurn?.generation;
    if (!generation) return;

    try {
      assertWorkspaceContainment(this.config, initial.workspaceRoot);
      const baseline = await inspectWorkspacePhysicalState(initial.workspaceRoot);
      let handle = this.getHerdrExternalHandle(initial.id);
      if (!handle) {
        const attemptKey = initial.startReplay?.key;
        const dispatchIntent = initial.executionContract?.dispatchIntent;
        if (!attemptKey || !dispatchIntent) {
          throw new AgentSessionError(
            "INVALID_EXECUTION_CONTRACT",
            "HERDR backend requires durable attemptKey and executionContract.dispatchIntent before external launch.",
          );
        }
        if (!await this.herdrGateway.probeReady()) {
          throw new AgentSessionError(
            "PROVIDER_UNAVAILABLE",
            `HerdR daemon is unavailable at ${HERDR_DEFAULT_SOCKET_PATH}; legacy fallback is forbidden.`,
          );
        }
        handle = await this.herdrGateway.startExternalAgent({
          agentId: initial.id,
          workspaceId: initial.workspaceId ?? "",
          attemptKey,
          dispatchIntentHash: hashDispatchIntent(dispatchIntent),
          canonicalWorktreePath: initial.workspaceRoot,
          agentKind: this.herdrAgentKind(initial.provider),
          requestedModel: initial.model,
          requestedEffort: initial.effort,
          requestedCliProviderId: initial.executionContract?.directSelection?.cliProviderId,
          writeMode: initial.executionContract?.writePaths?.length ? "allowed" : "read_only",
          selectedToolIntents: initial.executionContract?.toolProjectionManifest?.selectedTools,
          store: this.store,
        });
        this.bindHerdrExternalHandle(initial.id, handle);
      }

      const nonce = handle.promptNonce === `HERDR-DISPATCH-${handle.attemptKey}`
        && !initial.externalRuntimeBinding?.promptState?.consequentialPromptFenced
        ? handle.promptNonce
        : `HERDR-TURN-${generation}`;
      const claimed = this.store.claimExternalRuntimeTurnCAS({
        agentId: initial.id,
        generation,
        promptNonce: nonce,
        scopeBaseline: {
          changedPaths: baseline.changedPaths,
          head: baseline.head ?? null,
          fingerprints: baseline.fingerprints,
        },
      });
      if (!claimed.applied) {
        throw new AgentSessionError(
          "CONTINUATION_ADMISSION_FAILED",
          `HerdR turn for agent ${initial.id} lost its durable claim before prompt.`,
        );
      }
      handle = this.getHerdrExternalHandle(initial.id);
      if (!handle) {
        throw new AgentSessionError("AGENT_LIFECYCLE_CORRUPT", `HerdR handle disappeared for agent ${initial.id}.`);
      }

      const result = await this.herdrGateway.promptExternalAgent(
        handle,
        prompt,
        {
          timeoutMs: this.herdrPromptTimeoutMs(initial),
          waitForCompletion: true,
          store: this.store,
        },
      );
      if (result.status === "OUTCOME_UNKNOWN") {
        throw new AgentSessionError(
          "PROVIDER_UNAVAILABLE",
          `HerdR prompt outcome is unknown for agent ${initial.id}; blind resend is forbidden.`,
        );
      }
      await this.settleHerdrTurn(this.store.getById(initial.id) ?? initial, handle, result);
    } catch (error) {
      if (isAgentProviderError(error) || error instanceof LocalAgentProviderError) {
        const latest = this.store.getById(agentId) ?? initial;
        const physical = await inspectWorkspacePhysicalState(latest.workspaceRoot).catch(() => undefined);
        const delta = physical ? computeWorkerDelta(physical, latest.scopeBaseline) : undefined;
        const scope = delta
          ? this.classifyWorkerScope(
              delta.changedPaths,
              latest.executionContract?.writePaths,
              latest.executionContract?.maxFiles,
              delta.attribution,
            )
          : { scopeState: "UNKNOWN" as ScopeState, unexpectedPaths: [] as string[] };
        const cumulative = Array.from(new Set([
          ...(latest.lifecycleState?.cumulativeChangedPaths ?? []),
          ...(delta?.changedPaths ?? []),
        ])).sort();

        let providerSessionId: string | undefined;
        let latestResponse: string | undefined;
        let errorCode: string | undefined;
        let errorRetryable: boolean | undefined;
        let errorDetails: AgentProviderFailureDetails | string | undefined;
        if (AgentProviderFailureError.is(error)) {
          errorCode = error.code;
          errorRetryable = error.retryable;
          errorDetails = describeAgentProviderError(error);
          providerSessionId = error.providerSessionId;
          latestResponse = error.providerMessage === undefined
            ? undefined
            : redactSensitiveText(error.providerMessage);
        } else if (isAgentProviderError(error)) {
          errorCode = error.code;
          errorRetryable = error.retryable;
          errorDetails = describeAgentProviderError(error);
        } else {
          providerSessionId = error.providerSessionId;
          latestResponse = error.finalResponse === undefined
            ? undefined
            : redactSensitiveText(error.finalResponse);
        }

        const herdrErrorMessage = redactSensitiveText(error instanceof Error ? error.message : String(error));
        const failureClassification = classifyDispatchFailure({
          ...latest,
          status: "error",
          error: herdrErrorMessage,
          errorCode,
          scopeState: scope.scopeState,
          updatedAt: new Date().toISOString(),
        });

        const failed = this.store.failExternalRuntimeTurnCAS({
          agentId,
          generation,
          providerSessionId,
          latestResponse,
          error: herdrErrorMessage,
          errorCode,
          errorRetryable,
          errorDetails,
          terminalReason: "provider_error",
          scopeState: scope.scopeState,
          cumulativeChangedPaths: cumulative,
          turnEndBaseline: physical
            ? {
                changedPaths: physical.changedPaths,
                head: physical.head ?? null,
                fingerprints: physical.fingerprints,
              }
            : undefined,
          dispatchFailure: failureClassification,
        });
        if (!failed.applied) {
          const current = this.store.getById(agentId);
          if (current?.lifecycleState?.activeTurn?.generation === generation) {
            throw new AgentSessionError(
              "AGENT_LIFECYCLE_CORRUPT",
              `HerdR provider error for agent ${agentId} could not be durably settled.`,
            );
          }
        }
        return;
      }

      const current = this.store.getById(agentId);
      const activeGeneration = current?.lifecycleState?.activeTurn?.generation;
      if (current && activeGeneration === generation && current.externalRuntimeBinding?.runtimeKind === "HERDR") {
        try {
          const handle = this.getHerdrExternalHandle(agentId);
          if (handle) {
            const reconciliation = await this.herdrGateway.reconcileExternalAgent(
              handle,
              current.executionContract?.writePaths,
              false,
              undefined,
              { store: this.store },
            );
            if (reconciliation.settled) {
              await this.settleHerdrTurn(current, handle);
              return;
            }
          }
        } catch {
          // Preserve the original failure; the durable prompt/launch fence
          // prevents blind replay and later status/reconcile may recover.
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      const latest = this.store.getById(agentId);
      if (latest?.lifecycleState?.activeTurn?.generation === generation) {
        const launchState = latest.externalRuntimeBinding?.launch?.state;
        const knownHerdrLaunchFailure =
          latest.externalRuntimeBinding?.runtimeKind === "HERDR" &&
          !latest.externalRuntimeBinding.handle &&
          (
            launchState === "FENCED" ||
            (launchState === "WORKSPACE_OBSERVED" && message.startsWith("HerdR agent.start failed:")) ||
            (launchState === "AGENT_OBSERVED" && message.startsWith("HerdR onboarding blocked:"))
          );
        if (latest.externalRuntimeBinding?.runtimeKind !== "HERDR" || knownHerdrLaunchFailure) {
          this.store.failExternalRuntimePreLaunchCAS(
            agentId,
            generation,
            message,
            { allowKnownHerdrLaunchFailure: knownHerdrLaunchFailure },
          );
        }
      }
    }
  }

  private startHerdrTurn(agentId: string, prompt: string): void {
    const existing = this.herdrTurnTasks.get(agentId);
    if (existing) return;
    const initial = this.store.getById(agentId);
    const generation = initial?.lifecycleState?.activeTurn?.generation;
    if (!initial || !generation) return;
    const verifierPlans = this.buildHerdrVerifierPlans(initial, generation);
    for (const verifierPlan of verifierPlans) {
      const prepared = this.store.prepareExternalRuntimeVerifierCAS({
        agentId,
        generation,
        plan: verifierPlan,
      });
      if (!prepared.applied) {
        const error = "HerdR verifier obligation could not be durably recorded before provider execution.";
        if (initial.externalRuntimeBinding?.runtimeKind === "HERDR") {
          this.store.failExternalRuntimeTurnCAS({
            agentId,
            generation,
            error,
            errorCode: "VERIFIER_PLAN_PERSIST_FAILED",
            errorRetryable: false,
            terminalReason: "unknown",
            scopeState: "UNKNOWN",
          });
        } else {
          this.store.failExternalRuntimePreLaunchCAS(agentId, generation, error, { terminalReason: "unknown" });
        }
        return;
      }
    }
    const task = this.runHerdrTurn(agentId, prompt);
    this.herdrTurnTasks.set(agentId, task);
    void task.finally(() => {
      if (this.herdrTurnTasks.get(agentId) === task) this.herdrTurnTasks.delete(agentId);
    });
  }

  private async refreshHerdrTurn(agentId: string): Promise<void> {
    const record = this.store.getById(agentId);
    if (!record || record.externalRuntimeBinding?.runtimeKind !== "HERDR") return;
    if (!record.lifecycleState?.activeTurn) return;
    const handle = this.getHerdrExternalHandle(agentId);
    if (!handle) {
      throw new AgentSessionError("AGENT_LIFECYCLE_CORRUPT", `Agent ${agentId} has HERDR runtime state without a durable handle.`);
    }
    if (
      handle.herdrAgentKind === "opencode" &&
      handle.nativeProviderEndpoint !== undefined &&
      record.externalRuntimeBinding?.promptState?.consequentialPromptFenced
    ) {
      // HerdR owns the long-lived OpenCode server process, not the semantic SDK
      // request. After controller restart, server-idle is not evidence that the
      // fenced SDK turn completed. Preserve active/unknown truth; never replay.
      return;
    }
    await this.settleHerdrTurn(record, handle);
  }

  /**
   * Start a new agent session using an advertised profile.
   * Returns immediately; worker runs in background.
   * Fail-closed: if worker fails to launch, record is set to error status.
   */
  async startAgent(input: StartAgentInput): Promise<StartAgentOutput> {
    const { workspaceId, workspaceRoot, profileName, prompt, profiles, executionContract, attemptKey } = input;

    assertDispatchContractCoherence(executionContract);

    const profile = profiles.find((p) => p.name === profileName);
    if (!profile) {
      const blocker = input.profileCatalog?.blockerFor(profileName);
      if (blocker) {
        throw new AgentSessionError(blocker.code, `Agent profile '${profileName}' is not dispatchable: ${blocker.detail}`);
      }
      const available = profiles.map((p) => p.name).join(", ");
      throw new AgentSessionError(
        "UNKNOWN_PROFILE",
        `Unknown agent profile: ${profileName}. Available: ${available || "none"}`,
      );
    }

    const replayBinding = attemptKey === undefined
      ? undefined
      : buildStartReplayBinding(attemptKey, {
          workspaceRoot,
          profile,
          prompt,
          executionContract,
        });
    if (executionContract?.dispatchIntent && !attemptKey) {
      throw new AgentSessionError(
        "INVALID_ATTEMPT_KEY",
        "Controller-authored dispatchIntent requires attemptKey so duplicate/uncertain dispatch can be reconciled to one durable attempt.",
      );
    }
    if (executionContract?.dispatchIntent && attemptKey !== executionContract.dispatchIntent.attemptId) {
      throw new AgentSessionError(
        "DISPATCH_CONTRACT_REJECTED",
        `DISPATCH_CONTRACT_REJECTED: attemptKey '${attemptKey}' does not match dispatchIntent.attemptId '${executionContract.dispatchIntent.attemptId}'. Field: attemptKey; provider_effect=false`,
      );
    }
    if (this.usesHerdrBackend() && (!attemptKey || !executionContract?.dispatchIntent)) {
      throw new AgentSessionError(
        "INVALID_EXECUTION_CONTRACT",
        "HERDR production backend requires exact attemptKey and executionContract.dispatchIntent; implicit execution identity is forbidden.",
      );
    }

    if (replayBinding) {
      try {
        const replay = this.store.resolveStartReplay(workspaceRoot, replayBinding);
        if (replay) {
          const herdrHandle = this.getHerdrExternalHandle(replay.id);
          return recordToStartOutput(replay, herdrHandle);
        }
      } catch (error) {
        if (error instanceof LocalAgentReplayConflictError) {
          throw new AgentSessionError(
            "ATTEMPT_REPLAY_CONFLICT",
            `attemptKey '${attemptKey}' is already bound to agent ${error.existingAgentId} with a materially different request.`,
          );
        }
        throw error;
      }
    }

    let executionIdlePolicy: EffectiveExecutionIdlePolicy;
    try {
      executionIdlePolicy = resolveEffectiveExecutionIdlePolicy(profile, executionContract);
    } catch (error) {
      throw new AgentSessionError(
        "INVALID_EXECUTION_CONTRACT",
        error instanceof Error ? error.message : String(error),
      );
    }

    await this.assertExecutionAuthority(profileName, executionContract);
    this.assertDispatchOwnershipAvailable(workspaceRoot, executionContract);

    let startCapacity = this.executionCapacitySnapshot(workspaceRoot);
    if ((startCapacity.localState === "EXHAUSTED" || (startCapacity.unreconciledStale ?? 0) > 0) && this.usesHerdrBackend()) {
      await this.reconcileStaleHerdRSessions();
      startCapacity = this.executionCapacitySnapshot(workspaceRoot);
    }
    if (startCapacity.localState === "EXHAUSTED") {
      throw new AgentSessionError(
        "NO_EXECUTION_CAPACITY",
        `Local DevSpace execution capacity exhausted: ${startCapacity.used} of ${startCapacity.max} slot(s) active (${startCapacity.activeInWorkspace} in this workspace, ${startCapacity.activeOtherWorkspaces} in other workspaces/conversations). This is not provider rate-limit evidence.`,
      );
    }

    // Optional structured execution contract (execution-control only).
    let providerEnvironment = withInstalledNexusCertifyOnPath(process.env);
    if (executionContract?.toolchainId) {
      const toolchain = this.config.toolchains.find((candidate) => candidate.id === executionContract.toolchainId);
      if (!toolchain) {
        throw new AgentSessionError(
          "TOOLCHAIN_UNAVAILABLE",
          `Execution contract toolchain '${executionContract.toolchainId}' is not configured. ` +
            `Configure DEVSPACE_TOOLCHAINS or omit toolchainId. Dev MCP will not install or repair toolchains.`,
        );
      }
      try {
        providerEnvironment = buildToolchainEnvironment(
          this.config.toolchains,
          executionContract.toolchainId,
          workspaceRoot,
        );
      } catch (error) {
        throw new AgentSessionError(
          "TOOLCHAIN_UNAVAILABLE",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (executionContract?.expectedHead) {
      const currentHead = await readWorkspaceHead(workspaceRoot);
      if (!currentHead) {
        throw new AgentSessionError(
          "STALE_WORKSPACE",
          `Execution contract expected HEAD ${executionContract.expectedHead}, but the workspace HEAD could not be resolved. ` +
            `Refusing to start the worker against an unverifiable workspace.`,
        );
      }
      if (currentHead !== executionContract.expectedHead.toLowerCase()) {
        throw new AgentSessionError(
          "STALE_WORKSPACE",
          `Execution contract expected HEAD ${executionContract.expectedHead}, current workspace HEAD is ${currentHead}. ` +
            `Refusing to start the worker against a stale workspace.`,
        );
      }
    }

    const availability = checkLocalAgentProviderAvailability(profile.provider, providerEnvironment);
    const codexRuntime = profile.provider === "codex" && availability.available
      ? inspectCodexRuntime({ env: providerEnvironment })
      : undefined;
    if (!availability.available || (codexRuntime && !codexRuntime.ready)) {
      throw new AgentSessionError(
        "PROVIDER_UNAVAILABLE",
        `Agent provider '${profile.provider}' is unavailable: ${
          availability.reason ?? codexRuntime?.reason ?? "unknown reason"
        }`,
      );
    }
    if (this.usesHerdrBackend() && !await this.herdrGateway.probeReady()) {
      throw new AgentSessionError(
        "PROVIDER_UNAVAILABLE",
        `HerdR daemon is unavailable at ${HERDR_DEFAULT_SOCKET_PATH}; legacy fallback is forbidden.`,
      );
    }

    if (profile.provider === "opencode") {
      const modelValidation = validateOpencodeModelAndVariant(
        profile.model,
        profile.effort,
        input.profileCatalog?.opencodeCatalog,
      );
      if (!modelValidation.valid) {
        throw new AgentSessionError(
          modelValidation.blockerCode!,
          modelValidation.reason!,
        );
      }
    }

    const executionGeneration = this.resolveExecutionGeneration(
      profile,
      input.profileCatalog?.generation ?? "unresolved",
      providerEnvironment,
    );

    let record: LocalAgentRecord;
    let created = true;
    try {
      if (replayBinding) {
        const result = this.store.createOrReplay({
          workspaceId,
          workspaceRoot,
          profileName: profile.name,
          provider: profile.provider,
          model: profile.model,
          effort: profile.effort,
          executionContract,
          executionIdlePolicy,
          executionGeneration,
          startReplay: replayBinding,
          lifecycleKind: "detached_worker_v2",
        });
        record = result.record;
        created = result.created;
      } else {
        record = this.store.create({
          workspaceId,
          workspaceRoot,
          profileName: profile.name,
          provider: profile.provider,
          model: profile.model,
          effort: profile.effort,
          executionContract,
          executionIdlePolicy,
          executionGeneration,
          lifecycleKind: "detached_worker_v2",
        });
      }
    } catch (error) {
      if (error instanceof LocalAgentReplayConflictError) {
        throw new AgentSessionError(
          "ATTEMPT_REPLAY_CONFLICT",
          `attemptKey '${attemptKey}' is already bound to agent ${error.existingAgentId} with a materially different request.`,
        );
      }
      throw error;
    }

    if (created) {
      const boundPrompt = bindDispatchIntentToPrompt(record.executionContract?.dispatchIntent, prompt);
      if (this.usesHerdrBackend()) {
        this.startHerdrTurn(record.id, boundPrompt);
      } else {
        await this.launchPrompt(record.id, boundPrompt);
      }
    }
    const herdrHandle = this.getHerdrExternalHandle(record.id);
    return recordToStartOutput(this.store.getById(record.id) ?? record, herdrHandle);
  }

  private async assertExecutionAuthority(profileName: string, contract: ExecutionContract | undefined): Promise<AuthorityValidationEvidence> {
    const mode = contract?.authorityMode ?? "OWNER_DIRECT";
    if (mode === "OWNER_DIRECT") {
      if (contract?.nexusGrant) {
        throw new AgentSessionError("NEXUS_AUTHORITY_REJECTED", "OWNER_DIRECT execution must not carry Nexus grant authority.");
      }
      return { kind: "OWNER_DIRECT" };
    }
    if (!contract?.nexusGrant || !contract.dispatchIntent || !contract.expectedHead) {
      throw new AgentSessionError(
        "NEXUS_AUTHORITY_REJECTED",
        "NEXUS_GOVERNED execution requires canonical Nexus grant, dispatchIntent, and expectedHead before worker launch.",
      );
    }
    try {
      const grant = await this.nexusGrantResolver(contract.nexusGrant);
      return assertNexusGrantAuthorizesExecution({
        grant,
        dispatchIntent: contract.dispatchIntent,
        expectedHead: contract.expectedHead,
        profile: profileName,
        writePaths: contract.writePaths ?? [],
        authorizedToolCeiling: contract.authorizedToolCeiling,
        toolProjectionManifest: contract.toolProjectionManifest,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new AgentSessionError("NEXUS_AUTHORITY_REJECTED", `NEXUS_GOVERNED authority rejected before worker launch: ${detail}`);
    }
  }

  /**
   * Continue an existing agent session with a new prompt.
   * Provider session ID is preserved.
   *
   * Admission is revalidated BEFORE any mutation or worker relaunch:
   * durable identity, canonical workspace, persisted execution contract,
   * current scope state, foreign workspace mutation, execution capacity, and
   * HEAD lineage. A provider session ID by itself is not authority; stale or
   * contradictory admission evidence fails closed before mutation.
   */
  async continueAgent(input: ContinueAgentInput): Promise<ContinueAgentOutput> {
    const { workspaceId: _workspaceId, workspaceRoot, agentId, prompt } = input;

    // Exact id lookup only (no prefix matching through MCP)
    let record = this.store.getById(agentId);
    if (!record) {
      throw new AgentSessionError("UNKNOWN_AGENT", `Unknown agent id: ${agentId}`);
    }

    if (!isSameWorktreePath(record.workspaceRoot, workspaceRoot)) {
      throw new AgentSessionError(
        "AGENT_WORKSPACE_MISMATCH",
        `Agent ${agentId} belongs to workspace root '${record.workspaceRoot}', not '${workspaceRoot}'`,
      );
    }

    if (!isDetachedLifecycle(record.lifecycleState)) {
      throw new AgentSessionError(
        "AGENT_LIFECYCLE_UNSUPPORTED",
        `Agent ${agentId} is owned by the legacy/runtime-pool lifecycle and cannot be continued by detached-worker v2.`,
      );
    }
    if (record.lifecycleState?.terminationPending) {
      throw new AgentSessionError(
        "AGENT_TERMINATION_PENDING",
        `Agent ${agentId} has physical termination pending for generation ${record.lifecycleState.terminationPending.generation}.`,
      );
    }
    if (record.lifecycleState?.lifecycleCorrupt || record.lifecycleState?.terminationBlocked) {
      throw new AgentSessionError(
        "AGENT_LIFECYCLE_CORRUPT",
        `Agent ${agentId} has malformed durable lifecycle evidence; continuation is blocked.`,
      );
    }
    if (record.status === "starting" || record.status === "running") {
      throw new AgentSessionError(
        "AGENT_ALREADY_RUNNING",
        `Agent ${agentId} is currently ${record.status}. Wait for it to complete before continuing.`,
      );
    }
    if (record.status === "stopped" && record.externalRuntimeBinding?.runtimeKind === "HERDR") {
      throw new AgentSessionError(
        "REBIND_REQUIRED",
        `Agent ${agentId} was explicitly stopped in HerdR; continuation requires a new agent_start attempt.`,
      );
    }
    if (record.lifecycleState?.activeTurn) {
      throw new AgentSessionError(
        "AGENT_LIFECYCLE_CORRUPT",
        `Agent ${agentId} has a terminal status with an unsettled active turn; continuation is blocked.`,
      );
    }
    const unresolvedVerifier = Object.values(record.lifecycleState?.automatedVerifierEffects ?? {})
      .find((effect) => effect.effectState === "RUNNING" || effect.effectState === "OUTCOME_UNKNOWN")
      ?? (record.lifecycleState?.automatedVerifierResult?.effectState === "RUNNING"
        || record.lifecycleState?.automatedVerifierResult?.effectState === "OUTCOME_UNKNOWN"
        ? record.lifecycleState.automatedVerifierResult
        : undefined);
    if (unresolvedVerifier) {
      throw new AgentSessionError(
        "CONTINUATION_ADMISSION_FAILED",
        `Agent ${agentId} has unresolved verifier effect ${String(unresolvedVerifier.effectKey ?? "unknown")} (${String(unresolvedVerifier.effectState)}); reconcile that exact effect before starting a successor.`,
      );
    }

    // ── Continuation admission gates (all read-only; run before mutation) ──
    const admissionFailures: string[] = [];

    const herdrBound = record.externalRuntimeBinding?.runtimeKind === "HERDR";
    if (
      !herdrBound &&
      (
        record.providerContinuityState === "LOST" ||
        (record.provider === "agy" && !record.providerSessionId)
      )
    ) {
      throw new AgentSessionError(
        "REBIND_REQUIRED",
        `Agent ${agentId} has lost or unestablished provider session identity (${record.provider}); continuation cannot silently start a new provider conversation without explicit rebind.`,
      );
    }

    const directSelection = record.executionContract?.directSelection;
    if (directSelection) {
      if (!isLocalAgentProvider(directSelection.provider)) {
        throw new AgentSessionError("REBIND_REQUIRED", `Agent ${agentId} has an unknown persisted direct provider.`);
      }
      if (record.provider !== directSelection.provider
        || record.model !== directSelection.model
        || record.effort !== directSelection.effort) {
        throw new AgentSessionError("REBIND_REQUIRED", `Agent ${agentId} has inconsistent persisted direct selection evidence.`);
      }
    }
    const receipt = record.executionContract?.catalogReceipt;
    if (receipt) {
      const snapshot = receipt.provider === "opencode" ? input.opencodeCatalog : receipt.provider === "cline" ? input.clineCatalog : undefined;
      if (!snapshot) {
        throw new AgentSessionError("REBIND_REQUIRED", `Agent ${agentId} catalog receipt is stale or unavailable; explicit rebind is required.`);
      }
      if (receipt.provider === "opencode") {
        const validation = validateOpencodeModelAndVariant(receipt.model, receipt.effort, snapshot as OpencodeCatalogSnapshot);
        const opencode = snapshot as OpencodeCatalogSnapshot;
        const runtimeIdentity = `${opencode.runtime?.source ?? "unknown"}:${opencode.runtime?.version ?? "unknown"}:${opencode.runtime?.executable ?? "unknown"}`;
        if (!validation.valid || opencode.source !== receipt.source || !catalogSnapshotIsFresh(opencode.fetchedAt, opencode.expiresAt) || (opencode.freshness ?? "unknown") !== receipt.freshness || runtimeIdentity !== receipt.runtimeIdentity) throw new AgentSessionError("REBIND_REQUIRED", validation.reason ?? "Persisted OpenCode catalog receipt is no longer valid.");
      } else if (receipt.provider === "cline") {
        if (snapshot.generation !== receipt.generation) {
          throw new AgentSessionError("REBIND_REQUIRED", `Agent ${agentId} catalog receipt is stale or unavailable; explicit rebind is required.`);
        }
        const cline = snapshot as ClineCatalogSnapshot;
        const exact = cline.entries.filter((entry) => entry.cliProviderId === (receipt.cliProviderId ?? "cline") && entry.fullName === receipt.model);
        const runtimeIdentity = `${cline.runtime.cliProviderId}:${cline.runtime.version}:${cline.runtime.command}`;
        if (!isClineCatalogFresh(cline) || cline.source !== receipt.source || receipt.freshness !== "fresh" || runtimeIdentity !== receipt.runtimeIdentity || exact.length !== 1 || (receipt.effort && (!exact[0].thinkingKnown || !exact[0].thinking.includes(receipt.effort as never)))) {
          throw new AgentSessionError("REBIND_REQUIRED", "Persisted Cline catalog receipt is no longer valid.");
        }
      }
    }
    const currentProfile = directSelection
      ? {
          name: record.profileName,
          description: "Durable direct provider/model selection",
          provider: directSelection.provider as LocalAgentProfile["provider"],
          model: directSelection.model,
          effort: directSelection.effort,
          cliProviderId: directSelection.cliProviderId,
          write_mode: directSelection.writeMode,
          filePath: "<direct-dispatch>",
          body: "",
          disabled: false,
        }
      : input.profiles?.find((candidate) => candidate.name === record.profileName) ?? {
          name: record.profileName,
          description: "Persisted durable-agent profile binding",
          provider: record.provider as LocalAgentProfile["provider"],
          model: record.model,
          effort: record.effort,
          filePath: "<persisted>",
          body: "",
          disabled: false,
        };
    let executionIdlePolicy: EffectiveExecutionIdlePolicy;
    try {
      executionIdlePolicy = resolveEffectiveExecutionIdlePolicy(
        currentProfile,
        input.idleTimeoutMode !== undefined || input.idleTimeoutMs !== undefined
          ? { idleTimeoutMode: input.idleTimeoutMode, idleTimeoutMs: input.idleTimeoutMs }
          : undefined,
      );
    } catch (error) {
      throw new AgentSessionError(
        "INVALID_EXECUTION_CONTRACT",
        error instanceof Error ? error.message : String(error),
      );
    }

    if (!herdrBound) {
      try {
        const currentGeneration = this.resolveExecutionGeneration(
          currentProfile,
          input.profileCatalog?.generation ?? "unresolved",
          process.env,
        );
        assertSameExecutionGeneration(record.executionGeneration, currentGeneration);
      } catch (error) {
        if (error instanceof ExecutionProtocolError || error instanceof AgentSessionError) {
          throw new AgentSessionError(
            "REBIND_REQUIRED",
            `Continuation of agent ${agentId} requires explicit rebind before mutation: ${error.message}`,
          );
        }
        throw error;
      }
    }

    const continuationCapacity = this.executionCapacitySnapshot(workspaceRoot);
    if (continuationCapacity.localState === "EXHAUSTED") {
      admissionFailures.push(
        `Local DevSpace execution capacity exhausted: ${continuationCapacity.used} of ${continuationCapacity.max} slot(s) active (${continuationCapacity.activeInWorkspace} in this workspace, ${continuationCapacity.activeOtherWorkspaces} in other workspaces/conversations). This is not provider rate-limit evidence.`,
      );
    }

    const contract = record.executionContract;
    await this.assertExecutionAuthority(record.profileName, contract);
    const lineageBaseline = record.lifecycleState?.turnEndBaseline ?? record.scopeBaseline;

    const physical = await inspectWorkspacePhysicalState(record.workspaceRoot);

    const requiresLineageEvidence =
      Boolean(contract?.expectedHead) || Boolean(lineageBaseline?.head);
    if (!physical.gitAvailable && requiresLineageEvidence) {
      admissionFailures.push(
        "Workspace Git state is unavailable; recorded continuation lineage cannot be verified.",
      );
    } else if (physical.gitAvailable) {
      if (contract?.expectedHead) {
        if (physical.head !== contract.expectedHead.toLowerCase()) {
          admissionFailures.push(
            `Execution contract expected HEAD ${contract.expectedHead}, current workspace HEAD is ${physical.head ?? "unknown"}.`,
          );
        }
      } else if (
        lineageBaseline?.head &&
        physical.head &&
        lineageBaseline.head !== physical.head
      ) {
        admissionFailures.push(
          `Workspace HEAD advanced from the recorded turn-end lineage ${lineageBaseline.head} to ${physical.head}.`,
        );
      }
    }

    if (record.scopeState === "SCOPE_VIOLATION") {
      admissionFailures.push("The previous turn ended in SCOPE_VIOLATION; continuing would extend violated authority.");
    }

    if (physical.gitAvailable && lineageBaseline) {
      const postTurnDelta = computeWorkerDelta(physical, lineageBaseline);
      // ANY workspace mutation after the turn-end baseline is foreign for
      // continuation admission — including mutations to paths this worker
      // itself changed in earlier turns. A path is never whitelisted merely
      // because it appears in cumulativeChangedPaths. Incomplete evidence is
      // also fail-closed: an unprovable delta cannot prove absence of foreign
      // mutation. Provider scratch lives outside the workspace and needs no
      // exemption here.
      const foreignMutations = [...postTurnDelta.changedPaths];
      if (postTurnDelta.attribution === "UNKNOWN") {
        admissionFailures.push(
          "Post-turn workspace attribution is UNKNOWN; continuing would require evidence that cannot be proven.",
        );
      }
      if (foreignMutations.length > 0) {
        admissionFailures.push(
          `Foreign workspace mutation detected after the terminal turn (not attributable to this agent): ${foreignMutations.join(", ")}.`,
        );
      }
    }

    if (admissionFailures.length > 0) {
      throw new AgentSessionError(
        "CONTINUATION_ADMISSION_FAILED",
        `Continuation of agent ${agentId} was rejected before any mutation: ${admissionFailures.join(" ")}`,
      );
    }

    // Revalidate the same durable row after the read-only admission work. One
    // exact CAS installs one new opaque turn generation; concurrent continues
    // cannot both acquire execution authority.
    const begun = this.store.beginContinuationCAS({
      agentId: record.id,
      expectedPreviousGeneration: record.lifecycleState?.lastSettledGeneration,
      expectedUpdatedAt: record.updatedAt,
      turnStartedAt: new Date().toISOString(),
      executionIdlePolicy,
    });
    if (!begun.applied) {
      const current = begun.current;
      if (current?.lifecycleState?.terminationPending) {
        throw new AgentSessionError(
          "AGENT_TERMINATION_PENDING",
          `Agent ${agentId} entered physical termination while continuation admission was being checked.`,
        );
      }
      if (current?.lifecycleState?.lifecycleCorrupt) {
        throw new AgentSessionError(
          "AGENT_LIFECYCLE_CORRUPT",
          `Agent ${agentId} has malformed durable lifecycle evidence; continuation is blocked.`,
        );
      }
      throw new AgentSessionError(
        "CONTINUATION_ADMISSION_FAILED",
        `Continuation of agent ${agentId} lost its durable admission CAS before mutation.`,
      );
    }

    const boundPrompt = bindDispatchIntentToPrompt(record.executionContract?.dispatchIntent, prompt);
    if (herdrBound || this.usesHerdrBackend()) {
      this.startHerdrTurn(record.id, boundPrompt);
    } else {
      await this.launchPrompt(record.id, boundPrompt);
    }
    const updated = this.store.getById(record.id) ?? record;
    const herdrHandle = this.getHerdrExternalHandle(record.id);
    return { ...recordToStartOutput(updated, herdrHandle), continued: true as const };
  }

  /**
   * Get the status of an agent session, with optional bounded polling.
   */
  async getAgentStatus(input: GetAgentStatusInput): Promise<AgentStatusOutput> {
    const { workspaceId: _workspaceId, workspaceRoot, agentId, waitMs = 0 } = input;

    if (waitMs < 0 || waitMs > AGENT_STATUS_MAX_WAIT_MS) {
      throw new AgentSessionError(
        "INVALID_WAIT_MS",
        `waitMs must be between 0 and ${AGENT_STATUS_MAX_WAIT_MS}. Got: ${waitMs}`,
      );
    }

    let record = this.store.getById(agentId);
    if (!record) {
      throw new AgentSessionError("UNKNOWN_AGENT", `Unknown agent id: ${agentId}`);
    }

    if (!isSameWorktreePath(record.workspaceRoot, workspaceRoot)) {
      throw new AgentSessionError(
        "AGENT_WORKSPACE_MISMATCH",
        `Agent ${agentId} belongs to workspace root '${record.workspaceRoot}', not '${workspaceRoot}'`,
      );
    }

    if (this.usesHerdrBackend() && record.externalRuntimeBinding?.runtimeKind === "HERDR") {
      const activeTask = this.herdrTurnTasks.get(agentId);
      if (activeTask) {
        if (waitMs > 0) {
          await Promise.race([
            activeTask,
            sleep(waitMs),
          ]);
        }
        record = this.store.getById(agentId) ?? record;
      }
      if (record.lifecycleState?.activeTurn && !this.herdrTurnTasks.has(agentId)) {
        const deadline = Date.now() + waitMs;
        do {
          await this.refreshHerdrTurn(agentId);
          record = this.store.getById(agentId) ?? record;
          if (!record.lifecycleState?.activeTurn || waitMs <= 0 || Date.now() >= deadline) break;
          await sleep(Math.min(300, Math.max(0, deadline - Date.now())));
        } while (Date.now() < deadline);
      }
    } else if (waitMs > 0 && occupiesDetachedExecutionSlot(record)) {
      const deadline = Date.now() + waitMs;
      while (occupiesDetachedExecutionSlot(record) && Date.now() < deadline) {
        await sleep(Math.min(300, deadline - Date.now()));
        record = this.store.getById(agentId) ?? record;
      }
    }

    const herdrHandle = this.getHerdrExternalHandle(agentId);
    return recordToStatusOutput(record, await this.buildLifecycleEvidence(record), herdrHandle);
  }

  async cancelAgent(input: CancelAgentInput): Promise<AgentStatusOutput> {
    const { workspaceRoot, agentId } = input;
    let record = this.store.getById(agentId);
    if (!record) {
      throw new AgentSessionError("UNKNOWN_AGENT", `Unknown agent id: ${agentId}`);
    }
    if (!isSameWorktreePath(record.workspaceRoot, workspaceRoot)) {
      throw new AgentSessionError(
        "AGENT_WORKSPACE_MISMATCH",
        `Agent ${agentId} belongs to workspace root '${record.workspaceRoot}', not '${workspaceRoot}'`,
      );
    }

    const preLaunchGeneration =
      record.status === "starting" &&
      record.lifecycleState?.activeTurn?.launchState === "not_started" &&
      record.workerPid === undefined &&
      record.workerToken === undefined
        ? record.lifecycleState.activeTurn.generation
        : undefined;
    if (preLaunchGeneration && record.externalRuntimeBinding === undefined) {
      const stopped = this.store.cancelExternalRuntimePreLaunchCAS(record.id, preLaunchGeneration);
      if (!stopped.applied) {
        throw new AgentSessionError(
          "AGENT_LIFECYCLE_CORRUPT",
          `Agent ${agentId} lost its exact pre-launch generation before cancellation.`,
        );
      }
      record = stopped.current ?? record;
      return recordToStatusOutput(record, undefined, undefined);
    }
    if (
      preLaunchGeneration &&
      record.externalRuntimeBinding?.runtimeKind === "HERDR" &&
      !this.getHerdrExternalHandle(agentId)
    ) {
      const reconciled = await this.reconcileStaleHerdRSession(record);
      if (!reconciled) {
        throw new AgentSessionError(
          "AGENT_LIFECYCLE_CORRUPT",
          `Agent ${agentId} has no bound HerdR handle, but exact external absence and physical workspace safety are not both proven; slot remains fenced.`,
        );
      }
      record = this.store.getById(agentId) ?? record;
      return recordToStatusOutput(record, undefined, undefined);
    }

    const herdrHandle = this.getHerdrExternalHandle(agentId);

    if (record.externalRuntimeBinding?.runtimeKind === "HERDR" && herdrHandle) {
      if (record.status === "stopped") {
        return recordToStatusOutput(record, undefined, herdrHandle);
      }
      await this.herdrGateway.stopExternalAgent(herdrHandle, { store: this.store });
      const activeGeneration = record.lifecycleState?.activeTurn?.generation;
      if (activeGeneration) {
        const physical = await inspectWorkspacePhysicalState(record.workspaceRoot);
        const delta = computeWorkerDelta(physical, record.scopeBaseline);
        const scope = this.classifyWorkerScope(
          delta.changedPaths,
          record.executionContract?.writePaths,
          record.executionContract?.maxFiles,
          delta.attribution,
        );
        const completed = this.store.finishExternalRuntimeTurnCAS({
          agentId: record.id,
          generation: activeGeneration,
          status: "stopped",
          latestResponse: record.latestResponse,
          terminalReason: "cancelled",
          scopeState: scope.scopeState,
          cumulativeChangedPaths: Array.from(new Set([
            ...(record.lifecycleState?.cumulativeChangedPaths ?? []),
            ...delta.changedPaths,
          ])).sort(),
          turnEndBaseline: {
            changedPaths: physical.changedPaths,
            head: physical.head ?? null,
            fingerprints: physical.fingerprints,
          },
        });
        if (!completed.applied) {
          throw new AgentSessionError(
            "AGENT_LIFECYCLE_CORRUPT",
            `HerdR workspace for agent ${agentId} was stopped, but durable stop settlement failed.`,
          );
        }
      } else {
        const stopped = this.store.markExternalRuntimeStoppedCAS(record.id, "cancelled");
        if (!stopped.applied) {
          throw new AgentSessionError(
            "AGENT_LIFECYCLE_CORRUPT",
            `HerdR workspace for agent ${agentId} was stopped, but durable idle-session stop CAS failed.`,
          );
        }
        record = stopped.current ?? record;
      }
      const current = this.store.getById(agentId) ?? record;
      return recordToStatusOutput(current, undefined, herdrHandle);
    }

    if (!isDetachedLifecycle(record.lifecycleState) && isActiveStatus(record.status)) {
      record = this.store.reconcileLegacyDetachedActiveCAS(agentId).current ?? record;
    }
    if (!isDetachedLifecycle(record.lifecycleState)) {
      throw new AgentSessionError(
        "AGENT_LIFECYCLE_UNSUPPORTED",
        `Agent ${agentId} is owned by the legacy/runtime-pool lifecycle and cannot be cancelled by detached-worker v2.`,
      );
    }
    if (record.lifecycleState?.lifecycleCorrupt || record.lifecycleState?.terminationBlocked) {
      throw new AgentSessionError(
        "AGENT_LIFECYCLE_CORRUPT",
        `Agent ${agentId} has malformed durable lifecycle evidence; exact cancellation target is unknown.`,
      );
    }
    if (!isActiveStatus(record.status) && !record.lifecycleState?.terminationPending) {
      return recordToStatusOutput(record, undefined, herdrHandle);
    }
    const terminated = await this.terminateActiveAgent(
      agentId,
      "cancelled",
      "cancelled by operator",
      undefined,
      undefined,
      "stopped",
    );
    if (!terminated) {
      throw new AgentSessionError(
        "WORKER_TERMINATION_FAILED",
        `Agent ${agentId} is stopped, but its owned worker process could not be verified as terminated.`,
      );
    }
    const current = this.store.getById(agentId) ?? record;
    return recordToStatusOutput(current, undefined, herdrHandle);
  }

  /**
   * List agents scoped to a workspace, newest first.
   * workspaceRoot optionally narrows to a physical root.
   */
  listAgents(input: ListAgentsInput): AgentSummary[] {
    const { workspaceId, workspaceRoot, limit = AGENT_LIST_DEFAULT_LIMIT } = input;
    const effectiveLimit = Math.min(Math.max(1, limit), AGENT_LIST_MAX_LIMIT);

    if (!workspaceRoot) {
      const records = this.store.list({ workspaceId });
      return records.slice(0, effectiveLimit).map(recordToSummary);
    }

    const records = this.store.list();
    const matched = records.filter(
      (record) => isSameWorktreePath(record.workspaceRoot, workspaceRoot)
    );
    return matched.slice(0, effectiveLimit).map(recordToSummary);
  }

  listAllAgentRecords(): LocalAgentRecord[] {
    return this.store.list();
  }

  countAllAgentRecords(): number {
    return this.store.count();
  }

  /**
   * Read-only preflight for an exact workspace + agent profile.
   * Reports readiness evidence without routing, admission, or mutation
   * authority. Never exposes credentials. Unknown evidence stays unknown.
   */
  async preflightAgent(input: AgentPreflightInput): Promise<AgentPreflightOutput> {
    const { workspaceId, workspaceRoot, isolated, profileName, profiles, profileCatalog, toolchainId } = input;
    const blockers: Array<{ code: string; detail: string }> = [];
    const unknowns: string[] = [];

    const workspaceState = await inspectWorkspacePhysicalState(workspaceRoot);
    const workspace = {
      workspaceId,
      root: workspaceRoot,
      head: workspaceState.head,
      dirty: workspaceState.dirty,
      isolated,
    };

    const profile = profiles.find((candidate) => candidate.name === profileName);
    const profileResolved = Boolean(profile);
    if (!profile) {
      const blocker = profileCatalog?.blockerFor(profileName);
      blockers.push(
        blocker
          ? { code: blocker.code, detail: `Profile '${profileName}' is not dispatchable: ${blocker.detail}` }
          : {
              code: "UNKNOWN_PROFILE",
              detail: `Profile '${profileName}' is not advertised for this workspace.`,
            },
      );
    }

    // Authentication and provider reachability cannot be verified without an
    // expensive provider call; there is no existing safe readiness probe.
    // They must remain unknown rather than silently become true.
    unknowns.push(
      "authReady is unknown: Dev MCP cannot verify provider authentication without invoking the provider.",
    );
    unknowns.push(
      "providerReachable is unknown: no safe readiness probe exists that does not spawn a provider runtime.",
    );

    if (this.usesHerdrBackend()) {
      await this.reconcileStaleHerdRSessions();
    }

    const capacity = this.executionCapacitySnapshot(workspaceRoot);
    const capacityAvailable = capacity.localState === "AVAILABLE";
    if (!capacityAvailable) {
      const staleDetail = capacity.unreconciledStale ? ` (${capacity.unreconciledStale} slot(s) are unreconciled/stale HerdR sessions)` : "";
      blockers.push({
        code: "NO_EXECUTION_CAPACITY",
        detail: `${capacity.used} of ${capacity.max} configured local agent slot(s) are active (${capacity.activeInWorkspace} in this workspace, ${capacity.activeOtherWorkspaces} in other workspaces/conversations)${staleDetail}. This is local DevSpace capacity, not evidence of provider rate limiting.`,
      });
    }
    unknowns.push(
      "providerCapacity is unknown: local slot availability is reported separately and must not be interpreted as provider quota/rate-limit evidence.",
    );

    let toolchainAvailable = false;
    let executables: Record<string, string> | undefined;
    let providerEnvironment = withInstalledNexusCertifyOnPath(process.env);
    if (toolchainId) {
      const toolchain = this.config.toolchains.find((candidate) => candidate.id === toolchainId);
      if (!toolchain) {
        blockers.push({
          code: "TOOLCHAIN_UNAVAILABLE",
          detail: `Toolchain '${toolchainId}' is not configured.`,
        });
      } else {
        try {
          providerEnvironment = buildToolchainEnvironment(
            this.config.toolchains,
            toolchainId,
            workspaceRoot,
          );
          toolchainAvailable = true;
          executables = describeToolchainExecutables(this.config.toolchains, toolchainId);
        } catch (error) {
          blockers.push({
            code: "TOOLCHAIN_UNAVAILABLE",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    let providerConfigured = false;
    let runtimeReady = false;
    let runtimeVersion: string | undefined;
    let executionIdentity = "none";
    if (profile) {
      const availability = checkLocalAgentProviderAvailability(profile.provider, providerEnvironment);
      const codexRuntime: CodexRuntimeIdentity | undefined =
        profile.provider === "codex" && availability.available
          ? inspectCodexRuntime({ env: providerEnvironment })
          : undefined;
      providerConfigured = availability.available;
      runtimeReady = availability.available && (codexRuntime?.ready ?? true);
      executionIdentity = codexRuntime?.executable ?? profile.provider;
      runtimeVersion = codexRuntime?.binaryVersion ?? getLocalAgentProviderRuntimeVersion(
        profile.provider,
        providerEnvironment,
      );
      if (!runtimeReady) {
        blockers.push({
          code: "RUNTIME_STARTUP_NOT_READY",
          detail: `Provider '${profile.provider}' runtime is not configured: ${
            availability.reason ?? codexRuntime?.reason ?? "unknown reason"
          }`,
        });
      } else if (!codexRuntime) {
        const executable = resolveLocalAgentProviderExecutable(profile.provider, providerEnvironment);
        if (executable) executionIdentity = executable;
      }

      if (runtimeReady && profile.provider === "opencode") {
        const modelValidation = validateOpencodeModelAndVariant(
          profile.model,
          profile.effort,
          input.profileCatalog?.opencodeCatalog,
        );
        if (!modelValidation.valid) {
          blockers.push({
            code: modelValidation.blockerCode!,
            detail: modelValidation.reason!,
          });
        }
      }
    }

    // Tri-state dispatch readiness. UNKNOWN is never collapsed into a known
    // failure and never promoted to READY without positive evidence.
    const authReady: ReadinessValue = "unknown";
    const providerReachable: ReadinessValue = "unknown";
    const allRequiredPositive =
      profileResolved &&
      providerConfigured &&
      runtimeReady &&
      capacityAvailable &&
      (toolchainId === undefined || toolchainAvailable);
    const readinessSignalsPositive = isReadinessPositive(authReady) && isReadinessPositive(providerReachable);
    const dispatchState: DispatchReadinessState = blockers.length > 0
      ? "BLOCKED"
      : allRequiredPositive && readinessSignalsPositive
        ? "READY"
        : "UNKNOWN";
    const executionGeneration = profile
      ? buildExecutionGenerationBinding({
          profileCatalogGeneration: profileCatalog?.generation ?? "unresolved",
          provider: profile.provider,
          model: profile.model,
          executionIdentity,
          runtimeVersion,
          devspaceBuildId: this.runtimeBuildIdentity.buildId,
          devspaceSourceCommit: this.runtimeBuildIdentity.sourceCommit,
          hostGeneration: this.resolveHostGeneration(),
          authReadiness: this.normalizeAuthReadiness(authReady),
        })
      : undefined;

    return {
      workspace,
      worker: {
        profile: profileName,
        provider: profile?.provider ?? "unknown",
        model: profile?.model,
        effort: profile?.effort,
        executionIdentity,
        runtimeVersion,
        executionGeneration,
      },
      readiness: {
        profileResolved,
        providerConfigured,
        authReady,
        providerReachable,
        runtimeReady,
        capacityAvailable,
        dispatchState,
      },
      capacity,
      toolchain: toolchainId
        ? { id: toolchainId, available: toolchainAvailable, executables }
        : { id: "none", available: false },
      blockers,
      unknowns,
    };
  }

  /**
   * Read-only reconciliation: regardless of provider/session status, what
   * physically happened in the workspace? Provider timeout/error must not
   * imply "no candidate". Never retries mutation from here.
   */
  async reconcileAgent(input: ReconcileAgentInput): Promise<ReconcileAgentOutput> {
    const { workspaceRoot, agentId, isolated: _isolated } = input;
    const record = this.store.getById(agentId);
    if (!record) {
      throw new AgentSessionError("UNKNOWN_AGENT", `Unknown agent id: ${agentId}`);
    }
    if (!isSameWorktreePath(record.workspaceRoot, workspaceRoot)) {
      throw new AgentSessionError(
        "AGENT_WORKSPACE_MISMATCH",
        `Agent ${agentId} belongs to workspace root '${record.workspaceRoot}', not '${workspaceRoot}'`,
      );
    }

    const physical = await inspectWorkspacePhysicalState(record.workspaceRoot);
    const delta = computeWorkerDelta(physical, record.scopeBaseline);
    const workerChanged = delta.changedPaths;
    const contract = record.executionContract;
    const headAdvanced = Boolean(
      record.scopeBaseline?.head &&
        physical.head &&
        record.scopeBaseline.head !== physical.head,
    );

    const { scopeState, unexpectedPaths } = this.classifyWorkerScope(
      workerChanged,
      contract?.writePaths,
      contract?.maxFiles,
      delta.attribution,
    );

    const timing = computeSessionTiming(record);
    const herdrHandle = this.getHerdrExternalHandle(record.id);
    const opencodeSemanticOutcomeUnknown = Boolean(
      herdrHandle?.herdrAgentKind === "opencode" &&
      herdrHandle.nativeProviderEndpoint !== undefined &&
      record.lifecycleState?.activeTurn &&
      record.externalRuntimeBinding?.promptState?.consequentialPromptFenced &&
      !this.herdrTurnTasks.has(record.id),
    );
    const herdrReconciliation = herdrHandle && this.usesHerdrBackend() && !opencodeSemanticOutcomeUnknown
      ? await this.herdrGateway.reconcileExternalAgent(
          herdrHandle,
          contract?.writePaths,
          false,
          undefined,
          { store: this.store },
        )
      : undefined;
    const reconciledChangedPaths = Array.from(new Set([
      ...workerChanged,
      ...(herdrReconciliation?.changedPaths ?? []),
    ])).sort();
    const reconciledUnexpectedPaths = Array.from(new Set([
      ...unexpectedPaths,
      ...(herdrReconciliation?.unexpectedPaths ?? []),
    ])).sort();
    const observedScopeState: ScopeState = herdrReconciliation?.completionStatus === "SCOPE_VIOLATION"
      ? "SCOPE_VIOLATION"
      : scopeState;
    const reconciledScopeState = reportableScopeState(
      record,
      observedScopeState,
      herdrReconciliation?.enforcementState ?? herdrHandle?.enforcementState,
    );

    this.store.recordReconciledAtCAS(record.id);

    return {
      agentId: record.id,
      herdrHandle,
      ...(herdrHandle ? { runtime: herdrRuntimeOutput(herdrHandle) } : {}),
      dispatch: dispatchContractOutput(record.executionContract?.dispatchIntent),
      agentState: record.status,
      providerState: opencodeSemanticOutcomeUnknown
        ? "OUTCOME_UNKNOWN"
        : herdrReconciliation?.executionState
        ?? record.providerContinuityState
        ?? (record.providerSessionId ? "KNOWN_UNVERIFIED" : "UNKNOWN"),
      providerSessionId: record.providerSessionId,
      terminalReason: record.terminalReason,
      effectEnforcementReceipt: record.lifecycleState?.lastEffectEnforcementReceipt,
      workspace: {
        head: physical.head,
        dirty: physical.dirty,
      },
      candidate: {
        present: reconciledChangedPaths.length > 0 || headAdvanced,
        changedPaths: reconciledChangedPaths,
        unexpectedPaths: reconciledUnexpectedPaths,
        diffHash: physical.diffHash,
        scopeState: reconciledScopeState,
      },
      activity: {
        startedAt: record.createdAt,
        lastActivityAt: record.lifecycleState?.activeTurn?.lastActivityAt ?? record.updatedAt,
        lastFileMutationAt: physical.lastFileMutationAt,
        wallMs: timing.wallMs,
        idleMs: timing.idleMs,
      },
    };
  }

  /**
   * Supervise active agent sessions that carry an execution contract.
   * Enforces maxWallMs and write-scope (OBSERVE_AND_ABORT) by terminating the
   * owned worker. Called periodically by the server; safe to call directly in
   * tests.
   */
  async superviseActiveAgents(): Promise<void> {
    const now = Date.now();
    for (const record of this.store.listSupervisionCandidates()) {
      if (!isDetachedLifecycle(record.lifecycleState)) {
        if (isActiveStatus(record.status)) {
          const reconciled = this.store.reconcileLegacyDetachedActiveCAS(record.id);
          const adopted = reconciled.current;
          if (reconciled.applied && adopted?.lifecycleState?.terminationPending) {
            await this.drivePendingTermination(adopted);
          }
        }
        continue;
      }
      if (record.lifecycleState?.lifecycleCorrupt || record.lifecycleState?.terminationBlocked) {
        continue;
      }
      if (record.lifecycleState?.terminationPending) {
        if (shouldRetryPendingTermination(record, now)) {
          await this.drivePendingTermination(record);
        }
        continue;
      }
      if (record.status !== "running" && record.status !== "starting") continue;
      const supervisorObservedAt = new Date(now).toISOString();
      this.store.touchDispatcherHeartbeatCAS(record.id, supervisorObservedAt);
      if (record.externalRuntimeBinding?.runtimeKind === "HERDR" && !this.herdrTurnTasks.has(record.id)) {
        const settled = await this.reconcileStaleHerdRSession(record);
        if (settled) continue;
      }
      const contract: ExecutionContract = record.executionContract ?? {};

      // Active turn phase timestamps are persisted in `lifecycleState.activeTurn`.
      // `updatedAt` is not an authoritative phase clock.
      const activeTurn = record.lifecycleState?.activeTurn;
      const turnStartedAtMs = activeTurn?.turnStartedAt
        ? Date.parse(activeTurn.turnStartedAt)
        : Date.parse(record.updatedAt);
      const executionStartedAtMs = activeTurn?.executionStartedAt
        ? Date.parse(activeTurn.executionStartedAt)
        : undefined;
      const lastActivityAtMs = activeTurn?.lastActivityAt
        ? Date.parse(activeTurn.lastActivityAt)
        : turnStartedAtMs;

      // 1. maxWallMs: Whole-turn hard ceiling (turnStartedAt -> terminal)
      if (contract.maxWallMs && now - turnStartedAtMs > contract.maxWallMs) {
        await this.terminateActiveAgent(
          record.id,
          "timeout",
          `Agent exceeded execution contract maxWallMs of ${contract.maxWallMs}ms.`,
          "any",
          contract.maxWallMs,
        );
        continue;
      }

      // 2. maxStartupMs: Startup/readiness bound (turnStartedAt -> executionStartedAt)
      if (contract.maxStartupMs && executionStartedAtMs === undefined) {
        if (now - turnStartedAtMs > contract.maxStartupMs) {
          await this.terminateActiveAgent(
            record.id,
            "timeout",
            `Agent exceeded execution contract maxStartupMs of ${contract.maxStartupMs}ms during startup/readiness.`,
            "startup",
            contract.maxStartupMs,
          );
          continue;
        }
      }

      // 3. maxExecutionMs: Semantic execution bound (executionStartedAt -> terminal)
      // Must not fire if executionStartedAt is not yet established.
      if (contract.maxExecutionMs && executionStartedAtMs !== undefined) {
        if (now - executionStartedAtMs > contract.maxExecutionMs) {
          await this.terminateActiveAgent(
            record.id,
            "timeout",
            `Agent exceeded execution contract maxExecutionMs of ${contract.maxExecutionMs}ms during execution.`,
            "execution",
            contract.maxExecutionMs,
          );
          continue;
        }
      }

      // 4. Effective execution-idle policy is resolved before provider launch
      // and persisted per turn. Continuation therefore defaults back to the
      // current profile/provider policy instead of inheriting a prior explicit override.
      const effectiveIdleTimeoutMs = activeTurn?.executionIdlePolicy?.timeoutMs;
      if (effectiveIdleTimeoutMs && executionStartedAtMs !== undefined && now - lastActivityAtMs > effectiveIdleTimeoutMs) {
        await this.terminateActiveAgent(
          record.id,
          "idle_timeout",
          `Agent exceeded effective execution idle timeout of ${effectiveIdleTimeoutMs}ms without provider activity.`,
          "idle",
          effectiveIdleTimeoutMs,
        );
        continue;
      }

      if ((contract.writePaths?.length || contract.maxFiles !== undefined) && record.status === "running") {
        const baseline = record.scopeBaseline;
        if (baseline) {
          const physical = await inspectWorkspacePhysicalState(record.workspaceRoot);
          if (physical.gitAvailable) {
            const delta = computeWorkerDelta(physical, baseline);
            const headAdvanced = Boolean(baseline.head && physical.head && baseline.head !== physical.head);
            if (
              (delta.changedPaths.length > 0 || headAdvanced) &&
              activeTurn?.generation &&
              record.workerToken
            ) {
              this.store.recordFirstEffectCAS(
                record.id,
                activeTurn.generation,
                record.workerToken,
                supervisorObservedAt,
              );
            }
            const { scopeState, unexpectedPaths } = this.classifyWorkerScope(
              delta.changedPaths,
              contract.writePaths,
              contract.maxFiles,
              delta.attribution,
            );
            if (scopeState === "SCOPE_VIOLATION") {
              await this.terminateActiveAgent(
                record.id,
                "scope_violation",
                `Worker wrote outside the declared write scope. Offending paths: ${unexpectedPaths.join(", ")}`,
              );
            }
          }
        }
      }
    }
  }

  /** Number of agents holding an execution slot, including physical cleanup. */
  runningCount(): number {
    return this.store
      .list()
      .filter(occupiesDetachedExecutionSlot).length;
  }

  private executionCapacitySnapshot(workspaceRoot?: string): AgentPreflightOutput["capacity"] {
    const active = this.store.list().filter(occupiesDetachedExecutionSlot);
    const activeInWorkspace = workspaceRoot
      ? active.filter((record) => isSameWorktreePath(record.workspaceRoot, workspaceRoot)).length
      : 0;
    let liveActive = 0;
    let unreconciledStale = 0;
    for (const record of active) {
      if (record.externalRuntimeBinding?.runtimeKind === "HERDR") {
        if (this.herdrTurnTasks.has(record.id) || this.herdrVerifiedLive.has(record.id)) {
          liveActive++;
        } else {
          unreconciledStale++;
        }
      } else {
        liveActive++;
      }
    }
    return summarizeExecutionCapacity(
      active.length,
      this.config.agentMaxConcurrent,
      activeInWorkspace,
      liveActive,
      unreconciledStale,
    );
  }

  /** Compatibility predicate backed by the canonical capacity snapshot. */
  private hasExecutionCapacity(): boolean {
    return this.executionCapacitySnapshot().localState === "AVAILABLE";
  }

  private assertDispatchOwnershipAvailable(workspaceRoot: string, contract: ExecutionContract | undefined): void {
    const intent = contract?.dispatchIntent;
    const writeScope = contract?.writePaths ?? [];
    if (!intent?.exclusiveOwnership || writeScope.length === 0) return;

    for (const record of this.store.list()) {
      if (!occupiesDetachedExecutionSlot(record)) continue;
      if (!isSameWorktreePath(record.workspaceRoot, workspaceRoot)) continue;

      const activeWriteScope = record.executionContract?.writePaths;
      const activeIntent = record.executionContract?.dispatchIntent;
      if (!activeWriteScope?.length) {
        if (activeIntent && (activeIntent.writeScope?.length ?? 0) === 0) continue;
        throw new AgentSessionError(
          "OVERLAPPING_MUTATION_OWNERSHIP",
          `Active agent ${record.id} in the same workspace has no provable write ownership; serialize or use an isolated workspace before dispatching ${intent.taskId}/${intent.attemptId}.`,
        );
      }
      if (writeScopesOverlap(writeScope, activeWriteScope)) {
        throw new AgentSessionError(
          "OVERLAPPING_MUTATION_OWNERSHIP",
          `Dispatch ${intent.taskId}/${intent.attemptId} overlaps active agent ${record.id} write ownership; serialize or use isolated worktrees/workspaces.`,
        );
      }
    }
  }

  private normalizeAuthReadiness(value: ReadinessValue): ExecutionAuthReadiness {
    if (value === true) return "READY";
    if (value === false) return "NOT_READY";
    return "UNKNOWN";
  }

  private resolveHostGeneration(): HostGenerationBinding | undefined {
    if (!this.capabilityManifestSha256) return undefined;
    return buildHostGenerationBinding({
      hostName: hostname(),
      platform: platform(),
      arch: arch(),
      homeDir: process.env.HOME ?? homedir(),
      pathEnv: process.env.PATH ?? "",
      nodeVersion: process.versions.node,
      stateRoot: resolvePath(this.config.stateDir),
      capabilityManifestSha256: this.capabilityManifestSha256,
      adapterGeneration: `local-agent:${this.config.agentExecutionBackend === "herdr" ? "herdr" : "legacy"}:v1`,
    });
  }

  private resolveExecutionGeneration(
    profile: LocalAgentProfile,
    profileCatalogGeneration: string,
    environment: NodeJS.ProcessEnv,
  ): ExecutionGenerationBinding {
    const availability = checkLocalAgentProviderAvailability(profile.provider, environment);
    if (!availability.available) {
      throw new AgentSessionError(
        "REBIND_REQUIRED",
        `Provider '${profile.provider}' is unavailable while rebinding execution generation: ${availability.reason ?? "unknown reason"}`,
      );
    }
    const codexRuntime = profile.provider === "codex"
      ? inspectCodexRuntime({ env: environment })
      : undefined;
    if (codexRuntime && !codexRuntime.ready) {
      throw new AgentSessionError(
        "REBIND_REQUIRED",
        `Codex runtime is unavailable while rebinding execution generation: ${codexRuntime.reason ?? "unknown reason"}`,
      );
    }
    const executable = codexRuntime?.executable
      ?? resolveLocalAgentProviderExecutable(profile.provider, environment)
      ?? profile.provider;
    const runtimeVersion = codexRuntime?.binaryVersion
      ?? getLocalAgentProviderRuntimeVersion(profile.provider, environment);
    return buildExecutionGenerationBinding({
      profileCatalogGeneration,
      provider: profile.provider,
      model: profile.model,
      executionIdentity: executable,
      runtimeVersion,
      devspaceBuildId: this.runtimeBuildIdentity.buildId,
      devspaceSourceCommit: this.runtimeBuildIdentity.sourceCommit,
      hostGeneration: this.resolveHostGeneration(),
      authReadiness: "UNKNOWN",
    });
  }

  private async buildLifecycleEvidence(
    record: LocalAgentRecord,
  ): Promise<LifecycleEvidence | undefined> {
    const physical = await inspectWorkspacePhysicalState(record.workspaceRoot);
    const timing = computeSessionTiming(record);

    const changedPaths = record.scopeBaseline
      ? computeWorkerDelta(physical, record.scopeBaseline).changedPaths
      : physical.changedPaths;

    return {
      startedAt: record.createdAt,
      lastActivityAt: record.lifecycleState?.activeTurn?.lastActivityAt ?? record.updatedAt,
      lastFileMutationAt: physical.lastFileMutationAt,
      wallMs: timing.wallMs,
      idleMs: timing.idleMs,
      changedPaths: physical.gitAvailable ? changedPaths : undefined,
      terminalReason: record.terminalReason,
      scopeState: record.scopeState,
    };
  }

  /**
   * Evaluate scope for the agent's whole durable lifecycle: the current turn's
   * worker delta is unioned with every previously attributed path so that
   * writePaths/maxFiles stay enforced across continuation turns. A continuation
   * cannot widen authority by resetting the accounting with a fresh baseline.
   */
  private async computeCumulativeScopeEvidence(
    agentId: string,
  ): Promise<{ scopeState: ScopeState; unexpectedPaths: string[]; workerChangedPaths: string[] }> {
    const record = this.store.getById(agentId);
    if (!record) {
      return { scopeState: "UNKNOWN" as ScopeState, unexpectedPaths: [], workerChangedPaths: [] };
    }
    const physical = await inspectWorkspacePhysicalState(record.workspaceRoot);
    if (!physical.gitAvailable) {
      return { scopeState: "UNKNOWN" as ScopeState, unexpectedPaths: [], workerChangedPaths: [] };
    }
    const delta = computeWorkerDelta(physical, record.scopeBaseline);
    const cumulative = new Set(record.lifecycleState?.cumulativeChangedPaths ?? []);
    for (const path of delta.changedPaths) cumulative.add(path);
    const workerChangedPaths = [...cumulative].sort();
    const contract = record.executionContract;
    const classification = this.classifyWorkerScope(
      workerChangedPaths,
      contract?.writePaths,
      contract?.maxFiles,
      delta.attribution,
    );
    return {
      scopeState: classification.scopeState,
      unexpectedPaths: classification.unexpectedPaths,
      workerChangedPaths,
    };
  }

  private classifyWorkerScope(
    workerChanged: string[],
    writePaths: string[] | undefined,
    maxFiles: number | undefined,
    attribution: WorkerAttribution,
  ): { scopeState: ScopeState; unexpectedPaths: string[] } {
    const pathResult = classifyScopeState(workerChanged, writePaths);
    if (pathResult.scopeState === "SCOPE_VIOLATION") return pathResult;
    if (maxFiles !== undefined && workerChanged.length > maxFiles) {
      return { scopeState: "SCOPE_VIOLATION", unexpectedPaths: workerChanged };
    }
    if (attribution === "UNKNOWN") {
      return { scopeState: "UNKNOWN", unexpectedPaths: pathResult.unexpectedPaths };
    }
    return { scopeState: pathResult.scopeState, unexpectedPaths: pathResult.unexpectedPaths };
  }

  private async inspectStaleHerdRReclaimEvidence(
    record: LocalAgentRecord,
    exactGitHeadWhenNoBaseline?: string,
  ) {
    let physical;
    try {
      physical = await inspectWorkspacePhysicalState(record.workspaceRoot);
    } catch {
      return undefined;
    }
    if (!physical.gitAvailable) return undefined;

    if (!record.scopeBaseline) {
      if (
        !exactGitHeadWhenNoBaseline ||
        physical.head !== exactGitHeadWhenNoBaseline ||
        physical.changedPaths.length !== 0
      ) {
        return undefined;
      }
      return {
        physical,
        delta: { changedPaths: [] as string[], attribution: "KNOWN" as const },
        scope: this.classifyWorkerScope(
          [],
          record.executionContract?.writePaths,
          record.executionContract?.maxFiles,
          "KNOWN",
        ),
      };
    }

    const delta = computeWorkerDelta(physical, record.scopeBaseline);
    if (delta.attribution !== "KNOWN") return undefined;
    return {
      physical,
      delta,
      scope: this.classifyWorkerScope(
        delta.changedPaths,
        record.executionContract?.writePaths,
        record.executionContract?.maxFiles,
        delta.attribution,
      ),
    };
  }

  /**
   * Reconciles stale/orphaned HerdR agent sessions holding execution slots.
   * Enforces 5D lifecycle matrix:
   * - Positive external absence (workspace/agent confirmed absent) -> reclaim slot with physical effect preserved.
   * - Lost handle -> terminate with error, preserving physical effect.
   * - Unreachable / identity mismatch -> fail-closed (slot not released, marked unreconciled).
   */
  async reconcileStaleHerdRSessions(): Promise<number> {
    const all = this.store.list();
    const candidates = all
      .filter((record) => occupiesDetachedExecutionSlot(record) && record.externalRuntimeBinding?.runtimeKind === "HERDR");
    let reclaimed = 0;
    for (const record of candidates) {
      if (this.herdrTurnTasks.has(record.id)) {
        continue;
      }
      const settled = await this.reconcileStaleHerdRSession(record);
      if (settled) reclaimed++;
    }
    return reclaimed;
  }

  private async reconcileStaleHerdRSession(record: LocalAgentRecord): Promise<boolean> {
    const agentId = record.id;
    const generation = record.lifecycleState?.activeTurn?.generation;
    const handle = this.getHerdrExternalHandle(agentId);

    // 1. Lost durable handle: reclaim only after exact external absence and
    // physical workspace state are both proven. Missing evidence stays fenced.
    if (!handle) {
      this.herdrVerifiedLive.delete(agentId);
      const launch = record.externalRuntimeBinding?.launch;
      if (
        !launch ||
        (launch.state !== "WORKSPACE_OBSERVED" &&
          launch.state !== "AGENT_OBSERVED" &&
          launch.state !== "FENCED" &&
          launch.state !== "OUTCOME_UNKNOWN") ||
        !launch.herdrSocketPath
      ) {
        return false;
      }

      const targetSocket = normalizeHerdrSocketPath(launch.herdrSocketPath);
      if (!await this.herdrGateway.pingServer(2000, targetSocket)) {
        return false;
      }

      let externallyAbsent = false;
      try {
        if (
          (launch.state === "AGENT_OBSERVED" || launch.state === "WORKSPACE_OBSERVED") &&
          launch.herdrAgentIdentity &&
          launch.herdrWorkspaceId &&
          launch.herdrPaneId
        ) {
          externallyAbsent = await this.herdrGateway.confirmObservedLaunchAbsent(launch);
        } else {
          externallyAbsent = await this.herdrGateway.confirmPreAgentLaunchAbsent(launch);
        }
      } catch {
        return false;
      }
      if (!externallyAbsent) return false;

      const evidence = await this.inspectStaleHerdRReclaimEvidence(record, launch.gitHeadBefore);
      if (!evidence) return false;
      const { physical, delta, scope } = evidence;
      const terminalReason: AgentTerminalReason =
        scope.scopeState === "SCOPE_VIOLATION"
          ? "scope_violation"
          : record.status === "starting"
            ? "launch_failed"
            : "provider_error";
      const error =
        scope.scopeState === "SCOPE_VIOLATION"
          ? `Worker wrote outside declared scope: ${scope.unexpectedPaths.join(", ")}`
          : "Lost durable HerdR handle after exact external absence proof; reclaimed stale slot.";

      const settled = this.store.finishExternalRuntimeTurnCAS({
        agentId,
        generation: generation ?? record.lifecycleState?.lastSettledGeneration ?? "",
        status: "error",
        error,
        errorCode: scope.scopeState === "SCOPE_VIOLATION"
          ? "SCOPE_VIOLATION"
          : "AGENT_LIFECYCLE_CORRUPT",
        errorRetryable: false,
        terminalReason,
        scopeState: scope.scopeState,
        cumulativeChangedPaths: Array.from(new Set([
          ...(record.lifecycleState?.cumulativeChangedPaths ?? []),
          ...delta.changedPaths,
        ])).sort(),
        turnEndBaseline: {
          changedPaths: physical.changedPaths,
          head: physical.head ?? null,
          fingerprints: physical.fingerprints,
        },
      });
      return settled.applied;
    }

    // 2. Durable handle present: observe HerdR live identity
    const targetSocket = normalizeHerdrSocketPath(handle.herdrSocketPath);
    const pingOk = await this.herdrGateway.pingServer(2000, targetSocket);

    if (!pingOk) {
      // HerdR is unreachable -> Fail-closed: do not release capacity or assume absence
      this.herdrVerifiedLive.delete(agentId);
      return false;
    }

    let liveObs;
    try {
      liveObs = await this.herdrGateway.observeAndValidateLiveHandle({
        herdrWorkspaceId: handle.herdrWorkspaceId,
        herdrPaneId: handle.herdrPaneId,
        canonicalWorktreePath: canonicalizePath(handle.canonicalWorktreePath),
        herdrAgentIdentity: handle.herdrAgentIdentity,
        herdrAgentKind: handle.herdrAgentKind,
        herdrSocketPath: targetSocket,
      });
    } catch {
      this.herdrVerifiedLive.delete(agentId);
      return false;
    }

    if (liveObs.valid && liveObs.agent) {
      if (liveObs.agent.agent_status === "running" || liveObs.agent.agent_status === "prompting") {
        this.herdrVerifiedLive.add(agentId);
        return false;
      }
    }
    this.herdrVerifiedLive.delete(agentId);

    const evidence = await this.inspectStaleHerdRReclaimEvidence(record, handle.gitHeadBefore);
    if (!evidence) return false;
    const { physical, delta, scope } = evidence;

    try {
      await this.herdrGateway.stopExternalAgent(handle, { store: this.store });
    } catch {
      // Any absence/identity ambiguity remains fail-closed.
      return false;
    }

    const terminalStatus = scope.scopeState === "SCOPE_VIOLATION" ? "error" : "stopped";
    const terminalReason: AgentTerminalReason =
      scope.scopeState === "SCOPE_VIOLATION" ? "scope_violation" : "cancelled";

    const settled = this.store.finishExternalRuntimeTurnCAS({
      agentId,
      generation: generation ?? record.lifecycleState?.lastSettledGeneration ?? "",
      status: terminalStatus,
      error: scope.scopeState === "SCOPE_VIOLATION"
        ? `Worker wrote outside declared scope: ${scope.unexpectedPaths.join(", ")}`
        : undefined,
      errorCode: scope.scopeState === "SCOPE_VIOLATION" ? "SCOPE_VIOLATION" : undefined,
      errorRetryable: false,
      terminalReason,
      scopeState: scope.scopeState,
      cumulativeChangedPaths: delta ? Array.from(new Set([
        ...(record.lifecycleState?.cumulativeChangedPaths ?? []),
        ...delta.changedPaths,
      ])).sort() : record.lifecycleState?.cumulativeChangedPaths,
      turnEndBaseline: physical ? {
        changedPaths: physical.changedPaths,
        head: physical.head ?? null,
        fingerprints: physical.fingerprints,
      } : undefined,
    });
    return settled.applied;
  }

  private async terminateActiveAgent(
    agentId: string,
    reason: AgentTerminalReason,
    message: string,
    expectedPhase?: "startup" | "execution" | "idle" | "any",
    budgetMs?: number,
    terminalStatus: "error" | "stopped" = "error",
  ): Promise<boolean> {
    const existing = this.store.getById(agentId);
    if (existing?.externalRuntimeBinding?.runtimeKind === "HERDR") {
      const handle = this.getHerdrExternalHandle(agentId);
      if (!handle) {
        return this.reconcileStaleHerdRSession(existing);
      }
      try {
        await this.herdrGateway.stopExternalAgent(handle, { store: this.store });
        const generation = existing.lifecycleState?.activeTurn?.generation;
        if (!generation) return true;
        const physical = await inspectWorkspacePhysicalState(existing.workspaceRoot);
        const delta = computeWorkerDelta(physical, existing.scopeBaseline);
        const scope = this.classifyWorkerScope(
          delta.changedPaths,
          existing.executionContract?.writePaths,
          existing.executionContract?.maxFiles,
          delta.attribution,
        );
        const settled = this.store.finishExternalRuntimeTurnCAS({
          agentId,
          generation,
          status: terminalStatus,
          error: terminalStatus === "error" ? message : undefined,
          errorCode: terminalStatus === "error" ? "PROVIDER_EXECUTION_ERROR" : undefined,
          errorRetryable: terminalStatus === "error" ? false : undefined,
          terminalReason: reason,
          scopeState: scope.scopeState,
          cumulativeChangedPaths: Array.from(new Set([
            ...(existing.lifecycleState?.cumulativeChangedPaths ?? []),
            ...delta.changedPaths,
          ])).sort(),
          turnEndBaseline: {
            changedPaths: physical.changedPaths,
            head: physical.head ?? null,
            fingerprints: physical.fingerprints,
          },
        });
        return settled.applied || !this.store.getById(agentId)?.lifecycleState?.activeTurn;
      } catch {
        return false;
      }
    }

    const fenceResult = this.store.beginTerminationCAS({
      agentId,
      terminalReason: reason,
      error: message,
      expectedPhase,
      budgetMs,
      terminalStatus,
    });
    const fenced = fenceResult.current;
    if (!fenced?.lifecycleState?.terminationPending) {
      // A normal completion or a phase transition may have won the fence CAS.
      return true;
    }
    return this.drivePendingTermination(fenced);
  }

  private async drivePendingTermination(record: LocalAgentRecord): Promise<boolean> {
    if (
      !isDetachedLifecycle(record.lifecycleState) ||
      record.lifecycleState?.lifecycleCorrupt ||
      record.lifecycleState?.terminationBlocked
    ) {
      return false;
    }
    const pending = record.lifecycleState?.terminationPending;
    if (!pending) return true;
    const attemptKey = `${record.id}:${pending.generation}`;
    const existing = this.terminationAttempts.get(attemptKey);
    if (existing) return existing;

    const attempt = (async () => {
      let terminated = false;
      let failureDetail: string | undefined;
      try {
        terminated = await this.terminator(record);
      } catch (error) {
        failureDetail = error instanceof Error ? error.message : String(error);
      }
      if (!terminated) {
        const failure = `${record.error ?? "Termination requested."} Worker termination could not be verified.${
          failureDetail ? ` ${failureDetail}` : ""
        }`;
        this.store.recordTerminationFailureCAS({
          agentId: record.id,
          generation: pending.generation,
          workerPid: pending.workerPid,
          workerToken: pending.workerToken,
          failure,
        });
        return false;
      }

      try {
        // Physical absence is necessary but not sufficient. The post-kill
        // workspace snapshot and cumulative scope evidence are committed in
        // the same CAS that releases the slot and worker identity.
        const endState = await inspectWorkspacePhysicalState(record.workspaceRoot);
        const scope = await this.computeCumulativeScopeEvidence(record.id);
        const completed = this.store.completeTerminationCAS({
          agentId: record.id,
          generation: pending.generation,
          workerPid: pending.workerPid,
          workerToken: pending.workerToken,
          turnEndBaseline: {
            changedPaths: endState.changedPaths,
            head: endState.head ?? null,
            fingerprints: endState.fingerprints,
          },
          cumulativeChangedPaths: scope.workerChangedPaths,
          scopeState: scope.scopeState,
        });
        if (completed.applied) return true;
        const current = this.store.getById(record.id);
        return current?.lifecycleState?.terminationPending?.generation !== pending.generation;
      } catch (error) {
        const failure = `Physical termination was verified, but post-termination evidence could not be finalized: ${
          error instanceof Error ? error.message : String(error)
        }`;
        this.store.recordTerminationFailureCAS({
          agentId: record.id,
          generation: pending.generation,
          workerPid: pending.workerPid,
          workerToken: pending.workerToken,
          failure,
        });
        return false;
      }
    })();
    this.terminationAttempts.set(attemptKey, attempt);
    try {
      return await attempt;
    } finally {
      if (this.terminationAttempts.get(attemptKey) === attempt) {
        this.terminationAttempts.delete(attemptKey);
      }
    }
  }

  /**
   * Run the worker turn for an agent, reading the prompt from a temp file.
   * Used by CLI __worker subcommand.
   * Cleans up the owned prompt temp file after execution (success or failure).
   */
  async runWorkerTurnFromFile(agentId: string, promptFile: string, workerToken: string): Promise<void> {
    const initial = this.store.getById(agentId);
    if (!initial) throw new Error(`Unknown subagent id: ${agentId}`);
    const generation = initial.lifecycleState?.activeTurn?.generation
      ?? initial.lifecycleState?.terminationPending?.generation;
    if (!generation) {
      cleanupOwnedPromptFile(promptFile);
      return;
    }
    const claim = this.store.claimWorkerCAS(agentId, generation, workerToken, process.pid);
    const claimed = claim.current;
    if (
      !claim.applied ||
      !claimed ||
      claimed.status !== "running" ||
      claimed.lifecycleState?.activeTurn?.generation !== generation
    ) {
      cleanupOwnedPromptFile(promptFile);
      return;
    }

    const prompt = await readFile(promptFile, "utf8");
    let scratch: ScratchHandle | undefined;
    try {
      // Containment gate (fail closed): the workspace root must resolve to its
      // canonical physical path and stay inside a configured allowed root.
      // Git linked worktrees remain legitimate: canonicalization resolves their
      // real path, and an allowed root may itself be the linked worktree.
      try {
        assertWorkspaceContainment(this.config, claimed.workspaceRoot);
      } catch (error) {
        throw new WorkspaceContainmentError(
          error instanceof Error ? error.message : String(error),
        );
      }

      scratch = createProviderScratch(claimed.id);

      // Snapshot the physical workspace BEFORE any provider mutation so that
      // pre-existing changes are never attributed to this worker turn.
      // The baseline is always captured: reconciliation must be able to report a
      // physical diff as candidate evidence even when no execution contract
      // bounds writes (e.g. a manually started agent with no writePaths/maxFiles).
      const state = await inspectWorkspacePhysicalState(claimed.workspaceRoot);
      const baseline = this.store.updateTurnEvidenceCAS(claimed.id, generation, workerToken, {
        scopeBaseline: {
          changedPaths: state.changedPaths,
          head: state.head ?? null,
          fingerprints: state.fingerprints,
        },
      });
      if (!baseline.applied) {
        throw new Error(`Agent ${claimed.id} lost turn generation before baseline capture.`);
      }

      const profiles = await loadLocalAgentProfiles(this.config, claimed.workspaceRoot);
      // Direct provider/model selections are durable records without a disk
      // profile. Reconstruct the exact execution identity from the record so
      // worker reloads and continuation turns use the same normal profile
      // runner and security gates.
      const directSelection = claimed.executionContract?.directSelection;
      const catalogReceipt = claimed.executionContract?.catalogReceipt;
      if (catalogReceipt && (claimed.provider !== catalogReceipt.provider
        || (claimed.model ?? undefined) !== (catalogReceipt.model ?? undefined)
        || (claimed.effort ?? undefined) !== (catalogReceipt.effort ?? undefined))) {
        throw new Error("Durable record identity does not match its catalog receipt; refusing execution.");
      }
      if (directSelection && (directSelection.provider !== claimed.provider
        || directSelection.model !== claimed.model
        || directSelection.effort !== claimed.effort)) {
        throw new Error("Durable record identity does not match its direct selection; refusing execution.");
      }
      if (catalogReceipt?.provider === "opencode") {
        const liveCatalog = await this.opencodeCatalogSource.acquire();
        const runtimeIdentity = `${liveCatalog.runtime?.source ?? "unknown"}:${liveCatalog.runtime?.version ?? "unknown"}:${liveCatalog.runtime?.executable ?? "unknown"}`;
        if (liveCatalog.source !== catalogReceipt.source
          || !catalogSnapshotIsFresh(liveCatalog.fetchedAt, liveCatalog.expiresAt)
          || (liveCatalog.freshness ?? "unknown") !== catalogReceipt.freshness
          || runtimeIdentity !== catalogReceipt.runtimeIdentity) {
          throw new Error("Persisted OpenCode catalog receipt drifted before provider invocation; refusing execution.");
        }
        // Model/variant membership was already admitted against the fresh snapshot
        // captured in catalogReceipt for this exact durable turn. A second model-list
        // read may transiently omit an otherwise admitted route; do not let that
        // ephemeral observation revoke the same launch. Source/runtime/freshness drift
        // above still fails closed. Continuations revalidate current membership before
        // a new turn is created.

      }
      if (catalogReceipt?.provider === "cline") {
        const liveCatalog = await this.clineCatalogService?.refresh();
        const exact = liveCatalog?.entries.filter((entry) => entry.cliProviderId === (catalogReceipt.cliProviderId ?? "cline") && entry.fullName === catalogReceipt.model) ?? [];
        const runtimeIdentity = liveCatalog ? `${liveCatalog.runtime.cliProviderId}:${liveCatalog.runtime.version}:${liveCatalog.runtime.command}` : "unknown:unknown:unknown";
        if (!liveCatalog || liveCatalog.state !== "READY" || liveCatalog.generation !== catalogReceipt.generation
          || liveCatalog.source !== catalogReceipt.source || !isClineCatalogFresh(liveCatalog) || catalogReceipt.freshness !== "fresh" || runtimeIdentity !== catalogReceipt.runtimeIdentity || exact.length !== 1
          || (catalogReceipt.effort && (!exact[0].thinkingKnown || !exact[0].thinking.includes(catalogReceipt.effort as never)))) {
          throw new Error("Persisted Cline catalog receipt drifted before provider invocation; refusing execution.");
        }
      }
      if (directSelection) {
        if (!isLocalAgentProvider(directSelection.provider)) {
          throw new Error(`Persisted direct selection has unknown provider '${directSelection.provider}'.`);
        }
        if (claimed.provider !== directSelection.provider
          || claimed.model !== directSelection.model
          || claimed.effort !== directSelection.effort) {
          throw new Error("Persisted direct selection does not match the durable provider/model/effort identity.");
        }
      }
      const profile = directSelection
        ? {
            name: claimed.profileName,
            description: "Durable direct provider/model selection",
            provider: directSelection.provider as LocalAgentProfile["provider"],
            model: directSelection.model,
            effort: directSelection.effort,
            cliProviderId: directSelection.cliProviderId,
            write_mode: directSelection.writeMode,
            filePath: "<direct-dispatch>",
            body: "",
            disabled: false,
          }
        : profiles.find((p) => p.name === claimed.profileName);
      if (catalogReceipt && (!profile
        || profile.provider !== catalogReceipt.provider
        || (profile.model ?? undefined) !== (catalogReceipt.model ?? undefined)
        || (profile.effort ?? undefined) !== (catalogReceipt.effort ?? undefined)
        || (profile.cliProviderId ?? undefined) !== (catalogReceipt.cliProviderId ?? undefined))) {
        throw new Error("Reloaded profile identity does not match the durable catalog receipt; refusing execution.");
      }
      const requestedModel = claimed.executionContract?.directSelection?.model;
      const resolvedModel = claimed.model ?? undefined;

      const callbacks: LocalAgentRunCallbacks = {
        onActivity: () => {
          this.store.touchActivityCAS(claimed.id, generation, workerToken);
        },
        onExecutionStarted: () => {
          this.store.markExecutionStarted(claimed.id, workerToken, undefined, generation);
        },
        onStreamActivity: (timestamp = new Date().toISOString()) => {
          this.store.touchStreamActivityCAS(claimed.id, generation, workerToken, timestamp);
        },
        onEffect: (timestamp = new Date().toISOString()) => {
          this.store.recordFirstEffectCAS(claimed.id, generation, workerToken, timestamp);
        },
        onModelAttestation: (attestation) => {
          const computed = computeModelAttestation({
            requestedModel,
            resolvedModel,
            observedModel: attestation.observedModel,
            attestationSource: attestation.attestationSource,
            attestedAt: attestation.attestedAt,
          });
          this.store.updateModelAttestationCAS(claimed.id, generation, workerToken, computed);
        },
        onProviderProcessState: (state) => {
          this.store.updateProviderProcessStateCAS(claimed.id, generation, workerToken, state);
        },
        onSessionId: (providerSessionId) => {
          const bound = this.store.bindProviderSessionCAS(
            claimed.id,
            generation,
            workerToken,
            providerSessionId,
          );
          if (!bound.applied) {
            throw new Error(`Agent ${claimed.id} is no longer active under its turn generation.`);
          }
          if (bound.current?.providerContinuityState === "LOST") {
            throw new Error(
              `Provider session identity changed for agent ${claimed.id}; continuity is LOST and explicit rebind is required.`,
            );
          }
        },
      };
      let result: LocalAgentRunResult;
      if (this.turnRunner) {
        result = await this.turnRunner(profile, claimed, prompt, callbacks);
      } else if (profile) {
        result = await runLocalAgentProfile(this.config, profile, claimed, prompt, scratch, callbacks);
      } else {
        result = await runRawLocalAgentProvider(this.config, claimed, prompt, scratch, callbacks);
      }

      // End-of-turn snapshot: everything that changed after this point is no
      // longer attributable to the worker (foreign mutation detection at the
      // next continuation admission).
      const endState = await inspectWorkspacePhysicalState(claimed.workspaceRoot);
      const turnEndBaseline = {
        changedPaths: endState.changedPaths,
        head: endState.head ?? null,
        fingerprints: endState.fingerprints,
      };
      const scope = await this.computeCumulativeScopeEvidence(claimed.id);
      const scopeViolated = scope.scopeState === "SCOPE_VIOLATION";
      const cumulative = new Set(this.store.getById(claimed.id)?.lifecycleState?.cumulativeChangedPaths ?? []);
      for (const path of scope.workerChangedPaths ?? []) cumulative.add(path);

      let automatedVerifierResult: Record<string, unknown> | undefined;
      const contract = claimed.executionContract;
      const configuredToolchains = this.config.toolchains ?? [];
      const toolchainId = contract?.toolchainId ?? (configuredToolchains.length > 0 ? configuredToolchains[0]?.id : undefined);
      if (toolchainId && (contract?.role === "IMPLEMENT" || contract?.role === "REPAIR" || contract?.toolchainId)) {
        const toolchain = configuredToolchains.find((candidate) => candidate.id === toolchainId);
        const verifierName = Object.keys(toolchain?.verifiers ?? {})[0];
        if (toolchain && verifierName) {
          try {
            const vRes = await runToolchainVerifier({
              toolchains: configuredToolchains,
              toolchainId,
              verifier: verifierName,
              args: [],
              cwd: claimed.workspaceRoot,
            });
            automatedVerifierResult = {
              toolchainId,
              verifier: verifierName,
              exitCode: vRes.exitCode,
              passed: vRes.exitCode === 0,
              durationMs: vRes.durationMs,
              timedOut: vRes.timedOut,
              launchFailed: Boolean(vRes.launchError),
              stdout: vRes.stdout,
              stderr: vRes.stderr,
            };
          } catch (err) {
            automatedVerifierResult = {
              toolchainId,
              verifier: verifierName,
              passed: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      }

      if (contract?.resumableWork?.workKey && this.workResumeStore && automatedVerifierResult) {
        try {
          this.workResumeStore.recordAutomatedVerifierResult(contract.resumableWork.workKey, automatedVerifierResult);
        } catch {
          // ignore
        }
      }

      const modelAttestation = computeModelAttestation({
        requestedModel,
        resolvedModel,
        observedModel: result.observedModel,
        attestationSource: result.attestationSource,
        attestedAt: result.attestedAt,
      });

      const failureClassification = scopeViolated ? classifyDispatchFailure({
        ...claimed,
        status: "error",
        error: `Agent wrote outside the declared write scope. Offending paths: ${scope.unexpectedPaths.join(", ")}`,
        scopeState: scope.scopeState,
        updatedAt: new Date().toISOString(),
      }) : undefined;

      this.store.finishTurnCAS({
        agentId,
        generation,
        workerToken,
        providerSessionId: result.providerSessionId ?? undefined,
        status: "idle",
        latestResponse: redactSensitiveText(result.finalResponse),
        error: scopeViolated
          ? `Agent wrote outside the declared write scope. Offending paths: ${scope.unexpectedPaths.join(", ")}`
          : undefined,
        terminalReason: scopeViolated ? "scope_violation" : "completed",
        scopeState: scope.scopeState,
        cumulativeChangedPaths: [...cumulative].sort(),
        turnEndBaseline,
        effectEnforcementReceipt: result.effectEnforcementReceipt,
        automatedVerifierResult,
        modelAttestation,
        dispatchFailure: failureClassification,
        });
    } catch (error) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      const message = redactSensitiveText(originalMessage);
      const scope = await this.computeCumulativeScopeEvidence(agentId);
      const endState = await inspectWorkspacePhysicalState(
        this.store.getById(agentId)?.workspaceRoot ?? claimed.workspaceRoot,
      ).catch(() => undefined);

      let providerSessionId: string | undefined;
      let latestResponse: string | undefined;
      let errorCode: string | undefined;
      let errorRetryable: boolean | undefined;
      let errorDetails: AgentProviderFailureDetails | string | undefined;

      if (AgentProviderFailureError.is(error)) {
        errorCode = error.code;
        errorRetryable = error.retryable;
        errorDetails = {
          code: error.code,
          errorClass: error.errorClass,
          retryable: error.retryable,
          model: error.model,
          variant: error.variant,
          providerSessionId: error.providerSessionId,
          providerMessage: redactSensitiveText(error.providerMessage ?? error.message),
        };
        providerSessionId = error.providerSessionId;
        latestResponse = error.providerMessage === undefined ? undefined : redactSensitiveText(error.providerMessage);
      } else if (isAgentProviderError(error)) {
        errorCode = error.code;
        errorRetryable = error.retryable;
        errorDetails = describeAgentProviderError(error);
      } else if (error instanceof LocalAgentProviderError) {
        providerSessionId = error.providerSessionId;
        latestResponse = error.finalResponse === undefined ? undefined : redactSensitiveText(error.finalResponse);
      }

      let automatedVerifierResult: Record<string, unknown> | undefined;
      const contract = claimed.executionContract;
      const configuredToolchains = this.config.toolchains ?? [];
      const toolchainId = contract?.toolchainId ?? (configuredToolchains.length > 0 ? configuredToolchains[0]?.id : undefined);
      if (toolchainId && (contract?.role === "IMPLEMENT" || contract?.role === "REPAIR" || contract?.toolchainId)) {
        const toolchain = configuredToolchains.find((candidate) => candidate.id === toolchainId);
        const verifierName = Object.keys(toolchain?.verifiers ?? {})[0];
        if (toolchain && verifierName) {
          try {
            const vRes = await runToolchainVerifier({
              toolchains: this.config.toolchains,
              toolchainId,
              verifier: verifierName,
              args: [],
              cwd: claimed.workspaceRoot,
            });
            automatedVerifierResult = {
              toolchainId,
              verifier: verifierName,
              exitCode: vRes.exitCode,
              passed: vRes.exitCode === 0,
              durationMs: vRes.durationMs,
              timedOut: vRes.timedOut,
              launchFailed: Boolean(vRes.launchError),
              stdout: vRes.stdout,
              stderr: vRes.stderr,
            };
          } catch (err) {
            automatedVerifierResult = {
              toolchainId,
              verifier: verifierName,
              passed: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      }

      if (contract?.resumableWork?.workKey && this.workResumeStore && automatedVerifierResult) {
        try {
          this.workResumeStore.recordAutomatedVerifierResult(contract.resumableWork.workKey, automatedVerifierResult);
        } catch {
          // ignore
        }
      }

      const modelAttestation = computeModelAttestation({
        requestedModel: claimed.executionContract?.directSelection?.model,
        resolvedModel: claimed.model ?? undefined,
        observedModel: (error as any)?.observedModel ?? null,
        attestationSource: (error as any)?.attestationSource,
      });

      const failureClassification = classifyDispatchFailure({
        ...claimed,
        status: "error",
        error: message,
        errorCode,
        scopeState: scope.scopeState,
        updatedAt: new Date().toISOString(),
      });

      this.store.failTurnCAS({
        agentId,
        generation,
        workerToken,
        providerSessionId,
        latestResponse,
        error: message,
        errorCode,
        errorRetryable,
        errorDetails,
        terminalReason:
          error instanceof WorkspaceContainmentError
            ? "launch_failed"
            : isAgentProviderError(error) || error instanceof LocalAgentProviderError
              ? "provider_error"
              : classifyProviderError(originalMessage),
        scopeState: scope.scopeState,
        cumulativeChangedPaths: scope.workerChangedPaths,
        turnEndBaseline: endState
          ? {
              changedPaths: endState.changedPaths,
              head: endState.head ?? null,
              fingerprints: endState.fingerprints,
            }
          : undefined,
        automatedVerifierResult,
        modelAttestation,
        dispatchFailure: failureClassification,
        });
    } finally {
      cleanupOwnedPromptFile(promptFile);
      if (scratch) {
        cleanupProviderScratch(scratch.root);
      }
    }
  }

  private async launchPrompt(agentId: string, prompt: string): Promise<void> {
    const promptFile = writeAgentPromptFile(prompt);
    try {
      await this.spawnWorker(agentId, promptFile);
    } catch (launchErr) {
      cleanupOwnedPromptFile(promptFile);
      throw new AgentSessionError(
        "WORKER_LAUNCH_FAILED",
        `Failed to launch worker for agent ${agentId}: ${launchErr instanceof Error ? launchErr.message : String(launchErr)}`,
      );
    }
  }

  /**
   * Typed cleanup for one agent's provider scratch. Refuses to run while the
   * agent's worker is active, refuses unowned paths, and never touches
   * Candidate or worktree state: this cleans DevSpace-owned scratch only.
   * Idempotent; returns structured evidence.
   */
  async cleanupAgentScratch(agentId: string): Promise<CleanupResult> {
    const record = this.store.getById(agentId);
    if (!record) {
      throw new AgentSessionError("UNKNOWN_AGENT", `Unknown agent id: ${agentId}`);
    }
    if (isDetachedLifecycle(record.lifecycleState) && record.lifecycleState?.terminationPending) {
      throw new AgentSessionError(
        "AGENT_TERMINATION_PENDING",
        `Agent ${agentId} has physical termination pending; scratch cleanup is blocked.`,
      );
    }
    if (
      isDetachedLifecycle(record.lifecycleState) &&
      (record.lifecycleState?.lifecycleCorrupt || record.lifecycleState?.terminationBlocked)
    ) {
      throw new AgentSessionError(
        "AGENT_LIFECYCLE_CORRUPT",
        `Agent ${agentId} has blocked or corrupt detached lifecycle evidence; scratch cleanup is blocked.`,
      );
    }
    if (isDetachedLifecycle(record.lifecycleState) ? occupiesDetachedExecutionSlot(record) : isActiveStatus(record.status)) {
      throw new AgentSessionError(
        "AGENT_ALREADY_RUNNING",
        `Agent ${agentId} is ${record.status}: refusing destructive cleanup while its owned worker is active.`,
      );
    }
    const root = join(tmpdir(), `${SCRATCH_DIR_PREFIX}${agentId.replaceAll(/[^A-Za-z0-9_-]/g, "_")}`);
    return cleanupProviderScratch(root);
  }

  /**
   * For CLI: get a record by prefix/id (CLI allows prefix matching, MCP does not).
   */
  getRecordByPrefixOrId(idOrPrefix: string): LocalAgentRecord | undefined {
    return this.store.get(idOrPrefix);
  }

  /**
   * For CLI: list records by workspaceRoot scope.
   */
  listRecordsByRoot(scope: { workspaceId?: string; workspaceRoot?: string }): LocalAgentRecord[] {
    return this.store.list(scope);
  }

  /**
   * For CLI: update a record.
   */
  updateRecord(id: string, patch: Parameters<LocalAgentStore["update"]>[1]): LocalAgentRecord {
    return this.store.update(id, patch);
  }

  /**
   * Create a prompt file and spawn a background worker.
   * Used directly by CLI for profile-less raw provider runs.
   */
  async spawnWorker(agentId: string, promptFile: string): Promise<void> {
    const workerToken = randomUUID();
    const current = this.store.getById(agentId);
    const generation = current?.lifecycleState?.activeTurn?.generation;
    if (!generation) throw new Error(`Agent ${agentId} has no active turn to launch.`);
    const prepared = this.store.prepareWorkerCAS(agentId, generation, workerToken);
    if (!prepared.applied) throw new Error(`Agent ${agentId} lost its turn generation before launch.`);
    try {
      const workerPid = await this.launcher(agentId, promptFile, workerToken);
      const spawned = this.store.markWorkerSpawnedCAS(
        agentId,
        generation,
        workerToken,
        typeof workerPid === "number" ? workerPid : undefined,
      );
      if (spawned.current?.lifecycleState?.terminationPending?.generation === generation) {
        await this.drivePendingTermination(spawned.current);
      }
    } catch (error) {
      const message = `Worker launch failed: ${error instanceof Error ? error.message : String(error)}`;
      const failed = this.store.failLaunchCAS(agentId, generation, workerToken, message);
      const pending = failed.current?.lifecycleState?.terminationPending;
      if (pending?.generation === generation && pending.launchState === "launching" && !pending.workerPid) {
        const endState = await inspectWorkspacePhysicalState(failed.current!.workspaceRoot);
        this.store.completeTerminationCAS({
          agentId,
          generation,
          workerPid: pending.workerPid,
          workerToken: pending.workerToken,
          turnEndBaseline: {
            changedPaths: endState.changedPaths,
            head: endState.head ?? null,
            fingerprints: endState.fingerprints,
          },
        });
      }
      throw error;
    }
  }

  /**
   * Write a prompt to a temp file and return the path.
   * Exposed for CLI use.
   */
  static writePromptFile(prompt: string): string {
    return writeAgentPromptFile(prompt);
  }

  /**
   * Create a new raw store record (for CLI use without profile).
   */
  createRecord(input: Parameters<LocalAgentStore["create"]>[0]): LocalAgentRecord {
    return this.store.create({ ...input, lifecycleKind: "detached_worker_v2" });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function isTerminalStatus(status: LocalAgentStatus): boolean {
  return status === "idle" || status === "error" || status === "stopped";
}

export function isReadinessPositive(value: ReadinessValue): boolean {
  return value === true;
}

export function classifyProviderError(message: string): AgentTerminalReason {
  if (/timed out|timeout|timedout/i.test(message)) return "timeout";
  if (/scope|writePaths|write scope/i.test(message)) return "scope_violation";
  return "provider_error";
}

function buildStartReplayBinding(
  attemptKey: string,
  input: {
    workspaceRoot: string;
    profile: LocalAgentProfile;
    prompt: string;
    executionContract?: ExecutionContract;
  },
): { key: string; requestHash: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(attemptKey)) {
    throw new AgentSessionError(
      "INVALID_ATTEMPT_KEY",
      "attemptKey must be 1-128 characters and contain only letters, numbers, '.', '_', ':', '/', or '-'.",
    );
  }
  const request = JSON.stringify({
    workspaceRoot: canonicalizePath(input.workspaceRoot),
    profileName: input.profile.name,
    provider: input.profile.provider,
    model: input.profile.model ?? null,
    effort: input.profile.effort ?? null,
    cliProviderId: input.profile.cliProviderId ?? null,
    writeMode: input.profile.write_mode ?? "read_only",
    profileBody: input.profile.body,
    prompt: input.prompt,
    executionContract: input.executionContract ?? null,
  });
  return {
    key: attemptKey,
    requestHash: createHash("sha256").update(request).digest("hex"),
  };
}

function isActiveStatus(status: LocalAgentStatus): boolean {
  return status === "starting" || status === "running";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeAgentPromptFile(prompt: string): string {
  const directory = mkdtempSync(join(tmpdir(), "devspace-agent-prompt-"));
  const filePath = join(directory, "prompt.txt");
  writeFileSync(filePath, prompt, { mode: 0o600 });
  return filePath;
}

function defaultWorkerLauncher(agentId: string, promptFile: string, workerToken: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        fileURLToPath(import.meta.resolve("./cli.js")),
        "agents",
        "__worker",
        agentId,
        "--prompt-file",
        promptFile,
        "--worker-token",
        workerToken,
      ],
      {
        detached: true,
        stdio: "ignore",
        env: process.env,
      },
    );
    child.on("spawn", () => {
      if (!child.pid) {
        reject(new Error(`Worker process for ${agentId} spawned without an observable PID.`));
        return;
      }
      child.unref();
      resolve(child.pid);
    });
    child.on("error", (err) => {
      reject(err);
    });
  });
}

export type ProcessOwnership = "owned" | "absent" | "foreign" | "unknown";

export function getWorkerProcessOwnership(
  pid: number,
  agentId: string,
  workerToken: string,
  platform: NodeJS.Platform = process.platform,
): ProcessOwnership {
  if (platform === "win32") {
    try {
      process.kill(pid, 0);
      return "unknown";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return "absent";
      }
      return "unknown";
    }
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "absent";
    if (code === "EPERM") return "foreign";
    return "unknown";
  }

  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 2_000,
  });

  if (result.error || result.status !== 0) {
    try {
      process.kill(pid, 0);
      return "unknown";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return "absent";
      return "unknown";
    }
  }

  const command = result.stdout.trim();
  if (!command) {
    try {
      process.kill(pid, 0);
      return "unknown";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return "absent";
      return "unknown";
    }
  }

  const isOwned =
    command.includes("agents __worker") &&
    command.includes(agentId) &&
    command.includes("--worker-token") &&
    command.includes(workerToken);

  return isOwned ? "owned" : "foreign";
}

async function terminateOwnedWorker(record: LocalAgentRecord): Promise<boolean> {
  const pid = record.workerPid;
  const workerToken = record.workerToken;
  if (!pid || !workerToken) {
    return record.lifecycleState?.terminationPending?.launchState === "not_started";
  }

  const initialOwnership = getWorkerProcessOwnership(pid, record.id, workerToken);
  if (initialOwnership === "absent") {
    return true;
  }
  if (initialOwnership !== "owned") {
    return false;
  }

  const killable: KillableProcess = {
    pid,
    kill(signal = "SIGTERM") {
      try {
        process.kill(pid, signal);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    },
  };

  const termReceipt = terminateProcessTree(killable, "SIGTERM", process.platform !== "win32");
  const proofRequired = termReceipt.supported;
  if (proofRequired && !termReceipt.captureComplete) return false;

  let trackedDescendants = [...termReceipt.descendants];
  const postTermState = await waitForWorkerExitOrForeign(pid, record.id, workerToken, 1_000);
  const postTermTreeState = proofRequired
    ? await waitForOwnedProcessTreeState(trackedDescendants, 1_000)
    : undefined;

  const rootTerminated = postTermState === "absent" || postTermState === "foreign";
  if (rootTerminated && (!proofRequired || postTermTreeState === "terminated")) {
    return true;
  }
  if (!rootTerminated && postTermState !== "owned") {
    return false;
  }

  if (proofRequired && postTermTreeState !== "terminated") {
    signalOwnedProcessTree(trackedDescendants, "SIGKILL", undefined, false);
  }

  if (postTermState === "owned") {
    const killReceipt = terminateProcessTree(killable, "SIGKILL", process.platform !== "win32");
    if (proofRequired && !killReceipt.captureComplete) return false;
    if (killReceipt.descendants.length > 0) {
      const merged = new Map<number, OwnedProcessIdentity>();
      for (const target of trackedDescendants) merged.set(target.pid, target);
      for (const target of killReceipt.descendants) merged.set(target.pid, target);
      trackedDescendants = [...merged.values()];
    }
  }

  const postKillState = await waitForWorkerExitOrForeign(pid, record.id, workerToken, 500);
  const postKillTreeState = proofRequired
    ? await waitForOwnedProcessTreeState(trackedDescendants, 500)
    : undefined;
  return (postKillState === "absent" || postKillState === "foreign")
    && (!proofRequired || postKillTreeState === "terminated");
}

async function waitForOwnedProcessTreeState(
  descendants: readonly OwnedProcessIdentity[],
  timeoutMs: number,
): Promise<OwnedProcessTreeState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = inspectOwnedProcessTree(descendants) ?? "unknown";
    if (state === "terminated" || state === "unknown") return state;
    await sleep(50);
  }
  return inspectOwnedProcessTree(descendants) ?? "unknown";
}

async function waitForWorkerExitOrForeign(
  pid: number,
  agentId: string,
  workerToken: string,
  timeoutMs: number,
): Promise<ProcessOwnership> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ownership = getWorkerProcessOwnership(pid, agentId, workerToken);
    if (ownership !== "owned") {
      return ownership;
    }
    await sleep(50);
  }
  return getWorkerProcessOwnership(pid, agentId, workerToken);
}

async function runLocalAgentProfile(
  config: ServerConfig,
  profile: LocalAgentProfile,
  record: LocalAgentRecord,
  prompt?: string,
  scratch?: ScratchHandle,
  callbacks?: LocalAgentRunCallbacks,
): Promise<LocalAgentRunResult> {
  const effectivePrompt = prompt ?? "";
  const body = profile.body.trim();
  const fullPrompt = body ? `${body}\n\nTask:\n${effectivePrompt}` : effectivePrompt;
  const environment = providerEnvironment(config, record, scratch);
  return runLocalAgentProvider(
    profile.provider,
    {
      prompt: fullPrompt,
      workspaceRoot: record.workspaceRoot,
      providerSessionId: record.providerSessionId,
      writeMode: profile.write_mode === "allowed" ? "allowed" : "read_only",
      model: record.model ?? profile.model,
      effort: record.effort ?? profile.effort,
      cliProviderId: profile.cliProviderId,
      selectedToolIntents: record.executionContract?.toolProjectionManifest?.selectedTools,
      writePaths: record.executionContract?.writePaths,
      effectProjection: record.executionContract?.effectProjection,
      environment,
    },
    callbacks,
  );
}

async function runRawLocalAgentProvider(
  config: ServerConfig,
  record: LocalAgentRecord,
  prompt?: string,
  scratch?: ScratchHandle,
  callbacks?: LocalAgentRunCallbacks,
): Promise<LocalAgentRunResult> {
  const { isLocalAgentProvider } = await import("./local-agent-profiles.js");
  if (record.profileName !== record.provider || !isLocalAgentProvider(record.provider)) {
    throw new Error(`Subagent profile not found: ${record.profileName}`);
  }
  const environment = providerEnvironment(config, record, scratch);
  return runLocalAgentProvider(
    record.provider,
    {
      prompt: prompt ?? "",
      workspaceRoot: record.workspaceRoot,
      providerSessionId: record.providerSessionId,
      writeMode: "read_only",
      model: record.model,
      effort: record.effort,
      selectedToolIntents: record.executionContract?.toolProjectionManifest?.selectedTools,
      writePaths: record.executionContract?.writePaths,
      effectProjection: record.executionContract?.effectProjection,
      environment,
    },
    callbacks,
  );
}

/**
 * Per-turn provider environment: the verified toolchain bridge environment when
 * an execution contract binds one, plus the owned provider-scratch location.
 * Providers that honor DEVSPACE_PROVIDER_SCRATCH keep their transient state
 * outside the product repository.
 */
function providerEnvironment(
  config: ServerConfig,
  record: LocalAgentRecord,
  scratch?: ScratchHandle,
): NodeJS.ProcessEnv {
  let environment: NodeJS.ProcessEnv = withInstalledNexusCertifyOnPath(process.env);
  if (record.executionContract?.toolchainId) {
    try {
      environment = buildToolchainEnvironment(
        config.toolchains,
        record.executionContract.toolchainId,
        record.workspaceRoot,
      );
    } catch {
      // The turn proceeds with the server environment; the toolchain bridge was
      // already validated at start/preflight. Verification will surface drift.
      environment = withInstalledNexusCertifyOnPath(process.env);
    }
  }
  return scratch
    ? { ...environment, DEVSPACE_PROVIDER_SCRATCH: scratch.root }
    : environment;
}

function assertDispatchContractCoherence(contract: ExecutionContract | undefined): void {
  const intent = contract?.dispatchIntent;
  if (!intent) return;
  try {
    validateDispatchIntent(intent);
  } catch (error) {
    throw new AgentSessionError(
      "DISPATCH_CONTRACT_REJECTED",
      `DISPATCH_CONTRACT_REJECTED: ${error instanceof Error ? error.message : String(error)}; provider_effect=false`,
    );
  }
  const intentWriteScope = [...(intent.writeScope ?? [])].sort();
  const executionWriteScope = [...(contract?.writePaths ?? [])].sort();
  if (intentWriteScope.join("\n") !== executionWriteScope.join("\n")) {
    throw new AgentSessionError(
      "DISPATCH_CONTRACT_REJECTED",
      "DISPATCH_CONTRACT_REJECTED: executionContract.dispatchIntent.writeScope must exactly match executionContract.writePaths; DevSpace does not maintain two write-scope authorities. provider_effect=false",
    );
  }
}

function bindDispatchIntentToPrompt(intent: DispatchIntent | undefined, prompt: string): string {
  if (!intent) return prompt;
  return `${renderDispatchIntentForWorker(intent)}\n\nCONTROLLER TASK\n${prompt}`;
}

function dispatchContractOutput(intent: DispatchIntent | undefined): DispatchContractOutput | undefined {
  if (!intent) return undefined;
  return {
    taskId: intent.taskId,
    attemptId: intent.attemptId,
    roleIntent: intent.roleIntent,
    claimCeiling: intent.claimCeiling,
    verificationRequired: intent.verificationRequired,
    exclusiveOwnership: intent.exclusiveOwnership,
    intentHash: hashDispatchIntent(intent),
  };
}

const NEXUS_CANONICAL_REMOTE = "https://github.com/James3014/Nexus-new.git";
const NEXUS_RAW_HOST = "raw.githubusercontent.com";
const NEXUS_AUTHORITY_FETCH_TIMEOUT_MS = 10_000;
const NEXUS_AUTHORITY_MAX_BYTES = 256 * 1024;

async function resolveCanonicalNexusExecutionGrant(ref: NexusExecutionGrantRef): Promise<NexusExecutionGrant> {
  const observedMain = observeCanonicalNexusMain();
  const [grantRaw, authorityRaw] = await Promise.all([
    fetchCanonicalNexusText(ref.revision, ref.grantPath),
    fetchCanonicalNexusText(ref.revision, ref.authorityPath),
  ]);
  return validateResolvedNexusExecutionGrant(ref, grantRaw, authorityRaw, observedMain);
}

function observeCanonicalNexusMain(): string {
  const probe = spawnSync("git", ["ls-remote", NEXUS_CANONICAL_REMOTE, "refs/heads/main"], {
    encoding: "utf8",
    timeout: NEXUS_AUTHORITY_FETCH_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024,
  });
  if (probe.error || probe.status !== 0) {
    throw new ExecutionProtocolError(
      "NEXUS_AUTHORITY_NOT_VALIDATED",
      `Unable to resolve canonical Nexus main: ${probe.error?.message ?? String(probe.stderr || `git exited ${probe.status}`)}`,
    );
  }
  const match = /^([0-9a-f]{40})\s+refs\/heads\/main\s*$/m.exec(String(probe.stdout || ""));
  if (!match) {
    throw new ExecutionProtocolError("NEXUS_AUTHORITY_NOT_VALIDATED", "Canonical Nexus main probe returned malformed identity.");
  }
  return match[1];
}

async function fetchCanonicalNexusText(revision: string, path: string): Promise<string> {
  const encodedPath = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const url = new URL(`https://${NEXUS_RAW_HOST}/James3014/Nexus-new/${revision}/${encodedPath}`);
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(NEXUS_AUTHORITY_FETCH_TIMEOUT_MS),
    headers: { Accept: "text/plain" },
  });
  if (!response.ok || new URL(response.url).hostname !== NEXUS_RAW_HOST) {
    throw new ExecutionProtocolError(
      "NEXUS_AUTHORITY_NOT_VALIDATED",
      `Canonical Nexus authority fetch failed closed for ${path} (HTTP ${response.status}).`,
    );
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > NEXUS_AUTHORITY_MAX_BYTES) {
    throw new ExecutionProtocolError("NEXUS_AUTHORITY_NOT_VALIDATED", `Canonical Nexus authority artifact ${path} exceeds the bounded size limit.`);
  }
  return raw;
}

function writeScopesOverlap(left: string[], right: string[]): boolean {
  return left.some((leftPath) => right.some((rightPath) => workspacePathsOverlap(leftPath, rightPath)));
}

function workspacePathsOverlap(left: string, right: string): boolean {
  const a = left.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const b = right.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function recordToStartOutput(record: LocalAgentRecord, herdrHandle?: HerdrExternalHandle): StartAgentOutput {
  const output: StartAgentOutput = {
    agentId: record.id,
    status: record.status,
    profileName: record.profileName,
    provider: record.provider,
    workspaceRoot: record.workspaceRoot,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (herdrHandle !== undefined) {
    output.herdrHandle = herdrHandle;
    output.runtime = herdrRuntimeOutput(herdrHandle);
  }
  if (record.model !== undefined) output.model = record.model;
  if (record.effort !== undefined) output.effort = record.effort;
  if (record.workspaceId !== undefined) output.workspaceId = record.workspaceId;
  const executionIdlePolicy = record.lifecycleState?.activeTurn?.executionIdlePolicy
    ?? record.lifecycleState?.lastExecutionIdlePolicy;
  if (executionIdlePolicy) output.executionIdlePolicy = executionIdlePolicy;
  const dispatch = dispatchContractOutput(record.executionContract?.dispatchIntent);
  if (dispatch) output.dispatch = dispatch;
  return output;
}

type ProviderEffectKnowledge = "present" | "none" | "unknown";

/**
 * Whether the failed turn may have produced a source effect. "none" requires
 * positive evidence (a known scope state with no changed paths); anything else
 * is "unknown" and must be treated as a possible effect so callers never
 * blind-retry into a duplicate mutation.
 */
function providerEffectKnowledge(record: LocalAgentRecord): ProviderEffectKnowledge {
  if ((record.lifecycleState?.cumulativeChangedPaths?.length ?? 0) > 0) return "present";
  if (record.scopeState === "SCOPE_VIOLATION") return "present";
  if (record.scopeState === "WITHIN_SCOPE") return "none";
  return "unknown";
}

/**
 * P2-A: Computes model attestation state comparing requested/resolved model to physically observed model.
 */
export function computeModelAttestation(params: {
  requestedModel?: string;
  resolvedModel?: string;
  observedModel?: string | null;
  attestationSource?: string;
  attestedAt?: string;
}): ModelAttestation {
  const { requestedModel, resolvedModel, observedModel, attestationSource, attestedAt } = params;
  const now = attestedAt ?? new Date().toISOString();
  if (observedModel === undefined || observedModel === null) {
    return {
      requestedModel,
      resolvedModel,
      observedModel: null,
      attestationSource: attestationSource ?? "metadata_only",
      attestationState: "ATTESTATION_UNAVAILABLE",
      attestedAt: now,
    };
  }

  const expected = resolvedModel ?? requestedModel;
  const matches = expected !== undefined
    ? observedModel.trim().toLowerCase() === expected.trim().toLowerCase()
    : true;

  return {
    requestedModel,
    resolvedModel,
    observedModel,
    attestationSource: attestationSource ?? "provider_reported",
    attestationState: matches ? "MATCH" : "MODEL_ATTESTATION_MISMATCH",
    attestedAt: now,
  };
}

/** Classifies a failed record from its structured errorCode only; never from free-form message text. */
function classifyDispatchFailure(record: LocalAgentRecord): DispatchFailureClassification {
  const code = record.errorCode ?? "";
  const knowledge = providerEffectKnowledge(record);
  let failureClass: DispatchFailureClassification["failureClass"];
  let providerEffect = knowledge !== "none";

  switch (code) {
    case "DISPATCH_CONTRACT_REJECTED":
      // Pre-provider admission rejection: the provider was never invoked.
      failureClass = "DISPATCH_CONTRACT_REJECTED";
      providerEffect = false;
      break;
    case "WORKTREE_LEASE_CONFLICT":
      failureClass = "WORKTREE_LEASE_CONFLICT";
      break;
    case "DUPLICATE_EFFECT_SUPPRESSED":
      failureClass = "DUPLICATE_EFFECT_SUPPRESSED";
      break;
    case "RECONCILIATION_REQUIRED":
      failureClass = knowledge === "none" ? "TRANSPORT_LOST_ACK" : "EFFECT_OUTCOME_UNKNOWN";
      break;
    case "PROVIDER_CAPACITY_ERROR":
      failureClass = knowledge === "none"
        ? "PROVIDER_QUOTA_EXHAUSTED_PRE_EFFECT"
        : "PROVIDER_QUOTA_EXHAUSTED_AFTER_EFFECT";
      break;
    case "PROVIDER_AUTH_ERROR":
      failureClass = "PROVIDER_AUTH_ERROR";
      break;
    case "WORKER_LAUNCH_FAILED":
      failureClass = "PROVIDER_STARTUP_FAILED";
      break;
    case "PROVIDER_TIMEOUT":
    case "PROVIDER_MODEL_UNAVAILABLE":
    case "PROVIDER_VARIANT_UNAVAILABLE":
    case "PROVIDER_CANCELLED":
    case "PROVIDER_PROTOCOL_ERROR":
    case "PROVIDER_EXECUTION_ERROR":
    case "PROVIDER_UNAVAILABLE":
      failureClass = "PROVIDER_EXECUTION_FAILED";
      break;
    case "CLINEPASS_ENTITLEMENT_REQUIRED":
      failureClass = "PROVIDER_AUTH_ERROR";
      break;
    case "VERIFIER_PLAN_PERSIST_FAILED":
      failureClass = "INTERNAL_CONTROL_PLANE_ERROR";
      break;
    default:
      failureClass = record.scopeState === "SCOPE_VIOLATION" ? "SCOPE_OR_PERMISSION_ERROR" : "UNKNOWN";
  }

  const classification: DispatchFailureClassification = {
    failureClass,
    providerEffect,
    classifiedAt: record.updatedAt,
  };
  if (record.error !== undefined) classification.reason = record.error;
  return classification;
}

/** Per-axis effect policy status derived from the physical enforcement receipt; request-only otherwise. */
function deriveEffectPolicyStatus(
  record: LocalAgentRecord,
  herdrHandle?: HerdrExternalHandle,
): NonNullable<AgentStatusOutput["effectPolicyStatus"]> {
  const receipt = record.lifecycleState?.lastEffectEnforcementReceipt;
  const enforced = receipt?.enforcementMode === "ENFORCED_NATIVE_PROVIDER";
  const requested = record.executionContract?.effectProjection;
  const axis = (receiptHas: boolean, requestedHas: boolean): "enforced" | "request_only" | "unknown" => {
    if (enforced && receiptHas) return "enforced";
    return requestedHas ? "request_only" : "unknown";
  };
  const process = axis(Boolean(receipt?.process), Boolean(requested?.process));
  const network = axis(Boolean(receipt?.network), Boolean(requested?.network));
  const git = axis(Boolean(receipt?.git), Boolean(requested?.git));
  const toolCeiling = axis(Array.isArray(receipt?.selectedToolIntents), Boolean(requested));
  const axes = [process, network, git, toolCeiling];
  const overallEnforcement = axes.every((state) => state === "enforced")
    ? "PHYSICALLY_ENFORCED"
    : record.provider === "agy" ||
        herdrHandle?.enforcementState === "REQUEST_ONLY_NOT_ENFORCED" ||
        axes.some((state) => state === "request_only" || state === "enforced")
      ? "REQUEST_ONLY_NOT_ENFORCED"
      : "UNKNOWN";
  return { process, network, git, toolCeiling, overallEnforcement };
}

function reportableScopeState(
  record: LocalAgentRecord,
  scopeState: ScopeState,
  enforcementState: HerdrExternalHandle["enforcementState"] | undefined,
): ScopeState {
  if (scopeState === "SCOPE_VIOLATION") return scopeState;
  if (record.lifecycleState?.lastEffectEnforcementReceipt?.enforcementMode === "ENFORCED_NATIVE_PROVIDER") {
    return scopeState;
  }
  if (record.provider === "agy") return "UNKNOWN";
  return reportableHerdrScopeState(scopeState, enforcementState);
}

function reportableHerdrScopeState(
  scopeState: ScopeState,
  enforcementState: HerdrExternalHandle["enforcementState"] | undefined,
): ScopeState {
  if (scopeState === "SCOPE_VIOLATION") return scopeState;
  return enforcementState === "REQUEST_ONLY_NOT_ENFORCED" ? "UNKNOWN" : scopeState;
}

function recordToStatusOutput(
  record: LocalAgentRecord,
  lifecycle?: LifecycleEvidence,
  herdrHandle?: HerdrExternalHandle,
): AgentStatusOutput {
  const output: AgentStatusOutput = {
    agentId: record.id,
    workspaceRoot: record.workspaceRoot,
    profileName: record.profileName,
    provider: record.provider,
    status: record.status,
    terminal: isTerminalStatus(record.status) && !hasTerminationBlock(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (herdrHandle !== undefined) {
    output.herdrHandle = herdrHandle;
    output.runtime = herdrRuntimeOutput(herdrHandle);
  }
  if (record.model !== undefined) output.model = record.model;
  if (record.effort !== undefined) output.effort = record.effort;
  if (record.workspaceId !== undefined) output.workspaceId = record.workspaceId;
  const executionIdlePolicy = record.lifecycleState?.activeTurn?.executionIdlePolicy
    ?? record.lifecycleState?.lastExecutionIdlePolicy;
  if (executionIdlePolicy) output.executionIdlePolicy = executionIdlePolicy;
  if (record.lifecycleState?.lastEffectEnforcementReceipt) {
    output.effectEnforcementReceipt = record.lifecycleState.lastEffectEnforcementReceipt;
  }
  const dispatch = dispatchContractOutput(record.executionContract?.dispatchIntent);
  if (dispatch) output.dispatch = dispatch;
  if (record.executionContract?.role || record.executionContract?.parentEffectKey || record.executionContract?.supersedes) {
    output.lineage = {
      ...(record.executionContract.role ? { role: record.executionContract.role } : {}),
      ...(record.executionContract.parentEffectKey ? { parentEffectKey: record.executionContract.parentEffectKey } : {}),
      ...(record.executionContract.supersedes ? { supersedes: record.executionContract.supersedes } : {}),
    };
  }
  if (record.lifecycleState?.automatedVerifierResult) {
    output.automatedVerifierResult = record.lifecycleState.automatedVerifierResult;
  }
  if (record.lifecycleState?.automatedVerifierEffects) {
    output.automatedVerifierEffects = record.lifecycleState.automatedVerifierEffects;
  }
  if (record.lifecycleState?.automatedVerifierPlan) {
    output.automatedVerifierPlan = record.lifecycleState.automatedVerifierPlan;
  }
  if (record.lifecycleState?.automatedVerifierPlans) {
    output.automatedVerifierPlans = record.lifecycleState.automatedVerifierPlans;
  }
  // P2-D: Provider process state is reported separately from dispatcher liveness.
  if (record.lifecycleState?.dispatcherHeartbeatAt) {
    output.dispatcherHeartbeatAt = record.lifecycleState.dispatcherHeartbeatAt;
  }
  // workerPid identifies the DevSpace worker wrapper, not necessarily the provider
  // process. Only provider/runtime callbacks may populate providerProcessState.
  output.providerProcessState = record.lifecycleState?.providerProcessState ?? "unknown";

  // P2-H: Operation timeline. Only durably-recorded timestamps are reported;
  // unobserved phases stay absent instead of being estimated.
  {
    const activeTurn = record.lifecycleState?.activeTurn;
    const persisted = record.lifecycleState?.operationTimeline;
    const timeline: OperationTimeline = {
      queuedAt: persisted?.queuedAt ?? record.createdAt,
    };
    const providerStartedAt = persisted?.providerStartedAt ?? activeTurn?.executionStartedAt;
    if (providerStartedAt) timeline.providerStartedAt = providerStartedAt;
    if (persisted?.firstStreamActivityAt) {
      timeline.firstStreamActivityAt = persisted.firstStreamActivityAt;
    }
    const firstEffectAt = persisted?.firstEffectAt
      ?? (typeof activeTurn?.firstEffectAt === "string" ? activeTurn.firstEffectAt : undefined);
    if (firstEffectAt) timeline.firstEffectAt = firstEffectAt;
    const terminalAt = persisted?.terminalAt ?? (isTerminalStatus(record.status) ? record.updatedAt : undefined);
    if (terminalAt) timeline.terminalAt = terminalAt;
    if (persisted?.reconciledAt) timeline.reconciledAt = persisted.reconciledAt;
    output.operationTimeline = timeline;
  }

  // P2-A: Model attestation
  if (record.lifecycleState?.modelAttestation) {
    output.modelAttestation = record.lifecycleState.modelAttestation;
  } else if (record.model || record.executionContract?.directSelection?.model) {
    const requested = record.executionContract?.directSelection?.model;
    const resolved = record.model;
    output.modelAttestation = computeModelAttestation({
      requestedModel: requested,
      resolvedModel: resolved,
      observedModel: null,
      attestationSource: "metadata_only",
      attestedAt: record.updatedAt,
    });
  }

  // P2-E/F: Dispatch failure classification
  if (record.lifecycleState?.dispatchFailure) {
    output.dispatchFailure = record.lifecycleState.dispatchFailure;
  } else if (record.status === "error") {
    output.dispatchFailure = classifyDispatchFailure(record);
  }

  // P2-G: Effect policy enforcement breakdown
  output.effectPolicyStatus = deriveEffectPolicyStatus(record, herdrHandle);

  if (record.providerSessionId !== undefined) output.providerSessionId = record.providerSessionId;
  if (record.latestResponse !== undefined) output.latestResponse = record.latestResponse;
  if (record.error !== undefined) output.error = record.error;
  if (record.errorCode !== undefined) output.errorCode = record.errorCode;
  if (record.errorRetryable !== undefined) output.errorRetryable = record.errorRetryable;
  if (record.errorDetails !== undefined) output.errorDetails = record.errorDetails;
  const pending = record.lifecycleState?.terminationPending;
  const corrupt = isDetachedLifecycle(record.lifecycleState) && record.lifecycleState?.lifecycleCorrupt;
  const blocked = isDetachedLifecycle(record.lifecycleState) ? record.lifecycleState?.terminationBlocked : undefined;
  if (pending || corrupt || blocked) {
    output.termination = pending
      ? {
          pending: true,
          generation: pending.generation,
          requestedAt: pending.requestedAt,
          failure: pending.lastFailure,
        }
      : corrupt
        ? { pending: false, corrupt: true }
        : { pending: false, blocked: true, reason: blocked?.reason };
  }
  if (lifecycle) {
    output.startedAt = lifecycle.startedAt;
    output.lastActivityAt = lifecycle.lastActivityAt;
    if (lifecycle.lastFileMutationAt !== undefined) output.lastFileMutationAt = lifecycle.lastFileMutationAt;
    output.wallMs = lifecycle.wallMs;
    output.idleMs = lifecycle.idleMs;
    if (lifecycle.changedPaths !== undefined) output.changedPaths = lifecycle.changedPaths;
    if (lifecycle.terminalReason !== undefined) output.terminalReason = lifecycle.terminalReason;
    if (lifecycle.scopeState !== undefined) {
      output.scopeState = reportableScopeState(record, lifecycle.scopeState, herdrHandle?.enforcementState);
    }
  }
  return output;
}

function herdrRuntimeOutput(handle: HerdrExternalHandle): AgentRuntimeOutput {
  return {
    runtimeKind: "HERDR",
    socketPath: handle.herdrSocketPath,
    workspaceId: handle.herdrWorkspaceId,
    paneId: handle.herdrPaneId,
    agentIdentity: handle.herdrAgentIdentity,
    agentKind: handle.herdrAgentKind,
  };
}

function recordToSummary(record: LocalAgentRecord): AgentSummary {
  const output: AgentSummary = {
    agentId: record.id,
    profileName: record.profileName,
    provider: record.provider,
    status: record.status,
    terminationPending: Boolean(record.lifecycleState?.terminationPending) || undefined,
    terminationBlocked: hasDetachedTerminationBlocked(record) || undefined,
    updatedAt: record.updatedAt,
  };
  if (record.model !== undefined) output.model = record.model;
  if (record.effort !== undefined) output.effort = record.effort;
  return output;
}

function hasTerminationBlock(record: LocalAgentRecord): boolean {
  if (!isDetachedLifecycle(record.lifecycleState)) return false;
  return Boolean(
    record.lifecycleState?.terminationPending ||
    record.lifecycleState?.lifecycleCorrupt ||
    record.lifecycleState?.terminationBlocked ||
    (isTerminalStatus(record.status) && record.lifecycleState?.activeTurn),
  );
}

function hasDetachedTerminationBlocked(record: LocalAgentRecord): boolean {
  if (!isDetachedLifecycle(record.lifecycleState)) return false;
  return Boolean(
    record.lifecycleState?.lifecycleCorrupt ||
    record.lifecycleState?.terminationBlocked ||
    (isTerminalStatus(record.status) && record.lifecycleState?.activeTurn),
  );
}

function occupiesDetachedExecutionSlot(record: LocalAgentRecord): boolean {
  if (!isDetachedLifecycle(record.lifecycleState) || record.lifecycleState?.terminationBlocked) return false;
  return isActiveStatus(record.status) || Boolean(record.lifecycleState?.activeTurn) || hasTerminationBlock(record);
}

function shouldRetryPendingTermination(record: LocalAgentRecord, now: number): boolean {
  const lastAttemptAt = record.lifecycleState?.terminationPending?.lastAttemptAt;
  if (!lastAttemptAt) return true;
  const attemptedAt = Date.parse(lastAttemptAt);
  return Number.isFinite(attemptedAt) && now - attemptedAt >= TERMINATION_RETRY_BACKOFF_MS;
}
