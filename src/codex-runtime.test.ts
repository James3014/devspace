import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  CODEX_VERSION_PROBE_TIMEOUT_MS,
  MINIMUM_CODEX_RUNTIME_VERSION,
  inspectCodexRuntime,
  resolveSelfInstalledSdkPackagePath,
} from "./codex-runtime.js";

function compileWindowsExecutable(executable: string, version: string, delayMs = 0): void {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const compiler = systemRoot
    ? join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
    : "";
  if (!compiler || !existsSync(compiler)) {
    throw new Error(`Windows PE fixture compiler is unavailable: ${compiler || "SystemRoot"}`);
  }
  const source = `${executable}.cs`;
  writeFileSync(
    source,
    `using System; using System.Threading; class Program { static void Main() { Thread.Sleep(${delayMs}); Console.WriteLine("codex-cli ${version}"); } }`,
  );
  try {
    execFileSync(compiler, ["/nologo", "/target:exe", `/out:${executable}`, source], { stdio: "ignore" });
  } finally {
    rmSync(source, { force: true });
  }
}

function windowsTargetTriple(): string {
  return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
}

function windowsPlatformPackageName(): string {
  return process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
}

function fixture(version: string, delayMs = 0): { root: string; sdkPackagePath: string; executable: string } {
  const root = mkdtempSync(join(tmpdir(), "devspace-codex-runtime-"));
  const sdkPackagePath = join(root, "codex-sdk", "package.json");
  const executable = join(root, process.platform === "win32" ? "codex.exe" : "codex.js");
  mkdirSync(join(root, "codex-sdk"), { recursive: true });
  writeFileSync(
    sdkPackagePath,
    JSON.stringify({ name: "@openai/codex-sdk", version: MINIMUM_CODEX_RUNTIME_VERSION }),
  );
  if (process.platform === "win32") compileWindowsExecutable(executable, version, delayMs);
  else writeFileSync(executable, `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 });
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

test("inspectCodexRuntime returns an executable that can be spawned directly", () => {
  const f = fixture(MINIMUM_CODEX_RUNTIME_VERSION);
  try {
    const identity = inspectCodexRuntime({
      sdkPackagePath: f.sdkPackagePath,
      executable: f.executable,
    });
    assert.equal(identity.ready, true, identity.reason);
    const output = execFileSync(identity.executable!, ["--version"], { encoding: "utf8" }).trim();
    assert.match(output, new RegExp(`codex-cli ${MINIMUM_CODEX_RUNTIME_VERSION}`));
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

test("inspectCodexRuntime gives a valid environment executable precedence", () => {
  const sdk = fixture(MINIMUM_CODEX_RUNTIME_VERSION);
  const override = fixture(MINIMUM_CODEX_RUNTIME_VERSION);
  try {
    const identity = inspectCodexRuntime({
      sdkPackagePath: sdk.sdkPackagePath,
      env: { DEVSPACE_CODEX_EXECUTABLE: override.executable },
    });
    assert.equal(identity.ready, true, identity.reason);
    assert.equal(identity.executable, realpathSync(override.executable));
  } finally {
    rmSync(sdk.root, { recursive: true, force: true });
    rmSync(override.root, { recursive: true, force: true });
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
  const executable = process.platform === "win32"
    ? join(root, "node_modules", "@openai", "codex", "vendor", windowsTargetTriple(), "bin", "codex.exe")
    : join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
  try {
    mkdirSync(join(root, "node_modules", "@openai", "codex-sdk"), { recursive: true });
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(
      sdkPackagePath,
      JSON.stringify({
        name: "@openai/codex-sdk",
        version: MINIMUM_CODEX_RUNTIME_VERSION,
        exports: { ".": { import: "./dist/index.js" } },
      }),
    );
    if (process.platform === "win32") compileWindowsExecutable(executable, MINIMUM_CODEX_RUNTIME_VERSION);
    else writeFileSync(executable, `#!/bin/sh\necho "codex-cli ${MINIMUM_CODEX_RUNTIME_VERSION}"\n`, { mode: 0o755 });
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
  nativeLayout?: "platform" | "vendor";
  brokenPlatformPackage?: boolean;
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
  if (process.platform === "win32") {
    const architecture = { packageName: windowsPlatformPackageName(), target: windowsTargetTriple() };
    if (options.nativeLayout === "vendor") {
      const executable = join(root, "node_modules", "@openai", "codex", "vendor", architecture.target, "bin", "codex.exe");
      mkdirSync(join(root, "node_modules", "@openai", "codex", "vendor", architecture.target, "bin"), { recursive: true });
      compileWindowsExecutable(executable, version);
    } else {
      const packageRoot = join(root, "node_modules", "@openai", architecture.packageName);
      mkdirSync(packageRoot, { recursive: true });
      if (!options.brokenPlatformPackage) {
        const executable = join(packageRoot, "vendor", architecture.target, "bin", "codex.exe");
        mkdirSync(dirname(executable), { recursive: true });
        compileWindowsExecutable(executable, version);
      }
    }
  } else {
    mkdirSync(join(root, "node_modules", "@openai", "codex", "bin"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "@openai", "codex", "bin", "codex.js"),
      `#!/bin/sh\necho "codex-cli ${version}"\n`,
      { mode: 0o755 },
    );
  }
  return {
    root,
    moduleUrl: pathToFileURL(join(root, "dist", "codex-runtime.js")).href,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

function expectedSelfExecutable(root: string, layout: "platform" | "vendor" = "platform"): string {
  if (process.platform !== "win32") return join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
  const target = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  return layout === "vendor"
    ? join(root, "node_modules", "@openai", "codex", "vendor", target, "bin", "codex.exe")
    : join(root, "node_modules", "@openai", windowsPlatformPackageName(), "vendor", target, "bin", "codex.exe");
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
    if (process.platform === "win32") {
      const output = execFileSync(identity.executable!, ["--version"], { encoding: "utf8" }).trim();
      assert.match(output, new RegExp(`codex-cli ${MINIMUM_CODEX_RUNTIME_VERSION}`));
    }
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
      realpathSync(expectedSelfExecutable(f.root)),
    );
  } finally {
    rmSync(linkParent, { recursive: true, force: true });
    f.clean();
  }
});

