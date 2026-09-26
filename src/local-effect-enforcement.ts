import { createHash } from "node:crypto";
import {
  normalizeToolIntentSet,
  type ToolIntentId,
} from "./execution-protocol.js";

export const LOCAL_EFFECT_PROJECTION_SCHEMA = "devspace.local_effect_projection.v1" as const;
export const LOCAL_EFFECT_ENFORCEMENT_RECEIPT_SCHEMA =
  "devspace.local_effect_enforcement_receipt.v1" as const;

export interface LocalEffectProjection {
  schema: typeof LOCAL_EFFECT_PROJECTION_SCHEMA;
  /** Worker-controlled process execution; provider transport processes are outside this effect surface. */
  process: { mode: "DENY" };
  /** Worker/tool egress only; the selected provider's model transport remains the execution channel. */
  network: { egress: "DENY" };
  /** Repository mutation/integration effects, including Git commands and direct .git writes. */
  git: { mode: "DENY" };
}

export interface LocalEffectEnforcementReceipt {
  schema: typeof LOCAL_EFFECT_ENFORCEMENT_RECEIPT_SCHEMA;
  /** v1 is emitted only by the one currently proven native hard-effect provider path. */
  provider: "omp";
  model: string | null;
  writeMode: string;
  enforcementMode: "ENFORCED_NATIVE_PROVIDER";
  selectedToolIntents: ToolIntentId[];
  writePaths: string[];
  process: LocalEffectProjection["process"];
  network: LocalEffectProjection["network"];
  git: LocalEffectProjection["git"];
  enforcementSurface: unknown;
  enforcementSurfaceHash: string;
  authorityKind: "DERIVED_ENFORCEMENT_EVIDENCE_ONLY";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function exactKeys(record: Record<string, unknown>, expected: string[], field: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.join("\n") !== wanted.join("\n")) {
    throw new Error(`${field} fields must be exactly: ${wanted.join(", ")}.`);
  }
}

export function parseLocalEffectProjection(value: unknown): LocalEffectProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("executionContract.effectProjection must be an object.");
  }
  const record = value as Record<string, unknown>;
  exactKeys(record, ["schema", "process", "network", "git"], "executionContract.effectProjection");
  if (record.schema !== LOCAL_EFFECT_PROJECTION_SCHEMA) {
    throw new Error(
      `executionContract.effectProjection.schema must be ${LOCAL_EFFECT_PROJECTION_SCHEMA}.`,
    );
  }

  const process = record.process;
  if (!process || typeof process !== "object" || Array.isArray(process)) {
    throw new Error("executionContract.effectProjection.process must be an object.");
  }
  const processRecord = process as Record<string, unknown>;
  exactKeys(processRecord, ["mode"], "executionContract.effectProjection.process");
  if (processRecord.mode !== "DENY") {
    throw new Error("executionContract.effectProjection.process.mode must be DENY in v1.");
  }

  const network = record.network;
  if (!network || typeof network !== "object" || Array.isArray(network)) {
    throw new Error("executionContract.effectProjection.network must be an object.");
  }
  const networkRecord = network as Record<string, unknown>;
  exactKeys(networkRecord, ["egress"], "executionContract.effectProjection.network");
  if (networkRecord.egress !== "DENY") {
    throw new Error("executionContract.effectProjection.network.egress must be DENY in v1.");
  }

  const git = record.git;
  if (!git || typeof git !== "object" || Array.isArray(git)) {
    throw new Error("executionContract.effectProjection.git must be an object.");
  }
  const gitRecord = git as Record<string, unknown>;
  exactKeys(gitRecord, ["mode"], "executionContract.effectProjection.git");
  if (gitRecord.mode !== "DENY") {
    throw new Error("executionContract.effectProjection.git.mode must be DENY in v1.");
  }

  return {
    schema: LOCAL_EFFECT_PROJECTION_SCHEMA,
    process: { mode: "DENY" },
    network: { egress: "DENY" },
    git: { mode: "DENY" },
  };
}

