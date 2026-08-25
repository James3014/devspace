import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import { removeDevspaceNodeModulesBinFromPath } from "./local-agent-path.js";
import { resolveAgyExecutable } from "./local-agent-availability.js";
import {
  createCodexSdkLocalAgentRuntime,
  LocalAgentProviderError,
  type LocalAgentRunInput,
  type LocalAgentRunResult,
} from "./local-agent-runtime.js";
import { runOmpAcpLocalAgent } from "./local-agent-omp.js";
import { inspectCodexRuntime } from "./codex-runtime.js";

export interface LocalAgentAdapter {
  readonly provider: LocalAgentProvider;
  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult>;
}

const ACP_COMMANDS: Record<"cursor" | "copilot", [string, ...string[]]> = {
  cursor: ["cursor-agent", "acp"],
  copilot: ["copilot", "--acp"],
};
const PI_AGENT_TIMEOUT_MS = 120_000;
const AGY_PRINT_TIMEOUT_SECONDS = 600;
const AGY_AGENT_TIMEOUT_MS = 610_000;
const OPENCODE_AGENT_TIMEOUT_MS = 900_000;
const OPENCODE_STATUS_POLL_MS = 250;
const OPENCODE_SERVER_START_ATTEMPTS = 4;

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

export function createLocalAgentAdapter(provider: LocalAgentProvider): LocalAgentAdapter {
  switch (provider) {
    case "codex":
      return new CodexLocalAgentAdapter();
    case "claude":
      return new ClaudeLocalAgentAdapter();
    case "opencode":
      return new OpencodeLocalAgentAdapter();
    case "pi":
      return new PiRpcLocalAgentAdapter();
    case "cursor":
    case "copilot":
      return new AcpLocalAgentAdapter(provider, ACP_COMMANDS[provider]);
    case "agy":
      return new AgyLocalAgentAdapter();
    case "omp":
      return new OmpLocalAgentAdapter();
  }
}

class OmpLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "omp" as const;

  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    return runOmpAcpLocalAgent(input);
  }
}

class CodexLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "codex" as const;

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

class ClaudeLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "claude" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const environment = inputEnvironment(input);
    const claudeExecutable = environment.CLAUDE_COMMAND ?? resolveExecutable("claude", environment);
    const messages = query({
      prompt: input.prompt,
      options: {
        cwd: input.workspace,
        model: input.model,
        ...(input.thinking ? { thinking: { type: "adaptive" } as const, effort: input.thinking as EffortLevel } : {}),
        resume: input.providerSessionId,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        env: claudeCommandEnvironment(environment),
        ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
      },
    });

    let providerSessionId = input.providerSessionId ?? null;
    let finalResponse = "";
    const items: unknown[] = [];
    for await (const message of messages) {
      items.push(message);
      const record = message as Record<string, unknown>;
      if (typeof record.session_id === "string") providerSessionId = record.session_id;
      if (record.type === "result" && typeof record.result === "string") {
        const resultError = claudeResultError(record);
        if (resultError) {
          throw new LocalAgentProviderError(resultError, {
            providerSessionId,
            finalResponse: typeof record.result === "string" ? record.result : undefined,
          });
        }
        finalResponse = record.result;
      }
    }

    finalResponse = requireFinalResponse("Claude", finalResponse);
    return {
      provider: this.provider,
      providerSessionId,
      finalResponse,
      items,
    };
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
    if (input.thinking && input.model !== "gemini-3.7-flash-medium") {
      args.push("--effort", input.thinking);
    }
    args.push("--sandbox");
    // DevSpace invokes Agy in non-interactive --print mode. Without this flag,
    // any command/file confirmation that Agy cannot prompt for is soft-denied
    // and the durable worker exits before it can perform bounded work. The
    // workspace/add-dir scope and DevSpace execution contract remain the
    // outer containment boundaries for the delegated turn.
    args.push("--dangerously-skip-permissions");
    args.push("--add-dir", input.workspace);
    for (const gitMetadataDir of resolveAgyGitMetadataDirs(input.workspace)) {
      args.push("--add-dir", gitMetadataDir);
    }

    const mode = input.writeMode === "allowed" ? "accept-edits" : "plan";
    args.push("--mode", mode);
    args.push("--output-format", "json");
    args.push("--print-timeout", `${AGY_PRINT_TIMEOUT_SECONDS}s`);
    args.push("--print", input.prompt);

    const child = spawn(agyExecutable, args, {
      cwd: input.workspace,
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

function claudeResultError(record: Record<string, unknown>): string | undefined {
  const subtype = typeof record.subtype === "string" ? record.subtype : undefined;
  const isError = record.is_error === true || subtype?.startsWith("error");
  if (!isError) return undefined;
  const message =
    directString(record.error) ??
    directString(record.message) ??
    directString(record.result) ??
    subtype ??
    "Claude returned an error result.";
  return `Claude returned an error result: ${message}`;
}

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveExecutable(command: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "command", [
    ...(process.platform === "win32" ? [command] : ["-v", command]),
  ], {
    encoding: "utf8",
    env: environment,
    shell: process.platform !== "win32",
  });
  const executable = result.stdout?.split(/\r?\n/).find((line) => line.trim());
  return executable?.trim() || undefined;
}

export function claudeCommandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_AGENT_SDK_VERSION",
  ]) {
    delete next[key];
  }
  return next;
}

class OpencodeLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "opencode" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const environment = inputEnvironment(input);
    const runtime = await createIsolatedOpencodeRuntime(environment);
    const { client, server } = runtime;
    let sessionId = input.providerSessionId;
    let promptResult: unknown;
    let messages: unknown;
    try {
      sessionId ??= await createOpencodeSession(client, input);
      promptResult = await promptOpencodeSessionAsync(client, sessionId, input);
      await waitForOpencodeTurn(client, sessionId, input.workspace, opencodeAgentTimeoutMs(environment));
      messages = await readOpencodeMessages(client, sessionId, input.workspace);
      const finalResponse = requireFinalResponse(
        "OpenCode",
        extractOpenCodeFinalResponse(messages) || extractOpenCodeFinalResponse(promptResult),
      );
      return {
        provider: this.provider,
        providerSessionId: sessionId,
        finalResponse,
        items: [promptResult, messages],
      };
    } catch (error) {
      if (sessionId && messages === undefined) {
        try {
          messages = await readOpencodeMessages(client, sessionId, input.workspace);
        } catch {
          // Preserve the original provider failure when evidence recovery fails.
        }
      }
      if (sessionId) await abortOpencodeSession(client, sessionId, input.workspace);
      if (error instanceof LocalAgentProviderError) throw error;
      throw new LocalAgentProviderError(errorMessage(error), {
        providerSessionId: sessionId,
        finalResponse: extractOpenCodeFinalResponse(messages) || extractOpenCodeFinalResponse(promptResult),
      });
    } finally {
      server.close();
    }
  }
}

