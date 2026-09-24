import { execFile } from "node:child_process";

/**
 * Narrow protected GitHub PR integration action: `git_merge_pull_request`.
 *
 * This is a bounded fallback used only when the primary GitHub connector is
 * unavailable. It merges ONE exact, independently accepted PR head into the
 * repository default branch, with native exact-head CAS and independent
 * required-check verification. It is intentionally NOT a generic git merge /
 * push primitive and never accepts a caller-supplied shell string, refspec,
 * remote URL, or target branch.
 *
 * Security model:
 *  - the integration target is resolved by a server-controlled trusted
 *    resolver (never caller-chosen remote/repo/branch/URL and never an
 *    implicit "origin == collaboration repository" assumption).
 *  - every required state is re-read fresh before the merge (no trusting
 *    caller-passed state).
 *  - the merge request uses GitHub's native `sha` CAS: if the PR head moved,
 *    GitHub rejects it (409) and we never retry a changed head.
 *  - required status checks are verified independently from classic branch
 *    protection and the GitHub effective branch rules (`rules/branches/{b}`);
 *    an unreadable or ambiguous rules answer fails closed.
 *  - required-check evidence is bound to the exact expected head SHA and the
 *    required app/integration identity (check runs + commit statuses).
 *  - the GitHub CLI is invoked with `execFile` (argv only, never a shell) and
 *    only typed, validated arguments.
 */

const execFileAsync = execFile;

type McpContent = { type: "text"; text: string };

export interface ToolResult {
  content: McpContent[];
  isError?: boolean;
}

/** Deterministic error codes for the git_merge_pull_request action. */
export const PR_MERGE_ERROR_CODES = {
  INVALID_INPUT: "INVALID_INPUT",
  OWNER_CONFIRMATION_REQUIRED: "OWNER_CONFIRMATION_REQUIRED",
  WORKSPACE_NOT_GIT_REPOSITORY: "WORKSPACE_NOT_GIT_REPOSITORY",
  REMOTE_NOT_FOUND: "REMOTE_NOT_FOUND",
  REMOTE_NOT_GITHUB: "REMOTE_NOT_GITHUB",
  INTEGRATION_TARGET_UNRESOLVED: "INTEGRATION_TARGET_UNRESOLVED",
  REPOSITORY_IDENTITY_MISMATCH: "REPOSITORY_IDENTITY_MISMATCH",
  DEFAULT_BRANCH_MISMATCH: "DEFAULT_BRANCH_MISMATCH",
  PR_NOT_FOUND: "PR_NOT_FOUND",
  PR_NOT_OPEN: "PR_NOT_OPEN",
  PR_IS_DRAFT: "PR_IS_DRAFT",
  PR_BASE_MISMATCH: "PR_BASE_MISMATCH",
  EXPECTED_HEAD_MISMATCH: "EXPECTED_HEAD_MISMATCH",
  EXPECTED_BASE_MISMATCH: "EXPECTED_BASE_MISMATCH",
  PR_NOT_MERGEABLE: "PR_NOT_MERGEABLE",
  REQUIRED_CHECKS_PENDING: "REQUIRED_CHECKS_PENDING",
  REQUIRED_CHECKS_FAILED: "REQUIRED_CHECKS_FAILED",
  REQUIRED_CHECKS_UNKNOWN: "REQUIRED_CHECKS_UNKNOWN",
  MERGE_LANE_NOT_AUTHORIZED: "MERGE_LANE_NOT_AUTHORIZED",
  AUTHORIZATION_FAILURE: "AUTHORIZATION_FAILURE",
  TRANSPORT_AVAILABILITY_FAILURE: "TRANSPORT_AVAILABILITY_FAILURE",
  MERGE_REJECTED: "MERGE_REJECTED",
  POST_MERGE_VERIFICATION_FAILED: "POST_MERGE_VERIFICATION_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type PrMergeErrorCode =
  (typeof PR_MERGE_ERROR_CODES)[keyof typeof PR_MERGE_ERROR_CODES];

export class MergePullRequestError extends Error {
  constructor(
    readonly code: PrMergeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MergePullRequestError";
  }
}

export type TransportErrorKind = "http" | "auth" | "availability";

export class TransportError extends Error {
  constructor(
    readonly kind: TransportErrorKind,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPO_PART = /^[A-Za-z0-9_.-]+$/;

export type MergeMethod = "merge" | "squash" | "rebase";

export interface GitMergePullRequestInput {
  prNumber: number;
  expectedBaseSha: string;
  expectedHeadSha: string;
  mergeMethod: MergeMethod;
  ownerConfirmation: boolean;
}

/**
 * Strict, typed parsing of caller input. Only the documented keys are read;
 * any other key (refspec, force, remote, branch, shell suffix, ...) is
 * structurally ignored and can never influence the action.
 */
export function parseMergePullRequestInput(
  raw: Record<string, unknown>,
): GitMergePullRequestInput {
  const prNumber = raw.prNumber;
  if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber < 1) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.INVALID_INPUT,
      "prNumber must be a positive integer",
    );
  }

  const expectedBaseSha = normalizeSha(raw.expectedBaseSha, "expectedBaseSha");
  const expectedHeadSha = normalizeSha(raw.expectedHeadSha, "expectedHeadSha");

  const method = raw.mergeMethod;
  if (method !== "merge" && method !== "squash" && method !== "rebase") {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.INVALID_INPUT,
      "mergeMethod must be one of: merge, squash, rebase",
    );
  }

  const confirmation = raw.ownerConfirmation;
  if (confirmation !== undefined && typeof confirmation !== "boolean") {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.INVALID_INPUT,
      "ownerConfirmation must be a boolean",
    );
  }

  return {
    prNumber,
    expectedBaseSha,
    expectedHeadSha,
    mergeMethod: method,
    ownerConfirmation: confirmation === true,
  };
}

function normalizeSha(value: unknown, name: string): string {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.INVALID_INPUT,
      `${name} must be an exact full 40-character lowercase hex commit SHA`,
    );
  }
  return value.toLowerCase();
}

function isValidRepoPart(part: string): boolean {
  return REPO_PART.test(part) && !part.startsWith(".") && !part.includes("..");
}

/**
 * Parse a github.com remote URL into { owner, name }. Only github.com remotes
 * are accepted; any other host (gitlab, bitbucket, self-hosted) is rejected so
 * the merge can never target an arbitrary external repository.
 */
export function parseGitHubRemote(remoteUrl: string): { owner: string; name: string } | null {
  const url = remoteUrl.trim().replace(/\.git\/?$/, "");
  if (!url) return null;

  const patterns = [
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/,
    /^(?:git|ssh):\/\/git@github\.com\/([^/\s]+)\/([^/\s]+)$/,
    /^git@github\.com:([^/\s]+)\/([^/\s]+)$/,
    /^git@github\.com\/([^/\s]+)\/([^/\s]+)$/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (!match) continue;
    const owner = match[1];
    const name = match[2];
    if (!isValidRepoPart(owner) || !isValidRepoPart(name)) return null;
    return { owner, name };
  }

  return null;
}

