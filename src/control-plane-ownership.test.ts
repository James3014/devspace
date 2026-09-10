import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";
import { ControlPlaneOwnershipError, ControlPlaneOwnershipStore, initializeControlPlaneOwnershipDatabase, type GrantEvidenceReference } from "./control-plane-ownership.js";
import { getCompletionMatrixRow, upsertCompletionMatrixRow } from "./current-completion-matrix.js";

const grant: GrantEvidenceReference = { repository: "owner/repo", goal: "goal", coordinatorThread: "coord", evidenceHash: "hash" };
const context = (thread: string) => ({ thread });
const options = { resolveOwnerContext: (value: unknown) => { const thread = (value as { thread?: unknown })?.thread; return typeof thread === "string" ? { ownerThread: thread } : undefined; }, verifyGrantEvidence: (value: GrantEvidenceReference) => value.repository === "owner/repo" && value.goal === "goal" && value.coordinatorThread === "coord" && value.evidenceHash === "hash" };
function input(scope = ["/repo/src/a"]): Parameters<ControlPlaneOwnershipStore["acquire"]>[1] { return { repositoryKey: "owner/repo", resourceKind: "checkout", resourceId: "main", resource: "checkout", operation: "write", scope, baseRevision: "sha-a", expiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: `key-${scope.join("-")}`, grant }; }
function db() { const sqlite = new Database(":memory:"); initializeControlPlaneOwnershipDatabase(sqlite); sqlite.prepare("insert into control_plane_grant_evidence(repository,goal,coordinator_thread,evidence_hash,version,updated_at) values(?,?,?,?,?,?)").run(grant.repository, grant.goal, grant.coordinatorThread, grant.evidenceHash, 1, new Date().toISOString()); return sqlite; }

test("acquire/assert/release requires verified grant and trusted owner context", () => { const sqlite = db(); const store = new ControlPlaneOwnershipStore(sqlite, options); try { const lease = store.acquire(context("owner"), input()); assert.equal(store.assertHeld(context("owner"), lease.leaseId, 1, "write", "sha-a").ownerThread, "owner"); assert.throws(() => store.acquire({ thread: "attacker" }, { ...input(), grant: { ...grant, evidenceHash: "forged" } }), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "AUTHORITY_REQUIRED"); assert.throws(() => store.assertHeld({}, lease.leaseId, 1, "write", "sha-a"), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "AUTHORITY_REQUIRED"); const released = store.release(context("owner"), lease.leaseId, 1); assert.equal(released.terminalState, "released"); assert.throws(() => store.assertHeld(context("owner"), lease.leaseId, 2, "write", "sha-a"), ControlPlaneOwnershipError); } finally { sqlite.close(); } });

test("ancestor and descendant scopes conflict; expired unresolved lease cannot be stolen", () => { const sqlite = db(); const store = new ControlPlaneOwnershipStore(sqlite, options); try { const lease = store.acquire(context("one"), input(["/repo"])); assert.throws(() => store.acquire(context("two"), { ...input(["/repo/src"]), idempotencyKey: "descendant" }), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "OWNERSHIP_CONFLICT"); const expired = { ...lease, expiresAt: new Date(Date.now() - 1).toISOString() }; sqlite.prepare("update control_plane_resource_leases set expires_at=? where lease_id=?").run(expired.expiresAt, lease.leaseId); assert.throws(() => store.acquire(context("three"), { ...input(["/repo"]), idempotencyKey: "expired-steal" }), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "OWNERSHIP_CONFLICT"); } finally { sqlite.close(); } });

test("handoff is atomic and stale owner/version cannot mutate", () => { const sqlite = db(); const store = new ControlPlaneOwnershipStore(sqlite, options); try { const lease = store.acquire(context("from"), input()); const receipt = store.handoff(context("from"), lease.leaseId, 1, context("to"), { resource: "checkout", candidateRevision: "sha-b", baseRevision: lease.baseRevision, scope: lease.scope, grantDependency: lease.grant, grantVersion: lease.grantVersion, recipientGrant: lease.grant, recipientGrantVersion: lease.grantVersion, checkpoint: "checkpoint-ref", liveOperation: lease.operation, liveHandle: "", forbiddenOverlap: ["/repo"], tests: ["race"], evidence: ["evidence"], remainingGap: "none", nextGate: "review", expiresAt: lease.expiresAt }); assert.equal(receipt.newVersion, 2); assert.throws(() => store.assertHeld(context("from"), lease.leaseId, 1, "write", "sha-a"), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "CAS_CONFLICT"); assert.equal(store.assertHeld(context("to"), lease.leaseId, 2, "write", "sha-a").ownerThread, "to"); } finally { sqlite.close(); } });

