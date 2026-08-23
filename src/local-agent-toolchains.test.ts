import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  buildToolchainEnvironment,
  describeToolchainExecutables,
  parseToolchains,
  resolveToolchainExecutable,
  runToolchainVerifier,
  type ToolchainSpec,
} from "./local-agent-toolchains.js";

function dependencyBridgeFixture(version = "1.0.0") {
  const root = mkdtempSync(join(tmpdir(), "devspace-dependency-root-"));
  const workspace = mkdtempSync(join(tmpdir(), "devspace-dependency-workspace-"));
  const packageJson = {
    name: "dependency-candidate",
    private: true,
    dependencies: {
      "fixture-package": "^1.0.0",
      "unrelated-package": "^2.0.0",
    },
  };
  const lock = JSON.stringify({
    name: "dependency-candidate",
    lockfileVersion: 3,
    packages: {
      "": packageJson,
      "node_modules/fixture-package": { version: "1.0.0" },
      "node_modules/unrelated-package": { version: "2.0.0" },
    },
  });
  const sourceLock = JSON.stringify({
    name: "dependency-source",
    lockfileVersion: 3,
    packages: {
      "": { ...packageJson, name: "dependency-source" },
      "node_modules/fixture-package": { version: "1.0.0" },
      "node_modules/unrelated-package": { version: "1.9.9" },
    },
  });
  const lockfileSha256 = createHash("sha256").update(lock).digest("hex");
  writeFileSync(join(root, "package.json"), JSON.stringify({ ...packageJson, name: "dependency-source" }));
  writeFileSync(join(root, "package-lock.json"), sourceLock);
  writeFileSync(join(workspace, "package.json"), JSON.stringify(packageJson));
  writeFileSync(join(workspace, "package-lock.json"), lock);
  mkdirSync(join(root, "node_modules", "fixture-package"), { recursive: true });
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  writeFileSync(
    join(root, "node_modules", "fixture-package", "package.json"),
    JSON.stringify({ name: "fixture-package", version, type: "module", exports: "./index.js" }),
  );
  writeFileSync(join(root, "node_modules", "fixture-package", "index.js"), "export default 'bridged';\n");
  writeFileSync(join(root, "source-value.mjs"), "export default 'source-checkout-source';\n");
  writeFileSync(
    join(root, "probe.mjs"),
    "import source from './source-value.mjs'; import dependency from 'fixture-package'; console.log(`${source}:${dependency}`);\n",
  );
  const verifierLoader = join(root, "node_modules", ".bin", "verifier-loader.mjs");
  const verifierExecutable = join(root, "node_modules", ".bin", "tsx-fixture.mjs");
  writeFileSync(
    verifierLoader,
    [
      'import { registerHooks } from "node:module";',
      "registerHooks({ resolve(specifier, context, nextResolve) {",
      "  return nextResolve(specifier, context);",
      "} });",
    ].join("\n"),
  );
  writeFileSync(
    verifierExecutable,
    [
      "#!/usr/bin/env node",
      'import { spawnSync } from "node:child_process";',
      `const child = spawnSync(process.execPath, ["--import", ${JSON.stringify(pathToFileURL(verifierLoader).href)}, ...process.argv.slice(2)], { env: process.env, stdio: "inherit" });`,
      "process.exit(child.status ?? 1);",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(join(workspace, "source-value.mjs"), "export default 'worktree-source';\n");
  writeFileSync(
    join(workspace, "probe.mjs"),
    "import source from './source-value.mjs'; import dependency from 'fixture-package'; console.log(`${source}:${dependency}`);\n",
  );
  return {
    root,
    workspace,
    lock,
    sourceLock,
    packageJson,
    spec: {
      id: "node",
      root,
      verifiers: {},
      dependencyBridge: {
        lockfileSha256,
        packages: ["fixture-package"],
      },
    } satisfies ToolchainSpec,
    verifierExecutable,
    clean() {
      rmSync(root, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

test("parseToolchains parses valid JSON and rejects invalid input", () => {
  assert.deepEqual(parseToolchains(undefined), []);
  assert.deepEqual(parseToolchains(""), []);
  assert.throws(() => parseToolchains("{not json"), /not valid JSON/);
  assert.throws(() => parseToolchains('{"id":"x"}'), /JSON array/);

  const specs = parseToolchains(
    JSON.stringify([
      {
        id: "nexus-python",
        root: "/known/repo/toolchain",
        verifiers: { pytest: "/known/repo/toolchain/.venv/bin/pytest", ruff: "bin/ruff" },
      },
    ]),
  );
  assert.equal(specs.length, 1);
  assert.equal(specs[0].id, "nexus-python");
  assert.deepEqual(specs[0].verifiers, {
    pytest: "/known/repo/toolchain/.venv/bin/pytest",
    ruff: "bin/ruff",
  });

  assert.throws(
    () => parseToolchains(JSON.stringify([{ id: "x" }])),
    /string id and root/,
  );

  assert.throws(
    () => parseToolchains(JSON.stringify([{ id: "x", root: "/x", verifiers: {}, dependencyBridge: {} }])),
    /packages/,
  );

  const selected = parseToolchains(JSON.stringify([{
    id: "selected",
    root: "/x",
    verifiers: {},
    dependencyBridge: { packages: ["fixture-package"] },
  }]));
  assert.deepEqual(selected[0].dependencyBridge?.packages, ["fixture-package"]);
});

test("dependency bridge admits a differing source lock when selected Candidate packages match", () => {
  const fixture = dependencyBridgeFixture();
  try {
    const environment = buildToolchainEnvironment(
      [fixture.spec],
      fixture.spec.id,
      fixture.workspace,
      { PATH: "/usr/bin", EXISTING: "kept" },
    );
    assert.equal(environment.EXISTING, "kept");
    assert.equal(environment.NODE_PATH, realpathSync(join(fixture.root, "node_modules")));
    assert.equal(
      environment.PATH?.split(":")[0],
      realpathSync(join(fixture.root, "node_modules", ".bin")),
    );
    assert.equal(environment.DEVSPACE_DEPENDENCY_ROOT, realpathSync(fixture.root));
    const probe = spawnSync(
      process.execPath,
      [join(fixture.workspace, "probe.mjs")],
      { cwd: fixture.workspace, env: environment, encoding: "utf8" },
    );
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout.trim(), "worktree-source:bridged");
    assert.equal(existsSync(join(fixture.workspace, "node_modules")), false);
  } finally {
    fixture.clean();
  }
});

test("dependency bridge takes precedence over an existing module hook", () => {
  const fixture = dependencyBridgeFixture();
  try {
    const hookedProbe = join(fixture.workspace, "hooked-probe.mjs");
    writeFileSync(
      hookedProbe,
      [
        'import { registerHooks } from "node:module";',
        "registerHooks({ resolve(specifier, context, nextResolve) {",
        "  if (specifier === 'fixture-package') throw new Error('existing hook intercepted dependency');",
        "  return nextResolve(specifier, context);",
        "} });",
        "await import('./probe.mjs');",
      ].join("\n"),
    );
    const environment = buildToolchainEnvironment(
      [fixture.spec],
      fixture.spec.id,
      fixture.workspace,
      {},
    );
    const probe = spawnSync(process.execPath, [hookedProbe], {
      cwd: fixture.workspace,
      env: environment,
      encoding: "utf8",
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout.trim(), "worktree-source:bridged");
  } finally {
    fixture.clean();
  }
});

test("dependency bridge never borrows a package from a workspace ancestor", () => {
  const fixture = dependencyBridgeFixture();
  const ancestor = mkdtempSync(join(tmpdir(), "devspace-dependency-ancestor-"));
  const workspace = join(ancestor, "checkout");
  try {
    mkdirSync(workspace);
    writeFileSync(join(workspace, "package.json"), JSON.stringify(fixture.packageJson));
    writeFileSync(join(workspace, "package-lock.json"), fixture.lock);
    mkdirSync(join(ancestor, "node_modules", "borrowed-package"), { recursive: true });
    writeFileSync(
      join(ancestor, "node_modules", "borrowed-package", "package.json"),
      JSON.stringify({ name: "borrowed-package", version: "9.9.9", type: "module", exports: "./index.js" }),
    );
    writeFileSync(join(ancestor, "node_modules", "borrowed-package", "index.js"), "export default 'borrowed';\n");
    writeFileSync(
      join(workspace, "probe.mjs"),
      "import value from 'borrowed-package'; console.log(value);\n",
    );
    const environment = buildToolchainEnvironment([fixture.spec], fixture.spec.id, workspace, {});
    const probe = spawnSync(process.execPath, [join(workspace, "probe.mjs")], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });
    assert.notEqual(probe.status, 0);
    assert.match(probe.stderr, /borrowed-package/);
  } finally {
    rmSync(ancestor, { recursive: true, force: true });
    fixture.clean();
  }
});

test("dependency bridge never uses a source-ancestor package as selected evidence", () => {
  const fixture = dependencyBridgeFixture();
  const ancestor = mkdtempSync(join(tmpdir(), "devspace-source-ancestor-"));
  const sourceRoot = join(ancestor, "source");
  try {
    mkdirSync(join(sourceRoot, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(sourceRoot, "package.json"), JSON.stringify({ name: "source" }));
    mkdirSync(join(ancestor, "node_modules", "fixture-package"), { recursive: true });
    writeFileSync(
      join(ancestor, "node_modules", "fixture-package", "package.json"),
      JSON.stringify({ name: "fixture-package", version: "1.0.0" }),
    );
    const spec: ToolchainSpec = { ...fixture.spec, root: sourceRoot };
    assert.throws(
      () => buildToolchainEnvironment([spec], spec.id, fixture.workspace, {}),
      /fixture-package.*is missing/,
    );
  } finally {
    rmSync(ancestor, { recursive: true, force: true });
    fixture.clean();
  }
});

test("workspace verifier runs worktree source with dependencies from the verified bridge", async () => {
  const fixture = dependencyBridgeFixture();
  try {
    const spec: ToolchainSpec = {
      ...fixture.spec,
      verifiers: { tsx: fixture.verifierExecutable },
    };
    const result = await runToolchainVerifier({
      toolchains: [spec],
      toolchainId: spec.id,
      verifier: "tsx",
      args: [join(fixture.workspace, "probe.mjs")],
      cwd: fixture.workspace,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), "worktree-source:bridged");
    assert.equal(existsSync(join(fixture.workspace, "node_modules")), false);
  } finally {
    fixture.clean();
  }
});

test("dependency bridge fails closed for stale, missing, and incompatible dependency evidence", () => {
  const fixture = dependencyBridgeFixture("0.9.0");
  try {
    assert.throws(
      () => buildToolchainEnvironment([fixture.spec], fixture.spec.id, fixture.workspace, {}),
      /fixture-package.*requires \^1\.0\.0.*found 0\.9\.0/,
    );

    writeFileSync(
      join(fixture.root, "node_modules", "fixture-package", "package.json"),
      JSON.stringify({ name: "fixture-package", version: "1.0.0" }),
    );
    writeFileSync(join(fixture.workspace, "package-lock.json"), `${fixture.lock}\n`);
    assert.throws(
      () => buildToolchainEnvironment([fixture.spec], fixture.spec.id, fixture.workspace, {}),
      /workspace lockfile is stale/,
    );

    rmSync(join(fixture.root, "node_modules", "fixture-package"), { recursive: true, force: true });
    writeFileSync(join(fixture.workspace, "package-lock.json"), fixture.lock);
    assert.throws(
      () => buildToolchainEnvironment([fixture.spec], fixture.spec.id, fixture.workspace, {}),
      /fixture-package.*is missing/,
    );
  } finally {
    fixture.clean();
  }
});

test("dependency bridge rejects a Candidate lock that contradicts its package requirement", () => {
  const fixture = dependencyBridgeFixture();
  try {
    const contradictoryLock = JSON.parse(fixture.lock);
    contradictoryLock.packages["node_modules/fixture-package"].version = "2.0.0";
    writeFileSync(join(fixture.workspace, "package-lock.json"), JSON.stringify(contradictoryLock));
    const spec: ToolchainSpec = {
      ...fixture.spec,
      dependencyBridge: { packages: ["fixture-package"] },
    };
    assert.throws(
      () => buildToolchainEnvironment([spec], spec.id, fixture.workspace, {}),
      /Candidate lock.*fixture-package.*contradicts requirement \^1\.0\.0.*2\.0\.0/,
    );
  } finally {
    fixture.clean();
  }
});

test("resolveToolchainExecutable resolves allowlisted executables only", () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-toolchain-test-"));
  try {
    const bin = join(root, ".venv", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pytest"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(bin, "ruff"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const toolchains: ToolchainSpec[] = [
      { id: "nexus-python", root, verifiers: { pytest: join(bin, "pytest"), ruff: ".venv/bin/ruff" } },
    ];

    const pytest = resolveToolchainExecutable(toolchains, "nexus-python", "pytest");
    assert.ok(pytest);
    assert.equal(pytest.executable, realpathSync(join(bin, "pytest")));

    const ruff = resolveToolchainExecutable(toolchains, "nexus-python", "ruff");
    assert.ok(ruff);
    assert.equal(ruff.executable, realpathSync(join(bin, "ruff")));

    assert.equal(resolveToolchainExecutable(toolchains, "nexus-python", "mypy"), undefined);
    assert.equal(resolveToolchainExecutable(toolchains, "unknown-toolchain", "pytest"), undefined);
    assert.equal(resolveToolchainExecutable(toolchains, "nexus-python", "missing"), undefined);

    assert.deepEqual(Object.keys(describeToolchainExecutables(toolchains, "nexus-python") ?? {}).sort(), [
      "pytest",
      "ruff",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runToolchainVerifier runs allowlisted executable with bounded cwd and structured exit code", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-toolchain-test-"));
  const workRoot = mkdtempSync(join(tmpdir(), "devspace-toolchain-cwd-"));
  try {
    const bin = join(root, ".venv", "bin");
    mkdirSync(bin, { recursive: true });
    const verifierPath = join(bin, "pytest");
    writeFileSync(
      verifierPath,
      [
        "#!/bin/sh",
        'echo "cwd=$(pwd)"',
        "echo \"args=$*\"",
        `if [ "$1" = "fail" ]; then exit 3; fi`,
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(verifierPath, 0o755);

    const toolchains: ToolchainSpec[] = [
      { id: "nexus-python", root, verifiers: { pytest: verifierPath } },
    ];

    const ok = await runToolchainVerifier({
      toolchains,
      toolchainId: "nexus-python",
      verifier: "pytest",
      args: ["--tb=short", "tests"],
      cwd: workRoot,
      timeoutMs: 5000,
    });
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.timedOut, false);
    assert.match(ok.stdout, /cwd=/);
    assert.match(ok.stdout, /args=--tb=short tests/);

    const failed = await runToolchainVerifier({
      toolchains,
      toolchainId: "nexus-python",
      verifier: "pytest",
      args: ["fail"],
      cwd: workRoot,
      timeoutMs: 5000,
    });
    assert.equal(failed.exitCode, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("runToolchainVerifier enforces a bounded timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-toolchain-test-"));
  try {
    const bin = join(root, ".venv", "bin");
    mkdirSync(bin, { recursive: true });
    const verifierPath = join(bin, "slow");
    writeFileSync(verifierPath, "#!/bin/sh\nsleep 30\nexit 0\n", { mode: 0o755 });
    chmodSync(verifierPath, 0o755);

    const toolchains: ToolchainSpec[] = [{ id: "t", root, verifiers: { slow: verifierPath } }];
    const startedAt = Date.now();
    const result = await runToolchainVerifier({
      toolchains,
      toolchainId: "t",
      verifier: "slow",
      args: [],
      cwd: root,
      timeoutMs: 200,
    });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - startedAt < 5000, "should not wait for the sleeping process");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runToolchainVerifier never runs when the verifier is not configured", async () => {
  await assert.rejects(
    runToolchainVerifier({
      toolchains: [],
      toolchainId: "nexus-python",
      verifier: "pytest",
      args: [],
      cwd: process.cwd(),
    }),
    /not configured or not resolvable/,
  );
});
