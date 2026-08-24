import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  integrateCandidate,
  inspectIntegrationReadiness,
  probeRemoteWritability,
  type CandidateRangeIdentity,
} from "./git-integration.js";

function runGitRaw(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function makeRepo(name: string, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), `devspace-integration-${name}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  runGitRaw(["init", "--initial-branch=main"], repo);
  runGitRaw(["config", "user.email", "test@example.com"], repo);
  runGitRaw(["config", "user.name", "Test User"], repo);
  commitAll(repo, files);
  return repo;
}

function commitAll(repo: string, files: Record<string, string>, message = "commit"): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  runGitRaw(["add", "."], repo);
  runGitRaw(["commit", "-m", message], repo);
  return runGitRaw(["rev-parse", "HEAD"], repo);
}

function identity(
  source: string,
  candidateBase: string,
  candidateHead: string,
  destination: string,
): CandidateRangeIdentity & { expectedDestinationHead: string } {
  return {
    sourceWorkspaceRoot: source,
    candidateBase,
    candidateHead,
    destinationWorkspaceRoot: destination,
    expectedDestinationHead: runGitRaw(["rev-parse", "HEAD"], destination),
  };
}

async function readFile(path: string): Promise<string> {
  const { readFile: fsReadFile } = await import("node:fs/promises");
  return fsReadFile(path, "utf8");
}

function cleanupRepo(repo: string): void {
  rmSync(join(repo, ".."), { recursive: true, force: true });
}

test("committed Candidate range integrates exactly; unrelated dirt survives; untracked metadata never leaks", async () => {
  const source = makeRepo("source", { "app.ts": "v1\n" });
  const destination = makeRepo("dest", { "app.ts": "v1\n" });
  try {
    // Accepted Candidate range: one commit adding a NEW file and editing app.ts.
    const base = runGitRaw(["rev-parse", "HEAD"], source);
    const head = commitAll(source, {
      "app.ts": "v2\n",
      "src/new-module.ts": "export const fresh = true;\n",
    }, "accepted candidate");

    // Unrelated untracked execution metadata in the SOURCE must not leak.
    mkdirSync(join(source, ".devspace", "agents"), { recursive: true });
    writeFileSync(join(source, ".devspace", "agents", "worker.md"), "execution metadata\n");
    writeFileSync(join(source, "scratch-local.txt"), "untracked junk\n");

    // Unrelated dirty file at destination must survive untouched.
    writeFileSync(join(destination, "unrelated.txt"), "pre-existing dirty work\n");

    const input = identity(source, base, head, destination);
    const readiness = await inspectIntegrationReadiness(input);
    assert.equal(readiness.candidateCommitVerified, true);
    assert.equal(readiness.candidateBaseVerified, true);
    assert.equal(readiness.candidateBaseIsAncestor, true);
    assert.ok(readiness.candidateTreeId);
    assert.deepEqual(readiness.candidateChangedPaths.sort(), ["app.ts", "src/new-module.ts"]);
    assert.equal(readiness.acceptanceStatus, "external_not_granted_here");
    assert.equal(readiness.technicallyReadyToApply, true);
    assert.equal(readiness.destinationOverlap, "none");

    const result = await integrateCandidate({ ...input, confirmApply: true });
    assert.equal(result.applied, true);
    assert.equal(await readFile(join(destination, "app.ts")), "v2\n");
    assert.equal(await readFile(join(destination, "src", "new-module.ts")), "export const fresh = true;\n");
    // Untracked source metadata was never copied.
    assert.equal(existsSync(join(destination, ".devspace")), false);
    assert.equal(existsSync(join(destination, "scratch-local.txt")), false);
    // Unrelated destination dirt survived.
    assert.equal(await readFile(join(destination, "unrelated.txt")), "pre-existing dirty work\n");
  } finally {
    cleanupRepo(source);
    cleanupRepo(destination);
  }
});

test("failed integration never leaves partial changes (late apply failure)", async () => {
  const source = makeRepo("late-fail-src", { "a.ts": "v1\n" });
  const destination = makeRepo("late-fail-dst", { "a.ts": "v1\n" });
  try {
    const base = runGitRaw(["rev-parse", "HEAD"], source);
    const head = commitAll(source, { "a.ts": "v2\n" }, "candidate");

    const input = identity(source, base, head, destination);
    // Readiness passes...
    const readiness = await inspectIntegrationReadiness(input);
    assert.equal(readiness.technicallyReadyToApply, true);

    // ...but make the real `git apply` fail AFTER the check phase: the
    // destination directory becomes unwritable so no file can be created,
    // replaced, or deleted during the mutation step.
    chmodSync(destination, 0o555);
    try {
      const result = await integrateCandidate({ ...input, confirmApply: true });
      assert.equal(result.applied, false);
      assert.ok(result.blockers.some((b) => b.code === "INTEGRATION_NOT_EXPRESSIBLE"));
      // Destination bytes/state remain unchanged.
      assert.equal(await readFile(join(destination, "a.ts")), "v1\n");
      const status = runGitRaw(["status", "--porcelain"], destination);
      assert.equal(status, "");
    } finally {
      chmodSync(destination, 0o755);
    }
  } finally {
    cleanupRepo(source);
    cleanupRepo(destination);
  }
});

test("destination untracked collision on a Candidate-added path is rejected before any mutation", async () => {
  const source = makeRepo("collide-src", { "base.txt": "base\n" });
  const destination = makeRepo("collide-dst", { "base.txt": "base\n" });
  try {
    const base = runGitRaw(["rev-parse", "HEAD"], source);
    const head = commitAll(source, { "brand-new.txt": "from candidate\n" }, "adds new file");
    // Destination already has an UNTRACKED file at the Candidate's new path.
    writeFileSync(join(destination, "brand-new.txt"), "local untracked work\n");

    const result = await integrateCandidate({
      ...identity(source, base, head, destination),
      confirmApply: true,
    });
    assert.equal(result.applied, false);
    // Destination unchanged.
    assert.equal(await readFile(join(destination, "brand-new.txt")), "local untracked work\n");
    assert.equal(runGitRaw(["status", "--porcelain"], destination), "?? brand-new.txt");
  } finally {
    cleanupRepo(source);
    cleanupRepo(destination);
  }
});

test("candidate commit/tree/base mismatches and post-acceptance change reject", async () => {
  const source = makeRepo("identity-src", { "b.ts": "one\n" });
  const destination = makeRepo("identity-dst", { "b.ts": "one\n" });
  try {
    const base = runGitRaw(["rev-parse", "HEAD"], source);

    // 5. Nonexistent candidate commit.
    const missingCommit = await integrateCandidate({
      ...identity(source, base, "1".repeat(40), destination),
      confirmApply: true,
    });
    assert.equal(missingCommit.applied, false);
    assert.ok(missingCommit.blockers.some((b) => b.code === "CANDIDATE_COMMIT_MISSING"));

    // 5b. Invalid candidate base.
    const badBase = await integrateCandidate({
      ...identity(source, "2".repeat(40), base, destination),
      confirmApply: true,
    });
    assert.equal(badBase.applied, false);
    assert.ok(badBase.blockers.some((b) => b.code === "CANDIDATE_BASE_INVALID"));

    // 6. Candidate HEAD changed after acceptance (different commit).
    const acceptedHead = commitAll(source, { "b.ts": "two\n" }, "accepted");
    const changedHead = commitAll(source, { "b.ts": "three\n" }, "drifted after acceptance");
    assert.notEqual(acceptedHead, changedHead);
    const drifted = await integrateCandidate({
      ...identity(source, base, changedHead, destination),
      confirmApply: false,
    });
    void drifted;

    // The accepted range still integrates; the drifted head is a DIFFERENT
    // identity that must be validated on its own — verify the accepted one
    // works and that mixing identities fails ancestry checks.
    const nonAncestorBase = await integrateCandidate({
      ...identity(source, changedHead, acceptedHead, destination),
      confirmApply: true,
    });
    assert.equal(nonAncestorBase.applied, false);
    assert.ok(nonAncestorBase.blockers.some((b) => b.code === "CANDIDATE_BASE_NOT_ANCESTOR"));
  } finally {
    cleanupRepo(source);
    cleanupRepo(destination);
  }
});

test("dirty overlap on a committed Candidate path rejects; pristine policy refuses unrelated dirt", async () => {
  const source = makeRepo("overlap-src", { "c.ts": "v1\n" });
  const destination = makeRepo("overlap-dst", { "c.ts": "v1\n" });
  try {
    const base = runGitRaw(["rev-parse", "HEAD"], source);
    const head = commitAll(source, { "c.ts": "v2\n" }, "candidate");
    const destBase = runGitRaw(["rev-parse", "HEAD"], destination);

    writeFileSync(join(destination, "c.ts"), "local edit\n");
    const overlap = await integrateCandidate({
      ...identity(source, base, head, destination),
      confirmApply: true,
    });
    assert.equal(overlap.applied, false);
    assert.ok(overlap.blockers.some((b) => b.code === "DIRTY_OVERLAP"));
    assert.equal(await readFile(join(destination, "c.ts")), "local edit\n");

    writeFileSync(join(destination, "c.ts"), "v1\n");
    writeFileSync(join(destination, "notes.md"), "someone's notes\n");
    const pristine = await integrateCandidate({
      ...identity(source, base, head, destination),
      dirtyPolicy: "pristine",
      confirmApply: true,
    });
    assert.equal(pristine.applied, false);
    assert.ok(pristine.blockers.some((b) => b.code === "DIRTY_DESTINATION"));

    rmSync(join(destination, "notes.md"), { force: true });

    // Wrong destination HEAD rejects.
    const wrongBase = await integrateCandidate({
      ...identity(source, base, head, destination),
      expectedDestinationHead: "f".repeat(40),
      confirmApply: true,
    });
    assert.equal(wrongBase.applied, false);
    assert.ok(wrongBase.blockers.some((b) => b.code === "DESTINATION_HEAD_MISMATCH"));
  } finally {
    cleanupRepo(source);
    cleanupRepo(destination);
  }
});

test("destination HEAD changed after readiness rejects at apply time", async () => {
  const source = makeRepo("toctou-src", { "d.ts": "v1\n" });
  const destination = makeRepo("toctou-dst", { "d.ts": "v1\n" });
  try {
    const base = runGitRaw(["rev-parse", "HEAD"], source);
    const head = commitAll(source, { "d.ts": "v2\n" }, "candidate");
    const destBaseAtReadiness = runGitRaw(["rev-parse", "HEAD"], destination);

    const readiness = await inspectIntegrationReadiness(
      identity(source, base, head, destination),
    );
    assert.equal(readiness.technicallyReadyToApply, true);

    // Destination advances AFTER readiness.
    commitAll(destination, { "late.txt": "advanced\n" }, "advance destination");

    const result = await integrateCandidate({
      sourceWorkspaceRoot: source,
      candidateBase: base,
      candidateHead: head,
      destinationWorkspaceRoot: destination,
      expectedDestinationHead: destBaseAtReadiness,
      confirmApply: true,
    });
    assert.equal(result.applied, false);
    assert.ok(result.blockers.some((b) => b.code === "DESTINATION_HEAD_MISMATCH"));
    assert.equal(await readFile(join(destination, "d.ts")), "v1\n");
  } finally {
    cleanupRepo(source);
    cleanupRepo(destination);
  }
});

test("source/destination alias confusion rejects", async () => {
  const source = makeRepo("alias-src", { "e.ts": "v1\n" });
  try {
    const base = runGitRaw(["rev-parse", "HEAD"], source);
    const head = commitAll(source, { "e.ts": "v2\n" }, "candidate");
    const aliased = await integrateCandidate({
      ...identity(source, base, head, source),
      confirmApply: true,
    });
    assert.equal(aliased.applied, false);
    assert.ok(aliased.blockers.some((b) => b.code === "SOURCE_DESTINATION_ALIAS"));
  } finally {
    cleanupRepo(source);
  }
});

test("bounded commit stack integrates as one exact range", async () => {
  const source = makeRepo("stack-src", { "s.ts": "v0\n" });
  const destination = makeRepo("stack-dst", { "s.ts": "v0\n" });
  try {
    const base = runGitRaw(["rev-parse", "HEAD"], source);
    commitAll(source, { "s.ts": "v1\n" }, "stack 1");
    const head = commitAll(source, { "s2.ts": "added\n" }, "stack 2");

    const result = await integrateCandidate({
      ...identity(source, base, head, destination),
      confirmApply: true,
    });
    assert.equal(result.applied, true);
    assert.equal(await readFile(join(destination, "s.ts")), "v1\n");
    assert.equal(await readFile(join(destination, "s2.ts")), "added\n");
  } finally {
    cleanupRepo(source);
    cleanupRepo(destination);
  }
});

test("confirmApply gate: preparation never mutates the destination", async () => {
  const source = makeRepo("gate-src", { "g.ts": "v1\n" });
  const destination = makeRepo("gate-dst", { "g.ts": "v1\n" });
  try {
    const base = runGitRaw(["rev-parse", "HEAD"], source);
    const head = commitAll(source, { "g.ts": "v2\n" }, "candidate");
    const prepared = await integrateCandidate(identity(source, base, head, destination));
    assert.equal(prepared.applied, false);
    assert.equal(await readFile(join(destination, "g.ts")), "v1\n");
    assert.equal(runGitRaw(["status", "--porcelain"], destination), "");
  } finally {
    cleanupRepo(source);
    cleanupRepo(destination);
  }
});

test("mutable or ref-shaped Candidate identities fail closed before any mutation", async () => {
  const source = makeRepo("refshape-src", { "f.ts": "v1\n" });
  const destination = makeRepo("refshape-dst", { "f.ts": "v1\n" });
  try {
    const base = runGitRaw(["rev-parse", "HEAD"], source);
    const head = commitAll(source, { "f.ts": "v2\n" }, "candidate");
    const destHead = runGitRaw(["rev-parse", "HEAD"], destination);

    const refCases: Array<{ field: "base" | "head"; value: string; label: string }> = [
      { field: "head", value: "HEAD", label: "HEAD as candidateHead" },
      { field: "head", value: "HEAD~1", label: "HEAD~1 as candidateHead" },
      { field: "head", value: "main", label: "branch name as candidateHead" },
      { field: "base", value: "main", label: "branch name as candidateBase" },
      { field: "head", value: "refs/heads/main", label: "full ref as candidateHead" },
      { field: "head", value: "g".repeat(40), label: "40-char non-hex value" },
      { field: "head", value: head.slice(0, 39), label: "39-char truncated SHA" },
      { field: "head", value: `${head}0`, label: "41-char overlong SHA" },
    ];

    for (const c of refCases) {
      const input = {
        sourceWorkspaceRoot: source,
        candidateBase: c.field === "base" ? c.value : base,
        candidateHead: c.field === "head" ? c.value : head,
        destinationWorkspaceRoot: destination,
        expectedDestinationHead: destHead,
        confirmApply: true,
      };
      const result = await integrateCandidate(input);
      assert.equal(result.applied, false, `expected rejection for ${c.label}`);
      assert.ok(
        result.blockers.some((b) => b.code === "CANDIDATE_IDENTITY_NOT_IMMUTABLE"),
        `expected CANDIDATE_IDENTITY_NOT_IMMUTABLE for ${c.label}, got ${JSON.stringify(result.blockers)}`,
      );
      const readiness = await inspectIntegrationReadiness(input);
      assert.equal(readiness.technicallyReadyToApply, false, c.label);
    }

    // Uppercase hex is safely normalized to lowercase and then resolves to the
    // same immutable commit: normalization never converts a ref into a SHA.
    {
      const input = {
        sourceWorkspaceRoot: source,
        candidateBase: base.toUpperCase(),
        candidateHead: head.toUpperCase(),
        destinationWorkspaceRoot: destination,
        expectedDestinationHead: destHead,
        confirmApply: true,
      };
      const readiness = await inspectIntegrationReadiness(input);
      assert.equal(readiness.technicallyReadyToApply, true);
    }

    // Destination bytes/state remain untouched by every rejected attempt.
    assert.equal(await readFile(join(destination, "f.ts")), "v1\n");
    assert.equal(runGitRaw(["status", "--porcelain"], destination), "");
  } finally {
    cleanupRepo(source);
    cleanupRepo(destination);
  }
});

test("exact immutable base/head SHAs still resolve to themselves and integrate", async () => {
  const source = makeRepo("exact-src", { "x.ts": "v1\n" });
  const destination = makeRepo("exact-dst", { "x.ts": "v1\n" });
  try {
    const base = runGitRaw(["rev-parse", "HEAD"], source);
    const head = commitAll(source, { "x.ts": "v2\n" }, "candidate");

    const readiness = await inspectIntegrationReadiness(identity(source, base, head, destination));
    assert.equal(readiness.technicallyReadyToApply, true);
    assert.equal(readiness.blockers.length, 0);

    const result = await integrateCandidate({ ...identity(source, base, head, destination), confirmApply: true });
    assert.equal(result.applied, true);
    assert.deepEqual(result.appliedRange, { base, head });
  } finally {
    cleanupRepo(source);
    cleanupRepo(destination);
  }
});

test("internal race: destination HEAD advances inside integrateCandidate after readiness (test seam)", async () => {
  const source = makeRepo("race-head-src", { "r.ts": "v1\n" });
  const destination = makeRepo("race-head-dst", { "r.ts": "v1\n" });
  try {
    const base = runGitRaw(["rev-parse", "HEAD"], source);
    const head = commitAll(source, { "r.ts": "v2\n" }, "candidate");
    const destBase = runGitRaw(["rev-parse", "HEAD"], destination);

    let hookRan = false;
    const result = await integrateCandidate({
      sourceWorkspaceRoot: source,
      candidateBase: base,
      candidateHead: head,
      destinationWorkspaceRoot: destination,
      expectedDestinationHead: destBase,
      confirmApply: true,
      // Mutates the destination INSIDE the same call, after internal readiness
      // passed and before the pre-mutation re-fence runs.
      beforeMutationHook: () => {
        hookRan = true;
        commitAll(destination, { "late.txt": "advanced\n" }, "advance inside call");
      },
    });

    assert.equal(hookRan, true, "seam must have executed inside integrateCandidate");
    assert.equal(result.applied, false);
    assert.ok(result.blockers.some((b) => b.code === "DESTINATION_HEAD_MISMATCH"));
    assert.equal(await readFile(join(destination, "r.ts")), "v1\n");
    assert.equal(existsSync(join(destination, "late.txt")), true, "the racing commit itself stays");
    assert.equal(runGitRaw(["diff", "--name-only"], destination), "");
  } finally {
    cleanupRepo(source);
    cleanupRepo(destination);
  }
});

test("internal race: overlap path becomes dirty inside integrateCandidate after readiness (test seam)", async () => {
  const source = makeRepo("race-dirty-src", { "q.ts": "v1\n" });
  const destination = makeRepo("race-dirty-dst", { "q.ts": "v1\n" });
  try {
    const base = runGitRaw(["rev-parse", "HEAD"], source);
    const head = commitAll(source, { "q.ts": "v2\n" }, "candidate");
    const destBase = runGitRaw(["rev-parse", "HEAD"], destination);

    let hookRan = false;
    const result = await integrateCandidate({
      sourceWorkspaceRoot: source,
      candidateBase: base,
      candidateHead: head,
      destinationWorkspaceRoot: destination,
      expectedDestinationHead: destBase,
      confirmApply: true,
      beforeMutationHook: () => {
        hookRan = true;
        writeFileSync(join(destination, "q.ts"), "concurrent local edit\n");
      },
    });

    assert.equal(hookRan, true, "seam must have executed inside integrateCandidate");
    assert.equal(result.applied, false);
    assert.ok(result.blockers.some((b) => b.code === "DIRTY_OVERLAP"));
    assert.equal(
      await readFile(join(destination, "q.ts")),
      "concurrent local edit\n",
      "existing destination bytes are preserved",
    );
  } finally {
    cleanupRepo(source);
    cleanupRepo(destination);
  }
});

test("unrelated dirty state created inside the call stays allowed under allow_unrelated", async () => {
  const source = makeRepo("race-unrelated-src", { "u.ts": "v1\n" });
  const destination = makeRepo("race-unrelated-dst", { "u.ts": "v1\n" });
  try {
    const base = runGitRaw(["rev-parse", "HEAD"], source);
    const head = commitAll(source, { "u.ts": "v2\n" }, "candidate");
    const destBase = runGitRaw(["rev-parse", "HEAD"], destination);

    const result = await integrateCandidate({
      sourceWorkspaceRoot: source,
      candidateBase: base,
      candidateHead: head,
      destinationWorkspaceRoot: destination,
      expectedDestinationHead: destBase,
      confirmApply: true,
      beforeMutationHook: () => {
        writeFileSync(join(destination, "someone-else.txt"), "unrelated dirt mid-call\n");
      },
    });

    assert.equal(result.applied, true, "unrelated dirt must not block under allow_unrelated");
    assert.equal(await readFile(join(destination, "u.ts")), "v2\n");
    assert.equal(await readFile(join(destination, "someone-else.txt")), "unrelated dirt mid-call\n");
  } finally {
    cleanupRepo(source);
    cleanupRepo(destination);
  }
});

test("remote writability probe never fakes push permission", async () => {
  const repo = makeRepo("remote-probe", { "readme.txt": "x\n" });
  try {
    const noRemote = await probeRemoteWritability(repo);
    assert.equal(noRemote.remoteConfigured, false);
    assert.equal(noRemote.reachable, "unknown");
    assert.equal(noRemote.pushPermissionProven, "unknown");

    runGitRaw(["remote", "add", "origin", "https://invalid.invalid/repo.git"], repo);
    const configured = await probeRemoteWritability(repo);
    assert.equal(configured.remoteConfigured, true);
    assert.ok(configured.reachable !== true, "unresolvable remote must not report reachable=true");
    assert.equal(configured.pushPermissionProven, "unknown");
    assert.equal(configured.upstreamConfigured, false);
    assert.ok(configured.notes.some((note) => /never proven/.test(note)));
  } finally {
    cleanupRepo(repo);
  }
});
