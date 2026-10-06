import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertAllowedPath,
  canonicalizePath,
  expandHomePath,
  isPathInsideRoot,
  isSameWorktreePath,
  resolveAllowedPath,
} from "./roots.js";

const home = homedir();

assert.equal(expandHomePath("~"), home);
assert.equal(expandHomePath("~/personal/devspace"), resolve(home, "personal", "devspace"));
assert.equal(expandHomePath("~user/project"), "~user/project");
assert.equal(expandHomePath("$HOME/project"), "$HOME/project");

assert.equal(
  assertAllowedPath("~/personal/devspace", [join(home, "personal")]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  assertAllowedPath("~/personal/devspace", ["~/personal"]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  resolveAllowedPath("~/file.txt", "/workspace", ["/workspace"]),
  resolve("/workspace", "~/file.txt"),
);

if (process.platform === "win32") {
  assert.throws(
    () => assertAllowedPath("C:\\Users\\Administrator", ["G:\\Projects\\Dev\\Github\\devspace"]),
    /Path is outside allowed roots/,
  );
}

// ─── canonicalizePath Tests ──────────────────────────────────────────────────

const tempDir = mkdtempSync(join(tmpdir(), "devspace-roots-test-"));
try {
  const realTargetDir = join(tempDir, "real-target");
  const symlinkDir = join(tempDir, "symlink-dir");
  mkdirSync(realTargetDir);
  symlinkSync(realTargetDir, symlinkDir, "dir");

  // 1. symlink / equivalent path -> canonical equality
  assert.equal(canonicalizePath(symlinkDir), canonicalizePath(realTargetDir));
  assert.equal(canonicalizePath(symlinkDir), realpathSync(realTargetDir));

  // 2. missing trailing path segment -> deterministic canonical reconstruction
  const missingNestedPath = join(symlinkDir, "missing", "sub", "dir");
  const expectedReconstructed = join(realpathSync(realTargetDir), "missing", "sub", "dir");
  assert.equal(canonicalizePath(missingNestedPath), expectedReconstructed);

  // 2b. worktree identity handles symlinks, while allowed-root containment
  // additionally recognizes only physically proven case aliases on case-insensitive filesystems.
  assert.equal(isSameWorktreePath(symlinkDir, realTargetDir), true);

  if (process.platform === "darwin" || process.platform === "win32") {
    assert.equal(isSameWorktreePath(realTargetDir.toUpperCase(), realTargetDir.toLowerCase()), true);

    const caseVariant = join(dirname(realTargetDir), basename(realTargetDir).toUpperCase());
    try {
      if (realpathSync(caseVariant) === realpathSync(realTargetDir)) {
        assert.equal(isPathInsideRoot(caseVariant, realTargetDir), true);
        assert.equal(assertAllowedPath(caseVariant, [realTargetDir]), resolve(caseVariant));
      }
    } catch {
      // Case-sensitive volumes do not provide a physical casing alias.
    }
  }

  // 3. unexpected realpath error -> throws / fails closed
  if (process.platform !== "win32") {
    const loopLinkA = join(tempDir, "loopA");
    const loopLinkB = join(tempDir, "loopB");
    symlinkSync(loopLinkB, loopLinkA);
    symlinkSync(loopLinkA, loopLinkB);

    assert.throws(
      () => canonicalizePath(loopLinkA),
      (err: any) => {
        assert.equal(err.code, "ELOOP");
        return true;
      },
    );
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
