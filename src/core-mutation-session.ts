import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type { CapabilityDiscoveryReceipt } from "./capability-discovery.js";

const execFileAsync = promisify(execFile);

export const CORE_MUTATION_BINDING_SCHEMA = "nexus.repository_mutation_binding.v1" as const;
export const NEXUS_CORE_PROTOCOL_VERSION = "0.1.0-experimental" as const;
export const NEXUS_CORE_PROTOCOL_CANDIDATE =
  "James3014/nexus-core@5e54a243b6f1e26824880a11ef4138812c623c78 (semantic-lineage:8ce871463fd3571d5d39dde9ac698c515dd47e)" as const;
export const CORE_CHANGE_MANIFEST_SCHEMA =
  "nexus.core.git-change-manifest.v1-experimental" as const;

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const GIT_COMMIT_RE = /^git-commit:([0-9a-f]{40})$/;
const GIT_TREE_RE = /^git-tree:([0-9a-f]{40})$/;
const GIT_OID_RE = /^[0-9a-f]{40}$/;
const GIT_MODE_RE = /^[0-7]{6}$/;

export type CoreMutationWorkspaceMode = "checkout" | "managed_worktree" | "target";
export type CoreMutationExecutionLane = "DIRECT_CANONICAL" | "DIRECT_DELEGATED" | "GOVERNED";
export type CoreMutationSessionStatus = "ACTIVE" | "COMPLETED" | "ABANDONED";
export type CoreMutationFreshnessState = "FRESH" | "EXPIRED";
export type CoreMutationRebindState = "BOUND_CURRENT" | "REBIND_REQUIRED";
export type CoreMutationWriterReconciliationState = "CLEAR" | "OUTCOME_UNKNOWN";
export type CoreMutationManagedWriterDomain = "PROCESS" | "AGENT";
export type CoreMutationWriterDomain = CoreMutationManagedWriterDomain | "SYNCHRONOUS_GIT";

export interface CoreAcceptanceContractWire {
  contract_id: string;
  requirements_hash: string;
  required_verifier_ids: string[];
  allowed_paths: string[];
  deletion_policy: "FORBID" | "ALLOW";
}

export interface RepositoryMutationBinding {
  schema: typeof CORE_MUTATION_BINDING_SCHEMA;
  binding_id: string;
  operation_id: string;
  attempt_id: string;
  repository: {
    canonical_id: string;
    origin: string;
    source_revision: string;
    source_tree: string;
    workspace_identity: string;
    workspace_mode: CoreMutationWorkspaceMode;
  };
  integration_authority: {
    execution_lane: CoreMutationExecutionLane;
    authority_ref: string;
    authority_hash: string;
  };
  capability_discovery: {
    required: true;
    receipt_hash: string;
    index_revision: string;
  };
  core: {
    protocol_version: string;
    acceptance_contract: CoreAcceptanceContractWire;
    acceptance_contract_hash: string;
  };
  freshness: {
    created_at: string;
    valid_until: string | null;
    revalidate_before_first_effect: true;
  };
  binding_hash: string;
}

export interface CoreMutationSessionRecord {
  id: string;
  workspaceSessionId: string;
  actorKey: string;
  bindingId: string;
  operationId: string;
  attemptId: string;
  bindingHash: string;
  binding: RepositoryMutationBinding;
  sourceHead: string;
  sourceTree: string;
  status: CoreMutationSessionStatus;
  freshnessState: CoreMutationFreshnessState;
  rebindState: CoreMutationRebindState;
  writerReconciliationState: CoreMutationWriterReconciliationState;
  writerDomains: CoreMutationWriterDomain[];
  firstEffectAt?: string;
  lastEffectAt?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface CoreMutationAdmission {
  bound: true;
  sessionId: string;
  bindingHash: string;
  acceptanceContractHash: string;
  claim: "CORE_BOUND_SESSION";
  pathContainment: "STRUCTURED_SINK_ENFORCED" | "NOT_PROVEN";
}

export interface CoreChangeManifestEntry {
  path: string;
  change_type: "ADD" | "MODIFY" | "DELETE";
  before_oid: string | null;
  after_oid: string | null;
  before_mode: string | null;
  after_mode: string | null;
}

export interface CoreChangeSetWire {
  change_set_id: string;
  source_revision: string;
  target_revision: string;
  diff_hash: string;
  paths: string[];
  deleted_paths: string[];
}

export interface CoreMutationPhysicalSnapshot {
  sessionId: string;
  bindingHash: string;
  acceptanceContractHash: string;
  sourceRevision: string;
  sourceTree: string;
  targetRevision: string;
  targetTree: string;
  currentHead: string;
  currentHeadTree: string;
  dirty: boolean;
  changedPaths: string[];
  deletedPaths: string[];
  scopeEscapePaths: string[];
  deletionViolation: boolean;
  diffHash: string;
  changeSetId: string;
  changeSetHash: string;
  changeSet: CoreChangeSetWire;
  provenance: {
    operationId: string;
    attemptId: string;
    workspaceSessionId: string;
    bindingId: string;
    bindingHash: string;
  };
  changeManifest: {
    schema: typeof CORE_CHANGE_MANIFEST_SCHEMA;
    source_tree: string;
    target_tree: string;
    entries: CoreChangeManifestEntry[];
    manifest_hash: string;
  };
  materializedGitObjects: boolean;
  objectStorage: "CALLER_EXISTING" | "ISOLATED_TEMPORARY";
}

export interface CoreMutationCandidateProvenance {
  candidateHead: string;
  candidateTree: string;
  sessionId: string;
  workspaceSessionId: string;
  bindingHash: string;
  acceptanceContractHash: string;
  sourceHead: string;
  sourceTree: string;
  changedPaths: string[];
  deletedPaths: string[];
  diffHash: string;
  changeSetId: string;
  changeSetHash: string;
  changeManifestHash: string;
  createdAt: string;
}

export class CoreMutationSessionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CoreMutationSessionError";
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function jsonStringAscii(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function coreCanonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return jsonStringAscii(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(coreCanonicalJson).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${jsonStringAscii(key)}:${coreCanonicalJson(value[key]!)}`);
  return `{${entries.join(",")}}`;
}

export function coreCanonicalHash(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(coreCanonicalJson(value), "utf8").digest("hex")}`;
}

export function acceptanceContractHash(contract: CoreAcceptanceContractWire): string {
  return coreCanonicalHash([
    contract.contract_id,
    contract.requirements_hash,
    [...contract.required_verifier_ids].sort(),
    [...contract.allowed_paths].sort(),
    contract.deletion_policy,
  ]);
}

export function coreChangeSetHash(changeSet: CoreChangeSetWire): string {
  const canonical: JsonValue[] = [
    changeSet.change_set_id,
    changeSet.source_revision,
    changeSet.target_revision,
    changeSet.diff_hash,
    [...changeSet.paths].sort(),
  ];
  if (changeSet.deleted_paths.length > 0) canonical.push([...changeSet.deleted_paths].sort());
  return coreCanonicalHash(canonical);
}

function bindingHash(binding: Omit<RepositoryMutationBinding, "binding_hash">): string {
  return coreCanonicalHash(binding as unknown as JsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new CoreMutationSessionError("MALFORMED_BINDING", `${field} has unexpected or missing fields.`);
  }
}

function nonEmptyText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\0")) {
    throw new CoreMutationSessionError("MALFORMED_BINDING", `${field} must be non-empty normalized text.`);
  }
  return value;
}

function hashText(value: unknown, field: string): string {
  const text = nonEmptyText(value, field);
  if (!HASH_RE.test(text)) {
    throw new CoreMutationSessionError("MALFORMED_BINDING", `${field} must be sha256:<64 lowercase hex>.`);
  }
  return text;
}