test("operation pin closes the release/handoff TOCTOU window", () => { const sqlite = db(); const store = new ControlPlaneOwnershipStore(sqlite, options); try { const lease = store.acquire(context("from"), input()); const pinned = store.beginOperation(context("from"), lease.leaseId, 1, "run-1"); assert.equal(pinned.operationHandle, "run-1"); assert.throws(() => store.release(context("from"), lease.leaseId, 2), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "OWNERSHIP_CONFLICT"); assert.throws(() => store.handoff(context("from"), lease.leaseId, 2, context("to"), { resource: "checkout", candidateRevision: "sha-b", baseRevision: lease.baseRevision, scope: lease.scope, grantDependency: lease.grant, grantVersion: lease.grantVersion, recipientGrant: lease.grant, recipientGrantVersion: lease.grantVersion, checkpoint: "checkpoint-ref", liveOperation: lease.operation, liveHandle: "wrong", forbiddenOverlap: ["/repo"], tests: [], evidence: ["checkpoint-proof"], remainingGap: "none", nextGate: "review", expiresAt: lease.expiresAt }), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "CAS_CONFLICT"); const receipt = store.handoff(context("from"), lease.leaseId, 2, context("to"), { resource: "checkout", candidateRevision: "sha-b", baseRevision: lease.baseRevision, scope: lease.scope, grantDependency: lease.grant, grantVersion: lease.grantVersion, recipientGrant: lease.grant, recipientGrantVersion: lease.grantVersion, checkpoint: "checkpoint-ref", liveOperation: lease.operation, liveHandle: "run-1", forbiddenOverlap: ["/repo"], tests: [], evidence: ["checkpoint-proof"], remainingGap: "none", nextGate: "review", expiresAt: lease.expiresAt }); assert.equal(receipt.liveHandle, "run-1"); const finished = store.finishOperation(context("to"), lease.leaseId, 3, "run-1"); assert.equal(finished.operationState, "finished"); } finally { sqlite.close(); } });

test("repository aliases canonicalize before overlap checks", () => { const sqlite = db(); const store = new ControlPlaneOwnershipStore(sqlite, options); try { store.acquire(context("one"), input(["/repo/src"])); assert.throws(() => store.acquire(context("two"), { ...input(["/repo/src/child"]), repositoryKey: "OWNER/REPO", idempotencyKey: "canonical-alias" }), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "OWNERSHIP_CONFLICT"); assert.throws(() => store.acquire(context("two"), { ...input(["repo/src"]), idempotencyKey: "relative" }), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "INVALID_INPUT"); } finally { sqlite.close(); } });

test("root and trailing-slash scopes cannot bypass overlap", () => { const sqlite = db(); const store = new ControlPlaneOwnershipStore(sqlite, options); try { store.acquire(context("one"), input(["/"])); assert.throws(() => store.acquire(context("two"), { ...input(["/repo"]), idempotencyKey: "root-child" }), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "OWNERSHIP_CONFLICT"); } finally { sqlite.close(); } });

test("grant evidence index uses composite key and file restart CAS", () => { const root = mkdtempSync(join(tmpdir(), "devspace-grant-index-")); const path = join(root, "grant.sqlite"); const indexOptions = { ...options, verifyGrantEvidence: () => true }; const ref = { ...grant, evidenceHash: "first" }; const sqlite = new Database(path); const store = new ControlPlaneOwnershipStore(sqlite, indexOptions); try { assert.equal(store.putGrantEvidence(context("owner"), ref, 0).version, 1); assert.throws(() => store.putGrantEvidence(context("owner"), { ...ref, evidenceHash: "stale" }, 0), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "CAS_CONFLICT"); sqlite.close(); const reopened = new Database(path); const store2 = new ControlPlaneOwnershipStore(reopened, indexOptions); assert.equal(store2.getGrantEvidence(ref.repository, ref.goal, ref.coordinatorThread)?.version, 1); reopened.close(); } finally { rmSync(root, { recursive: true, force: true }); } });

