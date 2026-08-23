import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNodeServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const claudeCommand = process.env.CLAUDE_COMMAND
  ?? (process.platform === "win32" ? "claude.cmd" : "claude");
const hostTimeoutMs = 120_000;
const hostOutputLimit = 10 * 1024 * 1024;
const ownerToken = randomBytes(32).toString("base64url");
const marker = `devspace-host-${randomBytes(16).toString("hex")}`;
const port = await availablePort();
const temporaryRoot = await mkdtemp(join(tmpdir(), "devspace-claude-host-"));
const workspaceRoot = join(temporaryRoot, "workspace");
const baseUrl = new URL(`http://127.0.0.1:${port}`);
const mcpUrl = new URL("/mcp", baseUrl);
let serverProcess;
let verifier;

try {
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "marker.txt"), marker);

  serverProcess = startDevspace();
  await waitForServer(serverProcess);

  const accessToken = await authorize();
  const mcpConfigPath = join(temporaryRoot, "claude-mcp.json");
  await writeFile(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        devspace: {
          type: "http",
          url: mcpUrl.href,
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      },
    }),
    { mode: 0o600 },
  );

  const observed = await runClaude(mcpConfigPath);
  assert.equal(observed.marker, marker, "Claude must return the marker read through DevSpace");

  verifier = new Client({ name: "devspace-host-verifier", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  await verifier.connect(transport);

  const readResult = await verifier.callTool({
    name: "read",
    arguments: { workspaceId: observed.workspaceId, path: "marker.txt" },
  });
  const verified = z.object({ result: z.string() }).parse(readResult.structuredContent);
  assert.ok(
    verified.result.includes(marker),
    "The workspaceId returned by Claude must remain usable through the MCP interface",
  );

  console.log(`Claude read an unknown marker through DevSpace workspace ${observed.workspaceId}.`);
} finally {
  await verifier?.close().catch(() => undefined);
  if (serverProcess) await stopProcess(serverProcess.child);
  await rm(temporaryRoot, { recursive: true, force: true });
}

function startDevspace() {
  const child = spawn(process.execPath, [join(repositoryRoot, "dist", "cli.js"), "serve"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DEVSPACE_AGENT_DIR: join(temporaryRoot, "agent"),
      DEVSPACE_ALLOWED_HOSTS: "127.0.0.1",
      DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
      DEVSPACE_ARTIFACTS: "0",
      DEVSPACE_CONFIG_DIR: join(temporaryRoot, "config"),
      DEVSPACE_LOG_LEVEL: "error",
      DEVSPACE_LOG_REQUESTS: "0",
      DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
      DEVSPACE_PUBLIC_BASE_URL: baseUrl.href,
      DEVSPACE_SKILLS: "0",
      DEVSPACE_STATE_DIR: join(temporaryRoot, "state"),
      DEVSPACE_SUBAGENTS: "0",
      DEVSPACE_TOOL_MODE: "minimal",
      DEVSPACE_WIDGETS: "off",
      DEVSPACE_WORKTREE_ROOT: join(temporaryRoot, "worktrees"),
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectOutput(child);
  let spawnError;
  child.once("error", (error) => {
    spawnError = error;
  });
  return { child, output, spawnError: () => spawnError };
}

async function waitForServer(server) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.spawnError()) throw server.spawnError();
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`DevSpace exited before becoming ready.\n${server.output()}`);
    }

    try {
      const response = await fetch(new URL("/healthz", baseUrl), {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The exact startup instant is outside the test process, so readiness is
      // bounded by the deadline instead of inferred from a log line.
    }
    await delay(100);
  }
  throw new Error(`DevSpace did not become ready within 10 seconds.\n${server.output()}`);
}

