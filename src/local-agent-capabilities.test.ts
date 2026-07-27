import assert from "node:assert/strict";
import { getLocalAgentProviderCapabilities } from "./local-agent-capabilities.js";
import { LOCAL_AGENT_PROVIDERS } from "./local-agent-profiles.js";

for (const provider of LOCAL_AGENT_PROVIDERS) {
  const capabilities = getLocalAgentProviderCapabilities(provider);
  assert.equal(typeof capabilities.model.supported, "boolean");
  assert.equal(typeof capabilities.effort.supported, "boolean");
}

assert.equal(
  getLocalAgentProviderCapabilities("opencode").effort.semantics,
  "model_variant",
);
assert.equal(
  getLocalAgentProviderCapabilities("pi").effort.semantics,
  "thinking_level",
);
assert.equal(
  getLocalAgentProviderCapabilities("cursor").effort.discovery,
  "session_dynamic",
);

console.log("local-agent-capabilities.test.ts: ok");
