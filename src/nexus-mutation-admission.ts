import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { git, getGitEligibility } from "./git.js";

export const NEXUS_MUTATION_ADMISSION_SCHEMA = "nexus.mutation_admission.v1" as const;

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

export interface NexusMutationAdmissionBinding {
  admissionId: string;
  operationId: string;
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

export interface NexusMutationAdmissionDecision {
  required: boolean;
  repository?: string;
  receipt?: NexusMutationAdmissionReceipt;
}

export class NexusMutationAdmissionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NexusMutationAdmissionError";
  }
}

const ADMISSION_ID = /^admission-[0-9a-f]{32}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;

const RECEIPT_FIELDS = [
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
] as const;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateBinding(value: NexusMutationAdmissionBinding | undefined): NexusMutationAdmissionBinding {
  if (!value) {
    throw new NexusMutationAdmissionError(
      "NEXUS_MUTATION_ADMISSION_REQUIRED",
      "Canonical repository mutation requires a Nexus mutation admission binding.",
    );
  }
  if (
    !ADMISSION_ID.test(value.admissionId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.operationId)
    || !SHA64.test(value.receiptHash)
  ) {
    throw new NexusMutationAdmissionError(
      "NEXUS_MUTATION_ADMISSION_BINDING_INVALID",
      "Mutation admission binding must contain exact admissionId, operationId, and receiptHash identities.",
    );
  }
  const expectedAdmissionId = "admission-" + sha256(value.operationId).slice(0, 32);
  if (value.admissionId !== expectedAdmissionId) {
    throw new NexusMutationAdmissionError(
      "NEXUS_MUTATION_ADMISSION_OPERATION_MISMATCH",
      "Admission id is not derived from the supplied operation identity.",
    );
  }
  return value;
}

function validateAllowedPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_INVALID", "Admission allowed_paths is invalid.");
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.startsWith("/") || item.includes("\\")) {
      throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_INVALID", "Admission contains an invalid path.");
    }
    const directory = item.endsWith("/**");
    const base = directory ? item.slice(0, -3) : item;
    if (!base || base.split("/").includes("..") || base.split("/").includes(".git") || /[*?\[\]]/.test(base)) {
      throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_INVALID", "Admission contains an invalid path.");
    }
    const normalized = directory ? `${base}/**` : base;
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function pathWithinAdmission(path: string, allowedPaths: readonly string[]): boolean {
  const candidate = path.trim().replace(/^\.\//, "");
  if (!candidate || candidate.startsWith("/") || candidate.includes("\\") || candidate.split("/").includes("..") || candidate.split("/").includes(".git")) {
    return false;
  }
  return allowedPaths.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const root = pattern.slice(0, -3).replace(/\/$/, "");
      return candidate === root || candidate.startsWith(`${root}/`);
    }
    return candidate === pattern;
  });
}

function requestedScopeWithinAdmission(path: string, allowedPaths: readonly string[]): boolean {
  const candidate = path.trim().replace(/^\.\//, "").replace(/\/$/, "");
  if (!candidate || candidate === "." || candidate.startsWith("/") || candidate.includes("\\") || candidate.split("/").includes("..") || candidate.split("/").includes(".git")) {
    return false;
  }
  return allowedPaths.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const root = pattern.slice(0, -3).replace(/\/$/, "");
      return candidate === root || candidate.startsWith(`${root}/`);
    }
    return candidate === pattern;
  });
}

function parseGitHubRepository(remote: string): string | undefined {
  const value = remote.trim().replace(/\.git$/, "");
  const https = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = value.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const sshUrl = value.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i);
  if (sshUrl) return `${sshUrl[1]}/${sshUrl[2]}`;
  return undefined;
}

