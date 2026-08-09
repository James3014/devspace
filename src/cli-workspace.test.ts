import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertCliWorkspaceAllowed,
  assertRecordInCliWorkspace,
  resolveCliWorkspaceContext,
} from "./cli-workspace.js";

const root = mkdtempSync(join(tmpdir(), "devspace-cli-workspace-"));
try {
  const repository = join(root, "repository");
  const nested = join(repository, "packages", "app");
  mkdirSync(nested, { recursive: true });
  execFileSync("git", ["init", "--quiet", repository]);
  const gitRoot = execFileSync(
    "git",
    ["-C", nested, "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  ).trim();

  assert.deepEqual(resolveCliWorkspaceContext({}, nested), {
    workspaceId: undefined,
    workspaceRoot: resolve(gitRoot),
  });

  mkdirSync(join(repository, "packages", ".devspace"));
  assert.equal(
    resolveCliWorkspaceContext({}, nested).workspaceRoot,
    resolve(repository, "packages"),
  );

  assert.deepEqual(
    resolveCliWorkspaceContext({
      DEVSPACE_WORKSPACE_ID: "ws_injected",
      DEVSPACE_WORKSPACE_ROOT: nested,
    }, root),
    {
      workspaceId: "ws_injected",
      workspaceRoot: resolve(nested),
    },
  );

  assert.doesNotThrow(() => assertRecordInCliWorkspace(
    { workspaceId: "ws_injected", workspaceRoot: root },
    { workspaceId: "ws_injected", workspaceRoot: nested },
    "Subagent",
  ));
  assert.doesNotThrow(() => assertRecordInCliWorkspace(
    { workspaceRoot: nested },
    { workspaceId: "ws_injected", workspaceRoot: nested },
    "Legacy subagent",
  ));
  assert.throws(
    () => assertRecordInCliWorkspace(
      { workspaceId: "ws_other", workspaceRoot: nested },
      { workspaceId: "ws_injected", workspaceRoot: nested },
      "Subagent",
    ),
    /does not belong to the current project/,
  );
  assert.doesNotThrow(() => assertCliWorkspaceAllowed(
    { workspaceRoot: nested },
    [root],
  ));
  assert.throws(
    () => assertCliWorkspaceAllowed({ workspaceRoot: "/outside" }, [root]),
    /outside DevSpace allowed roots/,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("cli-workspace.test.ts: ok");
