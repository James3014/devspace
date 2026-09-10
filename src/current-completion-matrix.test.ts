import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ControlPlaneOwnershipError, initializeControlPlaneOwnershipDatabase } from "./control-plane-ownership.js";
import { getCompletionMatrixRow, upsertCompletionMatrixRow } from "./current-completion-matrix.js";

test("matrix restart preserves opaque revision and rejects stale CAS", () => {
  const sqlite = new Database(":memory:");
  initializeControlPlaneOwnershipDatabase(sqlite);
  const first = upsertCompletionMatrixRow(sqlite, { goal: "g", layer: "Runtime", source: "receipt", revision: "z-revision", status: "READY", freshness: "fresh", gap: "" }, 0);
  assert.equal(first.revision, "z-revision");
  const reopened = getCompletionMatrixRow(sqlite, "g", "Runtime");
  assert.equal(reopened?.version, 1);
  assert.throws(() => upsertCompletionMatrixRow(sqlite, { goal: "g", layer: "Runtime", source: "receipt", revision: "a-revision", status: "PASS", freshness: "fresh", gap: "" }, 1, "a-revision"), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "CAS_CONFLICT");
  sqlite.close();
});

test("malformed persisted matrix row fails closed", () => {
  const sqlite = new Database(":memory:");
  initializeControlPlaneOwnershipDatabase(sqlite);
  sqlite.prepare("insert into control_plane_completion_matrix (goal,layer,source,revision,status,freshness,gap,version,updated_at) values (?,?,?,?,?,?,?,?,?)").run("g", "Runtime", "receipt", "rev", "READY", "fresh", null, 0, new Date().toISOString());
  assert.throws(() => getCompletionMatrixRow(sqlite, "g", "Runtime"), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "MALFORMED");
  sqlite.close();
});

import { projectCompletion, type CompletionReaders } from "./current-completion-matrix.js";

function projectionFixture() {
  const now=Date.now();
  const selection={goal:"g",candidate:"candidate",subject:"installed-operation"};
  const criterion={id:"AC-1",layer:"SOURCE" as const,sourceRevision:"source",environment:"darwin",surface:"installed-mcp",independent:true,maxAgeMs:60000};
  const contract={goal:"g",candidate:"candidate",subject:selection.subject,source:"issue:62@contract",requiredLayers:["SOURCE"],criteria:[criterion]};
  const evidence={criterionId:"AC-1",layer:"SOURCE",sourceRevision:"source",candidate:"candidate",subject:selection.subject,source:"receipt:1",command:"run-real-operation",result:"PASS",artifactSha256:"a".repeat(64),environment:"darwin",surface:"installed-mcp",verifier:"reviewer",implementer:"worker",verificationState:"INDEPENDENTLY_VERIFIED",observedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+10000).toISOString(),limitations:[],nextGate:"none"};
  const records=[evidence];
  const readers:CompletionReaders={readContract:()=>contract,readEvidence:()=>records};
  return {now,selection,criterion,contract,evidence,records,readers};
}

test("C4 trusted complete evidence projects all separate layers without granting authority",()=>{
  const f=projectionFixture();const result=projectCompletion(f.selection,f.readers,f.now);
  assert.equal(result.status,"COMPLETE");assert.equal(result.authoritative,false);
  assert.equal(result.layers.SOURCE.status,"PASS");assert.equal(result.layers.NATIVE_SINGLE.status,"NOT_REQUIRED");
  assert.equal(Object.keys(result.layers).length,7);
  f.evidence.result="FAIL";assert.equal(result.criteria[0].evidence?.result,"PASS");
  assert.ok(Object.isFrozen(result.criteria[0].evidence));
});

test("C4 missing, partial, ambiguous and malformed contracts never complete",()=>{
  for(const alter of [(f:ReturnType<typeof projectionFixture>)=>{f.contract.criteria=[];},(f:ReturnType<typeof projectionFixture>)=>{f.contract.criteria.push({...f.criterion});},(f:ReturnType<typeof projectionFixture>)=>{f.contract.requiredLayers.push("CI");},(f:ReturnType<typeof projectionFixture>)=>{f.records.length=0;},(f:ReturnType<typeof projectionFixture>)=>{f.records.push({...f.evidence});}]){
    const f=projectionFixture();alter(f);assert.notEqual(projectCompletion(f.selection,f.readers,f.now).status,"COMPLETE");
  }
  const f=projectionFixture();f.contract.criteria.push({...f.criterion,id:"AC-2"});
  assert.notEqual(projectCompletion(f.selection,f.readers,f.now).status,"COMPLETE");
});

test("C4 stale, reported-only, wrong surface and non-independent evidence remain gaps",()=>{
  const changes=[{candidate:"other"},{subject:"other"},{sourceRevision:"other"},{result:"FAIL"},{verificationState:"HANDOFF_REPORTED"},{artifactSha256:"bad"},{surface:"unit-test"},{environment:"linux"},{verifier:"worker"},{observedAt:new Date(Date.now()+60000).toISOString()},{observedAt:new Date(Date.now()-120000).toISOString()},{expiresAt:new Date(0).toISOString()}];
  for(const change of changes){const f=projectionFixture();Object.assign(f.evidence,change);assert.notEqual(projectCompletion(f.selection,f.readers,f.now).status,"COMPLETE",JSON.stringify(change));}
});

test("C4 reader failure fails closed and callbacks cannot change frozen contract",()=>{
  const f=projectionFixture();
  assert.equal(projectCompletion(f.selection,{...f.readers,readEvidence:()=>{throw new Error("unavailable");}},f.now).status,"BLOCKED");
  f.readers.readEvidence=()=>{f.contract.criteria.length=0;return f.records;};
  const result=projectCompletion(f.selection,f.readers,f.now);assert.equal(result.criteria.length,1);
});
