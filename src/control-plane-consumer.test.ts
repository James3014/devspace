import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { loadConfig } from "./config.js";
import { DurableOperationManager } from "./durable-operations.js";
import type { ControlPlaneConsumerOptions } from "./control-plane-consumer.js";
import type { ControlPlaneOwnershipStore } from "./control-plane-ownership.js";

function fixture(run: ConstructorParameters<typeof DurableOperationManager>[1]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "devspace-c3-consumer-")));
  execFileSync("git", ["init", root], {stdio:"pipe"});
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "fixture"], {stdio:"pipe"});
  writeFileSync(join(root,"package.json"), '{"name":"fixture","version":"1.0.0"}');
  writeFileSync(join(root,"package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
  const base = execFileSync("git", ["-C",root,"rev-parse","HEAD"], {encoding:"utf8"}).trim();
  const config = loadConfig({DEVSPACE_CONFIG_DIR:join(root,"config"),DEVSPACE_ALLOWED_ROOTS:root,DEVSPACE_WORKTREE_ROOT:join(root,"worktrees"),DEVSPACE_STATE_DIR:join(root,"state"),DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-that-is-long-enough",PORT:"1"});
  const context = Object.freeze({});
  const grant = {repository:"owner/repo",goal:"fixture",coordinatorThread:"controller",evidenceHash:"trusted-fixture"};
  const sha = (text:string|Buffer) => createHash("sha256").update(text).digest("hex");
  const approvedHash = sha(JSON.stringify({baseRevision:base,frozenInputs:{"package-lock.json":sha(readFileSync(join(root,"package-lock.json"))),"package.json":sha(readFileSync(join(root,"package.json")))},recipe:"npm_ci",version:"devspace.execution.v1",workspaceId:"fixture",workspaceRoot:root}));
  let ownership: ControlPlaneOwnershipStore;
  let leaseId = "";
  let permitted = true;
  const options: ControlPlaneConsumerOptions = {
    resolveOwnerContext: c => c === context ? {ownerThread:"worker"} : undefined,
    verifyGrantEvidence: g => permitted && JSON.stringify(g) === JSON.stringify(grant),
    resolveEffectBinding: (c,s) => c === context && permitted && s.workspaceRoot === root && s.baseRevision === base && s.operation === "dependency_sync" && s.requestHash === approvedHash ? {leaseId,leaseVersion:ownership.get(leaseId)!.version,requestHash:s.requestHash,role:"worker"} : undefined,
  };
  const manager = new DurableOperationManager(config,run,undefined,undefined,options);
  ownership = manager.store.createOwnershipStore(options);
  ownership.putGrantEvidence(context,grant,0);
  leaseId = ownership.acquire(context,{repositoryKey:grant.repository,resourceKind:"workspace",resourceId:root,resource:root,operation:"dependency_sync",scope:[root],baseRevision:base,expiresAt:new Date(Date.now()+60000).toISOString(),idempotencyKey:"fixture",grant}).leaseId;
  const input = {attemptKey:"attempt",workspaceId:"fixture",workspaceRoot:root,recipe:"npm_ci" as const};
  return {manager,context,input,config,options,root,base,grant,leaseId,approvedHash,ownership,lease:()=>ownership.get(leaseId)!,revoke:()=>{permitted=false;}};
}

test("C3 manager denies missing host authority and forged context before effect", async () => {
  let launches = 0;
  const f = fixture(async()=>{ launches++; return {exitCode:0,stdout:"",stderr:""}; });
  const bare = new DurableOperationManager(f.config,async()=>{launches++; return {exitCode:0,stdout:"",stderr:""};});
  try {
    await assert.rejects(bare.dependencySync(f.input), /trusted host authority/);
    await assert.rejects(f.manager.dependencySync(f.input,{}), /trusted effect binding/);
    assert.equal(launches,0);
  } finally {bare.close(); f.manager.close();}
});

test("C3 successful operation releases pin atomically and exact replay launches once", async () => {
  let launches = 0;
  const f = fixture(async()=>{launches++; return {exitCode:0,stdout:"done",stderr:""};});
  try {
    const first = await f.manager.dependencySync(f.input,f.context);
    assert.equal(first.status,"succeeded");
    assert.equal(f.lease().operationHandle,undefined);
    assert.deepEqual(await f.manager.dependencySync(f.input,f.context),first);
    assert.equal(launches,1);
  } finally {f.manager.close();}
});

test("C3 lost effect response preserves pin and restart or new attempt cannot relaunch", async () => {
  let launches = 0;
  const f = fixture(async()=>{launches++; throw new Error("transport lost");});
  try {
    assert.equal((await f.manager.dependencySync(f.input,f.context)).status,"outcome_unknown");
    assert.ok(f.lease().operationHandle);
    const reopened = new DurableOperationManager(f.config,async()=>{launches++; return {exitCode:0,stdout:"",stderr:""};},undefined,undefined,f.options);
    try {
      await assert.rejects(reopened.dependencySync(f.input,f.context), /uncertain physical effects/);
      await assert.rejects(reopened.dependencySync({...f.input,attemptKey:"new-attempt"},f.context));
      assert.equal(launches,1);
    } finally {reopened.close();}
  } finally {f.manager.close();}
});


test("C3 real npm frozen recipe executes through the production manager", async () => {
  const f = fixture(undefined);
  try {
    const result = await f.manager.dependencySync(f.input,f.context);
    assert.equal(result.status,"succeeded",JSON.stringify(result));
    assert.equal(f.lease().operationHandle,undefined);
  } finally { f.manager.close(); }
});

test("C3 independent processes share one pin and a competing attempt cannot launch", async () => {
  const f = fixture(undefined);
  const childSource = `
    import {DurableOperationManager} from ${JSON.stringify(new URL("./durable-operations.ts",import.meta.url).href)};
    const f=JSON.parse(process.env.C3_FIXTURE);
    const context={}; let ownership;
    const options={
      resolveOwnerContext:c=>c===context?{ownerThread:"worker"}:undefined,
      verifyGrantEvidence:g=>JSON.stringify(g)===JSON.stringify(f.grant),
      resolveEffectBinding:(c,s)=>c===context && s.workspaceRoot===f.root && s.baseRevision===f.base && s.requestHash===f.approvedHash ? {leaseId:f.leaseId,leaseVersion:ownership.get(f.leaseId).version,requestHash:s.requestHash,role:"worker"}:undefined
    };
    const manager=new DurableOperationManager(f.config,async()=>{
      process.stdout.write("EFFECT_STARTED\\n");
      await new Promise(resolve=>process.stdin.once("data",resolve));
      return {exitCode:0,stdout:"canary",stderr:""};
    },undefined,undefined,options);
    ownership=manager.store.createOwnershipStore(options);
    try {const r=await manager.dependencySync({...f.input,attemptKey:process.env.C3_ATTEMPT},context); process.stdout.write(r.status);}
    catch(e){process.stdout.write("DENIED:"+e.code);}
    finally{manager.close();process.stdin.destroy();}
  `;
  const launch = (attempt:string) => spawn(process.execPath,["--import","tsx","--input-type=module","-e",childSource],{
    env:{...process.env,C3_FIXTURE:JSON.stringify({config:f.config,root:f.root,base:f.base,grant:f.grant,leaseId:f.leaseId,input:f.input,approvedHash:f.approvedHash}),C3_ATTEMPT:attempt},stdio:["pipe","pipe","pipe"]
  });
  const first=launch("first");
  const collect=(child:ReturnType<typeof launch>)=>new Promise<string>((resolve,reject)=>{
    let out=""; child.stdout.on("data",d=>out+=d); child.stderr.on("data",d=>out+=d);
    child.once("error",reject); child.once("exit",code=>code===0?resolve(out):reject(new Error(out)));
  });
  const firstResult=collect(first);
  try {
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("child did not reach effect")),10000);
      first.stdout.on("data",d=>{if(String(d).includes("EFFECT_STARTED")){clearTimeout(timer);resolve();}});
    });
    const secondResult=await collect(launch("second"));
    assert.match(secondResult,/DENIED:CAS_CONFLICT/);
    assert.doesNotMatch(secondResult,/EFFECT_STARTED/);
    assert.ok(f.lease().operationHandle);
    first.stdin.write("finish");
    assert.match(await firstResult,/succeeded/);
    assert.equal(f.lease().operationHandle,undefined);
  } finally {first.stdin.end(); f.manager.close();}
});


