import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { openWorkspaceOutputSchema } from "./server.js";
import * as z from "zod/v4";

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
assert.equal(workflowsOnly.has("agentProviders"), true);
assert.equal(workflowsOnly.has("agents"), true);
assert.equal(workflowsOnly.has("activeWorkflows"), true);

const compactOutput = z.object(openWorkspaceOutputSchema(loadConfig({
  ...baseEnv,
  DEVSPACE_SUBAGENTS: "1",
  DEVSPACE_WORKFLOWS: "1",
}))).parse({
  workspaceId: "ws_test",
  root: process.cwd(),
  mode: "checkout",
  agentsFiles: [],
  availableAgentsFiles: [],
  skills: [],
  agentProviders: [{
    name: "codex",
    model: { supported: true, discovery: "model_dependent" },
    effort: { supported: true, semantics: "reasoning_effort", discovery: "model_dependent" },
  }],
  agents: [{ name: "reviewer", description: "Review code.", provider: "codex", model: "gpt-5.4", effort: "high" }],
  activeWorkflows: [{
    id: "wfr_test",
    name: "review",
    status: "running",
    calls: { running: 1, completed: 0, cached: 0, failed: 0, cancelled: 0, observed: 1 },
    updatedAt: "2026-08-09T00:00:00.000Z",
  }],
  skillDiagnostics: [],
  instruction: "Use this workspaceId.",
});
assert.deepEqual(compactOutput.agentProviders, [{ name: "codex" }]);
assert.deepEqual(compactOutput.activeWorkflows, [{ id: "wfr_test", name: "review", status: "running" }]);

console.log("open-workspace-capabilities.test.ts: ok");
