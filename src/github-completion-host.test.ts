import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CompletionHostPort,
  isTransientRequiredChecksDecision,
} from "./github-completion-host.js";
import type { GitHubCompletionTransport, IntegrationTargetResolver } from "./git-pr-merge.js";

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

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);

function completionPort(overrides: {
  issueState?: "open" | "closed";
  issueStateRaw?: string;
  prNumber?: number;
  prBody?: string;
  baseSha?: string;
  headSha?: string;
} = {}) {
  const transport = {
    getPullRequest: async () => ({
      number: overrides.prNumber ?? 1228,
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      baseRefOid: overrides.baseSha ?? BASE,
      headRefName: "feature/g07",
      headRefOid: overrides.headSha ?? HEAD,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      merged: false,
      mergedAt: null,
      mergeCommitOid: null,
      title: "G07",
      url: "https://github.com/James3014/Nexus-new/pull/1228",
      body: overrides.prBody ?? "Issue-Closure-Intent: #1209 KEEP_OPEN",
    }),
    getIssueState: async () => overrides.issueStateRaw ?? overrides.issueState ?? "open",
  } as unknown as GitHubCompletionTransport;
  const targetResolver = {
    resolve: async () => ({
      remoteName: "origin",
      remoteUrl: "https://github.com/James3014/Nexus-new.git",
      repository: "James3014/Nexus-new",
      defaultBranch: "main",
    }),
  } as IntegrationTargetResolver;
  return new CompletionHostPort(
    {
      initialEvidence: {},
      standingGrantRequest: {},
      mergeMethod: "merge",
      ownerConfirmation: true,
      maxGenerations: 3,
      maxElapsedSeconds: 2700,
    },
    { nexusRoot: "/tmp/nexus", pythonBin: "python3" },
    transport,
    targetResolver,
    1228,
  );
}

describe("G07 completion host port", () => {
  it("returns fresh final merge fields bound to the actual submitted merge method and PR identity", async () => {
    const port = completionPort();
    assert.deepEqual(
      await port.call("read_final_merge_fields", {
        repository: "James3014/Nexus-new",
        pull_request_number: 1228,
      }),
      {
        schema: "nexus.final_merge_fields.v1",
        merge_method: "merge",
        pr_body: "Issue-Closure-Intent: #1209 KEEP_OPEN",
        commit_title: null,
        commit_message: null,
        pr_number: 1228,
        head_sha: HEAD,
        base_sha: BASE,
      },
    );
  });

  it("fails closed on repository, PR-number, or fresh PR identity mismatch", async () => {
    await assert.rejects(
      completionPort().call("read_final_merge_fields", {
        repository: "evil/repo",
        pull_request_number: 1228,
      }),
      /COMPLETION_REPOSITORY_MISMATCH/,
    );
    await assert.rejects(
      completionPort().call("read_final_merge_fields", {
        repository: "James3014/Nexus-new",
        pull_request_number: 1229,
      }),
      /COMPLETION_PR_NUMBER_MISMATCH/,
    );
    await assert.rejects(
      completionPort({ prNumber: 999 }).call("read_final_merge_fields", {
        repository: "James3014/Nexus-new",
        pull_request_number: 1228,
      }),
      /COMPLETION_PR_IDENTITY_MISMATCH/,
    );
  });

  it("returns only requested canonical Issue states and rejects malformed state", async () => {
    const port = completionPort({ issueState: "open" });
    assert.deepEqual(
      await port.call("read_issue_states", {
        repository: "James3014/Nexus-new",
        issue_numbers: [1209, 1209],
      }),
      { states: { "1209": "open" } },
    );
    await assert.rejects(
      completionPort({ issueStateRaw: "UNKNOWN" }).call("read_issue_states", {
        repository: "James3014/Nexus-new",
        issue_numbers: [1209],
      }),
      /ISSUE_STATE_INVALID/,
    );
  });

  it("keeps the Python bridge wired to both G07 port methods", () => {
    const source = readFileSync(new URL("../scripts/github_completion_bridge.py", import.meta.url), "utf8");
    assert.match(source, /def read_final_merge_fields\(/);
    assert.match(source, /FinalMergeFields\.model_validate/);
    assert.match(source, /def read_issue_states\(/);
    assert.match(source, /HOST_ISSUE_STATES_INCOMPLETE/);
  });
});
