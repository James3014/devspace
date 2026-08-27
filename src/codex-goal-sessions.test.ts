import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  CodexGoalSessionManager,
  normalizeTerminalText,
  resolveCodexBinary,
  type GoalProcessBackend,
} from "./codex-goal-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import {
  ProcessSessionManager,
  type ProcessSnapshot,
  type StartCommandInput,
  type WriteStdinInput,
} from "./process-sessions.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const OWNER_TOKEN = "test-owner-token-that-is-long-enough";

function makeFakeCodexTui(options: { logPath: string; emitGoalMarker?: boolean }): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(options.logPath)}, "SPAWN:" + process.pid + "\\n");
process.stdout.write("Codex CLI fake ready\\n");
const modelIndex = process.argv.indexOf("--model");
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : "fake-default-model";
process.stdout.write("model: " + model + " medium\\n");
process.stdout.write("directory: " + process.cwd() + "\\n");
process.stdout.write("Ask Codex to do anything\\n");
if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN !== undefined) {
  process.stdout.write("SENTINEL_LEAK:" + process.env.DEVSPACE_OAUTH_OWNER_TOKEN + "\\n");
}
process.stdout.write("HASPATH:" + (process.env.PATH ? "1" : "0") + "\\n");
process.stdout.write("TTY:" + (process.stdout.isTTY ? "1" : "0") + "\\n");
process.stdout.write("PWD:" + process.cwd() + "\\n");
if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
const emitGoal = ${options.emitGoalMarker === false ? "false" : "true"};
let buffer = "";
function handleLine(line) {
  if (!line) return;
  if (line.startsWith("/goal ")) {
    const goalText = line.slice(6);
    if (emitGoal) {
      process.stdout.write("Pursuing goal\\n");
      process.stdout.write("GOAL_RECEIVED:" + goalText + "\\n");
    } else {
      process.stdout.write("NO_GOAL_MODE\\n");
    }
    return;
  }
  if (line === "/exit") process.exit(0);
  if (line.startsWith("/")) { process.stdout.write("UNKNOWN_COMMAND\\n"); return; }
  process.stdout.write("ACK:" + line + "\\n");
}
process.stdin.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  if (text.length > 128) { process.stdout.write("PASTE_SWALLOWED\\n"); return; }
  buffer += text;
  let index;
  while ((index = buffer.search(/[\\r\\n]/)) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handleLine(line);
  }
});
setInterval(() => {}, 1000);
`;
}

interface GoalFixture {
  client: Client;
  projectA: string;
  projectB: string;
  config: ServerConfig;
  processes: ProcessSessionManager;
  goals: CodexGoalSessionManager;
  spawnLogPath: string;
  close: () => Promise<void>;
}

interface GoalFixtureOptions {
  toolMode?: "minimal" | "full" | "codex";
  goalsEnabled?: boolean;
  codexBinOverride?: string;
  emitGoalMarker?: boolean;
  startupTimeoutMs?: number;
}

async function goalFixture(t: TestContext, options: GoalFixtureOptions = {}): Promise<GoalFixture> {
  const rootDir = await mkdtemp(join(tmpdir(), "devspace-codex-goals-test-"));
  const projectA = join(rootDir, "project-a");
  const projectB = join(rootDir, "project-b");
  const binDir = join(rootDir, "bin");
  const stateDir = join(rootDir, ".state");
  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  for (const project of [projectA, projectB]) {
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "README.md"), "hello\n");
    await execFileAsync("git", ["init"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "devspace@example.com"], { cwd: project });
    await execFileAsync("git", ["config", "user.name", "DevSpace Test"], { cwd: project });
    await execFileAsync("git", ["add", "."], { cwd: project });
    await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: project });
  }

  const spawnLogPath = join(rootDir, "fake-codex-spawns.log");
  const fakeBin = join(binDir, "codex-fake");
  writeFileSync(fakeBin, makeFakeCodexTui({
    logPath: spawnLogPath,
    emitGoalMarker: options.emitGoalMarker,
  }), { mode: 0o755 });
  chmodSync(fakeBin, 0o755);

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(rootDir, ".config"),
    DEVSPACE_ALLOWED_ROOTS: rootDir,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_TOOL_MODE: options.toolMode ?? "minimal",
    DEVSPACE_CODEX_GOALS: options.goalsEnabled === false ? undefined : "1",
    ...(options.codexBinOverride !== undefined
      ? { DEVSPACE_CODEX_BIN: options.codexBinOverride }
      : {}),
    DEVSPACE_OAUTH_OWNER_TOKEN: OWNER_TOKEN,
    PORT: "1",
  });

  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const processes = new ProcessSessionManager();
  const goals = new CodexGoalSessionManager(processes, {
    codexBin: config.codexBin ?? fakeBin,
    startupTimeoutMs: options.startupTimeoutMs ?? 8_000,
    activationPollMs: 80,
    typeChunkCharacters: 24,
    typeChunkDelayMs: 30,
    cancelTimeoutMs: 3_000,
  });

  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    processes,
    () => [],
    [],
    undefined,
    goals,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-goals-test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    goals.shutdown();
    processes.shutdown();
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
  };
  t.after(close);

  return { client, projectA, projectB, config, processes, goals, spawnLogPath, close };
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
}

type CallToolResult = Awaited<ReturnType<Client["callTool"]>> & {
  structuredContent?: Record<string, unknown>;
};

function structured(result: CallToolResult): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function textOf(result: CallToolResult): string {
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  assert.ok(Array.isArray(content));
  return content.map((item) => item.text ?? "").join("\n");
}

async function openWorkspace(client: Client, path: string): Promise<string> {
  const opened = await callTool(client, "open_workspace", { path });
  assert.equal(opened.isError, undefined);
  return structured(opened).workspaceId as string;
}

async function headSha(project: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: project });
  return stdout.trim();
}

function spawnCount(logPath: string): number {
  if (!existsSync(logPath)) return 0;
  return readFileSync(logPath, "utf8").split("\n").filter((line) => line.startsWith("SPAWN:")).length;
}

function collectOutput(states: Array<Record<string, unknown>>): string {
  return states.map((state) => String(state.outputChunk ?? "")).join("");
}

// ── Unit: feature flag and binary resolution ────────────────────────────────

const flagConfigEnv = {
  DEVSPACE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "devspace-goals-config-")),
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: OWNER_TOKEN,
};

test("codex goals default to disabled and opt in through DEVSPACE_CODEX_GOALS=1", () => {
  assert.equal(loadConfig(flagConfigEnv).codexGoalsEnabled, false);
  assert.equal(loadConfig({ ...flagConfigEnv, DEVSPACE_CODEX_GOALS: "1" }).codexGoalsEnabled, true);
  assert.equal(loadConfig({ ...flagConfigEnv, DEVSPACE_CODEX_GOALS: "true" }).codexGoalsEnabled, true);
  assert.equal(loadConfig({ ...flagConfigEnv, DEVSPACE_CODEX_GOALS: "0" }).codexGoalsEnabled, false);
  assert.equal(loadConfig(flagConfigEnv).codexBin, undefined);
  assert.equal(
    loadConfig({ ...flagConfigEnv, DEVSPACE_CODEX_BIN: "/custom/codex" }).codexBin,
    "/custom/codex",
  );
});

test("resolveCodexBinary prefers explicit override then PATH then fails clearly", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "devspace-goals-bin-"));
  try {
    const realBin = join(rootDir, "codex");
    writeFileSync(realBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    assert.equal(await resolveCodexBinary({ configuredBin: realBin }), realBin);

    const missing = join(rootDir, "missing", "codex");
    await assert.rejects(
      () => resolveCodexBinary({ configuredBin: missing }),
      /not an executable file.*DEVSPACE_CODEX_BIN/,
    );

    const pathRoot = join(rootDir, "path-dir");
    await mkdir(pathRoot, { recursive: true });
    const onPath = join(pathRoot, "codex");
    writeFileSync(onPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(
      await resolveCodexBinary({ platform: "linux", pathEnv: `${pathRoot}:whatever` }),
      onPath,
    );

    await assert.rejects(
      () => resolveCodexBinary({ platform: "linux", pathEnv: "" }),
      /Codex CLI executable not found/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

// ── Tool surface registration ────────────────────────────────────────────────

const GOAL_TOOLS = [
  "codex_goal_start",
  "codex_goal_status",
  "codex_goal_continue",
  "codex_goal_cancel",
];

test("feature disabled: no codex_goal tools even when a manager is supplied", async (t) => {
  const context = await goalFixture(t, { goalsEnabled: false });
  // Rebuild registration expectations directly against the live server surface.
  const tools = await context.client.listTools();
  for (const name of GOAL_TOOLS) {
    assert.equal(tools.tools.some((tool) => tool.name === name), false);
  }
});

test("minimal mode with flag: goal tools exposed, generic PTY tools stay hidden", async (t) => {
  const context = await goalFixture(t, { toolMode: "minimal" });
  const tools = await context.client.listTools();
  for (const name of GOAL_TOOLS) {
    assert.equal(tools.tools.some((tool) => tool.name === name), true, name);
  }
  assert.equal(tools.tools.some((tool) => tool.name === "exec_command"), false);
  assert.equal(tools.tools.some((tool) => tool.name === "write_stdin"), false);
});

test("full mode compatibility: goal tools coexist with the full surface", async (t) => {
  const context = await goalFixture(t, { toolMode: "full" });
  const tools = await context.client.listTools();
  for (const name of GOAL_TOOLS) {
    assert.equal(tools.tools.some((tool) => tool.name === name), true, name);
  }
  assert.equal(tools.tools.some((tool) => tool.name === "bash"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "exec_command"), false);
});

test("codex mode compatibility: goal tools coexist with exec_command/write_stdin", async (t) => {
  const context = await goalFixture(t, { toolMode: "codex" });
  const tools = await context.client.listTools();
  for (const name of GOAL_TOOLS) {
    assert.equal(tools.tools.some((tool) => tool.name === name), true, name);
  }
  assert.equal(tools.tools.some((tool) => tool.name === "exec_command"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "write_stdin"), true);

  const startTool = tools.tools.find((tool) => tool.name === "codex_goal_start");
  const continueTool = tools.tools.find((tool) => tool.name === "codex_goal_continue");
  const statusTool = tools.tools.find((tool) => tool.name === "codex_goal_status");
  const cancelTool = tools.tools.find((tool) => tool.name === "codex_goal_cancel");
  assert.equal(startTool?.annotations?.destructiveHint, true);
  assert.equal(continueTool?.annotations?.destructiveHint, true);
  assert.equal(statusTool?.annotations?.readOnlyHint, true);
  assert.equal(cancelTool?.annotations?.destructiveHint, true);
});

// ── Start fences ─────────────────────────────────────────────────────────────

test("invalid workspace rejected without spawning Codex", async (t) => {
  const context = await goalFixture(t);
  const result = await callTool(context.client, "codex_goal_start", {
    workspaceId: "ws_unknown",
    goal: "inspect the repo",
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Unknown workspace/);
  assert.equal(spawnCount(context.spawnLogPath), 0);
});

test("missing expectedHead is rejected for Git workspaces before the Codex process is created", async (t) => {
  const context = await goalFixture(t);
  const workspaceId = await openWorkspace(context.client, context.projectA);

  const result = await callTool(context.client, "codex_goal_start", {
    workspaceId,
    goal: "inspect the repo",
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /expectedHead is required/);
  assert.equal(spawnCount(context.spawnLogPath), 0);
});

test("expectedHead mismatch rejected before the Codex process is created", async (t) => {
  const context = await goalFixture(t);
  const workspaceId = await openWorkspace(context.client, context.projectA);
  const wrongHead = "b".repeat(40);

  const result = await callTool(context.client, "codex_goal_start", {
    workspaceId,
    goal: "inspect the repo",
    expectedHead: wrongHead,
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /expectedHead mismatch/);
  assert.equal(spawnCount(context.spawnLogPath), 0);
});

test("malformed expectedHead rejected before any Git or process work", async (t) => {
  const context = await goalFixture(t);
  const workspaceId = await openWorkspace(context.client, context.projectA);
  const result = await callTool(context.client, "codex_goal_start", {
    workspaceId,
    goal: "inspect the repo",
    expectedHead: "not-a-sha",
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /40-character commit SHA/);
  assert.equal(spawnCount(context.spawnLogPath), 0);
});

test("dirty initial Git workspace rejected before spawning Codex", async (t) => {
  const context = await goalFixture(t);
  const workspaceId = await openWorkspace(context.client, context.projectA);
  await writeFile(join(context.projectA, "dirty.txt"), "uncommitted\n");

  const result = await callTool(context.client, "codex_goal_start", {
    workspaceId,
    goal: "inspect the repo",
    expectedHead: await headSha(context.projectA),
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /must be clean/);
  assert.equal(spawnCount(context.spawnLogPath), 0);
});

// ── Real start behavior ─────────────────────────────────────────────────────

test("start launches the real CLI in a PTY, types /goal, and observes activation", async (t) => {
  const context = await goalFixture(t);
  const workspaceId = await openWorkspace(context.client, context.projectA);
  const goal = "summarize the repository layout";

  const started = await callTool(context.client, "codex_goal_start", {
    workspaceId,
    goal,
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    expectedHead: await headSha(context.projectA),
  });
  assert.equal(started.isError, undefined, textOf(started));

  const state = structured(started);
  assert.equal(typeof state.goalId, "string");
  assert.ok(String(state.goalId).startsWith("goal_"));
  assert.equal(state.running, true);
  assert.equal(state.terminal, false);
  assert.equal(state.goalActiveObserved, true);
  assert.equal(state.model, "gpt-5.6-sol");
  assert.equal(state.reasoningEffort, "medium");
  assert.equal(state.baseHead, await headSha(context.projectA));

  const output = collectOutput([state]);
  assert.match(output, /TTY:1/, "the Codex process must run inside a real PTY");
  assert.match(normalizeTerminalText(output), /Pursuing goal/);
  assert.ok(output.includes(`GOAL_RECEIVED:${goal}`));
  assert.doesNotMatch(output, /PASTE_SWALLOWED/);
  assert.ok(
    output.includes(`PWD:${context.projectA}`) ||
      output.includes(`PWD:${realpathSync(context.projectA)}`),
    "Codex must run in the exact workspace",
  );
  assert.equal(spawnCount(context.spawnLogPath), 1);

  await callTool(context.client, "codex_goal_cancel", { workspaceId, goalId: state.goalId });
});

test("large goal input is typed in chunks instead of one swallowed paste", async (t) => {
  const context = await goalFixture(t);
  const workspaceId = await openWorkspace(context.client, context.projectA);
  const longTail = "review module boundaries step by step ".repeat(20);
  const goal = `audit the codebase ${longTail.trim()}`;

  const started = await callTool(context.client, "codex_goal_start", {
    workspaceId,
    goal,
    expectedHead: await headSha(context.projectA),
  });
  assert.equal(started.isError, undefined, textOf(started));
  const status = await callTool(context.client, "codex_goal_status", {
    workspaceId,
    goalId: structured(started).goalId as string,
  });
  const normalized = normalizeTerminalText(collectOutput([structured(started), structured(status)]));
  assert.doesNotMatch(collectOutput([structured(started), structured(status)]), /PASTE_SWALLOWED/);
  assert.ok(normalized.includes(`GOAL_RECEIVED:${goal.slice(0, 40)}`));
  assert.ok(normalized.includes(goal.slice(-30)));
  await callTool(context.client, "codex_goal_cancel", {
    workspaceId,
    goalId: structured(started).goalId as string,
  });
});

test("start fails closed when Goal activation is never observed", async (t) => {
  // Generous startup window so the fake TUI fully boots; the point under test
  // is that Goal activation itself is never observed.
  const context = await goalFixture(t, { emitGoalMarker: false, startupTimeoutMs: 4_000 });
  const workspaceId = await openWorkspace(context.client, context.projectA);

  const started = await callTool(context.client, "codex_goal_start", {
    workspaceId,
    goal: "should never activate",
    expectedHead: await headSha(context.projectA),
  });
  assert.equal(started.isError, true);
  assert.match(textOf(started), /Goal activation failed|not observed within/);

  // The half-started session must be terminated, not leaked as a success.
  const list = context.goals.listActiveGoalIds();
  assert.equal(list.length, 0);
  assert.equal(spawnCount(context.spawnLogPath), 1);
});

test("start fails clearly when no Codex binary can be resolved", async (t) => {
  const context = await goalFixture(t, { codexBinOverride: join(tmpdir(), "definitely-missing-codex") });
  const workspaceId = await openWorkspace(context.client, context.projectA);
  const result = await callTool(context.client, "codex_goal_start", {
    workspaceId,
    goal: "anything",
    expectedHead: await headSha(context.projectA),
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /not an executable file|not found/);
  assert.equal(spawnCount(context.spawnLogPath), 0);
});

test("PTY-unavailable backends fail closed instead of piping Goal Mode", async () => {
  const stubProcesses = {
    start: async () => {
      throw new Error("PTY support requires the optional node-pty dependency.");
    },
    write: async () => {
      throw new Error("no session");
    },
    terminate: () => undefined,
  };
  const manager = new CodexGoalSessionManager(stubProcesses, { codexBin: "/bin/echo" });
  await assert.rejects(
    () =>
      manager.start({
        workspaceId: "ws",
        workspaceRoot: tmpdir(),
        goal: "never starts",
      }),
    /PTY support requires/,
  );
});

// ── Session identity, continuation, cancellation ────────────────────────────

test("status and continue reuse the same goalId and never spawn a second process", async (t) => {
  const context = await goalFixture(t);
  const workspaceId = await openWorkspace(context.client, context.projectA);
  const started = await callTool(context.client, "codex_goal_start", {
    workspaceId,
    goal: "track one session only",
    expectedHead: await headSha(context.projectA),
  });
  const goalId = structured(started).goalId as string;

  const status = await callTool(context.client, "codex_goal_status", { workspaceId, goalId });
  assert.equal(structured(status).goalId, goalId);
  assert.equal(structured(status).running, true);

  const continued = await callTool(context.client, "codex_goal_continue", {
    workspaceId,
    goalId,
    message: "focus on the auth module next",
  });
  assert.equal(continued.isError, undefined, textOf(continued));
  assert.equal(structured(continued).goalId, goalId);
  assert.match(collectOutput([structured(continued)]), /ACK:focus on the auth module next/);
  assert.equal(spawnCount(context.spawnLogPath), 1);

  await callTool(context.client, "codex_goal_cancel", { workspaceId, goalId });
});

test("continue rejects terminal goals", async (t) => {
  const context = await goalFixture(t);
  const workspaceId = await openWorkspace(context.client, context.projectA);
  const started = await callTool(context.client, "codex_goal_start", {
    workspaceId,
    goal: "will be cancelled",
    expectedHead: await headSha(context.projectA),
  });
  const goalId = structured(started).goalId as string;
  await callTool(context.client, "codex_goal_cancel", { workspaceId, goalId });

  const attempted = await callTool(context.client, "codex_goal_continue", {
    workspaceId,
    goalId,
    message: "too late",
  });
  assert.equal(attempted.isError, true);
  assert.match(textOf(attempted), /terminal/);
});

test("unknown goal ids fail closed", async (t) => {
  const context = await goalFixture(t);
  const workspaceId = await openWorkspace(context.client, context.projectA);
  for (const [name, args] of [
    ["codex_goal_status", { workspaceId, goalId: "goal_missing" }],
    ["codex_goal_continue", { workspaceId, goalId: "goal_missing", message: "hi" }],
    ["codex_goal_cancel", { workspaceId, goalId: "goal_missing" }],
  ] as const) {
    const result = await callTool(context.client, name, { ...args });
    assert.equal(result.isError, true, name);
    assert.match(textOf(result), /Unknown Codex goal/);
  }
});

test("cross-workspace goal access is rejected for every action", async (t) => {
  const context = await goalFixture(t);
  const workspaceA = await openWorkspace(context.client, context.projectA);
  const workspaceB = await openWorkspace(context.client, context.projectB);

  const started = await callTool(context.client, "codex_goal_start", {
    workspaceId: workspaceA,
    goal: "owned by workspace A",
    expectedHead: await headSha(context.projectA),
  });
  const goalId = structured(started).goalId as string;

  for (const [name, extra] of [
    ["codex_goal_status", {}],
    ["codex_goal_continue", { message: "intrude" }],
    ["codex_goal_cancel", {}],
  ] as const) {
    const result = await callTool(context.client, name, {
      workspaceId: workspaceB,
      goalId,
      ...extra,
    });
    assert.equal(result.isError, true, name);
    assert.match(textOf(result), /does not belong to workspace/);
  }
  // The owning workspace still works.
  const ownerStatus = await callTool(context.client, "codex_goal_status", {
    workspaceId: workspaceA,
    goalId,
  });
  assert.equal(ownerStatus.isError, undefined);

  await callTool(context.client, "codex_goal_cancel", { workspaceId: workspaceA, goalId });
});

test("one active goal per workspace; different workspaces run independently", async (t) => {
  const context = await goalFixture(t);
  const workspaceA = await openWorkspace(context.client, context.projectA);
  const workspaceB = await openWorkspace(context.client, context.projectB);

  const first = await callTool(context.client, "codex_goal_start", {
    workspaceId: workspaceA,
    goal: "first active goal in A",
    expectedHead: await headSha(context.projectA),
  });
  const firstGoalId = structured(first).goalId as string;

  const blocked = await callTool(context.client, "codex_goal_start", {
    workspaceId: workspaceA,
    goal: "second goal must fail",
  });
  assert.equal(blocked.isError, true);
  assert.match(textOf(blocked), /already has an active Codex goal/);

  const otherWorkspace = await callTool(context.client, "codex_goal_start", {
    workspaceId: workspaceB,
    goal: "workspace B runs independently",
    expectedHead: await headSha(context.projectB),
  });
  assert.equal(otherWorkspace.isError, undefined, textOf(otherWorkspace));

  await callTool(context.client, "codex_goal_cancel", { workspaceId: workspaceA, goalId: firstGoalId });
  await callTool(context.client, "codex_goal_cancel", {
    workspaceId: workspaceB,
    goalId: structured(otherWorkspace).goalId as string,
  });
});

test("cancel terminates only the target session and preserves terminal state", async (t) => {
  const context = await goalFixture(t);
  const workspaceA = await openWorkspace(context.client, context.projectA);
  const workspaceB = await openWorkspace(context.client, context.projectB);

  const target = await callTool(context.client, "codex_goal_start", {
    workspaceId: workspaceA,
    goal: "cancel me",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    expectedHead: await headSha(context.projectA),
  });
  const survivor = await callTool(context.client, "codex_goal_start", {
    workspaceId: workspaceB,
    goal: "keep me alive",
    expectedHead: await headSha(context.projectB),
  });
  const targetGoalId = structured(target).goalId as string;
  const survivorGoalId = structured(survivor).goalId as string;

  const cancelled = await callTool(context.client, "codex_goal_cancel", {
    workspaceId: workspaceA,
    goalId: targetGoalId,
  });
  assert.equal(cancelled.isError, undefined);
  const cancelledState = structured(cancelled);
  assert.equal(cancelledState.terminal, true);
  assert.equal(cancelledState.running, false);
  assert.equal(cancelledState.goalActiveObserved, true);
  assert.equal(cancelledState.baseHead, await headSha(context.projectA));
  assert.equal(cancelledState.model, "gpt-5.6-sol");

  const survivorStatus = await callTool(context.client, "codex_goal_status", {
    workspaceId: workspaceB,
    goalId: survivorGoalId,
  });
  assert.equal(structured(survivorStatus).running, true);

  // Repeated cancel is safe and still returns inspectable state.
  const repeated = await callTool(context.client, "codex_goal_cancel", {
    workspaceId: workspaceA,
    goalId: targetGoalId,
  });
  assert.equal(repeated.isError, undefined);
  assert.equal(structured(repeated).terminal, true);

  const lateStatus = await callTool(context.client, "codex_goal_status", {
    workspaceId: workspaceA,
    goalId: targetGoalId,
  });
  assert.equal(structured(lateStatus).terminal, true);
  assert.equal(structured(lateStatus).goalActiveObserved, true);

  await callTool(context.client, "codex_goal_cancel", {
    workspaceId: workspaceB,
    goalId: survivorGoalId,
  });
});

// ── Environment sanitization ────────────────────────────────────────────────

test("sanitized child environment hides DevSpace secrets from the Codex process", async (t) => {
  const context = await goalFixture(t);
  const workspaceId = await openWorkspace(context.client, context.projectA);
  const started = await callTool(context.client, "codex_goal_start", {
    workspaceId,
    goal: "environment hygiene check",
    expectedHead: await headSha(context.projectA),
  });
  assert.equal(started.isError, undefined, textOf(started));
  const output = collectOutput([structured(started)]);
  assert.match(output, /HASPATH:1/, "PATH must survive sanitization for normal CLI operation");
  assert.doesNotMatch(output, /SENTINEL_LEAK/);
  assert.doesNotMatch(output, new RegExp(OWNER_TOKEN));
  await callTool(context.client, "codex_goal_cancel", {
    workspaceId,
    goalId: structured(started).goalId as string,
  });
});

test("no secret material leaks into structured output across a full lifecycle", async (t) => {
  const context = await goalFixture(t);
  const workspaceId = await openWorkspace(context.client, context.projectA);
  const started = await callTool(context.client, "codex_goal_start", {
    workspaceId,
    goal: "secret scan target",
    expectedHead: await headSha(context.projectA),
  });
  const goalId = structured(started).goalId as string;
  const status = await callTool(context.client, "codex_goal_status", { workspaceId, goalId });
  const continued = await callTool(context.client, "codex_goal_continue", {
    workspaceId,
    goalId,
    message: "keep scanning",
  });
  const cancelled = await callTool(context.client, "codex_goal_cancel", { workspaceId, goalId });

  for (const result of [started, status, continued, cancelled]) {
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(OWNER_TOKEN), "owner token leaked into MCP output");
    assert.ok(!serialized.includes("DEVSPACE_OAUTH"), "OAuth env names leaked into MCP output");
  }
});

// ── Direct ProcessSessionManager coverage of argv + sanitized env ───────────

test("argv spawning with sanitized environment strips non-allowlisted variables", async () => {
  process.env.DEVSPACE_TEST_SENTINEL_SECRET = "leak-me-not";
  const manager = new ProcessSessionManager();
  try {
    const snapshot = await manager.start({
      workspaceId: "ws-env",
      cwd: process.cwd(),
      command: "unused",
      executable: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({sentinel: process.env.DEVSPACE_TEST_SENTINEL_SECRET ?? null, hasPath: Boolean(process.env.PATH), hasHome: Boolean(process.env.HOME)}))",
      ],
      environmentPolicy: "sanitized",
      yieldTimeMs: 2_000,
    });
    assert.equal(snapshot.exitCode, 0);
    const reported = JSON.parse(snapshot.output.trim()) as {
      sentinel: string | null;
      hasPath: boolean;
      hasHome: boolean;
    };
    assert.equal(reported.sentinel, null);
    assert.equal(reported.hasPath, true);
    assert.equal(reported.hasHome, true);
  } finally {
    delete process.env.DEVSPACE_TEST_SENTINEL_SECRET;
    manager.shutdown();
  }
});

// ── RED oracles: destructive-delta Goal readiness (tests-only, current13a) ──

interface ScriptedSnapshotInput {
  output?: string;
  outputTruncated?: boolean;
  running?: boolean;
}

function snapshotFor(input: ScriptedSnapshotInput): ProcessSnapshot {
  return {
    sessionId: 1,
    output: input.output ?? "",
    outputTruncated: input.outputTruncated ?? false,
    running: input.running ?? true,
    wallTimeMs: 10,
  };
}

/**
 * Deterministic destructive-delta backend. Polls (empty chars) consume the
 * queued readiness snapshots. Once the complete ready text has been observed,
 * a typed `/goal` produces Goal activation; too-early typing is answered with
 * the real CLI's "start the session first" rejection.
 */
class ScriptedDeltaBackend implements GoalProcessBackend {
  readonly writes: string[] = [];
  nonEmptySnapshotsConsumed = 0;
  terminated = false;
  private readonly readySnapshots: ScriptedSnapshotInput[];
  private readonly expectedReadyTextTemplate: string;
  private expectedReadyText?: string;
  private index = 0;
  private currentScreen = "";
  private readinessInvalidated = false;

  constructor(
    snapshots: ScriptedSnapshotInput[],
    options: { readyText?: string } = {},
  ) {
    this.readySnapshots = snapshots;
    this.expectedReadyTextTemplate =
      options.readyText ?? "model: gpt-5.6-sol medium\ndirectory: <CWD>\nAsk Codex to do anything\n";
  }

  async start(input: { cwd: string }): Promise<ProcessSnapshot> {
    this.expectedReadyText = normalizeTerminalText(
      this.expectedReadyTextTemplate.replaceAll("<CWD>", input.cwd),
    );
    return this.nextSnapshot();
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    if (input.chars) {
      this.writes.push(input.chars);
      const typed = this.writes.join("");
      if (typed.includes("/goal ") || typed.endsWith("\r")) {
        const queuedBlockingScreen = this.readySnapshots
          .slice(this.index)
          .some((snapshot) => snapshot.outputTruncated || /trust\s+the\s+contents|error/i.test(normalizeTerminalText(snapshot.output ?? "")));
        return !this.readinessInvalidated && !queuedBlockingScreen &&
          this.currentScreen.includes(this.expectedReadyText ?? "")
          ? snapshotFor({ output: "Pursuing goal\nGOAL_RECEIVED:accepted\n" })
          : snapshotFor({ output: "The session must start before you can set a goal.\n" });
      }
    }
    return this.nextSnapshot();
  }

  terminate(): void {
    this.terminated = true;
  }

  private nextSnapshot(): ProcessSnapshot {
    if (this.index >= this.readySnapshots.length) {
      return snapshotFor({});
    }
    const next = snapshotFor(this.readySnapshots[this.index]!);
    this.index += 1;
    if (next.outputTruncated) {
      this.currentScreen = "";
      this.readinessInvalidated = true;
    } else if (next.output) {
      this.nonEmptySnapshotsConsumed += 1;
      // Model the PTY's destructive deltas as a current screen while still
      // accepting a repeated full-screen frame as a valid positive sample.
      this.currentScreen = normalizeTerminalText(`${this.currentScreen}${next.output}`);
    }
    return next;
  }
}

function scriptedGoalManager(
  backend: GoalProcessBackend,
  options: { model?: string; timeoutMs?: number } = {},
): CodexGoalSessionManager {
  return new CodexGoalSessionManager(backend, {
    codexBin: "/bin/echo",
    startupTimeoutMs: options.timeoutMs ?? 400,
    activationPollMs: 20,
    typeChunkCharacters: 24,
    typeChunkDelayMs: 0,
    cancelTimeoutMs: 80,
    resolveBinary: async () => "/bin/echo",
  });
}

test("start waits for resolved model and directory before typing /goal", async () => {
  const workspace = realpathSync(tmpdir());
  const loading = "model: loading\ndirectory: loading\nAsk Codex to do anything\n";
  const ready = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([
    { output: loading },
    { output: `\u001b[2J${ready}` },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  try {
    const started = await manager.start({
      workspaceId: "ws_wait_for_resolved_identity",
      workspaceRoot: workspace,
      goal: "wait for the real session",
      model: "gpt-5.6-sol",
    });
    assert.equal(started.goalActiveObserved, true);
    assert.equal(backend.writes.join(""), "/goal wait for the real session\r");
  } finally {
    manager.shutdown();
  }
});

const EXPECTED_TERMINAL_HANDSHAKE_REPLY = [
  "\u001b[1;1R",
  "\u001b]10;rgb:ffff/ffff/ffff\u001b\\",
  "\u001b]11;rgb:0000/0000/0000\u001b\\",
  "\u001b[?0u",
  "\u001b[?1;2c",
].join("");

class TerminalHandshakeBackend implements GoalProcessBackend {
  readonly writes: string[] = [];
  readonly startInputs: StartCommandInput[] = [];
  terminated = false;
  private ready = false;

  constructor(private readonly workspaceRoot: string) {}

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    this.startInputs.push(input);
    return snapshotFor({
      output: "\u001b[6n\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b[?u\u001b[c",
    });
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    if (input.chars) {
      this.writes.push(input.chars);
      if (input.chars === EXPECTED_TERMINAL_HANDSHAKE_REPLY) {
        this.ready = true;
        return snapshotFor({
          output: `model: gpt-5.6-sol medium\ndirectory: ${this.workspaceRoot}\nAsk Codex to do anything\n`,
        });
      }
      if (this.ready && this.writes.join("").includes("/goal ")) {
        return snapshotFor({ output: "Pursuing goal\n" });
      }
    }
    return snapshotFor({});
  }

  terminate(): void {
    this.terminated = true;
  }
}

test("Codex Goal answers only the bounded startup terminal handshake before typing /goal", async () => {
  const workspace = realpathSync(tmpdir());
  const backend = new TerminalHandshakeBackend(workspace);
  const manager = scriptedGoalManager(backend);
  try {
    const started = await manager.start({
      workspaceId: "ws_terminal_handshake",
      workspaceRoot: workspace,
      goal: "handshake first",
      model: "gpt-5.6-sol",
    });
    assert.equal(started.goalActiveObserved, true);
    assert.equal(backend.writes[0], EXPECTED_TERMINAL_HANDSHAKE_REPLY);
    assert.equal(backend.writes.slice(1).join(""), "/goal handshake first\r");
    assert.ok(
      backend.startInputs[0]?.args?.includes("check_for_update_on_startup=false"),
      "startup must suppress the interactive update chooser through Codex config",
    );
  } finally {
    manager.shutdown();
  }
});

test("Codex Goal accepts cursor-positioned boxed Codex 0.149.0 readiness with home-relative directory", async () => {
  const workspace = realpathSync(homedir());
  const writes: string[] = [];
  const backend: GoalProcessBackend = {
    async start() {
      return snapshotFor({
        output: [
          "\u001b[4;1H│ model:     gpt-5.6-sol minimal   /model to change │",
          "\u001b[5;1H│ directory: ~ │",
          "\u001b[9;1H› Ask Codex to do anything",
          "\u001b[10;1H",
        ].join(""),
      });
    },
    async write(input) {
      if (input.chars) {
        writes.push(input.chars);
        if (writes.join("").includes("/goal ")) {
          return snapshotFor({ output: "Pursuing goal\n" });
        }
      }
      return snapshotFor({});
    },
    terminate() {},
  };
  const manager = scriptedGoalManager(backend);
  try {
    const started = await manager.start({
      workspaceId: "ws_boxed_real_tui",
      workspaceRoot: workspace,
      goal: "parse real tui",
      model: "gpt-5.6-sol",
    });
    assert.equal(started.goalActiveObserved, true);
    assert.equal(writes.join(""), "/goal parse real tui\r");
  } finally {
    manager.shutdown();
  }
});

test("Codex Goal lets a later cursor repaint supersede historical startup loading without a clear-screen", async () => {
  const workspace = realpathSync(homedir());
  const writes: string[] = [];
  let pollCount = 0;
  const backend: GoalProcessBackend = {
    async start() {
      return snapshotFor({
        output: "model: loading\ndirectory: loading\nAsk Codex to do anything\n",
      });
    },
    async write(input) {
      if (input.chars) {
        writes.push(input.chars);
        if (writes.join("").includes("/goal ")) {
          return snapshotFor({ output: "Pursuing goal\n" });
        }
      } else if (pollCount === 0) {
        pollCount += 1;
        return snapshotFor({ output: "gpt-5.6-sol default · ~\n" });
      } else if (pollCount === 1) {
        pollCount += 1;
        return snapshotFor({
          output: [
            "\u001b[4;1H│ model:     gpt-5.6-sol minimal   /model to change │",
            "\u001b[5;1H│ directory: ~ │",
            "\u001b[9;1H› Ask Codex to do anything",
            "\u001b[10;1H",
          ].join(""),
        });
      }
      return snapshotFor({});
    },
    terminate() {},
  };
  const manager = scriptedGoalManager(backend);
  try {
    const started = await manager.start({
      workspaceId: "ws_loading_cursor_repaint",
      workspaceRoot: workspace,
      goal: "accept latest repaint",
      model: "gpt-5.6-sol",
    });
    assert.equal(started.goalActiveObserved, true);
    assert.equal(writes.join(""), "/goal accept latest repaint\r");
  } finally {
    manager.shutdown();
  }
});

test("Codex Goal keeps a coherent ready frame stable across decorative MCP spinner deltas", async () => {
  const workspace = realpathSync(tmpdir());
  const ready = `model: gpt-5.6-sol minimal\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([
    { output: ready },
    { output: "Starting MCP servers (1/3)\n" },
    { output: "⠋ nexus-devspace-mcp\n" },
  ], { readyText: ready });
  const manager = scriptedGoalManager(backend);
  try {
    const started = await manager.start({
      workspaceId: "ws_decorative_spinner_stability",
      workspaceRoot: workspace,
      goal: "ignore decorative spinner",
      model: "gpt-5.6-sol",
    });
    assert.equal(started.goalActiveObserved, true);
    assert.equal(backend.writes.join(""), "/goal ignore decorative spinner\r");
  } finally {
    manager.shutdown();
  }
});

