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
  LocalAgentReplayConflictError,
  LocalAgentStore,
  type LocalAgentRecord,
  type LocalAgentStatus,
} from "./local-agent-store.js";
import { loadLocalAgentProfiles, type LocalAgentProfile } from "./local-agent-profiles.js";
import {
  checkLocalAgentProviderAvailability,
  getLocalAgentProviderRuntimeVersion,
  resolveLocalAgentProviderExecutable,
} from "./local-agent-availability.js";
import { runLocalAgentProvider } from "./local-agent-adapters.js";
import { LocalAgentProviderError, type LocalAgentRunResult } from "./local-agent-runtime.js";
import { terminateProcessTree, type KillableProcess } from "./process-platform.js";
import { canonicalizePath } from "./roots.js";
import {
  type AgentTerminalReason,
  type ExecutionContract,
  type ScopeState,
} from "./local-agent-contract.js";
import { describeToolchainExecutables } from "./local-agent-toolchains.js";
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
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN_AGENT"
  | "AGENT_WORKSPACE_MISMATCH"
  | "AGENT_ALREADY_RUNNING"
  | "INVALID_WAIT_MS"
  | "WORKER_LAUNCH_FAILED"
  | "WORKER_TERMINATION_FAILED"
  | "STALE_WORKSPACE"
  | "NO_EXECUTION_CAPACITY"
  | "TOOLCHAIN_UNAVAILABLE"
  | "INVALID_EXECUTION_CONTRACT"
  | "INVALID_ATTEMPT_KEY"
  | "ATTEMPT_REPLAY_CONFLICT";

export class AgentSessionError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentSessionError";
  }
}

// ─── Input / Output types ────────────────────────────────────────────────────

export interface StartAgentInput {
  workspaceId: string;
  workspaceRoot: string;
  profileName: string;
  prompt: string;
  profiles: LocalAgentProfile[];
  executionContract?: ExecutionContract;
  attemptKey?: string;
}

