#!/usr/bin/env node
/**
 * generate-build-identity.js
 *
 * Populates generated/build-identity.json with real values from the source repo.
 * Run as part of the build pipeline BEFORE tsc compilation.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

const identity = {
  generated_at: commitTimestamp,
  source_commit: sourceCommit,
  package_name: pkg.name,
  package_version: pkg.version,
  tool_surface: "nexus-mcp-16-v1",
  tool_count: 16,
  build_id: buildId,
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
