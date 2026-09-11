import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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
    await assert.rejects(() => bind("process.exit(0)", { workspaceRoot: allowed }), /intersects/);

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
  } finally {
    await SandboxManager.reset().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}
