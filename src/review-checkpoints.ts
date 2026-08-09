import { mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { git, getGitEligibility, safeWorkspaceRefSegment } from "./git.js";

export type ReviewSince = "last_shown" | "workspace_open";

export interface ReviewSummary {
  files: number;
  additions: number;
  removals: number;
}

export interface ReviewFile {
  path: string;
  previousPath?: string;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  additions: number;
  removals: number;
}

export interface ReviewChangesResult {
  result: string;
  summary: ReviewSummary;
  files: ReviewFile[];
  patch: string;
}

interface WorkspaceReviewState {
  root: string;
  gitRoot?: string;
  openRef: string;
  baselineRef: string;
  openRefAvailable: boolean;
  baselineRefAvailable: boolean;
  headSha?: string;
  headTracked?: boolean;
  diagnostic?: string;
}

export interface ReviewCheckpointManager {
  initializeWorkspace(input: { workspaceId: string; root: string }): Promise<void>;
  reviewChanges(input: {
    workspaceId: string;
    root: string;
    since?: ReviewSince;
    markReviewed?: boolean;
    ignoreWhitespace?: boolean;
  }): Promise<ReviewChangesResult>;
}

const REVIEW_REF_PREFIX = "refs/devspace/review";

export function createReviewCheckpointManager(): ReviewCheckpointManager {
  const states = new Map<string, WorkspaceReviewState>();
  const initializations = new Map<string, Promise<void>>();

  return {
    async initializeWorkspace({ workspaceId, root }) {
      const existingState = states.get(workspaceId);
      assertWorkspaceRoot(existingState, workspaceId, root);
      if (existingState?.root === root && existingState.gitRoot !== undefined) {
        return;
      }

      const pending = initializations.get(workspaceId);
      if (pending) {
        await pending;
        assertWorkspaceRoot(states.get(workspaceId), workspaceId, root);
        return;
      }

      const initialize = initializeWorkspaceState(states, workspaceId, root);
      initializations.set(workspaceId, initialize);
      try {
        await initialize;
      } finally {
        if (initializations.get(workspaceId) === initialize) {
          initializations.delete(workspaceId);
        }
      }
    },

    async reviewChanges({ workspaceId, root, since = "last_shown", markReviewed = true, ignoreWhitespace = true }) {
      let state = states.get(workspaceId);
      assertWorkspaceRoot(state, workspaceId, root);
      if (!isReadyState(state)) {
        await this.initializeWorkspace({ workspaceId, root });
        state = states.get(workspaceId);
      }
      assertWorkspaceRoot(state, workspaceId, root);

      if (!state?.gitRoot) {
        throw new Error(state?.diagnostic ?? "show_changes requires a Git workspace in this version.");
      }

      const currentHead = await headSha(state.gitRoot);
      if (state.headTracked && state.headSha !== currentHead) {
        const snapshot = await createWorkingTreeSnapshot(state.gitRoot);
        await git(state.gitRoot, ["update-ref", state.openRef, snapshot.commit]);
        await git(state.gitRoot, ["update-ref", state.baselineRef, snapshot.commit]);
        state.headSha = snapshot.headSha;
        state.openRefAvailable = true;
        state.baselineRefAvailable = true;
        return {
          result: "The repository HEAD moved since the last review, so the review checkpoints were re-anchored to the latest commit. No changes since then.",
          summary: { files: 0, additions: 0, removals: 0 },
          files: [],
          patch: "",
        };
      }

      let effectiveSince = since;
      let usedWorkspaceOpenFallback = false;
      if (since === "last_shown" && !state.baselineRefAvailable) {
        if (!state.openRefAvailable) {
          throw new Error("Review checkpoints are missing; show_changes cannot reconstruct that history safely.");
        }
        effectiveSince = "workspace_open";
        usedWorkspaceOpenFallback = true;
      } else if (since === "workspace_open" && !state.openRefAvailable) {
        throw new Error(
          "The workspace-open review checkpoint is missing; show_changes cannot reconstruct that history safely.",
        );
      }

      const baselineRef = effectiveSince === "workspace_open" ? state.openRef : state.baselineRef;
      const baseline = (await git(state.gitRoot, ["rev-parse", "--verify", `${baselineRef}^{commit}`])).stdout.trim();
      const current = await createWorkingTreeSnapshot(state.gitRoot);
      const whitespaceArgs = ignoreWhitespace ? ["--ignore-all-space"] : [];
      const patch = await diffOrDegrade(
        state.gitRoot,
        ["diff", ...whitespaceArgs, "--no-color", "--no-ext-diff", "--no-textconv", baseline, current.commit],
      );
      const numstat = (await git(state.gitRoot, ["diff", ...whitespaceArgs, "--numstat", "-z", baseline, current.commit], {
        maxBuffer: 10 * 1024 * 1024,
      })).stdout;
      const files = parseNumstat(numstat);
      const summary = summarizeFiles(files);

      if (markReviewed) {
        await git(state.gitRoot, ["update-ref", state.baselineRef, current.commit]);
        state.baselineRefAvailable = true;
        state.headSha = current.headSha;
      }

      const fallbackNote = usedWorkspaceOpenFallback
        ? ` The last-shown checkpoint was missing, so changes were compared from workspace open${markReviewed ? " and the baseline was re-established" : ""}.`
        : "";
      const degradedNote = patch.degraded && summary.files > 0
        ? " The diff was too large to render, so a file list is shown instead."
        : "";
      return {
        result: `${
          summary.files === 0
            ? `No changes since ${effectiveSince === "workspace_open" ? "workspace open" : "last shown changes"}.`
            : `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`
        }${fallbackNote}${degradedNote}`,
        summary,
        files,
        patch: patch.text,
      };
    },
  };
}

function assertWorkspaceRoot(
  state: WorkspaceReviewState | undefined,
  workspaceId: string,
  root: string,
): void {
  if (state && state.root !== root) {
    throw new Error(`Review checkpoint workspace root mismatch for ${workspaceId}.`);
  }
}

async function initializeWorkspaceState(
  states: Map<string, WorkspaceReviewState>,
  workspaceId: string,
  root: string,
): Promise<void> {
  const refs = reviewRefs(workspaceId);
  const state: WorkspaceReviewState = {
    root,
    ...refs,
    openRefAvailable: false,
    baselineRefAvailable: false,
  };

  try {
    const eligibility = await getGitEligibility(root);
    if (!eligibility.gitRoot) {
      state.diagnostic = eligibility.message ?? "show_changes requires a Git workspace in this version.";
      return;
    }
    const gitRoot = eligibility.gitRoot;

    const [openCommit, baselineCommit] = await Promise.all([
      commitForRef(gitRoot, state.openRef),
      commitForRef(gitRoot, state.baselineRef),
    ]);

    if (!openCommit && !baselineCommit) {
      const initialCommit = await createWorkingTreeSnapshot(gitRoot);
      await git(gitRoot, ["update-ref", state.openRef, initialCommit.commit]);
      await git(gitRoot, ["update-ref", state.baselineRef, initialCommit.commit]);
      state.openRefAvailable = true;
      state.baselineRefAvailable = true;
      state.headSha = initialCommit.headSha;
      state.headTracked = true;
    } else {
      state.openRefAvailable = openCommit !== undefined;
      state.baselineRefAvailable = baselineCommit !== undefined;
    }

    state.gitRoot = gitRoot;
  } catch (error) {
    state.diagnostic = error instanceof Error ? error.message : String(error);
  } finally {
    states.set(workspaceId, state);
  }
}

function isReadyState(state: WorkspaceReviewState | undefined): boolean {
  return state?.gitRoot !== undefined;
}

async function commitForRef(gitRoot: string, ref: string): Promise<string | undefined> {
  try {
    return (await git(gitRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
  } catch {
    return undefined;
  }
}

function reviewRefs(
  workspaceId: string,
): Pick<WorkspaceReviewState, "openRef" | "baselineRef"> {
  const segment = safeWorkspaceRefSegment(workspaceId);
  return {
    openRef: `${REVIEW_REF_PREFIX}/${segment}/open`,
    baselineRef: `${REVIEW_REF_PREFIX}/${segment}/baseline`,
  };
}

async function createWorkingTreeSnapshot(gitRoot: string): Promise<{ commit: string; headSha?: string }> {
  const head = await headSha(gitRoot);
  const commonDir = (await git(gitRoot, ["rev-parse", "--git-common-dir"])).stdout.trim();
  const commonDirPath = isAbsolute(commonDir) ? commonDir : join(gitRoot, commonDir);
  const tempDir = await mkdtemp(join(commonDirPath, "devspace-review-index-"));
  const indexPath = join(tempDir, "index");
  const env = checkpointEnv(indexPath);
  const fsFlags = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];

  try {
    if (head) {
      await git(gitRoot, ["read-tree", "HEAD"], { env });
    } else {
      await git(gitRoot, ["read-tree", "--empty"], { env });
    }
    await git(gitRoot, [...fsFlags, "add", "-A", "--", "."], { env });
    const tree = (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
    const commit = (await git(gitRoot, ["commit-tree", tree, "-m", "DevSpace review snapshot"], { env })).stdout.trim();
    return { commit, headSha: head };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function headSha(gitRoot: string): Promise<string | undefined> {
  try {
    return (await git(gitRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  } catch {
    return undefined;
  }
}

async function diffOrDegrade(
  gitRoot: string,
  args: string[],
): Promise<{ text: string; degraded: boolean }> {
  try {
    const patch = await git(gitRoot, args, { maxBuffer: 10 * 1024 * 1024 });
    return { text: patch.stdout, degraded: false };
  } catch (error) {
    if (String(error).includes("maxBuffer")) {
      return { text: "", degraded: true };
    }
    throw error;
  }
}

function checkpointEnv(indexPath: string): NodeJS.ProcessEnv {
  return {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "DevSpace",
    GIT_AUTHOR_EMAIL: "devspace@users.noreply.local",
    GIT_COMMITTER_NAME: "DevSpace",
    GIT_COMMITTER_EMAIL: "devspace@users.noreply.local",
  };
}

function parseNumstat(output: string): ReviewFile[] {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const files: ReviewFile[] = [];

  for (let index = 0; index < fields.length;) {
    const header = fields[index++] ?? "";
    const parts = header.split("\t");
    const additions = parseStatNumber(parts[0]);
    const removals = parseStatNumber(parts[1]);

    if (parts.length >= 3) {
      const path = parts[2] ?? "";
      if (path) files.push({ path, type: fileType(path, undefined, additions, removals), additions, removals });
      continue;
    }

    const previousPath = fields[index++];
    const path = fields[index++];
    if (!path) continue;

    files.push({
      path,
      previousPath,
      type: fileType(path, previousPath, additions, removals),
      additions,
      removals,
    });
  }

  return files;
}

function parseStatNumber(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileType(
  path: string,
  previousPath: string | undefined,
  additions: number,
  removals: number,
): ReviewFile["type"] {
  if (previousPath) return additions === 0 && removals === 0 ? "rename-pure" : "rename-changed";
  if (additions > 0 && removals === 0) return "new";
  if (additions === 0 && removals > 0) return "deleted";
  return "change";
}

function summarizeFiles(files: ReviewFile[]): ReviewSummary {
  return files.reduce<ReviewSummary>(
    (summary, file) => ({
      files: summary.files + 1,
      additions: summary.additions + file.additions,
      removals: summary.removals + file.removals,
    }),
    { files: 0, additions: 0, removals: 0 },
  );
}
