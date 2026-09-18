import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { MINIMUM_CODEX_RUNTIME_VERSION } from "./codex-runtime.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { DurableOperationManager } from "./durable-operations.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry, findAvailableAgentsFiles, type AvailableAgentsFile } from "./workspaces.js";
import { LocalAgentSessionManager } from "./local-agent-sessions.js";
import { CORE_MUTATION_TEST_ONLY_UNTRUSTED_BYPASS } from "./core-mutation-tools.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import { ClineCatalogService, type ClineCatalogSnapshot } from "./local-agent-cline-catalog.js";
import { isReadOnlyInspectionCommand } from "./conversation-isolation.js";

const execFileAsync = promisify(execFile);

// Hermetic Codex runtime fixture to satisfy server dispatch preconditions
const originalDependencyRoot = process.env.DEVSPACE_DEPENDENCY_ROOT;
const codexRuntimeRoot = mkdtempSync(join(tmpdir(), "devspace-issue194-codex-runtime-"));
mkdirSync(join(codexRuntimeRoot, "node_modules", "@openai", "codex-sdk"), { recursive: true });
writeFileSync(
  join(codexRuntimeRoot, "node_modules", "@openai", "codex-sdk", "package.json"),
  JSON.stringify({ name: "@openai/codex-sdk", version: MINIMUM_CODEX_RUNTIME_VERSION }),
);
const codexExecutable = join(codexRuntimeRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
mkdirSync(dirname(codexExecutable), { recursive: true });
writeFileSync(
  codexExecutable,
  `#!/bin/sh\necho 'codex-cli ${MINIMUM_CODEX_RUNTIME_VERSION}'\n`,
  { mode: 0o755 },
);
process.env.DEVSPACE_DEPENDENCY_ROOT = codexRuntimeRoot;

after(async () => {
  if (originalDependencyRoot === undefined) delete process.env.DEVSPACE_DEPENDENCY_ROOT;
  else process.env.DEVSPACE_DEPENDENCY_ROOT = originalDependencyRoot;
  await rm(codexRuntimeRoot, { recursive: true, force: true });
});

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  return content
    .filter((c): c is { type: "text"; text: string } => Boolean(c && typeof c === "object" && (c as { type?: unknown }).type === "text"))
    .map((c) => c.text)
    .join("\n");
}

interface TestServerContext {
  root: string;
  project: string;
  stateDir: string;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  agentSessionManager?: LocalAgentSessionManager;
  client: Client;
  close: () => Promise<void>;
}

async function createTestServer(
  t: TestContext,
  options: {
    toolMode?: "full" | "minimal" | "codex";
    localAgentProviders?: LocalAgentProviderAvailability[] | (() => LocalAgentProviderAvailability[]);
    clineService?: ClineCatalogService;
    subagentsEnabled?: boolean;
    stateDir?: string;
  } = {},
): Promise<TestServerContext> {
  const root = await mkdtemp(join(tmpdir(), "devspace-issue194-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = options.stateDir ?? join(root, ".state");

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(
    join(project, ".devspace", "agents", "reviewer.md"),
    ["---", "name: reviewer", "description: Reviews project changes.", "provider: codex", "---", "Review changes."].join("\n"),
  );

  const initialProviders = typeof options.localAgentProviders === "function"
    ? options.localAgentProviders()
    : options.localAgentProviders ?? [];

  const loadedConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_TOOL_MODE: options.toolMode ?? "full",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
    DEVSPACE_STATE_DIR: stateDir,
  });

  const config: ServerConfig = {
    ...loadedConfig,
    toolMode: options.toolMode ?? loadedConfig.toolMode,
    subagents: {
      ...loadedConfig.subagents,
      enabled: options.subagentsEnabled ?? true,
      providers: initialProviders.map((p) => ({ id: p.name, enabled: true })),
    },
  };

  const resolveProviderAvailability = typeof options.localAgentProviders === "function"
    ? options.localAgentProviders
    : () => initialProviders;

  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    resolveProviderAvailability(),
  );

  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const agentSessionManager = config.subagents.enabled
    ? new LocalAgentSessionManager(
        config,
        async () => {},
        async () => true,
        undefined,
        undefined,
        undefined,
        options.clineService,
      )
    : undefined;

  const durableOperations = new DurableOperationManager(config);
  const processSessions = new ProcessSessionManager();

  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    processSessions,
    resolveLocalAgentProviders,
    [],
    agentSessionManager,
    undefined,
    undefined,
    durableOperations,
    undefined,
    undefined,
    options.clineService,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    CORE_MUTATION_TEST_ONLY_UNTRUSTED_BYPASS,
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "issue194-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  const close = async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  };

  t.after(close);

  return {
    root,
    project,
    stateDir,
    config,
    workspaces,
    agentSessionManager,
    client,
    close,
  };
}

