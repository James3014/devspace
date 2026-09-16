import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CdpMacWebDriver,
  MacWebChatCarrierAdapter,
  OpenCliMacWebDriver,
  ChatSwarmRuntimeManager,
  ChatSwarmRuntimeStore,
  loadChatSwarmRuntimeConfig,
  type ChatSwarmManagedCarrierAdapter,
  type ManagedCarrierSlot,
  type ManagedConversationEvidence,
  type RuntimePreflight,
} from "./chat-swarm-runtime.js";
import {
  ensureManagedRuntime,
  wakeManagedDispatchedTask,
} from "./chat-swarm-runtime-delivery.js";
import type {
  CarrierCallInput,
  CarrierEnsureEvidence,
  CarrierWakeEvidence,
} from "./chat-swarm-carrier.js";
import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";
import { ChatSwarmStore } from "./chat-swarm-store.js";

const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex");

class FakeManagedAdapter implements ChatSwarmManagedCarrierAdapter {
  readonly kind = "mac_web_chatgpt";
  readonly configHash = "9".repeat(64);
  provisionCalls = 0;
  bootstrapCalls = 0;
  wakeCalls = 0;
  ensureExistingCalls = 0;
  recoverCalls = 0;
  stopCalls = 0;
  failProvision = false;
  failStop = false;
  recoverReady = true;
  onBootstrap?: (operationId: string, rawIdentity: string) => void;
  readonly rawIdentities = new Map<number, string>();

  capabilities() {
    return {
      boundedWait: "SUPPORTED" as const,
      eventWake: "SUPPORTED" as const,
      resultReadback: "SUPPORTED" as const,
      durableReplay: "SUPPORTED" as const,
    };
  }

  async preflight(): Promise<RuntimePreflight> {
    return {
      ready: true,
      state: "READY",
      controlMechanism: "CDP",
      browserVersion: "fake-browser",
      appBinding: "READY",
    };
  }

  async provision(input: {
    operationId: string;
    swarmId: string;
    runtimeSlot: number;
    projectUrl: string;
    deadlineAt: string;
  }): Promise<ManagedConversationEvidence> {
    this.provisionCalls += 1;
    if (this.failProvision) throw new Error("response lost after possible create");
    const rawIdentity = `managed-conversation-${input.runtimeSlot}`;
    this.rawIdentities.set(input.runtimeSlot, rawIdentity);
    return {
      conversationUrl: `https://chatgpt.com/c/${rawIdentity}`,
      conversationFingerprint: fingerprint(rawIdentity),
      appBinding: "READY",
    };
  }

  async bootstrap(input: {
    operationId: string;
    swarmId: string;
    runtimeSlot: number;
    conversationUrl: string;
    workerLabel: string;
    deadlineAt: string;
  }) {
    this.bootstrapCalls += 1;
    const rawIdentity = this.rawIdentities.get(input.runtimeSlot)!;
    this.onBootstrap?.(input.operationId, rawIdentity);
    return { disposition: "DELIVERED" as const, remoteMayContinue: true };
  }

  async recover(_slot: ManagedCarrierSlot) {
    this.recoverCalls += 1;
    return this.recoverReady
      ? { ready: true }
      : { ready: false, blocker: "carrier_lost" };
  }

  async stop(_slot: ManagedCarrierSlot): Promise<void> {
    this.stopCalls += 1;
    if (this.failStop) throw new Error("close acknowledgement lost");
  }

  async ensureExisting(input: CarrierCallInput): Promise<CarrierEnsureEvidence> {
    this.ensureExistingCalls += 1;
    return {
      disposition: "READY",
      operationId: input.operationId,
      swarmId: input.swarmId,
      workerId: input.workerId,
      expectedEpoch: input.expectedEpoch,
      carrierKind: input.carrierKind,
      carrierFingerprint: input.carrierFingerprint,
      remoteMayContinue: false,
    };
  }

  async wake(input: CarrierCallInput): Promise<CarrierWakeEvidence> {
    this.wakeCalls += 1;
    return {
      disposition: "DELIVERED",
      operationId: input.operationId,
      swarmId: input.swarmId,
      workerId: input.workerId,
      expectedEpoch: input.expectedEpoch,
      taskId: input.taskId,
      attemptId: input.attemptId,
      carrierKind: input.carrierKind,
      carrierFingerprint: input.carrierFingerprint,
      remoteMayContinue: false,
    };
  }
}

function fixture(workerLimit = 5) {
  const root = mkdtempSync(join(tmpdir(), "devspace-runtime-117-"));
  const store = new ChatSwarmStore(root);
  const coordinator = new ChatSwarmCoordinator(store);
  const owner = { "openai/session": "owner-runtime-117" };
  const swarm = coordinator.createSwarm(owner, { workerLimit });
  const registry = new ChatSwarmRuntimeStore(root);
  const adapter = new FakeManagedAdapter();
  const env: NodeJS.ProcessEnv = {
    DEVSPACE_CHAT_SWARM_RUNTIME: "1",
    DEVSPACE_CHAT_SWARM_PROJECT_URL: "https://chatgpt.com/g/g-p-runtime-test/project",
    DEVSPACE_CHAT_SWARM_POOL_DEFAULT: "3",
    DEVSPACE_CHAT_SWARM_RUNTIME_TIMEOUT_MS: "5000",
    DEVSPACE_CHAT_SWARM_BOOTSTRAP_WAIT_MS: "5000",
  };
  const manager = new ChatSwarmRuntimeManager(
    coordinator,
    { stateDir: root, chatSwarmMaxWorkers: workerLimit },
    { env, registry, adapter },
  );
  adapter.onBootstrap = (operationId, rawIdentity) => {
    manager.bootstrap({ "openai/session": rawIdentity }, operationId);
  };
  return { root, store, coordinator, owner, swarm, registry, adapter, manager };
}

function cleanup(f: ReturnType<typeof fixture>) {
  f.manager.close();
  f.store.close();
  rmSync(f.root, { recursive: true, force: true });
}

function cdpDriverForSelectorTest() {
  return new CdpMacWebDriver({
    enabled: true,
    stateDir: "/tmp/devspace-runtime-selector-test",
    maxWorkers: 3,
    poolDefault: 3,
    projectUrl: "https://chatgpt.com/g/g-p-runtime-test/project",
    transport: "cdp",
    openCliExecutable: "opencli",
    cdpEndpoint: "http://[::1]:9222",
    browserProfileDir: "/tmp/devspace-runtime-selector-profile",
    appLabel: "dev",
    operationTimeoutMs: 5_000,
    bootstrapWaitMs: 5_000,
  });
}

test("CDP composer readiness ignores hidden fallback textareas and prefers visible editable composer", async () => {
  const driver = cdpDriverForSelectorTest();
  let expression = "";
  (driver as any).evaluate = async (_target: unknown, candidate: string) => {
    expression = candidate;
    return true;
  };
  await (driver as any).waitForComposer(
    { id: "target-1", url: "https://chatgpt.com/" },
    new Date(Date.now() + 1_000).toISOString(),
  );
  assert.match(expression, /getBoundingClientRect/);
  assert.match(expression, /style\.display !== 'none'/);
  assert.ok(expression.indexOf("[contenteditable=\"true\"]") < expression.indexOf("textarea"));
});

