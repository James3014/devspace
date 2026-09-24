import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PR_MERGE_ERROR_CODES,
  MergePullRequestError,
  TransportError,
  parseGitHubRemote,
  sanitizeRemoteUrl,
  parseMergePullRequestInput,
  classifyCheckRun,
  classifyCommitStatusState,
  mergePullRequest,
  gitMergePullRequestTool,
  createGhCliGitHubTransportWithExec,
  defaultGitMergeTransportFactory,
  GhCliGitHubTransport,
  createTrustedIntegrationTargetResolver,
  createNexusIntegrationTargetResolver,
  defaultIntegrationTargetResolver,
  NEXUS_TRUSTED_INTEGRATION_TARGET,
  type GitHubPullRequestTransport,
  type IntegrationTargetResolver,
  type BranchProtectionView,
  type EffectiveRulesView,
  type RequiredCheckRequirement,
  type CommitStatusEvidence,
  type CheckRunView,
  type GitRemoteInfo,
  type GhExecFn,
  type RepositoryView,
  type PullRequestView,
  type BranchRefView,
  type MergeResultView,
  type GitMergePullRequestInput,
  type MergeMethod,
} from "./git-pr-merge.js";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const OTHER_HEAD = "3".repeat(40);
const OTHER_BASE = "4".repeat(40);
const NEW_MAIN = "5".repeat(40);

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${(e as Error).message}`);
  }
}

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

function makeMergedPr(overrides: Partial<PullRequestView> = {}): PullRequestView {
  return {
    ...makePr({
      state: "MERGED",
      merged: true,
      mergedAt: "2026-08-16T12:00:00Z",
      mergeCommitOid: NEW_MAIN,
    }),
    ...overrides,
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

  repoError: Error | null = null;
  prError: Error | null = null;
  branchError: Error | null = null;
  branchProtectionError: Error | null = null;
  effectiveRulesError: Error | null = null;
  checkRunsError: Error | null = null;
  commitStatusesError: Error | null = null;
  mergeError: Error | null = null;
  postMergeError: Error | null = null;

  driftAfter?: { calls: number; head?: string; base?: string; pr?: Partial<PullRequestView> };

  prCallCount = 0;
  branchCallCount = 0;
  mergeCalls: Array<{
    repo: string;
    prNumber: number;
    method: MergeMethod;
    expectedHeadSha: string;
  }> = [];

  /** Declare required status check requirements (classic branch protection). */
  requireChecks(...requirements: RequiredCheckRequirement[]): void {
    this.branchProtection = { determined: true, requirements };
  }

  /** Convenience: declare contexts without app binding. */
  requireChecksByContext(...contexts: string[]): void {
    this.requireChecks(...contexts.map((context) => ({ context, integrationId: null })));
  }

  /** Make required-check determination unreadable → fail closed upstream. */
  requireChecksUnreadable(): void {
    this.branchProtection = { determined: false, requirements: [] };
  }

  async getRepository(repo: string): Promise<RepositoryView> {
    if (this.repoError) throw this.repoError;
    return this.repository;
  }

  async getPullRequest(repo: string, prNumber: number): Promise<PullRequestView> {
    if (this.postMergeError && this.mergeCalls.length > 0) throw this.postMergeError;
    if (this.prError) throw this.prError;
    if (this.mergeCalls.length > 0) return this.afterMergePr;
    const idx = this.prCallCount++;
    if (this.driftAfter && idx >= this.driftAfter.calls && this.driftAfter.pr) {
      return { ...this.pr, ...this.driftAfter.pr };
    }
    if (this.driftAfter && idx >= this.driftAfter.calls && this.driftAfter.head) {
      return { ...this.pr, headRefOid: this.driftAfter.head };
    }
    return this.pr;
  }

  async getBranchRef(repo: string, branch: string): Promise<BranchRefView> {
    if (this.postMergeError && this.mergeCalls.length > 0) throw this.postMergeError;
    if (this.branchError) throw this.branchError;
    if (this.mergeCalls.length > 0) return { sha: this.afterMergeBase };
    const idx = this.branchCallCount++;
    if (this.driftAfter && idx >= this.driftAfter.calls && this.driftAfter.base) {
      return { sha: this.driftAfter.base };
    }
    return { sha: this.baseSha };
  }

  async getBranchProtection(repo: string, branch: string): Promise<BranchProtectionView> {
    if (this.branchProtectionError) throw this.branchProtectionError;
    return this.branchProtection;
  }

  async getEffectiveRules(repo: string, branch: string): Promise<EffectiveRulesView> {
    if (this.effectiveRulesError) throw this.effectiveRulesError;
    return this.effectiveRules;
  }

  async getCheckRuns(repo: string, headSha: string): Promise<CheckRunView[]> {
    if (this.checkRunsError) throw this.checkRunsError;
    return this.checkRuns;
  }

  async getCommitStatus(repo: string, headSha: string): Promise<CommitStatusEvidence[]> {
    if (this.commitStatusesError) throw this.commitStatusesError;
    return this.commitStatuses;
  }

  async mergePullRequest(
    repo: string,
    prNumber: number,
    method: MergeMethod,
    expectedHeadSha: string,
  ): Promise<MergeResultView> {
    this.mergeCalls.push({ repo, prNumber, method, expectedHeadSha });
    if (this.mergeError) throw this.mergeError;
    return this.mergeResult;
  }
}

function runView(name: string, status: string | null, conclusion: string | null): CheckRunView {
  return { name, status, conclusion, appId: null, appSlug: null };
}

function runViewWithApp(name: string, appId: number | null, appSlug: string | null): CheckRunView {
  return { name, status: "completed", conclusion: "success", appId, appSlug };
}

function makeWorkspace(options: { remote?: string; noOrigin?: boolean; nexusRemotes?: boolean } = {}): {
  dir: string;
  cleanup: () => void;
} {
  const base = mkdtempSync(join(tmpdir(), "nexus-pr-merge-"));
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
  if (options.noOrigin) {
    execSync(`git -C ${JSON.stringify(work)} remote remove origin`, { stdio: "pipe" });
  } else {
    const remote = options.remote ?? "git@github.com:acme/widget.git";
    execSync(`git -C ${JSON.stringify(work)} remote set-url origin ${JSON.stringify(remote)}`, { stdio: "pipe" });
  }
  if (options.nexusRemotes) {
    execSync(`git -C ${JSON.stringify(work)} remote set-url origin https://github.com/James3014/Nexus.git`, { stdio: "pipe" });
    execSync(`git -C ${JSON.stringify(work)} remote add nexus-new https://github.com/James3014/Nexus-new.git`, { stdio: "pipe" });
  }
  return {
    dir: work,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

async function withWorkspace<T>(
  options: { remote?: string; noOrigin?: boolean; nexusRemotes?: boolean },
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const ws = makeWorkspace(options);
  try {
    return await fn(ws.dir);
  } finally {
    ws.cleanup();
  }
}

/**
 * Test-only resolver: the workspace's `origin` remote (acme/widget) is the
 * trusted integration target. This lets the existing tests exercise the
 * resolver-aware merge path without depending on the production Nexus target.
 */
const acmeResolver: IntegrationTargetResolver = createTrustedIntegrationTargetResolver([
  { remoteName: "origin", repository: "acme/widget", defaultBranch: "main" },
]);

function baseInput(overrides: Partial<GitMergePullRequestInput> = {}): GitMergePullRequestInput {
  return {
    prNumber: 42,
    expectedBaseSha: BASE,
    expectedHeadSha: HEAD,
    mergeMethod: "merge",
    ownerConfirmation: true,
    ...overrides,
  };
}

function assertErrorCode(error: unknown, code: string): boolean {
  assert.ok(error instanceof MergePullRequestError, `expected MergePullRequestError, got ${String(error)}`);
  assert.equal(error.code, code);
  return true;
}

// ============================================================
console.log("\n=== parseGitHubRemote ===");

test("https remote", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/acme/widget.git"), { owner: "acme", name: "widget" });
});

