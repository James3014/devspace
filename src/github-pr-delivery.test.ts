import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableOperationStore } from "./durable-operations.js";
import {
  GitHubPrDeliveryError,
  GitHubPrEffectError,
  preflightPrDelivery,
  reconcilePrDeliveryEffect,
  runPrDeliveryEffect,
  type GitHubPrDeliveryRequest,
  type GitHubPrEffectAdapter,
  type GitHubPrRef,
} from "./github-pr-delivery.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const OTHER_SHA = "c".repeat(40);

function baseRequest(overrides: Partial<GitHubPrDeliveryRequest> = {}): GitHubPrDeliveryRequest {
  return {
    repository: "James3014/devspace",
    baseBranch: "main",
    expectedBaseSha: BASE_SHA,
    candidateBranch: "codex/issue-115-probe",
    expectedCandidateHeadSha: HEAD_SHA,
    title: "probe delivery",
    body: "probe body",
    issueNumber: 115,
    attemptKey: "probe-attempt-1",
    localRepoRoot: "/tmp/pr-delivery-scope",
    ...overrides,
  };
}

interface FakeCounts {
  repoReads: number;
  branchReads: number;
  lists: number;
  prReads: number;
  creates: number;
}

class FakeGitHub implements GitHubPrEffectAdapter {
  readonly counts: FakeCounts = { repoReads: 0, branchReads: 0, lists: 0, prReads: 0, creates: 0 };
  repoError?: GitHubPrEffectError;
  repoForbidden = false;
  heads: Record<string, string | "missing"> = { main: BASE_SHA, "codex/issue-115-probe": HEAD_SHA };
  headError?: GitHubPrEffectError;
  prs: GitHubPrRef[] = [];
  listError?: GitHubPrEffectError;
  createMode: "ok" | "lost-ack" | "refused" = "ok";
  createError = new GitHubPrEffectError("EFFECT_FAILED", false, false, "create refused");
  readError?: GitHubPrEffectError;
  writeCapability: "unknown" | "unavailable" = "unknown";
  private nextNumber = 100;

  async readRepository(): Promise<{ name: string }> {
    this.counts.repoReads += 1;
    if (this.repoError) throw this.repoError;
    if (this.repoForbidden) {
      throw new GitHubPrEffectError("EFFECT_FORBIDDEN", false, false, "repository not authorized");
    }
    return { name: "James3014/devspace" };
  }

  async readBranchHead(branch: string): Promise<{ sha: string } | { missing: true }> {
    this.counts.branchReads += 1;
    if (this.headError) throw this.headError;
    const head = this.heads[branch];
    if (head === undefined || head === "missing") return { missing: true };
    return { sha: head };
  }

  async listOpenPrs(input: { headBranch: string; baseBranch: string }): Promise<GitHubPrRef[]> {
    this.counts.lists += 1;
    if (this.listError) throw this.listError;
    return this.prs.filter(
      (pr) => pr.state === "open" && pr.headBranch === input.headBranch && pr.baseBranch === input.baseBranch,
    );
  }

  async readPr(prNumber: number): Promise<GitHubPrRef> {
    this.counts.prReads += 1;
    if (this.readError) throw this.readError;
    const found = this.prs.find((pr) => pr.number === prNumber);
    if (!found) throw new GitHubPrEffectError("EFFECT_NOT_FOUND", false, false, "PR not found");
    return found;
  }

  async createPr(input: { title: string; body: string; headBranch: string; baseBranch: string; issueNumber?: number }): Promise<GitHubPrRef> {
    this.counts.creates += 1;
    if (this.createMode === "refused") throw this.createError;
    const ref: GitHubPrRef = {
      repository: "James3014/devspace",
      number: this.nextNumber++,
      url: `https://github.com/James3014/devspace/pull/${this.nextNumber - 1}`,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      title: input.title,
      ...(input.issueNumber === undefined ? {} : { issueNumber: input.issueNumber }),
      state: "open",
    };
    this.prs.push(ref);
    if (this.createMode === "lost-ack") {
      throw new GitHubPrEffectError("EFFECT_TRANSPORT_LOST", false, true, "response lost after remote create");
    }
    return ref;
  }

  describeWriteCapability(): "unknown" | "unavailable" {
    return this.writeCapability;
  }
}

