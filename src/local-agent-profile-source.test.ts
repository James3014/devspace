import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { loadProfileCatalog } from "./local-agent-profile-source.js";

const root = await mkdtemp(join(tmpdir(), "devspace-profile-source-test-"));

try {
  const configDir = join(root, ".devspace-home");
  const workspaceRoot = join(root, "repo");
  await mkdir(join(configDir, "agents"), { recursive: true });
  await mkdir(join(workspaceRoot, ".devspace", "agents"), { recursive: true });

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", workspaceRoot, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");

  const writeProfile = async (
    directory: string,
    name: string,
    lines: string[],
  ) => {
    await writeFile(join(directory, `${name}.md`), [
      "---",
      ...lines,
      "---",
      "",
      "Body.",
      "",
    ].join("\n"));
  };

  await writeProfile(join(configDir, "agents"), "agy-gemini-review", [
    "name: agy-gemini-review",
    "description: Global gemini review capability.",
    "provider: agy",
    "model: gemini-3.7-flash-medium",
    "write_mode: read_only",
  ]);
  await writeProfile(join(workspaceRoot, ".devspace", "agents"), "project-policy", [
    "name: project-policy",
    "description: Project execution policy.",
    "provider: agy",
    "write_mode: read_only",
  ]);

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });

  const checkout = await loadProfileCatalog(config, workspaceRoot);

  // Untracked repository profile: visible with explicit state, not advertised.
  assert.equal(
    checkout.entries.find((entry) => entry.name === "project-policy")?.state,
    "untracked_repository_profile",
  );
  assert.equal(checkout.advertised("project-policy"), undefined);
  assert.equal(checkout.blockerFor("project-policy")?.code, "UNTRACKED_REPOSITORY_PROFILE");

  // Advertised set matches the entry state surface.
  const advertisedNames = checkout.profiles.map((profile) => profile.name).sort();
  assert.deepEqual(advertisedNames, ["agy-gemini-review"]);

  // Same committed revision: worktree sees the identical authoritative set.
  git("add", ".devspace/agents/project-policy.md");
  git("commit", "-q", "-m", "track project policy");
  const worktreePath = join(root, "wt");
  git("worktree", "add", "-q", worktreePath, "HEAD");
  const worktree = await loadProfileCatalog(config, worktreePath);
  const committedCheckout = await loadProfileCatalog(config, workspaceRoot);
  assert.deepEqual(
    worktree.profiles.map((profile) => profile.name).sort(),
    [...advertisedNames, "project-policy"],
  );
  assert.deepEqual(
    worktree.entries.map((entry) => [entry.name, entry.state]).sort(),
    committedCheckout.entries.map((entry) => [entry.name, entry.state]).sort(),
  );
  assert.equal(worktree.generation, committedCheckout.generation);

  // Provider unavailability keeps the profile visible with a typed blocker,
  // never silently disappearing it.
  const unavailableConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  const withProviderDown = await loadProfileCatalog(unavailableConfig, workspaceRoot, {
    availability: [{ name: "agy", available: false, reason: "agy executable not found" }],
  });
  assert.equal(
    withProviderDown.entries.find((entry) => entry.name === "agy-gemini-review")?.state,
    "provider_unavailable",
  );
  assert.deepEqual(withProviderDown.profiles, []);
  assert.equal(withProviderDown.blockerFor("agy-gemini-review")?.code, "PROVIDER_UNAVAILABLE");

  // Unknown profile: no blocker (callers fail with UNKNOWN_PROFILE).
  assert.equal(checkout.blockerFor("does-not-exist"), undefined);

  // Generation changes when the profile surface changes.
  const beforeGeneration = checkout.generation;
  await writeProfile(join(workspaceRoot, ".devspace", "agents"), "extra-policy", [
    "name: extra-policy",
    "description: Extra.",
    "provider: agy",
  ]);
  git("add", ".devspace/agents/extra-policy.md");
  git("commit", "-q", "-m", "extra");
  const afterExtra = await loadProfileCatalog(config, workspaceRoot);
  assert.notEqual(afterExtra.generation, beforeGeneration);

  // Disabled global profile: explicit state, typed blocker.
  await writeProfile(join(configDir, "agents"), "agy-gemini-review", [
    "name: agy-gemini-review",
    "description: Global gemini review capability.",
    "provider: agy",
    "model: gemini-3.7-flash-medium",
    "write_mode: read_only",
    "disabled: true",
  ]);
  const disabledCatalog = await loadProfileCatalog(config, workspaceRoot);
  assert.equal(
    disabledCatalog.entries.find((entry) => entry.name === "agy-gemini-review")?.state,
    "disabled",
  );
  assert.equal(disabledCatalog.blockerFor("agy-gemini-review")?.code, "PROFILE_DISABLED");
} finally {
  await rm(root, { recursive: true, force: true });
}
