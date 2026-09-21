import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DurableOperationManager, DurableOperationStore, cutoverTerminalRecordHash, planCutoverStart } from "./durable-operations.js";
import { loadConfig } from "./config.js";
import test from "node:test";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CarrierBindingStore, type CarrierContract, type CarrierCompletionBinding } from "./carrier-binding.js";
import { openDatabase } from "./db/client.js";
import { CutoverStateStore } from "./cutover-state.js";
import { ControlPlaneOwnershipStore } from "./control-plane-ownership.js";
import { performLocalBoundCutoverRestart } from "./cutover-local-restart.js";

function fixture(completionBindings: readonly CarrierCompletionBinding[] = []) {
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),"carrier-test-"))).replaceAll("\\","/");
  const workspace=join(root,"workspace");mkdirSync(workspace);
  let now=Date.now();
  const store=new CarrierBindingStore(root,()=>now,completionBindings);
  const controller={clientId:"shared-oauth",sessionId:"controller-session"};
  const worker={clientId:"shared-oauth",sessionId:"worker-session"};
  const contract:CarrierContract={repository:"James3014/devspace",goal:"issue62",role:"controller",scope:[workspace],baseRevision:"a".repeat(40),operations:["dependency_sync"],expiresAt:new Date(now+60000).toISOString()};
  const request=store.requestPairing(controller);
  const approved=store.approveLocal(request.pendingId,contract);
  store.redeem(controller,request.credential);
  const db=openDatabase(root);
  const snapshot=()=>JSON.stringify({validity:db.sqlite.prepare("select * from carrier_validity order by carrier_id").all(),bindings:db.sqlite.prepare("select * from carrier_bindings order by id").all(),effects:db.sqlite.prepare("select * from carrier_effect_bindings order by operation_id").all(),leases:db.sqlite.prepare("select * from control_plane_resource_leases order by lease_id").all()});
  return {root,workspace,store,db,controller,worker,contract,request,approved,snapshot,advance:(ms=120000)=>{now+=ms;},clock:()=>now,close:()=>{db.close();store.close();rmSync(root,{recursive:true,force:true});}};
}

