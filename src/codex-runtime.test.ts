import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  MINIMUM_CODEX_RUNTIME_VERSION,
  inspectCodexRuntime,
  resolveSelfInstalledSdkPackagePath,
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

// ─── Self-installed SDK discovery (live DevSpace package context) ───────────

interface SelfInstalledFixture {
  root: string;
  moduleUrl: string;
  clean: () => void;
}

function selfInstalledFixture(options: {
  version?: string;
  sdkName?: string;
} = {}): SelfInstalledFixture {
  const root = mkdtempSync(join(tmpdir(), "devspace-self-codex-"));
  const version = options.version ?? MINIMUM_CODEX_RUNTIME_VERSION;
  const sdkName = options.sdkName ?? "@openai/codex-sdk";
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@waishnav/devspace", private: true }));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "codex-runtime.js"), "// module context fixture\n");
  // The real SDK export map exposes neither package.json nor a CommonJS main.
  mkdirSync(join(root, "node_modules", "@openai", "codex-sdk"), { recursive: true });
  writeFileSync(
    join(root, "node_modules", "@openai", "codex-sdk", "package.json"),
    JSON.stringify({
      name: sdkName,
      version,
      type: "module",
      exports: { ".": { import: "./dist/index.js" } },
    }),
  );
  mkdirSync(join(root, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  writeFileSync(
    join(root, "node_modules", "@openai", "codex", "bin", "codex.js"),
    `#!/bin/sh\necho "codex-cli ${version}"\n`,
    { mode: 0o755 },
  );
  return {
    root,
    moduleUrl: pathToFileURL(join(root, "dist", "codex-runtime.js")).href,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("self-installed ESM-only SDK is discovered from the owning package root", () => {
  const f = selfInstalledFixture();
  try {
    const identity = inspectCodexRuntime({ moduleUrl: f.moduleUrl, env: {} });
    assert.equal(identity.ready, true, identity.reason);
    assert.equal(identity.sdkVersion, MINIMUM_CODEX_RUNTIME_VERSION);
    assert.equal(identity.binaryVersion, MINIMUM_CODEX_RUNTIME_VERSION);
    assert.equal(identity.sdkPackagePath, realpathSync(join(f.root, "node_modules", "@openai", "codex-sdk", "package.json")));
    assert.equal(resolveSelfInstalledSdkPackagePath(f.moduleUrl), identity.sdkPackagePath);
  } finally {
    f.clean();
  }
});

test("self-discovery works through a symlinked DevSpace installation", () => {
  const f = selfInstalledFixture();
  const linkParent = mkdtempSync(join(tmpdir(), "devspace-self-link-"));
  try {
    const linkPath = join(linkParent, "devspace-install");
    symlinkSync(f.root, linkPath, "dir");
    const moduleThroughLink = pathToFileURL(join(linkPath, "dist", "codex-runtime.js")).href;
    const identity = inspectCodexRuntime({ moduleUrl: moduleThroughLink, env: {} });
    assert.equal(identity.ready, true, identity.reason);
    assert.equal(identity.sdkVersion, MINIMUM_CODEX_RUNTIME_VERSION);
    assert.equal(
      identity.executable,
      realpathSync(join(f.root, "node_modules", "@openai", "codex", "bin", "codex.js")),
    );
  } finally {
    rmSync(linkParent, { recursive: true, force: true });
    f.clean();
  }
});

test("self-discovery never borrows an ancestor node_modules", () => {
  const ancestor = mkdtempSync(join(tmpdir(), "devspace-self-ancestor-"));
  try {
    mkdirSync(join(ancestor, "node_modules", "@openai", "codex-sdk"), { recursive: true });
    writeFileSync(
      join(ancestor, "node_modules", "@openai", "codex-sdk", "package.json"),
      JSON.stringify({ name: "@openai/codex-sdk", version: MINIMUM_CODEX_RUNTIME_VERSION }),
    );
    const childRoot = join(ancestor, "child-devspace");
    mkdirSync(join(childRoot, "dist"), { recursive: true });
    writeFileSync(join(childRoot, "package.json"), JSON.stringify({ name: "@waishnav/devspace" }));
    writeFileSync(join(childRoot, "dist", "codex-runtime.js"), "// module context\n");
    const moduleUrl = pathToFileURL(join(childRoot, "dist", "codex-runtime.js")).href;

    assert.equal(resolveSelfInstalledSdkPackagePath(moduleUrl), undefined);
    const identity = inspectCodexRuntime({ moduleUrl, env: {} });
    assert.equal(identity.ready, false);
    assert.match(identity.reason ?? "", /could not be resolved/);
  } finally {
    rmSync(ancestor, { recursive: true, force: true });
  }
});

test("self-discovery fails closed for a wrong package identity", () => {
  const f = selfInstalledFixture({ sdkName: "@evil/codex-sdk" });
  try {
    const identity = inspectCodexRuntime({ moduleUrl: f.moduleUrl, env: {} });
    assert.equal(identity.ready, false);
    assert.match(identity.reason ?? "", /identity is invalid/);
  } finally {
    f.clean();
  }
});

test("self-discovery fails closed for an old package-owned SDK", () => {
  const f = selfInstalledFixture({ version: "0.142.5" });
  try {
    const identity = inspectCodexRuntime({ moduleUrl: f.moduleUrl, env: {} });
    assert.equal(identity.ready, false);
    assert.equal(identity.sdkVersion, "0.142.5");
    assert.match(identity.reason ?? "", /requires @openai\/codex-sdk >= 0\.149\.0/);
  } finally {
    f.clean();
  }
});
