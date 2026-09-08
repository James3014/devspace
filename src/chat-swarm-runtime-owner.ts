import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { canonicalizePath } from "./roots.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export class ChatSwarmRuntimeAlreadyOwnedError extends Error {
  readonly code = "CHAT_SWARM_RUNTIME_ALREADY_OWNED" as const;

  constructor(message = "Chat Swarm runtime is already owned for this state directory.") {
    super(message);
    this.name = "ChatSwarmRuntimeAlreadyOwnedError";
  }
}

type OwnerRow = {
  owner_token: string;
  pid: number;
  state_dir: string;
  acquired_at: string;
};

function ownerToken(): string {
  return randomBytes(32).toString("hex");
}

export type ProcessProbe = (pid: number) => void;

function processState(pid: number, probe: ProcessProbe): "dead" | "alive" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    probe(pid);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

export class ChatSwarmRuntimeOwner {
  readonly stateDir: string;
  private readonly database: DatabaseHandle;
  private readonly token: string;
  private readonly probe: ProcessProbe;
  private acquired = false;
  private closed = false;

  constructor(stateDir: string, options: { probe?: ProcessProbe } = {}) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.stateDir = canonicalizePath(stateDir);
    this.database = openDatabase(this.stateDir);
    this.token = ownerToken();
    this.probe = options.probe ?? ((pid) => process.kill(pid, 0));
  }

  acquire(): void {
    if (this.acquired) throw new ChatSwarmRuntimeAlreadyOwnedError("Chat Swarm runtime owner is already acquired by this instance.");
    try {
      const acquire = this.database.sqlite.transaction(() => {
        const row = this.database.sqlite.prepare(
          "select owner_token, pid, state_dir, acquired_at from chat_swarm_runtime_owner where singleton_id=1",
        ).get() as OwnerRow | undefined;
        if (row) {
          if (
            typeof row.owner_token !== "string" || !/^[0-9a-f]{64}$/.test(row.owner_token)
            || !Number.isSafeInteger(row.pid) || row.pid <= 0
            || typeof row.state_dir !== "string" || row.state_dir !== this.stateDir
            || typeof row.acquired_at !== "string" || !Number.isFinite(Date.parse(row.acquired_at))
          ) {
            throw new ChatSwarmRuntimeAlreadyOwnedError("Persisted Chat Swarm runtime owner is malformed.");
          }
          const state = processState(row.pid, this.probe);
          if (state !== "dead") {
            throw new ChatSwarmRuntimeAlreadyOwnedError(
              state === "unknown" ? "Cannot establish that the persisted Chat Swarm owner is dead." : undefined,
            );
          }
          const removed = this.database.sqlite.prepare(
            "delete from chat_swarm_runtime_owner where singleton_id=1 and owner_token=? and pid=? and state_dir=?",
          ).run(row.owner_token, row.pid, row.state_dir);
          if (removed.changes !== 1) throw new ChatSwarmRuntimeAlreadyOwnedError("Chat Swarm runtime owner changed during recovery.");
        }
        this.database.sqlite.prepare(
          "insert into chat_swarm_runtime_owner (singleton_id, owner_token, pid, state_dir, acquired_at) values (1, ?, ?, ?, ?)",
        ).run(this.token, process.pid, this.stateDir, new Date().toISOString());
      });
      acquire.immediate();
      this.acquired = true;
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  release(): void {
    if (!this.acquired) return;
    const release = this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare(
        "delete from chat_swarm_runtime_owner where singleton_id=1 and owner_token=?",
      ).run(this.token);
    });
    release.immediate();
    this.acquired = false;
  }

  close(): void {
    if (this.closed) return;
    this.release();
    this.database.close();
    this.closed = true;
  }
}
