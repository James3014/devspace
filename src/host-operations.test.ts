import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableOperationStore } from "./durable-operations.js";
import { HostOperationRegistrar, type HostOperationReceipt } from "./host-operations.js";
import type { BoundHostOperation, HostOperationPolicy, HostOperationRequest } from "./host-operation-policy.js";

const executable = process.execPath;
const fixtureSource = `import { appendFileSync } from "node:fs";
const [mode, marker] = process.argv.slice(2);
if (mode === "write" || mode === "short") appendFileSync(marker, "x\\n");
if (mode === "short") process.exit(0);
if (mode === "ignore-term") process.on("SIGTERM", () => {});
if (mode === "activity") setInterval(() => process.stdout.write("tick"), 20);
else setInterval(() => {}, 20);
setTimeout(() => process.exit(0), 8_000);
`;

const macOnly = { skip: process.platform !== "darwin" ? "Host process identity contract is macOS-specific." : false };

type Harness = { root: string; marker: string; store: DurableOperationStore; registrar: HostOperationRegistrar; request: Omit<HostOperationRequest, "clientId">; dispose: () => Promise<void> };

async function harness(mode: string, limits: Partial<Pick<HostOperationPolicy, "maxWallMs" | "maxIdleMs" | "allowLongLivedProcess">> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "devspace-host-operation-unit-"));
  const script = join(root, "fixture.mjs");
  const marker = join(root, "marker.txt");
  await writeFile(script, fixtureSource);
  const hash = createHash("sha256").update(await readFile(executable)).digest("hex");
  const store = new DurableOperationStore(root);
  const policy: HostOperationPolicy = { enabled: true, ownerClientId: "owner-client", executablePath: executable, executableSha256: hash, argv: [script, mode, marker], cwd: root, allowedPaths: { write: [root], read: [script] }, maxWallMs: 1_000, maxIdleMs: 1_000, allowLongLivedProcess: true, ...limits };
  const prepare = async (bound: BoundHostOperation) => ({ argv: [bound.request.executablePath, ...bound.request.argv], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  const registrar = new HostOperationRegistrar(store, policy, prepare);
  const request = { attemptKey: `${mode}-attempt`, executablePath: executable, argv: [script, mode, marker], cwd: root, allowedPaths: { write: [root], read: [script] }, maxWallMs: policy.maxWallMs, maxIdleMs: policy.maxIdleMs, allowLongLivedProcess: policy.allowLongLivedProcess };
  return { root, marker, store, registrar, request, dispose: async () => { await registrar.dispose(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

async function waitForStatus(registrar: HostOperationRegistrar, operationId: string, expected: string, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = registrar.status(operationId, "owner-client");
    if (current.status === expected) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return registrar.status(operationId, "owner-client");
}

async function assertDead(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) { try { process.kill(pid, 0); } catch { return; } await new Promise((resolve) => setTimeout(resolve, 25)); }
  assert.fail(`fixture process ${pid} remained alive`);
}

test("host operation records exact Node identity and cancels a running child", macOnly, async () => {
  const h = await harness("write");
  try {
    const result = await h.registrar.start(h.request, "owner-client");
    assert.equal(result.status, "started");
    const receipt = result.receipt as unknown as HostOperationReceipt;
    assert.equal(receipt.outcome, "running");
    assert.equal(receipt.executable, executable);
    assert.equal(typeof receipt.process?.pid, "number");
    assert.equal(receipt.process?.processGroup, receipt.process?.pid);
    assert.match(receipt.process?.command ?? "", /fixture\.mjs/);
    assert.match(receipt.process?.argvFingerprint ?? "", /^[a-f0-9]{64}$/);
    const cancelled = await h.registrar.cancel(result.operationId, "owner-client");
    assert.equal(cancelled.status, "failed");
    assert.equal(cancelled.errorCode, "CANCELLED");
    await assertDead(receipt.process!.pid);
  } finally { await h.dispose(); }
});

test("host operation kills a TERM-resistant child at its deadline and reports failure", macOnly, async () => {
  const h = await harness("ignore-term", { maxWallMs: 250, maxIdleMs: 250 });
  try { const started = await h.registrar.start(h.request, "owner-client"); assert.equal(started.status, "started"); const finished = await waitForStatus(h.registrar, started.operationId, "failed"); assert.equal(finished.status, "failed"); assert.equal(finished.errorCode, "TIMEOUT"); assert.notEqual(finished.receipt?.outcome, "succeeded"); } finally { await h.dispose(); }
});

test("host operation enforces absolute wall time despite continuous stdout activity", macOnly, async () => {
  const h = await harness("activity", { maxWallMs: 300, maxIdleMs: 80 });
  try { const startedAt = Date.now(); const started = await h.registrar.start(h.request, "owner-client"); assert.equal(started.status, "started"); const finished = await waitForStatus(h.registrar, started.operationId, "failed"); assert.equal(finished.status, "failed"); assert.equal(finished.errorCode, "TIMEOUT"); assert.ok(Date.now() - startedAt >= 250); } finally { await h.dispose(); }
});

test("same-attempt concurrent starts create one effect and completed replay is idempotent", async () => {
  const h = await harness("short", { allowLongLivedProcess: false });
  try {
    const results = await Promise.allSettled([h.registrar.start(h.request, "owner-client"), h.registrar.start(h.request, "owner-client")]);
    const fulfilled = results.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<HostOperationRegistrar["start"]>>> => item.status === "fulfilled");
    assert.equal(fulfilled.length, 2);
    assert.equal(fulfilled[0]!.value.status, "succeeded");
    assert.equal(fulfilled[1]!.value.operationId, fulfilled[0]!.value.operationId);
    assert.equal(await readFile(h.marker, "utf8"), "x\n");
  } finally { await h.dispose(); }
});

test("restart reconciliation returns unknown and cannot cancel by raw pid", macOnly, async () => {
  const h = await harness("write");
  try {
    const started = await h.registrar.start(h.request, "owner-client"); assert.equal(started.status, "started");
    const replacement = new HostOperationRegistrar(h.store, (h.registrar as any).policy, async (bound: BoundHostOperation) => ({ argv: [bound.request.executablePath, ...bound.request.argv], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }));
    const reconciled = await replacement.reconcile(started.operationId, "owner-client");
    assert.equal(reconciled.status, "outcome_unknown");
    await assert.rejects(() => replacement.cancel(started.operationId, "owner-client"), /live exact process identity/);
    await replacement.dispose();
  } finally { await h.dispose(); }
});

test("registrar disposal explicitly finalizes its owned child as failed", macOnly, async () => {
  const h = await harness("write");
  try {
    const started = await h.registrar.start(h.request, "owner-client");
    assert.equal(started.status, "started");
    const pid = (started.receipt as unknown as HostOperationReceipt).process!.pid;
    await h.registrar.dispose();
    const finished = h.registrar.status(started.operationId, "owner-client");
    assert.equal(finished.status, "failed");
    await assertDead(pid);
  } finally { await h.dispose(); }
});

test("foreign owner cannot read or cancel a host operation", macOnly, async () => {
  const h = await harness("write");
  try { const started = await h.registrar.start(h.request, "owner-client"); assert.equal(started.status, "started"); assert.throws(() => h.registrar.status(started.operationId, "foreign-client"), /different authenticated client/); await assert.rejects(() => h.registrar.cancel(started.operationId, "foreign-client"), /different authenticated client/); } finally { await h.dispose(); }
});

test("replacement startup owner cannot adopt a persisted record owned by another client", macOnly, async () => {
  const h = await harness("write");
  try {
    const started = await h.registrar.start(h.request, "owner-client");
    assert.equal(started.status, "started");
    const replacementPolicy = { ...(h.registrar as any).policy, ownerClientId: "replacement-owner" } as HostOperationPolicy;
    const replacement = new HostOperationRegistrar(h.store, replacementPolicy, async (bound: BoundHostOperation) => ({ argv: [bound.request.executablePath, ...bound.request.argv], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }));
    assert.throws(() => replacement.status(started.operationId, "owner-client"), /startup-selected owner|different authenticated client|owner/);
    await assert.rejects(() => replacement.reconcile(started.operationId, "owner-client"), /startup-selected owner|different authenticated client|owner/);
    await assert.rejects(() => replacement.cancel(started.operationId, "owner-client"), /startup-selected owner|different authenticated client|owner/);
    await replacement.dispose();
  } finally { await h.dispose(); }
});

test("dispose terminates a pending short process before awaiting its start", async () => {
  const h = await harness("write", { allowLongLivedProcess: false, maxWallMs: 5_000, maxIdleMs: 5_000 });
  try {
    const pendingStart = h.registrar.start(h.request, "owner-client");
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      try { if ((await readFile(h.marker, "utf8")) === "x\n") break; } catch { /* fixture has not started */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await readFile(h.marker, "utf8"), "x\n");
    const startedDispose = Date.now();
    await h.registrar.dispose();
    assert.ok(Date.now() - startedDispose < 1_500);
    const result = await pendingStart;
    assert.notEqual(result.status, "started");
  } finally { h.store.close(); await rm(h.root, { recursive: true, force: true }); }
});

{
  const root = await mkdtemp(join(tmpdir(), "devspace-host-durable-test-"));
  const store = new DurableOperationStore(root);
  const input = { operationId: "host_test_receipt", attemptKey: "receipt-1", requestHash: "request-hash", kind: "host_operation" as const, authorityMode: "OWNER_DIRECT" as const, scopeRoot: root, request: { clientId: "owner-client", attemptKey: "receipt-1" } };
  try { const created = store.createOrReplay(input); assert.equal(created.created, true); store.recordHostOperationReceipt(input.operationId, { process: { pid: 123, startTime: "fixed", processGroup: 123, command: "inert" }, outcome: "running" }); const unknown = store.finishHostOperation(input.operationId, { status: "outcome_unknown", retrySafe: false, errorCode: "RECONCILIATION_REQUIRED" }); assert.deepEqual(unknown.receipt?.process, { pid: 123, startTime: "fixed", processGroup: 123, command: "inert" }); const replay = store.createOrReplay(input); assert.equal(replay.created, false); assert.equal(replay.record.status, "outcome_unknown"); assert.throws(() => store.createOrReplay({ ...input, requestHash: "different" }), /materially different/); } finally { store.close(); await rm(root, { recursive: true, force: true }); }
}
