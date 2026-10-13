import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MAX_COMPLETION_INTEGRATION_GENERATIONS,
  isTransientRequiredChecksDecision,
  parseCompletionGeneration,
  parseGitHubCompletionToolInput,
  readHeadCheckRuns,
} from "./github-completion-host.js";

const missingReason = "no check run or commit status matches the required context for the expected head SHA";

describe("isTransientRequiredChecksDecision", () => {
  it("waits when an exact-head required check has not appeared yet", () => {
    assert.equal(
      isTransientRequiredChecksDecision({
        ok: false,
        code: "REQUIRED_CHECKS_UNKNOWN",
        message: "missing",
        required: [],
        statuses: [
          { context: "a", integrationId: 1, state: "pending", status: "in_progress", conclusion: null, source: "check_run", appId: 1 },
          { context: "b", integrationId: 1, state: "unknown", status: null, conclusion: null, source: "check_run", appId: null, reason: missingReason },
        ],
      }),
      true,
    );
  });

  it("fails closed for indeterminate or unreadable evidence", () => {
    assert.equal(
      isTransientRequiredChecksDecision({
        ok: false,
        code: "REQUIRED_CHECKS_UNKNOWN",
        message: "indeterminate",
        required: [],
        statuses: [
          { context: "a", integrationId: 1, state: "unknown", status: "completed", conclusion: "neutral", source: "check_run", appId: 1, reason: "a relevant check run or commit status is neutral, skipped, or indeterminate" },
        ],
      }),
      false,
    );
    assert.equal(
      isTransientRequiredChecksDecision({
        ok: false,
        code: "REQUIRED_CHECKS_UNKNOWN",
        message: "configuration unreadable",
        required: [],
        statuses: [],
      }),
      false,
    );
  });
});

describe("completion integration generation cap (#1384)", () => {
  const baseInput = {
    initialEvidence: {},
    standingGrantRequest: {},
    mergeMethod: "merge",
    ownerConfirmation: true,
  };

  it("matches the Nexus-new MAX_INTEGRATION_GENERATIONS=5 loop budget", () => {
    assert.equal(MAX_COMPLETION_INTEGRATION_GENERATIONS, 5);
  });

  it("defaults maxGenerations to 5 and accepts 4 and 5", () => {
    assert.equal(parseGitHubCompletionToolInput({ ...baseInput }).maxGenerations, 5);
    assert.equal(parseGitHubCompletionToolInput({ ...baseInput, maxGenerations: 4 }).maxGenerations, 4);
    assert.equal(parseGitHubCompletionToolInput({ ...baseInput, maxGenerations: 5 }).maxGenerations, 5);
  });

  it("rejects maxGenerations above 5 or below 1", () => {
    for (const value of [0, 6, 2.5, "5"]) {
      assert.throws(
        () => parseGitHubCompletionToolInput({ ...baseInput, maxGenerations: value }),
        /maxGenerations_INVALID/,
      );
    }
  });

  it("port generation guard admits I4 and I5 and rejects I6", () => {
    assert.equal(parseCompletionGeneration(4), 4);
    assert.equal(parseCompletionGeneration(5), 5);
    for (const value of [0, 6, null, "4"]) {
      assert.throws(() => parseCompletionGeneration(value), /generation_INVALID/);
    }
  });
});

