import assert from "node:assert/strict";
import test from "node:test";
import { ChatSwarmError, type ChatSwarmWorker } from "./chat-swarm-contract.js";
import {
  WORKER_AUTO_COMPACT_CAPSULE_SCHEMA,
  evaluateWorkerAutoCompact,
  prepareWorkerAutoCompact,
  type WorkerContextPressureSignal,
} from "./chat-swarm-auto-compact.js";

function worker(overrides: Partial<ChatSwarmWorker> = {}): ChatSwarmWorker {
  return {
    id: "worker-1",
    swarmId: "swarm-1",
    label: "Worker-01",
    runtimeKind: "mcp_peer",
    sessionIdentityFingerprint: "1".repeat(64),
    carrierConversationFingerprint: "2".repeat(64),
    lifecycleState: "AVAILABLE",
    checkpoint: { summary: "safe checkpoint", lastTaskId: "task-9" },
    continuationEpoch: 4,
    createdAt: "2026-09-13T09:00:00.000Z",
    updatedAt: "2026-09-13T09:00:00.000Z",
    ...overrides,
  };
}

function pressure(overrides: Partial<WorkerContextPressureSignal> = {}): WorkerContextPressureSignal {
  return {
    precision: "ESTIMATED",
    source: "DEVSPACE_ESTIMATE",
    utilizationRatio: 0.85,
    provenance: "bounded DevSpace context ledger estimate",
    observedAt: "2026-09-13T09:30:00.000Z",
    ...overrides,
  };
}

function prepare(overrides: Partial<Parameters<typeof prepareWorkerAutoCompact>[0]> = {}) {
  return prepareWorkerAutoCompact({
    worker: worker(),
    pressure: pressure(),
    prepareAtRatio: 0.8,
    roleInstructions: "Continue as the same logical worker under existing Swarm authority.",
    contextSummary: "Completed the prior bounded task; next work should resume from durable task state.",
    taskRefs: ["task-9"],
    resultRefs: ["result:task-9"],
    evidenceRefs: ["evidence:checkpoint-9"],
    blockers: [],
    claimCeiling: "WORKER_AUTO_COMPACT_PLANNER_SOURCE_ACCEPTED",
    createdAt: "2026-09-13T09:31:00.000Z",
    ...overrides,
  });
}

test("pressure below threshold does not require Auto Compact", () => {
  const result = evaluateWorkerAutoCompact({
    worker: worker(),
    pressure: pressure({ utilizationRatio: 0.79 }),
    prepareAtRatio: 0.8,
  });
  assert.equal(result.state, "NOT_REQUIRED");
  assert.equal(result.compactRequired, false);
  assert.equal(result.safeToPrepare, false);
});