function setupStore() {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-pr-delivery-test-"));
  const store = new DurableOperationStore(stateDir);
  const clean = () => {
    try {
      store.close();
    } catch {}
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {}
  };
  return { store, stateDir, clean };
}

function authError() {
  return new GitHubPrEffectError("EFFECT_AUTH_UNAVAILABLE", false, false, "no credential");
}

function networkError() {
  return new GitHubPrEffectError("EFFECT_NETWORK_UNAVAILABLE", false, false, "unreachable");
}

// ─── G0 preflight ────────────────────────────────────────────────────────────

test("preflight reports READY without proving write and without creating", async () => {
  const fake = new FakeGitHub();
  const preflight = await preflightPrDelivery(fake, baseRequest());
  assert.equal(preflight.status, "GITHUB_PR_READY");
  assert.equal(preflight.writeProven, false);
  assert.equal(preflight.writeState, "UNPROVEN");
  assert.equal(preflight.observedBaseSha, BASE_SHA);
  assert.equal(preflight.observedCandidateHeadSha, HEAD_SHA);
  assert.equal(fake.counts.creates, 0);
});

test("preflight distinguishes auth, network, and authorization failures", async () => {
  const authProbe = new FakeGitHub();
  authProbe.repoError = authError();
  assert.equal((await preflightPrDelivery(authProbe, baseRequest())).status, "GITHUB_AUTH_UNAVAILABLE");

  const networkProbe = new FakeGitHub();
  networkProbe.repoError = networkError();
  assert.equal((await preflightPrDelivery(networkProbe, baseRequest())).status, "GITHUB_NETWORK_UNAVAILABLE");

  const forbiddenProbe = new FakeGitHub();
  forbiddenProbe.repoForbidden = true;
  assert.equal((await preflightPrDelivery(forbiddenProbe, baseRequest())).status, "REPOSITORY_NOT_AUTHORIZED");
});

test("preflight rejects missing branches and drifted identity without writes", async () => {
  const missingProbe = new FakeGitHub();
  missingProbe.heads = { main: BASE_SHA };
  assert.equal((await preflightPrDelivery(missingProbe, baseRequest())).status, "CANDIDATE_IDENTITY_INVALID");

  const driftedProbe = new FakeGitHub();
  driftedProbe.heads = { main: BASE_SHA, "codex/issue-115-probe": OTHER_SHA };
  const drifted = await preflightPrDelivery(driftedProbe, baseRequest());
  assert.equal(drifted.status, "CANDIDATE_IDENTITY_INVALID");
  assert.equal(driftedProbe.counts.creates, 0);
});

test("preflight reports unavailable write capability and unavailable reads distinctly", async () => {
  const writeProbe = new FakeGitHub();
  writeProbe.writeCapability = "unavailable";
  assert.equal((await preflightPrDelivery(writeProbe, baseRequest())).status, "PR_WRITE_UNAVAILABLE");

  const readProbe = new FakeGitHub();
  readProbe.listError = new GitHubPrEffectError("EFFECT_FAILED", false, false, "listing exploded");
  assert.equal((await preflightPrDelivery(readProbe, baseRequest())).status, "PR_READ_UNAVAILABLE");
});

// ─── G1/G3 delivery ──────────────────────────────────────────────────────────

test("delivery creates exactly one PR with exact identity receipt", async () => {
  const { store, clean } = setupStore();
  try {
    const fake = new FakeGitHub();
    const result = await runPrDeliveryEffect(store, fake, baseRequest());
    assert.equal(result.outcome, "COMPLETED");
    assert.equal(fake.counts.creates, 1);
    assert.equal(result.pr?.headSha, HEAD_SHA);
    assert.equal(result.pr?.baseSha, BASE_SHA);
    assert.equal(result.operation.status, "succeeded");
  } finally {
    clean();
  }
});

test("delivery refuses on base and candidate drift with zero creates", async () => {
  for (const heads of [
    { main: OTHER_SHA, "codex/issue-115-probe": HEAD_SHA },
    { main: BASE_SHA, "codex/issue-115-probe": OTHER_SHA },
  ]) {
    const { store, clean } = setupStore();
    try {
      const fake = new FakeGitHub();
      fake.heads = heads;
      const result = await runPrDeliveryEffect(store, fake, baseRequest({ attemptKey: `drift-${heads.main}` }));
      assert.equal(result.outcome, "FAILED");
      assert.equal(fake.counts.creates, 0);
    } finally {
      clean();
    }
  }
});

