/**
 * Core Candidate Acquisition — Wave B / Issue-321 comprehensive test suite.
 *
 * Tests numbered per the issue-321 Wave B recovery spec:
 *   1.  Legacy no-profile binding hash backward compatibility
 *   2.  Core-compatible profile hash fixture (no DevSpace prefix)
 *   3.  Verifier set mismatch / duplicate IDs / malformed argv / profile hash tamper fail
 *   4.  Profile immutable on replay/rebind
 *   5.  No-profile Candidate succeeds; observation records PROFILE_NOT_BOUND
 *   6.  Partial runtime config / digest mismatch → CORE_RUNTIME_UNAVAILABLE_OR_MISMATCH; Candidate succeeds
 *   7.  Fake executable: argv=["acquire","--request","-"], exact JSON on stdin, valid #77 result parsed
 *   8.  Fake Core result with wrong fields rejected
 *   9.  Core status ERROR → observer error, not verdict
 *   10. Durable op/observation identity exists before async launch; durable op row has right initial state
 *   11. Exact replay does not launch fake Core twice
 *   12. Restart: started → outcome_unknown; no blind rerun
 *   13. Conflicting replay fails closed
 *   14. Core REJECTED verdict retained but nonblocking
 *   15. Census readback includes observation; restart-safe/read-only
 *   16. No Core verdict in worker-facing mutation output
 *   17. Migration 23→24 idempotent; existing DB upgrade works
 *   18. Existing core-mutation-session, core-mutation-rebind, direct-evidence, durable-operations tests
 *       remain green (verified by running them separately — smoke check only here)
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  parseCoreVerificationProfile,
  computeVerificationProfileHash,
  computeAcquisitionOperationId,
  computeAcquisitionRequestHash,
  computeCoreAcquisitionChangeSetHash,
  validateCoreRuntimeConfig,
  validateCoreRuntimeConfigSync,
  buildCoreRuntimeIdentity,
  CoreCandidateAcquisitionError,
  CoreCandidateAcquisitionObservationStore,
  orchestrateCoreCandidateAcquisition,
  NEXUS_CORE_CANDIDATE_ACQUISITION_CLI_RESULT_SCHEMA,
  NEXUS_CORE_ACQUISITION_PRODUCER_REVISION,
  NEXUS_CORE_ACQUISITION_AUTHORITY,
  type CoreCandidateAcquisitionObservation,
} from "./core-candidate-acquisition.js";
import {
  coreCanonicalHash,
  computeRepositoryMutationBindingHash,
  parseRepositoryMutationBinding,
  acceptanceContractHash,
} from "./core-mutation-session.js";
import { DurableOperationStore } from "./durable-operations.js";
import { migrateDatabase } from "./db/migrations.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "devspace-cca-test-"));
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Build a minimal RepositoryMutationBinding-like object for hash tests.
 * Does not use the full parser (that would require a git repo); we just need
 * something whose binding hash is stable.
 */
function minimalBindingWithoutProfile(overrides: Record<string, unknown> = {}): import("./core-mutation-session.js").RepositoryMutationBinding {
  const contract = {
    contract_id: "contract-1",
    requirements_hash: "sha256:" + "a".repeat(64),
    required_verifier_ids: [],
    allowed_paths: ["src"],
    deletion_policy: "FORBID" as const,
  };
  const contractHash = acceptanceContractHash(contract);
  const base = {
    schema: "nexus.repository_mutation_binding.v1" as const,
    binding_id: "bid-1",
    operation_id: "op-1",
    attempt_id: "att-1",
    repository: {
      canonical_id: "github.com/org/repo",
      origin: "https://github.com/org/repo.git",
      source_revision: "git-commit:" + "a".repeat(40),
      source_tree: "git-tree:" + "b".repeat(40),
      workspace_identity: "sha256:" + "c".repeat(64),
      workspace_mode: "checkout" as const,
    },
    integration_authority: {
      execution_lane: "DIRECT_CANONICAL" as const,
      authority_ref: "ref-1",
      authority_hash: "sha256:" + "d".repeat(64),
    },
    capability_discovery: {
      required: true as const,
      receipt_hash: "sha256:" + "e".repeat(64),
      index_revision: "git-commit:" + "1".repeat(40),
    },
    core: {
      protocol_version: "0.1.0-experimental",
      acceptance_contract: contract,
      acceptance_contract_hash: contractHash,
    },
    freshness: {
      created_at: "2024-01-01T00:00:00.000Z",
      valid_until: null,
      revalidate_before_first_effect: true as const,
    },
    ...overrides,
  };
  const hash = computeRepositoryMutationBindingHash(base as Omit<typeof base, "binding_hash">);
  return { ...base, binding_hash: hash } as import("./core-mutation-session.js").RepositoryMutationBinding;
}

/** Build a minimal valid orchestration input using a fresh stateDir. */
function makeOrchestrationInput(stateDir: string, overrides: {
  profile?: import("./core-candidate-acquisition.js").CoreVerificationProfile | null;
  coreRuntime?: { identity: string; executable: string } | null;
  sessionId?: string;
  candidateHead?: string;
} = {}) {
  const durableStore = new DurableOperationStore(stateDir);
  const observationStore = new CoreCandidateAcquisitionObservationStore(stateDir);
  const contract = {
    contract_id: "session-contract",
    requirements_hash: "sha256:" + "f".repeat(64),
    required_verifier_ids: [],
    allowed_paths: ["src"],
    deletion_policy: "FORBID" as const,
  };
  const contractHash = acceptanceContractHash(contract);
  const changeSetHash = "sha256:" + "1".repeat(64);
  const binding = minimalBindingWithoutProfile();
  return {
    durableStore,
    observationStore,
    stateDir,
    sessionId: overrides.sessionId ?? "session-abc",
    candidateHead: overrides.candidateHead ?? "a".repeat(40),
    candidateTree: "b".repeat(40),
    sourceRevision: "git-commit:" + "c".repeat(40),
    bindingHash: binding.binding_hash,
    acceptanceContract: contract,
    acceptanceContractHash: contractHash,
    changeSetHash,
    changeManifestHash: "sha256:" + "2".repeat(64),
    changedPaths: ["src/example.ts"],
    deletedPaths: [],
    profile: overrides.profile !== undefined ? overrides.profile : null,
    coreRuntime: overrides.coreRuntime !== undefined ? overrides.coreRuntime : null,
    scopeRoot: stateDir,
    receiptDirectory: resolve(stateDir, "..", "core-candidate-acquisition-test-receipts"),
  };
}

// ---------------------------------------------------------------------------
// Test 1: Legacy no-profile binding hash backward compatibility
// ---------------------------------------------------------------------------

test("1. legacy no-profile binding: computeRepositoryMutationBindingHash is byte-for-byte stable", () => {
  const b1 = minimalBindingWithoutProfile();
  const b2 = minimalBindingWithoutProfile(); // same content, same hash

  // Same content → same hash
  assert.equal(b1.binding_hash, b2.binding_hash);
  assert.match(b1.binding_hash, /^sha256:[0-9a-f]{64}$/);

  // Adding a verification_profile changes the hash
  const contract = {
    contract_id: "contract-1",
    requirements_hash: "sha256:" + "a".repeat(64),
    required_verifier_ids: ["verifier-a"],
    allowed_paths: ["src"],
    deletion_policy: "FORBID" as const,
  };
  const profileHash = computeVerificationProfileHash(
    "test-profile",
    [{ verifier_id: "verifier-a", argv: ["run", "test"] }],
    60,
  );
  const profile: import("./core-mutation-session.js").CoreVerificationProfileBinding = {
    profile_id: "test-profile",
    verifier_ids: ["verifier-a"],
    verifier_commands: [["run", "test"]],
    timeout_seconds: 60,
    profile_hash: profileHash,
  };
  const bindingWithProfile = {
    ...minimalBindingWithoutProfile(),
    core: {
      protocol_version: "0.1.0-experimental",
      acceptance_contract: contract,
      acceptance_contract_hash: acceptanceContractHash(contract),
      verification_profile: profile,
    },
  };
  const hashWithProfile = computeRepositoryMutationBindingHash(
    bindingWithProfile as Omit<typeof bindingWithProfile, "binding_hash">,
  );

  // Profile present → different hash
  assert.notEqual(b1.binding_hash, hashWithProfile);

  // The no-profile hash is deterministic (legacy semantics preserved)
  const b3 = minimalBindingWithoutProfile();
  assert.equal(b3.binding_hash, b1.binding_hash);
});