test("CDP prompt delivery targets the visible editable composer before textarea fallback", async () => {
  const driver = cdpDriverForSelectorTest();
  let expression = "";
  (driver as any).evaluate = async (_target: unknown, candidate: string) => {
    expression = candidate;
    return { ok: true };
  };
  await (driver as any).sendPromptToTarget(
    { id: "target-1", url: "https://chatgpt.com/" },
    "probe",
    new Date(Date.now() + 1_000).toISOString(),
  );
  assert.match(expression, /getBoundingClientRect/);
  assert.match(expression, /data-testid="send-button"/);
  assert.ok(expression.indexOf("const editable=") < expression.indexOf("const textarea="));
  assert.match(expression, /const el=editable\|\|textarea/);
});

function openCliDriverForTest() {
  return new OpenCliMacWebDriver({
    enabled: true,
    stateDir: "/tmp/devspace-runtime-opencli-test",
    maxWorkers: 3,
    poolDefault: 3,
    projectUrl: "https://chatgpt.com/g/g-p-runtime-test/project",
    transport: "opencli",
    openCliExecutable: "/opt/homebrew/bin/opencli",
    cdpEndpoint: "http://127.0.0.1:9222",
    browserProfileDir: "/tmp/devspace-runtime-opencli-profile",
    appLabel: "dev",
    operationTimeoutMs: 5_000,
    bootstrapWaitMs: 5_000,
  });
}

test("runtime config selects OpenCLI explicitly while preserving CDP as the default fallback", () => {
  const base = { stateDir: "/tmp/devspace-runtime-config-test", chatSwarmMaxWorkers: 3 };
  const opencli = loadChatSwarmRuntimeConfig(base, {
    DEVSPACE_CHAT_SWARM_TRANSPORT: "opencli",
    DEVSPACE_CHAT_SWARM_OPENCLI_BIN: "/Users/test/.npm-global/bin/opencli",
  });
  assert.equal(opencli.transport, "opencli");
  assert.equal(opencli.openCliExecutable, "/Users/test/.npm-global/bin/opencli");
  assert.equal(opencli.appLabel, "dev");
  const fallback = loadChatSwarmRuntimeConfig(base, {});
  assert.equal(fallback.transport, "cdp");
});

test("OpenCLI provisioning captures transport and authenticated peer identities separately", async () => {
  const driver = openCliDriverForTest();
  const calls: string[][] = [];
  const peerFingerprint = "a".repeat(64);
  (driver as any).runJson = async (args: string[]) => {
    calls.push(args);
    if (args[1] === "detail") {
      const probePrompt = calls.find((call) => call[1] === "ask")?.[2] ?? "";
      return [
        { Role: "User", Text: probePrompt, Generating: false },
        {
          Role: "Assistant",
          Text: `DEVSPACE_PEER_FINGERPRINT=${peerFingerprint}`,
          Generating: false,
        },
      ];
    }
    return [{
      conversationId: "opencli-managed-01",
      conversationUrl: "https://chatgpt.com/g/g-p-runtime-test/c/opencli-managed-01",
      response: "",
    }];
  };
  const evidence = await driver.createManagedConversation(
    "https://chatgpt.com/g/g-p-runtime-test/project",
    new Date(Date.now() + 1_000).toISOString(),
  );
  assert.equal(
    evidence.conversationUrl,
    "https://chatgpt.com/g/g-p-runtime-test/c/opencli-managed-01",
  );
  assert.equal(evidence.conversationFingerprint, fingerprint("opencli-managed-01"));
  assert.equal(evidence.authenticatedPeerFingerprint, peerFingerprint);
  assert.notEqual(evidence.conversationFingerprint, peerFingerprint);
  assert.equal(evidence.appBinding, "READY");
  assert.deepEqual(calls[0]?.slice(0, 2), ["chatgpt", "ask"]);
  assert.match(calls[0]?.[2] ?? "", /^@dev Call chat_swarm_peer_status exactly once/);
  assert.equal(calls[0]?.includes("--project"), true);
  assert.equal(calls[0]?.[calls[0]!.indexOf("--project") + 1], "runtime-test");
  assert.equal(calls[0]?.includes("--new"), true);
  assert.equal(calls[0]?.includes("--wait"), true);
  assert.equal(calls[0]?.[calls[0]!.indexOf("--wait") + 1], "false");
  assert.equal(calls[0]?.[calls[0]!.indexOf("--site-session") + 1], "ephemeral");
  assert.equal(calls[0]?.[calls[0]!.indexOf("--trace") + 1], "retain-on-failure");
});

test("OpenCLI provisioning fails closed when the authenticated peer probe is malformed", async () => {
  const driver = openCliDriverForTest();
  let probePrompt = "";
  (driver as any).runJson = async (args: string[]) => {
    if (args[1] === "detail") {
      return [
        { Role: "User", Text: probePrompt, Generating: false },
        { Role: "Assistant", Text: "DEVSPACE_PEER_FINGERPRINT=not-valid", Generating: false },
      ];
    }
    probePrompt = args[2] ?? "";
    return [{
      conversationId: "opencli-managed-bad-peer",
      conversationUrl: "https://chatgpt.com/g/g-p-runtime-test/c/opencli-managed-bad-peer",
      response: "",
    }];
  };
  await assert.rejects(
    () => driver.createManagedConversation(
      "https://chatgpt.com/g/g-p-runtime-test/project",
      new Date(Date.now() + 1_000).toISOString(),
    ),
    /peer identity probe did not return a valid fingerprint/,
  );
});

test("OpenCLI wake reopens the exact conversation", async () => {
  const driver = openCliDriverForTest();
  const calls: string[][] = [];
  (driver as any).runJson = async (args: string[]) => {
    calls.push(args);
    if (args[1] === "detail") {
      return [
        { Role: "User", Text: "init", Generating: false },
        { Role: "Assistant", Text: "READY_FOR_BOOTSTRAP", Generating: false },
      ];
    }
    return [{
      conversationId: "opencli-managed-02",
      conversationUrl: "https://chatgpt.com/g/g-p-runtime-test/c/opencli-managed-02",
      response: "",
    }];
  };
  const result = await driver.sendPrompt(
    "https://chatgpt.com/g/g-p-runtime-test/c/opencli-managed-02",
    "@devspace wake",
    new Date(Date.now() + 1_000).toISOString(),
  );
  assert.deepEqual(result, { delivered: true, remoteMayContinue: true });
  const ask = calls.find((args) => args[1] === "ask")!;
  assert.equal(ask[ask.indexOf("--conversation") + 1], "opencli-managed-02");
  assert.equal(ask[ask.indexOf("--wait") + 1], "false");
  assert.equal(ask[ask.indexOf("--site-session") + 1], "ephemeral");
  assert.equal(ask[ask.indexOf("--trace") + 1], "retain-on-failure");
});

test("OpenCLI wake fails closed when the returned conversation identity drifts", async () => {
  const driver = openCliDriverForTest();
  (driver as any).runJson = async (args: string[]) => {
    if (args[1] === "detail") {
      return [
        { Role: "User", Text: "init", Generating: false },
        { Role: "Assistant", Text: "READY_FOR_BOOTSTRAP", Generating: false },
      ];
    }
    return [{
      conversationId: "opencli-managed-wrong",
      conversationUrl: "https://chatgpt.com/g/g-p-runtime-test/c/opencli-managed-wrong",
      response: "",
    }];
  };
  const result = await driver.sendPrompt(
    "https://chatgpt.com/g/g-p-runtime-test/c/opencli-managed-02",
    "@devspace wake",
    new Date(Date.now() + 1_000).toISOString(),
  );
  assert.deepEqual(result, {
    delivered: false,
    remoteMayContinue: true,
    blocker: "OPENCLI_CONVERSATION_IDENTITY_DRIFT",
  });
});