test("C3 trusted policy denies a changed recipe rather than echoing its hash", async () => {
  let launches=0;
  const f=fixture(async()=>{launches++;return {exitCode:0,stdout:"",stderr:""};});
  try {
    await assert.rejects(f.manager.dependencySync({...f.input,recipe:"pnpm_frozen"},f.context),/trusted effect binding/);
    assert.equal(launches,0);
  } finally {f.manager.close();}
});

test("C3 externally verified terminal proof reconciles durable record and pin together", async () => {
  const f=fixture(async()=>{throw new Error("lost response");});
  try {
    const unknown=await f.manager.dependencySync(f.input,f.context);
    const lease=f.lease();
    const proof={leaseId:lease.leaseId,ownerThread:lease.ownerThread,operationHandle:unknown.operationId,operation:lease.operation,baseRevision:lease.baseRevision,leaseVersion:lease.version,state:"finished" as const,requestHash:unknown.requestHash,exitCode:0,frozenInputsUnchanged:true};
    assert.throws(()=>f.manager.reconcileDependencySync(unknown.operationId,proof,f.context),/verified terminal/);
    assert.ok(f.lease().operationHandle);
    await assert.rejects(f.manager.reconcile(unknown.operationId,f.context), /terminal witness is unavailable/);
    f.options.readDependencyReconciliation=(c,subject)=>c===f.context && subject.operationId===unknown.operationId ? proof : undefined;
    f.options.verifyDependencyReconciliation=e=>JSON.stringify(e)===JSON.stringify(proof);
    f.options.verifyReconciliationEvidence=e=>e.operationHandle===proof.operationHandle && e.detail===JSON.stringify({requestHash:proof.requestHash,exitCode:proof.exitCode,frozenInputsUnchanged:proof.frozenInputsUnchanged});
    // The host policy is fixed at construction; reopen against the same durable database.
    const reopened=new DurableOperationManager(f.config,undefined,undefined,undefined,f.options);
    try {
      const result=reopened.reconcileDependencySync(unknown.operationId,proof,f.context);
      assert.equal(result.status,"succeeded");
      assert.deepEqual(await reopened.reconcile(unknown.operationId,f.context),result);
      assert.equal(f.lease().operationHandle,undefined);
      assert.deepEqual(reopened.reconcileDependencySync(unknown.operationId,proof,f.context),result);
      assert.throws(()=>reopened.reconcileDependencySync(unknown.operationId,{...proof,exitCode:1},f.context));
    } finally {reopened.close();}
  } finally {f.manager.close();}
});

test("C3 verifier cannot mutate grant and denial rolls back the operation record", async () => {
  let launches=0;
  const f=fixture(async()=>{launches++;return {exitCode:0,stdout:"",stderr:""};});
  try {
    f.options.verifyGrantEvidence=g=>{g.evidenceHash="forged";return true;};
    await assert.rejects(f.manager.dependencySync(f.input,f.context),TypeError);
    assert.equal(f.manager.store.getByAttempt(f.root,f.input.attemptKey),undefined);
    assert.equal(f.lease().operationHandle,undefined);
    assert.equal(launches,0);
  } finally {f.manager.close();}
});