export interface ContinueAgentInput {
  workspaceId: string;
  workspaceRoot: string;
  agentId: string;
  prompt: string;
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

export interface AgentStatusOutput {
  agentId: string;
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  thinking?: string;
  providerSessionId?: string;
  status: LocalAgentStatus;
  terminal: boolean;
  latestResponse?: string;
  error?: string;
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
}

export interface ReconcileAgentInput {
  workspaceId: string;
  workspaceRoot: string;
  isolated: boolean;
  agentId: string;
}

export interface ReconcileAgentOutput {
  agentId: string;
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
    thinking?: string;
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
  toolchain: {
    id: string;
    available: boolean;
    executables?: Record<string, string>;
  };
  blockers: Array<{ code: string; detail: string }>;
  unknowns: string[];
}

export interface AgentSummary {
  agentId: string;
  profileName: string;
  provider: string;
  model?: string;
  thinking?: string;
  status: LocalAgentStatus;
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

export interface StartAgentOutput {
  agentId: string;
  status: LocalAgentStatus;
  profileName: string;
  provider: string;
  model?: string;
  thinking?: string;
  workspaceId?: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContinueAgentOutput extends StartAgentOutput {
  continued: true;
}

// ─── Worker launcher type ────────────────────────────────────────────────────

/**
 * Async contract: resolves when the worker process has successfully spawned,
 * rejects if the OS-level spawn fails. Does NOT wait for the worker to finish.
 */
export type WorkerLauncher = (agentId: string, promptFile: string, workerToken: string) => Promise<void>;
export type WorkerTerminator = (record: LocalAgentRecord) => Promise<boolean>;
export type AgentTurnRunner = (
  profile: LocalAgentProfile | undefined,
  record: LocalAgentRecord,
  prompt: string,
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

  constructor(
    private readonly config: ServerConfig,
    testLauncher?: WorkerLauncher,
    testTerminator?: WorkerTerminator,
    testTurnRunner?: AgentTurnRunner,
  ) {
    this.store = createLocalAgentStore(config);
    this.launcher = testLauncher ?? defaultWorkerLauncher;
    this.terminator = testTerminator ?? terminateOwnedWorker;
    this.turnRunner = testTurnRunner;
  }

  /**
   * Start a new agent session using an advertised profile.
   * Returns immediately; worker runs in background.
   * Fail-closed: if worker fails to launch, record is set to error status.
   */
  async startAgent(input: StartAgentInput): Promise<StartAgentOutput> {
    const { workspaceId, workspaceRoot, profileName, prompt, profiles, executionContract, attemptKey } = input;

    const profile = profiles.find((p) => p.name === profileName);
    if (!profile) {
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

    const availability = checkLocalAgentProviderAvailability(profile.provider);
    if (!availability.available) {
      throw new AgentSessionError(
        "PROVIDER_UNAVAILABLE",
        `Agent provider '${profile.provider}' is unavailable: ${availability.reason ?? "unknown reason"}`,
      );
    }

    if (!this.hasExecutionCapacity()) {
      throw new AgentSessionError(
        "NO_EXECUTION_CAPACITY",
        `Execution capacity exhausted: ${this.runningCount()} of ${this.config.agentMaxConcurrent} configured agent(s) active.`,
      );
    }

    // Optional structured execution contract (execution-control only).
    if (executionContract?.toolchainId) {
      const toolchain = this.config.toolchains.find((candidate) => candidate.id === executionContract.toolchainId);
      if (!toolchain) {
        throw new AgentSessionError(
          "TOOLCHAIN_UNAVAILABLE",
          `Execution contract toolchain '${executionContract.toolchainId}' is not configured. ` +
            `Configure DEVSPACE_TOOLCHAINS or omit toolchainId. Dev MCP will not install or repair toolchains.`,
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
          thinking: profile.thinking,
          executionContract,
          startReplay: replayBinding,
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
          thinking: profile.thinking,
          executionContract,
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

    if (created) await this.launchPrompt(record.id, prompt);
    return recordToStartOutput(this.store.getById(record.id) ?? record);
  }

  /**
   * Continue an existing agent session with a new prompt.
   * Provider session ID is preserved.
   * Fail-closed: if worker fails to launch, record is set to error status.
   */
  async continueAgent(input: ContinueAgentInput): Promise<ContinueAgentOutput> {
    const { workspaceId: _workspaceId, workspaceRoot, agentId, prompt } = input;

    // Exact id lookup only (no prefix matching through MCP)
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

    if (record.status === "starting" || record.status === "running") {
      throw new AgentSessionError(
        "AGENT_ALREADY_RUNNING",
        `Agent ${agentId} is currently ${record.status}. Wait for it to complete before continuing.`,
      );
    }

    // Preserve provider/profile/session identity; reset response/error; restart
    // Note: workspaceId is NOT updated to preserve original workspaceId provenance.
    this.store.update(record.id, {
      status: "starting",
      latestResponse: undefined,
      error: undefined,
    });

    await this.launchPrompt(record.id, prompt);
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

    if (waitMs > 0 && isActiveStatus(record.status)) {
      const deadline = Date.now() + waitMs;
      while (isActiveStatus(record.status) && Date.now() < deadline) {
        await sleep(Math.min(300, deadline - Date.now()));
        record = this.store.getById(agentId) ?? record;
      }
    }

    return recordToStatusOutput(record, await this.buildLifecycleEvidence(record));
  }

  async cancelAgent(input: CancelAgentInput): Promise<AgentStatusOutput> {
    const { workspaceRoot, agentId } = input;
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

    const { previous, current } = this.store.cancelActive(agentId);
    if (previous.status === "starting" || previous.status === "running") {
      const terminated = await this.terminator(previous);
      if (!terminated) {
        this.store.update(agentId, {
          error: "cancellation persisted but owned worker termination could not be verified",
        });
        throw new AgentSessionError(
          "WORKER_TERMINATION_FAILED",
          `Agent ${agentId} is stopped, but its owned worker process could not be verified as terminated.`,
        );
      }
    }
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
    const { workspaceId, workspaceRoot, isolated, profileName, profiles, toolchainId } = input;
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
      blockers.push({
        code: "UNKNOWN_PROFILE",
        detail: `Profile '${profileName}' is not advertised for this workspace.`,
      });
    }

    let providerConfigured = false;
    let runtimeReady = false;
    let runtimeVersion: string | undefined;
    let executionIdentity = "none";
    if (profile) {
      const availability = checkLocalAgentProviderAvailability(profile.provider);
      providerConfigured = availability.available;
      runtimeReady = availability.available;
      executionIdentity = profile.provider;
      if (!availability.available) {
        blockers.push({
          code: "RUNTIME_STARTUP_NOT_READY",
          detail: `Provider '${profile.provider}' runtime is not configured: ${availability.reason ?? "unknown reason"}`,
        });
      } else {
        runtimeVersion = getLocalAgentProviderRuntimeVersion(profile.provider);
        const executable = resolveLocalAgentProviderExecutable(profile.provider);
        if (executable) executionIdentity = executable;
      }
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

    const capacityAvailable = this.hasExecutionCapacity();
    if (!capacityAvailable) {
      blockers.push({
        code: "NO_EXECUTION_CAPACITY",
        detail: `${this.runningCount()} of ${this.config.agentMaxConcurrent} configured agent(s) are active.`,
      });
    }

    let toolchainAvailable = false;
    let executables: Record<string, string> | undefined;
    if (toolchainId) {
      const toolchain = this.config.toolchains.find((candidate) => candidate.id === toolchainId);
      if (!toolchain) {
        blockers.push({
          code: "TOOLCHAIN_UNAVAILABLE",
          detail: `Toolchain '${toolchainId}' is not configured.`,
        });
      } else {
        toolchainAvailable = true;
        executables = describeToolchainExecutables(this.config.toolchains, toolchainId);
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
        thinking: profile?.thinking,
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
    const updatedAtMs = Date.parse(record.updatedAt);
    const now = Date.now();

    return {
      agentId: record.id,
      agentState: record.status,
      providerState: record.status,
      providerSessionId: record.providerSessionId,
      terminalReason: record.terminalReason,
      workspace: {
        head: physical.head,
        dirty: physical.dirty,
      },
      candidate: {
        present: workerChanged.length > 0 || headAdvanced,
        changedPaths: workerChanged,
        unexpectedPaths,
        diffHash: physical.diffHash,
        scopeState,
      },
      activity: {
        startedAt: record.createdAt,
        lastActivityAt: record.updatedAt,
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
      if (record.status !== "running" && record.status !== "starting") continue;
      const contract = record.executionContract;
      if (!contract) continue;

      // `updatedAt` is refreshed when each worker turn is prepared/claimed.
      // A durable provider conversation may be continued long after the agent
      // record was first created, so maxWallMs must fence the active turn rather
      // than the lifetime of the durable session.
      const activeTurnStartedAtMs = Date.parse(record.updatedAt);
      if (contract.maxWallMs && now - activeTurnStartedAtMs > contract.maxWallMs) {
        await this.terminateActiveAgent(
          record.id,
          "timeout",
          `Agent exceeded execution contract maxWallMs of ${contract.maxWallMs}ms.`,
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

  /** Number of agents currently starting or running. */
  runningCount(): number {
    return this.store
      .list()
      .filter((record) => record.status === "starting" || record.status === "running").length;
  }

  private hasExecutionCapacity(): boolean {
    const max = this.config.agentMaxConcurrent;
    if (max === undefined || max === null || max <= 0) return true;
    return this.runningCount() < max;
  }

  private async buildLifecycleEvidence(
    record: LocalAgentRecord,
  ): Promise<LifecycleEvidence | undefined> {
    const physical = await inspectWorkspacePhysicalState(record.workspaceRoot);
    const now = Date.now();
    const startedAtMs = Date.parse(record.createdAt);
    const updatedAtMs = Date.parse(record.updatedAt);

    const changedPaths = record.scopeBaseline
      ? computeWorkerDelta(physical, record.scopeBaseline).changedPaths
      : physical.changedPaths;

    return {
      startedAt: record.createdAt,
      lastActivityAt: record.updatedAt,
      lastFileMutationAt: physical.lastFileMutationAt,
      wallMs: Math.max(0, now - startedAtMs),
      idleMs: Math.max(0, now - updatedAtMs),
      changedPaths: physical.gitAvailable ? changedPaths : undefined,
      terminalReason: record.terminalReason,
      scopeState: record.scopeState,
    };
  }

  private async evaluateScope(agentId: string): Promise<{
    scopeState: ScopeState;
    unexpectedPaths: string[];
  }> {
    const record = this.store.getById(agentId);
    if (!record) return { scopeState: "UNKNOWN", unexpectedPaths: [] };
    const contract = record.executionContract;
    if (!contract?.writePaths?.length && !contract?.maxFiles) {
      return { scopeState: "UNKNOWN", unexpectedPaths: [] };
    }
    const physical = await inspectWorkspacePhysicalState(record.workspaceRoot);
    if (!physical.gitAvailable) return { scopeState: "UNKNOWN", unexpectedPaths: [] };
    const delta = computeWorkerDelta(physical, record.scopeBaseline);
    return this.classifyWorkerScope(
      delta.changedPaths,
      contract.writePaths,
      contract.maxFiles,
      delta.attribution,
    );
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
  ): Promise<void> {
    const record = this.store.getById(agentId);
    if (!record) return;
    const wasActive = record.status === "starting" || record.status === "running";
    const terminated = wasActive ? await this.terminator(record) : true;
    const scopeState: ScopeState | undefined =
      reason === "scope_violation" ? "SCOPE_VIOLATION" : record.scopeState;
    this.store.update(agentId, {
      status: "error",
      workerPid: undefined,
      workerToken: undefined,
      error: message,
      terminalReason: reason,
      scopeState,
    });
    if (!terminated) {
      this.store.update(agentId, {
        error: `${message} Worker termination could not be verified.`,
      });
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

    const claimed = this.store.claimWorker(agentId, workerToken, process.pid);
    if (!claimed) {
      cleanupOwnedPromptFile(promptFile);
      return;
    }

    const prompt = await readFile(promptFile, "utf8");
    try {
      // Snapshot the physical workspace BEFORE any provider mutation so that
      // pre-existing changes are never attributed to this worker turn.
      // The baseline is always captured: reconciliation must be able to report a
      // physical diff as candidate evidence even when no execution contract
      // bounds writes (e.g. a manually started agent with no writePaths/maxFiles).
      const state = await inspectWorkspacePhysicalState(claimed.workspaceRoot);
      this.store.update(claimed.id, {
        scopeBaseline: {
          changedPaths: state.changedPaths,
          head: state.head ?? null,
          fingerprints: state.fingerprints,
        },
      });

      const profiles = await loadLocalAgentProfiles(this.config, claimed.workspaceRoot);
      const profile = profiles.find((p) => p.name === claimed.profileName);
      let result: LocalAgentRunResult;
      if (this.turnRunner) {
        result = await this.turnRunner(profile, claimed, prompt);
      } else if (profile) {
        result = await runLocalAgentProfile(profile, claimed, prompt);
      } else {
        result = await runRawLocalAgentProvider(claimed, prompt);
      }

      const scope = await this.evaluateScope(claimed.id);
      const scopeViolated = scope.scopeState === "SCOPE_VIOLATION";
      this.store.finishWorker(agentId, workerToken, {
        providerSessionId: result.providerSessionId ?? undefined,
        status: "idle",
        latestResponse: result.finalResponse,
        error: scopeViolated
          ? `Agent wrote outside the declared write scope. Offending paths: ${scope.unexpectedPaths.join(", ")}`
          : undefined,
        terminalReason: scopeViolated ? "scope_violation" : "completed",
        scopeState: scope.scopeState,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const scope = await this.evaluateScope(agentId);
      this.store.finishWorker(agentId, workerToken, {
        providerSessionId: error instanceof LocalAgentProviderError ? error.providerSessionId : undefined,
        status: "error",
        latestResponse: error instanceof LocalAgentProviderError ? error.finalResponse : undefined,
        error: message,
        terminalReason: error instanceof LocalAgentProviderError ? "provider_error" : classifyProviderError(message),
        scopeState: scope.scopeState,
      });
    } finally {
      cleanupOwnedPromptFile(promptFile);
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
    this.store.prepareWorker(agentId, workerToken);
    try {
      await this.launcher(agentId, promptFile, workerToken);
    } catch (error) {
      this.store.update(agentId, {
        status: "error",
        workerPid: undefined,
        workerToken: undefined,
        error: `Worker launch failed: ${error instanceof Error ? error.message : String(error)}`,
      });
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
    return this.store.create(input);
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
    thinking: input.profile.thinking ?? null,
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

function defaultWorkerLauncher(agentId: string, promptFile: string, workerToken: string): Promise<void> {
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
      child.unref();
      resolve();
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
  if (!pid || !workerToken) return true;

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
  profile: LocalAgentProfile,
  record: LocalAgentRecord,
  prompt?: string,
): Promise<LocalAgentRunResult> {
  const effectivePrompt = prompt ?? "";
  const body = profile.body.trim();
  const fullPrompt = body ? `${body}\n\nTask:\n${effectivePrompt}` : effectivePrompt;
  return runLocalAgentProvider(profile.provider, {
    prompt: fullPrompt,
    workspace: record.workspaceRoot,
    providerSessionId: record.providerSessionId,
    writeMode: profile.write_mode === "allowed" ? "allowed" : "read_only",
    model: record.model ?? profile.model,
    thinking: record.thinking ?? profile.thinking,
  });
}

async function runRawLocalAgentProvider(
  record: LocalAgentRecord,
  prompt?: string,
): Promise<LocalAgentRunResult> {
  const { isLocalAgentProvider } = await import("./local-agent-profiles.js");
  if (record.profileName !== record.provider || !isLocalAgentProvider(record.provider)) {
    throw new Error(`Subagent profile not found: ${record.profileName}`);
  }
  return runLocalAgentProvider(record.provider, {
    prompt: prompt ?? "",
    workspace: record.workspaceRoot,
    providerSessionId: record.providerSessionId,
    writeMode: "read_only",
    model: record.model,
    thinking: record.thinking,
  });
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
  if (record.thinking !== undefined) output.thinking = record.thinking;
  if (record.workspaceId !== undefined) output.workspaceId = record.workspaceId;
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
    terminal: isTerminalStatus(record.status),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.model !== undefined) output.model = record.model;
  if (record.thinking !== undefined) output.thinking = record.thinking;
  if (record.workspaceId !== undefined) output.workspaceId = record.workspaceId;
  if (record.providerSessionId !== undefined) output.providerSessionId = record.providerSessionId;
  if (record.latestResponse !== undefined) output.latestResponse = record.latestResponse;
  if (record.error !== undefined) output.error = record.error;
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
    updatedAt: record.updatedAt,
  };
  if (record.model !== undefined) output.model = record.model;
  if (record.thinking !== undefined) output.thinking = record.thinking;
  return output;
}
