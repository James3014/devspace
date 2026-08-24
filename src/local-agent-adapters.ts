import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import { resolveAgyExecutable } from "./local-agent-availability.js";
import {
  createCodexSdkLocalAgentRuntime,
  LocalAgentProviderError,
  type LocalAgentDriver,
  type LocalAgentRunInput,
  type LocalAgentRunResult,
} from "./local-agent-runtime.js";
import { runOmpAcpLocalAgent } from "./local-agent-omp.js";
import { inspectCodexRuntime } from "./codex-runtime.js";
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
  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult>;
}

export interface LocalAgentDriverOptions {
  env?: NodeJS.ProcessEnv;
  claudeQueryFactory?: ClaudeQueryFactory;
  opencodeFactory?: OpencodeFactory;
  piSessionFactory?: PiSessionFactory;
}

const AGY_PRINT_TIMEOUT_SECONDS = 600;
const AGY_AGENT_TIMEOUT_MS = 610_000;

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
): Promise<LocalAgentRunResult> {
  return createLocalAgentAdapter(provider).run(input);
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
      return new DriverBackedLocalAgentAdapter(new OpencodeLocalAgentDriver(options.opencodeFactory));
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

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
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
      throw new LocalAgentProviderError(created.error.message);
    }
    const runtime = created.value;
    try {
      const turn = await runtime.run(input);
      if (turn.isOk()) return turn.value;
      throw new LocalAgentProviderError(turn.error.message);
    } finally {
      await runtime.close().catch(() => {});
    }
  }
}

class CodexLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "codex" as const;

  runtimeKey(): string {
    return this.provider;
  }

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const environment = definedEnvironment(inputEnvironment(input));
    const identity = inspectCodexRuntime({ env: environment });
    if (!identity.ready || !identity.executable) {
      throw new Error(`Codex runtime is not ready: ${identity.reason ?? "runtime inspection failed"}`);
    }
    const runtime = await createCodexSdkLocalAgentRuntime({
      codexPathOverride: identity.executable,
      env: environment,
    });
    return runtime.run(input);
  }
}

class OmpLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "omp" as const;

  runtimeKey(): string {
    return this.provider;
  }

  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    return runOmpAcpLocalAgent(input);
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
  return next;
}

export function resolveAgyGitMetadataDirs(workspace: string): string[] {
  const revParse = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: workspace,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    },
  );
  if (revParse.status !== 0) return [];

  const rawCommonDir = revParse.stdout.trim().split(/\r?\n/, 1)[0]?.trim();
  if (!rawCommonDir) return [];

  const workspaceRoot = canonicalizeExistingPath(workspace);
  const commonDir = canonicalizeExistingPath(resolve(workspaceRoot, rawCommonDir));
  if (isPathWithin(commonDir, workspaceRoot)) return [];
  if (basename(commonDir) !== ".git") return [];

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

  return ownsWorkspace ? [commonDir] : [];
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

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
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

    let exitInfo: { code: number | null; signal: NodeJS.Signals | null };
    try {
      exitInfo = await Promise.race([exitPromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (graceTermId) clearTimeout(graceTermId);
      if (graceKillId) clearTimeout(graceKillId);
    }

    if (isTimedOut) {
      throw new Error("Agy execution timed out.");
    }

    if (exitInfo.code !== 0) {
      throw new Error(
        `Agy exited with non-zero code ${exitInfo.code ?? "null"} (signal: ${exitInfo.signal ?? "null"}). Stderr: ${stderr.trim()}`,
      );
    }

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
    new OpencodeLocalAgentDriver(options.opencodeFactory),
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