export function assertLocalEffectProjectionCoherence(
  projection: LocalEffectProjection | undefined,
  selectedToolIntents: ToolIntentId[] | undefined,
  writePaths: string[] | undefined,
): void {
  if (!projection) return;
  if (!selectedToolIntents) {
    throw new Error(
      "executionContract.effectProjection requires toolProjectionManifest.selectedTools.",
    );
  }
  const selected = new Set(selectedToolIntents);
  if (selected.has("process.execute")) {
    throw new Error(
      "effectProjection cannot select process.execute because DevSpace has no proven OS process/network isolation seam.",
    );
  }
  if (selected.has("workspace.mutate") && !(writePaths?.length)) {
    throw new Error(
      "selected workspace.mutate requires executionContract.writePaths for hard local effect enforcement.",
    );
  }
  if (writePaths?.some((path) => path === ".git" || path.startsWith(".git/"))) {
    throw new Error(
      "executionContract.writePaths must not include .git under local effect enforcement.",
    );
  }
  if (writePaths?.some((path) => /[\\*?\[\]{}]/u.test(path))) {
    throw new Error(
      "executionContract.writePaths must be literal POSIX-style paths without glob metacharacters under local effect enforcement.",
    );
  }
}

function receiptMaterial(input: {
  provider: string;
  model: string | null;
  writeMode: string;
  selectedToolIntents: ToolIntentId[];
  writePaths: string[];
  process: LocalEffectProjection["process"];
  network: LocalEffectProjection["network"];
  git: LocalEffectProjection["git"];
  enforcementSurface: unknown;
}): unknown {
  return {
    provider: input.provider,
    model: input.model,
    writeMode: input.writeMode,
    selectedToolIntents: input.selectedToolIntents,
    writePaths: input.writePaths,
    process: input.process,
    network: input.network,
    git: input.git,
    enforcementSurface: input.enforcementSurface,
  };
}

export function buildLocalEffectEnforcementReceipt(input: {
  provider: "omp";
  model?: string;
  writeMode?: string;
  selectedToolIntents: ToolIntentId[];
  writePaths?: string[];
  effectProjection: LocalEffectProjection;
  enforcementSurface: unknown;
}): LocalEffectEnforcementReceipt {
  const selectedToolIntents = normalizeToolIntentSet(
    input.selectedToolIntents,
    "effect enforcement selectedToolIntents",
  );
  const writePaths = [...(input.writePaths ?? [])].sort();
  const projection = parseLocalEffectProjection(input.effectProjection);
  const material = receiptMaterial({
    provider: input.provider,
    model: input.model ?? null,
    writeMode: input.writeMode ?? "read_only",
    selectedToolIntents,
    writePaths,
    process: projection.process,
    network: projection.network,
    git: projection.git,
    enforcementSurface: input.enforcementSurface,
  });
  return {
    schema: LOCAL_EFFECT_ENFORCEMENT_RECEIPT_SCHEMA,
    provider: input.provider,
    model: input.model ?? null,
    writeMode: input.writeMode ?? "read_only",
    enforcementMode: "ENFORCED_NATIVE_PROVIDER",
    selectedToolIntents,
    writePaths,
    process: projection.process,
    network: projection.network,
    git: projection.git,
    enforcementSurface: input.enforcementSurface,
    enforcementSurfaceHash: sha256(material),
    authorityKind: "DERIVED_ENFORCEMENT_EVIDENCE_ONLY",
  };
}

