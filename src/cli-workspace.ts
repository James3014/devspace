import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { AccessDeniedError, assertAllowedPath, expandHomePath } from "./roots.js";

export interface CliWorkspaceScope {
  workspaceRoot: string;
  workspaceId?: string;
}

/**
 * Resolve the project scope for a command launched by a coding harness.
 *
 * MCP shells provide an explicit workspace root. Direct CLI invocations use
 * the current Git checkout when available, and otherwise the current
 * directory. Every result still has to be inside DevSpace's configured
 * allowlist; the environment is a hint, not an authority boundary.
 */
export function resolveCliWorkspaceRoot(
  allowedRoots: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const requested = env.DEVSPACE_WORKSPACE_ROOT?.trim();
  const candidate = requested
    ? resolve(cwd, expandHomePath(requested))
    : findGitRoot(cwd) ?? resolve(cwd);

  try {
    return assertAllowedPath(candidate, allowedRoots);
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      throw new AccessDeniedError(
        `Workspace is outside DEVSPACE_ALLOWED_ROOTS: ${candidate}`,
      );
    }
    throw error;
  }
}

export function resolveCliWorkspaceScope(
  allowedRoots: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): CliWorkspaceScope {
  return {
    workspaceRoot: resolveCliWorkspaceRoot(allowedRoots, env, cwd),
    workspaceId: env.DEVSPACE_WORKSPACE_ID?.trim() || undefined,
  };
}

function findGitRoot(cwd: string): string | undefined {
  try {
    const output = execFileSync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}
