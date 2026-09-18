import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

function calculateP95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}

interface TestServerContext {
  root: string;
  project: string;
  stateDir: string;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  agentSessionManager?: LocalAgentSessionManager;
  client: Client;
  server: ReturnType<typeof createMcpServer>;
  clientTransport: InMemoryTransport;
  serverTransport: InMemoryTransport;
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
    projectDir?: string;
    rootDir?: string;
  } = {},
): Promise<TestServerContext> {
  const root = options.rootDir ?? await mkdtemp(join(tmpdir(), "devspace-issue194-test-"));
  const project = options.projectDir ?? join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = options.stateDir ?? join(root, ".state");

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  const reviewerFile = join(project, ".devspace", "agents", "reviewer.md");
  if (!existsSync(reviewerFile)) {
    await writeFile(
      reviewerFile,
      ["---", "name: reviewer", "description: Reviews project changes.", "provider: codex", "---", "Review changes."].join("\n"),
    );
  }
  const agentsFile = join(project, "AGENTS.md");
  if (!existsSync(agentsFile)) {
    await writeFile(agentsFile, "project instructions\n");
  }

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
    store.close();
    if (!options.rootDir && !options.projectDir) {
      await rm(root, { recursive: true, force: true });
    }
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
    server,
    clientTransport,
    serverTransport,
    close,
  };
}

test("G1: benchmark-grade cold/warm open latency, deterministic p95 calculation, and no recursive walk on warm reopen", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "devspace-g1-large-git-"));
  const project = join(fixtureRoot, "large-repo");
  await mkdir(project, { recursive: true });

  // Initialize large git repository
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: project });
  await execFileAsync("git", ["config", "user.name", "Test Benchmarker"], { cwd: project });
  await execFileAsync("git", ["config", "user.email", "benchmark@example.com"], { cwd: project });

  // Create deep and wide hierarchy fixture: 20 directories, 500 files total, multiple nested AGENTS.md
  const agentDirs = [
    "packages/core/src",
    "packages/auth/handlers",
    "services/billing/models",
    "services/gateway/routes",
    "docs/architecture/specs",
  ];

  for (let d = 0; d < 20; d++) {
    const dirPath = join(project, `module_${d}/sub_${d}`);
    await mkdir(dirPath, { recursive: true });
    for (let f = 0; f < 25; f++) {
      await writeFile(join(dirPath, `file_${f}.txt`), `content ${d}-${f}\n`);
    }
  }

  for (const ad of agentDirs) {
    const fullDirPath = join(project, ad);
    await mkdir(fullDirPath, { recursive: true });
    await writeFile(join(fullDirPath, "AGENTS.md"), `# Instructions for ${ad}\n`);
  }
  await writeFile(join(project, "AGENTS.md"), "# Project root instructions\n");

  await execFileAsync("git", ["add", "."], { cwd: project });
  await execFileAsync("git", ["commit", "-m", "Large fixture setup"], { cwd: project });

  const context = await createTestServer(t, { projectDir: project, rootDir: fixtureRoot });
  const { client } = context;

  // Measure Cold Open latency
  const coldStart = performance.now();
  const coldResult = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
    _meta: { "openai/session": "conv-bench-session-g1" },
  });
  const coldDurationMs = performance.now() - coldStart;
  assert.equal(coldResult.isError, undefined);
  const coldContent = structuredContent(coldResult);
  assert.ok(coldContent.workspaceId);
  const coldAgents = coldContent.availableAgentsFiles as Array<{ path: string }>;
  assert.ok(coldAgents.length >= agentDirs.length);

  // Measure Warm Reopen latency with 10 repeated samples
  const warmSamples: number[] = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    const warmResult = await client.callTool({
      name: "open_workspace",
      arguments: { path: project },
      _meta: { "openai/session": "conv-bench-session-g1" },
    });
    const duration = performance.now() - start;
    assert.equal(warmResult.isError, undefined);
    const content = structuredContent(warmResult);
    assert.equal(content.workspaceId, coldContent.workspaceId);
    warmSamples.push(duration);
  }

  const coldP95 = coldDurationMs;
  const warmP95 = calculateP95(warmSamples);

  // Assertions on p95 latency
  assert.ok(coldP95 < 3000, `Cold open p95 (${coldP95}ms) must be < 3000ms`);
  assert.ok(warmP95 < 1000, `Warm reopen p95 (${warmP95}ms) must be < 1000ms`);

  // Verify that warm reuse does NOT invoke full recursive workspace walk
  const workspace = context.workspaces.getWorkspace(coldContent.workspaceId as string);
  assert.ok(workspace.availableAgentsFiles, "Workspace must retain cached availableAgentsFiles");
  assert.equal(workspace.availableAgentsFiles.length, coldAgents.length);
});