test("runtime provision lease spans all bounded provisioning phases", async () => {
  const f = fixture();
  try {
    let observedLeaseMs = 0;
    f.adapter.onBootstrap = (operationId, rawIdentity) => {
      const operation = f.registry.getProvision(operationId);
      assert.ok(operation);
      observedLeaseMs =
        Date.parse(operation.request.expiresAt) -
        Date.parse(operation.request.requestedAt);
      f.manager.bootstrap({ "openai/session": rawIdentity }, operationId);
    };

    const status = await f.manager.ensure(f.owner, f.swarm.id, 1);
    assert.equal(
      observedLeaseMs,
      f.manager.runtimeConfig.operationTimeoutMs * 2 +
        f.manager.runtimeConfig.bootstrapWaitMs,
    );
    assert.equal(status.slots[0]?.state, "PARKED");
  } finally {
    cleanup(f);
  }
});

test("concurrent runtime ensure creates only missing managed workers and exact replay creates no duplicates", async () => {
  const f = fixture();
  try {
    const [first, concurrent] = await Promise.all([
      f.manager.ensure(f.owner, f.swarm.id, 3),
      f.manager.ensure(f.owner, f.swarm.id, 3),
    ]);
    assert.equal(first.slots.length, 3);
    assert.equal(concurrent.slots.length, 3);
    const final = await f.manager.ensure(f.owner, f.swarm.id, 3);
    assert.equal(final.slots.filter((slot) => slot.state === "PARKED").length, 3);
    assert.equal(new Set(final.slots.map((slot) => slot.workerId)).size, 3);
    assert.equal(f.adapter.provisionCalls, 3);
    assert.equal(f.adapter.bootstrapCalls, 3);
    assert.equal(
      f.coordinator.store
        .listWorkers(f.swarm.id)
        .filter((worker) => worker.lifecycleState !== "DISABLED").length,
      3,
    );
  } finally {
    cleanup(f);
  }
});

test("cold ensure reconciles exact existing carriers before declaring the pool healthy", async () => {
  const f = fixture();
  try {
    await f.manager.ensure(f.owner, f.swarm.id, 2);
    assert.equal(f.adapter.ensureExistingCalls, 0);
    const cold = await ensureManagedRuntime(f.manager, f.owner, f.swarm.id, 2);
    assert.equal(cold.slots.filter((slot) => slot.state === "PARKED").length, 2);
    assert.equal(f.adapter.ensureExistingCalls, 2);
    assert.equal(f.adapter.provisionCalls, 2);
    assert.equal(f.adapter.bootstrapCalls, 2);
  } finally {
    cleanup(f);
  }
});

test("managed bootstrap binds the authenticated peer separately from the browser conversation", () => {
  const f = fixture();
  try {
    const slot = f.registry.ensureSlot(
      f.swarm.id,
      1,
      "https://chatgpt.com/g/g-p-runtime-test/project",
      "1".repeat(64),
    );
    const prepared = f.registry.prepareProvision(slot, 5_000);
    assert.ok(prepared.operation);
    assert.equal(f.registry.claimProvision(prepared.operation!.operationId), true);
    const transportFingerprint = fingerprint("exact-managed-conversation");
    const peerFingerprint = fingerprint("authenticated-peer-identity");
    f.registry.markCarrierCreated(prepared.operation!.operationId, {
      conversationUrl: "https://chatgpt.com/c/exact-managed-conversation",
      conversationFingerprint: transportFingerprint,
      authenticatedPeerFingerprint: peerFingerprint,
      appBinding: "READY",
    });
    assert.equal(f.registry.claimBootstrap(prepared.operation!.operationId), true);
    assert.throws(
      () =>
        f.manager.bootstrap(
          { "openai/session": "exact-managed-conversation" },
          prepared.operation!.operationId,
        ),
      /authenticated peer does not match the managed carrier/,
    );
    assert.equal(f.store.listWorkers(f.swarm.id).length, 0);
    assert.equal(f.registry.getSlot(f.swarm.id, 1)?.state, "BOOTSTRAPPING");
    assert.equal(
      f.registry.getProvision(prepared.operation.operationId)?.receipt?.authenticatedPeerFingerprint,
      peerFingerprint,
    );
    const accepted = f.manager.bootstrap(
      { "openai/session": "authenticated-peer-identity" },
      prepared.operation!.operationId,
    );
    assert.equal(accepted.slot.state, "PARKED");
    assert.equal(accepted.slot.conversationFingerprint, transportFingerprint);
    assert.equal(accepted.slot.authenticatedPeerFingerprint, peerFingerprint);
    assert.equal(accepted.worker.carrierConversationFingerprint, peerFingerprint);
    assert.notEqual(
      accepted.worker.carrierConversationFingerprint,
      accepted.slot.conversationFingerprint,
    );
  } finally {
    cleanup(f);
  }
});

for (const sameSwarm of [true, false]) {
  test(`authenticated bootstrap rejects a peer already bound to another slot (${sameSwarm ? "same" : "different"} swarm)`, () => {
    const f = fixture();
    try {
      const otherSwarm = sameSwarm ? f.swarm : f.coordinator.createSwarm(
        { "openai/session": "other-owner" }, { workerLimit: 5 },
      );
      const prepare = (swarmId: string, runtimeSlot: number) => {
        const slot = f.registry.ensureSlot(swarmId, runtimeSlot,
          "https://chatgpt.com/g/g-p-runtime-test/project", "1".repeat(64));
        const { operation } = f.registry.prepareProvision(slot, 5_000);
        assert.ok(operation);
        assert.equal(f.registry.claimProvision(operation.operationId), true);
        const conversation = `conversation-${runtimeSlot}`;
        f.registry.markCarrierCreated(operation.operationId, {
          conversationUrl: `https://chatgpt.com/c/${conversation}`,
          conversationFingerprint: fingerprint(conversation), appBinding: "READY",
        });
        assert.equal(f.registry.claimBootstrap(operation.operationId), true);
        return operation.operationId;
      };
      const firstOperation = prepare(f.swarm.id, 1);
      const secondOperation = prepare(otherSwarm.id, 2);
      const meta = { "openai/session": "shared-authenticated-peer" };
      const first = f.manager.bootstrap(meta, firstOperation);
      assert.throws(() => f.manager.bootstrap(meta, secondOperation), {
        code: "OWNERSHIP_CONFLICT",
        message: "authenticated peer is already managed by another runtime slot",
      });
      assert.equal(f.registry.getSlot(otherSwarm.id, 2)?.workerId, undefined);
      assert.equal(f.registry.getSlot(otherSwarm.id, 2)?.authenticatedPeerFingerprint, undefined);
      assert.equal(f.registry.getProvision(secondOperation)?.status, "bootstrapping");
      assert.deepEqual(f.registry.getSlot(f.swarm.id, 1), first.slot);
      assert.equal(f.store.listWorkers(f.swarm.id).length, 1);
      if (!sameSwarm) assert.equal(f.store.listWorkers(otherSwarm.id).length, 0);
      const replay = f.manager.bootstrap(meta, firstOperation);
      assert.equal(replay.worker.id, first.worker.id);
      assert.throws(() => f.manager.bootstrap(
        { "openai/session": "different-peer-after-binding" }, firstOperation,
      ), /authenticated peer does not match/);
    } finally { cleanup(f); }
  });
}

