import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
} from "./codex-goal-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const OWNER_TOKEN = "test-owner-token-that-is-long-enough";

function makeFakeCodexTui(options: {
  logPath: string;
  emitGoalMarker?: boolean;
  tuiReadyDelayMs?: number;
}): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(options.logPath)}, "SPAWN:" + process.pid + "\\n");
process.stdout.write("Codex CLI fake booting\\n");
process.stdout.write("model: loading\\n");
process.stdout.write("directory: loading\\n");
if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN !== undefined) {
  process.stdout.write("SENTINEL_LEAK:" + process.env.DEVSPACE_OAUTH_OWNER_TOKEN + "\\n");
}
process.stdout.write("HASPATH:" + (process.env.PATH ? "1" : "0") + "\\n");
process.stdout.write("TTY:" + (process.stdout.isTTY ? "1" : "0") + "\\n");
process.stdout.write("PWD:" + process.cwd() + "\\n");
if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
const emitGoal = ${options.emitGoalMarker === false ? "false" : "true"};
let tuiReady = false;
setTimeout(() => {
  tuiReady = true;
  process.stdout.write("model: gpt-5.6-sol medium\\n");
  process.stdout.write("directory: " + process.cwd() + "\\n");
  process.stdout.write("Ask Codex to do anything\\n");
}, ${options.tuiReadyDelayMs ?? 0});
let buffer = "";
function handleLine(line) {
  if (!line) return;
  if (line.startsWith("/goal ")) {
    if (!tuiReady) {
      process.stdout.write("The session must start before you can set a goal.\\n");
      return;
    }
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
  tuiReadyDelayMs?: number;
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
    tuiReadyDelayMs: options.tuiReadyDelayMs,
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

    const pluginHome = join(rootDir, "plugin-home");
    const pluginBin = join(pluginHome, ".codex", "plugins", ".plugin-appserver", "codex");
    await mkdir(join(pluginHome, ".codex", "plugins", ".plugin-appserver"), { recursive: true });
    writeFileSync(pluginBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(
      await resolveCodexBinary({ platform: "darwin", pathEnv: "", homeDir: pluginHome }),
      pluginBin,
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

test("start waits for resolved model and directory before typing /goal", async (t) => {
  const context = await goalFixture(t, { tuiReadyDelayMs: 500, startupTimeoutMs: 4_000 });
  const workspaceId = await openWorkspace(context.client, context.projectA);

  const started = await callTool(context.client, "codex_goal_start", {
    workspaceId,
    goal: "wait for the real session",
    expectedHead: await headSha(context.projectA),
  });
  assert.equal(started.isError, undefined, textOf(started));
  const output = collectOutput([structured(started)]);
  assert.doesNotMatch(output, /The session must start before you can set a goal/);
  assert.match(normalizeTerminalText(output), /Pursuing goal/);
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
