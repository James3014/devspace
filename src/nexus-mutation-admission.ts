import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { git } from "./git.js";

export const NEXUS_MUTATION_ADMISSION_SCHEMA = "nexus.mutation_admission.v1";

export const NEXUS_CANONICAL_REPOSITORIES = new Set([
  "James3014/devspace",
  "James3014/Nexus-new",
  "James3014/nexus-core",
  "James3014/nexus-learning",
  "James3014/nexus-open-swe-runtime",
  "James3014/repository-intelligence-engine",
  "James3014/nexus-runtime",
  "James3014/nexus-opencli-reviewer",
  "James3014/nexus-deployment-lab",
]);

const RECEIPT_FIELDS = new Set([
  "schema",
  "admission_id",
  "operation_id",
  "repository",
  "base_sha",
  "execution_lane",
  "authority_kind",
  "allowed_paths",
  "issue_number",
  "task_id",
  "attempt_id",
  "task_card_path",
  "task_card_hash",
  "governance_source_head",
  "ttl_minutes",
  "issued_at",
  "expires_at",
  "runtime_identity",
  "authority_reference",
  "request_hash",
  "receipt_hash",
]);

const ADMISSION_ID = /^admission-[0-9a-f]{32}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;

export interface NexusMutationAdmissionPointer {
  admissionId: string;
  receiptHash: string;
}

export interface NexusMutationAdmissionReceipt {
  schema: typeof NEXUS_MUTATION_ADMISSION_SCHEMA;
  admission_id: string;
  operation_id: string;
  repository: string;
  base_sha: string;
  execution_lane: "DIRECT_CANONICAL" | "DIRECT_DELEGATED" | "GOVERNED";
  authority_kind: "OWNER_INLINE" | "TRACKED_TASK_CARD";
  allowed_paths: string[];
  issue_number: number | null;
  task_id: string | null;
  attempt_id: string | null;
  task_card_path: string | null;
  task_card_hash: string | null;
  governance_source_head: string | null;
  ttl_minutes: number;
  issued_at: string;
  expires_at: string;
  runtime_identity: Record<string, unknown>;
  authority_reference: Record<string, unknown> | null;
  request_hash: string;
  receipt_hash: string;
}

export class NexusMutationAdmissionError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "NexusMutationAdmissionError";
  }
}

export function parseNexusMutationAdmissionPointer(value: unknown): NexusMutationAdmissionPointer | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_POINTER_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "admissionId,receiptHash"
    || typeof record.admissionId !== "string"
    || !ADMISSION_ID.test(record.admissionId)
    || typeof record.receiptHash !== "string"
    || !SHA64.test(record.receiptHash)
  ) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_POINTER_INVALID");
  }
  return { admissionId: record.admissionId, receiptHash: record.receiptHash };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

function receiptHash(receipt: Record<string, unknown>): string {
  const withoutHash = { ...receipt };
  delete withoutHash.receipt_hash;
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(withoutHash)), "utf8")
    .digest("hex");
}

function normalizeAdmissionPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (!candidate || candidate.startsWith("/") || candidate.includes("\\")) return undefined;
  const parts = candidate.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === ".git")) return undefined;
  return candidate;
}

export function nexusAdmissionPathAllowed(path: string, allowedPaths: readonly string[]): boolean {
  const candidate = normalizeAdmissionPath(path);
  if (!candidate) return false;
  return allowedPaths.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const root = pattern.slice(0, -3).replace(/\/$/, "");
      return candidate === root || candidate.startsWith(`${root}/`);
    }
    return candidate === pattern;
  });
}

function validateAllowedPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_SCOPE_INVALID");
  }
  const result: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_SCOPE_INVALID");
    }
    const directory = raw.endsWith("/**");
    const base = directory ? raw.slice(0, -3) : raw;
    const normalizedBase = normalizeAdmissionPath(base);
    if (!normalizedBase || normalizedBase !== base || /[*?\[\]]/.test(base)) {
      throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_SCOPE_INVALID");
    }
    const normalized = directory ? `${base}/**` : base;
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function repositoryFromRemote(value: string): string | undefined {
  const raw = value.trim().replace(/\.git$/, "");
  let candidate: string | undefined;
  const scp = raw.match(/^git@github\.com:([^/]+\/[^/]+)$/);
  if (scp) {
    candidate = scp[1];
  } else {
    try {
      const url = new URL(raw);
      if (url.hostname.toLowerCase() !== "github.com") return undefined;
      candidate = url.pathname.replace(/^\/+|\/+$/g, "");
    } catch {
      return undefined;
    }
  }
  return candidate && NEXUS_CANONICAL_REPOSITORIES.has(candidate) ? candidate : undefined;
}

export interface ObservedCanonicalRepository {
  repository: string;
  head: string;
}

