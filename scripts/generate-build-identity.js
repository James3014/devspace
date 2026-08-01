#!/usr/bin/env node
/**
 * generate-build-identity.js
 *
 * Populates generated/build-identity.json with real values from the source repo
 * plus a canonical build manifest SHA-256 (G1). Run as part of the build
 * pipeline BEFORE tsc compilation, AFTER the source-cleanliness gate.
 *
 * Requires tsx (resolves ../src/nexus-tools.js -> src/nexus-tools.ts) so the
 * manifest's tool_surface/tool_count come from the single canonical registry.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NEXUS_MCP_TOOL_COUNT,
  NEXUS_MCP_TOOL_SURFACE,
  buildManifestSha256,
} from "../src/nexus-tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

const sourceCommit = execSync("git rev-parse HEAD", { cwd: root })
  .toString()
  .trim();
const shortCommit = sourceCommit.slice(0, 8);

// Use git commit author date for deterministic builds (not current time)
const commitTimestamp = execSync(
  "git log -1 --format=%aI HEAD",
  { cwd: root },
)
  .toString()
  .trim();

const buildId = `nexus-${pkg.version}-${shortCommit}`;

// Mirror the source-cleanliness gate: the manifest records source_dirty so the
// artifact is self-describing. The gate (scripts/check-source-clean.js) has
// already rejected dirty builds before this generator runs.
const porcelain = execSync("git status --porcelain=v1", { cwd: root })
  .toString();
const sourceDirty = porcelain
  .split("\n")
  .filter(Boolean)
  .some((line) => {
    const path = line.slice(3);
    return !path.startsWith("generated/") && !path.startsWith("dist/");
  });

const manifestBody = {
  package_name: pkg.name,
  package_version: pkg.version,
  source_commit: sourceCommit,
  source_dirty: sourceDirty,
  build_id: buildId,
  tool_surface: NEXUS_MCP_TOOL_SURFACE,
  tool_count: NEXUS_MCP_TOOL_COUNT,
};

const identity = {
  generated_at: commitTimestamp,
  ...manifestBody,
  build_manifest_sha256: buildManifestSha256(manifestBody),
};

const outDir = join(root, "generated");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "build-identity.json"),
  JSON.stringify(identity, null, 2) + "\n",
);

console.log(`build-identity: ${buildId}`);
console.log(`  commit: ${sourceCommit}`);
console.log(`  package: ${pkg.name}@${pkg.version}`);
console.log(`  surface: ${NEXUS_MCP_TOOL_SURFACE} (${NEXUS_MCP_TOOL_COUNT} tools)`);
console.log(`  manifest_sha256: ${identity.build_manifest_sha256}`);
