import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  PR_MERGE_ERROR_CODES,
  MergePullRequestError,
  createTrustedIntegrationTargetResolver,
  defaultGitMergeTransportFactory,
  evaluateRequiredChecks,
  mergePullRequest,
  type GitHubCompletionTransport,
  type IntegrationTargetResolver,
  type MergeMethod,
} from "./git-pr-merge.js";

const execFileAsync = promisify(execFile);
const FULL_SHA = /^[0-9a-f]{40}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*[\u0000-\u001f\u007f]).+$/;
const REPOSITORY = "James3014/Nexus-new";
const DEFAULT_BRANCH = "main";
const COMPLETION_TARGET = {
  remoteName: "origin",
  repository: REPOSITORY,
  defaultBranch: DEFAULT_BRANCH,
} as const;

export interface GitHubCompletionToolInput {
  initialEvidence: Record<string, unknown>;
  standingGrantRequest: Record<string, unknown>;
  mergeMethod: MergeMethod;
  ownerConfirmation: boolean;
  maxGenerations: number;
  maxElapsedSeconds: number;
}

export interface GitHubCompletionToolOptions {
  nexusRoot: string;
  pythonBin: string;
  transport?: GitHubCompletionTransport;
  targetResolver?: IntegrationTargetResolver;
  /** Pilot/test seam only. Production proxy callers never supply this hook. */
  onRequiredChecksPending?: (context: {
    headSha: string;
    generation: number;
  }) => Promise<void>;
}

type HostCall = {
  type: "call";
  id: number;
  method: string;
  params: Record<string, unknown>;
};

type HostResult = { type: "result"; id: number; ok: true; result: unknown }
  | { type: "result"; id: number; ok: false; error: string };

type BridgeDone = { type: "done"; result: Record<string, unknown> };
type BridgeFatal = { type: "fatal"; error: string };