async function prepareCapabilityMismatch(f: ReturnType<typeof fixture>, sessionId: string, expectedCapability: string, observedCapability: string) {
  const context={clientId:"shared-oauth",sessionId};
  const pairing=f.store.requestPairing(context);
  const cutover={stateRoot:f.root,attemptKey:`${sessionId}-cutover`,
    currentIdentity:{serverInstanceId:"original",sourceCommit:f.contract.baseRevision,buildId:"old",capabilityManifestSha256:"c".repeat(64)},
    expectedIdentity:{sourceCommit:"b".repeat(40),buildId:"new",capabilityManifestSha256:expectedCapability},
    expiresAt:new Date(f.clock()+120000).toISOString(),
    restart:{buildReady:{verifiedBy:"fixture",verifiedAt:new Date(f.clock()).toISOString(),evidence:"exact target build"},actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service"},
    finish:{workspaceId:"ws_test",agentId:"agt_test"}};
  const contract={...f.contract,scope:[f.root],operations:["cutover_start" as const],cutover,expiresAt:new Date(f.clock()+180000).toISOString()};
  const approved=f.store.approveLocal(pairing.pendingId,contract);
  f.store.redeem(context,pairing.credential);
  const plan=planCutoverStart(f.root,cutover);
  const preparedLease=f.store.prepareEffect(context,plan.subject);
  const config=loadConfig({DEVSPACE_CONFIG_DIR:join(f.root,`${sessionId}-config`),DEVSPACE_ALLOWED_ROOTS:f.workspace,DEVSPACE_WORKTREE_ROOT:join(f.root,`${sessionId}-worktrees`),DEVSPACE_STATE_DIR:f.root,DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-long-enough",PORT:"1"});
  const manager=new DurableOperationManager(config,undefined,undefined,undefined,f.store.readers);
  const start=manager.startCutover(cutover,context),id=start.receipt!.cutoverId as string;
  manager.drainCutover(id,cutover.currentIdentity,()=>({activeSessions:0,oldestAgeMs:0}),context);
  let scheduled=0;
  await manager.restartCutover(id,cutover.currentIdentity,cutover.restart.buildReady,async()=>({buildReady:true,detail:"exact target build"}),{
    actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service",
    schedule:()=>{scheduled+=1;return {scheduled:true as const,actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service"};},
  },context);
  return {context,cutover,approved,preparedLease,manager,start,id,scheduled:()=>scheduled,observed:{serverInstanceId:"replacement",sourceCommit:cutover.expectedIdentity.sourceCommit,buildId:cutover.expectedIdentity.buildId,capabilityManifestSha256:observedCapability}};
}

async function prepareUnexpectedReplacement(f: ReturnType<typeof fixture>, sessionId: string) {
  const context={clientId:"shared-oauth",sessionId};
  const pairing=f.store.requestPairing(context);
  const cutover={stateRoot:f.root,attemptKey:`${sessionId}-cutover`,
    currentIdentity:{serverInstanceId:"original",sourceCommit:f.contract.baseRevision,buildId:"old",capabilityManifestSha256:"c".repeat(64)},
    expectedIdentity:{sourceCommit:"b".repeat(40),buildId:"new",capabilityManifestSha256:"d".repeat(64)},
    expiresAt:new Date(f.clock()+30000).toISOString(),
    restart:{buildReady:{verifiedBy:"fixture",verifiedAt:new Date(f.clock()).toISOString(),evidence:"exact original target"},actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service"},
    finish:{workspaceId:"ws_test",agentId:"agt_test"}};
  const contract={...f.contract,scope:[f.root],operations:["cutover_start" as const],cutover,expiresAt:new Date(f.clock()+60000).toISOString()};
  const approved=f.store.approveLocal(pairing.pendingId,contract);
  f.store.redeem(context,pairing.credential);
  const plan=planCutoverStart(f.root,cutover);
  const preparedLease=f.store.prepareEffect(context,plan.subject);
  const config=loadConfig({DEVSPACE_CONFIG_DIR:join(f.root,`${sessionId}-config`),DEVSPACE_ALLOWED_ROOTS:f.workspace,DEVSPACE_WORKTREE_ROOT:join(f.root,`${sessionId}-worktrees`),DEVSPACE_STATE_DIR:f.root,DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-long-enough",PORT:"1"});
  const manager=new DurableOperationManager(config,undefined,undefined,undefined,f.store.readers);
  const start=manager.startCutover(cutover,context),id=start.receipt!.cutoverId as string;
  manager.drainCutover(id,cutover.currentIdentity,()=>({activeSessions:0,oldestAgeMs:0}),context);
  const observed={serverInstanceId:"replacement",sourceCommit:"f".repeat(40),buildId:"replacement-build",capabilityManifestSha256:"e".repeat(64)};
  return {context,pairing,cutover,approved,preparedLease,manager,start,id,observed};
}

for(const scenario of ["current","expired","close-response","terminal-write","revoke-witness","renew-witness","stale-replay"]) test(`local cutover approval binds execution and recovery (${scenario})`,async()=>{
  const expireLease=scenario!=="current";
  const f=fixture();
  try {
    const context={clientId:"shared-oauth",sessionId:"cutover-controller"};
    const pairing=f.store.requestPairing(context);
    const cutover={stateRoot:f.root,attemptKey:"approved-cutover",
      currentIdentity:{serverInstanceId:"original",sourceCommit:f.contract.baseRevision,buildId:"old",capabilityManifestSha256:"c".repeat(64)},
      expectedIdentity:{sourceCommit:"b".repeat(40),buildId:"new",capabilityManifestSha256:"d".repeat(64)},
      expiresAt:new Date(Date.parse(f.contract.expiresAt)-30000).toISOString(),
      restart:{buildReady:{verifiedBy:"independent",verifiedAt:new Date(Date.parse(f.contract.expiresAt)-60000).toISOString(),evidence:"exact package digest"},actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service"},
      finish:{workspaceId:"ws_test",agentId:"agt_test"}};
    const contract={...f.contract,scope:[f.root],operations:["cutover_start" as const],cutover};
    const before=f.snapshot();
    for(const invalid of [
      {...contract,role:"worker" as const},
      {...contract,scope:[f.workspace]},
      {...contract,operations:["dependency_sync" as const],cutover},
      {...contract,cutover:{...cutover,stateRoot:f.workspace}},
      {...contract,cutover:{...cutover,expectedIdentity:{...cutover.expectedIdentity,capabilityManifestSha256:"invalid"}}},
      {...contract,cutover:{...cutover,currentIdentity:{...cutover.currentIdentity,sourceCommit:"unverified"}}},
      {...contract,cutover:{...cutover,expiresAt:new Date(Date.parse(contract.expiresAt)+1).toISOString()}},
      {...contract,cutover:{...cutover,restart:{...cutover.restart,buildReady:{...cutover.restart.buildReady,evidence:""}}}},
      {...contract,cutover:{...cutover,extraAuthority:true}},
    ]) {
      assert.throws(()=>f.store.approveLocal(pairing.pendingId,invalid));
      assert.equal(f.snapshot(),before);
    }
    const approved=f.store.approveLocal(pairing.pendingId,contract);
    f.store.redeem(context,pairing.credential);
    const plan=planCutoverStart(f.root,cutover);
    const lease=f.store.prepareEffect(context,plan.subject);
    assert.equal(lease.operation,"cutover_start");
    assert.throws(()=>f.store.prepareEffect(context,planCutoverStart(f.root,{...cutover,attemptKey:"other"}).subject));
    assert.throws(()=>f.store.prepareEffect(context,planCutoverStart(f.root,{...cutover,expectedIdentity:{...cutover.expectedIdentity,buildId:"wrong"}}).subject));
    const child=f.store.requestPairing(f.worker);
    assert.throws(()=>f.store.delegate(context,child.pendingId,{...contract,role:"worker"}));
    const config=loadConfig({DEVSPACE_CONFIG_DIR:join(f.root,"config"),DEVSPACE_ALLOWED_ROOTS:f.workspace,DEVSPACE_WORKTREE_ROOT:join(f.root,"worktrees"),DEVSPACE_STATE_DIR:f.root,DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-long-enough",PORT:"1"});
    const manager=new DurableOperationManager(config,undefined,undefined,undefined,f.store.readers);
    let scheduled=0;
    const actuator={actuator:"launchd-self" as const,serviceLabel:cutover.restart.serviceLabel,launchdTarget:cutover.restart.launchdTarget,schedule:()=>{scheduled++;return {scheduled:true as const,actuator:"launchd-self" as const,serviceLabel:cutover.restart.serviceLabel,launchdTarget:cutover.restart.launchdTarget};}};
    const start=manager.startCutover(cutover,context),id=start.receipt!.cutoverId as string;
    try {
      assert.throws(()=>manager.drainCutover(id,{...cutover.currentIdentity,serverInstanceId:"other"},()=>({activeSessions:0,oldestAgeMs:0}),context));
      assert.equal(manager.drainCutover(id,cutover.currentIdentity,()=>({activeSessions:0,oldestAgeMs:0}),context).phase,"drained");
      await assert.rejects(manager.restartCutover(id,cutover.currentIdentity,{...cutover.restart.buildReady,evidence:"wrong"},async()=>({buildReady:true,detail:"test"}),actuator,context));
      await manager.restartCutover(id,cutover.currentIdentity,cutover.restart.buildReady,async()=>({buildReady:true,detail:"test"}),actuator,context);
      await manager.restartCutover(id,cutover.currentIdentity,cutover.restart.buildReady,async()=>{throw new Error("replay must not probe");},actuator,context);
      assert.equal(scheduled,1);
      f.advance(40000);
      assert.throws(()=>f.store.prepareEffect(context,plan.subject),/expired/);
      await assert.rejects(manager.restartCutover(id,cutover.currentIdentity,cutover.restart.buildReady,async()=>({buildReady:true,detail:"test"}),actuator,context));
    } finally {manager.close();}
    const resumedStore=new CarrierBindingStore(f.root,f.clock);
    const resumedManager=new DurableOperationManager(config,undefined,undefined,undefined,resumedStore.readers);
    const successor={clientId:context.clientId,sessionId:"replacement-session"};
    try {
      if(expireLease) {
        f.advance(40000);
        assert.throws(()=>resumedStore.redeem(successor,pairing.credential),/expired/i);
        resumedStore.reauthorizeLocal(approved.id,1,new Date(f.clock()+60000).toISOString());
      }
      assert.throws(()=>resumedStore.status(successor));
      resumedStore.redeem(successor,pairing.credential);
      const replacement={serverInstanceId:"replacement",...cutover.expectedIdentity};
      const witness={workspaceQueryable:true,agentQueryable:true,agentReconciled:true,witnessWorkspaceId:cutover.finish.workspaceId,witnessAgentId:cutover.finish.agentId};
      await assert.rejects(resumedManager.finishCutover(id,cutover.currentIdentity,cutover.finish,async()=>witness,successor));
      await assert.rejects(resumedManager.finishCutover(id,replacement,{...cutover.finish,agentId:"wrong"},async()=>witness,successor));
      if(expireLease) {
        const pin=resumedStore.readLease(successor,lease.leaseId);
        assert.throws(()=>resumedStore.ownership.reconcile(successor,pin.leaseId,pin.version,{leaseId:pin.leaseId,leaseVersion:pin.version,ownerThread:pin.ownerThread,operation:pin.operation,operationHandle:start.operationId,baseRevision:pin.baseRevision,state:"finished",detail:JSON.stringify({kind:"cutover_terminal",cutoverId:id,requestHash:start.requestHash,terminalRecordHash:"0".repeat(64)})}),/terminal effect proof/);
        assert.deepEqual(resumedStore.readLease(successor,lease.leaseId),pin);
      }
      if(scenario==="revoke-witness" || scenario==="renew-witness") {
        await assert.rejects(resumedManager.finishCutover(id,replacement,cutover.finish,async()=>{
          if(scenario==="revoke-witness") resumedStore.revokeLocal(approved.id,1);
          else resumedStore.reauthorizeLocal(approved.id,2,new Date(f.clock()+120000).toISOString());
          return witness;
        },successor));
        assert.equal(resumedStore.ownership.get(lease.leaseId)?.operationHandle,start.operationId);
        assert.equal(new CutoverStateStore(f.root).get()?.phase,"drained");
        assert.equal(scheduled,1);
        if(scenario==="revoke-witness") return;
      }
      if(scenario==="close-response" || scenario==="terminal-write") {
        const close=CutoverStateStore.prototype.close;
        const finish=resumedManager.store.finish.bind(resumedManager.store);
        if(scenario==="close-response") CutoverStateStore.prototype.close=function(...args){close.apply(this,args);throw new Error("lost closed-file response");};
        else resumedManager.store.finish=(...args)=>{if(args[1].receipt?.lifecycleTerminal) throw new Error("terminal database write failed");return finish(...args);};
        try {await assert.rejects(resumedManager.finishCutover(id,replacement,cutover.finish,async()=>witness,successor),/lost closed-file|terminal database/);}
        finally {CutoverStateStore.prototype.close=close;resumedManager.store.finish=finish;}
        assert.equal(new CutoverStateStore(f.root).get()?.phase,"closed");
        assert.equal(resumedStore.readLease(successor,lease.leaseId).operationHandle,start.operationId);
        assert.equal(resumedStore.readLease(successor,lease.leaseId).terminalState,undefined);
      }
      assert.equal((await resumedManager.finishCutover(id,replacement,cutover.finish,async()=>witness,successor)).phase,"closed");
      assert.equal((await resumedManager.finishCutover(id,replacement,cutover.finish,async()=>{throw new Error("no repeat witness");},successor)).phase,"closed");
      assert.equal(resumedStore.readLease(successor,lease.leaseId).operationHandle,undefined);
      if(expireLease) assert.equal(resumedStore.readLease(successor,lease.leaseId).terminalState,"expired_reconciled");
      if(scenario==="stale-replay") {
        f.db.sqlite.prepare("update control_plane_resource_leases set version=version+1 where lease_id=?").run(lease.leaseId);
        await assert.rejects(resumedManager.finishCutover(id,replacement,cutover.finish,async()=>{throw new Error("must not repeat witness");},successor),/replay changed/);
      }
      assert.equal(scheduled,1);
    } finally {resumedManager.close();resumedStore.close();}
  } finally {f.close();}
});
test("expired coordination-bound prepared cutover can terminally reconcile an exact observed replacement",async()=>{
  const f=fixture();
  try {
    const context={clientId:"shared-oauth",sessionId:"prepared-recovery-controller"};
    const pairing=f.store.requestPairing(context);
    const cutover={stateRoot:f.root,attemptKey:"expired-prepared-recovery",
      currentIdentity:{serverInstanceId:"original",sourceCommit:f.contract.baseRevision,buildId:"old",capabilityManifestSha256:"c".repeat(64)},
      expectedIdentity:{sourceCommit:"b".repeat(40),buildId:"new",capabilityManifestSha256:"d".repeat(64)},
      expiresAt:new Date(f.clock()+20000).toISOString(),
      restart:{buildReady:{verifiedBy:"independent",verifiedAt:new Date(f.clock()).toISOString(),evidence:"exact package digest"},actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service"},
      finish:{workspaceId:"ws_prepared",agentId:"agt_prepared"}};
    const contract={...f.contract,scope:[f.root],operations:["cutover_start" as const],cutover};
    const approved=f.store.approveLocal(pairing.pendingId,contract);
    f.store.redeem(context,pairing.credential);
    const config=loadConfig({DEVSPACE_CONFIG_DIR:join(f.root,"config"),DEVSPACE_ALLOWED_ROOTS:f.workspace,DEVSPACE_WORKTREE_ROOT:join(f.root,"worktrees"),DEVSPACE_STATE_DIR:f.root,DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-long-enough",PORT:"1"});
    const manager=new DurableOperationManager(config,undefined,undefined,undefined,f.store.readers);
    try {
      f.store.prepareEffect(context,planCutoverStart(f.root,cutover).subject);
      const start=manager.startCutover(cutover,context),id=start.receipt!.cutoverId as string;
      const replacement={serverInstanceId:"replacement",...cutover.expectedIdentity};
      const witness={workspaceQueryable:true,agentQueryable:true,agentReconciled:true,witnessWorkspaceId:cutover.finish.workspaceId,witnessAgentId:cutover.finish.agentId};
      let witnessCalls=0;
      await assert.rejects(manager.finishCutover(id,replacement,cutover.finish,async()=>{witnessCalls++;return witness;},context),/drained generation|prepared recovery/);
      assert.equal(witnessCalls,0);
      assert.equal(new CutoverStateStore(f.root).get()?.phase,"prepared");
      f.advance(70000);
      f.store.reauthorizeLocal(approved.id,1,new Date(f.clock()+60000).toISOString());
      await assert.rejects(manager.finishCutover(id,{...replacement,serverInstanceId:cutover.currentIdentity.serverInstanceId},cutover.finish,async()=>{witnessCalls++;return witness;},context),/terminal recovery approval|required|runtime identity mismatch/);
      assert.equal(witnessCalls,0);
      const closed=await manager.finishCutover(id,replacement,cutover.finish,async()=>{witnessCalls++;return witness;},context);
      assert.equal(closed.phase,"closed");
      assert.equal(witnessCalls,1);
      assert.equal(closed.drainEvidence,undefined);
      assert.equal(closed.restartRequest,undefined);
      const lease=f.store.ownership.get(closed.coordinationBinding!.leaseId)!;
      assert.equal(lease.operationHandle,undefined);
      assert.equal(lease.terminalState,"expired_reconciled");
      assert.equal(manager.store.getByOperationId(start.operationId)?.receipt?.lifecycleTerminal,true);
      assert.deepEqual(await manager.finishCutover(id,replacement,cutover.finish,async()=>{throw new Error("must not repeat witness");},context),closed);
    } finally {manager.close();}
  } finally {f.close();}
});
test("host-local recovery terminally closes only an expired prepared cutover with zero lifecycle effect",()=>{
  const f=fixture();
  const context={clientId:"shared-oauth",sessionId:"expired-prepared-controller"};
  let manager:DurableOperationManager|undefined;
  try {
    const pairing=f.store.requestPairing(context);
    const cutover={stateRoot:f.root,attemptKey:"expired-prepared-no-effect",
      currentIdentity:{serverInstanceId:"original",sourceCommit:f.contract.baseRevision,buildId:"old",capabilityManifestSha256:"c".repeat(64)},
      expectedIdentity:{sourceCommit:"b".repeat(40),buildId:"new",capabilityManifestSha256:"d".repeat(64)},
      expiresAt:new Date(f.clock()+30000).toISOString(),
      restart:{buildReady:{verifiedBy:"fixture",verifiedAt:new Date(f.clock()).toISOString(),evidence:"no-effect recovery fixture"},actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service"},
      finish:{workspaceId:"ws_test",agentId:"agt_test"}};
    const contract={...f.contract,scope:[f.root],operations:["cutover_start" as const],cutover,expiresAt:new Date(f.clock()+60000).toISOString()};
    const approved=f.store.approveLocal(pairing.pendingId,contract);
    f.store.redeem(context,pairing.credential);
    const plan=planCutoverStart(f.root,cutover);
    const lease=f.store.prepareEffect(context,plan.subject);
    const config=loadConfig({DEVSPACE_CONFIG_DIR:join(f.root,"config2"),DEVSPACE_ALLOWED_ROOTS:f.workspace,DEVSPACE_WORKTREE_ROOT:join(f.root,"worktrees2"),DEVSPACE_STATE_DIR:f.root,DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-long-enough",PORT:"1"});
    manager=new DurableOperationManager(config,undefined,undefined,undefined,f.store.readers);
    const start=manager.startCutover(cutover,context),id=start.receipt!.cutoverId as string;
    const validityBefore=f.store.inspectLocal(approved.id).validity;
    f.advance(120000);
    assert.throws(()=>f.store.recoverExpiredPreparedCutoverLocal({cutoverId:id,carrierId:approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:"wrong"}),/confirmation/i);
    assert.throws(()=>f.store.recoverExpiredPreparedCutoverLocal({cutoverId:id,carrierId:approved.id,expectedVersion:2,expectedValidityVersion:1,confirmCutoverId:id}),/version/i);
    const recovered=f.store.recoverExpiredPreparedCutoverLocal({cutoverId:id,carrierId:approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:id});
    assert.equal(recovered.replayed,false);
    assert.equal(recovered.cutover.phase,"closed");
    assert.equal(recovered.cutover.expiredPreparedNoEffect?.terminalReason,"EXPIRED_PREPARED_NO_EFFECT");
    assert.equal(recovered.cutover.drainEvidence,undefined);
    assert.equal(recovered.cutover.restartRequest,undefined);
    assert.equal(recovered.cutover.reconciliationReceipt?.workspaceQueryable,false);
    assert.equal(recovered.cutover.reconciliationReceipt?.preRestartDrainObserved,false);
    assert.equal(recovered.lease.leaseId,lease.leaseId);
    assert.equal(recovered.lease.terminalState,"expired_reconciled");
    assert.equal(recovered.lease.operationState,"finished");
    assert.equal(recovered.lease.operationHandle,undefined);
    assert.equal(recovered.operation.receipt?.lifecycleTerminal,true);
    assert.equal(recovered.operation.receipt?.recoveryKind,"expired_prepared_no_effect");
    assert.equal(f.store.inspectLocal(approved.id).validity.version,validityBefore.version);
    assert.equal(f.store.inspectLocal(approved.id).validity.expiresAt,validityBefore.expiresAt);
    const replay=f.store.recoverExpiredPreparedCutoverLocal({cutoverId:id,carrierId:approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:id});
    assert.equal(replay.replayed,true);
    assert.deepEqual(replay.cutover,recovered.cutover);
    assert.deepEqual(replay.reconciliation,recovered.reconciliation);
  } finally {manager?.close();f.close();}
});

test("host-local expired prepared recovery rejects any prior drain effect",()=>{
  const f=fixture();
  const context={clientId:"shared-oauth",sessionId:"expired-prepared-drained"};
  let manager:DurableOperationManager|undefined;
  try {
    const pairing=f.store.requestPairing(context);
    const cutover={stateRoot:f.root,attemptKey:"expired-prepared-drained",
      currentIdentity:{serverInstanceId:"original",sourceCommit:f.contract.baseRevision,buildId:"old",capabilityManifestSha256:"c".repeat(64)},
      expectedIdentity:{sourceCommit:"b".repeat(40),buildId:"new",capabilityManifestSha256:"d".repeat(64)},
      expiresAt:new Date(f.clock()+30000).toISOString(),
      restart:{buildReady:{verifiedBy:"fixture",verifiedAt:new Date(f.clock()).toISOString(),evidence:"drain rejection fixture"},actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service"},
      finish:{workspaceId:"ws_test",agentId:"agt_test"}};
    const contract={...f.contract,scope:[f.root],operations:["cutover_start" as const],cutover,expiresAt:new Date(f.clock()+60000).toISOString()};
    const approved=f.store.approveLocal(pairing.pendingId,contract);
    f.store.redeem(context,pairing.credential);
    const plan=planCutoverStart(f.root,cutover);f.store.prepareEffect(context,plan.subject);
    const config=loadConfig({DEVSPACE_CONFIG_DIR:join(f.root,"config3"),DEVSPACE_ALLOWED_ROOTS:f.workspace,DEVSPACE_WORKTREE_ROOT:join(f.root,"worktrees3"),DEVSPACE_STATE_DIR:f.root,DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-long-enough",PORT:"1"});
    manager=new DurableOperationManager(config,undefined,undefined,undefined,f.store.readers);
    const start=manager.startCutover(cutover,context),id=start.receipt!.cutoverId as string;
    f.store.readers.approveCutoverLifecycle=()=>true;
    manager.drainCutover(id,cutover.currentIdentity,()=>({activeSessions:0,oldestAgeMs:0}),context);
    f.advance(120000);
    const before=JSON.stringify(new CutoverStateStore(f.root).get());
    assert.throws(()=>f.store.recoverExpiredPreparedCutoverLocal({cutoverId:id,carrierId:approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:id}),/non-prepared|drain/i);
    assert.equal(JSON.stringify(new CutoverStateStore(f.root).get()),before);
    assert.equal(f.store.ownership.get((start.request.coordinationBinding as {leaseId:string}).leaseId)?.operationHandle,start.operationId);
  } finally {manager?.close();f.close();}
});

test("expired prepared recovery crash before cutover close keeps the global fence closed",()=>{
  const f=fixture();
  const context={clientId:"shared-oauth",sessionId:"expired-prepared-crash-before-close"};
  let manager:DurableOperationManager|undefined;
  const originalRecover=CutoverStateStore.prototype.recoverExpiredPreparedNoEffect;
  try {
    const pairing=f.store.requestPairing(context);
    const cutover={stateRoot:f.root,attemptKey:"expired-prepared-crash-before-close",
      currentIdentity:{serverInstanceId:"original",sourceCommit:f.contract.baseRevision,buildId:"old",capabilityManifestSha256:"c".repeat(64)},
      expectedIdentity:{sourceCommit:"b".repeat(40),buildId:"new",capabilityManifestSha256:"d".repeat(64)},
      expiresAt:new Date(f.clock()+30000).toISOString(),
      restart:{buildReady:{verifiedBy:"fixture",verifiedAt:new Date(f.clock()).toISOString(),evidence:"crash-before-close fixture"},actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service"},
      finish:{workspaceId:"ws_test",agentId:"agt_test"}};
    const contract={...f.contract,scope:[f.root],operations:["cutover_start" as const],cutover,expiresAt:new Date(f.clock()+60000).toISOString()};
    const approved=f.store.approveLocal(pairing.pendingId,contract);f.store.redeem(context,pairing.credential);
    const plan=planCutoverStart(f.root,cutover);const lease=f.store.prepareEffect(context,plan.subject);
    const config=loadConfig({DEVSPACE_CONFIG_DIR:join(f.root,"config4"),DEVSPACE_ALLOWED_ROOTS:f.workspace,DEVSPACE_WORKTREE_ROOT:join(f.root,"worktrees4"),DEVSPACE_STATE_DIR:f.root,DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-long-enough",PORT:"1"});
    manager=new DurableOperationManager(config,undefined,undefined,undefined,f.store.readers);
    const start=manager.startCutover(cutover,context),id=start.receipt!.cutoverId as string;
    f.advance(120000);
    CutoverStateStore.prototype.recoverExpiredPreparedNoEffect=function(){throw new Error("injected-before-cutover-close");};
    assert.throws(()=>f.store.recoverExpiredPreparedCutoverLocal({cutoverId:id,carrierId:approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:id}),/injected-before-cutover-close/);
    CutoverStateStore.prototype.recoverExpiredPreparedNoEffect=originalRecover;
    const stillPrepared=new CutoverStateStore(f.root).get()!;
    assert.equal(stillPrepared.phase,"prepared");
    const terminalLease=f.store.ownership.get(lease.leaseId)!;
    assert.equal(terminalLease.terminalState,"expired_reconciled");
    assert.equal(terminalLease.operationState,"finished");
    assert.equal(terminalLease.operationHandle,undefined);
    assert.notEqual(manager.store.getByOperationId(start.operationId)?.receipt?.lifecycleTerminal,true);
    const recovered=f.store.recoverExpiredPreparedCutoverLocal({cutoverId:id,carrierId:approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:id});
    assert.equal(recovered.cutover.phase,"closed");
    assert.equal(recovered.operation.receipt?.lifecycleTerminal,true);
  } finally {CutoverStateStore.prototype.recoverExpiredPreparedNoEffect=originalRecover;manager?.close();f.close();}
});

test("expired prepared recovery crash after cutover close replays only operation finalization",()=>{
  const f=fixture();
  const context={clientId:"shared-oauth",sessionId:"expired-prepared-crash-after-close"};
  let manager:DurableOperationManager|undefined;
  const originalFinish=DurableOperationStore.prototype.finish;
  try {
    const pairing=f.store.requestPairing(context);
    const cutover={stateRoot:f.root,attemptKey:"expired-prepared-crash-after-close",
      currentIdentity:{serverInstanceId:"original",sourceCommit:f.contract.baseRevision,buildId:"old",capabilityManifestSha256:"c".repeat(64)},
      expectedIdentity:{sourceCommit:"b".repeat(40),buildId:"new",capabilityManifestSha256:"d".repeat(64)},
      expiresAt:new Date(f.clock()+30000).toISOString(),
      restart:{buildReady:{verifiedBy:"fixture",verifiedAt:new Date(f.clock()).toISOString(),evidence:"crash-after-close fixture"},actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service"},
      finish:{workspaceId:"ws_test",agentId:"agt_test"}};
    const contract={...f.contract,scope:[f.root],operations:["cutover_start" as const],cutover,expiresAt:new Date(f.clock()+60000).toISOString()};
    const approved=f.store.approveLocal(pairing.pendingId,contract);f.store.redeem(context,pairing.credential);
    const plan=planCutoverStart(f.root,cutover);const lease=f.store.prepareEffect(context,plan.subject);
    const config=loadConfig({DEVSPACE_CONFIG_DIR:join(f.root,"config5"),DEVSPACE_ALLOWED_ROOTS:f.workspace,DEVSPACE_WORKTREE_ROOT:join(f.root,"worktrees5"),DEVSPACE_STATE_DIR:f.root,DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-long-enough",PORT:"1"});
    manager=new DurableOperationManager(config,undefined,undefined,undefined,f.store.readers);
    const start=manager.startCutover(cutover,context),id=start.receipt!.cutoverId as string;
    f.advance(120000);
    let injected=false;
    DurableOperationStore.prototype.finish=function(operationId,patch){
      if(!injected && patch.receipt?.recoveryKind==="expired_prepared_no_effect") {injected=true;throw new Error("injected-after-cutover-close");}
      return originalFinish.call(this,operationId,patch);
    };
    assert.throws(()=>f.store.recoverExpiredPreparedCutoverLocal({cutoverId:id,carrierId:approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:id}),/injected-after-cutover-close/);
    DurableOperationStore.prototype.finish=originalFinish;
    const closed=new CutoverStateStore(f.root).get()!;
    assert.equal(closed.phase,"closed");
    assert.equal(closed.expiredPreparedNoEffect?.terminalReason,"EXPIRED_PREPARED_NO_EFFECT");
    const terminalLease=f.store.ownership.get(lease.leaseId)!;
    assert.equal(terminalLease.terminalState,"expired_reconciled");
    assert.equal(terminalLease.operationHandle,undefined);
    assert.notEqual(manager.store.getByOperationId(start.operationId)?.receipt?.lifecycleTerminal,true);
    const replay=f.store.recoverExpiredPreparedCutoverLocal({cutoverId:id,carrierId:approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:id});
    assert.equal(replay.replayed,true);
    assert.equal(replay.operation.receipt?.lifecycleTerminal,true);
  } finally {DurableOperationStore.prototype.finish=originalFinish;manager?.close();f.close();}
});

test("host-local unexpected replacement recovery closes only an expired drained no-restart generation",async()=>{
  const f=fixture();
  const prepared=await prepareUnexpectedReplacement(f,"unexpected-replacement");
  try {
    assert.throws(
      ()=>f.store.recoverUnexpectedReplacementLocal({
        cutoverId:prepared.id,carrierId:prepared.approved.id,expectedVersion:1,expectedValidityVersion:1,
        confirmCutoverId:prepared.id,observedIdentity:prepared.observed,
      }),
      /expired/i,
    );
    assert.equal(new CutoverStateStore(f.root).get()?.phase,"drained");
    assert.equal(f.store.ownership.get(prepared.preparedLease.leaseId)?.operationHandle,prepared.start.operationId);

    assert.throws(()=>f.store.recoverUnexpectedReplacementLocal({
      cutoverId:prepared.id,carrierId:prepared.approved.id,expectedVersion:1,expectedValidityVersion:1,
      confirmCutoverId:prepared.id,observedIdentity:{...prepared.cutover.expectedIdentity,serverInstanceId:"expected-target"},
    }),/expired|different complete replacement identity/i);
    assert.throws(()=>f.store.recoverUnexpectedReplacementLocal({
      cutoverId:prepared.id,carrierId:prepared.approved.id,expectedVersion:1,expectedValidityVersion:1,
      confirmCutoverId:prepared.id,observedIdentity:{...prepared.observed,serverInstanceId:prepared.cutover.currentIdentity.serverInstanceId},
    }),/expired|different complete replacement identity/i);

    f.advance(120000);
    assert.throws(()=>f.store.recoverUnexpectedReplacementLocal({
      cutoverId:prepared.id,carrierId:prepared.approved.id,expectedVersion:2,expectedValidityVersion:1,
      confirmCutoverId:prepared.id,observedIdentity:prepared.observed,
    }),/version/i);
    assert.throws(()=>f.store.recoverUnexpectedReplacementLocal({
      cutoverId:"wrong-cutover",carrierId:prepared.approved.id,expectedVersion:1,expectedValidityVersion:1,
      confirmCutoverId:"wrong-cutover",observedIdentity:prepared.observed,
    }));

    const recovered=f.store.recoverUnexpectedReplacementLocal({
      cutoverId:prepared.id,carrierId:prepared.approved.id,expectedVersion:1,expectedValidityVersion:1,
      confirmCutoverId:prepared.id,observedIdentity:prepared.observed,
    });
    assert.equal(recovered.replayed,false);
    assert.equal(recovered.cutover.phase,"closed");
    assert.equal(recovered.cutover.reconciliationReceipt?.terminalReason,"UNEXPECTED_REPLACEMENT_IDENTITY");
    assert.equal(recovered.cutover.reconciliationReceipt?.preRestartDrainObserved,true);
    assert.equal(recovered.cutover.restartRequest,undefined);
    assert.deepEqual(recovered.cutover.expectedNewIdentity,prepared.cutover.expectedIdentity);
    assert.deepEqual(recovered.cutover.unexpectedReplacement?.observedIdentity,prepared.observed);
    assert.equal(recovered.cutover.unexpectedReplacement?.restartRequested,false);
    assert.equal(recovered.cutover.unexpectedReplacement?.restartScheduled,false);
    assert.equal(recovered.lease.terminalState,"expired_reconciled");
    assert.equal(recovered.lease.operationState,"finished");
    assert.equal(recovered.lease.operationHandle,undefined);
    assert.equal(recovered.operation.status,"failed");
    assert.equal(recovered.operation.errorCode,"UNEXPECTED_REPLACEMENT_IDENTITY");
    assert.equal(recovered.operation.receipt?.lifecycleTerminal,true);
    assert.equal(recovered.operation.receipt?.recoveryKind,"unexpected_replacement_identity");

    const replay=f.store.recoverUnexpectedReplacementLocal({
      cutoverId:prepared.id,carrierId:prepared.approved.id,expectedVersion:1,expectedValidityVersion:1,
      confirmCutoverId:prepared.id,observedIdentity:prepared.observed,
    });
    assert.equal(replay.replayed,true);
    assert.deepEqual(replay.cutover,recovered.cutover);
    assert.deepEqual(replay.reconciliation,recovered.reconciliation);
  } finally {prepared.manager.close();f.close();}
});

test("unexpected replacement recovery refuses any restart lineage",async()=>{
  const f=fixture();
  const prepared=await prepareUnexpectedReplacement(f,"unexpected-replacement-restart-negative");
  try {
    let scheduled=0;
    await prepared.manager.restartCutover(
      prepared.id,
      prepared.cutover.currentIdentity,
      prepared.cutover.restart.buildReady,
      async()=>({buildReady:true,detail:"exact original target"}),
      {
        actuator:"launchd-self" as const,
        serviceLabel:"test.service",
        launchdTarget:"gui/501/test.service",
        schedule:()=>{scheduled+=1;return {scheduled:true as const,actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service"};},
      },
      prepared.context,
    );
    assert.equal(scheduled,1);
    f.advance(120000);
    assert.throws(()=>f.store.recoverUnexpectedReplacementLocal({
      cutoverId:prepared.id,carrierId:prepared.approved.id,expectedVersion:1,expectedValidityVersion:1,
      confirmCutoverId:prepared.id,observedIdentity:prepared.observed,
    }),/restart lineage/i);
    const stillDrained=new CutoverStateStore(f.root).get()!;
    assert.equal(stillDrained.phase,"drained");
    assert.ok(stillDrained.restartRequest?.restartScheduledAt);
  } finally {prepared.manager.close();f.close();}
});

test("unexpected replacement recovery resumes after lease reconciliation before cutover close",async()=>{
  const f=fixture();
  const prepared=await prepareUnexpectedReplacement(f,"unexpected-replacement-crash-before-close");
  const original=CutoverStateStore.prototype.recoverUnexpectedReplacement;
  try {
    f.advance(120000);
    let injected=false;
    CutoverStateStore.prototype.recoverUnexpectedReplacement=function(...args){
      if(!injected){injected=true;throw new Error("injected-after-unexpected-lease-reconciliation");}
      return original.apply(this,args);
    };
    assert.throws(()=>f.store.recoverUnexpectedReplacementLocal({
      cutoverId:prepared.id,carrierId:prepared.approved.id,expectedVersion:1,expectedValidityVersion:1,
      confirmCutoverId:prepared.id,observedIdentity:prepared.observed,
    }),/injected-after-unexpected-lease-reconciliation/);
    CutoverStateStore.prototype.recoverUnexpectedReplacement=original;

    const partialCutover=new CutoverStateStore(f.root).get()!;
    const partialLease=f.store.ownership.get(prepared.preparedLease.leaseId)!;
    assert.equal(partialCutover.phase,"drained");
    assert.equal(partialCutover.unexpectedReplacement,undefined);
    assert.equal(partialLease.terminalState,"expired_reconciled");
    assert.equal(partialLease.operationState,"finished");
    assert.equal(partialLease.operationHandle,undefined);
    assert.notEqual(prepared.manager.store.getByOperationId(prepared.start.operationId)?.receipt?.lifecycleTerminal,true);

    const resumed=f.store.recoverUnexpectedReplacementLocal({
      cutoverId:prepared.id,carrierId:prepared.approved.id,expectedVersion:1,expectedValidityVersion:1,
      confirmCutoverId:prepared.id,observedIdentity:prepared.observed,
    });
    assert.equal(resumed.replayed,false);
    assert.equal(resumed.cutover.phase,"closed");
    assert.equal(resumed.lease.terminalState,"expired_reconciled");
    assert.equal(resumed.operation.status,"failed");
  } finally {
    CutoverStateStore.prototype.recoverUnexpectedReplacement=original;
    prepared.manager.close();
    f.close();
  }
});

test("unexpected replacement recovery resumes after cutover close before operation finalization",async()=>{
  const f=fixture();
  const prepared=await prepareUnexpectedReplacement(f,"unexpected-replacement-crash-after-close");
  const originalFinish=DurableOperationStore.prototype.finish;
  try {
    f.advance(120000);
    let injected=false;
    DurableOperationStore.prototype.finish=function(operationId,patch){
      if(!injected && patch.receipt?.recoveryKind==="unexpected_replacement_identity"){
        injected=true;
        throw new Error("injected-after-unexpected-cutover-close");
      }
      return originalFinish.call(this,operationId,patch);
    };
    assert.throws(()=>f.store.recoverUnexpectedReplacementLocal({
      cutoverId:prepared.id,carrierId:prepared.approved.id,expectedVersion:1,expectedValidityVersion:1,
      confirmCutoverId:prepared.id,observedIdentity:prepared.observed,
    }),/injected-after-unexpected-cutover-close/);
    DurableOperationStore.prototype.finish=originalFinish;

    const partialCutover=new CutoverStateStore(f.root).get()!;
    const partialLease=f.store.ownership.get(prepared.preparedLease.leaseId)!;
    assert.equal(partialCutover.phase,"closed");
    assert.ok(partialCutover.unexpectedReplacement);
    assert.equal(partialLease.terminalState,"expired_reconciled");
    assert.equal(partialLease.operationHandle,undefined);
    assert.notEqual(prepared.manager.store.getByOperationId(prepared.start.operationId)?.receipt?.lifecycleTerminal,true);

    const resumed=f.store.recoverUnexpectedReplacementLocal({
      cutoverId:prepared.id,carrierId:prepared.approved.id,expectedVersion:1,expectedValidityVersion:1,
      confirmCutoverId:prepared.id,observedIdentity:prepared.observed,
    });
    assert.equal(resumed.replayed,true);
    assert.equal(resumed.cutover.phase,"closed");
    assert.equal(resumed.operation.status,"failed");
    assert.equal(resumed.operation.receipt?.lifecycleTerminal,true);
  } finally {
    DurableOperationStore.prototype.finish=originalFinish;
    prepared.manager.close();
    f.close();
  }
});

test("host-local capability expectation mismatch recovery closes the failed cutover and releases its lease",async()=>{
  const f=fixture();
  const context={clientId:"shared-oauth",sessionId:"capability-mismatch-controller"};
  let manager:DurableOperationManager|undefined;
  try {
    const pairing=f.store.requestPairing(context);
    const predecessorCapability="c".repeat(64);
    const observedCapability="e".repeat(64);
    const cutover={stateRoot:f.root,attemptKey:"capability-mismatch",
      currentIdentity:{serverInstanceId:"original",sourceCommit:f.contract.baseRevision,buildId:"old",capabilityManifestSha256:predecessorCapability},
      expectedIdentity:{sourceCommit:"b".repeat(40),buildId:"new",capabilityManifestSha256:predecessorCapability},
      expiresAt:new Date(f.clock()+120000).toISOString(),
      restart:{buildReady:{verifiedBy:"fixture",verifiedAt:new Date(f.clock()).toISOString(),evidence:"exact target build"},actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service"},
      finish:{workspaceId:"ws_test",agentId:"agt_test"}};
    const contract={...f.contract,scope:[f.root],operations:["cutover_start" as const],cutover,expiresAt:new Date(f.clock()+180000).toISOString()};
    const approved=f.store.approveLocal(pairing.pendingId,contract);
    f.store.redeem(context,pairing.credential);
    const plan=planCutoverStart(f.root,cutover);
    const preparedLease=f.store.prepareEffect(context,plan.subject);
    const config=loadConfig({DEVSPACE_CONFIG_DIR:join(f.root,"config-cap-mismatch"),DEVSPACE_ALLOWED_ROOTS:f.workspace,DEVSPACE_WORKTREE_ROOT:join(f.root,"worktrees-cap-mismatch"),DEVSPACE_STATE_DIR:f.root,DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-long-enough",PORT:"1"});
    manager=new DurableOperationManager(config,undefined,undefined,undefined,f.store.readers);
    const start=manager.startCutover(cutover,context),id=start.receipt!.cutoverId as string;
    manager.drainCutover(id,cutover.currentIdentity,()=>({activeSessions:0,oldestAgeMs:0}),context);
    const actuator={actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service",schedule:()=>({scheduled:true as const,actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service"})};
    await manager.restartCutover(id,cutover.currentIdentity,cutover.restart.buildReady,async()=>({buildReady:true,detail:"exact target build"}),actuator,context);
    const before=new CutoverStateStore(f.root).get()!;
    assert.equal(before.phase,"drained");
    assert.ok(before.restartRequest?.restartScheduledAt);
    assert.equal(f.store.ownership.get(preparedLease.leaseId)?.operationHandle,start.operationId);

    const observed={serverInstanceId:"replacement",sourceCommit:cutover.expectedIdentity.sourceCommit,buildId:cutover.expectedIdentity.buildId,capabilityManifestSha256:observedCapability};
    for (const wrongIdentity of [
      {...observed,sourceCommit:"f".repeat(40)},
      {...observed,buildId:"wrong-build"},
    ]) {
      assert.throws(()=>f.store.recoverCapabilityExpectationMismatchLocal({cutoverId:id,carrierId:approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:id,observedIdentity:wrongIdentity}),/exact replacement source\/build/i);
    }
    assert.throws(()=>f.store.recoverCapabilityExpectationMismatchLocal({cutoverId:id,carrierId:approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:id,observedIdentity:{...cutover.expectedIdentity,serverInstanceId:"replacement-with-expected-capability"}}),/capability/i);
    assert.throws(()=>f.store.recoverCapabilityExpectationMismatchLocal({cutoverId:"wrong-cutover",carrierId:approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:"wrong-cutover",observedIdentity:observed}));
    assert.throws(()=>f.store.recoverCapabilityExpectationMismatchLocal({cutoverId:id,carrierId:"wrong-carrier",expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:id,observedIdentity:observed}));
    assert.throws(()=>f.store.recoverCapabilityExpectationMismatchLocal({cutoverId:id,carrierId:approved.id,expectedVersion:2,expectedValidityVersion:1,confirmCutoverId:id,observedIdentity:observed}),/version/i);
    assert.throws(()=>f.store.recoverCapabilityExpectationMismatchLocal({cutoverId:id,carrierId:approved.id,expectedVersion:1,expectedValidityVersion:2,confirmCutoverId:id,observedIdentity:observed}),/version/i);
    const originalGet=CutoverStateStore.prototype.get;
    let forgeRequestHash=true;
    CutoverStateStore.prototype.get=function(...args){
      const record=originalGet.apply(this,args);
      if(forgeRequestHash && record?.cutoverId===id && record.coordinationBinding){
        forgeRequestHash=false;
        return {...record,coordinationBinding:{...record.coordinationBinding,requestHash:"0".repeat(64)}};
      }
      return record;
    };
    try {
      assert.throws(()=>f.store.recoverCapabilityExpectationMismatchLocal({cutoverId:id,carrierId:approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:id,observedIdentity:observed}),/operation correlation changed/i);
    } finally {CutoverStateStore.prototype.get=originalGet;}
    assert.equal(new CutoverStateStore(f.root).get()?.phase,"drained");
    assert.equal(f.store.ownership.get(preparedLease.leaseId)?.operationHandle,start.operationId);

    const recovered=f.store.recoverCapabilityExpectationMismatchLocal({cutoverId:id,carrierId:approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:id,observedIdentity:observed});
    assert.equal(recovered.replayed,false);
    assert.equal(recovered.cutover.phase,"closed");
    assert.equal(recovered.cutover.reconciliationReceipt?.terminalReason,"CAPABILITY_EXPECTATION_MISMATCH");
    assert.equal(recovered.cutover.reconciliationReceipt?.preRestartDrainObserved,true);
    assert.equal(recovered.cutover.capabilityExpectationMismatch?.observedIdentity.capabilityManifestSha256,observedCapability);
    assert.equal(recovered.lease.terminalState,"released");
    assert.equal(recovered.lease.operationState,"finished");
    assert.equal(recovered.lease.operationHandle,undefined);
    assert.equal(recovered.operation.status,"failed");
    assert.equal(recovered.operation.errorCode,"CAPABILITY_EXPECTATION_MISMATCH");
    assert.equal(recovered.operation.receipt?.lifecycleTerminal,true);
    assert.equal(recovered.operation.receipt?.recoveryKind,"capability_expectation_mismatch");

    const replay=f.store.recoverCapabilityExpectationMismatchLocal({cutoverId:id,carrierId:approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:id,observedIdentity:observed});
    assert.equal(replay.replayed,true);
    assert.deepEqual(replay.cutover,recovered.cutover);
    assert.deepEqual(replay.reconciliation,recovered.reconciliation);
    assert.equal(replay.lease.terminalState,"released");
  } finally {manager?.close();f.close();}
});

test("host-local capability expectation mismatch recovery accepts an arbitrary stale expected capability",async()=>{
  const f=fixture();
  const context={clientId:"shared-oauth",sessionId:"capability-mismatch-not-predecessor"};
  let manager:DurableOperationManager|undefined;
  try {
    const pairing=f.store.requestPairing(context);
    const cutover={stateRoot:f.root,attemptKey:"capability-mismatch-not-predecessor",
      currentIdentity:{serverInstanceId:"original",sourceCommit:f.contract.baseRevision,buildId:"old",capabilityManifestSha256:"c".repeat(64)},
      expectedIdentity:{sourceCommit:"b".repeat(40),buildId:"new",capabilityManifestSha256:"d".repeat(64)},
      expiresAt:new Date(f.clock()+120000).toISOString(),
      restart:{buildReady:{verifiedBy:"fixture",verifiedAt:new Date(f.clock()).toISOString(),evidence:"different expected capability"},actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service"},
      finish:{workspaceId:"ws_test",agentId:"agt_test"}};
    const contract={...f.contract,scope:[f.root],operations:["cutover_start" as const],cutover,expiresAt:new Date(f.clock()+180000).toISOString()};
    const approved=f.store.approveLocal(pairing.pendingId,contract);
    f.store.redeem(context,pairing.credential);
    const plan=planCutoverStart(f.root,cutover);
    const lease=f.store.prepareEffect(context,plan.subject);
    const config=loadConfig({DEVSPACE_CONFIG_DIR:join(f.root,"config-cap-mismatch-negative"),DEVSPACE_ALLOWED_ROOTS:f.workspace,DEVSPACE_WORKTREE_ROOT:join(f.root,"worktrees-cap-mismatch-negative"),DEVSPACE_STATE_DIR:f.root,DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-long-enough",PORT:"1"});
    manager=new DurableOperationManager(config,undefined,undefined,undefined,f.store.readers);
    const start=manager.startCutover(cutover,context),id=start.receipt!.cutoverId as string;
    manager.drainCutover(id,cutover.currentIdentity,()=>({activeSessions:0,oldestAgeMs:0}),context);
    const actuator={actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service",schedule:()=>({scheduled:true as const,actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service"})};
    await manager.restartCutover(id,cutover.currentIdentity,cutover.restart.buildReady,async()=>({buildReady:true,detail:"different expected capability"}),actuator,context);
    const observed={serverInstanceId:"replacement",sourceCommit:cutover.expectedIdentity.sourceCommit,buildId:cutover.expectedIdentity.buildId,capabilityManifestSha256:"e".repeat(64)};
    const recovered=f.store.recoverCapabilityExpectationMismatchLocal({cutoverId:id,carrierId:approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:id,observedIdentity:observed});
    assert.equal(recovered.replayed,false);
    assert.equal(recovered.cutover.phase,"closed");
    assert.equal(recovered.cutover.expectedNewIdentity.capabilityManifestSha256,"d".repeat(64));
    assert.equal(recovered.cutover.capabilityExpectationMismatch?.expectedIdentity.capabilityManifestSha256,"d".repeat(64));
    assert.equal(recovered.cutover.capabilityExpectationMismatch?.oldServerIdentity.capabilityManifestSha256,"c".repeat(64));
    assert.equal(recovered.cutover.capabilityExpectationMismatch?.observedIdentity.capabilityManifestSha256,"e".repeat(64));
    assert.equal(recovered.operation.errorMessage,"Replacement source/build matched, but the observed capability manifest differed from the approved expected capability.");
    assert.equal(recovered.lease.terminalState,"released");
  } finally {manager?.close();f.close();}
});



for (const authorityRace of ["reauthorize", "revoke"] as const) test(`capability mismatch recovery fails closed when carrier ${authorityRace} races before reconciliation`, async () => {
  const f=fixture();
  const prepared=await prepareCapabilityMismatch(f,`capability-mismatch-${authorityRace}-race`,"d".repeat(64),"e".repeat(64));
  const beforeCutover=new CutoverStateStore(f.root).get()!;
  const beforeLease=f.store.ownership.get(prepared.preparedLease.leaseId)!;
  const originalReconcile=ControlPlaneOwnershipStore.prototype.reconcile;
  let injected=false;
  try {
    ControlPlaneOwnershipStore.prototype.reconcile=function(...args){
      if(!injected){
        injected=true;
        if(authorityRace==="reauthorize") {
          f.store.reauthorizeLocal(prepared.approved.id,1,new Date(f.clock()+240000).toISOString());
        } else {
          f.store.revokeLocal(prepared.approved.id,1);
        }
      }
      return originalReconcile.apply(this,args);
    };
    assert.throws(
      ()=>f.store.recoverCapabilityExpectationMismatchLocal({
        cutoverId:prepared.id,carrierId:prepared.approved.id,expectedVersion:1,expectedValidityVersion:1,
        confirmCutoverId:prepared.id,observedIdentity:prepared.observed,
      }),
      /carrier authority changed|identity or version changed|validity|revoked|CAS_CONFLICT/i,
    );
  } finally {
    ControlPlaneOwnershipStore.prototype.reconcile=originalReconcile;
  }
  const afterCutover=new CutoverStateStore(f.root).get()!;
  const afterLease=f.store.ownership.get(prepared.preparedLease.leaseId)!;
  assert.deepEqual(afterCutover,beforeCutover);
  assert.equal(afterLease.operationHandle,beforeLease.operationHandle);
  assert.equal(afterLease.operationState,beforeLease.operationState);
  assert.equal(afterLease.terminalState,beforeLease.terminalState);
  assert.equal(afterLease.version,beforeLease.version);
  assert.equal(prepared.manager.store.getByOperationId(prepared.start.operationId)?.receipt?.lifecycleTerminal,false);
  prepared.manager.close();
  f.close();
});

test("capability mismatch recovery resumes after lease reconciliation before cutover close",async()=>{
  const f=fixture();
  const prepared=await prepareCapabilityMismatch(f,"capability-mismatch-crash-before-close","d".repeat(64),"e".repeat(64));
  try {
    const originalRecovery=CutoverStateStore.prototype.recoverCapabilityExpectationMismatch;
    let injected=false;
    CutoverStateStore.prototype.recoverCapabilityExpectationMismatch=function(...args){
      if(!injected){injected=true;throw new Error("injected-after-lease-reconciliation");}
      return originalRecovery.apply(this,args);
    };
    try {
      assert.throws(()=>f.store.recoverCapabilityExpectationMismatchLocal({cutoverId:prepared.id,carrierId:prepared.approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:prepared.id,observedIdentity:prepared.observed}),/injected-after-lease-reconciliation/);
    } finally {CutoverStateStore.prototype.recoverCapabilityExpectationMismatch=originalRecovery;}

    const partialCutover=new CutoverStateStore(f.root).get()!;
    const partialLease=f.store.ownership.get(prepared.preparedLease.leaseId)!;
    assert.equal(partialCutover.phase,"drained");
    assert.equal(partialCutover.capabilityExpectationMismatch,undefined);
    assert.equal(partialLease.operationHandle,undefined);
    assert.equal(partialLease.operationState,"finished");
    assert.equal(partialLease.terminalState,undefined);
    assert.equal(prepared.scheduled(),1);

    const resumed=f.store.recoverCapabilityExpectationMismatchLocal({cutoverId:prepared.id,carrierId:prepared.approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:prepared.id,observedIdentity:prepared.observed});
    assert.equal(resumed.replayed,false);
    assert.equal(resumed.cutover.phase,"closed");
    assert.equal(resumed.lease.terminalState,"released");
    assert.equal(resumed.operation.status,"failed");
    assert.equal(prepared.scheduled(),1);
  } finally {prepared.manager.close();f.close();}
});

test("capability mismatch recovery resumes after cutover close before operation finalization",async()=>{
  const f=fixture();
  const prepared=await prepareCapabilityMismatch(f,"capability-mismatch-crash-after-close","d".repeat(64),"e".repeat(64));
  try {
    const originalFinish=DurableOperationStore.prototype.finish;
    let injected=false;
    DurableOperationStore.prototype.finish=function(...args){
      if(!injected && args[1]?.receipt?.recoveryKind==="capability_expectation_mismatch"){
        injected=true;
        throw new Error("injected-after-cutover-close");
      }
      return originalFinish.apply(this,args);
    };
    try {
      assert.throws(()=>f.store.recoverCapabilityExpectationMismatchLocal({cutoverId:prepared.id,carrierId:prepared.approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:prepared.id,observedIdentity:prepared.observed}),/injected-after-cutover-close/);
    } finally {DurableOperationStore.prototype.finish=originalFinish;}

    const partialCutover=new CutoverStateStore(f.root).get()!;
    const partialLease=f.store.ownership.get(prepared.preparedLease.leaseId)!;
    assert.equal(partialCutover.phase,"closed");
    assert.ok(partialCutover.capabilityExpectationMismatch);
    assert.equal(partialLease.operationHandle,undefined);
    assert.equal(partialLease.terminalState,undefined);
    assert.notEqual(prepared.manager.store.getByOperationId(prepared.start.operationId)?.receipt?.lifecycleTerminal,true);
    assert.equal(prepared.scheduled(),1);

    const resumed=f.store.recoverCapabilityExpectationMismatchLocal({cutoverId:prepared.id,carrierId:prepared.approved.id,expectedVersion:1,expectedValidityVersion:1,confirmCutoverId:prepared.id,observedIdentity:prepared.observed});
    assert.equal(resumed.replayed,true);
    assert.equal(resumed.cutover.phase,"closed");
    assert.equal(resumed.lease.terminalState,"released");
    assert.equal(resumed.operation.status,"failed");
    assert.equal(resumed.operation.receipt?.lifecycleTerminal,true);
    assert.equal(prepared.scheduled(),1);
  } finally {prepared.manager.close();f.close();}
});

test("completion readers remain paired, scoped and independent of candidate base",()=>{
  const selection={goal:"issue62",subject:"delivery",candidate:"b".repeat(40)};
  const readers={readContract:(s:typeof selection)=>({...s}),readEvidence:()=>[]};
  const entry={repository:"James3014/devspace",goal:"issue62",subject:"delivery",readers};
  const f=fixture([entry]);try {
    assert.deepEqual(f.store.readers.readCompletionContract!(f.controller,selection),selection);
    readers.readContract=()=>{throw new Error("replacement must not run");};
    entry.subject="changed";
    assert.deepEqual(f.store.readers.readCompletionContract!(f.controller,selection),selection);
    assert.throws(()=>f.store.readers.readCompletionContract!(f.worker,selection));
    assert.throws(()=>f.store.readers.readCompletionContract!(f.controller,{...selection,goal:"other"}));
    assert.throws(()=>f.store.readers.readCompletionContract!(f.controller,{...selection,subject:"other"}));
    f.advance();
    assert.throws(()=>f.store.readers.readCompletionEvidence!(f.controller,selection));
  } finally {f.close();}
});
test("completion reader cannot return accepted evidence after revoking its carrier",()=>{
  let invoked=false;
  let revoke=()=>{};
  const f=fixture([{repository:"James3014/devspace",goal:"issue62",subject:"delivery",readers:{readContract:()=>({}),readEvidence:()=>{invoked=true;revoke();return [];}}}]);
  try {
    revoke=()=>{f.store.revokeLocal(f.approved.id,1);};
    assert.throws(()=>f.store.readers.readCompletionEvidence!(f.controller,{goal:"issue62",subject:"delivery",candidate:"b".repeat(40)}));
    assert.equal(invoked,true);
  } finally {f.close();}
});
test("completion binding rejects foreign repositories and ambiguous configuration",()=>{
  const binding={repository:"other/repository",goal:"issue62",subject:"delivery",readers:{readContract:()=>({}),readEvidence:()=>[]}};
  const f=fixture([binding]);try {
    assert.throws(()=>f.store.readers.readCompletionContract!(f.controller,{goal:"issue62",subject:"delivery",candidate:"b".repeat(40)}));
    assert.throws(()=>new CarrierBindingStore(f.root,Date.now,[binding,{...binding,repository:"OTHER/REPOSITORY"}]),/Duplicate/);
    assert.throws(()=>new CarrierBindingStore(f.root,Date.now,[{...binding,readers:{} as never}]),/Invalid/);
  } finally {f.close();}
});
test("completion selectors are immutable and expiry during callback rejects its output",()=>{
  let advance=()=>{},called=false;
  const f=fixture([{repository:"James3014/devspace",goal:"issue62",subject:"delivery",readers:{
    readContract:s=>{assert.equal(Object.isFrozen(s),true);return s;},
    readEvidence:()=>{called=true;advance();return [];},
  }}]);try {
    const selection={goal:"issue62",subject:"delivery",candidate:"b".repeat(40)};
    assert.deepEqual(f.store.readers.readCompletionContract!(f.controller,selection),selection);
    advance=f.advance;
    assert.throws(()=>f.store.readers.readCompletionEvidence!(f.controller,selection));
    assert.equal(called,true);
  } finally {f.close();}
});
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

test("handoff denies a pinned operation and permits terminal replay after predecessor revocation",async()=>{
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
    const packet={
      resource:lease.resource,baseRevision:base,scope:lease.scope,candidateRevision:base,
      liveOperation:lease.operation,liveHandle:plan.subject.operationId,checkpoint:"test-started",
      grantDependency:from.grant,grantVersion:1,recipientGrant:to.grant,recipientGrantVersion:1,
      forbiddenOverlap:lease.scope,tests:["terminal-test"],evidence:["test-command-started"],remainingGap:"wait for terminal proof",nextGate:"reconcile",expiresAt:lease.expiresAt,
    };
    const beforeHandoff=f.snapshot();
    assert.throws(()=>manager!.handoff(lease.leaseId,pinned.version,to.id,packet,sender), /reconcile/);
    assert.equal(f.snapshot(),beforeHandoff);
    assert.equal(f.store.ownership.get(lease.leaseId)?.ownerThread,from.id);
    finish();
    const completed=await running;
    assert.equal(completed.status,"succeeded");
    const terminalLease=f.store.ownership.get(lease.leaseId)!;
    manager.handoff(lease.leaseId,terminalLease.version,to.id,{...packet,liveHandle:"",remainingGap:"",nextGate:"continue"},sender);
    assert.equal(f.store.readers.resolveEffectBinding(sender,plan.subject),undefined);
    assert.equal(f.store.readers.resolveEffectBinding(successor,plan.subject)?.leaseId,lease.leaseId);
    await assert.rejects(()=>manager!.reconcile(plan.subject.operationId,sender));
    f.store.revokeLocal(from.id,1);
    const recovered=await manager.dependencySync(input,successor);
    assert.deepEqual(recovered,completed);
    const terminalSnapshot=f.snapshot();
    assert.deepEqual(await manager.dependencySync(input,successor),recovered);
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

test("local credential rotation is CAS-bound, idempotent, and preserves carrier authority",()=>{
  const f=fixture();try {
    const before=f.store.status(f.controller);
    const state=f.store.credentialRotationStateLocal(f.approved.id,before.version,before.validity.version);
    assert.deepEqual(state.carrier,before);
    assert.match(state.credentialHash,/^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(state).includes(f.request.credential));

    const credential="A".repeat(43);
    const rotated=f.store.rotateCredentialLocal(f.approved.id,before.version,before.validity.version,state.credentialHash,credential);
    assert.equal(rotated.replayed,false);
    assert.deepEqual(rotated.carrier,before);
    assert.match(rotated.credentialHash,/^[a-f0-9]{64}$/);
    assert.equal(Object.prototype.hasOwnProperty.call(rotated,"credential"),false);
    assert.deepEqual(f.store.inspectLocal(f.approved.id),{
      id:before.id,parentId:before.parentId,version:before.version,revoked:false,contract:before.contract,validity:before.validity,
    });

    const replay=f.store.rotateCredentialLocal(f.approved.id,before.version,before.validity.version,state.credentialHash,credential);
    assert.equal(replay.replayed,true);
    assert.deepEqual(replay.carrier,before);
    assert.equal(replay.credentialHash,rotated.credentialHash);
    assert.throws(()=>f.store.rotateCredentialLocal(f.approved.id,before.version,before.validity.version,state.credentialHash,"B".repeat(43)));

    f.store.forgetSession(f.controller.sessionId);
    assert.throws(()=>f.store.redeem(f.controller,f.request.credential));
    const replacement={clientId:f.controller.clientId,sessionId:"replacement-session"};
    assert.deepEqual(f.store.redeem(replacement,credential),before);
    assert.throws(()=>f.store.redeem({clientId:"different-oauth",sessionId:"other"},credential));
    assert.throws(()=>f.store.credentialRotationStateLocal(f.approved.id,before.version+1,before.validity.version));
    assert.throws(()=>f.store.rotateCredentialLocal(f.approved.id,before.version,before.validity.version+1,rotated.credentialHash,credential));
    assert.throws(()=>f.store.rotateCredentialLocal(f.approved.id,before.version,before.validity.version,"bad",credential));
    assert.throws(()=>f.store.rotateCredentialLocal(f.approved.id,before.version,before.validity.version,rotated.credentialHash,"bad"));

    f.store.revokeLocal(f.approved.id,before.version);
    assert.throws(()=>f.store.rotateCredentialLocal(f.approved.id,before.version,before.validity.version,rotated.credentialHash,credential));
  } finally {f.close();}
});

test("owner-approved recovery rebinds one pending verifier to the same durable carrier",()=>{
  const f=fixture();try {
    const before=f.store.status(f.controller);
    const carrierRowsBefore=f.db.sqlite.prepare("select count(*) as count from carrier_bindings").get() as {count:number};
    f.store.forgetSession(f.controller.sessionId);
    const fresh={clientId:f.controller.clientId,sessionId:"fresh-recovery-session"};
    const request=f.store.requestPairing(fresh);
    assert.throws(()=>f.store.redeem(fresh,{pendingId:request.pendingId}));

    const recovered=f.store.recoverLocal(request.pendingId,before.id,before.version,before.validity.version);
    assert.equal(recovered.replayed,false);
    assert.deepEqual(recovered.carrier,before);
    assert.deepEqual(f.store.inspectLocal(before.id),{
      id:before.id,parentId:before.parentId,version:before.version,revoked:false,contract:before.contract,validity:before.validity,
    });
    assert.equal((f.db.sqlite.prepare("select count(*) as count from carrier_bindings").get() as {count:number}).count,carrierRowsBefore.count);
    assert.throws(()=>f.store.redeem({clientId:f.controller.clientId,sessionId:"old-verifier"},f.request.credential));
    assert.deepEqual(f.store.redeem(fresh,{pendingId:request.pendingId}),before);

    const replay=f.store.recoverLocal(request.pendingId,before.id,before.version,before.validity.version);
    assert.equal(replay.replayed,true);
    assert.deepEqual(replay.carrier,before);
    assert.throws(()=>f.store.recoverLocal(request.pendingId,"carrier_missing",before.version,before.validity.version));

    const foreign={clientId:"different-oauth",sessionId:"foreign-recovery"};
    const foreignRequest=f.store.requestPairing(foreign);
    assert.throws(()=>f.store.recoverLocal(foreignRequest.pendingId,before.id,before.version,before.validity.version));
  } finally {f.close();}
});

test("carrier CLI persists a private replayable rotation intent and never prints the verifier",()=>{
  const f=fixture();try {
    const cli=fileURLToPath(new URL("./cli.ts",import.meta.url));
    const env={...process.env,
      DEVSPACE_CONFIG_DIR:join(f.root,"config"),DEVSPACE_STATE_DIR:f.root,DEVSPACE_ALLOWED_ROOTS:f.root,
      DEVSPACE_WORKTREE_ROOT:join(f.root,"worktrees"),DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-long-enough",PORT:"1"};
    const before=f.store.status(f.controller), intentPath=join(f.root,"rotation-intent.json");
    const args=["--import","tsx",cli,"carrier","rotate-credential",before.id,"--version",String(before.version),"--validity-version",String(before.validity.version),"--credential-file",intentPath,"--confirm",before.id];
    const output=execFileSync(process.execPath,args,{env,encoding:"utf8"});
    const rotated=JSON.parse(output) as {carrier:typeof before;credentialHash:string;replayed:boolean;credentialFile:string};
    const intent=JSON.parse(readFileSync(intentPath,"utf8")) as {credential:string;expectedCredentialHash:string};
    assert.deepEqual(rotated.carrier,before);
    assert.equal(rotated.replayed,false);
    assert.equal(rotated.credentialFile,intentPath);
    assert.match(rotated.credentialHash,/^[a-f0-9]{64}$/);
    assert.match(intent.credential,/^[A-Za-z0-9_-]{43}$/);
    assert.equal(Object.prototype.hasOwnProperty.call(rotated,"credential"),false);
    assert.equal(output.includes(intent.credential),false);
    if(process.platform!=="win32") assert.equal(lstatSync(intentPath).mode & 0o077,0);

    const replayOutput=execFileSync(process.execPath,args,{env,encoding:"utf8"});
    const replay=JSON.parse(replayOutput) as typeof rotated;
    assert.equal(replay.replayed,true);
    assert.equal(replay.credentialHash,rotated.credentialHash);
    assert.equal((JSON.parse(readFileSync(intentPath,"utf8")) as {credential:string}).credential,intent.credential);

    f.store.forgetSession(f.controller.sessionId);
    assert.throws(()=>f.store.redeem(f.controller,f.request.credential));
    assert.deepEqual(f.store.redeem({clientId:f.controller.clientId,sessionId:"cli-replacement"},intent.credential),before);
    assert.throws(()=>execFileSync(process.execPath,[...args.slice(0,-1),"wrong-carrier"],{env,stdio:"pipe"}));

    const insecurePath=join(f.root,"insecure-intent.json");
    writeFileSync(insecurePath,readFileSync(intentPath));
    if(process.platform!=="win32") chmodSync(insecurePath,0o644);
    assert.throws(()=>execFileSync(process.execPath,[...args.slice(0,11),insecurePath,...args.slice(12)],{env,stdio:"pipe"}));
    if(process.platform!=="win32") {
      const symlinkPath=join(f.root,"symlink-intent.json");
      symlinkSync(intentPath,symlinkPath);
      assert.throws(()=>execFileSync(process.execPath,[...args.slice(0,11),symlinkPath,...args.slice(12)],{env,stdio:"pipe"}));
    }
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

test("coordination_resume supports pendingId on same session once approved and gives diagnostic error when unapproved", () => {
  const f = fixture();
  try {
    const context = { clientId: "shared-oauth", sessionId: "new-session" };
    const pairing = f.store.requestPairing(context);

    // 1. Calling redeem before approval produces diagnostic error with approval command
    assert.throws(
      () => f.store.redeem(context, { pendingId: pairing.pendingId }),
      (err: any) => {
        assert.equal(err.code, "AUTHORITY_REQUIRED");
        assert.match(err.message, /awaiting host Owner approval/);
        assert.match(err.message, new RegExp(pairing.pendingId));
        return true;
      },
    );

    // Calling with credential token also gives diagnostic error
    assert.throws(
      () => f.store.redeem(context, pairing.credential),
      (err: any) => {
        assert.equal(err.code, "AUTHORITY_REQUIRED");
        assert.match(err.message, /awaiting host Owner approval/);
        return true;
      },
    );

    // 2. Approve via local Owner CLI
    const contract: CarrierContract = {
      repository: "James3014/devspace",
      goal: "issue156",
      role: "controller",
      scope: [f.workspace],
      baseRevision: "b".repeat(40),
      operations: ["dependency_sync"],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    const approved = f.store.approveLocal(pairing.pendingId, contract);

    // 3. Different session cannot hijack pendingId without credential token
    const otherSession = { clientId: "shared-oauth", sessionId: "attacker-session" };
    assert.throws(
      () => f.store.redeem(otherSession, { pendingId: pairing.pendingId }),
      /verification token is required to resume from another session/,
    );

    // 4. Same session can resume using pendingId directly without exposing credential
    const resumed = f.store.redeem(context, { pendingId: pairing.pendingId });
    assert.equal(resumed.id, approved.id);
  } finally {
    f.close();
  }
});


test("owner-local drained restart reuses exact carrier authority without MCP session affinity", async () => {
  const f=fixture();
  try {
    const context={clientId:"shared-oauth",sessionId:"cutover-restart-controller"};
    const pairing=f.store.requestPairing(context);
    const cutover={
      stateRoot:f.root,
      attemptKey:"bound-local-restart",
      currentIdentity:{
        serverInstanceId:"live-old",
        sourceCommit:f.contract.baseRevision,
        buildId:"old-build",
        capabilityManifestSha256:"c".repeat(64),
      },
      expectedIdentity:{
        sourceCommit:"b".repeat(40),
        buildId:"new-build",
        capabilityManifestSha256:"d".repeat(64),
      },
      expiresAt:new Date(f.clock()+30000).toISOString(),
      restart:{
        buildReady:{
          verifiedBy:"independent",
          verifiedAt:new Date(f.clock()).toISOString(),
          evidence:"exact target package",
        },
        actuator:"launchd-self" as const,
        serviceLabel:"test.service",
        launchdTarget:"gui/501/test.service",
      },
      finish:{workspaceId:"ws_test",agentId:"agt_test"},
    };
    const contract:CarrierContract={
      ...f.contract,
      scope:[f.root],
      operations:["cutover_start"],
      expiresAt:new Date(f.clock()+60000).toISOString(),
      cutover,
    };
    const approved=f.store.approveLocal(pairing.pendingId,contract);
    f.store.redeem(context,pairing.credential);
    const plan=planCutoverStart(f.root,cutover);
    f.store.prepareEffect(context,plan.subject);
    const config=loadConfig({
      DEVSPACE_CONFIG_DIR:join(f.root,"config"),
      DEVSPACE_ALLOWED_ROOTS:f.workspace,
      DEVSPACE_WORKTREE_ROOT:join(f.root,"worktrees"),
      DEVSPACE_STATE_DIR:f.root,
      DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-long-enough",
      HOST:"127.0.0.1",
      PORT:"7677",
    });
    const setup=new DurableOperationManager(config,undefined,undefined,undefined,f.store.readers);
    const start=setup.startCutover(cutover,context);
    const cutoverId=start.receipt!.cutoverId as string;
    setup.drainCutover(cutoverId,cutover.currentIdentity,()=>({activeSessions:0,oldestAgeMs:0}),context);
    setup.close();

    f.store.forgetSession(context.sessionId);
    assert.throws(()=>f.store.status(context),/paired carrier/i);

    const drainedSnapshot=f.snapshot();
    const health=()=>({
      build:{source_commit:cutover.currentIdentity.sourceCommit,build_id:cutover.currentIdentity.buildId,pid:4321},
      capabilityManifest:{manifestSha256:cutover.currentIdentity.capabilityManifestSha256},
      mcp:{serverInstanceId:cutover.currentIdentity.serverInstanceId,cutoverMode:"drain",reconciliationRequired:true},
    });
    const actuatorCalls: Array<{livePid:number;serviceLabel:string;launchdTarget:string}>=[];
    let scheduled=0;
    const dependencies={
      readHealth:async()=>health(),
      probeTarget:async()=>({buildReady:true,detail:"exact package"}),
      createActuator:(options:{livePid:number;serviceLabel:string;launchdTarget:string})=>{
        actuatorCalls.push(options);
        return {
          actuator:"launchd-self" as const,
          serviceLabel:options.serviceLabel,
          launchdTarget:options.launchdTarget,
          schedule:()=>{
            scheduled+=1;
            return {scheduled:true as const,actuator:"launchd-self" as const,serviceLabel:options.serviceLabel,launchdTarget:options.launchdTarget};
          },
        };
      },
    };

    await assert.rejects(
      performLocalBoundCutoverRestart({
        config,cutoverId,carrierId:approved.id,expectedCarrierVersion:2,expectedValidityVersion:1,carrierCredential:pairing.credential,
        confirmCutoverId:cutoverId,packageRoot:f.root,
      },dependencies),
      /version changed/i,
    );
    assert.equal(f.snapshot(),drainedSnapshot);

    await assert.rejects(
      performLocalBoundCutoverRestart({
        config,cutoverId,carrierId:approved.id,expectedCarrierVersion:1,expectedValidityVersion:1,
        carrierCredential:"x".repeat(43),
        confirmCutoverId:cutoverId,packageRoot:f.root,
      },dependencies),
      /credential/i,
    );
    assert.equal(f.snapshot(),drainedSnapshot);

    await assert.rejects(
      performLocalBoundCutoverRestart({
        config,cutoverId,carrierId:approved.id,expectedCarrierVersion:1,expectedValidityVersion:1,carrierCredential:pairing.credential,
        confirmCutoverId:cutoverId,packageRoot:f.root,
      },{
        ...dependencies,
        readHealth:async()=>({
          ...health(),
          build:{...health().build,build_id:"wrong-build"},
        }),
      }),
      /does not match the approved drained predecessor/i,
    );
    assert.equal(f.snapshot(),drainedSnapshot);

    const first=await performLocalBoundCutoverRestart({
      config,cutoverId,carrierId:approved.id,expectedCarrierVersion:1,expectedValidityVersion:1,carrierCredential:pairing.credential,
      confirmCutoverId:cutoverId,packageRoot:f.root,
    },dependencies);
    assert.equal(first.scheduled,true);
    assert.equal(scheduled,1);
    assert.deepEqual(actuatorCalls.at(-1),{
      livePid:4321,
      serviceLabel:"test.service",
      launchdTarget:"gui/501/test.service",
    });
    assert.ok(new CutoverStateStore(f.root).get()?.restartRequest?.restartScheduledAt);

    const replay=await performLocalBoundCutoverRestart({
      config,cutoverId,carrierId:approved.id,expectedCarrierVersion:1,expectedValidityVersion:1,carrierCredential:pairing.credential,
      confirmCutoverId:cutoverId,packageRoot:f.root,
    },dependencies);
    assert.equal(replay.scheduled,false);
    assert.equal(scheduled,1);
  } finally {
    f.close();
  }
});


test("terminal hygiene releases only the exact normally closed cutover lease after root carrier revocation", async () => {
  const f=fixture();
  let manager:DurableOperationManager|undefined;
  try {
    const context={clientId:"shared-oauth",sessionId:"terminal-hygiene-controller"};
    const pairing=f.store.requestPairing(context);
    const cutover={
      stateRoot:f.root,
      attemptKey:"terminal-hygiene-cutover",
      currentIdentity:{serverInstanceId:"old-instance",sourceCommit:f.contract.baseRevision,buildId:"old-build",capabilityManifestSha256:"c".repeat(64)},
      expectedIdentity:{sourceCommit:"b".repeat(40),buildId:"new-build",capabilityManifestSha256:"d".repeat(64)},
      expiresAt:new Date(f.clock()+30000).toISOString(),
      restart:{buildReady:{verifiedBy:"independent",verifiedAt:new Date(f.clock()).toISOString(),evidence:"exact package"},actuator:"launchd-self" as const,serviceLabel:"test.service",launchdTarget:"gui/501/test.service"},
      finish:{workspaceId:"ws_terminal",agentId:"agt_terminal"},
    };
    const contract:CarrierContract={...f.contract,scope:[f.root],operations:["cutover_start"],expiresAt:new Date(f.clock()+60000).toISOString(),cutover};
    const approved=f.store.approveLocal(pairing.pendingId,contract);
    f.store.redeem(context,pairing.credential);
    const plan=planCutoverStart(f.root,cutover);
    const acquired=f.store.prepareEffect(context,plan.subject);
    const config=loadConfig({DEVSPACE_CONFIG_DIR:join(f.root,"config"),DEVSPACE_ALLOWED_ROOTS:f.workspace,DEVSPACE_WORKTREE_ROOT:join(f.root,"worktrees"),DEVSPACE_STATE_DIR:f.root,DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-long-enough",HOST:"127.0.0.1",PORT:"7677"});
    manager=new DurableOperationManager(config,undefined,undefined,undefined,f.store.readers);
    const start=manager.startCutover(cutover,context);
    const cutoverId=start.receipt!.cutoverId as string;
    manager.drainCutover(cutoverId,cutover.currentIdentity,()=>({activeSessions:0,oldestAgeMs:0}),context);
    let scheduled=0;
    await manager.restartCutover(cutoverId,cutover.currentIdentity,cutover.restart.buildReady,async()=>({buildReady:true,detail:"exact package"}),{
      actuator:"launchd-self" as const,
      serviceLabel:cutover.restart.serviceLabel,
      launchdTarget:cutover.restart.launchdTarget,
      schedule:()=>{scheduled+=1;return {scheduled:true as const,actuator:"launchd-self" as const,serviceLabel:cutover.restart.serviceLabel,launchdTarget:cutover.restart.launchdTarget};},
    },context);
    assert.equal(scheduled,1);
    const replacement={serverInstanceId:"replacement-instance",...cutover.expectedIdentity};
    const witness={workspaceQueryable:true,agentQueryable:true,agentReconciled:true,witnessWorkspaceId:cutover.finish.workspaceId,witnessAgentId:cutover.finish.agentId};
    await manager.finishCutover(cutoverId,replacement,cutover.finish,async()=>witness,context);

    const closed=new CutoverStateStore(f.root).get()!;
    assert.equal(closed.phase,"closed");
    const terminalHash=cutoverTerminalRecordHash(closed);
    const operations=new DurableOperationStore(f.root);
    const terminalOperation=operations.getByOperationId(start.operationId)!;
    operations.close();
    assert.equal(terminalOperation.status,"succeeded");
    assert.equal(terminalOperation.receipt?.lifecycleTerminal,true);
    assert.equal(terminalOperation.receipt?.terminalRecordHash,terminalHash);
    const terminalLease=f.store.ownership.get(acquired.leaseId)!;
    assert.equal(terminalLease.operationState,"finished");
    assert.equal(terminalLease.operationHandle,undefined);
    assert.equal(terminalLease.terminalState,undefined);

    assert.throws(()=>f.store.releaseClosedCutoverLeaseLocal({
      cutoverId,leaseId:acquired.leaseId,expectedLeaseVersion:terminalLease.version,
      carrierId:approved.id,expectedCarrierVersion:2,expectedTerminalRecordHash:terminalHash,confirmCutoverId:cutoverId,
    }),/revoked/i);

    const revoked=f.store.revokeLocal(approved.id,1);
    assert.equal(revoked.version,2);
    f.store.forgetSession(context.sessionId);
    assert.throws(()=>f.store.releaseLease(context,acquired.leaseId,terminalLease.version),/paired carrier|revoked/i);

    const beforeCutover=JSON.stringify(new CutoverStateStore(f.root).get());
    const beforeOperation=JSON.stringify(terminalOperation);
    for(const invalid of [
      {leaseId:"lease_wrong",expectedLeaseVersion:terminalLease.version,expectedCarrierVersion:2,expectedTerminalRecordHash:terminalHash},
      {leaseId:acquired.leaseId,expectedLeaseVersion:terminalLease.version+1,expectedCarrierVersion:2,expectedTerminalRecordHash:terminalHash},
      {leaseId:acquired.leaseId,expectedLeaseVersion:terminalLease.version,expectedCarrierVersion:3,expectedTerminalRecordHash:terminalHash},
      {leaseId:acquired.leaseId,expectedLeaseVersion:terminalLease.version,expectedCarrierVersion:2,expectedTerminalRecordHash:"0".repeat(64)},
    ]) {
      assert.throws(()=>f.store.releaseClosedCutoverLeaseLocal({
        cutoverId,carrierId:approved.id,confirmCutoverId:cutoverId,...invalid,
      }));
      assert.equal(f.store.ownership.get(acquired.leaseId)?.terminalState,undefined);
    }

    const released=f.store.releaseClosedCutoverLeaseLocal({
      cutoverId,leaseId:acquired.leaseId,expectedLeaseVersion:terminalLease.version,
      carrierId:approved.id,expectedCarrierVersion:2,expectedTerminalRecordHash:terminalHash,confirmCutoverId:cutoverId,
    });
    assert.equal(released.replayed,false);
    assert.equal(released.lease.terminalState,"released");
    assert.equal(released.lease.version,terminalLease.version+1);
    assert.equal(released.lease.operationState,"finished");
    assert.equal(released.lease.operationHandle,undefined);
    assert.equal(JSON.stringify(new CutoverStateStore(f.root).get()),beforeCutover);
    const finalOperations=new DurableOperationStore(f.root);
    assert.equal(JSON.stringify(finalOperations.getByOperationId(start.operationId)),beforeOperation);
    finalOperations.close();

    const replay=f.store.releaseClosedCutoverLeaseLocal({
      cutoverId,leaseId:acquired.leaseId,expectedLeaseVersion:terminalLease.version,
      carrierId:approved.id,expectedCarrierVersion:2,expectedTerminalRecordHash:terminalHash,confirmCutoverId:cutoverId,
    });
    assert.equal(replay.replayed,true);
    assert.equal(replay.lease.version,released.lease.version);

    const successorContext={clientId:"shared-oauth",sessionId:"terminal-hygiene-successor"};
    const successorPairing=f.store.requestPairing(successorContext);
    const successorCutover={
      ...cutover,
      attemptKey:"terminal-hygiene-successor-cutover",
      currentIdentity:{serverInstanceId:"replacement-instance",...cutover.expectedIdentity},
      expectedIdentity:{sourceCommit:"e".repeat(40),buildId:"later-build",capabilityManifestSha256:"f".repeat(64)},
      expiresAt:new Date(f.clock()+25000).toISOString(),
      restart:{...cutover.restart,buildReady:{...cutover.restart.buildReady,verifiedAt:new Date(f.clock()).toISOString(),evidence:"later exact package"}},
    };
    const successorContract:CarrierContract={...contract,baseRevision:successorCutover.currentIdentity.sourceCommit,cutover:successorCutover};
    f.store.approveLocal(successorPairing.pendingId,successorContract);
    f.store.redeem(successorContext,successorPairing.credential);
    const successorLease=f.store.prepareEffect(successorContext,planCutoverStart(f.root,successorCutover).subject);
    assert.notEqual(successorLease.leaseId,acquired.leaseId);
    assert.equal(successorLease.terminalState,undefined);
  } finally {
    manager?.close();
    f.close();
  }
});