for (const provisionKnowsPeer of [false, true]) {
  test(`existing worker ensure ${provisionKnowsPeer ? "uses provisioned peer fast path" : "requires actual bootstrap for unknown peer"}`, async (t) => {
    const f = fixture();
    try {
      const peerFingerprint = fingerprint("managed-conversation-1");
      const existing = f.store.joinWorkerAtomic(f.swarm.id, peerFingerprint, {
        swarmId: f.swarm.id, label: "existing-worker", runtimeKind: "mcp_peer",
        carrierConversationFingerprint: peerFingerprint,
      });
      const provision = f.adapter.provision.bind(f.adapter);
      t.mock.method(f.adapter, "provision", async (input: Parameters<typeof provision>[0]) => ({
        ...await provision(input),
        authenticatedPeerFingerprint: provisionKnowsPeer ? peerFingerprint : undefined,
      }));
      const bootstrap = f.adapter.bootstrap.bind(f.adapter);
      t.mock.method(f.adapter, "bootstrap", async (input: Parameters<typeof bootstrap>[0]) => {
        assert.equal(f.registry.getSlot(f.swarm.id, 1)?.authenticatedPeerFingerprint, undefined);
        assert.throws(() => f.registry.bindWorker(input.operationId, existing), /worker does not match managed provision identity/);
        return bootstrap(input);
      });
      const bound = await f.manager.ensure(f.owner, f.swarm.id, 1);
      assert.equal(bound.slots[0]?.state, "PARKED");
      assert.equal(bound.slots[0]?.workerId, existing.id);
      assert.equal(bound.slots[0]?.authenticatedPeerFingerprint, peerFingerprint);
      await f.manager.ensure(f.owner, f.swarm.id, 1);
      assert.equal(f.adapter.bootstrapCalls, provisionKnowsPeer ? 0 : 1);
      assert.equal(f.adapter.provisionCalls, 1);
      assert.equal(f.store.listWorkers(f.swarm.id).length, 1);
    } finally { cleanup(f); }
  });
}

test("targeted dispatch wake is a delivery hint and preserves canonical claimed task truth", async () => {
  const f = fixture();
  try {
    const status = await f.manager.ensure(f.owner, f.swarm.id, 2);
    const workerId = status.slots[0]!.workerId!;
    const task = f.coordinator.dispatch(f.owner, {
      swarmId: f.swarm.id,
      taskKey: "runtime-targeted-wake",
      prompt: "bounded reasoning task",
      preferredWorkerId: workerId,
    });
    assert.equal(task.lifecycleState, "CLAIMED");
    assert.equal(task.assignedWorkerId, workerId);
    await wakeManagedDispatchedTask(f.manager, f.owner, task);
    assert.equal(f.adapter.wakeCalls, 1);
    assert.equal(f.coordinator.store.getTask(task.id)?.lifecycleState, "CLAIMED");
  } finally {
    cleanup(f);
  }
});

test("scale 3 to 5 to 2 retires only safe idle tail workers", async () => {
  const f = fixture();
  try {
    await f.manager.ensure(f.owner, f.swarm.id, 3);
    const five = await f.manager.scale(f.owner, f.swarm.id, 5);
    assert.equal(five.slots.filter((slot) => slot.state !== "STOPPED").length, 5);
    const two = await f.manager.scale(f.owner, f.swarm.id, 2);
    assert.equal(two.slots.filter((slot) => slot.state !== "STOPPED").length, 2);
    assert.equal(f.adapter.provisionCalls, 5);
    assert.equal(f.adapter.stopCalls, 3);
  } finally {
    cleanup(f);
  }
});

test("busy targeted worker is never evicted during scale-down", async () => {
  const f = fixture(3);
  try {
    const status = await f.manager.ensure(f.owner, f.swarm.id, 3);
    const tailWorker = status.slots[2]!.workerId!;
    const task = f.coordinator.dispatch(f.owner, {
      swarmId: f.swarm.id,
      taskKey: "protect-tail",
      prompt: "do not evict",
      preferredWorkerId: tailWorker,
    });
    assert.equal(task.lifecycleState, "CLAIMED");
    assert.equal(task.assignedWorkerId, tailWorker);
    const scaled = await f.manager.scale(f.owner, f.swarm.id, 2);
    assert.equal(f.coordinator.store.getWorker(tailWorker)?.lifecycleState, "BUSY");
    assert.equal(
      scaled.slots.some(
        (slot) => slot.workerId === tailWorker && slot.state !== "STOPPED",
      ),
      true,
    );
    assert.equal(f.adapter.stopCalls, 1);
  } finally {
    cleanup(f);
  }
});

test("stop fences worker authority before browser close and unknown close never retries blindly", async () => {
  const f = fixture();
  try {
    const status = await f.manager.ensure(f.owner, f.swarm.id, 1);
    const workerId = status.slots[0]!.workerId!;
    f.adapter.failStop = true;
    await assert.rejects(
      f.manager.stop(f.owner, f.swarm.id, workerId),
      /outcome is unknown/,
    );
    assert.equal(
      f.coordinator.store.getWorker(workerId)?.lifecycleState,
      "DISABLED",
    );
    assert.equal(f.adapter.stopCalls, 1);
    await assert.rejects(
      f.manager.stop(f.owner, f.swarm.id, workerId),
      /managed worker carrier not found|reconciliation/,
    );
    assert.equal(f.adapter.stopCalls, 1);
  } finally {
    cleanup(f);
  }
});

test("recovery reopens the exact saved conversation and never mints a replacement task attempt", async () => {
  const f = fixture();
  try {
    const status = await f.manager.ensure(f.owner, f.swarm.id, 1);
    const workerId = status.slots[0]!.workerId!;
    const task = f.coordinator.store.createTask({
      swarmId: f.swarm.id,
      taskKey: "no-attempt",
      prompt: "queued",
    }).task;
    assert.equal(f.coordinator.store.listAttempts(task.id).length, 0);
    const recovered = await f.manager.recover(f.owner, f.swarm.id, workerId);
    assert.equal(recovered.slots[0]!.workerId, workerId);
    assert.equal(f.adapter.recoverCalls, 1);
    assert.equal(f.coordinator.store.listAttempts(task.id).length, 0);
  } finally {
    cleanup(f);
  }
});

test("response loss stops the current ensure at the first uncertain carrier and is not reprovisioned", async () => {
  const f = fixture();
  f.adapter.failProvision = true;
  try {
    const first = await f.manager.ensure(f.owner, f.swarm.id, 3);
    assert.equal(first.state, "RECONCILE_REQUIRED");
    assert.equal(first.slots.length, 1);
    assert.equal(first.slots[0]!.state, "RECONCILE_REQUIRED");
    assert.equal(f.adapter.provisionCalls, 1);
    const replay = await f.manager.ensure(f.owner, f.swarm.id, 3);
    assert.equal(replay.slots.length, 1);
    assert.equal(replay.slots[0]!.state, "RECONCILE_REQUIRED");
    assert.equal(f.adapter.provisionCalls, 1);
  } finally {
    cleanup(f);
  }
});

