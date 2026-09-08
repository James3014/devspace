import { createHash } from "node:crypto";
import * as z from "zod/v4";

export const CAPABILITY_MANIFEST_SCHEMA = "devspace.capability_manifest.v1" as const;

export interface CapabilityManifest {
  schema: typeof CAPABILITY_MANIFEST_SCHEMA;
  capabilities: string[];
  missing: string[];
  manifestSha256: string;
  /** Stable fingerprint of the complete registered MCP input schemas. */
  inputSchemaFingerprint?: string;
}

interface SchemaLike {
  description?: string;
  shape?: Record<string, SchemaLike>;
  unwrap?: () => SchemaLike;
  constructor?: { name?: string };
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

function canonicalValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalValue(item));
    return key === "required" || key === "enum"
      ? items.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      : items;
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>).sort().map((childKey) => [childKey, canonicalValue((value as Record<string, unknown>)[childKey], childKey)]),
  );
}

function registeredSchemaFingerprint(tools: ToolInputSchemas): string | undefined {
  const schemas = Object.fromEntries(
    Object.keys(tools).sort().map((tool) => [tool, z.toJSONSchema(z.object(tools[tool] as Record<string, z.ZodType>))]),
  );
  return createHash("sha256").update(JSON.stringify(canonicalValue(schemas))).digest("hex");
}

/**
 * Derive the runtime manifest from the same schema objects passed to MCP tool
 * registration. No source declaration or caller-supplied capability list is
 * treated as evidence.
 */
export function deriveLoadedCapabilityManifest(
  tools: ToolInputSchemas,
): CapabilityManifest {
  const capabilities: string[] = [];
  const missing: string[] = [];
  const observed: Array<{ id: string; description?: string; schemaKind?: string }> = [];

  for (const requirement of REQUIRED_CAPABILITIES) {
    const toolSchema = tools[requirement.tool];
    const field = "fieldPath" in requirement
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
  const inputSchemaFingerprint = registeredSchemaFingerprint(tools);
  const manifestSha256 = createHash("sha256")
    .update(JSON.stringify({ schema: CAPABILITY_MANIFEST_SCHEMA, observed, inputSchemaFingerprint }))
    .digest("hex");
  return { schema: CAPABILITY_MANIFEST_SCHEMA, capabilities, missing, manifestSha256, inputSchemaFingerprint };
}