test("G1: large git workspace open & warm reopen latency with AGENTS.md caching", async (t) => {
  const context = await createTestServer(t);
  const { project, client } = context;

  // Initialize git repository
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: project });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: project });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: project });

  // Create deep hierarchy with nested AGENTS.md and dummy files
  const nestedDirs = [
    "pkg/module_a/submodule_1",
    "pkg/module_b/submodule_2",
    "services/auth/handlers",
    "services/billing/models",
    "docs/deep/nested/spec",
  ];

  for (const dir of nestedDirs) {
    const fullDirPath = join(project, dir);
    await mkdir(fullDirPath, { recursive: true });
    await writeFile(join(fullDirPath, "AGENTS.md"), `# Instructions for ${dir}\n`);
    for (let i = 0; i < 5; i++) {
      await writeFile(join(fullDirPath, `file_${i}.txt`), `content ${i}\n`);
    }
  }

  await execFileAsync("git", ["add", "."], { cwd: project });
  await execFileAsync("git", ["commit", "-m", "Initial deep structure"], { cwd: project });

  // Test findAvailableAgentsFiles directly to verify git ls-files fast path
  const gitDiscovered = await findAvailableAgentsFiles(project);
  assert.ok(gitDiscovered.length >= nestedDirs.length, `Expected at least ${nestedDirs.length} agents files, got ${gitDiscovered.length}`);
  for (const dir of nestedDirs) {
    const expectedPath = join(project, dir, "AGENTS.md");
    assert.ok(
      gitDiscovered.some((f: AvailableAgentsFile) => f.path === expectedPath),
      `Expected ${expectedPath} in git discovery`,
    );
  }

  // Cold open via MCP tool
  const coldResult = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
    _meta: { "openai/session": "conv-g1-cold-warm" },
  });
  assert.equal(coldResult.isError, undefined);
  assert.match(responseText(coldResult), /Opened workspace/);
  const coldContent = structuredContent(coldResult);
  assert.ok(coldContent.workspaceId);
  const coldAgents = coldContent.availableAgentsFiles as Array<{ path: string }>;
  assert.ok(coldAgents.length >= nestedDirs.length);

  // Warm reopen via MCP tool with same session and path
  const warmResult = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
    _meta: { "openai/session": "conv-g1-cold-warm" },
  });
  assert.equal(warmResult.isError, undefined);
  const warmContent = structuredContent(warmResult);
  assert.match(responseText(warmResult), /already open/);
  assert.equal(warmContent.workspaceId, coldContent.workspaceId);
  // Verify internal workspace instance cached availableAgentsFiles
  const cachedWorkspace = context.workspaces.getWorkspace(coldContent.workspaceId as string);
  assert.ok(cachedWorkspace.availableAgentsFiles);
  assert.ok(cachedWorkspace.availableAgentsFiles.length >= nestedDirs.length);

  // Non-git fallback discovery test
  const nonGitRoot = await mkdtemp(join(tmpdir(), "devspace-nongit-g1-"));
  try {
    const nonGitSub = join(nonGitRoot, "sub/deep");
    await mkdir(nonGitSub, { recursive: true });
    await writeFile(join(nonGitSub, "AGENTS.md"), "nongit instructions\n");
    const nonGitDiscovered = await findAvailableAgentsFiles(nonGitRoot);
    assert.equal(nonGitDiscovered.length, 1);
    assert.equal(nonGitDiscovered[0].path, join(nonGitSub, "AGENTS.md"));
  } finally {
    await rm(nonGitRoot, { recursive: true, force: true });
  }
});

