import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, stat, access } from "node:fs/promises";
import { join, normalize, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

type McpContent = { type: "text"; text: string };

interface ToolResult {
  content: McpContent[];
  isError?: boolean;
}

function toMcpContent(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function toMcpError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Validate that a user-supplied path stays within the workspace root.
 * Rejects: "..", absolute paths outside workspace, symlink escapes.
 */
function validateSearchPath(
  inputPath: string | undefined,
  workspaceRoot: string,
): string | null {
  if (!inputPath) return null;

  if (inputPath.includes("..")) {
    return "search_text: path must not contain '..'";
  }

  const normalized = normalize(inputPath);
  const resolved = resolve(workspaceRoot, normalized);

  // Reject absolute paths that resolve outside workspace
  if (
    resolved !== workspaceRoot &&
    !resolved.startsWith(workspaceRoot + "/") &&
    resolved !== workspaceRoot
  ) {
    return "search_text: path resolves outside workspace";
  }

  return null;
}

/**
 * Path-segment-aware containment check.
 * "tasks2/file.md" must NOT match prefix "tasks/".
 */
function isPathInsideDir(filePath: string, dir: string): boolean {
  const normalizedFile = normalize(filePath);
  const normalizedDir = normalize(dir);
  return (
    normalizedFile === normalizedDir ||
    normalizedFile.startsWith(normalizedDir + "/")
  );
}

// --- build identity reader ---
async function readBuildIdentity(): Promise<Record<string, unknown> | null> {
  try {
    // Try to find build-identity.json relative to this module
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const identityPath = join(thisDir, "..", "generated", "build-identity.json");
    await access(identityPath);
    const raw = await readFile(identityPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// --- workspace_snapshot ---
export async function workspaceSnapshotTool(
  input: Record<string, never>,
  context: { cwd: string },
): Promise<ToolResult> {
  try {
    const cwd = context.cwd;
    const { stdout: status } = await git(cwd, ["status", "--porcelain=v1"]);
    const { stdout: branch } = await git(cwd, ["branch", "--show-current"]);
    const { stdout: head } = await git(cwd, ["rev-parse", "HEAD"]);
    const { stdout: shortHead } = await git(cwd, ["rev-parse", "--short", "HEAD"]);

    const changedFiles = status
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const xy = line.substring(0, 2);
        const filePath = line.substring(3);
        return { status: xy.trim(), path: filePath };
      });

    // Include runtime build identity
    const buildIdentity = await readBuildIdentity();

    return toMcpContent(
      JSON.stringify(
        {
          branch: branch || "(detached)",
          head,
          head_short: shortHead,
          changed_count: changedFiles.length,
          changed_files: changedFiles.slice(0, 50),
          dirty: changedFiles.length > 0,
          server_identity: buildIdentity || {
            package_name: "unknown",
            package_version: "unknown",
            source_commit: "unknown",
            build_id: "unknown",
            tool_surface: "unknown",
            tool_count: 16,
          },
        },
        null,
        2,
      ),
    );
  } catch (e) {
    return toMcpError(
      `workspace_snapshot failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// --- search_text ---
export async function searchTextTool(
  input: {
    pattern: string;
    path?: string;
    include?: string;
    max_results?: number;
  },
  context: { cwd: string },
): Promise<ToolResult> {
  try {
    const cwd = context.cwd;

    // Normalize: "" and "." mean root mode (search entire workspace)
    const rawPath = input.path?.trim();
    const effectivePath =
      rawPath && rawPath !== "." ? rawPath : undefined;

    // Validate path: reject traversal and absolute paths outside workspace
    const pathError = validateSearchPath(effectivePath, cwd);
    if (pathError) {
      return toMcpError(pathError);
    }

    // Build git grep args: options BEFORE "--" and pathspec
    const args: string[] = ["grep", "-n", "-i"];

    // max-count must come before "--" and pathspec
    if (input.max_results) {
      args.push(`--max-count=${input.max_results}`);
    }

    args.push(input.pattern);

    // Build pathspec: combine path and include into single pathspec
    if (effectivePath && input.include) {
      const dir = effectivePath.replace(/\/+$/, "");
      const pattern = input.include.startsWith("*")
        ? input.include
        : `*${input.include}`;
      args.push("--", `${dir}/${pattern}`);
    } else if (effectivePath) {
      args.push("--", effectivePath);
    } else if (input.include) {
      // Root mode with include filter
      const pattern = input.include.startsWith("*")
        ? input.include
        : `*${input.include}`;
      args.push("--", pattern);
    }
    // Root mode without include: no pathspec, search entire workspace

    const { stdout } = await git(cwd, args);
    const lines = stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, input.max_results || 100);

    // Post-filter: path-segment-aware containment check
    const filtered = effectivePath
      ? lines.filter((line) => {
          const file = line.split(":")[0];
          return isPathInsideDir(file, effectivePath);
        })
      : lines;

    return toMcpContent(
      JSON.stringify(
        {
          pattern: input.pattern,
          match_count: filtered.length,
          matches: filtered.map((line) => {
            const [file, lineNum, ...rest] = line.split(":");
            return { file, line: parseInt(lineNum, 10), text: rest.join(":") };
          }),
        },
        null,
        2,
      ),
    );
  } catch (e: unknown) {
    // git grep exits 1 when no matches found — not a real error
    const exitCode =
      typeof e === "object" && e && "code" in e
        ? (e as { code?: number }).code
        : undefined;
    if (exitCode === 1) {
      return toMcpContent(
        JSON.stringify({ pattern: input.pattern, match_count: 0, matches: [] }),
      );
    }
    return toMcpError(
      `search_text failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// --- list_tree ---
export async function listTreeTool(
  input: { path?: string; max_depth?: number },
  context: { cwd: string },
): Promise<ToolResult> {
  try {
    const cwd = context.cwd;
    const target = input.path ? join(cwd, input.path) : cwd;
    const maxDepth = input.max_depth || 3;

    async function walk(dir: string, depth: number): Promise<unknown[]> {
      if (depth > maxDepth) return [];
      const entries = await readdir(dir, { withFileTypes: true });
      const results: unknown[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const fullPath = join(dir, entry.name);
        const relPath = relative(cwd, fullPath);
        if (entry.isDirectory()) {
          results.push({ path: relPath, type: "dir" });
          const children = await walk(fullPath, depth + 1);
          results.push(...children);
        } else {
          const s = await stat(fullPath);
          results.push({ path: relPath, type: "file", size: s.size });
        }
      }
      return results;
    }

    const tree = await walk(target, 1);
    return toMcpContent(
      JSON.stringify(
        { root: input.path || ".", max_depth: maxDepth, entries: tree },
        null,
        2,
      ),
    );
  } catch (e) {
    return toMcpError(
      `list_tree failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// --- git_status ---
export async function gitStatusTool(
  input: { include_detail?: boolean },
  context: { cwd: string },
): Promise<ToolResult> {
  try {
    const cwd = context.cwd;
    const { stdout } = await git(cwd, ["status", "--porcelain=v1"]);
    const lines = stdout.split("\n").filter(Boolean);

    const files = lines.map((line) => {
      const xy = line.substring(0, 2);
      const filePath = line.substring(3);
      return { xy, path: filePath };
    });

    return toMcpContent(
      JSON.stringify(
        {
          total: files.length,
          added: files.filter((f) => f.xy[0] === "A").length,
          modified: files.filter(
            (f) => f.xy[0] === "M" || f.xy[1] === "M",
          ).length,
          deleted: files.filter(
            (f) => f.xy[0] === "D" || f.xy[1] === "D",
          ).length,
          untracked: files.filter((f) => f.xy === "??").length,
          files: input.include_detail ? files : files.slice(0, 50),
        },
        null,
        2,
      ),
    );
  } catch (e) {
    return toMcpError(
      `git_status failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// --- git_diff ---
export async function gitDiffTool(
  input: {
    ref_a?: string;
    ref_b?: string;
    path?: string;
    stat_only?: boolean;
  },
  context: { cwd: string },
): Promise<ToolResult> {
  try {
    const cwd = context.cwd;
    const args = ["diff"];

    if (input.ref_a && input.ref_b) {
      args.push(`${input.ref_a}...${input.ref_b}`);
    } else if (input.ref_a) {
      args.push(input.ref_a);
    }

    if (input.path) args.push("--", input.path);
    if (input.stat_only) args.push("--stat");

    const { stdout } = await git(cwd, args);
    const truncated =
      stdout.length > 50000
        ? stdout.substring(0, 50000) + "\n... (truncated)"
        : stdout;

    return toMcpContent(
      JSON.stringify(
        {
          diff: truncated,
          truncated: stdout.length > 50000,
          total_length: stdout.length,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    return toMcpError(
      `git_diff failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// --- git_log ---
export async function gitLogTool(
  input: { count?: number; path?: string },
  context: { cwd: string },
): Promise<ToolResult> {
  try {
    const cwd = context.cwd;
    const count = input.count || 20;
    const args = [
      "log",
      `--max-count=${count}`,
      "--pretty=format:%H|%h|%s|%an|%ai",
    ];

    if (input.path) args.push("--", input.path);

    const { stdout } = await git(cwd, args);
    const commits = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, short, subject, author, date] = line.split("|");
        return { hash, short, subject, author, date };
      });

    return toMcpContent(
      JSON.stringify({ count: commits.length, commits }, null, 2),
    );
  } catch (e) {
    return toMcpError(
      `git_log failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// --- git_show ---
export async function gitShowTool(
  input: { ref?: string; format?: "stat" | "patch" },
  context: { cwd: string },
): Promise<ToolResult> {
  try {
    const cwd = context.cwd;
    const ref = input.ref || "HEAD";
    const args = ["show", ref, "--stat"];

    if (input.format === "patch") {
      args.pop();
    }

    const { stdout } = await git(cwd, args);
    const truncated =
      stdout.length > 30000
        ? stdout.substring(0, 30000) + "\n... (truncated)"
        : stdout;

    return toMcpContent(
      JSON.stringify(
        {
          ref,
          content: truncated,
          truncated: stdout.length > 30000,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    return toMcpError(
      `git_show failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// --- git_worktrees ---
export async function gitWorktreesTool(
  input: Record<string, never>,
  context: { cwd: string },
): Promise<ToolResult> {
  try {
    const cwd = context.cwd;
    const { stdout } = await git(cwd, ["worktree", "list", "--porcelain"]);
    const worktrees: Array<{
      path: string;
      head?: string;
      branch?: string;
      bare?: boolean;
      detached?: boolean;
    }> = [];
    let current: Record<string, unknown> = {};

    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) worktrees.push(current as { path: string });
        // Use full prefix length to preserve leading "/"
        current = { path: line.slice("worktree ".length) };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length);
      } else if (line === "bare") {
        current.bare = true;
      } else if (line === "detached") {
        current.detached = true;
      }
    }
    if (current.path) worktrees.push(current as { path: string });

    // Ensure all paths are absolute
    const normalized = worktrees.map((wt) => ({
      ...wt,
      path: wt.path.startsWith("/") ? wt.path : resolve(cwd, wt.path),
    }));

    return toMcpContent(
      JSON.stringify(
        { count: normalized.length, worktrees: normalized },
        null,
        2,
      ),
    );
  } catch (e) {
    return toMcpError(
      `git_worktrees failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// --- read_task_card ---
export async function readTaskCardTool(
  input: { campaign_id: string; card_id: string },
  context: { cwd: string },
): Promise<ToolResult> {
  try {
    const cwd = context.cwd;
    const cardPath = join(cwd, "tasks", input.campaign_id, `${input.card_id}.md`);
    const content = await readFile(cardPath, "utf-8");

    return toMcpContent(
      JSON.stringify(
        {
          campaign_id: input.campaign_id,
          card_id: input.card_id,
          path: `tasks/${input.campaign_id}/${input.card_id}.md`,
          content,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    return toMcpError(
      `read_task_card failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// --- read_candidate ---
export async function readCandidateTool(
  input: { candidate_id: string },
  context: { cwd: string },
): Promise<ToolResult> {
  try {
    const cwd = context.cwd;
    const candidatePath = join(
      cwd,
      ".nexus",
      "candidates",
      `${input.candidate_id}.json`,
    );
    const content = await readFile(candidatePath, "utf-8");

    return toMcpContent(
      JSON.stringify(
        {
          candidate_id: input.candidate_id,
          data: JSON.parse(content),
        },
        null,
        2,
      ),
    );
  } catch (e) {
    return toMcpError(
      `read_candidate failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// --- read_receipt ---
export async function readReceiptTool(
  input: { receipt_id: string },
  context: { cwd: string },
): Promise<ToolResult> {
  try {
    const cwd = context.cwd;
    const receiptPath = join(
      cwd,
      ".nexus",
      "receipts",
      `${input.receipt_id}.json`,
    );
    const content = await readFile(receiptPath, "utf-8");

    return toMcpContent(
      JSON.stringify(
        {
          receipt_id: input.receipt_id,
          data: JSON.parse(content),
        },
        null,
        2,
      ),
    );
  } catch (e) {
    return toMcpError(
      `read_receipt failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// Exported for testing
export { validateSearchPath, isPathInsideDir };