test("scp-style remote", () => {
  assert.deepEqual(parseGitHubRemote("git@github.com:acme/widget.git"), { owner: "acme", name: "widget" });
});

test("ssh:// remote", () => {
  assert.deepEqual(parseGitHubRemote("ssh://git@github.com/acme/widget"), { owner: "acme", name: "widget" });
});

test("trailing slash and no .git", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/acme/widget"), { owner: "acme", name: "widget" });
});

test("gitlab remote rejected", () => {
  assert.equal(parseGitHubRemote("git@gitlab.com:acme/widget.git"), null);
});

test("non-github https rejected", () => {
  assert.equal(parseGitHubRemote("https://example.com/acme/widget.git"), null);
});

test("malformed rejected", () => {
  assert.equal(parseGitHubRemote("https://github.com/acme"), null);
  assert.equal(parseGitHubRemote(""), null);
  assert.equal(parseGitHubRemote("arbitrary string"), null);
});

test("path-injection owner/name rejected", () => {
  assert.equal(parseGitHubRemote("https://github.com/../attacker/widget.git"), null);
  assert.equal(parseGitHubRemote("https://github.com/acme/evil/../x.git"), null);
});

test("sanitizeRemoteUrl strips embedded credentials", () => {
  const cleaned = sanitizeRemoteUrl("https://x-access-token:secret@github.com/acme/widget.git");
  assert.ok(!cleaned.includes("secret"), "credential must be stripped");
  assert.ok(cleaned.startsWith("https://github.com/acme/widget.git"));
});

