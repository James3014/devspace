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
  } finally {db.close();}
});
