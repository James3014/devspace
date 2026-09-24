import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  acceptanceContractHash,
  capabilityDiscoveryReceiptHash,
  computeCoreMutationWorkspaceIdentity,
  computeRepositoryMutationBindingHash,
  CoreMutationSessionError,
  CoreMutationSessionStore,
  NEXUS_CORE_PROTOCOL_VERSION,
  type CoreAcceptanceContractWire,
  type RepositoryMutationBinding,
} from "./core-mutation-session.js";
import { migrateDatabase } from "./db/migrations.js";
import { createWorkspaceStore } from "./workspace-store.js";
import {
  CAPABILITY_DISCOVERY_INDEX_PATH,
  CAPABILITY_DISCOVERY_RECEIPT_SCHEMA,
  NEXUS_CAPABILITY_REPOSITORY,
  type CapabilityDiscoveryReceipt,
} from "./capability-discovery.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "devspace-core-rebind-"));
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
function makeBinding(input: { workspaceSessionId: string; head: string; tree: string }): RepositoryMutationBinding {
  const receipt: CapabilityDiscoveryReceipt = {
    schema: CAPABILITY_DISCOVERY_RECEIPT_SCHEMA,
    repository: NEXUS_CAPABILITY_REPOSITORY,
    indexRevision: "1".repeat(40),
    indexPath: CAPABILITY_DISCOVERY_INDEX_PATH,
    indexSha256: "2".repeat(64),
    intent: "Reuse existing Core continuity.",
    disposition: "REUSE_EXISTING",
    matchedCapabilityIds: ["nexus-core"],
    evidence: {
      architecture: ["nexus-core owns completion truth"],
      source: ["devspace#240"],
      history: ["wave1-wave2"],
      runtime: ["devspace"],
    },
  };
  const contract: CoreAcceptanceContractWire = {
    contract_id: "devspace-core-rebind-test",
    requirements_hash: `sha256:${"3".repeat(64)}`,
    required_verifier_ids: ["focused-tests"],
    allowed_paths: ["app.ts"],
    deletion_policy: "FORBID",
  };
  const base: Omit<RepositoryMutationBinding, "binding_hash"> = {
    schema: "nexus.repository_mutation_binding.v1",
    binding_id: "binding-rebind-1",
    operation_id: "operation-rebind-1",
    attempt_id: "attempt-rebind-1",
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
      authority_ref: "James3014/devspace#240",
      authority_hash: `sha256:${"4".repeat(64)}`,
    },
    capability_discovery: {
      required: true,
      receipt_hash: capabilityDiscoveryReceiptHash(receipt),
      index_revision: `git-commit:${"1".repeat(40)}`,
    },
    core: {
      protocol_version: NEXUS_CORE_PROTOCOL_VERSION,
      acceptance_contract: contract,
      acceptance_contract_hash: acceptanceContractHash(contract),
    },
    freshness: {
      created_at: "2026-09-24T00:00:00.000Z",
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
async function fixture(workspaceId: string) {
  const f = makeRepo();
  const stateDir = join(f.root, "state");
  createWorkspaceStore(stateDir).createSession({ id: workspaceId, root: f.repo, mode: "checkout" });
  const store = new CoreMutationSessionStore(stateDir);
  const binding = makeBinding({ workspaceSessionId: workspaceId, head: f.head, tree: f.tree });
  const session = await store.open({
    workspaceSessionId: workspaceId,
    workspaceRoot: f.repo,
    workspaceMode: "checkout",
    managed: false,
    actorKey: "openai:" + "a".repeat(64),
    binding,
  });
  return { f, stateDir, store, binding, session };
}
function cleanup(ws: { f: { root: string }; store: CoreMutationSessionStore }) {
  ws.store.close();
  rmSync(ws.f.root, { recursive: true, force: true });
}
const OLD = "openai:" + "a".repeat(64);
const NEW = "mcp:" + "b".repeat(64);

test("rebind preserves session/binding identity and exact replay is idempotent", async () => {
  const ws = await fixture("ws_rebind_success");
  try {
    const first = await ws.store.rebindActor({
      sessionId: ws.session.id, workspaceSessionId: "ws_rebind_success", workspaceRoot: ws.f.repo,
      expectedActorKey: OLD, newActorKey: NEW, evidence: "receipt-1",
      pointer: { sessionId: ws.session.id, bindingHash: ws.session.bindingHash },
    });
    const replay = await ws.store.rebindActor({
      sessionId: ws.session.id, workspaceSessionId: "ws_rebind_success", workspaceRoot: ws.f.repo,
      expectedActorKey: OLD, newActorKey: NEW, evidence: "receipt-1",
      pointer: { sessionId: ws.session.id, bindingHash: ws.session.bindingHash },
    });
    assert.equal(replay.rebindId, first.rebindId);
    assert.equal(ws.store.getById(ws.session.id)?.actorKey, NEW);
    assert.equal(ws.store.getById(ws.session.id)?.bindingHash, ws.session.bindingHash);
    assert.equal(ws.store.rebindsFor(ws.session.id).length, 1);
  } finally { cleanup(ws); }
});

test("rebind rejects replay with different evidence", async () => {
  const ws = await fixture("ws_rebind_conflict");
  try {
    await ws.store.rebindActor({
      sessionId: ws.session.id, workspaceSessionId: "ws_rebind_conflict", workspaceRoot: ws.f.repo,
      expectedActorKey: OLD, newActorKey: NEW, evidence: "receipt-1",
      pointer: { sessionId: ws.session.id, bindingHash: ws.session.bindingHash },
    });
    await assert.rejects(() => ws.store.rebindActor({
      sessionId: ws.session.id, workspaceSessionId: "ws_rebind_conflict", workspaceRoot: ws.f.repo,
      expectedActorKey: OLD, newActorKey: NEW, evidence: "receipt-2",
      pointer: { sessionId: ws.session.id, bindingHash: ws.session.bindingHash },
    }), (e: unknown) => e instanceof CoreMutationSessionError && e.code === "CORE_MUTATION_REBIND_REPLAY_CONFLICT");
  } finally { cleanup(ws); }
});

test("rebind blocks unresolved writer effects", async () => {
  const ws = await fixture("ws_rebind_writer");
  try {
    await ws.store.admitEffect({
      workspaceSessionId: "ws_rebind_writer", workspaceRoot: ws.f.repo, workspaceMode: "checkout",
      managed: false, actorKey: OLD, paths: ["app.ts"], deletedPaths: [],
      pathContainment: "NOT_PROVEN", writerDomain: "PROCESS",
    });
    await assert.rejects(() => ws.store.rebindActor({
      sessionId: ws.session.id, workspaceSessionId: "ws_rebind_writer", workspaceRoot: ws.f.repo,
      expectedActorKey: OLD, newActorKey: NEW, evidence: "receipt-writer",
      pointer: { sessionId: ws.session.id, bindingHash: ws.session.bindingHash },
    }), (e: unknown) => e instanceof CoreMutationSessionError && e.code === "CORE_MUTATION_REBIND_RECONCILIATION_REQUIRED");
  } finally { cleanup(ws); }
});

test("rebind requires exact prior actor", async () => {
  const ws = await fixture("ws_rebind_actor");
  try {
    await assert.rejects(() => ws.store.rebindActor({
      sessionId: ws.session.id, workspaceSessionId: "ws_rebind_actor", workspaceRoot: ws.f.repo,
      expectedActorKey: "openai:" + "c".repeat(64), newActorKey: NEW, evidence: "receipt-actor",
      pointer: { sessionId: ws.session.id, bindingHash: ws.session.bindingHash },
    }), (e: unknown) => e instanceof CoreMutationSessionError && e.code === "CORE_MUTATION_ACTOR_MISMATCH");
  } finally { cleanup(ws); }
});

test("repeated actor pair after intervening handoff creates a new receipt", async () => {
  const ws = await fixture("ws_rebind_cycle");
  try {
    const first = await ws.store.rebindActor({
      sessionId: ws.session.id, workspaceSessionId: "ws_rebind_cycle", workspaceRoot: ws.f.repo,
      expectedActorKey: OLD, newActorKey: NEW, evidence: "cycle-1",
      pointer: { sessionId: ws.session.id, bindingHash: ws.session.bindingHash },
    });
    await ws.store.rebindActor({
      sessionId: ws.session.id, workspaceSessionId: "ws_rebind_cycle", workspaceRoot: ws.f.repo,
      expectedActorKey: NEW, newActorKey: OLD, evidence: "cycle-2",
      pointer: { sessionId: ws.session.id, bindingHash: ws.session.bindingHash },
    });
    const third = await ws.store.rebindActor({
      sessionId: ws.session.id, workspaceSessionId: "ws_rebind_cycle", workspaceRoot: ws.f.repo,
      expectedActorKey: OLD, newActorKey: NEW, evidence: "cycle-3",
      pointer: { sessionId: ws.session.id, bindingHash: ws.session.bindingHash },
    });
    assert.notEqual(third.rebindId, first.rebindId);
    assert.deepEqual(ws.store.rebindsFor(ws.session.id).map(x => x.evidence), ["cycle-1", "cycle-2", "cycle-3"]);
  } finally { cleanup(ws); }
});

test("terminal session rejects historical replay", async () => {
  const ws = await fixture("ws_rebind_terminal");
  try {
    await ws.store.rebindActor({
      sessionId: ws.session.id, workspaceSessionId: "ws_rebind_terminal", workspaceRoot: ws.f.repo,
      expectedActorKey: OLD, newActorKey: NEW, evidence: "terminal",
      pointer: { sessionId: ws.session.id, bindingHash: ws.session.bindingHash },
    });
    await ws.store.closeSession({
      sessionId: ws.session.id, workspaceSessionId: "ws_rebind_terminal", workspaceRoot: ws.f.repo,
      actorKey: NEW, mode: "ABANDON",
    });
    await assert.rejects(() => ws.store.rebindActor({
      sessionId: ws.session.id, workspaceSessionId: "ws_rebind_terminal", workspaceRoot: ws.f.repo,
      expectedActorKey: OLD, newActorKey: NEW, evidence: "terminal",
      pointer: { sessionId: ws.session.id, bindingHash: ws.session.bindingHash },
    }), (e: unknown) => e instanceof CoreMutationSessionError && e.code === "CORE_MUTATION_REBIND_TERMINAL");
  } finally { cleanup(ws); }
});

test("rebind requires normalized evidence and a different actor", async () => {
  const ws = await fixture("ws_rebind_validation");
  try {
    await assert.rejects(() => ws.store.rebindActor({
      sessionId: ws.session.id, workspaceSessionId: "ws_rebind_validation", workspaceRoot: ws.f.repo,
      expectedActorKey: OLD, newActorKey: OLD, evidence: "receipt",
      pointer: { sessionId: ws.session.id, bindingHash: ws.session.bindingHash },
    }), (e: unknown) => e instanceof CoreMutationSessionError && e.code === "CORE_MUTATION_REBIND_ACTOR_INVALID");
    await assert.rejects(() => ws.store.rebindActor({
      sessionId: ws.session.id, workspaceSessionId: "ws_rebind_validation", workspaceRoot: ws.f.repo,
      expectedActorKey: OLD, newActorKey: NEW, evidence: "  ",
      pointer: { sessionId: ws.session.id, bindingHash: ws.session.bindingHash },
    }), (e: unknown) => e instanceof CoreMutationSessionError && e.code === "CORE_MUTATION_REBIND_EVIDENCE_REQUIRED");
  } finally { cleanup(ws); }
});

test("migration 21 upgrades an already-migrated v20 database", () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec(`
      create table devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
      create table core_mutation_sessions (id text primary key);
    `);
    const insert = sqlite.prepare("insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)");
    for (let version = 1; version <= 20; version += 1) insert.run(version, `historical-${version}`, "2026-09-24T00:00:00.000Z");
    migrateDatabase(sqlite);
    const table = sqlite.prepare("select name from sqlite_master where type='table' and name='core_mutation_session_rebinds'").get() as { name?: string } | undefined;
    const migration = sqlite.prepare("select name from devspace_schema_migrations where version=21").get() as { name?: string } | undefined;
    assert.equal(table?.name, "core_mutation_session_rebinds");
    assert.equal(migration?.name, "core-mutation-session-rebinds");
  } finally { sqlite.close(); }
});
