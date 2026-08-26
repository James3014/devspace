import { randomUUID } from "node:crypto";
import { constants as fsConstants, access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  HeadTailBuffer,
  type ProcessSnapshot,
  type StartCommandInput,
  type WriteStdinInput,
} from "./process-sessions.js";
import {
  inspectWorkspacePhysicalState,
  isInsideGitRepository,
  readWorkspaceHead,
} from "./workspace-reconciliation.js";

const GOAL_MARKER_PATTERN = /pursuing\s+goal/i;
const TRUST_DIALOG_PATTERN = /trust\s+the\s+contents/i;
const TUI_MODEL_READY_PATTERN = /model:\s+(?!loading\b)\S+/i;
const TUI_DIRECTORY_READY_PATTERN = /directory:\s+(?!loading\b)\S+/i;
const EXPECTED_HEAD_PATTERN = /^[0-9a-fA-F]{40}$/;
const MACOS_CODEX_FALLBACK = "/Applications/ChatGPT.app/Contents/Resources/codex";
const MAX_GOAL_CHARACTERS = 20_000;
const MAX_MESSAGE_CHARACTERS = 20_000;
const RECENT_OUTPUT_LIMIT = 100_000;
const STATUS_OUTPUT_CHARACTER_LIMIT = 10_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_ACTIVATION_POLL_MS = 250;
const DEFAULT_TYPE_CHUNK_CHARACTERS = 24;
const DEFAULT_TYPE_CHUNK_DELAY_MS = 25;
const DEFAULT_CANCEL_TIMEOUT_MS = 5_000;

/**
 * Narrow process backend used by the goal session manager. Structurally
 * satisfied by ProcessSessionManager; kept as an interface so tests can stub
 * PTY availability deterministically.
 */
export interface GoalProcessBackend {
  start(input: StartCommandInput): Promise<ProcessSnapshot>;
  write(input: WriteStdinInput): Promise<ProcessSnapshot>;
  terminate(workspaceId: string, sessionId: number): void;
}

export interface CodexGoalStartInput {
  workspaceId: string;
  workspaceRoot: string;
  goal: string;
  model?: string;
  reasoningEffort?: string;
  expectedHead?: string;
}

export interface CodexGoalState {
  goalId: string;
  workspaceId: string;
  running: boolean;
  terminal: boolean;
  exitCode?: number;
  signal?: string;
  goalActiveObserved: boolean;
  wallTimeMs: number;
  outputChunk: string;
  outputTruncated: boolean;
  model?: string;
  reasoningEffort?: string;
  baseHead?: string;
  terminalReason?: string;
}

interface GoalSession {
  goalId: string;
  workspaceId: string;
  workspaceRoot: string;
  processSessionId: number;
  model?: string;
  reasoningEffort?: string;
  baseHead?: string;
  startedAt: number;
  goalActiveObserved: boolean;
  trustDialogObserved: boolean;
  modelReadyObserved: boolean;
  directoryReadyObserved: boolean;
  terminal: boolean;
  exitCode?: number;
  signal?: string;
  terminalReason?: string;
  recentOutput: HeadTailBuffer;
}

export interface CodexGoalSessionManagerOptions {
  codexBin?: string;
  startupTimeoutMs?: number;
  activationPollMs?: number;
  typeChunkCharacters?: number;
  typeChunkDelayMs?: number;
  cancelTimeoutMs?: number;
  resolveBinary?: (configuredBin?: string) => Promise<string>;
}

const TERMINAL_ESCAPE_PATTERN =
  /\x1B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

/** Normalize ANSI terminal escapes so markers can be matched reliably. */
export function normalizeTerminalText(value: string): string {
  return value.replace(TERMINAL_ESCAPE_PATTERN, "").replace(/\s+/g, " ");
}