export function parseLocalEffectEnforcementReceipt(
  value: unknown,
): LocalEffectEnforcementReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "schema",
    "provider",
    "model",
    "writeMode",
    "enforcementMode",
    "selectedToolIntents",
    "writePaths",
    "process",
    "network",
    "git",
    "enforcementSurface",
    "enforcementSurfaceHash",
    "authorityKind",
  ];
  if (Object.keys(record).sort().join("\n") !== expectedKeys.sort().join("\n")) return undefined;
  if (
    record.schema !== LOCAL_EFFECT_ENFORCEMENT_RECEIPT_SCHEMA ||
    record.provider !== "omp" ||
    (record.model !== null && typeof record.model !== "string") ||
    typeof record.writeMode !== "string" ||
    !record.writeMode ||
    record.enforcementMode !== "ENFORCED_NATIVE_PROVIDER" ||
    !Array.isArray(record.selectedToolIntents) ||
    !Array.isArray(record.writePaths) ||
    !record.writePaths.every((entry) => typeof entry === "string") ||
    typeof record.enforcementSurfaceHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.enforcementSurfaceHash) ||
    record.authorityKind !== "DERIVED_ENFORCEMENT_EVIDENCE_ONLY"
  ) {
    return undefined;
  }

  try {
    const selectedToolIntents = normalizeToolIntentSet(
      record.selectedToolIntents as string[],
      "effect enforcement selectedToolIntents",
    );
    const writePaths = [...(record.writePaths as string[])].sort();
    if (
      writePaths.length !== (record.writePaths as string[]).length ||
      writePaths.some((path, index) => path !== (record.writePaths as string[])[index])
    ) {
      return undefined;
    }
    const projection = parseLocalEffectProjection({
      schema: LOCAL_EFFECT_PROJECTION_SCHEMA,
      process: record.process,
      network: record.network,
      git: record.git,
    });
    const material = receiptMaterial({
      provider: "omp",
      model: record.model as string | null,
      writeMode: record.writeMode as string,
      selectedToolIntents,
      writePaths,
      process: projection.process,
      network: projection.network,
      git: projection.git,
      enforcementSurface: record.enforcementSurface,
    });
    if (sha256(material) !== record.enforcementSurfaceHash) return undefined;
    return {
      schema: LOCAL_EFFECT_ENFORCEMENT_RECEIPT_SCHEMA,
      provider: "omp",
      model: record.model as string | null,
      writeMode: record.writeMode as string,
      enforcementMode: "ENFORCED_NATIVE_PROVIDER",
      selectedToolIntents,
      writePaths,
      process: projection.process,
      network: projection.network,
      git: projection.git,
      enforcementSurface: record.enforcementSurface,
      enforcementSurfaceHash: record.enforcementSurfaceHash as string,
      authorityKind: "DERIVED_ENFORCEMENT_EVIDENCE_ONLY",
    };
  } catch {
    return undefined;
  }
}

// ─── Tool Exposure Receipt (nexus.tool_exposure_receipt.v1) ─────────────────

export const TOOL_EXPOSURE_RECEIPT_SCHEMA = "nexus.tool_exposure_receipt.v1" as const;
export const STABLE_TOOL_IDENTITY_SCHEMA = "nexus.stable_tool_identity.v1" as const;
export const RUNTIME_TOOL_GENERATION_SCHEMA = "nexus.runtime_tool_generation.v1" as const;

export type ToolExposureEnforcementMode =
  | "ENFORCED_NATIVE_PROVIDER"
  | "ENFORCED_MANAGED_BRIDGE"
  | "REQUEST_ONLY_NOT_ENFORCED"
  | "NOT_OBSERVED"
  | "NO_EXTERNAL_TOOL_SURFACE"
  | "UNKNOWN";

export interface StableToolIdentity {
  schema: typeof STABLE_TOOL_IDENTITY_SCHEMA;
  server_origin: string;
  tool_name: string;
  input_schema_hash: string;
  description_hash: string;
  stable_tool_id: string;
}

export interface RuntimeToolGeneration {
  schema: typeof RUNTIME_TOOL_GENERATION_SCHEMA;
  server_origin: string;
  server_instance_id: string;
  catalog_generation: number | string;
  generation_hash: string;
  observed_at: string;
}

export interface ToolExposureReceipt {
  schema: typeof TOOL_EXPOSURE_RECEIPT_SCHEMA;
  operation_id: string;
  attempt_id: string;
  provider: string;
  backend_id: string;
  planner_decision_hash: string;
  projection_hash: string;
  enforcement_mode: ToolExposureEnforcementMode;
  candidate_tools: string[];
  selected_tools: string[];
  actual_exposed_tools: string[];
  actual_exposed_tool_count: number;
  authority_kind: "DERIVED_EXPOSURE_EVIDENCE_ONLY";
  remote_tool_identities?: StableToolIdentity[];
  runtime_tool_generations?: RuntimeToolGeneration[];
  exposure_hash: string;
}

export class ToolExposureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExposureError";
  }
}

export class ToolExposureWidenedError extends ToolExposureError {
  constructor(message: string) {
    super(message);
    this.name = "ToolExposureWidenedError";
  }
}

export class ToolExposureIdentityError extends ToolExposureError {
  constructor(message: string) {
    super(message);
    this.name = "ToolExposureIdentityError";
  }
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function requireHex64(value: unknown, fieldName: string): string {
  const text = String(value || "");
  if (!SHA256_HEX_RE.test(text)) {
    throw new ToolExposureIdentityError(`${fieldName}_invalid: expected 64-hex sha256`);
  }
  return text;
}

function requireText(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolExposureIdentityError(`${fieldName}_invalid: non-empty string required`);
  }
  return value.trim();
}

