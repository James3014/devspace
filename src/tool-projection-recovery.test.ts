// Issue #401: open_workspace(mode=worktree) emits GIT_BASE_REF_NOT_LOCAL and tells the
// caller to use git_fetch_ref. That tool must be callable on every tool surface that can
// emit the message. src/server.test.ts holds the same contract but is excluded from
// `npm test` (DS-1-F6), so this file runs it in CI without codex CLI or OAuth secrets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig, type ToolMode } from "./config.js";
import { DurableOperationManager } from "./durable-operations.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

// Record<ToolMode, ...> makes the compiler reject this table if a ToolMode is added or removed.
const ALL_TOOL_MODES: Record<ToolMode, true> = { minimal: true, full: true, codex: true, dispatch: true };

async function projectSurface(toolMode: ToolMode): Promise<{ names: string[]; instructions: string }> {
  const root = await mkdtemp(join(tmpdir(), "devspace-projection-recovery-"));
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");
  await mkdir(join(root, "project"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  const loaded = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_TOOL_MODE: toolMode,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_GIT_CANDIDATES: "false",
    DEVSPACE_CHAT_SWARM: "0",
  });
  const config: ServerConfig = {
    ...loaded,
    toolMode,
    subagents: { ...loaded.subagents, enabled: false },
  };
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const durableOperations = new DurableOperationManager(config);
  const processSessions = new ProcessSessionManager();
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    processSessions,
    () => [],
    [],
    undefined,
    undefined,
    undefined,
    durableOperations,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-projection-recovery-client", version: "1.0.0" });
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    return { names, instructions: client.getInstructions() ?? "" };
  } finally {
    await client.close();
    await server.close();
    durableOperations.close();
    processSessions.shutdown();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("GIT_BASE_REF_NOT_LOCAL error text names the git_fetch_ref recovery tool", () => {
  const source = readFileSync(new URL("./git-worktrees.ts", import.meta.url), "utf8");
  const match = source.match(/"GIT_BASE_REF_NOT_LOCAL",\s*"\[GIT_BASE_REF_NOT_LOCAL\][^;]*?\);/);
  assert.ok(match, "GIT_BASE_REF_NOT_LOCAL throw site not found in src/git-worktrees.ts");
  assert.match(match[0], /git_fetch_ref/);
});

for (const toolMode of Object.keys(ALL_TOOL_MODES) as ToolMode[]) {
  test(`git_fetch_ref recovery is projected in ${toolMode} tool mode`, async () => {
    const { names, instructions } = await projectSurface(toolMode);
    const canOpenWorkspace = names.includes("open_workspace");
    if (canOpenWorkspace) {
      assert.ok(
        names.includes("git_fetch_ref"),
        `${toolMode} lists open_workspace (can emit GIT_BASE_REF_NOT_LOCAL) but not git_fetch_ref`,
      );
    }
    if (instructions.includes("GIT_BASE_REF_NOT_LOCAL")) {
      assert.match(instructions, /git_fetch_ref/);
      assert.ok(names.includes("git_fetch_ref"), `${toolMode} instructions cite git_fetch_ref but it is not callable`);
    }
    // Every current mode exposes open_workspace and the recovery text; guard against a vacuous pass.
    assert.ok(canOpenWorkspace, `${toolMode} no longer lists open_workspace; update this contract deliberately`);
    assert.match(instructions, /GIT_BASE_REF_NOT_LOCAL/);
  });
}
