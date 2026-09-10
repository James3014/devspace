import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "./db/client.js";
import { ChatSwarmRuntimeAlreadyOwnedError, ChatSwarmRuntimeOwner } from "./chat-swarm-runtime-owner.js";

test("runtime owner is singleton across aliases and same-process instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-swarm-owner-"));
  const state = join(root, "state");
  const alias = join(root, "alias");
  await symlink(state, alias, "dir");
  const first = new ChatSwarmRuntimeOwner(state);
  const second = new ChatSwarmRuntimeOwner(alias);
  try {
    first.acquire();
    assert.equal(first.stateDir, second.stateDir);
    assert.throws(() => second.acquire(), ChatSwarmRuntimeAlreadyOwnedError);
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("dead owner is recovered atomically and release is token-bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-swarm-owner-dead-"));
  const first = new ChatSwarmRuntimeOwner(root);
  first.acquire();
  const database = openDatabase(root);
  database.sqlite.prepare("update chat_swarm_runtime_owner set pid=?").run(999_999_999);
  database.close();
  // Simulate a process crash: the database connection disappears without the
  // owner-token release path running.
  (first as unknown as { database: { close(): void } }).database.close();

  const recovered = new ChatSwarmRuntimeOwner(root);
  try {
    recovered.acquire();
    const databaseAfterAcquire = openDatabase(root);
    databaseAfterAcquire.sqlite.prepare("update chat_swarm_runtime_owner set owner_token=?").run("f".repeat(64));
    databaseAfterAcquire.close();
    recovered.release();
    const preserved = openDatabase(root);
    assert.equal((preserved.sqlite.prepare("select count(*) as count from chat_swarm_runtime_owner").get() as { count: number }).count, 1);
    preserved.sqlite.prepare("update chat_swarm_runtime_owner set pid=?").run(999_999_999);
    preserved.close();
    const reacquired = new ChatSwarmRuntimeOwner(root);
    reacquired.acquire();
    const competing = new ChatSwarmRuntimeOwner(root);
    try {
      assert.throws(() => competing.acquire(), ChatSwarmRuntimeAlreadyOwnedError);
      competing.close();
    } finally {
      competing.close();
      reacquired.close();
    }
  } finally {
    recovered.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed and permission-unknown owners fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-swarm-owner-invalid-"));
  const database = openDatabase(root);
  database.sqlite.prepare(
    "insert into chat_swarm_runtime_owner (singleton_id, owner_token, pid, state_dir, acquired_at) values (1, ?, ?, ?, ?)",
  ).run("malformed", 999_999_999, root, new Date().toISOString());
  database.close();
  const owner = new ChatSwarmRuntimeOwner(root);
  try {
    assert.throws(() => owner.acquire(), ChatSwarmRuntimeAlreadyOwnedError);
  } finally {
    owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("EPERM process probes fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-swarm-owner-eperm-"));
  const seed = new ChatSwarmRuntimeOwner(root);
  seed.acquire();
  const database = openDatabase(root);
  database.sqlite.prepare("update chat_swarm_runtime_owner set pid=?").run(12345);
  database.close();
  (seed as unknown as { database: { close(): void } }).database.close();
  const owner = new ChatSwarmRuntimeOwner(root, {
    probe: () => {
      const error = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      throw error;
    },
  });
  try {
    assert.throws(() => owner.acquire(), ChatSwarmRuntimeAlreadyOwnedError);
  } finally {
    owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a separate process blocks the same state directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-swarm-owner-child-"));
  const script = [
    'import { ChatSwarmRuntimeOwner } from "./src/chat-swarm-runtime-owner.ts";',
    `const owner = new ChatSwarmRuntimeOwner(${JSON.stringify(root)});`,
    "owner.acquire(); console.log('ready'); setInterval(() => {}, 1000);",
  ].join(" ");
  const child = spawn(process.execPath, ["--import", "tsx/esm", "-e", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  try {
    await Promise.race([
      once(child.stdout, "data"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("child owner readiness timeout")), 5000)),
    ]);
    const contender = new ChatSwarmRuntimeOwner(root);
    try {
      assert.throws(() => contender.acquire(), ChatSwarmRuntimeAlreadyOwnedError);
    } finally {
      contender.close();
    }
  } finally {
    child.kill("SIGKILL");
    await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("child owner exit timeout")), 5000)),
    ]);
    const recovered = new ChatSwarmRuntimeOwner(root);
    try {
      recovered.acquire();
    } finally {
      recovered.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});