test("Codex Goal does not answer unrelated terminal control queries or leak /goal before readiness", async () => {
  const workspace = realpathSync(tmpdir());
  const backend: GoalProcessBackend & { writes: string[]; terminated: boolean } = {
    writes: [],
    terminated: false,
    async start() {
      return snapshotFor({ output: "\u001b[5n\u001b[>c\u001b[?25h" });
    },
    async write(input) {
      if (input.chars) this.writes.push(input.chars);
      return snapshotFor({});
    },
    terminate() {
      this.terminated = true;
    },
  };
  const manager = scriptedGoalManager(backend, { timeoutMs: 80 });
  try {
    await assert.rejects(
      manager.start({
        workspaceId: "ws_unrelated_terminal_query",
        workspaceRoot: workspace,
        goal: "must stay gated",
        model: "gpt-5.6-sol",
      }),
      /produced no output|stable coherent readiness|activation failed/i,
    );
    assert.deepEqual(backend.writes, []);
    assert.equal(backend.terminated, true);
  } finally {
    manager.shutdown();
  }
});

test("RED: readiness waits for a resolved model/directory before typing /goal across destructive deltas", async () => {
  const workspace = realpathSync(tmpdir());
  const backend = new ScriptedDeltaBackend(
    [{ output: "\u001b[32mmo" }, { output: "" }, { output: "del: gpt-5.6-sol medium\u001b[0m\n\u001b[34mdir" }, { output: "" }, { output: `ectory: ${workspace}\u001b[0m\nAsk Cod` }, { output: "" }, { output: "ex to do anything\n" }, { output: "" }, { output: "" }],
  );
  const manager = scriptedGoalManager(backend);
  try {
    const started = await manager.start({
      workspaceId: "ws_delta_fragments",
      workspaceRoot: workspace,
      goal: "consume ordered deltas",
      model: "gpt-5.6-sol",
    });
    assert.equal(started.goalActiveObserved, true);
    assert.equal(backend.writes.join(""), "/goal consume ordered deltas\r");
  } finally {
    manager.shutdown();
  }
});