async function authorize() {
  const redirectUri = new URL("/oauth-callback", baseUrl).href;
  const registrationResponse = await fetch(new URL("/register", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "DevSpace Claude host test",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registrationResponse.status, 201);
  const registration = z.object({ client_id: z.string() }).passthrough().parse(
    await registrationResponse.json(),
  );

  const codeVerifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const authorizationResponse = await fetch(new URL("/authorize", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "devspace",
      state,
      resource: mcpUrl.href,
      owner_token: ownerToken,
    }),
  });
  assert.equal(authorizationResponse.status, 302);
  const location = authorizationResponse.headers.get("location");
  assert.ok(location);
  const authorizationResult = new URL(location);
  assert.equal(authorizationResult.searchParams.get("state"), state);
  const code = authorizationResult.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(new URL("/token", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      resource: mcpUrl.href,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  return z.object({ access_token: z.string() }).passthrough().parse(
    await tokenResponse.json(),
  ).access_token;
}

async function runClaude(mcpConfigPath) {
  const outputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      marker: { type: "string" },
      workspaceId: { type: "string" },
    },
    required: ["marker", "workspaceId"],
  };
  const prompt = [
    "Use only the DevSpace MCP tools.",
    `Open the checkout workspace at ${workspaceRoot}.`,
    "Read marker.txt and return its exact contents and the workspaceId from open_workspace.",
    "Do not guess either value.",
  ].join(" ");
  const args = [
    "--print",
    "--output-format", "json",
    "--json-schema", JSON.stringify(outputSchema),
    "--mcp-config", mcpConfigPath,
    "--strict-mcp-config",
    "--setting-sources", "",
    "--tools", "",
    "--allowedTools", "mcp__devspace__open_workspace,mcp__devspace__read",
    "--permission-mode", "dontAsk",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--model", "sonnet",
    "--max-budget-usd", "0.25",
    prompt,
  ];

  let execution;
  try {
    execution = await runHostProcess(args);
  } catch (cause) {
    const stdout = cause && typeof cause === "object" && "stdout" in cause
      && typeof cause.stdout === "string" ? cause.stdout.trim() : "";
    const stderr = cause && typeof cause === "object" && "stderr" in cause
      && typeof cause.stderr === "string" ? cause.stderr.trim() : "";
    throw new Error(
      ["Claude host execution failed.", stdout, stderr].filter(Boolean).join("\n"),
      { cause },
    );
  }

  let rawResult;
  try {
    rawResult = JSON.parse(execution.stdout);
  } catch (cause) {
    throw new Error(`Claude did not return JSON.\n${execution.stdout.trim()}`, { cause });
  }
  const envelope = z.object({
    type: z.literal("result"),
    subtype: z.string(),
    is_error: z.boolean(),
    structured_output: z.unknown().optional(),
  }).passthrough().parse(rawResult);
  assert.equal(envelope.subtype, "success", `Claude ended with ${envelope.subtype}`);
  assert.equal(envelope.is_error, false, "Claude reported an error result");
  return z.object({ marker: z.string(), workspaceId: z.string().min(1) }).parse(
    envelope.structured_output,
  );
}

async function runHostProcess(args) {
  const child = spawn(claudeCommand, args, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let timedOut = false;
  let outputExceeded = false;
  let forceKillTimeout;

  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    forceKillTimeout ??= setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5_000);
  };

  const append = (target, chunk) => {
    const text = String(chunk);
    outputBytes += Buffer.byteLength(text);
    if (outputBytes > hostOutputLimit && !outputExceeded) {
      outputExceeded = true;
      terminate();
      return;
    }
    if (!outputExceeded && target === "stdout") stdout += text;
    else if (!outputExceeded) stderr += text;
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));

  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, hostTimeoutMs);

  try {
    const { code, signal } = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    if (outputExceeded) {
      throw Object.assign(new Error("Claude host output exceeded 10 MiB."), { stdout, stderr });
    }
    if (timedOut) {
      throw Object.assign(new Error("Claude host exceeded the 120 second deadline."), {
        stdout,
        stderr,
      });
    }
    if (code !== 0) {
      throw Object.assign(new Error(`Claude host exited with ${code ?? signal}.`), {
        stdout,
        stderr,
      });
    }
    return { stdout, stderr };
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceKillTimeout);
    if (child.exitCode === null && child.signalCode === null) await stopProcess(child);
  }
}

function collectOutput(child) {
  let output = "";
  const append = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-256_000);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return () => output.trim();
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolveClose) => child.once("close", resolveClose));
  if (!child.kill("SIGTERM")) return;
  const stopped = await Promise.race([closed.then(() => true), delay(5_000, false)]);
  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
    await closed;
  }
}

async function availablePort() {
  const server = createNodeServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const selectedPort = address.port;
  await new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return selectedPort;
}
