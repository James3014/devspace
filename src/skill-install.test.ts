import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installBundledAgentSkills, installBundledMcpSkill } from "./skill-install.js";

const root = mkdtempSync(join(tmpdir(), "devspace-skill-install-test-"));
const env = { DEVSPACE_CONFIG_DIR: root };

try {
  const first = installBundledAgentSkills(env);
  assert.deepEqual(first.installed, ["subagents", "dynamic-workflows"]);
  const subagentsDir = join(first.directory, "subagents");
  const subagentsFile = join(subagentsDir, "SKILL.md");
  assert.equal(existsSync(join(subagentsDir, ".devspace-managed")), true);
  assert.match(readFileSync(subagentsFile, "utf8"), /devspace agents targets --json/);

  const mcp = installBundledMcpSkill(env);
  assert.deepEqual(mcp.installed, ["mcp-workspace"]);
  assert.match(
    readFileSync(join(mcp.directory, "mcp-workspace", "SKILL.md"), "utf8"),
    /open_workspace/,
  );

  writeFileSync(subagentsFile, "stale managed copy\n");
  const updated = installBundledAgentSkills(env);
  assert.deepEqual(updated.updated, ["subagents", "dynamic-workflows"]);
  assert.match(readFileSync(subagentsFile, "utf8"), /devspace agents targets --json/);

  unlinkSync(join(subagentsDir, ".devspace-managed"));
  writeFileSync(subagentsFile, "user-owned skill\n");
  const skipped = installBundledAgentSkills(env);
  assert.deepEqual(skipped.skipped, ["subagents"]);
  assert.equal(readFileSync(subagentsFile, "utf8"), "user-owned skill\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("skill-install.test.ts: ok");
