import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUILD_IDENTITY_RELATIVE_PATH, CutoverBuildNotReadyError, probeBuildReady } from "./cutover-build-ready.js";

const expected = { sourceCommit: "a".repeat(40), buildId: "build-expected" };

function writeIdentity(root: string, value: unknown): void {
  mkdirSync(join(root, "generated"), { recursive: true });
  writeFileSync(join(root, BUILD_IDENTITY_RELATIVE_PATH), JSON.stringify(value), "utf8");
}

test("probe is ready when the bound expected identity matches the on-disk build identity file", () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-build-ready-match-"));
  try {
    writeIdentity(root, { source_commit: expected.sourceCommit, build_id: expected.buildId });
    const result = probeBuildReady({ packageRoot: root, expected });
    assert.equal(result.buildReady, true);
    assert.equal(result.verifiedBy, "build-identity-file");
    assert.equal(result.actualSourceCommit, expected.sourceCommit);
    assert.equal(result.actualBuildId, expected.buildId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probe fails closed on source, build, or tag mismatch without throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-build-ready-mismatch-"));
  try {
    writeIdentity(root, { source_commit: "b".repeat(40), build_id: expected.buildId });
    const sourceMismatch = probeBuildReady({ packageRoot: root, expected });
    assert.equal(sourceMismatch.buildReady, false);
    assert.equal(sourceMismatch.actualSourceCommit, "b".repeat(40));

    writeIdentity(root, { source_commit: expected.sourceCommit, build_id: "build-wrong" });
    assert.equal(probeBuildReady({ packageRoot: root, expected }).buildReady, false);

    writeIdentity(root, { source_commit: expected.sourceCommit, build_id: expected.buildId, source_dirty: true });
    assert.equal(probeBuildReady({ packageRoot: root, expected }).buildReady, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probe fails closed on missing, malformed, or field-poor identity files without throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-build-ready-missing-"));
  try {
    const missing = probeBuildReady({ packageRoot: root, expected });
    assert.equal(missing.buildReady, false);
    assert.match(missing.detail, /not readable/i);

    mkdirSync(join(root, "generated"), { recursive: true });
    writeFileSync(join(root, BUILD_IDENTITY_RELATIVE_PATH), "{ not json", "utf8");
    assert.match(probeBuildReady({ packageRoot: root, expected }).detail, /malformed/i);

    writeFileSync(join(root, BUILD_IDENTITY_RELATIVE_PATH), JSON.stringify({ only: "field" }), "utf8");
    assert.match(probeBuildReady({ packageRoot: root, expected }).detail, /lacks source_commit\/build_id/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CutoverBuildNotReadyError carries a stable fail-closed code", () => {
  const error = new CutoverBuildNotReadyError("probe blocked");
  assert.equal(error.code, "CUTOVER_BUILD_NOT_READY");
  assert.match(error.message, /CUTOVER_BUILD_NOT_READY/);
});