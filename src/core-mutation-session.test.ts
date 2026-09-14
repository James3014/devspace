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
  type RepositoryMutationBinding,
} from "./core-mutation-session.js";
import {
  CAPABILITY_DISCOVERY_INDEX_PATH,
  CAPABILITY_DISCOVERY_RECEIPT_SCHEMA,
  NEXUS_CAPABILITY_REPOSITORY,
  type CapabilityDiscoveryReceipt,
} from "./capability-discovery.js";
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
      execution_lane: "DIRECT_CANONICAL",
      authority_ref: "James3014/devspace#135",
      authority_hash: `sha256:${"4".repeat(64)}`,
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
      valid_until: null,
      revalidate_before_first_effect: true,
    },
  };
  base.repository.workspace_identity = computeCoreMutationWorkspaceIdentity({
    workspaceSessionId: input.workspaceSessionId,
    binding: { ...base, binding_hash: `sha256:${"0".repeat(64)}` },
  });
  return { ...base, binding_hash: computeRepositoryMutationBindingHash(base) };
}

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
  const store = new CoreMutationSessionStore(stateDir);
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