class AcpLocalAgentAdapter implements LocalAgentAdapter {
  constructor(
    readonly provider: "cursor" | "copilot",
    private readonly command: [string, ...string[]],
  ) {}

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const { client } = await import("@agentclientprotocol/sdk");
    const { methods } = await import("@agentclientprotocol/sdk");
    const { ndJsonStream } = await import("@agentclientprotocol/sdk");
    const [command, ...args] = this.command;
    const child = spawn(command, args, {
      cwd: input.workspace,
      env: inputEnvironment(input),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    assertPipedChild(child);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    let providerSessionId = input.providerSessionId ?? null;
    const textParts: string[] = [];

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    try {
      const finalResponse = await client({ name: "DevSpace" })
        .onRequest(methods.client.session.requestPermission, (context) => {
          const selected = selectAcpAllowPermissionOption(context.params.options);
          return selected
            ? { outcome: { outcome: "selected", optionId: selected.optionId } }
            : { outcome: { outcome: "cancelled" } };
        })
        .connectWith(stream, async (context) => {
          const session = await context.buildSession(input.workspace).start();
          providerSessionId = session.sessionId;
          try {
            if (input.model) {
              const config = resolveAcpModelConfigUpdate(session, input.model, this.provider);
              await context.request(methods.agent.session.setConfigOption, config);
            }
            if (input.thinking) {
              const config = resolveAcpThinkingConfigUpdate(session, input.thinking, this.provider);
              await context.request(methods.agent.session.setConfigOption, config);
            }
            const prompt = session.prompt(input.prompt);
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") {
                await prompt;
                return textParts.join("").trim();
              }

              const update = message.update;
              if (update.sessionUpdate !== "agent_message_chunk") continue;
              const content = update.content;
              if (content.type === "text") textParts.push(content.text);
            }
          } finally {
            session.dispose();
          }
        });
      return {
        provider: this.provider,
        providerSessionId,
        finalResponse: finalResponse.trim(),
        items: [],
      };
    } catch (error) {
      throw new LocalAgentProviderError(
        `${this.provider} ACP run failed: ${errorMessage(error)}${stderr ? `\n${stderr.trim()}` : ""}`,
        {
          providerSessionId,
          finalResponse: textParts.join("").trim(),
        },
      );
    } finally {
      child.kill();
    }
  }
}

export function resolveAcpModelConfigUpdate(
  session: unknown,
  model: string,
  provider: string,
): { sessionId: string; configId: string; value: string } {
  return resolveAcpSelectConfigUpdate(session, {
    category: "model",
    label: "model",
    provider,
    value: model,
  });
}

export function resolveAcpThinkingConfigUpdate(
  session: unknown,
  thinking: string,
  provider: string,
): { sessionId: string; configId: string; value: string } {
  return resolveAcpSelectConfigUpdate(session, {
    category: "thought_level",
    label: "thinking option",
    provider,
    value: thinking,
  });
}

function resolveAcpSelectConfigUpdate(
  session: unknown,
  options: {
    category: string;
    label: string;
    provider: string;
    value: string;
  },
): { sessionId: string; configId: string; value: string } {
  const record = asRecord(session);
  if (!record) throw new Error(`${options.provider} ACP session did not return session metadata.`);
  const sessionId = typeof record?.sessionId === "string" ? record.sessionId : undefined;
  if (!sessionId) throw new Error(`${options.provider} ACP session did not return a session id.`);

  const response = asRecord(record.newSessionResponse);
  const configOptions = response ? readArray(response, "configOptions") ?? [] : [];
  const config = configOptions
    .map(asRecord)
    .find((option) => option?.type === "select" && option.category === options.category);
  if (!config) {
    throw new Error(`${options.provider} ACP server does not expose a ${options.label}.`);
  }

  const configId = directString(config.id);
  if (!configId) throw new Error(`${options.provider} ACP ${options.label} is missing an id.`);

  const available = flattenAcpSelectValues(config);
  if (!available.includes(options.value)) {
    const suffix = available.length > 0 ? ` Available values: ${available.join(", ")}.` : "";
    throw new Error(`${options.provider} ACP ${options.label} does not support '${options.value}'.${suffix}`);
  }

  return { sessionId, configId, value: options.value };
}

function flattenAcpSelectValues(option: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const item of readArray(option, "options") ?? []) {
    const record = asRecord(item);
    const value = directString(record?.value);
    if (value) {
      values.push(value);
      continue;
    }
    for (const nested of readArray(record, "options") ?? []) {
      const nestedValue = directString(asRecord(nested)?.value);
      if (nestedValue) values.push(nestedValue);
    }
  }
  return values;
}

function selectAcpAllowPermissionOption(options: Array<{ optionId: string; kind: string }>): { optionId: string } | undefined {
  return (
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind === "allow_always")
  );
}

class PiRpcLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "pi" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const args = ["--mode", "rpc"];
    if (input.model) args.push("--model", input.model);
    if (input.thinking) args.push("--thinking", input.thinking);
    if (input.providerSessionId) args.push("--session", input.providerSessionId);
    const environment = inputEnvironment(input);
    const child = spawn(environment.PI_COMMAND ?? "pi", args, {
      cwd: input.workspace,
      env: piCommandEnvironment(environment),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    assertPipedChild(child);
    const rpc = new JsonLineRpc(child);
    const events: unknown[] = [];
    rpc.onEvent((event) => events.push(event));
    try {
      const state = await rpc.request({ type: "get_state" });
      const providerSessionId = readNestedString(state, ["sessionId"]) ?? input.providerSessionId ?? null;
      const done = rpc.waitForEvent((event) => asRecord(event)?.type === "agent_end", PI_AGENT_TIMEOUT_MS);
      await rpc.request({ type: "prompt", message: input.prompt });
      const agentEnd = await done;
      const sessionMessages = await rpc.request({ type: "get_messages" });
      const finalResponse =
        extractPiFinalResponse(agentEnd) ||
        extractPiFinalResponse(sessionMessages) ||
        extractPiStreamingText(events);
      if (!finalResponse) {
        const providerError =
          extractPiProviderError(agentEnd) ||
          extractPiProviderError(sessionMessages) ||
          extractPiProviderError(events);
        if (providerError) {
          throw new LocalAgentProviderError(`Pi returned an error: ${providerError}`, {
            providerSessionId,
            finalResponse: extractPiStreamingText(events),
          });
        }
      }
      requireFinalResponse("Pi", finalResponse);
      return {
        provider: this.provider,
        providerSessionId,
        finalResponse,
        items: [...events, sessionMessages],
      };
    } finally {
      child.kill();
    }
  }
}

export function piCommandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.PI_COMMAND) return env;
  const path = env.PATH;
  if (!path) return env;

  return {
    ...env,
    PATH: removeDevspaceNodeModulesBinFromPath(path),
  };
}

