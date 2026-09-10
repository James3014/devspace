import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ControlPlaneHandoff } from "./control-plane-handoff.js";
import { ControlPlaneOwnershipStore } from "./control-plane-ownership.js";

test("handoff facade delegates the atomic ownership transfer contract", () => {
  const db = new Database(":memory:");
  const options = { resolveResourceIdentity: (input: Parameters<ControlPlaneOwnershipStore["acquire"]>[1]) => input, resolveOwnerContext: (value: unknown) => ({ ownerThread: String(value) }), verifyGrantEvidence: () => true };
  const store = new ControlPlaneOwnershipStore(db, options);
  db.prepare("insert into control_plane_grant_evidence(repository,goal,coordinator_thread,evidence_hash,version,updated_at) values(?,?,?,?,?,?)").run("owner/repo", "goal", "coord", "evidence", 1, new Date().toISOString());
  const lease = store.acquire("from", { repositoryKey: "owner/repo", resourceKind: "checkout", resourceId: "main", resource: "checkout", operation: "write", scope: ["/repo"], baseRevision: "sha", expiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: "handoff", grant: { repository: "owner/repo", goal: "goal", coordinatorThread: "coord", evidenceHash: "evidence" } });
  const receipt = new ControlPlaneHandoff(store).transfer("from", lease.leaseId, 1, "to", { resource: "checkout", candidateRevision: "sha2", baseRevision: lease.baseRevision, scope: lease.scope, grantDependency: lease.grant, grantVersion: lease.grantVersion, recipientGrant: lease.grant, recipientGrantVersion: lease.grantVersion, checkpoint: "checkpoint-ref", liveOperation: lease.operation, liveHandle: "", forbiddenOverlap: ["/repo"], tests: ["test"], evidence: ["evidence"], remainingGap: "none", nextGate: "gate", expiresAt: lease.expiresAt });
  assert.equal(receipt.fromOwnerThread, "from");
  assert.equal(receipt.toOwnerThread, "to");
  db.close();
});

test("handoff validates full binding and fences every former-owner mutation", () => {
  const db = new Database(":memory:"); let now=Date.now(); let allowRecipient=true;
  const opts={resolveResourceIdentity: (input: Parameters<ControlPlaneOwnershipStore["acquire"]>[1]) => input,resolveOwnerContext:(v:unknown)=>({ownerThread:String(v)}),verifyGrantEvidence:(_g:unknown,o:{ownerThread:string})=>o.ownerThread!=="to" || allowRecipient,now:()=>now,verifyReconciliationEvidence:()=>true};
  const store=new ControlPlaneOwnershipStore(db,opts);
  const grant={repository:"owner/repo",goal:"goal",coordinatorThread:"from",evidenceHash:"old"};
  const recipientGrant={...grant,coordinatorThread:"to",evidenceHash:"new"};
  store.putGrantEvidence("from",grant,0);store.putGrantEvidence("to",recipientGrant,0);
  const lease=store.acquire("from",{repositoryKey:"owner/repo",resourceKind:"checkout",resourceId:"main",resource:"checkout",operation:"write",scope:["/repo"],baseRevision:"base",expiresAt:new Date(now+60000).toISOString(),idempotencyKey:"handoff",grant});
  store.beginOperation("from",lease.leaseId,1,"pinned-effect");
  const packet={resource:lease.resource,baseRevision:lease.baseRevision,scope:lease.scope,candidateRevision:"candidate",liveOperation:lease.operation,liveHandle:"pinned-effect",checkpoint:"checkpoint:42",grantDependency:grant,grantVersion:1,recipientGrant,recipientGrantVersion:1,forbiddenOverlap:["/repo"],tests:["test-ref"],evidence:["evidence:42"],remainingGap:"effect outcome unknown",nextGate:"reconcile same effect",expiresAt:lease.expiresAt};
  try {
    for(const delta of [{resource:"wrong"},{baseRevision:"wrong"},{scope:["/other"]},{liveOperation:"wrong"},{liveHandle:"wrong"},{grantVersion:2},{recipientGrantVersion:2},{checkpoint:""},{evidence:[]}]) {
      assert.throws(()=>store.handoff("from",lease.leaseId,2,"to",{...packet,...delta}));assert.equal(store.get(lease.leaseId)?.ownerThread,"from");
    }
    allowRecipient=false;assert.throws(()=>store.handoff("from",lease.leaseId,2,"to",packet));allowRecipient=true;
    now+=60000;assert.throws(()=>store.handoff("from",lease.leaseId,2,"to",packet));now-=60000;
    db.exec("create trigger deny_handoff before insert on control_plane_handoff_receipts begin select raise(ABORT, 'receipt denied'); end");
    assert.throws(()=>store.handoff("from",lease.leaseId,2,"to",packet),/receipt denied/);assert.equal(store.get(lease.leaseId)?.version,2);
    db.exec("drop trigger deny_handoff");
    const receipt=store.handoff("from",lease.leaseId,2,"to",packet);
    assert.equal(receipt.checkpoint,"checkpoint:42");assert.deepEqual(receipt.scope,lease.scope);assert.equal(receipt.recipientGrant.evidenceHash,"new");
    const current=store.get(lease.leaseId)!;assert.equal(current.ownerThread,"to");assert.equal(current.operationHandle,"pinned-effect");assert.deepEqual(current.grant,recipientGrant);
    assert.throws(()=>store.handoff("from",lease.leaseId,2,"to",packet));
    assert.throws(()=>store.finishOperation("from",lease.leaseId,3,"pinned-effect"));
    assert.throws(()=>store.renew("from",lease.leaseId,3,new Date(now+120000).toISOString()));
    assert.throws(()=>store.release("from",lease.leaseId,3));
    assert.throws(()=>store.reconcile("from",lease.leaseId,3,{leaseId:lease.leaseId,ownerThread:"from",operationHandle:"pinned-effect",operation:"write",baseRevision:"base",leaseVersion:3,state:"finished"}));
    assert.equal(store.get(lease.leaseId)?.version,3);
    store.putGrantEvidence("from",{...grant,evidenceHash:"sender-revoked"},1);
    assert.deepEqual(new ControlPlaneHandoff(store).readback("to",lease.leaseId,2,3).receipt,receipt);
  } finally {db.close();}
});

