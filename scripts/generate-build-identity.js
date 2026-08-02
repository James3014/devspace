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
import { getConfiguredSurfaceIdentity } from "../src/config.js";

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
const gatewayName = process.env.NEXUS_GATEWAY_NAME || "unknown";
const gatewayVersion = process.env.NEXUS_GATEWAY_VERSION || "unknown";
const gatewayCommit = process.env.NEXUS_GATEWAY_COMMIT || "unknown";
const lifecycleCommit = process.env.NEXUS_LIFECYCLE_COMMIT || "unknown";
const gatewayToolManifestRevision = process.env.NEXUS_GATEWAY_TOOL_MANIFEST_REVISION || "unknown";
const gatewayToolCount = Number(process.env.NEXUS_GATEWAY_TOOL_COUNT || 0);
const gatewayToolManifestSha256 = process.env.NEXUS_GATEWAY_TOOL_MANIFEST_SHA256 || "unknown";
const observedManifest = gatewayToolCount > 0 || gatewayToolManifestRevision !== "unknown" || gatewayToolManifestSha256 !== "unknown"
  ? {
      count: gatewayToolCount,
      revision: gatewayToolManifestRevision,
      sha256: gatewayToolManifestSha256,
    }
  : undefined;
const surfaceIdentity = getConfiguredSurfaceIdentity(process.env, observedManifest);

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
  // These legacy fields describe the tool registry compiled into this package.
  // Runtime/public exposure is configuration-dependent and is recorded
  // separately below so a canonical proxy build cannot make raw workspace
  // snapshots falsely claim that their embedded registry contains 24 tools.
  tool_surface: NEXUS_MCP_TOOL_SURFACE,
  tool_count: NEXUS_MCP_TOOL_COUNT,
  effective_tool_surface: surfaceIdentity.surface_profile === "canonical_gateway_proxy"
    ? "nexus-canonical-gateway-proxy"
    : NEXUS_MCP_TOOL_SURFACE,
  effective_tool_count: surfaceIdentity.surface_profile === "canonical_gateway_proxy"
    ? gatewayToolCount
    : NEXUS_MCP_TOOL_COUNT,
  surface_profile: surfaceIdentity.surface_profile,
  protocol_mode: surfaceIdentity.protocol_mode,
  tool_source: surfaceIdentity.tool_source,
  proxy_mode: surfaceIdentity.proxy_mode,
  observed_manifest_count: surfaceIdentity.observed_manifest_count,
  observed_manifest_revision: surfaceIdentity.observed_manifest_revision,
  observed_manifest_sha256: surfaceIdentity.observed_manifest_sha256,
  gateway_name: gatewayName,
  gateway_version: gatewayVersion,
  gateway_commit: gatewayCommit,
  lifecycle_commit: lifecycleCommit,
  gateway_tool_manifest_revision: gatewayToolManifestRevision,
  gateway_tool_count: gatewayToolCount,
  gateway_tool_manifest_sha256: gatewayToolManifestSha256,
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
console.log(`  surface: ${manifestBody.tool_surface} (${manifestBody.tool_count} tools)`);
console.log(`  gateway: ${gatewayName}@${gatewayVersion} (${gatewayToolCount} tools)`);
console.log(`  identity: ${surfaceIdentity.surface_profile}/${surfaceIdentity.protocol_mode} (${surfaceIdentity.tool_source})`);
console.log(`  manifest_sha256: ${identity.build_manifest_sha256}`);
