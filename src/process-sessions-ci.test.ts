import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { ProcessSessionManager } from "./process-sessions.js";

const legacyTmpRoot = "/tmp";
const createdLegacyTmpRoot = process.platform === "win32" && !existsSync(legacyTmpRoot);

if (createdLegacyTmpRoot) {
  mkdirSync(legacyTmpRoot, { recursive: true });
}

const require = createRequire(import.meta.url);
const pathModule = require("node:path") as { join: (...paths: string[]) => string };
const originalJoin = pathModule.join;
let patchedWindowsCollisionPath = false;
let diagnosticPhase = "setup";
const diagnosticWatchdog = setTimeout(() => {
  const resources = typeof process.getActiveResourcesInfo === "function"
    ? process.getActiveResourcesInfo()
    : ["active-resource-inspection-unavailable"];
  console.error(
    `[process-sessions-ci] watchdog timeout phase=${diagnosticPhase} activeResources=${resources.join(",")}`,
  );
  throw new Error(`process-sessions-ci watchdog timeout during ${diagnosticPhase}`);
}, 120_000);
diagnosticWatchdog.unref();

if (process.platform === "win32") {
  // NTFS rejects ':' in a path component, so exercise the same delimiter
  // collision at the session-identity seam where ':' is valid. A naive
  // `${workspaceId}:${attemptKey}` key would alias these two executions.
  const collisionManager = new ProcessSessionManager();
  try {
    const node = `"${process.execPath}"`;
    const first = await collisionManager.start({
      workspaceId: "ws_collision:a",
      cwd: process.cwd(),
      command: `${node} -e "console.log('collision_win_a')"`,
      attemptKey: "b:c",
      yieldTimeMs: 2_000,
    });
    const second = await collisionManager.start({
      workspaceId: "ws_collision:a:b",
      cwd: process.cwd(),
      command: `${node} -e "console.log('collision_win_b')"`,
      attemptKey: "c",
      yieldTimeMs: 2_000,
    });
    assert.equal(first.exitCode, 0);
    assert.equal(second.exitCode, 0);
    assert.match(second.output, /collision_win_b/);
  } finally {
    collisionManager.shutdown();
  }

  // Keep the original physical-root isolation block runnable on Windows.
  // The exact root+attempt delimiter collision remains exercised unchanged on
  // POSIX, while the session-scoped check above preserves the collision guard
  // on Windows without inventing an impossible NTFS filename.
  pathModule.join = (...parts: string[]) => {
    if (parts.at(-1) === "a:b" && String(parts[0] ?? "").includes("devspace-g5-collision-")) {
      return originalJoin(...parts.slice(0, -1), "a-colon-b");
    }
    return originalJoin(...parts);
  };
  syncBuiltinESMExports();
  patchedWindowsCollisionPath = true;
}

try {
  diagnosticPhase = "process-sessions-import-start";
  console.error(`[process-sessions-ci] phase=${diagnosticPhase}`);
  await import("./process-sessions.test.js");
  diagnosticPhase = "process-sessions-import-complete";
  console.error(`[process-sessions-ci] phase=${diagnosticPhase}`);
} finally {
  diagnosticPhase = "cleanup-start";
  console.error(`[process-sessions-ci] phase=${diagnosticPhase}`);
  if (patchedWindowsCollisionPath) {
    pathModule.join = originalJoin;
    syncBuiltinESMExports();
  }
  if (createdLegacyTmpRoot) {
    rmSync(legacyTmpRoot, { recursive: true, force: true });
  }
  clearTimeout(diagnosticWatchdog);
  diagnosticPhase = "cleanup-complete";
  console.error(`[process-sessions-ci] phase=${diagnosticPhase}`);
}