function relativePath(value: unknown, field: string): string {
  const path = nonEmptyText(value, field);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new CoreMutationSessionError("MALFORMED_BINDING", `${field} must be a normalized repository-relative path.`);
  }
  return path;
}

function uniqueTextArray(value: unknown, field: string, mapper = nonEmptyText): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CoreMutationSessionError("MALFORMED_BINDING", `${field} must be a non-empty array.`);
  }
  const mapped = value.map((item, index) => mapper(item, `${field}[${index}]`));
  if (new Set(mapped).size !== mapped.length) {
    throw new CoreMutationSessionError("MALFORMED_BINDING", `${field} must not contain duplicates.`);
  }
  return mapped;
}

function isoTimestamp(value: unknown, field: string): string {
  const text = nonEmptyText(value, field);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) {
    throw new CoreMutationSessionError("MALFORMED_BINDING", `${field} must be an RFC3339 timestamp.`);
  }
  return text;
}

export function parseRepositoryMutationBinding(input: unknown): RepositoryMutationBinding {
  if (!isRecord(input)) throw new CoreMutationSessionError("MALFORMED_BINDING", "binding must be an object.");
  exactKeys(input, [
    "schema",
    "binding_id",
    "operation_id",
    "attempt_id",
    "repository",
    "integration_authority",
    "capability_discovery",
    "core",
    "freshness",
    "binding_hash",
  ], "binding");
  if (input.schema !== CORE_MUTATION_BINDING_SCHEMA) {
    throw new CoreMutationSessionError("UNSUPPORTED_BINDING_SCHEMA", `Expected ${CORE_MUTATION_BINDING_SCHEMA}.`);
  }

  const repository = input.repository;
  const authority = input.integration_authority;
  const discovery = input.capability_discovery;
  const core = input.core;
  const freshness = input.freshness;
  if (!isRecord(repository) || !isRecord(authority) || !isRecord(discovery) || !isRecord(core) || !isRecord(freshness)) {
    throw new CoreMutationSessionError("MALFORMED_BINDING", "binding nested objects are required.");
  }
  exactKeys(repository, ["canonical_id", "origin", "source_revision", "source_tree", "workspace_identity", "workspace_mode"], "repository");
  exactKeys(authority, ["execution_lane", "authority_ref", "authority_hash"], "integration_authority");
  exactKeys(discovery, ["required", "receipt_hash", "index_revision"], "capability_discovery");
  exactKeys(core, ["protocol_version", "acceptance_contract", "acceptance_contract_hash"], "core");
  exactKeys(freshness, ["created_at", "valid_until", "revalidate_before_first_effect"], "freshness");

  const contractInput = core.acceptance_contract;
  if (!isRecord(contractInput)) throw new CoreMutationSessionError("MALFORMED_BINDING", "core.acceptance_contract must be an object.");
  exactKeys(contractInput, ["contract_id", "requirements_hash", "required_verifier_ids", "allowed_paths", "deletion_policy"], "core.acceptance_contract");
  const contract: CoreAcceptanceContractWire = {
    contract_id: nonEmptyText(contractInput.contract_id, "core.acceptance_contract.contract_id"),
    requirements_hash: hashText(contractInput.requirements_hash, "core.acceptance_contract.requirements_hash"),
    required_verifier_ids: uniqueTextArray(contractInput.required_verifier_ids, "core.acceptance_contract.required_verifier_ids"),
    allowed_paths: uniqueTextArray(contractInput.allowed_paths, "core.acceptance_contract.allowed_paths", relativePath),
    deletion_policy: contractInput.deletion_policy === "FORBID" || contractInput.deletion_policy === "ALLOW"
      ? contractInput.deletion_policy
      : (() => { throw new CoreMutationSessionError("MALFORMED_BINDING", "core.acceptance_contract.deletion_policy must be FORBID or ALLOW."); })(),
  };

  const sourceRevision = nonEmptyText(repository.source_revision, "repository.source_revision");
  const sourceTree = nonEmptyText(repository.source_tree, "repository.source_tree");
  if (!GIT_COMMIT_RE.test(sourceRevision)) {
    throw new CoreMutationSessionError("MALFORMED_BINDING", "repository.source_revision must be git-commit:<40 lowercase hex>.");
  }
  if (!GIT_TREE_RE.test(sourceTree)) {
    throw new CoreMutationSessionError("MALFORMED_BINDING", "repository.source_tree must be git-tree:<40 lowercase hex>.");
  }
  const workspaceMode = repository.workspace_mode;
  if (workspaceMode !== "checkout" && workspaceMode !== "managed_worktree" && workspaceMode !== "target") {
    throw new CoreMutationSessionError("MALFORMED_BINDING", "repository.workspace_mode is invalid.");
  }
  const lane = authority.execution_lane;
  if (lane !== "DIRECT_CANONICAL" && lane !== "DIRECT_DELEGATED" && lane !== "GOVERNED") {
    throw new CoreMutationSessionError("MALFORMED_BINDING", "integration_authority.execution_lane is invalid.");
  }
  if (discovery.required !== true) {
    throw new CoreMutationSessionError("MALFORMED_BINDING", "capability_discovery.required must be true for a mutation session.");
  }
  const indexRevision = nonEmptyText(discovery.index_revision, "capability_discovery.index_revision");
  if (!GIT_COMMIT_RE.test(indexRevision)) {
    throw new CoreMutationSessionError("MALFORMED_BINDING", "capability_discovery.index_revision must be git-commit:<40 lowercase hex>.");
  }
  const protocolVersion = nonEmptyText(core.protocol_version, "core.protocol_version");
  if (protocolVersion !== NEXUS_CORE_PROTOCOL_VERSION) {
    throw new CoreMutationSessionError(
      "CORE_PROTOCOL_REBIND_REQUIRED",
      `Expected Core protocol ${NEXUS_CORE_PROTOCOL_VERSION} from ${NEXUS_CORE_PROTOCOL_CANDIDATE}.`,
    );
  }
  const contractHash = hashText(core.acceptance_contract_hash, "core.acceptance_contract_hash");
  const expectedContractHash = acceptanceContractHash(contract);
  if (contractHash !== expectedContractHash) {
    throw new CoreMutationSessionError("CORE_CONTRACT_HASH_MISMATCH", "AcceptanceContract hash does not match canonical Core serialization.");
  }

  const createdAt = isoTimestamp(freshness.created_at, "freshness.created_at");
  const validUntil = freshness.valid_until === null
    ? null
    : isoTimestamp(freshness.valid_until, "freshness.valid_until");
  if (freshness.revalidate_before_first_effect !== true) {
    throw new CoreMutationSessionError("MALFORMED_BINDING", "freshness.revalidate_before_first_effect must be true.");
  }

  const parsedWithoutHash: Omit<RepositoryMutationBinding, "binding_hash"> = {
    schema: CORE_MUTATION_BINDING_SCHEMA,
    binding_id: nonEmptyText(input.binding_id, "binding_id"),
    operation_id: nonEmptyText(input.operation_id, "operation_id"),
    attempt_id: nonEmptyText(input.attempt_id, "attempt_id"),
    repository: {
      canonical_id: nonEmptyText(repository.canonical_id, "repository.canonical_id"),
      origin: nonEmptyText(repository.origin, "repository.origin"),
      source_revision: sourceRevision,
      source_tree: sourceTree,
      workspace_identity: hashText(repository.workspace_identity, "repository.workspace_identity"),
      workspace_mode: workspaceMode,
    },
    integration_authority: {
      execution_lane: lane,
      authority_ref: nonEmptyText(authority.authority_ref, "integration_authority.authority_ref"),
      authority_hash: hashText(authority.authority_hash, "integration_authority.authority_hash"),
    },
    capability_discovery: {
      required: true,
      receipt_hash: hashText(discovery.receipt_hash, "capability_discovery.receipt_hash"),
      index_revision: indexRevision,
    },
    core: {
      protocol_version: protocolVersion,
      acceptance_contract: contract,
      acceptance_contract_hash: contractHash,
    },
    freshness: {
      created_at: createdAt,
      valid_until: validUntil,
      revalidate_before_first_effect: true,
    },
  };
  const suppliedBindingHash = hashText(input.binding_hash, "binding_hash");
  const expectedBindingHash = bindingHash(parsedWithoutHash);
  if (suppliedBindingHash !== expectedBindingHash) {
    throw new CoreMutationSessionError("BINDING_HASH_MISMATCH", "binding_hash does not match the canonical integration projection.");
  }
  return { ...parsedWithoutHash, binding_hash: suppliedBindingHash };
}