class JsonLineRpc {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly eventSubscribers = new Set<(event: unknown) => void>();
  private buffer = "";
  private nextId = 1;
  private stderr = "";
  private fatalError: Error | undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      this.failAll(new Error(`Pi RPC process exited with code ${code ?? "null"} and signal ${signal ?? "null"}\n${this.stderr}`.trim()));
    });
  }

  request(command: Record<string, unknown>): Promise<unknown> {
    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }
    const id = `req_${this.nextId}`;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  onEvent(callback: (event: unknown) => void): () => void {
    this.eventSubscribers.add(callback);
    return () => this.eventSubscribers.delete(callback);
  }

  waitForEvent(predicate: (event: unknown) => boolean, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Pi RPC timed out waiting for agent completion\n${this.stderr}`.trim()));
      }, timeoutMs);
      const unsubscribe = this.onEvent((event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      });
    });
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.stderr += `${line}\n`;
        this.failAll(new Error(`Pi RPC emitted malformed JSON on stdout: ${line}`));
        return;
      }
      if (message.type !== "response") {
        for (const subscriber of this.eventSubscribers) subscriber(message);
        continue;
      }

      const id = typeof message.id === "string" ? message.id : undefined;
      if (!id) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      if (message.success === false || message.error) {
        pending.reject(new Error(errorMessage(message.error ?? `Pi RPC request failed: ${message.command ?? id}`)));
      } else {
        pending.resolve(message.data ?? message.result ?? message);
      }
    }
  }

  private failAll(error: Error): void {
    this.fatalError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function createIsolatedOpencodeRuntime(environment: NodeJS.ProcessEnv): Promise<{
  client: unknown;
  server: { close(): void };
}> {
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2/client");
  let lastError: unknown;
  for (let attempt = 0; attempt < OPENCODE_SERVER_START_ATTEMPTS; attempt += 1) {
    const port = await findFreeTcpPort();
    const child = spawn(environment.OPENCODE_COMMAND ?? "opencode", [
      "serve",
      "--hostname=127.0.0.1",
      `--port=${port}`,
    ], {
      env: {
        ...environment,
        OPENCODE_CONFIG_CONTENT: environment.OPENCODE_CONFIG_CONTENT ?? "{}",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.end();
    try {
      const url = await waitForOpencodeServer(child, port);
      return {
        client: createOpencodeClient({ baseUrl: url }),
        server: {
          close() {
            try {
              child.kill("SIGTERM");
            } catch {
              // best-effort parity with the SDK server close operation
            }
          },
        },
      };
    } catch (error) {
      lastError = error;
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort between bounded port attempts
      }
    }
  }
  throw new Error(
    `OpenCode server failed to start on an isolated port after ${OPENCODE_SERVER_START_ATTEMPTS} attempts: ${errorMessage(lastError)}`,
  );
}

async function waitForOpencodeServer(
  child: ChildProcessWithoutNullStreams,
  port: number,
): Promise<string> {
  return new Promise((resolveServer, reject) => {
    let output = "";
    let settled = false;
    const finish = (error?: Error, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.stdout.removeListener("data", inspect);
      child.stderr.removeListener("data", inspect);
      if (error) reject(error);
      else resolveServer(url ?? `http://127.0.0.1:${port}`);
    };
    const inspect = (chunk: Buffer | string) => {
      output += chunk.toString();
      const match = /opencode server listening[^\n]*on\s+(https?:\/\/[^\s]+)/.exec(output);
      if (match) finish(undefined, match[1]);
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(
        `OpenCode server exited before readiness with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}${
          output.trim() ? `: ${output.trim()}` : ""
        }`,
      ));
    };
    const timeout = setTimeout(() => {
      finish(new Error(`Timeout waiting for OpenCode server on port ${port}.`));
    }, 5_000);
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function findFreeTcpPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Unable to allocate an isolated OpenCode TCP port."));
        return;
      }
      const port = address.port;
      probe.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function createOpencodeSession(client: unknown, input: LocalAgentRunInput): Promise<string> {
  const sessionClient = client as {
    session: {
      create(parameters?: unknown, options?: unknown): Promise<unknown>;
    };
  };
  const result = await sessionClient.session.create({
    directory: input.workspace,
    location: { directory: input.workspace },
    ...(input.model
      ? { model: opencodeSessionCreateModelRef(parseOpencodeModel(input.model)) }
      : {}),
  }, { throwOnError: true });
  const id =
    readNestedString(result, ["id"]) ??
    readNestedString(result, ["data", "id"]) ??
    readNestedString(result, ["session", "id"]) ??
    readNestedString(result, ["data", "session", "id"]);
  if (typeof id !== "string") {
    throw new Error("OpenCode did not return a session id.");
  }
  return id;
}

async function promptOpencodeSessionAsync(
  client: unknown,
  sessionId: string,
  input: LocalAgentRunInput,
): Promise<unknown> {
  const session = (client as {
    session: {
      promptAsync?: (parameters?: unknown, options?: unknown) => Promise<unknown>;
      prompt(parameters?: unknown, options?: unknown): Promise<unknown>;
    };
  }).session;
  const promptInput = {
    sessionID: sessionId,
    directory: input.workspace,
    parts: [{ type: "text", text: input.prompt }],
    ...(input.model ? { model: parseOpencodeModel(input.model) } : {}),
    ...(input.thinking ? { variant: input.thinking } : {}),
  };
  if (session.promptAsync) {
    return session.promptAsync(promptInput, { throwOnError: true });
  }
  return promiseWithTimeout(
    session.prompt(promptInput, { throwOnError: true }),
    opencodeAgentTimeoutMs(inputEnvironment(input)),
    "OpenCode prompt",
  );
}