export function validateStableToolIdentity(val: unknown): StableToolIdentity {
  if (!val || typeof val !== "object" || Array.isArray(val)) {
    throw new ToolExposureError("STABLE_TOOL_IDENTITY_NOT_MAPPING");
  }
  const r = val as Record<string, unknown>;
  if (r.schema !== STABLE_TOOL_IDENTITY_SCHEMA) {
    throw new ToolExposureError("STABLE_TOOL_IDENTITY_SCHEMA_INVALID");
  }
  const origin = requireText(r.server_origin, "server_origin");
  const name = requireText(r.tool_name, "tool_name");
  const sHash = requireHex64(r.input_schema_hash, "input_schema_hash");
  const dHash = requireHex64(r.description_hash, "description_hash");
  const stableId = requireHex64(r.stable_tool_id, "stable_tool_id");
  return {
    schema: STABLE_TOOL_IDENTITY_SCHEMA,
    server_origin: origin,
    tool_name: name,
    input_schema_hash: sHash,
    description_hash: dHash,
    stable_tool_id: stableId,
  };
}

export function validateRuntimeToolGeneration(val: unknown): RuntimeToolGeneration {
  if (!val || typeof val !== "object" || Array.isArray(val)) {
    throw new ToolExposureError("RUNTIME_TOOL_GENERATION_NOT_MAPPING");
  }
  const r = val as Record<string, unknown>;
  if (r.schema !== RUNTIME_TOOL_GENERATION_SCHEMA) {
    throw new ToolExposureError("RUNTIME_TOOL_GENERATION_SCHEMA_INVALID");
  }
  const origin = requireText(r.server_origin, "server_origin");
  const instanceId = requireText(r.server_instance_id, "server_instance_id");
  if (typeof r.catalog_generation !== "number" && typeof r.catalog_generation !== "string") {
    throw new ToolExposureError("catalog_generation_invalid");
  }
  const catGen = typeof r.catalog_generation === "number" ? r.catalog_generation : requireText(r.catalog_generation, "catalog_generation");
  const genHash = requireHex64(r.generation_hash, "generation_hash");
  const obsAt = requireText(r.observed_at, "observed_at");
  return {
    schema: RUNTIME_TOOL_GENERATION_SCHEMA,
    server_origin: origin,
    server_instance_id: instanceId,
    catalog_generation: catGen,
    generation_hash: genHash,
    observed_at: obsAt,
  };
}

/**
 * Builds a canonical ToolExposureReceipt matching nexus.tool_exposure_receipt.v1.
 */
export function buildToolExposureReceipt(input: {
  operation_id: string;
  attempt_id: string;
  provider: string;
  backend_id: string;
  planner_decision_hash: string;
  projection_hash: string;
  enforcement_mode: ToolExposureEnforcementMode;
  candidate_tools: string[];
  selected_tools: string[];
  actual_exposed_tools: string[];
  remote_tool_identities?: StableToolIdentity[];
  runtime_tool_generations?: RuntimeToolGeneration[];
}): ToolExposureReceipt {
  const opId = requireText(input.operation_id, "operation_id");
  const attId = requireText(input.attempt_id, "attempt_id");
  const prov = requireText(input.provider, "provider");
  const backend = requireText(input.backend_id, "backend_id");
  const decHash = requireHex64(input.planner_decision_hash, "planner_decision_hash");
  const projHash = requireHex64(input.projection_hash, "projection_hash");

  const candidates = Array.from(new Set(input.candidate_tools)).sort();
  const selected = Array.from(new Set(input.selected_tools)).sort();
  const actual = Array.from(new Set(input.actual_exposed_tools)).sort();

  const candidateSet = new Set(candidates);
  for (const s of selected) {
    if (!candidateSet.has(s)) {
      throw new ToolExposureWidenedError("SELECTED_TOOLS_EXCEED_CANDIDATE_TOOLS");
    }
  }

  const selectedSet = new Set(selected);
  for (const a of actual) {
    if (!selectedSet.has(a)) {
      throw new ToolExposureWidenedError("ACTUAL_EXPOSED_TOOLS_EXCEED_SELECTED_TOOLS");
    }
  }

  const validatedRemote = (input.remote_tool_identities || []).map(validateStableToolIdentity);
  validatedRemote.sort((a, b) => {
    if (a.server_origin !== b.server_origin) return a.server_origin.localeCompare(b.server_origin);
    if (a.tool_name !== b.tool_name) return a.tool_name.localeCompare(b.tool_name);
    return a.stable_tool_id.localeCompare(b.stable_tool_id);
  });

  const validatedGens = (input.runtime_tool_generations || []).map(validateRuntimeToolGeneration);
  validatedGens.sort((a, b) => {
    if (a.server_origin !== b.server_origin) return a.server_origin.localeCompare(b.server_origin);
    const genA = String(a.catalog_generation);
    const genB = String(b.catalog_generation);
    if (genA !== genB) return genA.localeCompare(genB);
    return a.server_instance_id.localeCompare(b.server_instance_id);
  });

  const material: Record<string, unknown> = {
    schema: TOOL_EXPOSURE_RECEIPT_SCHEMA,
    operation_id: opId,
    attempt_id: attId,
    provider: prov,
    backend_id: backend,
    planner_decision_hash: decHash,
    projection_hash: projHash,
    enforcement_mode: input.enforcement_mode,
    candidate_tools: candidates,
    selected_tools: selected,
    actual_exposed_tools: actual,
    actual_exposed_tool_count: actual.length,
    authority_kind: "DERIVED_EXPOSURE_EVIDENCE_ONLY",
    ...(validatedRemote.length > 0 ? { remote_tool_identities: validatedRemote } : {}),
    ...(validatedGens.length > 0 ? { runtime_tool_generations: validatedGens } : {}),
  };

  const exposure_hash = createHash("sha256")
    .update(canonicalJson(material))
    .digest("hex");

  return {
    ...material,
    exposure_hash,
  } as ToolExposureReceipt;
}