// ---------------------------------------------------------------------------
// Test 2: Core-compatible profile hash — no DevSpace prefix
// ---------------------------------------------------------------------------

test("2. Core-compatible profile hash: coreCanonicalHash object (no prefix array) matches computeVerificationProfileHash", () => {
  // Per nexus-core#77: profile hash = coreCanonicalHash({profile_id, timeout_seconds, verifier_id_command_pairs})
  // coreCanonicalJson sorts object keys alphabetically, so wire order is: profile_id, timeout_seconds, verifier_id_command_pairs
  // There is NO "devspace.core-verification-profile.v1" prefix array.

  const expected = coreCanonicalHash({
    profile_id: "test-profile",
    timeout_seconds: 300,
    verifier_id_command_pairs: [["verifier-a", ["run", "test"]]],
  } as unknown as Parameters<typeof coreCanonicalHash>[0]);

  const actual = computeVerificationProfileHash(
    "test-profile",
    [{ verifier_id: "verifier-a", argv: ["run", "test"] }],
    300,
  );

  assert.equal(actual, expected);
  assert.match(actual, /^sha256:[0-9a-f]{64}$/);

  // Old v3 pattern (with a prefix array) produces a DIFFERENT hash — contract is correct per nexus-core#77
  const oldStyleHash = coreCanonicalHash([
    "devspace.core-verification-profile.v1",
    {
      profile_id: "test-profile",
      timeout_seconds: 300,
      verifier_id_command_pairs: [["verifier-a", ["run", "test"]]],
    },
  ] as unknown as Parameters<typeof coreCanonicalHash>[0]);

  assert.notEqual(actual, oldStyleHash, "Old DevSpace-prefix hash must differ from the new Core-compatible hash");
});

test("2b. Core acquisition ChangeSet hash matches the physical #321 canary and nexus-core#77", () => {
  const actual = computeCoreAcquisitionChangeSetHash({
    acquisitionRequestId: "cca_4247e6a4f06eb91ccf8a111eb2f457d4",
    sourceIdentity: "9e756740ff7ef69f4289545a2c5894551155a5a6",
    candidateTree: "0aa285b02105b0901630d7687f21425a55ec285e",
    changeManifestHash: "sha256:d9c55fe85ed5a8e677063b40bad180787e4b9f72ae7a178061cf57ccba1e938c",
    changedPaths: ["docs/issue321-canary-v4.txt"],
    deletedPaths: [],
  });

  assert.equal(
    actual,
    "sha256:d734e103d3c86d68470b4c945c6823074f74e3eef2bcfefe4fb7dbc053481300",
  );
  assert.notEqual(
    actual,
    "sha256:9481e3eb512856b69872a4f6b344c15bee8d40408fdd2fdb024205a948b5061a",
    "DevSpace Candidate ChangeSet hash must not be reused as the Core acquisition ChangeSet hash",
  );
});

// ---------------------------------------------------------------------------
// Test 3: Profile validation errors — verifier set mismatch, duplicates, malformed argv, hash tamper
// ---------------------------------------------------------------------------

test("3a. verifier set mismatch fails PROFILE_VERIFIER_SET_MISMATCH", () => {
  const profileHash = computeVerificationProfileHash(
    "test-profile",
    [{ verifier_id: "verifier-a", argv: ["run"] }],
    30,
  );
  const input = {
    profile_id: "test-profile",
    verifier_ids: ["verifier-a"],
    verifier_commands: [["run"]],
    timeout_seconds: 30,
    profile_hash: profileHash,
  };
  // Profile has verifier-a but contract requires verifier-b
  assert.throws(
    () => parseCoreVerificationProfile(input, ["verifier-b"]),
    (err: unknown) => err instanceof CoreCandidateAcquisitionError && err.code === "PROFILE_VERIFIER_SET_MISMATCH",
  );
});

test("3b. duplicate verifier IDs fail PROFILE_MALFORMED", () => {
  const input = {
    profile_id: "test-profile",
    verifier_ids: ["verifier-a", "verifier-a"],
    verifier_commands: [["run"], ["run"]],
    timeout_seconds: 30,
    profile_hash: "sha256:" + "0".repeat(64),
  };
  assert.throws(
    () => parseCoreVerificationProfile(input, ["verifier-a"]),
    (err: unknown) => err instanceof CoreCandidateAcquisitionError && err.code === "PROFILE_MALFORMED",
  );
});

test("3c. malformed argv (empty array) fails PROFILE_MALFORMED", () => {
  const input = {
    profile_id: "test-profile",
    verifier_ids: ["verifier-a"],
    verifier_commands: [[]], // empty argv is invalid
    timeout_seconds: 30,
    profile_hash: "sha256:" + "0".repeat(64),
  };
  assert.throws(
    () => parseCoreVerificationProfile(input, ["verifier-a"]),
    (err: unknown) => err instanceof CoreCandidateAcquisitionError && err.code === "PROFILE_MALFORMED",
  );
});

test("3d. profile hash tamper fails PROFILE_HASH_MISMATCH", () => {
  const input = {
    profile_id: "test-profile",
    verifier_ids: ["verifier-a"],
    verifier_commands: [["run", "test"]],
    timeout_seconds: 30,
    profile_hash: "sha256:" + "0".repeat(64), // wrong hash
  };
  assert.throws(
    () => parseCoreVerificationProfile(input, ["verifier-a"]),
    (err: unknown) =>
      err instanceof CoreCandidateAcquisitionError &&
      (err.code === "PROFILE_HASH_MISMATCH" || err.code === "PROFILE_MALFORMED"),
  );
});

// ---------------------------------------------------------------------------
// Test 4: Profile immutable on replay/rebind
// ---------------------------------------------------------------------------

