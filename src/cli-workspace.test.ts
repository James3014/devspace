import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCliWorkspaceRoot, resolveCliWorkspaceScope } from "./cli-workspace.js";

const root = mkdtempSync(join(tmpdir(), "devspace-cli-workspace-"));
const project = join(root, "project");
const nested = join(project, "packages", "app");
const outside = join(root, "outside");

try {
  mkdirSync(nested, { recursive: true });
  mkdirSync(outside, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: project });

  assert.equal(
    resolveCliWorkspaceRoot([root], {}, nested),
    project,
  );
  assert.deepEqual(
    resolveCliWorkspaceScope([root], {
      DEVSPACE_WORKSPACE_ID: "ws_mcp",
      DEVSPACE_WORKSPACE_ROOT: project,
    }, nested),
    { workspaceRoot: project, workspaceId: "ws_mcp" },
  );
  assert.throws(
    () => resolveCliWorkspaceRoot([project], {}, outside),
    /outside DEVSPACE_ALLOWED_ROOTS/,
  );
  assert.throws(
    () => resolveCliWorkspaceRoot([project], { DEVSPACE_WORKSPACE_ROOT: outside }, project),
    /outside DEVSPACE_ALLOWED_ROOTS/,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("cli-workspace.test.ts: ok");