/**
 * Validates and parses a ToolExposureReceipt from unknown input.
 */
export function parseToolExposureReceipt(value: unknown): ToolExposureReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  if (record.schema !== TOOL_EXPOSURE_RECEIPT_SCHEMA) return undefined;
  if (record.authority_kind !== "DERIVED_EXPOSURE_EVIDENCE_ONLY") return undefined;
  if (typeof record.exposure_hash !== "string" || !SHA256_HEX_RE.test(record.exposure_hash)) {
    return undefined;
  }

  try {
    const opId = requireText(record.operation_id, "operation_id");
    const attId = requireText(record.attempt_id, "attempt_id");
    const prov = requireText(record.provider, "provider");
    const backend = requireText(record.backend_id, "backend_id");
    const decHash = requireHex64(record.planner_decision_hash, "planner_decision_hash");
    const projHash = requireHex64(record.projection_hash, "projection_hash");

    if (
      !Array.isArray(record.candidate_tools) ||
      !Array.isArray(record.selected_tools) ||
      !Array.isArray(record.actual_exposed_tools)
    ) {
      return undefined;
    }

    const candidateTools = record.candidate_tools.filter((t): t is string => typeof t === "string");
    const selectedTools = record.selected_tools.filter((t): t is string => typeof t === "string");
    const actualExposedTools = record.actual_exposed_tools.filter((t): t is string => typeof t === "string");

    if (
      candidateTools.length !== record.candidate_tools.length ||
      selectedTools.length !== record.selected_tools.length ||
      actualExposedTools.length !== record.actual_exposed_tools.length ||
      actualExposedTools.length !== record.actual_exposed_tool_count
    ) {
      return undefined;
    }

    // Invariant checks
    const candidateSet = new Set(candidateTools);
    for (const s of selectedTools) {
      if (!candidateSet.has(s)) return undefined;
    }
    const selectedSet = new Set(selectedTools);
    for (const a of actualExposedTools) {
      if (!selectedSet.has(a)) return undefined;
    }

    if (record.remote_tool_identities !== undefined) {
      if (!Array.isArray(record.remote_tool_identities)) return undefined;
      for (const r of record.remote_tool_identities) {
        validateStableToolIdentity(r);
      }
    }

    if (record.runtime_tool_generations !== undefined) {
      if (!Array.isArray(record.runtime_tool_generations)) return undefined;
      for (const g of record.runtime_tool_generations) {
        validateRuntimeToolGeneration(g);
      }
    }

    // Verify exposure_hash
    const material: Record<string, unknown> = { ...record };
    delete material.exposure_hash;
    const computedHash = createHash("sha256")
      .update(canonicalJson(material))
      .digest("hex");
    if (computedHash !== record.exposure_hash) {
      return undefined;
    }

    return record as unknown as ToolExposureReceipt;
  } catch {
    return undefined;
  }
}

