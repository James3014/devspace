#!/usr/bin/env node
/**
 * compute-artifact-sha256.js
 *
 * Run AFTER npm pack to compute the SHA-256 of the artifact.
 * Writes to generated/artifact-sha256.txt (excluded from package)
 * and to a persistent location for verification.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const tgzFiles = execSync("ls -1 *.tgz 2>/dev/null || true", { cwd: root })
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean);

if (tgzFiles.length === 0) {
  console.error("No .tgz file found. Run 'npm pack' first.");
  process.exit(1);
}

const tgzPath = join(root, tgzFiles[0]);
const sha256 = execSync(`shasum -a 256 "${tgzPath}"`, { cwd: root })
  .toString()
  .split(" ")[0]
  .trim();

// Write to generated/ (excluded from package)
const outDir = join(root, "generated");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "artifact-sha256.txt"), sha256 + "\n");

console.log(`artifact_sha256: ${sha256}`);
console.log(`  file: ${tgzFiles[0]}`);
