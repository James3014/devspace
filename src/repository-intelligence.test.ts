import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import {
  REPOSITORY_INTELLIGENCE_TOOL_NAMES,
  runRepositoryIntelligenceOperation,
} from "./repository-intelligence.js";
import { createMcpServer } from "./server.js";
import { WorkspaceRegistry } from "./workspaces.js";

function initGitRepo(dir: string): string {
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test User"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"], { stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-m", "initial commit"], { stdio: "ignore" });
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim().toLowerCase();
}

function makeFakePython(root: string): string {
  const path = join(root, "fake-python");
  writeFileSync(path, `#!/usr/bin/env node
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { body += chunk; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const moduleFlagIndex = args.indexOf('-m');
  if (moduleFlagIndex === -1 || args[moduleFlagIndex + 1] !== 'repository_intelligence.cli') {
    console.error('expected module repository_intelligence.cli');
    process.exit(9);
  }
  const mode = process.env.RI_FAKE_MODE || 'ok';
  if (mode === 'fail-if-called') { console.error('python was unexpectedly called'); process.exit(11); }
  if (mode === 'nonzero') { console.error('canonical failure'); process.exit(7); }
  if (mode === 'invalid-json') { process.stdout.write('not-json'); return; }
  if (mode === 'overflow') { process.stdout.write('x'.repeat(4096)); return; }
  if (mode === 'timeout') { setTimeout(() => {}, 60000); return; }
  const operation = args[args.indexOf('--operation') + 1];
  const ceiling = operation === 'ci' || operation === 'cfi'
    ? 'CI_EVIDENCE_ONLY'
    : operation === 'eia' ? 'AUTOMATION_ADVISORY_ONLY' : 'PR_INTELLIGENCE_ONLY';
  const top = mode === 'wrong-ceiling' ? 'PRE_REVIEW_ONLY' : ceiling;
  const nested = mode === 'wrong-nested-ceiling' ? 'PRE_REVIEW_ONLY' : ceiling;
  const input = JSON.parse(body || '{}');
  process.stdout.write(JSON.stringify({ operation, claim_ceiling: top, result: { echo: input, claim_ceiling: nested } }));
});
`);
  chmodSync(path, 0o755);
  return path;
}

async function withFakeMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.RI_FAKE_MODE;
  process.env.RI_FAKE_MODE = mode;
  try { return await fn(); }
  finally {
    if (prior === undefined) delete process.env.RI_FAKE_MODE;
    else process.env.RI_FAKE_MODE = prior;
  }
}