function normalizeSha(value: unknown, name: string): string {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

function positiveInt(value: unknown, name: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

export function isTransientRequiredChecksDecision(
  decision: Awaited<ReturnType<typeof evaluateRequiredChecks>>,
): boolean {
  return (
    decision.ok === false
    && decision.code === PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_UNKNOWN
    && decision.statuses.length > 0
    && decision.statuses.every((status) =>
      status.state === "success"
      || status.state === "pending"
      || (
        status.state === "unknown"
        && status.reason === "no check run or commit status matches the required context for the expected head SHA"
      )
    )
    && decision.statuses.some((status) => status.state === "pending" || status.state === "unknown")
  );
}

export function parseGitHubCompletionToolInput(raw: Record<string, unknown>): GitHubCompletionToolInput {
  const initialEvidence = raw.initialEvidence;
  const standingGrantRequest = raw.standingGrantRequest;
  if (!initialEvidence || typeof initialEvidence !== "object" || Array.isArray(initialEvidence)) {
    throw new Error("initialEvidence must be an object");
  }
  if (!standingGrantRequest || typeof standingGrantRequest !== "object" || Array.isArray(standingGrantRequest)) {
    throw new Error("standingGrantRequest must be an object");
  }
  const mergeMethod = raw.mergeMethod;
  if (mergeMethod !== "merge" && mergeMethod !== "squash" && mergeMethod !== "rebase") {
    throw new Error("mergeMethod must be merge, squash, or rebase");
  }
  if (raw.ownerConfirmation !== true) {
    throw new Error("ownerConfirmation must be exactly true");
  }
  const maxGenerations = raw.maxGenerations === undefined
    ? 3
    : positiveInt(raw.maxGenerations, "maxGenerations", 3);
  const maxElapsedSeconds = raw.maxElapsedSeconds === undefined
    ? 2700
    : positiveInt(raw.maxElapsedSeconds, "maxElapsedSeconds", 2700);
  return {
    initialEvidence: initialEvidence as Record<string, unknown>,
    standingGrantRequest: standingGrantRequest as Record<string, unknown>,
    mergeMethod,
    ownerConfirmation: true,
    maxGenerations,
    maxElapsedSeconds,
  };
}

async function runGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

function transportWithCompletion(
  transport: ReturnType<typeof defaultGitMergeTransportFactory>,
): GitHubCompletionTransport {
  const candidate = transport as Partial<GitHubCompletionTransport>;
  const required = [
    "getCommitObject",
    "getBlobShaAtRef",
    "compareChangedFiles",
    "getPullRequestReviewState",
    "isPlatformApprovalRequired",
  ] as const;
  for (const name of required) {
    if (typeof candidate[name] !== "function") {
      throw new Error(`COMPLETION_TRANSPORT_METHOD_MISSING:${name}`);
    }
  }
  return candidate as GitHubCompletionTransport;
}

function bridgeScriptPath(): string {
  return fileURLToPath(new URL("../scripts/github_completion_bridge.py", import.meta.url));
}

class CompletionHostPort {
  constructor(
    private readonly input: GitHubCompletionToolInput,
    private readonly options: GitHubCompletionToolOptions,
    private readonly transport: GitHubCompletionTransport,
    private readonly targetResolver: IntegrationTargetResolver,
    private readonly prNumber: number,
  ) {}

  private async target() {
    const target = await this.targetResolver.resolve(this.options.nexusRoot);
    if (
      target.repository.toLowerCase() !== REPOSITORY.toLowerCase()
      || target.defaultBranch !== DEFAULT_BRANCH
      || target.remoteName !== COMPLETION_TARGET.remoteName
    ) {
      throw new Error("COMPLETION_TRUSTED_TARGET_MISMATCH");
    }
    return target;
  }

  private async commit(sha: string) {
    const commitSha = normalizeSha(sha, "commit_sha");
    const commit = await this.transport.getCommitObject(REPOSITORY, commitSha);
    if (commit.sha !== commitSha || !FULL_SHA.test(commit.treeSha)) {
      throw new Error("COMMIT_OBJECT_IDENTITY_MISMATCH");
    }
    return commit;
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "read_main_state": {
        const ref = await this.transport.getBranchRef(REPOSITORY, DEFAULT_BRANCH);
        const sha = normalizeSha(ref.sha, "main_sha");
        const commit = await this.commit(sha);
        return { commit_sha: sha, tree_sha: commit.treeSha };
      }
      case "get_tree_sha": {
        const commit = await this.commit(normalizeSha(params.commit_sha, "commit_sha"));
        return { tree_sha: commit.treeSha };
      }
      case "read_pr_head_sha": {
        const pr = await this.transport.getPullRequest(REPOSITORY, this.prNumber);
        return { head_sha: normalizeSha(pr.headRefOid, "pr_head_sha") };
      }
      case "read_blob_sha": {
        const ref = normalizeSha(params.commit_or_tree_sha, "blob_ref_sha");
        const path = params.path;
        if (typeof path !== "string" || !SAFE_PATH.test(path)) throw new Error("BLOB_PATH_INVALID");
        const blobSha = await this.transport.getBlobShaAtRef(REPOSITORY, ref, path);
        return { blob_sha: normalizeSha(blobSha, "blob_sha") };
      }
      case "get_changed_main_paths": {
        const oldSha = normalizeSha(params.old_main_sha, "old_main_sha");
        const newSha = normalizeSha(params.new_main_sha, "new_main_sha");
        const paths = await this.transport.compareChangedFiles(REPOSITORY, oldSha, newSha);
        for (const path of paths) {
          if (!SAFE_PATH.test(path)) throw new Error("CHANGED_PATH_INVALID");
        }
        return { paths: [...new Set(paths)].sort() };
      }
      case "revalidate_affected_dimension": {
        return {
          passed: false,
          requires_fresh_candidate_acceptance: true,
          details: {
            reason: "live host binding currently automates only REUSE_UNAFFECTED drift; affected semantic/authority/test/transport dimensions fail closed for fresh acceptance",
            dimension: String(params.dimension ?? "unknown"),
          },
        };
      }
      case "materialize_integration_head":
        return await this.materialize(params);
      case "read_required_checks":
        return await this.readRequiredChecks(params);
      case "read_reviews": {
        const state = await this.transport.getPullRequestReviewState(REPOSITORY, this.prNumber);
        const initialReviews = Array.isArray(this.input.initialEvidence.reviews)
          ? this.input.initialEvidence.reviews
          : [];
        const reviews = state.reviews.length > 0
          ? state.reviews.map((review) => ({
              reviewer: review.reviewer,
              state: review.state,
              unresolved_threads: 0,
            }))
          : initialReviews;
        return {
          reviews,
          unresolved_threads: state.unresolvedThreads,
        };
      }
      case "is_platform_approval_required": {
        const required = await this.transport.isPlatformApprovalRequired(REPOSITORY, DEFAULT_BRANCH);
        return { required };
      }
      case "cas_merge":
        return await this.casMerge(params);
      case "reconcile_post_merge":
        return await this.reconcile(params);
      default:
        throw new Error(`UNKNOWN_COMPLETION_PORT_METHOD:${method}`);
    }
  }

  private async materialize(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const baseSha = normalizeSha(params.base_sha, "base_sha");
    const baseTreeSha = normalizeSha(params.base_tree_sha, "base_tree_sha");
    const expectedHead = normalizeSha(params.expected_pr_head_sha, "expected_pr_head_sha");
    const generation = positiveInt(params.generation, "generation", 3);
    const target = await this.target();
    const pr = await this.transport.getPullRequest(REPOSITORY, this.prNumber);
    if (pr.state !== "OPEN" || pr.isDraft) {
      return { success: false, conflict: false, error: "pr_not_open_or_draft" };
    }
    if (pr.baseRefName !== DEFAULT_BRANCH || pr.headRefOid !== expectedHead) {
      return { success: false, conflict: false, error: "pr_head_or_base_moved" };
    }
    if (pr.isCrossRepository === true) {
      return { success: false, conflict: false, error: "cross_repository_pr_not_supported" };
    }
    const baseCommit = await this.commit(baseSha);
    if (baseCommit.treeSha !== baseTreeSha) {
      return { success: false, conflict: false, error: "base_tree_mismatch" };
    }

    try {
      await runGit(this.options.nexusRoot, ["fetch", "--no-tags", "--quiet", target.remoteName, expectedHead]);
      await runGit(this.options.nexusRoot, ["fetch", "--no-tags", "--quiet", target.remoteName, baseSha]);
      const treeOutput = await runGit(
        this.options.nexusRoot,
        ["merge-tree", "--write-tree", expectedHead, baseSha],
      );
      const integrationTree = normalizeSha(treeOutput.split(/\s+/)[0], "integration_tree_sha");
      const now = new Date().toISOString();
      const integrationHead = normalizeSha(
        await runGit(
          this.options.nexusRoot,
          [
            "commit-tree",
            integrationTree,
            "-p",
            expectedHead,
            "-p",
            baseSha,
            "-m",
            `Nexus completion integration generation I${generation}`,
          ],
          {
            GIT_AUTHOR_NAME: "Nexus Completion Host",
            GIT_AUTHOR_EMAIL: "nexus-completion@localhost",
            GIT_COMMITTER_NAME: "Nexus Completion Host",
            GIT_COMMITTER_EMAIL: "nexus-completion@localhost",
            GIT_AUTHOR_DATE: now,
            GIT_COMMITTER_DATE: now,
          },
        ),
        "integration_head_sha",
      );
      if (!pr.headRefName) throw new Error("PR_HEAD_BRANCH_MISSING");
      await runGit(this.options.nexusRoot, ["check-ref-format", "--branch", pr.headRefName]);
      await runGit(
        this.options.nexusRoot,
        ["push", "--porcelain", target.remoteName, `${integrationHead}:refs/heads/${pr.headRefName}`],
      );
      let observedPr = await this.transport.getPullRequest(REPOSITORY, this.prNumber);
      const readbackDeadline = Date.now() + 15_000;
      while (observedPr.headRefOid !== integrationHead) {
        if (observedPr.headRefOid !== expectedHead) {
          throw new Error(`PR_HEAD_READBACK_FOREIGN_MUTATION:${observedPr.headRefOid}`);
        }
        if (Date.now() >= readbackDeadline) {
          throw new Error(`PR_HEAD_READBACK_TIMEOUT:${observedPr.headRefOid}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        observedPr = await this.transport.getPullRequest(REPOSITORY, this.prNumber);
      }
      const observedCommit = await this.commit(integrationHead);
      if (observedCommit.treeSha !== integrationTree) {
        throw new Error("INTEGRATION_TREE_READBACK_MISMATCH");
      }
      return {
        schema: "nexus.integration_materialization_result.v1",
        success: true,
        integration_head_sha: integrationHead,
        integration_tree_sha: integrationTree,
        conflict: false,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const conflict = /CONFLICT|conflict|non-fast-forward|fetch first|rejected/i.test(message);
      return {
        schema: "nexus.integration_materialization_result.v1",
        success: false,
        integration_head_sha: null,
        integration_tree_sha: null,
        conflict,
        error: message.slice(0, 600),
      };
    }
  }

  private async readRequiredChecks(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const headSha = normalizeSha(params.head_sha, "checks_head_sha");
    const generation = positiveInt(params.generation, "generation", 3);
    const timeoutSeconds = typeof params.timeout_seconds === "number"
      ? Math.max(0, Math.min(params.timeout_seconds, 2700))
      : 2700;
    const deadline = Date.now() + timeoutSeconds * 1000;
    let pendingHookFired = false;
    for (;;) {
      const decision = await evaluateRequiredChecks(this.transport, REPOSITORY, DEFAULT_BRANCH, headSha);
      if (decision.ok) {
        const checks = decision.statuses.map((status) => ({
          name: status.context,
          status: "completed",
          conclusion: "success",
          terminal: true,
          head_sha: headSha,
          generation,
        }));
        if (checks.length === 0) throw new Error("REQUIRED_CHECKS_EMPTY");
        return { checks };
      }
      const transientMissingCheck = isTransientRequiredChecksDecision(decision);
      if (
        decision.code !== PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_PENDING
        && !transientMissingCheck
      ) {
        throw new Error(`${decision.code}:${decision.message}`);
      }
      if (!pendingHookFired && this.options.onRequiredChecksPending) {
        pendingHookFired = true;
        await this.options.onRequiredChecksPending({ headSha, generation });
      }
      if (Date.now() >= deadline) throw new Error("REQUIRED_CHECKS_TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, Math.min(3000, Math.max(100, deadline - Date.now()))));
    }
  }

  private async casMerge(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const expectedBaseSha = normalizeSha(params.expected_base_sha, "expected_base_sha");
    const expectedHeadSha = normalizeSha(params.expected_head_sha, "expected_head_sha");
    try {
      const receipt = await mergePullRequest(
        {
          prNumber: this.prNumber,
          expectedBaseSha,
          expectedHeadSha,
          mergeMethod: this.input.mergeMethod,
          ownerConfirmation: this.input.ownerConfirmation,
        },
        {
          cwd: this.options.nexusRoot,
          transport: this.transport,
          targetResolver: this.targetResolver,
        },
      );
      return { status: "SUCCESS", merged_sha: receipt.merge_commit_sha ?? receipt.new_main_sha, reason: null };
    } catch (error) {
      if (error instanceof MergePullRequestError) {
        if (error.code === PR_MERGE_ERROR_CODES.EXPECTED_BASE_MISMATCH) {
          return { status: "BASE_MOVED", merged_sha: null, reason: error.message };
        }
        if (error.code === PR_MERGE_ERROR_CODES.EXPECTED_HEAD_MISMATCH) {
          return { status: "HEAD_MISMATCH", merged_sha: null, reason: error.message };
        }
        if (error.code === PR_MERGE_ERROR_CODES.POST_MERGE_VERIFICATION_FAILED) {
          return { status: "AMBIGUOUS_ACK", merged_sha: null, reason: error.message };
        }
        if (
          error.code === PR_MERGE_ERROR_CODES.TRANSPORT_AVAILABILITY_FAILURE
          && /during merge/i.test(error.message)
        ) {
          return { status: "AMBIGUOUS_ACK", merged_sha: null, reason: error.message };
        }
        if (error.code === PR_MERGE_ERROR_CODES.PR_NOT_MERGEABLE) {
          return { status: "CONFLICT", merged_sha: null, reason: error.message };
        }
        return { status: "REJECTED", merged_sha: null, reason: `${error.code}:${error.message}` };
      }
      return { status: "REJECTED", merged_sha: null, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async reconcile(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const expectedBaseSha = normalizeSha(params.expected_base_sha, "expected_base_sha");
    const expectedHeadSha = normalizeSha(params.expected_head_sha, "expected_head_sha");
    const main = await this.transport.getBranchRef(REPOSITORY, DEFAULT_BRANCH);
    const mainSha = normalizeSha(main.sha, "observed_main_sha");
    const commit = await this.commit(mainSha);
    const pr = await this.transport.getPullRequest(REPOSITORY, this.prNumber);
    if (!pr.merged || pr.headRefOid !== expectedHeadSha) {
      throw new Error("POST_MERGE_PR_IDENTITY_MISMATCH");
    }
    if (!commit.parentShas.includes(expectedBaseSha) || !commit.parentShas.includes(expectedHeadSha)) {
      throw new Error("POST_MERGE_PARENT_LINEAGE_MISMATCH");
    }
    return {
      schema: "nexus.post_merge_reconciliation_result.v1",
      observed_main_commit_sha: mainSha,
      observed_main_tree_sha: commit.treeSha,
      observed_parent_shas: commit.parentShas,
      details: { pr_number: this.prNumber, repository: REPOSITORY },
    };
  }
}

export async function runGitHubCompletionTool(
  rawInput: Record<string, unknown>,
  options: GitHubCompletionToolOptions,
): Promise<Record<string, unknown>> {
  const input = parseGitHubCompletionToolInput(rawInput);
  const evidencePr = input.initialEvidence.pull_request_number;
  const evidenceRepo = input.initialEvidence.repository;
  if (evidenceRepo !== REPOSITORY) throw new Error("INITIAL_EVIDENCE_REPOSITORY_MISMATCH");
  const prNumber = positiveInt(evidencePr, "pull_request_number", Number.MAX_SAFE_INTEGER);
  const transport = options.transport ?? transportWithCompletion(defaultGitMergeTransportFactory());
  const targetResolver = options.targetResolver ?? createTrustedIntegrationTargetResolver([COMPLETION_TARGET]);
  await targetResolver.resolve(options.nexusRoot);

  const child = spawn(options.pythonBin, [bridgeScriptPath()], {
    cwd: options.nexusRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  const port = new CompletionHostPort(input, options, transport, targetResolver, prNumber);
  const lines = createInterface({ input: child.stdout });
  let done: Record<string, unknown> | undefined;
  let fatal: string | undefined;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
  });

  const processing = new Set<Promise<void>>();
  lines.on("line", (line) => {
    const task = (async () => {
      let message: HostCall | BridgeDone | BridgeFatal;
      try {
        message = JSON.parse(line) as HostCall | BridgeDone | BridgeFatal;
      } catch {
        fatal = `BRIDGE_NON_JSON_OUTPUT:${line.slice(0, 300)}`;
        return;
      }
      if (message.type === "done") {
        done = message.result;
        return;
      }
      if (message.type === "fatal") {
        fatal = message.error;
        return;
      }
      if (message.type !== "call") return;
      let response: HostResult;
      try {
        const result = await port.call(message.method, message.params ?? {});
        response = { type: "result", id: message.id, ok: true, result };
      } catch (error) {
        response = {
          type: "result",
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      child.stdin.write(`${JSON.stringify(response)}\n`);
    })();
    processing.add(task);
    void task.finally(() => processing.delete(task));
  });

  child.stdin.write(`${JSON.stringify({
    type: "start",
    nexus_root: options.nexusRoot,
    initial_evidence: input.initialEvidence,
    standing_grant_request: input.standingGrantRequest,
    max_generations: input.maxGenerations,
    max_elapsed_seconds: input.maxElapsedSeconds,
  })}\n`);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  await Promise.allSettled([...processing]);
  lines.close();
  if (fatal) throw new Error(`COMPLETION_BRIDGE_FATAL:${fatal}`);
  if (exitCode !== 0 || !done) {
    throw new Error(`COMPLETION_BRIDGE_EXIT:${exitCode}:${stderr.trim().slice(-1000)}`);
  }
  return done;
}