test("C3 input drift during binding cannot reach the command", async () => {
  let launches=0;
  const f=fixture(async()=>{launches++;return {exitCode:0,stdout:"",stderr:""};});
  const resolve=f.options.resolveEffectBinding;
  try {
    f.options.resolveEffectBinding=(c,s)=>{const binding=resolve(c,s);writeFileSync(join(f.root,"package.json"),"{}");return binding;};
    const result=await f.manager.dependencySync(f.input,f.context);
    assert.equal(result.status,"outcome_unknown");
    assert.match(result.errorMessage!,/changed before launch/);
    assert.equal(launches,0);
    assert.ok(f.lease().operationHandle);
  } finally {f.manager.close();}
});

test("C3 terminal record failure rolls back pin release", async () => {
  const f=fixture(async()=>({exitCode:0,stdout:"",stderr:""}));
  const {default:Database}=await import("better-sqlite3");
  const sqlite=new Database(join(f.config.stateDir,"devspace.sqlite"));
  try {
    sqlite.exec("create trigger reject_success before update on durable_operations when new.status='succeeded' begin select raise(ABORT, 'terminal write failure'); end");
    const result=await f.manager.dependencySync(f.input,f.context);
    assert.equal(result.status,"outcome_unknown");
    assert.ok(f.lease().operationHandle);
    assert.match(result.errorMessage!,/terminal write failure/);
  } finally {sqlite.close();f.manager.close();}
});

test("C3 reconciliation callbacks cannot change verified outcome, record, or binding", async () => {
  for (const attack of ["original-proof", "durable-record", "revoke-binding"] as const) {
    const f=fixture(async()=>{throw new Error("lost response");});
    try {
      const unknown=await f.manager.dependencySync(f.input,f.context);
      const lease=f.lease();
      const proof={leaseId:lease.leaseId,ownerThread:lease.ownerThread,operationHandle:unknown.operationId,operation:lease.operation,baseRevision:lease.baseRevision,leaseVersion:lease.version,state:"finished" as const,requestHash:unknown.requestHash,exitCode:0,frozenInputsUnchanged:true};
      const approved=JSON.stringify(proof);
      let callbackStore=f.manager.store;
      f.options.verifyDependencyReconciliation=e=>{
        assert.ok(Object.isFrozen(e));
        const accepted=JSON.stringify(e)===approved;
        if(attack==="original-proof") proof.exitCode=9;
        if(attack==="durable-record") callbackStore.finish(unknown.operationId,{status:"failed",retrySafe:false});
        if(attack==="revoke-binding") f.revoke();
        return accepted;
      };
      f.options.verifyReconciliationEvidence=e=>e.operationHandle===unknown.operationId && JSON.parse(e.detail!).exitCode===0;
      const reopened=new DurableOperationManager(f.config,undefined,undefined,undefined,f.options);
      callbackStore=reopened.store;
      try {
        if(attack==="original-proof") {
          assert.equal(reopened.reconcileDependencySync(unknown.operationId,proof,f.context).status,"succeeded");
        } else {
          assert.throws(()=>reopened.reconcileDependencySync(unknown.operationId,proof,f.context), /changed/);
          assert.equal(f.manager.store.getByOperationId(unknown.operationId)?.status,"outcome_unknown");
          assert.ok(f.lease().operationHandle);
        }
      } finally {reopened.close();}
    } finally {f.manager.close();}
  }
});

test("C3 late predecessor success or rejection cannot overwrite successor reconciliation", async () => {
  for (const lateResult of ["success", "rejection"] as const) {
    let deliver!:()=>void;
    let started!:()=>void;
    const pendingResponse=new Promise<void>(resolve=>{deliver=resolve;});
    const effectFinished=new Promise<void>(resolve=>{started=resolve;});
    const f=fixture(async()=>{
      // The effect has terminated; its response is delayed in the old carrier.
      started(); await pendingResponse;
      if(lateResult==="rejection") throw new Error("old carrier disconnected after effect");
      return {exitCode:0,stdout:"completed",stderr:""};
    });
    const successorContext=Object.freeze({});
    const oldResolver=f.options.resolveOwnerContext!;
    f.options.resolveOwnerContext=c=>c===successorContext?{ownerThread:"successor"}:oldResolver(c);
    const oldResponse=f.manager.dependencySync(f.input,f.context).then(result=>({result,error:undefined}),error=>({result:undefined,error}));
    let successor:DurableOperationManager|undefined;
    try {
      await effectFinished;
      const prior=f.lease();
      f.ownership.handoff(f.context,prior.leaseId,prior.version,successorContext,{
        resource:prior.resource,candidateRevision:f.base,baseRevision:prior.baseRevision,scope:prior.scope,
        grantDependency:prior.grant,grantVersion:prior.grantVersion,recipientGrant:prior.grant,recipientGrantVersion:prior.grantVersion,
        checkpoint:"verified-effect-completed-response-pending",liveOperation:prior.operation,liveHandle:prior.operationHandle!,
        forbiddenOverlap:[f.root],tests:["late-result"],evidence:["independent-terminal-proof"],remainingGap:"reconcile",nextGate:"reconcile",expiresAt:prior.expiresAt,
      });
      const transferred=f.lease();
      const proof={leaseId:transferred.leaseId,ownerThread:"successor",operationHandle:transferred.operationHandle!,operation:transferred.operation,baseRevision:transferred.baseRevision,leaseVersion:transferred.version,state:"finished" as const,requestHash:f.approvedHash,exitCode:0,frozenInputsUnchanged:true};
      const successorOptions:ControlPlaneConsumerOptions={...f.options,
        resolveEffectBinding:(c,s)=>c===successorContext && s.requestHash===f.approvedHash ? {leaseId:f.leaseId,leaseVersion:f.lease().version,requestHash:f.approvedHash,role:"worker"}:undefined,
        verifyDependencyReconciliation:e=>JSON.stringify(e)===JSON.stringify(proof),
        verifyReconciliationEvidence:e=>e.ownerThread==="successor" && e.operationHandle===proof.operationHandle && e.detail===JSON.stringify({requestHash:proof.requestHash,exitCode:0,frozenInputsUnchanged:true}),
      };
      successor=new DurableOperationManager(f.config,undefined,undefined,undefined,successorOptions);
      const terminal=successor.reconcileDependencySync(proof.operationHandle,proof,successorContext);
      assert.equal(terminal.status,"succeeded");
      const successorLease=f.lease();
      deliver();
      const late=await oldResponse;
      assert.deepEqual(f.manager.store.getByOperationId(terminal.operationId),terminal);
      assert.deepEqual(f.lease(),successorLease);
      assert.equal(late.error?.code,"CAS_CONFLICT");
    } finally {deliver();await oldResponse;successor?.close();f.manager.close();}
  }
});

function cutoverFixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"devspace-c3-cutover-")));
  const config=loadConfig({DEVSPACE_CONFIG_DIR:join(root,"config"),DEVSPACE_ALLOWED_ROOTS:root,DEVSPACE_STATE_DIR:join(root,"state"),DEVSPACE_WORKTREE_ROOT:join(root,"worktrees"),DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-that-is-long-enough",PORT:"1"});
  const context=Object.freeze({});const grant={repository:"owner/repo",goal:"cutover",coordinatorThread:"controller",evidenceHash:"fixture-grant"};
  const input={attemptKey:"start",currentIdentity:{serverInstanceId:"old-runtime",sourceCommit:"old-source",buildId:"old-build"},expectedIdentity:{sourceCommit:"target-source",buildId:"target-build"}};
  let ownership:ControlPlaneOwnershipStore;let leaseId="";let permitted=true;
  const sort=(v:any):any=>v&&typeof v==="object"?Object.fromEntries(Object.entries(v).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,sort(v)])):v;
  const request={version:"devspace.execution.v1",baseRevision:input.currentIdentity.sourceCommit,stateRoot:config.stateDir,currentIdentity:input.currentIdentity,expectedIdentity:input.expectedIdentity};
  const hash=createHash("sha256").update(JSON.stringify(sort(request))).digest("hex");
  const options:ControlPlaneConsumerOptions={resolveOwnerContext:c=>c===context?{ownerThread:"controller"}:undefined,verifyGrantEvidence:g=>permitted&&JSON.stringify(g)===JSON.stringify(grant),resolveEffectBinding:(c,s)=>c===context&&permitted&&s.requestHash===hash&&s.operation==="cutover_start"?{leaseId,leaseVersion:ownership.get(leaseId)!.version,requestHash:hash,role:"controller"}:undefined};
  const manager=new DurableOperationManager(config,undefined,undefined,undefined,options);ownership=manager.store.createOwnershipStore(options);ownership.putGrantEvidence(context,grant,0);
  leaseId=ownership.acquire(context,{repositoryKey:grant.repository,resourceKind:"filesystem",resourceId:config.stateDir,resource:config.stateDir,operation:"cutover_start",scope:[config.stateDir],baseRevision:input.currentIdentity.sourceCommit,expiresAt:new Date(Date.now()+60000).toISOString(),idempotencyKey:"cutover",grant}).leaseId;
  return {manager,config,context,input,options,ownership,leaseId,revoke:()=>{permitted=false;}};
}

test("C3 cutover start correlates real state, retains pin, replays once and denies revoked reconciliation", async()=>{
  const {CutoverStateStore}=await import("./cutover-state.js");const f=cutoverFixture();
  try {
    const result=f.manager.startCutover(f.input,f.context);
    assert.equal(result.status,"succeeded");
    const record=new CutoverStateStore(f.config.stateDir).get()!;
    assert.equal(record.coordinationBinding?.operationHandle,result.operationId);
    assert.equal(f.ownership.get(f.leaseId)?.operationHandle,result.operationId);
    assert.deepEqual(f.manager.startCutover(f.input,f.context),result);
    const reopened=new DurableOperationManager(f.config,undefined,undefined,undefined,f.options);
    try {assert.equal(reopened.reconcileCutoverStart(result.operationId,f.context).receipt?.cutoverId,record.cutoverId);} finally {reopened.close();}
    const before=JSON.stringify(f.manager.store.getByOperationId(result.operationId));f.revoke();
    assert.throws(()=>f.manager.reconcileCutoverStart(result.operationId,f.context),/authority|binding/);
    assert.equal(JSON.stringify(f.manager.store.getByOperationId(result.operationId)),before);
  } finally {f.manager.close();}
});

test("C3 cutover crash windows never retry and only exact bound file can reconcile", async()=>{
  const {CutoverStateStore}=await import("./cutover-state.js");
  for (const afterWrite of [false,true]) {
    const f=cutoverFixture();const original=CutoverStateStore.prototype.begin;let calls=0;
    try {
      CutoverStateStore.prototype.begin=function(input){calls++;if(afterWrite) original.call(this,input);throw new Error("lost cutover response");};
      const result=f.manager.startCutover(f.input,f.context);
      assert.equal(result.status,"outcome_unknown");assert.equal(calls,1);
      CutoverStateStore.prototype.begin=original;
      const reopened=new DurableOperationManager(f.config,undefined,undefined,undefined,f.options);
      try {
        assert.equal(reopened.store.getByOperationId(result.operationId)?.status,"outcome_unknown");
        if (afterWrite) assert.equal(reopened.startCutover(f.input,f.context).status,"succeeded");
        else {
          assert.throws(()=>reopened.startCutover(f.input,f.context),/no retry or release/);
          new CutoverStateStore(f.config.stateDir).begin({oldServerIdentity:f.input.currentIdentity,expectedNewIdentity:f.input.expectedIdentity});
          assert.throws(()=>reopened.reconcileCutoverStart(result.operationId,f.context),/exact persisted correlation/);
        }
        assert.equal(f.ownership.get(f.leaseId)?.operationHandle,result.operationId);
      } finally {reopened.close();}
    } finally {CutoverStateStore.prototype.begin=original;f.manager.close();}
  }
});