// ============================================================
console.log("\n=== input validation ===");

test("prNumber must be a positive integer", () => {
  assert.throws(() => parseMergePullRequestInput({ ...baseInput({ prNumber: 0 }) }), (e) =>
    assertErrorCode(e, PR_MERGE_ERROR_CODES.INVALID_INPUT));
  assert.throws(() => parseMergePullRequestInput({ ...baseInput({ prNumber: 1.5 }) }), (e) =>
    assertErrorCode(e, PR_MERGE_ERROR_CODES.INVALID_INPUT));
});

test("SHAs must be full 40-hex", () => {
  assert.throws(() => parseMergePullRequestInput({ ...baseInput({ expectedHeadSha: "short" }) }), (e) =>
    assertErrorCode(e, PR_MERGE_ERROR_CODES.INVALID_INPUT));
  assert.throws(() => parseMergePullRequestInput({ ...baseInput({ expectedBaseSha: "" }) }), (e) =>
    assertErrorCode(e, PR_MERGE_ERROR_CODES.INVALID_INPUT));
});

test("mergeMethod must be typed enum", () => {
  assert.throws(() => parseMergePullRequestInput({ ...baseInput({ mergeMethod: "squash --admin" as MergeMethod }) }), (e) =>
    assertErrorCode(e, PR_MERGE_ERROR_CODES.INVALID_INPUT));
});

test("ownerConfirmation must be a boolean", () => {
  assert.throws(() =>
    parseMergePullRequestInput({ ...baseInput({ ownerConfirmation: "true" as unknown as boolean }) }),
  (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.INVALID_INPUT));
});

test("extra caller keys are structurally ignored", () => {
  const parsed = parseMergePullRequestInput({
    ...baseInput(),
    refspec: "refs/heads/evil:refs/heads/main",
    remote: "git@github.com:attacker/evil.git",
    branch: "evil",
    force: true,
    shell: "rm -rf /",
  });
  assert.deepEqual(Object.keys(parsed).sort(), [
    "expectedBaseSha",
    "expectedHeadSha",
    "mergeMethod",
    "ownerConfirmation",
    "prNumber",
  ]);
});

// ============================================================
console.log("\n=== classifyCheckRun ===");

test("classifyCheckRun statuses", () => {
  assert.equal(classifyCheckRun(runView("ci", "completed", "success")), "success");
  assert.equal(classifyCheckRun(runView("ci", "in_progress", null)), "pending");
  assert.equal(classifyCheckRun(runView("ci", "queued", null)), "pending");
  assert.equal(classifyCheckRun(runView("ci", "completed", "failure")), "failed");
  assert.equal(classifyCheckRun(runView("ci", "completed", "timed_out")), "failed");
  assert.equal(classifyCheckRun(runView("ci", "completed", "cancelled")), "cancelled");
  assert.equal(classifyCheckRun(runView("ci", "completed", "neutral")), "neutral");
  assert.equal(classifyCheckRun(runView("ci", "completed", "skipped")), "neutral");
  assert.equal(classifyCheckRun(runView("ci", "completed", null)), "unknown");
  assert.equal(classifyCheckRun(runView("ci", null, null)), "unknown");
});

test("classifyCommitStatusState statuses", () => {
  assert.equal(classifyCommitStatusState("success"), "success");
  assert.equal(classifyCommitStatusState("pending"), "pending");
  assert.equal(classifyCommitStatusState("failure"), "failed");
  assert.equal(classifyCommitStatusState("error"), "failed");
  assert.equal(classifyCommitStatusState("something"), "unknown");
});

// ============================================================
console.log("\n=== happy path ===");

