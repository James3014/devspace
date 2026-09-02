import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import {
  loadLocalAgentProfileEntries,
  loadLocalAgentProfiles,
  summarizeLocalAgentProfile,
} from "./local-agent-profiles.js";

const root = await mkdtemp(join(tmpdir(), "devspace-agent-profiles-test-"));

try {
  const configDir = join(root, ".devspace-home");
  const workspaceRoot = join(root, "project");
  await mkdir(join(configDir, "agents"), { recursive: true });
  await mkdir(join(workspaceRoot, ".devspace", "agents"), { recursive: true });

  await writeFile(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Global reviewer.",
      "provider: codex",
      "model: gpt-5.4",
      "---",
      "",
      "Global body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      'description: "Project reviewer #1."',
      "provider: claude",
      "model: sonnet",
      "effort: high",
      "---",
      "",
      "Project body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "disabled.md"),
    [
      "---",
      "name: disabled",
      "description: Disabled agent.",
      "provider: codex",
      "disabled: true",
      "---",
      "",
      "Disabled body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "writer.md"),
    [
      "---",
      "name: writer",
      "description: Writer agent.",
      "provider: agy",
      "write_mode: allowed",
      "---",
      "",
      "Writer body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "invalid-mode.md"),
    [
      "---",
      "name: invalid-mode",
      "description: Invalid write mode agent.",
      "provider: agy",
      "write_mode: dangerous",
      "---",
      "",
      "Invalid body.",
      "",
    ].join("\n"),
  );

  const enabledConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });

  // Workspace is not a git worktree here: repository-local profiles without a
  // repo remain loadable with an explicit diagnostic. The same-name reviewer
  // definitions conflict and are never silently overridden.
  const profiles = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);
  assert.deepEqual(profiles.map((profile) => profile.name), ["writer"]);

  // Same-name global/repo definitions conflict: no silent override.
  const entries = await loadLocalAgentProfileEntries(enabledConfig, workspaceRoot);
  const reviewer = entries.find((entry) => entry.profile.name === "reviewer");
  assert.equal(reviewer?.status.state, "profile_authority_conflict");
  assert.match(reviewer?.status.diagnostic ?? "", /PROFILE_AUTHORITY_CONFLICT/);

  const writer = entries.find((entry) => entry.profile.name === "writer");
  assert.equal(writer?.status.state, "ready");
  assert.match(writer?.status.diagnostic ?? "", /not a Git worktree/);

  const disabledEntry = entries.find((entry) => entry.profile.name === "disabled");
  assert.equal(disabledEntry?.status.state, "disabled");

  assert.equal(profiles[0]?.name, "writer");
  assert.equal(profiles[0]?.write_mode, "allowed");

  // includeDisabled surfaces disabled profiles but never conflicted ones.
  const withDisabled = await loadLocalAgentProfiles(enabledConfig, workspaceRoot, {
    includeDisabled: true,
  });
  assert.deepEqual(
    withDisabled.map((profile) => profile.name).sort(),
    ["disabled", "writer"],
  );

  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "custom.md"),
    [
      "---",
      "name: custom",
      "description: Unsupported custom agent.",
      "provider: custom",
      "---",
      "",
      "Custom body.",
      "",
    ].join("\n"),
  );
  const profilesWithInvalid = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);
  assert.deepEqual(profilesWithInvalid.map((profile) => profile.name), ["writer"]);

  const disabledConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  assert.deepEqual(await loadLocalAgentProfiles(disabledConfig, workspaceRoot), []);
} finally {
  await rm(root, { recursive: true, force: true });
}

// ─── Git-tracked repository profile authority ───────────────────────────────

const gitRoot = await mkdtemp(join(tmpdir(), "devspace-agent-profiles-git-"));

