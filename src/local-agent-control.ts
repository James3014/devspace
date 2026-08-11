import { createHash } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ServerConfig } from "./config.js";
import {
  type LocalAgentRunCommand,
} from "./local-agent-manager.js";
import type { LocalAgentRecord } from "./local-agent-store.js";

type ControlRequest = { type: "run"; command: LocalAgentRunCommand };
type ControlResponse =
  | { ok: true; record: LocalAgentRecord }
  | { ok: false; error: string };

export interface LocalAgentCommandHandler {
  enqueue(command: LocalAgentRunCommand): Promise<LocalAgentRecord>;
}

export class LocalAgentControlServer {
  private server: Server | undefined;

  constructor(
    private readonly config: ServerConfig,
    private readonly manager: LocalAgentCommandHandler,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    const address = localAgentControlAddress(this.config.stateDir);
    if (process.platform !== "win32") {
      await mkdir(this.config.stateDir, { recursive: true });
      await removeStaleSocket(address);
    }

    const server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(address);
    });
    this.server = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (process.platform !== "win32") {
      await rm(localAgentControlAddress(this.config.stateDir), { force: true });
    }
  }

  private handleConnection(socket: Socket): void {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      const line = input.slice(0, newline);
      socket.pause();
      void this.handleLine(line).then((response) => {
        socket.end(`${JSON.stringify(response)}\n`);
      });
    });
  }

  private async handleLine(line: string): Promise<ControlResponse> {
    try {
      const request = parseControlRequest(JSON.parse(line) as unknown);
      const record = await this.manager.enqueue(request.command);
      return { ok: true, record };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export async function requestLocalAgentRun(
  config: ServerConfig,
  command: LocalAgentRunCommand,
): Promise<LocalAgentRecord> {
  const response = await requestControl(localAgentControlAddress(config.stateDir), {
    type: "run",
    command,
  });
  if (!response.ok) throw new Error(response.error);
  return response.record;
}

export function localAgentControlAddress(stateDir: string): string {
  if (process.platform !== "win32") return join(stateDir, "subagents.sock");
  const digest = createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\devspace-subagents-${digest}`;
}

async function requestControl(address: string, request: ControlRequest): Promise<ControlResponse> {
  return new Promise<ControlResponse>((resolve, reject) => {
    const socket = createConnection(address);
    socket.setEncoding("utf8");
    let response = "";
    socket.once("error", (error) => {
      reject(new Error(
        `DevSpace subagent runtime is unavailable. Start \`devspace serve\` and try again. (${error.message})`,
      ));
    });
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("end", () => {
      try {
        resolve(parseControlResponse(JSON.parse(response.trim()) as unknown));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
  });
}

async function removeStaleSocket(address: string): Promise<void> {
  const active = await canConnect(address);
  if (active) {
    throw new Error(`DevSpace subagent control socket is already active at ${address}.`);
  }
  await rm(address, { force: true });
}

async function canConnect(address: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(address);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function parseControlRequest(value: unknown): ControlRequest {
  if (!isRecord(value) || value.type !== "run" || !isRecord(value.command)) {
    throw new Error("Invalid DevSpace subagent control request.");
  }
  return { type: "run", command: parseRunCommand(value.command) };
}

function parseRunCommand(value: Record<string, unknown>): LocalAgentRunCommand {
  const workspaceRoot = requiredString(value.workspaceRoot, "workspaceRoot");
  const target = requiredString(value.target, "target");
  const prompt = requiredString(value.prompt, "prompt");
  return {
    workspaceRoot,
    target,
    prompt,
    workspaceId: optionalString(value.workspaceId),
    model: optionalString(value.model),
    thinking: optionalString(value.thinking),
  };
}

function parseControlResponse(value: unknown): ControlResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error("Invalid response from DevSpace subagent runtime.");
  }
  if (value.ok === false) {
    return { ok: false, error: requiredString(value.error, "error") };
  }
  if (!isRecord(value.record)) throw new Error("Invalid subagent record in control response.");
  return { ok: true, record: parseAgentRecord(value.record) };
}

function parseAgentRecord(value: Record<string, unknown>): LocalAgentRecord {
  const status = value.status;
  if (status !== "starting" && status !== "running" && status !== "idle" && status !== "error" && status !== "stopped") {
    throw new Error("Invalid subagent status in control response.");
  }
  return {
    id: requiredString(value.id, "id"),
    workspaceRoot: requiredString(value.workspaceRoot, "workspaceRoot"),
    profileName: requiredString(value.profileName, "profileName"),
    provider: requiredString(value.provider, "provider"),
    status,
    createdAt: requiredString(value.createdAt, "createdAt"),
    updatedAt: requiredString(value.updatedAt, "updatedAt"),
    workspaceId: optionalString(value.workspaceId),
    model: optionalString(value.model),
    thinking: optionalString(value.thinking),
    providerSessionId: optionalString(value.providerSessionId),
    latestResponse: optionalString(value.latestResponse),
    error: optionalString(value.error),
  };
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`Invalid ${name} in DevSpace subagent control message.`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