await asyncTest("merge method: exact base, exact head, checks success, owner confirmed", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecksByContext("ci");
    fake.checkRuns = [runView("ci", "completed", "success")];
    const receipt = await mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver });

    assert.equal(receipt.merged, true);
    assert.equal(receipt.merge_method, "merge");
    assert.equal(receipt.repository, "acme/widget");
    assert.equal(receipt.remote_name, "origin");
    assert.equal(receipt.pr_number, 42);
    assert.equal(receipt.pr_title, "Fix widget");
    assert.equal(receipt.expected_base_sha, BASE);
    assert.equal(receipt.observed_base_sha_before_merge, BASE);
    assert.equal(receipt.expected_head_sha, HEAD);
    assert.equal(receipt.observed_head_sha_before_merge, HEAD);
    assert.equal(receipt.old_main_sha, BASE);
    assert.equal(receipt.candidate_head_sha, HEAD);
    assert.equal(receipt.new_main_sha, NEW_MAIN);
    assert.equal(receipt.merge_commit_sha, NEW_MAIN);
    assert.equal(receipt.default_branch, "main");
    assert.equal(receipt.remote, "git@github.com:acme/widget.git");
    assert.equal(receipt.merged_at, "2026-08-16T12:00:00Z");
    assert.deepEqual(receipt.checks_status.required, [
      { context: "ci", integrationId: null },
    ]);
    assert.deepEqual(receipt.checks_status.checks, [
      {
        context: "ci",
        integrationId: null,
        state: "success",
        status: "completed",
        conclusion: "success",
        source: "check_run",
        appId: null,
        reason: undefined,
      },
    ]);

    assert.equal(fake.mergeCalls.length, 1);
    assert.deepEqual(fake.mergeCalls[0], {
      repo: "acme/widget",
      prNumber: 42,
      method: "merge",
      expectedHeadSha: HEAD,
    });
  });
});

await asyncTest("no required checks configured → allowed", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecks();
    const receipt = await mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver });
    assert.equal(receipt.merged, true);
    assert.deepEqual(receipt.checks_status.required, []);
  });
});

await asyncTest("squash method: receipt separates candidate from resulting main sha", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.afterMergeBase = NEW_MAIN;
    fake.mergeResult = { merged: true, sha: NEW_MAIN, message: null };
    fake.afterMergePr = makeMergedPr({ mergeCommitOid: NEW_MAIN });
    const receipt = await mergePullRequest(baseInput({ mergeMethod: "squash" }), { cwd: dir, transport: fake, targetResolver: acmeResolver });
    assert.equal(receipt.merge_method, "squash");
    assert.equal(receipt.candidate_head_sha, HEAD);
    assert.equal(receipt.merge_commit_sha, NEW_MAIN);
    assert.notEqual(receipt.candidate_head_sha, receipt.merge_commit_sha);
    assert.equal(fake.mergeCalls[0].method, "squash");
  });
});

await asyncTest("rebase method: receipt separates candidate from resulting main sha", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.afterMergeBase = NEW_MAIN;
    fake.mergeResult = { merged: true, sha: NEW_MAIN, message: null };
    fake.afterMergePr = makeMergedPr({ mergeCommitOid: NEW_MAIN });
    const receipt = await mergePullRequest(baseInput({ mergeMethod: "rebase" }), { cwd: dir, transport: fake, targetResolver: acmeResolver });
    assert.equal(receipt.merge_method, "rebase");
    assert.equal(fake.mergeCalls[0].method, "rebase");
    assert.notEqual(receipt.candidate_head_sha, receipt.merge_commit_sha);
  });
});

// ============================================================
console.log("\n=== CAS / TOCTOU ===");

await asyncTest("head moved after validation → reject, no merge", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.driftAfter = { calls: 1, head: OTHER_HEAD };
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.EXPECTED_HEAD_MISMATCH),
    );
    assert.equal(fake.mergeCalls.length, 0, "merge must not run after CAS failure");
  });
});

await asyncTest("base moved after validation → reject, no merge", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.driftAfter = { calls: 1, base: OTHER_BASE };
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.EXPECTED_BASE_MISMATCH),
    );
    assert.equal(fake.mergeCalls.length, 0, "merge must not run after CAS failure");
  });
});

await asyncTest("head mismatch at preflight → reject", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.pr = makePr({ headRefOid: OTHER_HEAD });
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.EXPECTED_HEAD_MISMATCH),
    );
    assert.equal(fake.mergeCalls.length, 0);
  });
});

await asyncTest("base mismatch at preflight → reject", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.baseSha = OTHER_BASE;
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.EXPECTED_BASE_MISMATCH),
    );
    assert.equal(fake.mergeCalls.length, 0);
  });
});

await asyncTest("PR became draft after validation → PR_IS_DRAFT, no merge", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.driftAfter = { calls: 1, pr: { isDraft: true } };
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.PR_IS_DRAFT),
    );
    assert.equal(fake.mergeCalls.length, 0, "merge must not run after draft drift");
  });
});

