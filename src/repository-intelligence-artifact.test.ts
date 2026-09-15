import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  consumeRepositoryIntelligenceArtifact,
  validateRepositoryIntelligenceArtifactPayload,
} from "./repository-intelligence-artifact.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const CONTENT_SHA = "c".repeat(64);
const DIGEST = `sha256:${"d".repeat(64)}`;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schema: "devspace.repository_intelligence_artifact.v1",
    repository: "owner/repo",
    prNumber: 7,
    expectedHead: HEAD,
    artifactId: 42,
    artifactName: `repository-intelligence-pr-7-${HEAD}`,
    artifactDigest: DIGEST,
    workflowRunId: 99,
    reviewIdentity: ["owner/repo", 7, HEAD, BASE, BASE],
    contentSha256: CONTENT_SHA,
    claimCeiling: "ADVISORY_EVIDENCE_ONLY",
    readiness: "REVIEW_READY",
    cfiStatus: "NO_TERMINAL_FAILURE",
    eiaDecision: "NO_ACTION",
    snapshotSemantics: "PR_EVENT_SNAPSHOT_NOT_TERMINAL_CI",
    ...overrides,
  };
}

test("artifact payload validation binds exact subject and preserves advisory ceiling", () => {
  const result = validateRepositoryIntelligenceArtifactPayload(
    payload(),
    { repository: "owner/repo", prNumber: 7, expectedHead: HEAD },
  );
  assert.equal(result.artifactId, 42);
  assert.equal(result.claimCeiling, "ADVISORY_EVIDENCE_ONLY");
  assert.equal(result.reviewIdentity[2], HEAD);
  assert.equal(result.snapshotSemantics, "PR_EVENT_SNAPSHOT_NOT_TERMINAL_CI");
});

test("artifact payload validation fails closed on identity, claim and digest drift", () => {
  const expected = { repository: "owner/repo", prNumber: 7, expectedHead: HEAD };
  assert.throws(
    () => validateRepositoryIntelligenceArtifactPayload(payload({ expectedHead: "e".repeat(40) }), expected),
    /subject mismatch/,
  );
  assert.throws(
    () => validateRepositoryIntelligenceArtifactPayload(payload({ claimCeiling: "PR_INTELLIGENCE_ONLY" }), expected),
    /claim ceiling mismatch/,
  );
  assert.throws(
    () => validateRepositoryIntelligenceArtifactPayload(payload({ artifactDigest: "sha256:short" }), expected),
    /digest is invalid/,
  );
  assert.throws(
    () => validateRepositoryIntelligenceArtifactPayload(
      payload({ reviewIdentity: ["owner/repo", 7, "e".repeat(40), BASE, BASE] }),
      expected,
    ),
    /review identity mismatches/,
  );
});

test("artifact consumer verifies exact engine HEAD before invoking helper and keeps token off argv", async () => {
  let helperCalled = false;
  const result = await consumeRepositoryIntelligenceArtifact(
    {
      repositoryIntelligenceRoot: "/tmp/rie",
      repositoryIntelligenceExpectedHead: "f".repeat(40),
      repositoryIntelligencePythonBin: "python-test",
    },
    { repository: "owner/repo", prNumber: 7, expectedHead: HEAD.toUpperCase() },
    {
      helperPath: "/tmp/consume-rie-artifact.py",
      env: { GH_TOKEN: "secret-token", PYTHONPATH: "/existing" },
      verifyEngineHead: async (root, expectedHead) => {
        assert.equal(root, "/tmp/rie");
        assert.equal(expectedHead, "f".repeat(40));
        return expectedHead;
      },
      runProcess: async (executable, args, options) => {
        helperCalled = true;
        assert.equal(executable, "python-test");
        assert.deepEqual(args, [
          "/tmp/consume-rie-artifact.py",
          "--repository", "owner/repo",
          "--pr-number", "7",
          "--expected-head", HEAD,
        ]);
        assert.equal(args.includes("secret-token"), false);
        assert.equal(options.cwd, "/tmp/rie");
        assert.equal(options.env.GH_TOKEN, "secret-token");
        assert.ok(options.env.PYTHONPATH?.startsWith("/tmp/rie"));
        return { stdout: JSON.stringify(payload()), stderr: "" };
      },
    },
  );
  assert.equal(helperCalled, true);
  assert.equal(result.engineHead, "f".repeat(40));
  assert.equal(result.expectedHead, HEAD);
});

test("artifact consumer rejects malformed helper output and configuration before use", async () => {
  await assert.rejects(
    () => consumeRepositoryIntelligenceArtifact(
      {},
      { repository: "owner/repo", prNumber: 7, expectedHead: HEAD },
    ),
    /configured exact engine root/,
  );
  await assert.rejects(
    () => consumeRepositoryIntelligenceArtifact(
      {
        repositoryIntelligenceRoot: "/tmp/rie",
        repositoryIntelligenceExpectedHead: "f".repeat(40),
      },
      { repository: "owner/repo", prNumber: 7, expectedHead: HEAD },
      {
        verifyEngineHead: async () => "f".repeat(40),
        runProcess: async () => ({ stdout: "not-json", stderr: "" }),
      },
    ),
    /invalid JSON/,
  );
});

test("Python helper self-test covers selection, ambiguity, archive safety and bundle identity gates", () => {
  const helperPath = fileURLToPath(new URL("../scripts/consume-rie-artifact.py", import.meta.url));
  const stdout = execFileSync("python3", [helperPath, "--self-test"], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(stdout.trim(), "ok");
});
