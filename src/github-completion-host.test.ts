import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isTransientRequiredChecksDecision,
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