test("G2: ChatGPT multi-turn transport recovery across sessions and server restarts", async (t) => {
  const context = await createTestServer(t);
  const { project, client, workspaces, stateDir, config } = context;

  // Turn 1: Client opens workspace with conversation scope
  const turn1Result = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
    _meta: { "openai/conversation_id": "chatgpt-turn-identity-123" },
  });
  assert.equal(turn1Result.isError, undefined);
  const turn1Content = structuredContent(turn1Result);
  const workspaceId = turn1Content.workspaceId as string;
  assert.ok(workspaceId);

  // Turn 1: Start an agent in this workspace
  const startResult = await client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "turn 1 initial prompt",
      attemptKey: "attempt-turn-1",
    },
    _meta: { "openai/conversation_id": "chatgpt-turn-identity-123" },
  });
  assert.equal(startResult.isError, undefined);
  const startContent = structuredContent(startResult);
  const agentId = startContent.agentId as string;
  assert.ok(agentId);

  // Reopen workspace directly with conversationScopeId, verify reused
  const reusedWorkspace = await workspaces.openWorkspace(project, {
    conversationScopeId: "chatgpt-turn-identity-123",
  });
  assert.equal(reusedWorkspace.workspaceReused, true);
  assert.equal(reusedWorkspace.workspace.id, workspaceId);

  // Query agent_status on the original server using alternative allowed conversation keys
  for (const altKey of ["chatgpt/session", "openai/session"]) {
    const statusQuery = await client.callTool({
      name: "agent_status",
      arguments: { workspaceId, agentId, waitMs: 0 },
      _meta: { [altKey]: "chatgpt-turn-identity-123" },
    });
    assert.equal(statusQuery.isError, undefined);
    const statusContent = structuredContent(statusQuery);
    assert.equal(statusContent.agentId, agentId);
  }

  // Turn 3: Full Server Restart simulation with same SQLite stateDir
  const store2 = new SqliteWorkspaceStore(stateDir);
  const workspaces2 = new WorkspaceRegistry(config, store2);
  const restartedWorkspace = await workspaces2.openWorkspace(project, {
    conversationScopeId: "chatgpt-turn-identity-123",
  });
  assert.equal(restartedWorkspace.workspaceReused, true);
  assert.equal(restartedWorkspace.workspace.id, workspaceId);
  store2.close();
});