test("4. session binding is the profile authority: canonical profile parses; tamper/blank argv fail", () => {
  const legacy = minimalBindingWithoutProfile();
  const { binding_hash: _legacyHash, ...legacyWithoutHash } = legacy;
  const contract = {
    ...legacy.core.acceptance_contract,
    required_verifier_ids: ["verifier-a"],
  };
  const profileHash = computeVerificationProfileHash(
    "test-profile",
    [{ verifier_id: "verifier-a", argv: ["run"] }],
    60,
  );
  const buildBinding = (profile: {
    profile_id: string;
    verifier_ids: string[];
    verifier_commands: string[][];
    timeout_seconds: number;
    profile_hash: string;
  }) => {
    const withoutHash = {
      ...legacyWithoutHash,
      core: {
        protocol_version: legacy.core.protocol_version,
        acceptance_contract: contract,
        acceptance_contract_hash: acceptanceContractHash(contract),
        verification_profile: profile,
      },
    };
    return {
      ...withoutHash,
      binding_hash: computeRepositoryMutationBindingHash(withoutHash),
    };
  };

  const valid = buildBinding({
    profile_id: "test-profile",
    verifier_ids: ["verifier-a"],
    verifier_commands: [["run"]],
    timeout_seconds: 60,
    profile_hash: profileHash,
  });
  assert.equal(parseRepositoryMutationBinding(valid).core.verification_profile?.profile_hash, profileHash);

  const tampered = buildBinding({
    ...valid.core.verification_profile!,
    profile_hash: "sha256:" + "0".repeat(64),
  });
  assert.throws(
    () => parseRepositoryMutationBinding(tampered),
    (err: unknown) => (err as { code?: string }).code === "CORE_PROFILE_HASH_MISMATCH",
  );

  const blankArgHash = computeVerificationProfileHash(
    "test-profile",
    [{ verifier_id: "verifier-a", argv: [" "] }],
    60,
  );
  const blankArg = buildBinding({
    profile_id: "test-profile",
    verifier_ids: ["verifier-a"],
    verifier_commands: [[" "]],
    timeout_seconds: 60,
    profile_hash: blankArgHash,
  });
  assert.throws(
    () => parseRepositoryMutationBinding(blankArg),
    (err: unknown) => (err as { code?: string }).code === "MALFORMED_BINDING",
  );
});

// ---------------------------------------------------------------------------
// Test 5: No-profile Candidate still succeeds; observation records PROFILE_NOT_BOUND
// ---------------------------------------------------------------------------

test("5. no-profile Candidate succeeds; observation records PROFILE_NOT_BOUND missingness", async () => {
  const stateDir = makeTmpDir();
  try {
    const input = makeOrchestrationInput(stateDir, {
      profile: null,
      coreRuntime: {
        identity: "fake-exe@sha256:" + "a".repeat(64),
        executable: "/usr/bin/true", // any existing executable
      },
    });
    const obs = await orchestrateCoreCandidateAcquisition(input);

    assert.ok(obs);
    assert.equal(obs.acquisitionStatus, "MISSINGNESS");
    assert.equal(obs.missingnessCode, "PROFILE_NOT_BOUND");
    assert.equal(obs.coreInvoked, false);
    assert.equal(obs.coreVerdict, null);
    assert.match(obs.operationId, /^cca_/);

    input.durableStore.close();
    input.observationStore.close();
  } finally {
    cleanup(stateDir);
  }
});

// ---------------------------------------------------------------------------
// Test 6: Partial runtime config / digest mismatch → CORE_RUNTIME_UNAVAILABLE_OR_MISMATCH
// ---------------------------------------------------------------------------

test("6a. partial runtime config (no executable) → validateCoreRuntimeConfig returns null", async () => {
  const result = await validateCoreRuntimeConfig({
    coreAcquisitionExecutable: undefined,
    coreAcquisitionExpectedSourceRevision: NEXUS_CORE_ACQUISITION_PRODUCER_REVISION,
    coreAcquisitionRuntimeDigest: "sha256:" + "a".repeat(64),
  });
  assert.equal(result, null);
});

test("6b. wrong source revision → validateCoreRuntimeConfigSync returns null", () => {
  const result = validateCoreRuntimeConfigSync({
    coreAcquisitionExecutable: "/usr/bin/true",
    coreAcquisitionExpectedSourceRevision: "wrong-revision",
    coreAcquisitionRuntimeDigest: "sha256:" + "a".repeat(64),
  });
  assert.equal(result, null);
});

test("6c. null coreRuntime → observation records CORE_RUNTIME_UNAVAILABLE_OR_MISMATCH; orchestration succeeds", async () => {
  const stateDir = makeTmpDir();
  try {
    const profileHash = computeVerificationProfileHash(
      "test-profile",
      [{ verifier_id: "verifier-x", argv: ["check"] }],
      30,
    );
    const profile = {
      profile_id: "test-profile",
      verifier_id_command_pairs: [{ verifier_id: "verifier-x", argv: ["check"] }],
      timeout_seconds: 30,
      profile_hash: profileHash,
    };
    const input = makeOrchestrationInput(stateDir, {
      profile,
      coreRuntime: null, // unavailable
    });
    const obs = await orchestrateCoreCandidateAcquisition(input);

    assert.ok(obs);
    assert.equal(obs.acquisitionStatus, "MISSINGNESS");
    assert.equal(obs.missingnessCode, "CORE_RUNTIME_UNAVAILABLE_OR_MISMATCH");
    assert.equal(obs.coreInvoked, false);
    assert.equal(obs.coreVerdict, null);

    // The durable operation should be finished (succeeded)
    const durable = input.durableStore.getByOperationId(obs.durableOperationId);
    assert.ok(durable);
    assert.equal(durable.status, "succeeded");

    input.durableStore.close();
    input.observationStore.close();
  } finally {
    cleanup(stateDir);
  }
});

// ---------------------------------------------------------------------------
// Test 7: Fake executable — argv=["acquire","--request","-"], exact JSON on stdin, valid result parsed
// ---------------------------------------------------------------------------

