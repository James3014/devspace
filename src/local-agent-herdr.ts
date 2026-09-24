import { createConnection, type Socket } from "node:net";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { createHash } from "node:crypto";
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

export interface HerdrPaneInfo {
  pane_id: string;
  workspace_id: string;
  cwd?: string | null;
  foreground_cwd?: string | null;
  agent?: string | null;
  agent_status?: string | null;
  label?: string | null;
  title?: string | null;
}

export interface HerdrAgentInfo {
  name?: string | null;
  agent?: string | null;
  workspace_id?: string;
  pane_id?: string;
  cwd?: string | null;
  foreground_cwd?: string | null;
  agent_status: string;
  interactive_ready: boolean;
}

export interface LiveHandleIdentityExpectations {
  herdrWorkspaceId: string;
  herdrPaneId: string;
  canonicalWorktreePath: string;
  herdrAgentIdentity: string;
  herdrAgentKind?: HerdrAgentKind;
  herdrSocketPath?: string;
}

export function normalizeHerdrSocketPath(socketPath: string): string {
  return canonicalizePath(socketPath);
}

export interface LiveHandleObservationResult {
  valid: boolean;
  reason?: string;
  pane?: HerdrPaneInfo;
  agent?: HerdrAgentInfo;
}

export function buildDeterministicHerdrAgentName(attemptKey: string, dispatchIntentHash?: string): string {
  const sanitized = attemptKey.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  const prefix = ("ds-" + sanitized).slice(0, 23);
  const hashInput = `${attemptKey}:${dispatchIntentHash ?? ""}`;
  const suffix = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);
  return `${prefix}-${suffix}`;
}

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

export interface NormalizedHerdrHandleAuthority {
  schemaVersion: number;
  runtimeKind: string;
  agentId: string;
  herdrSocketPath: string;
  herdrServerIdentity: string | null;
  herdrWorkspaceId: string;
  herdrPaneId: string;
  herdrAgentIdentity: string;
  herdrAgentKind: string;
  requestedProvider: string | null;
  requestedModel: string | null;
  requestedEffort: string | null;
  effectiveProvider: string | null;
  effectiveModel: string | null;
  effectiveEffort: string | null;
  nativeProviderSessionId: string | null;
  launchGeneration: number | null;
  promptNonce: string;
  canonicalWorktreePath: string;
  workspaceId: string;
  gitHeadBefore: string;
  attemptKey: string;
  dispatchIntentHash: string;
  launchTimestamp: string;
  enforcementState: string;
}

export function normalizeHerdrHandleAuthority(handle: HerdrExternalHandle): NormalizedHerdrHandleAuthority {
  return {
    schemaVersion: handle.schemaVersion,
    runtimeKind: handle.runtimeKind,
    agentId: handle.agentId ?? "",
    herdrSocketPath: normalizeHerdrSocketPath(handle.herdrSocketPath),
    herdrServerIdentity: handle.herdrServerIdentity ?? null,
    herdrWorkspaceId: handle.herdrWorkspaceId,
    herdrPaneId: handle.herdrPaneId,
    herdrAgentIdentity: handle.herdrAgentIdentity,
    herdrAgentKind: handle.herdrAgentKind,
    requestedProvider: handle.requestedProvider ?? null,
    requestedModel: handle.requestedModel ?? null,
    requestedEffort: handle.requestedEffort ?? null,
    effectiveProvider: handle.effectiveProvider ?? null,
    effectiveModel: handle.effectiveModel ?? null,
    effectiveEffort: handle.effectiveEffort ?? null,
    nativeProviderSessionId: handle.nativeProviderSessionId ?? null,
    launchGeneration: handle.launchGeneration ?? null,
    promptNonce: handle.promptNonce,
    canonicalWorktreePath: canonicalizePath(handle.canonicalWorktreePath),
    workspaceId: handle.workspaceId,
    gitHeadBefore: handle.gitHeadBefore,
    attemptKey: handle.attemptKey,
    dispatchIntentHash: handle.dispatchIntentHash,
    launchTimestamp: handle.launchTimestamp,
    enforcementState: handle.enforcementState,
  };
}