async function waitForOpencodeTurn(
  client: unknown,
  sessionId: string,
  workspace: string,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  let sawBusy = false;
  for (;;) {
    const blocker = await readOpencodeInteractiveBlocker(client, sessionId, workspace);
    if (blocker) throw new Error(blocker);

    const status = await readOpencodeSessionStatus(client, sessionId, workspace);
    if (status === "busy" || status === "retry") sawBusy = true;
    if (status === "idle") return;
    if (status === "inactive" && (sawBusy || Date.now() - startedAt >= 750)) {
      const messages = await readOpencodeMessages(client, sessionId, workspace);
      if (extractOpenCodeFinalResponse(messages)) return;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`OpenCode session ${sessionId} timed out after ${timeoutMs}ms.`);
    }
    await sleep(OPENCODE_STATUS_POLL_MS);
  }
}

async function readOpencodeInteractiveBlocker(
  client: unknown,
  sessionId: string,
  workspace: string,
): Promise<string | undefined> {
  const typed = client as {
    permission?: { list?: (parameters?: unknown, options?: unknown) => Promise<unknown> };
    question?: { list?: (parameters?: unknown, options?: unknown) => Promise<unknown> };
  };
  if (typed.permission?.list) {
    const response = await typed.permission.list({ directory: workspace }, { throwOnError: true });
    const permissions = unwrapProviderPayload(response);
    if (Array.isArray(permissions)) {
      const pending = permissions.map(asRecord).find((item) => item?.sessionID === sessionId);
      if (pending) {
        const permission = directString(pending.permission) ?? "unknown";
        const patterns = Array.isArray(pending.patterns)
          ? pending.patterns.filter((item) => typeof item === "string")
          : [];
        const suffix = patterns.length > 0 ? ` for ${patterns.join(", ")}` : "";
        return `OpenCode session ${sessionId} is blocked on permission '${permission}'${suffix}; DevSpace does not auto-approve interactive permission escalation.`;
      }
    }
  }
  if (typed.question?.list) {
    const response = await typed.question.list({ directory: workspace }, { throwOnError: true });
    const questions = unwrapProviderPayload(response);
    if (Array.isArray(questions)) {
      const pending = questions.map(asRecord).find((item) => item?.sessionID === sessionId);
      if (pending) {
        return `OpenCode session ${sessionId} is blocked on an interactive question; subagent prompts must be self-contained.`;
      }
    }
  }
  return undefined;
}

async function readOpencodeSessionStatus(
  client: unknown,
  sessionId: string,
  workspace: string,
): Promise<"busy" | "retry" | "idle" | "inactive"> {
  const session = (client as {
    session?: { status?: (parameters?: unknown, options?: unknown) => Promise<unknown> };
  }).session;
  if (!session?.status) return "inactive";
  const response = await session.status({ directory: workspace }, { throwOnError: true });
  const statuses = unwrapProviderPayload(response);
  const entry = asRecord(statuses)?.[sessionId];
  const type = directString(asRecord(entry)?.type);
  if (type === "busy" || type === "retry" || type === "idle") return type;
  return "inactive";
}

async function abortOpencodeSession(client: unknown, sessionId: string, workspace: string): Promise<void> {
  const session = (client as {
    session?: { abort?: (parameters?: unknown, options?: unknown) => Promise<unknown> };
  }).session;
  if (!session?.abort) return;
  try {
    await session.abort({ sessionID: sessionId, directory: workspace }, { throwOnError: true });
  } catch {
    // Preserve the original provider error; runtime close still terminates the owned server.
  }
}

async function readOpencodeMessages(client: unknown, sessionId: string, workspace?: string): Promise<unknown> {
  const session = (client as {
    session?: {
      messages?: (parameters?: unknown, options?: unknown) => Promise<unknown>;
    };
  }).session;
  if (!session?.messages) return undefined;
  return session.messages(
    { sessionID: sessionId, ...(workspace ? { directory: workspace } : {}), order: "asc", limit: 100 },
    { throwOnError: true },
  );
}

