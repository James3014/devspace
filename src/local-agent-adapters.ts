import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import { resolveAgyExecutable } from "./local-agent-availability.js";
import {
  createCodexSdkLocalAgentRuntime,
  LocalAgentProviderError,
  type LocalAgentDriver,
  type LocalAgentRunCallbacks,
  type LocalAgentRunInput,
  type LocalAgentRunResult,
} from "./local-agent-runtime.js";
import { runOmpAcpLocalAgent } from "./local-agent-omp.js";
import { inspectCodexRuntime } from "./codex-runtime.js";
import { inspectScratchOwnership } from "./provider-scratch.js";
import {
  AcpLocalAgentDriver,
  resolveAcpCommand,
  resolveAcpModelConfigUpdate,
  resolveAcpEffortConfigUpdate,
} from "./local-agent-acp.js";
import {
  ClaudeLocalAgentDriver,
  claudeCommandEnvironment,
  type ClaudeQueryFactory,
} from "./local-agent-claude.js";
import { CodexLocalAgentDriver as CodexDriverForDaemonStack } from "./local-agent-codex.js";
import {
  OpencodeLocalAgentDriver,
  extractOpenCodeFinalResponse,
  type OpencodeFactory,
} from "./local-agent-opencode.js";
import {
  PiLocalAgentDriver,
  extractPiFinalResponse,
  extractPiProviderError,
  type PiSessionFactory,
} from "./local-agent-pi.js";

export interface LocalAgentAdapter {
  readonly provider: LocalAgentProvider;
  runtimeKey(): string;
  run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks): Promise<LocalAgentRunResult>;
}

export interface LocalAgentDriverOptions {
  env?: NodeJS.ProcessEnv;
  claudeQueryFactory?: ClaudeQueryFactory;
  opencodeFactory?: OpencodeFactory;
  piSessionFactory?: PiSessionFactory;
}

const AGY_PRINT_TIMEOUT_SECONDS = 600;
const AGY_AGENT_TIMEOUT_MS = 610_000;
const AGY_OUTPUT_DRAIN_TIMEOUT_MS = 1_000;

function inputEnvironment(input: LocalAgentRunInput): NodeJS.ProcessEnv {
  return input.environment ?? process.env;
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export async function runLocalAgentProvider(
  provider: LocalAgentProvider,
  input: LocalAgentRunInput,
  callbacks?: LocalAgentRunCallbacks,
): Promise<LocalAgentRunResult> {
  return createLocalAgentAdapter(provider).run(input, callbacks);
}

export function createLocalAgentAdapter(
  provider: LocalAgentProvider,
  options: LocalAgentDriverOptions = {},
): LocalAgentAdapter {
  switch (provider) {
    case "codex":
      return new CodexLocalAgentAdapter();
    case "claude":
      return new DriverBackedLocalAgentAdapter(
        new ClaudeLocalAgentDriver(options.claudeQueryFactory, options.env),
      );
    case "opencode":
      return new DriverBackedLocalAgentAdapter(new OpencodeLocalAgentDriver(options.opencodeFactory, options.env));
    case "pi":
      return new DriverBackedLocalAgentAdapter(new PiLocalAgentDriver(options.piSessionFactory));
    case "cursor":
    case "copilot":
    case "grok":
      return new DriverBackedLocalAgentAdapter(new AcpLocalAgentDriver(provider, options.env));
    case "agy":
      return new AgyLocalAgentAdapter();
    case "omp":
      return new OmpLocalAgentAdapter();
    case "cline":
      return new DriverBackedLocalAgentAdapter(new AcpLocalAgentDriver("cline", options.env));
  }
}

class DriverBackedLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider: LocalAgentProvider;

  constructor(private readonly driver: LocalAgentDriver) {
    this.provider = driver.provider;
  }

  runtimeKey(): string {
    return this.driver.runtimeKey({
      agentId: "adapter",
      provider: this.driver.provider,
      workspaceRoot: ".",
    });
  }

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks): Promise<LocalAgentRunResult> {
    const context = {
      agentId: "adapter",
      provider: this.driver.provider,
      workspaceRoot: input.workspaceRoot,
      providerSessionId: input.providerSessionId,
      writeMode: input.writeMode,
      model: input.model,
      effort: input.effort,
    };
    const created = await this.driver.createRuntime(context);
    if (!created.isOk()) {
      throw created.error;
    }
    const runtime = created.value;
    if (callbacks?.onExecutionStarted) {
      await callbacks.onExecutionStarted();
    }
    try {
      const turn = await runtime.run(input, callbacks);
      if (turn.isOk()) return turn.value;
      throw turn.error;
    } finally {
      await runtime.close?.().catch(() => {});
    }
  }
}

class CodexLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "codex" as const;

  runtimeKey(): string {
    return this.provider;
  }

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks): Promise<LocalAgentRunResult> {
    const environment = definedEnvironment(inputEnvironment(input));
    const identity = inspectCodexRuntime({ env: environment });
    if (!identity.ready || !identity.executable) {
      throw new Error(`Codex runtime is not ready: ${identity.reason ?? "runtime inspection failed"}`);
    }
    const runtime = await createCodexSdkLocalAgentRuntime({
      codexPathOverride: identity.executable,
      env: environment,
    });
    if (callbacks?.onExecutionStarted) {
      await callbacks.onExecutionStarted();
    }
    return runtime.run(input, callbacks);
  }
}

class OmpLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "omp" as const;

  runtimeKey(): string {
    return this.provider;
  }

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks): Promise<LocalAgentRunResult> {
    return runOmpAcpLocalAgent(input, callbacks);
  }
}

export function agyCommandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  const keysToRemove = [
    "DEVSPACE_OAUTH_OWNER_TOKEN",
    "DEVSPACE_OAUTH_SCOPES",
  ];
  for (const key of keysToRemove) {
    delete next[key];
  }
  for (const key of Object.keys(next)) {
    const upper = key.toUpperCase();
    if (
      upper.startsWith("DEVSPACE_") &&
      (upper.includes("TOKEN") ||
       upper.includes("SECRET") ||
       upper.includes("AUTH") ||
       upper.includes("KEY") ||
       upper.includes("PASSWORD"))
    ) {
      delete next[key];
    }
  }

  // Agy loads global MCP configuration from ~/.gemini/config/mcp_config.json.
  // A bounded DevSpace worker must not inherit that ambient tool surface. Bind
  // Agy's user/config roots to the already-owned per-turn provider scratch so
  // global MCP servers stay invisible without mutating the user's real config.
  const scratch = next.DEVSPACE_PROVIDER_SCRATCH?.trim();
  if (!scratch) {
    throw new Error("Agy dispatch requires DevSpace-owned provider scratch for per-dispatch config isolation.");
  }
  const ownership = inspectScratchOwnership(scratch);
  if (!ownership.owned) {
    throw new Error(`Agy dispatch refused unowned provider scratch: ${ownership.reason}`);
  }
  const scratchRoot = canonicalizeExistingPath(scratch);
  const isolatedHome = join(scratchRoot, "agy-home");
  mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  const canonicalHome = canonicalizeExistingPath(isolatedHome);
  if (!isPathWithin(canonicalHome, scratchRoot)) {
    throw new Error(`Agy isolated home escaped provider scratch: ${canonicalHome}`);
  }

  // Agy stores its authenticated Antigravity token and durable conversation DBs
  // under ~/.gemini/antigravity-cli, separately from global MCP configuration in
  // ~/.gemini/config. Expose only those two provider-state paths into the
  // isolated home. Do not link the application-data directory wholesale: it may
  // contain cached MCP schemas, provider scratch, or other unrelated state.
  const originalHome = next.HOME?.trim() || next.USERPROFILE?.trim();
  if (!originalHome) {
    throw new Error("Agy dispatch cannot isolate global config without the original user home.");
  }
  const canonicalOriginalHome = canonicalizeExistingPath(originalHome);
  const sourceAppData = canonicalizeExistingPath(
    join(canonicalOriginalHome, ".gemini", "antigravity-cli"),
  );
  if (!isPathWithin(sourceAppData, canonicalOriginalHome)) {
    throw new Error(`Agy provider state escaped the original user home: ${sourceAppData}`);
  }
  const isolatedAppData = join(canonicalHome, ".gemini", "antigravity-cli");
  mkdirSync(isolatedAppData, { recursive: true, mode: 0o700 });
  const providerStateLinks: Array<{ name: string; type: "file" | "dir" }> = [
    { name: "antigravity-oauth-token", type: "file" },
    { name: "conversations", type: "dir" },
  ];
  for (const { name, type } of providerStateLinks) {
    const source = canonicalizeExistingPath(join(sourceAppData, name));
    if (!isPathWithin(source, sourceAppData)) {
      throw new Error(`Agy provider state path escaped its application-data root: ${source}`);
    }
    const target = join(isolatedAppData, name);
    if (existsSync(target)) {
      const existing = canonicalizeExistingPath(target);
      if (existing !== source) {
        throw new Error(`Agy isolated provider state has unexpected target for ${name}: ${existing}`);
      }
    } else {
      symlinkSync(source, target, process.platform === "win32" && type === "dir" ? "junction" : type);
      const linked = canonicalizeExistingPath(target);
      if (linked !== source) {
        throw new Error(`Agy provider state link verification failed for ${name}: ${linked}`);
      }
    }
  }

  next.HOME = canonicalHome;
  // Go's user-home resolution uses USERPROFILE on Windows. Setting both keeps
  // the provider-specific boundary deterministic across supported platforms.
  next.USERPROFILE = canonicalHome;
  next.XDG_CONFIG_HOME = join(canonicalHome, ".config");
  next.XDG_DATA_HOME = join(canonicalHome, ".local", "share");
  next.XDG_CACHE_HOME = join(canonicalHome, ".cache");
  next.XDG_STATE_HOME = join(canonicalHome, ".local", "state");
  return next;
}