test("managed registry survives reopen without duplicating logical workers", async () => {
  const f = fixture();
  try {
    const first = await f.manager.ensure(f.owner, f.swarm.id, 2);
    const ids = first.slots.map((slot) => slot.workerId);
    f.registry.close();
    const reopened = new ChatSwarmRuntimeStore(f.root);
    const slots = reopened.listSlots(f.swarm.id);
    assert.deepEqual(slots.map((slot) => slot.workerId), ids);
    assert.equal(slots.every((slot) => slot.state === "PARKED"), true);
    reopened.close();
  } finally {
    cleanup(f);
  }
});

test("CDP existing-session requires explicit mode and absolute profile; unset mode preserves managed config", () => {
  const base = { stateDir: "/tmp/devspace-runtime-config-test", chatSwarmMaxWorkers: 3 };
  const config = loadChatSwarmRuntimeConfig(base, {});
  assert.equal(config.cdpMode, "managed");
  assert.equal(config.appLabel, "dev");
  for (const env of [
    { DEVSPACE_CHAT_SWARM_CDP_MODE: "auto" },
    { DEVSPACE_CHAT_SWARM_CDP_MODE: "existing-session" },
    { DEVSPACE_CHAT_SWARM_CDP_MODE: "existing-session", DEVSPACE_CHAT_SWARM_BROWSER_PROFILE_DIR: "relative" },
    { DEVSPACE_CHAT_SWARM_CDP_MODE: "existing-session", DEVSPACE_CHAT_SWARM_BROWSER_PROFILE_DIR: "/explicit", DEVSPACE_CHAT_SWARM_BROWSER_BIN: "/chrome" },
    { DEVSPACE_CHAT_SWARM_CDP_MODE: "existing-session", DEVSPACE_CHAT_SWARM_BROWSER_PROFILE_DIR: "/explicit", DEVSPACE_CHAT_SWARM_CDP_ENDPOINT: "http://127.0.0.1:9222" },
  ]) assert.throws(() => loadChatSwarmRuntimeConfig(base, env));
  assert.equal(loadChatSwarmRuntimeConfig(base, { DEVSPACE_CHAT_SWARM_CDP_MODE: "managed" }).cdpMode, "managed");
  const legacy = loadChatSwarmRuntimeConfig(base, {
    DEVSPACE_CHAT_SWARM_CDP_ENDPOINT: "http://127.0.0.1:9333",
    DEVSPACE_CHAT_SWARM_BROWSER_BIN: "/explicit/chrome",
    DEVSPACE_CHAT_SWARM_BROWSER_PROFILE_DIR: "/explicit/managed-profile",
  });
  assert.equal(legacy.cdpMode, "managed");
  assert.equal(legacy.cdpEndpoint, "http://127.0.0.1:9333");
  assert.equal(legacy.browserExecutable, "/explicit/chrome");
  assert.equal(legacy.browserProfileDir, "/explicit/managed-profile");
});

function existingCdpFixture(t: test.TestContext, metadata = "43123\n/devtools/browser/browser-one\n") {
  const root = mkdtempSync(join(tmpdir(), "devspace-existing-cdp-"));
  if (metadata) writeFileSync(join(root, "DevToolsActivePort"), metadata);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = loadChatSwarmRuntimeConfig({ stateDir: root, chatSwarmMaxWorkers: 3 }, {
    DEVSPACE_CHAT_SWARM_CDP_MODE: "existing-session",
    DEVSPACE_CHAT_SWARM_BROWSER_PROFILE_DIR: root,
    DEVSPACE_CHAT_SWARM_PROJECT_URL: "https://chatgpt.com/g/g-p-test/project",
    DEVSPACE_CHAT_SWARM_RUNTIME_TIMEOUT_MS: "1000",
  });
  const calls: Array<{ method: string; params: any; sessionId?: string }> = [];
  const sockets: FakeSocket[] = [];
  const targets = new Map([["target-a", "https://chatgpt.com/c/worker-a"], ["target-b", "https://chatgpt.com/c/worker-b"]]);
  const sessions = new Map<string, string>();
  let disconnectOn = "";
  let domState = "ready";
  let denyConnection = false;
  let wrongSession = false;
  let driftBeforeSend = false;
  let disconnectAfterSend = false;
  class FakeSocket {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    onclose?: () => void;
    closed = false;
    constructor(readonly url: string) { sockets.push(this); queueMicrotask(() => denyConnection ? this.onclose?.() : this.onopen?.()); }
    close() { this.closed = true; queueMicrotask(() => this.onclose?.()); }
    send(data: string) {
      const command = JSON.parse(data);
      calls.push(command);
      if (command.method === disconnectOn) { this.close(); return; }
      let result: any = {};
      switch (command.method) {
        case "Browser.getVersion": result = { product: "Chrome/fake" }; break;
        case "Target.getTargets": result = { targetInfos: [...targets].map(([targetId,url]) => ({ targetId, url, type: "page" })) }; break;
        case "Target.createTarget": {
          const targetId = `reopened-${targets.size}`;
          targets.set(targetId, command.params.url);
          result = { targetId }; break;
        }
        case "Target.attachToTarget": {
          assert.equal(command.params.flatten, true);
          const sessionId = `session-${sessions.size}`;
          sessions.set(sessionId, command.params.targetId);
          result = { sessionId }; break;
        }
        case "Target.closeTarget": targets.delete(command.params.targetId); result = { success: true }; break;
        case "Runtime.evaluate": {
          const url = targets.get(sessions.get(command.sessionId)!);
          assert.ok(url, "evaluation must be attached to one live target");
          const expression: string = command.params.expression;
          let value: any = true;
          if (expression === "location.href") value = url;
          else if (expression.includes("const prompt=")) {
            if (disconnectAfterSend) { this.close(); return; }
            if (driftBeforeSend) {
              targets.set(sessions.get(command.sessionId)!, "https://chatgpt.com/c/unrelated");
              // Execute the actual guard, before any DOM write could happen.
              value = new Function("location", expression.replace("(() =>", "return (() =>"))({ href: "https://chatgpt.com/c/unrelated" });
            } else value = { ok: true };
          }
          else if (expression.includes("const label=")) {
            const text = domState === "unknown" ? "ChatGPT" : `dev ${domState}`;
            value = new Function("document", `return ${expression}`)({ body: { innerText: text } });
          }
          else value = domState === "signed-out" ? "SIGNED_OUT" : true;
          result = { result: { value } }; break;
        }
        default: assert.fail(`unexpected CDP command ${command.method}`);
      }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: command.id, sessionId: wrongSession && command.sessionId ? "foreign-session" : command.sessionId, result }) }));
    }
  }
  t.mock.method(globalThis, "WebSocket", function (url: string) { return new FakeSocket(url); } as any);
  t.mock.method(globalThis, "fetch", async () => { assert.fail("existing-session must use the metadata browser websocket, never HTTP/default port"); });
  return {
    root, config, calls, sockets, targets, sessions,
    driver: new CdpMacWebDriver(config),
    deadline: () => new Date(Date.now() + 1500).toISOString(),
    disconnect: (method: string) => { disconnectOn = method; },
    dom: (state: string) => { domState = state; },
    deny: () => { denyConnection = true; },
    spoofSession: () => { wrongSession = true; },
    drift: () => { driftBeforeSend = true; },
    loseSendAck: () => { disconnectAfterSend = true; },
  };
}

