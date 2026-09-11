import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const hookSource = fileURLToPath(new URL("../scripts/fix-node-pty-permissions.mjs", import.meta.url));
const helperModes = ["darwin-arm64", "darwin-x64"];
const hookText = await readFile(hookSource, "utf8");

async function fixture(layout: "nested" | "hoisted") {
  const root = await mkdtemp(join(tmpdir(), "devspace-pty-") );
  const app = layout === "nested" ? root : join(root, "app");
  const hook = join(app, "scripts", "fix-node-pty-permissions.mjs");
  const pty = join(layout === "nested" ? app : root, "node_modules/node-pty");
  await mkdir(join(app, "scripts"), { recursive: true });
  await mkdir(pty, { recursive: true });
  await writeFile(join(app, "package.json"), '{"type":"module"}\n');
  await writeFile(join(pty, "package.json"), '{"name":"node-pty","version":"fixture","main":"index.js"}\n');
  await writeFile(join(pty, "index.js"), "export {};\n");
  for (const mode of helperModes) {
    await mkdir(join(pty, "prebuilds", mode), { recursive: true });
    await writeFile(join(pty, "prebuilds", mode, "spawn-helper"), "sentinel");
    await chmod(join(pty, "prebuilds", mode, "spawn-helper"), 0o644);
  }
  await writeFile(hook, hookText);
  return { root, app, hook, pty };
}

async function runHook(hook: string) {
  return execFileAsync(process.execPath, [hook], { encoding: "utf8" });
}

test("repairs nested node-pty helpers and preserves sentinel bytes", { skip: process.platform !== "darwin" }, async () => {
  const f = await fixture("nested");
  try {
    await runHook(f.hook);
    for (const mode of helperModes) {
      const helper = join(f.pty, "prebuilds", mode, "spawn-helper");
      assert.equal((await (await import("node:fs/promises")).stat(helper)).mode & 0o777, 0o755);
      assert.equal(await readFile(helper, "utf8"), "sentinel");
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("repairs hoisted node-pty helpers through Node resolution", { skip: process.platform !== "darwin" }, async () => {
  const f = await fixture("hoisted");
  try {
    await runHook(f.hook);
    for (const mode of helperModes) {
      const helper = join(f.pty, "prebuilds", mode, "spawn-helper");
      assert.equal((await (await import("node:fs/promises")).stat(helper)).mode & 0o777, 0o755);
      assert.equal(await readFile(helper, "utf8"), "sentinel");
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("missing optional node-pty is a no-op and non-darwin is a no-op", async () => {
  const f = await fixture("nested");
  try {
    await rm(join(f.app, "node_modules"), { recursive: true, force: true });
    const mod = await import(`${pathToFileURL(f.hook).href}?linux=${Date.now()}`);
    await mod.fixNodePtyPermissions({ platform: "linux", hookUrl: pathToFileURL(f.hook).href });
    await mod.fixNodePtyPermissions({ platform: "darwin", hookUrl: pathToFileURL(f.hook).href });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("non-ENOENT resolver errors propagate", { skip: process.platform !== "darwin" }, async () => {
  const f = await fixture("nested");
  try {
    await writeFile(join(f.pty, "package.json"), "{broken\n");
    await assert.rejects(runHook(f.hook), /Invalid package config|Unexpected token/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("other MODULE_NOT_FOUND resolver failures propagate unchanged", async () => {
  const f = await fixture("nested");
  try {
    const code = `
      import Module from 'node:module';
      import assert from 'node:assert/strict';
      const hook = await import(${JSON.stringify(pathToFileURL(f.hook).href)});
      const original = Module._resolveFilename;
      const failure = Object.assign(new Error("Cannot find module 'resolver-internal'\\nRequire stack:"), {code: 'MODULE_NOT_FOUND'});
      Module._resolveFilename = () => { throw failure; };
      try { assert.throws(() => hook.resolveNodePtyPackage(), error => error === failure); }
      finally { Module._resolveFilename = original; }
    `;
    await execFileAsync(process.execPath, ["--input-type=module", "-e", code]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("non-darwin preserves helper permissions and unrelated dependency permissions", async () => {
  const f = await fixture("nested");
  try {
    const mod = await import(pathToFileURL(f.hook).href);
    const helper = join(f.pty, "prebuilds", "darwin-arm64", "spawn-helper");
    await chmod(helper, 0o644);
    const unrelated = join(f.app, "node_modules", "unrelated-helper");
    await writeFile(unrelated, "unchanged");
    await chmod(unrelated, 0o644);
    const { stat } = await import("node:fs/promises");
    const before = (await stat(helper)).mode;
    const otherBefore = (await stat(unrelated)).mode;
    await mod.fixNodePtyPermissions({platform: "linux"});
    assert.equal((await stat(helper)).mode, before);
    await mod.fixNodePtyPermissions({platform: "darwin"});
    assert.equal((await stat(unrelated)).mode, otherBefore);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