test("grant evidence index rejects missing authoritative verifier", () => { const sqlite = db(); const store = new ControlPlaneOwnershipStore(sqlite, { resolveOwnerContext: options.resolveOwnerContext }); try { assert.throws(() => store.putGrantEvidence({}, grant, 0), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "AUTHORITY_REQUIRED"); } finally { sqlite.close(); } });

test("lease grant binding fails closed for missing, changed, and ABA index rows", () => { const sqlite = new Database(":memory:"); initializeControlPlaneOwnershipDatabase(sqlite); const indexOptions = { ...options, verifyGrantEvidence: () => true }; const store = new ControlPlaneOwnershipStore(sqlite, indexOptions); try { assert.throws(() => store.acquire(context("owner"), input()), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "CAS_CONFLICT"); store.putGrantEvidence(context("owner"), grant, 0); const lease = store.acquire(context("owner"), input()); store.putGrantEvidence(context("owner"), { ...grant, evidenceHash: "h2" }, 1); assert.throws(() => store.assertHeld(context("owner"), lease.leaseId, 1, "write", "sha-a"), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "CAS_CONFLICT"); store.putGrantEvidence(context("owner"), { ...grant, evidenceHash: "hash" }, 2); assert.throws(() => store.assertHeld(context("owner"), lease.leaseId, 1, "write", "sha-a"), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "CAS_CONFLICT"); } finally { sqlite.close(); } });

test("grant index composite keys coexist and trusted resolver rejects spoofed context", () => { const sqlite = new Database(":memory:"); initializeControlPlaneOwnershipDatabase(sqlite); const trusted = { thread: "owner" }; const indexOptions = { resolveOwnerContext: (value: unknown) => value === trusted ? { ownerThread: "owner" } : undefined, verifyGrantEvidence: () => true }; const store = new ControlPlaneOwnershipStore(sqlite, indexOptions); const other = { ...grant, goal: "other-goal", evidenceHash: "other" }; try { store.putGrantEvidence(trusted, grant, 0); store.putGrantEvidence(trusted, other, 0); assert.equal(store.getGrantEvidence(grant.repository, grant.goal, grant.coordinatorThread)?.version, 1); assert.equal(store.getGrantEvidence(other.repository, other.goal, other.coordinatorThread)?.evidenceHash, "other"); assert.throws(() => store.acquire({ thread: "owner" }, input()), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "AUTHORITY_REQUIRED"); } finally { sqlite.close(); } });

