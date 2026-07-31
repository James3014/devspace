import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  searchTextTool,
  gitWorktreesTool,
  workspaceSnapshotTool,
  validateSearchPath,
  isPathInsideDir,
} from "./nexus-git-tools.js";

// Create a test workspace with git init
const testDir = mkdtempSync(join(tmpdir(), "nexus-git-tools-test-"));
writeFileSync(join(testDir, "AGENTS.md"), "# Root agents\nartifact_authority: test\n");
writeFileSync(join(testDir, "tasks.md"), "# Tasks root\n");
mkdirSync(join(testDir, "tasks"), { recursive: true });
writeFileSync(join(testDir, "tasks", "card.md"), "# Task Card\nartifact_authority: defined\n");
mkdirSync(join(testDir, "tasks", "campaign"), { recursive: true });
writeFileSync(join(testDir, "tasks", "campaign", "01-card.md"), "# Campaign Card\n");
mkdirSync(join(testDir, "tasks2"), { recursive: true });
writeFileSync(join(testDir, "tasks2", "example.md"), "# Tasks2 file\nartifact_authority: wrong\n");
mkdirSync(join(testDir, "nexus", "services"), { recursive: true });
writeFileSync(join(testDir, "nexus", "services", "gateway.py"), "class Gateway:\n    pass\n");
writeFileSync(join(testDir, "nexus", "services", "utils.json"), '{"key": "value"}\n');
mkdirSync(join(testDir, "tests"), { recursive: true });
writeFileSync(join(testDir, "tests", "test_main.py"), "def test_main():\n    pass\n");

// Init git repo (idempotent)
import { execSync } from "node:child_process";
try {
  execSync("git init", { cwd: testDir, stdio: "pipe" });
} catch {}
execSync("git add -A && (git commit -m 'test fixtures' || true)", {
  cwd: testDir,
  stdio: "pipe",
});

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${(e as Error).message}`);
  }
}

async function asyncTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${(e as Error).message}`);
  }
}

// ============================================================
console.log("\n=== validateSearchPath unit tests ===");

test("rejects path with '..'", () => {
  const err = validateSearchPath("../etc", testDir);
  assert.ok(err, "Expected error");
  assert.ok(err.includes(".."));
});

test("rejects absolute path outside workspace", () => {
  const err = validateSearchPath("/tmp", testDir);
  assert.ok(err, "Expected error for absolute path outside workspace");
});

test("accepts valid relative path", () => {
  assert.equal(validateSearchPath("tasks", testDir), null);
});

test("accepts undefined path", () => {
  assert.equal(validateSearchPath(undefined, testDir), null);
});

// ============================================================
console.log("\n=== isPathInsideDir unit tests ===");

test("exact match", () => {
  assert.ok(isPathInsideDir("tasks", "tasks"));
});

test("nested path", () => {
  assert.ok(isPathInsideDir("tasks/card.md", "tasks"));
});

test("deeply nested", () => {
  assert.ok(isPathInsideDir("tasks/campaign/01-card.md", "tasks"));
});

test("prefix collision: tasks2 NOT inside tasks", () => {
  assert.ok(!isPathInsideDir("tasks2/example.md", "tasks"));
});

test("different root", () => {
  assert.ok(!isPathInsideDir("nexus/services/gateway.py", "tasks"));
});

// ============================================================
console.log("\n=== searchTextTool tests ===");

await asyncTest("path=tasks returns only files under tasks/", async () => {
  const result = await searchTextTool(
    { pattern: "artifact_authority", path: "tasks" },
    { cwd: testDir },
  );
  const data = JSON.parse(result.content[0].text);
  for (const m of data.matches) {
    assert.ok(
      m.file.startsWith("tasks/"),
      `Expected file "${m.file}" to start with "tasks/"`,
    );
  }
  // AGENTS.md must NOT appear
  const agentsMd = data.matches.filter(
    (m: { file: string }) => m.file === "AGENTS.md",
  );
  assert.equal(agentsMd.length, 0, "AGENTS.md must not appear");
});