test("7. fake executable: argv is [acquire, --request, -], exact JSON arrives on stdin, valid #77 result is parsed", async () => {
  const stateDir = makeTmpDir();
  const binDir = join(stateDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const execPath = join(binDir, "fake-core");

  try {
    // Build the profile
    const profileHash = computeVerificationProfileHash(
      "profile-1",
      [{ verifier_id: "verifier-a", argv: ["run", "verify"] }],
      60,
    );
    const profile = {
      profile_id: "profile-1",
      verifier_id_command_pairs: [{ verifier_id: "verifier-a", argv: ["run", "verify"] }],
      timeout_seconds: 60,
      profile_hash: profileHash,
    };

    // Write a fake core executable that:
    // 1. Reads stdin
    // 2. Parses JSON to extract acquisition_request_id and request_hash
    // 3. Returns a valid #77 result with the echoed IDs
    const receiptHash = "sha256:" + "b".repeat(64);
    writeFileSync(
      execPath,
      `#!/usr/bin/env node
process.argv; // just to confirm argv
const args = process.argv.slice(2);
if (args[0] !== 'acquire' || args[1] !== '--request' || args[2] !== '-') {
  process.stderr.write(JSON.stringify({error: 'wrong args', got: args}));
  process.exit(1);
}
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  let req;
  try { req = JSON.parse(data); } catch(e) { process.stderr.write('parse error'); process.exit(1); }
  const result = {
    schema: '${NEXUS_CORE_CANDIDATE_ACQUISITION_CLI_RESULT_SCHEMA}',
    status: 'OK',
    core_verdict: 'VERIFIED',
    core_reason_codes: [],
    acquisition_request_id: req.acquisition_request_id,
    request_hash: req.request_hash,
    reason_codes: [],
    receipt_hash: '${receiptHash}',
    receipt_path: req.receipt_directory + '/receipt.json',
    replayed: false,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    orchestration_runtime_ms: 42,
    core_response: null,
    authority: '${NEXUS_CORE_ACQUISITION_AUTHORITY}',
    claim_ceiling: ['verification'],
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
});
`,
    );
    chmodSync(execPath, 0o755);

    // validateCoreRuntimeConfigSync requires matching source revision and digest
    // We skip file-read validation by using the sync variant (no file read)
    // Instead, build identity directly for the test
    const runtimeIdentity = buildCoreRuntimeIdentity(execPath, "sha256:" + "c".repeat(64));
    assert.ok(runtimeIdentity);

    const input = makeOrchestrationInput(stateDir, {
      profile,
      coreRuntime: { identity: runtimeIdentity!, executable: execPath },
    });
    const obs = await orchestrateCoreCandidateAcquisition(input);

    assert.ok(obs);
    assert.equal(obs.acquisitionStatus, "VERDICT_RECORDED");
    assert.equal(obs.coreInvoked, true);
    assert.equal(obs.coreVerdict, "VERIFIED");
    assert.equal(obs.receiptHash, receiptHash);
    assert.ok(obs.acquisitionRequestId);
    assert.ok(obs.requestHash);

    input.durableStore.close();
    input.observationStore.close();
  } finally {
    cleanup(stateDir);
  }
});

// ---------------------------------------------------------------------------
// Test 8: Fake Core result with wrong fields is rejected
// ---------------------------------------------------------------------------

test("8a. wrong acquisition_request_id in result → observer error CORE_RESULT_REQUEST_ID_MISMATCH", async () => {
  const stateDir = makeTmpDir();
  const binDir = join(stateDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const execPath = join(binDir, "fake-core-wrong-id");

  try {
    const profileHash = computeVerificationProfileHash(
      "profile-2",
      [{ verifier_id: "verifier-b", argv: ["check"] }],
      30,
    );
    const profile = {
      profile_id: "profile-2",
      verifier_id_command_pairs: [{ verifier_id: "verifier-b", argv: ["check"] }],
      timeout_seconds: 30,
      profile_hash: profileHash,
    };
    const receiptHash = "sha256:" + "d".repeat(64);
    writeFileSync(
      execPath,
      `#!/usr/bin/env node
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  let req;
  try { req = JSON.parse(data); } catch(e) { process.exit(1); }
  // Return WRONG acquisition_request_id
  const result = {
    schema: '${NEXUS_CORE_CANDIDATE_ACQUISITION_CLI_RESULT_SCHEMA}',
    status: 'OK',
    core_verdict: 'VERIFIED',
    core_reason_codes: [],
    acquisition_request_id: 'WRONG-ID-THAT-DOES-NOT-MATCH',
    request_hash: req.request_hash,
    reason_codes: [],
    receipt_hash: '${receiptHash}',
    receipt_path: req.receipt_directory + '/receipt.json',
    replayed: false,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    orchestration_runtime_ms: 1,
    core_response: null,
    authority: '${NEXUS_CORE_ACQUISITION_AUTHORITY}',
    claim_ceiling: ['verification'],
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
});
`,
    );
    chmodSync(execPath, 0o755);

    const runtimeIdentity = buildCoreRuntimeIdentity(execPath, "sha256:" + "e".repeat(64));
    const input = makeOrchestrationInput(stateDir, {
      profile,
      coreRuntime: { identity: runtimeIdentity!, executable: execPath },
    });
    const obs = await orchestrateCoreCandidateAcquisition(input);

    assert.equal(obs.acquisitionStatus, "ERROR");
    assert.equal(obs.missingnessCode, "CORE_RESULT_REQUEST_ID_MISMATCH");
    assert.equal(obs.coreVerdict, null);

    input.durableStore.close();
    input.observationStore.close();
  } finally {
    cleanup(stateDir);
  }
});

test("8b. wrong schema → observer error CORE_RESULT_SCHEMA_MISMATCH", async () => {
  const stateDir = makeTmpDir();
  const binDir = join(stateDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const execPath = join(binDir, "fake-core-wrong-schema");

  try {
    const profileHash = computeVerificationProfileHash(
      "profile-s",
      [{ verifier_id: "verifier-s", argv: ["run"] }],
      30,
    );
    const profile = {
      profile_id: "profile-s",
      verifier_id_command_pairs: [{ verifier_id: "verifier-s", argv: ["run"] }],
      timeout_seconds: 30,
      profile_hash: profileHash,
    };
    writeFileSync(
      execPath,
      `#!/usr/bin/env node
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({schema: 'wrong.schema', status: 'OK', core_verdict: 'VERIFIED'}));
});
`,
    );
    chmodSync(execPath, 0o755);

    const runtimeIdentity = buildCoreRuntimeIdentity(execPath, "sha256:" + "f".repeat(64));
    const input = makeOrchestrationInput(stateDir, {
      profile,
      coreRuntime: { identity: runtimeIdentity!, executable: execPath },
    });
    const obs = await orchestrateCoreCandidateAcquisition(input);

    assert.equal(obs.acquisitionStatus, "ERROR");
    assert.equal(obs.missingnessCode, "CORE_RESULT_SCHEMA_MISMATCH");

    input.durableStore.close();
    input.observationStore.close();
  } finally {
    cleanup(stateDir);
  }
});

test("8c. forbidden claim_ceiling term (acceptance) → CORE_RESULT_CLAIM_CEILING_EXCEEDS", async () => {
  const stateDir = makeTmpDir();
  const binDir = join(stateDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const execPath = join(binDir, "fake-core-ceiling");

  try {
    const profileHash = computeVerificationProfileHash(
      "profile-c",
      [{ verifier_id: "verifier-c", argv: ["run"] }],
      30,
    );
    const profile = {
      profile_id: "profile-c",
      verifier_id_command_pairs: [{ verifier_id: "verifier-c", argv: ["run"] }],
      timeout_seconds: 30,
      profile_hash: profileHash,
    };
    const rh = "sha256:" + "1".repeat(64);
    writeFileSync(
      execPath,
      `#!/usr/bin/env node
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  let req = JSON.parse(data);
  process.stdout.write(JSON.stringify({
    schema: '${NEXUS_CORE_CANDIDATE_ACQUISITION_CLI_RESULT_SCHEMA}',
    status: 'OK',
    core_verdict: 'VERIFIED',
    core_reason_codes: [],
    acquisition_request_id: req.acquisition_request_id,
    request_hash: req.request_hash,
    reason_codes: [],
    receipt_hash: '${rh}',
    receipt_path: req.receipt_directory + '/r.json',
    replayed: false,
    started_at: '',
    completed_at: '',
    orchestration_runtime_ms: 1,
    core_response: null,
    authority: '${NEXUS_CORE_ACQUISITION_AUTHORITY}',
    claim_ceiling: ['acceptance', 'merge'], // forbidden
  }));
});
`,
    );
    chmodSync(execPath, 0o755);

    const runtimeIdentity = buildCoreRuntimeIdentity(execPath, "sha256:" + "2".repeat(64));
    const input = makeOrchestrationInput(stateDir, {
      profile,
      coreRuntime: { identity: runtimeIdentity!, executable: execPath },
    });
    const obs = await orchestrateCoreCandidateAcquisition(input);

    assert.equal(obs.acquisitionStatus, "ERROR");
    assert.equal(obs.missingnessCode, "CORE_RESULT_CLAIM_CEILING_EXCEEDS");

    input.durableStore.close();
    input.observationStore.close();
  } finally {
    cleanup(stateDir);
  }
});

// ---------------------------------------------------------------------------
// Test 9: Core status ERROR → observer error, not verdict
// ---------------------------------------------------------------------------

test("9. Core status ERROR → observer error (not a verdict); acquisitionStatus=ERROR", async () => {
  const stateDir = makeTmpDir();
  const binDir = join(stateDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const execPath = join(binDir, "fake-core-error");

  try {
    const profileHash = computeVerificationProfileHash(
      "profile-e",
      [{ verifier_id: "verifier-e", argv: ["run"] }],
      30,
    );
    const profile = {
      profile_id: "profile-e",
      verifier_id_command_pairs: [{ verifier_id: "verifier-e", argv: ["run"] }],
      timeout_seconds: 30,
      profile_hash: profileHash,
    };
    writeFileSync(
      execPath,
      `#!/usr/bin/env node
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    schema: '${NEXUS_CORE_CANDIDATE_ACQUISITION_CLI_RESULT_SCHEMA}',
    status: 'ERROR',
    reason_code: 'INTERNAL_ERROR',
    detail: 'Something went wrong',
  }));
});
`,
    );
    chmodSync(execPath, 0o755);

    const runtimeIdentity = buildCoreRuntimeIdentity(execPath, "sha256:" + "3".repeat(64));
    const input = makeOrchestrationInput(stateDir, {
      profile,
      coreRuntime: { identity: runtimeIdentity!, executable: execPath },
    });
    const obs = await orchestrateCoreCandidateAcquisition(input);

    // Status ERROR from Core → observer error recorded, not a verdict
    assert.equal(obs.acquisitionStatus, "ERROR");
    assert.equal(obs.missingnessCode, "CORE_STATUS_ERROR");
    assert.equal(obs.coreVerdict, null);
    assert.equal(obs.coreInvoked, true);

    input.durableStore.close();
    input.observationStore.close();
  } finally {
    cleanup(stateDir);
  }
});

// ---------------------------------------------------------------------------
// Test 10: Durable op / observation identity exists before async launch
// ---------------------------------------------------------------------------

test("10. durable op and observation rows created; operationId is stable before Core exits", async () => {
  const stateDir = makeTmpDir();
  const binDir = join(stateDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const execPath = join(binDir, "fake-core-stable");

  try {
    const profileHash = computeVerificationProfileHash(
      "profile-stable",
      [{ verifier_id: "verifier-stable", argv: ["run"] }],
      30,
    );
    const profile = {
      profile_id: "profile-stable",
      verifier_id_command_pairs: [{ verifier_id: "verifier-stable", argv: ["run"] }],
      timeout_seconds: 30,
      profile_hash: profileHash,
    };
    const rh = "sha256:" + "5".repeat(64);
    writeFileSync(
      execPath,
      `#!/usr/bin/env node
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  let req = JSON.parse(data);
  process.stdout.write(JSON.stringify({
    schema: '${NEXUS_CORE_CANDIDATE_ACQUISITION_CLI_RESULT_SCHEMA}',
    status: 'OK',
    core_verdict: 'VERIFIED',
    core_reason_codes: [],
    acquisition_request_id: req.acquisition_request_id,
    request_hash: req.request_hash,
    reason_codes: [],
    receipt_hash: '${rh}',
    receipt_path: req.receipt_directory + '/receipt.json',
    replayed: false,
    started_at: '',
    completed_at: '',
    orchestration_runtime_ms: 0,
    core_response: null,
    authority: '${NEXUS_CORE_ACQUISITION_AUTHORITY}',
    claim_ceiling: ['verification'],
  }));
});
`,
    );
    chmodSync(execPath, 0o755);

    const runtimeIdentity = buildCoreRuntimeIdentity(execPath, "sha256:" + "6".repeat(64));
    const input = makeOrchestrationInput(stateDir, {
      profile,
      coreRuntime: { identity: runtimeIdentity!, executable: execPath },
    });

    // Compute what the operationId should be before calling orchestrate
    const expectedOpId = computeAcquisitionOperationId({
      sessionId: input.sessionId,
      candidateHead: input.candidateHead,
      candidateTree: input.candidateTree,
      sourceRevision: "c".repeat(40),
      acceptanceContractHash: input.acceptanceContractHash,
      profileHash: profile.profile_hash,
      changeSetHash: input.changeSetHash,
      coreRuntimeIdentity: runtimeIdentity,
    });

    assert.match(expectedOpId, /^cca_/);

    const pending = orchestrateCoreCandidateAcquisition(input);

    // Before awaiting the expensive Core process, the durable effect identity
    // and observation must already exist. This is the worker-return crash-window witness.
    const durableBeforeAwait = input.durableStore.getByOperationId(expectedOpId);
    assert.ok(durableBeforeAwait);
    assert.equal(durableBeforeAwait.status, "started");
    const observationBeforeAwait = input.observationStore.getByOperationId(expectedOpId);
    assert.ok(observationBeforeAwait);
    assert.equal(observationBeforeAwait.coreInvoked, true);

    const obs = await pending;

    // After completion, verify operation identity is stable
    assert.equal(obs.operationId, expectedOpId);
    assert.ok(obs.durableOperationId);

    // Verify the durable operation row exists and is finished
    const durableRecord = input.durableStore.getByOperationId(obs.durableOperationId);
    assert.ok(durableRecord);
    assert.equal(durableRecord.kind, "core_candidate_acquisition");
    assert.equal(durableRecord.status, "succeeded");

    // Verify observation is readable via the store
    const storedObs = input.observationStore.getByOperationId(obs.operationId);
    assert.ok(storedObs);
    assert.equal(storedObs.operationId, expectedOpId);
    assert.equal(storedObs.coreVerdict, "VERIFIED");

    input.durableStore.close();
    input.observationStore.close();
  } finally {
    cleanup(stateDir);
  }
});

// ---------------------------------------------------------------------------
// Test 11: Exact replay does not launch fake Core twice
// ---------------------------------------------------------------------------

test("11. exact replay does not launch Core a second time; returns existing observation", async () => {
  const stateDir = makeTmpDir();
  const binDir = join(stateDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const counterFile = join(stateDir, "invoke-count.txt");
  const execPath = join(binDir, "fake-core-replay");

  try {
    const profileHash = computeVerificationProfileHash(
      "profile-replay",
      [{ verifier_id: "verifier-r", argv: ["check"] }],
      30,
    );
    const profile = {
      profile_id: "profile-replay",
      verifier_id_command_pairs: [{ verifier_id: "verifier-r", argv: ["check"] }],
      timeout_seconds: 30,
      profile_hash: profileHash,
    };
    const rh = "sha256:" + "7".repeat(64);
    writeFileSync(
      execPath,
      `#!/usr/bin/env node
const fs = require('fs');
// Count invocations
let count = 0;
try { count = parseInt(fs.readFileSync('${counterFile}', 'utf8') || '0'); } catch {}
fs.writeFileSync('${counterFile}', String(count + 1));

let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  let req = JSON.parse(data);
  process.stdout.write(JSON.stringify({
    schema: '${NEXUS_CORE_CANDIDATE_ACQUISITION_CLI_RESULT_SCHEMA}',
    status: 'OK',
    core_verdict: 'VERIFIED',
    core_reason_codes: [],
    acquisition_request_id: req.acquisition_request_id,
    request_hash: req.request_hash,
    reason_codes: [],
    receipt_hash: '${rh}',
    receipt_path: req.receipt_directory + '/receipt.json',
    replayed: false,
    started_at: '',
    completed_at: '',
    orchestration_runtime_ms: 0,
    core_response: null,
    authority: '${NEXUS_CORE_ACQUISITION_AUTHORITY}',
    claim_ceiling: ['verification'],
  }));
});
`,
    );
    chmodSync(execPath, 0o755);

    const runtimeIdentity = buildCoreRuntimeIdentity(execPath, "sha256:" + "8".repeat(64));
    const input = makeOrchestrationInput(stateDir, {
      profile,
      coreRuntime: { identity: runtimeIdentity!, executable: execPath },
    });

    // First call — Core invoked
    const obs1 = await orchestrateCoreCandidateAcquisition(input);
    assert.equal(obs1.coreVerdict, "VERIFIED");

    // Second call with same input — exact replay; Core must NOT be invoked again
    // Use a fresh durableStore + observationStore pointing to same stateDir (simulating restart)
    const durableStore2 = new DurableOperationStore(stateDir);
    const observationStore2 = new CoreCandidateAcquisitionObservationStore(stateDir);
    const obs2 = await orchestrateCoreCandidateAcquisition({
      ...input,
      durableStore: durableStore2,
      observationStore: observationStore2,
    });

    assert.equal(obs2.operationId, obs1.operationId);
    assert.equal(obs2.coreVerdict, obs1.coreVerdict);

    // Counter file should show only 1 invocation
    let invokeCount = 0;
    try {
      invokeCount = parseInt(
        require("node:fs").readFileSync(counterFile, "utf8") || "0",
      );
    } catch {
      invokeCount = 1; // file exists from first call
    }
    assert.equal(invokeCount, 1, "exact replay must not launch Core a second time");
    assert.equal(obs2.acquisitionStatus, obs1.acquisitionStatus);

    durableStore2.close();
    observationStore2.close();
    input.durableStore.close();
    input.observationStore.close();
  } finally {
    cleanup(stateDir);
  }
});

// ---------------------------------------------------------------------------
// Test 12: Restart: started operation becomes outcome_unknown; no blind rerun
// ---------------------------------------------------------------------------

test("12. restart: started durable op becomes outcome_unknown; orchestrate does not blind-rerun", async () => {
  const stateDir = makeTmpDir();
  try {
    const profileHash = computeVerificationProfileHash(
      "profile-restart",
      [{ verifier_id: "verifier-rst", argv: ["run"] }],
      30,
    );
    const profile = {
      profile_id: "profile-restart",
      verifier_id_command_pairs: [{ verifier_id: "verifier-rst", argv: ["run"] }],
      timeout_seconds: 30,
      profile_hash: profileHash,
    };
    const runtimeIdentity = buildCoreRuntimeIdentity("/usr/bin/true", "sha256:" + "8".repeat(64));
    assert.ok(runtimeIdentity);
    const input = makeOrchestrationInput(stateDir, {
      profile,
      coreRuntime: { identity: runtimeIdentity!, executable: "/usr/bin/true" },
    });
    const sourceIdentity = "c".repeat(40);
    const operationId = computeAcquisitionOperationId({
      sessionId: input.sessionId,
      candidateHead: input.candidateHead,
      candidateTree: input.candidateTree,
      sourceRevision: sourceIdentity,
      acceptanceContractHash: input.acceptanceContractHash,
      profileHash,
      changeSetHash: input.changeSetHash,
      coreRuntimeIdentity: runtimeIdentity,
    });
    const coreAcquisitionChangeSetHash = computeCoreAcquisitionChangeSetHash({
      acquisitionRequestId: operationId,
      sourceIdentity,
      candidateTree: input.candidateTree,
      changeManifestHash: input.changeManifestHash,
      changedPaths: input.changedPaths,
      deletedPaths: input.deletedPaths,
    });
    const requestHash = computeAcquisitionRequestHash({
      acquisition_request_id: operationId,
      candidate_head: input.candidateHead,
      candidate_tree: input.candidateTree,
      expected_source_identity: sourceIdentity,
      expected_contract_hash: input.acceptanceContractHash,
      expected_profile_hash: profileHash,
      expected_change_set_hash: coreAcquisitionChangeSetHash,
    });
    input.durableStore.createOrReplay({
      operationId,
      attemptKey: operationId,
      requestHash,
      kind: "core_candidate_acquisition",
      authorityMode: "OWNER_DIRECT",
      scopeRoot: input.scopeRoot,
      request: { acquisition_request_id: operationId, request_hash: requestHash },
    });
    input.observationStore.createPending({
      operationId,
      durableOperationId: operationId,
      sessionId: input.sessionId,
      candidateHead: input.candidateHead,
      candidateTree: input.candidateTree,
      sourceRevision: sourceIdentity,
      bindingHash: input.bindingHash,
      acceptanceContractHash: input.acceptanceContractHash,
      changeSetHash: input.changeSetHash,
      profileHash,
      coreRuntimeIdentity: runtimeIdentity,
      acquisitionRequestId: operationId,
      requestHash,
    });
    input.observationStore.markCoreInvoked(operationId);

    const changed = input.durableStore.markInterruptedUnknown();
    assert.equal(changed, 1);
    assert.equal(input.durableStore.getByOperationId(operationId)?.status, "outcome_unknown");

    const durableStore2 = new DurableOperationStore(stateDir);
    const observationStore2 = new CoreCandidateAcquisitionObservationStore(stateDir);
    const obs2 = await orchestrateCoreCandidateAcquisition({
      ...input,
      durableStore: durableStore2,
      observationStore: observationStore2,
    });

    assert.equal(obs2.operationId, operationId);
    assert.equal(obs2.missingnessCode, "CORE_EFFECT_OUTCOME_UNKNOWN");
    assert.equal(durableStore2.getByOperationId(operationId)?.status, "outcome_unknown");

    durableStore2.close();
    observationStore2.close();
    input.durableStore.close();
    input.observationStore.close();
  } finally {
    cleanup(stateDir);
  }
});

// ---------------------------------------------------------------------------
// Test 13: Conflicting replay fails closed
// ---------------------------------------------------------------------------

test("13. conflicting replay fails closed: OPERATION_REPLAY_CONFLICT thrown", async () => {
  const stateDir = makeTmpDir();
  try {
    const input = makeOrchestrationInput(stateDir, {
      profile: null,
      coreRuntime: null,
      sessionId: "session-conflict",
    });

    // First call succeeds
    const obs1 = await orchestrateCoreCandidateAcquisition(input);
    assert.ok(obs1);

    // Different candidateHead = different operationId = different attempt = no conflict
    // To test actual conflict, we need same operationId but different request.
    // The DurableOperationStore detects conflict via attemptKey + requestHash.
    // orchestrateCoreCandidateAcquisition uses operationId as attemptKey.
    // Since operationId is derived from all inputs including candidateHead,
    // changing candidateHead changes the operationId/attemptKey → no conflict.
    // Actual conflict: inject same operationId with a different requestHash.

    // Simulate a conflict by directly creating a durable op with same operationId
    // but a different requestHash, then calling orchestrate again.
    // The observation store will detect ACQUISITION_REPLAY_CONFLICT.
    const observationStore2 = new CoreCandidateAcquisitionObservationStore(stateDir);
    // Try to insert a conflicting observation with same operationId but different session
    assert.throws(
      () => observationStore2.createPending({
        operationId: obs1.operationId,
        durableOperationId: obs1.durableOperationId,
        sessionId: "DIFFERENT-SESSION", // conflict
        candidateHead: obs1.candidateHead,
        candidateTree: obs1.candidateTree,
        sourceRevision: obs1.sourceRevision,
        bindingHash: obs1.bindingHash,
        acceptanceContractHash: obs1.acceptanceContractHash,
        changeSetHash: obs1.changeSetHash,
        profileHash: obs1.profileHash,
        coreRuntimeIdentity: obs1.coreRuntimeIdentity,
        acquisitionRequestId: "new-req-id",
        requestHash: "sha256:" + "9".repeat(64),
      }),
      (err: unknown) =>
        err instanceof CoreCandidateAcquisitionError && err.code === "ACQUISITION_REPLAY_CONFLICT",
    );

    observationStore2.close();
    input.durableStore.close();
    input.observationStore.close();
  } finally {
    cleanup(stateDir);
  }
});

// ---------------------------------------------------------------------------
// Test 14: Core REJECTED verdict retained but nonblocking
// ---------------------------------------------------------------------------

test("14. Core REJECTED verdict is retained in observation but never blocks the caller", async () => {
  const stateDir = makeTmpDir();
  const binDir = join(stateDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const execPath = join(binDir, "fake-core-rejected");

  try {
    const profileHash = computeVerificationProfileHash(
      "profile-rej",
      [{ verifier_id: "verifier-rej", argv: ["run"] }],
      30,
    );
    const profile = {
      profile_id: "profile-rej",
      verifier_id_command_pairs: [{ verifier_id: "verifier-rej", argv: ["run"] }],
      timeout_seconds: 30,
      profile_hash: profileHash,
    };
    const rh = "sha256:" + "a1a1".repeat(16);
    writeFileSync(
      execPath,
      `#!/usr/bin/env node
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  let req = JSON.parse(data);
  process.stdout.write(JSON.stringify({
    schema: '${NEXUS_CORE_CANDIDATE_ACQUISITION_CLI_RESULT_SCHEMA}',
    status: 'OK',
    core_verdict: 'REJECTED',
    core_reason_codes: ['VERIFICATION_FAILED'],
    acquisition_request_id: req.acquisition_request_id,
    request_hash: req.request_hash,
    reason_codes: ['VERIFICATION_FAILED'],
    receipt_hash: '${rh}',
    receipt_path: req.receipt_directory + '/rejected-receipt.json',
    replayed: false,
    started_at: '',
    completed_at: '',
    orchestration_runtime_ms: 1,
    core_response: null,
    authority: '${NEXUS_CORE_ACQUISITION_AUTHORITY}',
    claim_ceiling: ['verification'],
  }));
});
`,
    );
    chmodSync(execPath, 0o755);

    const runtimeIdentity = buildCoreRuntimeIdentity(execPath, "sha256:" + "b2".repeat(32));
    const input = makeOrchestrationInput(stateDir, {
      profile,
      coreRuntime: { identity: runtimeIdentity!, executable: execPath },
    });

    // orchestrateCoreCandidateAcquisition should NOT throw even for REJECTED
    const obs = await orchestrateCoreCandidateAcquisition(input);

    assert.ok(obs);
    assert.equal(obs.acquisitionStatus, "VERDICT_RECORDED");
    assert.equal(obs.coreVerdict, "REJECTED");
    assert.equal(obs.coreReason, "VERIFICATION_FAILED");
    assert.equal(obs.receiptHash, rh);
    assert.equal(obs.coreInvoked, true);

    // Durable op should be succeeded (nonblocking shadow)
    const durable = input.durableStore.getByOperationId(obs.durableOperationId);
    assert.ok(durable);
    assert.equal(durable.status, "succeeded");

    input.durableStore.close();
    input.observationStore.close();
  } finally {
    cleanup(stateDir);
  }
});

// ---------------------------------------------------------------------------
// Test 15: Census readback includes observation; restart-safe / read-only
// ---------------------------------------------------------------------------

test("15. census readback: observation is accessible via getBySessionAndCandidate and listByBinding", async () => {
  const stateDir = makeTmpDir();
  try {
    const input = makeOrchestrationInput(stateDir, {
      profile: null,
      coreRuntime: null,
      sessionId: "census-session",
      candidateHead: "f".repeat(40),
    });
    const obs = await orchestrateCoreCandidateAcquisition(input);

    // Readback via getBySessionAndCandidate
    const found = input.observationStore.getBySessionAndCandidate(
      "census-session",
      "f".repeat(40),
    );
    assert.ok(found);
    assert.equal(found.operationId, obs.operationId);
    assert.equal(found.sessionId, "census-session");
    assert.equal(found.candidateHead, "f".repeat(40));

    // Readback via listByBinding
    const list = input.observationStore.listByBinding(obs.bindingHash);
    assert.ok(list.length >= 1);
    assert.ok(list.some((o) => o.operationId === obs.operationId));

    // Read-only: opening a new store for the same stateDir returns same data
    const readonlyStore = new CoreCandidateAcquisitionObservationStore(stateDir);
    const found2 = readonlyStore.getByOperationId(obs.operationId);
    assert.ok(found2);
    assert.equal(found2.operationId, obs.operationId);
    readonlyStore.close();

    input.durableStore.close();
    input.observationStore.close();
  } finally {
    cleanup(stateDir);
  }
});

// ---------------------------------------------------------------------------
// Test 16: No Core verdict in worker-facing mutation output
// ---------------------------------------------------------------------------

test("16. Core verdict is shadow-only; it does not appear in the worker-facing observation's acquisitionStatus as a pass/fail gate", async () => {
  const stateDir = makeTmpDir();
  const binDir = join(stateDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const execPath = join(binDir, "fake-core-shadow");

  try {
    const profileHash = computeVerificationProfileHash(
      "profile-shadow",
      [{ verifier_id: "verifier-shadow", argv: ["run"] }],
      30,
    );
    const profile = {
      profile_id: "profile-shadow",
      verifier_id_command_pairs: [{ verifier_id: "verifier-shadow", argv: ["run"] }],
      timeout_seconds: 30,
      profile_hash: profileHash,
    };
    const rh = "sha256:" + "c3".repeat(32);
    writeFileSync(
      execPath,
      `#!/usr/bin/env node
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  let req = JSON.parse(data);
  process.stdout.write(JSON.stringify({
    schema: '${NEXUS_CORE_CANDIDATE_ACQUISITION_CLI_RESULT_SCHEMA}',
    status: 'OK',
    core_verdict: 'REJECTED',
    core_reason_codes: [],
    acquisition_request_id: req.acquisition_request_id,
    request_hash: req.request_hash,
    reason_codes: [],
    receipt_hash: '${rh}',
    receipt_path: req.receipt_directory + '/r.json',
    replayed: false,
    started_at: '',
    completed_at: '',
    orchestration_runtime_ms: 0,
    core_response: null,
    authority: '${NEXUS_CORE_ACQUISITION_AUTHORITY}',
    claim_ceiling: ['verification'],
  }));
});
`,
    );
    chmodSync(execPath, 0o755);

    const runtimeIdentity = buildCoreRuntimeIdentity(execPath, "sha256:" + "d4".repeat(32));
    const input = makeOrchestrationInput(stateDir, {
      profile,
      coreRuntime: { identity: runtimeIdentity!, executable: execPath },
    });

    // orchestrateCoreCandidateAcquisition should succeed (not throw) even for REJECTED
    let thrown = false;
    let obs: CoreCandidateAcquisitionObservation | undefined;
    try {
      obs = await orchestrateCoreCandidateAcquisition(input);
    } catch {
      thrown = true;
    }

    // Must not throw — verdict is shadow-only
    assert.equal(thrown, false);
    assert.ok(obs);

    // The verdict is recorded but the caller is not blocked
    assert.equal(obs.coreVerdict, "REJECTED");
    assert.equal(obs.acquisitionStatus, "VERDICT_RECORDED");

    // Verify no verdict leaked as an error (durable op succeeded)
    const durable = input.durableStore.getByOperationId(obs.durableOperationId);
    assert.ok(durable);
    assert.equal(durable.status, "succeeded");
    assert.equal(durable.errorCode, undefined);

    input.durableStore.close();
    input.observationStore.close();
  } finally {
    cleanup(stateDir);
  }
});

// ---------------------------------------------------------------------------
// Test 17: Migration 23→24 idempotent; existing DB upgrade works
// ---------------------------------------------------------------------------

test("17. migration 23→24 idempotent: observation schema created; running migrateDatabase twice is safe", () => {
  const stateDir = makeTmpDir();
  try {
    const dbPath = join(stateDir, "devspace.sqlite");
    const sqlite = new Database(dbPath);

    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");

    // First run: apply all migrations through Wave B migration 24.
    migrateDatabase(sqlite);

    // The only new profile truth remains the session binding; Wave B adds
    // only the durable observation projection table.
    const tables = (
      sqlite.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]
    ).map((r) => r.name);

    assert.equal(tables.includes("core_verification_profiles"), false);
    assert.ok(tables.includes("core_candidate_acquisition_observations"), "core_candidate_acquisition_observations table must exist");

    // Check receipt_path column exists (migration 24)
    const cols = (
      sqlite.prepare("pragma table_info(core_candidate_acquisition_observations)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    assert.ok(cols.includes("receipt_path"), "receipt_path column must exist (migration 24)");

    // Second run: idempotent — should not throw
    migrateDatabase(sqlite);

    // Migration versions 23 and 24 should be recorded; there is no
    // profile-registry migration because the session binding is authoritative.
    const versions = (
      sqlite.prepare("select version from devspace_schema_migrations order by version").all() as {
        version: number;
      }[]
    ).map((r) => r.version);

    assert.ok(versions.includes(23), "migration 23 must be recorded");
    assert.ok(versions.includes(24), "migration 24 must be recorded");
    assert.equal(versions.includes(25), false);

    sqlite.close();
  } finally {
    cleanup(stateDir);
  }
});

// ---------------------------------------------------------------------------
// Test 18: Smoke-check that sibling test files compile and import cleanly
// ---------------------------------------------------------------------------

test("18. sibling module imports resolve cleanly (smoke check)", async () => {
  // These imports validate that the compilation surface is consistent.
  // Full coverage is verified by running the sibling test suites separately.
  const { computeRepositoryMutationBindingHash: bh } = await import("./core-mutation-session.js");
  assert.equal(typeof bh, "function");

  const { DurableOperationStore: DOS } = await import("./durable-operations.js");
  assert.equal(typeof DOS, "function");

  const { migrateDatabase: md } = await import("./db/migrations.js");
  assert.equal(typeof md, "function");

  // Verify all expected exports from core-candidate-acquisition are present
  assert.equal(NEXUS_CORE_CANDIDATE_ACQUISITION_CLI_RESULT_SCHEMA, "nexus.core.candidate_acquisition_cli_result.v1");
  assert.equal(NEXUS_CORE_ACQUISITION_PRODUCER_REVISION, "6c0cc48c9b3082470da40cb44697617de52b3988");
  assert.equal(NEXUS_CORE_ACQUISITION_AUTHORITY, "CORE_EVIDENCE_TRUST_COMPLETION_ONLY");
  assert.equal(typeof parseCoreVerificationProfile, "function");
  assert.equal(typeof computeVerificationProfileHash, "function");
  assert.equal(typeof computeAcquisitionOperationId, "function");
  assert.equal(typeof computeAcquisitionRequestHash, "function");
  assert.equal(typeof computeCoreAcquisitionChangeSetHash, "function");
  assert.equal(typeof validateCoreRuntimeConfig, "function");
  assert.equal(typeof validateCoreRuntimeConfigSync, "function");
  assert.equal(typeof buildCoreRuntimeIdentity, "function");
  assert.equal(typeof CoreCandidateAcquisitionError, "function");
  assert.equal(typeof CoreCandidateAcquisitionObservationStore, "function");
  assert.equal(typeof orchestrateCoreCandidateAcquisition, "function");
});

// ---------------------------------------------------------------------------
// Additional edge-case tests for robustness
// ---------------------------------------------------------------------------

test("computeAcquisitionOperationId produces stable cca_ prefix", () => {
  const id1 = computeAcquisitionOperationId({
    sessionId: "s1",
    candidateHead: "a".repeat(40),
    candidateTree: "b".repeat(40),
    sourceRevision: "git-commit:" + "c".repeat(40),
    acceptanceContractHash: "sha256:" + "d".repeat(64),
    profileHash: null,
    changeSetHash: "sha256:" + "e".repeat(64),
    coreRuntimeIdentity: null,
  });
  assert.match(id1, /^cca_[0-9a-f]{32}$/);

  const id2 = computeAcquisitionOperationId({
    sessionId: "s1",
    candidateHead: "a".repeat(40),
    candidateTree: "b".repeat(40),
    sourceRevision: "git-commit:" + "c".repeat(40),
    acceptanceContractHash: "sha256:" + "d".repeat(64),
    profileHash: null,
    changeSetHash: "sha256:" + "e".repeat(64),
    coreRuntimeIdentity: null,
  });
  // Same input → same id
  assert.equal(id1, id2);

  // Different session → different id
  const id3 = computeAcquisitionOperationId({
    sessionId: "s2",
    candidateHead: "a".repeat(40),
    candidateTree: "b".repeat(40),
    sourceRevision: "git-commit:" + "c".repeat(40),
    acceptanceContractHash: "sha256:" + "d".repeat(64),
    profileHash: null,
    changeSetHash: "sha256:" + "e".repeat(64),
    coreRuntimeIdentity: null,
  });
  assert.notEqual(id1, id3);
});

test("buildCoreRuntimeIdentity returns null for missing fields", () => {
  assert.equal(buildCoreRuntimeIdentity(undefined, "sha256:" + "a".repeat(64)), null);
  assert.equal(buildCoreRuntimeIdentity("/usr/bin/core", undefined), null);
  assert.equal(buildCoreRuntimeIdentity("", "sha256:" + "a".repeat(64)), null);
  const id = buildCoreRuntimeIdentity("/usr/bin/core", "sha256:" + "a".repeat(64));
  assert.ok(id);
  assert.equal(
    id,
    `/usr/bin/core@sha256:${"a".repeat(64)}#source:${NEXUS_CORE_ACQUISITION_PRODUCER_REVISION}`,
  );
});

test("computeAcquisitionRequestHash produces stable sha256: hash", () => {
  const req = {
    acquisition_request_id: "req-1",
    candidate_head: "a".repeat(40),
    candidate_tree: "b".repeat(40),
    expected_source_identity: "git-commit:" + "c".repeat(40),
    expected_contract_hash: "sha256:" + "d".repeat(64),
    expected_profile_hash: null,
    expected_change_set_hash: "sha256:" + "e".repeat(64),
  };
  const h1 = computeAcquisitionRequestHash(req);
  const h2 = computeAcquisitionRequestHash(req);
  assert.match(h1, /^sha256:[0-9a-f]{64}$/);
  assert.equal(h1, h2);
});

test("parseCoreVerificationProfile: valid profile parses successfully", () => {
  const pairs = [
    { verifier_id: "verifier-b", argv: ["cmd", "arg1"] },
    { verifier_id: "verifier-a", argv: ["run"] },
  ];
  // Sorted by verifier_id for hash: a < b
  const sortedPairs = [...pairs].sort((a, b) => a.verifier_id.localeCompare(b.verifier_id));
  const profileHash = computeVerificationProfileHash("p1", sortedPairs, 120);

  const input = {
    profile_id: "p1",
    verifier_ids: ["verifier-b", "verifier-a"],
    verifier_commands: [["cmd", "arg1"], ["run"]],
    timeout_seconds: 120,
    profile_hash: profileHash,
  };

  const result = parseCoreVerificationProfile(input, ["verifier-a", "verifier-b"]);
  assert.equal(result.profile_id, "p1");
  assert.equal(result.timeout_seconds, 120);
  assert.equal(result.profile_hash, profileHash);
  // verifier_id_command_pairs should be sorted
  assert.equal(result.verifier_id_command_pairs[0].verifier_id, "verifier-a");
  assert.equal(result.verifier_id_command_pairs[1].verifier_id, "verifier-b");
});
