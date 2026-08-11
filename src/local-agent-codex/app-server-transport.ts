import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { terminateProcessTree } from "../process-platform.js";
import type { ResolvedCodexCommand } from "./command.js";

const STDERR_LIMIT = 32_000;
const SHUTDOWN_GRACE_MS = 2_000;

export interface CodexAppServerConnection {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  isUsable(): boolean;
  close(): Promise<void>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export async function startCodexAppServer(
  command: ResolvedCodexCommand,
): Promise<CodexAppServerConnection> {
  const client = new StdioCodexAppServerConnection(command);
  try {
    await client.request("initialize", {
      clientInfo: {
        name: "devspace",
        title: "DevSpace",
        version: "1",
      },
      capabilities: null,
    });
    client.notify("initialized");
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

class StdioCodexAppServerConnection implements CodexAppServerConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationHandlers = new Set<(method: string, params: unknown) => void>();
  private readonly closePromise: Promise<void>;
  private nextRequestId = 1;
  private stderr = "";
  private usable = true;
  private closing = false;

  constructor(command: ResolvedCodexCommand) {
    const detached = process.platform !== "win32";
    this.child = spawn(command.executable, ["app-server"], {
      env: command.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached,
      shell: process.platform === "win32",
    });

    this.closePromise = new Promise<void>((resolve) => {
      this.child.once("close", (code, signal) => {
        this.usable = false;
        const suffix = this.stderr.trim() ? `\n${this.stderr.trim()}` : "";
        this.failPending(new Error(
          `Codex app-server exited${code !== null ? ` with code ${code}` : signal ? ` from ${signal}` : ""}.${suffix}`,
        ));
        resolve();
      });
    });

    this.child.once("error", (error) => {
      this.usable = false;
      this.failPending(new Error(`Codex app-server failed to start: ${error.message}`));
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = takeTail(this.stderr + chunk.toString("utf8"), STDERR_LIMIT);
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.isUsable()) {
      return Promise.reject(new Error("Codex app-server connection is not available."));
    }
    const id = this.nextRequestId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      this.write(payload, reject);
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.isUsable()) throw new Error("Codex app-server connection is not available.");
    this.write(params === undefined ? { method } : { method, params });
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  isUsable(): boolean {
    return this.usable && !this.closing && this.child.exitCode === null && this.child.signalCode === null;
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.closePromise;
      return;
    }
    this.closing = true;
    this.usable = false;
    this.failPending(new Error("Codex app-server connection closed."));
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      await this.closePromise;
      return;
    }

    const detached = process.platform !== "win32";
    terminateProcessTree(this.child, "SIGTERM", detached);
    const exited = await Promise.race([
      this.closePromise.then(() => true),
      delay(SHUTDOWN_GRACE_MS).then(() => false),
    ]);
    if (!exited && this.child.exitCode === null && this.child.signalCode === null) {
      terminateProcessTree(this.child, "SIGKILL", detached);
      await this.closePromise;
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      this.usable = false;
      this.failPending(new Error(`Codex app-server emitted invalid JSON: ${line.slice(0, 500)}`));
      return;
    }
    if (!isRecord(message)) return;

    const id = requestId(message.id);
    const method = typeof message.method === "string" ? message.method : undefined;
    if (id !== undefined && method) {
      this.write({
        id: message.id,
        error: {
          code: -32601,
          message: `DevSpace does not handle Codex server request ${method}.`,
        },
      });
      return;
    }
    if (id !== undefined) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (isRecord(message.error)) {
        pending.reject(new Error(codexRpcError(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!method) return;
    for (const handler of this.notificationHandlers) {
      handler(method, message.params);
    }
  }

  private write(payload: unknown, reject?: (error: Error) => void): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
      if (!error) return;
      this.usable = false;
      const wrapped = new Error(`Failed to write to Codex app-server: ${error.message}`);
      reject?.(wrapped);
      this.failPending(wrapped);
    });
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function requestId(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function codexRpcError(error: Record<string, unknown>): string {
  const message = typeof error.message === "string" ? error.message : "Codex app-server request failed";
  const code = typeof error.code === "number" ? ` (${error.code})` : "";
  return `${message}${code}`;
}

function takeTail(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(value.length - maxLength);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
