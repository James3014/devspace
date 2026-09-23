import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acceptanceContractHash,
  assertCapabilityDiscoveryBinding,
  capabilityDiscoveryReceiptHash,
  computeCoreMutationWorkspaceIdentity,
  computeRepositoryMutationBindingHash,
  CoreMutationSessionError,
  CoreMutationSessionStore,
  NEXUS_CORE_PROTOCOL_VERSION,
  parseRepositoryMutationBinding,
  type CoreMutationDurableAgentRecord,
  type RepositoryMutationBinding,
} from "./core-mutation-session.js";
import {
  CAPABILITY_DISCOVERY_INDEX_PATH,
  CAPABILITY_DISCOVERY_RECEIPT_SCHEMA,
  NEXUS_CAPABILITY_REPOSITORY,
  type CapabilityDiscoveryReceipt,
} from "./capability-discovery.js";
import {
  buildExecutionGenerationBinding,
  computeDispatchIntentHash,
  DIRECT_CANDIDATE_EXECUTION_SCHEMA,
  validateDirectCandidateExecutionEvidence,
} from "./execution-protocol.js";
import { createWorkspaceStore } from "./workspace-store.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function makeRepo(): { root: string; repo: string; head: string; tree: string } {
  const root = mkdtempSync(join(tmpdir(), "devspace-core-session-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  writeFileSync(join(repo, "app.ts"), "export const value = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "origin", "https://github.com/James3014/devspace.git");
  return { root, repo, head: git(repo, "rev-parse", "HEAD"), tree: git(repo, "rev-parse", "HEAD^{tree}") };
}

function discoveryReceipt(indexRevision = "1".repeat(40)): CapabilityDiscoveryReceipt {
  return {
    schema: CAPABILITY_DISCOVERY_RECEIPT_SCHEMA,
    repository: NEXUS_CAPABILITY_REPOSITORY,
    indexRevision,
    indexPath: CAPABILITY_DISCOVERY_INDEX_PATH,
    indexSha256: "2".repeat(64),
    intent: "Reuse the existing Core evidence/completion envelope.",
    disposition: "REUSE_EXISTING",
    matchedCapabilityIds: ["nexus-core"],
    evidence: {
      architecture: ["nexus-core owns Completion truth"],
      source: ["product/evidence"],
      history: ["Nexus-new#957"],
      runtime: ["devspace#135"],
    },
  };
}

function makeBinding(input: {
  workspaceSessionId: string;
  head: string;
  tree: string;
  receipt?: CapabilityDiscoveryReceipt;
  allowedPaths?: string[];
  deletionPolicy?: "FORBID" | "ALLOW";
  validUntil?: string | null;
  executionLane?: "DIRECT_CANONICAL" | "DIRECT_DELEGATED" | "GOVERNED";
  authorityHash?: string;
}): RepositoryMutationBinding {
  const receipt = input.receipt ?? discoveryReceipt();
  const contract = {
    contract_id: "devspace-core-session-test",
    requirements_hash: `sha256:${"3".repeat(64)}`,
    required_verifier_ids: ["focused-tests"],
    allowed_paths: input.allowedPaths ?? ["app.ts", "new.ts"],
    deletion_policy: input.deletionPolicy ?? "FORBID",
  };
  const base: Omit<RepositoryMutationBinding, "binding_hash"> = {
    schema: "nexus.repository_mutation_binding.v1",
    binding_id: "binding-test-1",
    operation_id: "operation-test-1",
    attempt_id: "attempt-test-1",
    repository: {
      canonical_id: "James3014/devspace",
      origin: "https://github.com/James3014/devspace.git",
      source_revision: `git-commit:${input.head}`,
      source_tree: `git-tree:${input.tree}`,
      workspace_identity: `sha256:${"0".repeat(64)}`,
      workspace_mode: "checkout",
    },
    integration_authority: {
      execution_lane: input.executionLane ?? "DIRECT_CANONICAL",
      authority_ref: "James3014/devspace#135",
      authority_hash: input.authorityHash ?? `sha256:${"4".repeat(64)}`,
    },
    capability_discovery: {
      required: true,
      receipt_hash: capabilityDiscoveryReceiptHash(receipt),
      index_revision: `git-commit:${receipt.indexRevision}`,
    },
    core: {
      protocol_version: NEXUS_CORE_PROTOCOL_VERSION,
      acceptance_contract: contract,
      acceptance_contract_hash: acceptanceContractHash(contract),
    },
    freshness: {
      created_at: "2026-09-14T00:00:00.000Z",
      valid_until: input.validUntil ?? null,
      revalidate_before_first_effect: true,
    },
  };
  base.repository.workspace_identity = computeCoreMutationWorkspaceIdentity({
    workspaceSessionId: input.workspaceSessionId,
    binding: { ...base, binding_hash: `sha256:${"0".repeat(64)}` },
  });
  return { ...base, binding_hash: computeRepositoryMutationBindingHash(base) };
}

