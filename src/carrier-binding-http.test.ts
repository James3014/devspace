import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createTcpServer } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { CarrierBindingStore, type CarrierContract } from "./carrier-binding.js";
import { openDatabase } from "./db/client.js";

function data(result: Awaited<ReturnType<Client["callTool"]>>): Record<string,any> {
  assert.notEqual(result.isError,true,JSON.stringify(result));
  if(result.structuredContent) return result.structuredContent;
  const content=result.content as Array<{type:string;text?:string}>;
  return JSON.parse(content.find(item=>item.type==="text")!.text!);
}
test("CLI completion-only startup preserves pairing and rejects altered or mixed modules",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"completion-cli-")));
  const workspace=join(root,"workspace");mkdirSync(workspace);
  const socket=createTcpServer();
  await new Promise<void>(resolve=>socket.listen(0,"127.0.0.1",resolve));
  const port=(socket.address() as {port:number}).port;
  await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const env={...process.env,DEVSPACE_CONFIG_DIR:join(root,"config"),DEVSPACE_STATE_DIR:join(root,"state"),DEVSPACE_ALLOWED_ROOTS:workspace,DEVSPACE_WORKTREE_ROOT:join(root,"worktrees"),DEVSPACE_SUBAGENTS:"false",DEVSPACE_PUBLIC_BASE_URL:`http://127.0.0.1:${port}`,DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-that-is-long-enough",PORT:String(port)};
  const config=loadConfig(env);
  const provider=new SingleUserOAuthProvider(config.oauth,new URL("/mcp",config.publicBaseUrl),config.stateDir);
  const oauthClient=await provider.clientsStore.registerClient!({redirect_uris:["http://localhost/callback"],client_name:"CLI fixture",token_endpoint_auth_method:"none"});
  let redirect="";
  await provider.authorize(oauthClient,{redirectUri:"http://localhost/callback",codeChallenge:"fixture",scopes:config.oauth.scopes,resource:new URL("/mcp",config.publicBaseUrl)},{req:{method:"POST",body:{owner_token:config.oauth.ownerToken}},redirect:(_status:number,url:string)=>{redirect=url;}} as never);
  const tokens=await provider.exchangeAuthorizationCode(oauthClient,new URL(redirect).searchParams.get("code")!);
  const artifact=join(root,"completion.mjs");
  const source=`export function createCompletionBindings(context){
    if(!Object.isFrozen(context)) throw new Error('context');
    return [{repository:'James3014/devspace',goal:'issue62',subject:'cli-fixture',readers:{
      readContract:s=>({...s,source:'synthetic-cli-test-only',requiredLayers:['SOURCE'],criteria:[{id:'source',layer:'SOURCE',sourceRevision:s.candidate,environment:'test',surface:'CLI',independent:true,maxAgeMs:60000}]}),
      readEvidence:()=>[]}}];}`;
  writeFileSync(artifact,source);
  const digest=createHash("sha256").update(source).digest("hex");
  const cli=process.env.DEVSPACE_TEST_INSTALLED_CLI;
  const entry=cli ? [cli] : ["--import","tsx",fileURLToPath(new URL("./cli.ts",import.meta.url))];
  const flags=["--completion-reader-module",artifact,"--completion-reader-sha256",digest];
  const child=spawn(process.execPath,[...entry,"serve",...flags],{env,stdio:["ignore","pipe","pipe"]});
  const client=new Client({name:"CLI completion fixture",version:"1"});
  try {
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("CLI readiness timeout")),20000);
      child.once("error",error=>{clearTimeout(timer);reject(error);});
      child.once("exit",code=>{clearTimeout(timer);reject(new Error(`CLI exited before readiness: ${code}`));});
      let output="";
      child.stdout.on("data",chunk=>{output+=chunk.toString();if(output.includes("devspace listening on")){clearTimeout(timer);resolve();}});
      child.stderr.on("data",()=>{});
    });
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp",config.publicBaseUrl),{requestInit:{headers:{Authorization:`Bearer ${tokens.access_token}`}}}));
    assert.equal((await client.callTool({name:"coordination_carrier_status",arguments:{}})).isError,true);
    const pending=data(await client.callTool({name:"coordination_pair",arguments:{}}));
    const contractPath=join(root,"contract.json");
    writeFileSync(contractPath,JSON.stringify({repository:"James3014/devspace",goal:"issue62",role:"controller",scope:[workspace],baseRevision:"a".repeat(40),operations:["dependency_sync"],expiresAt:new Date(Date.now()+60000).toISOString()}));
    execFileSync(process.execPath,[...entry,"carrier","inspect",pending.pendingId],{env,stdio:"pipe"});
    execFileSync(process.execPath,[...entry,"carrier","approve",pending.pendingId,"--contract",contractPath,"--confirm",pending.pendingId],{env,stdio:"pipe"});
    data(await client.callTool({name:"coordination_resume",arguments:{credential:pending.credential}}));
    const projection=data(await client.callTool({name:"coordination_completion_read",arguments:{goal:"issue62",subject:"cli-fixture",candidate:"b".repeat(40)}})).projection;
    assert.equal(projection.contractSource,"synthetic-cli-test-only");
    assert.equal(projection.status,"INCOMPLETE");
    assert.equal(projection.criteria[0].gap,"MISSING_EVIDENCE");
    const cutoverClient=new Client({name:"CLI cutover fixture",version:"1"});
    try {
      await cutoverClient.connect(new StreamableHTTPClientTransport(new URL("/mcp",config.publicBaseUrl),{requestInit:{headers:{Authorization:`Bearer ${tokens.access_token}`}}}));
      const status=data(await cutoverClient.callTool({name:"cutover_status",arguments:{}})).status;
      const identity=status.currentServerIdentity;
      const expiry=new Date(Date.now()+60000).toISOString();
      const args={attemptKey:"installed-cli-cutover",expectedSourceCommit:"b".repeat(40),expectedBuildId:"target-fixture",expectedCapabilityManifestSha256:"d".repeat(64),expiresAt:expiry};
      assert.equal((await cutoverClient.callTool({name:"coordination_prepare_cutover",arguments:args})).isError,true);
      const pendingCutover=data(await cutoverClient.callTool({name:"coordination_pair",arguments:{}}));
      const approved={repository:"James3014/devspace",goal:"issue62",role:"controller",scope:[config.stateDir],baseRevision:identity.sourceCommit,operations:["cutover_start"],expiresAt:expiry,
        cutover:{stateRoot:config.stateDir,attemptKey:args.attemptKey,currentIdentity:identity,expectedIdentity:{sourceCommit:args.expectedSourceCommit,buildId:args.expectedBuildId,capabilityManifestSha256:args.expectedCapabilityManifestSha256},expiresAt:expiry,
          restart:{buildReady:{verifiedBy:"fixture",verifiedAt:new Date().toISOString(),evidence:"synthetic isolated test only"},actuator:"launchd-self",serviceLabel:"isolated-test",launchdTarget:"gui/501/isolated-test"},finish:{workspaceId:"ws_fixture",agentId:"agt_fixture"}}};
      const approvalPath=join(root,"cutover-contract.json");
      // A cutover-shaped field cannot expand a dependency contract to stateDir.
      writeFileSync(approvalPath,JSON.stringify({...approved,operations:["dependency_sync"]}));
      assert.throws(()=>execFileSync(process.execPath,[...entry,"carrier","approve",pendingCutover.pendingId,"--contract",approvalPath,"--confirm",pendingCutover.pendingId],{env,stdio:"pipe"}));
      writeFileSync(approvalPath,JSON.stringify(approved));
      if(identity.sourceCommit==="unverified") {
        assert.equal(cli,undefined,"Installed CLI must carry a verified source identity");
        assert.throws(()=>execFileSync(process.execPath,[...entry,"carrier","approve",pendingCutover.pendingId,"--contract",approvalPath,"--confirm",pendingCutover.pendingId],{env,stdio:"pipe"}));
        assert.equal((await cutoverClient.callTool({name:"coordination_prepare_cutover",arguments:args})).isError,true);
      } else {
      execFileSync(process.execPath,[...entry,"carrier","approve",pendingCutover.pendingId,"--contract",approvalPath,"--confirm",pendingCutover.pendingId],{env,stdio:"pipe"});
      data(await cutoverClient.callTool({name:"coordination_resume",arguments:{credential:pendingCutover.credential}}));
      assert.equal((await cutoverClient.callTool({name:"coordination_prepare_cutover",arguments:{...args,expectedBuildId:"wrong-target"}})).isError,true);
      const prepared=data(await cutoverClient.callTool({name:"coordination_prepare_cutover",arguments:args}));
      assert.equal(prepared.subject.baseRevision,identity.sourceCommit);
      assert.equal((await cutoverClient.callTool({name:"cutover_start",arguments:{...args,attemptKey:"changed"}})).isError,true);
      const started=data(await cutoverClient.callTool({name:"cutover_start",arguments:args}));
      assert.equal(started.operationId,prepared.subject.operationId);
      const readback=data(await cutoverClient.callTool({name:"cutover_status",arguments:{}})).status.cutover;
      assert.equal(readback.coordinationBinding.operationHandle,prepared.subject.operationId);
      assert.equal(readback.coordinationBinding.requestHash,prepared.subject.requestHash);
      data(await cutoverClient.callTool({name:"cutover_drain",arguments:{cutoverId:started.cutover.cutoverId}}));
      assert.equal(data(await cutoverClient.callTool({name:"cutover_status",arguments:{}})).status.cutover.phase,"drained");
      }
    } finally {await cutoverClient.close().catch(()=>{});}
  } finally {
    await client.close().catch(()=>{});
    if(child.exitCode===null){
      const exited=new Promise<void>(resolve=>child.once("exit",()=>resolve()));
      const killTimer=setTimeout(()=>child.kill("SIGKILL"),5000);
      child.kill("SIGTERM");await exited;clearTimeout(killTimer);
    }
    provider.close();
  }
  try {
    writeFileSync(artifact,"throw new Error('PRIVATE_DETAIL');");
    for(const args of [flags,[...flags,"--coordination-reader-module",artifact,"--coordination-reader-sha256",digest]]) {
      const failed=spawnSync(process.execPath,[...entry,"serve",...args],{env,encoding:"utf8",timeout:20000});
      assert.notEqual(failed.status,0);
      assert.equal(failed.error,undefined);
      assert.doesNotMatch(failed.stdout,/devspace listening on/);
      assert.doesNotMatch(failed.stderr,/PRIVATE_DETAIL/);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("real HTTP clients sharing OAuth pair independently, delegate, resume, execute frozen npm and reject revoked identity",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"carrier-http-")));
  const project=join(root,"project");mkdirSync(project);
  const git=(args:string[])=>execFileSync("git",args,{cwd:project,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  git(["init"]);git(["-c","user.name=Fixture","-c","user.email=fixture@example.test","commit","--allow-empty","-m","fixture"]);
  const base=git(["rev-parse","HEAD"]);
  const vendor=join(project,"vendor","canary-local");mkdirSync(vendor,{recursive:true});
  writeFileSync(join(vendor,"package.json"),JSON.stringify({name:"canary-local",version:"1.0.0"}));
  writeFileSync(join(vendor,"witness.txt"),"ISSUE62_INSTALLED_DEPENDENCY_CANARY");
  writeFileSync(join(project,"package.json"),JSON.stringify({name:"carrier-canary",version:"1.0.0",dependencies:{"canary-local":"file:vendor/canary-local"}}));
  writeFileSync(join(project,"package-lock.json"),JSON.stringify({name:"carrier-canary",version:"1.0.0",lockfileVersion:3,packages:{"":{name:"carrier-canary",version:"1.0.0",dependencies:{"canary-local":"file:vendor/canary-local"}},"node_modules/canary-local":{resolved:"vendor/canary-local",link:true},"vendor/canary-local":{version:"1.0.0"}}}));
  const config=loadConfig({DEVSPACE_CONFIG_DIR:join(root,"config"),DEVSPACE_ALLOWED_ROOTS:root,DEVSPACE_STATE_DIR:join(root,"state"),DEVSPACE_WORKTREE_ROOT:join(root,"worktrees"),DEVSPACE_SUBAGENTS:"false",DEVSPACE_PUBLIC_BASE_URL:"http://127.0.0.1:1",DEVSPACE_OAUTH_OWNER_TOKEN:"test-owner-token-that-is-long-enough",PORT:"1"});
  const provider=new SingleUserOAuthProvider(config.oauth,new URL("/mcp",config.publicBaseUrl),config.stateDir);
  const oauthClient=await provider.clientsStore.registerClient!({redirect_uris:["http://localhost/callback"],client_name:"shared carrier fixture",token_endpoint_auth_method:"none"});
  let redirect="";
  await provider.authorize(oauthClient,{redirectUri:"http://localhost/callback",codeChallenge:"fixture",scopes:config.oauth.scopes,resource:new URL("/mcp",config.publicBaseUrl)}, {req:{method:"POST",body:{owner_token:config.oauth.ownerToken}},redirect:(_status:number,url:string)=>{redirect=url;}} as never);
  const tokens=await provider.exchangeAuthorizationCode(oauthClient,new URL(redirect).searchParams.get("code")!);
  let now=Date.now();
  const selection={goal:"issue62",subject:"delivery",candidate:"b".repeat(40)};
  let verificationState="INDEPENDENTLY_VERIFIED",verifier="reviewer";
  const completionBindings=[{repository:"James3014/devspace",goal:"issue62",subject:"delivery",readers:{
    readContract:()=>({...selection,source:"fixture-contract",requiredLayers:["SOURCE"],criteria:[{id:"source",layer:"SOURCE",sourceRevision:selection.candidate,environment:"fixture",surface:"HTTP",independent:true,maxAgeMs:60000}]}),
    readEvidence:()=>[{criterionId:"source",layer:"SOURCE",sourceRevision:selection.candidate,candidate:selection.candidate,subject:selection.subject,source:"fixture-evidence",command:"fixture",result:"PASS",artifactSha256:"a".repeat(64),environment:"fixture",surface:"HTTP",verifier,implementer:"implementer",verificationState,observedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString(),limitations:[],nextGate:"native acceptance"}],
  }}];
  assert.throws(()=>createServer(config,{completionBindings,coordination:{} as never}),/mutually exclusive/);
  const running=createServer(config,{carrierClock:()=>now,completionBindings});
  const localOwner=new CarrierBindingStore(config.stateDir,()=>now);
  const database=openDatabase(config.stateDir);
  const snapshot=()=>JSON.stringify({effects:database.sqlite.prepare("select * from carrier_effect_bindings order by operation_id").all(),leases:database.sqlite.prepare("select * from control_plane_resource_leases order by lease_id").all(),operations:database.sqlite.prepare("select * from durable_operations order by operation_id").all()});
  const listener=running.app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve=>listener.once("listening",resolve));
  const url=new URL(`http://127.0.0.1:${(listener.address() as {port:number}).port}/mcp`);
  const clients:Client[]=[];
  async function connect(name:string) {
    const client=new Client({name,version:"1"});clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${tokens.access_token}`}}}));
    return client;
  }
  try {
    const controller=await connect("controller"), worker=await connect("worker");
    const request=data(await controller.callTool({name:"coordination_pair",arguments:{}}));
    const contract:CarrierContract={repository:"James3014/devspace",goal:"issue62",role:"controller",scope:[root],baseRevision:base,operations:["dependency_sync"],expiresAt:new Date(Date.now()+120000).toISOString()};
    localOwner.approveLocal(request.pendingId,contract);
    data(await controller.callTool({name:"coordination_resume",arguments:{credential:request.credential}}));
    const completion=()=>controller.callTool({name:"coordination_completion_read",arguments:selection});
    assert.equal(data(await completion()).projection.status,"COMPLETE");
    verificationState="HANDOFF_REPORTED";
    assert.equal(data(await completion()).projection.status,"INCOMPLETE");
    verificationState="INDEPENDENTLY_VERIFIED";verifier="implementer";
    assert.equal(data(await completion()).projection.status,"INCOMPLETE");
    verifier="reviewer";
    const foreign=data(await controller.callTool({name:"coordination_completion_read",arguments:{...selection,subject:"foreign"}})).projection;
    assert.equal(foreign.status,"BLOCKED");
    assert.deepEqual(foreign.criteria,[]);
    const pending=data(await worker.callTool({name:"coordination_pair",arguments:{}}));
    const child=data(await controller.callTool({name:"coordination_delegate",arguments:{pendingId:pending.pendingId,contract:{...contract,role:"worker",scope:[project]}}}));
    data(await worker.callTool({name:"coordination_resume",arguments:{credential:pending.credential}}));
    const opened=data(await worker.callTool({name:"open_workspace",arguments:{path:project,mode:"checkout"}}));
    const args={workspaceId:opened.workspaceId,attemptKey:"carrier-real-npm",recipe:"npm_ci"};
    const imposter=await connect("same-client-imposter");
    const before=snapshot();
    assert.equal((await imposter.callTool({name:"coordination_prepare_dependencies",arguments:args,_meta:{ownerThread:child.id,role:"controller"}})).isError,true);
    assert.equal((await worker.callTool({name:"coordination_delegate",arguments:{pendingId:pending.pendingId,contract}})).isError,true);
    assert.equal(snapshot(),before);
    const prepared=data(await worker.callTool({name:"coordination_prepare_dependencies",arguments:args}));
    await worker.close();
    const resumed=await connect("worker-reconnected");
    assert.equal((await resumed.callTool({name:"dependency_sync",arguments:args})).isError,true);
    data(await resumed.callTool({name:"coordination_resume",arguments:{credential:pending.credential}}));
    const result=data(await resumed.callTool({name:"dependency_sync",arguments:args}));
    assert.equal(result.status,"succeeded");
    assert.equal(result.operationId,prepared.subject.operationId);
    assert.ok(existsSync(join(project,"node_modules","canary-local","witness.txt")),"real npm created installed state");
    assert.equal(data(await resumed.callTool({name:"dependency_sync",arguments:args})).operationId,result.operationId);
    const nextArgs={...args,attemptKey:"carrier-next-operation"};
    const nextPrepared=data(await resumed.callTool({name:"coordination_prepare_dependencies",arguments:nextArgs}));
    assert.equal(nextPrepared.lease.leaseId,prepared.lease.leaseId);
    assert.equal(data(await resumed.callTool({name:"dependency_sync",arguments:nextArgs})).status,"succeeded");
    data(await controller.callTool({name:"coordination_revoke_worker",arguments:{carrierId:child.id,expectedVersion:child.version}}));
    const revoked=snapshot();
    assert.equal((await resumed.callTool({name:"dependency_sync",arguments:args})).isError,true);
    assert.equal((await imposter.callTool({name:"coordination_resume",arguments:{credential:pending.credential}})).isError,true);
    assert.equal(snapshot(),revoked);
    const second=join(root,"second-project");
    cpSync(project,second,{recursive:true,filter:path=>!path.includes("node_modules")});
    const secondOpened=data(await controller.callTool({name:"open_workspace",arguments:{path:second,mode:"checkout"}}));
    const secondArgs={workspaceId:secondOpened.workspaceId,attemptKey:"controller-handoff",recipe:"npm_ci"};
    const secondPrepared=data(await controller.callTool({name:"coordination_prepare_dependencies",arguments:secondArgs}));
    const successor=await connect("next-controller");
    const nextPair=data(await successor.callTool({name:"coordination_pair",arguments:{}}));
    const nextOwner=localOwner.approveLocal(nextPair.pendingId,contract);
    data(await successor.callTool({name:"coordination_resume",arguments:{credential:nextPair.credential}}));
    const lease=secondPrepared.lease;
    const receipt={resource:lease.resource,baseRevision:base,scope:lease.scope,candidateRevision:base,liveOperation:lease.operation,liveHandle:"",checkpoint:"prepared-http",grantDependency:lease.grant,grantVersion:lease.grantVersion,recipientGrant:nextOwner.grant,recipientGrantVersion:1,forbiddenOverlap:lease.scope,tests:["http-pairing"],evidence:["prepared-http-effect"],remainingGap:"execute prepared operation",nextGate:"dependency_sync",expiresAt:lease.expiresAt};
    const narrow=await connect("insufficient-scope-controller");
    const narrowPair=data(await narrow.callTool({name:"coordination_pair",arguments:{}}));
    const narrowOwner=localOwner.approveLocal(narrowPair.pendingId,{...contract,scope:[project]});
    data(await narrow.callTool({name:"coordination_resume",arguments:{credential:narrowPair.credential}}));
    const beforeHandoff=snapshot();
    assert.equal((await controller.callTool({name:"coordination_handoff",arguments:{leaseId:lease.leaseId,expectedVersion:lease.version,recipientHandle:narrowOwner.id,receipt:{...receipt,recipientGrant:narrowOwner.grant}}})).isError,true);
    assert.equal(snapshot(),beforeHandoff);
    data(await controller.callTool({name:"coordination_handoff",arguments:{leaseId:lease.leaseId,expectedVersion:lease.version,recipientHandle:nextOwner.id,receipt}}));
    assert.equal((await controller.callTool({name:"dependency_sync",arguments:secondArgs})).isError,true);
    const transferred=data(await successor.callTool({name:"dependency_sync",arguments:secondArgs}));
    assert.equal(transferred.status,"succeeded");
    assert.equal(transferred.operationId,secondPrepared.subject.operationId);
    assert.equal((database.sqlite.prepare("select count(*) as count from control_plane_resource_leases where resource=?").get(lease.resource) as {count:number}).count,1);
    now=Date.parse(contract.expiresAt)+1000;
    assert.equal((await successor.callTool({name:"coordination_lease_read",arguments:{leaseId:lease.leaseId}})).isError,true);
    const refreshed=localOwner.reauthorizeLocal(nextOwner.id,1,new Date(now+120000).toISOString());
    assert.equal(refreshed.id,nextOwner.id);
    assert.deepEqual(refreshed.grant,nextOwner.grant);
    const recoveredClient=await connect("reauthorized-controller");
    data(await recoveredClient.callTool({name:"coordination_resume",arguments:{credential:nextPair.credential}}));
    const expiredLease=data(await recoveredClient.callTool({name:"coordination_lease_read",arguments:{leaseId:lease.leaseId}}));
    assert.equal(expiredLease.operationHandle,undefined);
    const freshArgs={...secondArgs,attemptKey:"after-explicit-release"};
    assert.equal((await recoveredClient.callTool({name:"coordination_prepare_dependencies",arguments:freshArgs})).isError,true);
    data(await recoveredClient.callTool({name:"coordination_lease_release",arguments:{leaseId:lease.leaseId,expectedVersion:expiredLease.version}}));
    const freshPrepared=data(await recoveredClient.callTool({name:"coordination_prepare_dependencies",arguments:freshArgs}));
    assert.notEqual(freshPrepared.lease.leaseId,lease.leaseId);
    assert.equal(data(await recoveredClient.callTool({name:"dependency_sync",arguments:freshArgs})).status,"succeeded");


  } finally {
    for(const client of clients) await client.close().catch(()=>{});
    await running.close();
    await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));
    database.close();localOwner.close();provider.close();
    rmSync(root,{recursive:true,force:true});
  }
});
