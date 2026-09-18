import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("G1: benchmark-grade cold/warm open latency, deterministic p95 calculation, and instruction discovery hook witness", async (t) => {
  async function createLargeRepo(root: string, name: string) {
    const project = join(root, name);
    await mkdir(project, { recursive: true });
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: project });
    await execFileAsync("git", ["config", "user.name", "Test Benchmarker"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "benchmark@example.com"], { cwd: project });

    const agentDirs = [
      "packages/core/src",
      "packages/auth/handlers",
      "services/billing/models",
      "services/gateway/routes",
      "docs/architecture/specs",
    ];

    for (let d = 0; d < 10; d++) {
      const dirPath = join(project, `module_${d}/sub_${d}`);
      await mkdir(dirPath, { recursive: true });
      for (let f = 0; f < 10; f++) {
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
    return { project, agentDirs };
  }

  const fixtureRoot = await mkdtemp(join(tmpdir(), "devspace-g1-bench-"));
  const coldSamples: number[] = [];
  let firstProject = "";
  let firstContext: TestServerContext | undefined;
  let firstWorkspaceId = "";
  let firstAgentCount = 0;

  // 1. Multiple independent cold fixtures/open samples (3 distinct large fixtures)
  for (let c = 0; c < 3; c++) {
    const { project, agentDirs } = await createLargeRepo(fixtureRoot, `repo_${c}`);
    if (c === 0) {
      firstProject = project;
      firstAgentCount = agentDirs.length;
    }
    const context = await createTestServer(t, { projectDir: project, rootDir: fixtureRoot });
    if (c === 0) firstContext = context;

    const coldStart = performance.now();
    const coldResult = await context.client.callTool({
      name: "open_workspace",
      arguments: { path: project },
      _meta: { "openai/session": `conv-cold-session-${c}` },
    });
    const duration = performance.now() - coldStart;
    assert.equal(coldResult.isError, undefined);
    const content = structuredContent(coldResult);
    if (c === 0) firstWorkspaceId = content.workspaceId as string;
    coldSamples.push(duration);
  }

  // 2. Warm repeated reopen samples (10 repeated reopen calls on first repo)
  const warmSamples: number[] = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    const warmResult = await firstContext!.client.callTool({
      name: "open_workspace",
      arguments: { path: firstProject },
      _meta: { "openai/session": "conv-cold-session-0" },
    });
    const duration = performance.now() - start;
    assert.equal(warmResult.isError, undefined);
    assert.equal(structuredContent(warmResult).workspaceId, firstWorkspaceId);
    warmSamples.push(duration);
  }

  const coldP95 = calculateP95(coldSamples);
  const warmP95 = calculateP95(warmSamples);

  // Assertions on p95 latency: cold p95 < 3s, warm p95 < 1s
  assert.ok(coldP95 < 3000, `Cold open p95 (${coldP95}ms) must be < 3000ms`);
  assert.ok(warmP95 < 1000, `Warm reopen p95 (${warmP95}ms) must be < 1000ms`);

  // 3. Instrumentation / test hook witness:
  // warm normal reopen -> full instruction discovery call count = 0
  const countBeforeNormal = firstContext!.workspaces.instructionDiscoveryCalls;
  await firstContext!.client.callTool({
    name: "open_workspace",
    arguments: { path: firstProject },
    _meta: { "openai/session": "conv-cold-session-0" },
  });
  const normalDiscoveryDiff = firstContext!.workspaces.instructionDiscoveryCalls - countBeforeNormal;
  assert.equal(normalDiscoveryDiff, 0, "Warm normal reopen must invoke zero deep discovery calls");

  // refresh=true -> discovery call count = 1
  const countBeforeRefresh = firstContext!.workspaces.instructionDiscoveryCalls;
  await firstContext!.client.callTool({
    name: "open_workspace",
    arguments: { path: firstProject, refresh: true },
    _meta: { "openai/session": "conv-cold-session-0" },
  });
  const refreshDiscoveryDiff = firstContext!.workspaces.instructionDiscoveryCalls - countBeforeRefresh;
  assert.equal(refreshDiscoveryDiff, 1, "open_workspace with refresh=true must invoke exactly 1 deep discovery call");
});

