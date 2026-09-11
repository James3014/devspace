import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DurableOperationManager } from "./durable-operations.js";
import { loadConfig } from "./config.js";
import test from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CarrierBindingStore, type CarrierContract } from "./carrier-binding.js";
import { openDatabase } from "./db/client.js";

function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"carrier-test-"))).replaceAll("\\","/");
  const workspace=join(root,"workspace");mkdirSync(workspace);
  let now=Date.now();
  const store=new CarrierBindingStore(root,()=>now);
  const controller={clientId:"shared-oauth",sessionId:"controller-session"};
  const worker={clientId:"shared-oauth",sessionId:"worker-session"};
  const contract:CarrierContract={repository:"James3014/devspace",goal:"issue62",role:"controller",scope:[workspace],baseRevision:"a".repeat(40),operations:["dependency_sync"],expiresAt:new Date(now+60000).toISOString()};
  const request=store.requestPairing(controller);
  const approved=store.approveLocal(request.pendingId,contract);
  store.redeem(controller,request.credential);
  const db=openDatabase(root);
  const snapshot=()=>JSON.stringify({validity:db.sqlite.prepare("select * from carrier_validity order by carrier_id").all(),bindings:db.sqlite.prepare("select * from carrier_bindings order by id").all(),effects:db.sqlite.prepare("select * from carrier_effect_bindings order by operation_id").all(),leases:db.sqlite.prepare("select * from control_plane_resource_leases order by lease_id").all()});
  return {root,workspace,store,db,controller,worker,contract,request,approved,snapshot,advance:()=>{now+=120000;},close:()=>{db.close();store.close();rmSync(root,{recursive:true,force:true});}};
}
test("shared OAuth and forged metadata cannot impersonate a paired carrier; reconnect requires credential possession",()=>{
  const f=fixture();try {
    const before=f.snapshot();
    assert.throws(()=>f.store.status({...f.worker,ownerThread:f.approved.id,_meta:{conversation_id:f.approved.id}}));
    assert.throws(()=>f.store.redeem({...f.worker,clientId:"different-client"},f.request.credential));
    assert.equal(f.snapshot(),before);
    assert.equal(f.store.redeem(f.worker,f.request.credential).id,f.approved.id);
    f.store.forgetSession(f.worker.sessionId);
    assert.throws(()=>f.store.status(f.worker));
    assert.equal(f.store.redeem(f.worker,f.request.credential).id,f.approved.id);
  } finally {f.close();}
});
test("delegation narrows scope; workers cannot promote or delegate; parent revocation fences every child",()=>{
  const f=fixture();try {
    const pending=f.store.requestPairing(f.worker);
    const before=f.snapshot();
    assert.throws(()=>f.store.delegate(f.controller,pending.pendingId,f.contract));
    assert.throws(()=>f.store.delegate(f.controller,pending.pendingId,{...f.contract,role:"worker",scope:[f.root]}));
    assert.equal(f.snapshot(),before);
    const child=f.store.delegate(f.controller,pending.pendingId,{...f.contract,role:"worker"});
    assert.equal(f.store.redeem(f.worker,pending.credential).id,child.id);
    assert.throws(()=>f.store.delegate(f.worker,pending.pendingId,{...f.contract,role:"worker"}));
    f.store.revokeLocal(f.approved.id,1);
    const revoked=f.snapshot();
    assert.throws(()=>f.store.status(f.controller));
    assert.throws(()=>f.store.status(f.worker));
    assert.throws(()=>f.store.redeem(f.worker,pending.credential));
    assert.throws(()=>f.store.revokeLocal(f.approved.id,1));
    assert.equal(f.snapshot(),revoked);
  } finally {f.close();}
});
test("exact effect binds existing lease and grant CAS; rejection never mutates durable state",()=>{
  const f=fixture();try {
    const subject={operationId:"op_test",requestHash:"b".repeat(64),workspaceRoot:f.workspace.replaceAll("\\","/"),baseRevision:f.contract.baseRevision,operation:"dependency_sync" as const};
    const lease=f.store.prepareEffect(f.controller,subject);
    assert.equal(f.store.readers.resolveEffectBinding(f.controller,subject)?.leaseId,lease.leaseId);
    const before=f.snapshot();
    assert.throws(()=>f.store.prepareEffect(f.worker,subject));
    assert.throws(()=>f.store.prepareEffect(f.controller,{...subject,requestHash:"c".repeat(64)}));
    assert.throws(()=>f.store.prepareEffect(f.controller,{...subject,baseRevision:"d".repeat(40)}));
    assert.equal(f.snapshot(),before);
    const pinned=f.store.ownership.beginOperation(f.controller,lease.leaseId,lease.version,subject.operationId);
    assert.equal(f.store.readers.resolveEffectBinding(f.controller,subject)?.leaseVersion,pinned.version);
    const inFlight=f.snapshot();
    assert.throws(()=>f.store.prepareEffect(f.controller,{...subject,operationId:"different-operation"}));
    assert.equal(f.snapshot(),inFlight);
    f.store.revokeLocal(f.approved.id,1);
    const revoked=f.snapshot();
    assert.throws(()=>f.store.ownership.finishOperation(f.controller,lease.leaseId,pinned.version,subject.operationId));
    assert.equal(f.snapshot(),revoked);
    assert.equal(f.store.ownership.get(lease.leaseId)?.operationHandle,subject.operationId);
  } finally {f.close();}
});
test("authority and hashed credentials survive reopen; sessions do not; expiry denies resume",()=>{
  const f=fixture();let reopened:CarrierBindingStore|undefined;try {
    reopened=new CarrierBindingStore(f.root);
    assert.throws(()=>reopened!.status(f.controller));
    assert.equal(reopened.redeem(f.controller,f.request.credential).id,f.approved.id);
    assert.ok(!f.snapshot().includes(f.request.credential));
    f.advance();
    assert.throws(()=>f.store.redeem(f.controller,f.request.credential));
  } finally {reopened?.close();f.close();}
});

