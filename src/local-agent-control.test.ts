import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import {
  LocalAgentControlServer,
  requestLocalAgentRun,
  type LocalAgentCommandHandler,
} from "./local-agent-control.js";
import type { LocalAgentRunCommand } from "./local-agent-manager.js";
import type { LocalAgentRecord } from "./local-agent-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-local-agent-control-test-"));
const config = loadConfig({
  ...process.env,
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: join(root, "state"),
  DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-long-enough",
});
let received: LocalAgentRunCommand | undefined;
const expected: LocalAgentRecord = {
  id: "agt_control",
  workspaceId: "ws_control",
  workspaceRoot: root,
  profileName: "codex",
  provider: "codex",
  status: "running",
  model: undefined,
  thinking: undefined,
  providerSessionId: undefined,
  latestResponse: undefined,
  error: undefined,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const handler: LocalAgentCommandHandler = {
  async enqueue(command) {
    received = command;
    return expected;
  },
};
const server = new LocalAgentControlServer(config, handler);

try {
  await server.start();
  const record = await requestLocalAgentRun(config, {
    workspaceId: "ws_control",
    workspaceRoot: root,
    target: "codex",
    prompt: "inspect",
    model: "gpt-test",
    thinking: "high",
  });

  assert.deepEqual(received, {
    workspaceId: "ws_control",
    workspaceRoot: root,
    target: "codex",
    prompt: "inspect",
    model: "gpt-test",
    thinking: "high",
  });
  assert.deepEqual(record, expected);
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