function assertNonEmpty(value: string | undefined, name: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function collapseTypedWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

async function assertExecutableFile(path: string): Promise<void> {
  try {
    await access(path, fsConstants.X_OK);
  } catch {
    throw new Error(
      `Configured Codex CLI binary is not an executable file: ${path}. Check DEVSPACE_CODEX_BIN.`,
    );
  }
}

/**
 * Deterministic Codex CLI resolution:
 * 1. DEVSPACE_CODEX_BIN when explicitly configured (fail closed when invalid);
 * 2. an executable `codex` found on PATH;
 * 3. the macOS ChatGPT.app bundled CLI.
 */
export async function resolveCodexBinary(options: {
  configuredBin?: string;
  platform?: NodeJS.Platform;
  pathEnv?: string;
} = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const configured = assertNonEmpty(options.configuredBin, "DEVSPACE_CODEX_BIN");
  if (configured) {
    await assertExecutableFile(configured);
    return configured;
  }

  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  for (const directory of pathEnv.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "codex");
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  if (platform === "darwin") {
    try {
      await access(MACOS_CODEX_FALLBACK, fsConstants.X_OK);
      return MACOS_CODEX_FALLBACK;
    } catch {
      // fall through to the clear failure below
    }
  }

  throw new Error(
    "Codex CLI executable not found. Install the Codex CLI or configure DEVSPACE_CODEX_BIN.",
  );
}

function buildCodexArgs(input: {
  workspaceRoot: string;
  model?: string;
  reasoningEffort?: string;
}): string[] {
  const args: string[] = [];
  if (input.model) args.push("--model", input.model);
  if (input.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${input.reasoningEffort}"`);
  }
  args.push(
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    "--no-alt-screen",
    "--cd",
    input.workspaceRoot,
  );
  return args;
}

export class CodexGoalSessionManager {
  private readonly sessions = new Map<string, GoalSession>();
  private readonly startupTimeoutMs: number;
  private readonly activationPollMs: number;
  private readonly typeChunkCharacters: number;
  private readonly typeChunkDelayMs: number;
  private readonly cancelTimeoutMs: number;
  private readonly codexBin?: string;
  private readonly resolveBinaryImpl: (configuredBin?: string) => Promise<string>;

  constructor(
    private readonly processes: GoalProcessBackend,
    options: CodexGoalSessionManagerOptions = {},
  ) {
    if (
      options.startupTimeoutMs !== undefined &&
      (!Number.isInteger(options.startupTimeoutMs) || options.startupTimeoutMs < 1)
    ) {
      throw new Error("Startup timeout must be a positive integer.");
    }
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.activationPollMs = options.activationPollMs ?? DEFAULT_ACTIVATION_POLL_MS;
    this.typeChunkCharacters = options.typeChunkCharacters ?? DEFAULT_TYPE_CHUNK_CHARACTERS;
    this.typeChunkDelayMs = options.typeChunkDelayMs ?? DEFAULT_TYPE_CHUNK_DELAY_MS;
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    this.codexBin = options.codexBin;
    this.resolveBinaryImpl =
      options.resolveBinary ?? ((configuredBin?: string) => resolveCodexBinary({ configuredBin }));
  }

  listActiveGoalIds(): string[] {
    return [...this.sessions.values()]
      .filter((session) => !session.terminal)
      .map((session) => session.goalId);
  }

  async start(input: CodexGoalStartInput): Promise<CodexGoalState> {
    const goal = collapseTypedWhitespace(input.goal);
    if (!goal) throw new Error("Goal text must not be empty.");
    if (codePointLength(goal) > MAX_GOAL_CHARACTERS) {
      throw new Error(`Goal text exceeds the ${MAX_GOAL_CHARACTERS} character limit.`);
    }
    if (input.expectedHead && !EXPECTED_HEAD_PATTERN.test(input.expectedHead)) {
      throw new Error("expectedHead must be a valid 40-character commit SHA.");
    }

    const existingActive = [...this.sessions.values()].find(
      (session) => session.workspaceId === input.workspaceId && !session.terminal,
    );
    if (existingActive) {
      throw new Error(
        `Workspace already has an active Codex goal (${existingActive.goalId}). Cancel it before starting another.`,
      );
    }

    let baseHead: string | undefined;
    if (await isInsideGitRepository(input.workspaceRoot)) {
      if (!input.expectedHead) {
        throw new Error("expectedHead is required when starting a Codex goal in a Git workspace.");
      }
      baseHead = await readWorkspaceHead(input.workspaceRoot);
      if (!baseHead) {
        throw new Error("Workspace is a Git repository without a resolvable HEAD commit.");
      }
      if (input.expectedHead.toLowerCase() !== baseHead.toLowerCase()) {
        throw new Error(
          `expectedHead mismatch: workspace HEAD is ${baseHead}, expected ${input.expectedHead}.`,
        );
      }
      const physical = await inspectWorkspacePhysicalState(input.workspaceRoot);
      if (physical.dirty) {
        throw new Error(
          `Workspace must be clean before starting a Codex goal. Dirty paths: ${physical.changedPaths.slice(0, 10).join(", ")}`,
        );
      }
    } else if (input.expectedHead) {
      throw new Error(
        `expectedHead mismatch: workspace ${input.workspaceRoot} is not a Git repository.`,
      );
    }

    const binary = await this.resolveBinaryImpl(this.codexBin);

    const goalId = `goal_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const args = buildCodexArgs({
      workspaceRoot: input.workspaceRoot,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    });

    const snapshot = await this.processes.start({
      workspaceId: input.workspaceId,
      command: binary,
      cwd: input.workspaceRoot,
      workspaceRoot: input.workspaceRoot,
      tty: true,
      executable: binary,
      args,
      environmentPolicy: "sanitized",
      yieldTimeMs: this.activationPollMs,
    });

    if (!snapshot.running || snapshot.sessionId === undefined) {
      throw new Error(
        `Codex CLI exited before Goal Mode started (exitCode=${snapshot.exitCode ?? "unknown"}). Output: ${
          truncateForError(snapshot.output)
        }`,
      );
    }

    const session: GoalSession = {
      goalId,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      processSessionId: snapshot.sessionId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      baseHead,
      startedAt: Date.now(),
      goalActiveObserved: false,
      trustDialogObserved: false,
      modelReadyObserved: false,
      directoryReadyObserved: false,
      terminal: false,
      recentOutput: new HeadTailBuffer(RECENT_OUTPUT_LIMIT),
    };
    this.sessions.set(goalId, session);
    this.recordOutput(session, snapshot.output);

    try {
      await this.waitForTuiReady(session);
      await this.typeIntoSession(session, `/goal ${goal}`);
      await this.waitForGoalActivation(session);
    } catch (error) {
      await this.terminateSession(session, "activation_failed");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Codex Goal activation failed: ${message}`);
    }

    return this.stateFor(session, "");
  }

  async status(
    workspaceId: string,
    goalId: string,
    options: { waitMs?: number } = {},
  ): Promise<CodexGoalState> {
    const session = this.getOwnedSession(workspaceId, goalId);
    let outputChunk = "";
    if (!session.terminal) {
      const polled = await this.pollSession(session, options.waitMs ?? 0);
      outputChunk = polled;
    }
    return this.stateFor(session, outputChunk);
  }

  async continue(
    workspaceId: string,
    goalId: string,
    message: string,
  ): Promise<CodexGoalState> {
    const session = this.getOwnedSession(workspaceId, goalId);
    if (session.terminal) {
      throw new Error(`Codex goal ${goalId} is terminal and cannot accept continuation input.`);
    }
    if (!session.goalActiveObserved) {
      throw new Error(`Codex goal ${goalId} has not activated Goal Mode yet.`);
    }
    const collapsed = collapseTypedWhitespace(message);
    if (!collapsed) throw new Error("Continuation message must not be empty.");
    if (codePointLength(collapsed) > MAX_MESSAGE_CHARACTERS) {
      throw new Error(`Continuation message exceeds the ${MAX_MESSAGE_CHARACTERS} character limit.`);
    }

    await this.typeIntoSession(session, collapsed);
    const outputChunk = await this.pollSession(session, this.activationPollMs * 4);
    return this.stateFor(session, outputChunk);
  }

  async cancel(workspaceId: string, goalId: string): Promise<CodexGoalState> {
    const session = this.getOwnedSession(workspaceId, goalId);
    if (session.terminal) {
      const state = this.stateFor(session, "");
      return { ...state, terminalReason: session.terminalReason ?? "already_terminal" };
    }

    this.processes.terminate(session.workspaceId, session.processSessionId);
    const deadline = Date.now() + this.cancelTimeoutMs;
    while (Date.now() < deadline && !session.terminal) {
      await this.pollSession(session, Math.min(this.activationPollMs, deadline - Date.now()));
      if (!session.terminal) await this.pause();
    }
    if (session.terminal) {
      session.terminalReason = "cancelled";
    } else {
      session.terminal = true;
      session.terminalReason = "cancel_timeout";
    }
    return this.stateFor(session, "");
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      if (!session.terminal) {
        try {
          this.processes.terminate(session.workspaceId, session.processSessionId);
        } catch {
          // best-effort shutdown
        }
        session.terminal = true;
        session.terminalReason = "server_shutdown";
      }
    }
    this.sessions.clear();
  }

  private getOwnedSession(workspaceId: string, goalId: string): GoalSession {
    const session = this.sessions.get(goalId);
    if (!session) throw new Error(`Unknown Codex goal: ${goalId}`);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Codex goal ${goalId} does not belong to workspace ${workspaceId}.`);
    }
    return session;
  }

  /** Type text through the PTY in bounded chunks so the Codex TUI does not
   * interpret the whole payload as a single bracketed paste event. Ends with
   * an explicit carriage return to execute the line. */
  private async typeIntoSession(session: GoalSession, text: string): Promise<void> {
    const characters = Array.from(text);
    for (let index = 0; index < characters.length; index += this.typeChunkCharacters) {
      const chunk = characters.slice(index, index + this.typeChunkCharacters).join("");
      const snapshot = await this.processes.write({
        workspaceId: session.workspaceId,
        sessionId: session.processSessionId,
        chars: chunk,
        yieldTimeMs: this.typeChunkDelayMs,
      });
      this.absorbSnapshot(session, snapshot);
      if (!snapshot.running) {
        throw new Error(
          `Codex CLI exited while receiving input (exitCode=${snapshot.exitCode ?? "unknown"}).`,
        );
      }
    }
    const submit = await this.processes.write({
      workspaceId: session.workspaceId,
      sessionId: session.processSessionId,
      chars: "\r",
      yieldTimeMs: this.typeChunkDelayMs,
    });
    this.absorbSnapshot(session, submit);
    if (!submit.running) {
      throw new Error(
        `Codex CLI exited while submitting input (exitCode=${submit.exitCode ?? "unknown"}).`,
      );
    }
  }

  /** Wait until Codex has resolved both model and workspace identity. Startup
   * terminal output arrives before the persisted interactive thread is ready,
   * and sending `/goal` during that loading window is rejected by current CLI
   * versions as "The session must start before you can set a goal." */
  private async waitForTuiReady(session: GoalSession): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      await this.pollSession(session, this.activationPollMs);
      if (session.modelReadyObserved && session.directoryReadyObserved) {
        this.assertNoTrustDialog(session);
        return;
      }
      if (session.terminal) {
        throw new Error(
          `Codex CLI exited before the TUI became ready (exitCode=${session.exitCode ?? "unknown"}).`,
        );
      }
      await this.pause();
    }
    throw new Error(
      `Codex CLI TUI did not resolve model and directory within ${this.startupTimeoutMs}ms.`,
    );
  }

  private async waitForGoalActivation(session: GoalSession): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      await this.pollSession(session, this.activationPollMs);
      if (session.goalActiveObserved) return;
      this.assertNoTrustDialog(session);
      if (session.terminal) {
        throw new Error(
          `Codex CLI exited before Goal Mode was observed (exitCode=${session.exitCode ?? "unknown"}, signal=${session.signal ?? "none"}).`,
        );
      }
      await this.pause();
    }
    throw new Error(
      `Goal activation was not observed within ${this.startupTimeoutMs}ms. Expected a "Pursuing goal" indicator in the Codex TUI.`,
    );
  }

  /** Fail closed when Codex blocks on its directory-trust dialog instead of
   * answering it on the user's behalf. */
  private assertNoTrustDialog(session: GoalSession): void {
    if (!session.trustDialogObserved) return;
    throw new Error(
      "Codex is showing its directory-trust dialog for this workspace. Trust the directory once with the Codex CLI, then retry codex_goal_start.",
    );
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.activationPollMs));
  }

  /** Poll the existing process session without ever creating a replacement. */
  private async pollSession(session: GoalSession, waitMs: number): Promise<string> {
    let snapshot: ProcessSnapshot;
    try {
      snapshot = await this.processes.write({
        workspaceId: session.workspaceId,
        sessionId: session.processSessionId,
        chars: "",
        yieldTimeMs: Math.max(waitMs, 50),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Unknown process session/.test(message)) {
        if (!session.terminal) {
          session.terminal = true;
          session.terminalReason = "session_reaped";
        }
        return "";
      }
      throw error;
    }
    return this.absorbSnapshot(session, snapshot);
  }

  private absorbSnapshot(session: GoalSession, snapshot: ProcessSnapshot): string {
    this.recordOutput(session, snapshot.output);
    if (!snapshot.running && !session.terminal) {
      session.terminal = true;
      session.exitCode = snapshot.exitCode;
      session.signal = snapshot.signal;
      session.terminalReason = session.goalActiveObserved ? "exited" : "exited_before_activation";
    }
    return snapshot.output;
  }

  private recordOutput(session: GoalSession, output: string): void {
    if (!output) return;
    session.recentOutput.append(output);
    const normalized = normalizeTerminalText(output);
    if (!session.goalActiveObserved && GOAL_MARKER_PATTERN.test(normalized)) {
      session.goalActiveObserved = true;
    }
    if (!session.trustDialogObserved && TRUST_DIALOG_PATTERN.test(normalized)) {
      session.trustDialogObserved = true;
    }
    if (!session.modelReadyObserved && TUI_MODEL_READY_PATTERN.test(normalized)) {
      session.modelReadyObserved = true;
    }
    if (!session.directoryReadyObserved && TUI_DIRECTORY_READY_PATTERN.test(normalized)) {
      session.directoryReadyObserved = true;
    }
  }

  private async terminateSession(session: GoalSession, reason: string): Promise<void> {
    if (session.terminal) return;
    try {
      this.processes.terminate(session.workspaceId, session.processSessionId);
    } catch {
      // best-effort
    }
    const deadline = Date.now() + this.cancelTimeoutMs;
    while (Date.now() < deadline && !session.terminal) {
      await this.pollSession(session, Math.min(this.activationPollMs, deadline - Date.now()));
      if (!session.terminal) await this.pause();
    }
    session.terminal = true;
    session.terminalReason = reason;
  }

  private stateFor(session: GoalSession, outputChunk: string): CodexGoalState {
    const drained = session.recentOutput.drain(STATUS_OUTPUT_CHARACTER_LIMIT);
    const combined = [drained.output, outputChunk].filter(Boolean).join("");
    const wallTimeMs = Date.now() - session.startedAt;
    return {
      goalId: session.goalId,
      workspaceId: session.workspaceId,
      running: !session.terminal,
      terminal: session.terminal,
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      ...(session.signal ? { signal: session.signal } : {}),
      goalActiveObserved: session.goalActiveObserved,
      wallTimeMs,
      outputChunk: combined,
      outputTruncated: drained.truncated,
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(session.baseHead ? { baseHead: session.baseHead } : {}),
      ...(session.terminalReason ? { terminalReason: session.terminalReason } : {}),
    };
  }
}

function truncateForError(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 400 ? `${normalized.slice(0, 397)}...` : normalized || "(none)";
}
