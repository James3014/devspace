import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, unlinkSync, rmdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config.js";
import {
  createLocalAgentStore,
  isDetachedLifecycle,
  LocalAgentReplayConflictError,
  LocalAgentStore,
  type LocalAgentDispatchMode,
  type LocalAgentRecord,
  type LocalAgentStatus,
  type WriteMode,
} from "./local-agent-store.js";
import { loadLocalAgentProfiles, type LocalAgentProfile, type LocalAgentProvider } from "./local-agent-profiles.js";
import {
  checkLocalAgentProviderAvailability,
  getLocalAgentProviderRuntimeVersion,
  resolveLocalAgentProviderExecutable,
} from "./local-agent-availability.js";
import { runLocalAgentProvider } from "./local-agent-adapters.js";
import { resolveEffectiveExecutionIdlePolicy } from "./local-agent-idle-policy.js";
import { LocalAgentProviderError, type LocalAgentRunCallbacks, type LocalAgentRunInput, type LocalAgentRunResult } from "./local-agent-runtime.js";
import { terminateProcessTree, type KillableProcess } from "./process-platform.js";
import {
  type AgentTerminalReason,
  type EffectiveExecutionIdlePolicy,
  type ExecutionContract,
  type ScopeState,
} from "./local-agent-contract.js";
import { buildToolchainEnvironment, describeToolchainExecutables } from "./local-agent-toolchains.js";
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
  type AgentProviderFailureDetails,
} from "./local-agent-errors.js";
import { getOpencodeCatalogGeneration, validateOpencodeModelAndVariant } from "./local-agent-opencode-catalog.js";
import { canonicalizePath, isPathInsideRoot } from "./roots.js";
import {
assertNexusGrantAuthorizesExecution,
  assertSameExecutionGeneration,
  buildExecutionGenerationBinding,
  hashDispatchIntent,
  renderDispatchIntentForWorker,
  validateDispatchIntent,
  validateResolvedNexusExecutionGrant,
  type AuthorityValidationEvidence,
  type DispatchIntent,
  type ExecutionDispatchControl,
  type ExecutionGenerationBinding,
  type ExecutionSelection,
  type NexusExecutionGrant,
  type NexusExecutionGrantRef,
  ExecutionProtocolError,
} from "./execution-protocol.js";
import { describeRuntimeBuildIdentity, type RuntimeBuildIdentity } from "./build-identity.js";
import { devspaceConfigDir } from "./user-config.js";
import {
  classifyScopeState,
  computeWorkerDelta,
  inspectWorkspacePhysicalState,
  readWorkspaceHead,
  type WorkerAttribution,
} from "./workspace-reconciliation.js";

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
  | "REBIND_REQUIRED";

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
  dispatchMode?: LocalAgentDispatchMode;
  writeMode?: WriteMode;
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

export type SelectionContractOutput = ExecutionSelection;

export interface DispatchContractOutput {
  taskId: string;
  attemptId: string;
  roleIntent: string;
  claimCeiling: string;
  verificationRequired: boolean;
  exclusiveOwnership: boolean;
  intentHash: string;
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
  selection?: SelectionContractOutput;
  dispatch?: DispatchContractOutput;
  dispatchControl?: ExecutionDispatchControl;
  executionIdlePolicy?: EffectiveExecutionIdlePolicy;
  termination?: {
    pending: boolean;
    generation?: string;
    requestedAt?: string;
    failure?: string;
    corrupt?: boolean;
    blocked?: boolean;
    reason?: string;
  };
}

export interface ReconcileAgentInput {
  workspaceId: string;
  workspaceRoot: string;
  isolated: boolean;
  agentId: string;
}

export interface ReconcileAgentOutput {
  agentId: string;
  selection?: SelectionContractOutput;
  dispatch?: DispatchContractOutput;
  dispatchControl: ExecutionDispatchControl;
  agentState: LocalAgentStatus;
  providerState?: string;
  providerSessionId?: string;
  terminalReason?: AgentTerminalReason;
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
  dispatchMode?: LocalAgentDispatchMode;
  writeMode?: WriteMode;
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
  const updatedAtMs = Date.parse(record.updatedAt);
  const terminalStable = isTerminalStatus(record.status) &&
    !record.lifecycleState?.terminationPending &&
    !record.lifecycleState?.lifecycleCorrupt &&
    !record.lifecycleState?.terminationBlocked;
  const referenceMs = terminalStable ? updatedAtMs : now;
  return {
    wallMs: Math.max(0, referenceMs - createdAtMs),
    idleMs: terminalStable ? 0 : Math.max(0, now - updatedAtMs),
  };
}

