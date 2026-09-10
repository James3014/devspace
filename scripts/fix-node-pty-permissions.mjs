import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

export function resolveNodePtyPackage(hookUrl = import.meta.url) {
  const require = createRequire(hookUrl);
  let packageJson;
  try {
    packageJson = require.resolve("node-pty/package.json");
  } catch (error) {
    if (
      error?.code === "MODULE_NOT_FOUND" &&
      String(error?.message).split("\n", 1)[0] === "Cannot find module 'node-pty/package.json'"
    )
      return undefined;
    throw error;
  }
  return dirname(packageJson);
}

export async function fixNodePtyPermissions({
  platform = process.platform,
  hookUrl = import.meta.url,
} = {}) {
  if (platform !== "darwin") return;
  const packageRoot = resolveNodePtyPackage(hookUrl);
  if (!packageRoot) return;
  for (const architecture of ["arm64", "x64"]) {
    const helper = join(packageRoot, "prebuilds", `darwin-${architecture}`, "spawn-helper");
    try {
      await chmod(helper, 0o755);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

await fixNodePtyPermissions();