test("runner verifies exact engine HEAD and preserves all operation claim ceilings", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-ri-runner-"));
  try {
    const head = initGitRepo(root);
    const pythonBin = makeFakePython(root);
    const snapshot = { repository: "owner/repo", pr_number: 1, custom: { preserved: true } };
    const cfg = { root, expectedHead: head, pythonBin };
    const readiness = await runRepositoryIntelligenceOperation(cfg, "readiness", snapshot);
    assert.equal(readiness.claim_ceiling, "PR_INTELLIGENCE_ONLY");
    assert.equal(readiness.engine.head, head);
    assert.deepEqual((readiness.result.echo as Record<string, unknown>).custom, { preserved: true });
    const ci = await runRepositoryIntelligenceOperation(cfg, "ci", snapshot);
    assert.equal(ci.claim_ceiling, "CI_EVIDENCE_ONLY");
    assert.equal(ci.engine.head, head);
    const impact = await runRepositoryIntelligenceOperation(cfg, "impact", {
      snapshot,
      covered_files: ["src/a.ts"],
      dependency_edges: [],
      graph_complete: true,
    });
    assert.equal(impact.claim_ceiling, "PR_INTELLIGENCE_ONLY");
    assert.equal(impact.engine.head, head);
    const cfi = await runRepositoryIntelligenceOperation(cfg, "cfi", snapshot);
    assert.equal(cfi.claim_ceiling, "CI_EVIDENCE_ONLY");
    assert.equal(cfi.engine.head, head);
    const eia = await runRepositoryIntelligenceOperation(cfg, "eia", { snapshot });
    assert.equal(eia.claim_ceiling, "AUTOMATION_ADVISORY_ONLY");
    assert.equal(eia.engine.head, head);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner fails closed on engine HEAD mismatch before Python execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-ri-head-check-"));
  try {
    const head = initGitRepo(root);
    const pythonBin = makeFakePython(root);
    const wrongHead = "0".repeat(40);
    await assert.rejects(
      () => withFakeMode("fail-if-called", () =>
        runRepositoryIntelligenceOperation({ root, expectedHead: wrongHead, pythonBin }, "revision", {})),
      new RegExp(`Repository Intelligence engine HEAD mismatch: expected ${wrongHead}, got ${head}`),
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner fails closed on malformed execution and claim evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-ri-negative-"));
  try {
    const head = initGitRepo(root);
    const pythonBin = makeFakePython(root);
    const cfg = { root, expectedHead: head, pythonBin, timeoutMs: 2_000 };
    await assert.rejects(() => withFakeMode("wrong-ceiling", () => runRepositoryIntelligenceOperation(cfg, "revision", {})), /claim ceiling mismatch/);
    await assert.rejects(() => withFakeMode("wrong-nested-ceiling", () => runRepositoryIntelligenceOperation(cfg, "readiness", {})), /nested claim ceiling mismatch/);
    await assert.rejects(() => withFakeMode("invalid-json", () => runRepositoryIntelligenceOperation(cfg, "revision", {})), /invalid JSON/);
    await assert.rejects(() => withFakeMode("nonzero", () => runRepositoryIntelligenceOperation(cfg, "revision", {})), /canonical failure/);
    await assert.rejects(() => withFakeMode("overflow", () => runRepositoryIntelligenceOperation({ ...cfg, maxStdoutBytes: 128 }, "revision", {})), /stdout exceeded 128 byte limit/);
    await assert.rejects(() => withFakeMode("timeout", () => runRepositoryIntelligenceOperation({ ...cfg, timeoutMs: 50 }, "revision", {})), /timed out/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

async function makeConnectedServer(config: ReturnType<typeof loadConfig>, workspaces: WorkspaceRegistry) {
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => [],
    [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ri-test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => { await client.close(); await server.close(); },
  };
}

test("native tools are opt-in and exactly read-only when enabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-ri-server-"));
  try {
    const project = join(root, "project");
    const riRoot = join(root, "ri");
    mkdirSync(project, { recursive: true });
    mkdirSync(riRoot, { recursive: true });
    const riHead = initGitRepo(riRoot);
    const pythonBin = makeFakePython(root);
    const baseEnv = {
      DEVSPACE_CONFIG_DIR: join(root, ".config"),
      DEVSPACE_ALLOWED_ROOTS: root,
      DEVSPACE_STATE_DIR: join(root, ".state"),
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      DEVSPACE_SUBAGENTS: "0",
    } as NodeJS.ProcessEnv;

    const disabled = loadConfig(baseEnv);
    const disabledConnected = await makeConnectedServer(disabled, new WorkspaceRegistry(disabled));
    try {
      const disabledTools = (await disabledConnected.client.listTools()).tools;
      for (const name of REPOSITORY_INTELLIGENCE_TOOL_NAMES) {
        assert.equal(disabledTools.some((tool) => tool.name === name), false);
      }
    } finally {
      await disabledConnected.close();
    }

    const enabled = loadConfig({
      ...baseEnv,
      DEVSPACE_REPOSITORY_INTELLIGENCE_ROOT: riRoot,
      DEVSPACE_REPOSITORY_INTELLIGENCE_EXPECTED_HEAD: riHead,
      DEVSPACE_REPOSITORY_INTELLIGENCE_PYTHON_BIN: pythonBin,
    });
    const workspaces = new WorkspaceRegistry(enabled);
    const opened = await workspaces.openWorkspace(project);
    const connected = await makeConnectedServer(enabled, workspaces);
    try {
      const tools = (await connected.client.listTools()).tools;
      for (const name of REPOSITORY_INTELLIGENCE_TOOL_NAMES) {
        const tool = tools.find((candidate) => candidate.name === name);
        assert.ok(tool, `${name} must be registered`);
        assert.equal(tool.annotations?.readOnlyHint, true);
        assert.equal(tool.annotations?.destructiveHint, false);
        assert.equal(tool.annotations?.idempotentHint, true);
        assert.equal(tool.annotations?.openWorldHint, false);
      }

      const snapshot = { repository: "owner/repo", pr_number: 7, custom: "preserved" };
      const cases = [
        ["repository_intelligence_revision", "revision", "PR_INTELLIGENCE_ONLY", { workspaceId: opened.workspace.id, snapshot }],
        ["repository_intelligence_readiness", "readiness", "PR_INTELLIGENCE_ONLY", { workspaceId: opened.workspace.id, snapshot }],
        ["repository_intelligence_overlap", "overlap", "PR_INTELLIGENCE_ONLY", { workspaceId: opened.workspace.id, snapshots: [snapshot] }],
        ["repository_intelligence_ci", "ci", "CI_EVIDENCE_ONLY", { workspaceId: opened.workspace.id, snapshot }],
        ["repository_intelligence_impact", "impact", "PR_INTELLIGENCE_ONLY", {
          workspaceId: opened.workspace.id,
          snapshot,
          covered_files: ["src/a.ts"],
          dependency_edges: [],
          observed_symbols: { "src/a.ts": ["A"] },
          graph_complete: true,
          graph_errors: [],
        }],
        ["repository_intelligence_cfi", "cfi", "CI_EVIDENCE_ONLY", { workspaceId: opened.workspace.id, snapshot }],
        ["repository_intelligence_eia", "eia", "AUTOMATION_ADVISORY_ONLY", { workspaceId: opened.workspace.id, snapshot }],
      ] as const;
      for (const [name, operation, ceiling, args] of cases) {
        const response = await connected.client.callTool({ name, arguments: args as unknown as Record<string, unknown> });
        assert.equal(response.isError, undefined);
        const structured = response.structuredContent as Record<string, unknown>;
        assert.equal(structured.operation, operation);
        assert.equal(structured.claim_ceiling, ceiling);
        assert.equal((structured.engine as { head?: string } | undefined)?.head, riHead);
      }

      const eiaMissing = await connected.client.callTool({
        name: "repository_intelligence_eia",
        arguments: { workspaceId: opened.workspace.id },
      });
      assert.equal(eiaMissing.isError, true);
      assert.match(JSON.stringify(eiaMissing.structuredContent), /exactly one of snapshot or cfi_report/);

      const eiaAmbiguous = await connected.client.callTool({
        name: "repository_intelligence_eia",
        arguments: { workspaceId: opened.workspace.id, snapshot, cfi_report: snapshot },
      });
      assert.equal(eiaAmbiguous.isError, true);
      assert.match(JSON.stringify(eiaAmbiguous.structuredContent), /exactly one of snapshot or cfi_report/);
    } finally {
      await connected.close();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const EXTRACTED_ENGINE_ROOT = "/Users/jameschen/Workspace/repository-intelligence-engine";
const EXTRACTED_ENGINE_HEAD = "a8b9a00a6f3ea3e9ade0c6ef494d0fa88a2d73b2";

if (existsSync(join(EXTRACTED_ENGINE_ROOT, ".git"))) {
  test("live integration binds the productized Repository Intelligence engine HEAD", async () => {
    const result = await runRepositoryIntelligenceOperation(
      {
        root: EXTRACTED_ENGINE_ROOT,
        expectedHead: EXTRACTED_ENGINE_HEAD,
        pythonBin: "/opt/homebrew/bin/python3",
      },
      "eia",
      {
        snapshot: {
          repository: "owner/repo",
          pr_number: 1,
          head_sha: "b".repeat(40),
          base_sha: "a".repeat(40),
          current_main_sha: "a".repeat(40),
          checks: [],
          collection_complete: true,
          collection_errors: [],
        },
      },
    );
    assert.equal(result.operation, "eia");
    assert.equal(result.claim_ceiling, "AUTOMATION_ADVISORY_ONLY");
    assert.equal(result.engine.head, EXTRACTED_ENGINE_HEAD);
  });
}
