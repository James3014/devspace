import assert from "node:assert/strict";
import { runShellTool } from "./pi-tools.js";

const response = await runShellTool(
  {
    command: "printf '%s\\n%s' \"$DEVSPACE_WORKSPACE_ID\" \"$DEVSPACE_WORKSPACE_ROOT\"",
    timeout: 5,
  },
  {
    cwd: process.cwd(),
    root: process.cwd(),
    workspaceId: "ws_shell_scope",
  },
);

assert.equal(response.isError, undefined);
assert.equal(response.content[0]?.type, "text");
if (response.content[0]?.type === "text") {
  assert.equal(response.content[0].text, "ws_shell_scope\n" + process.cwd());
}

console.log("pi-tools.test.ts: ok");
