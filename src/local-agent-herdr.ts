import { createConnection, type Socket } from "node:net";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, normalize } from "node:path";

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
  herdrServerIdentity: string;
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
  launchGeneration: number;
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
}

export interface HerdrPromptResult {
  status: "done" | "idle" | "blocked" | "OUTCOME_UNKNOWN";
  rawStatus?: string;
  paneOutput?: string;
  stalled?: boolean;
  timeout?: boolean;
}

export interface HerdrReconciliationResult {
  settled: boolean;
  completionStatus: "COMPLETED" | "NOT_COMPLETE" | "SCOPE_VIOLATION" | "OUTCOME_UNKNOWN";
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
  if (agentKind === "codex") {
    return (
      terminalText.includes("Welcome to Codex") ||
      terminalText.includes("Sign in with ChatGPT") ||
      terminalText.includes("Sign in with Device Code") ||
      terminalText.includes("Provide your own API key") ||
      terminalText.includes("Do you trust the authors")
    );
  }
  if (agentKind === "cline") {
    return terminalText.includes("authkit.cline.bot") || terminalText.includes("Enter this code in your browser");
  }
  if (agentKind === "agy") {
    return (
      terminalText.includes("Do you trust the contents of this project?") &&
      !terminalText.includes("Antigravity CLI 1.2.8")
    );
  }
  return false;
}

/**
 * In-memory registry of active handles to enforce attemptKey deduplication (N1)
 * and conflicting replay prevention (N2).
 */
export class HerdrGatewayRegistry {
  private handlesByAttemptKey = new Map<string, HerdrExternalHandle>();

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

  releaseHandle(attemptKey: string): void {
    this.handlesByAttemptKey.delete(attemptKey);
  }

  clear(): void {
    this.handlesByAttemptKey.clear();
  }
}

export const defaultHerdrGatewayRegistry = new HerdrGatewayRegistry();

export class HerdrThinGateway {
  constructor(
    private readonly socketPath: string = HERDR_DEFAULT_SOCKET_PATH,
    private readonly registry: HerdrGatewayRegistry = defaultHerdrGatewayRegistry,
  ) {}

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

