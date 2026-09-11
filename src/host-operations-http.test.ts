import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function structured(result: ToolResult): Record<string, any> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  if (result.structuredContent) return result.structuredContent as Record<string, any>;
  const text = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  assert.ok(text, "expected structured tool output");
  return JSON.parse(text);
}

function requestFor(root: string, executable: string, script: string, marker: string, workspaceRoot?: string, readPaths = [script]) {
  return {
    attemptKey: "host-http-attempt",
    executablePath: executable,
    argv: [script, marker],
    cwd: root,
    allowedPaths: { write: [root], read: readPaths },
    maxWallMs: 8_000,
    maxIdleMs: 8_000,
    allowLongLivedProcess: true,
    ...(workspaceRoot ? { workspaceRoot } : {}),
  };
}

function fixtureRuntimeReadPaths(script: string): string[] {
  return [script, "/opt/homebrew/etc/openssl@3/openssl.cnf", "/opt/homebrew/opt/libuv/lib/libuv.1.dylib"].filter((path) => path === script || existsSync(path));
}

async function assertDead(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`host operation process ${pid} remained alive after cancellation`);
}

async function waitForMarker(path: string, expected = "x\n"): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      if (readFileSync(path, "utf8") === expected) return;
    } catch { /* fixture has not written its marker yet */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("host operation fixture did not write its marker before the deadline");
}

async function issueToken(provider: SingleUserOAuthProvider, config: ReturnType<typeof loadConfig>, name: string) {
  const client = await provider.clientsStore.registerClient!({
    redirect_uris: ["http://localhost/callback"],
    client_name: name,
    token_endpoint_auth_method: "none",
  });
  let redirect = "";
  await provider.authorize(client, {
    redirectUri: "http://localhost/callback",
    codeChallenge: `${name}-challenge`,
    scopes: config.oauth.scopes,
    resource: new URL("/mcp", config.publicBaseUrl),
  }, {
    req: { method: "POST", body: { owner_token: config.oauth.ownerToken } },
    redirect: (_status: number, url: string) => { redirect = url; },
  } as never);
  return {
    clientId: client.client_id,
    accessToken: (await provider.exchangeAuthorizationCode(client, new URL(redirect).searchParams.get("code")!)).access_token,
  };
}