test("repository mutation admission requires an active Core-bound session", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_required";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    await assert.rejects(
      () => store.admitEffect({
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        workspaceMode: "checkout",
        managed: false,
        actorKey: "actor:test",
        paths: ["app.ts"],
        deletedPaths: [],
        pathContainment: "STRUCTURED_SINK_ENFORCED",
      }),
      (error: unknown) =>
        error instanceof CoreMutationSessionError && error.code === "CORE_BOUND_SESSION_REQUIRED",
    );
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("logical operation and attempt identity rejects a changed binding after terminal reopen", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_logical_attempt";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  let store = new CoreMutationSessionStore(stateDir);
  try {
    const original = makeBinding({ workspaceSessionId: workspaceId, head: fixture.head, tree: fixture.tree });
    const session = await store.open({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      binding: original,
    });
    assert.equal(session.operationId, original.operation_id);
    assert.equal(session.attemptId, original.attempt_id);
    await store.closeSession({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:test",
      mode: "ABANDON",
    });
    store.close();
    store = new CoreMutationSessionStore(stateDir);

    await assert.rejects(
      () => store.open({
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        workspaceMode: "checkout",
        managed: false,
        actorKey: "actor:test",
        binding: original,
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "BINDING_ALREADY_TERMINAL",
    );

    const broadened = makeBinding({
      workspaceSessionId: workspaceId,
      head: fixture.head,
      tree: fixture.tree,
      allowedPaths: ["app.ts", "new.ts", "broadened.ts"],
    });
    assert.equal(broadened.operation_id, original.operation_id);
    assert.equal(broadened.attempt_id, original.attempt_id);
    assert.notEqual(broadened.binding_hash, original.binding_hash);
    await assert.rejects(
      () => store.open({
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        workspaceMode: "checkout",
        managed: false,
        actorKey: "actor:test",
        binding: broadened,
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "BINDING_REPLAY_CONFLICT",
    );
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a clean Core session without physical Candidate provenance cannot complete", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_clean_no_candidate";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    const binding = makeBinding({ workspaceSessionId: workspaceId, head: fixture.head, tree: fixture.tree });
    const session = await store.open({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      binding,
    });
    await assert.rejects(
      () => store.closeSession({
        sessionId: session.id,
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        actorKey: "actor:test",
        mode: "COMPLETE",
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_CANDIDATE_REQUIRED",
    );
    assert.equal(store.getById(session.id)?.status, "ACTIVE");
    assert.equal((await store.closeSession({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:test",
      mode: "ABANDON",
    })).status, "ABANDONED");
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Candidate-bearing session cannot COMPLETE or ABANDON after binding expiry and admitted effect", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_expired_candidate_close";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    const binding = makeBinding({
      workspaceSessionId: workspaceId,
      head: fixture.head,
      tree: fixture.tree,
      allowedPaths: ["app.ts"],
      validUntil: "2026-09-14T02:00:00.000Z",
    });
    const session = await store.open({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      binding,
      now: new Date("2026-09-14T01:00:00.000Z"),
    });
    await store.admitEffect({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash },
      paths: ["app.ts"],
      deletedPaths: [],
      pathContainment: "STRUCTURED_SINK_ENFORCED",
      now: new Date("2026-09-14T01:10:00.000Z"),
    });
    writeFileSync(join(fixture.repo, "app.ts"), "export const value = 2;\n");
    git(fixture.repo, "add", "app.ts");
    git(fixture.repo, "commit", "-m", "candidate before expiry");
    await store.recordCandidate({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:test",
      candidateHead: git(fixture.repo, "rev-parse", "HEAD"),
      candidateTree: git(fixture.repo, "rev-parse", "HEAD^{tree}"),
      now: new Date("2026-09-14T01:20:00.000Z"),
    });

    await assert.rejects(
      () => store.closeSession({
        sessionId: session.id,
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        actorKey: "actor:test",
        mode: "COMPLETE",
        now: new Date("2026-09-14T03:00:00.000Z"),
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "BINDING_EXPIRED",
    );
    assert.equal(store.getById(session.id)?.status, "ACTIVE");
    assert.equal(store.getById(session.id)?.freshnessState, "EXPIRED");
    await assert.rejects(
      () => store.closeSession({
        sessionId: session.id,
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        actorKey: "actor:test",
        mode: "ABANDON",
        now: new Date("2026-09-14T03:01:00.000Z"),
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_RECONCILE_REQUIRED",
    );
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("terminal close replay validates actor and exact requested mode after reopen", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_terminal_replay";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  let store = new CoreMutationSessionStore(stateDir);
  try {
    const binding = makeBinding({ workspaceSessionId: workspaceId, head: fixture.head, tree: fixture.tree });
    const session = await store.open({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:owner",
      binding,
    });
    await store.closeSession({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:owner",
      mode: "ABANDON",
    });
    store.close();
    store = new CoreMutationSessionStore(stateDir);

    assert.equal((await store.closeSession({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:owner",
      mode: "ABANDON",
    })).status, "ABANDONED");
    await assert.rejects(
      () => store.closeSession({
        sessionId: session.id,
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        actorKey: "actor:foreign",
        mode: "ABANDON",
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_ACTOR_MISMATCH",
    );
    await assert.rejects(
      () => store.closeSession({
        sessionId: session.id,
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        actorKey: "actor:owner",
        mode: "COMPLETE",
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_TERMINAL_MODE_CONFLICT",
    );
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ABANDON wins before admission CAS and admission wins before later ABANDON", async () => {
  const first = makeRepo();
  const firstStateDir = join(first.root, "state");
  const firstWorkspaceId = "ws_core_abandon_wins";
  const firstWorkspaceStore = createWorkspaceStore(firstStateDir);
  firstWorkspaceStore.createSession({ id: firstWorkspaceId, root: first.repo, mode: "checkout" });
  const firstStore = new CoreMutationSessionStore(firstStateDir);
  let releaseAdmission!: () => void;
  let admissionReached!: () => void;
  const admissionPaused = new Promise<void>((resolve) => { admissionReached = resolve; });
  const release = new Promise<void>((resolve) => { releaseAdmission = resolve; });
  try {
    const binding = makeBinding({ workspaceSessionId: firstWorkspaceId, head: first.head, tree: first.tree });
    const session = await firstStore.open({ workspaceSessionId: firstWorkspaceId, workspaceRoot: first.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", binding });
    const admission = firstStore.admitEffect({
      workspaceSessionId: firstWorkspaceId,
      workspaceRoot: first.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash },
      paths: ["app.ts"],
      deletedPaths: [],
      pathContainment: "STRUCTURED_SINK_ENFORCED",
      beforeAdmissionCas: async () => {
        admissionReached();
        await release;
      },
    } as Parameters<CoreMutationSessionStore["admitEffect"]>[0]);
    await Promise.race([
      admissionPaused,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("admission CAS hook was not reached")), 250)),
    ]);
    assert.equal((await firstStore.closeSession({ sessionId: session.id, workspaceSessionId: firstWorkspaceId, workspaceRoot: first.repo, actorKey: "actor:test", mode: "ABANDON" })).status, "ABANDONED");
    releaseAdmission();
    await assert.rejects(
      admission,
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_ADMISSION_RACE",
    );
  } finally {
    releaseAdmission?.();
    firstStore.close();
    firstWorkspaceStore.close?.();
    rmSync(first.root, { recursive: true, force: true });
  }

  const second = makeRepo();
  const secondStateDir = join(second.root, "state");
  const secondWorkspaceId = "ws_core_admission_wins";
  const secondWorkspaceStore = createWorkspaceStore(secondStateDir);
  secondWorkspaceStore.createSession({ id: secondWorkspaceId, root: second.repo, mode: "checkout" });
  const secondStore = new CoreMutationSessionStore(secondStateDir);
  try {
    const binding = makeBinding({ workspaceSessionId: secondWorkspaceId, head: second.head, tree: second.tree });
    const session = await secondStore.open({ workspaceSessionId: secondWorkspaceId, workspaceRoot: second.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", binding });
    await secondStore.admitEffect({ workspaceSessionId: secondWorkspaceId, workspaceRoot: second.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash }, paths: ["app.ts"], deletedPaths: [], pathContainment: "STRUCTURED_SINK_ENFORCED" });
    await assert.rejects(
      () => secondStore.closeSession({ sessionId: session.id, workspaceSessionId: secondWorkspaceId, workspaceRoot: second.repo, actorKey: "actor:test", mode: "ABANDON" }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_RECONCILE_REQUIRED",
    );
  } finally {
    secondStore.close();
    secondWorkspaceStore.close?.();
    rmSync(second.root, { recursive: true, force: true });
  }
});

test("status refreshes expiry and Candidate recording rejects stale session", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_status_expiry";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    const binding = makeBinding({ workspaceSessionId: workspaceId, head: fixture.head, tree: fixture.tree, allowedPaths: ["app.ts"], validUntil: "2026-09-14T02:00:00.000Z" });
    const session = await store.open({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", binding, now: new Date("2026-09-14T01:00:00.000Z") });
    await store.admitEffect({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash }, paths: ["app.ts"], deletedPaths: [], pathContainment: "STRUCTURED_SINK_ENFORCED", now: new Date("2026-09-14T01:10:00.000Z") });
    writeFileSync(join(fixture.repo, "app.ts"), "export const value = 2;\n");
    git(fixture.repo, "add", "app.ts");
    git(fixture.repo, "commit", "-m", "candidate after admission");

    const refreshed = store.getById(session.id, new Date("2026-09-14T03:00:00.000Z"));
    assert.equal(refreshed?.freshnessState, "EXPIRED");
    assert.equal(refreshed?.rebindState, "REBIND_REQUIRED");
    await assert.rejects(
      () => store.recordCandidate({ sessionId: session.id, workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, actorKey: "actor:test", candidateHead: git(fixture.repo, "rev-parse", "HEAD"), candidateTree: git(fixture.repo, "rev-parse", "HEAD^{tree}"), now: new Date("2026-09-14T03:00:00.000Z") }),
      (error: unknown) => error instanceof CoreMutationSessionError && (error.code === "BINDING_EXPIRED" || error.code === "CORE_MUTATION_REBIND_REQUIRED"),
    );
    assert.equal(store.getCandidate(git(fixture.repo, "rev-parse", "HEAD")), undefined);
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("unreconciled Core-bound writer blocks Candidate completion", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_active_writer";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    const binding = makeBinding({ workspaceSessionId: workspaceId, head: fixture.head, tree: fixture.tree, allowedPaths: ["app.ts"] });
    const session = await store.open({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", binding });
    await store.admitEffect({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash }, pathContainment: "NOT_PROVEN", writerDomain: "PROCESS" });
    assert.equal(store.getById(session.id)?.writerReconciliationState, "OUTCOME_UNKNOWN");
    writeFileSync(join(fixture.repo, "app.ts"), "export const value = 2;\n");
    git(fixture.repo, "add", "app.ts");
    git(fixture.repo, "commit", "-m", "candidate while writer unresolved");
    await store.recordCandidate({ sessionId: session.id, workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, actorKey: "actor:test", candidateHead: git(fixture.repo, "rev-parse", "HEAD"), candidateTree: git(fixture.repo, "rev-parse", "HEAD^{tree}") });
    await assert.rejects(
      () => store.closeSession({ sessionId: session.id, workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, actorKey: "actor:test", mode: "COMPLETE" }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_WRITER_RECONCILE_REQUIRED",
    );
    assert.equal((await store.closeSession({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:test",
      mode: "COMPLETE",
      inspectWriterDomain: async () => "CLEAR",
    } as Parameters<CoreMutationSessionStore["closeSession"]>[0])).status, "COMPLETED");
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("admission winning during COMPLETE causes terminal CAS conflict", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_complete_admission_race";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  let releaseClose!: () => void;
  let closeReached!: () => void;
  const closePaused = new Promise<void>((resolve) => { closeReached = resolve; });
  const release = new Promise<void>((resolve) => { releaseClose = resolve; });
  try {
    const binding = makeBinding({ workspaceSessionId: workspaceId, head: fixture.head, tree: fixture.tree, allowedPaths: ["app.ts"] });
    const session = await store.open({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", binding });
    await store.admitEffect({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash }, paths: ["app.ts"], pathContainment: "STRUCTURED_SINK_ENFORCED" });
    writeFileSync(join(fixture.repo, "app.ts"), "export const value = 2;\n");
    git(fixture.repo, "add", "app.ts");
    git(fixture.repo, "commit", "-m", "candidate before close race");
    await store.recordCandidate({ sessionId: session.id, workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, actorKey: "actor:test", candidateHead: git(fixture.repo, "rev-parse", "HEAD"), candidateTree: git(fixture.repo, "rev-parse", "HEAD^{tree}") });

    const closing = store.closeSession({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:test",
      mode: "COMPLETE",
      beforeCloseCas: async () => {
        closeReached();
        await release;
      },
    } as Parameters<CoreMutationSessionStore["closeSession"]>[0]);
    await Promise.race([closePaused, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("close CAS hook was not reached")), 250))]);
    const admission = await store.admitEffect({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash },
      pathContainment: "NOT_PROVEN",
      writerDomain: "PROCESS",
    } as Parameters<CoreMutationSessionStore["admitEffect"]>[0]);
    assert.equal(admission.bound, true, "the concurrent sink wins only while the Core session remains ACTIVE");
    releaseClose();
    await assert.rejects(
      closing,
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_RECONCILE_REQUIRED",
    );
    assert.equal(store.getById(session.id)?.status, "ACTIVE");
  } finally {
    releaseClose?.();
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("every durably admitted writer domain must independently reconcile CLEAR", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_writer_domains";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    const binding = makeBinding({ workspaceSessionId: workspaceId, head: fixture.head, tree: fixture.tree, allowedPaths: ["app.ts"] });
    const session = await store.open({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", binding });
    for (const writerDomain of ["PROCESS", "AGENT"] as const) {
      await store.admitEffect({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash }, pathContainment: "NOT_PROVEN", writerDomain } as Parameters<CoreMutationSessionStore["admitEffect"]>[0]);
    }
    assert.deepEqual(store.getById(session.id)?.writerDomains, ["AGENT", "PROCESS"]);
    writeFileSync(join(fixture.repo, "app.ts"), "export const value = 2;\n");
    git(fixture.repo, "add", "app.ts");
    git(fixture.repo, "commit", "-m", "candidate with two writer domains");
    await store.recordCandidate({ sessionId: session.id, workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, actorKey: "actor:test", candidateHead: git(fixture.repo, "rev-parse", "HEAD"), candidateTree: git(fixture.repo, "rev-parse", "HEAD^{tree}") });

    for (const states of [
      { PROCESS: "UNKNOWN", AGENT: "CLEAR" },
      { PROCESS: "CLEAR", AGENT: "UNKNOWN" },
      { PROCESS: "ACTIVE", AGENT: "CLEAR" },
    ] as const) {
      await assert.rejects(
        () => store.closeSession({ sessionId: session.id, workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, actorKey: "actor:test", mode: "COMPLETE", inspectWriterDomain: async (_record, domain) => states[domain] } as Parameters<CoreMutationSessionStore["closeSession"]>[0]),
        (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_WRITER_RECONCILE_REQUIRED",
      );
    }
    const completed = await store.closeSession({ sessionId: session.id, workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, actorKey: "actor:test", mode: "COMPLETE", inspectWriterDomain: async () => "CLEAR" } as Parameters<CoreMutationSessionStore["closeSession"]>[0]);
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.writerReconciliationState, "CLEAR");
    assert.deepEqual(completed.writerDomains, []);
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("synchronous Git effect is unresolved until CAS-bound physical reconciliation", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_synchronous_git";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    const binding = makeBinding({ workspaceSessionId: workspaceId, head: fixture.head, tree: fixture.tree });
    const session = await store.open({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", binding });
    await store.admitEffect({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash },
      pathContainment: "NOT_PROVEN",
      synchronousPostEffectCheck: true,
    } as Parameters<CoreMutationSessionStore["admitEffect"]>[0]);
    assert.deepEqual(store.getById(session.id)?.writerDomains, ["SYNCHRONOUS_GIT"]);
    await assert.rejects(
      () => store.closeSession({ sessionId: session.id, workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, actorKey: "actor:test", mode: "COMPLETE" }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_WRITER_RECONCILE_REQUIRED",
    );
    const reconciled = await store.reconcileSynchronousEffect({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:test",
      bindingHash: session.bindingHash,
    });
    assert.deepEqual(reconciled.session.writerDomains, []);
    assert.equal(reconciled.session.writerReconciliationState, "CLEAR");
    assert.deepEqual(reconciled.snapshot.scopeEscapePaths, []);
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("synchronous reconciliation never clears required PROCESS evidence", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_sync_process_mix";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    const binding = makeBinding({ workspaceSessionId: workspaceId, head: fixture.head, tree: fixture.tree });
    const session = await store.open({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", binding });
    await store.admitEffect({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash }, pathContainment: "NOT_PROVEN", writerDomain: "PROCESS" });
    await store.admitEffect({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash }, pathContainment: "NOT_PROVEN", synchronousPostEffectCheck: true } as Parameters<CoreMutationSessionStore["admitEffect"]>[0]);
    const reconciled = await store.reconcileSynchronousEffect({ sessionId: session.id, workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, actorKey: "actor:test", bindingHash: session.bindingHash });
    assert.deepEqual(reconciled.session.writerDomains, ["PROCESS"]);
    assert.equal(reconciled.session.writerReconciliationState, "OUTCOME_UNKNOWN");
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("owner recovery clears only an exact orphaned PROCESS writer after physical evidence", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_orphan_process_recovery";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  const originalActor = `mcp:${"a".repeat(64)}`;
  const recoveryActor = `mcp:${"b".repeat(64)}`;
  try {
    const binding = makeBinding({ workspaceSessionId: workspaceId, head: fixture.head, tree: fixture.tree });
    const session = await store.open({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: originalActor,
      binding,
    });
    await store.admitEffect({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: originalActor,
      pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash },
      pathContainment: "NOT_PROVEN",
      writerDomain: "PROCESS",
    });
    writeFileSync(join(fixture.repo, "app.ts"), "export const value = 2;\n");
    const expected = await store.snapshot({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: originalActor,
    });
    const evidence = {
      expectedOriginalActorKey: originalActor,
      expectedSourceHead: fixture.head,
      expectedSourceTree: fixture.tree,
      expectedCurrentHead: fixture.head,
      expectedTargetTree: expected.targetTree,
      expectedDiffHash: expected.diffHash,
      expectedChangedPaths: expected.changedPaths,
      expectedDeletedPaths: expected.deletedPaths,
    };

    await assert.rejects(
      () => store.recoverOrphanedProcessEffect({
        sessionId: session.id,
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        recoveryActorKey: recoveryActor,
        bindingHash: session.bindingHash,
        evidence,
        inspectProcessWriter: () => "ACTIVE",
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_RECOVERY_WRITER_ACTIVE",
    );
    await assert.rejects(
      () => store.recoverOrphanedProcessEffect({
        sessionId: session.id,
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        recoveryActorKey: recoveryActor,
        bindingHash: session.bindingHash,
        evidence: { ...evidence, expectedOriginalActorKey: `mcp:${"c".repeat(64)}` },
        inspectProcessWriter: () => "UNKNOWN",
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_RECOVERY_ACTOR_MISMATCH",
    );
    await assert.rejects(
      () => store.recoverOrphanedProcessEffect({
        sessionId: session.id,
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        recoveryActorKey: recoveryActor,
        bindingHash: session.bindingHash,
        evidence: { ...evidence, expectedDiffHash: `sha256:${"f".repeat(64)}` },
        inspectProcessWriter: () => "UNKNOWN",
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_RECOVERY_PHYSICAL_MISMATCH",
    );

    const recovered = await store.recoverOrphanedProcessEffect({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      recoveryActorKey: recoveryActor,
      bindingHash: session.bindingHash,
      evidence,
      inspectProcessWriter: () => "UNKNOWN",
    });
    assert.equal(recovered.observedWriterState, "UNKNOWN");
    assert.equal(recovered.alreadyReconciled, false);
    assert.equal(recovered.session.actorKey, originalActor);
    assert.equal(recovered.session.status, "ACTIVE");
    assert.deepEqual(recovered.session.writerDomains, []);
    assert.equal(recovered.session.writerReconciliationState, "CLEAR");
    assert.equal(recovered.snapshot.diffHash, expected.diffHash);
    assert.equal(recovered.snapshot.targetTree, expected.targetTree);

    const replay = await store.recoverOrphanedProcessEffect({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      recoveryActorKey: recoveryActor,
      bindingHash: session.bindingHash,
      evidence,
      inspectProcessWriter: () => "UNKNOWN",
    });
    assert.equal(replay.alreadyReconciled, true);
    assert.deepEqual(replay.session.writerDomains, []);
    assert.equal(replay.session.writerReconciliationState, "CLEAR");
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("binding hashes, Core contract, and authority shape reject forgery", () => {
  const original = makeBinding({
    workspaceSessionId: "ws_core_forgery",
    head: "a".repeat(40),
    tree: "b".repeat(40),
  });
  const forgedBinding = structuredClone(original);
  forgedBinding.binding_hash = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => parseRepositoryMutationBinding(forgedBinding),
    (error: unknown) => error instanceof CoreMutationSessionError && error.code === "BINDING_HASH_MISMATCH",
  );

  const forgedContract = structuredClone(original);
  forgedContract.core.acceptance_contract.allowed_paths.push("widened.ts");
  assert.throws(
    () => parseRepositoryMutationBinding(forgedContract),
    (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_CONTRACT_HASH_MISMATCH",
  );

  const providerAsAuthority = { ...structuredClone(original), provider: "gpt-5.6-sol", model: "gpt-5.6-sol" };
  assert.throws(
    () => parseRepositoryMutationBinding(providerAsAuthority),
    (error: unknown) => error instanceof CoreMutationSessionError && error.code === "MALFORMED_BINDING",
  );
});

test("an unrecorded HEAD change after first effect requires Core rebind", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_head_drift";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    const binding = makeBinding({ workspaceSessionId: workspaceId, head: fixture.head, tree: fixture.tree });
    const session = await store.open({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      binding,
    });
    await store.admitEffect({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash },
      paths: ["app.ts"],
      deletedPaths: [],
      pathContainment: "STRUCTURED_SINK_ENFORCED",
    });
    writeFileSync(join(fixture.repo, "app.ts"), "export const value = 2;\n");
    git(fixture.repo, "add", "app.ts");
    git(fixture.repo, "commit", "-m", "unrecorded external commit");

    await assert.rejects(
      () => store.admitEffect({
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        workspaceMode: "checkout",
        managed: false,
        actorKey: "actor:test",
        pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash },
        paths: ["app.ts"],
        deletedPaths: [],
        pathContainment: "STRUCTURED_SINK_ENFORCED",
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_REBIND_REQUIRED",
    );
    assert.equal(store.getById(session.id)?.rebindState, "REBIND_REQUIRED");
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("source, pointer, scope, verifier, deletion, and lane identity remain immutable", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_immutable";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    const staleHead = makeBinding({ workspaceSessionId: workspaceId, head: "a".repeat(40), tree: fixture.tree });
    await assert.rejects(
      () => store.open({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", binding: staleHead }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "SOURCE_REVISION_MISMATCH",
    );
    const staleTree = makeBinding({ workspaceSessionId: workspaceId, head: fixture.head, tree: "b".repeat(40) });
    await assert.rejects(
      () => store.open({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", binding: staleTree }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "SOURCE_TREE_MISMATCH",
    );

    const binding = makeBinding({ workspaceSessionId: workspaceId, head: fixture.head, tree: fixture.tree });
    const session = await store.open({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", binding });
    await assert.rejects(
      () => store.admitEffect({
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        workspaceMode: "checkout",
        managed: false,
        actorKey: "actor:test",
        pointer: { required: true, sessionId: session.id, bindingHash: `sha256:${"e".repeat(64)}` },
        paths: ["app.ts"],
        deletedPaths: [],
        pathContainment: "STRUCTURED_SINK_ENFORCED",
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_BINDING_MISMATCH",
    );

    for (const [index, mutate] of [
      (candidate: RepositoryMutationBinding) => candidate.core.acceptance_contract.allowed_paths.push("widened.ts"),
      (candidate: RepositoryMutationBinding) => { candidate.core.acceptance_contract.required_verifier_ids = ["replacement-verifier"]; },
      (candidate: RepositoryMutationBinding) => { candidate.core.acceptance_contract.deletion_policy = "ALLOW"; },
      (candidate: RepositoryMutationBinding) => { candidate.integration_authority.authority_ref = "different-authority"; },
    ].entries()) {
      const changed = structuredClone(binding);
      mutate(changed);
      changed.binding_id = `independent-binding-${index}`;
      changed.operation_id = `independent-operation-${index}`;
      changed.attempt_id = `independent-attempt-${index}`;
      changed.core.acceptance_contract_hash = acceptanceContractHash(changed.core.acceptance_contract);
      const { binding_hash: _oldHash, ...withoutHash } = changed;
      changed.binding_hash = computeRepositoryMutationBindingHash(withoutHash);
      await assert.rejects(
        () => store.open({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", binding: changed }),
        (error: unknown) => error instanceof CoreMutationSessionError && error.code === "ACTIVE_CORE_MUTATION_SESSION_CONFLICT",
      );
    }
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Core session binds clean source and snapshots deterministic worktree tree", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_session_test";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    const receipt = discoveryReceipt();
    const binding = makeBinding({ workspaceSessionId: workspaceId, head: fixture.head, tree: fixture.tree, receipt });
    assertCapabilityDiscoveryBinding(binding, receipt);
    const session = await store.open({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      binding,
      now: new Date("2026-09-14T01:00:00.000Z"),
    });
    assert.equal(session.status, "ACTIVE");

    writeFileSync(join(fixture.repo, "app.ts"), "export const value = 2;\n");
    writeFileSync(join(fixture.repo, "new.ts"), "export const added = true;\n");
    const looseObjectsBefore = git(fixture.repo, "count-objects", "-v");
    const snapshot = await store.snapshot({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:test",
    });
    assert.match(snapshot.targetRevision, /^git-tree:[0-9a-f]{40}$/);
    assert.deepEqual(snapshot.changedPaths, ["app.ts", "new.ts"]);
    assert.deepEqual(snapshot.deletedPaths, []);
    assert.deepEqual(snapshot.scopeEscapePaths, []);
    assert.equal(snapshot.deletionViolation, false);
    assert.equal(git(fixture.repo, "rev-parse", "HEAD"), fixture.head);
    assert.equal(git(fixture.repo, "diff", "--cached", "--name-only"), "", "snapshot must not pollute the caller index");
    assert.equal(
      git(fixture.repo, "count-objects", "-v"),
      looseObjectsBefore,
      "snapshot must use isolated temporary Git object storage",
    );
    assert.equal(snapshot.objectStorage, "ISOLATED_TEMPORARY");
    assert.deepEqual(snapshot.changeSet, {
      change_set_id: snapshot.changeSetId,
      source_revision: `git-commit:${fixture.head}`,
      target_revision: snapshot.targetRevision,
      diff_hash: snapshot.diffHash,
      paths: ["app.ts", "new.ts"],
      deleted_paths: [],
    });
    assert.match(snapshot.changeSetId, /^sha256:[0-9a-f]{64}$/);
    assert.match(snapshot.changeSetHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(snapshot.changeManifest.schema, "nexus.core.git-change-manifest.v1-experimental");
    assert.equal(snapshot.changeManifest.manifest_hash, snapshot.diffHash);
    assert.deepEqual(snapshot.provenance, {
      operationId: binding.operation_id,
      attemptId: binding.attempt_id,
      workspaceSessionId: workspaceId,
      bindingId: binding.binding_id,
      bindingHash: binding.binding_hash,
    });

    await assert.rejects(
      () => store.admitEffect({
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        workspaceMode: "checkout",
        managed: false,
        actorKey: "actor:test",
        pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash },
        paths: ["outside.ts"],
        deletedPaths: [],
        pathContainment: "STRUCTURED_SINK_ENFORCED",
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_SCOPE_ESCAPE",
    );
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Core manifest path ordering matches canonical cross-language lexical order", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_manifest_order";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    const expectedPaths = [
      "README.md",
      "docs/EXTRACTION_STATUS.md",
      "docs/current-source-ownership.json",
    ];
    const binding = makeBinding({
      workspaceSessionId: workspaceId,
      head: fixture.head,
      tree: fixture.tree,
      allowedPaths: expectedPaths,
    });
    const session = await store.open({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      binding,
    });

    mkdirSync(join(fixture.repo, "docs"));
    writeFileSync(join(fixture.repo, "README.md"), "readme\n");
    writeFileSync(join(fixture.repo, "docs", "EXTRACTION_STATUS.md"), "status\n");
    writeFileSync(join(fixture.repo, "docs", "current-source-ownership.json"), "{}\n");

    const snapshot = await store.snapshot({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:test",
    });

    assert.deepEqual(snapshot.changedPaths, expectedPaths);
    assert.deepEqual(snapshot.changeManifest.entries.map((entry) => entry.path), expectedPaths);
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dirty bind and forbidden deletion fail closed", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_delete_test";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    const binding = makeBinding({ workspaceSessionId: workspaceId, head: fixture.head, tree: fixture.tree });
    writeFileSync(join(fixture.repo, "app.ts"), "dirty before bind\n");
    await assert.rejects(
      () => store.open({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", binding }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "WORKSPACE_NOT_CLEAN_AT_BIND",
    );

    git(fixture.repo, "checkout", "--", "app.ts");
    const session = await store.open({ workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, workspaceMode: "checkout", managed: false, actorKey: "actor:test", binding });
    await assert.rejects(
      () => store.admitEffect({
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        workspaceMode: "checkout",
        managed: false,
        actorKey: "actor:test",
        pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash },
        paths: ["app.ts"],
        deletedPaths: ["app.ts"],
        pathContainment: "STRUCTURED_SINK_ENFORCED",
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_DELETION_FORBIDDEN",
    );

    unlinkSync(join(fixture.repo, "app.ts"));
    const snapshot = await store.snapshot({ sessionId: session.id, workspaceSessionId: workspaceId, workspaceRoot: fixture.repo, actorKey: "actor:test" });
    assert.deepEqual(snapshot.deletedPaths, ["app.ts"]);
    assert.equal(snapshot.deletionViolation, true);
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("capability-discovery receipt identity must match binding exactly", () => {
  const receipt = discoveryReceipt("1".repeat(40));
  const binding = makeBinding({ workspaceSessionId: "ws_discovery", head: "a".repeat(40), tree: "b".repeat(40), receipt });
  assertCapabilityDiscoveryBinding(binding, receipt);
  assert.throws(
    () => assertCapabilityDiscoveryBinding(binding, discoveryReceipt("9".repeat(40))),
    (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CAPABILITY_DISCOVERY_BINDING_MISMATCH",
  );
});

test("Candidate provenance durably binds exact committed physical ChangeSet", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_candidate_test";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  let store = new CoreMutationSessionStore(stateDir);
  try {
    const binding = makeBinding({
      workspaceSessionId: workspaceId,
      head: fixture.head,
      tree: fixture.tree,
      allowedPaths: ["app.ts"],
    });
    const session = await store.open({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      binding,
      now: new Date("2026-09-14T01:00:00.000Z"),
    });
    await store.admitEffect({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash },
      paths: ["app.ts"],
      deletedPaths: [],
      pathContainment: "STRUCTURED_SINK_ENFORCED",
    });
    writeFileSync(join(fixture.repo, "app.ts"), "export const value = 2;\n");
    git(fixture.repo, "add", "app.ts");
    git(fixture.repo, "commit", "-m", "candidate");
    const candidateHead = git(fixture.repo, "rev-parse", "HEAD");
    const candidateTree = git(fixture.repo, "rev-parse", "HEAD^{tree}");

    const provenance = await store.recordCandidate({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:test",
      candidateHead,
      candidateTree,
      now: new Date("2026-09-14T01:05:00.000Z"),
    });
    assert.equal(provenance.candidateHead, candidateHead);
    assert.equal(provenance.candidateTree, candidateTree);
    assert.equal(provenance.sourceHead, fixture.head);
    assert.deepEqual(provenance.changedPaths, ["app.ts"]);
    assert.deepEqual(provenance.deletedPaths, []);
    assert.match(provenance.changeSetId, /^sha256:[0-9a-f]{64}$/);
    assert.match(provenance.changeSetHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(provenance.changeManifestHash, provenance.diffHash);
    assert.equal(store.getCandidate(candidateHead)?.bindingHash, session.bindingHash);

    const replay = await store.recordCandidate({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:test",
      candidateHead,
      candidateTree,
      now: new Date("2026-09-14T02:00:00.000Z"),
    });
    assert.deepEqual(replay, provenance);

    await store.closeSession({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:test",
      mode: "COMPLETE",
    });
    assert.equal(store.getCandidate(candidateHead)?.candidateTree, candidateTree);

    store.close();
    store = new CoreMutationSessionStore(stateDir);
    assert.equal((await store.closeSession({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:test",
      mode: "COMPLETE",
    })).status, "COMPLETED");
    await assert.rejects(
      () => store.closeSession({
        sessionId: session.id,
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        actorKey: "actor:foreign",
        mode: "COMPLETE",
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_ACTOR_MISMATCH",
    );
    await assert.rejects(
      () => store.closeSession({
        sessionId: session.id,
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        actorKey: "actor:test",
        mode: "ABANDON",
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_TERMINAL_MODE_CONFLICT",
    );
    const changedAfterComplete = structuredClone(binding);
    changedAfterComplete.core.acceptance_contract.deletion_policy = "ALLOW";
    changedAfterComplete.core.acceptance_contract_hash = acceptanceContractHash(changedAfterComplete.core.acceptance_contract);
    const { binding_hash: _oldHash, ...changedWithoutHash } = changedAfterComplete;
    changedAfterComplete.binding_hash = computeRepositoryMutationBindingHash(changedWithoutHash);
    await assert.rejects(
      () => store.open({
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        workspaceMode: "checkout",
        managed: false,
        actorKey: "actor:test",
        binding: changedAfterComplete,
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "BINDING_REPLAY_CONFLICT",
    );
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Candidate provenance rejects committed scope escape and forbidden deletion", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws_core_candidate_negative";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    const binding = makeBinding({
      workspaceSessionId: workspaceId,
      head: fixture.head,
      tree: fixture.tree,
      allowedPaths: ["app.ts"],
      deletionPolicy: "FORBID",
    });
    const session = await store.open({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      binding,
    });

    writeFileSync(join(fixture.repo, "outside.ts"), "export const escaped = true;\n");
    git(fixture.repo, "add", "outside.ts");
    git(fixture.repo, "commit", "-m", "scope escape");
    const escapeHead = git(fixture.repo, "rev-parse", "HEAD");
    const escapeTree = git(fixture.repo, "rev-parse", "HEAD^{tree}");
    await assert.rejects(
      () => store.recordCandidate({
        sessionId: session.id,
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        actorKey: "actor:test",
        candidateHead: escapeHead,
        candidateTree: escapeTree,
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_SCOPE_ESCAPE",
    );

    git(fixture.repo, "reset", "--hard", fixture.head);
    unlinkSync(join(fixture.repo, "app.ts"));
    git(fixture.repo, "add", "-A");
    git(fixture.repo, "commit", "-m", "forbidden deletion");
    const deletionHead = git(fixture.repo, "rev-parse", "HEAD");
    const deletionTree = git(fixture.repo, "rev-parse", "HEAD^{tree}");
    await assert.rejects(
      () => store.recordCandidate({
        sessionId: session.id,
        workspaceSessionId: workspaceId,
        workspaceRoot: fixture.repo,
        actorKey: "actor:test",
        candidateHead: deletionHead,
        candidateTree: deletionTree,
      }),
      (error: unknown) => error instanceof CoreMutationSessionError && error.code === "CORE_MUTATION_DELETION_FORBIDDEN",
    );
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("produceDirectCandidateEvidence produces valid signed evidence matching exact candidate and agent records", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws-direct-candidate-test";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    const dispatchIntent = {
      taskId: "operation-test-1",
      attemptId: "attempt-test-1",
      roleIntent: "DEEP_ENGINEERING" as const,
      objective: "implement direct candidate execution evidence producer",
      acceptanceCriteria: ["producer passes verification"],
      claimCeiling: "CANDIDATE_READY" as const,
      verificationRequired: true,
      exclusiveOwnership: true,
      writeScope: ["app.ts"],
    };
    const dispatchIntentHash = computeDispatchIntentHash(dispatchIntent);

    const binding = makeBinding({
      workspaceSessionId: workspaceId,
      head: fixture.head,
      tree: fixture.tree,
      executionLane: "DIRECT_DELEGATED",
      authorityHash: `sha256:${dispatchIntentHash}`,
    });
    const session = await store.open({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      binding,
    });

    writeFileSync(join(fixture.repo, "app.ts"), "export const value = 42;\n");
    git(fixture.repo, "add", "app.ts");
    git(fixture.repo, "commit", "-m", "candidate implementation");
    const candidateHead = git(fixture.repo, "rev-parse", "HEAD");
    const candidateTree = git(fixture.repo, "rev-parse", "HEAD^{tree}");

    await store.recordCandidate({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:test",
      candidateHead,
      candidateTree,
    });

    const executionGen = buildExecutionGenerationBinding({
      profileCatalogGeneration: "gen-1",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      executionIdentity: "agent:worker-1",
      runtimeVersion: "1.0.0",
      devspaceBuildId: "build-123",
      devspaceSourceCommit: fixture.head,
    });

    const agentRecord: CoreMutationDurableAgentRecord = {
      id: "agent-123",
      workspaceId,
      workspaceRoot: fixture.repo,
      profileName: "deep-engineer",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      status: "stopped",
      terminalReason: "completed",
      scopeState: "WITHIN_SCOPE",
      executionContract: {
        coreMutation: {
          sessionId: session.id,
          bindingHash: session.bindingHash,
        },
        dispatchIntent,
      },
      executionGeneration: executionGen,
      createdAt: "2026-09-23T12:00:00.000Z",
      updatedAt: "2026-09-23T12:05:00.000Z",
    };

    const evidence = await store.produceDirectCandidateEvidence({
      workspaceId,
      sessionId: session.id,
      candidateHead,
      agentId: agentRecord.id,
      agentReader: (id) => (id === agentRecord.id ? agentRecord : undefined),
    });

    assert.equal(evidence.schema, DIRECT_CANDIDATE_EXECUTION_SCHEMA);
    assert.match(evidence.evidence_id, /^dce_[0-9a-f]{32}$/);
    assert.equal(evidence.authority.authority_mode, "OWNER_DIRECT");
    assert.equal(evidence.authority.execution_lane, "DIRECT_DELEGATED");
    assert.equal(evidence.authority.task_id, binding.operation_id);
    assert.equal(evidence.authority.attempt_id, binding.attempt_id);
    assert.equal(evidence.execution.agent_id, agentRecord.id);
    assert.equal(evidence.execution.state, "completed");
    assert.equal(evidence.execution.terminal_reason, "completed");
    assert.equal(evidence.execution.retry_safe, false);
    assert.equal(evidence.execution.reconciliation_required, false);
    assert.equal(evidence.core_binding.session_id, session.id);
    assert.equal(evidence.core_binding.binding_hash, session.bindingHash);
    assert.equal(evidence.candidate.commit_sha, candidateHead);
    assert.equal(evidence.candidate.tree_sha, candidateTree);
    assert.deepEqual(evidence.candidate.changed_paths, ["app.ts"]);
    assert.deepEqual(evidence.candidate.deleted_paths, []);
    assert.equal(evidence.claim.status, "CANDIDATE_CAPTURED_PENDING_CORE_VERIFICATION_AND_ACCEPTANCE");
    assert.equal(evidence.claim.claim_ceiling, "CANDIDATE_READY");
    assert.equal(evidence.claim.core_verified, false);
    assert.equal(evidence.claim.accepted, false);
    assert.equal(evidence.claim.merged, false);

    assert.doesNotThrow(() => validateDirectCandidateExecutionEvidence(evidence));
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("produceDirectCandidateEvidence rejects unresolved Core writer reconciliation", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws-direct-candidate-writer-unresolved";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    const dispatchIntent = {
      taskId: "operation-writer-unresolved",
      attemptId: "attempt-writer-unresolved",
      roleIntent: "DEEP_ENGINEERING" as const,
      objective: "reject unresolved writer reconciliation",
      acceptanceCriteria: ["producer fails closed"],
      claimCeiling: "CANDIDATE_READY" as const,
      verificationRequired: true,
      exclusiveOwnership: true,
      writeScope: ["app.ts"],
    };
    const dispatchIntentHash = computeDispatchIntentHash(dispatchIntent);
    const binding = makeBinding({
      workspaceSessionId: workspaceId,
      head: fixture.head,
      tree: fixture.tree,
      executionLane: "DIRECT_DELEGATED",
      authorityHash: `sha256:${dispatchIntentHash}`,
    });
    const session = await store.open({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      binding,
    });

    await store.admitEffect({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      pointer: { required: true, sessionId: session.id, bindingHash: session.bindingHash },
      pathContainment: "NOT_PROVEN",
      writerDomain: "PROCESS",
    } as Parameters<CoreMutationSessionStore["admitEffect"]>[0]);

    writeFileSync(join(fixture.repo, "app.ts"), "export const value = 77;\n");
    git(fixture.repo, "add", "app.ts");
    git(fixture.repo, "commit", "-m", "candidate with unresolved writer");
    const candidateHead = git(fixture.repo, "rev-parse", "HEAD");
    const candidateTree = git(fixture.repo, "rev-parse", "HEAD^{tree}");

    await store.recordCandidate({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:test",
      candidateHead,
      candidateTree,
    });

    const executionGen = buildExecutionGenerationBinding({
      profileCatalogGeneration: "gen-1",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      executionIdentity: "agent:writer-unresolved",
      runtimeVersion: "1.0.0",
      devspaceBuildId: "build-123",
      devspaceSourceCommit: fixture.head,
    });

    const agentRecord: CoreMutationDurableAgentRecord = {
      id: "agent-writer-unresolved",
      workspaceId,
      workspaceRoot: fixture.repo,
      profileName: "deep-engineer",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      status: "stopped",
      terminalReason: "completed",
      scopeState: "WITHIN_SCOPE",
      executionContract: {
        coreMutation: {
          sessionId: session.id,
          bindingHash: session.bindingHash,
        },
        dispatchIntent,
      },
      executionGeneration: executionGen,
      createdAt: "2026-09-23T12:00:00.000Z",
      updatedAt: "2026-09-23T12:05:00.000Z",
    };

    const unresolved = store.getById(session.id);
    assert.equal(unresolved?.writerReconciliationState, "OUTCOME_UNKNOWN");
    assert.deepEqual(unresolved?.writerDomains, ["PROCESS"]);

    await assert.rejects(
      () => store.produceDirectCandidateEvidence({
        workspaceId,
        sessionId: session.id,
        candidateHead,
        agentId: agentRecord.id,
        agentReader: () => agentRecord,
      }),
      (err: unknown) => err instanceof CoreMutationSessionError && err.code === "DIRECT_EVIDENCE_RECONCILIATION_REQUIRED",
    );
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("produceDirectCandidateEvidence fails closed on mismatched or invalid invariants", async () => {
  const fixture = makeRepo();
  const stateDir = join(fixture.root, "state");
  const workspaceId = "ws-direct-candidate-neg-test";
  const workspaceStore = createWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: fixture.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  try {
    const dispatchIntent = {
      taskId: "operation-test-1",
      attemptId: "attempt-test-1",
      roleIntent: "DEEP_ENGINEERING" as const,
      objective: "test negative paths",
      acceptanceCriteria: ["passes"],
      claimCeiling: "CANDIDATE_READY" as const,
      verificationRequired: true,
      exclusiveOwnership: true,
      writeScope: ["app.ts"],
    };
    const dispatchIntentHash = computeDispatchIntentHash(dispatchIntent);

    const binding = makeBinding({
      workspaceSessionId: workspaceId,
      head: fixture.head,
      tree: fixture.tree,
      executionLane: "DIRECT_DELEGATED",
      authorityHash: `sha256:${dispatchIntentHash}`,
    });
    const session = await store.open({
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      workspaceMode: "checkout",
      managed: false,
      actorKey: "actor:test",
      binding,
    });

    writeFileSync(join(fixture.repo, "app.ts"), "export const value = 99;\n");
    git(fixture.repo, "add", "app.ts");
    git(fixture.repo, "commit", "-m", "candidate for neg test");
    const candidateHead = git(fixture.repo, "rev-parse", "HEAD");
    const candidateTree = git(fixture.repo, "rev-parse", "HEAD^{tree}");

    await store.recordCandidate({
      sessionId: session.id,
      workspaceSessionId: workspaceId,
      workspaceRoot: fixture.repo,
      actorKey: "actor:test",
      candidateHead,
      candidateTree,
    });

    const executionGen = buildExecutionGenerationBinding({
      profileCatalogGeneration: "gen-1",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      executionIdentity: "agent:worker-1",
      runtimeVersion: "1.0.0",
      devspaceBuildId: "build-123",
      devspaceSourceCommit: fixture.head,
    });

    const baseAgent: CoreMutationDurableAgentRecord = {
      id: "agent-neg-1",
      workspaceId,
      workspaceRoot: fixture.repo,
      profileName: "deep-engineer",
      provider: "anthropic",
      status: "stopped",
      terminalReason: "completed",
      scopeState: "WITHIN_SCOPE",
      executionContract: {
        coreMutation: {
          sessionId: session.id,
          bindingHash: session.bindingHash,
        },
        dispatchIntent,
      },
      executionGeneration: executionGen,
      createdAt: "2026-09-23T12:00:00.000Z",
      updatedAt: "2026-09-23T12:05:00.000Z",
    };

    // 1. Missing agent reader
    await assert.rejects(
      () => store.produceDirectCandidateEvidence({
        workspaceId,
        sessionId: session.id,
        candidateHead,
        agentId: baseAgent.id,
      }),
      (err: unknown) => err instanceof CoreMutationSessionError && err.code === "DURABLE_AGENT_READER_UNAVAILABLE",
    );

    // 2. Agent not found
    await assert.rejects(
      () => store.produceDirectCandidateEvidence({
        workspaceId,
        sessionId: session.id,
        candidateHead,
        agentId: "nonexistent-agent",
        agentReader: () => undefined,
      }),
      (err: unknown) => err instanceof CoreMutationSessionError && err.code === "DURABLE_AGENT_NOT_FOUND",
    );

    // 3. Agent still running
    await assert.rejects(
      () => store.produceDirectCandidateEvidence({
        workspaceId,
        sessionId: session.id,
        candidateHead,
        agentId: baseAgent.id,
        agentReader: () => ({ ...baseAgent, status: "running" }),
      }),
      (err: unknown) => err instanceof CoreMutationSessionError && err.code === "AGENT_EXECUTION_NOT_TERMINAL",
    );

    // 4. Agent failed
    await assert.rejects(
      () => store.produceDirectCandidateEvidence({
        workspaceId,
        sessionId: session.id,
        candidateHead,
        agentId: baseAgent.id,
        agentReader: () => ({ ...baseAgent, terminalReason: "provider_error" }),
      }),
      (err: unknown) => err instanceof CoreMutationSessionError && err.code === "AGENT_EXECUTION_FAILED",
    );

    // 5. Agent scope escaped
    await assert.rejects(
      () => store.produceDirectCandidateEvidence({
        workspaceId,
        sessionId: session.id,
        candidateHead,
        agentId: baseAgent.id,
        agentReader: () => ({ ...baseAgent, scopeState: "SCOPE_VIOLATION" }),
      }),
      (err: unknown) => err instanceof CoreMutationSessionError && err.code === "AGENT_SCOPE_ESCAPE",
    );

    // 6. Agent bound to different Core session
    await assert.rejects(
      () => store.produceDirectCandidateEvidence({
        workspaceId,
        sessionId: session.id,
        candidateHead,
        agentId: baseAgent.id,
        agentReader: () => ({
          ...baseAgent,
          executionContract: {
            ...baseAgent.executionContract as object,
            coreMutation: { sessionId: "cms_other", bindingHash: session.bindingHash },
          },
        }),
      }),
      (err: unknown) => err instanceof CoreMutationSessionError && err.code === "AGENT_CORE_MUTATION_MISMATCH",
    );

    // 7. Dispatch intent task mismatch
    await assert.rejects(
      () => store.produceDirectCandidateEvidence({
        workspaceId,
        sessionId: session.id,
        candidateHead,
        agentId: baseAgent.id,
        agentReader: () => ({
          ...baseAgent,
          executionContract: {
            ...baseAgent.executionContract as object,
            dispatchIntent: {
              ...(baseAgent.executionContract as any).dispatchIntent,
              taskId: "wrong-task",
            },
          },
        }),
      }),
      (err: unknown) => err instanceof CoreMutationSessionError && err.code === "DISPATCH_INTENT_TASK_MISMATCH",
    );

    // 8. Dispatch intent claim ceiling mismatch
    await assert.rejects(
      () => store.produceDirectCandidateEvidence({
        workspaceId,
        sessionId: session.id,
        candidateHead,
        agentId: baseAgent.id,
        agentReader: () => ({
          ...baseAgent,
          executionContract: {
            ...baseAgent.executionContract as object,
            dispatchIntent: {
              ...(baseAgent.executionContract as any).dispatchIntent,
              claimCeiling: "RESULT_RETURNED",
            },
          },
        }),
      }),
      (err: unknown) => err instanceof CoreMutationSessionError && err.code === "DISPATCH_INTENT_CLAIM_CEILING_MISMATCH",
    );

    // 9. Candidate head not found
    await assert.rejects(
      () => store.produceDirectCandidateEvidence({
        workspaceId,
        sessionId: session.id,
        candidateHead: "1".repeat(40),
        agentId: baseAgent.id,
        agentReader: () => baseAgent,
      }),
      (err: unknown) => err instanceof CoreMutationSessionError && err.code === "CANDIDATE_NOT_FOUND",
    );

    // 10. Core authority hash mismatch
    const alteredIntent = { ...dispatchIntent, objective: "altered objective" };
    await assert.rejects(
      () => store.produceDirectCandidateEvidence({
        workspaceId,
        sessionId: session.id,
        candidateHead,
        agentId: baseAgent.id,
        agentReader: () => ({
          ...baseAgent,
          executionContract: {
            ...baseAgent.executionContract as object,
            dispatchIntent: alteredIntent,
          },
        }),
      }),
      (err: unknown) => err instanceof CoreMutationSessionError && err.code === "CORE_AUTHORITY_HASH_MISMATCH",
    );

    // 11. Durable Candidate provenance cannot authorize a dirty physical worktree.
    writeFileSync(join(fixture.repo, "app.ts"), "export const value = 1001;\n");
    await assert.rejects(
      () => store.produceDirectCandidateEvidence({
        workspaceId,
        sessionId: session.id,
        candidateHead,
        agentId: baseAgent.id,
        agentReader: () => baseAgent,
      }),
      (err: unknown) => err instanceof CoreMutationSessionError && err.code === "DIRECT_EVIDENCE_PHYSICAL_WORKTREE_DIRTY",
    );

    // 12. Durable Candidate provenance cannot authorize evidence after physical HEAD moves.
    git(fixture.repo, "checkout", "--", "app.ts");
    writeFileSync(join(fixture.repo, "app.ts"), "export const value = 1002;\n");
    git(fixture.repo, "add", "app.ts");
    git(fixture.repo, "commit", "-m", "later physical head");
    await assert.rejects(
      () => store.produceDirectCandidateEvidence({
        workspaceId,
        sessionId: session.id,
        candidateHead,
        agentId: baseAgent.id,
        agentReader: () => baseAgent,
      }),
      (err: unknown) => err instanceof CoreMutationSessionError && err.code === "DIRECT_EVIDENCE_PHYSICAL_CANDIDATE_MISMATCH",
    );
  } finally {
    store.close();
    workspaceStore.close?.();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