test("G3: cline catalog exact selection, entitlement enforcement, and UNKNOWN state non-promotion", async (t) => {
  const nowStr = new Date().toISOString();
  const futureStr = new Date(Date.now() + 3_600_000).toISOString();

  const customClineSnapshot: ClineCatalogSnapshot = {
    state: "READY",
    source: "fixture",
    fetchedAt: nowStr,
    expiresAt: futureStr,
    generation: "test-gen-1",
    runtime: {
      command: "cline",
      cliProviderId: "cline",
      version: "3.5.0",
      supportsProviderFlag: true,
      supportsModelFlag: true,
      supportedThinking: ["low", "high"],
      clinePassEntitled: false, // Default: no ClinePass subscription
    },
    entries: [
      {
        cliProviderId: "cline",
        catalogTier: "free",
        modelProviderId: "anthropic",
        modelId: "claude-3-7-sonnet",
        fullName: "cline:anthropic/claude-3-7-sonnet",
        routeKey: "cline:anthropic/claude-3-7-sonnet",
        thinking: ["low", "high"],
        thinkingKnown: true,
        supportsReasoning: true,
        free: "known-paid",
        source: "fixture",
        accountEntitlement: "entitled",
      },
      {
        cliProviderId: "cline-pass",
        catalogTier: "pass",
        modelProviderId: "openai",
        modelId: "gpt-4o",
        fullName: "cline-pass:openai/gpt-4o",
        routeKey: "cline-pass:openai/gpt-4o",
        thinking: [],
        thinkingKnown: true,
        supportsReasoning: false,
        free: "known-paid",
        source: "fixture",
        accountEntitlement: "missing", // Missing entitlement!
      },
    ],
  };

  const customService = new ClineCatalogService({
    probeRuntime: async () => customClineSnapshot.runtime,
  });
  // Inject mock snapshot directly
  (customService as unknown as { snapshot?: ClineCatalogSnapshot }).snapshot = customClineSnapshot;

  const context = await createTestServer(t, {
    localAgentProviders: [
      { name: "cline", available: true },
      { name: "codex", available: true },
    ],
    clineService: customService,
  });
  const { project, client } = context;

  const openRes = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
  });
  const workspaceId = structuredContent(openRes).workspaceId as string;

  // 1. Exact model unavailable test: Model not in catalog must be rejected immediately
  const unavailableModelPreflight = await client.callTool({
    name: "agent_preflight",
    arguments: {
      workspaceId,
      provider: "cline",
      model: "nonexistent-model-xyz",
    },
  });
  assert.equal(unavailableModelPreflight.isError, true);
  assert.match(responseText(unavailableModelPreflight), /not established for cliProviderId|EXACT_MODEL_UNAVAILABLE/);

  const unavailableModelStart = await client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      provider: "cline",
      model: "nonexistent-model-xyz",
      prompt: "should fail",
    },
  });
  assert.equal(unavailableModelStart.isError, true);
  assert.match(responseText(unavailableModelStart), /not established for cliProviderId|EXACT_MODEL_UNAVAILABLE/);

  // 2. Entitlement required test: cline-pass model with missing entitlement must be rejected
  const missingEntitlementPreflight = await client.callTool({
    name: "agent_preflight",
    arguments: {
      workspaceId,
      provider: "cline",
      cliProviderId: "cline-pass",
      model: "cline-pass:openai/gpt-4o",
    },
  });
  assert.equal(missingEntitlementPreflight.isError, true);
  assert.match(responseText(missingEntitlementPreflight), /entitlement is missing|CLINEPASS_ENTITLEMENT_REQUIRED/i);

  // 3. Valid direct model in catalog must pass preflight
  const validPreflight = await client.callTool({
    name: "agent_preflight",
    arguments: {
      workspaceId,
      provider: "cline",
      model: "cline:anthropic/claude-3-7-sonnet",
    },
  });
  assert.equal(validPreflight.isError, undefined, responseText(validPreflight));
  const preflightContent = structuredContent(validPreflight);
  assert.equal((preflightContent.blockers as unknown[]).length, 0);
  assert.equal((preflightContent.readiness as Record<string, unknown>).profileResolved, true);
  assert.equal((preflightContent.readiness as Record<string, unknown>).runtimeReady, true);
  assert.notEqual((preflightContent.readiness as Record<string, unknown>).dispatchState, "BLOCKED");

  // 4. UNKNOWN catalog state test: preflight must NOT promote to READY
  const unknownSnapshot: ClineCatalogSnapshot = {
    state: "UNKNOWN",
    source: "none",
    fetchedAt: nowStr,
    generation: "unknown",
    runtime: {
      command: "cline",
      cliProviderId: "cline",
      version: "unknown",
      supportsProviderFlag: false,
      supportsModelFlag: false,
      supportedThinking: [],
    },
    entries: [],
  };

  const unknownService = new ClineCatalogService({
    probeRuntime: async () => unknownSnapshot.runtime,
  });
  (unknownService as unknown as { snapshot?: ClineCatalogSnapshot }).snapshot = unknownSnapshot;

  const unknownContext = await createTestServer(t, {
    localAgentProviders: [{ name: "cline", available: true }],
    clineService: unknownService,
  });
  const unknownOpen = await unknownContext.client.callTool({
    name: "open_workspace",
    arguments: { path: unknownContext.project },
  });
  const unknownWsId = structuredContent(unknownOpen).workspaceId as string;

  const unknownPreflight = await unknownContext.client.callTool({
    name: "agent_preflight",
    arguments: {
      workspaceId: unknownWsId,
      provider: "cline",
      model: "cline:anthropic/claude-3-7-sonnet",
    },
  });
  // Since catalog is unknown and model is not established, it fails closed
  assert.equal(unknownPreflight.isError, true);
});

