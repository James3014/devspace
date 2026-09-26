import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep, dirname, basename } from "node:path";
import { realpathSync } from "node:fs";

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(expandHomePath(path));
  const resolvedRoot = resolve(expandHomePath(root));
  const relationship = relative(resolvedRoot, resolvedPath);

  return (
    relationship === "" ||
    (!isAbsolute(relationship) &&
      !relationship.startsWith("..") &&
      relationship !== ".." &&
      !relationship.includes(`..${sep}`))
  );
}

export function assertAllowedPath(path: string, allowedRoots: string[]): string {
  const resolvedPath = resolve(expandHomePath(path));
  if (allowedRoots.some((root) => isPathInsideRoot(resolvedPath, root))) {
    return resolvedPath;
  }

  throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}

export function resolveAllowedPath(inputPath: string, cwd: string, allowedRoots: string[]): string {
  const absolutePath = resolve(cwd, inputPath);
  return assertAllowedPath(absolutePath, allowedRoots);
}

export function canonicalizePath(path: string): string {
  const missingSegments: string[] = [];
  let candidate = resolve(expandHomePath(path));

  const realpathFn = typeof realpathSync.native === "function" ? realpathSync.native : realpathSync;
  while (true) {
    try {
      return resolve(realpathFn(candidate), ...missingSegments.slice().reverse());
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (!err || (err.code !== "ENOENT" && err.code !== "ENOTDIR")) {
        throw error;
      }

      const parent = dirname(candidate);
      if (parent === candidate) return resolve(expandHomePath(path));
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

export function isSameWorktreePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return a === b;
  if (a === b) return true;
  const ca = canonicalizePath(a);
  const cb = canonicalizePath(b);
  if (ca === cb) return true;
  if (process.platform === "darwin" || process.platform === "win32") {
    return ca.toLowerCase() === cb.toLowerCase();
  }
  return false;
}