test("carrier effects never use conversation identity as missing peer authority", async (t) => {
  const f = existingCdpFixture(t);
  const conversationUrl = "https://chatgpt.com/c/worker-a";
  const conversationFingerprint = fingerprint("worker-a");
  const slot: ManagedCarrierSlot = {
    managedCarrierId: "legacy-conversation-only",
    swarmId: "swarm",
    runtimeSlot: 1,
    generation: 1,
    state: "PARKED",
    projectUrl: f.config.projectUrl!,
    browserProfileId: "1".repeat(64),
    workerId: "worker",
    conversationUrl,
    conversationFingerprint,
    continuationEpoch: 0,
    lastOperationId: "legacy-operation",
    updatedAt: new Date().toISOString(),
  };
  const registry = {
    getSlotByWorker: (swarmId: string, workerId: string) =>
      swarmId === slot.swarmId && workerId === slot.workerId ? slot : undefined,
  } as unknown as ChatSwarmRuntimeStore;
  const adapter = new MacWebChatCarrierAdapter(f.config, registry, f.driver);
  const input: CarrierCallInput = {
    operationId: "carrier-operation",
    operationKey: "carrier-operation-key",
    swarmId: slot.swarmId,
    workerId: slot.workerId!,
    carrierKind: "mcp_peer",
    carrierFingerprint: conversationFingerprint,
    expectedEpoch: 0,
    adapterConfigHash: adapter.configHash,
    signal: new AbortController().signal,
    deadlineAt: f.deadline(),
  };
  const ensured = await adapter.ensureExisting(input);
  assert.equal(ensured.disposition, "UNSUPPORTED");
  assert.equal(ensured.remoteMayContinue, false);
  const woke = await adapter.wake({ ...input, taskId: "task" });
  assert.equal(woke.disposition, "UNSUPPORTED");
  assert.equal(woke.remoteMayContinue, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sockets.length, 0);
});

const macOsOnlyTest = process.platform === "darwin" ? test : test.skip;

macOsOnlyTest("existing-session missing or malformed metadata fails closed before connection", async (t) => {
  const f = existingCdpFixture(t, "");
  let result = await f.driver.preflight();
  assert.match(result.blocker!, /BROWSER_CONTROL_UNAVAILABLE:DEVTOOLS_ACTIVE_PORT_UNAVAILABLE/);
  for (const invalid of ["", "0\n/devtools/browser/id", "65536\n/devtools/browser/id", "1e3\n/devtools/browser/id", "9222junk\n/devtools/browser/id", "9222", "9222\nws://evil/", "9222\n//evil", "9222\n/devtools/browser/id?redirect=1", "9222\n/devtools/browser/../id", "9222\n/devtools/browser/id\nextra", "x".repeat(2048)]) {
    writeFileSync(join(f.root, "DevToolsActivePort"), invalid);
    result = await f.driver.preflight();
    assert.equal(result.ready, false);
    assert.match(result.blocker!, /BROWSER_CONTROL_UNAVAILABLE:DEVTOOLS_ACTIVE_PORT_MALFORMED/);
  }
  // Even an incorrectly assembled internal config cannot launch Chrome in this mode.
  const unsafe = new CdpMacWebDriver({ ...f.config, browserExecutable: "/must-not-spawn" });
  await assert.rejects(unsafe.createManagedConversation(f.config.projectUrl!, f.deadline()), /BROWSER_CONTROL_UNAVAILABLE/);
  assert.equal(f.sockets.length, 0);
  assert.equal(f.calls.length, 0);
});

macOsOnlyTest("existing-session resolves dynamic browser endpoint anew and closes each bounded connection", async (t) => {
  const f = existingCdpFixture(t);
  assert.equal((await f.driver.preflight()).ready, true);
  writeFileSync(join(f.root, "DevToolsActivePort"), "45234\r\n/devtools/browser/browser-two\r\n");
  assert.equal((await f.driver.preflight()).ready, true);
  assert.deepEqual(f.sockets.map(s => s.url), ["ws://127.0.0.1:43123/devtools/browser/browser-one", "ws://127.0.0.1:45234/devtools/browser/browser-two"]);
  assert.ok(f.sockets.every(s => s.closed));
  assert.deepEqual(f.calls.map(c => c.method), ["Browser.getVersion", "Browser.getVersion"]);
});

macOsOnlyTest("existing-session isolates exact targets, reopens lost conversations, and closes only the requested target", async (t) => {
  const f = existingCdpFixture(t);
  const url = "https://chatgpt.com/c/worker-a";
  assert.equal((await f.driver.sendPrompt(url, "wake a", f.deadline())).delivered, true);
  assert.deepEqual(f.calls.filter(c => c.method === "Target.attachToTarget").map(c => c.params.targetId), ["target-a"]);
  f.targets.set("target-a", "https://chatgpt.com/c/someone-else");
  const recovered = await f.driver.recoverConversation(url, f.deadline());
  assert.equal(recovered.ready, true);
  assert.deepEqual(f.calls.filter(c => c.method === "Target.createTarget").map(c => c.params.url), [url]);
  assert.equal(f.targets.get("target-b"), "https://chatgpt.com/c/worker-b");
  assert.equal(f.targets.get("target-a"), "https://chatgpt.com/c/someone-else");
  await f.driver.closeConversation(url);
  assert.equal(f.targets.size, 2);
  assert.equal(f.calls.filter(c => c.method === "Target.closeTarget").length, 1);
  assert.ok(f.sockets.every(s => s.closed));
});

macOsOnlyTest("existing-session disconnect before acknowledgement never retries a prompt or switches transport", async (t) => {
  const f = existingCdpFixture(t);
  f.disconnect("Runtime.evaluate");
  const result = await f.driver.sendPrompt("https://chatgpt.com/c/worker-a", "wake", f.deadline());
  assert.equal(result.delivered, false);
  assert.match(result.blocker!, /BROWSER_CONTROL_UNAVAILABLE/);
  assert.equal(f.calls.filter(c => c.method === "Runtime.evaluate").length, 1);
  assert.equal(f.calls.filter(c => c.method === "Target.createTarget").length, 0);
  assert.equal(f.sockets.length, 1);
  assert.equal(result.remoteMayContinue, true);
});

macOsOnlyTest("existing-session keeps signed-out and app binding blockers separate from control availability", async (t) => {
  const f = existingCdpFixture(t);
  f.dom("signed-out");
  assert.match((await f.driver.recoverConversation("https://chatgpt.com/c/worker-a", f.deadline())).blocker!, /CHATGPT_SIGNED_OUT/);
  f.dom("disabled");
  assert.equal((await f.driver.sendPrompt("https://chatgpt.com/c/worker-a", "wake", f.deadline())).blocker, "HOST_APP_BINDING_NOT_READY:DISABLED");
});


macOsOnlyTest("existing-session socket close cannot distinguish authorization denial from transport failure", async (t) => {
  const f = existingCdpFixture(t);
  f.deny();
  const result = await f.driver.preflight();
  assert.equal(result.ready, false);
  assert.equal(result.appBinding, "UNKNOWN");
  assert.match(result.blocker!, /BROWSER_CONTROL_UNAVAILABLE:AUTHORIZATION_OR_CONNECTION_CLOSED/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sockets.length, 1);
  assert.ok(f.sockets.every(s => s.closed));
});

macOsOnlyTest("existing-session prompt acknowledgement loss remains unknown and is not blindly resent", async (t) => {
  const f = existingCdpFixture(t);
  f.loseSendAck();
  const result = await f.driver.sendPrompt("https://chatgpt.com/c/worker-a", "wake", f.deadline());
  assert.equal(result.delivered, false);
  assert.equal(result.remoteMayContinue, true);
  assert.match(result.blocker!, /BROWSER_CONTROL_UNAVAILABLE:DISCONNECTED/);
  assert.equal(f.calls.filter(c => c.method === "Runtime.evaluate" && c.params.expression.includes("const prompt=")).length, 1);
  assert.equal(f.calls.filter(c => c.method === "Target.createTarget").length, 0);
  assert.equal(f.sockets.length, 1);
});

