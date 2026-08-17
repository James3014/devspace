import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer } from "./server.js";
import {
  PR_MERGE_ERROR_CODES,
  createTrustedIntegrationTargetResolver,
  type GitHubPullRequestTransport,
  type IntegrationTargetResolver,
  type RepositoryView,
  type PullRequestView,
  type BranchRefView,
  type BranchProtectionView,
  type EffectiveRulesView,
  type RequiredCheckRequirement,
  type CommitStatusEvidence,
  type CheckRunView,
  type MergeResultView,
  type MergeMethod,
} from "./git-pr-merge.js";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const NEW_MAIN = "5".repeat(40);

let passed = 0;
let failed = 0;

async function asyncTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${(e as Error).message}`);
  }
}

function makePr(overrides: Partial<PullRequestView> = {}): PullRequestView {
  return {
    number: 42,
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    baseRefOid: BASE,
    headRefName: "feature/x",
    headRefOid: HEAD,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    merged: false,
    mergedAt: null,
    mergeCommitOid: null,
    title: "Fix widget",
    url: "https://github.com/acme/widget/pull/42",
    ...overrides,
  };
}

function makeMergedPr(): PullRequestView {
  return {
    ...makePr({
      state: "MERGED",
      merged: true,
      mergedAt: "2026-08-16T12:00:00Z",
      mergeCommitOid: NEW_MAIN,
    }),
  };
}

class FakeGitHubTransport implements GitHubPullRequestTransport {
  repository: RepositoryView = { default_branch: "main", full_name: "acme/widget" };
  pr: PullRequestView = makePr();
  baseSha = BASE;
  afterMergeBase = NEW_MAIN;
  afterMergePr: PullRequestView = makeMergedPr();
  branchProtection: BranchProtectionView = { determined: true, requirements: [] };
  effectiveRules: EffectiveRulesView = { determined: true, requirements: [] };
  checkRuns: CheckRunView[] = [];
  commitStatuses: CommitStatusEvidence[] = [];
  mergeResult: MergeResultView = { merged: true, sha: NEW_MAIN, message: null };
  mergeCalls: Array<{
    repo: string;
    prNumber: number;
    method: MergeMethod;
    expectedHeadSha: string;
  }> = [];

  async getRepository(repo: string): Promise<RepositoryView> {
    return this.repository;
  }
  async getPullRequest(repo: string, prNumber: number): Promise<PullRequestView> {
    if (this.mergeCalls.length > 0) return this.afterMergePr;
    return this.pr;
  }
  async getBranchRef(repo: string, branch: string): Promise<BranchRefView> {
    return { sha: this.mergeCalls.length > 0 ? this.afterMergeBase : this.baseSha };
  }
  async getBranchProtection(repo: string, branch: string): Promise<BranchProtectionView> {
    return this.branchProtection;
  }
  async getEffectiveRules(repo: string, branch: string): Promise<EffectiveRulesView> {
    return this.effectiveRules;
  }
  async getCheckRuns(repo: string, headSha: string): Promise<CheckRunView[]> {
    return this.checkRuns;
  }
  async getCommitStatus(repo: string, headSha: string): Promise<CommitStatusEvidence[]> {
    return this.commitStatuses;
  }
  async mergePullRequest(
    repo: string,
    prNumber: number,
    method: MergeMethod,
    expectedHeadSha: string,
  ): Promise<MergeResultView> {
    this.mergeCalls.push({ repo, prNumber, method, expectedHeadSha });
    return this.mergeResult;
  }
}

function makeWorkspace(): { base: string; dir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "nexus-pr-merge-wiring-"));
  const bare = join(base, "origin.git");
  const work = join(base, "work");
  execSync(`git init --bare -b main ${JSON.stringify(bare)}`, { stdio: "pipe" });
  execSync(`git clone -q ${JSON.stringify(bare)} ${JSON.stringify(work)}`, { stdio: "pipe" });
  execSync(`git -C ${JSON.stringify(work)} config user.name test`, { stdio: "pipe" });
  execSync(`git -C ${JSON.stringify(work)} config user.email test@test.com`, { stdio: "pipe" });
  writeFileSync(join(work, "README.md"), "# widget\n");
  execSync(`git -C ${JSON.stringify(work)} add -A`, { stdio: "pipe" });
  execSync(`git -C ${JSON.stringify(work)} commit -m init`, { stdio: "pipe" });
  execSync(`git -C ${JSON.stringify(work)} push -q origin main`, { stdio: "pipe" });
  execSync(
    `git -C ${JSON.stringify(work)} remote set-url origin git@github.com:acme/widget.git`,
    { stdio: "pipe" },
  );
  return {
    base,
    dir: work,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

type RegisteredTool = {
  executor?: (
    args: Record<string, unknown>,
    ctx?: unknown,
  ) => Promise<{ content?: Array<{ type: string; text: string }>; isError?: boolean }>;
};

/**
 * Test-only resolver: the wiring-test workspace exposes only `origin`
 * (acme/widget). The server seam must thread this resolver through to the
 * action so the merge targets the trusted test repository.
 */
const acmeResolver: IntegrationTargetResolver = createTrustedIntegrationTargetResolver([
  { remoteName: "origin", repository: "acme/widget", defaultBranch: "main" },
]);

async function buildRegisteredMergeAction(
  workspace: { base: string; dir: string },
  transport: FakeGitHubTransport,
): Promise<{ executor: NonNullable<RegisteredTool["executor"]>; workspaceId: string }> {
  const stateRoot = mkdtempSync(join(tmpdir(), "nexus-pr-merge-wiring-state-"));
  try {
    const config = loadConfig({
      DEVSPACE_CONFIG_DIR: join(stateRoot, ".empty-config"),
      DEVSPACE_ALLOWED_ROOTS: workspace.base,
      DEVSPACE_STATE_DIR: join(stateRoot, ".state"),
      DEVSPACE_AGENT_DIR: join(stateRoot, ".agent"),
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      NEXUS_MCP_SURFACE_PROFILE: "raw_devspace",
      MCP_PROTOCOL_MODE: "dual",
    });
    const workspaces = new WorkspaceRegistry(config);
    const opened = await workspaces.openWorkspace(workspace.dir);
    const server = await createMcpServer(
      config,
      workspaces,
      createReviewCheckpointManager(),
      undefined,
      {
        gitMergeTransportFactory: () => transport,
        gitMergeTargetResolver: () => acmeResolver,
      },
    );
    const registered = (server as unknown as {
      _registeredTools?: Record<string, RegisteredTool>;
    })._registeredTools?.["git_merge_pull_request"];
    assert.ok(registered?.executor, "git_merge_pull_request must be registered with an executor");
    return { executor: registered.executor!, workspaceId: opened.workspace.id };
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

function mergeArgs(workspaceId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId,
    prNumber: 42,
    expectedBaseSha: BASE,
    expectedHeadSha: HEAD,
    mergeMethod: "merge",
    ownerConfirmation: true,
    ...overrides,
  };
}

// ============================================================
console.log("\n=== production wiring: registered git_merge_pull_request ===");

await asyncTest("registered action is part of the raw_devspace tool surface", async () => {
  const ws = makeWorkspace();
  try {
    const { executor, workspaceId } = await buildRegisteredMergeAction(
      ws,
      new FakeGitHubTransport(),
    );
    assert.ok(executor, "executor must be present");
    assert.ok(workspaceId.startsWith("ws_"), "workspace must be opened");
  } finally {
    ws.cleanup();
  }
});

await asyncTest("registered action → real transport path → GitHub merge API with expectedHeadSha CAS", async () => {
  const ws = makeWorkspace();
  try {
    const transport = new FakeGitHubTransport();
    const { executor, workspaceId } = await buildRegisteredMergeAction(ws, transport);
    const result = await executor(mergeArgs(workspaceId, { mergeMethod: "squash" }));

    assert.ok(!result.isError, `expected success receipt, got ${JSON.stringify(result)}`);
    const receipt = JSON.parse(result.content?.[0]?.text ?? "{}");
    assert.equal(receipt.merged, true);
    assert.equal(receipt.repository, "acme/widget");
    assert.equal(receipt.pr_number, 42);
    assert.equal(receipt.merge_method, "squash");
    assert.equal(receipt.candidate_head_sha, HEAD);
    assert.equal(receipt.observed_head_sha_before_merge, HEAD);
    assert.equal(receipt.merge_commit_sha, NEW_MAIN);
    assert.equal(receipt.transport, "github_api");

    assert.equal(transport.mergeCalls.length, 1, "merge API must be called exactly once");
    assert.deepEqual(transport.mergeCalls[0], {
      repo: "acme/widget",
      prNumber: 42,
      method: "squash",
      expectedHeadSha: HEAD,
    });
  } finally {
    ws.cleanup();
  }
});

await asyncTest("registered action surfaces deterministic errors through the handler", async () => {
  const ws = makeWorkspace();
  try {
    const transport = new FakeGitHubTransport();
    transport.pr = makePr({ isDraft: true });
    const { executor, workspaceId } = await buildRegisteredMergeAction(ws, transport);
    const result = await executor(mergeArgs(workspaceId));

    assert.ok(result.isError, "draft PR must produce an error result");
    const data = JSON.parse(result.content?.[0]?.text ?? "{}");
    assert.equal(data.code, PR_MERGE_ERROR_CODES.PR_IS_DRAFT);
    assert.equal(transport.mergeCalls.length, 0, "no merge call on draft PR");
  } finally {
    ws.cleanup();
  }
});

await asyncTest("registered action rejects missing owner confirmation before any transport call", async () => {
  const ws = makeWorkspace();
  try {
    const transport = new FakeGitHubTransport();
    const { executor, workspaceId } = await buildRegisteredMergeAction(ws, transport);
    const result = await executor(mergeArgs(workspaceId, { ownerConfirmation: false }));

    assert.ok(result.isError, "ownerConfirmation false must error");
    const data = JSON.parse(result.content?.[0]?.text ?? "{}");
    assert.equal(data.code, PR_MERGE_ERROR_CODES.OWNER_CONFIRMATION_REQUIRED);
    assert.equal(transport.mergeCalls.length, 0, "no merge call without owner confirmation");
  } finally {
    ws.cleanup();
  }
});

// ============================================================
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