test("C3 cutover missing authority, worker role and changed target deny before file writes", async()=>{
  const {CutoverStateStore}=await import("./cutover-state.js");const f=cutoverFixture();const bare=new DurableOperationManager(f.config);
  try {
    assert.throws(()=>bare.startCutover(f.input,f.context),/trusted host authority/);
    assert.throws(()=>f.manager.startCutover(f.input,{}),/binding/);
    assert.throws(()=>f.manager.startCutover({...f.input,expectedIdentity:{...f.input.expectedIdentity,buildId:"changed"}},f.context),/binding/);
    const original=f.options.resolveEffectBinding;f.options.resolveEffectBinding=(c,s)=>{const b=original(c,s);return b?{...b,role:"worker"}:undefined;};
    assert.throws(()=>f.manager.startCutover(f.input,f.context),/controller authority/);
    assert.equal(new CutoverStateStore(f.config.stateDir).get(),undefined);
    assert.equal(f.ownership.get(f.leaseId)?.operationHandle,undefined);
  } finally {bare.close();f.manager.close();}
});

test("C3 separate cutover processes share intent and pin before the real file write", async()=>{
  const {existsSync}=await import("node:fs");const f=cutoverFixture();
  const marker=join(f.config.stateDir,"before-begin");const release=join(f.config.stateDir,"release-begin");
  const ready=join(f.config.stateDir,"second-ready");const go=join(f.config.stateDir,"second-go");
  const childSource=`
    import {DurableOperationManager} from ${JSON.stringify(new URL("./durable-operations.ts",import.meta.url).href)};
    import {CutoverStateStore} from ${JSON.stringify(new URL("./cutover-state.js",import.meta.url).href)};
    import {existsSync,writeFileSync} from 'node:fs';
    const payload=JSON.parse(process.env.CUTOVER_FIXTURE);const context={};let ownership;
    const options={resolveOwnerContext:c=>c===context?{ownerThread:'controller'}:undefined,verifyGrantEvidence:g=>JSON.stringify(g)===JSON.stringify(payload.grant),resolveEffectBinding:(c,s)=>c===context&&s.requestHash===payload.hash?{leaseId:payload.leaseId,leaseVersion:ownership.get(payload.leaseId).version,requestHash:s.requestHash,role:'controller'}:undefined};
    const manager=new DurableOperationManager(payload.config,undefined,undefined,undefined,options);ownership=manager.store.createOwnershipStore(options);
    if(!payload.pause){writeFileSync(payload.ready,'ready');const deadline=Date.now()+15000;while(!existsSync(payload.go)&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}
    if(payload.pause){const original=CutoverStateStore.prototype.begin;CutoverStateStore.prototype.begin=function(input){writeFileSync(payload.marker,'pinned');const deadline=Date.now()+15000;while(!existsSync(payload.release)&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);if(!existsSync(payload.release))throw new Error('fixture timeout');return original.call(this,input);};}
    try{process.stdout.write(JSON.stringify({result:manager.startCutover(payload.input,context)}));}catch(e){process.stdout.write(JSON.stringify({error:e.code||e.message}));}finally{manager.close();}
  `;
  const lease=f.ownership.get(f.leaseId)!;
  const grant=lease.grant;
  // Capture the approved hash from the trusted fixture's fixed request.
  const sort=(v:any):any=>v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,sort(v)])):v;
  const hash=createHash('sha256').update(JSON.stringify(sort({version:'devspace.execution.v1',baseRevision:f.input.currentIdentity.sourceCommit,stateRoot:f.config.stateDir,currentIdentity:f.input.currentIdentity,expectedIdentity:f.input.expectedIdentity}))).digest('hex');
  const launch=(pause:boolean,attemptKey:string)=>{
    const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",childSource],{env:{...process.env,CUTOVER_FIXTURE:JSON.stringify({config:f.config,input:{...f.input,attemptKey},leaseId:f.leaseId,grant,hash,pause,marker,release,ready,go})},stdio:['ignore','pipe','pipe']});
    let out='';let err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    return new Promise<any>((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));});
  };
  try {
    const secondPromise=launch(false,'second');
    for(let n=0;n<500&&!existsSync(ready);n++)await new Promise(r=>setTimeout(r,20));
    assert.equal(existsSync(ready),true);
    const first=launch(true,'first');
    for(let n=0;n<500&&!existsSync(marker);n++)await new Promise(r=>setTimeout(r,20));
    assert.equal(existsSync(marker),true);
    const pinned=f.ownership.get(f.leaseId)!;
    assert.equal(f.manager.store.getByOperationId(pinned.operationHandle!)?.status,'started');
    writeFileSync(go,'compete');const second=await secondPromise;assert.ok(second.error);
    assert.equal(f.manager.store.getByOperationId(pinned.operationHandle!)?.status,'started');
    writeFileSync(release,'continue');const result=await first;assert.equal(result.result.status,'succeeded');
    assert.equal(f.ownership.get(f.leaseId)?.operationHandle,result.result.operationId);
  } finally {writeFileSync(go,'compete');writeFileSync(release,'continue');f.manager.close();}
});

