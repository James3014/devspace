import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    console.error('expected module repository_intelligence.cli, got ' + (args[moduleFlagIndex + 1] || 'none'));
    process.exit(9);
  }
  const mode = process.env.RI_FAKE_MODE || 'ok';
  if (mode === 'fail-if-called') { console.error('python was unexpectedly called'); process.exit(11); }
  if (mode === 'nonzero') { console.error('canonical failure'); process.exit(7); }
  if (mode === 'invalid-json') { process.stdout.write('not-json'); return; }
  if (mode === 'overflow') { process.stdout.write('x'.repeat(4096)); return; }
  if (mode === 'timeout') { setTimeout(() => {}, 60000); return; }
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

test("runner maps operations, verifies exact Git HEAD, and preserves exact claim ceilings", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-ri-runner-"));
  try {
    const head = initGitRepo(root);
    const pythonBin = makeFakePython(root);
    const snapshot = { repository: "owner/repo", pr_number: 1, extra: { preserved: true } };
    const readiness = await runRepositoryIntelligenceOperation(
      { root, expectedHead: head, pythonBin },
      "readiness",
      snapshot,
    );
    assert.equal(readiness.operation, "readiness");
    assert.equal(readiness.claim_ceiling, "PR_INTELLIGENCE_ONLY");
    assert.equal(readiness.engine?.head, head);
    assert.deepEqual((readiness.result.echo as Record<string, unknown>).extra, { preserved: true });

    const ci = await runRepositoryIntelligenceOperation(
      { root, expectedHead: head, pythonBin },
      "ci",
      snapshot,
    );
    assert.equal(ci.claim_ceiling, "CI_EVIDENCE_ONLY");
    assert.equal(ci.result.claim_ceiling, "CI_EVIDENCE_ONLY");
    assert.equal(ci.engine?.head, head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner fails closed when expected HEAD mismatches and blocks before Python operation", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-ri-head-check-"));
  try {
    const head = initGitRepo(root);
    const pythonBin = makeFakePython(root);
    const wrongHead = "0".repeat(40);

    await assert.rejects(
      () =>
        withFakeMode("fail-if-called", () =>
          runRepositoryIntelligenceOperation(
            { root, expectedHead: wrongHead, pythonBin },
            "revision",
            {},
          ),
        ),
      new RegExp(`Repository Intelligence engine HEAD mismatch: expected ${wrongHead}, got ${head}`),
    );

    const nonGitRoot = mkdtempSync(join(tmpdir(), "devspace-ri-non-git-"));
    try {
      await assert.rejects(
        () =>
          withFakeMode("fail-if-called", () =>
            runRepositoryIntelligenceOperation(
              { root: nonGitRoot, expectedHead: head, pythonBin },
              "revision",
              {},
            ),
          ),
        /Failed to resolve repository intelligence engine Git HEAD/,
      );
    } finally {
      rmSync(nonGitRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner fails closed on claim mismatch, invalid JSON, nonzero, and timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-ri-negative-"));
  try {
    const head = initGitRepo(root);
    const pythonBin = makeFakePython(root);
    const cfg = { root, expectedHead: head, pythonBin, timeoutMs: 2_000 };
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
    const riHead = initGitRepo(riRoot);
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
      DEVSPACE_REPOSITORY_INTELLIGENCE_EXPECTED_HEAD: riHead,
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
      assert.equal(
        (result.structuredContent?.engine as { head?: string } | undefined)?.head,
        riHead,
      );
    }

    const proxyConfig = loadConfig({
      ...baseEnv,
      DEVSPACE_REPOSITORY_INTELLIGENCE_ROOT: riRoot,
      DEVSPACE_REPOSITORY_INTELLIGENCE_EXPECTED_HEAD: riHead,
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

const EXTRACTED_ENGINE_ROOT = "/Users/jameschen/Workspace/repository-intelligence-engine";
const EXTRACTED_ENGINE_HEAD = "693ae7cf59e3b090ee873b7196ee330b30e26221";

if (existsSync(join(EXTRACTED_ENGINE_ROOT, ".git"))) {
  test("live integration with extracted repository-intelligence-engine", async () => {
    const result = await runRepositoryIntelligenceOperation(
      {
        root: EXTRACTED_ENGINE_ROOT,
        expectedHead: EXTRACTED_ENGINE_HEAD,
        pythonBin: "python3",
      },
      "revision",
      {
        base_sha: "0".repeat(40),
        head_sha: "1".repeat(40),
        base_ref: "main",
        head_ref: "feature",
      },
    );
    assert.equal(result.operation, "revision");
    assert.equal(result.claim_ceiling, "PR_INTELLIGENCE_ONLY");
    assert.equal(result.engine?.head, EXTRACTED_ENGINE_HEAD);
    assert.equal(typeof result.result, "object");
  });
}
