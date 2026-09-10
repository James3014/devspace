import assert from "node:assert/strict";
import test from "node:test";
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

function compileWindowsAgyExecutable(executable: string): void {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const compiler = systemRoot
    ? join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
    : "";
  if (!compiler || !existsSync(compiler)) {
    throw new Error(`Windows native Agy fixture compiler is unavailable: ${compiler || "SystemRoot"}`);
  }
  const source = `${executable}.cs`;
  writeFileSync(source, String.raw`using System;
using System.Diagnostics;
using System.IO;

class Program {
  static void Main() {
    if (Environment.GetEnvironmentVariable("FORCE_MALFORMED") == "1") {
      Console.Write("{malformed");
      return;
    }
    var descendantPath = Environment.GetEnvironmentVariable("DESCENDANT_PID_FILE");
    if (!String.IsNullOrEmpty(descendantPath)) {
      var node = Environment.GetEnvironmentVariable("NODE_EXEC_PATH");
      var child = Process.Start(new ProcessStartInfo {
        FileName = node,
        Arguments = "-e \"setTimeout(() => {}, 3000)\"",
        UseShellExecute = false,
        RedirectStandardInput = true,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
      });
      child.StandardInput.Close();
      File.WriteAllText(descendantPath, child.Id.ToString());
    }
    var response = "{\"status\":\"SUCCESS\",\"conversation_id\":\"mock-session\",\"response\":\"mock response-"
      + new String('x', 100000) + "\"}";
    Console.Write(response);
  }
}
`);
  try {
    execFileSync(compiler, ["/nologo", "/target:exe", `/out:${executable}`, source], { stdio: "ignore" });
  } finally {
    rmSync(source, { force: true });
  }
}

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

for (const args of [
  ["cutover", "observe", "--cutover-id", "c", "--workspace-id", "w"],
  ["cutover", "observe", "--cutover-id", "c", "--workspace-id", "w", "--agent-id", "a", "--server-url", "https://foreign.invalid/mcp"],
  ["cutover", "observe", "--cutover-id", "", "--workspace-id", "w", "--agent-id", "a"],
  ["cutover", "observe", "--cutover-id", "c", "--workspace-id", "", "--agent-id", "a"],
  ["cutover", "observe", "--cutover-id", "c", "--workspace-id", "w", "--agent-id", ""],
]) {
  assert.throws(
    () => execFileSync("node", ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf8", env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-invalid-binding-test" } }),
    (error: unknown) => {
      const detail = error as { stderr?: string; status?: number };
      return detail.status !== 0 && /Usage:|Unknown cutover observe flag|requires a value/.test(detail.stderr ?? "");
    },
  );
}

