import { createConnection, type Socket } from "node:net";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, normalize } from "node:path";
import type { LocalAgentStore, ExternalRuntimeLaunchFence, LocalAgentRecord } from "./local-agent-store.js";
import { hashDispatchIntent } from "./execution-protocol.js";
import { canonicalizePath } from "./roots.js";

export const HERDR_DEFAULT_SOCKET_PATH = process.env.HERDR_SOCKET_PATH || "/Users/james/.config/herdr/herdr.sock";
export const HERDR_RUNTIME_KIND = "HERDR" as const;

export type HerdrAgentKind = "opencode" | "agy" | "codex" | "cline" | "grok";

export type HerdrEnforcementState =
  | "REQUEST_ONLY_NOT_ENFORCED"
  | "PARTIALLY_ENFORCED"
  | "PHYSICALLY_ENFORCED"
  | "NOT_OBSERVED";

export interface HerdrExternalHandle {
  schemaVersion: 1;
  runtimeKind: typeof HERDR_RUNTIME_KIND;
  agentId?: string;
  herdrSocketPath: string;
  herdrServerIdentity?: string;
  herdrWorkspaceId: string;
  herdrPaneId: string;
  herdrAgentIdentity: string;
  herdrAgentKind: HerdrAgentKind;
  requestedProvider?: string;
  requestedModel?: string;
  requestedEffort?: string;
  effectiveProvider?: string;
  effectiveModel?: string;
  effectiveEffort?: string;
  nativeProviderSessionId?: string;
  launchGeneration?: number;
  promptNonce: string;
  canonicalWorktreePath: string;
  workspaceId: string;
  gitHeadBefore: string;
  attemptKey: string;
  dispatchIntentHash: string;
  launchTimestamp: string;
  enforcementState: HerdrEnforcementState;
}

export interface StartHerdrAgentParams {
  agentId?: string;
  attemptKey: string;
  dispatchIntentHash: string;
  agentKind: HerdrAgentKind;
  canonicalWorktreePath: string;
  workspaceId: string;
  requestedModel?: string;
  requestedEffort?: string;
  socketPath?: string;
  store?: LocalAgentStore;
  allowTestOnlyNonConsequential?: boolean;
}

export interface HerdrPromptOptions {
  timeoutMs?: number;
  until?: string[];
  store?: LocalAgentStore;
  allowTestOnlyNonConsequential?: boolean;
}

export interface HerdrPromptResult {
  turnNonce?: string;
  status: "done" | "idle" | "blocked" | "OUTCOME_UNKNOWN";
  rawStatus?: string;
  paneOutput?: string;
  stalled?: boolean;
  timeout?: boolean;
}

export type HerdrExecutionState = "SETTLED_TERMINAL" | "RUNNING" | "BLOCKED" | "OUTCOME_UNKNOWN";
export type HerdrPhysicalEffect = "PRESENT" | "ABSENT" | "UNKNOWN";

export interface HerdrReconciliationResult {
  settled: boolean;
  completionStatus: "COMPLETED" | "NOT_COMPLETE" | "SCOPE_VIOLATION" | "OUTCOME_UNKNOWN";
  executionState: HerdrExecutionState;
  physicalEffect: HerdrPhysicalEffect;
  changedPaths: string[];
  unexpectedPaths: string[];
  gitHeadAfter?: string;
  enforcementState: HerdrEnforcementState;
  reason?: string;
}