export function computeRepositoryMutationBindingHash(
  binding: Omit<RepositoryMutationBinding, "binding_hash">,
): string {
  return bindingHash(binding);
}

export function computeCoreMutationWorkspaceIdentity(input: {
  workspaceSessionId: string;
  binding: RepositoryMutationBinding;
}): string {
  return coreCanonicalHash([
    "devspace.core-mutation-workspace.v1",
    input.workspaceSessionId,
    input.binding.repository.canonical_id,
    input.binding.repository.source_revision,
    input.binding.repository.source_tree,
    input.binding.repository.workspace_mode,
  ]);
}

export function capabilityDiscoveryReceiptHash(receipt: CapabilityDiscoveryReceipt): string {
  return coreCanonicalHash(receipt as unknown as JsonValue);
}

export function assertCapabilityDiscoveryBinding(
  binding: RepositoryMutationBinding,
  receipt: CapabilityDiscoveryReceipt,
): void {
  const expectedRevision = `git-commit:${receipt.indexRevision}`;
  if (binding.capability_discovery.index_revision !== expectedRevision) {
    throw new CoreMutationSessionError(
      "CAPABILITY_DISCOVERY_BINDING_MISMATCH",
      `Binding discovery revision ${binding.capability_discovery.index_revision} does not match verified receipt ${expectedRevision}.`,
    );
  }
  const observedReceiptHash = capabilityDiscoveryReceiptHash(receipt);
  if (binding.capability_discovery.receipt_hash !== observedReceiptHash) {
    throw new CoreMutationSessionError(
      "CAPABILITY_DISCOVERY_BINDING_MISMATCH",
      "Binding capability-discovery receipt hash does not match the verified receipt.",
    );
  }
}

async function runGit(
  workspaceRoot: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", workspaceRoot, ...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: options.timeoutMs ?? 15_000,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    return String(result.stdout).trimEnd();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CoreMutationSessionError("GIT_READBACK_FAILED", `git ${args.join(" ")} failed: ${detail}`);
  }
}

function normalizeRemoteIdentity(value: string): string {
  const trimmed = value.trim();
  const scp = /^git@([^:]+):(.+)$/.exec(trimmed);
  if (scp) return `${scp[1]!.toLowerCase()}/${scp[2]!.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "")}`;
  try {
    const url = new URL(trimmed);
    return `${url.hostname.toLowerCase()}/${url.pathname.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "")}`;
  } catch {
    return trimmed.replace(/\.git$/, "").replace(/\/+$/g, "");
  }
}

function sourceCommit(binding: RepositoryMutationBinding): string {
  return GIT_COMMIT_RE.exec(binding.repository.source_revision)![1]!;
}

function sourceTree(binding: RepositoryMutationBinding): string {
  return GIT_TREE_RE.exec(binding.repository.source_tree)![1]!;
}

function expectedWorkspaceMode(mode: "checkout" | "worktree", managed: boolean): CoreMutationWorkspaceMode {
  return mode === "worktree" && managed ? "managed_worktree" : "checkout";
}

async function assertPhysicalSource(input: {
  workspaceRoot: string;
  workspaceMode: "checkout" | "worktree";
  managed: boolean;
  binding: RepositoryMutationBinding;
  requireClean: boolean;
}): Promise<{ head: string; tree: string }> {
  const head = (await runGit(input.workspaceRoot, ["rev-parse", "HEAD"])).trim();
  const tree = (await runGit(input.workspaceRoot, ["rev-parse", "HEAD^{tree}"])).trim();
  if (head !== sourceCommit(input.binding)) {
    throw new CoreMutationSessionError("SOURCE_REVISION_MISMATCH", `Workspace HEAD ${head} does not match bound source ${sourceCommit(input.binding)}.`);
  }
  if (tree !== sourceTree(input.binding)) {
    throw new CoreMutationSessionError("SOURCE_TREE_MISMATCH", `Workspace tree ${tree} does not match bound source tree ${sourceTree(input.binding)}.`);
  }
  const actualMode = expectedWorkspaceMode(input.workspaceMode, input.managed);
  if (input.binding.repository.workspace_mode !== actualMode) {
    throw new CoreMutationSessionError("WORKSPACE_MODE_MISMATCH", `Binding expects ${input.binding.repository.workspace_mode}, workspace is ${actualMode}.`);
  }
  const origin = (await runGit(input.workspaceRoot, ["remote", "get-url", "origin"])).trim();
  if (normalizeRemoteIdentity(origin) !== normalizeRemoteIdentity(input.binding.repository.origin)) {
    throw new CoreMutationSessionError("REPOSITORY_ORIGIN_MISMATCH", "Workspace origin does not match bound repository origin.");
  }
  if (input.requireClean) {
    const status = await runGit(input.workspaceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status.trim().length > 0) {
      throw new CoreMutationSessionError(
        "WORKSPACE_NOT_CLEAN_AT_BIND",
        "A Core-bound mutation session can only start from the exact clean bound source; pre-existing changes cannot receive retroactive provenance.",
      );
    }
  }
  return { head, tree };
}

