import assert from "node:assert/strict";
import test from "node:test";
import { assertBounded, canonicalize, ChatSwarmError, hashCredential, isExecutionActive, requestHash, TASK_STATES } from "./chat-swarm-contract.js";

test("canonical request hashing ignores object insertion order and includes routing", () => {
  assert.equal(requestHash({ swarmId: "s", taskKey: "k", prompt: "p", payload: { b: 2, a: 1 }, preferredWorkerId: "w" }), requestHash({ swarmId: "s", taskKey: "k", prompt: "p", payload: { a: 1, b: 2 }, preferredWorkerId: "w" }));
  assert.notEqual(requestHash({ swarmId: "s", taskKey: "k", prompt: "p", payload: {}, preferredWorkerId: "w" }), requestHash({ swarmId: "s", taskKey: "k", prompt: "p", payload: {}, preferredWorkerId: "x" }));
});

test("state vocabulary is closed and execution occupancy is explicit", () => {
  assert.deepEqual(TASK_STATES, ["QUEUED", "CLAIMED", "RUNNING", "RESULT_READY", "COLLECTED", "CANCEL_REQUESTED", "CANCELLED", "FAILED", "RECONCILE_REQUIRED"]);
  assert.equal(isExecutionActive("RUNNING"), true);
  assert.equal(isExecutionActive("RESULT_READY"), false);
  assert.throws(() => assertBounded("x".repeat(10), 2, "prompt"), ChatSwarmError);
  assert.match(hashCredential("secret"), /^[0-9a-f]{64}$/);
  assert.deepEqual(canonicalize({ z: { b: 2, a: 1 }, a: 0 }), { a: 0, z: { a: 1, b: 2 } });
});