export interface StartAgentOutput {
  agentId: string;
  selection?: SelectionContractOutput;
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

/**
 * Direct-dispatch provider runner. Mirrors the exported `runLocalAgentProvider`
 * adapter signature so worker direct-dispatch turns stay unit-testable without
 * spawning a real provider runtime.
 */
export type LocalAgentProviderRunner = (
  provider: LocalAgentProvider,
  input: LocalAgentRunInput,
  callbacks?: LocalAgentRunCallbacks,
) => Promise<LocalAgentRunResult>;

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
  private readonly providerRunner?: LocalAgentProviderRunner;
  private readonly runtimeBuildIdentity: RuntimeBuildIdentity;
  private readonly nexusGrantResolver: NexusGrantResolver;
  private closed = false;
  private readonly terminationAttempts = new Map<string, Promise<boolean>>();

  constructor(
    private readonly config: ServerConfig,
    testLauncher?: WorkerLauncher,
    testTerminator?: WorkerTerminator,
    testTurnRunner?: AgentTurnRunner,
    runtimeBuildIdentity?: RuntimeBuildIdentity,
nexusGrantResolver?: NexusGrantResolver,
    testProviderRunner?: LocalAgentProviderRunner,
  ) {
    this.store = createLocalAgentStore(config.stateDir);
    this.launcher = testLauncher ?? defaultWorkerLauncher;
    this.terminator = testTerminator ?? terminateOwnedWorker;
    this.turnRunner = testTurnRunner;
    this.nexusGrantResolver = nexusGrantResolver ?? resolveCanonicalNexusExecutionGrant;
    this.providerRunner = testProviderRunner;
    this.runtimeBuildIdentity = runtimeBuildIdentity ?? describeRuntimeBuildIdentity({
      env: process.env,
      listenPort: config.port,
      configRoot: devspaceConfigDir(process.env),
      stateRoot: config.stateDir,
      profileCatalogGeneration: "unresolved",
    });
  }