export function assertExactDurableHerdrHandle(
  callerHandle: HerdrExternalHandle,
  durableHandle: HerdrExternalHandle,
  context: string = "operation",
): void {
  const callerNorm = normalizeHerdrHandleAuthority(callerHandle);
  const durableNorm = normalizeHerdrHandleAuthority(durableHandle);

  const mismatchedFields: string[] = [];
  for (const key of Object.keys(durableNorm) as Array<keyof NormalizedHerdrHandleAuthority>) {
    if (callerNorm[key] !== durableNorm[key]) {
      mismatchedFields.push(
        `${key} (caller '${callerNorm[key]}' != durable '${durableNorm[key]}')`,
      );
    }
  }

  if (mismatchedFields.length > 0) {
    throw new Error(
      `[FAIL_CLOSED / DURABLE_HANDLE_AUTHORITY_MISMATCH] Caller-supplied handle does not match exact durable authority in LocalAgentStore for ${context}: ${mismatchedFields.join(", ")}. Zero external effects permitted.`,
    );
  }
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
    terminalText.includes("Requesting permission") ||
    terminalText.includes("Run this command?") ||
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
  async listWorkspaces(socketPath?: string): Promise<Array<{ workspace_id: string; label?: string }>> {
    const req: HerdrSocketRequest = {
      id: `ws-list-${Date.now()}`,
      method: "workspace.list",
      params: {},
    };
    try {
      const res = await this.sendRequest<{
        type: string;
        workspaces?: Array<{ workspace_id: string; label?: string }>;
      }>(req, 3000, socketPath);
      return res.result?.workspaces || [];
    } catch {
      return [];
    }
  }

  /**
   * Show a workspace directly over socket.
   */
  async getWorkspace(workspaceId: string, socketPath?: string): Promise<{ workspace_id: string; label?: string } | undefined> {
    const req: HerdrSocketRequest = {
      id: `ws-get-${Date.now()}`,
      method: "workspace.get",
      params: { target: workspaceId },
    };
    try {
      const res = await this.sendRequest<{
        workspace?: { workspace_id: string; label?: string };
      }>(req, 3000, socketPath);
      return res.result?.workspace;
    } catch {
      return undefined;
    }
  }

  /**
   * List panes directly over socket, optionally filtered by workspace_id.
   */
  async listPanes(workspaceId?: string, socketPath?: string): Promise<HerdrPaneInfo[]> {
    const req: HerdrSocketRequest = {
      id: `pane-list-${Date.now()}`,
      method: "pane.list",
      params: workspaceId ? { workspace_id: workspaceId } : {},
    };
    try {
      const res = await this.sendRequest<{
        type: string;
        panes?: HerdrPaneInfo[];
      }>(req, 3000, socketPath);
      return res.result?.panes || [];
    } catch {
      return [];
    }
  }

  /**
   * Show a pane directly over socket.
   */
  async getPane(paneId: string, socketPath?: string): Promise<HerdrPaneInfo | undefined> {
    const req: HerdrSocketRequest = {
      id: `pane-get-${Date.now()}`,
      method: "pane.get",
      params: { pane_id: paneId },
    };
    try {
      const res = await this.sendRequest<{
        type: string;
        pane?: HerdrPaneInfo;
      }>(req, 3000, socketPath);
      return res.result?.pane;
    } catch {
      return undefined;
    }
  }

  /**
   * Query HerdR agent status directly over socket.
   */
  async getAgent(agentName: string, socketPath?: string): Promise<HerdrAgentInfo | undefined> {
    const req: HerdrSocketRequest = {
      id: `agent-get-${Date.now()}`,
      method: "agent.get",
      params: { target: agentName },
    };
    try {
      const res = await this.sendRequest<{
        type: string;
        agent?: HerdrAgentInfo;
      }>(req, 3000, socketPath);
      return res.result?.agent;
    } catch {
      return undefined;
    }
  }

  /**
   * Validate physical AgentInfo object against expected launch/target identity (E1, F4, Comment 5785928588).
   * Missing required fields (workspace_id, pane_id, name, cwd) or any contradiction fails closed.
   */
  validateAgentInfoIdentity(
    agent: HerdrAgentInfo | undefined,
    expectations: LiveHandleIdentityExpectations,
    context: string = "agent",
  ): { valid: boolean; reason?: string } {
    if (!agent || typeof agent !== "object") {
      return { valid: false, reason: `Missing or invalid AgentInfo object in ${context}` };
    }
    if (!agent.workspace_id || agent.workspace_id !== expectations.herdrWorkspaceId) {
      return {
        valid: false,
        reason: `${context} workspace_id '${agent.workspace_id}' does not match expected '${expectations.herdrWorkspaceId}'`,
      };
    }
    if (!agent.pane_id || agent.pane_id !== expectations.herdrPaneId) {
      return {
        valid: false,
        reason: `${context} pane_id '${agent.pane_id}' does not match expected '${expectations.herdrPaneId}'`,
      };
    }
    if (!agent.name || agent.name !== expectations.herdrAgentIdentity) {
      return {
        valid: false,
        reason: `${context} name '${agent.name}' does not match expected '${expectations.herdrAgentIdentity}'`,
      };
    }
    const aCwd = agent.cwd ? canonicalizePath(agent.cwd) : undefined;
    const aFgCwd = agent.foreground_cwd ? canonicalizePath(agent.foreground_cwd) : undefined;
    if (!aCwd && !aFgCwd) {
      return {
        valid: false,
        reason: `${context} has no cwd or foreground_cwd`,
      };
    }
    if (aCwd !== expectations.canonicalWorktreePath && aFgCwd !== expectations.canonicalWorktreePath) {
      return {
        valid: false,
        reason: `${context} cwd '${aCwd || aFgCwd}' does not match canonical worktree '${expectations.canonicalWorktreePath}'`,
      };
    }
    if (expectations.herdrAgentKind && agent.agent && agent.agent !== expectations.herdrAgentKind) {
      return {
        valid: false,
        reason: `${context} kind '${agent.agent}' does not match expected '${expectations.herdrAgentKind}'`,
      };
    }
    return { valid: true };
  }

  /**
   * Validate physical agent.start response (AgentInfo) against expected launch identity (E1).
   * Wrong workspace, pane, cwd, or name fails closed.
   */
  validateAgentStartResponse(
    agent: HerdrAgentInfo | undefined,
    expectations: LiveHandleIdentityExpectations,
  ): { valid: boolean; reason?: string } {
    return this.validateAgentInfoIdentity(agent, expectations, "agent.start response");
  }

  /**
   * Central shared validator for positive current live process continuity (E1, E2, E3, E4, E5).
   * Validates from supported HerdR protocol 22 fields:
   * - exact workspace id;
   * - exact pane id;
   * - pane cwd or foreground_cwd == canonical worktree;
   * - exact current agent belongs to that workspace and pane;
   * - agent cwd or foreground_cwd == canonical worktree;
   * - observed named agent identity matches the deterministic/bound identity under actual HerdR field semantics.
   */
  async observeAndValidateLiveHandle(
    expectations: LiveHandleIdentityExpectations,
  ): Promise<LiveHandleObservationResult> {
    const pane = await this.getPane(expectations.herdrPaneId, expectations.herdrSocketPath);
    if (!pane) {
      return { valid: false, reason: `Pane '${expectations.herdrPaneId}' not found in HerdR` };
    }
    if (pane.workspace_id !== expectations.herdrWorkspaceId) {
      return {
        valid: false,
        reason: `Pane '${expectations.herdrPaneId}' workspace_id '${pane.workspace_id}' does not match expected '${expectations.herdrWorkspaceId}'`,
        pane,
      };
    }
    const pCwd = pane.cwd ? canonicalizePath(pane.cwd) : undefined;
    const pFgCwd = pane.foreground_cwd ? canonicalizePath(pane.foreground_cwd) : undefined;
    if (!pCwd && !pFgCwd) {
      return {
        valid: false,
        reason: `Pane '${expectations.herdrPaneId}' has no cwd or foreground_cwd`,
        pane,
      };
    }
    if (pCwd !== expectations.canonicalWorktreePath && pFgCwd !== expectations.canonicalWorktreePath) {
      return {
        valid: false,
        reason: `Pane '${expectations.herdrPaneId}' cwd '${pCwd || pFgCwd}' does not match canonical worktree '${expectations.canonicalWorktreePath}'`,
        pane,
      };
    }

    const agent = await this.getAgent(expectations.herdrAgentIdentity, expectations.herdrSocketPath);
    if (!agent) {
      return {
        valid: false,
        reason: `Agent '${expectations.herdrAgentIdentity}' not found in HerdR`,
        pane,
      };
    }
    if (!agent.workspace_id || agent.workspace_id !== expectations.herdrWorkspaceId) {
      return {
        valid: false,
        reason: `Agent '${expectations.herdrAgentIdentity}' workspace_id '${agent.workspace_id}' does not match expected '${expectations.herdrWorkspaceId}'`,
        pane,
        agent,
      };
    }
    if (!agent.pane_id || agent.pane_id !== expectations.herdrPaneId) {
      return {
        valid: false,
        reason: `Agent '${expectations.herdrAgentIdentity}' pane_id '${agent.pane_id}' does not match expected '${expectations.herdrPaneId}'`,
        pane,
        agent,
      };
    }
    const aCwd = agent.cwd ? canonicalizePath(agent.cwd) : undefined;
    const aFgCwd = agent.foreground_cwd ? canonicalizePath(agent.foreground_cwd) : undefined;
    if (!aCwd && !aFgCwd) {
      return {
        valid: false,
        reason: `Agent '${expectations.herdrAgentIdentity}' has no cwd or foreground_cwd`,
        pane,
        agent,
      };
    }
    if (aCwd !== expectations.canonicalWorktreePath && aFgCwd !== expectations.canonicalWorktreePath) {
      return {
        valid: false,
        reason: `Agent '${expectations.herdrAgentIdentity}' cwd '${aCwd || aFgCwd}' does not match canonical worktree '${expectations.canonicalWorktreePath}'`,
        pane,
        agent,
      };
    }
    if (!agent.name || agent.name !== expectations.herdrAgentIdentity) {
      return {
        valid: false,
        reason: `Agent '${expectations.herdrAgentIdentity}' observed name '${agent.name}' does not match expected identity '${expectations.herdrAgentIdentity}'`,
        pane,
        agent,
      };
    }
    if (expectations.herdrAgentKind && agent.agent && agent.agent !== expectations.herdrAgentKind) {
      return {
        valid: false,
        reason: `Agent '${expectations.herdrAgentIdentity}' kind '${agent.agent}' does not match expected '${expectations.herdrAgentKind}'`,
        pane,
        agent,
      };
    }

    return { valid: true, pane, agent };
  }

  private async reconcileFencedLaunch(
    params: StartHerdrAgentParams,
    record: LocalAgentRecord,
    launch: ExternalRuntimeLaunchFence,
    canonicalPath: string,
    gitHeadBefore: string,
    store: LocalAgentStore,
  ): Promise<HerdrExternalHandle | undefined> {
    if (!launch.herdrSocketPath) {
      throw new Error(
        `[OUTCOME_UNKNOWN] Stored launch fence for attemptKey '${params.attemptKey}' lacks durable herdrSocketPath endpoint; cannot infer gateway default. Zero external calls permitted.`,
      );
    }
    const targetSocket = normalizeHerdrSocketPath(launch.herdrSocketPath);

    const wsLabel = `devspace-${params.attemptKey}`;
    const agentName =
      launch.herdrAgentIdentity ||
      launch.plannedAgentName ||
      buildDeterministicHerdrAgentName(params.attemptKey, params.dispatchIntentHash);

    let wsId = launch.herdrWorkspaceId;
    let paneId = launch.herdrPaneId;
    let observedCwd = launch.observedCwd;

    // 1. If workspace not observed, query HerdR to see if workspace was created
    if (!wsId) {
      const workspaces = await this.listWorkspaces(targetSocket);
      const match = workspaces.find((w) => w.label === wsLabel);
      if (!match || !match.workspace_id) {
        return undefined;
      }
      wsId = match.workspace_id;

      // Find panes restricted to this workspace (Section 10, 11, 14)
      const panes = await this.listPanes(wsId, targetSocket);
      const candidatePanes = panes.filter((p) => {
        if (p.workspace_id !== wsId) return false;
        const pCwd = p.cwd ? canonicalizePath(p.cwd) : undefined;
        const pFgCwd = p.foreground_cwd ? canonicalizePath(p.foreground_cwd) : undefined;
        return pCwd === canonicalPath || pFgCwd === canonicalPath;
      });

      // Require unique safe match with physical cwd proof (REC-WORKSPACE-WRONG-CWD, REC-WORKSPACE-CWD-MISSING, REC-WORKSPACE-MULTIPLE-PANES, REC-PANE-NO-FABRICATION)
      if (candidatePanes.length !== 1) {
        return undefined;
      }

      const safePane = candidatePanes[0];
      if (!safePane.pane_id) {
        return undefined;
      }
      paneId = safePane.pane_id;
      observedCwd = safePane.cwd
        ? canonicalizePath(safePane.cwd)
        : (safePane.foreground_cwd ? canonicalizePath(safePane.foreground_cwd) : undefined);

      if (!observedCwd || observedCwd !== canonicalPath) {
        return undefined;
      }

      const wsPersistRes = store.recordExternalRuntimeWorkspaceObservedCAS({
        agentId: record.id,
        attemptKey: params.attemptKey,
        herdrWorkspaceId: wsId,
        herdrPaneId: paneId,
        observedCwd,
      });

      // D2 / Section 21: Failed workspace persistence must STOP immediately
      if (!wsPersistRes.applied) {
        return undefined;
      }
    } else if (!paneId) {
      // Workspace ID is already known, but paneId is missing
      const panes = await this.listPanes(wsId, targetSocket);
      const candidatePanes = panes.filter((p) => {
        if (p.workspace_id !== wsId) return false;
        const pCwd = p.cwd ? canonicalizePath(p.cwd) : undefined;
        const pFgCwd = p.foreground_cwd ? canonicalizePath(p.foreground_cwd) : undefined;
        return pCwd === canonicalPath || pFgCwd === canonicalPath;
      });

      if (candidatePanes.length !== 1 || !candidatePanes[0].pane_id) {
        return undefined;
      }

      paneId = candidatePanes[0].pane_id;
      observedCwd = candidatePanes[0].cwd
        ? canonicalizePath(candidatePanes[0].cwd)
        : (candidatePanes[0].foreground_cwd ? canonicalizePath(candidatePanes[0].foreground_cwd) : undefined);

      if (!observedCwd || observedCwd !== canonicalPath) {
        return undefined;
      }

      const wsPersistRes = store.recordExternalRuntimeWorkspaceObservedCAS({
        agentId: record.id,
        attemptKey: params.attemptKey,
        herdrWorkspaceId: wsId,
        herdrPaneId: paneId,
        observedCwd,
      });

      if (!wsPersistRes.applied) {
        return undefined;
      }
    } else {
      // Both wsId and paneId already known, verify physical pane exists and cwd matches
      const paneInfo = await this.getPane(paneId, targetSocket);
      if (!paneInfo) {
        return undefined;
      }
      const pCwd = paneInfo.cwd ? canonicalizePath(paneInfo.cwd) : undefined;
      const pFgCwd = paneInfo.foreground_cwd ? canonicalizePath(paneInfo.foreground_cwd) : undefined;
      if (paneInfo.workspace_id !== wsId || (pCwd !== canonicalPath && pFgCwd !== canonicalPath)) {
        return undefined;
      }
    }

    // 2. Workspace is known and physically verified; check agent (Section 16, 17, 32, E2, F4)
    let agentIdentity = launch.herdrAgentIdentity;
    if (!agentIdentity) {
      const agentInfo = await this.getAgent(agentName, targetSocket);
      if (!agentInfo) {
        return undefined;
      }

      // F4: Strict identity verification - required fields must be present and match
      const agentVal = this.validateAgentInfoIdentity(agentInfo, {
        herdrWorkspaceId: wsId,
        herdrPaneId: paneId,
        canonicalWorktreePath: canonicalPath,
        herdrAgentIdentity: agentName,
        herdrAgentKind: params.agentKind,
        herdrSocketPath: targetSocket,
      }, "reconcileFencedLaunch");
      if (!agentVal.valid) {
        return undefined;
      }

      agentIdentity = agentInfo.name!;
      const agentPersistRes = store.recordExternalRuntimeAgentObservedCAS({
        agentId: record.id,
        attemptKey: params.attemptKey,
        herdrAgentIdentity: agentIdentity,
      });

      // D2 / Section 22: Failed agent persistence must STOP immediately
      if (!agentPersistRes.applied) {
        return undefined;
      }
    } else {
      // E2 / F4: Even if launch.herdrAgentIdentity already exists, current agent must be positively re-observed!
      const agentInfo = await this.getAgent(agentIdentity, targetSocket);
      if (!agentInfo) {
        return undefined;
      }
      const agentVal = this.validateAgentInfoIdentity(agentInfo, {
        herdrWorkspaceId: wsId,
        herdrPaneId: paneId,
        canonicalWorktreePath: canonicalPath,
        herdrAgentIdentity: agentIdentity,
        herdrAgentKind: params.agentKind,
        herdrSocketPath: targetSocket,
      }, "reconcileFencedLaunch");
      if (!agentVal.valid) {
        return undefined;
      }
    }

    // 3. Both are positively observed! Build and bind completed handle
    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      agentId: record.id,
      herdrSocketPath: targetSocket,
      herdrWorkspaceId: wsId,
      herdrPaneId: paneId,
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

    const bindRes = store.bindExternalRuntimeBindingCAS({
      agentId: record.id,
      expectedAttemptKey: params.attemptKey,
      expectedDispatchIntentHash: params.dispatchIntentHash,
      binding: {
        runtimeKind: HERDR_RUNTIME_KIND,
        launch: {
          ...launch,
          state: "AGENT_OBSERVED",
          herdrSocketPath: targetSocket,
          herdrWorkspaceId: wsId,
          herdrPaneId: paneId,
          herdrAgentIdentity: agentIdentity,
          plannedAgentName: agentName,
          observedCwd,
          updatedAt: new Date().toISOString(),
        },
        handle: handle as unknown as Record<string, unknown>,
      },
    });

    // D2 / Section 23: Final bind failure must NOT register in registry and must NOT return handle
    if (!bindRes.applied) {
      throw new Error(
        `[OUTCOME_UNKNOWN] Reconciled external runtime state, but failed to bind external runtime handle in store (CAS failed). Refusing to return or register handle.`,
      );
    }

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
    if (!effectiveStore || !params.agentId) {
      throw new Error(
        `[LAUNCH_NO_DURABLE_STORE] startExternalAgent requires a durable LocalAgentStore and agentId; in-memory-only execution is forbidden.`,
      );
    }

    const herdrSocketPath = normalizeHerdrSocketPath(params.socketPath || this.socketPath);
    let herdrServerIdentity: string | undefined = undefined;

    const record = effectiveStore.getById(params.agentId);
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
      if (normalizeHerdrSocketPath(existing.herdrSocketPath) !== herdrSocketPath) {
        throw new Error(
          `[ATTEMPT_REPLAY_CONFLICT] Replay socketPath '${herdrSocketPath}' does not match durable handle socketPath '${existing.herdrSocketPath}'`,
        );
      }
      if (existing.workspaceId !== params.workspaceId) {
        throw new Error(
          `[ATTEMPT_REPLAY_CONFLICT] Replay workspaceId '${params.workspaceId}' does not match durable handle workspaceId '${existing.workspaceId}'`,
        );
      }
      if ((existing.requestedModel ?? undefined) !== (params.requestedModel ?? undefined)) {
        throw new Error(
          `[ATTEMPT_REPLAY_CONFLICT] Replay requestedModel '${params.requestedModel}' does not match durable handle requestedModel '${existing.requestedModel}'`,
        );
      }
      if ((existing.requestedEffort ?? undefined) !== (params.requestedEffort ?? undefined)) {
        throw new Error(
          `[ATTEMPT_REPLAY_CONFLICT] Replay requestedEffort '${params.requestedEffort}' does not match durable handle requestedEffort '${existing.requestedEffort}'`,
        );
      }

      // E2: Stale durable IDs are not proof of current live process continuity.
      // Returning a usable live handle from replay requires current positive re-observation.
      const liveCheck = await this.observeAndValidateLiveHandle({
        herdrWorkspaceId: existing.herdrWorkspaceId,
        herdrPaneId: existing.herdrPaneId,
        canonicalWorktreePath: canonicalPath,
        herdrAgentIdentity: existing.herdrAgentIdentity,
        herdrAgentKind: existing.herdrAgentKind,
        herdrSocketPath: existing.herdrSocketPath,
      });

      if (!liveCheck.valid) {
        throw new Error(
          `[OUTCOME_UNKNOWN] Existing durable handle live process continuity could not be verified in HerdR (${liveCheck.reason}). Refusing to return or register stale handle.`,
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
      if (!launch.herdrSocketPath) {
        throw new Error(
          `[OUTCOME_UNKNOWN] Stored launch fence for attemptKey '${params.attemptKey}' lacks durable herdrSocketPath endpoint; cannot infer gateway default. Zero external calls permitted.`,
        );
      }
      if (normalizeHerdrSocketPath(launch.herdrSocketPath) !== herdrSocketPath) {
        throw new Error(
          `[ATTEMPT_REPLAY_CONFLICT] Replay socketPath '${herdrSocketPath}' does not match launch fence socketPath '${launch.herdrSocketPath}'`,
        );
      }
      if (launch.workspaceId && launch.workspaceId !== params.workspaceId) {
        throw new Error(
          `[ATTEMPT_REPLAY_CONFLICT] Replay workspaceId '${params.workspaceId}' does not match launch fence workspaceId '${launch.workspaceId}'`,
        );
      }
      if ((launch.requestedModel ?? undefined) !== (params.requestedModel ?? undefined)) {
        throw new Error(
          `[ATTEMPT_REPLAY_CONFLICT] Replay requestedModel '${params.requestedModel}' does not match launch fence requestedModel '${launch.requestedModel}'`,
        );
      }
      if ((launch.requestedEffort ?? undefined) !== (params.requestedEffort ?? undefined)) {
        throw new Error(
          `[ATTEMPT_REPLAY_CONFLICT] Replay requestedEffort '${params.requestedEffort}' does not match launch fence requestedEffort '${launch.requestedEffort}'`,
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

    const promptNonce = `HERDR-DISPATCH-${params.attemptKey}`;
    const wsLabel = `devspace-${params.attemptKey}`;
    const agentName = buildDeterministicHerdrAgentName(params.attemptKey, params.dispatchIntentHash);

    // Pre-effect launch fence (Blocker C2, G2)
    const fenceRes = effectiveStore.fenceExternalRuntimeLaunchCAS({
      agentId: params.agentId,
      attemptKey: params.attemptKey,
      dispatchIntentHash: params.dispatchIntentHash,
      canonicalWorktreePath: canonicalPath,
      gitHeadBefore,
      agentKind: params.agentKind,
      herdrSocketPath,
      requestedModel: params.requestedModel,
      requestedEffort: params.requestedEffort,
      promptNonce,
      workspaceId: params.workspaceId,
      plannedAgentName: agentName,
      expectedUpdatedAt: record.updatedAt,
    });

    if (!fenceRes.applied) {
      throw new Error(
        `[LAUNCH_FENCE_FAILED] Failed to durably fence HerdR launch for attemptKey '${params.attemptKey}'; CAS failed. Zero external calls permitted.`,
      );
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
      await this.closeWorkspace(wsId, herdrSocketPath).catch(() => {});
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
      agent: HerdrAgentInfo;
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
      await this.closeWorkspace(wsId, herdrSocketPath).catch(() => {});
      if (effectiveStore && params.agentId) {
        effectiveStore.markExternalRuntimeLaunchOutcomeUnknownCAS({
          agentId: params.agentId,
          attemptKey: params.attemptKey,
          reason: `agent.start failed: ${agentRes.error?.message}`,
        });
      }
      throw new Error(`HerdR agent.start failed: ${agentRes.error?.message || "unknown error"}`);
    }

    // E1: Validate physical agent.start response (AgentInfo)
    const startVal = this.validateAgentStartResponse(agentRes.result.agent, {
      herdrWorkspaceId: wsId,
      herdrPaneId: paneId,
      canonicalWorktreePath: canonicalPath,
      herdrAgentIdentity: agentName,
      herdrAgentKind: params.agentKind,
    });

    if (!startVal.valid) {
      await this.closeWorkspace(wsId, herdrSocketPath).catch(() => {});
      if (effectiveStore && params.agentId) {
        effectiveStore.markExternalRuntimeLaunchOutcomeUnknownCAS({
          agentId: params.agentId,
          attemptKey: params.attemptKey,
          reason: `agent.start response validation failed: ${startVal.reason}`,
        });
      }
      throw new Error(`[FAIL_CLOSED / E1] agent.start response identity mismatch: ${startVal.reason}`);
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
    let terminalOutput = await this.readPane(paneId, 60, herdrSocketPath);
    if (!terminalOutput.trim()) {
      await new Promise((r) => setTimeout(r, 1500));
      terminalOutput = await this.readPane(paneId, 60, herdrSocketPath);
    }
    if (detectBlockedOnboardingDialog(params.agentKind, terminalOutput)) {
      await this.closeWorkspace(wsId, herdrSocketPath).catch(() => {});
      throw new Error(
        `[Fail-Closed / N-TRUST] Agent '${params.agentKind}' is stuck at an unauthenticated onboarding/trust/permission dialog: BLOCKED_ON_PERMISSION_ADMISSION`,
      );
    }

    // F6 / Supplement Comment 5786070980: Re-observe current live identity immediately before final handle binding
    const finalLiveObs = await this.observeAndValidateLiveHandle({
      herdrWorkspaceId: wsId,
      herdrPaneId: paneId,
      canonicalWorktreePath: canonicalPath,
      herdrAgentIdentity: agentName,
      herdrAgentKind: params.agentKind,
      herdrSocketPath,
    });

    if (!finalLiveObs.valid) {
      if (effectiveStore && params.agentId) {
        effectiveStore.markExternalRuntimeLaunchOutcomeUnknownCAS({
          agentId: params.agentId,
          attemptKey: params.attemptKey,
          reason: `Post-wait live identity lost before final binding: ${finalLiveObs.reason}`,
        });
      }
      throw new Error(
        `[OUTCOME_UNKNOWN] Current live process identity was lost after wait and before final handle binding: ${finalLiveObs.reason}. Zero final handle bindings permitted.`,
      );
    }

    const handle: HerdrExternalHandle = {
      schemaVersion: 1,
      runtimeKind: HERDR_RUNTIME_KIND,
      agentId: params.agentId,
      herdrSocketPath,
      ...(herdrServerIdentity !== undefined ? { herdrServerIdentity } : {}),
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
            herdrSocketPath,
            ...(params.requestedModel ? { requestedModel: params.requestedModel } : {}),
            ...(params.requestedEffort ? { requestedEffort: params.requestedEffort } : {}),
            promptNonce,
            ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
            herdrWorkspaceId: wsId,
            herdrPaneId: paneId,
            herdrAgentIdentity: agentName,
            plannedAgentName: agentName,
            observedCwd,
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
   * Submit a prompt to an agent.
   * Enforces N3: timeout or stalled prompt maps to OUTCOME_UNKNOWN; zero duplicate panes.
   * Enforces Option A (B4): one consequential prompt per attempt; rejects subsequent prompts.
   * Embeds durable handle.promptNonce into prompt.
   * Enforces exact prompt fence CAS tuple (C1).
   * Enforces live identity validation before fence, after fence, and on response (E3).
   */
  async promptExternalAgent(
    handle: HerdrExternalHandle,
    promptText: string,
    options: HerdrPromptOptions = {},
  ): Promise<HerdrPromptResult> {
    const effectiveStore = options.store ?? this.store;
    if (!effectiveStore) {
      throw new Error(
        `[PROMPT_NO_DURABLE_STORE] promptExternalAgent requires a durable LocalAgentStore; in-memory-only execution is forbidden.`,
      );
    }
    if (!handle.agentId) {
      throw new Error(
        `[PROMPT_MISSING_AGENT_ID] HerdrExternalHandle must contain exact agentId; fail closed.`,
      );
    }

    // 1. Durable Authority Gate (Blocker F1)
    const record = effectiveStore.getById(handle.agentId);
    if (!record) {
      throw new Error(`[UNKNOWN_AGENT] Agent record '${handle.agentId}' not found in store.`);
    }
    const durableBinding = record.externalRuntimeBinding;
    if (!durableBinding?.handle || typeof durableBinding.handle !== "object") {
      throw new Error(
        `[FAIL_CLOSED / NO_DURABLE_HANDLE] Agent '${handle.agentId}' has no durable externalRuntimeBinding.handle in store; zero prompt calls permitted.`,
      );
    }
    assertExactDurableHerdrHandle(
      handle,
      durableBinding.handle as unknown as HerdrExternalHandle,
      "promptExternalAgent",
    );

    // Fast in-memory registry check (Option A / B4)
    if (this.registry.hasPromptSubmitted(handle.attemptKey)) {
      throw new Error(
        `[N-TURN-OPTION-A] attemptKey '${handle.attemptKey}' has already submitted a consequential prompt; subsequent prompts on same handle are rejected.`,
      );
    }

    const targetSocket = normalizeHerdrSocketPath(handle.herdrSocketPath);

    // Pre-fence live identity validation (E3)
    const preFenceLive = await this.observeAndValidateLiveHandle({
      herdrWorkspaceId: handle.herdrWorkspaceId,
      herdrPaneId: handle.herdrPaneId,
      canonicalWorktreePath: canonicalizePath(handle.canonicalWorktreePath),
      herdrAgentIdentity: handle.herdrAgentIdentity,
      herdrAgentKind: handle.herdrAgentKind,
      herdrSocketPath: targetSocket,
    });
    if (!preFenceLive.valid) {
      throw new Error(
        `[FAIL_CLOSED / E3] Cannot prompt external agent: live identity validation failed before prompt fence (${preFenceLive.reason}). Zero prompt calls permitted.`,
      );
    }
    if (
      preFenceLive.agent &&
      (preFenceLive.agent.agent_status === "running" ||
        preFenceLive.agent.agent_status === "prompting" ||
        !preFenceLive.agent.interactive_ready)
    ) {
      throw new Error(
        `[N-TURN] Agent '${handle.herdrAgentIdentity}' is already busy in status '${preFenceLive.agent.agent_status}'; cannot submit new turn.`,
      );
    }

    // Exact durable check and CAS fence in store BEFORE any external socket effect (Blocker A & C1)
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

    // Mark prompt as submitted under Option A
    this.registry.markPromptSubmitted(handle.attemptKey);

    // Post-fence live identity revalidation immediately before actual prompt (E3)
    const postFenceLive = await this.observeAndValidateLiveHandle({
      herdrWorkspaceId: handle.herdrWorkspaceId,
      herdrPaneId: handle.herdrPaneId,
      canonicalWorktreePath: canonicalizePath(handle.canonicalWorktreePath),
      herdrAgentIdentity: handle.herdrAgentIdentity,
      herdrAgentKind: handle.herdrAgentKind,
      herdrSocketPath: targetSocket,
    });
    if (!postFenceLive.valid) {
      throw new Error(
        `[FAIL_CLOSED / E3] Agent live identity lost or mismatched after prompt fence (${postFenceLive.reason}). Fence preserved, zero agent.prompt calls permitted.`,
      );
    }
    if (
      postFenceLive.agent &&
      (postFenceLive.agent.agent_status === "running" ||
        postFenceLive.agent.agent_status === "prompting" ||
        !postFenceLive.agent.interactive_ready)
    ) {
      throw new Error(
        `[N-TURN] Agent '${handle.herdrAgentIdentity}' is already busy in status '${postFenceLive.agent.agent_status}'; cannot submit new turn.`,
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
        agent?: HerdrAgentInfo;
      }>(req, timeoutMs + 5000, targetSocket);

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

      // E3 / Comment 5785928588: Validate returned AgentInfo from agent.prompt response
      const resAgent = res.result?.agent;
      const resAgentVal = this.validateAgentInfoIdentity(resAgent, {
        herdrWorkspaceId: handle.herdrWorkspaceId,
        herdrPaneId: handle.herdrPaneId,
        canonicalWorktreePath: canonicalizePath(handle.canonicalWorktreePath),
        herdrAgentIdentity: handle.herdrAgentIdentity,
        herdrAgentKind: handle.herdrAgentKind,
        herdrSocketPath: targetSocket,
      }, "agent.prompt response");

      if (!resAgentVal.valid) {
        return {
          turnNonce,
          status: "OUTCOME_UNKNOWN",
          rawStatus: "PROMPT_RESPONSE_IDENTITY_INCOMPLETE_OR_MISMATCH",
        };
      }

      const statusStr = resAgent?.agent_status;
      const paneOutput = await this.readPane(handle.herdrPaneId, 60, targetSocket);

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
      // The durable prompt fence has already been committed and agent.prompt may have
      // reached HerdR/provider. Any post-fence transport/observation failure is therefore
      // ambiguous external-world truth, not proof that the effect was absent.
      const msg = err instanceof Error ? err.message : String(err);
      const errorCode =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as NodeJS.ErrnoException).code ?? "")
          : "";
      return {
        turnNonce,
        status: "OUTCOME_UNKNOWN",
        rawStatus: errorCode || "PROMPT_POST_FENCE_ERROR",
        timeout: msg.includes("timed out") || errorCode === "ETIMEDOUT",
      };
    }
  }

  /**
   * Read pane output.
   */
  async readPane(paneId: string, lines: number = 60, socketPath?: string): Promise<string> {
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
      }>(req, 10_000, socketPath);
      if (res.result?.read?.text !== undefined) {
        return res.result.read.text;
      }
      if (socketPath) {
        throw new Error(
          `[EXPLICIT_SOCKET_READBACK_FAILURE] Socket pane.read on explicit socket '${socketPath}' returned no text (error: ${res.error?.message ?? "empty result"}). CLI fallback forbidden.`,
        );
      }
    } catch (err) {
      if (socketPath) {
        if (err instanceof Error && err.message.startsWith("[EXPLICIT_SOCKET_READBACK_FAILURE]")) {
          throw err;
        }
        throw new Error(
          `[EXPLICIT_SOCKET_READBACK_FAILURE] Socket pane.read on explicit socket '${socketPath}' failed: ${String(err)}. CLI fallback forbidden.`,
        );
      }
    }
    // Fallback to CLI read if socket read helper differs (only diagnostic callers without explicit socketPath)
    return execFileSync("herdr", ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  }

  /**
   * Physical completion reconciliation.
   * Enforces N5 (worker false success), N5-COMMIT (committed change detection),
   * N6 (unexpected path), N6-COMMIT (unauthorized commit),
   * N7 (runtime loss), N7-PHYSICAL (physical evidence preserved during runtime loss),
   * N8 (enforcement truth).
   * Enforces positive live-agent identity check for terminal settlement (E4).
   */
  async reconcileExternalAgent(
    handle: HerdrExternalHandle,
    expectedScope?: string[],
    expectMutation: boolean = true,
    lastPromptResult?: HerdrPromptResult,
    options: { store?: LocalAgentStore } = {},
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

    // 2. Durable Authority Check (Blocker F2, Sections 16-18)
    const effectiveStore = options.store ?? this.store;
    let durableAuthorityValid = false;
    let authorityFailureReason: string | undefined;

    if (!effectiveStore) {
      authorityFailureReason = "No durable LocalAgentStore provided for reconciliation; execution cannot be attributed.";
    } else if (!handle.agentId) {
      authorityFailureReason = "HerdrExternalHandle missing agentId; execution cannot be attributed.";
    } else {
      const record = effectiveStore.getById(handle.agentId);
      if (!record || !record.externalRuntimeBinding?.handle) {
        authorityFailureReason = `No durable externalRuntimeBinding in store for agentId '${handle.agentId}'; execution cannot be attributed.`;
      } else {
        try {
          assertExactDurableHerdrHandle(
            handle,
            record.externalRuntimeBinding.handle as unknown as HerdrExternalHandle,
            "reconcileExternalAgent",
          );
          durableAuthorityValid = true;
        } catch (err: unknown) {
          authorityFailureReason = err instanceof Error ? err.message : String(err);
        }
      }
    }

    if (!durableAuthorityValid) {
      return {
        settled: false,
        completionStatus: "OUTCOME_UNKNOWN",
        executionState: "OUTCOME_UNKNOWN",
        physicalEffect,
        changedPaths,
        unexpectedPaths: [],
        gitHeadAfter,
        enforcementState: "REQUEST_ONLY_NOT_ENFORCED",
        reason: `[DURABLE_AUTHORITY_MISSING] ${authorityFailureReason}`,
      };
    }

    // 3. Execution settlement inspection (A3: separate from physical effect)
    let executionState: HerdrExecutionState = "OUTCOME_UNKNOWN";

    if (lastPromptResult?.status === "OUTCOME_UNKNOWN") {
      executionState = "OUTCOME_UNKNOWN";
    } else if (lastPromptResult?.status === "blocked") {
      executionState = "BLOCKED";
    } else {
      const targetSocket = normalizeHerdrSocketPath(handle.herdrSocketPath);

      // Check HerdR server health and agent status
      let serverAlive = false;
      try {
        const ping = await this.sendRequest<{ type: string }>({ id: "ping", method: "ping", params: {} }, 2000, targetSocket);
        serverAlive = ping.result?.type === "pong";
      } catch {
        serverAlive = false;
      }

      if (!serverAlive) {
        executionState = "OUTCOME_UNKNOWN";
      } else {
        // E4: Require current positive live-agent observation with exact identity.
        // Vanished or mismatched live identity => OUTCOME_UNKNOWN, regardless of stale done/idle.
        const liveObs = await this.observeAndValidateLiveHandle({
          herdrWorkspaceId: handle.herdrWorkspaceId,
          herdrPaneId: handle.herdrPaneId,
          canonicalWorktreePath: canonicalizePath(handle.canonicalWorktreePath),
          herdrAgentIdentity: handle.herdrAgentIdentity,
          herdrAgentKind: handle.herdrAgentKind,
          herdrSocketPath: targetSocket,
        });

        if (!liveObs.valid || !liveObs.agent) {
          executionState = "OUTCOME_UNKNOWN";
        } else {
          const agentInfo = liveObs.agent;
          if (agentInfo.agent_status === "running" || agentInfo.agent_status === "prompting") {
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
        reason: "HerdR server is unreachable, live agent identity unverified, or prompt outcome is unknown (UNRECOVERABLE_PROCESS_UPON_HEADLESS_RESTART / timeout).",
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
   * Enforces E5: requires durable handle binding in LocalAgentStore and positive live identity
   * before workspace.close. Zero close calls if absent or mismatched.
   * Enforces A8: close workspace first; release registry binding only upon successful close.
   */
  async stopExternalAgent(handle: HerdrExternalHandle, options: { store?: LocalAgentStore } = {}): Promise<void> {
    const effectiveStore = options.store ?? this.store;
    if (!effectiveStore) {
      throw new Error(
        `[STOP_NO_DURABLE_STORE] stopExternalAgent requires a durable LocalAgentStore; zero workspace.close calls permitted.`,
      );
    }
    if (!handle.agentId) {
      throw new Error(
        `[STOP_MISSING_AGENT_ID] HerdrExternalHandle must contain exact agentId; zero workspace.close calls permitted.`,
      );
    }
    const record = effectiveStore.getById(handle.agentId);
    if (!record) {
      throw new Error(
        `[STOP_UNKNOWN_AGENT] Agent record '${handle.agentId}' not found in store; zero workspace.close calls permitted.`,
      );
    }
    const boundHandle = record.externalRuntimeBinding?.handle as HerdrExternalHandle | undefined;
    if (!boundHandle) {
      throw new Error(
        `[STOP_NO_BOUND_HANDLE] Agent '${handle.agentId}' has no bound externalRuntimeBinding.handle; zero workspace.close calls permitted.`,
      );
    }

    // 1. Exact Durable Authority Comparison (Blocker F3)
    assertExactDurableHerdrHandle(handle, boundHandle, "stopExternalAgent");

    const targetSocket = normalizeHerdrSocketPath(boundHandle.herdrSocketPath);

    // 2. Validate current live identity before closing workspace (E5)
    const liveObs = await this.observeAndValidateLiveHandle({
      herdrWorkspaceId: boundHandle.herdrWorkspaceId,
      herdrPaneId: boundHandle.herdrPaneId,
      canonicalWorktreePath: canonicalizePath(boundHandle.canonicalWorktreePath),
      herdrAgentIdentity: boundHandle.herdrAgentIdentity,
      herdrAgentKind: boundHandle.herdrAgentKind,
      herdrSocketPath: targetSocket,
    });

    if (!liveObs.valid) {
      throw new Error(
        `[STOP_LIVE_IDENTITY_MISMATCH] Current live process identity could not be verified in HerdR (${liveObs.reason}); zero workspace.close calls permitted.`,
      );
    }

    await this.closeWorkspace(boundHandle.herdrWorkspaceId, targetSocket);
    this.registry.releaseHandle(boundHandle.attemptKey);
  }

  /**
   * Close a HerdR workspace.
   * Internal helper; private to prevent consequential side-door bypass (E6).
   * Enforces A8: does not swallow close errors.
   */
  private async closeWorkspace(workspaceId: string, socketPath?: string): Promise<void> {
    const req: HerdrSocketRequest = {
      id: `ws-close-${Date.now()}`,
      method: "workspace.close",
      params: {
        workspace_id: workspaceId,
      },
    };
    const res = await this.sendRequest<{ type?: string }>(req, 10_000, socketPath);
    if (res.error) {
      throw new Error(`HerdR workspace.close failed: ${res.error.message}`);
    }
  }
}
