import { readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  const serverUrl = new URL("http://127.0.0.1:7677/mcp");
  const ownerToken = readFileSync("/Users/jameschen/.devspace-chatgpt/owner-token", "utf-8").trim();

  const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", serverUrl.origin);
  const resourceResponse = await fetch(resourceMetadataUrl);
  const resourceMetadata = await resourceResponse.json();
  const issuer = new URL(resourceMetadata.authorization_servers[0]);

  const authMetadataResponse = await fetch(
    new URL(".well-known/oauth-authorization-server", issuer.href.replace("https://devspace.snowskill.app", serverUrl.origin))
  );
  const authMetadata = await authMetadataResponse.json();
  const endpoint = (name: string) => (authMetadata as any)[name].replace("https://devspace.snowskill.app", serverUrl.origin);

  const redirectUri = "http://127.0.0.1:9/devspace-native-cutover";
  const clientMetadata = {
    client_name: "devspace-probe-create",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };

  const regRes = await fetch(endpoint("registration_endpoint"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(clientMetadata),
  });
  const reg = await regRes.json();
  const clientId = reg.client_id;

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomUUID();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "devspace",
    resource: resourceMetadata.resource,
    state,
  });

  const approval = await fetch(endpoint("authorization_endpoint"), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams([...params, ["owner_token", ownerToken]]),
  });

  const location = approval.headers.get("location");
  if (!location) throw new Error("Approval failed: " + approval.status);
  const code = new URL(location).searchParams.get("code")!;

  const tokenRes = await fetch(endpoint("token_endpoint"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
      resource: resourceMetadata.resource,
    }),
  });
  const tokens = await tokenRes.json();

  const transport = new StreamableHTTPClientTransport(serverUrl, {
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  });
  const client = new Client({ name: "devspace-probe-create", version: "1.0.0" });
  await client.connect(transport);

  const createRes = await client.callTool({
    name: "chat_swarm_create",
    arguments: {},
    _meta: { "openai/session": "v1/3b9C3Q11WLxf0wujKVKoSdsoxgJvAfbWXRG0cavUps9o1sXdaeZdGlwLmcUEXKdRnfHlKC1drP6l" },
  });
  console.log("Create Res:", JSON.stringify(createRes, null, 2));

  await client.close();
}

main().catch(console.error);
