import assert from "node:assert/strict";
import test from "node:test";
import { summarizeExecutionCapacity } from "./local-agent-sessions.js";

test("global local slot exhaustion is explicit and separated from provider quota", () => {
  assert.deepEqual(summarizeExecutionCapacity(4, 4, 1), {
    used: 4,
    max: 4,
    activeInWorkspace: 1,
    activeOtherWorkspaces: 3,
    localState: "EXHAUSTED",
    providerState: "UNKNOWN",
  });
});

test("available local slots never manufacture provider rate-limit evidence", () => {
  assert.deepEqual(summarizeExecutionCapacity(2, 4, 2), {
    used: 2,
    max: 4,
    activeInWorkspace: 2,
    activeOtherWorkspaces: 0,
    localState: "AVAILABLE",
    providerState: "UNKNOWN",
  });
});

test("unbounded local configuration stays available while preserving usage diagnostics", () => {
  assert.deepEqual(summarizeExecutionCapacity(8, undefined, 3), {
    used: 8,
    activeInWorkspace: 3,
    activeOtherWorkspaces: 5,
    localState: "AVAILABLE",
    providerState: "UNKNOWN",
  });
});