test("C3 cutover callback drift cannot reach begin or overwrite durable evidence", async()=>{
  const {CutoverStateStore}=await import("./cutover-state.js");
  for (const duringCatch of [false,true]) {
    const f=cutoverFixture();const begin=CutoverStateStore.prototype.begin;const resolve=f.options.resolveEffectBinding;
    let reachedBegin=false;let changed=false;
    try {
      CutoverStateStore.prototype.begin=function(){reachedBegin=true;throw new Error('before file write');};
      f.options.resolveEffectBinding=(c,s)=>{
        const binding=resolve(c,s);const record=f.manager.store.getByOperationId(s.operationId);
        if(record&&!changed&&(!duringCatch||reachedBegin)) {changed=true;f.manager.store.finish(record.operationId,{status:'failed',retrySafe:false,receipt:{newerEvidence:true}});}
        return binding;
      };
      if(duringCatch) assert.throws(()=>f.manager.startCutover(f.input,f.context),/CAS|newer durable|changed/);
      else {assert.equal(f.manager.startCutover(f.input,f.context).status,'outcome_unknown');assert.equal(reachedBegin,false);}
      assert.equal(new CutoverStateStore(f.config.stateDir).get(),undefined);
      assert.ok(f.ownership.get(f.leaseId)?.operationHandle);
    } finally {CutoverStateStore.prototype.begin=begin;f.manager.close();}
  }
});

test("C3 cutover reconciliation rejects another lease with the same operation handle", async()=>{
  const {CutoverStateStore}=await import("./cutover-state.js");const f=cutoverFixture();
  try {
    const result=f.manager.startCutover(f.input,f.context);const old=f.ownership.get(f.leaseId)!;
    const finished=f.ownership.finishOperation(f.context,f.leaseId,old.version,result.operationId);
    f.ownership.release(f.context,f.leaseId,finished.version);
    const alternate=f.ownership.acquire(f.context,{...old,idempotencyKey:"alternate"});
    f.ownership.beginOperation(f.context,alternate.leaseId,alternate.version,result.operationId);
    const resolve=f.options.resolveEffectBinding;
    f.options.resolveEffectBinding=(c,s)=>{const binding=resolve(c,s);return binding?{...binding,leaseId:alternate.leaseId,leaseVersion:f.ownership.get(alternate.leaseId)!.version}:undefined;};
    const snapshot=()=>JSON.stringify([f.manager.store.getByOperationId(result.operationId),f.ownership.get(f.leaseId),f.ownership.get(alternate.leaseId),new CutoverStateStore(f.config.stateDir).get()]);
    const before=snapshot();assert.throws(()=>f.manager.reconcileCutoverStart(result.operationId,f.context),/correlation|binding/);assert.equal(snapshot(),before);
  } finally {f.manager.close();}
});

test("C3 cutover reconciliation follows legitimate same-lease handoff and fences former owner", ()=>{
  const f=cutoverFixture();const recipient={};
  try {
    const result=f.manager.startCutover(f.input,f.context);const lease=f.ownership.get(f.leaseId)!;
    const owner=f.options.resolveOwnerContext!;const resolve=f.options.resolveEffectBinding;
    f.options.resolveOwnerContext=c=>c===recipient?{ownerThread:"recipient"}:owner(c);
    f.options.resolveEffectBinding=(c,s)=>resolve(c===recipient?f.context:c,s);
    f.options.resolveHandoffRecipient=(c,h)=>c===f.context && h==="recipient"?recipient:undefined;
    const handoffInput={resource:lease.resource,scope:lease.scope,baseRevision:lease.baseRevision,candidateRevision:"candidate",liveOperation:lease.operation,liveHandle:result.operationId,checkpoint:"after-start",grantDependency:lease.grant,grantVersion:lease.grantVersion,recipientGrant:lease.grant,recipientGrantVersion:lease.grantVersion,forbiddenOverlap:[lease.resource],tests:["start"],evidence:["bound-file"],remainingGap:"lifecycle",nextGate:"reconcile",expiresAt:lease.expiresAt};
    const snapshot=JSON.stringify(f.ownership.get(f.leaseId));
    const recipientReader=f.options.resolveHandoffRecipient;
    f.options.resolveHandoffRecipient=undefined;
    assert.throws(()=>f.manager.handoff(f.leaseId,lease.version,"recipient",handoffInput,f.context),/trusted authenticated handoff recipient/);
    assert.equal(JSON.stringify(f.ownership.get(f.leaseId)),snapshot);
    f.options.resolveHandoffRecipient=recipientReader;
    f.manager.handoff(f.leaseId,lease.version,"recipient",handoffInput,f.context);
    assert.equal(f.manager.reconcileCutoverStart(result.operationId,recipient).operationId,result.operationId);
    f.options.approveCutoverLifecycle=(c,subject,action)=>c===recipient&&subject.operationId===result.operationId&&action.action==="drain";
    const cutoverId=result.receipt!.cutoverId as string;
    assert.equal(f.manager.drainCutover(cutoverId,f.input.currentIdentity,()=>({activeSessions:0,oldestAgeMs:0}),recipient).phase,"drained");
    assert.throws(()=>f.manager.drainCutover(cutoverId,f.input.currentIdentity,()=>({activeSessions:0,oldestAgeMs:0}),f.context));

    assert.throws(()=>f.manager.reconcileCutoverStart(result.operationId,f.context),/owner|binding|CAS|lease evidence/);
    assert.equal(f.ownership.get(f.leaseId)?.operationHandle,result.operationId);
  } finally {f.manager.close();}
});

