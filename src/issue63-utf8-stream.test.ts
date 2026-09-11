import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalAgentAdapter } from "./local-agent-adapters.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { cleanupProviderScratch, createProviderScratch } from "./provider-scratch.js";

// Issue #63 Finding 1: exercise the real Agy adapter with an executable whose
// JSON stdout is split inside a multi-byte UTF-8 code point. A second run does
// the same for stderr so stdout/stderr decoder state cannot be shared.
{
  const root = mkdtempSync(join(tmpdir(), "devspace-issue63-agy-utf8-"));
  const mockPath = join(root, "mock-agy-utf8.js");
  const ambientHome = join(root, "ambient-home");
  const appData = join(ambientHome, ".gemini", "antigravity-cli");
  mkdirSync(join(appData, "conversations"), { recursive: true });
  writeFileSync(join(appData, "antigravity-oauth-token"), "TEST_AUTH_TOKEN\n", { mode: 0o600 });
  const scratch = createProviderScratch(`issue63_agy_utf8_${process.pid}_${Date.now()}`);

  const mockSource = `#!/usr/bin/env node
const mode = process.env.DEVSPACE_ISSUE63_UTF8_MODE || "stdout";
function writeSplit(stream, text, marker) {
  const bytes = Buffer.from(text, "utf8");
  const markerBytes = Buffer.from(marker, "utf8");
  const start = bytes.indexOf(markerBytes);
  if (start < 0) process.exit(94);
  const split = start + 1;
  stream.write(bytes.subarray(0, split));
  setTimeout(() => stream.write(bytes.subarray(split)), 15);
}
if (mode === "stderr") {
  writeSplit(process.stderr, "錯誤🎯", "錯");
  setTimeout(() => process.exit(7), 40);
} else {
  const payload = JSON.stringify({
    status: "SUCCESS",
    conversation_id: "issue63-utf8",
    response: "繁體中文🎯",
  });
  writeSplit(process.stdout, payload, "繁");
}
`;
  writeFileSync(mockPath, mockSource, { mode: 0o755 });
  chmodSync(mockPath, 0o755);

  const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
  const originalSpawn = childProcess.spawn;
  let patchedWindowsSpawn = false;
  if (process.platform === "win32") {
    childProcess.spawn = function patchedSpawn(this: typeof childProcess, command: any, args?: any, options?: any): any {
      if (command === mockPath) {
        const forwardedArgs = Array.isArray(args) ? args : [];
        const forwardedOptions = Array.isArray(args) ? options : args;
        return originalSpawn.call(this, process.execPath, [mockPath, ...forwardedArgs], forwardedOptions);
      }
      return originalSpawn.call(this, command, args, options);
    } as typeof childProcess.spawn;
    syncBuiltinESMExports();
    patchedWindowsSpawn = true;
  }

  try {
    const baseEnv = {
      ...process.env,
      AGY_COMMAND: mockPath,
      HOME: ambientHome,
      USERPROFILE: ambientHome,
      DEVSPACE_PROVIDER_SCRATCH: scratch.root,
    };
    const adapter = createLocalAgentAdapter("agy");

    const result = await adapter.run({
      prompt: "issue63 utf8 stdout",
      workspaceRoot: root,
      environment: baseEnv,
    });
    assert.equal(result.providerSessionId, "issue63-utf8");
    assert.equal(result.finalResponse, "繁體中文🎯");
    assert.equal(result.finalResponse.includes("\uFFFD"), false);

    await assert.rejects(
      adapter.run({
        prompt: "issue63 utf8 stderr",
        workspaceRoot: root,
        environment: { ...baseEnv, DEVSPACE_ISSUE63_UTF8_MODE: "stderr" },
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /錯誤🎯/);
        assert.equal(message.includes("\uFFFD"), false);
        return true;
      },
    );
  } finally {
    if (patchedWindowsSpawn) {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
    cleanupProviderScratch(scratch.root);
    rmSync(root, { recursive: true, force: true });
  }
}

// Exercise ProcessSessionManager's real pipe transport with stdout and stderr
// split independently inside multi-byte UTF-8 code points.
{
  const manager = new ProcessSessionManager();
  try {
    const script = `
const stdout = Buffer.from("繁體中文🎯", "utf8");
const stderr = Buffer.from("錯誤🧪", "utf8");
process.stdout.write(stdout.subarray(0, 1));
process.stderr.write(stderr.subarray(0, 2));
setTimeout(() => {
  process.stdout.write(stdout.subarray(1));
  process.stderr.write(stderr.subarray(2));
}, 20);
`;
    const snapshot = await manager.start({
      workspaceId: "issue63-utf8-pipe",
      cwd: process.cwd(),
      command: "issue63-utf8-pipe",
      executable: process.execPath,
      args: ["-e", script],
      yieldTimeMs: 2_000,
      maxOutputTokens: 10_000,
    });
    assert.equal(snapshot.exitCode, 0);
    assert.match(snapshot.output, /繁體中文🎯/);
    assert.match(snapshot.output, /錯誤🧪/);
    assert.equal(snapshot.output.includes("\uFFFD"), false);
  } finally {
    manager.shutdown();
  }
}
