import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MINIMUM_CODEX_RUNTIME_VERSION,
  inspectCodexRuntime,
} from "./codex-runtime.js";

function fixture(version: string): { root: string; sdkPackagePath: string; executable: string } {
  const root = mkdtempSync(join(tmpdir(), "devspace-codex-runtime-"));
  const sdkPackagePath = join(root, "codex-sdk", "package.json");
  const executable = join(root, "codex.js");
  mkdirSync(join(root, "codex-sdk"), { recursive: true });
  writeFileSync(
    sdkPackagePath,
    JSON.stringify({ name: "@openai/codex-sdk", version: MINIMUM_CODEX_RUNTIME_VERSION }),
  );
  writeFileSync(
    executable,
    `#!/bin/sh\necho "codex-cli ${version}"\n`,
    { mode: 0o755 },
  );
  return { root, sdkPackagePath, executable };
}

test("inspectCodexRuntime reports the actual SDK and executable identity", () => {
  const f = fixture(MINIMUM_CODEX_RUNTIME_VERSION);
  try {
    const identity = inspectCodexRuntime({
      sdkPackagePath: f.sdkPackagePath,
      executable: f.executable,
    });
    assert.equal(identity.ready, true);
    assert.equal(identity.sdkVersion, MINIMUM_CODEX_RUNTIME_VERSION);
    assert.equal(identity.binaryVersion, MINIMUM_CODEX_RUNTIME_VERSION);
    assert.equal(identity.executable, realpathSync(f.executable));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("inspectCodexRuntime fails closed for an incompatible executable", () => {
  const f = fixture("0.142.5");
  try {
    const identity = inspectCodexRuntime({
      sdkPackagePath: f.sdkPackagePath,
      executable: f.executable,
    });
    assert.equal(identity.ready, false);
    assert.equal(identity.binaryVersion, "0.142.5");
    assert.match(identity.reason ?? "", /requires Codex CLI >= 0\.149\.0/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("inspectCodexRuntime validates rather than trusts an override path", () => {
  const f = fixture(MINIMUM_CODEX_RUNTIME_VERSION);
  try {
    const identity = inspectCodexRuntime({
      sdkPackagePath: f.sdkPackagePath,
      executable: join(f.root, "missing-codex"),
    });
    assert.equal(identity.ready, false);
    assert.match(identity.reason ?? "", /does not exist|could not be resolved/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("inspectCodexRuntime validates the environment executable override", () => {
  const f = fixture(MINIMUM_CODEX_RUNTIME_VERSION);
  try {
    const identity = inspectCodexRuntime({
      sdkPackagePath: f.sdkPackagePath,
      env: { DEVSPACE_CODEX_EXECUTABLE: join(f.root, "missing-codex") },
    });
    assert.equal(identity.ready, false);
    assert.match(identity.reason ?? "", /does not exist/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("inspectCodexRuntime fails closed for an incompatible SDK", () => {
  const f = fixture(MINIMUM_CODEX_RUNTIME_VERSION);
  try {
    writeFileSync(
      f.sdkPackagePath,
      JSON.stringify({ name: "@openai/codex-sdk", version: "0.142.5" }),
    );
    const identity = inspectCodexRuntime({
      sdkPackagePath: f.sdkPackagePath,
      executable: f.executable,
    });
    assert.equal(identity.ready, false);
    assert.equal(identity.sdkVersion, "0.142.5");
    assert.match(identity.reason ?? "", /requires @openai\/codex-sdk >= 0\.149\.0/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("inspectCodexRuntime resolves an ESM-only SDK from the verified dependency root", () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-codex-bridge-runtime-"));
  const sdkPackagePath = join(root, "node_modules", "@openai", "codex-sdk", "package.json");
  const executable = join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
  try {
    mkdirSync(join(root, "node_modules", "@openai", "codex-sdk"), { recursive: true });
    mkdirSync(join(root, "node_modules", "@openai", "codex", "bin"), { recursive: true });
    writeFileSync(
      sdkPackagePath,
      JSON.stringify({
        name: "@openai/codex-sdk",
        version: MINIMUM_CODEX_RUNTIME_VERSION,
        exports: { ".": { import: "./dist/index.js" } },
      }),
    );
    writeFileSync(executable, `#!/bin/sh\necho "codex-cli ${MINIMUM_CODEX_RUNTIME_VERSION}"\n`, {
      mode: 0o755,
    });
    const identity = inspectCodexRuntime({
      env: { DEVSPACE_DEPENDENCY_ROOT: root },
    });
    assert.equal(identity.ready, true, identity.reason);
    assert.equal(identity.sdkPackagePath, realpathSync(sdkPackagePath));
    assert.equal(identity.executable, realpathSync(executable));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
