import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error(`${command} ${args.join(" ")} failed with exit ${String(result.status)}`);
  }
}

const subjectRoot = git(["rev-parse", "--show-toplevel"], process.cwd());
const sourceHead = git(["rev-parse", "HEAD^{commit}"], subjectRoot);
const targetTree = git(["write-tree"], subjectRoot);
const tempRoot = mkdtempSync(join(tmpdir(), "devspace-nexus-core-verify-"));
const verifyRoot = join(tempRoot, "repo");

try {
  execFileSync("git", ["clone", "--no-checkout", "--shared", "--quiet", subjectRoot, verifyRoot], {
    stdio: "inherit",
  });
  execFileSync("git", ["-C", verifyRoot, "checkout", "--detach", "--quiet", sourceHead], {
    stdio: "inherit",
  });
  execFileSync("git", ["-C", verifyRoot, "read-tree", "--reset", "-u", targetTree], {
    stdio: "inherit",
  });

  try {
    const origin = git(["remote", "get-url", "origin"], subjectRoot);
    if (origin) execFileSync("git", ["-C", verifyRoot, "remote", "set-url", "origin", origin]);
  } catch {
    // A local-only Core subject may not have origin; verification does not require one.
  }

  if (git(["write-tree"], verifyRoot) !== targetTree) {
    throw new Error("temporary verifier tree does not match Core target tree");
  }

  const env = {
    ...process.env,
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  run("npm", ["ci"], verifyRoot, env);
  run("npm", ["test"], verifyRoot, env);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