await asyncTest("PR base branch changed after validation → PR_BASE_MISMATCH, no merge", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.driftAfter = { calls: 1, pr: { baseRefName: "another-branch" } };
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.PR_BASE_MISMATCH),
    );
    assert.equal(fake.mergeCalls.length, 0, "merge must not run after base branch drift");
  });
});

await asyncTest("PR base commit changed after validation → EXPECTED_BASE_MISMATCH, no merge", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.driftAfter = { calls: 1, pr: { baseRefOid: OTHER_BASE } };
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.EXPECTED_BASE_MISMATCH),
    );
    assert.equal(fake.mergeCalls.length, 0, "merge must not run after PR base commit drift");
  });
});

// ============================================================
console.log("\n=== PR state ===");

await asyncTest("closed PR → reject", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.pr = makePr({ state: "CLOSED" });
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.PR_NOT_OPEN),
    );
  });
});

await asyncTest("merged PR → reject", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.pr = makePr({ state: "MERGED", merged: true });
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.PR_NOT_OPEN),
    );
  });
});

await asyncTest("draft PR → reject", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.pr = makePr({ isDraft: true });
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.PR_IS_DRAFT),
    );
    assert.equal(fake.mergeCalls.length, 0);
  });
});

await asyncTest("wrong PR base branch → reject", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.pr = makePr({ baseRefName: "develop" });
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.PR_BASE_MISMATCH),
    );
  });
});

await asyncTest("fresh PR base commit differs from expected base → reject", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.pr = makePr({ baseRefOid: OTHER_BASE });
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.EXPECTED_BASE_MISMATCH),
    );
    assert.equal(fake.mergeCalls.length, 0);
  });
});

await asyncTest("wrong repository identity → reject", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.repository = { default_branch: "main", full_name: "acme/other" };
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REPOSITORY_IDENTITY_MISMATCH),
    );
  });
});

await asyncTest("conflicting mergeable → reject", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.pr = makePr({ mergeable: "CONFLICTING" });
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.PR_NOT_MERGEABLE),
    );
  });
});

await asyncTest("unknown mergeable → fail closed", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.pr = makePr({ mergeable: "UNKNOWN" });
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.PR_NOT_MERGEABLE),
    );
  });
});

// ============================================================
console.log("\n=== required checks ===");

await asyncTest("pending required check → REQUIRED_CHECKS_PENDING", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecksByContext("ci");
    fake.checkRuns = [runView("ci", "in_progress", null)];
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_PENDING),
    );
    assert.equal(fake.mergeCalls.length, 0);
  });
});

await asyncTest("failed required check → REQUIRED_CHECKS_FAILED", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecksByContext("ci");
    fake.checkRuns = [runView("ci", "completed", "failure")];
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_FAILED),
    );
  });
});

await asyncTest("cancelled required check → REQUIRED_CHECKS_FAILED", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecksByContext("ci");
    fake.checkRuns = [runView("ci", "completed", "cancelled")];
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_FAILED),
    );
  });
});

await asyncTest("required checks config unreadable → REQUIRED_CHECKS_UNKNOWN", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecksUnreadable();
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_UNKNOWN),
    );
  });
});

await asyncTest("required check has no check run → REQUIRED_CHECKS_UNKNOWN", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecksByContext("ci");
    fake.checkRuns = [];
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_UNKNOWN),
    );
  });
});

await asyncTest("required check neutral → REQUIRED_CHECKS_UNKNOWN (not success)", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecksByContext("ci");
    fake.checkRuns = [runView("ci", "completed", "neutral")];
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_UNKNOWN),
    );
  });
});

await asyncTest("duplicate same-name check runs, all success → allowed", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecksByContext("ci");
    fake.checkRuns = [
      runView("ci", "completed", "success"),
      runView("ci", "completed", "success"),
    ];
    const receipt = await mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver });
    assert.equal(receipt.merged, true);
  });
});

await asyncTest("duplicate same-name check runs, success + pending → REQUIRED_CHECKS_PENDING", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecksByContext("ci");
    fake.checkRuns = [
      runView("ci", "completed", "success"),
      runView("ci", "in_progress", null),
    ];
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_PENDING),
    );
  });
});

await asyncTest("duplicate same-name check runs, success + failed → REQUIRED_CHECKS_FAILED", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecksByContext("ci");
    fake.checkRuns = [
      runView("ci", "completed", "success"),
      runView("ci", "completed", "failure"),
    ];
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_FAILED),
    );
  });
});

await asyncTest("app-bound requirement only satisfied by matching app run → REQUIRED_CHECKS_UNKNOWN when wrong app present", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecks({ context: "ci", integrationId: 15368 });
    fake.checkRuns = [runViewWithApp("ci", 999, "other-app")];
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_UNKNOWN),
    );
  });
});

