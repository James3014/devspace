// Guard: every src/**/*.test.ts must run from `npm test`, or be listed below
// with a reason and a tracking ID. Without this, new test files silently fall
// out of CI (see DS-1 in /home/claude/issues/PRIORITIES.md).
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

// Files deliberately excluded from `npm test`. Each needs a TODO with a tracking ID.
// Details: /home/claude/issues/devspace/DS-1-failures.md
const EXCLUDED = new Map([
  ["src/cli.test.ts", "TODO(DS-1-F1): fails in npm test; see DS-1-failures.md"],
  ["src/cutover-progression.test.ts", "TODO(DS-1-F2): fails in npm test; see DS-1-failures.md"],
  ["src/issue344-minimal-direct-coding.test.ts", "TODO(DS-1-F3): needs DEVSPACE_OAUTH_OWNER_TOKEN; see DS-1-failures.md"],
  ["src/local-agent-herdr.test.ts", "TODO(DS-1-F4): live canary with hard-coded /Users/james paths; see DS-1-failures.md"],
  ["src/local-agent-p2-telemetry.test.ts", "TODO(DS-1-F5): requires agy CLI; see DS-1-failures.md"],
  ["src/server.test.ts", "TODO(DS-1-F6): requires codex CLI and has preflight failures; see DS-1-failures.md"],
  ["src/local-agent-sessions.test.ts", "run by CI job 'Local agent sessions (macOS)' via npm run test:local-agent-sessions"],
]);

function listTestFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTestFiles(full));
    else if (name.endsWith(".test.ts")) out.push(relative(repoRoot, full));
  }
  return out.sort();
}

// Collect every test file reachable from the `test` script, following `npm run <name>`
// references and `./<name>.test.js` imports made by files already reached.
const covered = new Set();
const seenScripts = new Set();
const pending = [pkg.scripts.test];
while (pending.length > 0) {
  const text = pending.pop();
  for (const match of text.matchAll(/(src\/[^\s"'&]+\.test\.ts)/g)) {
    covered.add(match[1]);
  }
  for (const match of text.matchAll(/npm run ([^\s&]+)/g)) {
    const name = match[1];
    if (seenScripts.has(name) || !pkg.scripts[name]) continue;
    seenScripts.add(name);
    pending.push(pkg.scripts[name]);
  }
}
for (const file of [...covered]) {
  const body = readFileSync(join(repoRoot, file), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  for (const match of body.matchAll(/["'](\.\/[^"']+)\.test\.js["']/g)) {
    covered.add(relative(repoRoot, join(dirname(join(repoRoot, file)), `${match[1].slice(2)}.test.ts`)));
  }
}

const all = listTestFiles(join(repoRoot, "src"));
const problems = [];
for (const file of all) {
  if (covered.has(file) && EXCLUDED.has(file)) {
    problems.push(`${file}: listed as excluded but is run by npm test; remove it from EXCLUDED`);
  } else if (!covered.has(file) && !EXCLUDED.has(file)) {
    problems.push(`${file}: not run by npm test and not excluded; add it to the test script`);
  }
}
for (const file of EXCLUDED.keys()) {
  if (!existsSync(join(repoRoot, file))) problems.push(`${file}: excluded but file does not exist`);
}

if (problems.length > 0) {
  console.error(`check-test-chain: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-test-chain: ${covered.size} files chained, ${EXCLUDED.size} excluded with TODO, ${all.length} total`);