test("handoff preserves the pinned operation; terminal proof permits successor recovery after predecessor revocation",async()=>{
  const f=fixture();let manager:DurableOperationManager|undefined;
  try {
    execFileSync("git",["init"],{cwd:f.workspace,stdio:"ignore"});
    execFileSync("git",["-c","user.name=Fixture","-c","user.email=fixture@example.test","commit","--allow-empty","-m","fixture"],{cwd:f.workspace,stdio:"ignore"});
    const base=execFileSync("git",["rev-parse","HEAD"],{cwd:f.workspace,encoding:"utf8"}).trim();
    writeFileSync(join(f.workspace,"package.json"),'{"name":"fixture","version":"1.0.0"}');
    writeFileSync(join(f.workspace,"package-lock.json"),'{"lockfileVersion":3,"packages":{}}');
    const sender={clientId:"shared-oauth",sessionId:"sender"}, successor={clientId:"shared-oauth",sessionId:"successor"};
    const contract={...f.contract,baseRevision:base};
    const a=f.store.requestPairing(sender),b=f.store.requestPairing(successor);
    const from=f.store.approveLocal(a.pendingId,contract),to=f.store.approveLocal(b.pendingId,contract);
    f.store.redeem(sender,a.credential);f.store.redeem(successor,b.credential);
    let launched!:()=>void, finish!:()=>void;
    const started=new Promise<void>(resolve=>{launched=resolve;});
    const terminal=new Promise<void>(resolve=>{finish=resolve;});
    const config=loadConfig({DEVSPACE_CONFIG_DIR:join(f.root,"config"),DEVSPACE_STATE_DIR:f.root,DEVSPACE_ALLOWED_ROOTS:f.root,DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-that-is-long-enough",PORT:"1"});
    manager=new DurableOperationManager(config,async()=>{launched();await terminal;return {exitCode:0,stdout:"",stderr:""};},undefined,undefined,f.store.readers);
    const input={workspaceId:"fixture-workspace",workspaceRoot:f.workspace,attemptKey:"handoff-terminal",recipe:"npm_ci" as const};
    const plan=await manager.planDependencySync(input);
    const lease=f.store.prepareEffect(sender,plan.subject);
    const running=manager.dependencySync(input,sender);
    await started;
    const pinned=f.store.ownership.get(lease.leaseId)!;
    manager.handoff(lease.leaseId,pinned.version,to.id,{
      resource:lease.resource,baseRevision:base,scope:lease.scope,candidateRevision:base,
      liveOperation:lease.operation,liveHandle:plan.subject.operationId,checkpoint:"test-started",
      grantDependency:from.grant,grantVersion:1,recipientGrant:to.grant,recipientGrantVersion:1,
      forbiddenOverlap:lease.scope,tests:["terminal-test"],evidence:["test-command-started"],remainingGap:"wait for terminal proof",nextGate:"reconcile",expiresAt:lease.expiresAt,
    },sender);
    assert.equal(f.store.readers.resolveEffectBinding(sender,plan.subject),undefined);
    assert.equal(f.store.readers.resolveEffectBinding(successor,plan.subject)?.leaseId,lease.leaseId);
    await assert.rejects(()=>manager!.reconcile(plan.subject.operationId,sender));
    f.store.revokeLocal(from.id,1);
    finish();
    assert.equal((await running).status,"outcome_unknown");
    const recovered=await manager.reconcile(plan.subject.operationId,successor);
    assert.equal(recovered.status,"succeeded");
    const terminalSnapshot=f.snapshot();
    assert.deepEqual(await manager.reconcile(plan.subject.operationId,successor),recovered);
    assert.equal(f.snapshot(),terminalSnapshot);
    assert.equal(f.store.ownership.get(lease.leaseId)?.operationHandle,undefined);
    assert.equal(f.store.ownership.get(lease.leaseId)?.ownerThread,to.id);
    const before=f.snapshot();
    await assert.rejects(()=>manager!.dependencySync(input,sender));
    assert.equal(f.snapshot(),before);
  } finally {manager?.close();f.close();}
});


test("reauthorization preserves identity and grant, rejects stale or unbounded approval, and requires explicit idle lease release",()=>{
  const f=fixture();try {
    const subject={operationId:"idle",requestHash:"b".repeat(64),workspaceRoot:f.workspace,baseRevision:f.contract.baseRevision,operation:"dependency_sync" as const};
    const lease=f.store.prepareEffect(f.controller,subject);
    f.advance();
    assert.throws(()=>f.store.status(f.controller));
    const until=new Date(Date.parse(f.contract.expiresAt)+240000).toISOString();
    const before=f.snapshot();
    for(const invalid of ["invalid",new Date(Date.parse(f.contract.expiresAt)+48*60*60*1000).toISOString()]) assert.throws(()=>f.store.reauthorizeLocal(f.approved.id,1,invalid));
    assert.throws(()=>f.store.reauthorizeLocal(f.approved.id,2,until));
    assert.equal(f.snapshot(),before);
    const renewed=f.store.reauthorizeLocal(f.approved.id,1,until);
    assert.equal(renewed.id,f.approved.id);
    assert.deepEqual(renewed.contract,f.approved.contract);
    assert.deepEqual(renewed.grant,f.approved.grant);
    assert.equal(renewed.validity.version,2);
    assert.notEqual(renewed.authorityVersion,f.approved.authorityVersion);
    const after=f.snapshot();
    assert.throws(()=>f.store.reauthorizeLocal(f.approved.id,1,until));
    assert.equal(f.snapshot(),after);
    f.store.forgetSession(f.controller.sessionId);
    assert.equal(f.store.redeem(f.controller,f.request.credential).id,f.approved.id);
    assert.equal(f.store.readLease(f.controller,lease.leaseId).leaseId,lease.leaseId);
    assert.throws(()=>f.store.prepareEffect(f.controller,{...subject,operationId:"next"}));
    assert.throws(()=>f.store.releaseLease(f.worker,lease.leaseId,lease.version));
    assert.throws(()=>f.store.releaseLease(f.controller,lease.leaseId,lease.version+1));
    assert.equal(f.store.releaseLease(f.controller,lease.leaseId,lease.version).terminalState,"released");
    assert.notEqual(f.store.prepareEffect(f.controller,{...subject,operationId:"next"}).leaseId,lease.leaseId);
    assert.ok(!JSON.stringify(f.store.inspectLocal(f.approved.id)).includes(f.request.credential));
  } finally {f.close();}
});

test("renewal cannot unpin unknown effects, renew children implicitly, or revive revoked ancestry",()=>{
  const f=fixture();try {
    const request=f.store.requestPairing(f.worker);
    const child=f.store.delegate(f.controller,request.pendingId,{...f.contract,role:"worker"});
    f.store.redeem(f.worker,request.credential);
    const subject={operationId:"unknown",requestHash:"b".repeat(64),workspaceRoot:f.workspace,baseRevision:f.contract.baseRevision,operation:"dependency_sync" as const};
    const lease=f.store.prepareEffect(f.worker,subject);
    const pinned=f.store.ownership.beginOperation(f.worker,lease.leaseId,lease.version,subject.operationId);
    f.advance();
    const until=new Date(Date.parse(f.contract.expiresAt)+240000).toISOString();
    assert.throws(()=>f.store.reauthorizeLocal(child.id,1,until));
    f.store.reauthorizeLocal(f.approved.id,1,until);
    assert.throws(()=>f.store.status(f.worker));
    assert.throws(()=>f.store.reauthorizeLocal(child.id,1,new Date(Date.parse(until)+1).toISOString()));
    f.store.reauthorizeLocal(child.id,1,until);
    const before=f.snapshot();
    assert.equal(f.store.readers.readDependencyReconciliation?.(f.worker,subject),undefined);
    assert.throws(()=>f.store.releaseLease(f.worker,lease.leaseId,pinned.version));
    assert.throws(()=>f.store.prepareEffect(f.worker,{...subject,operationId:"retry"}));
    assert.throws(()=>f.store.reauthorizeLocal(child.id,2,new Date(Date.parse(until)+48*60*60*1000).toISOString()));
    assert.equal(f.snapshot(),before);
    assert.equal(f.store.ownership.get(lease.leaseId)?.operationHandle,subject.operationId);
    f.store.revokeLocal(f.approved.id,1);
    const revoked=f.snapshot();
    assert.throws(()=>f.store.reauthorizeLocal(f.approved.id,2,new Date(Date.parse(until)+60000).toISOString()));
    assert.throws(()=>f.store.reauthorizeLocal(child.id,2,new Date(Date.parse(until)+60000).toISOString()));
    assert.equal(f.snapshot(),revoked);
  } finally {f.close();}
});

test("persisted validity rejects competing approvals and malformed records",()=>{
  const f=fixture();const other=new CarrierBindingStore(f.root);try {
    const until=new Date(Date.parse(f.contract.expiresAt)+240000).toISOString();
    const accepted=f.store.reauthorizeLocal(f.approved.id,1,until);
    assert.deepEqual(other.inspectLocal(f.approved.id).validity,accepted.validity);
    const before=f.snapshot();
    assert.throws(()=>other.reauthorizeLocal(f.approved.id,1,new Date(Date.parse(until)+60000).toISOString()));
    assert.equal(f.snapshot(),before);
    assert.equal(other.redeem(f.worker,f.request.credential).authorityVersion,accepted.authorityVersion);
    for(const invalid of ["invalid","2027-01-01",""]) {
      f.db.sqlite.prepare("update carrier_validity set expires_at=? where carrier_id=?").run(invalid,f.approved.id);
      const malformed=f.snapshot();
      assert.throws(()=>f.store.status(f.controller));
      assert.throws(()=>f.store.inspectLocal(f.approved.id));
      assert.throws(()=>f.store.reauthorizeLocal(f.approved.id,2,until));
      assert.equal(f.snapshot(),malformed);
    }
  } finally {other.close();f.close();}
});

test("migration preserves existing authority and pinned ownership",()=>{
  const f=fixture();let migrated:CarrierBindingStore|undefined;try {
    const subject={operationId:"migration-pin",requestHash:"b".repeat(64),workspaceRoot:f.workspace,baseRevision:f.contract.baseRevision,operation:"dependency_sync" as const};
    const lease=f.store.prepareEffect(f.controller,subject);
    const pinned=f.store.ownership.beginOperation(f.controller,lease.leaseId,lease.version,subject.operationId);
    const before=f.db.sqlite.prepare("select * from carrier_bindings order by id").all();
    // Reconstruct the preceding schema only in this disposable fixture.
    f.db.sqlite.exec("drop table carrier_validity; delete from devspace_schema_migrations where version=16");
    migrated=new CarrierBindingStore(f.root);
    assert.deepEqual(f.db.sqlite.prepare("select * from carrier_bindings order by id").all(),before);
    const resumed=migrated.redeem(f.controller,f.request.credential);
    assert.equal(resumed.id,f.approved.id);
    assert.deepEqual(resumed.grant,f.approved.grant);
    assert.deepEqual(resumed.validity,{version:1,expiresAt:f.contract.expiresAt});
    assert.deepEqual(migrated.ownership.get(lease.leaseId),pinned);
  } finally {migrated?.close();f.close();}
});

for(const expire of [true,false]) test(`validity drift fences completion and original carrier recovers without command replay (expired=${expire})`,async()=>{
  const f=fixture();let manager:DurableOperationManager|undefined;
  try {
    execFileSync("git",["init"],{cwd:f.workspace,stdio:"ignore"});
    execFileSync("git",["-c","user.name=Fixture","-c","user.email=fixture@example.test","commit","--allow-empty","-m","fixture"],{cwd:f.workspace,stdio:"ignore"});
    const base=execFileSync("git",["rev-parse","HEAD"],{cwd:f.workspace,encoding:"utf8"}).trim();
    writeFileSync(join(f.workspace,"package.json"),'{"name":"fixture","version":"1.0.0"}');
    writeFileSync(join(f.workspace,"package-lock.json"),'{"lockfileVersion":3,"packages":{}}');
    const sender={clientId:"shared-oauth",sessionId:"sender"}, successor={clientId:"shared-oauth",sessionId:"successor"};
    const contract={...f.contract,baseRevision:base};
    const a=f.store.requestPairing(sender),b=f.store.requestPairing(successor);
    const from=f.store.approveLocal(a.pendingId,contract),to=f.store.approveLocal(b.pendingId,contract);
    f.store.redeem(sender,a.credential);f.store.redeem(successor,b.credential);
    let launched!:()=>void, finish!:()=>void;
    const started=new Promise<void>(resolve=>{launched=resolve;});
    const terminal=new Promise<void>(resolve=>{finish=resolve;});
    const config=loadConfig({DEVSPACE_CONFIG_DIR:join(f.root,"config"),DEVSPACE_STATE_DIR:f.root,DEVSPACE_ALLOWED_ROOTS:f.root,DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-that-is-long-enough",PORT:"1"});
    manager=new DurableOperationManager(config,async()=>{launched();await terminal;return {exitCode:0,stdout:"",stderr:""};},undefined,undefined,f.store.readers);
    const input={workspaceId:"fixture-workspace",workspaceRoot:f.workspace,attemptKey:"handoff-terminal",recipe:"npm_ci" as const};
    const plan=await manager.planDependencySync(input);
    const lease=f.store.prepareEffect(sender,plan.subject);
    const running=manager.dependencySync(input,sender);
    await started;
    const pinned=f.store.ownership.get(lease.leaseId)!;
    if(expire) f.advance();
    await assert.rejects(()=>manager!.reconcile(plan.subject.operationId,sender));
    const renewed=f.store.reauthorizeLocal(from.id,1,new Date(Date.parse(contract.expiresAt)+240000).toISOString());
    assert.deepEqual(renewed.grant,from.grant);
    assert.equal(f.store.ownership.get(lease.leaseId)?.operationHandle,plan.subject.operationId);
    finish();
    assert.equal((await running).status,"outcome_unknown");
    const recovered=await manager.reconcile(plan.subject.operationId,sender);
    assert.equal(recovered.status,"succeeded");
    const terminalSnapshot=f.snapshot();
    assert.deepEqual(await manager.reconcile(plan.subject.operationId,sender),recovered);
    assert.equal(f.snapshot(),terminalSnapshot);
    assert.equal(f.store.ownership.get(lease.leaseId)?.operationHandle,undefined);
    assert.equal(f.store.ownership.get(lease.leaseId)?.ownerThread,from.id);
    assert.equal(f.store.ownership.get(lease.leaseId)?.terminalState,expire ? "expired_reconciled" : undefined);
    const nextPlan=await manager.planDependencySync({...input,attemptKey:"next-after-recovery"});
    assert.equal(f.store.prepareEffect(sender,nextPlan.subject).leaseId===lease.leaseId,!expire);
  } finally {manager?.close();f.close();}
});