await asyncTest("app-bound requirement satisfied by matching app run → allowed", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecks({ context: "ci", integrationId: 15368 });
    fake.checkRuns = [
      runViewWithApp("ci", 999, "other-app"),
      runViewWithApp("ci", 15368, "nexus-verifier"),
    ];
    const receipt = await mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver });
    assert.equal(receipt.merged, true);
    assert.deepEqual(receipt.checks_status.required, [{ context: "ci", integrationId: 15368 }]);
  });
});

await asyncTest("app-bound requirement cannot be satisfied by commit status alone → REQUIRED_CHECKS_UNKNOWN", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecks({ context: "ci", integrationId: 15368 });
    fake.commitStatuses = [{ context: "ci", state: "success" }];
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_UNKNOWN),
    );
  });
});

await asyncTest("commit status success satisfies context-only requirement → allowed", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecksByContext("ci");
    fake.checkRuns = [];
    fake.commitStatuses = [{ context: "ci", state: "success" }];
    const receipt = await mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver });
    assert.equal(receipt.merged, true);
    assert.equal(receipt.checks_status.checks[0].source, "commit_status");
    assert.equal(receipt.checks_status.checks[0].state, "success");
  });
});

await asyncTest("commit status pending → REQUIRED_CHECKS_PENDING", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecksByContext("ci");
    fake.checkRuns = [];
    fake.commitStatuses = [{ context: "ci", state: "pending" }];
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_PENDING),
    );
  });
});

await asyncTest("commit status failed → REQUIRED_CHECKS_FAILED", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecksByContext("ci");
    fake.checkRuns = [];
    fake.commitStatuses = [{ context: "ci", state: "failure" }];
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_FAILED),
    );
  });
});

await asyncTest("effective rules require a check that classic protection does not → enforced", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.effectiveRules = {
      determined: true,
      requirements: [{ context: "gate", integrationId: 15368 }],
    };
    fake.checkRuns = [runViewWithApp("gate", 15368, "nexus-verifier")];
    const receipt = await mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver });
    assert.equal(receipt.merged, true);
    assert.deepEqual(receipt.checks_status.required, [{ context: "gate", integrationId: 15368 }]);
  });
});

await asyncTest("effective rules unreadable → REQUIRED_CHECKS_UNKNOWN even if classic protection empty", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.effectiveRules = { determined: false, requirements: [] };
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_UNKNOWN),
    );
  });
});

await asyncTest("required checks config fetch throws → REQUIRED_CHECKS_UNKNOWN", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.branchProtectionError = new TransportError("availability", 0, "network down");
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_UNKNOWN),
    );
  });
});

await asyncTest("check runs fetch throws → REQUIRED_CHECKS_UNKNOWN", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecksByContext("ci");
    fake.checkRunsError = new TransportError("availability", 0, "network down");
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_UNKNOWN),
    );
  });
});

await asyncTest("commit statuses fetch throws → REQUIRED_CHECKS_UNKNOWN", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecksByContext("ci");
    fake.commitStatusesError = new TransportError("availability", 0, "network down");
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_UNKNOWN),
    );
  });
});

// ============================================================
console.log("\n=== pre-merge effect guard ===");

await asyncTest("pre-merge guard rejects before physical merge effect", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.pr = makePr({ body: "lane evidence" });
    let observedBody: string | undefined;
    await assert.rejects(
      mergePullRequest(baseInput(), {
        cwd: dir,
        transport: fake,
        targetResolver: acmeResolver,
        beforeMergeEffect: async (context) => {
          observedBody = context.pullRequest.body;
          throw new MergePullRequestError(
            PR_MERGE_ERROR_CODES.MERGE_LANE_NOT_AUTHORIZED,
            "GOVERNED must use completion",
          );
        },
      }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.MERGE_LANE_NOT_AUTHORIZED),
    );
    assert.equal(observedBody, "lane evidence", "guard must receive the fresh PR body");
    assert.equal(fake.mergeCalls.length, 0, "guard rejection must happen before GitHub merge effect");
  });
});

await asyncTest("pre-merge guard permits existing CAS core when authorized", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    let guardCalls = 0;
    const receipt = await mergePullRequest(baseInput(), {
      cwd: dir,
      transport: fake,
      targetResolver: acmeResolver,
      beforeMergeEffect: async () => {
        guardCalls += 1;
      },
    });
    assert.equal(guardCalls, 1);
    assert.equal(fake.mergeCalls.length, 1);
    assert.equal(receipt.merged, true);
  });
});

