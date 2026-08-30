import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadConfig } from "./config.js";
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
  const actualCeiling = mode === 'wrong-ceiling' ? 'PRE_REVIEW_ONLY' : ceiling;
  const resultCeiling = mode === 'wrong-nested-ceiling' ? 'PRE_REVIEW_ONLY' : ceiling;
  const input = JSON.parse(body || '{}');
  const payload = { operation, claim_ceiling: actualCeiling, result: { echo: input, claim_ceiling: resultCeiling } };
  process.stdout.write(JSON.stringify(payload));
});
`);
  chmodSync(path, 0o755);
  return path;
}

function withFakeMode<T>(mode: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.RI_FAKE_MODE;
  if (mode === undefined) delete process.env.RI_FAKE_MODE;
  else process.env.RI_FAKE_MODE = mode;
  return fn().finally(() => {
    if (prior === undefined) delete process.env.RI_FAKE_MODE;
    else process.env.RI_FAKE_MODE = prior;
  });
}

test("runner maps operations and preserves exact claim ceilings", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-ri-runner-"));
  try {
    const pythonBin = makeFakePython(root);
    const snapshot = { repository: "owner/repo", pr_number: 1, extra: { preserved: true } };
    const readiness = await runRepositoryIntelligenceOperation({ root, pythonBin }, "readiness", snapshot);
    assert.equal(readiness.operation, "readiness");
    assert.equal(readiness.claim_ceiling, "PR_INTELLIGENCE_ONLY");
    assert.deepEqual((readiness.result.echo as Record<string, unknown>).extra, { preserved: true });

    const ci = await runRepositoryIntelligenceOperation({ root, pythonBin }, "ci", snapshot);
    assert.equal(ci.claim_ceiling, "CI_EVIDENCE_ONLY");
    assert.equal(ci.result.claim_ceiling, "CI_EVIDENCE_ONLY");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner fails closed on claim mismatch, invalid JSON, nonzero, and timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-ri-negative-"));
  try {
    const pythonBin = makeFakePython(root);
    const cfg = { root, pythonBin, timeoutMs: 2_000 };
    await assert.rejects(
      () => withFakeMode("wrong-ceiling", () => runRepositoryIntelligenceOperation(cfg, "revision", {})),
      /claim ceiling mismatch/,
    );
    await assert.rejects(
      () => withFakeMode("wrong-nested-ceiling", () => runRepositoryIntelligenceOperation(cfg, "readiness", {})),
      /nested claim ceiling mismatch/,
    );
    await assert.rejects(
      () => withFakeMode("invalid-json", () => runRepositoryIntelligenceOperation(cfg, "revision", {})),
      /invalid JSON/,
    );
    await assert.rejects(
      () => withFakeMode("nonzero", () => runRepositoryIntelligenceOperation(cfg, "revision", {})),
      /canonical failure/,
    );
    await assert.rejects(
      () => withFakeMode("overflow", () => runRepositoryIntelligenceOperation({ ...cfg, maxStdoutBytes: 128 }, "revision", {})),
      /stdout exceeded 128 byte limit/,
    );
    await assert.rejects(
      () => withFakeMode("timeout", () => runRepositoryIntelligenceOperation({ ...cfg, timeoutMs: 50 }, "revision", {})),
      /timed out/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw server registers exactly four opt-in read-only Repository Intelligence tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-ri-server-"));
  try {
    const project = join(root, "project");
    const riRoot = join(root, "ri");
    mkdirSync(project, { recursive: true });
    mkdirSync(riRoot, { recursive: true });
    const pythonBin = makeFakePython(root);
    const baseEnv = {
      DEVSPACE_CONFIG_DIR: join(root, ".empty-config"),
      DEVSPACE_ALLOWED_ROOTS: root,
      DEVSPACE_STATE_DIR: join(root, ".state"),
      DEVSPACE_AGENT_DIR: join(root, ".agent"),
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      NEXUS_MCP_SURFACE_PROFILE: "raw_devspace",
      MCP_PROTOCOL_MODE: "dual",
    } as NodeJS.ProcessEnv;

    const disabled = loadConfig(baseEnv);
    const disabledServer = await createMcpServer(
      disabled,
      new WorkspaceRegistry(disabled),
      createReviewCheckpointManager(),
    );
    const disabledTools = (disabledServer as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
    for (const name of REPOSITORY_INTELLIGENCE_TOOL_NAMES) assert.equal(disabledTools[name], undefined);

    const enabled = loadConfig({
      ...baseEnv,
      DEVSPACE_REPOSITORY_INTELLIGENCE_ROOT: riRoot,
      DEVSPACE_REPOSITORY_INTELLIGENCE_PYTHON_BIN: pythonBin,
    });
    const workspaces = new WorkspaceRegistry(enabled);
    const opened = await workspaces.openWorkspace(project);
    const enabledServer = await createMcpServer(enabled, workspaces, createReviewCheckpointManager());
    const registered = (enabledServer as unknown as {
      _registeredTools?: Record<string, {
        executor?: (args: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }>;
        annotations?: Record<string, unknown>;
      }>;
    })._registeredTools ?? {};

    for (const name of REPOSITORY_INTELLIGENCE_TOOL_NAMES) {
      assert.ok(registered[name]?.executor, `${name} must be registered`);
      assert.deepEqual(registered[name]?.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }

    const snapshot = { repository: "owner/repo", pr_number: 7, custom: "preserved" };
    for (const [name, operation, claimCeiling, args] of [
      ["repository_intelligence_revision", "revision", "PR_INTELLIGENCE_ONLY", { workspaceId: opened.workspace.id, snapshot }],
      ["repository_intelligence_readiness", "readiness", "PR_INTELLIGENCE_ONLY", { workspaceId: opened.workspace.id, snapshot }],
      ["repository_intelligence_overlap", "overlap", "PR_INTELLIGENCE_ONLY", { workspaceId: opened.workspace.id, snapshots: [snapshot] }],
      ["repository_intelligence_ci", "ci", "CI_EVIDENCE_ONLY", { workspaceId: opened.workspace.id, snapshot }],
    ] as const) {
      const result = await registered[name]!.executor!(args as unknown as Record<string, unknown>);
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent?.operation, operation);
      assert.equal(result.structuredContent?.claim_ceiling, claimCeiling);
    }

    const proxyConfig = loadConfig({
      ...baseEnv,
      DEVSPACE_REPOSITORY_INTELLIGENCE_ROOT: riRoot,
      DEVSPACE_REPOSITORY_INTELLIGENCE_PYTHON_BIN: pythonBin,
      NEXUS_MCP_SURFACE_PROFILE: "canonical_gateway_proxy",
      NEXUS_GATEWAY_PROXY_URL: "http://127.0.0.1:8766",
      NEXUS_GATEWAY_PROXY_TOKEN: "gateway-token-that-is-long-enough",
    });
    const manifest = Object.assign([], { revision: "test", sha256: "a".repeat(64) });
    const proxyServer = await createMcpServer(
      proxyConfig,
      new WorkspaceRegistry(proxyConfig),
      createReviewCheckpointManager(),
      manifest,
    );
    const proxyTools = (proxyServer as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
    for (const name of REPOSITORY_INTELLIGENCE_TOOL_NAMES) assert.equal(proxyTools[name], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