export function resolveAgyGitMetadataDirs(workspace: string): string[] {
  const workspaceRoot = canonicalizeExistingPath(workspace);

  // Resolve the worktree-scoped git metadata directory. For the main worktree
  // this is <root>/.git (inside the workspace); for a linked worktree it is
  // <common>/.git/worktrees/<name>, outside the workspace. Expose only the
  // scoped directory: handing agy the repo-common .git makes its --new-project
  // resolution pick the repository's main worktree instead of this workspace,
  // escaping the bounded workspace boundary.
  const gitDir = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    {
      cwd: workspace,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    },
  );
  if (gitDir.status !== 0) return [];
  const rawGitDir = gitDir.stdout.trim().split(/\r?\n/, 1)[0]?.trim();
  if (!rawGitDir) return [];

  const gitMetadataDir = canonicalizeExistingPath(resolve(workspaceRoot, rawGitDir));
  if (isPathWithin(gitMetadataDir, workspaceRoot)) return [];

  // The scoped dir must sit under <common>/.git/worktrees/ of a repository
  // this workspace is a verified member of.
  const commonRevParse = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: workspace,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    },
  );
  if (commonRevParse.status !== 0) return [];
  const rawCommonDir = commonRevParse.stdout.trim().split(/\r?\n/, 1)[0]?.trim();
  if (!rawCommonDir) return [];

  const commonDir = canonicalizeExistingPath(resolve(workspaceRoot, rawCommonDir));
  if (basename(commonDir) !== ".git") return [];
  if (!isPathWithin(gitMetadataDir, join(commonDir, "worktrees"))) return [];

  const membership = spawnSync(
    "git",
    [`--git-dir=${commonDir}`, "worktree", "list", "--porcelain"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    },
  );
  if (membership.status !== 0) return [];

  const ownsWorkspace = membership.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => canonicalizeExistingPath(line.slice("worktree ".length).trim()))
    .includes(workspaceRoot);

  return ownsWorkspace ? [gitMetadataDir] : [];
}

function canonicalizeExistingPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isPathWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

class AgyLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "agy" as const;

  runtimeKey(): string {
    return this.provider;
  }

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks): Promise<LocalAgentRunResult> {
    const environment = inputEnvironment(input);
    const agyExecutable = resolveAgyExecutable(environment);
    if (!agyExecutable) {
      throw new Error("Agy executable not found.");
    }

    const args: string[] = [];
    if (input.providerSessionId) {
      args.push("--conversation", input.providerSessionId);
    } else {
      args.push("--new-project");
    }
    if (input.model) {
      args.push("--model", input.model);
    }
    // Agy 1.1.18 rejects a separate --effort for this preset model because
    // the reasoning tier is already encoded in the model identity.
    if (input.effort && input.model !== "gemini-3.7-flash-medium") {
      args.push("--effort", input.effort);
    }
    args.push("--sandbox");
    // DevSpace invokes Agy in non-interactive --print mode. Without this flag,
    // any command/file confirmation that Agy cannot prompt for is soft-denied
    // and the durable worker exits before it can perform bounded work. The
    // workspace/add-dir scope and DevSpace execution contract remain the
    // outer containment boundaries for the delegated turn.
    args.push("--dangerously-skip-permissions");
    args.push("--add-dir", input.workspaceRoot);
    for (const gitMetadataDir of resolveAgyGitMetadataDirs(input.workspaceRoot)) {
      args.push("--add-dir", gitMetadataDir);
    }

    const mode = input.writeMode === "allowed" ? "accept-edits" : "plan";
    args.push("--mode", mode);
    args.push("--output-format", "json");
    args.push("--print-timeout", `${AGY_PRINT_TIMEOUT_SECONDS}s`);
    args.push("--print", input.prompt);

    if (callbacks?.onExecutionStarted) {
      await callbacks.onExecutionStarted();
    }

    const child = spawn(agyExecutable, args, {
      cwd: input.workspaceRoot,
      env: agyCommandEnvironment(environment),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    assertPipedChild(child);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });

    const timeoutMs = environment.DEVSPACE_AGY_TIMEOUT_MS
      ? parseInt(environment.DEVSPACE_AGY_TIMEOUT_MS, 10)
      : AGY_AGENT_TIMEOUT_MS;
    const graceMs = environment.DEVSPACE_AGY_GRACE_MS
      ? parseInt(environment.DEVSPACE_AGY_GRACE_MS, 10)
      : 3_000;

    let timeoutId: NodeJS.Timeout | undefined;
    let graceTermId: NodeJS.Timeout | undefined;
    let graceKillId: NodeJS.Timeout | undefined;
    let isTimedOut = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(async () => {
        isTimedOut = true;
        child.kill("SIGTERM");

        const waitGraceExit = new Promise<void>((resolveGrace) => {
          graceTermId = setTimeout(() => {
            child.kill("SIGKILL");
            graceKillId = setTimeout(() => {
              resolveGrace();
            }, graceMs);
          }, graceMs);
        });

        try {
          await Promise.race([exitPromise, waitGraceExit]);
        } catch {}

        reject(new Error("Agy execution timed out."));
      }, timeoutMs);
    });

    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    try {
      exitInfo = await Promise.race([exitPromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (graceTermId) clearTimeout(graceTermId);
      if (graceKillId) clearTimeout(graceKillId);
      // A provider may fork a descendant that inherits these descriptors.
      // Once the exact child has exited, close only our owned handles so that
      // the caller is never held open by an inherited pipe.
      if (exitInfo) {
        await drainOwnedChildOutput(child, () => stdout, () => stderr);
      }
      await closeOwnedChildPipes(child);
    }

    if (isTimedOut) {
      throw new Error("Agy execution timed out.");
    }

    if (exitInfo.code !== 0) {
      throw new Error(
        `Agy exited with non-zero code ${exitInfo.code ?? "null"} (signal: ${exitInfo.signal ?? "null"}). Stderr: ${stderr.trim()}`,
      );
    }

    // Agy's JSON protocol has no trustworthy incremental event boundary;
    // record activity only once the complete provider response is available.
    await callbacks?.onActivity?.();

    let parsed: any;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch (error) {
      throw new Error(`Failed to parse Agy JSON output: ${errorMessage(error)}. Raw stdout: ${stdout}`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Agy JSON output is not an object. Raw stdout: ${stdout}`);
    }

    const { status, conversation_id, response } = parsed;

    if (status !== "SUCCESS") {
      throw new LocalAgentProviderError(
        `Agy execution status is not SUCCESS: ${status}. Full output: ${JSON.stringify(parsed)}`,
        {
          providerSessionId: typeof conversation_id === "string" ? conversation_id : undefined,
          finalResponse: typeof response === "string" ? response : undefined,
        },
      );
    }

    if (!conversation_id || typeof conversation_id !== "string") {
      throw new Error(`Agy execution response is missing conversation_id or it is not a string.`);
    }

    if (!response || typeof response !== "string" || !response.trim()) {
      throw new Error(`Agy execution response is missing response content or it is empty.`);
    }

    return {
      provider: this.provider,
      providerSessionId: conversation_id,
      finalResponse: response.trim(),
      items: [parsed],
    };
  }
}

async function closeOwnedChildPipes(
  child: import("node:child_process").ChildProcessWithoutNullStreams,
): Promise<void> {
  child.stdin.end();
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

async function drainOwnedChildOutput(
  child: import("node:child_process").ChildProcessWithoutNullStreams,
  readStdout: () => string,
  readStderr: () => string,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let stdoutEnded = child.stdout.readableEnded;
    let stderrEnded = child.stderr.readableEnded;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.stdout.off("end", onStdoutEnd);
      child.stderr.off("end", onStderrEnd);
    };
    const finish = () => { cleanup(); resolve(); };
    const onData = () => {
      try {
        const parsed = JSON.parse(readStdout().trim());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) finish();
      } catch {
        // Continue draining until the output is complete or bounded timeout.
      }
    };
    const onStdoutEnd = () => { stdoutEnded = true; if (stdoutEnded && stderrEnded) finish(); };
    const onStderrEnd = () => { stderrEnded = true; if (stdoutEnded && stderrEnded) finish(); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.stdout.once("end", onStdoutEnd);
    child.stderr.once("end", onStderrEnd);
    timer = setTimeout(finish, AGY_OUTPUT_DRAIN_TIMEOUT_MS);
    onData();
    if (stdoutEnded && stderrEnded) finish();
  });
}

function assertPipedChild(child: ReturnType<typeof spawn>): asserts child is import("node:child_process").ChildProcessWithoutNullStreams {
  if (!child.stdout || !child.stdin || !child.stderr) {
    child.kill();
    throw new Error("Agent child process did not provide piped stdio streams.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Daemon-stack driver composition used by `devspace agents` and local-agent-daemon.
export function createLocalAgentDrivers(
  options: LocalAgentDriverOptions = {},
): LocalAgentDriver[] {
  return [
    new CodexDriverForDaemonStack(options.env),
    new ClaudeLocalAgentDriver(options.claudeQueryFactory, options.env),
    new OpencodeLocalAgentDriver(options.opencodeFactory, options.env),
    new PiLocalAgentDriver(options.piSessionFactory),
    new AcpLocalAgentDriver("cursor", options.env),
    new AcpLocalAgentDriver("copilot", options.env),
    new AcpLocalAgentDriver("grok", options.env),
  ];
}

export function extractLocalAgentResponseText(value: unknown): string {
  return extractOpenCodeFinalResponse(value) || extractPiFinalResponse(value);
}

export {
  claudeCommandEnvironment,
  extractOpenCodeFinalResponse,
  extractPiFinalResponse,
  extractPiProviderError,
  resolveAcpCommand,
  resolveAcpModelConfigUpdate,
  resolveAcpEffortConfigUpdate,
};
