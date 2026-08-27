import fs from "node:fs";
import {
  createGhCliGitHubTransport,
  createTrustedIntegrationTargetResolver,
  evaluateRequiredChecks,
  mergePullRequest,
} from "../src/git-pr-merge.js";
import { runGitHubCompletionTool } from "../src/github-completion-host.js";

const repo = "James3014/Nexus-new";
const nexusRoot = "/Users/jameschen/Workspace/.devspace-chatgpt/worktrees/Nexus-new-49349983";
const pythonBin = "/Users/jameschen/Workspace/Nexus-new/.venv/bin/python";
const driftB = "e44d0600c376ffd77080accc739ab9ddf7392939";
const cPr = 643;
const cHead = "c4aa80da82a0c6359e3fc9847dbc9df8b45368b4";
const targetResolver = createTrustedIntegrationTargetResolver([
  { remoteName: "origin", repository: repo, defaultBranch: "main" },
]);
const transport = createGhCliGitHubTransport();

const initialEvidence = {
  "schema": "nexus.github_orchestration_evidence.v2",
  "repository": "James3014/Nexus-new",
  "issue_number": 599,
  "pull_request_number": 641,
  "base_sha": "5c93a14cac735b757a0262a6865b6f50bcdedd53",
  "head_sha": "c45d68b23ad742386699d88cd3100ab8e61a1d17",
  "tree_sha": "aceef56f59f76a1079ba1a418280ff78464ebc5b",
  "current_main_sha": "5c93a14cac735b757a0262a6865b6f50bcdedd53",
  "diff_hash": "d3faab9df633a6c9ee2d223d222cc542d13ef5ee8f836d85f3ccc27db0d3cd7f",
  "checks_hash": "e07c419a49b250548e91d39fd433207eaf7f043dc01a7b4df6f97f2768d800d7",
  "reviews_hash": "5902150e282fb2ebb1b3fc2f582f704681d51fe8c81330a6cf207782a32752c0",
  "task_attempt_contract_hash": "0e665f4e2c6fda7c487bd951f62891f951e57f50a981e242a41eb8f2452dfeae",
  "candidate_hash": "be656517d29b3fe09e03aeaa75f2fc7a96807aaf7d72f3a9294544b6299003d9",
  "verifier_hash": "84d1567a426d1e1125a537f418cc0706eef9dcd7c09e49b4c67251fd627571f6",
  "independent_acceptance_hash": "044052f06154f04b9dc71aea8a648681e994c00459cc497ae53d010eddbe2986",
  "impact_hash": "c1da74025d67eda60ff1501318678865499da2393d5ef4bcd26cdce24b46f8cd",
  "observed_at": "2026-08-26T22:03:07.815128Z",
  "fresh_until": "2026-08-27T00:03:07.815128Z",
  "allowed_paths": [
    "docs/verification/issue-599-live-caller-20260827/a8-candidate.md"
  ],
  "changed_paths": [
    "docs/verification/issue-599-live-caller-20260827/a8-candidate.md"
  ],
  "required_checks": [
    {
      "name": "Exact-base impact gate",
      "status": "completed",
      "conclusion": "success",
      "terminal": true,
      "head_sha": "c45d68b23ad742386699d88cd3100ab8e61a1d17",
      "generation": null
    },
    {
      "name": "Trusted verifier (default branch)",
      "status": "completed",
      "conclusion": "success",
      "terminal": true,
      "head_sha": "c45d68b23ad742386699d88cd3100ab8e61a1d17",
      "generation": null
    }
  ],
  "reviews": [
    {
      "reviewer": "primary-codex-coordinator",
      "state": "APPROVED",
      "unresolved_threads": 0
    }
  ],
  "candidate": {
    "task_id": "issue-599-live-caller-pilot",
    "attempt_id": "a8",
    "contract_hash": "0e665f4e2c6fda7c487bd951f62891f951e57f50a981e242a41eb8f2452dfeae",
    "card_hash": "1a62460fb60f76f41d3f5fe81251bce06bce8f1b76f0f53bebe3696433c6b75d",
    "candidate_commit_sha": "c45d68b23ad742386699d88cd3100ab8e61a1d17",
    "candidate_tree_sha": "aceef56f59f76a1079ba1a418280ff78464ebc5b",
    "candidate_state_hash": "be656517d29b3fe09e03aeaa75f2fc7a96807aaf7d72f3a9294544b6299003d9",
    "verified_receipt_hash": "84d1567a426d1e1125a537f418cc0706eef9dcd7c09e49b4c67251fd627571f6",
    "independent_acceptance_hash": "044052f06154f04b9dc71aea8a648681e994c00459cc497ae53d010eddbe2986",
    "reviewer": "primary-codex-coordinator",
    "implementer": "github-contents-api"
  },
  "impact": {
    "classification": "NO_CHANGE",
    "known": true,
    "regression_free": true
  },
  "integration": null,
  "checks_passed": true,
  "reviews_resolved": true,
  "regression_free": true,
  "impact_known": true,
  "independent_acceptance": true
};