test("old lease schema receives an unbound sentinel and fails after file reopen", () => { const root = mkdtempSync(join(tmpdir(), "devspace-old-lease-schema-")); const path = join(root, "state.sqlite"); const oldSchema = new Database(path); oldSchema.exec("create table control_plane_resource_leases (lease_id text primary key, repository_key text not null, resource_kind text not null, resource_id text not null, resource text not null, operation text not null, scope_json text not null, base_revision text not null, idempotency_key text not null, owner_thread text not null, grant_json text not null, version integer not null, terminal_state text, expires_at text not null, created_at text not null, updated_at text not null, active_operation_handle text, operation_state text, unique(repository_key, resource_kind, resource_id, idempotency_key))"); new ControlPlaneOwnershipStore(oldSchema, { ...options, verifyGrantEvidence: () => true }); oldSchema.prepare("insert into control_plane_grant_evidence(repository,goal,coordinator_thread,evidence_hash,version,updated_at) values(?,?,?,?,?,?)").run(grant.repository, grant.goal, grant.coordinatorThread, grant.evidenceHash, 1, new Date().toISOString()); oldSchema.prepare("insert into control_plane_resource_leases(lease_id,repository_key,resource_kind,resource_id,resource,operation,scope_json,base_revision,idempotency_key,owner_thread,grant_json,version,terminal_state,expires_at,created_at,updated_at,active_operation_handle,operation_state) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("old", "owner/repo", "checkout", "main", "checkout", "write", JSON.stringify(["/repo/src/a"]), "sha-a", "old-key", "owner", JSON.stringify(grant), 1, null, new Date(Date.now() + 60000).toISOString(), new Date().toISOString(), new Date().toISOString(), null, null); oldSchema.close(); const reopened = new Database(path); const reopenedStore = new ControlPlaneOwnershipStore(reopened, { ...options, verifyGrantEvidence: () => true }); try { assert.throws(() => reopenedStore.get("old"), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "MALFORMED"); } finally { reopened.close(); rmSync(root, { recursive: true, force: true }); } });

test("trailing slash cannot bypass descendant overlap", () => { const sqlite = db(); const store = new ControlPlaneOwnershipStore(sqlite, options); try { store.acquire(context("one"), input(["/repo/"])); assert.throws(() => store.acquire(context("two"), { ...input(["/repo/src"]), idempotencyKey: "slash-child" }), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "OWNERSHIP_CONFLICT"); } finally { sqlite.close(); } });

test("completion matrix uses opaque revision plus expected version CAS", () => { const sqlite = db(); initializeControlPlaneOwnershipDatabase(sqlite); try { const first = upsertCompletionMatrixRow(sqlite, { goal: "goal", layer: "Implementation", source: "receipt", revision: "0000dead", status: "已實作", freshness: "fresh", gap: "" }, 0); assert.equal(first.version, 1); const second = upsertCompletionMatrixRow(sqlite, { goal: "goal", layer: "Implementation", source: "receipt", revision: "00000001", status: "PASS", freshness: "fresh", gap: "" }, 1, "0000dead"); assert.equal(second.version, 2); assert.throws(() => upsertCompletionMatrixRow(sqlite, { ...second, status: "FAIL" }, 1, "00000001"), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "CAS_CONFLICT"); assert.equal(getCompletionMatrixRow(sqlite, "goal", "Implementation")?.revision, "00000001"); } finally { sqlite.close(); } });

test("two independent processes race for one overlapping lease", async () => { const root = mkdtempSync(join(tmpdir(), "devspace-control-plane-race-")); const databasePath = join(root, "state.sqlite"); const script = `import Database from "better-sqlite3"; import { ControlPlaneOwnershipStore } from "./src/control-plane-ownership.ts"; const db = new Database(process.argv[1]); const o={resolveOwnerContext:(v)=>({ownerThread:String(v)}),verifyGrantEvidence:()=>true}; const s=new ControlPlaneOwnershipStore(db,o); try { s.putGrantEvidence(process.argv[2],{repository:"owner/repo",goal:"g",coordinatorThread:"c",evidenceHash:"h"},0); const l=s.acquire(process.argv[2],{repositoryKey:"owner/repo",resourceKind:"checkout",resourceId:"main",resource:"checkout",operation:"write",scope:["/repo/src"],baseRevision:"sha",expiresAt:new Date(Date.now()+60000).toISOString(),idempotencyKey:process.argv[2],grant:{repository:"owner/repo",goal:"g",coordinatorThread:"c",evidenceHash:"h"}}); console.log("won:"+l.ownerThread); } catch(e) { console.log("lost:"+(e.code||"error")); } finally { db.close(); }`;
  const run = (owner: string) => new Promise<string>((resolve) => { const child = spawn(process.execPath, ["--import", "tsx", "-e", script, databasePath, owner], { cwd: process.cwd() }); let out = ""; child.stdout.on("data", (chunk) => { out += chunk; }); child.on("close", () => resolve(out.trim())); });
  try { const results = await Promise.all([run("one"), run("two")]); assert.equal(results.filter((value) => value.startsWith("won:")).length, 1); assert.equal(results.filter((value) => value.startsWith("lost:")).length, 1); } finally { rmSync(root, { recursive: true, force: true }); } });

test("C1 renew preserves identity and pin while fencing stale, expired and revoked authority", () => {
  const sqlite = db(); let now = Date.now(); let allowed = true;
  const store = new ControlPlaneOwnershipStore(sqlite, {...options, now: () => now, verifyGrantEvidence: () => allowed});
  try {
    const lease = store.acquire(context("owner"), input());
    const pinned = store.beginOperation(context("owner"), lease.leaseId, 1, "effect-1");
    const renewed = store.renew(context("owner"), lease.leaseId, 2, new Date(now + 120_000).toISOString());
    assert.equal(renewed.version, 3);
    for (const key of ["ownerThread", "resource", "baseRevision", "operationHandle", "grantVersion"] as const) assert.deepEqual(renewed[key], pinned[key]);
    assert.deepEqual(renewed.scope, pinned.scope);
    assert.throws(() => store.renew(context("other"), lease.leaseId, 3, new Date(now + 180_000).toISOString()));
    assert.throws(() => store.renew(context("owner"), lease.leaseId, 2, new Date(now + 180_000).toISOString()));
    assert.throws(() => store.renew(context("owner"), lease.leaseId, 3, renewed.expiresAt));
    assert.throws(() => store.renew(context("owner"), lease.leaseId, 3, new Date(now + 25 * 3600_000).toISOString()));
    allowed = false;
    assert.throws(() => store.renew(context("owner"), lease.leaseId, 3, new Date(now + 180_000).toISOString()));
    allowed = true; now += 121_000;
    assert.throws(() => store.renew(context("owner"), lease.leaseId, 3, new Date(now + 180_000).toISOString()));
    assert.equal(store.get(lease.leaseId)?.operationHandle, "effect-1");
  } finally { sqlite.close(); }
});

test("C1 reconcile requires exact trusted terminal proof, retains unknown pin and atomically replays after reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-reconcile-")); const path = join(root, "state.sqlite");
  let sqlite = new Database(path); let now = Date.now(); let allowed = true; let verified: unknown = true;
  const opts = {...options, now: () => now, verifyGrantEvidence: () => allowed,
    verifyReconciliationEvidence: () => verified as boolean};
  let store = new ControlPlaneOwnershipStore(sqlite, opts);
  try {
    store.putGrantEvidence(context("owner"), grant, 0);
    const lease = store.acquire(context("owner"), input());
    store.beginOperation(context("owner"), lease.leaseId, 1, "effect-1");
    const evidence = {leaseId: lease.leaseId, ownerThread: "owner", operationHandle: "effect-1", operation: "write", baseRevision: "sha-a", leaseVersion: 2, state: "finished" as const};
    for (const state of ["unknown", "running", "not_running"] as const) assert.throws(() => store.reconcile(context("owner"), lease.leaseId, 2, {...evidence, state}));
    for (const wrong of [{ownerThread: "other"}, {operationHandle: "wrong"}, {operation: "wrong"}, {baseRevision: "wrong"}, {leaseVersion: 1}]) assert.throws(() => store.reconcile(context("owner"), lease.leaseId, 2, {...evidence, ...wrong}));
    for (const value of [false, undefined, "true", Promise.resolve(true)]) { verified = value; assert.throws(() => store.reconcile(context("owner"), lease.leaseId, 2, evidence)); }
    verified = true;
    sqlite.exec("create trigger deny_receipt before insert on control_plane_reconciliation_receipts begin select raise(ABORT, 'injected receipt failure'); end");
    assert.throws(() => store.reconcile(context("owner"), lease.leaseId, 2, evidence), /injected receipt failure/);
    assert.equal(store.get(lease.leaseId)?.version, 2); assert.equal(store.get(lease.leaseId)?.operationHandle, "effect-1");
    sqlite.exec("drop trigger deny_receipt");
    now += 61_000;
    assert.throws(() => store.reconcile(context("owner"), lease.leaseId, 2, {...evidence, state: "unknown"}));
    assert.throws(() => store.acquire(context("other"), {...input(), expiresAt: new Date(now + 60_000).toISOString(), idempotencyKey: "steal"}));
    const receipt = store.reconcile(context("owner"), lease.leaseId, 2, evidence);
    assert.equal(receipt.newVersion, 3); assert.equal(store.get(lease.leaseId)?.terminalState, "expired_reconciled");
    assert.equal(store.get(lease.leaseId)?.operationHandle, undefined);
    sqlite.close(); sqlite = new Database(path); store = new ControlPlaneOwnershipStore(sqlite, opts);
    assert.deepEqual(store.reconcile(context("owner"), lease.leaseId, 2, evidence), receipt);
    assert.throws(() => store.reconcile(context("owner"), lease.leaseId, 2, {...evidence, detail: "changed"}));
    allowed = false; assert.throws(() => store.reconcile(context("owner"), lease.leaseId, 2, evidence));
    assert.equal((sqlite.prepare("select count(*) n from control_plane_reconciliation_receipts").get() as {n:number}).n, 1);
  } finally { sqlite.close(); rmSync(root, {recursive:true, force:true}); }
});

