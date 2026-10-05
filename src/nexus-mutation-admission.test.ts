import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertNexusMutationAdmission,
  NexusMutationAdmissionError,
  nexusAdmissionChangedPathsToHead,
  type NexusMutationAdmissionReceipt,
} from "./nexus-mutation-admission.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function hash(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(repository = "James3014/devspace") {
  const root = mkdtempSync(join(tmpdir(), "devspace-nexus-admission-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "tracked.txt"), "base\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "allowed.ts"), "export const value = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "remote", "add", "origin", `https://github.com/${repository}.git`);

  const stateRoot = join(root, ".test-nexus-state");
  const receipts = join(stateRoot, "mutation-admissions");
  mkdirSync(receipts, { recursive: true });
  const admissionId = "admission-" + "1".repeat(32);
  const receiptBase: Omit<NexusMutationAdmissionReceipt, "receipt_hash"> = {
    schema: "nexus.mutation_admission.v1",
    admission_id: admissionId,
    operation_id: "issue-364-test",
    repository,
    base_sha: base,
    execution_lane: "DIRECT_CANONICAL",
    authority_kind: "OWNER_INLINE",
    allowed_paths: ["src/**", "tracked.txt"],
    issue_number: 364,
    task_id: null,
    attempt_id: null,
    task_card_path: null,
    task_card_hash: null,
    governance_source_head: null,
    ttl_minutes: 60,
    issued_at: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    runtime_identity: {},
    authority_reference: { schema: "test-authority" },
    request_hash: "2".repeat(64),
  };
  const receipt = {
    ...receiptBase,
    receipt_hash: hash(receiptBase as unknown as Record<string, unknown>),
  } satisfies NexusMutationAdmissionReceipt;
  const path = join(receipts, `${admissionId}.json`);
  writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n");
  return {
    root,
    stateRoot,
    base,
    path,
    receipt,
    pointer: { admissionId, receiptHash: receipt.receipt_hash },
  };
}

test("canonical mutation consumes the persisted exact receipt and scope", async () => {
  const f = fixture();
  const consumed = await assertNexusMutationAdmission({
    stateRoot: f.stateRoot,
    workspaceRoot: f.root,
    pointer: f.pointer,
    expectedBase: f.base,
    requestedPaths: ["src/allowed.ts"],
  });
  assert.equal(consumed.required, true);
  assert.equal(consumed.repository, "James3014/devspace");
  assert.equal(consumed.receipt?.receipt_hash, f.pointer.receiptHash);
});

test("canonical mutation fails closed without an admission pointer", async () => {
  const f = fixture();
  await assert.rejects(
    assertNexusMutationAdmission({
      stateRoot: f.stateRoot,
      workspaceRoot: f.root,
      expectedBase: f.base,
      requestedPaths: ["src/allowed.ts"],
    }),
    (error: unknown) =>
      error instanceof NexusMutationAdmissionError
      && error.code === "NEXUS_MUTATION_ADMISSION_REQUIRED",
  );
});

test("tampered receipt, wrong base, repository, and scope fail closed", async () => {
  const f = fixture();
  const tampered = { ...f.receipt, operation_id: "caller-forged" };
  writeFileSync(f.path, JSON.stringify(tampered, null, 2) + "\n");
  await assert.rejects(
    assertNexusMutationAdmission({
      stateRoot: f.stateRoot,
      workspaceRoot: f.root,
      pointer: f.pointer,
      expectedBase: f.base,
      requestedPaths: ["src/allowed.ts"],
    }),
    /NEXUS_MUTATION_ADMISSION_RECEIPT_HASH_MISMATCH/,
  );

  writeFileSync(f.path, JSON.stringify(f.receipt, null, 2) + "\n");
  await assert.rejects(
    assertNexusMutationAdmission({
      stateRoot: f.stateRoot,
      workspaceRoot: f.root,
      pointer: f.pointer,
      expectedBase: "a".repeat(40),
      requestedPaths: ["src/allowed.ts"],
    }),
    /NEXUS_MUTATION_ADMISSION_BASE_MISMATCH/,
  );
  await assert.rejects(
    assertNexusMutationAdmission({
      stateRoot: f.stateRoot,
      workspaceRoot: f.root,
      pointer: f.pointer,
      expectedRepository: "James3014/Nexus-new",
      expectedBase: f.base,
      requestedPaths: ["src/allowed.ts"],
    }),
    /NEXUS_MUTATION_ADMISSION_REPOSITORY_MISMATCH/,
  );
  await assert.rejects(
    assertNexusMutationAdmission({
      stateRoot: f.stateRoot,
      workspaceRoot: f.root,
      pointer: f.pointer,
      expectedBase: f.base,
      requestedPaths: ["outside.txt"],
    }),
    /NEXUS_MUTATION_ADMISSION_SCOPE_ESCAPE/,
  );
});

test("expired receipts fail closed", async () => {
  const f = fixture();
  await assert.rejects(
    assertNexusMutationAdmission({
      stateRoot: f.stateRoot,
      workspaceRoot: f.root,
      pointer: f.pointer,
      expectedBase: f.base,
      requestedPaths: ["tracked.txt"],
      nowMs: Date.now() + 120_000,
    }),
    /NEXUS_MUTATION_ADMISSION_EXPIRED/,
  );
});

test("candidate publication accepts admitted base ancestry and derives bounded changed paths", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "src", "allowed.ts"), "export const value = 2;\n");
  git(f.root, "add", "src/allowed.ts");
  git(f.root, "commit", "-m", "candidate");
  const head = git(f.root, "rev-parse", "HEAD");

  const consumed = await assertNexusMutationAdmission({
    stateRoot: f.stateRoot,
    workspaceRoot: f.root,
    pointer: f.pointer,
    expectedBase: head,
    basePolicy: "ANCESTOR",
  });
  assert.ok(consumed.receipt);
  const changed = await nexusAdmissionChangedPathsToHead(f.root, consumed.receipt!, head);
  assert.deepEqual(changed, ["src/allowed.ts"]);
  await assert.doesNotReject(
    assertNexusMutationAdmission({
      stateRoot: f.stateRoot,
      workspaceRoot: f.root,
      pointer: f.pointer,
      expectedBase: head,
      basePolicy: "ANCESTOR",
      requestedPaths: changed,
    }),
  );
});

test("noncanonical repositories do not acquire Nexus mutation authority", async () => {
  const f = fixture("someone/example");
  const consumed = await assertNexusMutationAdmission({
    workspaceRoot: f.root,
    requestedPaths: ["tracked.txt"],
  });
  assert.deepEqual(consumed, { required: false });
});
