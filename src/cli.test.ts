import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { localAgentDaemonPaths } from "./local-agent-daemon-lifecycle.js";
import { encodeLocalAgentDaemonResponse } from "./local-agent-daemon-protocol.js";
import { LocalAgentStore } from "./local-agent-store.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}

const root = mkdtempSync(join(tmpdir(), "devspace-cli-agents-test-"));
try {
  const configDir = join(root, ".devspace");
  const stateDir = join(root, ".state");
  const projectRoot = join(root, "project");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(configDir, "agents"), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only reviewer.",
      "provider: codex",
      "model: gpt-5.4",
      "effort: high",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(configDir, "agents", "agy-reviewer.md"),
    ["---", "name: agy-reviewer", "description: Test Agy worker.", "provider: agy", "model: mock", "---", "", "Review only.", ""].join("\n"),
  );
  const mockAgyPath = join(root, "mock-agy.js");
  const descendantPidPath = join(root, "agy-descendant.pid");
  writeFileSync(mockAgyPath, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const prompt = process.argv[process.argv.indexOf("--print") + 1];
if (process.env.FORCE_MALFORMED) { console.log("{malformed"); process.exit(0); }
if (process.env.DESCENDANT_PID_FILE) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: "ignore", detached: true });
  require("node:fs").writeFileSync(process.env.DESCENDANT_PID_FILE, String(child.pid));
  child.unref();
}
const response = "mock response-" + "x".repeat(100000);
const payload = JSON.stringify({ status: "SUCCESS", conversation_id: "mock-session", response });
let index = 0;
function writeNextChunk() {
  if (index >= payload.length) { process.exit(0); }
  const chunk = payload.slice(index, index + 4096);
  index += 4096;
  process.stdout.write(chunk, writeNextChunk);
}
writeNextChunk();
`, { mode: 0o755 });
  const store = new LocalAgentStore(stateDir);
  const current = store.update(
    store.create({
      workspaceId: "ws_current",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
      model: "gpt-5.4",
      effort: "high",
    }).id,
    { status: "idle", latestResponse: "Review complete.", providerSessionId: "provider_secret" },
  );
  const other = store.update(
    store.create({
      workspaceId: "ws_other",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
    }).id,
    { status: "running", workerPid: process.pid, workerToken: "foreign-token" },
  );
  const successWorker = store.create({ workspaceId: "ws_current", workspaceRoot: projectRoot, profileName: "agy-reviewer", provider: "agy", model: "mock" });
  const successToken = "success-worker-token";
  store.prepareWorker(successWorker.id, successToken);
  const failureWorker = store.create({ workspaceId: "ws_current", workspaceRoot: projectRoot, profileName: "agy-reviewer", provider: "agy", model: "mock" });
  const failureToken = "failure-worker-token";
  store.prepareWorker(failureWorker.id, failureToken);
  store.close();

  const daemonSocket = localAgentDaemonPaths(stateDir).endpoint;
  const daemonRequests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const daemon = createNetServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        requestId: string;
        method: string;
        params?: Record<string, unknown>;
      };
      daemonRequests.push(request);
      if (request.method === "agent.start") {
        socket.end(encodeLocalAgentDaemonResponse({
          requestId: request.requestId,
          protocolVersion: 3,
          ok: false,
          error: {
            code: "UNKNOWN_TARGET",
            message: "Unknown subagent profile or provider: missing.",
            retryable: false,
            target: "missing",
          },
        }));
        return;
      }
      const result = request.method === "agent.list"
        ? [current]
        : request.method === "hello"
          ? {
              state: "ready",
              protocolVersion: 3,
              pid: process.pid,
              endpoint: daemonSocket,
              startedAt: "now",
              activeTurns: 0,
              runtimeCount: 0,
              clientConnections: 1,
            }
          : null;
      socket.end(encodeLocalAgentDaemonResponse({
        requestId: request.requestId,
        protocolVersion: 3,
        ok: true,
        result,
      }));
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    daemon.once("error", rejectListen);
    daemon.listen(daemonSocket, resolveListen);
  });

  try {
    const workerEnv = {
      ...process.env,
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_ALLOWED_ROOTS: projectRoot,
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_WORKSPACE_ID: "ws_current",
      DEVSPACE_WORKSPACE_ROOT: projectRoot,
      DEVSPACE_SUBAGENTS: "1",
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      AGY_COMMAND: mockAgyPath,
      DESCENDANT_PID_FILE: descendantPidPath,
    };
    const runWorker = async (worker: typeof successWorker, token: string, prompt: string) => {
      const promptDir = mkdtempSync(join(tmpdir(), "devspace-agent-prompt-"));
      const promptFile = join(promptDir, "prompt.txt");
      writeFileSync(promptFile, prompt);
      const child = spawn("node", ["--import", "tsx", "src/cli.ts", "agents", "__worker", worker.id, "--prompt-file", promptFile, "--worker-token", token], {
        cwd: process.cwd(), env: { ...workerEnv, DESCENDANT_PID_FILE: prompt === "success" ? descendantPidPath : "", FORCE_MALFORMED: prompt === "failure" ? "1" : "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const workerPid = child.pid;
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      const result = await new Promise<{ code: number | null; stderr: string }>((resolveWorker, rejectWorker) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); rejectWorker(new Error(`worker timeout: ${stderr}`)); }, 5_000);
        child.once("close", (code) => { clearTimeout(timer); resolveWorker({ code, stderr }); });
      });
      assert.equal(result.code, 0, result.stderr);
      if (workerPid) {
        assert.throws(() => process.kill(workerPid, 0), /ESRCH|不存在|not found/i);
      }
      assert.equal(existsSync(promptFile), false);
    };
    await runWorker(successWorker, successToken, "success");
    const successStore = new LocalAgentStore(stateDir);
    const completed = successStore.getById(successWorker.id)!;
    assert.equal(completed.status, "idle");
    assert.equal(completed.terminalReason, "completed");
    assert.equal(completed.providerSessionId, "mock-session");
    assert.equal(completed.latestResponse, "mock response-" + "x".repeat(100000));
    assert.equal(completed.workerPid, undefined);
    assert.equal(completed.workerToken, undefined);
    successStore.close();

    await runWorker(failureWorker, failureToken, "failure");
    const failureStore = new LocalAgentStore(stateDir);
    const failed = failureStore.getById(failureWorker.id)!;
    assert.equal(failed.status, "error");
    assert.equal(failed.terminalReason, "provider_error");
    assert.match(failed.error ?? "", /Failed to parse Agy JSON output/);
    assert.equal(failed.workerPid, undefined);
    assert.equal(failed.workerToken, undefined);
    failureStore.close();
    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    if (Number.isInteger(descendantPid) && descendantPid > 0) {
      try { process.kill(descendantPid, "SIGTERM"); } catch {}
    }

    const { stdout: output } = await execFileAsync("node", ["--import", "tsx", "src/cli.ts", "agents", "ls"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DEVSPACE_CONFIG_DIR: configDir,
        DEVSPACE_ALLOWED_ROOTS: projectRoot,
        DEVSPACE_STATE_DIR: stateDir,
        DEVSPACE_WORKSPACE_ID: "ws_current",
        DEVSPACE_WORKSPACE_ROOT: projectRoot,
        DEVSPACE_SUBAGENTS: "1",
        DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      },
    });

    assert.equal(output.trim(), `${current.id} completed reviewer`);

    const { stdout: jsonOutput } = await execFileAsync(
      "node",
      ["--import", "tsx", "src/cli.ts", "agents", "ls", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DEVSPACE_CONFIG_DIR: configDir,
          DEVSPACE_ALLOWED_ROOTS: projectRoot,
          DEVSPACE_STATE_DIR: stateDir,
          DEVSPACE_WORKSPACE_ID: "ws_current",
          DEVSPACE_WORKSPACE_ROOT: projectRoot,
          DEVSPACE_SUBAGENTS: "1",
          DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
        },
      },
    );
    assert.equal(
      jsonOutput,
      `${JSON.stringify([{ id: current.id, status: "completed", target: "reviewer" }])}\n`,
    );

    await assert.rejects(
      execFileAsync("node", ["--import", "tsx", "src/cli.ts", "agents", "cancel", "agt_missing"], {
        cwd: process.cwd(), encoding: "utf8", env: {
          ...process.env, DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_ALLOWED_ROOTS: projectRoot,
          DEVSPACE_STATE_DIR: stateDir, DEVSPACE_WORKSPACE_ID: "ws_current", DEVSPACE_WORKSPACE_ROOT: projectRoot,
          DEVSPACE_SUBAGENTS: "1", DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
        },
      }),
      (error: unknown) => {
        assert.match((error as { stderr?: string }).stderr ?? "", /Unknown subagent id: agt_missing/);
        assert.doesNotMatch((error as { stderr?: string }).stderr ?? "", /Unknown agents command: cancel/);
        return true;
      },
    );
    await assert.rejects(
      execFileAsync("node", ["--import", "tsx", "src/cli.ts", "agents", "cancel", other.id, "--json"], {
        cwd: process.cwd(), encoding: "utf8", env: {
          ...process.env, DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_ALLOWED_ROOTS: projectRoot,
          DEVSPACE_STATE_DIR: stateDir, DEVSPACE_WORKSPACE_ID: "ws_current", DEVSPACE_WORKSPACE_ROOT: projectRoot,
          DEVSPACE_SUBAGENTS: "1", DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
        },
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}").error;
        assert.equal(payload.code, "WORKER_TERMINATION_FAILED");
        assert.equal(payload.retryable, true);
        assert.equal(payload.operation, "cancel");
        assert.equal(payload.agentId, other.id);
        assert.equal(payload.provider, "codex");
        return true;
      },
    );
    await assert.rejects(
      execFileAsync("node", ["--import", "tsx", "src/cli.ts", "agents", "cancel", "agt_missing", "--json"], {
        cwd: process.cwd(), encoding: "utf8", env: {
          ...process.env, DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_ALLOWED_ROOTS: projectRoot,
          DEVSPACE_STATE_DIR: stateDir, DEVSPACE_WORKSPACE_ID: "ws_current", DEVSPACE_WORKSPACE_ROOT: projectRoot,
          DEVSPACE_SUBAGENTS: "1", DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
        },
      }),
      (error: unknown) => {
        const stdout = (error as { stdout?: string }).stdout ?? "";
        assert.equal(JSON.parse(stdout).error.code, "AGENT_NOT_FOUND");
        assert.match(JSON.parse(stdout).error.message, /Unknown subagent id: agt_missing/);
        return true;
      },
    );

    const { stdout: directOutput } = await execFileAsync(
      "node",
      ["--import", tsxLoader, cliPath, "agents", "ls"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          DEVSPACE_CONFIG_DIR: configDir,
          DEVSPACE_ALLOWED_ROOTS: stateDir,
          DEVSPACE_STATE_DIR: stateDir,
          DEVSPACE_SUBAGENTS: "1",
          DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
          DEVSPACE_WORKSPACE_ID: "",
          DEVSPACE_WORKSPACE_ROOT: stateDir,
        },
      },
    );
    assert.match(directOutput, new RegExp(current.id));
    const directList = [...daemonRequests].reverse().find((request) => request.method === "agent.list");
    assert.deepEqual(directList?.params, { workspaceRoot: realpathSync.native(projectRoot) });

    let commandFailure: unknown;
    try {
      await execFileAsync(
        "node",
        ["--import", "tsx", "src/cli.ts", "agents", "run", "missing", "--json", "inspect"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            DEVSPACE_CONFIG_DIR: configDir,
            DEVSPACE_ALLOWED_ROOTS: projectRoot,
            DEVSPACE_STATE_DIR: stateDir,
            DEVSPACE_WORKSPACE_ID: "ws_current",
            DEVSPACE_WORKSPACE_ROOT: projectRoot,
            DEVSPACE_SUBAGENTS: "1",
            DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
          },
        },
      );
    } catch (error) {
      commandFailure = error;
    }
    assert.ok(commandFailure, "structured CLI errors should exit non-zero");
    const stdout = (commandFailure as { stdout?: string }).stdout ?? "";
    const payload = JSON.parse(stdout) as {
      error: { code: string; message: string; retryable: boolean; target: string };
    };
    assert.equal(payload.error.code, "UNKNOWN_TARGET");
    assert.equal(payload.error.message, "Unknown subagent profile or provider: missing.");
    assert.equal(payload.error.retryable, false);
    assert.equal(payload.error.target, "missing");

    await assert.rejects(
      execFileAsync(
        "node",
        [
          "--import",
          "tsx",
          "src/cli.ts",
          "agents",
          "run",
          "codex",
          "--model",
          "--unknown",
          "inspect",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            DEVSPACE_CONFIG_DIR: configDir,
            DEVSPACE_ALLOWED_ROOTS: projectRoot,
            DEVSPACE_STATE_DIR: stateDir,
            DEVSPACE_WORKSPACE_ID: "ws_current",
            DEVSPACE_WORKSPACE_ROOT: projectRoot,
            DEVSPACE_SUBAGENTS: "1",
            DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
          },
        },
      ),
      (error: unknown) => {
        assert.match((error as { stderr?: string }).stderr ?? "", /Unknown option: --unknown/);
        return true;
      },
    );

    await assert.rejects(
      execFileAsync(
        "node",
        [
          "--import",
          "tsx",
          "src/cli.ts",
          "agents",
          "__worker",
          "agt_missing",
          "--prompt-file",
          "/dev/null",
          "--worker-token",
          "diagnostic-token",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            DEVSPACE_CONFIG_DIR: configDir,
            DEVSPACE_ALLOWED_ROOTS: projectRoot,
            DEVSPACE_STATE_DIR: stateDir,
            DEVSPACE_WORKSPACE_ID: "ws_current",
            DEVSPACE_WORKSPACE_ROOT: projectRoot,
            DEVSPACE_SUBAGENTS: "1",
            DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
          },
        },
      ),
      (error: unknown) => {
        const stderr = (error as { stderr?: string }).stderr ?? "";
        assert.match(stderr, /Unknown subagent id: agt_missing/);
        assert.doesNotMatch(stderr, /Unknown agents command: __worker/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      daemon.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }

  assert.equal(loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  }).subagents.enabled, true);
} finally {
  rmSync(root, { recursive: true, force: true });
}