function parseReceipt(raw: string, expectedHash: string, now: Date): NexusMutationAdmissionReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_INVALID", "Admission record is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_INVALID", "Admission record must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== [...RECEIPT_FIELDS].sort().join(",")) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_INVALID", "Admission record contains missing or unknown fields.");
  }
  if (
    record.schema !== NEXUS_MUTATION_ADMISSION_SCHEMA
    || typeof record.admission_id !== "string"
    || !ADMISSION_ID.test(record.admission_id)
    || typeof record.operation_id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(record.operation_id)
    || typeof record.repository !== "string"
    || !NEXUS_CANONICAL_REPOSITORIES.has(record.repository)
    || typeof record.base_sha !== "string"
    || !SHA40.test(record.base_sha)
    || !["DIRECT_CANONICAL", "DIRECT_DELEGATED", "GOVERNED"].includes(String(record.execution_lane))
    || !["OWNER_INLINE", "TRACKED_TASK_CARD"].includes(String(record.authority_kind))
    || typeof record.request_hash !== "string"
    || !SHA64.test(record.request_hash)
    || typeof record.receipt_hash !== "string"
    || !SHA64.test(record.receipt_hash)
  ) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_INVALID", "Admission identity fields are invalid.");
  }
  const allowedPaths = validateAllowedPaths(record.allowed_paths);
  const issuedAt = new Date(String(record.issued_at));
  const expiresAt = new Date(String(record.expires_at));
  if (!Number.isFinite(issuedAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || expiresAt <= issuedAt) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_INVALID", "Admission time bounds are invalid.");
  }
  if (now.getTime() >= expiresAt.getTime()) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_EXPIRED", "Admission has expired.");
  }
  const hashPayload: Record<string, unknown> = {};
  for (const field of RECEIPT_FIELDS) {
    if (field !== "receipt_hash") hashPayload[field] = record[field];
  }
  const actualHash = sha256(canonicalJson(hashPayload));
  if (record.receipt_hash !== actualHash || expectedHash !== actualHash) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_HASH_MISMATCH", "Admission receipt hash does not match canonical record bytes.");
  }
  return {
    ...(record as unknown as NexusMutationAdmissionReceipt),
    allowed_paths: allowedPaths,
  };
}

export class NexusMutationAdmissionResolver {
  constructor(
    private readonly stateRoot: string | undefined,
    private readonly nowProvider: () => Date = () => new Date(),
  ) {}

  private async repositoryForWorkspace(workspaceRoot: string): Promise<string | undefined> {
    const eligibility = await getGitEligibility(workspaceRoot);
    if (!eligibility.ok || !eligibility.gitRoot) return undefined;
    try {
      const remote = (await git(eligibility.gitRoot, ["remote", "get-url", "origin"])).stdout.trim();
      return parseGitHubRepository(remote);
    } catch {
      return undefined;
    }
  }