test("Windows self-discovery resolves the native vendor executable", () => {
  if (process.platform !== "win32") return;
  const f = selfInstalledFixture({ nativeLayout: "vendor" });
  try {
    const identity = inspectCodexRuntime({ moduleUrl: f.moduleUrl, env: {} });
    assert.equal(identity.ready, true, identity.reason);
    assert.equal(identity.executable, realpathSync(expectedSelfExecutable(f.root, "vendor")));
    const output = execFileSync(identity.executable!, ["--version"], { encoding: "utf8" }).trim();
    assert.match(output, new RegExp(`codex-cli ${MINIMUM_CODEX_RUNTIME_VERSION}`));
  } finally {
    f.clean();
  }
});

test("Windows explicit SDK discovery does not borrow an ancestor native package", () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "devspace-explicit-codex-"));
  const sdkPackagePath = join(root, "owned", "node_modules", "@openai", "codex-sdk", "package.json");
  const ancestorExecutable = join(root, "node_modules", "@openai", "codex", "vendor", windowsTargetTriple(), "bin", "codex.exe");
  try {
    mkdirSync(dirname(sdkPackagePath), { recursive: true });
    writeFileSync(sdkPackagePath, JSON.stringify({ name: "@openai/codex-sdk", version: MINIMUM_CODEX_RUNTIME_VERSION }));
    mkdirSync(dirname(ancestorExecutable), { recursive: true });
    compileWindowsExecutable(ancestorExecutable, MINIMUM_CODEX_RUNTIME_VERSION);
    const identity = inspectCodexRuntime({ sdkPackagePath });
    assert.equal(identity.ready, false);
    assert.match(identity.reason ?? "", /could not be resolved|does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows discovery fails closed for a broken platform package", () => {
  if (process.platform !== "win32") return;
  const f = selfInstalledFixture({ brokenPlatformPackage: true });
  try {
    const legacyExecutable = join(f.root, "node_modules", "@openai", "codex", "vendor", windowsTargetTriple(), "bin", "codex.exe");
    mkdirSync(dirname(legacyExecutable), { recursive: true });
    compileWindowsExecutable(legacyExecutable, MINIMUM_CODEX_RUNTIME_VERSION);
    const identity = inspectCodexRuntime({ moduleUrl: f.moduleUrl, env: {} });
    assert.equal(identity.ready, false);
    assert.match(identity.reason ?? "", /does not exist/);
  } finally {
    f.clean();
  }
});

test("Windows discovery ignores a native package for the wrong architecture", () => {
  if (process.platform !== "win32") return;
  const f = selfInstalledFixture();
  try {
    const wrongPackage = process.arch === "arm64" ? "codex-win32-x64" : "codex-win32-arm64";
    rmSync(join(f.root, "node_modules", "@openai", windowsPlatformPackageName()), { recursive: true, force: true });
    const wrongTarget = process.arch === "arm64" ? "x86_64-pc-windows-msvc" : "aarch64-pc-windows-msvc";
    const wrongExecutable = join(f.root, "node_modules", "@openai", wrongPackage, "vendor", wrongTarget, "bin", "codex.exe");
    mkdirSync(dirname(wrongExecutable), { recursive: true });
    compileWindowsExecutable(wrongExecutable, MINIMUM_CODEX_RUNTIME_VERSION);
    const identity = inspectCodexRuntime({ moduleUrl: f.moduleUrl, env: {} });
    assert.equal(identity.ready, false);
    assert.match(identity.reason ?? "", /could not be resolved|does not exist/);
  } finally {
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

// ─── Bounded version-probe deadline ─────────────────────────────────────────

test("production version-probe default is the explicit 30s cold-start bound", () => {
  assert.equal(CODEX_VERSION_PROBE_TIMEOUT_MS, 30_000);
});

test("an over-deadline probe fails closed while a sufficient deadline succeeds", () => {
  const f = fixture(MINIMUM_CODEX_RUNTIME_VERSION, 500);
  try {
    if (process.platform !== "win32") {
      // Executable sleeps 500ms before answering: legitimate cold-start proxy.
      writeFileSync(f.executable, "#!/bin/sh\nsleep 0.5\necho \"codex-cli 0.149.0\"\n", { mode: 0o755 });
    }

    const tooTight = inspectCodexRuntime({
      sdkPackagePath: f.sdkPackagePath,
      executable: f.executable,
      versionProbeTimeoutMs: 50,
    });
    assert.equal(tooTight.ready, false);
    assert.match(tooTight.reason ?? "", /version probe failed/);
    assert.ok(/ETIMEDOUT|timed out/i.test(tooTight.reason ?? ""));

    const sufficient = inspectCodexRuntime({
      sdkPackagePath: f.sdkPackagePath,
      executable: f.executable,
      versionProbeTimeoutMs: 10_000,
    });
    assert.equal(sufficient.ready, true, sufficient.reason);
    assert.equal(sufficient.binaryVersion, "0.149.0");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
