import { createHash } from "node:crypto";
import {
  type ToolIntentId,
  TOOL_INTENT_IDS,
} from "./execution-protocol.js";

export const TOOL_EXPOSURE_RECEIPT_SCHEMA = "nexus.tool_exposure_receipt.v1" as const;

export type ToolExposureEnforcementMode =
  | "ENFORCED_NATIVE_PROVIDER"
  | "ENFORCED_MANAGED_BRIDGE"
  | "REQUEST_ONLY_NOT_ENFORCED"
  | "NOT_OBSERVED"
  | "NO_EXTERNAL_TOOL_SURFACE"
  | "UNKNOWN";

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

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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

/**
 * Maps ToolIntentId to OpenCode physical tool permission names.
 * Returns only tools that are physically enabled (allowed).
 */
export function mapSelectedIntentsToOpencodeTools(
  selectedToolIntents?: ToolIntentId[],
  writeMode?: "read_only" | "allowed",
): string[] {
  const allowed = writeMode !== "read_only";
  if (selectedToolIntents === undefined) {
    const defaultTools = ["glob", "grep", "list", "read"];
    if (allowed) {
      defaultTools.push("bash", "edit");
    }
    return defaultTools.sort();
  }

  const selectedSet = new Set(selectedToolIntents);
  const exposed: string[] = [];
  if (selectedSet.has("workspace.read")) exposed.push("read");
  if (allowed && selectedSet.has("workspace.mutate")) exposed.push("edit");
  if (selectedSet.has("workspace.search_paths")) exposed.push("glob");
  if (selectedSet.has("workspace.search_text")) exposed.push("grep");
  if (selectedSet.has("workspace.list")) exposed.push("list");
  if (allowed && selectedSet.has("process.execute")) exposed.push("bash");

  return exposed.sort();
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

/**
 * Builds the canonical HerdR tool exposure receipt for an agent launch.
 */
export function buildHerdrToolExposureReceipt(input: {
  agentKind: string;
  attemptKey: string;
  dispatchIntent?: { taskId: string; attemptId: string };
  dispatchIntentHash: string;
  toolProjectionManifest?: {
    candidateTools: ToolIntentId[];
    selectedTools: ToolIntentId[];
  };
  selectedToolIntents?: ToolIntentId[];
  writeMode?: "read_only" | "allowed";
}): ToolExposureReceipt {
  const {
    agentKind,
    attemptKey,
    dispatchIntent,
    dispatchIntentHash,
    toolProjectionManifest,
    selectedToolIntents,
    writeMode,
  } = input;

  const operationId = dispatchIntent?.taskId ?? attemptKey;
  const attemptId = dispatchIntent?.attemptId ?? attemptKey;
  const plannerDecisionHash = dispatchIntentHash;

  // Projection hash: if toolProjectionManifest is present, hash it; else hash the selectedToolIntents or attempt
  let projectionHash: string;
  if (toolProjectionManifest) {
    projectionHash = createHash("sha256")
      .update(canonicalJson(toolProjectionManifest))
      .digest("hex");
  } else {
    projectionHash = createHash("sha256")
      .update(canonicalJson({ attemptKey, selectedToolIntents: selectedToolIntents ?? [] }))
      .digest("hex");
  }

  // Derive candidate and selected tool lists
  let candidateTools: string[];
  let selectedTools: string[];

  if (toolProjectionManifest) {
    candidateTools = Array.from(new Set(toolProjectionManifest.candidateTools)).sort();
    selectedTools = Array.from(new Set(toolProjectionManifest.selectedTools)).sort();
  } else if (selectedToolIntents) {
    candidateTools = Array.from(new Set(TOOL_INTENT_IDS)).sort();
    selectedTools = Array.from(new Set(selectedToolIntents)).sort();
  } else {
    candidateTools = Array.from(new Set(TOOL_INTENT_IDS)).sort();
    selectedTools = Array.from(new Set(TOOL_INTENT_IDS)).sort();
  }

  if (agentKind === "opencode") {
    // OpenCode has managed bridge enforcement via opencodeAgentConfig
    // Note: candidate/selected tool intents (like workspace.read) map to actual tool names (like read).
    // To maintain actual <= selected <= candidates, candidates and selected for the physical receipt
    // represent the physical tool namespace when mapped, or intent namespace.
    // In Nexus contracts: candidate_tools and selected_tools contain tool names.
    // For OpenCode: candidate tool names: ["bash", "edit", "glob", "grep", "list", "read"]
    // selected tool names: mapped from selectedToolIntents
    // actual_exposed_tools: mapped and allowed
    const physicalCandidates = ["bash", "edit", "glob", "grep", "list", "read"];
    // Map selectedToolIntents to physical tools
    const physicalSelected = mapSelectedIntentsToOpencodeTools(
      selectedToolIntents ?? (toolProjectionManifest?.selectedTools),
      "allowed", // All selected tools regardless of writeMode
    );
    // Filter physicalSelected by physicalCandidates
    const validSelected = physicalSelected.filter((t) => physicalCandidates.includes(t));

    // Actual exposed tools respects writeMode (e.g. read_only forbids edit and bash)
    const actualExposed = mapSelectedIntentsToOpencodeTools(
      selectedToolIntents ?? (toolProjectionManifest?.selectedTools),
      writeMode,
    ).filter((t) => validSelected.includes(t));

    return buildToolExposureReceipt({
      operation_id: operationId,
      attempt_id: attemptId,
      provider: agentKind,
      backend_id: "herdr",
      planner_decision_hash: plannerDecisionHash,
      projection_hash: projectionHash,
      enforcement_mode: "ENFORCED_MANAGED_BRIDGE",
      candidate_tools: physicalCandidates,
      selected_tools: validSelected,
      actual_exposed_tools: actualExposed,
    });
  }

  // Unsupported or CLI providers (agy, codex, grok, cline)
  // Fail closed as REQUEST_ONLY_NOT_ENFORCED with actual_exposed_tools = []
  return buildToolExposureReceipt({
    operation_id: operationId,
    attempt_id: attemptId,
    provider: agentKind,
    backend_id: "herdr",
    planner_decision_hash: plannerDecisionHash,
    projection_hash: projectionHash,
    enforcement_mode: "REQUEST_ONLY_NOT_ENFORCED",
    candidate_tools: candidateTools,
    selected_tools: selectedTools,
    actual_exposed_tools: [],
  });
}