test("lost acknowledgement reconciles to the same PR without a second create", async () => {
  const { store, clean } = setupStore();
  try {
    const fake = new FakeGitHub();
    fake.createMode = "lost-ack";
    const attempted = await runPrDeliveryEffect(store, fake, baseRequest());
    assert.equal(attempted.outcome, "OUTCOME_UNKNOWN");
    assert.equal(fake.counts.creates, 1);
    const reconciled = await reconcilePrDeliveryEffect(store, fake, "/tmp/pr-delivery-scope", "probe-attempt-1");
    assert.equal(reconciled.outcome, "COMPLETED");
    assert.equal(reconciled.pr?.headSha, HEAD_SHA);
    assert.equal(fake.counts.creates, 1);
  } finally {
    clean();
  }
});

test("identical replay resolves to the same operation with one create", async () => {
  const { store, clean } = setupStore();
  try {
    const fake = new FakeGitHub();
    const first = await runPrDeliveryEffect(store, fake, baseRequest());
    const second = await runPrDeliveryEffect(store, fake, baseRequest());
    assert.equal(first.outcome, "COMPLETED");
    assert.equal(second.outcome, "COMPLETED");
    assert.equal(first.operation.operationId, second.operation.operationId);
    assert.equal(second.pr?.number, first.pr?.number);
    assert.equal(fake.counts.creates, 1);
  } finally {
    clean();
  }
});

test("conflicting replay under the same attemptKey fails closed", async () => {
  const variants: Partial<GitHubPrDeliveryRequest>[] = [
    { expectedCandidateHeadSha: OTHER_SHA },
    { expectedBaseSha: OTHER_SHA },
    { title: "different title" },
    { body: "different body" },
    { issueNumber: 999 },
  ];
  for (const [index, variant] of variants.entries()) {
    const { store, clean } = setupStore();
    try {
      const fake = new FakeGitHub();
      await runPrDeliveryEffect(store, fake, baseRequest());
      await assert.rejects(
        runPrDeliveryEffect(store, fake, baseRequest({ ...variant, attemptKey: "probe-attempt-1" })),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "OPERATION_REPLAY_CONFLICT");
          return true;
        },
      );
      assert.equal(fake.counts.creates, 1, `variant ${index} must not create again`);
    } finally {
      clean();
    }
  }
});

test("unrelated and wrong-head PRs are never adopted", async () => {
  const { store, clean } = setupStore();
  try {
    const fake = new FakeGitHub();
    fake.prs.push({
      repository: "James3014/devspace",
      number: 41,
      url: "https://github.com/James3014/devspace/pull/41",
      headSha: OTHER_SHA,
      baseSha: BASE_SHA,
      baseBranch: "main",
      headBranch: "codex/issue-115-probe",
      title: "unrelated same-issue PR",
      issueNumber: 115,
      state: "open",
    });
    const result = await runPrDeliveryEffect(store, fake, baseRequest());
    assert.equal(result.outcome, "COMPLETED");
    assert.notEqual(result.pr?.number, 41);
    assert.equal(result.pr?.headSha, HEAD_SHA);
    assert.equal(fake.counts.creates, 1);
  } finally {
    clean();
  }
});

test("restart reopens the same operation and reconciles it", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-pr-delivery-restart-"));
  const firstStore = new DurableOperationStore(stateDir);
  try {
    const fake = new FakeGitHub();
    fake.createMode = "lost-ack";
    const attempted = await runPrDeliveryEffect(firstStore, fake, baseRequest());
    assert.equal(attempted.outcome, "OUTCOME_UNKNOWN");
  } finally {
    try {
      firstStore.close();
    } catch {}
  }
  const reopened = new DurableOperationStore(stateDir);
  try {
    const fake = new FakeGitHub();
    fake.prs.push({
      repository: "James3014/devspace",
      number: 77,
      url: "https://github.com/James3014/devspace/pull/77",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      baseBranch: "main",
      headBranch: "codex/issue-115-probe",
      title: "probe delivery",
      issueNumber: 115,
      state: "open",
    });
    const reconciled = await reconcilePrDeliveryEffect(reopened, fake, "/tmp/pr-delivery-scope", "probe-attempt-1");
    assert.equal(reconciled.outcome, "COMPLETED");
    assert.equal(reconciled.pr?.number, 77);
    assert.equal(fake.counts.creates, 0);
  } finally {
    try {
      reopened.close();
    } catch {}
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {}
  }
});