test("G4: idempotent agent dispatch replay, replay conflict detection, and attemptKey lookup in status/reconcile", async (t) => {
  const context = await createTestServer(t);
  const { project, client } = context;

  const openRes = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
  });
  const workspaceId = structuredContent(openRes).workspaceId as string;
  const attemptKey = "attempt-g4-unique-12345";

  // First start
  const start1 = await client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "Initial task description for attemptKey",
      attemptKey,
    },
  });
  assert.equal(start1.isError, undefined);
  const agentId = (structuredContent(start1) as Record<string, unknown>).agentId as string;
  assert.ok(agentId);

  // Exact idempotent replay with identical parameters
  const startReplay = await client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "Initial task description for attemptKey",
      attemptKey,
    },
  });
  assert.equal(startReplay.isError, undefined);
  const replayContent = structuredContent(startReplay);
  assert.equal(replayContent.agentId, agentId);

  // Conflicting replay with materially different prompt
  const startConflict = await client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "CONFLICTING DIFFERENT PROMPT",
      attemptKey,
    },
  });
  assert.equal(startConflict.isError, true);
  assert.match(responseText(startConflict), /materially different request|ATTEMPT_REPLAY_CONFLICT/);

  // Query agent_status using ONLY attemptKey (omitting agentId)
  const statusByAttempt = await client.callTool({
    name: "agent_status",
    arguments: {
      workspaceId,
      attemptKey,
      waitMs: 0,
    },
  });
  assert.equal(statusByAttempt.isError, undefined);
  const statusContent = structuredContent(statusByAttempt);
  assert.equal(statusContent.agentId, agentId);

  // Query agent_reconcile using ONLY attemptKey (omitting agentId)
  const reconcileByAttempt = await client.callTool({
    name: "agent_reconcile",
    arguments: {
      workspaceId,
      attemptKey,
    },
  });
  assert.equal(reconcileByAttempt.isError, undefined);
  const reconcileContent = structuredContent(reconcileByAttempt);
  assert.equal(reconcileContent.agentId, agentId);
});

test("G5: search tools availability in minimal mode, regex pipe safety, and bash pipe guard enforcement", async (t) => {
  // Test in toolMode: "minimal"
  const context = await createTestServer(t, { toolMode: "minimal" });
  const { project, client } = context;

  // 1. Verify tools discovery: list_directory, find_files, grep_files are registered even in minimal mode
  const toolList = await client.listTools();
  const toolNames = new Set(toolList.tools.map((t) => t.name));
  assert.ok(toolNames.has("list_directory"), "list_directory must be registered in minimal mode");
  assert.ok(toolNames.has("find_files"), "find_files must be registered in minimal mode");
  assert.ok(toolNames.has("grep_files"), "grep_files must be registered in minimal mode");

  const openRes = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
  });
  const workspaceId = structuredContent(openRes).workspaceId as string;

  // Prepare test files
  await writeFile(join(project, "test_search.ts"), "const ALPHA_VAL = 100;\nconst BETA_VAL = 200;\nconst OTHER = 300;\n");

  // 2. Test regex search with pattern containing regex pipe |
  const grepResult = await client.callTool({
    name: "grep_files",
    arguments: {
      workspaceId,
      pattern: "ALPHA_VAL|BETA_VAL",
    },
  });
  assert.equal(grepResult.isError, undefined);
  const grepText = responseText(grepResult);
  assert.ok(grepText.includes("ALPHA_VAL"), "Should match ALPHA_VAL");
  assert.ok(grepText.includes("BETA_VAL"), "Should match BETA_VAL");

  // 3. Test find_files with glob pattern
  const findResult = await client.callTool({
    name: "find_files",
    arguments: {
      workspaceId,
      pattern: "*.ts",
    },
  });
  assert.equal(findResult.isError, undefined);
  assert.ok(responseText(findResult).includes("test_search.ts"));

  // 4. Test bash pipe guard & regex delimiter safety:
  // Regex | inside quotes is safe and read-only; unquoted shell pipe | and command substitution are blocked
  assert.equal(isReadOnlyInspectionCommand("grep -E 'ALPHA|BETA' test_search.ts"), true);
  assert.equal(isReadOnlyInspectionCommand("echo 'blocked' | cat"), false);
  assert.equal(isReadOnlyInspectionCommand("echo $(whoami)"), false);
  assert.equal(isReadOnlyInspectionCommand("echo `whoami`"), false);

  // 5. Test nonexistent path returns structured error without corrupting workspace
  const badGrep = await client.callTool({
    name: "grep_files",
    arguments: {
      workspaceId,
      path: "nonexistent_dir_xyz",
      pattern: "foo",
    },
  });
  assert.equal(badGrep.isError, true);
});