function rowToRecord(row: Record<string, unknown>): CoreMutationSessionRecord {
  const binding = parseRepositoryMutationBinding(JSON.parse(String(row.binding_json)));
  return {
    id: String(row.id),
    workspaceSessionId: String(row.workspace_session_id),
    actorKey: String(row.actor_key),
    bindingId: String(row.binding_id),
    operationId: String(row.operation_id),
    attemptId: String(row.attempt_id),
    bindingHash: String(row.binding_hash),
    binding,
    sourceHead: String(row.source_head),
    sourceTree: String(row.source_tree),
    status: String(row.status) as CoreMutationSessionStatus,
    freshnessState: String(row.freshness_state) as CoreMutationFreshnessState,
    rebindState: String(row.rebind_state) as CoreMutationRebindState,
    writerReconciliationState: String(row.writer_reconciliation_state) as CoreMutationWriterReconciliationState,
    writerDomains: (JSON.parse(String(row.writer_domains_json)) as CoreMutationWriterDomain[]).slice().sort(),
    firstEffectAt: row.first_effect_at ? String(row.first_effect_at) : undefined,
    lastEffectAt: row.last_effect_at ? String(row.last_effect_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    closedAt: row.closed_at ? String(row.closed_at) : undefined,
  };
}

function rowToCandidate(row: Record<string, unknown>): CoreMutationCandidateProvenance {
  return {
    candidateHead: String(row.candidate_head),
    candidateTree: String(row.candidate_tree),
    sessionId: String(row.session_id),
    workspaceSessionId: String(row.workspace_session_id),
    bindingHash: String(row.binding_hash),
    acceptanceContractHash: String(row.acceptance_contract_hash),
    sourceHead: String(row.source_head),
    sourceTree: String(row.source_tree),
    changedPaths: JSON.parse(String(row.changed_paths_json)) as string[],
    deletedPaths: JSON.parse(String(row.deleted_paths_json)) as string[],
    diffHash: String(row.diff_hash),
    changeSetId: String(row.change_set_id),
    changeSetHash: String(row.change_set_hash),
    changeManifestHash: String(row.change_manifest_hash),
    createdAt: String(row.created_at),
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const orderedLeft = [...left].sort();
  const orderedRight = [...right].sort();
  return orderedLeft.every((value, index) => value === orderedRight[index]);
}

export class CoreMutationSessionStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  close(): void {
    this.database.close();
  }

  private getByIdRaw(sessionId: string): CoreMutationSessionRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from core_mutation_sessions where id = ? limit 1")
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getById(sessionId: string, now: Date = new Date()): CoreMutationSessionRecord | undefined {
    const record = this.getByIdRaw(sessionId);
    if (
      record?.status === "ACTIVE" &&
      record.freshnessState === "FRESH" &&
      record.binding.freshness.valid_until !== null &&
      Date.parse(record.binding.freshness.valid_until) <= now.getTime()
    ) {
      this.markRebindRequired(record.id, "EXPIRED", now);
      return this.getByIdRaw(sessionId);
    }
    return record;
  }

  getActive(workspaceSessionId: string, now: Date = new Date()): CoreMutationSessionRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from core_mutation_sessions where workspace_session_id = ? and status = 'ACTIVE' limit 1")
      .get(workspaceSessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const record = rowToRecord(row);
    if (
      record.freshnessState === "FRESH" &&
      record.binding.freshness.valid_until !== null &&
      Date.parse(record.binding.freshness.valid_until) <= now.getTime()
    ) {
      this.markRebindRequired(record.id, "EXPIRED", now);
      return this.getByIdRaw(record.id);
    }
    return record;
  }

  getCandidate(candidateHead: string): CoreMutationCandidateProvenance | undefined {
    if (!GIT_OID_RE.test(candidateHead)) return undefined;
    const row = this.database.sqlite
      .prepare("select * from core_mutation_candidates where candidate_head = ? limit 1")
      .get(candidateHead) as Record<string, unknown> | undefined;
    return row ? rowToCandidate(row) : undefined;
  }

  async open(input: {
    workspaceSessionId: string;
    workspaceRoot: string;
    workspaceMode: "checkout" | "worktree";
    managed: boolean;
    actorKey: string;
    binding: unknown;
    now?: Date;
  }): Promise<CoreMutationSessionRecord> {
    if (!input.actorKey) throw new CoreMutationSessionError("ACTOR_IDENTITY_REQUIRED", "A trusted caller identity is required to bind a mutation session.");
    const binding = parseRepositoryMutationBinding(input.binding);
    const expectedWorkspaceIdentity = computeCoreMutationWorkspaceIdentity({
      workspaceSessionId: input.workspaceSessionId,
      binding,
    });
    if (binding.repository.workspace_identity !== expectedWorkspaceIdentity) {
      throw new CoreMutationSessionError(
        "WORKSPACE_IDENTITY_MISMATCH",
        "Binding workspace_identity does not match the exact DevSpace workspace/source identity.",
      );
    }
    const now = input.now ?? new Date();
    const createdAtMs = Date.parse(binding.freshness.created_at);
    if (createdAtMs > now.getTime() + 60_000) {
      throw new CoreMutationSessionError("BINDING_NOT_YET_VALID", "Binding creation time is materially in the future.");
    }
    if (binding.freshness.valid_until !== null && Date.parse(binding.freshness.valid_until) <= now.getTime()) {
      throw new CoreMutationSessionError("BINDING_EXPIRED", "Binding has expired and must be rebound before mutation.");
    }

    const canonicalBindingJson = coreCanonicalJson(binding as unknown as JsonValue);
    const byLogicalAttempt = this.database.sqlite
      .prepare("select * from core_mutation_sessions where operation_id = ? and attempt_id = ? limit 1")
      .get(binding.operation_id, binding.attempt_id) as Record<string, unknown> | undefined;
    if (byLogicalAttempt) {
      const existing = rowToRecord(byLogicalAttempt);
      if (
        existing.bindingHash !== binding.binding_hash ||
        existing.bindingId !== binding.binding_id ||
        existing.workspaceSessionId !== input.workspaceSessionId ||
        existing.actorKey !== input.actorKey ||
        coreCanonicalJson(existing.binding as unknown as JsonValue) !== canonicalBindingJson
      ) {
        throw new CoreMutationSessionError(
          "BINDING_REPLAY_CONFLICT",
          `Logical attempt ${binding.operation_id}/${binding.attempt_id} is already durably bound to a different immutable session subject.`,
        );
      }
      if (existing.status !== "ACTIVE") {
        throw new CoreMutationSessionError("BINDING_ALREADY_TERMINAL", `Binding is already ${existing.status}.`);
      }
      return existing;
    }
    const byHash = this.database.sqlite
      .prepare("select * from core_mutation_sessions where binding_hash = ? limit 1")
      .get(binding.binding_hash) as Record<string, unknown> | undefined;
    if (byHash) {
      const existing = rowToRecord(byHash);
      if (
        existing.workspaceSessionId !== input.workspaceSessionId ||
        existing.actorKey !== input.actorKey ||
        coreCanonicalJson(existing.binding as unknown as JsonValue) !== canonicalBindingJson
      ) {
        throw new CoreMutationSessionError("BINDING_REPLAY_CONFLICT", "binding_hash is already durably associated with a different session subject.");
      }
      if (existing.status !== "ACTIVE") {
        throw new CoreMutationSessionError("BINDING_ALREADY_TERMINAL", `Binding is already ${existing.status}.`);
      }
      return existing;
    }

    const active = this.getActive(input.workspaceSessionId);
    if (active) {
      throw new CoreMutationSessionError(
        "ACTIVE_CORE_MUTATION_SESSION_CONFLICT",
        `Workspace already has active Core mutation session ${active.id}; close or reconcile it before rebinding.`,
      );
    }

    const source = await assertPhysicalSource({
      workspaceRoot: input.workspaceRoot,
      workspaceMode: input.workspaceMode,
      managed: input.managed,
      binding,
      requireClean: true,
    });
    const timestamp = now.toISOString();
    const id = `cms_${randomUUID().replace(/-/g, "")}`;
    this.database.sqlite.prepare(`
      insert into core_mutation_sessions (
        id, workspace_session_id, actor_key, binding_id, operation_id, attempt_id, binding_hash, binding_json,
        source_head, source_tree, status, freshness_state, rebind_state,
        writer_reconciliation_state, writer_domains_json, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'FRESH', 'BOUND_CURRENT', 'CLEAR', '[]', ?, ?)
    `).run(
      id,
      input.workspaceSessionId,
      input.actorKey,
      binding.binding_id,
      binding.operation_id,
      binding.attempt_id,
      binding.binding_hash,
      JSON.stringify(binding),
      source.head,
      source.tree,
      timestamp,
      timestamp,
    );
    return this.getById(id, now)!;
  }

  private assertActor(record: CoreMutationSessionRecord, actorKey: string): void {
    if (!actorKey || record.actorKey !== actorKey) {
      throw new CoreMutationSessionError("CORE_MUTATION_ACTOR_MISMATCH", "Active Core mutation session belongs to a different caller identity.");
    }
  }

  private assertPointer(
    record: CoreMutationSessionRecord,
    pointer?: { sessionId?: string; bindingHash?: string },
  ): void {
    if (pointer?.sessionId !== undefined && pointer.sessionId !== record.id) {
      throw new CoreMutationSessionError("CORE_MUTATION_SESSION_MISMATCH", `Expected session ${record.id}.`);
    }
    if (pointer?.bindingHash !== undefined && pointer.bindingHash !== record.bindingHash) {
      throw new CoreMutationSessionError("CORE_MUTATION_BINDING_MISMATCH", "Core mutation binding hash does not match the active session.");
    }
  }

  private assertScope(
    record: CoreMutationSessionRecord,
    paths: readonly string[],
    deletedPaths: readonly string[],
  ): void {
    const allowed = new Set(record.binding.core.acceptance_contract.allowed_paths);
    const normalized = paths.map((path, index) => relativePath(path, `paths[${index}]`));
    const deleted = deletedPaths.map((path, index) => relativePath(path, `deletedPaths[${index}]`));
    const escaped = normalized.filter((path) => !allowed.has(path));
    if (escaped.length > 0) {
      throw new CoreMutationSessionError("CORE_MUTATION_SCOPE_ESCAPE", `Mutation paths escape AcceptanceContract: ${escaped.join(", ")}`);
    }
    if (record.binding.core.acceptance_contract.deletion_policy === "FORBID" && deleted.length > 0) {
      throw new CoreMutationSessionError("CORE_MUTATION_DELETION_FORBIDDEN", `AcceptanceContract forbids deletion: ${deleted.join(", ")}`);
    }
  }

  private markRebindRequired(
    sessionId: string,
    freshnessState: CoreMutationFreshnessState = "FRESH",
    now: Date = new Date(),
  ): void {
    this.database.sqlite.prepare(`
      update core_mutation_sessions
      set freshness_state = ?, rebind_state = 'REBIND_REQUIRED', updated_at = ?
      where id = ? and status = 'ACTIVE'
    `).run(freshnessState, now.toISOString(), sessionId);
  }

  private async assertContinuationLineage(
    record: CoreMutationSessionRecord,
    workspaceRoot: string,
  ): Promise<void> {
    const head = (await runGit(workspaceRoot, ["rev-parse", "HEAD"])).trim();
    const tree = (await runGit(workspaceRoot, ["rev-parse", "HEAD^{tree}"])).trim();
    if (head === record.sourceHead && tree === record.sourceTree) return;
    const candidate = this.getCandidate(head);
    if (
      candidate?.sessionId === record.id &&
      candidate.bindingHash === record.bindingHash &&
      candidate.candidateTree === tree &&
      candidate.sourceHead === record.sourceHead &&
      candidate.sourceTree === record.sourceTree
    ) return;
    this.markRebindRequired(record.id);
    throw new CoreMutationSessionError(
      "CORE_MUTATION_REBIND_REQUIRED",
      `Workspace HEAD/tree ${head}/${tree} is neither the bound source nor a recorded Candidate of this Core session.`,
    );
  }

  requireActive(input: {
    workspaceSessionId: string;
    actorKey: string;
    pointer?: { sessionId?: string; bindingHash?: string; required?: boolean };
    now?: Date;
  }): CoreMutationSessionRecord {
    const active = this.getActive(input.workspaceSessionId, input.now ?? new Date());
    if (!active) {
      throw new CoreMutationSessionError(
        "CORE_BOUND_SESSION_REQUIRED",
        "Repository mutation requires one active Core-bound mutation session for this workspace.",
      );
    }
    this.assertActor(active, input.actorKey);
    this.assertPointer(active, input.pointer);
    if (input.pointer?.required && (!input.pointer.sessionId || !input.pointer.bindingHash)) {
      throw new CoreMutationSessionError("CORE_MUTATION_POINTER_REQUIRED", "Trusted continuation must carry the exact Core session id and binding hash.");
    }
    if (active.rebindState !== "BOUND_CURRENT" || active.freshnessState !== "FRESH") {
      throw new CoreMutationSessionError(
        "CORE_MUTATION_REBIND_REQUIRED",
        "Core mutation session is no longer fresh and bound to the current physical repository state.",
      );
    }
    const now = input.now ?? new Date();
    if (active.binding.freshness.valid_until !== null && Date.parse(active.binding.freshness.valid_until) <= now.getTime()) {
      this.markRebindRequired(active.id, "EXPIRED");
      throw new CoreMutationSessionError("BINDING_EXPIRED", "Active binding expired before the requested effect.");
    }
    return active;
  }

  async admitEffect(input: {
    workspaceSessionId: string;
    workspaceRoot: string;
    workspaceMode: "checkout" | "worktree";
    managed: boolean;
    actorKey: string;
    pointer?: { sessionId?: string; bindingHash?: string; required?: boolean };
    paths?: readonly string[];
    deletedPaths?: readonly string[];
    pathContainment: "STRUCTURED_SINK_ENFORCED" | "NOT_PROVEN";
    writerDomain?: CoreMutationWriterDomain;
    synchronousPostEffectCheck?: true;
    now?: Date;
    /** Deterministic race-test seam immediately before the admission CAS. */
    beforeAdmissionCas?: () => Promise<void> | void;
  }): Promise<CoreMutationAdmission> {
    const active = this.requireActive({
      workspaceSessionId: input.workspaceSessionId,
      actorKey: input.actorKey,
      pointer: input.pointer,
      now: input.now,
    });
    if (active.writerDomains.includes("SYNCHRONOUS_GIT")) {
      throw new CoreMutationSessionError(
        "CORE_MUTATION_RECONCILE_REQUIRED",
        "A prior synchronous Git effect is unresolved; reconcile its exact physical outcome before any new admission.",
      );
    }
    const synchronous = input.synchronousPostEffectCheck === true;
    const uncontainedIdentityCount = Number(input.writerDomain !== undefined) + Number(synchronous);
    if (
      (input.pathContainment === "NOT_PROVEN" && uncontainedIdentityCount !== 1) ||
      (input.pathContainment === "STRUCTURED_SINK_ENFORCED" && uncontainedIdentityCount !== 0) ||
      input.writerDomain === "SYNCHRONOUS_GIT"
    ) {
      throw new CoreMutationSessionError(
        "CORE_MUTATION_WRITER_DOMAIN_REQUIRED",
        "NOT_PROVEN admission requires exactly one internal managed-writer domain or synchronous post-effect check; structured sinks must supply neither.",
      );
    }
    this.assertScope(active, input.paths ?? [], input.deletedPaths ?? []);

    const now = input.now ?? new Date();
    if (!active.firstEffectAt) {
      await assertPhysicalSource({
        workspaceRoot: input.workspaceRoot,
        workspaceMode: input.workspaceMode,
        managed: input.managed,
        binding: active.binding,
        requireClean: true,
      });
    } else {
      await this.assertContinuationLineage(active, input.workspaceRoot);
    }

    await input.beforeAdmissionCas?.();
    const timestamp = now.toISOString();
    const admittedDomain: CoreMutationWriterDomain | undefined = synchronous ? "SYNCHRONOUS_GIT" : input.writerDomain;
    const writerDomains = admittedDomain
      ? [...new Set([...active.writerDomains, admittedDomain])].sort()
      : active.writerDomains;
    const admitted = this.database.sqlite.prepare(`
      update core_mutation_sessions
      set first_effect_at = coalesce(first_effect_at, ?), last_effect_at = ?, updated_at = ?,
          writer_reconciliation_state = case when ? is not null then 'OUTCOME_UNKNOWN' else writer_reconciliation_state end,
          writer_domains_json = ?
      where id = ? and status = 'ACTIVE' and freshness_state = 'FRESH'
        and rebind_state = 'BOUND_CURRENT' and updated_at = ?
    `).run(timestamp, timestamp, timestamp, admittedDomain ?? null, JSON.stringify(writerDomains), active.id, active.updatedAt);
    if (admitted.changes !== 1) {
      throw new CoreMutationSessionError(
        "CORE_MUTATION_ADMISSION_RACE",
        "Core session state changed after physical validation; mutation admission did not win the durable CAS.",
      );
    }
    return {
      bound: true,
      sessionId: active.id,
      bindingHash: active.bindingHash,
      acceptanceContractHash: active.binding.core.acceptance_contract_hash,
      claim: "CORE_BOUND_SESSION",
      pathContainment: input.pathContainment,
    };
  }

  async recordCandidate(input: {
    sessionId: string;
    workspaceSessionId: string;
    workspaceRoot: string;
    actorKey: string;
    candidateHead: string;
    candidateTree: string;
    now?: Date;
  }): Promise<CoreMutationCandidateProvenance> {
    const now = input.now ?? new Date();
    const record = this.getByIdRaw(input.sessionId);
    if (!record || record.workspaceSessionId !== input.workspaceSessionId) {
      throw new CoreMutationSessionError("CORE_MUTATION_SESSION_NOT_FOUND", "Core mutation session is not bound to this workspace.");
    }
    if (record.status !== "ACTIVE") {
      throw new CoreMutationSessionError("CORE_MUTATION_SESSION_TERMINAL", `Cannot form new Candidate provenance from ${record.status} session.`);
    }
    this.assertActor(record, input.actorKey);
    if (record.binding.freshness.valid_until !== null && Date.parse(record.binding.freshness.valid_until) <= now.getTime()) {
      this.markRebindRequired(record.id, "EXPIRED", now);
      throw new CoreMutationSessionError("BINDING_EXPIRED", "Core binding expired before Candidate provenance could be recorded.");
    }
    if (record.freshnessState !== "FRESH" || record.rebindState !== "BOUND_CURRENT") {
      throw new CoreMutationSessionError("CORE_MUTATION_REBIND_REQUIRED", "A stale Core mutation session cannot record Candidate provenance.");
    }
    if (!GIT_OID_RE.test(input.candidateHead) || !GIT_OID_RE.test(input.candidateTree)) {
      throw new CoreMutationSessionError("MALFORMED_CANDIDATE_IDENTITY", "Candidate head/tree must be lowercase 40-character Git object ids.");
    }

    const currentHead = (await runGit(input.workspaceRoot, ["rev-parse", "HEAD"])).trim();
    const currentTree = (await runGit(input.workspaceRoot, ["rev-parse", "HEAD^{tree}"])).trim();
    if (currentHead !== input.candidateHead || currentTree !== input.candidateTree) {
      throw new CoreMutationSessionError(
        "CANDIDATE_IDENTITY_MISMATCH",
        "Candidate head/tree do not match the exact physical workspace state after commit.",
      );
    }
    const mergeBase = (await runGit(input.workspaceRoot, ["merge-base", record.sourceHead, input.candidateHead])).trim();
    if (mergeBase !== record.sourceHead) {
      throw new CoreMutationSessionError(
        "CANDIDATE_BASE_MISMATCH",
        `Candidate ${input.candidateHead} is not descended from bound source ${record.sourceHead}.`,
      );
    }

    const snapshot = await materializeSnapshot(input.workspaceRoot, record);
    if (snapshot.dirty) {
      throw new CoreMutationSessionError("CANDIDATE_WORKSPACE_DIRTY", "Candidate provenance requires a clean post-commit workspace.");
    }
    if (snapshot.currentHead !== input.candidateHead || snapshot.targetTree !== `git-tree:${input.candidateTree}`) {
      throw new CoreMutationSessionError("CANDIDATE_IDENTITY_MISMATCH", "Physical ChangeSet snapshot does not match Candidate head/tree.");
    }
    if (snapshot.scopeEscapePaths.length > 0) {
      throw new CoreMutationSessionError(
        "CORE_MUTATION_SCOPE_ESCAPE",
        `Candidate contains paths outside AcceptanceContract: ${snapshot.scopeEscapePaths.join(", ")}`,
      );
    }
    if (snapshot.deletionViolation) {
      throw new CoreMutationSessionError(
        "CORE_MUTATION_DELETION_FORBIDDEN",
        `Candidate deletes paths while AcceptanceContract forbids deletion: ${snapshot.deletedPaths.join(", ")}`,
      );
    }

    const existing = this.getCandidate(input.candidateHead);
    const provenance: CoreMutationCandidateProvenance = {
      candidateHead: input.candidateHead,
      candidateTree: input.candidateTree,
      sessionId: record.id,
      workspaceSessionId: record.workspaceSessionId,
      bindingHash: record.bindingHash,
      acceptanceContractHash: record.binding.core.acceptance_contract_hash,
      sourceHead: record.sourceHead,
      sourceTree: record.sourceTree,
      changedPaths: snapshot.changedPaths,
      deletedPaths: snapshot.deletedPaths,
      diffHash: snapshot.diffHash,
      changeSetId: snapshot.changeSetId,
      changeSetHash: snapshot.changeSetHash,
      changeManifestHash: snapshot.changeManifest.manifest_hash,
      createdAt: existing?.createdAt ?? (input.now ?? new Date()).toISOString(),
    };
    if (existing) {
      if (
        coreCanonicalJson(existing as unknown as JsonValue) !==
        coreCanonicalJson(provenance as unknown as JsonValue)
      ) {
        throw new CoreMutationSessionError(
          "CANDIDATE_PROVENANCE_CONFLICT",
          `Candidate ${input.candidateHead} is already bound to different Core provenance.`,
        );
      }
      return existing;
    }

    this.database.sqlite.prepare(`
      insert into core_mutation_candidates (
        candidate_head, candidate_tree, session_id, workspace_session_id, binding_hash,
        acceptance_contract_hash, source_head, source_tree, changed_paths_json,
        deleted_paths_json, diff_hash, change_set_id, change_set_hash,
        change_set_json, change_manifest_hash, change_manifest_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      provenance.candidateHead,
      provenance.candidateTree,
      provenance.sessionId,
      provenance.workspaceSessionId,
      provenance.bindingHash,
      provenance.acceptanceContractHash,
      provenance.sourceHead,
      provenance.sourceTree,
      JSON.stringify(provenance.changedPaths),
      JSON.stringify(provenance.deletedPaths),
      provenance.diffHash,
      provenance.changeSetId,
      provenance.changeSetHash,
      JSON.stringify(snapshot.changeSet),
      provenance.changeManifestHash,
      JSON.stringify(snapshot.changeManifest),
      provenance.createdAt,
    );
    return this.getCandidate(input.candidateHead)!;
  }

  async reconcileSynchronousEffect(input: {
    sessionId: string;
    workspaceSessionId: string;
    workspaceRoot: string;
    actorKey: string;
    bindingHash: string;
    now?: Date;
  }): Promise<{ session: CoreMutationSessionRecord; snapshot: CoreMutationPhysicalSnapshot }> {
    const record = this.getByIdRaw(input.sessionId);
    if (!record || record.workspaceSessionId !== input.workspaceSessionId) {
      throw new CoreMutationSessionError("CORE_MUTATION_SESSION_NOT_FOUND", "Core mutation session is not bound to this workspace.");
    }
    this.assertActor(record, input.actorKey);
    this.assertPointer(record, { sessionId: input.sessionId, bindingHash: input.bindingHash });
    if (record.status !== "ACTIVE" || !record.writerDomains.includes("SYNCHRONOUS_GIT")) {
      throw new CoreMutationSessionError("CORE_MUTATION_RECONCILE_REQUIRED", "No active unresolved synchronous Git effect matches this session.");
    }
    const snapshot = await materializeSnapshot(input.workspaceRoot, record);
    if (snapshot.scopeEscapePaths.length > 0) {
      this.markRebindRequired(record.id);
      throw new CoreMutationSessionError(
        "CORE_MUTATION_POST_EFFECT_SCOPE_ESCAPE",
        `Synchronous Git hook changed paths outside AcceptanceContract: ${snapshot.scopeEscapePaths.join(", ")}.`,
      );
    }
    if (snapshot.deletionViolation) {
      this.markRebindRequired(record.id);
      throw new CoreMutationSessionError(
        "CORE_MUTATION_POST_EFFECT_DELETION_FORBIDDEN",
        `Synchronous Git hook deleted forbidden paths: ${snapshot.deletedPaths.join(", ")}.`,
      );
    }
    const remainingDomains = record.writerDomains.filter((domain) => domain !== "SYNCHRONOUS_GIT");
    const nextWriterState: CoreMutationWriterReconciliationState = remainingDomains.length > 0 ? "OUTCOME_UNKNOWN" : "CLEAR";
    const now = (input.now ?? new Date()).toISOString();
    const reconciled = this.database.sqlite.prepare(`
      update core_mutation_sessions
      set writer_domains_json = ?, writer_reconciliation_state = ?, updated_at = ?
      where id = ? and status = 'ACTIVE' and updated_at = ? and freshness_state = ?
        and rebind_state = ? and writer_reconciliation_state = 'OUTCOME_UNKNOWN'
        and writer_domains_json = ?
    `).run(
      JSON.stringify(remainingDomains),
      nextWriterState,
      now,
      record.id,
      record.updatedAt,
      record.freshnessState,
      record.rebindState,
      JSON.stringify(record.writerDomains),
    );
    if (reconciled.changes !== 1) {
      throw new CoreMutationSessionError("CORE_MUTATION_RECONCILE_REQUIRED", "Core session changed during synchronous post-effect inspection; reconciliation CAS lost.");
    }
    return { session: this.getByIdRaw(record.id)!, snapshot };
  }

  async closeSession(input: {
    sessionId: string;
    workspaceSessionId: string;
    workspaceRoot: string;
    actorKey: string;
    mode: "COMPLETE" | "ABANDON";
    now?: Date;
    inspectWriterDomain?: (
      session: CoreMutationSessionRecord,
      domain: CoreMutationManagedWriterDomain,
    ) => Promise<"CLEAR" | "ACTIVE" | "UNKNOWN"> | "CLEAR" | "ACTIVE" | "UNKNOWN";
    /** Deterministic race-test seam after checks and immediately before terminal CAS. */
    beforeCloseCas?: () => Promise<void> | void;
  }): Promise<CoreMutationSessionRecord> {
    const record = this.getByIdRaw(input.sessionId);
    if (!record || record.workspaceSessionId !== input.workspaceSessionId) {
      throw new CoreMutationSessionError("CORE_MUTATION_SESSION_NOT_FOUND", "Core mutation session is not bound to this workspace.");
    }
    this.assertActor(record, input.actorKey);
    if (record.status !== "ACTIVE") {
      const recordedMode = record.status === "COMPLETED" ? "COMPLETE" : "ABANDON";
      if (input.mode !== recordedMode) {
        throw new CoreMutationSessionError(
          "CORE_MUTATION_TERMINAL_MODE_CONFLICT",
          `Core mutation session is already ${record.status}; terminal replay cannot change close mode from ${recordedMode} to ${input.mode}.`,
        );
      }
      return record;
    }
    if (input.mode === "ABANDON" && record.firstEffectAt) {
      throw new CoreMutationSessionError(
        "CORE_MUTATION_RECONCILE_REQUIRED",
        "ABANDON is allowed only before the first admitted effect; reconcile or close a recorded Candidate after mutation may have occurred.",
      );
    }
    if (input.mode === "COMPLETE") {
      if (record.freshnessState !== "FRESH" || record.rebindState !== "BOUND_CURRENT") {
        throw new CoreMutationSessionError("CORE_MUTATION_REBIND_REQUIRED", "A stale Core mutation session cannot produce Candidate-bound execution completion state.");
      }
      const closeTime = input.now ?? new Date();
      if (
        record.binding.freshness.valid_until !== null &&
        Date.parse(record.binding.freshness.valid_until) <= closeTime.getTime()
      ) {
        this.markRebindRequired(record.id, "EXPIRED");
        throw new CoreMutationSessionError("BINDING_EXPIRED", "Core binding expired before Candidate-bound execution completion could be recorded.");
      }
      if (record.writerDomains.length > 0) {
        const states = await Promise.all(record.writerDomains.map(async (domain) => [
          domain,
          domain === "SYNCHRONOUS_GIT"
            ? "UNKNOWN"
            : input.inspectWriterDomain ? await input.inspectWriterDomain(record, domain) : "UNKNOWN",
        ] as const));
        const unresolved = states.filter(([, state]) => state !== "CLEAR");
        if (unresolved.length > 0) {
          throw new CoreMutationSessionError(
            "CORE_MUTATION_WRITER_RECONCILE_REQUIRED",
            `Core-bound writer domains are not all CLEAR (${unresolved.map(([domain, state]) => `${domain}=${state}`).join(", ")}); retained manager evidence must prove every admitted domain terminal before completion.`,
          );
        }
      }
      const status = await runGit(input.workspaceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
      if (status.trim().length > 0) {
        throw new CoreMutationSessionError("CORE_MUTATION_DIRTY_AT_CLOSE", "COMPLETE requires a clean workspace; use ABANDON or commit the bounded Candidate first.");
      }
      const snapshot = await materializeSnapshot(input.workspaceRoot, record);
      const candidate = this.getCandidate(snapshot.currentHead);
      if (!candidate) {
        throw new CoreMutationSessionError(
          "CORE_MUTATION_CANDIDATE_REQUIRED",
          "COMPLETE requires durable physical Candidate/ChangeSet provenance for the exact current HEAD; a clean workspace is insufficient.",
        );
      }
      if (
        candidate.sessionId !== record.id ||
        candidate.workspaceSessionId !== record.workspaceSessionId ||
        candidate.bindingHash !== record.bindingHash ||
        candidate.acceptanceContractHash !== record.binding.core.acceptance_contract_hash ||
        candidate.sourceHead !== record.sourceHead ||
        candidate.sourceTree !== record.sourceTree ||
        candidate.candidateHead !== snapshot.currentHead ||
        candidate.candidateTree !== snapshot.currentHeadTree.replace(/^git-tree:/, "") ||
        candidate.diffHash !== snapshot.diffHash ||
        candidate.changeSetId !== snapshot.changeSetId ||
        candidate.changeSetHash !== snapshot.changeSetHash ||
        candidate.changeManifestHash !== snapshot.changeManifest.manifest_hash ||
        !sameStringSet(candidate.changedPaths, snapshot.changedPaths) ||
        !sameStringSet(candidate.deletedPaths, snapshot.deletedPaths)
      ) {
        throw new CoreMutationSessionError(
          "CORE_MUTATION_CANDIDATE_CONFLICT",
          "Current physical Candidate/ChangeSet provenance does not satisfy this exact immutable Core binding.",
        );
      }
    }
    const now = (input.now ?? new Date()).toISOString();
    const status: CoreMutationSessionStatus = input.mode === "COMPLETE" ? "COMPLETED" : "ABANDONED";
    await input.beforeCloseCas?.();
    const closed = this.database.sqlite.prepare(`
      update core_mutation_sessions
      set status = ?, writer_reconciliation_state = case when ? = 'COMPLETED' then 'CLEAR' else writer_reconciliation_state end,
          closed_at = ?, updated_at = ?
      where id = ? and status = 'ACTIVE' and updated_at = ? and freshness_state = ?
        and rebind_state = ? and writer_reconciliation_state = ? and writer_domains_json = ?
    `).run(
      status,
      status,
      now,
      now,
      record.id,
      record.updatedAt,
      record.freshnessState,
      record.rebindState,
      record.writerReconciliationState,
      JSON.stringify(record.writerDomains),
    );
    if (closed.changes !== 1) {
      throw new CoreMutationSessionError(
        "CORE_MUTATION_RECONCILE_REQUIRED",
        "Core session changed during completion checks; terminal CAS lost and no COMPLETED state was recorded.",
      );
    }
    return this.getByIdRaw(record.id)!;
  }

  async snapshot(input: {
    sessionId: string;
    workspaceSessionId: string;
    workspaceRoot: string;
    actorKey: string;
  }): Promise<CoreMutationPhysicalSnapshot> {
    const record = this.getById(input.sessionId);
    if (!record || record.workspaceSessionId !== input.workspaceSessionId) {
      throw new CoreMutationSessionError("CORE_MUTATION_SESSION_NOT_FOUND", "Core mutation session is not bound to this workspace.");
    }
    this.assertActor(record, input.actorKey);
    const snapshot = await materializeSnapshot(input.workspaceRoot, record);
    if (snapshot.scopeEscapePaths.length > 0 || snapshot.deletionViolation) {
      this.markRebindRequired(record.id);
    }
    return snapshot;
  }
}

async function treeEntry(
  workspaceRoot: string,
  tree: string,
  path: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ mode: string; oid: string } | null> {
  const output = await runGit(workspaceRoot, ["ls-tree", "-z", tree, "--", path], { env });
  if (!output) return null;
  const match = /^([0-7]{6})\s+\S+\s+([0-9a-f]{40})\t/.exec(output);
  if (!match || !GIT_MODE_RE.test(match[1]!) || !GIT_OID_RE.test(match[2]!)) {
    throw new CoreMutationSessionError("GIT_READBACK_FAILED", `Unable to parse tree entry for ${path}.`);
  }
  return { mode: match[1]!, oid: match[2]! };
}

async function materializeSnapshot(
  workspaceRoot: string,
  record: CoreMutationSessionRecord,
): Promise<CoreMutationPhysicalSnapshot> {
  const currentHead = (await runGit(workspaceRoot, ["rev-parse", "HEAD"])).trim();
  const currentHeadTree = (await runGit(workspaceRoot, ["rev-parse", "HEAD^{tree}"])).trim();
  const status = await runGit(workspaceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const dirty = status.trim().length > 0;
  if (!dirty) {
    return buildPhysicalSnapshot(workspaceRoot, record, {
      currentHead,
      currentHeadTree,
      targetTree: currentHeadTree,
      dirty: false,
      materializedGitObjects: false,
      objectStorage: "CALLER_EXISTING",
    });
  }

  const tempDir = await mkdtemp(join(tmpdir(), "devspace-core-mutation-git-"));
  const indexPath = join(tempDir, "index");
  const isolatedObjects = join(tempDir, "objects");
  const commonDirRaw = (await runGit(workspaceRoot, ["rev-parse", "--git-common-dir"])).trim();
  const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(workspaceRoot, commonDirRaw);
  await mkdir(isolatedObjects, { recursive: true });
  const env = {
    GIT_INDEX_FILE: indexPath,
    GIT_OBJECT_DIRECTORY: isolatedObjects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(commonDir, "objects"),
  };
  try {
    await runGit(workspaceRoot, ["read-tree", "HEAD"], { env });
    await runGit(workspaceRoot, ["add", "-A", "--", "."], { env });
    const targetTree = (await runGit(workspaceRoot, ["write-tree"], { env })).trim();
    return await buildPhysicalSnapshot(workspaceRoot, record, {
      currentHead,
      currentHeadTree,
      targetTree,
      dirty: true,
      materializedGitObjects: true,
      objectStorage: "ISOLATED_TEMPORARY",
      env,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function buildPhysicalSnapshot(
  workspaceRoot: string,
  record: CoreMutationSessionRecord,
  materialized: {
    currentHead: string;
    currentHeadTree: string;
    targetTree: string;
    dirty: boolean;
    materializedGitObjects: boolean;
    objectStorage: "CALLER_EXISTING" | "ISOLATED_TEMPORARY";
    env?: NodeJS.ProcessEnv;
  },
): Promise<CoreMutationPhysicalSnapshot> {
  const {
    currentHead,
    currentHeadTree,
    targetTree,
    dirty,
    materializedGitObjects,
    objectStorage,
    env,
  } = materialized;

  const sourceTreeOid = record.sourceTree;
  const namesRaw = await runGit(workspaceRoot, [
    "diff-tree",
    "--no-commit-id",
    "--name-status",
    "-r",
    "-z",
    "--no-renames",
    sourceTreeOid,
    targetTree,
  ], { env });
  const fields = namesRaw.split("\0").filter((field) => field.length > 0);
  const changes: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < fields.length;) {
    const statusCode = fields[index++]!;
    const path = fields[index++];
    if (!path) throw new CoreMutationSessionError("GIT_READBACK_FAILED", "Malformed NUL-delimited diff-tree output.");
    changes.push({ status: statusCode, path });
  }

  const entries: CoreChangeManifestEntry[] = [];
  for (const change of changes) {
    const before = await treeEntry(workspaceRoot, sourceTreeOid, change.path, env);
    const after = await treeEntry(workspaceRoot, targetTree, change.path, env);
    const changeType: CoreChangeManifestEntry["change_type"] = change.status.startsWith("A")
      ? "ADD"
      : change.status.startsWith("D")
        ? "DELETE"
        : "MODIFY";
    entries.push({
      path: change.path,
      change_type: changeType,
      before_oid: before?.oid ?? null,
      after_oid: after?.oid ?? null,
      before_mode: before?.mode ?? null,
      after_mode: after?.mode ?? null,
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const changeManifestCore = {
    source_tree: `git-tree:${sourceTreeOid}`,
    target_tree: `git-tree:${targetTree}`,
    entries,
  };
  const diffHash = coreCanonicalHash([
    CORE_CHANGE_MANIFEST_SCHEMA,
    changeManifestCore.source_tree,
    changeManifestCore.target_tree,
    entries.map((entry) => [
      entry.path,
      entry.change_type,
      entry.before_oid,
      entry.after_oid,
      entry.before_mode,
      entry.after_mode,
    ]),
  ] as unknown as JsonValue);
  const changedPaths = entries.map((entry) => entry.path);
  const deletedPaths = entries.filter((entry) => entry.change_type === "DELETE").map((entry) => entry.path);
  const allowed = new Set(record.binding.core.acceptance_contract.allowed_paths);
  const scopeEscapePaths = changedPaths.filter((path) => !allowed.has(path));
  const deletionViolation =
    record.binding.core.acceptance_contract.deletion_policy === "FORBID" && deletedPaths.length > 0;
  const targetRevision = dirty
    ? `git-tree:${targetTree}`
    : `git-commit:${currentHead}`;
  const provenance = {
    operationId: record.binding.operation_id,
    attemptId: record.binding.attempt_id,
    workspaceSessionId: record.workspaceSessionId,
    bindingId: record.bindingId,
    bindingHash: record.bindingHash,
  };
  const changeSetId = coreCanonicalHash([
    "nexus.core.physical-change-set-id.v1",
    provenance.operationId,
    provenance.attemptId,
    provenance.workspaceSessionId,
    provenance.bindingId,
    provenance.bindingHash,
    record.binding.repository.source_revision,
    record.binding.repository.source_tree,
    targetRevision,
    `git-tree:${targetTree}`,
    diffHash,
  ]);
  const changeSet: CoreChangeSetWire = {
    change_set_id: changeSetId,
    source_revision: record.binding.repository.source_revision,
    target_revision: targetRevision,
    diff_hash: diffHash,
    paths: changedPaths,
    deleted_paths: deletedPaths,
  };
  const changeSetHash = coreChangeSetHash(changeSet);
  const changeManifest = {
    schema: CORE_CHANGE_MANIFEST_SCHEMA,
    ...changeManifestCore,
    manifest_hash: diffHash,
  };

  return {
    sessionId: record.id,
    bindingHash: record.bindingHash,
    acceptanceContractHash: record.binding.core.acceptance_contract_hash,
    sourceRevision: record.binding.repository.source_revision,
    sourceTree: record.binding.repository.source_tree,
    targetRevision,
    targetTree: `git-tree:${targetTree}`,
    currentHead,
    currentHeadTree: `git-tree:${currentHeadTree}`,
    dirty,
    changedPaths,
    deletedPaths,
    scopeEscapePaths,
    deletionViolation,
    diffHash,
    changeSetId,
    changeSetHash,
    changeSet,
    provenance,
    changeManifest,
    materializedGitObjects,
    objectStorage,
  };
}