test("C3 guarded drain binds action/runtime, rejects callback CAS drift and preserves replay", async()=>{
  const {CutoverStateStore}=await import("./cutover-state.js");const f=cutoverFixture();
  const evidence={activeSessions:0,oldestAgeMs:0};
  try {
    const start=f.manager.startCutover(f.input,f.context);const store=new CutoverStateStore(f.config.stateDir);const record=store.get()!;
    const snapshot=()=>JSON.stringify([store.get(),f.ownership.get(f.leaseId),f.manager.store.getByOperationId(start.operationId)]);
    const before=snapshot();
    assert.throws(()=>f.manager.drainCutover(record.cutoverId,f.input.currentIdentity,()=>evidence,f.context),/approval/);
    f.options.approveCutoverLifecycle=(c,s,a)=>c===f.context&&s.operationId===start.operationId&&a.action==="drain"&&a.cutoverId===record.cutoverId;
    assert.throws(()=>f.manager.drainCutover("wrong-id",f.input.currentIdentity,()=>evidence,f.context),/generation/);
    assert.throws(()=>f.manager.drainCutover(record.cutoverId,{...f.input.currentIdentity,buildId:"wrong"},()=>evidence,f.context),/runtime identity/);
    const resolver=f.options.resolveEffectBinding;
    f.options.resolveEffectBinding=(c,s)=>{const b=resolver(c,s);return b?{...b,leaseVersion:b.leaseVersion-1}:undefined;};
    assert.throws(()=>f.manager.drainCutover(record.cutoverId,f.input.currentIdentity,()=>evidence,f.context),/CAS|lease/);
    f.options.resolveEffectBinding=resolver;
    assert.throws(()=>f.manager.drainCutover(record.cutoverId,f.input.currentIdentity,()=>{
      const lease=f.ownership.get(f.leaseId)!;
      f.ownership.renew(f.context,f.leaseId,lease.version,new Date(Date.parse(lease.expiresAt)+10000).toISOString());
      return evidence;
    },f.context),/binding changed/);
    assert.equal(snapshot(),before);
    const drained=f.manager.drainCutover(record.cutoverId,f.input.currentIdentity,()=>evidence,f.context);
    assert.equal(drained.phase,"drained");assert.equal(f.ownership.get(f.leaseId)?.operationHandle,start.operationId);
    const beforeReplay=snapshot();
    assert.deepEqual(f.manager.drainCutover(record.cutoverId,f.input.currentIdentity,()=>{throw new Error("replay must not sample");},f.context),store.get());
    assert.equal(snapshot(),beforeReplay);
    f.revoke();const terminal=snapshot();assert.throws(()=>f.manager.drainCutover(record.cutoverId,f.input.currentIdentity,()=>evidence,f.context));assert.equal(snapshot(),terminal);
  } finally {f.manager.close();}
});

test("C3 drain response loss preserves pin and reconciles existing file without replay", async()=>{
  const {CutoverStateStore}=await import("./cutover-state.js");const f=cutoverFixture();
  const original=CutoverStateStore.prototype.recordDrain;let writes=0;
  try {
    const start=f.manager.startCutover(f.input,f.context);const cutoverId=start.receipt!.cutoverId as string;
    f.options.approveCutoverLifecycle=(c,s,a)=>c===f.context&&s.operationId===start.operationId&&a.cutoverId===cutoverId;
    const pin=JSON.stringify(f.ownership.get(f.leaseId));
    CutoverStateStore.prototype.recordDrain=function(id,evidence){writes++;original.call(this,id,evidence);throw new Error("drain response lost");};
    assert.throws(()=>f.manager.drainCutover(cutoverId,f.input.currentIdentity,()=>({activeSessions:0,oldestAgeMs:0}),f.context),/response lost/);
    assert.equal(JSON.stringify(f.ownership.get(f.leaseId)),pin);
    assert.equal(f.manager.drainCutover(cutoverId,f.input.currentIdentity,()=>{throw new Error("must not reexecute");},f.context).phase,"drained");
    assert.equal(writes,1);assert.equal(JSON.stringify(f.ownership.get(f.leaseId)),pin);
  } finally {CutoverStateStore.prototype.recordDrain=original;f.manager.close();}
});

test("C3 guarded finish closes exact generation, releases its pin and rejects newer-pin replay",async()=>{
  const f=cutoverFixture();
  try {
    const start=f.manager.startCutover(f.input,f.context);const id=start.receipt!.cutoverId as string;
    f.options.approveCutoverLifecycle=(c,s,a)=>c===f.context&&s.operationId===start.operationId;
    f.manager.drainCutover(id,f.input.currentIdentity,()=>({activeSessions:0,oldestAgeMs:0}),f.context);
    const replacement={serverInstanceId:"replacement",...f.input.expectedIdentity};
    const pair={workspaceId:"workspace",agentId:"agent"};let calls=0;
    const reconcile=async()=>{calls++;return {workspaceQueryable:true,agentQueryable:true,agentReconciled:true,witnessWorkspaceId:pair.workspaceId,witnessAgentId:pair.agentId};};
    const result=await f.manager.finishCutover(id,replacement,pair,reconcile,f.context);
    assert.equal(result.phase,"closed");assert.equal(f.ownership.get(f.leaseId)?.operationHandle,undefined);
    assert.equal(f.manager.store.getByOperationId(start.operationId)?.receipt?.lifecycleTerminal,true);
    assert.deepEqual(await f.manager.finishCutover(id,replacement,pair,reconcile,f.context),result);assert.equal(calls,1);
    const lease=f.ownership.get(f.leaseId)!;f.ownership.beginOperation(f.context,f.leaseId,lease.version,"new-operation");
    await assert.rejects(f.manager.finishCutover(id,replacement,pair,reconcile,f.context),/pin/);
    assert.equal(f.ownership.get(f.leaseId)?.operationHandle,"new-operation");
  } finally {f.manager.close();}
});