test("G6: stale edit fail-closed with recovery guidance, accurate edit resolution, and patch application in full mode", async (t) => {
  const context = await createTestServer(t, { toolMode: "full" });
  const { project, client } = context;

  const openRes = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
  });
  const workspaceId = structuredContent(openRes).workspaceId as string;

  const targetFile = "editable.txt";
  const initialContent = "line 1: apple\nline 2: banana\nline 3: cherry\n";
  await writeFile(join(project, targetFile), initialContent);

  // 1. Stale edit: oldText does not match current file content
  const staleEdit = await client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      path: targetFile,
      edits: [
        {
          oldText: "line 2: orange (stale content)",
          newText: "line 2: blueberry",
        },
      ],
    },
  });
  assert.equal(staleEdit.isError, true);
  // Fail-closed verification: file content must remain completely unchanged
  assert.equal(await readFile(join(project, targetFile), "utf8"), initialContent);
  // Recovery guidance verification: error text must advise reading current content and trying exact edit
  const errorMsg = responseText(staleEdit);
  assert.match(errorMsg, /read/i);
  assert.match(errorMsg, /exact/i);

  // 2. Recovery: read latest content, then perform accurate exact edit
  const readRes = await client.callTool({
    name: "read",
    arguments: {
      workspaceId,
      path: targetFile,
    },
  });
  assert.equal(readRes.isError, undefined);
  assert.ok(responseText(readRes).includes("line 2: banana"));

  const accurateEdit = await client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      path: targetFile,
      edits: [
        {
          oldText: "line 2: banana",
          newText: "line 2: blueberry",
        },
      ],
    },
  });
  assert.equal(accurateEdit.isError, undefined);
  const updatedContent = await readFile(join(project, targetFile), "utf8");
  assert.equal(updatedContent, "line 1: apple\nline 2: blueberry\nline 3: cherry\n");

  // 3. Fast patch application via apply_patch in full mode
  const toolList = await client.listTools();
  assert.ok(
    toolList.tools.some((tool) => tool.name === "apply_patch"),
    "apply_patch must be registered in full mode",
  );

  const patchString = [
    "*** Begin Patch",
    `*** Update File: ${targetFile}`,
    "@@",
    " line 1: apple",
    "-line 2: blueberry",
    "+line 2: blackberry",
    " line 3: cherry",
    "*** End Patch",
  ].join("\n");

  const patchRes = await client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId,
      patch: patchString,
    },
  });
  assert.equal(patchRes.isError, undefined, responseText(patchRes));
  const postPatchContent = await readFile(join(project, targetFile), "utf8");
  assert.equal(postPatchContent, "line 1: apple\nline 2: blackberry\nline 3: cherry\n");
});
