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
