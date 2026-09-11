import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadCoordinationReaders, parseCoordinationReaderArgs } from "./coordination-reader-loader.js";
import * as readerLoader from "./coordination-reader-loader.js";

test("completion-only serve selection loads evidence bindings without identity hooks",async()=>{
  const source=`export function createCompletionBindings(){return [{repository:'Owner/Repo',goal:'goal',subject:'subject',readers:{readContract:()=>({source:'fixture-only'}),readEvidence:()=>[]}}];}`;
  await artifact(source,async(path,sha256)=>{
    const selected=readerLoader.parseServeReaderArgs(["--completion-reader-module",path,"--completion-reader-sha256",sha256]);
    const bindings=await readerLoader.loadCompletionBindings(selected.completion,"state");
    assert.equal(bindings?.[0]?.repository,"owner/repo");
    assert.deepEqual(bindings?.[0]?.readers.readEvidence({goal:"goal",candidate:"candidate",subject:"subject"}),[]);
    assert.equal(Object.isFrozen(bindings),true);
  });
});

test("serve readers reject incomplete or mixed modes before loading",()=>{
  for(const args of [
    ["--completion-reader-module","/tmp/reader.mjs"],
    ["--completion-reader-sha256","a".repeat(64)],
    ["--completion-reader-module","/tmp/reader.mjs","--coordination-reader-sha256","a".repeat(64)],
    ["--completion-reader-module","/tmp/reader.mjs","--completion-reader-module","/tmp/reader.mjs"],
    ["--completion-reader-unknown","value"],
  ]) assert.throws(()=>readerLoader.parseServeReaderArgs(args));
  const args=["--coordination-reader-module","/tmp/reader.mjs","--coordination-reader-sha256","a".repeat(64)];
  assert.deepEqual(readerLoader.parseServeReaderArgs(args).coordination,parseCoordinationReaderArgs(args));
});

for(const body of [
  "return {};",
  "return [{repository:'repo',goal:'g',subject:'s',readers:{readContract(){},readEvidence(){},verifyGrantEvidence(){return true}}}];",
  "const b={repository:'owner/repo',goal:'g',subject:'s',readers:{readContract(){},readEvidence(){}}};return [b,b];",
  "return [{repository:'repo',goal:'g',subject:'s',readers:{readContract:'PRIVATE_DETAIL',readEvidence(){}}}];",
  "throw new Error('PRIVATE_DETAIL');",
  "return import('node:fs');",
]) test(`completion factory rejects invalid output ${createHash('sha256').update(body).digest('hex').slice(0,8)}`,async()=>{
  await artifact(`export function createCompletionBindings(){${body}}`,async(modulePath,sha256)=>{
    await assert.rejects(readerLoader.loadCompletionBindings({modulePath,sha256},"state"),error=>{
      assert.equal((error as Error).message,"Completion reader bootstrap failed; verify the selected artifact and reader contract.");return true;
    });
  });
});

test("completion loading rejects changed bytes and missing factory",async()=>{
  await artifact("export function createCompletionBindings(){return [];}",async(modulePath,sha256)=>{
    await writeFile(modulePath,"throw new Error('PRIVATE_DETAIL');");
    await assert.rejects(readerLoader.loadCompletionBindings({modulePath,sha256},"state"),/Completion reader bootstrap failed/);
  });
  await artifact(factory,async(modulePath,sha256)=>{
    await assert.rejects(readerLoader.loadCompletionBindings({modulePath,sha256},"state"),/Completion reader bootstrap failed/);
  });
});

const factory = `export function createCoordinationReaders(context) {
 if (!Object.isFrozen(context) || Object.keys(context).join() !== 'stateDir') throw new Error('bad context');
 return {resolveOwnerContext: () => undefined, verifyGrantEvidence: () => false, resolveEffectBinding: () => undefined};
}`;
async function artifact(source: string, run: (path: string, sha256: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "devspace-reader-"));
  try {
    const path = join(root, "reader.mjs");
    await writeFile(path, source);
    await run(path, createHash("sha256").update(source).digest("hex"));
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("reader selection requires exact local artifact and digest pair", () => {
  assert.equal(parseCoordinationReaderArgs([]), undefined);
  for (const args of [["--coordination-reader-module", "relative.mjs"], ["--coordination-reader-sha256", "a".repeat(64)], ["--coordination-reader-module"], ["--unknown", "value"]]) {
    assert.throws(() => parseCoordinationReaderArgs(args));
  }
});

test("verified exact bytes load frozen reader hooks without minting authority", async () => {
  assert.equal(await loadCoordinationReaders(undefined, "state"), undefined);
  await artifact(`import { sep } from 'node:path';\n${factory}`, async (path, sha256) => {
    const selection = parseCoordinationReaderArgs(["--coordination-reader-module", path, "--coordination-reader-sha256", sha256])!;
    const readers = await loadCoordinationReaders(selection, "state");
    assert.ok(Object.isFrozen(readers));
    assert.equal(readers?.resolveOwnerContext?.({ clientId: "authenticated-but-ungranted" }), undefined);
    await assert.rejects(loadCoordinationReaders({ modulePath: path, sha256: "0".repeat(64) }, "state"), /bootstrap failed/);
    await writeFile(path, "throw new Error('changed bytes');");
    await assert.rejects(loadCoordinationReaders(selection, "state"), /bootstrap failed/);
  });
});

for (const source of [
  `import './unattested.mjs'; ${factory}`,
  `export * from './unattested.mjs'; ${factory}`,
  `export { value } from 'unattested'; ${factory}`,
  `function nested(path) { return () => import(path); } ${factory}`,
  `export function createCoordinationReaders() { return import('node:path'); }`,
  `export const createCoordinationReaders = 1;`,
  `export function createCoordinationReaders() { return { resolveOwnerContext() {} }; }`,
  factory.replace('resolveEffectBinding: () => undefined', 'resolveEffectBinding: () => undefined, readCompletionEvidence: "secret"'),
  `export function createCoordinationReaders() { throw new Error('PRIVATE_FACTORY_DETAIL'); }`,
  `this is invalid syntax`,
]) {
  test(`reader artifact rejects unsupported syntax or invalid contract ${createHash("sha256").update(source).digest("hex").slice(0, 8)}`, async () => {
    await artifact(source, async (path, sha256) => {
      await assert.rejects(loadCoordinationReaders({ modulePath: path, sha256 }, "state"), error => {
        assert.equal((error as Error).message, "Coordination reader bootstrap failed; verify the selected artifact and reader contract.");
        return true;
      });
    });
  });
}