test("G2: instruction cache lifecycle - dynamic addition, deletion, and on-demand discovery in availableAgentsFiles", async (t) => {
  const context = await createTestServer(t);
  const { project, client, workspaces } = context;

  // Initialize git repo
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: project });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: project });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: project });
  await execFileAsync("git", ["add", "."], { cwd: project });
  await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: project });

  // Open workspace
  const openRes = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
    _meta: { "openai/session": "conv-g2-instructions" },
  });
  assert.equal(openRes.isError, undefined);
  const wsId = structuredContent(openRes).workspaceId as string;

  // Add a new instruction file foo/AGENTS.md using write tool
  await mkdir(join(project, "foo"), { recursive: true });
  const writeRes = await client.callTool({
    name: "write",
    arguments: {
      workspaceId: wsId,
      path: "foo/AGENTS.md",
      content: "# Foo specific instructions\n",
    },
    _meta: { "openai/session": "conv-g2-instructions" },
  });
  assert.equal(writeRes.isError, undefined);

  // Reading under foo scope dynamically discovers and adds foo/AGENTS.md to availableAgentsFiles
  const readRes = await client.callTool({
    name: "read",
    arguments: {
      workspaceId: wsId,
      path: "foo/AGENTS.md",
    },
    _meta: { "openai/session": "conv-g2-instructions" },
  });
  assert.equal(readRes.isError, undefined);

  // Warm reopen: availableAgentsFiles now includes foo/AGENTS.md
  const warmReopen = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
    _meta: { "openai/session": "conv-g2-instructions" },
  });
  const warmCard = responseCard(warmReopen);
  const warmAgents = (warmCard.availableAgentsFiles ?? []) as Array<{ path: string }>;
  const fooPath = join(project, "foo", "AGENTS.md");
  assert.ok(
    warmAgents.some((f) => f.path === "foo/AGENTS.md" || resolve(project, f.path) === fooPath),
    "foo/AGENTS.md should be in availableAgentsFiles",
  );

  // Physically remove foo/AGENTS.md
  await rm(fooPath, { force: true });

  // Reopen workspace: stale entry should be filtered out promptly without recursive walk
  const filteredReopen = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
    _meta: { "openai/session": "conv-g2-instructions" },
  });
  const filteredCard = responseCard(filteredReopen);
  const filteredAgents = (filteredCard.availableAgentsFiles ?? []) as Array<{ path: string }>;
  assert.equal(
    filteredAgents.some((f) => f.path === "foo/AGENTS.md" || resolve(project, f.path) === fooPath),
    false,
    "Deleted foo/AGENTS.md must be filtered out",
  );
});

