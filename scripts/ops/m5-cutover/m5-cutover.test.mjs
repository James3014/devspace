import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  Refuse,
  identityFromHealth,
  matchesTarget,
  readSidecarEnv,
  recoveryFor,
  resolveServiceRoot,
  sameDeep,
  selectMode,
} from "./m5-cutover-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const oldIdentity = { serverInstanceId: "old", sourceCommit: "a".repeat(40), buildId: "b1", capabilityManifestSha256: "c".repeat(64) };
const target = { sourceCommit: "d".repeat(40), buildId: "b2", capabilityManifestSha256: "e".repeat(64) };
const contract = { cutover: { currentIdentity: oldIdentity, expectedIdentity: target } };

function record(overrides = {}) {
  return { cutoverId: "cut_1", phase: "prepared", oldServerIdentity: oldIdentity, expectedNewIdentity: target, ...overrides };
}
const select = (file, liveIsOld, liveIsTarget) => selectMode({ file, contract, liveIsOld, liveIsTarget });

test("sidecar without env exits 1 with a usage error and no side effects", () => {
  const env = { PATH: process.env.PATH };
  const result = spawnSync(process.execPath, [join(here, "m5-cutover-sidecar.mjs")], { env, encoding: "utf8" });
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.ok, false);
  assert.match(failure.error, /PENDING_ID, CONTRACT_PATH, RECEIPT_PATH and ACTIVE_RELEASE_ROOT are all required/);
});

test("readSidecarEnv requires all four inputs and defaults the service root from home", () => {
  const full = { PENDING_ID: "pair_x", CONTRACT_PATH: "/c", RECEIPT_PATH: "/r", ACTIVE_RELEASE_ROOT: "/a" };
  for (const key of Object.keys(full)) {
    assert.equal(readSidecarEnv({ ...full, [key]: "" }, "/home/u").ok, false, key);
  }
  const ok = readSidecarEnv(full, "/home/u");
  assert.equal(ok.ok, true);
  assert.equal(ok.values.SERVICE_ROOT, "/home/u/.local/share/devspace-service");
});

test("resolveServiceRoot precedence: DEVSPACE_SERVICE_ROOT, legacy SERVICE_ROOT, home default", () => {
  assert.equal(resolveServiceRoot({ DEVSPACE_SERVICE_ROOT: "/x", SERVICE_ROOT: "/y" }, "/h"), "/x");
  assert.equal(resolveServiceRoot({ SERVICE_ROOT: "/y" }, "/h"), "/y");
  assert.equal(resolveServiceRoot({}, "/h"), "/h/.local/share/devspace-service");
});

test("no active generation or a closed one selects full", () => {
  assert.equal(select(null, true, false), "full");
  assert.equal(select(record({ phase: "closed" }), false, true), "full");
});

test("prepared without progress and old live resumes at drain", () => {
  assert.equal(select(record(), true, false), "resume_drain");
});

test("drained with activation selects resume_restart (old live) or resume_finish (target live)", () => {
  const drained = record({ phase: "drained", activationBinding: { releasePath: "/r" }, drainEvidence: {} });
  assert.equal(select(drained, true, false), "resume_restart");
  assert.equal(select(drained, false, true), "resume_finish");
});

test("restart already requested with old still live is refused (one-restart rule)", () => {
  const drained = record({ phase: "drained", activationBinding: {}, restartRequest: { at: "t" } });
  assert.throws(() => select(drained, true, false), (error) => error instanceof Refuse && error.extra.activePhase === "drained");
});

test("refuses drained without activation, prepared with progress, and unknown live identity", () => {
  assert.throws(() => select(record({ phase: "drained" }), true, false), Refuse);
  assert.throws(() => select(record({ drainEvidence: {} }), true, false), Refuse);
  assert.throws(() => select(record({ phase: "drained", activationBinding: {} }), false, false), Refuse);
});

test("refuses an active generation that is not this contract's", () => {
  const foreign = record({ expectedNewIdentity: { ...target, buildId: "other" } });
  assert.throws(() => select(foreign, true, false), /does not match this contract/);
});

test("recovery hints name the right command and keep the cutover id", () => {
  assert.match(recoveryFor(record(), true, false), /abort-expired-prepared --cutover-id cut_1/);
  assert.match(recoveryFor(record({ phase: "drained" }), true, false), /recover-expired-drained/);
  assert.match(recoveryFor(record({ phase: "drained", activationBinding: {} }), false, false), /recover-unexpected-replacement/);
});

test("identity helpers: structural equality ignores key order; health maps to identity", () => {
  assert.equal(sameDeep({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }), true);
  assert.equal(sameDeep({ a: 1 }, { a: 2 }), false);
  const h = {
    mcp: { serverInstanceId: "old" },
    build: { source_commit: target.sourceCommit, build_id: "b2", release_path: "/rel" },
    capabilityManifest: { manifestSha256: target.capabilityManifestSha256 },
  };
  assert.deepEqual(identityFromHealth(h), {
    serverInstanceId: "old", sourceCommit: target.sourceCommit, buildId: "b2",
    capabilityManifestSha256: target.capabilityManifestSha256, releasePath: "/rel",
  });
  assert.equal(matchesTarget(h, target), true);
  assert.equal(matchesTarget(h, { ...target, buildId: "x" }), false);
});
