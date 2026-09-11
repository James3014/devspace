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
  const snapshot=()=>JSON.stringify({bindings:db.sqlite.prepare("select * from carrier_bindings order by id").all(),effects:db.sqlite.prepare("select * from carrier_effect_bindings order by operation_id").all(),leases:db.sqlite.prepare("select * from control_plane_resource_leases order by lease_id").all()});
  return {root,workspace,store,controller,worker,contract,request,approved,snapshot,advance:()=>{now+=120000;},close:()=>{db.close();store.close();rmSync(root,{recursive:true,force:true});}};
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
