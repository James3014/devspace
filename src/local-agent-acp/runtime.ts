import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type {
  ClientConnection,
  ClientContext,
  InitializeResponse,
  LoadSessionResponse,
  NewSessionResponse,
  ResumeSessionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { LocalAgentRunInput, LocalAgentRunResult } from "../local-agent-runtime.js";
import type { HarnessDriver, HarnessRuntime } from "../local-agent-runtime-pool.js";
import { resolveLocalAgentExecutable } from "../local-agent-path.js";
import { terminateProcessTree } from "../process-platform.js";
import {
  resolveAcpModelConfigUpdate,
  resolveAcpThinkingConfigUpdate,
  selectAcpAllowPermissionOption,
  type AcpSessionConfigState,
} from "./config.js";

const STDERR_LIMIT = 32_000;
const SHUTDOWN_GRACE_MS = 2_000;
const ACP_SESSION_IDLE_MS = 5 * 60 * 1_000;

type AcpProvider = "cursor" | "copilot";

interface PendingAcpTurn {
  textParts: string[];
}

interface AcpSessionEntry extends AcpSessionConfigState {
  active: boolean;
  lastUsedAt: number;
}

export class AcpHarnessRuntime implements HarnessRuntime {
  private readonly sessions = new Map<string, AcpSessionEntry>();
  private readonly pendingTurns = new Map<string, PendingAcpTurn>();
  private closed = false;

  constructor(
    private readonly provider: AcpProvider,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connection: ClientConnection,
    private readonly initializeResponse: InitializeResponse,
    private readonly stderr: () => string,
  ) {}

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    if (!this.isUsable()) throw new Error(`${this.provider} ACP runtime is closed.`);
    try {
      const session = await this.ensureSession(input);
      if (this.pendingTurns.has(session.sessionId)) {
        throw new Error(`${this.provider} ACP session ${session.sessionId} already has a turn in progress.`);
      }
      session.active = true;
      try {
        if (input.model) {
          await this.connection.agent.request("session/set_config_option", {
            ...resolveAcpModelConfigUpdate(session, input.model, this.provider),
          });
        }
        if (input.thinking) {
          await this.connection.agent.request("session/set_config_option", {
            ...resolveAcpThinkingConfigUpdate(session, input.thinking, this.provider),
          });
        }

        const pending: PendingAcpTurn = { textParts: [] };
        this.pendingTurns.set(session.sessionId, pending);
        try {
          await this.connection.agent.request("session/prompt", {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: input.prompt }],
          });
          return {
            provider: this.provider,
            providerSessionId: session.sessionId,
            finalResponse: pending.textParts.join("").trim(),
            items: [],
          };
        } finally {
          this.pendingTurns.delete(session.sessionId);
        }
      } finally {
        session.active = false;
        session.lastUsedAt = Date.now();
      }
    } catch (error) {
      const detail = this.stderr().trim();
      throw new Error(
        `${this.provider} ACP run failed: ${errorMessage(error)}${detail ? `\n${detail}` : ""}`,
      );
    }
  }

  handleSessionUpdate(notification: SessionNotification): void {
    const pending = this.pendingTurns.get(notification.sessionId);
    if (!pending) return;
    const update = notification.update;
    if (update.sessionUpdate !== "agent_message_chunk") return;
    if (update.content.type === "text") pending.textParts.push(update.content.text);
  }

  isUsable(): boolean {
    return !this.closed
      && !this.connection.signal.aborted
      && this.child.exitCode === null
      && this.child.signalCode === null;
  }

  async reapIdleSessions(now: number): Promise<void> {
    if (!this.initializeResponse.agentCapabilities?.sessionCapabilities?.close) return;
    for (const [sessionId, session] of this.sessions) {
      if (session.active || now - session.lastUsedAt < ACP_SESSION_IDLE_MS) continue;
      try {
        await this.connection.agent.request("session/close", { sessionId });
        this.sessions.delete(sessionId);
      } catch {
        // The connection remains useful; retry this session on a later reap.
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connection.close();
    const detached = process.platform !== "win32";
    if (this.child.exitCode === null && this.child.signalCode === null) {
      terminateProcessTree(this.child, "SIGTERM", detached);
      const exited = await Promise.race([
        childClosed(this.child).then(() => true),
        delay(SHUTDOWN_GRACE_MS).then(() => false),
      ]);
      if (!exited && this.child.exitCode === null && this.child.signalCode === null) {
        terminateProcessTree(this.child, "SIGKILL", detached);
        await childClosed(this.child);
      }
    }
  }

  private async ensureSession(input: LocalAgentRunInput): Promise<AcpSessionEntry> {
    if (input.providerSessionId) {
      const existing = this.sessions.get(input.providerSessionId);
      if (existing) return existing;
      const resumed = await this.resumeSession(input.providerSessionId, input.workspace);
      const entry = withActivity(resumed);
      this.sessions.set(input.providerSessionId, entry);
      return entry;
    }

    const response = await this.connection.agent.request("session/new", {
      cwd: input.workspace,
      mcpServers: [],
    }) as NewSessionResponse;
    const session: AcpSessionEntry = {
      sessionId: response.sessionId,
      configOptions: response.configOptions,
      active: false,
      lastUsedAt: Date.now(),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  private async resumeSession(sessionId: string, cwd: string): Promise<AcpSessionConfigState> {
    const capabilities = this.initializeResponse.agentCapabilities;
    if (capabilities?.sessionCapabilities?.resume) {
      const response = await this.connection.agent.request("session/resume", {
        sessionId,
        cwd,
        mcpServers: [],
      }) as ResumeSessionResponse;
      return { sessionId, configOptions: response.configOptions };
    }
    if (capabilities?.loadSession) {
      const response = await this.connection.agent.request("session/load", {
        sessionId,
        cwd,
        mcpServers: [],
      }) as LoadSessionResponse;
      return { sessionId, configOptions: response.configOptions };
    }
    throw new Error(
      `${this.provider} ACP agent cannot resume session ${sessionId}; it advertises neither session/resume nor session/load.`,
    );
  }
}

function withActivity(session: AcpSessionConfigState): AcpSessionEntry {
  return { ...session, active: false, lastUsedAt: Date.now() };
}

export function createAcpHarnessDriver(
  provider: AcpProvider,
  command: readonly [string, ...string[]],
  env: NodeJS.ProcessEnv = process.env,
): HarnessDriver {
  return {
    provider,
    runtimeKey: () => {
      const executable = resolveLocalAgentExecutable(command[0], env) ?? command[0];
      return `${executable}\0${command.slice(1).join("\0")}`;
    },
    createRuntime: async () => {
      const { client, methods, ndJsonStream, PROTOCOL_VERSION } = await import("@agentclientprotocol/sdk");
      const executable = resolveLocalAgentExecutable(command[0], env);
      if (!executable) throw new Error(`${command[0]} executable not found`);

      const detached = process.platform !== "win32";
      const child = spawn(executable, command.slice(1), {
        cwd: process.cwd(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached,
        shell: process.platform === "win32",
      });
      assertPipedChild(child);

      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = takeTail(stderr + chunk.toString("utf8"), STDERR_LIMIT);
      });

      let runtime: AcpHarnessRuntime | undefined;
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      const connection = client({ name: "DevSpace" })
        .onRequest(methods.client.session.requestPermission, (context) => {
          const selected = selectAcpAllowPermissionOption(context.params.options);
          return selected
            ? { outcome: { outcome: "selected", optionId: selected.optionId } }
            : { outcome: { outcome: "cancelled" } };
        })
        .onNotification(methods.client.session.update, (context) => {
          runtime?.handleSessionUpdate(context.params);
        })
        .connect(stream);

      try {
        const initializeResponse = await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "DevSpace", version: "1" },
        });
        runtime = new AcpHarnessRuntime(provider, child, connection, initializeResponse, () => stderr);
        return runtime;
      } catch (error) {
        connection.close(error);
        terminateProcessTree(child, "SIGTERM", detached);
        throw error;
      }
    },
  };
}

function assertPipedChild(child: ReturnType<typeof spawn>): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("ACP process did not expose piped stdio.");
  }
}

function childClosed(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", () => resolve()));
}

function takeTail(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(value.length - maxLength);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
