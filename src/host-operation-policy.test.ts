import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  bindHostOperation,
  prepareHostOperationSandbox,
  type HostOperationPolicy,
  type HostOperationRequest,
} from "./host-operation-policy.js";

const executablePath = process.execPath;
const executableSha256 = createHash("sha256").update(await readFile(executablePath)).digest("hex");

if (process.platform !== "darwin") {
  console.log("Host operation policy sandbox tests skipped: macOS-only acceptance scope.");
} else {
  const root = await mkdtemp(join(tmpdir(), "devspace-host-operation-policy-"));
  const allowed = join(root, "allowed-cache");
  const sibling = join(root, "sibling");
  const approvedRead = join(allowed, "approved.txt");
  const syntheticSecret = join(allowed, ".env");
  const keychainLike = join(allowed, "keychain-db");
  const outsideSecret = join(root, "outside-secret.txt");
  const runtimeConfig = "/opt/homebrew/etc/openssl@3/openssl.cnf";
  const allowedOutput = join(allowed, "allowed.txt");
  const siblingOutput = join(sibling, "outside.txt");
  await mkdir(allowed);
  await mkdir(sibling);
  await writeFile(approvedRead, "approved\n");
  await writeFile(syntheticSecret, "synthetic-secret-never-real\n");
  await writeFile(keychainLike, "synthetic-keychain-never-real\n");
  await writeFile(outsideSecret, "synthetic-outside-secret-never-real\n");

  const basePolicy: HostOperationPolicy = {
    enabled: true,
    ownerClientId: "owner-client",
    executablePath,
    executableSha256,
    argv: ["-e", ""],
    cwd: allowed,
    allowedPaths: { write: [allowed], read: [approvedRead, runtimeConfig] },
    maxWallMs: 5_000,
    maxIdleMs: 2_000,
    allowLongLivedProcess: false,
  };

  const bind = async (script: string, overrides: Partial<HostOperationRequest> = {}) => {
    const policy = { ...basePolicy, argv: ["-e", script] };
    const request: HostOperationRequest = {
      attemptKey: `attempt-${Math.random().toString(16).slice(2)}`,
      clientId: "owner-client",
      executablePath,
      argv: ["-e", script],
      cwd: allowed,
      allowedPaths: { write: [allowed], read: [approvedRead, runtimeConfig] },
      maxWallMs: 1_000,
      maxIdleMs: 500,
      allowLongLivedProcess: false,
      ...overrides,
    };
    return bindHostOperation(policy, request, "owner-client");
  };

  const run = async (script: string, overrides: Partial<HostOperationRequest> = {}) => {
    const bound = await bind(script, overrides);
    const wrapped = await prepareHostOperationSandbox(bound);
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolveResult, reject) => {
      const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), { cwd: allowed, env: wrapped.env, shell: false, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, stderr }); });
    });
    const violations = SandboxManager.getSandboxViolationStore().getViolationsForCommand(bound.operationId);
    SandboxManager.cleanupAfterCommand();
    return { bound, result, violations };
  };

  try {
    const allowedWrite = await run(`require("node:fs").writeFileSync(${JSON.stringify(allowedOutput)}, "ok")`);
    assert.equal(allowedWrite.result.code, 0, JSON.stringify(allowedWrite.result));
    assert.equal(await readFile(allowedOutput, "utf8"), "ok");

    const deniedWrite = await run(`require("node:fs").writeFileSync(${JSON.stringify(siblingOutput)}, "blocked")`);
    assert.notEqual(deniedWrite.result.code, 0);
    assert.equal((await import("node:fs")).existsSync(siblingOutput), false);
    assert.ok(deniedWrite.result.stderr.includes("EPERM") || deniedWrite.result.stderr.includes("EACCES") || deniedWrite.violations.length > 0);

    const deniedSecret = await run(`process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(syntheticSecret)}, "utf8"))`);
    assert.notEqual(deniedSecret.result.code, 0);
    assert.ok(deniedSecret.result.stderr.includes("EPERM") || deniedSecret.result.stderr.includes("EACCES") || deniedSecret.violations.length > 0);

    const deniedKeychain = await run(`process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(keychainLike)}, "utf8"))`);
    assert.notEqual(deniedKeychain.result.code, 0);
    assert.ok(deniedKeychain.result.stderr.includes("EPERM") || deniedKeychain.result.stderr.includes("EACCES") || deniedKeychain.violations.length > 0);

    const deniedOutside = await run(`process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(outsideSecret)}, "utf8"))`);
    assert.notEqual(deniedOutside.result.code, 0);
    assert.ok(deniedOutside.result.stderr.includes("EPERM") || deniedOutside.result.stderr.includes("EACCES") || deniedOutside.violations.length > 0);

    const approvedReadResult = await run(`if (require("node:fs").readFileSync(${JSON.stringify(approvedRead)}, "utf8") !== "approved\\n") process.exit(4)`);
    assert.equal(approvedReadResult.result.code, 0);

    const deniedNetwork = await run("require('node:http').get('http://127.0.0.1:1').on('error', e => { process.stderr.write(e.code || e.message); process.exit(2); })");
    assert.notEqual(deniedNetwork.result.code, 0);
    assert.ok(deniedNetwork.result.stderr.includes("EPERM") || deniedNetwork.result.stderr.includes("EACCES") || deniedNetwork.violations.length > 0);

    const deniedFork = await run("require('node:child_process').fork(process.execPath, ['-e', 'process.exit(0)']).on('error', e => { process.stderr.write(e.code || e.message); process.exit(2); })");
    assert.notEqual(deniedFork.result.code, 0, "sandboxed host operation must deny child process fork");
    const readOnlyExec = await run("process.stdout.write('readonly')", { allowedPaths: { write: [], read: [approvedRead, runtimeConfig] } });
    assert.equal(readOnlyExec.result.code, 0, "read-only harmless command must execute");
    await assert.rejects(() => bind("process.exit(0)", { allowedPaths: { write: [process.cwd()], read: [approvedRead] } }), /outside startup policy|repository|configured repository/i);

    const fixtureRoot = join(root, "rebind-fixtures");
    const fixtureExecutable = join(fixtureRoot, "true");
    const fixtureWrite = join(fixtureRoot, "write-cache");
    const fixtureBackup = join(fixtureRoot, "write-cache-backup");
    const fixtureExternal = join(fixtureRoot, "external");
    await mkdir(fixtureRoot);
    await mkdir(fixtureWrite);
    await mkdir(fixtureExternal);
    await copyFile("/usr/bin/true", fixtureExecutable);
    await chmod(fixtureExecutable, 0o755);
    const fixtureHash = createHash("sha256").update(await readFile(fixtureExecutable)).digest("hex");
    const fixturePolicy: HostOperationPolicy = {
      ...basePolicy,
      executablePath: fixtureExecutable,
      executableSha256: fixtureHash,
      argv: [],
      allowedPaths: { write: [fixtureWrite], read: [] },
    };
    const fixtureRequest: HostOperationRequest = {
      attemptKey: "fixture-rebind",
      clientId: "owner-client",
      executablePath: fixtureExecutable,
      argv: [],
      cwd: allowed,
      allowedPaths: { write: [fixtureWrite], read: [] },
      maxWallMs: 1_000,
      maxIdleMs: 500,
      allowLongLivedProcess: false,
    };
    const changedExecutableBound = await bindHostOperation(fixturePolicy, fixtureRequest, "owner-client");
    await writeFile(fixtureExecutable, Buffer.concat([await readFile(fixtureExecutable), Buffer.from([0]) ]));
    await assert.rejects(() => prepareHostOperationSandbox(changedExecutableBound), /Bound executable changed/);

    await copyFile("/usr/bin/true", fixtureExecutable);
    await chmod(fixtureExecutable, 0o755);
    const changedScopeBound = await bindHostOperation(fixturePolicy, fixtureRequest, "owner-client");
    await rename(fixtureWrite, fixtureBackup);
    await symlink(fixtureExternal, fixtureWrite);
    await assert.rejects(() => prepareHostOperationSandbox(changedScopeBound), /Bound write scope changed/);

    const frozen = await bind("process.exit(0)");
    assert.equal(Object.isFrozen(frozen), true);
    assert.equal(Object.isFrozen(frozen.request), true);
    assert.equal(Object.isFrozen(frozen.request.allowedPaths), true);
    await assert.rejects(() => bind("process.exit(0)", { clientId: "other-client" }), /client identity/);
    await assert.rejects(() => bind("process.exit(0)", { argv: ["-e", "process.exit(1)"] }), /exactly match/);
    await assert.rejects(() => bind("process.exit(0)", { maxWallMs: 9_000 }), /time limits/);
    await assert.rejects(() => bind("process.exit(0)", { allowedPaths: { write: [sibling], read: [approvedRead] } }), /outside startup policy/);
    await assert.rejects(() => bind("process.exit(0)", { workspaceRoot: allowed }), /supplied together/);
    await assert.rejects(() => bind("process.exit(0)", { workspaceId: "ws-only" }), /supplied together/);
    await assert.rejects(() => bind("process.exit(0)", { workspaceId: "ws-intersect", workspaceRoot: allowed }), /intersects/);
    const workspaceBound = await bind("process.exit(0)", { workspaceId: "ws-exact", workspaceRoot: sibling });
    assert.equal(workspaceBound.request.workspaceId, "ws-exact");
    assert.equal(workspaceBound.request.workspaceRoot, await realpath(sibling));

    const readOnlyPolicy = { ...basePolicy, allowedPaths: { write: [], read: [approvedRead, runtimeConfig] }, argv: ["-e", "process.exit(0)"] };
    const readOnlyRequest: HostOperationRequest = {
      attemptKey: "read-only",
      executablePath,
      argv: ["-e", "process.exit(0)"],
      cwd: allowed,
      allowedPaths: { write: [], read: [approvedRead, runtimeConfig] },
      maxWallMs: 1_000,
      maxIdleMs: 500,
      allowLongLivedProcess: false,
    };
    const readOnlyBound = await bindHostOperation(readOnlyPolicy, readOnlyRequest, "owner-client");
    assert.deepEqual(readOnlyBound.request.allowedPaths.write, []);
    const readOnlySandbox = await prepareHostOperationSandbox(readOnlyBound);
    const generatedProfile = readOnlySandbox.argv.join("\n");
    assert.doesNotMatch(generatedProfile, /\(subpath "\/opt\/homebrew"\)/, "runtime dylib carveouts must not grant the Homebrew parent subtree");

    // Verify Node 24 original layout passes if installed
    const node24Candidates = [
      "/opt/homebrew/opt/node@24/bin/node",
      "/opt/homebrew/Cellar/node@24/24.21.0/bin/node",
    ];
    let node24Path: string | undefined;
    for (const candidate of node24Candidates) {
      try {
        if ((await stat(candidate)).isFile()) {
          node24Path = candidate;
          break;
        }
      } catch {}
    }
    if (node24Path) {
      const canonicalNode24 = await realpath(node24Path);
      const node24Hash = createHash("sha256").update(await readFile(canonicalNode24)).digest("hex");
      const node24Policy: HostOperationPolicy = {
        ...basePolicy,
        executablePath: canonicalNode24,
        executableSha256: node24Hash,
        argv: ["-e", "process.stdout.write('node24-ok')"],
        allowedPaths: { write: [allowed], read: [approvedRead, runtimeConfig] },
      };
      const node24Request: HostOperationRequest = {
        attemptKey: "node24-rpath-test",
        clientId: "owner-client",
        executablePath: canonicalNode24,
        argv: ["-e", "process.stdout.write('node24-ok')"],
        cwd: allowed,
        allowedPaths: { write: [allowed], read: [approvedRead, runtimeConfig] },
        maxWallMs: 2_000,
        maxIdleMs: 1_000,
        allowLongLivedProcess: false,
      };
      const boundNode24 = await bindHostOperation(node24Policy, node24Request, "owner-client");
      const wrappedNode24 = await prepareHostOperationSandbox(boundNode24);
      const node24Run = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolveResult, reject) => {
        const child = spawn(wrappedNode24.argv[0]!, wrappedNode24.argv.slice(1), { cwd: allowed, env: wrappedNode24.env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("close", (code) => { clearTimeout(timer); resolveResult({ code, stderr, stdout }); });
      });
      assert.equal(node24Run.code, 0, `Node 24 should succeed under sandbox: ${node24Run.stderr}`);
      assert.equal(node24Run.stdout, "node24-ok");
    }

    // Regression test: executable whose dylib is reachable ONLY through @loader_path/../lib
    const rpathFixtureDir = join(root, "rpath-regression");
    const rpathBinDir = join(rpathFixtureDir, "bin");
    const rpathLibDir = join(rpathFixtureDir, "lib");
    await mkdir(rpathBinDir, { recursive: true });
    await mkdir(rpathLibDir, { recursive: true });
    const libSrc = join(rpathFixtureDir, "libanswer.c");
    const runnerSrc = join(rpathFixtureDir, "runner.c");
    const dylibPath = join(rpathLibDir, "libanswer.dylib");
    const runnerPath = join(rpathBinDir, "runner");
    await writeFile(libSrc, "int get_answer(void) { return 42; }\n");
    await writeFile(runnerSrc, "int get_answer(void); int main(void) { return get_answer() == 42 ? 0 : 1; }\n");
    const { spawnSync: ccSpawnSync } = await import("node:child_process");
    const ccCompileDylib = ccSpawnSync("clang", ["-shared", "-o", dylibPath, libSrc, "-install_name", "@rpath/libanswer.dylib"], { encoding: "utf8" });
    assert.equal(ccCompileDylib.status, 0, ccCompileDylib.stderr);
    const ccCompileRunner = ccSpawnSync("clang", ["-o", runnerPath, runnerSrc, `-L${rpathLibDir}`, "-lanswer", "-Wl,-rpath,@loader_path/../lib"], { encoding: "utf8" });
    assert.equal(ccCompileRunner.status, 0, ccCompileRunner.stderr);
    await chmod(runnerPath, 0o755);

    // Verify dylib is not present in bin/
    const { existsSync: fsExistsSync } = await import("node:fs");
    assert.equal(fsExistsSync(join(rpathBinDir, "libanswer.dylib")), false);

    const canonicalRunner = await realpath(runnerPath);
    const canonicalDylib = await realpath(dylibPath);
    const runnerHash = createHash("sha256").update(await readFile(canonicalRunner)).digest("hex");
    const rpathPolicy: HostOperationPolicy = {
      ...basePolicy,
      executablePath: canonicalRunner,
      executableSha256: runnerHash,
      argv: [],
      allowedPaths: { write: [allowed], read: [] },
    };
    const rpathRequest: HostOperationRequest = {
      attemptKey: "rpath-regression-test",
      clientId: "owner-client",
      executablePath: canonicalRunner,
      argv: [],
      cwd: allowed,
      allowedPaths: { write: [allowed], read: [] },
      maxWallMs: 2_000,
      maxIdleMs: 1_000,
      allowLongLivedProcess: false,
    };
    const boundRpath = await bindHostOperation(rpathPolicy, rpathRequest, "owner-client");
    const wrappedRpath = await prepareHostOperationSandbox(boundRpath);
    const rpathProfile = wrappedRpath.argv.join("\n");
    assert.ok(rpathProfile.includes(canonicalDylib), "sandbox profile must include exact carveout for resolved dylib");
    assert.doesNotMatch(rpathProfile, new RegExp(`\\(subpath "${rpathFixtureDir}"\\)`), "sandbox profile must not grant entire fixture root as subpath");

    const rpathRun = await new Promise<{ code: number | null; stderr: string }>((resolveResult, reject) => {
      const child = spawn(wrappedRpath.argv[0]!, wrappedRpath.argv.slice(1), { cwd: allowed, env: wrappedRpath.env, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); resolveResult({ code, stderr }); });
    });
    assert.equal(rpathRun.code, 0, `runner with @loader_path/../lib dylib must succeed: ${rpathRun.stderr}`);

    // Regression test: sibling dylibs must not leak LC_RPATH to each other.
    // Binary `siblingRunner` links against sibling dylibs libA and libB.
    // libA declares LC_RPATH pointing to privateA/ which contains liba_dep.dylib and libb_dep.dylib.
    // libB declares LC_RPATH pointing to privateB/ (empty) and depends on @rpath/libb_dep.dylib.
    // libB must NOT be able to resolve libb_dep.dylib via sibling libA's LC_RPATH.
    const siblingFixtureDir = join(root, "sibling-isolation-regression");
    const siblingBinDir = join(siblingFixtureDir, "bin");
    const siblingLibADir = join(siblingFixtureDir, "libA");
    const siblingLibBDir = join(siblingFixtureDir, "libB");
    const siblingPrivateADir = join(siblingLibADir, "privateA");
    const siblingPrivateBDir = join(siblingLibBDir, "privateB");
    await mkdir(siblingBinDir, { recursive: true });
    await mkdir(siblingPrivateADir, { recursive: true });
    await mkdir(siblingPrivateBDir, { recursive: true });

    const siblingRunnerSrc = join(siblingFixtureDir, "sibling_runner.c");
    const libASrc = join(siblingFixtureDir, "liba.c");
    const libBSrc = join(siblingFixtureDir, "libb.c");
    const libADepSrc = join(siblingFixtureDir, "liba_dep.c");
    const libBDepSrc = join(siblingFixtureDir, "libb_dep.c");

    await writeFile(libADepSrc, "int get_a_dep(void) { return 10; }\n");
    await writeFile(libBDepSrc, "int get_b_dep(void) { return 20; }\n");
    await writeFile(libASrc, "int get_a_dep(void); int get_a(void) { return get_a_dep(); }\n");
    await writeFile(libBSrc, "int get_b_dep(void); int get_b(void) { return get_b_dep(); }\n");
    await writeFile(siblingRunnerSrc, "int get_a(void); int get_b(void); int main(void) { return (get_a() == 10 && get_b() == 20) ? 0 : 1; }\n");

    const siblingRunnerPath = join(siblingBinDir, "sibling_runner");
    const libAPath = join(siblingLibADir, "liba.dylib");
    const libBPath = join(siblingLibBDir, "libb.dylib");
    const libADepPath = join(siblingPrivateADir, "liba_dep.dylib");
    const libBDepPath = join(siblingPrivateADir, "libb_dep.dylib");

    // Compile dependencies in privateA
    const ccADep = ccSpawnSync("clang", ["-shared", "-o", libADepPath, libADepSrc, "-install_name", "@rpath/liba_dep.dylib"], { encoding: "utf8" });
    assert.equal(ccADep.status, 0, ccADep.stderr);
    const ccBDep = ccSpawnSync("clang", ["-shared", "-o", libBDepPath, libBDepSrc, "-install_name", "@rpath/libb_dep.dylib"], { encoding: "utf8" });
    assert.equal(ccBDep.status, 0, ccBDep.stderr);

    // libA: LC_RPATH = @loader_path/privateA, depends on @rpath/liba_dep.dylib
    const ccLibA = ccSpawnSync("clang", ["-shared", "-o", libAPath, libASrc, "-install_name", "@rpath/liba.dylib", `-L${siblingPrivateADir}`, "-la_dep", "-Wl,-rpath,@loader_path/privateA"], { encoding: "utf8" });
    assert.equal(ccLibA.status, 0, ccLibA.stderr);

    // libB: LC_RPATH = @loader_path/privateB, depends on @rpath/libb_dep.dylib (linked against privateA at build time)
    const ccLibB = ccSpawnSync("clang", ["-shared", "-o", libBPath, libBSrc, "-install_name", "@rpath/libb.dylib", `-L${siblingPrivateADir}`, "-lb_dep", "-Wl,-rpath,@loader_path/privateB"], { encoding: "utf8" });
    assert.equal(ccLibB.status, 0, ccLibB.stderr);

    // sibling_runner: links to libA and libB with rpaths @loader_path/../libA and @loader_path/../libB
    const ccSiblingRunner = ccSpawnSync("clang", ["-o", siblingRunnerPath, siblingRunnerSrc, `-L${siblingLibADir}`, "-la", `-L${siblingLibBDir}`, "-lb", "-Wl,-rpath,@loader_path/../libA", "-Wl,-rpath,@loader_path/../libB"], { encoding: "utf8" });
    assert.equal(ccSiblingRunner.status, 0, ccSiblingRunner.stderr);
    await chmod(siblingRunnerPath, 0o755);
    const siblingLoadCommands = ccSpawnSync("/usr/bin/otool", ["-L", siblingRunnerPath], { encoding: "utf8" });
    assert.equal(siblingLoadCommands.status, 0, siblingLoadCommands.stderr);
    assert.match(siblingLoadCommands.stdout, /@rpath\/libb\.dylib/, "fixture must prove sibling libB is a direct load dependency");

    const canonicalSiblingRunner = await realpath(siblingRunnerPath);
    const canonicalLibADep = await realpath(libADepPath);
    const canonicalLibBDep = await realpath(libBDepPath);
    const siblingRunnerHash = createHash("sha256").update(await readFile(canonicalSiblingRunner)).digest("hex");

    const siblingPolicy: HostOperationPolicy = {
      ...basePolicy,
      executablePath: canonicalSiblingRunner,
      executableSha256: siblingRunnerHash,
      argv: [],
      allowedPaths: { write: [allowed], read: [] },
    };
    const siblingRequest: HostOperationRequest = {
      attemptKey: "sibling-isolation-regression-test",
      clientId: "owner-client",
      executablePath: canonicalSiblingRunner,
      argv: [],
      cwd: allowed,
      allowedPaths: { write: [allowed], read: [] },
      maxWallMs: 2_000,
      maxIdleMs: 1_000,
      allowLongLivedProcess: false,
    };
    const boundSibling = await bindHostOperation(siblingPolicy, siblingRequest, "owner-client");
    const wrappedSibling = await prepareHostOperationSandbox(boundSibling);
    const siblingProfile = wrappedSibling.argv.join("\n");

    // Sibling A's dependency should be resolved and carved out
    assert.ok(siblingProfile.includes(canonicalLibADep), "sandbox profile must include exact carveout for libA's dependency");
    // Sibling B must NOT resolve libb_dep through sibling A's privateA LC_RPATH
    assert.ok(!siblingProfile.includes(canonicalLibBDep), "sibling B must not resolve libb_dep via sibling A's LC_RPATH");

    // Regression test: current image LC_RPATH must win over inherited ancestor rpaths.
    const precedenceFixtureDir = join(root, "rpath-precedence-regression");
    const precedenceBinDir = join(precedenceFixtureDir, "bin");
    const precedenceChildDir = join(precedenceFixtureDir, "child");
    const precedenceChildPrivateDir = join(precedenceChildDir, "private");
    const precedenceAncestorDir = join(precedenceFixtureDir, "ancestor");
    await mkdir(precedenceBinDir, { recursive: true });
    await mkdir(precedenceChildPrivateDir, { recursive: true });
    await mkdir(precedenceAncestorDir, { recursive: true });

    const precedenceChoiceSrc = join(precedenceFixtureDir, "choice.c");
    const precedenceChildSrc = join(precedenceFixtureDir, "child.c");
    const precedenceRunnerSrc = join(precedenceFixtureDir, "runner.c");
    const precedenceChildChoice = join(precedenceChildPrivateDir, "libchoice.dylib");
    const precedenceAncestorChoice = join(precedenceAncestorDir, "libchoice.dylib");
    const precedenceChild = join(precedenceChildDir, "libchild.dylib");
    const precedenceRunner = join(precedenceBinDir, "runner");
    await writeFile(precedenceChoiceSrc, "int choice(void) { return 7; }\\n");
    await writeFile(precedenceChildSrc, "int choice(void); int child_value(void) { return choice(); }\\n");
    await writeFile(precedenceRunnerSrc, "int child_value(void); int main(void) { return child_value() == 7 ? 0 : 1; }\\n");

    const ccChildChoice = ccSpawnSync("clang", ["-shared", "-o", precedenceChildChoice, precedenceChoiceSrc, "-install_name", "@rpath/libchoice.dylib"], { encoding: "utf8" });
    assert.equal(ccChildChoice.status, 0, ccChildChoice.stderr);
    const ccAncestorChoice = ccSpawnSync("clang", ["-shared", "-o", precedenceAncestorChoice, precedenceChoiceSrc, "-install_name", "@rpath/libchoice.dylib"], { encoding: "utf8" });
    assert.equal(ccAncestorChoice.status, 0, ccAncestorChoice.stderr);
    const ccPrecedenceChild = ccSpawnSync("clang", ["-shared", "-o", precedenceChild, precedenceChildSrc, "-install_name", "@rpath/libchild.dylib", \`-L\${precedenceChildPrivateDir}\`, "-lchoice", "-Wl,-rpath,@loader_path/private"], { encoding: "utf8" });
    assert.equal(ccPrecedenceChild.status, 0, ccPrecedenceChild.stderr);
    const ccPrecedenceRunner = ccSpawnSync("clang", ["-o", precedenceRunner, precedenceRunnerSrc, \`-L\${precedenceChildDir}\`, "-lchild", "-Wl,-rpath,@loader_path/../child", "-Wl,-rpath,@loader_path/../ancestor"], { encoding: "utf8" });
    assert.equal(ccPrecedenceRunner.status, 0, ccPrecedenceRunner.stderr);
    await chmod(precedenceRunner, 0o755);

    const canonicalPrecedenceRunner = await realpath(precedenceRunner);
    const canonicalChildChoice = await realpath(precedenceChildChoice);
    const canonicalAncestorChoice = await realpath(precedenceAncestorChoice);
    const precedenceRunnerHash = createHash("sha256").update(await readFile(canonicalPrecedenceRunner)).digest("hex");
    const precedencePolicy: HostOperationPolicy = {
      ...basePolicy,
      executablePath: canonicalPrecedenceRunner,
      executableSha256: precedenceRunnerHash,
      argv: [],
      allowedPaths: { write: [allowed], read: [] },
    };
    const precedenceRequest: HostOperationRequest = {
      attemptKey: "rpath-precedence-regression-test",
      clientId: "owner-client",
      executablePath: canonicalPrecedenceRunner,
      argv: [],
      cwd: allowed,
      allowedPaths: { write: [allowed], read: [] },
      maxWallMs: 2_000,
      maxIdleMs: 1_000,
      allowLongLivedProcess: false,
    };
    const boundPrecedence = await bindHostOperation(precedencePolicy, precedenceRequest, "owner-client");
    const wrappedPrecedence = await prepareHostOperationSandbox(boundPrecedence);
    const precedenceProfile = wrappedPrecedence.argv.join("\\n");
    assert.ok(precedenceProfile.includes(canonicalChildChoice), "current image LC_RPATH must resolve its own child-private dylib first");
    assert.ok(!precedenceProfile.includes(canonicalAncestorChoice), "inherited ancestor LC_RPATH must not shadow the current image LC_RPATH");

    // Regression test: unsupported relative LC_RPATH entries must not create carveouts.
    const relativeFixtureDir = join(root, "relative-rpath-regression");
    const relativeBinDir = join(relativeFixtureDir, "bin");
    const relativePrivateDir = join(relativeBinDir, "relative-private");
    await mkdir(relativePrivateDir, { recursive: true });
    const relativeLibSrc = join(relativeFixtureDir, "relative-lib.c");
    const relativeRunnerSrc = join(relativeFixtureDir, "relative-runner.c");
    const relativeLib = join(relativePrivateDir, "librelative.dylib");
    const relativeRunner = join(relativeBinDir, "runner");
    await writeFile(relativeLibSrc, "int relative_value(void) { return 9; }\\n");
    await writeFile(relativeRunnerSrc, "int relative_value(void); int main(void) { return relative_value() == 9 ? 0 : 1; }\\n");
    const ccRelativeLib = ccSpawnSync("clang", ["-shared", "-o", relativeLib, relativeLibSrc, "-install_name", "@rpath/librelative.dylib"], { encoding: "utf8" });
    assert.equal(ccRelativeLib.status, 0, ccRelativeLib.stderr);
    const ccRelativeRunner = ccSpawnSync("clang", ["-o", relativeRunner, relativeRunnerSrc, \`-L\${relativePrivateDir}\`, "-lrelative", "-Wl,-rpath,relative-private"], { encoding: "utf8" });
    assert.equal(ccRelativeRunner.status, 0, ccRelativeRunner.stderr);
    await chmod(relativeRunner, 0o755);
    const relativeRpaths = ccSpawnSync("/usr/bin/otool", ["-l", relativeRunner], { encoding: "utf8" });
    assert.equal(relativeRpaths.status, 0, relativeRpaths.stderr);
    assert.match(relativeRpaths.stdout, /path relative-private \\(offset \\d+\\)/, "fixture must contain the unsupported relative LC_RPATH");

    const canonicalRelativeRunner = await realpath(relativeRunner);
    const canonicalRelativeLib = await realpath(relativeLib);
    const relativeRunnerHash = createHash("sha256").update(await readFile(canonicalRelativeRunner)).digest("hex");
    const relativePolicy: HostOperationPolicy = {
      ...basePolicy,
      executablePath: canonicalRelativeRunner,
      executableSha256: relativeRunnerHash,
      argv: [],
      allowedPaths: { write: [allowed], read: [] },
    };
    const relativeRequest: HostOperationRequest = {
      attemptKey: "relative-rpath-regression-test",
      clientId: "owner-client",
      executablePath: canonicalRelativeRunner,
      argv: [],
      cwd: allowed,
      allowedPaths: { write: [allowed], read: [] },
      maxWallMs: 2_000,
      maxIdleMs: 1_000,
      allowLongLivedProcess: false,
    };
    const boundRelative = await bindHostOperation(relativePolicy, relativeRequest, "owner-client");
    const wrappedRelative = await prepareHostOperationSandbox(boundRelative);
    const relativeProfile = wrappedRelative.argv.join("\\n");
    assert.ok(!relativeProfile.includes(canonicalRelativeLib), "unsupported relative LC_RPATH must not create an exact dylib carveout");
  } finally {
    await SandboxManager.reset().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}