test("C1 successful reconciliation retains unexpired ownership and replay never clears a newer pin", () => {
  const sqlite = db();
  const store = new ControlPlaneOwnershipStore(sqlite, {...options, verifyReconciliationEvidence: (e, l, o) => {
    assert.ok(Object.isFrozen(e) && Object.isFrozen(l) && Object.isFrozen(l.grant) && Object.isFrozen(o)); return true;
  }});
  try {
    const lease = store.acquire(context("owner"), input()); store.beginOperation(context("owner"), lease.leaseId, 1, "old");
    const evidence = {leaseId:lease.leaseId, ownerThread:"owner", operationHandle:"old", operation:"write", baseRevision:"sha-a", leaseVersion:2, state:"failed" as const};
    const receipt = store.reconcile(context("owner"), lease.leaseId, 2, evidence);
    assert.equal(store.get(lease.leaseId)?.terminalState, undefined);
    store.beginOperation(context("owner"), lease.leaseId, 3, "new");
    assert.deepEqual(store.reconcile(context("owner"), lease.leaseId, 2, evidence), receipt);
    assert.equal(store.get(lease.leaseId)?.operationHandle, "new"); assert.equal(store.get(lease.leaseId)?.version, 4);
    store.putGrantEvidence(context("owner"), {...grant, evidenceHash:"hash"}, 1);
    assert.throws(() => store.reconcile(context("owner"), lease.leaseId, 2, evidence), ControlPlaneOwnershipError);
  } finally { sqlite.close(); }
});

