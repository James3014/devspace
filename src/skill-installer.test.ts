import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledSkillsRoot, installManagedSkills, readManagedSkillMarker } from "./skill-installer.js";

const root = await mkdtemp(join(tmpdir(), "devspace-skill-installer-"));
try {
  const destination = join(root, "skills");
  const first = await installManagedSkills({
    destination,
    subagents: true,
    workflows: false,
    sourceRoot: bundledSkillsRoot(),
  });
  assert.deepEqual(first.map((result) => result.name), ["subagents"]);
  assert.equal(first[0]?.status, "installed");
  assert.match(await readFile(join(destination, "subagents", "SKILL.md"), "utf8"), /devspace agents run/);
  assert.ok(await readManagedSkillMarker(join(destination, "subagents")));

  const userOwned = join(destination, "dynamic-workflows");
  await mkdir(userOwned, { recursive: true });
  await writeFile(join(userOwned, "SKILL.md"), "user-owned\n");
  const second = await installManagedSkills({
    destination,
    subagents: true,
    workflows: true,
    sourceRoot: bundledSkillsRoot(),
  });
  assert.equal(second.find((result) => result.name === "subagents")?.status, "updated");
  assert.equal(second.find((result) => result.name === "dynamic-workflows")?.status, "preserved");
  assert.equal(await readFile(join(userOwned, "SKILL.md"), "utf8"), "user-owned\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("skill-installer.test.ts: ok");