const root = mkdtempSync(join(tmpdir(), "devspace-cli-agents-test-"));
// A fresh production-tsconfig compilation keeps tsx cold loading outside the
// worker exit deadline. Both direct and CI-wrapper invocations use this fixture.
const compiledWorkerDir = mkdtempSync(join(process.cwd(), ".cli-worker-build-"));
try {
  const compilationStarted = performance.now();
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json", "--outDir", compiledWorkerDir], { cwd: process.cwd(), stdio: "pipe", timeout: 120000 });
  const compiledWorkerEntry = join(compiledWorkerDir, "cli.js");
  assert.equal(existsSync(compiledWorkerEntry), true);
  console.error(`[cli-worker-build] elapsedMs=${Math.round(performance.now() - compilationStarted)}`);
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
  const mockAgyPath = join(root, process.platform === "win32" ? "mock-agy.exe" : "mock-agy.js");
  const descendantPidPath = join(root, "agy-descendant.pid");
  if (process.platform === "win32") {
    compileWindowsAgyExecutable(mockAgyPath);
  } else {
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
  }
  const store = new LocalAgentStore(stateDir);
  let current: ReturnType<LocalAgentStore["update"]>;
  let other: ReturnType<LocalAgentStore["update"]>;
  let successWorker: ReturnType<LocalAgentStore["create"]>;
  let failureWorker: ReturnType<LocalAgentStore["create"]>;
  const successToken = "success-worker-token";
  const failureToken = "failure-worker-token";
  try {
    current = store.update(
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
    other = store.update(
    store.create({
      workspaceId: "ws_other",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
    }).id,
    { status: "running", workerPid: process.pid, workerToken: "foreign-token" },
    );
    successWorker = store.create({ workspaceId: "ws_current", workspaceRoot: projectRoot, profileName: "agy-reviewer", provider: "agy", model: "mock" });
    store.prepareWorker(successWorker.id, successToken);
    failureWorker = store.create({ workspaceId: "ws_current", workspaceRoot: projectRoot, profileName: "agy-reviewer", provider: "agy", model: "mock" });
    store.prepareWorker(failureWorker.id, failureToken);
  } finally {
    store.close();
  }

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
      NODE_EXEC_PATH: process.execPath,
      DESCENDANT_PID_FILE: descendantPidPath,
    };
    const runWorker = async (worker: typeof successWorker, token: string, prompt: string) => {
      const promptDir = mkdtempSync(join(tmpdir(), "devspace-agent-prompt-"));
      const promptFile = join(promptDir, "prompt.txt");
      writeFileSync(promptFile, prompt);
      const child = spawn(process.execPath, [compiledWorkerEntry, "agents", "__worker", worker.id, "--prompt-file", promptFile, "--worker-token", token], {
        cwd: process.cwd(), env: { ...workerEnv, DESCENDANT_PID_FILE: prompt === "success" ? descendantPidPath : "", FORCE_MALFORMED: prompt === "failure" ? "1" : "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const workerPid = child.pid;
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      const milestones: Record<string, unknown> = { executable: process.execPath, pid: workerPid };
      let stderr = "", stdout = "", stderrTruncated = false, stdoutTruncated = false;
      const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
        milestones.firstOutputMs ??= elapsed();
        const text = chunk.toString();
        if (stream === "stderr") { stderrTruncated ||= stderr.length + text.length > 8192; stderr = (stderr + text).slice(-8192); }
        else { stdoutTruncated ||= stdout.length + text.length > 8192; stdout = (stdout + text).slice(-8192); }
      };
      child.stdout.on("data", chunk => capture("stdout", chunk));
      child.stderr.on("data", chunk => capture("stderr", chunk));
      const result = await new Promise<{ code: number | null; stderr: string }>((resolveWorker, rejectWorker) => {
        let settled = false, timedOut = false;
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error, code: number | null = null) => {
          if (settled) return;
          settled = true; clearTimeout(timer); if (cleanupTimer) clearTimeout(cleanupTimer);
          child.removeListener("close", onClose); child.removeListener("error", onError);
          if (error) rejectWorker(error); else resolveWorker({ code, stderr });
        };
        const details = () => JSON.stringify({ ...milestones, stderr, stdout, stderrTruncated, stdoutTruncated });
        const onClose = (code: number | null) => {
          milestones.closeMs = elapsed();
          if (timedOut) finish(new Error(`worker timeout: ${details()}`));
          else { console.error(`[cli-worker-diagnostic] ${JSON.stringify(milestones)}`); finish(undefined, code); }
        };
        const onError = (error: Error) => finish(new Error(`worker spawn error: ${error.message}; ${details()}`));
        child.once("spawn", () => { milestones.spawnMs = elapsed(); });
        child.once("close", onClose); child.once("error", onError);
        const timer = setTimeout(() => {
          timedOut = true; milestones.timeoutMs = elapsed();
          try {
            const snapshot = new LocalAgentStore(stateDir);
            try { const row = snapshot.getById(worker.id); milestones.worker = row ? { status: row.status, terminalReason: row.terminalReason, workerPid: row.workerPid } : "missing"; }
            finally { snapshot.close(); }
          } catch { milestones.worker = "diagnostic-read-failed"; }
          child.kill("SIGKILL");
          cleanupTimer = setTimeout(() => finish(new Error(`worker timeout; cleanup close not observed: ${details()}`)), 2000);
        }, 5_000);
      });
      assert.equal(result.code, 0, result.stderr);
      if (workerPid) {
        assert.throws(() => process.kill(workerPid, 0), /ESRCH|不存在|not found/i);
      }
      assert.equal(existsSync(promptFile), false);
    };
    await runWorker(successWorker, successToken, "success");
    const successStore = new LocalAgentStore(stateDir);
    try {
      const completed = successStore.getById(successWorker.id)!;
      assert.equal(completed.status, "idle");
      assert.equal(completed.terminalReason, "completed");
      assert.equal(completed.providerSessionId, "mock-session");
      assert.equal(completed.latestResponse, "mock response-" + "x".repeat(100000));
      assert.equal(completed.workerPid, undefined);
      assert.equal(completed.workerToken, undefined);
    } finally {
      successStore.close();
    }

    await runWorker(failureWorker, failureToken, "failure");
    const failureStore = new LocalAgentStore(stateDir);
    try {
      const failed = failureStore.getById(failureWorker.id)!;
      assert.equal(failed.status, "error");
      assert.equal(failed.terminalReason, "provider_error");
      assert.match(failed.error ?? "", /Failed to parse Agy JSON output/);
      assert.equal(failed.workerPid, undefined);
      assert.equal(failed.workerToken, undefined);
    } finally {
      failureStore.close();
    }
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
  rmSync(compiledWorkerDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

test("serve rejects incomplete coordination reader selection before listening", async () => {
  await assert.rejects(execFileAsync(process.execPath, ["--import", tsxLoader, cliPath, "serve", "--coordination-reader-module", "relative.mjs"], { timeout: 15000 }), error => {
    const result = error as Error & { stdout?: string; stderr?: string };
    assert.match(result.stderr ?? "", /absolute .mjs path and its SHA-256 together/);
    assert.doesNotMatch(result.stdout ?? "", /devspace listening/);
    return true;
  });
});