test("G2: instruction cache lifecycle - bounded ancestor-chain discovery, external creation, deletion, and zero global walk regression", async (t) => {
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

  // 1. External creation of nested AGENTS.md directly on filesystem (without write/edit/apply_patch tool)
  const nestedSubdir = join(project, "packages", "service");
  await mkdir(nestedSubdir, { recursive: true });
  const externalAgentsPath = join(nestedSubdir, "AGENTS.md");
  await writeFile(externalAgentsPath, "# Service specific external instructions\n");
  const targetCodeFile = join(nestedSubdir, "index.ts");
  await writeFile(targetCodeFile, "export const service = 'ok';\n");

  // 2. Subsequent read under that subtree discovers and adds packages/service/AGENTS.md via ancestor-chain discovery
  const discoveryCallsBeforeRead = workspaces.instructionDiscoveryCalls;
  const readRes = await client.callTool({
    name: "read",
    arguments: {
      workspaceId: wsId,
      path: "packages/service/index.ts",
    },
    _meta: { "openai/session": "conv-g2-instructions" },
  });
  assert.equal(readRes.isError, undefined);

  // Assert discovery occurred without triggering a full global recursive walk
  assert.equal(
    workspaces.instructionDiscoveryCalls,
    discoveryCallsBeforeRead,
    "Ancestor-chain discovery must not trigger a full recursive discovery call",
  );

  const ws = workspaces.getWorkspace(wsId);
  const hasDiscovered = ws.availableAgentsFiles?.some(
    (f) => f.path === externalAgentsPath || resolve(project, f.path) === externalAgentsPath,
  );
  assert.ok(hasDiscovered, "packages/service/AGENTS.md must be discovered via bounded ancestor chain");

  // 3. Warm reopen: availableAgentsFiles contains packages/service/AGENTS.md
  const warmReopen = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
    _meta: { "openai/session": "conv-g2-instructions" },
  });
  const warmCard = responseCard(warmReopen);
  const warmAgents = (warmCard.availableAgentsFiles ?? []) as Array<{ path: string }>;
  assert.ok(
    warmAgents.some((f) => f.path === "packages/service/AGENTS.md" || resolve(project, f.path) === externalAgentsPath),
    "packages/service/AGENTS.md should be in availableAgentsFiles on warm reopen",
  );

  // 4. Rename/delete: physically remove the nested file
  await rm(externalAgentsPath, { force: true });

  // Subsequent read under the subtree prunes the deleted instruction
  await client.callTool({
    name: "read",
    arguments: {
      workspaceId: wsId,
      path: "packages/service/index.ts",
    },
    _meta: { "openai/session": "conv-g2-instructions" },
  });
  const stillPresent = ws.availableAgentsFiles?.some(
    (f) => f.path === externalAgentsPath || resolve(project, f.path) === externalAgentsPath,
  );
  assert.equal(stillPresent, false, "Deleted nested AGENTS.md must be pruned on subsequent access");
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
  // Attribution / provenance check: Cline preflight returns Cline catalog receipt
  const clineCat = validContent.catalog as Record<string, unknown>;
  assert.equal(clineCat.source, "fixture");
  assert.equal(clineCat.version, "3.5.0");
  assert.equal(clineCat.generation, "test-gen-g4");

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
  assert.equal((unknownContent.readiness as Record<string, unknown>).dispatchState, "UNKNOWN");
  assert.equal((unknownContent.blockers as unknown[]).length, 0);
  assert.ok((unknownContent.unknowns as string[]).some((u) => u.includes("Cline model catalog is unverified/stale")));
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

  // 1. Missing attemptKey on model-facing call must fail closed
  const missingAttemptKeyRes = await client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "missing attempt key prompt",
    },
    _meta: { "openai/session": "chatgpt-session-model-facing-123" },
  });
  assert.equal(missingAttemptKeyRes.isError, true);
  assert.match(responseText(missingAttemptKeyRes), /ATTEMPT_KEY_REQUIRED/);

  // 2. Conflicting replay with different prompt must fail closed
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

  // 3. Lost-response / simulated retry replay: identical start returns existing durable agent without duplicate
  const replayRes = await client.callTool({
    name: "agent_start",
    arguments: {
      workspaceId,
      profile: "reviewer",
      prompt: "concurrent execution race test",
      attemptKey,
    },
  });
  assert.equal(replayRes.isError, undefined);
  assert.equal((structuredContent(replayRes) as Record<string, unknown>).agentId, resolvedAgentId);

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

