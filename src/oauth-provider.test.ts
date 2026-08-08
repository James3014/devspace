import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response } from "express";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import type { OAuthConfig } from "./oauth-provider.js";

const config: OAuthConfig = {
  ownerToken: "owner-token-long-enough-for-test",
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  scopes: ["devspace"],
  allowedRedirectHosts: ["chatgpt.com", "localhost", "127.0.0.1"],
};

const mcpUrl = new URL("http://127.0.0.1:7676/mcp");
const resource = new URL("http://127.0.0.1:7676/mcp");

function persistPath() {
  const dir = mkdtempSync(join(tmpdir(), "oauth-provider-persist-test-"));
  return join(dir, "oauth-state.json");
}

function requireToken(tokens: OAuthTokens): { access_token: string; refresh_token: string } {
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);
  return { access_token: tokens.access_token, refresh_token: tokens.refresh_token };
}

function mockResponse(): Response {
  let lastRedirect = "";
  const res = {
    req: { method: "POST", body: { owner_token: config.ownerToken } },
    redirect: (_status: number, url: string) => {
      lastRedirect = url;
    },
    status: () => res,
    setHeader: () => res,
    send: () => res,
    getLastRedirect: () => lastRedirect,
  };
  return res as unknown as Response;
}

async function registerClient(provider: SingleUserOAuthProvider): Promise<OAuthClientInformationFull> {
  const client = provider.clientsStore.registerClient!({
    redirect_uris: ["https://chatgpt.com/callback"],
    client_name: "test-client",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  return client as OAuthClientInformationFull;
}

async function authorizeAndExchange(
  provider: SingleUserOAuthProvider,
  client: OAuthClientInformationFull,
) {
  const res = mockResponse();
  await provider.authorize(
    client,
    {
      redirectUri: client.redirect_uris[0],
      codeChallenge: "challenge-hash",
      scopes: config.scopes,
      resource,
    },
    res,
  );
  const redirectUrl = new URL((res as unknown as { getLastRedirect: () => string }).getLastRedirect());
  const code = redirectUrl.searchParams.get("code");
  assert.ok(code);
  return provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0], resource);
}

{
  const path = persistPath();
  const provider = new SingleUserOAuthProvider(config, mcpUrl, path);
  const client = await registerClient(provider);
  const tokens = await authorizeAndExchange(provider, client);

  const persisted = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(persisted.clients.length, 1);
  assert.equal(persisted.clients[0].client_id, client.client_id);
  assert.equal(Object.keys(persisted.accessTokens).length, 1);
  assert.equal(Object.keys(persisted.refreshTokens).length, 1);
}

{
  const path = persistPath();
  const provider = new SingleUserOAuthProvider(config, mcpUrl, path);
  const client = await registerClient(provider);
  const issued = await authorizeAndExchange(provider, client);
  const { access_token, refresh_token } = requireToken(issued);

  const restored = new SingleUserOAuthProvider(config, mcpUrl, path);
  const restoredClient = restored.clientsStore.getClient(client.client_id) as
    | OAuthClientInformationFull
    | undefined;
  assert.ok(restoredClient, "client must survive restart");
  assert.equal(restoredClient.client_id, client.client_id);

  const info = await restored.verifyAccessToken(access_token);
  assert.equal(info.clientId, client.client_id);
  assert.deepEqual(info.scopes, ["devspace"]);

  const refreshed = await restored.exchangeRefreshToken(restoredClient, refresh_token, ["devspace"]);
  const refreshedToken = requireToken(refreshed);
  assert.ok(refreshedToken.access_token);
  assert.notEqual(refreshedToken.access_token, access_token);
}

{
  const path = persistPath();
  const provider = new SingleUserOAuthProvider(config, mcpUrl, path);
  const client = await registerClient(provider);
  const issued = await authorizeAndExchange(provider, client);
  const { refresh_token } = requireToken(issued);

  const restored = new SingleUserOAuthProvider(config, mcpUrl, path);
  const restoredClient = restored.clientsStore.getClient(client.client_id) as
    | OAuthClientInformationFull
    | undefined;
  assert.ok(restoredClient);
  await restored.exchangeRefreshToken(restoredClient, refresh_token, ["devspace"]);

  await assert.rejects(
    restored.exchangeRefreshToken(restoredClient, refresh_token, ["devspace"]),
    /Invalid refresh token/,
  );
}

{
  const path = persistPath();
  const provider = new SingleUserOAuthProvider(config, mcpUrl, path);
  const client = await registerClient(provider);
  const issued = await authorizeAndExchange(provider, client);
  const { refresh_token } = requireToken(issued);

  const restored = new SingleUserOAuthProvider(config, mcpUrl, path);
  const restoredClient = restored.clientsStore.getClient(client.client_id) as
    | OAuthClientInformationFull
    | undefined;
  assert.ok(restoredClient);
  await restored.revokeToken!(restoredClient, { token: refresh_token });

  const again = new SingleUserOAuthProvider(config, mcpUrl, path);
  const againClient = again.clientsStore.getClient(client.client_id) as
    | OAuthClientInformationFull
    | undefined;
  assert.ok(againClient);
  await assert.rejects(
    again.exchangeRefreshToken(againClient, refresh_token, ["devspace"]),
    /Invalid refresh token/,
  );
}