    // Get current git HEAD in worktree
    let gitHeadBefore = "";
    try {
      gitHeadBefore = execFileSync("git", ["-C", canonicalPath, "rev-parse", "HEAD"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      gitHeadBefore = "UNKNOWN";
    }

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
    const agentName = `ds-${params.attemptKey}`;
    const args: string[] = [];
    if (params.agentKind === "opencode") {
      const model = params.requestedModel || "opencode/mimo-v2.6-flash-free";
      args.push("-m", model);
    }

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

    // Auto-confirm initial workspace trust prompt for agy if needed
    let terminalOutput = await this.readPane(paneId);
    if (params.agentKind === "agy" && terminalOutput.includes("Do you trust the contents of this project?")) {
      await this.sendPaneKeys(paneId, ["enter"]);
      // Wait for agy to settle into interactive prompt
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await sendHerdrSocketRequest(
        {
          id: `agy-settle-${Date.now()}`,
          method: "agent.wait",
          params: {
            target: agentName,
            until: ["idle"],
            timeout_ms: 5000,
          },
        },
        this.socketPath,
      ).catch(() => {});
      terminalOutput = await this.readPane(paneId);
    }

    // Read terminal visible output to fail closed against onboarding dialogs
    if (detectBlockedOnboardingDialog(params.agentKind, terminalOutput)) {
      await this.closeWorkspace(wsId).catch(() => {});
      throw new Error(
        `[Fail-Closed] Agent '${params.agentKind}' is stuck at an unauthenticated onboarding/login dialog`,
      );
    }

    const promptNonce = `HERDR-DISPATCH-${params.attemptKey}-${Date.now()}`;
    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      herdrServerIdentity: `herdr@0.9.1:unix:${this.socketPath}`,
      herdrWorkspaceId: wsId,
      herdrPaneId: paneId,
      herdrAgentIdentity: agentName,
      herdrAgentKind: params.agentKind,
      requestedModel: params.requestedModel,
      requestedEffort: params.requestedEffort,
      effectiveModel: params.requestedModel || (params.agentKind === "opencode" ? "opencode/mimo-v2.6-flash-free" : "gemini-3.8-flash-high"),
      launchGeneration: 1,
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
   * Submit a prompt to an agent.
   * Enforces N3: timeout or stalled prompt maps to OUTCOME_UNKNOWN; zero duplicate panes.
   */
  async promptExternalAgent(
    handle: HerdrExternalHandle,
    promptText: string,
    options: HerdrPromptOptions = {},
  ): Promise<HerdrPromptResult> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const waitOptions: Record<string, unknown> = {
      timeout_ms: timeoutMs,
    };
    if (options.until && options.until.length > 0) {
      waitOptions.until = options.until;
    }

    const req: HerdrSocketRequest = {
      id: `prompt-${Date.now()}`,
      method: "agent.prompt",
      params: {
        target: handle.herdrAgentIdentity,
        text: promptText,
        wait: waitOptions,
      },
    };

    try {
      const res = await sendHerdrSocketRequest<{
        agent: { agent_status: string; interactive_ready: boolean };
      }>(req, this.socketPath, timeoutMs + 5000);

      if (res.error) {
        // N3: timeout or stalled prompt maps strictly to OUTCOME_UNKNOWN
        if (res.error.code === "timeout" || res.error.code === "agent_prompt_stalled") {
          return {
            status: "OUTCOME_UNKNOWN",
            rawStatus: res.error.code,
            timeout: res.error.code === "timeout",
            stalled: res.error.code === "agent_prompt_stalled",
          };
        }
        throw new Error(`HerdR prompt error: ${res.error.message}`);
      }

      const statusStr = res.result?.agent?.agent_status;
      const normalizedStatus: "done" | "idle" | "blocked" | "OUTCOME_UNKNOWN" =
        statusStr === "done" ? "done" : statusStr === "idle" ? "idle" : statusStr === "blocked" ? "blocked" : "OUTCOME_UNKNOWN";

      const paneOutput = await this.readPane(handle.herdrPaneId);
      return {
        status: normalizedStatus,
        rawStatus: statusStr,
        paneOutput,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timed out")) {
        return {
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
   * Enforces N5 (worker false success), N6 (unexpected path), N7 (runtime loss), N8 (enforcement truth).
   */
  async reconcileExternalAgent(
    handle: HerdrExternalHandle,
    expectedScope?: string[],
    expectMutation: boolean = true,
  ): Promise<HerdrReconciliationResult> {
    const worktree = handle.canonicalWorktreePath;

    // N7: Check if HerdR server is reachable
    let serverRunning = false;
    try {
      const ping = await sendHerdrSocketRequest<{ type: string }>({ id: "ping", method: "ping", params: {} }, this.socketPath, 2000);
      serverRunning = ping.result?.type === "pong";
    } catch {
      serverRunning = false;
    }

    if (!serverRunning) {
      return {
        settled: false,
        completionStatus: "OUTCOME_UNKNOWN",
        changedPaths: [],
        unexpectedPaths: [],
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
        reason: "HerdR server is unreachable (UNRECOVERABLE_PROCESS_UPON_HEADLESS_RESTART).",
      };
    }

    // Inspect physical repository state
    let porcelainStatus = "";
    try {
      porcelainStatus = execFileSync("git", ["-C", worktree, "status", "--porcelain"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch (e) {
      return {
        settled: false,
        completionStatus: "OUTCOME_UNKNOWN",
        changedPaths: [],
        unexpectedPaths: [],
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
        reason: `Failed to inspect git status in worktree: ${String(e)}`,
      };
    }

    const changedPaths = porcelainStatus
      ? porcelainStatus
          .split("\n")
          .map((line) => line.slice(3).trim())
          .filter(Boolean)
      : [];

    let gitHeadAfter: string | undefined;
    try {
      gitHeadAfter = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {}

    // N5: Worker false success -> If mutation was expected but changedPaths is empty, NOT_COMPLETE
    if (expectMutation && changedPaths.length === 0) {
      return {
        settled: true,
        completionStatus: "NOT_COMPLETE",
        changedPaths: [],
        unexpectedPaths: [],
        gitHeadAfter,
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
        reason: "Worker settled but no physical file modifications were observed.",
      };
    }

    // N6: Unexpected path check -> If any changed path is outside expectedScope
    const unexpectedPaths: string[] = [];
    if (expectedScope && expectedScope.length > 0) {
      for (const p of changedPaths) {
        if (!expectedScope.includes(p)) {
          unexpectedPaths.push(p);
        }
      }
      if (unexpectedPaths.length > 0) {
        return {
          settled: true,
          completionStatus: "SCOPE_VIOLATION",
          changedPaths,
          unexpectedPaths,
          gitHeadAfter,
          enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
          reason: `Physical changes touched paths outside authorized scope: ${unexpectedPaths.join(", ")}`,
        };
      }
    }

    return {
      settled: true,
      completionStatus: "COMPLETED",
      changedPaths,
      unexpectedPaths: [],
      gitHeadAfter,
      // N8: Never claim physically enforced
      enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
    };
  }

  /**
   * Stop an external agent and close its HerdR workspace.
   */
  async stopExternalAgent(handle: HerdrExternalHandle): Promise<void> {
    this.registry.releaseHandle(handle.attemptKey);
    await this.closeWorkspace(handle.herdrWorkspaceId);
  }

  /**
   * Close a HerdR workspace.
   */
  async closeWorkspace(workspaceId: string): Promise<void> {
    const req: HerdrSocketRequest = {
      id: `ws-close-${Date.now()}`,
      method: "workspace.close",
      params: {
        workspace_id: workspaceId,
      },
    };
    await sendHerdrSocketRequest(req, this.socketPath).catch(() => {});
  }
}