  private async load(binding: NexusMutationAdmissionBinding): Promise<NexusMutationAdmissionReceipt> {
    const validated = validateBinding(binding);
    if (!this.stateRoot) {
      throw new NexusMutationAdmissionError(
        "NEXUS_MUTATION_ADMISSION_RESOLVER_UNAVAILABLE",
        "Canonical Nexus mutation admission state root is not configured.",
      );
    }
    const root = await realpath(resolve(this.stateRoot));
    let admissionsRoot: string;
    try {
      admissionsRoot = await realpath(resolve(root, "mutation-admissions"));
    } catch (error) {
      throw new NexusMutationAdmissionError(
        "NEXUS_MUTATION_ADMISSION_NOT_FOUND",
        `Canonical admission directory could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!(admissionsRoot === root || admissionsRoot.startsWith(root + sep))) {
      throw new NexusMutationAdmissionError(
        "NEXUS_MUTATION_ADMISSION_INVALID",
        "Canonical admission directory escapes the configured Nexus state root.",
      );
    }
    const expected = resolve(admissionsRoot, `${validated.admissionId}.json`);
    if (!(expected === admissionsRoot || expected.startsWith(admissionsRoot + sep))) {
      throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_INVALID", "Admission path escapes canonical admission directory.");
    }
    let handle;
    try {
      handle = await open(expected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const raw = await handle.readFile({ encoding: "utf8" });
      const receipt = parseReceipt(raw, validated.receiptHash, this.nowProvider());
      if (receipt.admission_id !== validated.admissionId) {
        throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_ID_MISMATCH", "Admission id does not match canonical record.");
      }
      if (receipt.operation_id !== validated.operationId) {
        throw new NexusMutationAdmissionError(
          "NEXUS_MUTATION_ADMISSION_OPERATION_MISMATCH",
          "Admission operation identity does not match the requested binding.",
        );
      }
      return receipt;
    } catch (error) {
      if (error instanceof NexusMutationAdmissionError) throw error;
      throw new NexusMutationAdmissionError(
        "NEXUS_MUTATION_ADMISSION_NOT_FOUND",
        `Canonical admission record could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await handle?.close();
    }
  }

  async authorizeWorkspaceMutation(input: {
    workspaceRoot: string;
    binding?: NexusMutationAdmissionBinding;
    expectedBase?: string;
    requestedPaths?: string[];
    operationId?: string;
  }): Promise<NexusMutationAdmissionDecision> {
    const repository = await this.repositoryForWorkspace(input.workspaceRoot);
    if (!repository || !NEXUS_CANONICAL_REPOSITORIES.has(repository)) {
      return { required: false, repository };
    }
    const receipt = await this.load(validateBinding(input.binding));
    if (receipt.repository !== repository) {
      throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_REPOSITORY_MISMATCH", "Admission repository does not match workspace repository.");
    }
    if (input.expectedBase && receipt.base_sha !== input.expectedBase.toLowerCase()) {
      throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_BASE_MISMATCH", "Admission base does not match the requested mutation base.");
    }
    let currentHead: string;
    try {
      currentHead = (await git(input.workspaceRoot, ["rev-parse", "HEAD"])).stdout.trim().toLowerCase();
      await git(input.workspaceRoot, ["merge-base", "--is-ancestor", receipt.base_sha, currentHead]);
    } catch {
      throw new NexusMutationAdmissionError(
        "NEXUS_MUTATION_ADMISSION_BASE_MISMATCH",
        "Admission base is not an ancestor of the current workspace HEAD.",
      );
    }
    const committedPaths = (await git(input.workspaceRoot, [
      "diff",
      "--name-only",
      "--no-renames",
      `${receipt.base_sha}..${currentHead}`,
    ])).stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const path of committedPaths) {
      if (!pathWithinAdmission(path, receipt.allowed_paths)) {
        throw new NexusMutationAdmissionError(
          "NEXUS_MUTATION_ADMISSION_SCOPE_MISMATCH",
          `Existing committed change is outside admitted scope: ${path}`,
        );
      }
    }
    let dirtyPaths: string[];
    try {
      const [unstaged, staged, untracked] = await Promise.all([
        git(input.workspaceRoot, ["diff", "--name-only", "--no-renames"]),
        git(input.workspaceRoot, ["diff", "--cached", "--name-only", "--no-renames"]),
        git(input.workspaceRoot, ["ls-files", "--others", "--exclude-standard"]),
      ]);
      dirtyPaths = Array.from(new Set(
        [unstaged.stdout, staged.stdout, untracked.stdout]
          .flatMap((value) => value.split(/\r?\n/))
          .map((path) => path.trim())
          .filter(Boolean),
      ));
    } catch (error) {
      throw new NexusMutationAdmissionError(
        "NEXUS_MUTATION_ADMISSION_WORKSPACE_STATE_UNKNOWN",
        `Unable to inspect workspace mutation state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const path of dirtyPaths) {
      if (!pathWithinAdmission(path, receipt.allowed_paths)) {
        throw new NexusMutationAdmissionError(
          "NEXUS_MUTATION_ADMISSION_SCOPE_MISMATCH",
          `Existing workspace mutation is outside admitted scope: ${path}`,
        );
      }
    }
    if (input.operationId && receipt.operation_id !== input.operationId) {
      throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_OPERATION_MISMATCH", "Admission operation identity does not match.");
    }
    for (const path of input.requestedPaths ?? []) {
      if (!requestedScopeWithinAdmission(path, receipt.allowed_paths)) {
        throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_SCOPE_MISMATCH", `Requested path is outside admitted scope: ${path}`);
      }
    }
    return { required: true, repository, receipt };
  }

  async authorizePublication(input: {
    workspaceRoot: string;
    binding?: NexusMutationAdmissionBinding;
    candidateHead: string;
    expectedBase?: string;
    requestedPaths?: string[];
    operationId?: string;
  }): Promise<NexusMutationAdmissionDecision> {
    const decision = await this.authorizeWorkspaceMutation({
      workspaceRoot: input.workspaceRoot,
      binding: input.binding,
      expectedBase: input.expectedBase,
      requestedPaths: input.requestedPaths,
      operationId: input.operationId,
    });
    if (!decision.required || !decision.receipt) return decision;
    const receipt = decision.receipt;
    try {
      await git(input.workspaceRoot, ["merge-base", "--is-ancestor", receipt.base_sha, input.candidateHead]);
    } catch {
      throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_BASE_MISMATCH", "Admission base is not an ancestor of publication head.");
    }
    const changed = (await git(input.workspaceRoot, ["diff", "--name-only", "--no-renames", `${receipt.base_sha}..${input.candidateHead}`]))
      .stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const path of changed) {
      if (!pathWithinAdmission(path, receipt.allowed_paths)) {
        throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_SCOPE_MISMATCH", `Published change is outside admitted scope: ${path}`);
      }
    }
    return decision;
  }
}

export function parseNexusMutationAdmissionBinding(value: unknown): NexusMutationAdmissionBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NexusMutationAdmissionError("NEXUS_MUTATION_ADMISSION_BINDING_INVALID", "mutationAdmission must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "admissionId,operationId,receiptHash") {
    throw new NexusMutationAdmissionError(
      "NEXUS_MUTATION_ADMISSION_BINDING_INVALID",
      "mutationAdmission must contain only admissionId, operationId, and receiptHash.",
    );
  }
  return validateBinding({
    admissionId: String(record.admissionId ?? ""),
    operationId: String(record.operationId ?? ""),
    receiptHash: String(record.receiptHash ?? ""),
  });
}
