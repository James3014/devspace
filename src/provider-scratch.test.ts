import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupProviderScratch,
  createProviderScratch,
  inspectScratchOwnership,
  sweepProviderScratch,
} from "./provider-scratch.js";

test("provider scratch is created outside product repos with valid ownership", () => {
  const repo = mkdtempSync(join(tmpdir(), "devspace-scratch-repo-"));
  try {
    const handle = createProviderScratch("agt_scratch1");
    try {
      assert.ok(handle.root.startsWith(tmpdir()));
      assert.ok(!handle.root.startsWith(repo));
      const ownership = inspectScratchOwnership(handle.root);
      assert.equal(ownership.owned, true);
    } finally {
      cleanupProviderScratch(handle.root);
    }
    assert.equal(existsSync(handle.root), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cleanup is idempotent for absent paths", () => {
  const first = cleanupProviderScratch(join(tmpdir(), "devspace-agent-scratch-never-created"));
  assert.equal(first.removed, false);
  assert.equal(first.alreadyAbsent, true);
  assert.deepEqual(first.refusals, []);
});

test("cleanup refuses unowned directories without deleting them", () => {
  const foreign = mkdtempSync(join(tmpdir(), "devspace-agent-scratch-unowned-"));
  writeFileSync(join(foreign, "user-file.txt"), "keep me");
  try {
    const result = cleanupProviderScratch(foreign);
    assert.equal(result.removed, false);
    assert.equal(result.refusals.length, 1);
    assert.equal(result.refusals[0]!.code, "REFUSED_UNOWNED");
    assert.equal(existsSync(join(foreign, "user-file.txt")), true);

    // A directory that merely looks like a scratch dir but lacks the marker.
    const fake = mkdtempSync(join(tmpdir(), "devspace-agent-scratch-fake-"));
    const fakeResult = cleanupProviderScratch(fake);
    assert.equal(fakeResult.removed, false);
    assert.equal(existsSync(fake), true);
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }
});

test("cleanup refuses paths that are not scratch-shaped at all", () => {
  const repo = mkdtempSync(join(tmpdir(), "devspace-real-repo-"));
  try {
    mkdirSync(join(repo, "nested"), { recursive: true });
    writeFileSync(join(repo, "nested", "important.txt"), "do not delete");
    const result = cleanupProviderScratch(join(repo, "nested"));
    assert.equal(result.removed, false);
    assert.equal(result.refusals[0]!.code, "REFUSED_UNOWNED");
    assert.equal(existsSync(join(repo, "nested", "important.txt")), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("sweep removes only owned scratch and reports unowned entries untouched", () => {
  const owned = createProviderScratch("agt_sweep_owned");
  const unowned = mkdtempSync(join(tmpdir(), "devspace-agent-scratch-stray-"));
  writeFileSync(join(unowned, "stray.txt"), "untouched");
  try {
    const sweep = sweepProviderScratch();
    assert.ok(sweep.swept.includes(owned.root));
    // Unowned entry survives the sweep.
    assert.equal(existsSync(join(unowned, "stray.txt")), true);
  } finally {
    if (existsSync(owned.root)) cleanupProviderScratch(owned.root);
    rmSync(unowned, { recursive: true, force: true });
  }
});
