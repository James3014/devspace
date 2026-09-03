import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ServerConfig } from "./config.js";
import { createServer as createDevMcpServer } from "./server.js";

const OWNER_TOKEN = "test-owner-token-that-is-long-enough";
let portCounter = 19_000;

interface RunningServer {
  baseUrl: string;
  stateDir: string;
  close: () => Promise<void>;
}

async function startServer(): Promise<RunningServer> {
  const root = await mkdtemp(join(tmpdir(), "devspace-cutover-http-"));
  const stateDir = join(root, ".state");
  const port = String(portCounter++);
  const loadedConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: OWNER_TOKEN,
    PORT: port,
  });
  const app = createDevMcpServer(loadedConfig as ServerConfig);
  const httpServer = createServer(app.app);
  await new Promise<void>((resolve) => httpServer.listen(Number(port), resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stateDir,
    close: async () => {
      await app.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("cutover HTTP: drain requires owner token, then rejects new MCP init", async () => {
  const running = await startServer();
  try {
    const noAuth = await fetch(`${running.baseUrl}/api/cutover/drain`, {
      method: "POST",
    });
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`${running.baseUrl}/api/cutover/drain`, {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as Record<string, unknown>;
    assert.equal(body.status, "drained");
    assert.equal(body.reconnectRequired, true);

    const health = await fetch(`${running.baseUrl}/healthz`);
    const healthBody = (await health.json()) as Record<string, unknown>;
    assert.equal((healthBody.mcp as Record<string, unknown>).draining, true);
  } finally {
    await running.close();
  }
});

test("cutover HTTP: only one concurrent drain wins the deployment lease (race)", async () => {
  const running = await startServer();
  try {
    const [first, second] = await Promise.all([
      fetch(`${running.baseUrl}/api/cutover/drain`, {
        method: "POST",
        headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      }),
      fetch(`${running.baseUrl}/api/cutover/drain`, {
        method: "POST",
        headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      }),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const loser = first.status === 409 ? first : second;
    const body = (await loser.json()) as Record<string, unknown>;
    assert.equal(body.error, "cutover_lease_held");
  } finally {
    await running.close();
  }
});

test("cutover HTTP: finish releases the lease and clears drain state", async () => {
  const running = await startServer();
  try {
    await fetch(`${running.baseUrl}/api/cutover/drain`, {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    const finish = await fetch(`${running.baseUrl}/api/cutover/finish`, {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    assert.equal(finish.status, 200);
    const body = (await finish.json()) as Record<string, unknown>;
    assert.equal(body.released, true);

    const status = await fetch(`${running.baseUrl}/api/cutover/status`);
    const statusBody = (await status.json()) as Record<string, unknown>;
    assert.equal(statusBody.draining, false);
  } finally {
    await running.close();
  }
});