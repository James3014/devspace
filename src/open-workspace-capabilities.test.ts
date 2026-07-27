import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { openWorkspaceOutputSchema } from "./server.js";

const configDir = mkdtempSync(join(tmpdir(), "devspace-open-workspace-capabilities-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

function fields(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(Object.keys(openWorkspaceOutputSchema(loadConfig(env))));
}

const disabled = fields(baseEnv);
assert.equal(disabled.has("agentProviders"), false);
assert.equal(disabled.has("agents"), false);
assert.equal(disabled.has("activeWorkflows"), false);

const subagentsOnly = fields({
  ...baseEnv,
  DEVSPACE_SUBAGENTS: "1",
  DEVSPACE_WORKFLOWS: "0",
});
assert.equal(subagentsOnly.has("agentProviders"), true);
assert.equal(subagentsOnly.has("agents"), true);
assert.equal(subagentsOnly.has("activeWorkflows"), false);

const workflowsOnly = fields({
  ...baseEnv,
  DEVSPACE_SUBAGENTS: "0",
  DEVSPACE_WORKFLOWS: "1",
});
assert.equal(workflowsOnly.has("agentProviders"), false);
assert.equal(workflowsOnly.has("agents"), false);
assert.equal(workflowsOnly.has("activeWorkflows"), true);

console.log("open-workspace-capabilities.test.ts: ok");