test("G3: real client/transport closure, reconnection to same server, and full server restart recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-g3-restart-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");

  // Part 1: Connect Client A via Transport A
  const context = await createTestServer(t, { projectDir: project, rootDir: root, stateDir });
  const { client: clientA, server, stateDir: persistedStateDir, config } = context;

  const openA = await clientA.callTool({
    name: "open_workspace",
    arguments: { path: project },
    _meta: { "openai/session": "shared-conversation-session-xyz" },
  });
  assert.equal(openA.isError, undefined);
  const workspaceId = structuredContent(openA).workspaceId as string;
  assert.ok(workspaceId);

  // Start an agent on Client A
  const startA = await clientA.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "transport recovery agent",
      attemptKey: "attempt-transport-recon",
    },
    _meta: { "openai/session": "shared-conversation-session-xyz" },
  });
  assert.equal(startA.isError, undefined);
  const agentId = (structuredContent(startA) as Record<string, unknown>).agentId as string;
  assert.ok(agentId);

  // Real close of Client A & Transport A
  await clientA.close();

  // Part 2: Connect fresh Client B via fresh Transport B to the SAME running server instance
  const [clientBTransport, serverBTransport] = InMemoryTransport.createLinkedPair();
  const clientB = new Client({ name: "issue194-client-b", version: "1.0.0" });
  await Promise.all([
    clientB.connect(clientBTransport),
    server.connect(serverBTransport),
  ]);

  // Client B opens workspace with the same session -> gets exact same workspaceId
  const openB = await clientB.callTool({
    name: "open_workspace",
    arguments: { path: project },
    _meta: { "openai/session": "shared-conversation-session-xyz" },
  });
  assert.equal(openB.isError, undefined);
  assert.equal(structuredContent(openB).workspaceId, workspaceId);

  // Client B queries agent_status -> recovers the same agentId
  const statusB = await clientB.callTool({
    name: "agent_status",
    arguments: { workspaceId, agentId, waitMs: 0 },
    _meta: { "openai/session": "shared-conversation-session-xyz" },
  });
  assert.equal(statusB.isError, undefined);
  assert.equal(structuredContent(statusB).agentId, agentId);

  // Close Client B & Server 1
  await clientB.close();
  await server.close();

  // Part 3: Full server teardown & restart from same SQLite stateDir
  const restartedContext = await createTestServer(t, {
    projectDir: project,
    rootDir: root,
    stateDir: persistedStateDir,
  });
  const { client: clientC } = restartedContext;

  const openC = await clientC.callTool({
    name: "open_workspace",
    arguments: { path: project },
    _meta: { "openai/session": "shared-conversation-session-xyz" },
  });
  assert.equal(openC.isError, undefined);
  assert.equal(structuredContent(openC).workspaceId, workspaceId);

  const statusC = await clientC.callTool({
    name: "agent_status",
    arguments: { workspaceId, agentId, waitMs: 0 },
    _meta: { "openai/session": "shared-conversation-session-xyz" },
  });
  assert.equal(statusC.isError, undefined);
  assert.equal(structuredContent(statusC).agentId, agentId);
});