test("estimated pressure remains explicitly estimated and prepares only at a safe boundary", () => {
  const result = prepare();
  assert.equal(result.decision.state, "PREPARE_REQUIRED");
  assert.equal(result.decision.compactRequired, true);
  assert.equal(result.decision.safeToPrepare, true);
  assert.equal(result.capsule?.schema, WORKER_AUTO_COMPACT_CAPSULE_SCHEMA);
  assert.equal(result.capsule?.pressure.precision, "ESTIMATED");
  assert.equal(result.capsule?.pressure.source, "DEVSPACE_ESTIMATE");
  assert.equal(result.capsule?.summaryAuthority, "CONTEXT_ONLY");
  assert.match(result.capsule?.checkpointHash ?? "", /^[0-9a-f]{64}$/);
  assert.match(result.capsule?.capsuleHash ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(result.replacementIntent, {
    kind: "REQUEST_REPLACEMENT_CARRIER",
    authority: "NON_AUTHORIZING",
    swarmId: "swarm-1",
    workerId: "worker-1",
    sourceEpoch: 4,
    capsuleHash: result.capsule?.capsuleHash,
  });
});

test("non-host pressure cannot be labeled exact", () => {
  assert.throws(
    () => evaluateWorkerAutoCompact({
      worker: worker(),
      pressure: pressure({ precision: "EXACT", source: "CARRIER_ESTIMATE" }),
      prepareAtRatio: 0.8,
    }),
    (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_INPUT",
  );

  assert.doesNotThrow(() => evaluateWorkerAutoCompact({
    worker: worker(),
    pressure: pressure({ precision: "EXACT", source: "HOST_NATIVE" }),
    prepareAtRatio: 0.8,
  }));
});

test("busy worker waits for an idle boundary without producing a replacement intent", () => {
  const result = prepare({
    worker: worker({ lifecycleState: "BUSY", currentTaskId: "task-live" }),
  });
  assert.equal(result.decision.state, "WAIT_SAFE_BOUNDARY");
  assert.equal(result.decision.compactRequired, true);
  assert.equal(result.decision.safeToPrepare, false);
  assert.equal(result.capsule, undefined);
  assert.equal(result.replacementIntent, undefined);
});

test("unknown effect, pending continuation, or reconciliation state blocks Auto Compact", () => {
  for (const input of [
    { hasUnknownEffect: true },
    { hasPendingContinuation: true },
    { worker: worker({ lifecycleState: "RECONCILE_REQUIRED" }) },
  ]) {
    const result = prepare(input);
    assert.equal(result.decision.state, "BLOCKED_RECONCILIATION");
    assert.equal(result.decision.safeToPrepare, false);
    assert.equal(result.capsule, undefined);
  }
});

test("missing checkpoint and disabled worker fail closed", () => {
  const missingCheckpoint = prepare({ worker: worker({ checkpoint: undefined }) });
  assert.equal(missingCheckpoint.decision.state, "BLOCKED_CHECKPOINT");
  assert.equal(missingCheckpoint.capsule, undefined);

  const disabled = prepare({ worker: worker({ lifecycleState: "DISABLED" }) });
  assert.equal(disabled.decision.state, "BLOCKED_DISABLED");
  assert.equal(disabled.capsule, undefined);
});

test("capsule hash is deterministic and material changes alter the hash", () => {
  const first = prepare();
  const second = prepare();
  const changedSummary = prepare({ contextSummary: "different bounded context" });
  const changedPressure = prepare({ pressure: pressure({ utilizationRatio: 0.9 }) });
  const changedEpoch = prepare({ worker: worker({ continuationEpoch: 5 }) });

  assert.equal(first.capsule?.capsuleHash, second.capsule?.capsuleHash);
  assert.notEqual(first.capsule?.capsuleHash, changedSummary.capsule?.capsuleHash);
  assert.notEqual(first.capsule?.capsuleHash, changedPressure.capsule?.capsuleHash);
  assert.notEqual(first.capsule?.capsuleHash, changedEpoch.capsule?.capsuleHash);
});

test("capsule structurally excludes raw checkpoint, transcript, reasoning, tool history and credentials", () => {
  const capsule = prepare().capsule! as unknown as Record<string, unknown>;
  for (const forbidden of [
    "checkpoint",
    "transcript",
    "chainOfThought",
    "reasoning",
    "toolHistory",
    "rawToolOutput",
    "credentials",
    "token",
    "cookie",
    "sessionSecret",
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(capsule, forbidden), false, forbidden);
  }
  assert.equal(typeof capsule.checkpointHash, "string");
});

test("capsule and reference bounds fail closed", () => {
  assert.throws(
    () => prepare({ contextSummary: "x".repeat(16 * 1024 + 1) }),
    (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_INPUT",
  );

  assert.throws(
    () => prepare({ taskRefs: Array.from({ length: 33 }, (_, index) => `task-${index}`) }),
    (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_INPUT",
  );

  assert.throws(
    () => prepare({ blockers: Array.from({ length: 17 }, (_, index) => `blocker-${index}`) }),
    (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_INPUT",
  );
});

test("invalid threshold, ratio, timestamp and epoch fail closed", () => {
  for (const prepareAtRatio of [0, -0.1, 1.01, Number.NaN]) {
    assert.throws(
      () => evaluateWorkerAutoCompact({ worker: worker(), pressure: pressure(), prepareAtRatio }),
      (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_INPUT",
    );
  }

  assert.throws(
    () => evaluateWorkerAutoCompact({
      worker: worker(),
      pressure: pressure({ utilizationRatio: 1.1 }),
      prepareAtRatio: 0.8,
    }),
    (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_INPUT",
  );

  assert.throws(
    () => evaluateWorkerAutoCompact({
      worker: worker(),
      pressure: pressure({ observedAt: "not-a-time" }),
      prepareAtRatio: 0.8,
    }),
    (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_INPUT",
  );

  assert.throws(
    () => evaluateWorkerAutoCompact({
      worker: worker({ continuationEpoch: -1 }),
      pressure: pressure(),
      prepareAtRatio: 0.8,
    }),
    (error: unknown) => error instanceof ChatSwarmError && error.code === "INVALID_INPUT",
  );
});
