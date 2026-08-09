import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShellTool } from "./pi-tools.js";

const root = mkdtempSync(join(tmpdir(), "devspace-pi-tools-"));
try {
  const result = await runShellTool(
    {
      command:
        `node -e "console.log(process.env.DEVSPACE_WORKSPACE_ID + ',' + process.env.DEVSPACE_WORKSPACE_ROOT)"`,
      timeout: 10,
    },
    {
      cwd: root,
      root,
      env: {
        DEVSPACE_WORKSPACE_ID: "ws_shell",
        DEVSPACE_WORKSPACE_ROOT: root,
      },
    },
  );

  assert.equal(result.isError, undefined);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /ws_shell/);
  const output = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.ok(output.includes(root));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("pi-tools.test.ts: ok");
