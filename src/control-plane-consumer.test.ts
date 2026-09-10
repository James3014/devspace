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
    f.options.verifyDependencyReconciliation=e=>JSON.stringify(e)===JSON.stringify(proof);
    f.options.verifyReconciliationEvidence=e=>e.operationHandle===proof.operationHandle && e.detail===JSON.stringify({requestHash:proof.requestHash,exitCode:proof.exitCode,frozenInputsUnchanged:proof.frozenInputsUnchanged});
    // The host policy is fixed at construction; reopen against the same durable database.
    const reopened=new DurableOperationManager(f.config,undefined,undefined,undefined,f.options);
    try {
      const result=reopened.reconcileDependencySync(unknown.operationId,proof,f.context);
      assert.equal(result.status,"succeeded");
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
