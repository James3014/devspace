import { mkdtempSync, unlinkSync, rmdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config.js";
import {
  createLocalAgentStore,
  LocalAgentStore,
  type LocalAgentRecord,
  type LocalAgentStatus,
} from "./local-agent-store.js";
import { loadLocalAgentProfiles, type LocalAgentProfile } from "./local-agent-profiles.js";
import {
  checkLocalAgentProviderAvailability,
} from "./local-agent-availability.js";
import { runLocalAgentProvider } from "./local-agent-adapters.js";
import type { LocalAgentRunResult } from "./local-agent-runtime.js";

// ─── Error codes ────────────────────────────────────────────────────────────

export type AgentErrorCode =
  | "UNKNOWN_WORKSPACE"
  | "UNKNOWN_PROFILE"
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN_AGENT"
  | "AGENT_WORKSPACE_MISMATCH"
  | "AGENT_ALREADY_RUNNING"
  | "INVALID_WAIT_MS"
  | "WORKER_LAUNCH_FAILED";

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
export type WorkerLauncher = (agentId: string, promptFile: string) => Promise<void>;

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

  constructor(
    private readonly config: ServerConfig,
    testLauncher?: WorkerLauncher,
  ) {
    this.store = createLocalAgentStore(config);
    this.launcher = testLauncher ?? defaultWorkerLauncher;
  }

  /**
   * Start a new agent session using an advertised profile.
   * Returns immediately; worker runs in background.
   * Fail-closed: if worker fails to launch, record is set to error status.
   */
  async startAgent(input: StartAgentInput): Promise<StartAgentOutput> {
    const { workspaceId, workspaceRoot, profileName, prompt, profiles } = input;

    const profile = profiles.find((p) => p.name === profileName);
    if (!profile) {
      const available = profiles.map((p) => p.name).join(", ");
      throw new AgentSessionError(
        "UNKNOWN_PROFILE",
        `Unknown agent profile: ${profileName}. Available: ${available || "none"}`,
      );
    }

    const availability = checkLocalAgentProviderAvailability(profile.provider);
    if (!availability.available) {
      throw new AgentSessionError(
        "PROVIDER_UNAVAILABLE",
        `Agent provider '${profile.provider}' is unavailable: ${availability.reason ?? "unknown reason"}`,
      );
    }

    const record = this.store.create({
      workspaceId,
      workspaceRoot,
      profileName: profile.name,
      provider: profile.provider,
      model: profile.model,
      thinking: profile.thinking,
    });

    const promptFile = writeAgentPromptFile(prompt);
    try {
      await this.launcher(record.id, promptFile);
    } catch (launchErr) {
      cleanupOwnedPromptFile(promptFile);
      this.store.update(record.id, {
        status: "error",
        error: `Worker launch failed: ${launchErr instanceof Error ? launchErr.message : String(launchErr)}`,
      });
      throw new AgentSessionError(
        "WORKER_LAUNCH_FAILED",
        `Failed to launch worker for agent ${record.id}: ${launchErr instanceof Error ? launchErr.message : String(launchErr)}`,
      );
    }

    return recordToStartOutput(record);
  }

  /**
   * Continue an existing agent session with a new prompt.
   * Provider session ID is preserved.
   * Fail-closed: if worker fails to launch, record is set to error status.
   */
  async continueAgent(input: ContinueAgentInput): Promise<ContinueAgentOutput> {
    const { workspaceId, workspaceRoot, agentId, prompt } = input;

    // Exact id lookup only (no prefix matching through MCP)
    const record = this.store.getById(agentId);
    if (!record) {
      throw new AgentSessionError("UNKNOWN_AGENT", `Unknown agent id: ${agentId}`);
    }

    if (record.workspaceRoot !== workspaceRoot) {
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
    this.store.update(record.id, {
      workspaceId,
      status: "starting",
      latestResponse: undefined,
      error: undefined,
    });

    const promptFile = writeAgentPromptFile(prompt);
    try {
      await this.launcher(record.id, promptFile);
    } catch (launchErr) {
      cleanupOwnedPromptFile(promptFile);
      this.store.update(record.id, {
        status: "error",
        error: `Worker launch failed: ${launchErr instanceof Error ? launchErr.message : String(launchErr)}`,
      });
      throw new AgentSessionError(
        "WORKER_LAUNCH_FAILED",
        `Failed to launch worker for agent ${record.id}: ${launchErr instanceof Error ? launchErr.message : String(launchErr)}`,
      );
    }

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

    if (record.workspaceRoot !== workspaceRoot) {
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

    return recordToStatusOutput(record);
  }

  /**
   * List agents scoped to a workspace, newest first.
   * workspaceRoot optionally narrows to a physical root.
   */
  listAgents(input: ListAgentsInput): AgentSummary[] {
    const { workspaceId, workspaceRoot, limit = AGENT_LIST_DEFAULT_LIMIT } = input;
    const effectiveLimit = Math.min(Math.max(1, limit), AGENT_LIST_MAX_LIMIT);

    const records = this.store.list({ workspaceId, workspaceRoot });
    return records.slice(0, effectiveLimit).map(recordToSummary);
  }

  /**
   * Run the worker turn for an agent, reading the prompt from a temp file.
   * Used by CLI __worker subcommand.
   * Cleans up the owned prompt temp file after execution (success or failure).
   */
  async runWorkerTurnFromFile(agentId: string, promptFile: string): Promise<void> {
    const record = this.store.getById(agentId);
    if (!record) throw new Error(`Unknown subagent id: ${agentId}`);

    const prompt = await readFile(promptFile, "utf8");

    this.store.update(record.id, { status: "running", error: undefined });
    try {
      const profiles = await loadLocalAgentProfiles(this.config, record.workspaceRoot);
      const profile = profiles.find((p) => p.name === record.profileName);
      let result: LocalAgentRunResult;
      if (profile) {
        result = await runLocalAgentProfile(profile, record, prompt);
      } else {
        result = await runRawLocalAgentProvider(record, prompt);
      }
      this.store.update(record.id, {
        providerSessionId: result.providerSessionId ?? undefined,
        status: "idle",
        latestResponse: result.finalResponse,
        error: undefined,
      });
    } catch (error) {
      this.store.update(record.id, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      cleanupOwnedPromptFile(promptFile);
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
  spawnWorker(agentId: string, promptFile: string): Promise<void> {
    return this.launcher(agentId, promptFile);
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

function defaultWorkerLauncher(agentId: string, promptFile: string): Promise<void> {
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

function recordToStatusOutput(record: LocalAgentRecord): AgentStatusOutput {
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