// ============================================================
console.log("\n=== owner confirmation ===");

await asyncTest("ownerConfirmation false → OWNER_CONFIRMATION_REQUIRED", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    await assert.rejects(
      mergePullRequest(baseInput({ ownerConfirmation: false }), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.OWNER_CONFIRMATION_REQUIRED),
    );
    assert.equal(fake.mergeCalls.length, 0);
  });
});

await asyncTest("ownerConfirmation missing → OWNER_CONFIRMATION_REQUIRED", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    const input = baseInput({ ownerConfirmation: false });
    await assert.rejects(
      mergePullRequest({ ...input, ownerConfirmation: false }, { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.OWNER_CONFIRMATION_REQUIRED),
    );
  });
});

// ============================================================
console.log("\n=== merge rejections / transport errors ===");

await asyncTest("merge HTTP 405 → MERGE_REJECTED", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.mergeError = new TransportError("http", 405, "Pull request is not mergeable");
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.MERGE_REJECTED),
    );
  });
});

await asyncTest("merge HTTP 409 (head no longer expected) → EXPECTED_HEAD_MISMATCH", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.mergeError = new TransportError("http", 409, "Head commit was not expected SHA");
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.EXPECTED_HEAD_MISMATCH),
    );
  });
});

await asyncTest("merge HTTP 403 → AUTHORIZATION_FAILURE", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.mergeError = new TransportError("http", 403, "Resource not accessible by integration");
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.AUTHORIZATION_FAILURE),
    );
  });
});

await asyncTest("merge HTTP 500 → TRANSPORT_AVAILABILITY_FAILURE", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.mergeError = new TransportError("http", 500, "Internal Server Error");
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.TRANSPORT_AVAILABILITY_FAILURE),
    );
  });
});

await asyncTest("merge returned merged=false → MERGE_REJECTED", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.mergeResult = { merged: false, sha: null, message: "Pull request is not mergeable" };
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.MERGE_REJECTED),
    );
  });
});

await asyncTest("getPullRequest 404 → PR_NOT_FOUND", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.prError = new TransportError("http", 404, "Not Found");
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.PR_NOT_FOUND),
    );
  });
});

await asyncTest("getRepository auth failure → AUTHORIZATION_FAILURE", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.repoError = new TransportError("auth", 0, "gh CLI is not authenticated");
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.AUTHORIZATION_FAILURE),
    );
  });
});

await asyncTest("getRepository HTTP 500 → TRANSPORT_AVAILABILITY_FAILURE", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.repoError = new TransportError("http", 500, "Internal Server Error");
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.TRANSPORT_AVAILABILITY_FAILURE),
    );
  });
});

// ============================================================
console.log("\n=== post-merge verification ===");

await asyncTest("main did not advance → POST_MERGE_VERIFICATION_FAILED", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.afterMergeBase = BASE;
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.POST_MERGE_VERIFICATION_FAILED),
    );
  });
});

await asyncTest("PR not merged after merge → POST_MERGE_VERIFICATION_FAILED", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.afterMergePr = makePr({ state: "OPEN", merged: false, headRefOid: HEAD });
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.POST_MERGE_VERIFICATION_FAILED),
    );
  });
});

await asyncTest("read-back sha differs from merge result → POST_MERGE_VERIFICATION_FAILED", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.afterMergeBase = "9".repeat(40);
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.POST_MERGE_VERIFICATION_FAILED),
    );
  });
});

await asyncTest("read-back transport failure → POST_MERGE_VERIFICATION_FAILED", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.postMergeError = new Error("read-back unavailable");
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.POST_MERGE_VERIFICATION_FAILED),
    );
  });
});

// ============================================================
console.log("\n=== workspace / repository identity ===");

await asyncTest("non-git workspace → WORKSPACE_NOT_GIT_REPOSITORY", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-pr-merge-nongit-"));
  try {
    const fake = new FakeGitHubTransport();
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.WORKSPACE_NOT_GIT_REPOSITORY),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await asyncTest("non-github remote → INTEGRATION_TARGET_UNRESOLVED", async () => {
  await withWorkspace({ remote: "git@gitlab.com:acme/widget.git" }, async (dir) => {
    const fake = new FakeGitHubTransport();
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.INTEGRATION_TARGET_UNRESOLVED),
    );
  });
});

await asyncTest("no matching trusted remote → INTEGRATION_TARGET_UNRESOLVED", async () => {
  await withWorkspace({ remote: "git@github.com:acme/other.git" }, async (dir) => {
    const fake = new FakeGitHubTransport();
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.INTEGRATION_TARGET_UNRESOLVED),
    );
  });
});

