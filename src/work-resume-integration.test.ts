/**
 * Regression for the post-#413 execution-only boundary.
 *
 * The original WorkResumeStore server-sink suite asserted a retired
 * governance precondition.  Keep an active end-to-end MCP witness at this
 * Core-protected test path: DIRECT writes need no separate mutation session,
 * while physical workspace-root containment continues to fail closed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

function responseText(value: unknown): string {
  const parts = (value as { content?: Array<{ text?: string }> }).content;
  return parts?.map((part) => part.text ?? "").join("\n") ?? "";
}

test("DIRECT MCP write is transport-neutral but root-contained", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-direct-no-core-session-"));
  const project = join(root, "project");
  const stateDir = join(root, "state");
  await Promise.all([mkdir(project, { recursive: true }), mkdir(stateDir, { recursive: true })]);
  await writeFile(join(project, "AGENTS.md"), "# Direct integration fixture\n");

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_ALLOWED_ROOTS: project,
    DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_TOOL_MODE: "full",
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const processes = new ProcessSessionManager();
  const server = createMcpServer(
    config, workspaces, createReviewCheckpointManager(), processes, () => [], [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "post-413-direct-integration", version: "1.0.0" });
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    processes.shutdown();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: project, mode: "checkout" },
  });
  assert.equal(opened.isError, undefined, responseText(opened));
  const workspaceId = (opened.structuredContent as { workspaceId?: string } | undefined)?.workspaceId;
  assert.ok(workspaceId, "MCP must return a real workspace identity");

  const written = await client.callTool({
    name: "write",
    arguments: { workspaceId, path: "direct.txt", content: "DIRECT remains transport-neutral\n" },
  });
  assert.equal(written.isError, undefined, responseText(written));
  assert.equal(await readFile(join(project, "direct.txt"), "utf8"), "DIRECT remains transport-neutral\n");
  assert.equal((written.structuredContent as { coreMutation?: unknown } | undefined)?.coreMutation, undefined);

  const escaped = await client.callTool({
    name: "write",
    arguments: { workspaceId, path: "../outside.txt", content: "forbidden\n" },
  });
  assert.equal(escaped.isError, true, "DIRECT must not weaken approved-root containment");
  await assert.rejects(readFile(join(root, "outside.txt"), "utf8"), { code: "ENOENT" });
});
