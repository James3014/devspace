import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve, sep } from "node:path";

export function removeDevspaceNodeModulesBinFromPath(pathValue: string): string {
  return pathValue
    .split(delimiter)
    .filter((entry) => entry && !isDevspaceNodeModulesBin(entry))
    .join(delimiter);
}

/**
 * Expose an explicitly installed per-user nexus-certify executable to
 * DevSpace-managed processes even when launchd provides a minimal PATH.
 * The path is added only when the executable physically exists.
 */
export function withInstalledNexusCertifyOnPath(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next = { ...env };
  const home = next.HOME?.trim();
  if (!home) return next;

  const userLocalBin = join(home, ".local", "bin");
  const executable = join(
    userLocalBin,
    process.platform === "win32" ? "nexus-certify.exe" : "nexus-certify",
  );
  if (!existsSync(executable)) return next;

  const entries = (next.PATH ?? "").split(delimiter).filter(Boolean);
  if (!entries.includes(userLocalBin)) {
    next.PATH = [userLocalBin, ...entries].join(delimiter);
  }
  return next;
}

function isDevspaceNodeModulesBin(pathEntry: string): boolean {
  const resolvedEntry = resolve(pathEntry);
  if (!resolvedEntry.endsWith(`${sep}node_modules${sep}.bin`)) {
    return false;
  }

  const packageJson = resolve(resolvedEntry, "..", "..", "package.json");
  if (!existsSync(packageJson)) return false;

  try {
    const packageInfo = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown };
    return packageInfo.name === "@waishnav/devspace";
  } catch {
    return false;
  }
}