await asyncTest("path=tasks + include=*.md returns only .md under tasks/", async () => {
  const result = await searchTextTool(
    { pattern: "artifact_authority", path: "tasks", include: "*.md" },
    { cwd: testDir },
  );
  const data = JSON.parse(result.content[0].text);
  for (const m of data.matches) {
    assert.ok(
      m.file.startsWith("tasks/"),
      `Expected file "${m.file}" to start with "tasks/"`,
    );
    assert.ok(
      m.file.endsWith(".md"),
      `Expected file "${m.file}" to end with ".md"`,
    );
  }
});

await asyncTest("path=tasks excludes tasks2/", async () => {
  const result = await searchTextTool(
    { pattern: "artifact_authority", path: "tasks" },
    { cwd: testDir },
  );
  const data = JSON.parse(result.content[0].text);
  const tasks2 = data.matches.filter(
    (m: { file: string }) => m.file.startsWith("tasks2/"),
  );
  assert.equal(tasks2.length, 0, "tasks2/ must not appear in results");
});

await asyncTest("path=nexus/services restricts to that directory", async () => {
  const result = await searchTextTool(
    { pattern: "class", path: "nexus/services" },
    { cwd: testDir },
  );
  const data = JSON.parse(result.content[0].text);
  for (const m of data.matches) {
    assert.ok(
      m.file.startsWith("nexus/services/"),
      `Expected file "${m.file}" to start with "nexus/services/"`,
    );
  }
});

await asyncTest("path=nonexistent returns empty results (not full workspace)", async () => {
  const result = await searchTextTool(
    { pattern: "test", path: "nonexistent_dir_xyz" },
    { cwd: testDir },
  );
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.match_count, 0, "Expected 0 matches for non-existent path");
});

await asyncTest("path=.. is rejected", async () => {
  const result = await searchTextTool(
    { pattern: "test", path: "../" },
    { cwd: testDir },
  );
  assert.ok(result.isError, "Expected error for path with '..'");
});

await asyncTest("absolute path outside workspace is rejected", async () => {
  const result = await searchTextTool(
    { pattern: "test", path: "/tmp" },
    { cwd: testDir },
  );
  assert.ok(result.isError, "Expected error for absolute path outside workspace");
});

await asyncTest("no path searches full workspace", async () => {
  const result = await searchTextTool(
    { pattern: "artifact_authority" },
    { cwd: testDir },
  );
  const data = JSON.parse(result.content[0].text);
  assert.ok(
    data.match_count >= 2,
    "Expected at least 2 matches without path restriction",
  );
});

await asyncTest("no-match returns success with empty results", async () => {
  const result = await searchTextTool(
    { pattern: "nonexistent_pattern_xyz_12345" },
    { cwd: testDir },
  );
  assert.ok(!result.isError, "No-match should not be an error");
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.match_count, 0);
});

await asyncTest("nested file found with path=tasks, include=*.md", async () => {
  const result = await searchTextTool(
    { pattern: "Campaign Card", path: "tasks", include: "*.md" },
    { cwd: testDir },
  );
  const data = JSON.parse(result.content[0].text);
  assert.ok(data.match_count >= 1, "Expected at least 1 match for nested file");
  assert.ok(
    data.matches.some(
      (m: { file: string }) => m.file === "tasks/campaign/01-card.md",
    ),
    "Expected tasks/campaign/01-card.md in results",
  );
});

// ============================================================
console.log("\n=== gitWorktreesTool tests ===");

await asyncTest("all worktree paths are absolute (start with /)", async () => {
  const result = await gitWorktreesTool({}, { cwd: testDir });
  const data = JSON.parse(result.content[0].text);
  for (const wt of data.worktrees) {
    assert.ok(
      wt.path.startsWith("/"),
      `Expected worktree path "${wt.path}" to start with "/"`,
    );
  }
});

await asyncTest("main worktree path matches testDir", async () => {
  const result = await gitWorktreesTool({}, { cwd: testDir });
  const data = JSON.parse(result.content[0].text);
  assert.ok(data.count >= 1, "Expected at least 1 worktree");
  const resolved = await import("node:fs/promises").then((fs) =>
    fs.realpath(testDir),
  );
  assert.equal(data.worktrees[0].path, resolved);
});

await asyncTest("worktree count matches array length", async () => {
  const result = await gitWorktreesTool({}, { cwd: testDir });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.count, data.worktrees.length);
});

// ============================================================
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
