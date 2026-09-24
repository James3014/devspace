import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import {
  DurableOperationError,
  DurableOperationStore,
  hashJson,
} from "./durable-operations.js";
import {
  NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_RECEIPT_SCHEMA,
  NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_SCHEMA,
  NEXUS_GATEWAY_RECOVERY_SCHEMA,
  NexusRecoveryAdapter,
  type NexusGatewayRecoveryMaterializationReceipt,
  type NexusGatewayRecoveryMaterializationRequest,
  type NexusGatewayRecoveryRequest,
} from "./nexus-recovery-adapter.js";

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "devspace-nexus-adapter-test-"));
  const stateDir = join(root, "state");
  const managerStateRoot = join(root, "manager-state");
  const materializationsDir = join(managerStateRoot, "recovery-materializations");
  await mkdir(stateDir, { recursive: true });
  await mkdir(materializationsDir, { recursive: true });

  const store = new DurableOperationStore(stateDir);
  return {
    root,
    stateDir,
    managerStateRoot,
    materializationsDir,
    store,
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function sampleMaterializationRequest(overrides?: Partial<NexusGatewayRecoveryMaterializationRequest>): NexusGatewayRecoveryMaterializationRequest {
  const hashPayload = {
    request_id: "req-mat-1",
    idempotency_fence: "fence-mat-1",
    operation: "gateway-recovery-materialize" as const,
    effect_class: "GATEWAY_RECOVERY_MATERIALIZATION" as const,
    recovery_authority_id: "auth-1",
    recovery_authority_hash: "a".repeat(64),
  };
  const request_hash = hashJson(hashPayload);
  return {
    ...hashPayload,
    schema: NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_SCHEMA,
    request_hash,
    ...overrides,
  };
}

function sampleRecoveryRequest(overrides?: Partial<NexusGatewayRecoveryRequest>): NexusGatewayRecoveryRequest {
  const hashPayload = {
    request_id: "req-rec-1",
    idempotency_fence: "fence-rec-1",
    operation: "gateway-recover" as const,
    effect_class: "GATEWAY_DURABLE_RECOVERY" as const,
    recovery_authority_id: "auth-1",
    recovery_authority_hash: "a".repeat(64),
    desired_manifest_id: `r1-${"1".repeat(40)}`,
    desired_manifest_hash: "b".repeat(64),
    predecessor_manifest_id: `r1-${"2".repeat(40)}`,
    predecessor_manifest_hash: "c".repeat(64),
  };
  const request_hash = hashJson(hashPayload);
  return {
    ...hashPayload,
    schema: NEXUS_GATEWAY_RECOVERY_SCHEMA,
    request_hash,
    ...overrides,
  };
}

function validMaterializationReceipt(request: NexusGatewayRecoveryMaterializationRequest): NexusGatewayRecoveryMaterializationReceipt {
  return {
    request_id: request.request_id,
    idempotency_fence: request.idempotency_fence,
    operation: "gateway-recovery-materialize",
    effect_class: "GATEWAY_RECOVERY_MATERIALIZATION",
    recovery_authority_id: request.recovery_authority_id,
    recovery_authority_hash: request.recovery_authority_hash,
    materialization_request_hash: request.request_hash,
    fresh_main: "1".repeat(40),
    fresh_main_tree: "2".repeat(40),
    materialized_authority_sha256: "3".repeat(64),
    materialized_request_sha256: "4".repeat(64),
    predecessor_artifact_sha256: "5".repeat(64),
    predecessor_artifact_size: 1024,
    effect_started: false,
    schema: NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_RECEIPT_SCHEMA,
    receipt_hash: "6".repeat(64),
  };
}

test("devspace#262 G3: Dev MCP disconnect/replacement between submit and readback reconciles from manager truth", async () => {
  const f = await createFixture();
  try {
    const request = sampleMaterializationRequest();
    const receipt = validMaterializationReceipt(request);

    // Simulated host manager writes durable receipt to fixed manager state store
    const receiptPath = join(f.materializationsDir, `${request.request_hash}.json`);
    await writeFile(receiptPath, JSON.stringify(receipt), "utf8");

    let bridgeCalls = 0;
    // Process 1 (Dev MCP before restart)
    const adapter1 = new NexusRecoveryAdapter(f.store, {
      stateRoot: f.managerStateRoot,
      runMaterialize: async () => {
        bridgeCalls++;
        return { exitCode: 0, stdout: JSON.stringify(receipt), stderr: "" };
      },
    });

    const op1 = await adapter1.materialize({ attemptKey: "replace-canary-1", request });
    assert.equal(op1.status, "succeeded");
    assert.equal(bridgeCalls, 0, "must adopt existing manager receipt without invoking bridge");

    // Process 2 (Replacement Dev MCP instance after crash/restart)
    const newStore = new DurableOperationStore(join(f.root, "state-new"));
    try {
      const adapter2 = new NexusRecoveryAdapter(newStore, {
        stateRoot: f.managerStateRoot,
        runMaterialize: async () => {
          bridgeCalls++;
          return { exitCode: 0, stdout: JSON.stringify(receipt), stderr: "" };
        },
      });

      // Replacement adapter receives the exact same request
      const op2 = await adapter2.materialize({ attemptKey: "replace-canary-1", request });
      assert.equal(op2.status, "succeeded");
      assert.equal(bridgeCalls, 0, "replacement adapter must adopt manager truth with zero duplicate effects");
      assert.equal((op2.receipt as Record<string, unknown>).reconciled, true);
    } finally {
      newStore.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("devspace#262 G3: adapter restart with manager operation already terminal reconciles without re-execution", async () => {
  const f = await createFixture();
  try {
    const request = sampleMaterializationRequest();
    const receipt = validMaterializationReceipt(request);

    let bridgeCalls = 0;
    const adapter = new NexusRecoveryAdapter(f.store, {
      stateRoot: f.managerStateRoot,
      runMaterialize: async () => {
        bridgeCalls++;
        // Simulate manager writing receipt to disk during execution
        await writeFile(join(f.materializationsDir, `${request.request_hash}.json`), JSON.stringify(receipt), "utf8");
        return { exitCode: 0, stdout: JSON.stringify(receipt), stderr: "" };
      },
    });

    const op = await adapter.materialize({ attemptKey: "restart-canary-1", request });
    assert.equal(op.status, "succeeded");
    assert.equal(bridgeCalls, 1);

    // Simulate server crash while operation was nonterminal -> reset to outcome_unknown
    f.store.markInterruptedUnknown();
    // Manually force record back to outcome_unknown
    const rawRecord = f.store.getByOperationId(op.operationId)!;
    f.store.finish(op.operationId, {
      status: "outcome_unknown",
      retrySafe: false,
      errorCode: "RECONCILIATION_REQUIRED",
      errorMessage: "Simulated restart crash",
    });

    const uncertain = f.store.getByOperationId(op.operationId)!;
    assert.equal(uncertain.status, "outcome_unknown");

    // Call reconcile: adapter must check manager truth and adopt terminal receipt
    const reconciled = await adapter.reconcile(uncertain);
    assert.equal(reconciled.status, "succeeded");
    assert.equal(bridgeCalls, 1, "reconciliation must not re-execute bridge when manager is already terminal");
  } finally {
    await f.cleanup();
  }
});

test("devspace#262 G3: conflicting request under same attemptKey fails closed before manager execution", async () => {
  const f = await createFixture();
  try {
    let bridgeCalls = 0;
    const adapter = new NexusRecoveryAdapter(f.store, {
      stateRoot: f.managerStateRoot,
      runMaterialize: async () => {
        bridgeCalls++;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });

    const req1 = sampleMaterializationRequest({ request_id: "req-1" });
    req1.request_hash = hashJson({
      request_id: req1.request_id,
      idempotency_fence: req1.idempotency_fence,
      operation: req1.operation,
      effect_class: req1.effect_class,
      recovery_authority_id: req1.recovery_authority_id,
      recovery_authority_hash: req1.recovery_authority_hash,
    });

    const receipt = validMaterializationReceipt(req1);
    await writeFile(join(f.materializationsDir, `${req1.request_hash}.json`), JSON.stringify(receipt), "utf8");

    await adapter.materialize({ attemptKey: "conflict-key-1", request: req1 });

    const req2 = sampleMaterializationRequest({ request_id: "req-2" });
    req2.request_hash = hashJson({
      request_id: req2.request_id,
      idempotency_fence: req2.idempotency_fence,
      operation: req2.operation,
      effect_class: req2.effect_class,
      recovery_authority_id: req2.recovery_authority_id,
      recovery_authority_hash: req2.recovery_authority_hash,
    });

    await assert.rejects(
      adapter.materialize({ attemptKey: "conflict-key-1", request: req2 }),
      (err: unknown) => err instanceof DurableOperationError && err.code === "OPERATION_REPLAY_CONFLICT",
    );
    assert.equal(bridgeCalls, 0, "conflicting request must not reach manager");
  } finally {
    await f.cleanup();
  }
});

test("devspace#262 G3: tampered or corrupt manager receipt fails closed", async () => {
  const f = await createFixture();
  try {
    const request = sampleMaterializationRequest();
    // Write corrupt/tampered receipt
    const receiptPath = join(f.materializationsDir, `${request.request_hash}.json`);
    await writeFile(receiptPath, JSON.stringify({ forged: true, schema: "invalid" }), "utf8");

    const adapter = new NexusRecoveryAdapter(f.store, {
      stateRoot: f.managerStateRoot,
      runMaterialize: async () => ({ exitCode: 1, stdout: "", stderr: "bridge failed" }),
    });

    // Submitting with corrupt manager receipt must not claim success
    const op = await adapter.materialize({ attemptKey: "tamper-key-1", request });
    assert.equal(op.status, "outcome_unknown");
  } finally {
    await f.cleanup();
  }
});

test("devspace#262 G3: unavailable manager persists uncertain outcome and fails closed", async () => {
  const f = await createFixture();
  try {
    const request = sampleRecoveryRequest();
    const adapter = new NexusRecoveryAdapter(f.store, {
      stateRoot: f.managerStateRoot,
      runRecovery: async () => {
        throw new Error("Manager process unavailable: ENOENT");
      },
    });

    const op = await adapter.recover({ attemptKey: "unavailable-key-1", request });
    assert.equal(op.status, "outcome_unknown");
    assert.equal(op.errorCode, "NEXUS_GATEWAY_RECOVERY_UNCERTAIN");
    assert.equal(op.retrySafe, false);
  } finally {
    await f.cleanup();
  }
});

test("devspace#262 G4: end-to-end canary - begin through adapter, reconnect/replace, continue without duplicate effect", async () => {
  const f = await createFixture();
  try {
    const request = sampleMaterializationRequest();
    let bridgeInvocations = 0;

    const receipt = validMaterializationReceipt(request);

    // Step 1: Dev MCP adapter begins operation; manager produces receipt
    const adapter1 = new NexusRecoveryAdapter(f.store, {
      stateRoot: f.managerStateRoot,
      runMaterialize: async (req) => {
        bridgeInvocations++;
        await writeFile(join(f.materializationsDir, `${req.request_hash}.json`), JSON.stringify(receipt), "utf8");
        return { exitCode: 0, stdout: JSON.stringify(receipt), stderr: "" };
      },
    });

    const firstResult = await adapter1.materialize({ attemptKey: "canary-mat-1", request });
    assert.equal(firstResult.status, "succeeded");
    assert.equal(bridgeInvocations, 1);

    // Step 2: Caller replaces / reconnects Dev MCP (simulated fresh process / store)
    const store2 = new DurableOperationStore(join(f.root, "state-replaced"));
    try {
      const adapter2 = new NexusRecoveryAdapter(store2, {
        stateRoot: f.managerStateRoot,
        runMaterialize: async () => {
          bridgeInvocations++;
          throw new Error("Duplicate execution forbidden!");
        },
      });

      // Step 3: Reconnected caller queries / reconciles with exact same identity
      const reconnectedResult = await adapter2.materialize({ attemptKey: "canary-mat-1", request });
      assert.equal(reconnectedResult.status, "succeeded");
      assert.equal(bridgeInvocations, 1, "exactly 1 effect occurred across Dev MCP replacement");
      assert.equal(
        ((reconnectedResult.receipt as Record<string, unknown>).nexusOutcome as Record<string, unknown>).materialization_request_hash,
        request.request_hash,
      );
    } finally {
      store2.close();
    }
  } finally {
    await f.cleanup();
  }
});
