import { createHash } from "node:crypto";

/**
 * Machine-checkable loaded-capability manifest for the Dev MCP runtime.
 *
 * Issue #30 requires promotions/cutovers to fail closed when a candidate
 * silently removes a previously verified host-visible capability (tool action
 * or schema field, such as the `agent_start` G9 authority seam). The manifest
 * is computed from what the loaded runtime actually registers, serialized
 * canonically, and fingerprinted so identity evidence can be compared
 * pre/post-cutover without trusting prose claims.
 */

export const CAPABILITY_MANIFEST_SCHEMA = "devspace.capability_manifest.v1" as const;

export const NEXUS_EXECUTION_GRANT_SCHEMA_REF = "nexus.devspace.execution_grant.v1" as const;

export interface RequiredCapability {
  /** Stable capability id used in promotion evidence and diagnostics. */
  id: string;
  kind: "mcp_action" | "tool_schema_field";
  /** Host-visible MCP tool that carries this capability. */
  tool: string;
  /** Dot-separated schema field path for `tool_schema_field` capabilities. */
  fieldPath?: string;
  /** Contract schema this capability exposes, when applicable. */
  schemaRef?: string;
  description: string;
}

/**
 * Capabilities that are loaded and verified on the current canonical lineage.
 * A candidate that removes any of these without an explicit contract delta
 * must be refused by the promotion gate.
 */
export const REQUIRED_HOST_CAPABILITIES: readonly RequiredCapability[] = [
  {
    id: "agent_start.tool",
    kind: "mcp_action",
    tool: "agent_start",
    description: "agent_start MCP action is advertised to the host.",
  },
  {
    id: "agent_start.executionContract.authorityMode",
    kind: "tool_schema_field",
    tool: "agent_start",
    fieldPath: "executionContract.authorityMode",
    description:
      "agent_start execution contract exposes the G9 authority lane selector (OWNER_DIRECT | NEXUS_GOVERNED).",
  },
  {
    id: "agent_start.executionContract.nexusGrant",
    kind: "tool_schema_field",
    tool: "agent_start",
    fieldPath: "executionContract.nexusGrant",
    schemaRef: NEXUS_EXECUTION_GRANT_SCHEMA_REF,
    description:
      "agent_start execution contract exposes the canonical Nexus execution grant pointer seam.",
  },
];

/**
 * Evidence recorded by the runtime when a tool schema is actually registered.
 * Values are dot-separated field paths relative to the tool input schema.
 */
export function recordToolSchemaEvidence(tool: string, fieldPaths: readonly string[]): void {
  recordedToolSchemaEvidence.set(tool, [...fieldPaths]);
}

/** Test/observation seam: forget all recorded evidence. */
export function resetToolSchemaEvidence(): void {
  recordedToolSchemaEvidence.clear();
}

const recordedToolSchemaEvidence = new Map<string, readonly string[]>();

export interface CapabilityManifest {
  schema: typeof CAPABILITY_MANIFEST_SCHEMA;
  /** Sorted ids of required capabilities present in the loaded runtime. */
  capabilities: string[];
  /** Sorted ids of required capabilities absent from the loaded runtime. */
  missing: string[];
  /** sha256 over the canonical JSON of { schema, capabilities }. */
  manifestSha256: string;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Compute the loaded-capability manifest from the recorded runtime evidence. */
export function computeCapabilityManifest(): CapabilityManifest {
  const capabilities: string[] = [];
  const missing: string[] = [];
  for (const required of REQUIRED_HOST_CAPABILITIES) {
    let present = false;
    if (required.kind === "mcp_action") {
      present = recordedToolSchemaEvidence.has(required.tool);
    } else if (required.fieldPath) {
      const fields = recordedToolSchemaEvidence.get(required.tool) ?? [];
      present = fields.includes(required.fieldPath);
    }
    if (present) capabilities.push(required.id);
    else missing.push(required.id);
  }
  capabilities.sort();
  missing.sort();
  const manifestSha256 = createHash("sha256")
    .update(canonicalJson({ schema: CAPABILITY_MANIFEST_SCHEMA, capabilities }))
    .digest("hex");
  return { schema: CAPABILITY_MANIFEST_SCHEMA, capabilities, missing, manifestSha256 };
}

export interface CapabilityPreservationDiff {
  preserved: boolean;
  /** Required capability ids absent from the candidate manifest. */
  missing: string[];
}

/** Compare a required (current live/canonical) manifest against a candidate manifest. */
export function diffCapabilityManifests(input: {
  requiredCapabilityIds: readonly string[];
  candidateCapabilityIds: readonly string[];
}): CapabilityPreservationDiff {
  const candidate = new Set(input.candidateCapabilityIds);
  const missing = [...new Set(input.requiredCapabilityIds)]
    .sort()
    .filter((id) => !candidate.has(id));
  return { preserved: missing.length === 0, missing };
}