export async function observeNexusCanonicalRepository(
  workspaceRoot: string,
): Promise<ObservedCanonicalRepository | undefined> {
  try {
    const root = (await git(workspaceRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim().toLowerCase();
    const remote = (await git(root, ["remote", "get-url", "origin"])).stdout.trim();
    const repository = repositoryFromRemote(remote);
    if (!repository || !SHA40.test(head)) return undefined;
    return { repository, head };
  } catch {
    return undefined;
  }
}

function validateReceipt(
  value: unknown,
  expectedReceiptHash: string,
  nowMs: number,
): NexusMutationAdmissionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_RECEIPT_INVALID");
  }
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt);
  if (
    keys.length !== RECEIPT_FIELDS.size
    || keys.some((key) => !RECEIPT_FIELDS.has(key))
  ) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_RECEIPT_FIELDS_INVALID");
  }
  if (
    receipt.schema !== NEXUS_MUTATION_ADMISSION_SCHEMA
    || typeof receipt.admission_id !== "string"
    || !ADMISSION_ID.test(receipt.admission_id)
    || typeof receipt.receipt_hash !== "string"
    || !SHA64.test(receipt.receipt_hash)
    || receipt.receipt_hash !== expectedReceiptHash
    || receiptHash(receipt) !== receipt.receipt_hash
  ) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_RECEIPT_HASH_MISMATCH");
  }
  if (
    typeof receipt.repository !== "string"
    || !NEXUS_CANONICAL_REPOSITORIES.has(receipt.repository)
    || typeof receipt.base_sha !== "string"
    || !SHA40.test(receipt.base_sha)
  ) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_IDENTITY_INVALID");
  }
  const allowedPaths = validateAllowedPaths(receipt.allowed_paths);
  if (
    receipt.execution_lane !== "DIRECT_CANONICAL"
    && receipt.execution_lane !== "DIRECT_DELEGATED"
    && receipt.execution_lane !== "GOVERNED"
  ) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_AUTHORITY_INVALID");
  }
  if (receipt.authority_kind !== "OWNER_INLINE" && receipt.authority_kind !== "TRACKED_TASK_CARD") {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_AUTHORITY_INVALID");
  }
  if (typeof receipt.expires_at !== "string") {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_EXPIRES_AT_INVALID");
  }
  const expiresAt = Date.parse(receipt.expires_at);
  if (!Number.isFinite(expiresAt)) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_EXPIRES_AT_INVALID");
  }
  if (expiresAt <= nowMs) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_EXPIRED");
  }
  return { ...(receipt as unknown as NexusMutationAdmissionReceipt), allowed_paths: allowedPaths };
}

export interface AssertNexusMutationAdmissionInput {
  stateRoot?: string;
  workspaceRoot: string;
  pointer?: NexusMutationAdmissionPointer;
  expectedRepository?: string;
  expectedBase?: string;
  basePolicy?: "EXACT" | "ANCESTOR";
  requestedPaths?: string[];
  nowMs?: number;
}

export interface NexusMutationAdmissionConsumption {
  required: boolean;
  repository?: string;
  receipt?: NexusMutationAdmissionReceipt;
}

export async function assertNexusMutationAdmission(
  input: AssertNexusMutationAdmissionInput,
): Promise<NexusMutationAdmissionConsumption> {
  const observed = await observeNexusCanonicalRepository(input.workspaceRoot);
  if (!observed) return { required: false };

  if (input.expectedRepository && input.expectedRepository !== observed.repository) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_REPOSITORY_MISMATCH");
  }
  if (!input.stateRoot) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_STATE_ROOT_REQUIRED");
  }
  if (!input.pointer) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_REQUIRED");
  }

  const pointer = parseNexusMutationAdmissionPointer(input.pointer)!;
  const stateRoot = resolve(input.stateRoot);
  const receiptPath = join(stateRoot, "mutation-admissions", `${pointer.admissionId}.json`);
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) {
    throw new NexusMutationAdmissionError(
      "NEXUS_MUTATION_ADMISSION_RECEIPT_UNAVAILABLE",
      error instanceof Error ? error.message : String(error),
    );
  }

  const receipt = validateReceipt(decoded, pointer.receiptHash, input.nowMs ?? Date.now());
  if (receipt.admission_id !== pointer.admissionId) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_ID_MISMATCH");
  }
  if (receipt.repository !== observed.repository) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_REPOSITORY_MISMATCH");
  }

  const expectedBase = input.expectedBase?.toLowerCase();
  if (expectedBase && !SHA40.test(expectedBase)) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_EXPECTED_BASE_INVALID");
  }
  const basePolicy = input.basePolicy ?? "EXACT";
  if (basePolicy === "EXACT") {
    const actualBase = expectedBase ?? observed.head;
    if (receipt.base_sha !== actualBase || observed.head !== actualBase) {
      throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_BASE_MISMATCH");
    }
  } else {
    const candidateHead = expectedBase ?? observed.head;
    if (observed.head !== candidateHead) {
      throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_BASE_MISMATCH");
    }
    try {
      await git(input.workspaceRoot, ["merge-base", "--is-ancestor", receipt.base_sha, candidateHead]);
    } catch {
      throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_BASE_MISMATCH");
    }
  }

  const requestedPaths = input.requestedPaths ?? [];
  for (const path of requestedPaths) {
    if (!nexusAdmissionPathAllowed(path, receipt.allowed_paths)) {
      throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_SCOPE_ESCAPE", path);
    }
  }
  return { required: true, repository: observed.repository, receipt };
}

export async function nexusAdmissionChangedPathsToHead(
  workspaceRoot: string,
  receipt: NexusMutationAdmissionReceipt,
  head: string,
): Promise<string[]> {
  const output = await git(workspaceRoot, [
    "diff",
    "--name-only",
    "--no-renames",
    `${receipt.base_sha}..${head}`,
  ]);
  return output.stdout.split("\n").map((value) => value.trim()).filter(Boolean);
}
