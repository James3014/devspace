#!/usr/bin/env node
/**
 * check-source-clean.js
 *
 * Pre-build source-cleanliness gate (G2).
 *
 * Rejects the build when the source tree has uncommitted tracked changes or
 * untracked files outside the generated/ output directory. When rejected, the
 * build exits non-zero with error_code DIRTY_SOURCE_BUILD_REJECTED BEFORE the
 * identity generator runs, so the tracked generated/build-identity.json is
 * never modified by a dirty-source build (clean-before == clean-after).
 *
 * Run as the first step of `npm run build`.
 */
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

let porcelain;
try {
  porcelain = execSync("git status --porcelain=v1", { cwd: root })
    .toString();
} catch {
  console.error(
    JSON.stringify({
      error_code: "DIRTY_SOURCE_BUILD_REJECTED",
      reason: "git status failed; cannot prove source cleanliness",
    }),
  );
  process.exit(1);
}

const lines = porcelain.split("\n").filter(Boolean);

// Build outputs that are allowed to change between builds are excluded from
// the source-dirtiness determination.
const dirty = lines.filter((line) => {
  const path = line.slice(3);
  return !path.startsWith("generated/") && !path.startsWith("dist/");
});

if (dirty.length > 0) {
  console.error(
    JSON.stringify({
      error_code: "DIRTY_SOURCE_BUILD_REJECTED",
      reason: "source tree has uncommitted changes",
      files: dirty,
    }),
  );
  process.exit(1);
}

console.log("source-clean: build allowed");
process.exit(0);