test("C1 callback mutation, throw and missing verifier roll back; grant ABA and legacy unbound deny", () => {
  for (const scenario of ["reenter", "throw", "missing", "aba", "legacy"] as const) {
    const sqlite = db();
    const store = new ControlPlaneOwnershipStore(sqlite, {...options, verifyGrantEvidence: () => true,
      ...(scenario === "missing" ? {} : {verifyReconciliationEvidence: () => {
        if (scenario === "throw") throw Error("verifier failed");
        if (scenario === "reenter") sqlite.prepare("update control_plane_resource_leases set version=version+1").run();
        return true;
      }})});
    try {
      const lease = store.acquire(context("owner"), input()); store.beginOperation(context("owner"), lease.leaseId, 1, "op");
      if (scenario === "aba") {store.putGrantEvidence(context("owner"), {...grant,evidenceHash:"h2"},1);store.putGrantEvidence(context("owner"), grant,2);}
      if (scenario === "legacy") sqlite.prepare("update control_plane_resource_leases set grant_version=0").run();
      const evidence = {leaseId:lease.leaseId, ownerThread:"owner", operationHandle:"op", operation:"write", baseRevision:"sha-a", leaseVersion:2, state:"finished" as const};
      assert.throws(() => store.reconcile(context("owner"), lease.leaseId, 2, evidence));
      const row = sqlite.prepare("select version,active_operation_handle from control_plane_resource_leases").get();
      assert.deepEqual(row, {version:2, active_operation_handle:"op"});
      assert.equal((sqlite.prepare("select count(*) n from control_plane_reconciliation_receipts").get() as {n:number}).n, 0);
      if (scenario === "aba" || scenario === "legacy") assert.throws(() => store.renew(context("owner"),lease.leaseId,2,new Date(Date.now()+120000).toISOString()));
    } finally { sqlite.close(); }
  }
});