test("C3 finish denial and uncertain terminal writes retain the original pin",async()=>{
  const {CutoverStateStore}=await import("./cutover-state.js");
  for(const failure of ["wrong-pair","wrong-runtime","revoke","handoff","close-response","terminal-write"]){
    const f=cutoverFixture();const recipient={};const originalClose=CutoverStateStore.prototype.close;const originalFinish=f.manager.store.finish.bind(f.manager.store);
    try {
      const start=f.manager.startCutover(f.input,f.context);const id=start.receipt!.cutoverId as string;
      f.options.approveCutoverLifecycle=(c,s)=>[f.context,recipient].includes(c as object)&&s.operationId===start.operationId;
      f.manager.drainCutover(id,f.input.currentIdentity,()=>({activeSessions:0,oldestAgeMs:0}),f.context);
      const replacement={serverInstanceId:"replacement",...f.input.expectedIdentity};const pair={workspaceId:"workspace",agentId:"agent"};
      const pin=f.ownership.get(f.leaseId)!;
      const witness={workspaceQueryable:true,agentQueryable:true,agentReconciled:true,witnessWorkspaceId:pair.workspaceId,witnessAgentId:pair.agentId};let calls=0;
      if(failure==="close-response") CutoverStateStore.prototype.close=function(id,r){originalClose.call(this,id,r);throw new Error("lost close response");};
      if(failure==="terminal-write") f.manager.store.finish=()=>{throw new Error("terminal receipt failure");};
      await assert.rejects(f.manager.finishCutover(id,failure==="wrong-runtime"?f.input.currentIdentity:replacement,pair,async()=>{
        calls++;
        if(failure==="revoke") f.revoke();
        if(failure==="handoff") {
          const owner=f.options.resolveOwnerContext!,resolver=f.options.resolveEffectBinding;
          f.options.resolveOwnerContext=c=>c===recipient?{ownerThread:"recipient"}:owner(c);
          f.options.resolveEffectBinding=(c,s)=>resolver(c===recipient?f.context:c,s);
          f.ownership.handoff(f.context,f.leaseId,pin.version,recipient,{resource:pin.resource,scope:pin.scope,baseRevision:pin.baseRevision,candidateRevision:"candidate",liveOperation:pin.operation,liveHandle:start.operationId,checkpoint:"pending-finish",grantDependency:pin.grant,grantVersion:pin.grantVersion,recipientGrant:pin.grant,recipientGrantVersion:pin.grantVersion,forbiddenOverlap:[pin.resource],tests:["drain"],evidence:["bound-file"],remainingGap:"finish",nextGate:"reconcile",expiresAt:pin.expiresAt});
        }
        return {...witness,...(failure==="wrong-pair"?{witnessAgentId:"wrong"}:{})};
      },f.context));
      assert.equal(f.ownership.get(f.leaseId)?.operationHandle,start.operationId);
      assert.notEqual(f.manager.store.getByOperationId(start.operationId)?.receipt?.lifecycleTerminal,true);
      const file=new CutoverStateStore(f.config.stateDir).get()!;
      assert.equal(file.phase,["close-response","terminal-write"].includes(failure)?"closed":"drained");
      if(failure==="wrong-runtime") assert.equal(calls,0);
      if(failure==="handoff") {
        await assert.rejects(f.manager.finishCutover(id,replacement,pair,async()=>witness,f.context));
        assert.equal((await f.manager.finishCutover(id,replacement,pair,async()=>witness,recipient)).phase,"closed");
      }
      if(["close-response","terminal-write"].includes(failure)) {
        CutoverStateStore.prototype.close=originalClose;f.manager.store.finish=originalFinish;
        assert.equal((await f.manager.finishCutover(id,replacement,pair,async()=>{throw new Error("must not repeat reconciliation");},f.context)).phase,"closed");
        assert.equal(f.ownership.get(f.leaseId)?.operationHandle,undefined);
      }
    } finally {CutoverStateStore.prototype.close=originalClose;f.manager.store.finish=originalFinish;f.manager.close();}
  }
});

test("C3 final finish authority callback cannot overwrite a changed durable intent",async()=>{
  const {CutoverStateStore}=await import("./cutover-state.js");const f=cutoverFixture();
  try {
    const start=f.manager.startCutover(f.input,f.context);const id=start.receipt!.cutoverId as string;
    f.options.approveCutoverLifecycle=()=>true;
    f.manager.drainCutover(id,f.input.currentIdentity,()=>({activeSessions:0,oldestAgeMs:0}),f.context);
    const pin=f.ownership.get(f.leaseId);const intent=f.manager.store.getByOperationId(start.operationId);
    const verifier=f.options.verifyGrantEvidence!;let attacked=false;
    f.options.verifyGrantEvidence=(grant,owner)=>{
      if(!attacked&&new CutoverStateStore(f.config.stateDir).get()?.phase==="closed") {
        attacked=true;f.manager.store.finish(start.operationId,{status:"failed",retrySafe:false,errorMessage:"newer callback intent"});
      }
      return verifier(grant,owner);
    };
    await assert.rejects(f.manager.finishCutover(id,{serverInstanceId:"replacement",...f.input.expectedIdentity},{workspaceId:"workspace",agentId:"agent"},async()=>({workspaceQueryable:true,agentQueryable:true,agentReconciled:true,witnessWorkspaceId:"workspace",witnessAgentId:"agent"}),f.context),/intent changed/);
    assert.equal(attacked,true);assert.deepEqual(f.ownership.get(f.leaseId),pin);assert.deepEqual(f.manager.store.getByOperationId(start.operationId),intent);
    assert.equal(new CutoverStateStore(f.config.stateDir).get()?.phase,"closed");
  } finally {f.manager.close();}
});
