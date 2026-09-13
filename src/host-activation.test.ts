import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HOST_ACTIVATION_MANIFEST_SCHEMA,
  applyHostActivation,
  bindHostActivation,
  preflightHostActivation,
  reconcileHostActivation,
  type HostActivationManifest,
} from "./host-activation.js";

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "devspace-host-activation-"));
  const receiptDir = join(root, "receipts");
  const manifestPath = join(root, "manifest.json");
  const first = join(root, "first.js");
  const second = join(root, "second.js");
  const firstOld = "const first = 'old';\n";
  const secondOld = "const second = 'old';\n";
  const firstNew = "const first = 'new';\n";
  const secondNew = "const second = 'new';\n";
  await writeFile(first, firstOld);
  await writeFile(second, secondOld);
  const manifest: HostActivationManifest = {
    schema: HOST_ACTIVATION_MANIFEST_SCHEMA,
    kind: "OPENCLI_CHATGPT_ADAPTER_OVERLAY",
    receiptDir,
    targets: [
      { targetId: "first", path: first, expectedPreimageSha256: digest(firstOld), expectedPostimageSha256: digest(firstNew), transform: { kind: "replace_exact_utf8", oldText: firstOld, newText: firstNew } },
      { targetId: "second", path: second, expectedPreimageSha256: digest(secondOld), expectedPostimageSha256: digest(secondNew), transform: { kind: "replace_exact_utf8", oldText: secondOld, newText: secondNew } },
    ],
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const cleanup = () => rm(root, { recursive: true, force: true });
  return { root, receiptDir, manifestPath, first, second, firstOld, secondOld, firstNew, secondNew, manifest, cleanup };
}

test("host activation applies exact postimages, persists rollback first, and reconciles from physical evidence", async () => {
  const f = await fixture();
  try {
    const bound = await bindHostActivation(f.manifestPath, [f.root], [f.manifestPath]);
    const preflight = await preflightHostActivation(bound);
    assert.equal(preflight.classification, "CONFIRMED_NO_EFFECT");
    assert.ok(preflight.targets.every((target) => target.state === "preimage"));
    const receipt = await applyHostActivation(f.manifestPath, bound.manifestSha256, "host_apply", [f.root], [f.manifestPath]);
    assert.equal(receipt.classification, "APPLIED");
    assert.equal(await readFile(f.first, "utf8"), f.firstNew);
    assert.equal(await readFile(f.second, "utf8"), f.secondNew);
    assert.equal(digest(await readFile(join(receipt.rollbackDir, "first.bin"))), digest(f.firstOld));
    assert.equal(digest(await readFile(join(receipt.rollbackDir, "second.bin"))), digest(f.secondOld));
    const reconciled = await reconcileHostActivation(bound, "host_apply");
    assert.equal(reconciled.classification, "APPLIED");
    assert.equal(reconciled.receiptPresent, true);
  } finally { await f.cleanup(); }
});

test("host activation blocks on preimage drift before any target write", async () => {
  const f = await fixture();
  try {
    await writeFile(f.second, "drift\n");
    const bound = await bindHostActivation(f.manifestPath, [f.root], [f.manifestPath]);
    const receipt = await applyHostActivation(f.manifestPath, bound.manifestSha256, "host_drift", [f.root], [f.manifestPath]);
    assert.equal(receipt.classification, "BLOCKED_PREIMAGE_DRIFT");
    assert.equal(receipt.changedByOperation, false);
    assert.equal(await readFile(f.first, "utf8"), f.firstOld);
    assert.equal(await readFile(f.second, "utf8"), "drift\n");
  } finally { await f.cleanup(); }
});

test("host activation rolls back every target when a later write fails", async () => {
  const f = await fixture();
  try {
    const bound = await bindHostActivation(f.manifestPath, [f.root], [f.manifestPath]);
    const receipt = await applyHostActivation(f.manifestPath, bound.manifestSha256, "host_rollback", [f.root], [f.manifestPath], {
      beforeTargetWrite: (_target, index) => { if (index === 1) throw new Error("synthetic second-target failure"); },
    });
    assert.equal(receipt.classification, "ROLLED_BACK");
    assert.equal(await readFile(f.first, "utf8"), f.firstOld);
    assert.equal(await readFile(f.second, "utf8"), f.secondOld);
    const reconciled = await reconcileHostActivation(bound, "host_rollback");
    assert.equal(reconciled.classification, "ROLLED_BACK");
  } finally { await f.cleanup(); }
});

test("host activation reconciliation never calls unreceipted postimages APPLIED", async () => {
  const f = await fixture();
  try {
    const bound = await bindHostActivation(f.manifestPath, [f.root], [f.manifestPath]);
    await writeFile(f.first, f.firstNew);
    await writeFile(f.second, f.secondNew);
    const unknown = await reconcileHostActivation(bound, "host_no_receipt");
    assert.equal(unknown.classification, "EFFECT_UNKNOWN");
    await writeFile(f.second, f.secondOld);
    const partial = await reconcileHostActivation(bound, "host_partial");
    assert.equal(partial.classification, "PARTIAL_EFFECT");
  } finally { await f.cleanup(); }
});

test("host activation binds manifest content and refuses a changed manifest", async () => {
  const f = await fixture();
  try {
    const bound = await bindHostActivation(f.manifestPath, [f.root], [f.manifestPath]);
    const changed = { ...f.manifest, receiptDir: join(f.root, "other-receipts") };
    await writeFile(f.manifestPath, JSON.stringify(changed, null, 2));
    await assert.rejects(
      () => applyHostActivation(f.manifestPath, bound.manifestSha256, "host_manifest_drift", [f.root], [f.manifestPath]),
      /manifest changed after durable binding/,
    );
  } finally { await f.cleanup(); }
});

test("host activation rejects a target outside the startup-approved write scope", async () => {
  const f = await fixture();
  const allowed = join(f.root, "allowed");
  try {
    await mkdir(allowed);
    await assert.rejects(() => bindHostActivation(f.manifestPath, [allowed], [f.manifestPath]), /outside the startup-approved host operation scope/);
  } finally { await f.cleanup(); }
});