test("C1/C2 two processes race at renewal/reconciliation/handoff CAS after grant is seeded", async () => {
  for (const action of ["renew", "reconcile", "handoff"] as const) {
    const root = mkdtempSync(join(tmpdir(), "devspace-c1-race-")); const path=join(root,"state.sqlite");
    const sqlite = new Database(path); const store = new ControlPlaneOwnershipStore(sqlite, options);
    store.putGrantEvidence(context("owner"), grant, 0);
    const lease=store.acquire(context("owner"),input()); store.beginOperation(context("owner"),lease.leaseId,1,"op"); sqlite.close();
    const script = `import Database from 'better-sqlite3'; import {ControlPlaneOwnershipStore} from './src/control-plane-ownership.ts';
      const db=new Database(process.argv[1]);db.pragma('busy_timeout=5000');
      const s=new ControlPlaneOwnershipStore(db,{resolveOwnerContext:()=>({ownerThread:'owner'}),verifyGrantEvidence:()=>true,verifyReconciliationEvidence:()=>true});
      process.stdout.write('ready\\n'); process.stdin.once('data',()=>{try {
        if(process.argv[3]==='renew') s.renew({},process.argv[2],2,new Date(Date.now()+120000+Number(process.argv[4])*1000).toISOString());
        else if(process.argv[3]==='handoff') { const lease=s.get(process.argv[2]); const target=process.argv[4]; const handoffStore=new ControlPlaneOwnershipStore(db,{resolveOwnerContext:(v)=>({ownerThread:String(v)}),verifyGrantEvidence:()=>true}); handoffStore.handoff('owner',lease.leaseId,2,target,{resource:lease.resource,baseRevision:lease.baseRevision,scope:lease.scope,candidateRevision:'candidate',liveOperation:lease.operation,liveHandle:'op',checkpoint:'checkpoint',grantDependency:lease.grant,grantVersion:lease.grantVersion,recipientGrant:lease.grant,recipientGrantVersion:lease.grantVersion,forbiddenOverlap:lease.scope,tests:[],evidence:['proof'],remainingGap:'unknown',nextGate:'reconcile',expiresAt:lease.expiresAt}); }
        else s.reconcile({},process.argv[2],2,{leaseId:process.argv[2],ownerThread:'owner',operationHandle:'op',operation:'write',baseRevision:'sha-a',leaseVersion:2,state:'finished',detail:process.argv[4]});
        console.log('won');
      }catch(e){console.log('lost:'+e.code)}finally{db.close()}});`;
    const children = ["1","2"].map(n => {
      const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",script,path,lease.leaseId,action,n],{cwd:process.cwd()});
      let output=""; let error="";
      const ready=new Promise<void>((resolve,reject)=>{child.on('error',reject);child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('ready'))resolve()});});
      const done=new Promise<string>((resolve,reject)=>{child.stderr.on('data',chunk=>error+=chunk);child.on('close',code=>code===0?resolve(output):reject(Error(error)));});
      return {child,ready,done};
    });
    try {
      await Promise.all(children.map(c=>c.ready)); children.forEach(c=>c.child.stdin.end('go'));
      const results=await Promise.all(children.map(c=>c.done));
      assert.equal(results.filter(r=>r.includes('\nwon')).length,1); assert.equal(results.filter(r=>r.includes('lost:CAS_CONFLICT')).length,1);
      const reopened=new Database(path);try {
        assert.equal((reopened.prepare('select version from control_plane_resource_leases').get() as {version:number}).version,3);
        assert.equal((reopened.prepare('select count(*) n from control_plane_reconciliation_receipts').get() as {n:number}).n,action==='reconcile'?1:0);
        if(action==='handoff') {
          assert.equal((reopened.prepare('select count(*) n from control_plane_handoff_receipts').get() as {n:number}).n,1);
          const state=new ControlPlaneOwnershipStore(reopened,options).get(lease.leaseId)!;assert.ok(['1','2'].includes(state.ownerThread));assert.equal(state.operationHandle,'op');
        }
      } finally {reopened.close();}
    } finally {children.forEach(c=>c.child.kill());rmSync(root,{recursive:true,force:true});}
  }
});

test("C1 corrupted receipt after reopen denies replay and preserves durable evidence", () => {
  for (const patch of ["new_version=-1", "receipt_id=''", "created_at='invalid'", "evidence_json='{}'"]) {
    const root=mkdtempSync(join(tmpdir(),"devspace-corrupt-receipt-")); const path=join(root,"state.sqlite");
    let sqlite=new Database(path); const opts={...options,verifyReconciliationEvidence:()=>true}; let store=new ControlPlaneOwnershipStore(sqlite,opts);
    try {
      store.putGrantEvidence(context("owner"),grant,0);const lease=store.acquire(context("owner"),input());store.beginOperation(context("owner"),lease.leaseId,1,"op");
      const evidence={leaseId:lease.leaseId,ownerThread:"owner",operationHandle:"op",operation:"write",baseRevision:"sha-a",leaseVersion:2,state:"finished" as const};
      store.reconcile(context("owner"),lease.leaseId,2,evidence);sqlite.exec(`update control_plane_reconciliation_receipts set ${patch}`);
      const before=sqlite.prepare("select * from control_plane_reconciliation_receipts").all();sqlite.close();sqlite=new Database(path);store=new ControlPlaneOwnershipStore(sqlite,opts);
      assert.throws(()=>store.reconcile(context("owner"),lease.leaseId,2,evidence),(error:unknown)=>error instanceof ControlPlaneOwnershipError && error.code==='MALFORMED');
      assert.deepEqual(sqlite.prepare("select * from control_plane_reconciliation_receipts").all(),before);
    } finally {sqlite.close();rmSync(root,{recursive:true,force:true});}
  }
});
