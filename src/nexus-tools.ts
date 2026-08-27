import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Single canonical registry of the Nexus MCP tool surface.
 *
 * This is the ONE source of truth for the tool surface name and tool count.
 * Consumers:
 *  - scripts/generate-build-identity.js (build-time, via tsx)
 *  - src/nexus-git-tools.ts (runtime fallback identity)
 *  - src/server.ts (runtime server surface metadata)
 *  - src/nexus-git-tools.test.ts (tests)
 *
 * The surface is defined as the always-on tool set under default config:
 * 5 core tools (open_workspace, read, write, edit, shell) + 12 Nexus tools
 * (11 read-only git/lifecycle tools + 1 protected PR integration fallback).
 * Conditional tools (grep/glob/ls, show_changes) are NOT part of this
 * canonical surface.
 */
export const NEXUS_MCP_TOOL_NAMES = [
  "open_workspace",
  "read",
  "write",
  "edit",
  "shell",
  "workspace_snapshot",
  "search_text",
  "list_tree",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_worktrees",
  "read_task_card",
  "read_candidate",
  "read_receipt",
  "git_merge_pull_request",
] as const;

export const NEXUS_MCP_TOOL_COUNT = NEXUS_MCP_TOOL_NAMES.length;
export const NEXUS_MCP_TOOL_SURFACE = `nexus-mcp-${NEXUS_MCP_TOOL_COUNT}-v1`;

export interface BuildManifestBody {
  package_name: string;
  package_version: string;
  source_commit: string;
  source_dirty: boolean;
  build_id: string;
  tool_surface: string;
  tool_count: number;
  gateway_name?: string;
  gateway_version?: string;
  gateway_commit?: string;
  lifecycle_commit?: string;
  gateway_tool_manifest_revision?: string;
  gateway_tool_count?: number;
}

/**
 * Canonical serialization of the build manifest body.
 * Keys sorted lexicographically, no whitespace, deterministic.
 */
export function canonicalBuildManifest(body: BuildManifestBody): string {
  return JSON.stringify(
    Object.keys(body)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (body as unknown as Record<string, unknown>)[key];
        return acc;
      }, {}),
  );
}

/**
 * SHA-256 hex digest of the canonical manifest body.
 * The digest covers every manifest field EXCEPT build_manifest_sha256 itself.
 */
export function buildManifestSha256(body: BuildManifestBody): string {
  return createHash("sha256").update(canonicalBuildManifest(body)).digest("hex");
}

export interface PackageBuildIdentity {
  package_name: string;
  package_version: string;
  source_commit: string;
  source_dirty: boolean;
  build_id: string;
  build_manifest_sha256: string;
}

export function readPackageBuildIdentity(): PackageBuildIdentity | null {
  try {
    const identityPath = join(dirname(fileURLToPath(import.meta.url)), "..", "generated", "build-identity.json");
    const parsed = JSON.parse(readFileSync(identityPath, "utf8")) as Record<string, unknown>;
    if (
      typeof parsed.package_name !== "string"
      || typeof parsed.package_version !== "string"
      || typeof parsed.source_commit !== "string"
      || typeof parsed.source_dirty !== "boolean"
      || typeof parsed.build_id !== "string"
      || typeof parsed.build_manifest_sha256 !== "string"
    ) {
      return null;
    }
    return {
      package_name: parsed.package_name,
      package_version: parsed.package_version,
      source_commit: parsed.source_commit,
      source_dirty: parsed.source_dirty,
      build_id: parsed.build_id,
      build_manifest_sha256: parsed.build_manifest_sha256,
    };
  } catch {
    return null;
  }
}