test("interrupted started operation reconciles after markInterruptedUnknown", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-pr-delivery-crash-"));
  const firstStore = new DurableOperationStore(stateDir);
  try {
    // A crash between durable creation and finish leaves a started record,
    // exactly as a killed controller would.
    firstStore.createOrReplay({
      operationId: "op_crash_probe",
      attemptKey: "crash-attempt-1",
      requestHash: "probe-hash",
      kind: "github_pr_delivery",
      authorityMode: "OWNER_DIRECT",
      scopeRoot: "/tmp/pr-delivery-scope",
      request: {
        schema: "devspace.github_pr_delivery_request.v1",
        repository: "james3014/devspace",
        baseBranch: "main",
        expectedBaseSha: BASE_SHA,
        candidateBranch: "codex/issue-115-probe",
        expectedCandidateHeadSha: HEAD_SHA,
        title: "probe delivery",
        body: "probe body",
        issueNumber: 115,
      },
    });
    assert.equal(firstStore.markInterruptedUnknown(), 1);
  } finally {
    try {
      firstStore.close();
    } catch {}
  }
  const reopened = new DurableOperationStore(stateDir);
  try {
    const crashed = reopened.getByAttempt("/tmp/pr-delivery-scope", "crash-attempt-1");
    assert.equal(crashed?.status, "outcome_unknown");
    assert.equal(crashed?.errorCode, "RECONCILIATION_REQUIRED");
    const fake = new FakeGitHub();
    fake.prs.push({
      repository: "James3014/devspace",
      number: 78,
      url: "https://github.com/James3014/devspace/pull/78",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      baseBranch: "main",
      headBranch: "codex/issue-115-probe",
      title: "probe delivery",
      issueNumber: 115,
      state: "open",
    });
    const reconciled = await reconcilePrDeliveryEffect(reopened, fake, "/tmp/pr-delivery-scope", "crash-attempt-1");
    assert.equal(reconciled.outcome, "COMPLETED");
    assert.equal(reconciled.pr?.number, 78);
    assert.equal(fake.counts.creates, 0);
  } finally {
    try {
      reopened.close();
    } catch {}
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {}
  }
});

test("concurrent delivery attempts create at most one PR", async () => {
  const { store, clean } = setupStore();
  try {
    const fake = new FakeGitHub();
    const [first, second] = await Promise.all([
      runPrDeliveryEffect(store, fake, baseRequest()),
      runPrDeliveryEffect(store, fake, baseRequest()),
    ]);
    assert.equal(fake.counts.creates, 1);
    assert.equal(fake.prs.length, 1);
    assert.equal(first.operation.operationId, second.operation.operationId);
    assert.ok(["COMPLETED", "OUTCOME_UNKNOWN"].includes(first.outcome));
    assert.ok(["COMPLETED", "OUTCOME_UNKNOWN"].includes(second.outcome));
    assert.ok(first.outcome === "COMPLETED" || second.outcome === "COMPLETED");
  } finally {
    clean();
  }
});

test("delivery surface grants no merge authority", async () => {
  const { store, clean } = setupStore();
  try {
    const fake = new FakeGitHub();
    const result = await runPrDeliveryEffect(store, fake, baseRequest());
    assert.equal(result.outcome, "COMPLETED");
    const serialized = JSON.stringify(result);
    assert.ok(!/merge/i.test(serialized.replace(/MERGE_READY/g, "")), "no merge state may appear in delivery evidence");
    assert.ok(!("merge" in (result as unknown as Record<string, unknown>)), "no merge surface on the result");
  } finally {
    clean();
  }
});

test("invalid request identity fails closed before any effect", async () => {
  const { store, clean } = setupStore();
  try {
    const fake = new FakeGitHub();
    await assert.rejects(
      runPrDeliveryEffect(store, fake, baseRequest({ expectedCandidateHeadSha: "not-a-sha" })),
      (error: unknown) => error instanceof GitHubPrDeliveryError,
    );
    assert.equal(fake.counts.creates, 0);
    assert.equal(fake.counts.branchReads, 0);
  } finally {
    clean();
  }
});