try {
  const configDir = join(gitRoot, ".devspace-home");
  const workspaceRoot = join(gitRoot, "repo");
  await mkdir(join(configDir, "agents"), { recursive: true });
  await mkdir(join(workspaceRoot, ".devspace", "agents"), { recursive: true });

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", workspaceRoot, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");

  const writeProfile = async (name: string, lines: string[]) => {
    await writeFile(join(workspaceRoot, ".devspace", "agents", `${name}.md`), [
      "---",
      ...lines,
      "---",
      "",
      "Body.",
      "",
    ].join("\n"));
  };

  await writeFile(
    join(configDir, "agents", "agy-gemini-review.md"),
    [
      "---",
      "name: agy-gemini-review",
      "description: Global gemini review capability.",
      "provider: agy",
      "model: gemini-3.7-flash-medium",
      "write_mode: read_only",
      "---",
      "",
      "Global body.",
      "",
    ].join("\n"),
  );

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });

  // Untracked repo profile: visible as diagnostic, never dispatchable.
  await writeProfile("project-policy", ["name: project-policy", "description: Project policy.", "provider: agy"]);
  const untrackedEntries = await loadLocalAgentProfileEntries(config, workspaceRoot);
  assert.equal(
    untrackedEntries.find((entry) => entry.profile.name === "project-policy")?.status.state,
    "untracked_repository_profile",
  );
  const untrackedProfiles = await loadLocalAgentProfiles(config, workspaceRoot);
  assert.deepEqual(untrackedProfiles.map((profile) => profile.name), ["agy-gemini-review"]);

  // Tracked repo profile: dispatchable.
  git("add", ".devspace/agents/project-policy.md");
  git("commit", "-q", "-m", "track profile");
  const trackedEntries = await loadLocalAgentProfileEntries(config, workspaceRoot);
  const trackedEntry = trackedEntries.find((entry) => entry.profile.name === "project-policy");
  assert.equal(trackedEntry?.status.state, "ready");
  assert.equal(trackedEntry?.status.tracked, true);
  const trackedProfiles = await loadLocalAgentProfiles(config, workspaceRoot);
  assert.deepEqual(trackedProfiles.map((profile) => profile.name).sort(), [
    "agy-gemini-review",
    "project-policy",
  ]);

  // Same checkout/worktree invariant: same committed revision yields the same
  // advertised set regardless of physical checkout path.
  const worktreePath = join(gitRoot, "wt");
  git("worktree", "add", "-q", worktreePath, "HEAD");
  const worktreeEntries = await loadLocalAgentProfileEntries(config, worktreePath);
  assert.deepEqual(
    worktreeEntries
      .filter((entry) => entry.status.state === "ready")
      .map((entry) => entry.profile.name)
      .sort(),
    trackedProfiles.map((profile) => profile.name).sort(),
  );

  // Tracked repository override with explicit extends+override: allowed.
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "agy-gemini-review.md"),
    [
      "---",
      "name: agy-gemini-review",
      "description: Project-tuned review policy.",
      "provider: agy",
      "model: gemini-3.7-flash-medium",
      "write_mode: read_only",
      "extends: global:agy-gemini-review",
      "override: true",
      "---",
      "",
      "Project body.",
      "",
    ].join("\n"),
  );
  git("add", ".devspace/agents/agy-gemini-review.md");
  git("commit", "-q", "-m", "override");
  const overrideEntries = await loadLocalAgentProfileEntries(config, workspaceRoot);
  const overrideEntry = overrideEntries.find((entry) => entry.profile.name === "agy-gemini-review");
  assert.equal(overrideEntry?.status.state, "ready");
  assert.equal(overrideEntry?.profile.description, "Project-tuned review policy.");

  // Conflicting override without extends/override declaration: fail closed.
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "agy-gemini-review.md"),
    [
      "---",
      "name: agy-gemini-review",
      "description: Silent conflicting policy.",
      "provider: agy",
      "model: gemini-3.7-flash-medium",
      "write_mode: read_only",
      "---",
      "",
      "Project body.",
      "",
    ].join("\n"),
  );
  git("add", ".devspace/agents/agy-gemini-review.md");
  git("commit", "-q", "-m", "silent conflict");
  const conflictEntries = await loadLocalAgentProfileEntries(config, workspaceRoot);
  assert.equal(
    conflictEntries.find((entry) => entry.profile.name === "agy-gemini-review")?.status.state,
    "profile_authority_conflict",
  );
  const conflictProfiles = await loadLocalAgentProfiles(config, workspaceRoot);
  assert.equal(conflictProfiles.find((profile) => profile.name === "agy-gemini-review"), undefined);
} finally {
  await rm(gitRoot, { recursive: true, force: true });
}