async function connect(url: URL, accessToken: string, name: string): Promise<Client> {
  const client = new Client({ name, version: "1" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}

test("HTTP host operation tools enforce owner binding and exact long-lived lifecycle", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-host-http-"));
  const configRoot = join(root, "config");
  const stateRoot = join(root, "state");
  const script = join(root, "fixture.mjs");
  const runtimeReadPaths = fixtureRuntimeReadPaths(script);
  const effectsRoot = join(root, "effects");
  const workspaceRoot = join(root, "workspace");
  const marker = join(effectsRoot, "marker.txt");
  await mkdir(effectsRoot);
  await mkdir(workspaceRoot);
  execFileSync("git", ["init", "-q", workspaceRoot]);
  execFileSync("git", ["-C", workspaceRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture"], { stdio: "ignore" });
  const baseHead = execFileSync("git", ["-C", workspaceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const executable = process.execPath;
  const executableSha256 = createHash("sha256").update(await readFile(executable)).digest("hex");
  writeFileSync(script, `import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], "x\\n");\nsetInterval(() => {}, 1000);\nsetTimeout(() => process.exit(0), 8000);\n`);
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configRoot,
    DEVSPACE_STATE_DIR: stateRoot,
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
    DEVSPACE_SUBAGENTS: "false",
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  const provider = new SingleUserOAuthProvider(config.oauth, new URL("/mcp", config.publicBaseUrl), config.stateDir);
  const owner = await issueToken(provider, config, "host-owner");
  Object.assign(config as any, {
    hostOperationsEnabled: true,
    hostOperationExecutable: executable,
    hostOperationExecutableSha256: executableSha256,
    hostOperationAllowedPaths: [effectsRoot],
    hostOperationReadPaths: runtimeReadPaths,
    hostOperationOwnerClientId: owner.clientId,
    hostOperationCwd: root,
    hostOperationArgv: [script, marker],
    hostOperationMaxWallMs: 8_000,
    hostOperationMaxIdleMs: 8_000,
    hostOperationAllowLongLived: true,
  });
  const running = createServer(config);
  const listener = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const url = new URL(`http://127.0.0.1:${(listener.address() as { port: number }).port}/mcp`);
  let ownerClient = await connect(url, owner.accessToken, "host-owner-http");
  const foreign = await issueToken(provider, config, "host-foreign");
  const foreignClient = await connect(url, foreign.accessToken, "host-foreign-http");
  const request = {
    ...requestFor(root, executable, script, marker, workspaceRoot, runtimeReadPaths),
    allowedPaths: { write: [effectsRoot], read: runtimeReadPaths },
    clientId: foreign.clientId,
    authorityMode: "NEXUS_GOVERNED",
  } as any;
  let operationId: string | undefined;
  try {
    const tools = await ownerClient.listTools();
    for (const name of ["host_operation_preflight", "host_operation_start", "host_operation_status", "host_operation_reconcile", "host_operation_cancel"]) {
      assert.ok(tools.tools.some((tool) => tool.name === name), `missing ${name}`);
    }

    const preflight = structured(await ownerClient.callTool({ name: "host_operation_preflight", arguments: request }));
    assert.equal(preflight.status, "ready");
    const started = structured(await ownerClient.callTool({ name: "host_operation_start", arguments: request }));
    assert.equal(started.status, "started", JSON.stringify(started));
    assert.equal(started.authorityMode, "OWNER_DIRECT");
    assert.equal(started.request.clientId, owner.clientId);
    assert.equal(started.receipt.repository.preHead, baseHead);
    assert.equal(started.receipt.repository.preDirty, false);
    operationId = started.operationId;
    await waitForMarker(marker);

    await ownerClient.close();
    ownerClient = await connect(url, owner.accessToken, "host-owner-http-reconnected");
    assert.equal(structured(await ownerClient.callTool({ name: "host_operation_status", arguments: { operationId: started.operationId } })).status, "started");
    assert.equal(structured(await ownerClient.callTool({ name: "host_operation_reconcile", arguments: { operationId: started.operationId } })).status, "started");

    const replay = await ownerClient.callTool({ name: "host_operation_start", arguments: request });
    assert.equal(replay.isError, true, "same-attempt replay must not spawn a duplicate process");
    assert.equal(readFileSync(marker, "utf8"), "x\n");

    const status = structured(await ownerClient.callTool({ name: "host_operation_status", arguments: { operationId: started.operationId } }));
    assert.equal(status.status, "started");
    const reconciled = structured(await ownerClient.callTool({ name: "host_operation_reconcile", arguments: { operationId: started.operationId } }));
    assert.equal(reconciled.status, "started");
    const cancelled = structured(await ownerClient.callTool({ name: "host_operation_cancel", arguments: { operationId: started.operationId } }));
    assert.equal(cancelled.status, "failed");
    assert.equal(cancelled.errorCode, "CANCELLED");
    assert.equal(cancelled.receipt.repository.postHead, baseHead);
    assert.equal(cancelled.receipt.repository.postDirty, false);
    assert.equal(typeof started.receipt?.process?.pid, "number");
    await assertDead(started.receipt.process.pid);
    assert.equal(structured(await ownerClient.callTool({ name: "host_operation_status", arguments: { operationId: started.operationId } })).status, "failed");

    const concurrentRequest = { ...request, attemptKey: "concurrent-start" };
    const concurrentResults = await Promise.all([
      ownerClient.callTool({ name: "host_operation_start", arguments: concurrentRequest }),
      ownerClient.callTool({ name: "host_operation_start", arguments: concurrentRequest }),
    ]);
    const concurrentSuccess = concurrentResults.find((result) => !result.isError);
    assert.ok(concurrentSuccess, "one concurrent start must return the durable operation");
    const concurrent = structured(concurrentSuccess);
    assert.equal(concurrent.status, "started");
    await waitForMarker(marker, "x\nx\n");
    assert.equal(readFileSync(marker, "utf8"), "x\nx\n", "concurrent same-attempt start must produce one additional effect");
    const concurrentCancelled = structured(await ownerClient.callTool({ name: "host_operation_cancel", arguments: { operationId: concurrent.operationId } }));
    assert.equal(concurrentCancelled.errorCode, "CANCELLED");

    const foreignCalls: Array<Promise<ToolResult>> = [
      foreignClient.callTool({ name: "host_operation_preflight", arguments: request }),
      foreignClient.callTool({ name: "host_operation_start", arguments: request }),
      foreignClient.callTool({ name: "host_operation_status", arguments: { operationId: started.operationId } }),
      foreignClient.callTool({ name: "host_operation_reconcile", arguments: { operationId: started.operationId } }),
      foreignClient.callTool({ name: "host_operation_cancel", arguments: { operationId: started.operationId } }),
    ];
    for (const result of await Promise.all(foreignCalls)) assert.equal(result.isError, true, "foreign authenticated client must be denied");

    const differentArgv = { ...request, attemptKey: "different-argv", argv: [script, join(root, "other-marker.txt")] };
    assert.equal((await ownerClient.callTool({ name: "host_operation_preflight", arguments: differentArgv })).isError, true);
  } finally {
    if (operationId) await ownerClient.callTool({ name: "host_operation_cancel", arguments: { operationId } }).catch(() => {});
    await ownerClient.close().catch(() => {});
    await foreignClient.close().catch(() => {});
    await running.close();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP server omits host operation tools when startup capability is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-host-http-disabled-"));
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_STATE_DIR: join(root, "state"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
    DEVSPACE_SUBAGENTS: "false",
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  const provider = new SingleUserOAuthProvider(config.oauth, new URL("/mcp", config.publicBaseUrl), config.stateDir);
  const owner = await issueToken(provider, config, "host-disabled");
  const running = createServer(config);
  const listener = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const client = await connect(new URL(`http://127.0.0.1:${(listener.address() as { port: number }).port}/mcp`), owner.accessToken, "host-disabled-http");
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.some((name) => name.startsWith("host_operation_")), false);
  } finally {
    await client.close().catch(() => {});
    await running.close();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP completed host operation replay returns the recorded effect without rerunning it", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-host-http-replay-"));
  const script = join(root, "short-fixture.mjs");
  const runtimeReadPaths = fixtureRuntimeReadPaths(script);
  const marker = join(root, "marker.txt");
  const executable = process.execPath;
  const executableSha256 = createHash("sha256").update(await readFile(executable)).digest("hex");
  writeFileSync(script, `import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], "x\\n");\n`);
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_STATE_DIR: join(root, "state"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
    DEVSPACE_SUBAGENTS: "false",
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  const provider = new SingleUserOAuthProvider(config.oauth, new URL("/mcp", config.publicBaseUrl), config.stateDir);
  const owner = await issueToken(provider, config, "host-replay-owner");
  Object.assign(config as any, {
    hostOperationsEnabled: true,
    hostOperationExecutable: executable,
    hostOperationExecutableSha256: executableSha256,
    hostOperationAllowedPaths: [root],
    hostOperationReadPaths: runtimeReadPaths,
    hostOperationOwnerClientId: owner.clientId,
    hostOperationCwd: root,
    hostOperationArgv: [script, marker],
    hostOperationMaxWallMs: 8_000,
    hostOperationMaxIdleMs: 8_000,
    hostOperationAllowLongLived: false,
  });
  const running = createServer(config);
  const listener = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const client = await connect(new URL(`http://127.0.0.1:${(listener.address() as { port: number }).port}/mcp`), owner.accessToken, "host-replay-http");
  const request = requestFor(root, executable, script, marker, undefined, runtimeReadPaths);
  const shortRequest = { ...request, allowLongLivedProcess: false };
  try {
    const first = structured(await client.callTool({ name: "host_operation_start", arguments: shortRequest }));
    assert.equal(first.status, "succeeded");
    await waitForMarker(marker);
    const replay = structured(await client.callTool({ name: "host_operation_start", arguments: shortRequest }));
    assert.equal(replay.status, "succeeded");
    assert.equal(replay.operationId, first.operationId);
    assert.equal(readFileSync(marker, "utf8"), "x\n");
  } finally {
    await client.close().catch(() => {});
    await running.close();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
