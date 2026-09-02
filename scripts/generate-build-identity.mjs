import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const commit = git(["rev-parse", "HEAD"]) || "unknown";
const dirty = git(["status", "--porcelain"]).length > 0;
const builtAt = new Date().toISOString();
const buildId = `devspace-${pkg.version}-${commit.slice(0, 8)}`;
const buildManifestSha256 = createHash("sha256")
  .update(
    JSON.stringify({
      package_name: pkg.name,
      package_version: pkg.version,
      source_commit: commit,
      source_dirty: dirty,
      built_at: builtAt,
    }),
  )
  .digest("hex");

const identity = {
  package_name: pkg.name,
  package_version: pkg.version,
  source_commit: commit,
  source_dirty: dirty,
  build_id: buildId,
  build_manifest_sha256: buildManifestSha256,
  built_at: builtAt,
};

mkdirSync(join(root, "generated"), { recursive: true });
writeFileSync(
  join(root, "generated", "build-identity.json"),
  `${JSON.stringify(identity, null, 2)}\n`,
);
console.log(`build identity: ${buildId} (commit ${commit.slice(0, 12)})`);