  /** Close the manager's durable store. Safe to call from multiple cleanup paths. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store.close();
  }

  /**
   * Start a new agent session using an advertised profile.
   * Returns immediately; worker runs in background.
   * Fail-closed: if worker fails to launch, record is set to error status.
   */
  async startAgent(input: StartAgentInput): Promise<StartAgentOutput> {
    const { workspaceId, workspaceRoot, profileName, prompt, profiles, executionContract, attemptKey } = input;
    const dispatchMode = input.dispatchMode ?? "profile";
    const writeMode = input.writeMode;

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

    assertSelectionMatchesResolvedProfile(executionContract?.selection, profile);

    const replayBinding = attemptKey === undefined
      ? undefined
      : buildStartReplayBinding(attemptKey, {
          workspaceRoot,
          profile,
          prompt,
          executionContract,
          dispatchMode,
        });
    if (executionContract?.dispatchIntent && !attemptKey) {
      throw new AgentSessionError(
        "INVALID_ATTEMPT_KEY",
        "Controller-authored dispatchIntent requires attemptKey so duplicate/uncertain dispatch can be reconciled to one durable attempt.",
      );
    }
    if (executionContract?.dispatchIntent && attemptKey !== executionContract.dispatchIntent.attemptId) {
      throw new AgentSessionError(
        "INVALID_ATTEMPT_KEY",
        `dispatchIntent.attemptId '${executionContract.dispatchIntent.attemptId}' must exactly match durable attemptKey '${attemptKey}'.`,
      );
    }

    if (replayBinding) {
      try {
        const replay = this.store.resolveStartReplay(workspaceRoot, replayBinding);
        if (replay) return recordToStartOutput(replay);
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

    const startCapacity = this.executionCapacitySnapshot(workspaceRoot);
    if (startCapacity.localState === "EXHAUSTED") {
      throw new AgentSessionError(
        "NO_EXECUTION_CAPACITY",
        `Local DevSpace execution capacity exhausted: ${startCapacity.used} of ${startCapacity.max} slot(s) active (${startCapacity.activeInWorkspace} in this workspace, ${startCapacity.activeOtherWorkspaces} in other workspaces/conversations). This is not provider rate-limit evidence.`,
      );
    }

    // Optional structured execution contract (execution-control only).
    let providerEnvironment = process.env;
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

    if (profile.provider === "opencode") {
      const modelValidation = validateOpencodeModelAndVariant(profile.model, profile.effort);
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
      dispatchMode,
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
          dispatchMode,
          writeMode,
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
          dispatchMode,
          writeMode,
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

    if (created) await this.launchPrompt(record.id, bindDispatchIntentToPrompt(record.executionContract?.dispatchIntent, prompt));
    return recordToStartOutput(this.store.getById(record.id) ?? record);
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

    if (canonicalizePath(record.workspaceRoot) !== canonicalizePath(workspaceRoot)) {
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
    if (record.lifecycleState?.activeTurn) {
      throw new AgentSessionError(
        "AGENT_LIFECYCLE_CORRUPT",
        `Agent ${agentId} has a terminal status with an unsettled active turn; continuation is blocked.`,
      );
    }

    // ── Continuation admission gates (all read-only; run before mutation) ──
    const admissionFailures: string[] = [];

// Direct-model sessions never rebind against the profile catalog: their
    // provider/model are durable-dispatch state, so an on-disk profile that
    // happens to share the provider name must not influence continuation.
    const currentProfile: LocalAgentProfile = record.dispatchMode === "direct_model"
      ? {
          name: record.profileName,
          description: "Persisted direct-model dispatch binding",
          provider: record.provider as LocalAgentProfile["provider"],
          model: record.model,
          effort: record.effort,
          filePath: "<direct-dispatch>",
          body: "",
          disabled: false,
        }
      : (input.profiles?.find((candidate) => candidate.name === record.profileName) ?? {
          name: record.profileName,
          description: "Persisted durable-agent profile binding",
          provider: record.provider as LocalAgentProfile["provider"],
          model: record.model,
          effort: record.effort,
          filePath: "<persisted>",
          body: "",
          disabled: false,
        });
    assertSelectionMatchesResolvedProfile(record.executionContract?.selection, currentProfile);

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
    try {
      const currentGeneration = this.resolveExecutionGeneration(
        currentProfile,
        input.profileCatalog?.generation ?? "unresolved",
        process.env,
        record.dispatchMode,
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

    await this.launchPrompt(record.id, bindDispatchIntentToPrompt(record.executionContract?.dispatchIntent, prompt));
    const updated = this.store.getById(record.id) ?? record;
    return { ...recordToStartOutput(updated), continued: true as const };
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

    if (canonicalizePath(record.workspaceRoot) !== canonicalizePath(workspaceRoot)) {
      throw new AgentSessionError(
        "AGENT_WORKSPACE_MISMATCH",
        `Agent ${agentId} belongs to workspace root '${record.workspaceRoot}', not '${workspaceRoot}'`,
      );
    }

    if (waitMs > 0 && occupiesDetachedExecutionSlot(record)) {
      const deadline = Date.now() + waitMs;
      while (occupiesDetachedExecutionSlot(record) && Date.now() < deadline) {
        await sleep(Math.min(300, deadline - Date.now()));
        record = this.store.getById(agentId) ?? record;
      }
    }

    return recordToStatusOutput(record, await this.buildLifecycleEvidence(record));
  }

  async cancelAgent(input: CancelAgentInput): Promise<AgentStatusOutput> {
    const { workspaceRoot, agentId } = input;
    let record = this.store.getById(agentId);
    if (!record) {
      throw new AgentSessionError("UNKNOWN_AGENT", `Unknown agent id: ${agentId}`);
    }
    if (canonicalizePath(record.workspaceRoot) !== canonicalizePath(workspaceRoot)) {
      throw new AgentSessionError(
        "AGENT_WORKSPACE_MISMATCH",
        `Agent ${agentId} belongs to workspace root '${record.workspaceRoot}', not '${workspaceRoot}'`,
      );
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
      return recordToStatusOutput(record);
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
    return recordToStatusOutput(current);
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

    const canonicalCurrent = canonicalizePath(workspaceRoot);
    const records = this.store.list();
    const matched = records.filter(
      (record) => canonicalizePath(record.workspaceRoot) === canonicalCurrent
    );
    return matched.slice(0, effectiveLimit).map(recordToSummary);
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

    const capacity = this.executionCapacitySnapshot(workspaceRoot);
    const capacityAvailable = capacity.localState === "AVAILABLE";
    if (!capacityAvailable) {
      blockers.push({
        code: "NO_EXECUTION_CAPACITY",
        detail: `${capacity.used} of ${capacity.max} configured local agent slot(s) are active (${capacity.activeInWorkspace} in this workspace, ${capacity.activeOtherWorkspaces} in other workspaces/conversations). This is local DevSpace capacity, not evidence of provider rate limiting.`,
      });
    }
    unknowns.push(
      "providerCapacity is unknown: local slot availability is reported separately and must not be interpreted as provider quota/rate-limit evidence.",
    );

    let toolchainAvailable = false;
    let executables: Record<string, string> | undefined;
    let providerEnvironment = process.env;
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
        const modelValidation = validateOpencodeModelAndVariant(profile.model, profile.effort);
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

    return {
      workspace,
      worker: {
        profile: profileName,
        provider: profile?.provider ?? "unknown",
        model: profile?.model,
        effort: profile?.effort,
        executionIdentity,
        runtimeVersion,
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
    if (canonicalizePath(record.workspaceRoot) !== canonicalizePath(workspaceRoot)) {
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

    const startedAtMs = Date.parse(record.createdAt);
    const updatedAtMs = Date.parse(record.lifecycleState?.activeTurn?.lastActivityAt ?? record.updatedAt);
    const now = Date.now();
    const candidatePresent = workerChanged.length > 0 || headAdvanced;

    return {
      agentId: record.id,
      selection: selectionContractOutput(record.executionContract?.selection),
      dispatch: dispatchContractOutput(record.executionContract?.dispatchIntent),
      dispatchControl: dispatchControlForReconcile(record, candidatePresent),
      agentState: record.status,
      providerState: record.status,
      providerSessionId: record.providerSessionId,
      terminalReason: record.terminalReason,
      workspace: {
        head: physical.head,
        dirty: physical.dirty,
      },
      candidate: {
        present: candidatePresent,
        changedPaths: workerChanged,
        unexpectedPaths,
        diffHash: physical.diffHash,
        scopeState,
      },
      activity: {
        startedAt: record.createdAt,
        lastActivityAt: record.lifecycleState?.activeTurn?.lastActivityAt ?? record.updatedAt,
        lastFileMutationAt: physical.lastFileMutationAt,
        wallMs: Math.max(0, now - startedAtMs),
        idleMs: Math.max(0, now - updatedAtMs),
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
    for (const record of this.store.list()) {
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
    const canonicalRoot = workspaceRoot ? canonicalizePath(workspaceRoot) : undefined;
    const activeInWorkspace = canonicalRoot
      ? active.filter((record) => canonicalizePath(record.workspaceRoot) === canonicalRoot).length
      : 0;
    return summarizeExecutionCapacity(active.length, this.config.agentMaxConcurrent, activeInWorkspace);
  }

  /** Compatibility predicate backed by the canonical capacity snapshot. */
  private hasExecutionCapacity(): boolean {
    return this.executionCapacitySnapshot().localState === "AVAILABLE";
  }

  private assertDispatchOwnershipAvailable(workspaceRoot: string, contract: ExecutionContract | undefined): void {
    const intent = contract?.dispatchIntent;
    const writeScope = contract?.writePaths ?? [];
    if (!intent?.exclusiveOwnership || writeScope.length === 0) return;

    const canonicalRoot = canonicalizePath(workspaceRoot);
    for (const record of this.store.list()) {
      if (!occupiesDetachedExecutionSlot(record)) continue;
      if (canonicalizePath(record.workspaceRoot) !== canonicalRoot) continue;

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

  private resolveExecutionGeneration(
    profile: LocalAgentProfile,
    profileCatalogGeneration: string,
    environment: NodeJS.ProcessEnv,
    dispatchMode?: LocalAgentDispatchMode,
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

    // Direct-model dispatch has no profile catalog entry, so a grounded
    // "catalog generation" is synthesized instead: the live OpenCode catalog
    // generation (model validity is bound to it) or a stable per-provider
    // direct binding id. Continuation rebinds reproduce the exact same value.
    const effectiveCatalogGeneration = dispatchMode === "direct_model"
      ? profile.provider === "opencode"
        ? getOpencodeCatalogGeneration()
        : `direct:${profile.provider}`
      : profileCatalogGeneration;

    return buildExecutionGenerationBinding({
      profileCatalogGeneration: effectiveCatalogGeneration,
      provider: profile.provider,
      model: profile.model,
      executionIdentity: executable,
      runtimeVersion,
      devspaceBuildId: this.runtimeBuildIdentity.buildId,
      devspaceSourceCommit: this.runtimeBuildIdentity.sourceCommit,
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

  private async terminateActiveAgent(
    agentId: string,
    reason: AgentTerminalReason,
    message: string,
    expectedPhase?: "startup" | "execution" | "idle" | "any",
    budgetMs?: number,
    terminalStatus: "error" | "stopped" = "error",
  ): Promise<boolean> {
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
      // Direct-model sessions rebind purely from persisted dispatch state; the
      // on-disk profile with the provider's name (if any) is never shadowed or
      // consulted at the worker turn.
      const profile = claimed.dispatchMode === "direct_model"
        ? undefined
        : profiles.find((p) => p.name === claimed.profileName);
      const callbacks: LocalAgentRunCallbacks = {
        onActivity: () => {
          this.store.touchActivityCAS(claimed.id, generation, workerToken);
        },
        onExecutionStarted: () => {
          this.store.markExecutionStarted(claimed.id, workerToken, undefined, generation);
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
        },
      };
      let result: LocalAgentRunResult;
      if (this.turnRunner) {
        result = await this.turnRunner(profile, claimed, prompt, callbacks);
      } else if (claimed.dispatchMode === "direct_model") {
        result = await runDirectModelDispatch(
          this.config,
          claimed,
          prompt,
          scratch,
          callbacks,
          this.providerRunner,
        );
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
      this.store.finishTurnCAS({
        agentId,
        generation,
        workerToken,
        providerSessionId: result.providerSessionId ?? undefined,
        status: "idle",
        latestResponse: result.finalResponse,
        error: scopeViolated
          ? `Agent wrote outside the declared write scope. Offending paths: ${scope.unexpectedPaths.join(", ")}`
          : undefined,
        terminalReason: scopeViolated ? "scope_violation" : "completed",
        scopeState: scope.scopeState,
        cumulativeChangedPaths: [...cumulative].sort(),
        turnEndBaseline,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
          providerMessage: error.providerMessage ?? error.message,
        };
        providerSessionId = error.providerSessionId;
        latestResponse = error.providerMessage;
      } else if (isAgentProviderError(error)) {
        errorCode = error.code;
        errorRetryable = error.retryable;
        errorDetails = describeAgentProviderError(error);
      } else if (error instanceof LocalAgentProviderError) {
        providerSessionId = error.providerSessionId;
        latestResponse = error.finalResponse;
      }

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
              : classifyProviderError(message),
        scopeState: scope.scopeState,
        cumulativeChangedPaths: scope.workerChangedPaths,
        turnEndBaseline: endState
          ? {
              changedPaths: endState.changedPaths,
              head: endState.head ?? null,
              fingerprints: endState.fingerprints,
            }
          : undefined,
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
    dispatchMode?: LocalAgentDispatchMode;
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
    writeMode: input.profile.write_mode ?? "read_only",
    profileBody: input.profile.body,
    prompt: input.prompt,
    executionContract: input.executionContract ?? null,
    dispatchMode: input.dispatchMode ?? "profile",
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

  terminateProcessTree(killable, "SIGTERM", process.platform !== "win32");
  const postTermState = await waitForWorkerExitOrForeign(pid, record.id, workerToken, 1_000);
  if (postTermState === "absent" || postTermState === "foreign") {
    return true;
  }
  if (postTermState !== "owned") {
    return false;
  }

  terminateProcessTree(killable, "SIGKILL", process.platform !== "win32");
  const postKillState = await waitForWorkerExitOrForeign(pid, record.id, workerToken, 500);
  return postKillState === "absent" || postKillState === "foreign";
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
      environment,
    },
    callbacks,
  );
}

/**
 * Worker-side direct-model dispatch. Rebuilds the provider run input from the
 * persisted durable dispatch state (never from profile files): provider must be
 * a known local agent provider, and the persisted model binding must exist.
 * The write mode is persisted dispatch state, so an absent value is a
 * serialization defect and fails closed instead of defaulting to a scope.
 */
async function runDirectModelDispatch(
  config: ServerConfig,
  record: LocalAgentRecord,
  prompt?: string,
  scratch?: ScratchHandle,
  callbacks?: LocalAgentRunCallbacks,
  providerRunner?: LocalAgentProviderRunner,
): Promise<LocalAgentRunResult> {
  const { isLocalAgentProvider } = await import("./local-agent-profiles.js");
  if (!isLocalAgentProvider(record.provider)) {
    throw new Error(`Unknown direct-dispatch provider: ${record.provider}`);
  }
  if (!record.model) {
    throw new Error(
      `Direct-dispatch session ${record.id} has no persisted model binding; refusing to run an unbounded provider turn.`,
    );
  }
  if (!record.writeMode) {
    throw new Error(
      `Direct-dispatch session ${record.id} has no persisted write mode; serialization defect, failing closed.`,
    );
  }
  const environment = providerEnvironment(config, record, scratch);
  const input: LocalAgentRunInput = {
    prompt: prompt ?? "",
    workspaceRoot: record.workspaceRoot,
    providerSessionId: record.providerSessionId,
    writeMode: record.writeMode,
    model: record.model,
    effort: record.effort,
    environment,
  };
  const run = providerRunner ?? runLocalAgentProvider;
  return run(record.provider, input, callbacks);
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
  let environment: NodeJS.ProcessEnv = process.env;
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
      environment = { ...process.env };
    }
  }
  return scratch
    ? { ...environment, DEVSPACE_PROVIDER_SCRATCH: scratch.root }
    : environment;
}

function assertSelectionMatchesResolvedProfile(
  selection: ExecutionSelection | undefined,
  profile: LocalAgentProfile,
): void {
  if (!selection) return;
  const mismatches: string[] = [];
  if (selection.profile !== profile.name) mismatches.push(`profile=${selection.profile} (resolved ${profile.name})`);
  if (selection.provider !== profile.provider) mismatches.push(`provider=${selection.provider} (resolved ${profile.provider})`);
  if (selection.model !== profile.model) mismatches.push(`model=${selection.model ?? "<none>"} (resolved ${profile.model ?? "<none>"})`);
  if (selection.effort !== profile.effort) mismatches.push(`effort=${selection.effort ?? "<none>"} (resolved ${profile.effort ?? "<none>"})`);
  if (mismatches.length > 0) {
    throw new AgentSessionError(
      "INVALID_EXECUTION_CONTRACT",
      `Explicit worker selection does not match the resolved advertised profile; Dev MCP will not substitute it: ${mismatches.join(", ")}.`,
    );
  }
}

function assertDispatchContractCoherence(contract: ExecutionContract | undefined): void {
  const intent = contract?.dispatchIntent;
  if (!intent) return;
  try {
    validateDispatchIntent(intent);
  } catch (error) {
    throw new AgentSessionError(
      "INVALID_EXECUTION_CONTRACT",
      error instanceof Error ? error.message : String(error),
    );
  }
  const intentWriteScope = [...(intent.writeScope ?? [])].sort();
  const executionWriteScope = [...(contract?.writePaths ?? [])].sort();
  if (intentWriteScope.join("\n") !== executionWriteScope.join("\n")) {
    throw new AgentSessionError(
      "INVALID_EXECUTION_CONTRACT",
      "executionContract.dispatchIntent.writeScope must exactly match executionContract.writePaths; DevSpace does not maintain two write-scope authorities.",
    );
  }
}

function bindDispatchIntentToPrompt(intent: DispatchIntent | undefined, prompt: string): string {
  if (!intent) return prompt;
  return `${renderDispatchIntentForWorker(intent)}\n\nCONTROLLER TASK\n${prompt}`;
}

function selectionContractOutput(selection: ExecutionSelection | undefined): SelectionContractOutput | undefined {
  return selection ? { ...selection } : undefined;
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

function dispatchControlBase(record: LocalAgentRecord) {
  return {
    decisionOwner: "HOST_GPT" as const,
    silentFallbackAllowed: false as const,
    freshNexusAuthorityRequired: (record.executionContract?.authorityMode ?? "OWNER_DIRECT") === "NEXUS_GOVERNED",
  };
}

function dispatchControlForStatus(
  record: LocalAgentRecord,
  lifecycle: LifecycleEvidence | undefined,
): ExecutionDispatchControl {
  const base = dispatchControlBase(record);
  const stableTerminal = isTerminalStatus(record.status) && !hasTerminationBlock(record);
  const mutating = Boolean(record.executionContract?.writePaths?.length);
  const changedPaths = lifecycle?.changedPaths;
  const changed = Boolean(changedPaths?.length);

  if (!stableTerminal) {
    return {
      ...base,
      effectState: mutating ? (changed ? "OBSERVED" : "POSSIBLE") : "NONE_OBSERVED",
      retrySafe: false,
      reconciliationRequired: mutating || hasTerminationBlock(record),
      reasonCode: hasTerminationBlock(record) ? "TERMINATION_OR_EFFECT_UNCERTAIN" : "ATTEMPT_ACTIVE",
    };
  }
  if (!mutating) {
    return {
      ...base,
      effectState: "NONE_OBSERVED",
      retrySafe: true,
      reconciliationRequired: false,
      reasonCode: "TERMINAL_READ_ONLY",
    };
  }
  if (changedPaths === undefined) {
    return {
      ...base,
      effectState: "POSSIBLE",
      retrySafe: false,
      reconciliationRequired: true,
      reasonCode: "PHYSICAL_EFFECT_UNKNOWN",
    };
  }
  if (changed) {
    return {
      ...base,
      effectState: "OBSERVED",
      retrySafe: false,
      reconciliationRequired: false,
      reasonCode: "TERMINAL_EFFECT_OBSERVED",
    };
  }
  return {
    ...base,
    effectState: "RECONCILED_NO_EFFECT",
    retrySafe: true,
    reconciliationRequired: false,
    reasonCode: "TERMINAL_NO_WORKSPACE_EFFECT",
  };
}

function dispatchControlForReconcile(
  record: LocalAgentRecord,
  candidatePresent: boolean,
): ExecutionDispatchControl {
  const base = dispatchControlBase(record);
  const stableTerminal = isTerminalStatus(record.status) && !hasTerminationBlock(record);
  if (!stableTerminal) {
    return {
      ...base,
      effectState: candidatePresent ? "RECONCILED_EFFECT" : "POSSIBLE",
      retrySafe: false,
      reconciliationRequired: true,
      reasonCode: candidatePresent ? "ACTIVE_EFFECT_RECONCILED" : "ATTEMPT_STILL_ACTIVE",
    };
  }
  return candidatePresent
    ? {
        ...base,
        effectState: "RECONCILED_EFFECT",
        retrySafe: false,
        reconciliationRequired: false,
        reasonCode: "TERMINAL_EFFECT_RECONCILED",
      }
    : {
        ...base,
        effectState: "RECONCILED_NO_EFFECT",
        retrySafe: true,
        reconciliationRequired: false,
        reasonCode: "TERMINAL_NO_EFFECT_RECONCILED",
      };
}

function recordToStartOutput(record: LocalAgentRecord): StartAgentOutput {
  const output: StartAgentOutput = {
    agentId: record.id,
    status: record.status,
    profileName: record.profileName,
    provider: record.provider,
    workspaceRoot: record.workspaceRoot,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.model !== undefined) output.model = record.model;
  if (record.effort !== undefined) output.effort = record.effort;
  if (record.workspaceId !== undefined) output.workspaceId = record.workspaceId;
  const executionIdlePolicy = record.lifecycleState?.activeTurn?.executionIdlePolicy
    ?? record.lifecycleState?.lastExecutionIdlePolicy;
  if (executionIdlePolicy) output.executionIdlePolicy = executionIdlePolicy;
  const selection = selectionContractOutput(record.executionContract?.selection);
  if (selection) output.selection = selection;
  const dispatch = dispatchContractOutput(record.executionContract?.dispatchIntent);
  if (dispatch) output.dispatch = dispatch;
  return output;
}

function recordToStatusOutput(
  record: LocalAgentRecord,
  lifecycle?: LifecycleEvidence,
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
  if (record.model !== undefined) output.model = record.model;
  if (record.effort !== undefined) output.effort = record.effort;
  if (record.workspaceId !== undefined) output.workspaceId = record.workspaceId;
  const executionIdlePolicy = record.lifecycleState?.activeTurn?.executionIdlePolicy
    ?? record.lifecycleState?.lastExecutionIdlePolicy;
  if (executionIdlePolicy) output.executionIdlePolicy = executionIdlePolicy;
  const selection = selectionContractOutput(record.executionContract?.selection);
  if (selection) output.selection = selection;
  const dispatch = dispatchContractOutput(record.executionContract?.dispatchIntent);
  if (dispatch) output.dispatch = dispatch;
  output.dispatchControl = dispatchControlForStatus(record, lifecycle);
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
    if (lifecycle.scopeState !== undefined) output.scopeState = lifecycle.scopeState;
  }
  return output;
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
