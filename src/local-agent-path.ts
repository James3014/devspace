import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, resolve, sep } from "node:path";

export function removeDevspaceNodeModulesBinFromPath(pathValue: string): string {
  return pathValue
    .split(delimiter)
    .filter((entry) => entry && !isDevspaceNodeModulesBin(entry))
    .join(delimiter);
}

export function resolveLocalAgentExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    const candidate = resolve(command);
    return executableExists(candidate) ? candidate : undefined;
  }

  const path = env.PATH;
  if (!path) return undefined;
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
    : [""];

  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`);
      if (executableExists(candidate)) return candidate;
    }
  }
  return undefined;
}

function executableExists(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
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
