import { createHash } from "node:crypto";

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
 * 5 core tools (open_workspace, read, write, edit, shell) + 11 Nexus
 * read-only git/lifecycle tools. Conditional tools (grep/glob/ls, show_changes)
 * are NOT part of this canonical surface.
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