export interface HerdrSocketRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface HerdrSocketResponse<T = unknown> {
  id: string;
  result?: T;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Low-level JSON line client over HerdR's Unix domain socket.
 */
export async function sendHerdrSocketRequest<T = unknown>(
  req: HerdrSocketRequest,
  socketPath: string = HERDR_DEFAULT_SOCKET_PATH,
  timeoutMs: number = 10_000,
): Promise<HerdrSocketResponse<T>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let timer: NodeJS.Timeout | undefined;
    let client: Socket | undefined;
    let buffer = "";

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (client && !client.destroyed) client.destroy();
    };

    timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`HerdR socket request '${req.method}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    client = createConnection(socketPath, () => {
      client?.write(JSON.stringify(req) + "\n");
    });

    client.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        cleanup();
        try {
          const parsed = JSON.parse(line) as HerdrSocketResponse<T>;
          resolvePromise(parsed);
        } catch (parseErr) {
          rejectPromise(new Error(`Failed to parse HerdR response JSON: ${line}`));
        }
      }
    });

    client.on("error", (err) => {
      cleanup();
      rejectPromise(err);
    });
  });
}

/**
 * Inspect terminal content to fail closed against onboarding / login dialogs (upstream #4343).
 */
export function detectBlockedOnboardingDialog(agentKind: HerdrAgentKind, terminalText: string): boolean {
  if (
    terminalText.includes("Do you trust the contents of this project?") ||
    terminalText.includes("Do you trust the authors") ||
    terminalText.includes("Allow creation of this file?") ||
    terminalText.includes("Allow execution of") ||
    terminalText.includes("Allow file edit") ||
    terminalText.includes("Do you want to allow") ||
    terminalText.includes("Permission denied") ||
    terminalText.includes("permission admission") ||
    terminalText.includes("Waiting for approval") ||
    terminalText.includes("Grant permission") ||
    terminalText.includes("Allow this action?") ||
    terminalText.includes("Welcome to Codex") ||
    terminalText.includes("Sign in with ChatGPT") ||
    terminalText.includes("Sign in with Device Code") ||
    terminalText.includes("Provide your own API key") ||
    terminalText.includes("authkit.cline.bot") ||
    terminalText.includes("Enter this code in your browser")
  ) {
    return true;
  }
  return false;
}

/**
 * In-memory registry of active handles to enforce attemptKey deduplication (N1)
 * and conflicting replay prevention (N2).
 * Enforces Option A (B4): tracks submitted prompts per attemptKey to reject subsequent prompts.
 */
export class HerdrGatewayRegistry {
  private handlesByAttemptKey = new Map<string, HerdrExternalHandle>();
  private submittedPromptAttemptKeys = new Set<string>();

  getHandle(attemptKey: string): HerdrExternalHandle | undefined {
    return this.handlesByAttemptKey.get(attemptKey);
  }

  registerHandle(handle: HerdrExternalHandle): void {
    const existing = this.handlesByAttemptKey.get(handle.attemptKey);
    if (existing) {
      if (existing.dispatchIntentHash !== handle.dispatchIntentHash) {
        throw new Error(
          `Conflicting replay for attemptKey '${handle.attemptKey}': existing intent hash '${existing.dispatchIntentHash}' does not match '${handle.dispatchIntentHash}'`,
        );
      }
      return; // Already registered
    }
    this.handlesByAttemptKey.set(handle.attemptKey, handle);
  }

  markPromptSubmitted(attemptKey: string): void {
    this.submittedPromptAttemptKeys.add(attemptKey);
  }

  hasPromptSubmitted(attemptKey: string): boolean {
    return this.submittedPromptAttemptKeys.has(attemptKey);
  }

  releaseHandle(attemptKey: string): void {
    this.handlesByAttemptKey.delete(attemptKey);
    this.submittedPromptAttemptKeys.delete(attemptKey);
  }

  clear(): void {
    this.handlesByAttemptKey.clear();
    this.submittedPromptAttemptKeys.clear();
  }
}

export function cleanPorcelainPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function parsePorcelainChangedPaths(statusOutput: string): string[] {
  const paths: string[] = [];
  for (const line of statusOutput.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.length < 3) continue;
    const payload = trimmed.slice(3).trim();
    if (!payload) continue;
    if (payload.includes(" -> ")) {
      const [src, dst] = payload.split(" -> ");
      const cleanSrc = cleanPorcelainPath(src);
      const cleanDst = cleanPorcelainPath(dst);
      if (cleanSrc) paths.push(cleanSrc);
      if (cleanDst) paths.push(cleanDst);
    } else {
      const clean = cleanPorcelainPath(payload);
      if (clean) paths.push(clean);
    }
  }
  return paths;
}

export const defaultHerdrGatewayRegistry = new HerdrGatewayRegistry();

export class HerdrThinGateway {
  constructor(
    private readonly socketPath: string = HERDR_DEFAULT_SOCKET_PATH,
    private readonly registry: HerdrGatewayRegistry = defaultHerdrGatewayRegistry,
    private readonly store?: LocalAgentStore,
  ) {}

  protected async sendRequest<T = unknown>(
    req: HerdrSocketRequest,
    timeoutMs: number = 10_000,
    socketPath?: string,
  ): Promise<HerdrSocketResponse<T>> {
    return sendHerdrSocketRequest<T>(req, socketPath || this.socketPath, timeoutMs);
  }

  /**
   * List workspaces directly over socket.
   */
  async listWorkspaces(): Promise<Array<{ workspace_id: string; label?: string }>> {
    const req: HerdrSocketRequest = {
      id: `ws-list-${Date.now()}`,
      method: "workspace.list",
      params: {},
    };
    try {
      const res = await this.sendRequest<{
        type: string;
        workspaces?: Array<{ workspace_id: string; label?: string }>;
      }>(req, 3000);
      return res.result?.workspaces || [];
    } catch {
      return [];
    }
  }

  /**
   * Show a workspace directly over socket.
   */
  async getWorkspace(workspaceId: string): Promise<{ workspace_id: string; root_pane_id?: string } | undefined> {
    const req: HerdrSocketRequest = {
      id: `ws-get-${Date.now()}`,
      method: "workspace.get",
      params: { target: workspaceId },
    };
    try {
      const res = await this.sendRequest<{
        workspace?: { workspace_id: string; root_pane_id?: string };
      }>(req, 3000);
      return res.result?.workspace;
    } catch {
      return undefined;
    }
  }

  private async reconcileFencedLaunch(
    params: StartHerdrAgentParams,
    record: LocalAgentRecord,
    launch: ExternalRuntimeLaunchFence,
    canonicalPath: string,
    gitHeadBefore: string,
    store: LocalAgentStore,
  ): Promise<HerdrExternalHandle | undefined> {
    const wsLabel = `devspace-${params.attemptKey}`;
    const agentName = ("ds-" + params.attemptKey.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()).slice(0, 32);

    let wsId = launch.herdrWorkspaceId;
    let paneId = launch.herdrPaneId;

    // 1. If workspace not observed, query HerdR to see if workspace was created
    if (!wsId) {
      const workspaces = await this.listWorkspaces();
      const match = workspaces.find((w) => w.label === wsLabel);
      if (match) {
        wsId = match.workspace_id;
        const wsDetails = await this.getWorkspace(wsId);
        paneId = wsDetails?.root_pane_id || `${wsId}:p1`;
        store.recordExternalRuntimeWorkspaceObservedCAS({
          agentId: record.id,
          attemptKey: params.attemptKey,
          herdrWorkspaceId: wsId,
          herdrPaneId: paneId,
          observedCwd: canonicalPath,
        });
      } else {
        return undefined;
      }
    }

    // 2. Workspace is known; check agent
    let agentIdentity = launch.herdrAgentIdentity;
    if (!agentIdentity) {
      const agentInfo = await this.getAgent(agentName);
      if (agentInfo) {
        agentIdentity = agentName;
        store.recordExternalRuntimeAgentObservedCAS({
          agentId: record.id,
          attemptKey: params.attemptKey,
          herdrAgentIdentity: agentName,
        });
      } else {
        return undefined;
      }
    }

    // 3. Both are positively observed! Build and bind completed handle
    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      agentId: record.id,
      herdrSocketPath: params.socketPath || this.socketPath,
      herdrWorkspaceId: wsId,
      herdrPaneId: paneId || `${wsId}:p1`,
      herdrAgentIdentity: agentIdentity,
      herdrAgentKind: params.agentKind,
      ...(params.requestedModel ? { requestedModel: params.requestedModel } : {}),
      ...(params.requestedEffort ? { requestedEffort: params.requestedEffort } : {}),
      promptNonce: launch.promptNonce,
      canonicalWorktreePath: canonicalPath,
      workspaceId: params.workspaceId,
      gitHeadBefore,
      attemptKey: params.attemptKey,
      dispatchIntentHash: params.dispatchIntentHash,
      launchTimestamp: launch.fencedAt,
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    store.bindExternalRuntimeBindingCAS({
      agentId: record.id,
      expectedAttemptKey: params.attemptKey,
      expectedDispatchIntentHash: params.dispatchIntentHash,
      binding: {
        runtimeKind: HERDR_RUNTIME_KIND,
        launch: {
          ...launch,
          state: "AGENT_OBSERVED",
          herdrWorkspaceId: wsId,
          herdrPaneId: paneId || `${wsId}:p1`,
          herdrAgentIdentity: agentIdentity,
          updatedAt: new Date().toISOString(),
        },
        handle: handle as unknown as Record<string, unknown>,
      },
    });

    this.registry.registerHandle(handle);
    return handle;
  }

  /**
   * Start a bounded external agent in HerdR.
   * Enforces pre-effect launch fence (C2), N1 (duplicate prevention), N2 (conflicting replay), N4 (wrong worktree fail closed).
   */
  async startExternalAgent(params: StartHerdrAgentParams): Promise<HerdrExternalHandle> {
    const canonicalPath = canonicalizePath(params.canonicalWorktreePath);

    // Git base fence (A9): must resolve exact 40-character commit SHA
    let gitHeadBefore = "";
    try {
      gitHeadBefore = execFileSync("git", ["-C", canonicalPath, "rev-parse", "HEAD"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch (err) {
      throw new Error(
        `[A9 Git Base Fence] Failed to resolve exact Git HEAD in worktree '${canonicalPath}': ${String(err)}`,
      );
    }

    if (!/^[0-9a-f]{40}$/i.test(gitHeadBefore)) {
      throw new Error(
        `[A9 Git Base Fence] Invalid Git HEAD '${gitHeadBefore}' in worktree '${canonicalPath}'; must be a valid 40-character commit SHA`,
      );
    }

    const effectiveStore = params.store ?? this.store;
    if (!params.allowTestOnlyNonConsequential && (!effectiveStore || !params.agentId)) {
      throw new Error(
        `[LAUNCH_NO_DURABLE_STORE] startExternalAgent requires a durable LocalAgentStore and agentId; in-memory-only execution is forbidden.`,
      );
    }

    const herdrSocketPath = params.socketPath || this.socketPath;
    let herdrServerIdentity: string | undefined = undefined;

    let record: LocalAgentRecord | undefined;
    if (effectiveStore && params.agentId) {
      record = effectiveStore.getById(params.agentId);
      if (!record) {
        throw new Error(`[UNKNOWN_AGENT] Agent record '${params.agentId}' not found in store.`);
      }

      if (record.startReplay?.key && record.startReplay.key !== params.attemptKey) {
        throw new Error(
          `[ATTEMPT_REPLAY_CONFLICT] Record attemptKey '${record.startReplay.key}' does not match launch attemptKey '${params.attemptKey}'`,
        );
      }

      if (record.executionContract?.dispatchIntent) {
        const recordHash = hashDispatchIntent(record.executionContract.dispatchIntent);
        if (recordHash && recordHash !== params.dispatchIntentHash) {
          throw new Error(
            `[N2 Conflicting Replay] attemptKey '${params.attemptKey}' already active with different intent hash '${recordHash}'`,
          );
        }
      }

      if (canonicalizePath(record.workspaceRoot) !== canonicalPath) {
        throw new Error(
          `[N4 Wrong Worktree] Record workspaceRoot '${record.workspaceRoot}' does not match canonical worktree '${canonicalPath}'`,
        );
      }

      const existingBinding = record.externalRuntimeBinding;
      if (existingBinding?.handle && typeof existingBinding.handle === "object") {
        const existing = existingBinding.handle as unknown as HerdrExternalHandle;
        if (existing.dispatchIntentHash !== params.dispatchIntentHash) {
          throw new Error(
            `[N2 Conflicting Replay] attemptKey '${params.attemptKey}' already active with different intent hash '${existing.dispatchIntentHash}'`,
          );
        }
        if (canonicalizePath(existing.canonicalWorktreePath) !== canonicalPath) {
          throw new Error(
            `[N4 Wrong Worktree] Observed cwd '${existing.canonicalWorktreePath}' does not match canonical worktree '${canonicalPath}'`,
          );
        }
        if (existing.herdrAgentKind !== params.agentKind) {
          throw new Error(
            `[ATTEMPT_REPLAY_CONFLICT] Replay agentKind '${params.agentKind}' does not match durable handle agentKind '${existing.herdrAgentKind}'`,
          );
        }
        if (existing.gitHeadBefore !== gitHeadBefore) {
          throw new Error(
            `[SOURCE_IDENTITY_DRIFT] Git HEAD '${gitHeadBefore}' drifted from bound gitHeadBefore '${existing.gitHeadBefore}'`,
          );
        }
        this.registry.registerHandle(existing);
        return existing;
      }

      if (existingBinding?.launch) {
        const launch = existingBinding.launch;
        if (launch.dispatchIntentHash !== params.dispatchIntentHash) {
          throw new Error(
            `[ATTEMPT_REPLAY_CONFLICT] Replay intent hash '${params.dispatchIntentHash}' does not match launch fence intent hash '${launch.dispatchIntentHash}'`,
          );
        }
        if (canonicalizePath(launch.canonicalWorktreePath) !== canonicalPath) {
          throw new Error(
            `[N4 Wrong Worktree] Observed cwd '${launch.canonicalWorktreePath}' does not match canonical worktree '${canonicalPath}'`,
          );
        }
        if (launch.agentKind !== params.agentKind) {
          throw new Error(
            `[ATTEMPT_REPLAY_CONFLICT] Replay agentKind '${params.agentKind}' does not match launch fence agentKind '${launch.agentKind}'`,
          );
        }
        if (launch.gitHeadBefore !== gitHeadBefore) {
          throw new Error(
            `[SOURCE_IDENTITY_DRIFT] Git HEAD '${gitHeadBefore}' drifted from launch fence gitHeadBefore '${launch.gitHeadBefore}'`,
          );
        }

        const reconciled = await this.reconcileFencedLaunch(
          params,
          record,
          launch,
          canonicalPath,
          gitHeadBefore,
          effectiveStore,
        );
        if (reconciled) {
          return reconciled;
        }
        throw new Error(
          `[OUTCOME_UNKNOWN] Launch fence exists for attemptKey '${params.attemptKey}' in state '${launch.state}', but external runtime state could not be positively reconciled. Cannot retry launch effects.`,
        );
      }
    } else {
      const existing = this.registry.getHandle(params.attemptKey);
      if (existing) {
        if (existing.dispatchIntentHash !== params.dispatchIntentHash) {
          throw new Error(
            `[N2 Conflicting Replay] attemptKey '${params.attemptKey}' already active with different intent hash '${existing.dispatchIntentHash}'`,
          );
        }
        return existing;
      }
    }

    const promptNonce = `HERDR-DISPATCH-${params.attemptKey}`;
    const wsLabel = `devspace-${params.attemptKey}`;
    const agentName = ("ds-" + params.attemptKey.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()).slice(0, 32);

    // Pre-effect launch fence (Blocker C2)
    if (effectiveStore && params.agentId) {
      const fenceRes = effectiveStore.fenceExternalRuntimeLaunchCAS({
        agentId: params.agentId,
        attemptKey: params.attemptKey,
        dispatchIntentHash: params.dispatchIntentHash,
        canonicalWorktreePath: canonicalPath,
        gitHeadBefore,
        agentKind: params.agentKind,
        requestedModel: params.requestedModel,
        requestedEffort: params.requestedEffort,
        promptNonce,
        workspaceId: params.workspaceId,
        expectedUpdatedAt: record?.updatedAt,
      });

      if (!fenceRes.applied) {
        throw new Error(
          `[LAUNCH_FENCE_FAILED] Failed to durably fence HerdR launch for attemptKey '${params.attemptKey}'; CAS failed. Zero external calls permitted.`,
        );
      }
    }

    // 1. Create HerdR workspace with exact cwd
    const wsReq: HerdrSocketRequest = {
      id: `HERDR-LAUNCH:${params.attemptKey}:workspace`,
      method: "workspace.create",
      params: {
        cwd: canonicalPath,
        label: wsLabel,
        focus: false,
      },
    };

    let wsRes: HerdrSocketResponse<{
      workspace: { workspace_id: string };
      root_pane: { pane_id: string; cwd: string; foreground_cwd: string };
    }>;

    try {
      wsRes = await this.sendRequest(wsReq, 10_000, herdrSocketPath);
    } catch (err) {
      if (effectiveStore && params.agentId) {
        effectiveStore.markExternalRuntimeLaunchOutcomeUnknownCAS({
          agentId: params.agentId,
          attemptKey: params.attemptKey,
          reason: `workspace.create transport error: ${String(err)}`,
        });
      }
      throw err;
    }

    if (wsRes.error || !wsRes.result) {
      if (effectiveStore && params.agentId) {
        effectiveStore.markExternalRuntimeLaunchOutcomeUnknownCAS({
          agentId: params.agentId,
          attemptKey: params.attemptKey,
          reason: `workspace.create failed: ${wsRes.error?.message}`,
        });
      }
      throw new Error(`HerdR workspace.create failed: ${wsRes.error?.message || "unknown error"}`);
    }

    const wsId = wsRes.result.workspace.workspace_id;
    const paneId = wsRes.result.root_pane.pane_id;
    const observedCwd = canonicalizePath(wsRes.result.root_pane.cwd);

    // N4: Wrong worktree fail closed
    if (observedCwd !== canonicalPath) {
      await this.closeWorkspace(wsId).catch(() => {});
      throw new Error(
        `[N4 Wrong Worktree] Observed cwd '${observedCwd}' does not match canonical worktree '${canonicalPath}'`,
      );
    }

    // Persist positive workspace observation BEFORE agent.start (Section 31 & 35)
    if (effectiveStore && params.agentId) {
      const wsPersistRes = effectiveStore.recordExternalRuntimeWorkspaceObservedCAS({
        agentId: params.agentId,
        attemptKey: params.attemptKey,
        herdrWorkspaceId: wsId,
        herdrPaneId: paneId,
        observedCwd,
      });

      if (!wsPersistRes.applied) {
        throw new Error(
          `[OUTCOME_UNKNOWN] Workspace created (id=${wsId}), but failed to durably persist workspace observation in store; halting before agent.start.`,
        );
      }
    }

    // 2. Start agent in pane
    const args: string[] = [];
    if (params.agentKind === "opencode") {
      const model = params.requestedModel || "opencode/mimo-v2.6-flash-free";
      args.push("-m", model);
    }

    const agentReq: HerdrSocketRequest = {
      id: `HERDR-LAUNCH:${params.attemptKey}:agent`,
      method: "agent.start",
      params: {
        name: agentName,
        kind: params.agentKind,
        pane_id: paneId,
        timeout_ms: 15_000,
        args,
      },
    };

    let agentRes: HerdrSocketResponse<{
      agent: {
        agent: string;
        agent_status: string;
        pane_id: string;
        state_change_seq: number;
        interactive_ready: boolean;
      };
    }>;

    try {
      agentRes = await this.sendRequest(agentReq, 15_000, herdrSocketPath);
    } catch (err) {
      if (effectiveStore && params.agentId) {
        effectiveStore.markExternalRuntimeLaunchOutcomeUnknownCAS({
          agentId: params.agentId,
          attemptKey: params.attemptKey,
          reason: `agent.start transport error: ${String(err)}`,
        });
      }
      throw err;
    }

    if (agentRes.error || !agentRes.result) {
      await this.closeWorkspace(wsId).catch(() => {});
      if (effectiveStore && params.agentId) {
        effectiveStore.markExternalRuntimeLaunchOutcomeUnknownCAS({
          agentId: params.agentId,
          attemptKey: params.attemptKey,
          reason: `agent.start failed: ${agentRes.error?.message}`,
        });
      }
      throw new Error(`HerdR agent.start failed: ${agentRes.error?.message || "unknown error"}`);
    }

    // Persist positive agent observation BEFORE prompt (Section 32 & 36)
    if (effectiveStore && params.agentId) {
      const agentPersistRes = effectiveStore.recordExternalRuntimeAgentObservedCAS({
        agentId: params.agentId,
        attemptKey: params.attemptKey,
        herdrAgentIdentity: agentName,
      });

      if (!agentPersistRes.applied) {
        throw new Error(
          `[OUTCOME_UNKNOWN] Agent started (name=${agentName}), but failed to durably persist agent observation in store; halting before prompt.`,
        );
      }
    }

    // Wait for agent to reach ready state over socket
    const waitReq: HerdrSocketRequest = {
      id: `HERDR-LAUNCH:${params.attemptKey}:agent-wait`,
      method: "agent.wait",
      params: {
        target: agentName,
        until: ["idle", "blocked", "done"],
        timeout_ms: 15_000,
      },
    };
    await this.sendRequest(waitReq, 15_000, herdrSocketPath).catch(() => {});

    // Read terminal visible output to fail closed against onboarding / trust / permission dialogs (A5 / N-TRUST / B3)
    let terminalOutput = await this.readPane(paneId);
    if (!terminalOutput.trim()) {
      await new Promise((r) => setTimeout(r, 1500));
      terminalOutput = await this.readPane(paneId);
    }
    if (detectBlockedOnboardingDialog(params.agentKind, terminalOutput)) {
      await this.closeWorkspace(wsId).catch(() => {});
      throw new Error(
        `[Fail-Closed / N-TRUST] Agent '${params.agentKind}' is stuck at an unauthenticated onboarding/trust/permission dialog: BLOCKED_ON_PERMISSION_ADMISSION`,
      );
    }

    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      agentId: params.agentId,
      herdrSocketPath,
      herdrServerIdentity,
      herdrWorkspaceId: wsId,
      herdrPaneId: paneId,
      herdrAgentIdentity: agentName,
      herdrAgentKind: params.agentKind,
      ...(params.requestedModel ? { requestedModel: params.requestedModel } : {}),
      ...(params.requestedEffort ? { requestedEffort: params.requestedEffort } : {}),
      promptNonce,
      canonicalWorktreePath: canonicalPath,
      workspaceId: params.workspaceId,
      gitHeadBefore,
      attemptKey: params.attemptKey,
      dispatchIntentHash: params.dispatchIntentHash,
      launchTimestamp: new Date().toISOString(),
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

    if (effectiveStore && params.agentId) {
      const bindRes = effectiveStore.bindExternalRuntimeBindingCAS({
        agentId: params.agentId,
        expectedAttemptKey: params.attemptKey,
        expectedDispatchIntentHash: params.dispatchIntentHash,
        binding: {
          runtimeKind: HERDR_RUNTIME_KIND,
          launch: {
            state: "AGENT_OBSERVED",
            launchRequestId: `HERDR-LAUNCH:${params.attemptKey}:${params.dispatchIntentHash.slice(0, 16)}`,
            attemptKey: params.attemptKey,
            dispatchIntentHash: params.dispatchIntentHash,
            canonicalWorktreePath: canonicalPath,
            gitHeadBefore,
            agentKind: params.agentKind,
            ...(params.requestedModel ? { requestedModel: params.requestedModel } : {}),
            ...(params.requestedEffort ? { requestedEffort: params.requestedEffort } : {}),
            promptNonce,
            ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
            herdrWorkspaceId: wsId,
            herdrPaneId: paneId,
            herdrAgentIdentity: agentName,
            fencedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          handle: handle as unknown as Record<string, unknown>,
        },
      });

      if (!bindRes.applied) {
        throw new Error(`[OUTCOME_UNKNOWN] Failed to bind final external runtime handle in store.`);
      }
    }

    this.registry.registerHandle(handle);
    return handle;
  }

  /**
   * Query HerdR agent status directly over socket.
   */
  async getAgent(agentName: string): Promise<{ agent_status: string; interactive_ready: boolean } | undefined> {
    const req: HerdrSocketRequest = {
      id: `agent-get-${Date.now()}`,
      method: "agent.get",
      params: { target: agentName },
    };
    try {
      const res = await this.sendRequest<{
        type: string;
        agent?: { agent_status: string; interactive_ready: boolean };
      }>(req, 3000);
      return res.result?.agent;
    } catch {
      return undefined;
    }
  }

  /**
   * Submit a prompt to an agent.
   * Enforces N3: timeout or stalled prompt maps to OUTCOME_UNKNOWN; zero duplicate panes.
   * Enforces Option A (B4): one consequential prompt per attempt; rejects subsequent prompts.
   * Embeds durable handle.promptNonce into prompt.
   * Enforces exact prompt fence CAS tuple (C1).
   */
  async promptExternalAgent(
    handle: HerdrExternalHandle,
    promptText: string,
    options: HerdrPromptOptions = {},
  ): Promise<HerdrPromptResult> {
    const effectiveStore = options.store ?? this.store;
    if (!options.allowTestOnlyNonConsequential && !effectiveStore) {
      throw new Error(
        `[PROMPT_NO_DURABLE_STORE] promptExternalAgent requires a durable LocalAgentStore; in-memory-only execution is forbidden.`,
      );
    }
    if (!options.allowTestOnlyNonConsequential && !handle.agentId) {
      throw new Error(
        `[PROMPT_MISSING_AGENT_ID] HerdrExternalHandle must contain exact agentId; fail closed.`,
      );
    }

    // Fast in-memory registry check (Option A / B4)
    if (this.registry.hasPromptSubmitted(handle.attemptKey)) {
      throw new Error(
        `[N-TURN-OPTION-A] attemptKey '${handle.attemptKey}' has already submitted a consequential prompt; subsequent prompts on same handle are rejected.`,
      );
    }

    // Exact durable check and CAS fence in store BEFORE any external socket effect (Blocker A & C1)
    if (effectiveStore && handle.agentId) {
      const fenceRes = effectiveStore.fenceConsequentialPromptCAS({
        agentId: handle.agentId,
        attemptKey: handle.attemptKey,
        dispatchIntentHash: handle.dispatchIntentHash,
        promptNonce: handle.promptNonce,
      });

      if (!fenceRes.applied) {
        throw new Error(
          `[N-TURN-OPTION-A] attemptKey '${handle.attemptKey}' prompt fence CAS failed (already fenced or authority tuple mismatch); cannot prompt external agent.`,
        );
      }
    }

    // Mark prompt as submitted under Option A
    this.registry.markPromptSubmitted(handle.attemptKey);
    const agentInfo = await this.getAgent(handle.herdrAgentIdentity);
    if (agentInfo && (agentInfo.agent_status === "running" || agentInfo.agent_status === "prompting" || !agentInfo.interactive_ready)) {
      throw new Error(
        `[N-TURN] Agent '${handle.herdrAgentIdentity}' is already busy in status '${agentInfo.agent_status}'; cannot submit new turn.`,
      );
    }

    const timeoutMs = options.timeoutMs ?? 30_000;
    const waitOptions: Record<string, unknown> = {
      timeout_ms: timeoutMs,
    };
    if (options.until && options.until.length > 0) {
      waitOptions.until = options.until;
    }

    // B4: Embed durable handle.promptNonce
    const turnNonce = handle.promptNonce;
    const boundPrompt = `[NEXUS_ATTEMPT_NONCE:${turnNonce}]\n\n${promptText}`;

    const req: HerdrSocketRequest = {
      id: `prompt-${Date.now()}`,
      method: "agent.prompt",
      params: {
        target: handle.herdrAgentIdentity,
        text: boundPrompt,
        wait: waitOptions,
      },
    };

    try {
      const res = await this.sendRequest<{
        agent: { agent_status: string; interactive_ready: boolean };
      }>(req, timeoutMs + 5000);

      if (res.error) {
        // N3: timeout or stalled prompt maps strictly to OUTCOME_UNKNOWN
        if (res.error.code === "timeout" || res.error.code === "agent_prompt_stalled") {
          return {
            turnNonce,
            status: "OUTCOME_UNKNOWN",
            rawStatus: res.error.code,
            timeout: res.error.code === "timeout",
            stalled: res.error.code === "agent_prompt_stalled",
          };
        }
        throw new Error(`HerdR prompt error: ${res.error.message}`);
      }

      const statusStr = res.result?.agent?.agent_status;
      const paneOutput = await this.readPane(handle.herdrPaneId);

      // Check if blocked on permission admission or onboarding dialog (B3)
      if (detectBlockedOnboardingDialog(handle.herdrAgentKind, paneOutput)) {
        return {
          turnNonce,
          status: "blocked",
          rawStatus: "BLOCKED_ON_PERMISSION_ADMISSION",
          paneOutput,
        };
      }

      const normalizedStatus: "done" | "idle" | "blocked" | "OUTCOME_UNKNOWN" =
        statusStr === "done" ? "done" : statusStr === "idle" ? "idle" : statusStr === "blocked" ? "blocked" : "OUTCOME_UNKNOWN";

      return {
        turnNonce,
        status: normalizedStatus,
        rawStatus: statusStr,
        paneOutput,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timed out")) {
        return {
          turnNonce,
          status: "OUTCOME_UNKNOWN",
          timeout: true,
        };
      }
      throw err;
    }
  }

  /**
   * Read pane output.
   */
  async readPane(paneId: string, lines: number = 60): Promise<string> {
    const req: HerdrSocketRequest = {
      id: `pane-read-${Date.now()}`,
      method: "pane.read",
      params: {
        pane_id: paneId,
        source: "recent_unwrapped",
        lines,
      },
    };
    try {
      const res = await this.sendRequest<{
        type: string;
        read: {
          text: string;
        };
      }>(req);
      if (res.result?.read?.text !== undefined) {
        return res.result.read.text;
      }
    } catch {}
    // Fallback to CLI read if socket read helper differs
    return execFileSync("herdr", ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  }

  /**
   * Send keys to a pane.
   */
  async sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    const req: HerdrSocketRequest = {
      id: `pane-keys-${Date.now()}`,
      method: "pane.send_keys",
      params: {
        pane_id: paneId,
        keys,
      },
    };
    await this.sendRequest(req).catch(() => {});
  }

  /**
   * Physical completion reconciliation.
   * Enforces N5 (worker false success), N5-COMMIT (committed change detection),
   * N6 (unexpected path), N6-COMMIT (unauthorized commit),
   * N7 (runtime loss), N7-PHYSICAL (physical evidence preserved during runtime loss),
   * N8 (enforcement truth).
   */
  async reconcileExternalAgent(
    handle: HerdrExternalHandle,
    expectedScope?: string[],
    expectMutation: boolean = true,
    lastPromptResult?: HerdrPromptResult,
  ): Promise<HerdrReconciliationResult> {
    const worktree = handle.canonicalWorktreePath;

    // 1. Physical Git state inspection (A2: independent of HerdR status)
    const changedPathsSet = new Set<string>();
    let gitInspectionFailed = false;

    // Committed diff vs gitHeadBefore if valid 40-char SHA (N5-COMMIT, N6-COMMIT)
    if (handle.gitHeadBefore && /^[0-9a-f]{40}$/i.test(handle.gitHeadBefore)) {
      try {
        const diffOut = execFileSync("git", ["-C", worktree, "diff", "--name-only", handle.gitHeadBefore], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (diffOut) {
          for (const line of diffOut.split("\n")) {
            const p = cleanPorcelainPath(line.trim());
            if (p) changedPathsSet.add(p);
          }
        }
      } catch {
        gitInspectionFailed = true;
      }
    }

    // Working tree and untracked changes (P1, P2, P6, P7, P8)
    try {
      const rawStatus = execFileSync(
        "git",
        ["-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      if (rawStatus) {
        const paths = parsePorcelainChangedPaths(rawStatus);
        for (const p of paths) {
          changedPathsSet.add(p);
        }
      }
    } catch {
      gitInspectionFailed = true;
    }

    const changedPaths = Array.from(changedPathsSet).sort();

    let gitHeadAfter: string | undefined;
    try {
      gitHeadAfter = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {}

    const physicalEffect: HerdrPhysicalEffect = gitInspectionFailed
      ? "UNKNOWN"
      : changedPaths.length > 0
        ? "PRESENT"
        : "ABSENT";

    // Scope check
    const unexpectedPaths: string[] = [];
    if (expectedScope && expectedScope.length > 0) {
      for (const p of changedPaths) {
        if (!expectedScope.includes(p)) {
          unexpectedPaths.push(p);
        }
      }
    }

    // 2. Execution settlement inspection (A3: separate from physical effect)
    let executionState: HerdrExecutionState = "OUTCOME_UNKNOWN";

    if (lastPromptResult?.status === "OUTCOME_UNKNOWN") {
      executionState = "OUTCOME_UNKNOWN";
    } else if (lastPromptResult?.status === "blocked") {
      executionState = "BLOCKED";
    } else {
      // Check HerdR server health and agent status
      let serverAlive = false;
      try {
        const ping = await sendHerdrSocketRequest<{ type: string }>({ id: "ping", method: "ping", params: {} }, this.socketPath, 2000);
        serverAlive = ping.result?.type === "pong";
      } catch {
        serverAlive = false;
      }

      if (!serverAlive) {
        executionState = "OUTCOME_UNKNOWN";
      } else {
        const agentInfo = await this.getAgent(handle.herdrAgentIdentity);
        if (!agentInfo) {
          executionState = lastPromptResult?.status === "done" || lastPromptResult?.status === "idle"
            ? "SETTLED_TERMINAL"
            : "OUTCOME_UNKNOWN";
        } else if (agentInfo.agent_status === "running" || agentInfo.agent_status === "prompting") {
          executionState = "RUNNING";
        } else if (agentInfo.agent_status === "blocked") {
          executionState = "BLOCKED";
        } else if (agentInfo.agent_status === "idle" || agentInfo.agent_status === "done") {
          executionState = "SETTLED_TERMINAL";
        } else {
          executionState = "OUTCOME_UNKNOWN";
        }
      }
    }

    // 3. Synthesize result (A3)
    if (executionState === "OUTCOME_UNKNOWN") {
      return {
        settled: false,
        completionStatus: "OUTCOME_UNKNOWN",
        executionState,
        physicalEffect,
        changedPaths,
        unexpectedPaths,
        gitHeadAfter,
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
        reason: "HerdR server is unreachable or prompt outcome is unknown (UNRECOVERABLE_PROCESS_UPON_HEADLESS_RESTART / timeout).",
      };
    }

    if (executionState === "RUNNING") {
      return {
        settled: false,
        completionStatus: "NOT_COMPLETE",
        executionState,
        physicalEffect,
        changedPaths,
        unexpectedPaths,
        gitHeadAfter,
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
        reason: "Agent execution is still running.",
      };
    }

    if (executionState === "BLOCKED") {
      const reason =
        lastPromptResult?.rawStatus === "BLOCKED_ON_PERMISSION_ADMISSION"
          ? "Agent is blocked on interaction or onboarding: BLOCKED_ON_PERMISSION_ADMISSION."
          : "Agent is blocked on interaction or onboarding.";
      return {
        settled: false,
        completionStatus: "NOT_COMPLETE",
        executionState,
        physicalEffect,
        changedPaths,
        unexpectedPaths,
        gitHeadAfter,
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
        reason,
      };
    }

    // executionState === "SETTLED_TERMINAL"
    if (unexpectedPaths.length > 0) {
      return {
        settled: true,
        completionStatus: "SCOPE_VIOLATION",
        executionState,
        physicalEffect,
        changedPaths,
        unexpectedPaths,
        gitHeadAfter,
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
        reason: `Physical changes touched paths outside authorized scope: ${unexpectedPaths.join(", ")}`,
      };
    }

    if (expectMutation && physicalEffect === "ABSENT") {
      return {
        settled: true,
        completionStatus: "NOT_COMPLETE",
        executionState,
        physicalEffect,
        changedPaths: [],
        unexpectedPaths: [],
        gitHeadAfter,
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
        reason: "Worker settled but no physical file modifications were observed.",
      };
    }

    return {
      settled: true,
      completionStatus: "COMPLETED",
      executionState,
      physicalEffect,
      changedPaths,
      unexpectedPaths: [],
      gitHeadAfter,
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };
  }

  /**
   * Stop an external agent and close its HerdR workspace.
   * Enforces A8: close workspace first; release registry binding only upon successful close.
   */
  async stopExternalAgent(handle: HerdrExternalHandle): Promise<void> {
    await this.closeWorkspace(handle.herdrWorkspaceId);
    this.registry.releaseHandle(handle.attemptKey);
  }

  /**
   * Close a HerdR workspace.
   * Enforces A8: does not swallow close errors.
   */
  async closeWorkspace(workspaceId: string): Promise<void> {
    const req: HerdrSocketRequest = {
      id: `ws-close-${Date.now()}`,
      method: "workspace.close",
      params: {
        workspace_id: workspaceId,
      },
    };
    const res = await this.sendRequest<{ type?: string }>(req);
    if (res.error) {
      throw new Error(`HerdR workspace.close failed: ${res.error.message}`);
    }
  }
}