/** Strip credentials (e.g. embedded tokens) from a remote URL for receipts. */
export function sanitizeRemoteUrl(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

// --- trusted integration-target resolution -----------------------------------

/**
 * Server-controlled identity of the collaboration repository a workspace is
 * expected to integrate into. Callers can never select or override any of
 * these fields.
 */
export interface TrustedIntegrationTarget {
  /** git remote name that must exist in the workspace. */
  remoteName: string;
  /** GitHub `owner/name` repository the remote must point at. */
  repository: string;
  /** Branch the merge action is allowed to update. */
  defaultBranch: string;
}

/** Resolved integration target derived from a workspace's git remotes. */
export interface IntegrationTarget {
  remoteName: string;
  repository: string;
  remoteUrl: string;
  defaultBranch: string;
}

/** A remote observed in the workspace: name + URL. */
export interface GitRemoteInfo {
  name: string;
  url: string;
}

export type ListRemotesFn = (gitRoot: string) => Promise<GitRemoteInfo[]>;

async function defaultListRemotes(gitRoot: string): Promise<GitRemoteInfo[]> {
  const namesOut = await runGit(gitRoot, ["remote"]);
  const names = namesOut.trim() ? namesOut.trim().split(/\s+/) : [];
  const remotes: GitRemoteInfo[] = [];
  for (const name of names) {
    const url = (await runGit(gitRoot, ["remote", "get-url", name])).trim();
    remotes.push({ name, url });
  }
  return remotes;
}

/**
 * Narrow server-controlled resolver: a workspace resolves to an integration
 * target only when a git remote exists whose name AND github.com URL exactly
 * match a trusted target. `origin` is never implied to be the collaboration
 * repository; if no unique trusted target can be determined the resolver fails
 * closed with {@link PR_MERGE_ERROR_CODES.INTEGRATION_TARGET_UNRESOLVED}.
 */
export function createTrustedIntegrationTargetResolver(
  trustedTargets: TrustedIntegrationTarget[],
  listRemotes: ListRemotesFn = defaultListRemotes,
): IntegrationTargetResolver {
  return {
    async resolve(gitRoot: string): Promise<IntegrationTarget> {
      let remotes: GitRemoteInfo[];
      try {
        remotes = await listRemotes(gitRoot);
      } catch {
        throw new MergePullRequestError(
          PR_MERGE_ERROR_CODES.INTEGRATION_TARGET_UNRESOLVED,
          "workspace git remotes could not be enumerated to resolve a trusted integration target",
        );
      }

      const matches: IntegrationTarget[] = [];
      for (const trusted of trustedTargets) {
        for (const remote of remotes) {
          if (remote.name !== trusted.remoteName) continue;
          const parsed = parseGitHubRemote(remote.url);
          if (!parsed) continue;
          if (`${parsed.owner}/${parsed.name}`.toLowerCase() !== trusted.repository.toLowerCase()) continue;
          matches.push({
            remoteName: remote.name,
            repository: trusted.repository,
            remoteUrl: remote.url,
            defaultBranch: trusted.defaultBranch,
          });
        }
      }

      if (matches.length !== 1) {
        throw new MergePullRequestError(
          PR_MERGE_ERROR_CODES.INTEGRATION_TARGET_UNRESOLVED,
          `no unique trusted integration target resolvable (${matches.length} candidate(s) matched ${trustedTargets.length} trusted target(s)); refusing to infer a collaboration repository`,
        );
      }
      return matches[0];
    },
  };
}

export interface IntegrationTargetResolver {
  resolve(gitRoot: string): Promise<IntegrationTarget>;
}

/**
 * The trusted collaboration target for the Nexus workspace. The Nexus
 * workspace observes both `origin` (James3014/Nexus) and `nexus-new`
 * (James3014/Nexus-new); only `nexus-new` is the collaboration integration
 * target, and only this resolver may establish that.
 */
export const NEXUS_TRUSTED_INTEGRATION_TARGET: TrustedIntegrationTarget = {
  remoteName: "nexus-new",
  repository: "James3014/Nexus-new",
  defaultBranch: "main",
};

export function createNexusIntegrationTargetResolver(): IntegrationTargetResolver {
  return createTrustedIntegrationTargetResolver([NEXUS_TRUSTED_INTEGRATION_TARGET]);
}

/** Default production integration-target resolver (server-controlled). */
export function defaultIntegrationTargetResolver(): IntegrationTargetResolver {
  return createNexusIntegrationTargetResolver();
}

// --- GitHub transport abstraction -------------------------------------------

export interface RepositoryView {
  default_branch: string;
  full_name: string;
}

export interface PullRequestView {
  number: number;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository?: boolean;
  mergeable: string;
  mergeStateStatus: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitOid: string | null;
  title: string;
  url: string;
  body?: string;
}

export interface BranchRefView {
  sha: string;
}

export interface CheckRunView {
  name: string;
  status: string | null;
  conclusion: string | null;
  appId: number | null;
  appSlug: string | null;
}

/** A required status check bound to a context (and optionally an App/integration). */
export interface RequiredCheckRequirement {
  context: string;
  integrationId: number | null;
}

export interface BranchProtectionView {
  /** True when a definitive answer was obtained (200 or 404). */
  determined: boolean;
  /** Required status check requirements declared by classic branch protection. */
  requirements: RequiredCheckRequirement[];
}

export interface EffectiveRulesView {
  /** True when a definitive answer was obtained from the effective-rules endpoint. */
  determined: boolean;
  /** Required status check requirements declared by the effective branch rules. */
  requirements: RequiredCheckRequirement[];
}

/** A commit status (context + state) bound to one exact commit SHA. */
export interface CommitStatusEvidence {
  context: string;
  state: string;
}

export interface MergeResultView {
  merged: boolean;
  sha: string | null;
  message: string | null;
}

export interface CommitObjectView {
  sha: string;
  treeSha: string;
  parentShas: string[];
}

export interface PullRequestReviewState {
  reviews: Array<{ reviewer: string; state: string }>;
  unresolvedThreads: number;
}

/** Extra read-only observations required by the #599 completion host binding. */
export interface GitHubCompletionTransport extends GitHubPullRequestTransport {
  getCommitObject(repo: string, commitSha: string): Promise<CommitObjectView>;
  getBlobShaAtRef(repo: string, refSha: string, path: string): Promise<string>;
  compareChangedFiles(repo: string, oldSha: string, newSha: string): Promise<string[]>;
  getPullRequestReviewState(repo: string, prNumber: number): Promise<PullRequestReviewState>;
  isPlatformApprovalRequired(repo: string, branch: string): Promise<boolean>;
}

/**
 * Narrow GitHub transport abstraction used by the core action. Core logic never
 * touches `gh`/`git` directly; it only talks to this interface so TOCTOU and
 * failure paths are deterministic to test.
 *
 * Production: {@link GhCliGitHubTransport} (execFile + fixed argv over `gh`).
 * Tests: `FakeGitHubTransport`.
 */
export interface GitHubPullRequestTransport {
  getRepository(repo: string): Promise<RepositoryView>;
  getPullRequest(repo: string, prNumber: number): Promise<PullRequestView>;
  getBranchRef(repo: string, branch: string): Promise<BranchRefView>;
  getBranchProtection(repo: string, branch: string): Promise<BranchProtectionView>;
  getEffectiveRules(repo: string, branch: string): Promise<EffectiveRulesView>;
  getCheckRuns(repo: string, headSha: string): Promise<CheckRunView[]>;
  getCommitStatus(repo: string, headSha: string): Promise<CommitStatusEvidence[]>;
  mergePullRequest(
    repo: string,
    prNumber: number,
    method: MergeMethod,
    expectedHeadSha: string,
  ): Promise<MergeResultView>;
}

/**
 * Real GitHub transport backed by the local `gh` CLI. Every invocation uses
 * `execFile` with a fixed argv array and an explicitly typed, validated
 * argument list. No shell, no command-string concatenation, no caller-supplied
 * suffix, no arbitrary CLI options.
 */
export type GhExecFn = (
  args: string[],
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

function defaultGhExec(
  args: string[],
  callback: (error: Error | null, stdout: string, stderr: string) => void,
): void {
  execFileAsync(
    "gh",
    args,
    { env: { ...process.env, GH_PROMPT_DISABLED: "1" }, maxBuffer: 10 * 1024 * 1024 },
    callback,
  );
}

export class GhCliGitHubTransport implements GitHubCompletionTransport {
  constructor(private readonly run: GhExecFn = defaultGhExec) {}

  private gh(args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.run(args, (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const err = error as NodeJS.ErrnoException & { code?: number | string };
        if (err.code === "ENOENT") {
          reject(
            new TransportError(
              "availability",
              0,
              "the gh CLI is not installed or not on PATH",
            ),
          );
          return;
        }
        const combined = `${stderr}\n${stdout}`.trim();
        if (Number(err.code) === 4 || /gh auth login/i.test(combined)) {
          reject(new TransportError("auth", 0, "the gh CLI is not authenticated"));
          return;
        }
        const httpMatch = /HTTP\s+(\d{3})/.exec(combined);
        if (httpMatch) {
          const status = Number(httpMatch[1]);
          const parsed = tryParseJson(stdout);
          const message =
            parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string"
              ? (parsed as { message: string }).message
              : combined;
          reject(new TransportError("http", status, message));
          return;
        }
        reject(
          new TransportError("availability", 0, combined || String(err.message)),
        );
      });
    });
  }

  private async apiJson(args: string[]): Promise<Record<string, unknown> | unknown[] | null> {
    const stdout = await this.gh(args);
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed) as Record<string, unknown> | unknown[];
  }

  async getRepository(repo: string): Promise<RepositoryView> {
    const body = await this.apiJson(["api", `repos/${repo}`]);
    const record = body && !Array.isArray(body) ? body : {};
    return {
      default_branch: typeof record.default_branch === "string" ? record.default_branch : "",
      full_name: typeof record.full_name === "string" ? record.full_name : "",
    };
  }

  async getPullRequest(repo: string, prNumber: number): Promise<PullRequestView> {
    const fields = [
      "number",
      "state",
      "isDraft",
      "baseRefName",
      "baseRefOid",
      "headRefName",
      "headRefOid",
      "isCrossRepository",
      "mergeable",
      "mergeStateStatus",
      "mergedAt",
      "mergeCommit",
      "title",
      "url",
      "body",
    ].join(",");
    let stdout: string;
    try {
      stdout = await this.gh([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        fields,
      ]);
    } catch (e) {
      // `gh pr view` reports a missing PR without an HTTP status marker.
      // Normalize it to a 404 so the caller maps it to PR_NOT_FOUND.
      if (
        e instanceof TransportError &&
        e.kind === "availability" &&
        /could not resolve to a pullrequest|could not find pull request|not found/i.test(e.message)
      ) {
        throw new TransportError("http", 404, `pull request #${prNumber} not found in ${repo}`);
      }
      throw e;
    }
    const p = JSON.parse(stdout) as Record<string, unknown>;
    const mergeCommit =
      p.mergeCommit && typeof p.mergeCommit === "object"
        ? (p.mergeCommit as { oid?: unknown })
        : null;
    const mergedAt = typeof p.mergedAt === "string" ? p.mergedAt : null;
    return {
      number: Number(p.number ?? prNumber),
      state: String(p.state ?? "UNKNOWN"),
      isDraft: p.isDraft === true,
      baseRefName: String(p.baseRefName ?? ""),
      baseRefOid: String(p.baseRefOid ?? ""),
      headRefName: String(p.headRefName ?? ""),
      headRefOid: String(p.headRefOid ?? ""),
      isCrossRepository: p.isCrossRepository === true,
      mergeable: String(p.mergeable ?? "UNKNOWN"),
      mergeStateStatus: String(p.mergeStateStatus ?? "UNKNOWN"),
      merged: p.state === "MERGED" || mergedAt !== null,
      mergedAt,
      mergeCommitOid: mergeCommit && typeof mergeCommit.oid === "string" ? mergeCommit.oid : null,
      title: String(p.title ?? ""),
      url: String(p.url ?? ""),
      body: String(p.body ?? ""),
    };
  }

  async getBranchRef(repo: string, branch: string): Promise<BranchRefView> {
    const body = await this.apiJson([
      "api",
      `repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    ]);
    const record = body && !Array.isArray(body) ? body : {};
    const object = record.object && typeof record.object === "object"
      ? (record.object as { sha?: unknown })
      : null;
    return { sha: object && typeof object.sha === "string" ? object.sha : "" };
  }

  async getBranchProtection(repo: string, branch: string): Promise<BranchProtectionView> {
    const requirements: RequiredCheckRequirement[] = [];
    try {
      const body = await this.apiJson([
        "api",
        `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`,
      ]);
      const record = body && !Array.isArray(body) ? body : {};
      const rsc = record.required_status_checks;
      if (rsc && typeof rsc === "object") {
        const checks = rsc as { contexts?: unknown; checks?: unknown };
        // contexts: string[] — no app binding.
        if (Array.isArray(checks.contexts)) {
          for (const c of checks.contexts) {
            if (typeof c === "string") {
              requirements.push({ context: c, integrationId: null });
            }
          }
        }
        // checks: [{ context, app_id }] — app binding preserved.
        if (Array.isArray(checks.checks)) {
          for (const c of checks.checks) {
            if (!c || typeof c !== "object") continue;
            const entry = c as { context?: unknown; app_id?: unknown };
            if (typeof entry.context === "string") {
              requirements.push({
                context: entry.context,
                integrationId: typeof entry.app_id === "number" ? entry.app_id : null,
              });
            }
          }
        }
      }
      return { determined: true, requirements };
    } catch (e) {
      if (e instanceof TransportError && e.kind === "http" && e.status === 404) {
        // 404 → no classic branch protection configured (a definitive answer).
        return { determined: true, requirements: [] };
      }
      // Branch protection exists but cannot be read → fail closed upstream.
      return { determined: false, requirements: [] };
    }
  }

  /**
   * GitHub effective branch rules: `GET /repos/{owner}/{repo}/rules/branches/{branch}`.
   *
   * This is the authoritative endpoint for the rules that actually apply to a
   * branch. The legacy `rulesets/branches/{branch}` endpoint (plural
   * "rulesets") is NOT a valid effective-rules endpoint and must never be
   * interpreted as evidence of "no required rules". A non-2xx (including 404)
   * from this endpoint is treated as an unreadable/unknown answer, never as an
   * empty rules set → the caller fails closed with REQUIRED_CHECKS_UNKNOWN.
   */
  async getEffectiveRules(repo: string, branch: string): Promise<EffectiveRulesView> {
    const requirements: RequiredCheckRequirement[] = [];
    try {
      const body = await this.apiJson([
        "api",
        `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`,
      ]);
      if (!Array.isArray(body)) {
        // Malformed / unexpected response shape → not a definitive answer.
        return { determined: false, requirements: [] };
      }
      for (const rule of body) {
        if (!rule || typeof rule !== "object") continue;
        const r = rule as { type?: unknown; parameters?: unknown };
        if (r.type !== "required_status_checks") continue;
        const parameters =
          r.parameters && typeof r.parameters === "object"
            ? (r.parameters as { required_status_checks?: unknown })
            : null;
        const required = parameters?.required_status_checks;
        if (!Array.isArray(required)) continue;
        for (const item of required) {
          if (!item || typeof item !== "object") continue;
          const entry = item as { context?: unknown; integration_id?: unknown };
          if (typeof entry.context === "string") {
            requirements.push({
              context: entry.context,
              integrationId: typeof entry.integration_id === "number" ? entry.integration_id : null,
            });
          }
        }
      }
      return { determined: true, requirements };
    } catch {
      // Any non-2xx (403 permission-limited, 404 unsupported/unknown, 5xx,
      // malformed) is NOT an authoritative "no rules" answer → fail closed.
      return { determined: false, requirements: [] };
    }
  }

  async getCheckRuns(repo: string, headSha: string): Promise<CheckRunView[]> {
    const body = await this.apiJson([
      "api",
      `repos/${repo}/commits/${headSha}/check-runs`,
    ]);
    const runs = body && !Array.isArray(body) ? (body as { check_runs?: unknown }).check_runs : [];
    if (!Array.isArray(runs)) return [];
    return runs.map((run) => {
      if (!run || typeof run !== "object") {
        return { name: "", status: null, conclusion: null, appId: null, appSlug: null };
      }
      const r = run as { name?: unknown; status?: unknown; conclusion?: unknown; app?: unknown };
      const app = r.app && typeof r.app === "object" ? (r.app as { id?: unknown; slug?: unknown }) : null;
      return {
        name: typeof r.name === "string" ? r.name : "",
        status: typeof r.status === "string" ? r.status : null,
        conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
        appId: app && typeof app.id === "number" ? app.id : null,
        appSlug: app && typeof app.slug === "string" ? app.slug : null,
      };
    });
  }

  async getCommitStatus(repo: string, headSha: string): Promise<CommitStatusEvidence[]> {
    const body = await this.apiJson([
      "api",
      `repos/${repo}/commits/${headSha}/status`,
    ]);
    const record = body && !Array.isArray(body) ? body : {};
    const statuses = (record as { statuses?: unknown }).statuses;
    if (!Array.isArray(statuses)) return [];
    return statuses
      .map((s) => {
        if (!s || typeof s !== "object") return null;
        const entry = s as { context?: unknown; state?: unknown };
        if (typeof entry.context !== "string" || typeof entry.state !== "string") return null;
        return { context: entry.context, state: entry.state };
      })
      .filter((s): s is CommitStatusEvidence => s !== null);
  }

  async getCommitObject(repo: string, commitSha: string): Promise<CommitObjectView> {
    const body = await this.apiJson(["api", `repos/${repo}/git/commits/${commitSha}`]);
    const record = body && !Array.isArray(body) ? body : {};
    const tree = record.tree && typeof record.tree === "object"
      ? (record.tree as { sha?: unknown })
      : null;
    const parents = Array.isArray(record.parents) ? record.parents : [];
    return {
      sha: typeof record.sha === "string" ? record.sha : "",
      treeSha: tree && typeof tree.sha === "string" ? tree.sha : "",
      parentShas: parents
        .map((parent) => parent && typeof parent === "object" ? (parent as { sha?: unknown }).sha : undefined)
        .filter((sha): sha is string => typeof sha === "string"),
    };
  }

  async getBlobShaAtRef(repo: string, refSha: string, path: string): Promise<string> {
    const encodedPath = path.split("/").map((part) => encodeURIComponent(part)).join("/");
    const body = await this.apiJson([
      "api",
      "--method",
      "GET",
      `repos/${repo}/contents/${encodedPath}`,
      "-f",
      `ref=${refSha}`,
    ]);
    const record = body && !Array.isArray(body) ? body : {};
    return typeof record.sha === "string" ? record.sha : "";
  }

  async compareChangedFiles(repo: string, oldSha: string, newSha: string): Promise<string[]> {
    const body = await this.apiJson(["api", `repos/${repo}/compare/${oldSha}...${newSha}`]);
    const record = body && !Array.isArray(body) ? body : {};
    const files = Array.isArray(record.files) ? record.files : [];
    return files
      .map((file) => file && typeof file === "object" ? (file as { filename?: unknown }).filename : undefined)
      .filter((name): name is string => typeof name === "string" && name.length > 0);
  }

  async getPullRequestReviewState(repo: string, prNumber: number): Promise<PullRequestReviewState> {
    const [owner, name] = repo.split("/", 2);
    const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}} reviews(first:100){nodes{author{login} state submittedAt}}}}}`;
    const body = await this.apiJson([
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${prNumber}`,
    ]);
    const repository = body && !Array.isArray(body) && body.data && typeof body.data === "object"
      ? (body.data as { repository?: unknown }).repository
      : undefined;
    const pullRequest = repository && typeof repository === "object"
      ? (repository as { pullRequest?: unknown }).pullRequest
      : undefined;
    const pr = pullRequest && typeof pullRequest === "object" ? pullRequest as Record<string, unknown> : {};
    const reviewThreads = pr.reviewThreads && typeof pr.reviewThreads === "object"
      ? (pr.reviewThreads as { nodes?: unknown }).nodes
      : [];
    const reviewNodes = pr.reviews && typeof pr.reviews === "object"
      ? (pr.reviews as { nodes?: unknown }).nodes
      : [];
    const latest = new Map<string, { reviewer: string; state: string; submittedAt: string }>();
    if (Array.isArray(reviewNodes)) {
      for (const node of reviewNodes) {
        if (!node || typeof node !== "object") continue;
        const review = node as { author?: unknown; state?: unknown; submittedAt?: unknown };
        const author = review.author && typeof review.author === "object"
          ? (review.author as { login?: unknown }).login
          : undefined;
        if (typeof author !== "string" || typeof review.state !== "string") continue;
        const submittedAt = typeof review.submittedAt === "string" ? review.submittedAt : "";
        const existing = latest.get(author);
        if (!existing || submittedAt >= existing.submittedAt) {
          latest.set(author, { reviewer: author, state: review.state, submittedAt });
        }
      }
    }
    const unresolvedThreads = Array.isArray(reviewThreads)
      ? reviewThreads.filter((node) => node && typeof node === "object" && (node as { isResolved?: unknown }).isResolved !== true).length
      : 0;
    return {
      reviews: [...latest.values()].map(({ reviewer, state }) => ({ reviewer, state })),
      unresolvedThreads,
    };
  }

  async isPlatformApprovalRequired(repo: string, branch: string): Promise<boolean> {
    let classicRequiresApproval = false;
    try {
      const body = await this.apiJson(["api", `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`]);
      const record = body && !Array.isArray(body) ? body : {};
      const reviews = record.required_pull_request_reviews;
      if (reviews && typeof reviews === "object") {
        const count = (reviews as { required_approving_review_count?: unknown }).required_approving_review_count;
        classicRequiresApproval = typeof count === "number" && count > 0;
      }
    } catch (error) {
      if (!(error instanceof TransportError && error.kind === "http" && error.status === 404)) {
        return true;
      }
    }
    if (classicRequiresApproval) return true;
    try {
      const body = await this.apiJson(["api", `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`]);
      if (!Array.isArray(body)) return true;
      for (const item of body) {
        if (!item || typeof item !== "object") continue;
        const rule = item as { type?: unknown; parameters?: unknown };
        if (rule.type !== "pull_request") continue;
        const parameters = rule.parameters && typeof rule.parameters === "object"
          ? rule.parameters as { required_approving_review_count?: unknown }
          : {};
        if (typeof parameters.required_approving_review_count === "number" && parameters.required_approving_review_count > 0) {
          return true;
        }
      }
      return false;
    } catch {
      return true;
    }
  }

  async mergePullRequest(
    repo: string,
    prNumber: number,
    method: MergeMethod,
    expectedHeadSha: string,
  ): Promise<MergeResultView> {
    const stdout = await this.gh([
      "api",
      "--method",
      "PUT",
      `repos/${repo}/pulls/${prNumber}/merge`,
      "-f",
      `sha=${expectedHeadSha}`,
      "-f",
      `merge_method=${method}`,
    ]);
    const trimmed = stdout.trim();
    if (!trimmed) return { merged: false, sha: null, message: "empty merge response" };
    const body = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      merged: body.merged === true,
      sha: typeof body.sha === "string" ? body.sha : null,
      message: typeof body.message === "string" ? body.message : null,
    };
  }
}

export function createGhCliGitHubTransport(): GitHubPullRequestTransport {
  return new GhCliGitHubTransport();
}

/** Create a GhCliGitHubTransport with an injected gh executor (for tests). */
export function createGhCliGitHubTransportWithExec(run: GhExecFn): GhCliGitHubTransport {
  return new GhCliGitHubTransport(run);
}

/**
 * Default production transport factory. The registered MCP action uses this
 * when no transport is injected, so production wiring always talks to the
 * real `gh`-backed GitHub transport.
 */
export function defaultGitMergeTransportFactory(): GitHubPullRequestTransport {
  return createGhCliGitHubTransport();
}

// --- required-check verification ---------------------------------------------

export type RequiredCheckState =
  | "success"
  | "pending"
  | "failed"
  | "cancelled"
  | "neutral"
  | "unknown";

export type CheckEvidenceSource = "check_run" | "commit_status";

export interface RequiredCheckStatus {
  context: string;
  integrationId: number | null;
  state: RequiredCheckState;
  status: string | null;
  conclusion: string | null;
  source: CheckEvidenceSource;
  appId: number | null;
  reason?: string;
}

export function classifyCheckRun(run: CheckRunView): RequiredCheckState {
  const conclusion = run.conclusion;
  if (conclusion === "success") return "success";
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "action_required" || conclusion === "startup_failure") {
    return "failed";
  }
  if (conclusion === "cancelled") return "cancelled";
  if (conclusion === "neutral" || conclusion === "skipped") return "neutral";
  const status = run.status;
  if (status === "queued" || status === "in_progress" || status === "requested" || status === "waiting") {
    return "pending";
  }
  return "unknown";
}

/** Classify a GitHub commit status `state` (success/pending/failure/error). */
export function classifyCommitStatusState(state: string): RequiredCheckState {
  if (state === "success") return "success";
  if (state === "pending") return "pending";
  if (state === "failure" || state === "error") return "failed";
  return "unknown";
}

export type ChecksDecision =
  | { ok: true; required: RequiredCheckRequirement[]; statuses: RequiredCheckStatus[] }
  | {
      ok: false;
      code: PrMergeErrorCode;
      message: string;
      required: RequiredCheckRequirement[];
      statuses: RequiredCheckStatus[];
    };

function normalizeRequirements(
  requirements: RequiredCheckRequirement[],
): RequiredCheckRequirement[] {
  const byContext = new Map<string, RequiredCheckRequirement>();
  for (const req of requirements) {
    const existing = byContext.get(req.context);
    if (!existing) {
      byContext.set(req.context, req);
      continue;
    }
    // Same semantic requirement: prefer the more specific app binding, but never
    // drop a non-null binding in favor of a null one.
    if (existing.integrationId === null && req.integrationId !== null) {
      byContext.set(req.context, req);
    }
  }
  return [...byContext.values()];
}

/**
 * Independently verify that every required status check for the expected head
 * SHA is in a reliable terminal success state. `PR mergeable == true` is never
 * treated as CI success.
 *
 * Required checks are collected from BOTH classic branch protection and the
 * GitHub effective branch rules (`rules/branches/{branch}`), normalized into
 * one semantic contract keyed by context (never counted twice).
 *
 * Evidence is always bound to the exact `headSha` and considers both Check Runs
 * (with `app.id`/`app.slug`) and Commit Statuses (context + state). When a
 * requirement declares an `integrationId`, only a Check Run whose `app.id`
 * matches it may satisfy the requirement; a same-name run from another App is
 * ignored as satisfying evidence.
 *
 * Duplicate same-name evidence is handled conservatively: ALL relevant current
 * evidence for the candidate SHA is evaluated together. A pass is only asserted
 * when every relevant item is terminally successful; any relevant pending item
 * → REQUIRED_CHECKS_PENDING, any relevant failed/cancelled item →
 * REQUIRED_CHECKS_FAILED, and any neutral/skipped/unknown/missing/source
 * mismatch → REQUIRED_CHECKS_UNKNOWN. Never manufactured success, and never an
 * automatic failure purely because more than one run exists.
 */
export async function evaluateRequiredChecks(
  transport: GitHubPullRequestTransport,
  repo: string,
  defaultBranch: string,
  headSha: string,
): Promise<ChecksDecision> {
  let protection: BranchProtectionView;
  let effective: EffectiveRulesView;
  try {
    [protection, effective] = await Promise.all([
      transport.getBranchProtection(repo, defaultBranch),
      transport.getEffectiveRules(repo, defaultBranch),
    ]);
  } catch {
    return {
      ok: false,
      code: PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_UNKNOWN,
      message: "required status checks configuration could not be fetched; refusing to merge",
      required: [],
      statuses: [],
    };
  }
  if (!protection.determined || !effective.determined) {
    return {
      ok: false,
      code: PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_UNKNOWN,
      message: "required status checks configuration could not be reliably determined (classic protection or effective branch rules unreadable); refusing to merge",
      required: [],
      statuses: [],
    };
  }

  const required = normalizeRequirements([
    ...protection.requirements,
    ...effective.requirements,
  ]);
  if (required.length === 0) {
    // Both classic protection and effective rules were readable and require no
    // status checks. This is a reliable "no required checks" answer, not an
    // absence of evidence.
    return { ok: true, required: [], statuses: [] };
  }

  let runs: CheckRunView[];
  let commitStatuses: CommitStatusEvidence[];
  try {
    [runs, commitStatuses] = await Promise.all([
      transport.getCheckRuns(repo, headSha),
      transport.getCommitStatus(repo, headSha),
    ]);
  } catch {
    return {
      ok: false,
      code: PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_UNKNOWN,
      message: `check runs / commit statuses could not be fetched for expected head ${headSha}; refusing to merge`,
      required,
      statuses: [],
    };
  }

  const statuses: RequiredCheckStatus[] = [];
  let hasPending = false;
  let hasFailed = false;
  let hasUnknown = false;

  for (const requirement of required) {
    // Relevant Check Runs: exact context/name; when the requirement is bound to
    // an integration, only runs from that exact App are relevant.
    const relevantRuns = runs.filter((run) => {
      if (run.name !== requirement.context) return false;
      if (requirement.integrationId !== null) {
        return run.appId === requirement.integrationId;
      }
      return true;
    });

    // Commit Statuses are context-based only; they carry no App identity and
    // therefore can never satisfy an app-bound requirement.
    const relevantStatuses =
      requirement.integrationId === null
        ? commitStatuses.filter((s) => s.context === requirement.context)
        : [];

    const evidence: RequiredCheckStatus[] = [
      ...relevantRuns.map((run) => ({
        context: requirement.context,
        integrationId: requirement.integrationId,
        state: classifyCheckRun(run),
        status: run.status,
        conclusion: run.conclusion,
        source: "check_run" as const,
        appId: run.appId,
      })),
      ...relevantStatuses.map((s) => ({
        context: requirement.context,
        integrationId: null,
        state: classifyCommitStatusState(s.state),
        status: s.state,
        conclusion: null,
        source: "commit_status" as const,
        appId: null,
      })),
    ];

    if (evidence.length === 0) {
      hasUnknown = true;
      statuses.push({
        context: requirement.context,
        integrationId: requirement.integrationId,
        state: "unknown",
        status: null,
        conclusion: null,
        source: "check_run",
        appId: null,
        reason: "no check run or commit status matches the required context for the expected head SHA",
      });
      continue;
    }

    // Evaluate ALL relevant evidence for the exact SHA together. A terminal
    // failure dominates; then pending; then unknown/neutral; only an
    // unambiguous all-success is a pass.
    const hasFailedEvidence = evidence.some(
      (e) => e.state === "failed" || e.state === "cancelled",
    );
    const hasPendingEvidence = evidence.some((e) => e.state === "pending");
    const hasUnknownEvidence = evidence.some(
      (e) => e.state === "unknown" || e.state === "neutral",
    );
    const hasSuccessEvidence = evidence.some((e) => e.state === "success");

    let state: RequiredCheckState;
    let reason: string | undefined;
    if (hasFailedEvidence) {
      state = "failed";
      reason = "a relevant check run or commit status is in a terminal failure state";
    } else if (hasPendingEvidence) {
      state = "pending";
      reason = "a relevant check run or commit status is still pending";
    } else if (hasUnknownEvidence) {
      state = "unknown";
      reason = "a relevant check run or commit status is neutral, skipped, or indeterminate";
    } else if (hasSuccessEvidence) {
      state = "success";
    } else {
      state = "unknown";
      reason = "no conclusive relevant evidence for the required context";
    }

    statuses.push({
      context: requirement.context,
      integrationId: requirement.integrationId,
      state,
      status: evidence[0].status,
      conclusion: evidence[0].conclusion,
      source: evidence[0].source,
      appId: evidence[0].appId,
      reason,
    });

    if (state === "success") continue;
    // Aggregate from the evidence flags (derived above), not from the narrowed
    // `state` variable, so "cancelled"/"neutral" classification is preserved.
    if (hasFailedEvidence) hasFailed = true;
    else if (hasPendingEvidence) hasPending = true;
    else hasUnknown = true;
  }

  if (hasUnknown) {
    return {
      ok: false,
      code: PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_UNKNOWN,
      message: `a required check is not in a reliable terminal success state: ${formatCheckStatuses(statuses)}`,
      required,
      statuses,
    };
  }
  if (hasPending) {
    return {
      ok: false,
      code: PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_PENDING,
      message: `a required check is still pending: ${formatCheckStatuses(statuses)}`,
      required,
      statuses,
    };
  }
  if (hasFailed) {
    return {
      ok: false,
      code: PR_MERGE_ERROR_CODES.REQUIRED_CHECKS_FAILED,
      message: `a required check failed: ${formatCheckStatuses(statuses)}`,
      required,
      statuses,
    };
  }
  return { ok: true, required, statuses };
}

function formatCheckStatuses(statuses: RequiredCheckStatus[]): string {
  return statuses.map((s) => `${s.context}=${s.state}`).join(", ");
}

function mapTransportError(e: unknown, op: string): MergePullRequestError {
  if (!(e instanceof TransportError)) {
    return new MergePullRequestError(
      PR_MERGE_ERROR_CODES.TRANSPORT_AVAILABILITY_FAILURE,
      `${op} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (e.kind === "auth") {
    return new MergePullRequestError(
      PR_MERGE_ERROR_CODES.AUTHORIZATION_FAILURE,
      `GitHub transport authorization failure during ${op}: ${e.message}`,
    );
  }
  if (e.kind === "http") {
    if (e.status === 401 || e.status === 403) {
      return new MergePullRequestError(
        PR_MERGE_ERROR_CODES.AUTHORIZATION_FAILURE,
        `GitHub denied access during ${op}: ${e.message}`,
      );
    }
    if (e.status === 404) {
      if (op === "getPullRequest" || op === "merge") {
        return new MergePullRequestError(
          PR_MERGE_ERROR_CODES.PR_NOT_FOUND,
          `pull request not found during ${op}: ${e.message}`,
        );
      }
      return new MergePullRequestError(
        PR_MERGE_ERROR_CODES.REPOSITORY_IDENTITY_MISMATCH,
        `repository not found during ${op}: ${e.message}`,
      );
    }
    if (e.status === 405) {
      return new MergePullRequestError(
        PR_MERGE_ERROR_CODES.MERGE_REJECTED,
        `merge rejected by GitHub: ${e.message}`,
      );
    }
    if (e.status === 409) {
      return new MergePullRequestError(
        PR_MERGE_ERROR_CODES.EXPECTED_HEAD_MISMATCH,
        `GitHub rejected the merge because the PR head no longer matches the expected SHA: ${e.message}`,
      );
    }
    if (e.status >= 500) {
      return new MergePullRequestError(
        PR_MERGE_ERROR_CODES.TRANSPORT_AVAILABILITY_FAILURE,
        `GitHub returned HTTP ${e.status} during ${op}: ${e.message}`,
      );
    }
    return new MergePullRequestError(
      PR_MERGE_ERROR_CODES.MERGE_REJECTED,
      `GitHub rejected the request during ${op}: ${e.message}`,
    );
  }
  return new MergePullRequestError(
    PR_MERGE_ERROR_CODES.TRANSPORT_AVAILABILITY_FAILURE,
    `GitHub transport unavailable during ${op}: ${e.message}`,
  );
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFileAsync(
      "git",
      args,
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || String(error.message)));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// --- merge orchestration ------------------------------------------------------

export interface MergeEffectGuardContext {
  gitRoot: string;
  repository: string;
  defaultBranch: string;
  pullRequest: PullRequestView;
  expectedBaseSha: string;
  expectedHeadSha: string;
}

export type MergeEffectGuard = (context: MergeEffectGuardContext) => Promise<void>;

export interface MergePullRequestOptions {
  cwd: string;
  transport: GitHubPullRequestTransport;
  targetResolver?: IntegrationTargetResolver;
  beforeMergeEffect?: MergeEffectGuard;
}

export interface MergeReceipt {
  schema: string;
  merged: boolean;
  merge_method: MergeMethod;
  repository: string;
  remote_name: string;
  pr_number: number;
  pr_title: string;
  expected_base_sha: string;
  observed_base_sha_before_merge: string;
  expected_head_sha: string;
  observed_head_sha_before_merge: string;
  old_main_sha: string;
  candidate_head_sha: string;
  new_main_sha: string;
  merge_commit_sha: string | null;
  default_branch: string;
  remote: string;
  required_checks: RequiredCheckRequirement[];
  checks_status: {
    required: RequiredCheckRequirement[];
    checks: RequiredCheckStatus[];
  };
  merged_at: string | null;
  transport: "github_api";
}

/**
 * Orchestrate one exact-head default-branch PR merge.
 *
 * Flow:
 *  1. owner confirmation gate
 *  2. workspace → trusted integration-target resolution (server-controlled;
 *     never an implicit `origin == collaboration repository`)
 *  3. fresh repository default branch + identity cross-check
 *  4. fresh PR state (open, not draft, base == default, head == expected,
 *     mergeable)
 *  5. fresh default-branch SHA == expectedBaseSha
 *  6. independent required-check verification (classic protection +
 *     effective branch rules, check runs + commit statuses)
 *  7. last-moment CAS re-verification (TOCTOU window)
 *  8. merge with native `sha` CAS (a drifted head is rejected by GitHub)
 *  9. post-merge read-back verification + structured receipt
 */
export async function mergePullRequest(
  input: GitMergePullRequestInput,
  options: MergePullRequestOptions,
): Promise<MergeReceipt> {
  const { cwd, transport } = options;
  const targetResolver = options.targetResolver ?? defaultIntegrationTargetResolver();

  if (input.ownerConfirmation !== true) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.OWNER_CONFIRMATION_REQUIRED,
      "ownerConfirmation must be exactly true to authorize this merge",
    );
  }

  let gitRoot: string;
  try {
    gitRoot = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.WORKSPACE_NOT_GIT_REPOSITORY,
      "workspace is not inside a git repository",
    );
  }

  // Trusted integration-target resolution. The caller cannot select the
  // remote, repository, owner, branch, or URL; only the server-controlled
  // resolver may establish the collaboration target.
  let target: IntegrationTarget;
  try {
    target = await targetResolver.resolve(gitRoot);
  } catch (e) {
    if (e instanceof MergePullRequestError) throw e;
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.INTEGRATION_TARGET_UNRESOLVED,
      `trusted integration target resolution failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const repo = target.repository;

  let repository: RepositoryView;
  try {
    repository = await transport.getRepository(repo);
  } catch (e) {
    throw mapTransportError(e, "getRepository");
  }
  if (repository.full_name.toLowerCase() !== repo.toLowerCase()) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.REPOSITORY_IDENTITY_MISMATCH,
      `GitHub reports repository identity ${repository.full_name || "unknown"} which does not match the trusted integration target ${repo}`,
    );
  }
  if (!repository.default_branch) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.REPOSITORY_IDENTITY_MISMATCH,
      "GitHub did not report a default branch for the repository",
    );
  }
  if (repository.default_branch !== target.defaultBranch) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.DEFAULT_BRANCH_MISMATCH,
      `GitHub default branch ${repository.default_branch} does not match the trusted integration target default branch ${target.defaultBranch}`,
    );
  }
  const defaultBranch = target.defaultBranch;

  let pr: PullRequestView;
  try {
    pr = await transport.getPullRequest(repo, input.prNumber);
  } catch (e) {
    throw mapTransportError(e, "getPullRequest");
  }
  if (pr.state !== "OPEN") {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.PR_NOT_OPEN,
      `pull request #${input.prNumber} is ${pr.state}, not open`,
    );
  }
  if (pr.isDraft) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.PR_IS_DRAFT,
      `pull request #${input.prNumber} is a draft; it must be marked ready for review before merge`,
    );
  }
  if (pr.baseRefName !== defaultBranch) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.PR_BASE_MISMATCH,
      `pull request #${input.prNumber} base branch ${pr.baseRefName} does not match repository default branch ${defaultBranch}`,
    );
  }
  if (pr.baseRefOid && pr.baseRefOid !== input.expectedBaseSha) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.EXPECTED_BASE_MISMATCH,
      `pull request base commit ${pr.baseRefOid} does not match expected base ${input.expectedBaseSha}`,
    );
  }
  if (pr.headRefOid !== input.expectedHeadSha) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.EXPECTED_HEAD_MISMATCH,
      `pull request head is ${pr.headRefOid}, expected ${input.expectedHeadSha}`,
    );
  }
  if (pr.mergeable !== "MERGEABLE") {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.PR_NOT_MERGEABLE,
      `pull request mergeable state is ${pr.mergeable} (expected MERGEABLE)`,
    );
  }

  let baseRef: BranchRefView;
  try {
    baseRef = await transport.getBranchRef(repo, defaultBranch);
  } catch (e) {
    throw mapTransportError(e, "getBranchRef");
  }
  if (baseRef.sha !== input.expectedBaseSha) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.EXPECTED_BASE_MISMATCH,
      `remote ${defaultBranch} is ${baseRef.sha}, expected ${input.expectedBaseSha}`,
    );
  }

  const checks = await evaluateRequiredChecks(
    transport,
    repo,
    defaultBranch,
    input.expectedHeadSha,
  );
  if (!checks.ok) {
    throw new MergePullRequestError(checks.code, checks.message);
  }

  // Last-moment re-verification. Even though the merge call carries the native
  // exact-head CAS, the base branch has no API-level CAS, so it is re-read
  // immediately before the merge and the PR is re-read to shrink the TOCTOU
  // window to a single round trip. Every PR property that was validated during
  // preflight must still hold: state, draft status, base branch, base commit,
  // and head commit. A drifted property fails closed with the same
  // deterministic code used in preflight; the merge API is never called.
  let observedBase = baseRef.sha;
  let observedHead = pr.headRefOid;
  let finalPr = pr;
  try {
    const [freshBase, freshPr] = await Promise.all([
      transport.getBranchRef(repo, defaultBranch),
      transport.getPullRequest(repo, input.prNumber),
    ]);
    if (freshPr.state !== "OPEN") {
      throw new MergePullRequestError(
        PR_MERGE_ERROR_CODES.PR_NOT_OPEN,
        `pull request state changed between validation and merge: ${freshPr.state}`,
      );
    }
    if (freshPr.isDraft) {
      throw new MergePullRequestError(
        PR_MERGE_ERROR_CODES.PR_IS_DRAFT,
        "pull request became a draft between validation and merge",
      );
    }
    if (freshPr.baseRefName !== defaultBranch) {
      throw new MergePullRequestError(
        PR_MERGE_ERROR_CODES.PR_BASE_MISMATCH,
        `pull request base branch changed between validation and merge: ${freshPr.baseRefName}`,
      );
    }
    if (freshPr.baseRefOid !== input.expectedBaseSha) {
      throw new MergePullRequestError(
        PR_MERGE_ERROR_CODES.EXPECTED_BASE_MISMATCH,
        `pull request base commit changed between validation and merge: observed ${freshPr.baseRefOid}, expected ${input.expectedBaseSha}`,
      );
    }
    if (freshPr.headRefOid !== input.expectedHeadSha) {
      throw new MergePullRequestError(
        PR_MERGE_ERROR_CODES.EXPECTED_HEAD_MISMATCH,
        `head drifted between validation and merge: observed ${freshPr.headRefOid}, expected ${input.expectedHeadSha}`,
      );
    }
    if (freshBase.sha !== input.expectedBaseSha) {
      throw new MergePullRequestError(
        PR_MERGE_ERROR_CODES.EXPECTED_BASE_MISMATCH,
        `base drifted between validation and merge: observed ${freshBase.sha}, expected ${input.expectedBaseSha}`,
      );
    }
    observedBase = freshBase.sha;
    observedHead = freshPr.headRefOid;
    finalPr = freshPr;
  } catch (e) {
    if (e instanceof MergePullRequestError) throw e;
    throw mapTransportError(e, "final-preflight");
  }

  if (options.beforeMergeEffect) {
    try {
      await options.beforeMergeEffect({
        gitRoot,
        repository: repo,
        defaultBranch,
        pullRequest: finalPr,
        expectedBaseSha: input.expectedBaseSha,
        expectedHeadSha: input.expectedHeadSha,
      });
    } catch (e) {
      if (e instanceof MergePullRequestError) throw e;
      throw new MergePullRequestError(
        PR_MERGE_ERROR_CODES.MERGE_LANE_NOT_AUTHORIZED,
        `pre-merge lane guard rejected the effect: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  let mergeResult: MergeResultView;
  try {
    mergeResult = await transport.mergePullRequest(
      repo,
      input.prNumber,
      input.mergeMethod,
      input.expectedHeadSha,
    );
  } catch (e) {
    throw mapTransportError(e, "merge");
  }
  if (!mergeResult.merged) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.MERGE_REJECTED,
      mergeResult.message ?? "GitHub rejected the merge request",
    );
  }

  let newMainSha: string;
  let postPr: PullRequestView;
  try {
    newMainSha = (await transport.getBranchRef(repo, defaultBranch)).sha;
    postPr = await transport.getPullRequest(repo, input.prNumber);
  } catch (e) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.POST_MERGE_VERIFICATION_FAILED,
      `post-merge read-back failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (newMainSha === observedBase) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.POST_MERGE_VERIFICATION_FAILED,
      `remote ${defaultBranch} did not advance after merge (still ${newMainSha})`,
    );
  }
  if (mergeResult.sha && mergeResult.sha !== newMainSha) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.POST_MERGE_VERIFICATION_FAILED,
      `post-merge read-back ${newMainSha} does not match the merge result ${mergeResult.sha}`,
    );
  }
  if (!postPr.merged) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.POST_MERGE_VERIFICATION_FAILED,
      `pull request #${input.prNumber} is not in a merged state after merge`,
    );
  }
  if (postPr.headRefOid !== input.expectedHeadSha) {
    throw new MergePullRequestError(
      PR_MERGE_ERROR_CODES.POST_MERGE_VERIFICATION_FAILED,
      `pull request head changed after merge (${postPr.headRefOid}), not the expected candidate ${input.expectedHeadSha}`,
    );
  }

  return {
    schema: "nexus.pr_merge_receipt.v1",
    merged: true,
    merge_method: input.mergeMethod,
    repository: repo,
    remote_name: target.remoteName,
    pr_number: input.prNumber,
    pr_title: postPr.title,
    expected_base_sha: input.expectedBaseSha,
    observed_base_sha_before_merge: observedBase,
    expected_head_sha: input.expectedHeadSha,
    observed_head_sha_before_merge: observedHead,
    old_main_sha: observedBase,
    candidate_head_sha: input.expectedHeadSha,
    new_main_sha: newMainSha,
    merge_commit_sha: mergeResult.sha ?? postPr.mergeCommitOid ?? newMainSha,
    default_branch: defaultBranch,
    remote: sanitizeRemoteUrl(target.remoteUrl),
    required_checks: checks.required,
    checks_status: { required: checks.required, checks: checks.statuses },
    merged_at: postPr.mergedAt ?? null,
    transport: "github_api",
  };
}

// --- MCP tool wrapper ---------------------------------------------------------

export interface MergeToolContext {
  cwd: string;
  transport?: GitHubPullRequestTransport;
  targetResolver?: IntegrationTargetResolver;
  beforeMergeEffect?: MergeEffectGuard;
}

function toMcpError(error: unknown): ToolResult {
  if (error instanceof MergePullRequestError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: error.message, code: error.code },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
            code: PR_MERGE_ERROR_CODES.INTERNAL_ERROR,
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

export async function gitMergePullRequestTool(
  input: Record<string, unknown>,
  context: MergeToolContext,
): Promise<ToolResult> {
  let parsed: GitMergePullRequestInput;
  try {
    parsed = parseMergePullRequestInput(input);
  } catch (e) {
    return toMcpError(e);
  }

  try {
    const receipt = await mergePullRequest(parsed, {
      cwd: context.cwd,
      transport: context.transport ?? defaultGitMergeTransportFactory(),
      targetResolver: context.targetResolver,
      beforeMergeEffect: context.beforeMergeEffect,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }],
    };
  } catch (e) {
    return toMcpError(e);
  }
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