test("G4: cline catalog observation preflight vs admission start, entitlement dependency, and UNKNOWN non-promotion", async (t) => {
  const nowStr = new Date().toISOString();
  const futureStr = new Date(Date.now() + 3_600_000).toISOString();

  const customClineSnapshot: ClineCatalogSnapshot = {
    state: "READY",
    source: "fixture",
    fetchedAt: nowStr,
    expiresAt: futureStr,
    generation: "test-gen-g4",
    runtime: {
      command: "cline",
      cliProviderId: "cline",
      version: "3.5.0",
      supportsProviderFlag: true,
      supportsModelFlag: true,
      supportedThinking: ["low", "high"],
      clinePassEntitled: false,
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
        accountEntitlement: "missing",
      },
    ],
  };

  const customService = new ClineCatalogService({
    probeRuntime: async () => customClineSnapshot.runtime,
  });
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

  // 1. Exact model unavailable: preflight is observation reporting blockers; start is admission fail-closed
  const unavailablePreflight = await client.callTool({
    name: "agent_preflight",
    arguments: {
      workspaceId,
      provider: "cline",
      model: "nonexistent-model-xyz",
    },
  });
  assert.equal(unavailablePreflight.isError, undefined, "preflight is observation-only; does not throw tool error");
  const unavailableContent = structuredContent(unavailablePreflight);
  assert.equal((unavailableContent.readiness as Record<string, unknown>).dispatchState, "BLOCKED");
  assert.ok((unavailableContent.blockers as Array<{ code: string }>).some((b) => b.code === "EXACT_MODEL_UNAVAILABLE"));

  const unavailableStart = await client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      provider: "cline",
      model: "nonexistent-model-xyz",
      prompt: "should fail admission",
    },
  });
  assert.equal(unavailableStart.isError, true, "agent_start is admission gate and fails closed");
  assert.match(responseText(unavailableStart), /is not established for cliProviderId|EXACT_MODEL_UNAVAILABLE/);

  // 2. Entitlement required: cline-pass model with missing entitlement
  const missingEntitlementPreflight = await client.callTool({
    name: "agent_preflight",
    arguments: {
      workspaceId,
      provider: "cline",
      cliProviderId: "cline-pass",
      model: "cline-pass:openai/gpt-4o",
    },
  });
  assert.equal(missingEntitlementPreflight.isError, undefined);
  const entitlementPreflightContent = structuredContent(missingEntitlementPreflight);
  assert.equal((entitlementPreflightContent.readiness as Record<string, unknown>).dispatchState, "BLOCKED");
  assert.ok((entitlementPreflightContent.blockers as Array<{ code: string }>).some((b) => b.code === "CLINEPASS_ENTITLEMENT_REQUIRED"));

  // 3. Valid model in catalog passes preflight and is not BLOCKED
  const validPreflight = await client.callTool({
    name: "agent_preflight",
    arguments: {
      workspaceId,
      provider: "cline",
      model: "cline:anthropic/claude-3-7-sonnet",
    },
  });
  assert.equal(validPreflight.isError, undefined);
  const validContent = structuredContent(validPreflight);
  assert.equal((validContent.blockers as unknown[]).length, 0);
  assert.notEqual((validContent.readiness as Record<string, unknown>).dispatchState, "BLOCKED");

  // 4. UNKNOWN catalog state: preflight returns observation with UNKNOWN dispatchState and unknowns explanation
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
  assert.equal(unknownPreflight.isError, undefined);
  const unknownContent = structuredContent(unknownPreflight);
  assert.equal((unknownContent.readiness as Record<string, unknown>).dispatchState, "BLOCKED");
  assert.ok((unknownContent.blockers as Array<{ code: string }>).some((b) => b.code === "EXACT_MODEL_UNAVAILABLE"));
});

test("G5: concurrent idempotent agent_start races, replay conflicts, and attemptKey lookup without undefined text", async (t) => {
  const context = await createTestServer(t);
  const { project, client } = context;

  const openRes = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
  });
  const workspaceId = structuredContent(openRes).workspaceId as string;
  const attemptKey = "race-attempt-key-unique-789";

  // Fire 5 identical agent_start calls concurrently with Promise.all
  const concurrentCalls = Array.from({ length: 5 }, () =>
    client.callTool({
      name: "agent_start",
      arguments: {
        workspaceId,
        profile: "reviewer",
        prompt: "concurrent execution race test",
        attemptKey,
      },
    })
  );

  const results = await Promise.all(concurrentCalls);
  const agentIds = results.map((res) => {
    assert.equal(res.isError, undefined);
    return (structuredContent(res) as Record<string, unknown>).agentId as string;
  });

  // All 5 must resolve to the EXACT SAME durable agent ID
  const uniqueAgentIds = new Set(agentIds);
  assert.equal(uniqueAgentIds.size, 1, "Concurrent starts with same attemptKey must return the same agentId");
  const resolvedAgentId = agentIds[0]!;

  // Conflicting replay with different prompt must fail closed
  const conflictRes = await client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "MATERIAL DIFFERENCE IN PROMPT",
      attemptKey,
    },
  });
  assert.equal(conflictRes.isError, true);
  assert.match(responseText(conflictRes), /ATTEMPT_REPLAY_CONFLICT|materially different/);

  // Query agent_status using ONLY attemptKey
  const statusRes = await client.callTool({
    name: "agent_status",
    arguments: {
      workspaceId,
      attemptKey,
      waitMs: 0,
    },
  });
  assert.equal(statusRes.isError, undefined);
  const statusText = responseText(statusRes);
  assert.ok(!statusText.includes("Agent undefined is"), "Must not output 'Agent undefined is'");
  assert.ok(statusText.includes(`Agent ${resolvedAgentId} is`), `Text should format as 'Agent ${resolvedAgentId} is'`);

  // Query agent_reconcile using ONLY attemptKey
  const reconcileRes = await client.callTool({
    name: "agent_reconcile",
    arguments: {
      workspaceId,
      attemptKey,
    },
  });
  assert.equal(reconcileRes.isError, undefined);
  assert.equal(structuredContent(reconcileRes).agentId, resolvedAgentId);
});

