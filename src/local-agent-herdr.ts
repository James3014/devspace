import { createConnection, type Socket } from "node:net";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, normalize } from "node:path";
import type { LocalAgentStore } from "./local-agent-store.js";

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
  attemptKey: string;
  dispatchIntentHash: string;
  agentKind: HerdrAgentKind;
  canonicalWorktreePath: string;
  workspaceId: string;
  requestedModel?: string;
  requestedEffort?: string;
  socketPath?: string;
}

export interface HerdrPromptOptions {
  timeoutMs?: number;
  until?: string[];
  store?: LocalAgentStore;
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

  protected async sendRequest<T = unknown>(req: HerdrSocketRequest, timeoutMs: number = 10_000): Promise<HerdrSocketResponse<T>> {
    return sendHerdrSocketRequest<T>(req, this.socketPath, timeoutMs);
  }

  /**
   * Start a bounded external agent in HerdR.
   * Enforces N1 (duplicate prevention), N2 (conflicting replay), N4 (wrong worktree fail closed).
   */
  async startExternalAgent(params: StartHerdrAgentParams): Promise<HerdrExternalHandle> {
    const canonicalPath = normalize(resolve(params.canonicalWorktreePath));

    // N1 & N2: Check existing handle
    const existing = this.registry.getHandle(params.attemptKey);
    if (existing) {
      if (existing.dispatchIntentHash !== params.dispatchIntentHash) {
        throw new Error(
          `[N2 Conflicting Replay] attemptKey '${params.attemptKey}' already active with different intent hash '${existing.dispatchIntentHash}'`,
        );
      }
      // N1: Return existing handle without creating a second agent/pane
      return existing;
    }

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

    // Transport endpoint vs server instance identity (B5)
    // herdrSocketPath is recorded as transport endpoint.
    // HerdR 0.9.1 ping returns version/protocol but no server instance UUID;
    // herdrServerIdentity is classified as undefined / NOT_OBSERVED.
    const herdrSocketPath = this.socketPath;
    let herdrServerIdentity: string | undefined = undefined;

    // 1. Create HerdR workspace with exact cwd
    const wsLabel = `devspace-${params.attemptKey}`;
    const wsReq: HerdrSocketRequest = {
      id: `ws-create-${Date.now()}`,
      method: "workspace.create",
      params: {
        cwd: canonicalPath,
        label: wsLabel,
        focus: false,
      },
    };

    const wsRes = await sendHerdrSocketRequest<{
      workspace: { workspace_id: string };
      root_pane: { pane_id: string; cwd: string; foreground_cwd: string };
    }>(wsReq, this.socketPath);

    if (wsRes.error || !wsRes.result) {
      throw new Error(`HerdR workspace.create failed: ${wsRes.error?.message || "unknown error"}`);
    }

    const wsId = wsRes.result.workspace.workspace_id;
    const paneId = wsRes.result.root_pane.pane_id;
    const observedCwd = normalize(resolve(wsRes.result.root_pane.cwd));

    // N4: Wrong worktree fail closed
    if (observedCwd !== canonicalPath) {
      // Clean up workspace immediately
      await this.closeWorkspace(wsId).catch(() => {});
      throw new Error(
        `[N4 Wrong Worktree] Observed cwd '${observedCwd}' does not match canonical worktree '${canonicalPath}'`,
      );
    }

    // 2. Start agent in pane
    const agentName = ("ds-" + params.attemptKey.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()).slice(0, 32);
    const args: string[] = [];
    if (params.agentKind === "opencode") {
      const model = params.requestedModel || "opencode/mimo-v2.6-flash-free";
      args.push("-m", model);
    }
    // B3: Completely removed --dangerously-skip-permissions for agy.

    const agentReq: HerdrSocketRequest = {
      id: `agent-start-${Date.now()}`,
      method: "agent.start",
      params: {
        name: agentName,
        kind: params.agentKind,
        pane_id: paneId,
        timeout_ms: 15_000,
        args,
      },
    };

    const agentRes = await sendHerdrSocketRequest<{
      agent: {
        agent: string;
        agent_status: string;
        pane_id: string;
        state_change_seq: number;
        interactive_ready: boolean;
      };
    }>(agentReq, this.socketPath);

    if (agentRes.error || !agentRes.result) {
      await this.closeWorkspace(wsId).catch(() => {});
      throw new Error(`HerdR agent.start failed: ${agentRes.error?.message || "unknown error"}`);
    }

    // Wait for agent to reach ready state over socket
    const waitReq: HerdrSocketRequest = {
      id: `agent-wait-${Date.now()}`,
      method: "agent.wait",
      params: {
        target: agentName,
        until: ["idle", "blocked", "done"],
        timeout_ms: 15_000,
      },
    };
    await sendHerdrSocketRequest(waitReq, this.socketPath).catch(() => {});

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

    const promptNonce = `HERDR-DISPATCH-${params.attemptKey}-${Date.now()}`;
    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
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
      // N8: Never claim physically enforced
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };

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
      const res = await sendHerdrSocketRequest<{
        type: string;
        agent?: { agent_status: string; interactive_ready: boolean };
      }>(req, this.socketPath, 3000);
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
   */
  async promptExternalAgent(
    handle: HerdrExternalHandle,
    promptText: string,
    options: HerdrPromptOptions = {},
  ): Promise<HerdrPromptResult> {
    const effectiveStore = options.store ?? this.store;

    // Fast in-memory registry check (Option A / B4)
    if (this.registry.hasPromptSubmitted(handle.attemptKey)) {
      throw new Error(
        `[N-TURN-OPTION-A] attemptKey '${handle.attemptKey}' has already submitted a consequential prompt; subsequent prompts on same handle are rejected.`,
      );
    }

    // Durable check and CAS fence in store BEFORE any external socket effect (Blocker A)
    if (effectiveStore) {
      let record = handle.agentId ? effectiveStore.getById(handle.agentId) : undefined;
      if (!record) {
        const rows = effectiveStore.list();
        record = rows.find(
          (r) =>
            r.startReplay?.key === handle.attemptKey ||
            (r.externalRuntimeBinding?.handle &&
              typeof r.externalRuntimeBinding.handle === "object" &&
              (r.externalRuntimeBinding.handle as Record<string, unknown>).attemptKey === handle.attemptKey),
        );
      }

      if (record?.externalRuntimeBinding?.promptState?.consequentialPromptFenced) {
        this.registry.markPromptSubmitted(handle.attemptKey);
        throw new Error(
          `[N-TURN-OPTION-A] attemptKey '${handle.attemptKey}' has already submitted a consequential prompt; subsequent prompts on same handle are rejected.`,
        );
      }

      const fenceRes = effectiveStore.fenceConsequentialPromptCAS({
        agentId: handle.agentId ?? record?.id,
        attemptKey: handle.attemptKey,
        promptNonce: handle.promptNonce,
      });

      if (!fenceRes.applied) {
        this.registry.markPromptSubmitted(handle.attemptKey);
        throw new Error(
          `[N-TURN-OPTION-A] attemptKey '${handle.attemptKey}' prompt fence CAS failed (already fenced or conflict); cannot prompt external agent.`,
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

    // Mark prompt as submitted under Option A
    this.registry.markPromptSubmitted(handle.attemptKey);

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
      const res = await sendHerdrSocketRequest<{
        type: string;
        read: {
          text: string;
        };
      }>(req, this.socketPath);
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
    await sendHerdrSocketRequest(req, this.socketPath).catch(() => {});
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
    const res = await sendHerdrSocketRequest<{ type?: string }>(req, this.socketPath);
    if (res.error) {
      throw new Error(`HerdR workspace.close failed: ${res.error.message}`);
    }
  }
}