await asyncTest("no remotes at all → INTEGRATION_TARGET_UNRESOLVED", async () => {
  await withWorkspace({ noOrigin: true }, async (dir) => {
    const fake = new FakeGitHubTransport();
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.INTEGRATION_TARGET_UNRESOLVED),
    );
  });
});

await asyncTest("default branch differs from trusted target → DEFAULT_BRANCH_MISMATCH", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.repository = { default_branch: "master", full_name: "acme/widget" };
    await assert.rejects(
      mergePullRequest(baseInput(), { cwd: dir, transport: fake, targetResolver: acmeResolver }),
      (e) => assertErrorCode(e, PR_MERGE_ERROR_CODES.DEFAULT_BRANCH_MISMATCH),
    );
  });
});

// ============================================================
console.log("\n=== trusted integration-target resolver ===");

test("nexus resolver selects only nexus-new (James3014/Nexus-new), never origin (James3014/Nexus)", async () => {
  const fakeList = async (): Promise<GitRemoteInfo[]> => {
    return [
      { name: "nexus-new", url: "https://github.com/James3014/Nexus-new.git" },
      { name: "origin", url: "https://github.com/James3014/Nexus.git" },
      { name: "gitlab", url: "git@gitlab.com:James3014/Nexus-new.git" },
    ];
  };
  const resolver = createTrustedIntegrationTargetResolver([NEXUS_TRUSTED_INTEGRATION_TARGET], fakeList);
  const r = await resolver.resolve("/tmp/workspace");
  assert.equal(r.remoteName, "nexus-new");
  assert.equal(r.repository, "James3014/Nexus-new");
  assert.equal(r.defaultBranch, "main");
  assert.equal(r.remoteUrl, "https://github.com/James3014/Nexus-new.git");
});

test("nexus resolver fails closed when the trusted remote is absent", async () => {
  const fakeList = async (): Promise<GitRemoteInfo[]> => {
    return [
      { name: "origin", url: "https://github.com/James3014/Nexus.git" },
      { name: "gitlab", url: "git@gitlab.com:James3014/Nexus-new.git" },
    ];
  };
  const resolver = createTrustedIntegrationTargetResolver([NEXUS_TRUSTED_INTEGRATION_TARGET], fakeList);
  await assert.rejects(
    resolver.resolve("/tmp/workspace"),
    (e) => {
      assert.ok(e instanceof MergePullRequestError);
      assert.equal(e.code, PR_MERGE_ERROR_CODES.INTEGRATION_TARGET_UNRESOLVED);
      return true;
    },
  );
});

test("trusted resolver fails closed when remotes cannot be enumerated", async () => {
  const fakeList = async (): Promise<GitRemoteInfo[]> => {
    throw new Error("git remote failed");
  };
  const resolver = createTrustedIntegrationTargetResolver([NEXUS_TRUSTED_INTEGRATION_TARGET], fakeList);
  await assert.rejects(
    resolver.resolve("/tmp/workspace"),
    (e) => {
      assert.ok(e instanceof MergePullRequestError);
      assert.equal(e.code, PR_MERGE_ERROR_CODES.INTEGRATION_TARGET_UNRESOLVED);
      return true;
    },
  );
});

await asyncTest("Nexus workspace merge resolves via nexus-new remote and targets James3014/Nexus-new", async () => {
  await withWorkspace({ nexusRemotes: true }, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.repository = { default_branch: "main", full_name: "James3014/Nexus-new" };
    fake.afterMergePr = makeMergedPr({ url: "https://github.com/James3014/Nexus-new/pull/42" });
    const receipt = await mergePullRequest(baseInput(), {
      cwd: dir,
      transport: fake,
      targetResolver: defaultIntegrationTargetResolver(),
    });
    assert.equal(receipt.repository, "James3014/Nexus-new");
    assert.equal(receipt.remote_name, "nexus-new");
    assert.equal(receipt.remote, "https://github.com/James3014/Nexus-new.git");
    assert.equal(fake.mergeCalls.length, 1);
    assert.equal(fake.mergeCalls[0].repo, "James3014/Nexus-new");
  });
});

// ============================================================
console.log("\n=== security: caller cannot influence target/force/refspec ===");

await asyncTest("tool ignores caller-supplied refspec/remote/branch/force/shell keys", async () => {
  await withWorkspace({}, async (dir) => {
    const fake = new FakeGitHubTransport();
    fake.requireChecks();

[Showing lines 1-1275 of 1632 (50.0KB limit). Use offset=1276 to continue.]