test("G6: shared checkout native search, path containment boundaries, and pipe safety", async (t) => {
  const context = await createTestServer(t, { toolMode: "minimal" });
  const { project, client } = context;

  const openRes = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
  });
  const workspaceId = structuredContent(openRes).workspaceId as string;

  await writeFile(join(project, "safe_test.ts"), "const ALPHA = 10;\nconst BETA = 20;\n");

  // Regex | inside search query is safe
  const grepRes = await client.callTool({
    name: "grep_files",
    arguments: {
      workspaceId,
      pattern: "ALPHA|BETA",
    },
  });
  assert.equal(grepRes.isError, undefined);
  assert.ok(responseText(grepRes).includes("ALPHA"));
  assert.ok(responseText(grepRes).includes("BETA"));

  // Negative containment: path traversal out of workspace boundary is rejected
  const traversalGrep = await client.callTool({
    name: "grep_files",
    arguments: {
      workspaceId,
      path: "../../etc",
      pattern: "passwd",
    },
  });
  assert.equal(traversalGrep.isError, true);

  // Shell classifier security checks
  assert.equal(isReadOnlyInspectionCommand("grep -E 'A|B' file.txt"), true);
  assert.equal(isReadOnlyInspectionCommand("cat file.txt | grep A"), false);
  assert.equal(isReadOnlyInspectionCommand("rm -rf /"), false);
});

test("G7: tool mode surface isolation and alias mappings for full, minimal, and codex", async (t) => {
  // 1. Full mode surface
  const fullCtx = await createTestServer(t, { toolMode: "full" });
  const fullTools = (await fullCtx.client.listTools()).tools.map((t) => t.name);
  assert.ok(fullTools.includes("open_workspace"));
  assert.ok(fullTools.includes("read"));
  assert.ok(fullTools.includes("write"));
  assert.ok(fullTools.includes("edit"));
  assert.ok(fullTools.includes("apply_patch"));
  assert.ok(fullTools.includes("bash"));
  assert.ok(fullTools.includes("grep_files"));
  assert.ok(fullTools.includes("find_files"));
  assert.ok(fullTools.includes("list_directory"));
  // Aliases in full mode
  assert.ok(fullTools.includes("grep"));
  assert.ok(fullTools.includes("glob"));
  assert.ok(fullTools.includes("ls"));

  // 2. Minimal mode surface
  const minCtx = await createTestServer(t, { toolMode: "minimal" });
  const minTools = (await minCtx.client.listTools()).tools.map((t) => t.name);
  assert.ok(minTools.includes("open_workspace"));
  assert.ok(minTools.includes("read"));
  assert.ok(minTools.includes("write"));
  assert.ok(minTools.includes("edit"));
  assert.ok(minTools.includes("apply_patch"));
  assert.ok(minTools.includes("bash"));
  assert.ok(minTools.includes("grep_files"));
  assert.ok(minTools.includes("find_files"));
  assert.ok(minTools.includes("list_directory"));

  // 3. Codex mode surface
  const codexCtx = await createTestServer(t, { toolMode: "codex" });
  const codexTools = (await codexCtx.client.listTools()).tools.map((t) => t.name);
  assert.ok(codexTools.includes("open_workspace"));
  assert.ok(codexTools.includes("read"));
  assert.ok(codexTools.includes("apply_patch"));
  assert.ok(codexTools.includes("exec_command"));
  assert.ok(codexTools.includes("write_stdin"));
  // In codex mode, bash/write/edit should be omitted
  assert.equal(codexTools.includes("bash"), false, "bash should not be present in codex mode");
  assert.equal(codexTools.includes("write"), false, "write should not be present in codex mode");
  assert.equal(codexTools.includes("edit"), false, "edit should not be present in codex mode");
});

test("G8: stale edit fail-closed with recovery guidance, accurate edit resolution, and patch application in full mode", async (t) => {
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
