import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadConfig } from "./config.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import {
  REPOSITORY_INTELLIGENCE_TOOL_NAMES,
  runRepositoryIntelligenceOperation,
} from "./repository-intelligence.js";
import { createMcpServer } from "./server.js";
import { WorkspaceRegistry } from "./workspaces.js";

function makeFakePython(root: string): string {
  const path = join(root, "fake-python");
  writeFileSync(path, `#!/usr/bin/env node
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { body += chunk; });
process.stdin.on('end', () => {
  const mode = process.env.RI_FAKE_MODE || 'ok';
  if (mode === 'nonzero') { console.error('canonical failure'); process.exit(7); }
  if (mode === 'invalid-json') { process.stdout.write('not-json'); return; }
  if (mode === 'overflow') { process.stdout.write('x'.repeat(4096)); return; }
  if (mode === 'timeout') { setTimeout(() => {}, 60000); return; }
  const args = process.argv.slice(2);
  const operation = args[args.indexOf('--operation') + 1];
  const ceiling = operation === 'ci' ? 'CI_EVIDENCE_ONLY' : 'PR_INTELLIGENCE_ONLY';
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

test("runner preserves operation and exact claim ceilings", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-ri-runner-"));
  try {
    const pythonBin = makeFakePython(root);
    const snapshot = { repository: "owner/repo", pr_number: 1, custom: { preserved: true } };
    const readiness = await runRepositoryIntelligenceOperation({ root, pythonBin }, "readiness", snapshot);
    assert.equal(readiness.claim_ceiling, "PR_INTELLIGENCE_ONLY");
    assert.deepEqual((readiness.result.echo as Record<string, unknown>).custom, { preserved: true });
    const ci = await runRepositoryIntelligenceOperation({ root, pythonBin }, "ci", snapshot);
    assert.equal(ci.claim_ceiling, "CI_EVIDENCE_ONLY");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner fails closed on malformed execution and claim evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-ri-negative-"));
  try {
    const pythonBin = makeFakePython(root);
    const cfg = { root, pythonBin, timeoutMs: 2_000 };
    await assert.rejects(() => withFakeMode("wrong-ceiling", () => runRepositoryIntelligenceOperation(cfg, "revision", {})), /claim ceiling mismatch/);
    await assert.rejects(() => withFakeMode("wrong-nested-ceiling", () => runRepositoryIntelligenceOperation(cfg, "readiness", {})), /nested claim ceiling mismatch/);
    await assert.rejects(() => withFakeMode("invalid-json", () => runRepositoryIntelligenceOperation(cfg, "revision", {})), /invalid JSON/);
    await assert.rejects(() => withFakeMode("nonzero", () => runRepositoryIntelligenceOperation(cfg, "revision", {})), /canonical failure/);
    await assert.rejects(() => withFakeMode("overflow", () => runRepositoryIntelligenceOperation({ ...cfg, maxStdoutBytes: 128 }, "revision", {})), /stdout exceeded 128 byte limit/);
    await assert.rejects(() => withFakeMode("timeout", () => runRepositoryIntelligenceOperation({ ...cfg, timeoutMs: 50 }, "revision", {})), /timed out/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function makeServer(config: ReturnType<typeof loadConfig>, workspaces: WorkspaceRegistry) {
  return createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => [],
    [],
  );
}

test("native tools are opt-in and exactly read-only when enabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-ri-server-"));
  try {
    const project = join(root, "project");
    const riRoot = join(root, "ri");
    mkdirSync(project, { recursive: true });
    mkdirSync(riRoot, { recursive: true });
    const pythonBin = makeFakePython(root);
    const baseEnv = {
      DEVSPACE_CONFIG_DIR: join(root, ".config"),
      DEVSPACE_ALLOWED_ROOTS: root,
      DEVSPACE_STATE_DIR: join(root, ".state"),
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      DEVSPACE_SUBAGENTS: "0",
    } as NodeJS.ProcessEnv;

    const disabled = loadConfig(baseEnv);
    const disabledServer = makeServer(disabled, new WorkspaceRegistry(disabled));
    const disabledTools = (disabledServer as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
    for (const name of REPOSITORY_INTELLIGENCE_TOOL_NAMES) assert.equal(disabledTools[name], undefined);

    const enabled = loadConfig({
      ...baseEnv,
      DEVSPACE_REPOSITORY_INTELLIGENCE_ROOT: riRoot,
      DEVSPACE_REPOSITORY_INTELLIGENCE_PYTHON_BIN: pythonBin,
    });
    const workspaces = new WorkspaceRegistry(enabled);
    const opened = await workspaces.openWorkspace(project);
    const server = makeServer(enabled, workspaces);
    const tools = (server as unknown as {
      _registeredTools?: Record<string, {
        executor?: (args: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }>;
        annotations?: Record<string, unknown>;
      }>;
    })._registeredTools ?? {};

    for (const name of REPOSITORY_INTELLIGENCE_TOOL_NAMES) {
      assert.ok(tools[name]?.executor, `${name} must be registered`);
      assert.deepEqual(tools[name]?.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }

    const snapshot = { repository: "owner/repo", pr_number: 7, custom: "preserved" };
    const cases = [
      ["repository_intelligence_revision", "revision", "PR_INTELLIGENCE_ONLY", { workspaceId: opened.workspace.id, snapshot }],
      ["repository_intelligence_readiness", "readiness", "PR_INTELLIGENCE_ONLY", { workspaceId: opened.workspace.id, snapshot }],
      ["repository_intelligence_overlap", "overlap", "PR_INTELLIGENCE_ONLY", { workspaceId: opened.workspace.id, snapshots: [snapshot] }],
      ["repository_intelligence_ci", "ci", "CI_EVIDENCE_ONLY", { workspaceId: opened.workspace.id, snapshot }],
    ] as const;
    for (const [name, operation, ceiling, args] of cases) {
      const response = await tools[name]!.executor!(args as unknown as Record<string, unknown>);
      assert.equal(response.isError, undefined);
      assert.equal(response.structuredContent?.operation, operation);
      assert.equal(response.structuredContent?.claim_ceiling, ceiling);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
