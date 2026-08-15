import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  describeToolchainExecutables,
  parseToolchains,
  resolveToolchainExecutable,
  runToolchainVerifier,
  type ToolchainSpec,
} from "./local-agent-toolchains.js";

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
