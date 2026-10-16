import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bindCutoverActivation,
  verifyActivationBinding,
  verifyReleasePointer,
} from "./cutover-activation.js";
import {
  CUTOVER_ACTIVATION_BINDING_SCHEMA,
  CutoverStateStore,
} from "./cutover-state.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devspace-cutover-activation-"));
  const serviceRoot = join(root, "service");
  const packageRoot = join(root, "target");
  mkdirSync(join(serviceRoot, "dist"), { recursive: true });
  writeFileSync(join(serviceRoot, "dist", "service-launcher.js"), "export {};\n");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  mkdirSync(join(packageRoot, "generated"), { recursive: true });
  mkdirSync(join(packageRoot, "node_modules", "fixture"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@waishnav/devspace", version: "1.0.7", type: "module" }),
  );
  writeFileSync(join(packageRoot, "dist", "cli.js"), "console.log('target');\n");
  writeFileSync(join(packageRoot, "node_modules", "fixture", "index.js"), "export default 1;\n");
  const sourceCommit = "b".repeat(40);
  const buildId = "devspace-1.0.7-bbbbbbbb";
  writeFileSync(
    join(packageRoot, "generated", "build-identity.json"),
    JSON.stringify({
      package_name: "@waishnav/devspace",
      package_version: "1.0.7",
      source_commit: sourceCommit,
      source_dirty: false,
      build_id: buildId,
      built_at: "2026-10-06T00:00:00.000Z",
    }),
  );
  return {
    root,
    serviceRoot,
    packageRoot,
    sourceCommit,
    buildId,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("activation binding materializes one immutable release and exact pointer readback", () => {
  const f = fixture();
  try {
    const binding = bindCutoverActivation({
      cutoverId: "cutover-a",
      packageRoot: f.packageRoot,
      serviceRoot: f.serviceRoot,
      expected: { sourceCommit: f.sourceCommit, buildId: f.buildId },
      now: () => Date.parse("2026-10-06T00:00:00.000Z"),
    });
    assert.equal(binding.schema, CUTOVER_ACTIVATION_BINDING_SCHEMA);
    assert.equal(binding.sourceCommit, f.sourceCommit);
    assert.equal(binding.buildId, f.buildId);
    assert.match(binding.releaseSha256, /^[0-9a-f]{64}$/);
    assert.match(binding.releasePath, /releases\/release-b{40}-[0-9a-f]{16}$/);
    assert.equal(binding.previousReleasePath, undefined);

    const pointer = verifyActivationBinding(binding, f.serviceRoot);
    assert.equal(pointer.releasePath, binding.releasePath);
    assert.equal(pointer.releaseSha256, binding.releaseSha256);
    assert.equal(
      verifyReleasePointer(binding.pointerPath, f.serviceRoot).cutoverId,
      "cutover-a",
    );

    const replay = bindCutoverActivation({
      cutoverId: "cutover-a",
      packageRoot: f.packageRoot,
      serviceRoot: f.serviceRoot,
      expected: { sourceCommit: f.sourceCommit, buildId: f.buildId },
      now: () => Date.parse("2026-10-07T00:00:00.000Z"),
    });
    assert.deepEqual(replay, binding);
  } finally {
    f.cleanup();
  }
});

test("activation verification rejects release tampering before restart", () => {
  const f = fixture();
  try {
    const binding = bindCutoverActivation({
      cutoverId: "cutover-a",
      packageRoot: f.packageRoot,
      serviceRoot: f.serviceRoot,
      expected: { sourceCommit: f.sourceCommit, buildId: f.buildId },
    });
    writeFileSync(join(binding.releasePath, "dist", "cli.js"), "tampered\n");
    assert.throws(
      () => verifyActivationBinding(binding, f.serviceRoot),
      /release digest changed/i,
    );
  } finally {
    f.cleanup();
  }
});

test("activation binding stays idempotent after restart intent but before scheduling", () => {
  const f = fixture();
  try {
    const stateDir = join(f.root, "state");
    const store = new CutoverStateStore(stateDir);
    const record = store.begin({
      oldServerIdentity: {
        serverInstanceId: "old",
        sourceCommit: "a".repeat(40),
        buildId: "old-build",
      },
      expectedNewIdentity: {
        sourceCommit: f.sourceCommit,
        buildId: f.buildId,
      },
    });
    store.recordDrain(record.cutoverId, { activeSessions: 0, oldestAgeMs: 0 });
    const request = store.recordRestartRequest(record.cutoverId, {
      actuator: "launchd-self",
      requestedByServerInstanceId: "old",
      buildReady: {
        verifiedBy: "test",
        verifiedAt: new Date().toISOString(),
        evidence: "target verified",
      },
    });
    assert.equal(request.newlyRequested, true);
    assert.equal(request.record.restartRequest?.restartScheduledAt, undefined);

    const binding = bindCutoverActivation({
      cutoverId: record.cutoverId,
      packageRoot: f.packageRoot,
      serviceRoot: f.serviceRoot,
      expected: record.expectedNewIdentity,
    });
    assert.equal(store.recordActivationBinding(record.cutoverId, binding).newlyBound, true);
    assert.equal(store.recordActivationBinding(record.cutoverId, binding).newlyBound, false);
    assert.deepEqual(store.get()?.activationBinding, binding);
  } finally {
    f.cleanup();
  }
});


test("activation preserves relative in-tree npm bin symlinks", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.packageRoot, "node_modules", ".bin"), { recursive: true });
    symlinkSync(
      "../fixture/index.js",
      join(f.packageRoot, "node_modules", ".bin", "fixture"),
    );
    const binding = bindCutoverActivation({
      cutoverId: "cutover-relative-link",
      packageRoot: f.packageRoot,
      serviceRoot: f.serviceRoot,
      expected: { sourceCommit: f.sourceCommit, buildId: f.buildId },
    });
    assert.equal(
      readlinkSync(join(binding.releasePath, "node_modules", ".bin", "fixture")),
      "../fixture/index.js",
    );
    verifyActivationBinding(binding, f.serviceRoot);
  } finally {
    f.cleanup();
  }
});

test("activation rejects a release tree with an external physical symlink target", () => {
  const f = fixture();
  try {
    const external = join(f.root, "external.js");
    writeFileSync(external, "mutable external content\n");
    symlinkSync(
      external,
      join(f.packageRoot, "node_modules", "fixture", "external.js"),
    );
    assert.throws(
      () => bindCutoverActivation({
        cutoverId: "cutover-external-link",
        packageRoot: f.packageRoot,
        serviceRoot: f.serviceRoot,
        expected: { sourceCommit: f.sourceCommit, buildId: f.buildId },
      }),
      /symlink escapes the immutable release root/i,
    );
  } finally {
    f.cleanup();
  }
});