test("handoff readback survives reopen and distinguishes history from current pin", async () => {
  const {mkdtempSync}=await import("node:fs");
  const {tmpdir}=await import("node:os");
  const {join}=await import("node:path");
  const path=join(mkdtempSync(join(tmpdir(),"devspace-handoff-readback-")),"state.sqlite");
  let now=Date.now();let permitted=true;
  const opts={resolveResourceIdentity:(i:Parameters<ControlPlaneOwnershipStore["acquire"]>[1])=>i,resolveOwnerContext:(c:unknown)=>({ownerThread:String(c)}),verifyGrantEvidence:()=>permitted,now:()=>now};
  let sqlite=new Database(path);let store=new ControlPlaneOwnershipStore(sqlite,opts);
  const grant={repository:"owner/repo",goal:"goal",coordinatorThread:"host",evidenceHash:"verified"};
  store.putGrantEvidence("from",grant,0);
  const lease=store.acquire("from",{repositoryKey:grant.repository,resourceKind:"checkout",resourceId:"main",resource:"checkout",operation:"write",scope:["/repo"],baseRevision:"base",expiresAt:new Date(now+60000).toISOString(),idempotencyKey:"readback",grant});
  const packet={resource:lease.resource,baseRevision:lease.baseRevision,scope:lease.scope,candidateRevision:"candidate",liveOperation:lease.operation,liveHandle:"",checkpoint:"checkpoint",grantDependency:grant,grantVersion:1,recipientGrant:grant,recipientGrantVersion:1,forbiddenOverlap:["/repo"],tests:["tests"],evidence:["evidence"],remainingGap:"continue",nextGate:"verify",expiresAt:lease.expiresAt};
  const receipt=store.handoff("from",lease.leaseId,1,"to",packet);
  sqlite.close();sqlite=new Database(path);store=new ControlPlaneOwnershipStore(sqlite,opts);
  try {
    const facade=new ControlPlaneHandoff(store);
    const snapshot=()=>JSON.stringify([sqlite.prepare("select * from control_plane_handoff_receipts").all(),sqlite.prepare("select * from control_plane_resource_leases").all()]);
    const before=snapshot();
    const recovered=facade.readback("to",lease.leaseId,1,2);
    assert.deepEqual(recovered.receipt,receipt);assert.equal(recovered.currentLease.ownerThread,"to");
    assert.ok(Object.isFrozen(recovered) && Object.isFrozen(recovered.receipt.scope) && Object.isFrozen(recovered.currentLease.grant));
    assert.equal(snapshot(),before);
    assert.throws(()=>facade.readback("from",lease.leaseId,1,2));
    assert.throws(()=>facade.readback("to",lease.leaseId,1,1));
    store.beginOperation("to",lease.leaseId,2,"new-operation");
    const later=facade.readback("to",lease.leaseId,1,3);
    assert.equal(later.receipt.liveHandle,"");assert.equal(later.currentLease.operationHandle,"new-operation");
    now+=60001;assert.deepEqual(facade.readback("to",lease.leaseId,1,3).receipt,receipt);
    assert.throws(()=>store.assertHeld("to",lease.leaseId,3,"write","base"));
    permitted=false;assert.throws(()=>facade.readback("to",lease.leaseId,1,3));permitted=true;
    const validJson=sqlite.prepare("select receipt_json from control_plane_handoff_receipts").pluck().get() as string;
    for(const bad of ["{",JSON.stringify({...receipt,scope:"bad"}),JSON.stringify({...receipt,newVersion:99}),JSON.stringify({...receipt,toOwnerThread:"forged"})]) {
      sqlite.prepare("update control_plane_handoff_receipts set receipt_json=?").run(bad);
      const corrupt=snapshot();assert.throws(()=>facade.readback("to",lease.leaseId,1,3));assert.equal(snapshot(),corrupt);
    }
    sqlite.prepare("update control_plane_handoff_receipts set receipt_json=?").run(validJson);
    sqlite.exec("insert into control_plane_handoff_receipts select 'duplicate',lease_id,resource,from_owner_thread,to_owner_thread,previous_version,new_version,receipt_json,created_at from control_plane_handoff_receipts");
    assert.throws(()=>facade.readback("to",lease.leaseId,1,3));
    sqlite.prepare("delete from control_plane_handoff_receipts where receipt_id=?").run("duplicate");
    assert.deepEqual(facade.readback("to",lease.leaseId,1,3).receipt,receipt);
    now-=60001;
    const thirdReceipt=store.handoff("to",lease.leaseId,3,"third",{...packet,liveHandle:"new-operation"});
    assert.throws(()=>facade.readback("to",lease.leaseId,1,4));
    assert.throws(()=>facade.readback("third",lease.leaseId,1,4));
    assert.deepEqual(facade.readback("third",lease.leaseId,3,4).receipt,thirdReceipt);
    store.putGrantEvidence("third",{...grant,evidenceHash:"replacement"},1);
    store.putGrantEvidence("third",grant,2);
    assert.throws(()=>facade.readback("third",lease.leaseId,3,4), /grant/);
  } finally {sqlite.close();}
});
