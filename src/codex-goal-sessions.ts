import { randomUUID } from "node:crypto";
import { constants as fsConstants, access } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
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
const MAX_RAW_ESCAPE_CARRY_CHARACTERS = 8_192;

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
  terminal: boolean;
  exitCode?: number;
  signal?: string;
  terminalReason?: string;
  recentOutput: HeadTailBuffer;
  readiness?: DestructiveDeltaReadiness;
  readinessBlocked?: string;
  terminalQueryCarry: string;
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

// ─── Destructive delta readiness model ──────────────────────────────────────

type ReadinessBlock = "trust" | "error" | "truncation";

interface ReadinessSnapshot {
  screen: string;
  modelLine?: string;
  model?: string;
  directory?: string;
  loading?: boolean;
  block?: ReadinessBlock;
}

const LOADING_PATTERN = /\bloading\b/i;
const ERROR_PATTERN = /\b(?:error|failed|fatal)\b/i;
const PROMPT_FRAME_PATTERN = /^\s*(?:[>›]\s*)?Ask Codex to do anything\s*$/i;
const READINESS_SEMANTIC_DELTA_PATTERN = /(?:model|direc|ask\s+codex|loading|error|failed|fatal|trust\s+the\s+contents)/i;
const CLEAR_SCREEN_PATTERN = /\x1b(?:\[2J|\[3J|c)/;

const TERMINAL_QUERY_RESPONSES = [
  ["\x1b[6n", "\x1b[1;1R"],
  ["\x1b]10;?\x1b\\", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\"],
  ["\x1b]11;?\x1b\\", "\x1b]11;rgb:0000/0000/0000\x1b\\"],
  ["\x1b[?u", "\x1b[?0u"],
  ["\x1b[c", "\x1b[?1;2c"],
] as const;
const MAX_TERMINAL_QUERY_LENGTH = Math.max(
  ...TERMINAL_QUERY_RESPONSES.map(([query]) => query.length),
);

function terminalQueryReply(
  output: string,
  carry: string,
): { chars: string; carry: string } {
  const input = `${carry}${output}`;
  const matches: Array<{ index: number; chars: string }> = [];
  for (const [query, response] of TERMINAL_QUERY_RESPONSES) {
    let from = 0;
    while (from < input.length) {
      const index = input.indexOf(query, from);
      if (index < 0) break;
      matches.push({ index, chars: response });
      from = index + query.length;
    }
  }
  matches.sort((left, right) => left.index - right.index);

  let nextCarry = "";
  const maxSuffix = Math.min(input.length, MAX_TERMINAL_QUERY_LENGTH - 1);
  for (let length = maxSuffix; length > 0; length -= 1) {
    const suffix = input.slice(-length);
    if (
      TERMINAL_QUERY_RESPONSES.some(
        ([query]) => query.length > suffix.length && query.startsWith(suffix),
      )
    ) {
      nextCarry = suffix;
      break;
    }
  }

  return {
    chars: matches.map((match) => match.chars).join(""),
    carry: nextCarry,
  };
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\[\d+;1H/g, "\n")
    .replace(TERMINAL_ESCAPE_PATTERN, "");
}

function currentEpochAfterLastClear(value: string): { cleared: boolean; output: string } {
  const clearPattern = new RegExp(CLEAR_SCREEN_PATTERN.source, "g");
  let cleared = false;
  let suffixStart = 0;
  let match: RegExpExecArray | null;
  while ((match = clearPattern.exec(value)) !== null) {
    cleared = true;
    suffixStart = match.index + match[0].length;
  }
  return { cleared, output: cleared ? value.slice(suffixStart) : value };
}

function splitIncompleteTerminalEscape(value: string): { output: string; carry: string } {
  const escapeIndex = value.lastIndexOf("\x1b");
  if (escapeIndex < 0) return { output: value, carry: "" };

  const suffix = value.slice(escapeIndex);
  const completeClear = new RegExp(`^(?:${CLEAR_SCREEN_PATTERN.source})`).test(suffix);
  const completeEscape = new RegExp(`^(?:${TERMINAL_ESCAPE_PATTERN.source})`).test(suffix);
  if (completeClear || completeEscape) return { output: value, carry: "" };
  return { output: value.slice(0, escapeIndex), carry: suffix };
}

function sampleReadyScreen(value: string): string {
  return value.slice(-8_000);
}

function normalizeTuiRow(line: string): string {
  let normalized = line.trim();
  if (normalized.startsWith("│")) normalized = normalized.slice(1).trim();
  if (normalized.endsWith("│")) normalized = normalized.slice(0, -1).trim();
  return normalized;
}

function parseModelLine(line: string): string | undefined {
  const match = normalizeTuiRow(line).match(/^model:\s*(.+)$/);
  if (!match) return undefined;
  const name = match[1]!.replace(/\s+\/model\s+to\s+change\s*$/i, "").trim();
  return name || undefined;
}

function parseDirectoryLine(line: string): string | undefined {
  const match = normalizeTuiRow(line).match(/^directory:\s*(.+)$/);
  if (!match) return undefined;
  const directory = match[1]!.trim();
  return directory || undefined;
}

function scanScreen(screen: string): ReadinessSnapshot {
  const snapshot: ReadinessSnapshot = { screen };
  if (TRUST_DIALOG_PATTERN.test(screen)) {
    snapshot.block = "trust";
  } else if (ERROR_PATTERN.test(screen)) {
    snapshot.block = "error";
  } else if (LOADING_PATTERN.test(screen)) {
    snapshot.loading = true;
  }
  for (const line of screen.split(/\r?\n/)) {
    const model = parseModelLine(line);
    if (model !== undefined) {
      snapshot.modelLine = model;
      snapshot.model = model;
    }
    const directory = parseDirectoryLine(line);
    if (directory !== undefined) snapshot.directory = directory;
  }
  return snapshot;
}

function completeLines(value: string, carry: string): { lines: string[]; carry: string } {
  const combined = `${carry}${value}`;
  const parts = combined.split(/\r?\n/);
  const incomplete = parts.pop() ?? "";
  return { lines: parts, carry: incomplete };
}

function realpathEqual(left: string, right: string): boolean {
  const expandHome = (value: string): string =>
    value === "~"
      ? homedir()
      : value.startsWith("~/")
        ? join(homedir(), value.slice(2))
        : value;
  try {
    return realpathSync(expandHome(left)) === realpathSync(expandHome(right));
  } catch {
    return false;
  }
}

function modelMatches(observed: string, requested: string): boolean {
  return observed === requested || observed.startsWith(`${requested} `);
}

function readinessResolved(
  snapshot: ReadinessSnapshot,
  workspaceRoot: string,
  explicitModel?: string,
): boolean {
  if (snapshot.block) return false;
  if (snapshot.model === undefined || snapshot.directory === undefined) return false;
  if (explicitModel !== undefined && !modelMatches(snapshot.model, explicitModel)) return false;
  return realpathEqual(snapshot.directory, workspaceRoot);
}

const READINESS_REQUIRED_STABLE_POLLS = 3;

/**
 * ANSI-stripped, complete-line parser for a PTY's destructive screen deltas.
 * It keeps a bounded recent screen model plus resolved model/directory lines
 * and only reports coherency after the same full-ready frame has been observed
 * across three stable polls. Loading is a transient startup/repaint state that
 * invalidates the current readiness streak but keeps polling. Trust, error, or
 * truncation remain fatal blocks; model/directory mismatches also fail closed
 * with no /goal bytes.
 */
class DestructiveDeltaReadiness {
  private rawEscapeCarry = "";
  private carry = "";
  private lineBuffer: string[] = [];
  private screen = "";
  private observedModel?: string;
  private observedModelSequence?: number;
  private observedDirectory?: string;
  private observedDirectorySequence?: number;
  private explicitModel?: string;
  private workspaceRoot?: string;
  private block?: ReadinessBlock;
  private nonEmptySnapshots = 0;
  private readyStablePolls = 0;
  private lastReadySignature = "";
  private inputReadyObserved = false;
  private inputReadySequence?: number;
  private lineSequence = 0;
  private readonly explicitModelLocked?: string;
  private sawAnyDelta = false;

  absorb(snapshot: ProcessSnapshot, workspaceRoot: string, explicitModel?: string): void {
    this.workspaceRoot = workspaceRoot;
    if (explicitModel !== undefined) {
      this.explicitModel = explicitModel;
    }
    if (snapshot.outputTruncated) {
      this.block = "truncation";
      this.rawEscapeCarry = "";
      this.carry = "";
      this.screen = "";
      this.lineBuffer = [];
      this.readyStablePolls = 0;
      this.lastReadySignature = "";
      this.inputReadyObserved = false;
      return;
    }
    const hasNewRawOutput = snapshot.output.length > 0;
    if (hasNewRawOutput) {
      this.nonEmptySnapshots += 1;
      this.sawAnyDelta = true;
    }
    const raw = splitIncompleteTerminalEscape(`${this.rawEscapeCarry}${snapshot.output}`);
    this.rawEscapeCarry = raw.carry;
    if (this.rawEscapeCarry.length > MAX_RAW_ESCAPE_CARRY_CHARACTERS) {
      this.block = "truncation";
      this.rawEscapeCarry = "";
      this.carry = "";
      this.inputReadyObserved = false;
      this.inputReadySequence = undefined;
      this.readyStablePolls = 0;
      this.lastReadySignature = "";
      return;
    }
    const currentEpoch = currentEpochAfterLastClear(raw.output);
    if (currentEpoch.cleared) {
      this.carry = "";
      this.lineBuffer = [];
      this.screen = "";
      this.observedModel = undefined;
      this.observedModelSequence = undefined;
      this.observedDirectory = undefined;
      this.observedDirectorySequence = undefined;
      this.inputReadyObserved = false;
      this.inputReadySequence = undefined;
      this.lineSequence = 0;
      this.readyStablePolls = 0;
      this.lastReadySignature = "";
    }
    const output = stripAnsi(currentEpoch.output);
    if (!output) {
      if (hasNewRawOutput || this.rawEscapeCarry) {
        return;
      }
      // Neutral empty poll: keep the current coherent screen; it neither adds
      // history nor invalidates the current frame. A real ready frame that is
      // still the current screen stays eligible for a stable re-observation;
      // any different/invalidating frame resets the streak to zero.
      const resolved = this.validate();
      if (resolved && this.inputReadyObserved) {
        this.readyStablePolls += 1;
        this.lastReadySignature = resolved.signature;
      } else {
        this.readyStablePolls = 0;
      }
      return;
    }

    // Only readiness-semantic visible deltas revoke a previously coherent
    // prompt frame. Codex 0.149+ continuously repaints decorative title/MCP
    // startup spinners; treating every such byte as semantic drift creates a
    // timing-dependent false negative even when model/directory/prompt remain
    // unchanged. Identity/prompt/loading/error/trust deltas still revoke and
    // must establish a fresh coherent frame before /goal is typed.
    const semanticDelta = READINESS_SEMANTIC_DELTA_PATTERN.test(output);
    if (semanticDelta) {
      this.inputReadyObserved = false;
      this.inputReadySequence = undefined;
      this.readyStablePolls = 0;
      this.lastReadySignature = "";
    }
    const { lines, carry } = completeLines(output, this.carry);
    this.carry = carry;
    let framePromptSequence: number | undefined;
    for (const line of lines) {
      this.lineSequence += 1;
      const sequence = this.lineSequence;
      this.lineBuffer.push(line);
      const model = parseModelLine(line);
      if (model !== undefined) {
        this.observedModel = model;
        this.observedModelSequence = sequence;
      }
      const directory = parseDirectoryLine(line);
      if (directory !== undefined) {
        this.observedDirectory = directory;
        this.observedDirectorySequence = sequence;
      }
      if (PROMPT_FRAME_PATTERN.test(line)) {
        framePromptSequence = sequence;
      }
    }
    if (this.lineBuffer.length > 500) {
      this.lineBuffer = this.lineBuffer.slice(-500);
    }
    const coherent = this.lineBuffer.join("\n") + (this.carry ? `\n${this.carry}` : "");
    this.screen = sampleReadyScreen(coherent);

    const scanned = scanScreen(this.screen);
    if (scanned.block) {
      this.block = scanned.block;
      this.readyStablePolls = 0;
      this.lastReadySignature = "";
      this.inputReadyObserved = false;
      this.inputReadySequence = undefined;
      return;
    }
    if (LOADING_PATTERN.test(output)) {
      this.readyStablePolls = 0;
      this.lastReadySignature = "";
      this.inputReadyObserved = false;
      this.inputReadySequence = undefined;
      return;
    }
    if (this.resolveMismatch()) {
      this.block = "error";
      this.readyStablePolls = 0;
      this.lastReadySignature = "";
      this.inputReadyObserved = false;
      this.inputReadySequence = undefined;
      return;
    }

    const resolved = this.validate();
    if (
      resolved &&
      framePromptSequence !== undefined &&
      this.observedModelSequence !== undefined &&
      this.observedDirectorySequence !== undefined &&
      framePromptSequence > this.observedModelSequence &&
      framePromptSequence > this.observedDirectorySequence
    ) {
      this.inputReadyObserved = true;
      this.inputReadySequence = framePromptSequence;
      this.readyStablePolls = this.readyStablePolls + 1;
      this.lastReadySignature = resolved.signature;
    } else if (resolved && this.inputReadyObserved && !semanticDelta) {
      this.readyStablePolls += 1;
      this.lastReadySignature = resolved.signature;
    } else {
      this.readyStablePolls = 0;
      this.lastReadySignature = "";
    }
  }

  private resolveMismatch(): boolean {
    if (this.observedModel === undefined || this.explicitModel === undefined) return false;
    if (
      LOADING_PATTERN.test(this.observedModel) ||
      (this.observedDirectory !== undefined && LOADING_PATTERN.test(this.observedDirectory))
    ) {
      return false;
    }
    return !modelMatches(this.observedModel, this.explicitModel);
  }

  snapshot(): ReadinessSnapshot {
    const snapshot: ReadinessSnapshot = { screen: this.screen };
    if (this.observedModel) snapshot.model = this.observedModel;
    if (this.observedDirectory) snapshot.directory = this.observedDirectory;
    if (this.block) snapshot.block = this.block;
    return snapshot;
  }

  validate(): { model: string; directory: string; signature: string } | undefined {
    const snapshot = this.snapshot();
    if (snapshot.block) return undefined;
    if (!snapshot.model || !snapshot.directory) return undefined;
    if (
      this.explicitModel !== undefined &&
      !modelMatches(snapshot.model, this.explicitModel)
    ) {
      return undefined;
    }
    if (!this.workspaceRoot || !realpathEqual(snapshot.directory, this.workspaceRoot)) return undefined;
    return {
      model: snapshot.model,
      directory: snapshot.directory,
      signature: `${snapshot.model}\n${snapshot.directory}`,
    };
  }

  stableResolved(): boolean {
    return (
      this.inputReadyObserved &&
      this.inputReadySequence !== undefined &&
      this.observedModelSequence !== undefined &&
      this.observedDirectorySequence !== undefined &&
      this.inputReadySequence > this.observedModelSequence &&
      this.inputReadySequence > this.observedDirectorySequence &&
      this.validate() !== undefined &&
      this.readyStablePolls >= READINESS_REQUIRED_STABLE_POLLS
    );
  }

  debugStablePolls(): number {
    return this.readyStablePolls;
  }

  get blockReason(): ReadinessBlock | undefined {
    return this.block;
  }

  get snapshotCount(): number {
    return this.nonEmptySnapshots;
  }

  hasModelDirectoryEvidence(): boolean {
    return this.observedModel !== undefined || this.observedDirectory !== undefined;
  }

  sawCoherentDelta(): boolean {
    return (
      this.sawAnyDelta &&
      !this.block &&
      (this.observedModel !== undefined || this.observedDirectory !== undefined)
    );
  }

  mismatchReason(explicitModel?: string, workspaceRoot?: string): string | undefined {
    if (this.block === "truncation") return "terminal output was truncated by the runtime";
    if (this.block === "trust") return "Codex is showing its directory-trust dialog for this workspace. Trust the directory once with the Codex CLI, then retry codex_goal_start.";
    if (this.block === "error") return "the terminal resolved an error/failed state or a mismatched model/directory";
    const snapshot = this.snapshot();
    if (!snapshot.model || !snapshot.directory) return "Codex did not resolve model and directory before /goal";
    if (explicitModel !== undefined && !modelMatches(snapshot.model, explicitModel)) {
      return `Codex resolved model '${snapshot.model}' but ${explicitModel} was required`;
    }
    if (workspaceRoot !== undefined && !realpathEqual(snapshot.directory, workspaceRoot)) {
      return `Codex resolved directory '${snapshot.directory}' which is not the workspace root`;
    }
    return "Codex did not reach a stable coherent readiness state";
  }
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
  const args: string[] = ["-c", "check_for_update_on_startup=false"];
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
      terminal: false,
      recentOutput: new HeadTailBuffer(RECENT_OUTPUT_LIMIT),
      readiness: new DestructiveDeltaReadiness(),
      terminalQueryCarry: "",
    };
    this.sessions.set(goalId, session);
    this.absorbSnapshot(session, snapshot, input.workspaceRoot);
    await this.respondToTerminalQueries(session, snapshot.output, input.workspaceRoot);

    try {
      await this.waitForTuiReady(session);
      await this.typeIntoSession(session, `/goal ${goal}`, input.workspaceRoot);
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
  private async typeIntoSession(session: GoalSession, text: string, workspaceRoot?: string): Promise<void> {
    const characters = Array.from(text);
    if (workspaceRoot !== undefined && text.startsWith("/goal ")) {
      if (!session.readiness?.stableResolved()) {
        const blockReason = session.readiness?.blockReason;
        const reason =
          blockReason === "truncation"
            ? "terminal output was truncated by the runtime; readiness cannot be proven"
            : blockReason === "trust"
              ? "Codex is showing its directory-trust dialog for this workspace. Trust the directory once with the Codex CLI, then retry codex_goal_start."
              : blockReason === "error"
                ? "the terminal resolved an error/failed or mismatched state"
                : session.readiness?.mismatchReason(session.model, workspaceRoot) ??
                  "Codex did not resolve model and directory before /goal";
        if (process.env.NEXUS_GOAL_DEBUG === "1") {
          process.stderr.write(
            `NEXUS_GOAL_DEBUG gate screen=${JSON.stringify(session.readiness?.snapshot().screen)}\n` +
              `model=${JSON.stringify(session.readiness?.snapshot().model)} directory=${JSON.stringify(session.readiness?.snapshot().directory)} polls=${session.readiness?.debugStablePolls()}\n`,
          );
        }
        throw new Error(
          `Codex Goal activation failed: ${reason}. The terminal did not reach three stable coherent readiness polls.`,
        );
      }
    }
    for (let index = 0; index < characters.length; index += this.typeChunkCharacters) {
      const chunk = characters.slice(index, index + this.typeChunkCharacters).join("");
      const snapshot = await this.processes.write({
        workspaceId: session.workspaceId,
        sessionId: session.processSessionId,
        chars: chunk,
        yieldTimeMs: this.typeChunkDelayMs,
      });
      this.absorbSnapshot(session, snapshot, workspaceRoot);
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
    this.absorbSnapshot(session, submit, workspaceRoot);
    if (!submit.running) {
      throw new Error(
        `Codex CLI exited while submitting input (exitCode=${submit.exitCode ?? "unknown"}).`,
      );
    }
  }

  /** Wait until the Codex TUI has produced a stable coherent input-ready frame. */
  private async waitForTuiReady(session: GoalSession): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      await this.pollSession(session, this.activationPollMs);
      this.assertNoTrustDialog(session);
      if (
        !session.terminal &&
        !session.readiness?.blockReason &&
        session.readiness?.stableResolved()
      ) {
        return;
      }
      if (session.terminal) {
        throw new Error(
          `Codex CLI exited before the TUI became ready (exitCode=${session.exitCode ?? "unknown"}).`,
        );
      }
      if (session.readiness?.blockReason) {
        throw new Error(
          `Codex CLI readiness blocked (${session.readiness.blockReason}). ${session.readiness.blockReason === "truncation" ? "The runtime truncated the terminal buffer so a coherent readiness frame cannot be proven." : "The terminal resolved a non-coherent state before /goal."}`,
        );
      }
      await this.pause();
    }
    throw new Error(`Codex CLI TUI produced no output within ${this.startupTimeoutMs}ms.`);
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
    const output = this.absorbSnapshot(session, snapshot, session.workspaceRoot);
    const responseOutput = await this.respondToTerminalQueries(
      session,
      snapshot.output,
      session.workspaceRoot,
    );
    return `${output}${responseOutput}`;
  }

  private async respondToTerminalQueries(
    session: GoalSession,
    output: string,
    workspaceRoot: string,
  ): Promise<string> {
    let pendingOutput = output;
    let combinedOutput = "";
    for (let round = 0; round < 4; round += 1) {
      const reply = terminalQueryReply(pendingOutput, session.terminalQueryCarry);
      session.terminalQueryCarry = reply.carry;
      if (!reply.chars || session.terminal) break;
      const snapshot = await this.processes.write({
        workspaceId: session.workspaceId,
        sessionId: session.processSessionId,
        chars: reply.chars,
        yieldTimeMs: this.activationPollMs,
      });
      combinedOutput += this.absorbSnapshot(session, snapshot, workspaceRoot);
      if (!snapshot.running) break;
      pendingOutput = snapshot.output;
    }
    return combinedOutput;
  }

  private absorbSnapshot(
    session: GoalSession,
    snapshot: ProcessSnapshot,
    workspaceRoot?: string,
  ): string {
    this.recordOutput(session, snapshot.output);
    if (workspaceRoot !== undefined && session.readiness) {
      session.readiness.absorb(snapshot, workspaceRoot, session.model);
      if (session.readiness.blockReason === "truncation") {
        session.readinessBlocked = "truncation";
      }
    }
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
    if (!session.goalActiveObserved && GOAL_MARKER_PATTERN.test(normalizeTerminalText(output))) {
      session.goalActiveObserved = true;
    }
    if (!session.trustDialogObserved && TRUST_DIALOG_PATTERN.test(normalizeTerminalText(output))) {
      session.trustDialogObserved = true;
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