macOsOnlyTest("existing-session rejects cross-session responses", async (t) => {
  const f = existingCdpFixture(t);
  f.spoofSession();
  const spoofed = await f.driver.recoverConversation("https://chatgpt.com/c/worker-a", f.deadline());
  assert.equal(spoofed.ready, false);
  assert.match(spoofed.blocker!, /SESSION_IDENTITY_MISMATCH/);
});

macOsOnlyTest("existing-session checks the exact URL inside the prompt mutation", async (t) => {
  const f = existingCdpFixture(t);
  f.drift();
  const drifted = await f.driver.sendPrompt("https://chatgpt.com/c/worker-a", "wake", f.deadline());
  assert.equal(drifted.delivered, false);
  assert.match(drifted.blocker!, /CHATGPT_CONVERSATION_IDENTITY_DRIFT/);
  assert.equal(f.targets.get("target-b"), "https://chatgpt.com/c/worker-b");
});

macOsOnlyTest("existing-session recovery after target deletion reopens only the saved conversation", async (t) => {
  const f = existingCdpFixture(t);
  f.targets.delete("target-a");
  const url = "https://chatgpt.com/c/worker-a";
  assert.equal((await f.driver.recoverConversation(url, f.deadline())).ready, true);
  assert.deepEqual(f.calls.filter(c => c.method === "Target.createTarget").map(c => c.params.url), [url]);
  assert.equal(f.calls.filter(c => c.method === "Runtime.evaluate" && c.params.expression.includes("const prompt=")).length, 0);
  assert.equal(f.targets.get("target-b"), "https://chatgpt.com/c/worker-b");
});

macOsOnlyTest("explicit and legacy managed CDP retain the direct endpoint path", async (t) => {
  const config = loadChatSwarmRuntimeConfig({ stateDir: "/tmp/devspace-managed", chatSwarmMaxWorkers: 3 }, {
    DEVSPACE_CHAT_SWARM_CDP_MODE: "managed",
    DEVSPACE_CHAT_SWARM_CDP_ENDPOINT: "http://127.0.0.1:9333",
    DEVSPACE_CHAT_SWARM_PROJECT_URL: "https://chatgpt.com/g/g-p-test/project",
  });
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ Browser: "Chrome/managed" }));
  });
  for (const cdpMode of ["managed", undefined] as const) {
    assert.equal((await new CdpMacWebDriver({ ...config, cdpMode }).preflight()).ready, true);
  }
  assert.deepEqual(calls, ["http://127.0.0.1:9333/json/version", "http://127.0.0.1:9333/json/version"]);
});


test("unset CDP mode retains managed browserExecutable startup without launching a real browser", async (t) => {
  const calls: Array<{ executable: string; args: string[]; options: unknown }> = [];
  let unrefs = 0;
  t.mock.method(childProcess, "spawn", ((executable: string, args: string[], options: unknown) => {
    calls.push({ executable, args, options });
    return { unref: () => { unrefs += 1; } };
  }) as any);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const config = loadChatSwarmRuntimeConfig({ stateDir: "/tmp/devspace-managed", chatSwarmMaxWorkers: 3 }, {
    DEVSPACE_CHAT_SWARM_CDP_ENDPOINT: "http://127.0.0.1:9333",
    DEVSPACE_CHAT_SWARM_BROWSER_BIN: "/explicit/chrome",
    DEVSPACE_CHAT_SWARM_BROWSER_PROFILE_DIR: "/explicit/managed-profile",
    DEVSPACE_CHAT_SWARM_PROJECT_URL: "https://chatgpt.com/g/g-p-test/project",
  });
  for (const cdpMode of [config.cdpMode, undefined]) {
    const driver = new CdpMacWebDriver({ ...config, cdpMode });
    let probes = 0;
    t.mock.method(driver, "preflight", async () => ({
      ready: ++probes > 1, state: "CONFIGURED_NOT_READY", controlMechanism: "CDP", appBinding: "UNKNOWN",
    } as RuntimePreflight));
    await (driver as any).ensureRuntime(new Date(Date.now() + 1500).toISOString());
    assert.equal(probes, 2);
  }
  assert.equal(unrefs, 2);
  assert.deepEqual(calls, [0, 1].map(() => ({
    executable: "/explicit/chrome",
    args: ["--remote-debugging-port=9333", "--user-data-dir=/explicit/managed-profile", "--no-first-run", "--no-default-browser-check", config.projectUrl!],
    options: { detached: true, stdio: "ignore" },
  })));
});

macOsOnlyTest("existing-session missing explicit setup is authorization-required, never inferred from missing metadata", async (t) => {
  const f = existingCdpFixture(t, "");
  for (const browserProfileDir of ["", "relative"] ) {
    assert.throws(() => loadChatSwarmRuntimeConfig({ stateDir: f.root, chatSwarmMaxWorkers: 3 }, {
      DEVSPACE_CHAT_SWARM_CDP_MODE: "existing-session",
      DEVSPACE_CHAT_SWARM_BROWSER_PROFILE_DIR: browserProfileDir,
    }), /BROWSER_AUTHORIZATION_REQUIRED:EXPLICIT_USER_DATA_DIR_REQUIRED/);
    const driver = new CdpMacWebDriver({ ...f.config, browserProfileDir });
    const result = await driver.preflight();
    assert.equal(result.ready, false);
    assert.equal(result.state, "SETUP_REQUIRED");
    assert.equal(result.blocker, "BROWSER_AUTHORIZATION_REQUIRED:EXPLICIT_USER_DATA_DIR_REQUIRED");
    await assert.rejects(driver.createManagedConversation(f.config.projectUrl!, f.deadline()), /BROWSER_AUTHORIZATION_REQUIRED/);
  }
  const unavailable = await f.driver.preflight();
  assert.equal(unavailable.state, "CONFIGURED_NOT_READY");
  assert.equal(unavailable.blocker, "BROWSER_CONTROL_UNAVAILABLE:DEVTOOLS_ACTIVE_PORT_UNAVAILABLE");
  assert.equal(f.sockets.length, 0);
  assert.equal(f.calls.length, 0);
});

macOsOnlyTest("existing-session browser readiness surfaces unknown app binding without blocking bootstrap delivery", async (t) => {
  const f = existingCdpFixture(t);
  f.dom("unknown");
  const preflight = await f.driver.preflight();
  assert.equal(preflight.ready, true);
  assert.equal(preflight.appBinding, "UNKNOWN");
  assert.equal(preflight.blocker, "HOST_APP_BINDING_NOT_READY:UNKNOWN");
  const url = "https://chatgpt.com/c/worker-a";
  assert.deepEqual(await f.driver.sendPrompt(url, "bootstrap", f.deadline()), {
    delivered: true, remoteMayContinue: true, blocker: "HOST_APP_BINDING_NOT_READY:UNKNOWN",
  });
  assert.deepEqual(await f.driver.recoverConversation(url, f.deadline()), {
    ready: true, blocker: "HOST_APP_BINDING_NOT_READY:UNKNOWN",
  });
  assert.equal(f.calls.filter(c => c.method === "Runtime.evaluate" && c.params.expression.includes("const prompt=")).length, 1);
  assert.ok(f.calls.filter(c => c.method === "Target.attachToTarget").every(c => c.params.targetId === "target-a"));
  assert.equal(f.targets.get("target-b"), "https://chatgpt.com/c/worker-b");
});