describe("readHeadCheckRuns (Nexus-new #2068)", () => {
  const SHA = "a".repeat(40);
  const run = (n: number, over: Record<string, unknown> = {}) => ({
    name: `check-${n}`,
    status: "completed",
    conclusion: "success",
    head_sha: SHA,
    app: { id: 15368, slug: "github-actions" },
    ...over,
  });
  const pagedTransport = (pages: Array<{ total: number; runs: unknown[] } | Error>) => {
    const calls: Array<[string, string, number, number]> = [];
    return {
      calls,
      getCheckRunsPage: async (repo: string, sha: string, page: number, perPage: number) => {
        calls.push([repo, sha, page, perPage]);
        const entry = pages[page - 1];
        if (!entry) throw new Error("unexpected extra page");
        if (entry instanceof Error) throw entry;
        return { totalCount: entry.total, checkRuns: entry.runs };
      },
    };
  };

  it("paginates through every page and returns app identity", async () => {
    const t = pagedTransport([
      { total: 3, runs: [run(1), run(2)] },
      { total: 3, runs: [run(3, { app: { id: 7, slug: "other" } })] },
    ]);
    const out = await readHeadCheckRuns(t, "o/r", SHA);
    assert.deepEqual(out.map((r) => r.name), ["check-1", "check-2", "check-3"]);
    assert.deepEqual(t.calls.map((c) => c[2]), [1, 2]);
    assert.equal(out[0].app_slug, "github-actions");
    assert.equal(out[0].app_id, 15368);
    assert.equal(out[2].app_id, 7);
    assert.equal(out[0].head_sha, SHA);
  });

  it("returns empty only when GitHub reports total_count 0", async () => {
    assert.deepEqual(await readHeadCheckRuns(pagedTransport([{ total: 0, runs: [] }]), "o/r", SHA), []);
  });

  it("rejects a non-40-hex requested SHA before any API call", async () => {
    for (const bad of ["abc", "A".repeat(40), "g".repeat(40), 5, null]) {
      const t = pagedTransport([{ total: 0, runs: [] }]);
      await assert.rejects(() => readHeadCheckRuns(t, "o/r", bad), /check_runs_head_sha_INVALID/);
      assert.equal(t.calls.length, 0);
    }
  });

  it("rejects any run whose head_sha differs from the requested SHA", async () => {
    const t = pagedTransport([{ total: 2, runs: [run(1), run(2, { head_sha: "b".repeat(40) })] }]);
    await assert.rejects(() => readHeadCheckRuns(t, "o/r", SHA), /CHECK_RUN_HEAD_SHA_MISMATCH/);
  });

  it("fails closed on API error instead of returning an empty list", async () => {
    await assert.rejects(
      () => readHeadCheckRuns(pagedTransport([new Error("HTTP 502")]), "o/r", SHA),
      /HTTP 502/,
    );
    await assert.rejects(
      () => readHeadCheckRuns(pagedTransport([{ total: 2, runs: [run(1)] }, new Error("HTTP 500")]), "o/r", SHA),
      /HTTP 500/,
    );
  });

  it("fails closed on incomplete, shifting or malformed pagination", async () => {
    await assert.rejects(
      () => readHeadCheckRuns(pagedTransport([{ total: 3, runs: [run(1)] }, { total: 3, runs: [] }]), "o/r", SHA),
      /PAGINATION_INCOMPLETE/,
    );
    await assert.rejects(
      () => readHeadCheckRuns(pagedTransport([{ total: 2, runs: [run(1)] }, { total: 3, runs: [run(2)] }]), "o/r", SHA),
      /TOTAL_CHANGED/,
    );
    await assert.rejects(
      () => readHeadCheckRuns(pagedTransport([{ total: 1, runs: [run(1), run(2)] }]), "o/r", SHA),
      /COUNT_MISMATCH/,
    );
    await assert.rejects(
      () => readHeadCheckRuns(pagedTransport([{ total: 1, runs: [run(1, { status: 3 })] }]), "o/r", SHA),
      /STATUS_INVALID/,
    );
    await assert.rejects(
      () => readHeadCheckRuns(pagedTransport([{ total: 1, runs: ["x"] }]), "o/r", SHA),
      /CHECK_RUN_INVALID/,
    );
  });

  it("keeps a null conclusion and null app identity", async () => {
    const out = await readHeadCheckRuns(
      pagedTransport([{ total: 1, runs: [run(1, { status: "in_progress", conclusion: null, app: null })] }]),
      "o/r",
      SHA,
    );
    assert.equal(out[0].conclusion, null);
    assert.equal(out[0].app_slug, null);
    assert.equal(out[0].app_id, null);
  });

  it("bridge parse_head_check_runs validates payloads (python unittest)", () => {
    const script = fileURLToPath(new URL("../scripts/test_github_completion_bridge.py", import.meta.url));
    execFileSync("python3", ["-I", "-B", script], { stdio: "pipe" });
  });
});