test("RED: startup loading is transient and a fresh coherent repaint can become ready", async () => {
  const workspace = realpathSync(tmpdir());
  const loading = "model: loading\ndirectory: loading\nAsk Codex to do anything\n";
  const ready = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([
    { output: loading },
    { output: "" },
    { output: `\u001b[2J${ready}` },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  try {
    const started = await manager.start({
      workspaceId: "ws_loading_then_ready",
      workspaceRoot: workspace,
      goal: "wait through loading",
      model: "gpt-5.6-sol",
    });
    assert.equal(started.goalActiveObserved, true);
    assert.equal(backend.writes.join(""), "/goal wait through loading\r");
  } finally {
    manager.shutdown();
  }
});

test("RED: later loading revokes readiness but does not become a permanent fatal block", async () => {
  const workspace = realpathSync(tmpdir());
  const ready = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([
    { output: ready },
    { output: "loading\n" },
    { output: `\u001b[2J${ready}` },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  try {
    const started = await manager.start({
      workspaceId: "ws_ready_loading_ready",
      workspaceRoot: workspace,
      goal: "require fresh repaint",
      model: "gpt-5.6-sol",
    });
    assert.equal(started.goalActiveObserved, true);
    assert.equal(backend.writes.join(""), "/goal require fresh repaint\r");
  } finally {
    manager.shutdown();
  }
});

test("RED: startup loading never masks a later trust dialog", async () => {
  const workspace = realpathSync(tmpdir());
  const backend = new ScriptedDeltaBackend([
    { output: "model: loading\ndirectory: loading\nAsk Codex to do anything\n" },
    { output: "Trust the contents of this directory?\n" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_loading_then_trust",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Trust|directory-trust dialog|activation failed/i,
  );
  assert.equal(backend.writes.join(""), "", "trust dialog must emit no /goal bytes");
  assert.equal(backend.terminated, true);
});

test("RED: model and directory without an input-ready prompt never become ready on empty polls", async () => {
  const workspace = realpathSync(tmpdir());
  const backend = new ScriptedDeltaBackend(
    [
      { output: `model: gpt-5.6-sol medium\ndirectory: ${workspace}\n` },
      { output: "" },
      { output: "" },
      { output: "" },
      { output: "" },
    ],
    { readyText: `model: gpt-5.6-sol medium\ndirectory: ${workspace}\n` },
  );
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_no_prompt",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Codex Goal activation failed|stable coherent readiness|produced no output/,
  );
  assert.equal(backend.writes.join(""), "", "empty polls must not manufacture prompt readiness");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

test("RED: version header cannot substitute for an input-ready prompt", async () => {
  const workspace = realpathSync(tmpdir());
  const backend = new ScriptedDeltaBackend([
    {
      output: `version 1.0\nmodel: gpt-5.6-sol medium\ndirectory: ${workspace}\n`,
    },
    { output: "" },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_version_without_prompt",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Codex Goal activation failed|stable coherent readiness|produced no output/,
  );
  assert.equal(backend.writes.join(""), "");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

test("RED: built-from header cannot substitute for an input-ready prompt", async () => {
  const workspace = realpathSync(tmpdir());
  const backend = new ScriptedDeltaBackend([
    {
      output: `built from source\nmodel: gpt-5.6-sol medium\ndirectory: ${workspace}\n`,
    },
    { output: "" },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_built_from_without_prompt",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Codex Goal activation failed|stable coherent readiness|produced no output/,
  );
  assert.equal(backend.writes.join(""), "");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

for (const [name, hostilePrompt] of [
  ["negated", "not Ask Codex to do anything"],
  ["suffixed", "Ask Codex to do anything later"],
  ["diagnostic", "status: Ask Codex to do anything unavailable"],
  ["embedded", "XAsk Codex to do anythingY"],
] as const) {
  test(`RED: ${name} Ask-Codex text cannot substitute for the exact input-ready prompt`, async () => {
    const workspace = realpathSync(tmpdir());
    const backend = new ScriptedDeltaBackend([
      {
        output: `model: gpt-5.6-sol medium\ndirectory: ${workspace}\n${hostilePrompt}\n`,
      },
      { output: "" },
      { output: "" },
      { output: "" },
    ]);
    const manager = scriptedGoalManager(backend);
    await assert.rejects(
      manager.start({
        workspaceId: `ws_hostile_prompt_${name}`,
        workspaceRoot: workspace,
        goal: "must not be typed",
        model: "gpt-5.6-sol",
      }),
      /Codex Goal activation failed|stable coherent readiness|produced no output/,
    );
    assert.equal(backend.writes.join(""), "");
    assert.equal(backend.terminated, true);
    assert.deepEqual(manager.listActiveGoalIds(), []);
  });
}

for (const [name, orderedFrame] of [
  [
    "before both identity rows",
    (workspace: string) =>
      `Ask Codex to do anything\nmodel: gpt-5.6-sol medium\ndirectory: ${workspace}\n`,
  ],
  [
    "between model and directory",
    (workspace: string) =>
      `model: gpt-5.6-sol medium\nAsk Codex to do anything\ndirectory: ${workspace}\n`,
  ],
  [
    "between directory and model",
    (workspace: string) =>
      `directory: ${workspace}\nAsk Codex to do anything\nmodel: gpt-5.6-sol medium\n`,
  ],
] as const) {
  test(`RED: prompt ${name} cannot establish ordered readiness`, async () => {
    const workspace = realpathSync(tmpdir());
    const backend = new ScriptedDeltaBackend([
      { output: orderedFrame(workspace) },
      { output: "" },
      { output: "" },
      { output: "" },
    ]);
    const manager = scriptedGoalManager(backend);
    await assert.rejects(
      manager.start({
        workspaceId: `ws_prompt_order_${name.replaceAll(" ", "_")}`,
        workspaceRoot: workspace,
        goal: "must not be typed",
        model: "gpt-5.6-sol",
      }),
      /Codex Goal activation failed|stable coherent readiness|produced no output/,
    );
    assert.equal(backend.writes.join(""), "");
    assert.equal(backend.terminated, true);
    assert.deepEqual(manager.listActiveGoalIds(), []);
  });
}

test("RED: a later non-prompt identity frame revokes historical prompt readiness", async () => {
  const workspace = realpathSync(tmpdir());
  const ready = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([
    { output: ready },
    {
      output: `version 1.1\nmodel: gpt-5.6-sol medium\ndirectory: ${workspace}\n`,
    },
    { output: "" },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_prompt_revoked",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Codex Goal activation failed|stable coherent readiness|produced no output/,
  );
  assert.equal(backend.writes.join(""), "");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

test("RED: clear-screen delta revokes a ready frame before empty polls", async () => {
  const workspace = realpathSync(tmpdir());
  const ready = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([
    { output: ready },
    { output: "\u001b[2J" },
    { output: "" },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_clear_revokes_ready",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Codex Goal activation failed|stable coherent readiness|produced no output/,
  );
  assert.equal(backend.writes.join(""), "");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

test("RED: clear-screen delta discards partial carry before a later prompt", async () => {
  const workspace = realpathSync(tmpdir());
  const ready = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([
    { output: ready },
    { output: "model:" },
    { output: "\u001b[2J" },
    {
      output: ` gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`,
    },
    { output: "" },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_clear_discards_partial_carry",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Codex Goal activation failed|stable coherent readiness|produced no output/,
  );
  assert.equal(backend.writes.join(""), "");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

test("RED: model and directory after clear require a fresh exact prompt", async () => {
  const workspace = realpathSync(tmpdir());
  const ready = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([
    { output: ready },
    { output: "\u001b[3J" },
    {
      output: `model: gpt-5.6-sol medium\ndirectory: ${workspace}\n`,
    },
    { output: "" },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_clear_requires_fresh_prompt",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Codex Goal activation failed|stable coherent readiness|produced no output/,
  );
  assert.equal(backend.writes.join(""), "");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

test("RED: an ordered frame cleared at the end of one snapshot is not ready", async () => {
  const workspace = realpathSync(tmpdir());
  const ready = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([
    { output: `${ready}\u001b[2J` },
    { output: "" },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_same_snapshot_clear_at_end",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Codex Goal activation failed|stable coherent readiness|produced no output/,
  );
  assert.equal(backend.writes.join(""), "");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

test("RED: only promptless post-clear identity bytes survive within one snapshot", async () => {
  const workspace = realpathSync(tmpdir());
  const ready = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([
    {
      output: `${ready}\u001b[2Jmodel: gpt-5.6-sol medium\ndirectory: ${workspace}\n`,
    },
    { output: "" },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_same_snapshot_promptless_suffix",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Codex Goal activation failed|stable coherent readiness|produced no output/,
  );
  assert.equal(backend.writes.join(""), "");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

test("RED: clear within one snapshot prevents partial-prefix identity synthesis", async () => {
  const workspace = realpathSync(tmpdir());
  const backend = new ScriptedDeltaBackend([
    {
      output: `model:\u001b[2J gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`,
    },
    { output: "" },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_same_snapshot_partial_prefix",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Codex Goal activation failed|stable coherent readiness|produced no output/,
  );
  assert.equal(backend.writes.join(""), "");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

test("RED: a fresh ordered repaint after clear in one snapshot can become ready", async () => {
  const workspace = realpathSync(tmpdir());
  const stale = `loading\nmodel: stale-model\ndirectory: /stale\nAsk Codex to do anything\n`;
  const fresh = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([
    { output: `${stale}\u001b[3J${fresh}` },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  try {
    const started = await manager.start({
      workspaceId: "ws_same_snapshot_fresh_repaint",
      workspaceRoot: workspace,
      goal: "accept only the post-clear frame",
      model: "gpt-5.6-sol",
    });
    assert.equal(started.goalActiveObserved, true);
    assert.equal(backend.writes.join(""), "/goal accept only the post-clear frame\r");
  } finally {
    manager.shutdown();
  }
});

test("RED: a split ESC[2J clear revokes pre-clear identity before a later prompt", async () => {
  const workspace = realpathSync(tmpdir());
  const backend = new ScriptedDeltaBackend([
    {
      output: `model: gpt-5.6-sol medium\ndirectory: ${workspace}\n`,
    },
    { output: "\u001b[" },
    { output: "2J\nAsk Codex to do anything\n" },
    { output: "" },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_split_clear_revokes_identity",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Codex Goal activation failed|stable coherent readiness|produced no output/,
  );
  assert.equal(backend.writes.join(""), "");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

test("RED: a fresh ordered repaint after a split ESC[2J clear can become ready", async () => {
  const workspace = realpathSync(tmpdir());
  const fresh = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([
    {
      output: `model: gpt-5.6-sol medium\ndirectory: ${workspace}\n`,
    },
    { output: "\u001b[" },
    { output: `2J${fresh}` },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  try {
    const started = await manager.start({
      workspaceId: "ws_split_clear_fresh_repaint",
      workspaceRoot: workspace,
      goal: "accept the split-clear repaint",
      model: "gpt-5.6-sol",
    });
    assert.equal(started.goalActiveObserved, true);
    assert.equal(backend.writes.join(""), "/goal accept the split-clear repaint\r");
  } finally {
    manager.shutdown();
  }
});

test("RED: split clear prevents pre-clear partial identity synthesis", async () => {
  const workspace = realpathSync(tmpdir());
  const backend = new ScriptedDeltaBackend([
    { output: "model:" },
    { output: "\u001b[" },
    {
      output: `2J gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`,
    },
    { output: "" },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_split_clear_partial_identity",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Codex Goal activation failed|stable coherent readiness|produced no output/,
  );
  assert.equal(backend.writes.join(""), "");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

test("RED: ESC c clear split after ESC revokes pre-clear identity", async () => {
  const workspace = realpathSync(tmpdir());
  const backend = new ScriptedDeltaBackend([
    {
      output: `model: gpt-5.6-sol medium\ndirectory: ${workspace}\n`,
    },
    { output: "\u001b" },
    { output: "c\nAsk Codex to do anything\n" },
    { output: "" },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_split_escape_c_clear",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Codex Goal activation failed|stable coherent readiness|produced no output/,
  );
  assert.equal(backend.writes.join(""), "");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

for (const [name, prefix, suffix] of [
  ["ESC then bracket-2J", "\u001b", "[2J"],
  ["ESC-bracket-2 then J", "\u001b[2", "J"],
  ["ESC then bracket-3J", "\u001b", "[3J"],
  ["ESC-bracket then 3J", "\u001b[", "3J"],
  ["ESC-bracket-3 then J", "\u001b[3", "J"],
] as const) {
  test(`RED: ${name} split clear revokes pre-clear identity`, async () => {
    const workspace = realpathSync(tmpdir());
    const backend = new ScriptedDeltaBackend([
      {
        output: `model: gpt-5.6-sol medium\ndirectory: ${workspace}\n`,
      },
      { output: prefix },
      { output: `${suffix}\nAsk Codex to do anything\n` },
      { output: "" },
      { output: "" },
      { output: "" },
    ]);
    const manager = scriptedGoalManager(backend);
    await assert.rejects(
      manager.start({
        workspaceId: `ws_split_clear_${name.replaceAll(/[^a-z0-9]+/gi, "_")}`,
        workspaceRoot: workspace,
        goal: "must not be typed",
        model: "gpt-5.6-sol",
      }),
      /Codex Goal activation failed|stable coherent readiness|produced no output/,
    );
    assert.equal(backend.writes.join(""), "");
    assert.equal(backend.terminated, true);
    assert.deepEqual(manager.listActiveGoalIds(), []);
  });
}

test("RED: a partial later model label revokes historical prompt readiness", async () => {
  const workspace = realpathSync(tmpdir());
  const ready = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([
    { output: ready },
    { output: "model:" },
    { output: "" },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_partial_model_revokes_prompt",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Codex Goal activation failed|stable coherent readiness|produced no output/,
  );
  assert.equal(backend.writes.join(""), "");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

test("RED: a partial later directory label revokes historical prompt readiness", async () => {
  const workspace = realpathSync(tmpdir());
  const ready = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([
    { output: ready },
    { output: "direc" },
    { output: "" },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_partial_directory_revokes_prompt",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Codex Goal activation failed|stable coherent readiness|produced no output/,
  );
  assert.equal(backend.writes.join(""), "");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

test("RED: identical non-empty destructive chunks are consumed twice, not deduplicated", async () => {
  const workspace = realpathSync(tmpdir());
  const ready = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([{ output: "" }, { output: ready }, { output: ready }, { output: "" }, { output: "" }]);
  const manager = scriptedGoalManager(backend);
  try {
    const started = await manager.start({
      workspaceId: "ws_duplicate_deltas",
      workspaceRoot: workspace,
      goal: "consume both chunks",
    });
    assert.ok(backend.nonEmptySnapshotsConsumed >= 2, "both identical full-screen chunks must be consumed");
    assert.equal(started.goalActiveObserved, true);
  } finally {
    manager.shutdown();
  }
});

test("RED: later loading/error/trust output invalidates historical readiness before /goal", async () => {
  const workspace = realpathSync(tmpdir());
  const ready = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([
    { output: "" },
    { output: ready },
    { output: "Trust the contents of this directory?\n" },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_later_trust",
      workspaceRoot: workspace,
      goal: "must not be typed",
    }),
    /Codex Goal activation failed|did not resolve model and directory|Trust/,
  );
  assert.equal(backend.writes.join(""), "", "later trust must emit no /goal bytes");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

test("RED: wrong explicit model fails closed without /goal", async () => {
  const workspace = realpathSync(tmpdir());
  const backend = new ScriptedDeltaBackend([
    { output: "" },
    { output: `model: some-other-model medium\ndirectory: ${workspace}\nAsk Codex to do anything\n` },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_wrong_model",
      workspaceRoot: workspace,
      goal: "must not be typed",
      model: "gpt-5.6-sol",
    }),
    /Codex Goal activation failed|did not resolve model and directory/,
  );
  assert.equal(backend.writes.join(""), "", "wrong model must emit no /goal bytes");
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

test("RED: wrong workspace directory fails closed without /goal", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "devspace-goal-workspace-"));
  const otherWorkspace = mkdtempSync(join(tmpdir(), "devspace-goal-other-"));
  const backend = new ScriptedDeltaBackend([
    { output: "" },
    { output: `model: gpt-5.6-sol medium\ndirectory: ${otherWorkspace}\nAsk Codex to do anything\n` },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  try {
    await assert.rejects(
      manager.start({
        workspaceId: "ws_wrong_dir",
        workspaceRoot: workspace,
        goal: "must not be typed",
      }),
      /Codex Goal activation failed|did not resolve model and directory/,
    );
    assert.equal(backend.writes.join(""), "", "wrong workspace must emit no /goal bytes");
    assert.deepEqual(manager.listActiveGoalIds(), []);
  } finally {
    try { rmSync(workspace, { recursive: true, force: true }); } catch {}
    try { rmSync(otherWorkspace, { recursive: true, force: true }); } catch {}
  }
});

test("RED: empty truncated destructive snapshot permanently blocks readiness and leaks no goal", async () => {
  const workspace = realpathSync(tmpdir());
  const ready = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([
    { output: "" },
    { output: ready },
    { output: "", outputTruncated: true },
    { output: ready },
    { output: "" },
    { output: "" },
  ]);
  const manager = scriptedGoalManager(backend);
  await assert.rejects(
    manager.start({
      workspaceId: "ws_empty_truncated",
      workspaceRoot: workspace,
      goal: "must not be typed",
    }),
    /Codex Goal activation failed|did not resolve model and directory/,
  );
  assert.equal(backend.writes.join(""), "", "truncated parser must emit no /goal bytes");
  assert.equal(backend.terminated, true);
  assert.deepEqual(manager.listActiveGoalIds(), []);
});

test("RED: empty polls do not replay history and one real duplicate is consumed as a real chunk", async () => {
  const workspace = realpathSync(tmpdir());
  const ready = `model: gpt-5.6-sol medium\ndirectory: ${workspace}\nAsk Codex to do anything\n`;
  const backend = new ScriptedDeltaBackend([{ output: "" }, { output: ready }, { output: "" }, { output: "" }, { output: ready }, { output: "" }, { output: "" }]);
  const manager = scriptedGoalManager(backend);
  try {
    const started = await manager.start({
      workspaceId: "ws_empty_polls",
      workspaceRoot: workspace,
      goal: "consume exactly once",
    });
    assert.equal(backend.writes.join(""), "/goal consume exactly once\r");
    assert.equal(started.goalActiveObserved, true);
  } finally {
    manager.shutdown();
  }
});
