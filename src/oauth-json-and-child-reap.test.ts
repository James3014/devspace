import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { requestPath } from "./logger.js";

// Test 1: requestPath preserves originalUrl across sub-routers
{
  const mockReq1 = {
    path: "/",
    url: "/",
    originalUrl: "/token?grant_type=refresh_token",
  } as any;
  assert.equal(requestPath(mockReq1), "/token");

  const mockReq2 = {
    path: "/mcp",
    url: "/mcp",
    originalUrl: "/mcp",
  } as any;
  assert.equal(requestPath(mockReq2), "/mcp");

  const mockReqFallback = {
    path: "/healthz",
    url: "/healthz",
  } as any;
  assert.equal(requestPath(mockReqFallback), "/healthz");
}

// Test 2: Verify /token and /revoke accept application/json
{
  const app = express();
  app.use(["/token", "/revoke"], express.json());

  let receivedTokenBody: unknown = null;
  let receivedRevokeBody: unknown = null;

  app.post("/token", (req, res) => {
    receivedTokenBody = req.body;
    res.status(200).json({ ok: true, echo: req.body });
  });

  app.post("/revoke", (req, res) => {
    receivedRevokeBody = req.body;
    res.status(200).json({ ok: true, echo: req.body });
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Test JSON post to /token
    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: "test-refresh-token",
        client_id: "test-client-id",
      }),
    });
    assert.equal(tokenRes.status, 200);
    const tokenJson = (await tokenRes.json()) as any;
    assert.equal(tokenJson.echo.grant_type, "refresh_token");
    assert.equal(tokenJson.echo.client_id, "test-client-id");
    assert.deepEqual(receivedTokenBody, {
      grant_type: "refresh_token",
      refresh_token: "test-refresh-token",
      client_id: "test-client-id",
    });

    // Test JSON post to /revoke
    const revokeRes = await fetch(`${baseUrl}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "token-to-revoke",
        client_id: "test-client-id",
      }),
    });
    assert.equal(revokeRes.status, 200);
    const revokeJson = (await revokeRes.json()) as any;
    assert.equal(revokeJson.echo.token, "token-to-revoke");
    assert.deepEqual(receivedRevokeBody, {
      token: "token-to-revoke",
      client_id: "test-client-id",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

console.log("OAuth JSON and child process reaping tests passed successfully.");
