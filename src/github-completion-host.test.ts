import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_COMPLETION_INTEGRATION_GENERATIONS,
  isTransientRequiredChecksDecision,
  parseCompletionGeneration,
  parseGitHubCompletionToolInput,
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