const standingGrantRequest = {
  action: "GITHUB_MERGE",
  context_hash: "7bde8299a0ad6cada31b6c82bfb4e37c0e794e836b6b5077b9012d2653fc9507",
  coordinator_id: "primary-codex-coordinator",
  goal_id: "NEXUS_ALL_ISSUES_COMPLETION_20260811",
  owner_id: "James3014",
  repository: { canonical_remote: "https://github.com/James3014/Nexus-new.git", repository_id: repo },
  requested_at: "2026-08-27T06:03:00.000000Z",
  schema: "nexus.standing_grant_request.v1",
  thread_id: "01a01061-d086-7293-bbc3-20cfce184fd4",
};

let cMerged = false;
let cReceipt: unknown = null;

async function main() {
  console.log("Starting runGitHubCompletionTool...");
  const result = await runGitHubCompletionTool(
    {
      initialEvidence,
      standingGrantRequest,
      mergeMethod: "merge",
      ownerConfirmation: true,
      maxGenerations: 3,
      maxElapsedSeconds: 2700,
    },
    {
      nexusRoot,
      pythonBin,
      transport,
      targetResolver,
      onRequiredChecksPending: async ({ headSha, generation }) => {
        if (generation !== 1 || cMerged) return;
        console.log(`onRequiredChecksPending triggered for generation ${generation}, head ${headSha}`);
        const current = await transport.getBranchRef(repo, "main");
        if (current.sha !== driftB) throw new Error(`C_HOOK_MAIN_MOVED:${current.sha}`);
        const pr = await transport.getPullRequest(repo, cPr);
        if (pr.state !== "OPEN" || pr.headRefOid !== cHead || pr.baseRefOid !== driftB) {
          throw new Error(`C_HOOK_PR_IDENTITY_MISMATCH:${pr.state}:${pr.baseRefOid}:${pr.headRefOid}`);
        }
        const checks = await evaluateRequiredChecks(transport, repo, "main", cHead);
        if (!checks.ok) throw new Error(`C_HOOK_CHECKS_NOT_GREEN:${JSON.stringify(checks)}`);
        cReceipt = await mergePullRequest(
          { prNumber: cPr, expectedBaseSha: driftB, expectedHeadSha: cHead, mergeMethod: "merge", ownerConfirmation: true },
          { cwd: nexusRoot, transport, targetResolver },
        );
        cMerged = true;
        console.error(JSON.stringify({ event: "C_MERGED_DURING_I1_PENDING", generation, i1Head: headSha, cReceipt }));
      },
    },
  );

  console.log("=== COMPLETION RESULT ===");
  console.log(JSON.stringify({ result, cMerged, cReceipt }, null, 2));
}

main().catch((err) => {
  console.error("FATAL_ERROR:", err);
  process.exit(1);
});
