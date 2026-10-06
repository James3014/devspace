import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { createMcpServer } from "./server.js";
import { createManagedWorktree, GitWorktreeError } from "./git-worktrees.js";

interface TestWorkspaceEnvironment {
  tempDir: string;
  allowedRoot: string;
  stateDir: string;
  repoDir: string;
  remoteDir: string;
  config: ServerConfig;
  store: SqliteWorkspaceStore;
  workspaces: WorkspaceRegistry;
  client: Client;
  close: () => Promise<void>;
}

async function setupMinimalEnvironment(t: TestContext): Promise<TestWorkspaceEnvironment> {
  const tempDir = await mkdtemp(join(tmpdir(), "devspace-issue344-"));
  const allowedRoot = join(tempDir, "allowed");
  const stateDir = join(tempDir, "state");
  const repoDir = join(allowedRoot, "repo");
  const remoteDir = join(tempDir, "remote.git");
  const worktreeRoot = join(tempDir, "worktrees");

  await mkdir(allowedRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });

  // Initialize a remote git repo and local repo
  execFileSync("git", ["init", "--bare", remoteDir]);
  execFileSync("git", ["init", repoDir]);
  execFileSync("git", ["config", "user.name", "DevSpace Test"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@devspace.local"], { cwd: repoDir });
  execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });

  // Initial commit
  await writeFile(join(repoDir, "README.md"), "# Initial\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repoDir });
  execFileSync("git", ["push", "-u", "origin", "HEAD:main"], { cwd: repoDir });

  // Create a dummy fake verifier toolchain
  const toolchainsDir = join(tempDir, "toolchain");
  await mkdir(toolchainsDir, { recursive: true });
  const fakePytest = join(toolchainsDir, "fake-pytest.sh");
  await writeFile(fakePytest, "#!/bin/sh\necho 'pytest ok'\nexit 0\n", { mode: 0o755 });

  const envConfig = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: allowedRoot,
    DEVSPACE_WORKTREE_ROOT: worktreeRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_TOOL_MODE: "minimal",
    DEVSPACE_TOOLCHAINS: JSON.stringify([
      {
        id: "python-test",
        root: toolchainsDir,
        verifiers: {
          pytest: fakePytest,
          missing: join(toolchainsDir, "does-not-exist.sh"),
        },
      },
    ]),
  });

  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(envConfig, store);
  const server = createMcpServer(
    envConfig,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => [],
    [],
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "issue344-test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const close = async () => {
    await client.close();
    await server.close();
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  };
  t.after(close);

  return {
    tempDir,
    allowedRoot,
    stateDir,
    repoDir,
    remoteDir,
    config: envConfig,
    store,
    workspaces,
    client,
    close,
  };
}

function structuredContent(response: unknown): Record<string, unknown> {
  const result = response as { structuredContent?: Record<string, unknown> };
  return result?.structuredContent ?? {};
}

test("Issue #344 - Criteria 1: apply_patch is available in DEVSPACE_TOOL_MODE=minimal and mutates files", async (t) => {
  const env = await setupMinimalEnvironment(t);

  // List tools to verify apply_patch is present in minimal mode
  const tools = await env.client.listTools();
  const toolNames = tools.tools.map((t) => t.name);
  assert.ok(toolNames.includes("apply_patch"), "apply_patch must be present in minimal mode");
  assert.ok(toolNames.includes("open_workspace"), "open_workspace must be present");
  assert.ok(toolNames.includes("workspace_verify"), "workspace_verify must be present");
  assert.ok(toolNames.includes("workspace_list_verifiers"), "workspace_list_verifiers must be present");
  assert.ok(toolNames.includes("workspace_copy_file"), "workspace_copy_file must be present");
  assert.ok(toolNames.includes("git_fetch_ref"), "git_fetch_ref must be present");

  // Open workspace
  const openRes = await env.client.callTool({
    name: "open_workspace",
    arguments: { path: env.repoDir, mode: "checkout" },
  });
  const wsId = structuredContent(openRes).workspaceId as string;
  assert.ok(wsId);

  // Apply a multi-file structured patch without shell file mutation
  const patchText = `*** Begin Patch
*** Add File: src/hello.txt
+Hello World
+Line 2
*** Update File: README.md
@@
-# Initial
+# Modified Title
*** End Patch`;

  const patchRes = await env.client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId: wsId,
      patch: patchText,
    },
  });

  const patchStructured = structuredContent(patchRes);
  assert.equal(patchStructured.additions, 3);
  assert.equal(patchStructured.removals, 1);

  // Verify file states on disk
  const readme = await readFile(join(env.repoDir, "README.md"), "utf8");
  assert.equal(readme, "# Modified Title\n");
  const hello = await readFile(join(env.repoDir, "src/hello.txt"), "utf8");
  assert.equal(hello, "Hello World\nLine 2\n");
});