function opencodeAgentTimeoutMs(env: NodeJS.ProcessEnv): number {
  const configured = Number.parseInt(env.DEVSPACE_OPENCODE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : OPENCODE_AGENT_TIMEOUT_MS;
}

function opencodeSessionCreateModelRef(
  model: { providerID: string; modelID: string },
): { providerID: string; id: string } {
  return { providerID: model.providerID, id: model.modelID };
}

function parseOpencodeModel(model: string): { providerID: string; modelID: string } {
  const separator = model.indexOf("/");
  if (separator === -1) return { providerID: "opencode", modelID: model };
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function extractLocalAgentResponseText(value: unknown): string {
  return extractOpenCodeFinalResponse(value) || extractPiFinalResponse(value);
}

function assertPipedChild(child: ReturnType<typeof spawn>): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Agent process did not expose stdio pipes.");
  }
}

export function extractOpenCodeFinalResponse(value: unknown): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (messages) return extractLastOpenCodeAssistantMessageText(messages);
  return extractOpenCodeAssistantMessageText(root);
}

export function extractPiFinalResponse(value: unknown): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (!messages) return "";

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message || message.role !== "assistant") continue;
    const text = extractPiAssistantMessageText(message);
    if (text) return text;
  }
  return "";
}

export function extractPiStreamingText(events: unknown[]): string {
  return events
    .map((event) => {
      const record = asRecord(event);
      if (!record || record.type !== "message_update") return "";
      const update = asRecord(record.assistantMessageEvent);
      if (!update || update.type !== "text_delta") return "";
      return typeof update.delta === "string" ? update.delta : "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}

export function extractPiProviderError(value: unknown): string {
  const root = unwrapProviderPayload(value);
  if (Array.isArray(root)) {
    for (let index = root.length - 1; index >= 0; index -= 1) {
      const error = extractPiProviderError(root[index]);
      if (error) return error;
    }
    return "";
  }

  const messages = readArray(root, "messages");
  if (messages) return extractPiProviderError(messages);

  const message = asRecord(root)?.message ?? root;
  const record = asRecord(message);
  if (!record) return "";
  const error = record.errorMessage ?? record.error;
  return typeof error === "string" ? error.trim() : "";
}

function extractLastOpenCodeAssistantMessageText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    const info = asRecord(message.info);
    const role = typeof info?.role === "string" ? info.role : message.role;
    const type = typeof message.type === "string" ? message.type : undefined;
    if (role !== "assistant" && type !== "assistant") continue;
    const text = extractOpenCodeAssistantMessageText(message);
    if (text) return text;
  }
  return "";
}

function extractOpenCodeAssistantMessageText(value: unknown): string {
  const message = asRecord(value);
  if (!message) return "";

  const content = readArray(message, "content");
  if (content) {
    const text = content
      .map((part) => {
        const partRecord = asRecord(part);
        if (!partRecord || partRecord.type !== "text") return "";
        return typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text.trim()) return text.trim();
  }

  const parts = readArray(message, "parts");
  if (parts) {
    const text = parts
      .map((part) => {
        const partRecord = asRecord(part);
        if (!partRecord || partRecord.type !== "text") return "";
        return typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text.trim()) return text.trim();
  }

  const info = asRecord(message.info) ?? message;
  return stringifyStructuredAssistantMessage(info.structured);
}

function extractPiAssistantMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const partRecord = asRecord(part);
      if (!partRecord || partRecord.type !== "text") return "";
      return typeof partRecord.text === "string" ? partRecord.text : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function stringifyStructuredAssistantMessage(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  return JSON.stringify(value);
}

function unwrapProviderPayload(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  return record.data ?? record.result ?? value;
}

function readArray(record: unknown, key: string): unknown[] | undefined {
  const value = asRecord(record)?.[key];
  return Array.isArray(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)?.[key];
  }
  return typeof current === "string" ? current : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireFinalResponse(provider: string, response: string): string {
  const trimmed = response.trim();
  if (!trimmed) {
    throw new Error(`${provider} did not return a final assistant response.`);
  }
  return trimmed;
}
