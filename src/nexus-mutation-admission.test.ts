import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { git } from "./git.js";
import {
  NexusMutationAdmissionError,
  NexusMutationAdmissionResolver,
  parseNexusMutationAdmissionBinding,
} from "./nexus-mutation-admission.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function fixture(options: {
  remote?: string;
  allowedPaths?: string[];
  expiresAt?: string;
  repository?: string;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "devspace-admission-"));
  const repo = join(root, "repo");
  const stateRoot = join(root, "nexus-state");
  await mkdir(repo);
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, "allowed.txt"), "base\n", "utf8");
  await git(repo, ["add", "allowed.txt"]);
  await git(repo, ["commit", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", options.remote ?? "https://github.com/James3014/devspace.git"]);
  const base = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();

  const operationId = "issue362-test-operation";
  const admissionId = "admission-" + sha256(operationId).slice(0, 32);
  const issuedAt = "2026-10-05T05:00:00.000000+00:00";
  const payload: Record<string, unknown> = {
    schema: "nexus.mutation_admission.v1",
    admission_id: admissionId,
    operation_id: operationId,
    repository: options.repository ?? "James3014/devspace",
    base_sha: base,
    execution_lane: "DIRECT_CANONICAL",
    authority_kind: "OWNER_INLINE",
    allowed_paths: options.allowedPaths ?? ["allowed.txt", "src/**"],
    issue_number: 362,
    task_id: null,
    attempt_id: null,
    task_card_path: null,
    task_card_hash: null,
    governance_source_head: null,
    ttl_minutes: 10080,
    issued_at: issuedAt,
    expires_at: options.expiresAt ?? "2026-10-12T05:00:00.000000+00:00",
    runtime_identity: { gateway_source_head: "a".repeat(40) },
    authority_reference: {
      schema: "nexus.standing_grant_effect_authorization.v1",
      owner_id: "James3014",
      action: "TASK_SUBMIT",
      mutation_authorized: true,
    },
    request_hash: "b".repeat(64),
    receipt_hash: "",
  };
  const hashPayload = { ...payload };
  delete hashPayload.receipt_hash;
  payload.receipt_hash = sha256(canonicalJson(hashPayload));

  const admissions = join(stateRoot, "mutation-admissions");
  await mkdir(admissions, { recursive: true });
  await writeFile(join(admissions, `${admissionId}.json`), JSON.stringify(payload, null, 2) + "\n", "utf8");

  return {
    root,
    repo,
    stateRoot,
    base,
    operationId,
    admissionId,
    receiptHash: payload.receipt_hash as string,
    payload,
  };
}

const now = () => new Date("2026-10-05T06:00:00.000Z");

test("canonical repository mutation requires admission binding", async () => {
  const f = await fixture();
  const resolver = new NexusMutationAdmissionResolver(f.stateRoot, now);
  await assert.rejects(
    resolver.authorizeWorkspaceMutation({ workspaceRoot: f.repo, expectedBase: f.base, requestedPaths: ["allowed.txt"] }),
    (error: unknown) => error instanceof NexusMutationAdmissionError && error.code === "NEXUS_MUTATION_ADMISSION_REQUIRED",
  );
});

test("canonical mutation fails closed when resolver state root is unavailable", async () => {
  const f = await fixture();
  const resolver = new NexusMutationAdmissionResolver(undefined, now);
  await assert.rejects(
    resolver.authorizeWorkspaceMutation({
      workspaceRoot: f.repo,
      binding: { admissionId: f.admissionId, receiptHash: f.receiptHash },
      expectedBase: f.base,
      requestedPaths: ["allowed.txt"],
    }),
    (error: unknown) => error instanceof NexusMutationAdmissionError && error.code === "NEXUS_MUTATION_ADMISSION_RESOLVER_UNAVAILABLE",
  );
});

test("valid canonical admission authorizes exact base and bounded scope", async () => {
  const f = await fixture();
  const resolver = new NexusMutationAdmissionResolver(f.stateRoot, now);
  const result = await resolver.authorizeWorkspaceMutation({
    workspaceRoot: f.repo,
    binding: { admissionId: f.admissionId, receiptHash: f.receiptHash },
    expectedBase: f.base,
    requestedPaths: ["allowed.txt", "src/owned"],
    operationId: f.operationId,
  });
  assert.equal(result.required, true);
  assert.equal(result.repository, "James3014/devspace");
  assert.equal(result.receipt?.receipt_hash, f.receiptHash);
});

test("caller cannot smuggle receipt payload through the binding", () => {
  assert.throws(
    () => parseNexusMutationAdmissionBinding({
      admissionId: "admission-" + "a".repeat(32),
      receiptHash: "b".repeat(64),
      allowed_paths: ["**"],
    }),
    (error: unknown) => error instanceof NexusMutationAdmissionError && error.code === "NEXUS_MUTATION_ADMISSION_BINDING_INVALID",
  );
});

test("hash, expiry, repository, base and scope mismatches fail closed", async () => {
  const f = await fixture();
  const resolver = new NexusMutationAdmissionResolver(f.stateRoot, now);

  await assert.rejects(
    resolver.authorizeWorkspaceMutation({
      workspaceRoot: f.repo,
      binding: { admissionId: f.admissionId, receiptHash: "f".repeat(64) },
      expectedBase: f.base,
      requestedPaths: ["allowed.txt"],
    }),
    (error: unknown) => error instanceof NexusMutationAdmissionError && error.code === "NEXUS_MUTATION_ADMISSION_HASH_MISMATCH",
  );

  await assert.rejects(
    resolver.authorizeWorkspaceMutation({
      workspaceRoot: f.repo,
      binding: { admissionId: f.admissionId, receiptHash: f.receiptHash },
      expectedBase: "f".repeat(40),
      requestedPaths: ["allowed.txt"],
    }),
    (error: unknown) => error instanceof NexusMutationAdmissionError && error.code === "NEXUS_MUTATION_ADMISSION_BASE_MISMATCH",
  );

  await assert.rejects(
    resolver.authorizeWorkspaceMutation({
      workspaceRoot: f.repo,
      binding: { admissionId: f.admissionId, receiptHash: f.receiptHash },
      expectedBase: f.base,
      requestedPaths: ["outside.txt"],
    }),
    (error: unknown) => error instanceof NexusMutationAdmissionError && error.code === "NEXUS_MUTATION_ADMISSION_SCOPE_MISMATCH",
  );

  const wrongRepo = await fixture({ repository: "James3014/nexus-core" });
  await assert.rejects(
    new NexusMutationAdmissionResolver(wrongRepo.stateRoot, now).authorizeWorkspaceMutation({
      workspaceRoot: wrongRepo.repo,
      binding: { admissionId: wrongRepo.admissionId, receiptHash: wrongRepo.receiptHash },
      expectedBase: wrongRepo.base,
      requestedPaths: ["allowed.txt"],
    }),
    (error: unknown) => error instanceof NexusMutationAdmissionError && error.code === "NEXUS_MUTATION_ADMISSION_REPOSITORY_MISMATCH",
  );

  const expired = await fixture({ expiresAt: "2026-10-05T05:30:00.000000+00:00" });
  await assert.rejects(
    new NexusMutationAdmissionResolver(expired.stateRoot, now).authorizeWorkspaceMutation({
      workspaceRoot: expired.repo,
      binding: { admissionId: expired.admissionId, receiptHash: expired.receiptHash },
      expectedBase: expired.base,
      requestedPaths: ["allowed.txt"],
    }),
    (error: unknown) => error instanceof NexusMutationAdmissionError && error.code === "NEXUS_MUTATION_ADMISSION_EXPIRED",
  );
});

test("publication verifies admitted base ancestry and physical changed paths", async () => {
  const f = await fixture({ allowedPaths: ["allowed.txt"] });
  await writeFile(join(f.repo, "allowed.txt"), "changed\n", "utf8");
  await git(f.repo, ["add", "allowed.txt"]);
  await git(f.repo, ["commit", "-m", "candidate"]);
  const head = (await git(f.repo, ["rev-parse", "HEAD"])).stdout.trim();

  const resolver = new NexusMutationAdmissionResolver(f.stateRoot, now);
  const result = await resolver.authorizePublication({
    workspaceRoot: f.repo,
    binding: { admissionId: f.admissionId, receiptHash: f.receiptHash },
    candidateHead: head,
  });
  assert.equal(result.required, true);

  const outside = await fixture({ allowedPaths: ["allowed.txt"] });
  await writeFile(join(outside.repo, "outside.txt"), "nope\n", "utf8");
  await git(outside.repo, ["add", "outside.txt"]);
  await git(outside.repo, ["commit", "-m", "outside"]);
  const outsideHead = (await git(outside.repo, ["rev-parse", "HEAD"])).stdout.trim();
  await assert.rejects(
    new NexusMutationAdmissionResolver(outside.stateRoot, now).authorizePublication({
      workspaceRoot: outside.repo,
      binding: { admissionId: outside.admissionId, receiptHash: outside.receiptHash },
      candidateHead: outsideHead,
    }),
    (error: unknown) => error instanceof NexusMutationAdmissionError && error.code === "NEXUS_MUTATION_ADMISSION_SCOPE_MISMATCH",
  );
});

test("non-canonical repositories remain outside Nexus mutation admission scope", async () => {
  const f = await fixture({ remote: "https://github.com/example/other.git" });
  const result = await new NexusMutationAdmissionResolver(undefined, now).authorizeWorkspaceMutation({
    workspaceRoot: f.repo,
    expectedBase: f.base,
    requestedPaths: ["anything.txt"],
  });
  assert.equal(result.required, false);
  assert.equal(result.repository, "example/other");
});
