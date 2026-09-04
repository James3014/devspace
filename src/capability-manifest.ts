import { createHash } from "node:crypto";

export const CAPABILITY_MANIFEST_SCHEMA = "devspace.capability_manifest.v1" as const;
export const NEXUS_INTEGRATION_MANIFEST_SCHEMA = "devspace.nexus_integration_manifest.v1" as const;

export interface CapabilityManifest {
  schema: typeof CAPABILITY_MANIFEST_SCHEMA;
  capabilities: string[];
  missing: string[];
  manifestSha256: string;
}

interface SchemaLike {
  description?: string;
  shape?: Record<string, SchemaLike>;
  unwrap?: () => SchemaLike;
  constructor?: { name?: string };
}

export interface NexusIntegrationManifest {
  schema: typeof NEXUS_INTEGRATION_MANIFEST_SCHEMA;
  capabilities: string[];
  missing: string[];
  manifestSha256: string;
}

type ToolInputSchemas = Record<string, Record<string, SchemaLike>>;

const REQUIRED_CAPABILITIES = [
  { id: "agent_start.tool", tool: "agent_start" },
  {
    id: "agent_start.executionContract.authorityMode",
    tool: "agent_start",
    fieldPath: "executionContract.authorityMode",
  },
  {
    id: "agent_start.executionContract.idleTimeoutMs",
    tool: "agent_start",
    fieldPath: "executionContract.idleTimeoutMs",
  },
  {
    id: "agent_start.executionContract.selection",
    tool: "agent_start",
    fieldPath: "executionContract.selection",
  },
] as const;

const NEXUS_INTEGRATION_CAPABILITIES = [
  {
    id: "agent_start.executionContract.authorityMode",
    tool: "agent_start",
    fieldPath: "executionContract.authorityMode",
  },
  {
    id: "agent_start.executionContract.nexusGrant",
    tool: "agent_start",
    fieldPath: "executionContract.nexusGrant",
  },
] as const;

function unwrap(schema: SchemaLike | undefined): SchemaLike | undefined {
  let current = schema;
  const seen = new Set<SchemaLike>();
  while (current && typeof current.unwrap === "function" && !seen.has(current)) {
    seen.add(current);
    current = current.unwrap();
  }
  return current;
}

function resolveField(
  schema: Record<string, SchemaLike> | undefined,
  fieldPath: string,
): SchemaLike | undefined {
  let current: SchemaLike | undefined;
  let shape = schema;
  for (const segment of fieldPath.split(".")) {
    current = unwrap(shape?.[segment]);
    shape = current?.shape;
  }
  return current;
}

/**
 * Derive the runtime manifest from the same schema objects passed to MCP tool
 * registration. No source declaration or caller-supplied capability list is
 * treated as evidence.
 */
function deriveManifest(
  schema: string,
  requirements: readonly { id: string; tool: string; fieldPath?: string }[],
  tools: ToolInputSchemas,
): { capabilities: string[]; missing: string[]; manifestSha256: string } {
  const capabilities: string[] = [];
  const missing: string[] = [];
  const observed: Array<{ id: string; description?: string; schemaKind?: string }> = [];

  for (const requirement of requirements) {
    const toolSchema = tools[requirement.tool];
    const field = requirement.fieldPath !== undefined
      ? resolveField(toolSchema, requirement.fieldPath)
      : toolSchema
        ? ({ constructor: { name: "McpTool" } } satisfies SchemaLike)
        : undefined;
    if (!field) {
      missing.push(requirement.id);
      continue;
    }
    capabilities.push(requirement.id);
    observed.push({
      id: requirement.id,
      description: field.description,
      schemaKind: field.constructor?.name,
    });
  }

  capabilities.sort();
  missing.sort();
  observed.sort((left, right) => left.id.localeCompare(right.id));
  const manifestSha256 = createHash("sha256")
    .update(JSON.stringify({ schema, observed }))
    .digest("hex");
  return { capabilities, missing, manifestSha256 };
}

export function deriveLoadedCapabilityManifest(
  tools: ToolInputSchemas,
): CapabilityManifest {
  const derived = deriveManifest(CAPABILITY_MANIFEST_SCHEMA, REQUIRED_CAPABILITIES, tools);
  return { schema: CAPABILITY_MANIFEST_SCHEMA, ...derived };
}

export function deriveNexusIntegrationManifest(
  tools: ToolInputSchemas,
): NexusIntegrationManifest {
  const derived = deriveManifest(NEXUS_INTEGRATION_MANIFEST_SCHEMA, NEXUS_INTEGRATION_CAPABILITIES, tools);
  return { schema: NEXUS_INTEGRATION_MANIFEST_SCHEMA, ...derived };
}