for (const binding of ["DISABLED", "STALE"] as const) {
  macOsOnlyTest(`existing-session ${binding} app binding blocks send and recovery with explicit NOT_READY`, async (t) => {
    const f = existingCdpFixture(t);
    f.dom(binding.toLowerCase());
    const url = "https://chatgpt.com/c/worker-a";
    assert.deepEqual(await f.driver.sendPrompt(url, "wake", f.deadline()), {
      delivered: false, remoteMayContinue: false, blocker: `HOST_APP_BINDING_NOT_READY:${binding}`,
    });
    assert.deepEqual(await f.driver.recoverConversation(url, f.deadline()), {
      ready: false, blocker: `HOST_APP_BINDING_NOT_READY:${binding}`,
    });
    const registry = new ChatSwarmRuntimeStore(f.root);
    try {
      const adapter = new MacWebChatCarrierAdapter(f.config, registry, f.driver);
      const bootstrap = await adapter.bootstrap({ operationId: "operation", swarmId: "swarm", runtimeSlot: 1,
        conversationUrl: url, workerLabel: "worker", deadlineAt: f.deadline() });
      assert.equal(bootstrap.disposition, "SETUP_REQUIRED");
      assert.equal(bootstrap.remoteMayContinue, false);
      assert.equal(bootstrap.blocker, `HOST_APP_BINDING_NOT_READY:${binding}`);
    } finally { registry.close(); }
    assert.equal(f.calls.filter(c => c.method === "Runtime.evaluate" && c.params.expression.includes("const prompt=")).length, 0);
  });
}

test("runtime status surfaces binding uncertainty and authenticated bootstrap can resolve the slot", async (t) => {
  const f = fixture();
  try {
    const peerFingerprint = fingerprint("actual-bootstrap-peer");
    f.adapter.onBootstrap = (operationId) => {
      assert.equal(f.registry.getProvision(operationId)?.receipt?.authenticatedPeerFingerprint, undefined);
      assert.throws(() => f.manager.bootstrap({}, operationId), /identity evidence/);
      f.manager.bootstrap({ "openai/session": "actual-bootstrap-peer" }, operationId);
    };
    t.mock.method(f.adapter, "preflight", async () => ({
      ready: true, state: "READY", controlMechanism: "CDP", appBinding: "UNKNOWN",
    } as RuntimePreflight));
    const provision = f.adapter.provision.bind(f.adapter);
    t.mock.method(f.adapter, "provision", async (input: Parameters<typeof provision>[0]) => ({
      ...await provision(input), appBinding: "UNKNOWN" as const,
    }));
    const bootstrap = f.adapter.bootstrap.bind(f.adapter);
    t.mock.method(f.adapter, "bootstrap", async (input: Parameters<typeof bootstrap>[0]) => {
      const pending = await f.manager.status(f.owner, f.swarm.id);
      assert.equal(pending.state, "DEGRADED");
      assert.equal(pending.slots[0]?.blocker, "HOST_APP_BINDING_NOT_READY:UNKNOWN");
      assert.equal(pending.slots[0]?.workerId, undefined);
      return bootstrap(input);
    });
    const initial = await f.manager.status(f.owner, f.swarm.id);
    assert.equal(initial.adapter.blocker, "HOST_APP_BINDING_NOT_READY:UNKNOWN");
    assert.equal(initial.slots.length, 0);
    const bound = await f.manager.ensure(f.owner, f.swarm.id, 1);
    assert.equal(bound.state, "READY");
    assert.equal(bound.slots[0]?.state, "PARKED");
    assert.equal(bound.slots[0]?.blocker, undefined);
    assert.equal(bound.slots[0]?.authenticatedPeerFingerprint, peerFingerprint);
    assert.notEqual(bound.slots[0]?.conversationFingerprint, peerFingerprint);
    const persisted = new ChatSwarmRuntimeStore(f.root);
    try {
      assert.deepEqual(persisted.getSlot(f.swarm.id, 1), bound.slots[0]);
      assert.equal(persisted.getProvision(bound.slots[0]!.lastOperationId!)?.receipt?.authenticatedPeerFingerprint,
        peerFingerprint);
    } finally { persisted.close(); }
    await f.manager.ensure(f.owner, f.swarm.id, 1);
    assert.equal(f.adapter.provisionCalls, 1);
    assert.equal(f.adapter.bootstrapCalls, 1);
    assert.equal(f.store.listWorkers(f.swarm.id).length, 1);
  } finally { cleanup(f); }
});

for (const binding of ["DISABLED", "STALE"] as const) {
  test(`runtime retains ${binding} binding reason in durable status without bootstrap or reprovision`, async (t) => {
    const f = fixture();
    try {
      const provision = f.adapter.provision.bind(f.adapter);
      t.mock.method(f.adapter, "provision", async (input: Parameters<typeof provision>[0]) => ({
        ...await provision(input), appBinding: binding,
      }));
      const status = await f.manager.ensure(f.owner, f.swarm.id, 1);
      assert.equal(status.slots[0]?.state, "SETUP_REQUIRED");
      assert.equal(status.slots[0]?.blocker, `HOST_APP_BINDING_NOT_READY:${binding}`);
      await f.manager.ensure(f.owner, f.swarm.id, 1);
      assert.equal(f.adapter.bootstrapCalls, 0);
      assert.equal(f.adapter.provisionCalls, 1);
    } finally { cleanup(f); }
  });
}

test("binding disabled after creation survives bootstrap mapping and remains reconcile-required without resend", async (t) => {
  const f = fixture();
  try {
    t.mock.method(f.adapter, "bootstrap", async () => {
      f.adapter.bootstrapCalls += 1;
      return { disposition: "SETUP_REQUIRED", remoteMayContinue: false,
        blocker: "HOST_APP_BINDING_NOT_READY:DISABLED" } as any;
    });
    const status = await f.manager.ensure(f.owner, f.swarm.id, 1);
    assert.equal(status.state, "RECONCILE_REQUIRED");
    assert.equal(status.slots[0]?.blocker, "HOST_APP_BINDING_NOT_READY:DISABLED");
    await f.manager.ensure(f.owner, f.swarm.id, 1);
    assert.equal(f.adapter.bootstrapCalls, 1);
    assert.equal(f.adapter.provisionCalls, 1);
  } finally { cleanup(f); }
});

test("missing authenticated peer acknowledgement is unresolved and never grants bootstrap retry", async () => {
  const f = fixture();
  try {
    f.adapter.onBootstrap = undefined;
    f.manager.runtimeConfig.bootstrapWaitMs = 1;
    const status = await f.manager.ensure(f.owner, f.swarm.id, 1);
    assert.equal(status.state, "RECONCILE_REQUIRED");
    assert.match(status.slots[0]!.blocker!, /^PEER_IDENTITY_UNRESOLVED:/);
    await f.manager.ensure(f.owner, f.swarm.id, 1);
    assert.equal(f.adapter.bootstrapCalls, 1);
    assert.equal(f.adapter.provisionCalls, 1);
    assert.equal(status.slots[0]?.workerId, undefined);
  } finally { cleanup(f); }
});