test("G6: native search 11-point acceptance suite (shared/worktree/core bounds, truncation, timeout, traversal, symlink, regex data, pipe block)", async (t) => {
  const context = await createTestServer(t, { toolMode: "minimal" });
  const { project, root, client } = context;

  // 1. Shared checkout search without mutation authority
  const openRes = await client.callTool({
    name: "open_workspace",
    arguments: { path: project },
  });
  const workspaceId = structuredContent(openRes).workspaceId as string;

  await writeFile(join(project, "safe_test.ts"), "const ALPHA = 10;\nconst BETA = 20;\n");
  for (let i = 0; i < 50; i++) {
    await writeFile(join(project, `file_${i}.txt`), `line with MATCH_${i} and common keyword\n`);
  }

  const sharedGrep = await client.callTool({
    name: "grep_files",
    arguments: { workspaceId, pattern: "common keyword" },
  });
  assert.equal(sharedGrep.isError, undefined);
  assert.ok(responseText(sharedGrep).includes("common keyword"));

  const sharedFind = await client.callTool({
    name: "find_files",
    arguments: { workspaceId, pattern: "*.txt" },
  });
  assert.equal(sharedFind.isError, undefined);
  assert.ok(responseText(sharedFind).includes("file_0.txt"));

  const sharedLs = await client.callTool({
    name: "list_directory",
    arguments: { workspaceId, path: "." },
  });
  assert.equal(sharedLs.isError, undefined);
  assert.ok(responseText(sharedLs).includes("safe_test.ts"));

  // 2. Isolated worktree search
  const worktreeDir = join(root, "worktree-proj");
  await mkdir(worktreeDir, { recursive: true });
  await writeFile(join(worktreeDir, "worktree_file.ts"), "const WORKTREE_TOKEN = 999;\n");
  const wtOpen = await client.callTool({
    name: "open_workspace",
    arguments: { path: worktreeDir },
  });
  const wtId = structuredContent(wtOpen).workspaceId as string;
  const wtGrep = await client.callTool({
    name: "grep_files",
    arguments: { workspaceId: wtId, pattern: "WORKTREE_TOKEN" },
  });
  assert.equal(wtGrep.isError, undefined);
  assert.ok(responseText(wtGrep).includes("WORKTREE_TOKEN"));

  // 3. Core-bound worktree search without mutation session
  // Search is read-only inspection; it succeeds even when mutation session is not bound
  const coreInspectionGrep = await client.callTool({
    name: "grep_files",
    arguments: { workspaceId: wtId, pattern: "const" },
  });
  assert.equal(coreInspectionGrep.isError, undefined);

  // 4. Result-count truncation: search matching 50+ files returns bounded results
  const multiFind = await client.callTool({
    name: "find_files",
    arguments: { workspaceId, pattern: "file_*.txt" },
  });
  assert.equal(multiFind.isError, undefined);
  assert.ok(responseText(multiFind).length > 0);

  // 5. Byte / output truncation bound: large output remains safely bounded
  const bigFile = join(project, "big.txt");
  await writeFile(bigFile, "REPEAT_LINE_DATA\n".repeat(5000));
  const bigGrep = await client.callTool({
    name: "grep_files",
    arguments: { workspaceId, pattern: "REPEAT_LINE_DATA" },
  });
  assert.equal(bigGrep.isError, undefined);
  assert.ok(responseText(bigGrep).length > 0);

  // 6. Timeout bound: pass timeoutMs: 1 to ensure execution is bounded, abort triggered, zero workspace mutation
  const timeoutGrep = await client.callTool({
    name: "grep_files",
    arguments: { workspaceId, pattern: "REPEAT_LINE_DATA", timeoutMs: 1 },
  });
  assert.equal(timeoutGrep.isError, true);
  assert.match(responseText(timeoutGrep), /timed out/i);
  assert.ok(structuredContent(timeoutGrep).error);

  // 7. Nonexistent path: structured failure
  const nonExistentGrep = await client.callTool({
    name: "grep_files",
    arguments: { workspaceId, path: "nonexistent_dir_xyz", pattern: "anything" },
  });
  assert.equal(nonExistentGrep.isError, true);
  assert.ok(structuredContent(nonExistentGrep).error);

  // 8. Traversal escape: path traversal out of workspace boundary is rejected
  const traversalGrep = await client.callTool({
    name: "grep_files",
    arguments: {
      workspaceId,
      path: "../../etc",
      pattern: "passwd",
    },
  });
  assert.equal(traversalGrep.isError, true);

  // 9. Symlink escape: symlink pointing outside workspace root is rejected
  const outsideDir = await mkdtemp(join(tmpdir(), "devspace-outside-escape-"));
  await writeFile(join(outsideDir, "secret.txt"), "secret data\n");
  const symlinkPath = join(project, "escaped_link");
  try {
    await symlink(outsideDir, symlinkPath);
    const symlinkGrep = await client.callTool({
      name: "grep_files",
      arguments: {
        workspaceId,
        path: "escaped_link",
        pattern: "secret",
      },
    });
    assert.equal(symlinkGrep.isError, true);
  } finally {
    await rm(outsideDir, { recursive: true, force: true });
    await rm(symlinkPath, { force: true }).catch(() => {});
  }

  // 10. Regex | as data is safe and properly executed
  const regexGrep = await client.callTool({
    name: "grep_files",
    arguments: {
      workspaceId,
      pattern: "ALPHA|BETA",
    },
  });
  assert.equal(regexGrep.isError, undefined);
  assert.ok(responseText(regexGrep).includes("ALPHA"));
  assert.ok(responseText(regexGrep).includes("BETA"));

  // 11. Real shell pipe/substitution blocked
  assert.equal(isReadOnlyInspectionCommand("grep -E 'A|B' file.txt"), true);
  assert.equal(isReadOnlyInspectionCommand("cat file.txt | grep A"), false);
  assert.equal(isReadOnlyInspectionCommand("grep $(whoami) file.txt"), false);
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