test("Issue #344 - Criteria 2: explicit git_fetch_ref syncs one configured remote branch before worktree open", async (t) => {
  const env = await setupMinimalEnvironment(t);

  // Push a new branch directly to the bare remote repo from another clone
  const secondClone = join(env.tempDir, "clone2");
  execFileSync("git", ["clone", env.remoteDir, secondClone]);
  execFileSync("git", ["config", "user.name", "DevSpace Other"], { cwd: secondClone });
  execFileSync("git", ["config", "user.email", "other@devspace.local"], { cwd: secondClone });
  execFileSync("git", ["checkout", "-b", "feat/remote-pr-branch"], { cwd: secondClone });
  await writeFile(join(secondClone, "pr-feature.txt"), "Remote PR feature content\n");
  execFileSync("git", ["add", "pr-feature.txt"], { cwd: secondClone });
  execFileSync("git", ["commit", "-m", "Remote PR branch commit"], { cwd: secondClone });
  execFileSync("git", ["push", "-u", "origin", "feat/remote-pr-branch"], { cwd: secondClone });

  // The remote branch is not local yet. open_workspace must fail without hidden network/ref mutation.
  const missingLocalRef = await env.client.callTool({
    name: "open_workspace",
    arguments: {
      path: env.repoDir,
      mode: "worktree",
      baseRef: "feat/remote-pr-branch",
    },
  });
  assert.equal((missingLocalRef as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(missingLocalRef), /GIT_BASE_REF_NOT_LOCAL/);
  assert.throws(
    () => execFileSync("git", ["show-ref", "--verify", "refs/remotes/origin/feat/remote-pr-branch"], { cwd: env.repoDir }),
  );

  // Open the physical checkout, explicitly sync exactly one configured remote branch, then open by returned localRef.
  const checkoutRes = await env.client.callTool({
    name: "open_workspace",
    arguments: { path: env.repoDir, mode: "checkout" },
  });
  const checkoutId = structuredContent(checkoutRes).workspaceId as string;
  const fetchRes = await env.client.callTool({
    name: "git_fetch_ref",
    arguments: {
      workspaceId: checkoutId,
      remote: "origin",
      branch: "feat/remote-pr-branch",
    },
  });
  const fetchData = structuredContent(fetchRes);
  assert.equal(fetchData.remote, "origin");
  assert.equal(fetchData.branch, "feat/remote-pr-branch");
  assert.equal(fetchData.localRef, "refs/remotes/origin/feat/remote-pr-branch");
  assert.match(String(fetchData.fetchedSha), /^[0-9a-f]{40}$/);

  const openRes = await env.client.callTool({
    name: "open_workspace",
    arguments: {
      path: env.repoDir,
      mode: "worktree",
      baseRef: fetchData.localRef,
    },
  });

  const structured = structuredContent(openRes);
  assert.equal(structured.mode, "worktree");
  const worktreeRoot = structured.root as string;
  const prContent = await readFile(join(worktreeRoot, "pr-feature.txt"), "utf8");
  assert.equal(prContent, "Remote PR feature content\n");

  const missingRemoteRef = await env.client.callTool({
    name: "git_fetch_ref",
    arguments: {
      workspaceId: checkoutId,
      remote: "origin",
      branch: "non-existent-pr-branch-9999",
    },
  });
  assert.equal((missingRemoteRef as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(missingRemoteRef), /GIT_REMOTE_REF_NOT_FOUND/);

  const unconfiguredRemote = await env.client.callTool({
    name: "git_fetch_ref",
    arguments: {
      workspaceId: checkoutId,
      remote: env.remoteDir,
      branch: "feat/remote-pr-branch",
    },
  });
  assert.equal((unconfiguredRemote as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(unconfiguredRemote), /GIT_REMOTE_NOT_CONFIGURED/);
});


test("Issue #344 - Criteria 3: workspace_copy_file transfers >=5,000 line file with exact SHA-256 and negative controls", async (t) => {
  const env = await setupMinimalEnvironment(t);

  // Create workspace A and workspace B
  const wsARes = await env.client.callTool({
    name: "open_workspace",
    arguments: { path: env.repoDir, mode: "checkout" },
  });
  const wsAId = structuredContent(wsARes).workspaceId as string;

  const wsBRes = await env.client.callTool({
    name: "open_workspace",
    arguments: { path: env.repoDir, mode: "worktree" },
  });
  const wsBId = structuredContent(wsBRes).workspaceId as string;

  // Generate a >=5,000 line file in workspace A
  const lines: string[] = [];
  for (let i = 1; i <= 5500; i++) {
    lines.push(`Line ${i}: deterministic content padding token_${(i * 31) % 10007}`);
  }
  const bigFileContent = lines.join("\n") + "\n";
  const sourceSha = createHash("sha256").update(bigFileContent).digest("hex");
  await writeFile(join(env.repoDir, "large_source.txt"), bigFileContent);

  // Copy from workspace A to workspace B
  const copyRes = await env.client.callTool({
    name: "workspace_copy_file",
    arguments: {
      sourceWorkspaceId: wsAId,
      sourcePath: "large_source.txt",
      destinationWorkspaceId: wsBId,
      destinationPath: "nested/transferred.txt",
      expectedSourceSha256: sourceSha,
    },
  });

  const copyStructured = structuredContent(copyRes);
  assert.equal(copyStructured.sha256, sourceSha);
  assert.equal(copyStructured.bytes, Buffer.byteLength(bigFileContent));
  assert.equal(copyStructured.overwritten, false);

  // Verify destination file has exact byte equality and hash equality
  const wsBRoot = structuredContent(wsBRes).root as string;
  const destBytes = await readFile(join(wsBRoot, "nested/transferred.txt"));
  const destSha = createHash("sha256").update(destBytes).digest("hex");
  assert.equal(destSha, sourceSha);

  // Negative control 1: destination exists without overwrite flag -> blocked
  const blockedExists = await env.client.callTool({
    name: "workspace_copy_file",
    arguments: {
      sourceWorkspaceId: wsAId,
      sourcePath: "large_source.txt",
      destinationWorkspaceId: wsBId,
      destinationPath: "nested/transferred.txt",
      overwrite: false,
    },
  });
  assert.equal((blockedExists as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(blockedExists), /DESTINATION_EXISTS/);

  // Negative control 2: destination CAS mismatch -> blocked
  const blockedCas = await env.client.callTool({
    name: "workspace_copy_file",
    arguments: {
      sourceWorkspaceId: wsAId,
      sourcePath: "large_source.txt",
      destinationWorkspaceId: wsBId,
      destinationPath: "nested/transferred.txt",
      expectedDestinationSha256: "0".repeat(64),
      overwrite: true,
    },
  });
  assert.equal((blockedCas as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(blockedCas), /DESTINATION_CAS_MISMATCH/);

  // Negative control 3: lexical path escape outside workspace root -> blocked.
  try {
    const escapedRes = await env.client.callTool({
      name: "workspace_copy_file",
      arguments: {
        sourceWorkspaceId: wsAId,
        sourcePath: "large_source.txt",
        destinationWorkspaceId: wsBId,
        destinationPath: "../../../../etc/escaped.txt",
        overwrite: true,
      },
    });
    assert.equal((escapedRes as { isError?: boolean }).isError, true);
    assert.match(JSON.stringify(escapedRes), /outside workspace root|AccessDeniedError|outside an allowed root/);
  } catch (error) {
    assert.match(String(error), /outside workspace root|AccessDeniedError|outside an allowed root/);
  }

  // Negative control 4: a parent-directory symlink cannot redirect writes outside the destination workspace.
  const outsideDir = join(env.tempDir, "outside-copy-target");
  await mkdir(outsideDir, { recursive: true });
  await symlink(outsideDir, join(wsBRoot, "escape-link"));
  const symlinkEscape = await env.client.callTool({
    name: "workspace_copy_file",
    arguments: {
      sourceWorkspaceId: wsAId,
      sourcePath: "large_source.txt",
      destinationWorkspaceId: wsBId,
      destinationPath: "escape-link/escaped.txt",
      overwrite: true,
    },
  });
  assert.equal((symlinkEscape as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(symlinkEscape), /DESTINATION_PATH_ESCAPE/);
  await assert.rejects(readFile(join(outsideDir, "escaped.txt")));

  // Negative control 5: CAS preimage cannot silently degrade to create-if-missing.
  const missingPreimage = await env.client.callTool({
    name: "workspace_copy_file",
    arguments: {
      sourceWorkspaceId: wsAId,
      sourcePath: "large_source.txt",
      destinationWorkspaceId: wsBId,
      destinationPath: "nested/missing-preimage.txt",
      expectedDestinationSha256: "1".repeat(64),
      overwrite: true,
    },
  });
  assert.equal((missingPreimage as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(missingPreimage), /DESTINATION_PREIMAGE_MISSING/);

  // Negative control 6: source-side nested instructions must be loaded before copy reads the file.
  await mkdir(join(env.repoDir, "guarded"), { recursive: true });
  await writeFile(join(env.repoDir, "guarded", "AGENTS.md"), "# guarded source instructions\n");
  await writeFile(join(env.repoDir, "guarded", "source.txt"), "guarded payload\n");
  const guardedBlocked = await env.client.callTool({
    name: "workspace_copy_file",
    arguments: {
      sourceWorkspaceId: wsAId,
      sourcePath: "guarded/source.txt",
      destinationWorkspaceId: wsBId,
      destinationPath: "guarded-copy.txt",
    },
  });
  assert.equal((guardedBlocked as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(guardedBlocked), /NESTED_INSTRUCTION_REBIND_REQUIRED/);

  const guardedInstructions = await env.client.callTool({
    name: "read",
    arguments: {
      workspaceId: wsAId,
      path: "guarded/AGENTS.md",
    },
  });
  assert.equal((guardedInstructions as { isError?: boolean }).isError, undefined);

  const guardedCopy = await env.client.callTool({
    name: "workspace_copy_file",
    arguments: {
      sourceWorkspaceId: wsAId,
      sourcePath: "guarded/source.txt",
      destinationWorkspaceId: wsBId,
      destinationPath: "guarded-copy.txt",
    },
  });
  assert.equal((guardedCopy as { isError?: boolean }).isError, undefined);
});


test("Issue #344 - Criteria 4: bounded read returns exact content separately from pagination metadata", async (t) => {
  const env = await setupMinimalEnvironment(t);

  const wsRes = await env.client.callTool({
    name: "open_workspace",
    arguments: { path: env.repoDir, mode: "checkout" },
  });
  const wsId = structuredContent(wsRes).workspaceId as string;

  // Create a file with 100 lines
  const lines = Array.from({ length: 100 }, (_, i) => `line_${i + 1}`);
  await writeFile(join(env.repoDir, "paginated.txt"), lines.join("\n") + "\n");

  // Read with limit=10
  const readRes = await env.client.callTool({
    name: "read",
    arguments: {
      workspaceId: wsId,
      path: "paginated.txt",
      offset: 1,
      limit: 10,
    },
  });

  const structured = structuredContent(readRes);
  const resultText = structured.result as string;

  // Exact content must contain ONLY lines 1..10, without any navigation notice!
  const expectedContent = lines.slice(0, 10).join("\n");
  assert.equal(resultText, expectedContent);
  assert.equal(structured.content, expectedContent);
  assert.ok(!resultText.includes("more lines in file"));
  assert.ok(!resultText.includes("Showing lines"));
  assert.ok(!resultText.includes("Use offset="));

  // Pagination metadata must be returned in the structured pagination field
  const pagination = structured.pagination as Record<string, unknown>;
  assert.ok(pagination, "pagination metadata should be present");
  assert.equal(pagination.offset, 1);
  assert.equal(pagination.returnedLines, 10);
  assert.equal(pagination.totalLines, 101); // 100 lines + trailing newline line
  assert.equal(pagination.remainingLines, 91);
  assert.equal(pagination.nextOffset, 11);
  assert.ok(String(pagination.notice).includes("91 more lines in file. Use offset=11 to continue."));
  assert.match(String(structured.fileSha256), /^[0-9a-f]{64}$/);

  // Source text that literally resembles the old pagination prose must remain source text.
  const literalNotice = "payload\n\n[91 more lines in file. Use offset=11 to continue.]";
  await writeFile(join(env.repoDir, "literal-notice.txt"), literalNotice);
  const literalRead = await env.client.callTool({
    name: "read",
    arguments: {
      workspaceId: wsId,
      path: "literal-notice.txt",
    },
  });
  const literalStructured = structuredContent(literalRead);
  assert.equal(literalStructured.result, literalNotice);
  assert.equal(literalStructured.content, literalNotice);
  assert.equal(literalStructured.pagination, undefined);

  // Existing Pi read byte bounds remain authoritative for pathological long lines.
  const hugeLine = "x".repeat(60 * 1024);
  await writeFile(join(env.repoDir, "huge-line.txt"), hugeLine);
  const hugeRead = await env.client.callTool({
    name: "read",
    arguments: {
      workspaceId: wsId,
      path: "huge-line.txt",
    },
  });
  const hugeStructured = structuredContent(hugeRead);
  assert.equal(hugeStructured.result, "");
  assert.equal(hugeStructured.content, "");
  assert.match(String(hugeStructured.fileSha256), /^[0-9a-f]{64}$/);
  const hugePagination = hugeStructured.pagination as Record<string, unknown>;
  assert.equal(hugePagination.truncated, true);
  assert.equal(hugePagination.returnedLines, 0);
  assert.equal(hugePagination.nextOffset, undefined);
  assert.match(String(hugePagination.notice), /exceeds .* limit/);
});

test("Issue #344 - Criteria 5: discover verifiers and invoke workspace_verify without prior knowledge of toolchainId", async (t) => {
  const env = await setupMinimalEnvironment(t);

  const wsRes = await env.client.callTool({
    name: "open_workspace",
    arguments: { path: env.repoDir, mode: "checkout" },
  });
  const wsId = structuredContent(wsRes).workspaceId as string;

  // Call workspace_list_verifiers to discover catalog
  const listRes = await env.client.callTool({
    name: "workspace_list_verifiers",
    arguments: { workspaceId: wsId },
  });

  const structured = structuredContent(listRes);
  const toolchains = structured.toolchains as Array<{
    toolchainId: string;
    verifiers: Array<{ name: string; available: boolean }>;
  }>;
  assert.ok(Array.isArray(toolchains));
  assert.equal(toolchains.length, 1);
  assert.equal(toolchains[0].toolchainId, "python-test");

  const verifiers = toolchains[0].verifiers;
  const pytestEntry = verifiers.find((v) => v.name === "pytest");
  assert.ok(pytestEntry);
  assert.equal(pytestEntry.available, true);

  const missingEntry = verifiers.find((v) => v.name === "missing");
  assert.ok(missingEntry);
  assert.equal(missingEntry.available, false);

  // Invoke workspace_verify with the discovered toolchainId and verifier
  const verifyRes = await env.client.callTool({
    name: "workspace_verify",
    arguments: {
      workspaceId: wsId,
      toolchainId: toolchains[0].toolchainId,
      verifier: pytestEntry.name,
      args: [],
    },
  });

  const verifyStructured = structuredContent(verifyRes);
  assert.equal(verifyStructured.ok, true);
  assert.equal(verifyStructured.exitCode, 0);
  assert.match(String(verifyStructured.stdout), /pytest ok/);
});

test("Issue #344 - Criteria 6: end-to-end dogfood flow (open/sync -> inspect -> patch -> verify -> readback -> commit/push)", async (t) => {
  const env = await setupMinimalEnvironment(t);

  // 1. Create a remote PR branch on bare remote from another clone
  const secondClone = join(env.tempDir, "clone-dogfood");
  execFileSync("git", ["clone", env.remoteDir, secondClone]);
  execFileSync("git", ["config", "user.name", "Dogfood Dev"], { cwd: secondClone });
  execFileSync("git", ["config", "user.email", "dogfood@devspace.local"], { cwd: secondClone });
  execFileSync("git", ["checkout", "-b", "feat/dogfood-pr"], { cwd: secondClone });
  await writeFile(
    join(secondClone, "service.py"),
    "def run():\n    return 'broken'\n",
  );
  execFileSync("git", ["add", "service.py"], { cwd: secondClone });
  execFileSync("git", ["commit", "-m", "WIP broken service"], { cwd: secondClone });
  execFileSync("git", ["push", "-u", "origin", "feat/dogfood-pr"], { cwd: secondClone });

  // 2. Open the repository checkout, explicitly sync the remote branch, then open the isolated worktree.
  const checkoutRes = await env.client.callTool({
    name: "open_workspace",
    arguments: { path: env.repoDir, mode: "checkout" },
  });
  const checkoutId = structuredContent(checkoutRes).workspaceId as string;
  const fetchRes = await env.client.callTool({
    name: "git_fetch_ref",
    arguments: {
      workspaceId: checkoutId,
      remote: "origin",
      branch: "feat/dogfood-pr",
    },
  });
  const localRef = structuredContent(fetchRes).localRef as string;
  const openRes = await env.client.callTool({
    name: "open_workspace",
    arguments: {
      path: env.repoDir,
      mode: "worktree",
      baseRef: localRef,
    },
  });
  const openData = structuredContent(openRes);
  const wsId = openData.workspaceId as string;
  const initialHead = (openData.worktree as { baseSha: string }).baseSha;
  assert.ok(wsId);
  assert.ok(initialHead);

  // 3. Inspect: read the file (separating pagination metadata)
  const readRes = await env.client.callTool({
    name: "read",
    arguments: {
      workspaceId: wsId,
      path: "service.py",
    },
  });
  const readData = structuredContent(readRes);
  assert.equal(readData.result, "def run():\n    return 'broken'\n");

  // 4. Structured Patch: repair the code via apply_patch
  const patchText = `*** Begin Patch
*** Update File: service.py
@@
 def run():
-    return 'broken'
+    return 'repaired'
*** End Patch`;

  const patchRes = await env.client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId: wsId,
      patch: patchText,
    },
  });
  assert.equal(structuredContent(patchRes).additions, 1);
  assert.equal(structuredContent(patchRes).removals, 1);

  // 5. Verify: discover verifier catalog and run workspace_verify
  const listVerifiersRes = await env.client.callTool({
    name: "workspace_list_verifiers",
    arguments: { workspaceId: wsId },
  });
  const verifierCatalog = structuredContent(listVerifiersRes).toolchains as Array<{
    toolchainId: string;
    verifiers: Array<{ name: string; available: boolean }>;
  }>;
  assert.ok(verifierCatalog.length > 0);
  const tc = verifierCatalog[0];
  const verifier = tc.verifiers.find((v) => v.available && v.name === "pytest")!;

  const verifyRes = await env.client.callTool({
    name: "workspace_verify",
    arguments: {
      workspaceId: wsId,
      toolchainId: tc.toolchainId,
      verifier: verifier.name,
      args: [],
    },
  });
  assert.equal(structuredContent(verifyRes).ok, true);

  // 6. Readback: verify source contains repaired code
  const readbackRes = await env.client.callTool({
    name: "read",
    arguments: {
      workspaceId: wsId,
      path: "service.py",
    },
  });
  assert.equal(structuredContent(readbackRes).result, "def run():\n    return 'repaired'\n");

  // 7. git_commit: form a scoped candidate commit
  const commitRes = await env.client.callTool({
    name: "git_commit",
    arguments: {
      workspaceId: wsId,
      expectedHead: initialHead,
      message: "fix: repair service run output",
      paths: ["service.py"],
    },
  });
  const commitData = structuredContent(commitRes);
  const candidateHead = commitData.commitSha as string;
  assert.ok(candidateHead);
  assert.notEqual(candidateHead, initialHead);

  // 8. git_push: publish Candidate HEAD to a non-default branch
  const pushRes = await env.client.callTool({
    name: "git_push",
    arguments: {
      workspaceId: wsId,
      attemptKey: "issue344-dogfood-push",
      expectedHead: candidateHead,
      remote: "origin",
      branch: "feat/dogfood-pr",
    },
  });
  const pushData = structuredContent(pushRes);
  assert.equal(pushData.pushedSha, candidateHead);
  assert.equal(pushData.branch, "feat/dogfood-pr");
});
