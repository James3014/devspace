import { existsSync, mkdirSync, rmSync } from "node:fs";

const legacyTmpRoot = "/tmp";
const createdLegacyTmpRoot = process.platform === "win32" && !existsSync(legacyTmpRoot);

if (createdLegacyTmpRoot) {
  mkdirSync(legacyTmpRoot, { recursive: true });
}

try {
  await import("./process-sessions.test.js");
} finally {
  if (createdLegacyTmpRoot) {
    rmSync(legacyTmpRoot, { recursive: true, force: true });
  }
}
