#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CUTOVER_RELEASE_POINTER_FILENAME,
  verifyReleasePointer,
} from "./cutover-activation.js";

function stableServiceRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function main(): void {
  const serviceRoot = stableServiceRoot();
  const pointerPath = join(serviceRoot, CUTOVER_RELEASE_POINTER_FILENAME);
  if (!existsSync(pointerPath)) {
    throw new Error(
      "DevSpace stable service launcher has no activation pointer; refusing to start an unbound runtime.",
    );
  }

  const pointer = verifyReleasePointer(pointerPath, serviceRoot);
  const cliPath = join(pointer.releasePath, "dist", "cli.js");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVSPACE_STABLE_SERVICE_ROOT: serviceRoot,
    DEVSPACE_ACTIVE_RELEASE_PATH: pointer.releasePath,
    DEVSPACE_ACTIVE_RELEASE_SHA256: pointer.releaseSha256,
    DEVSPACE_ACTIVATION_POINTER_PATH: pointerPath,
    DEVSPACE_ACTIVATION_CUTOVER_ID: pointer.cutoverId,
  };

  process.chdir(pointer.releasePath);
  if (typeof process.execve !== "function") {
    throw new Error(
      "DevSpace stable service launcher requires Node process.execve support.",
    );
  }
  process.execve(
    process.execPath,
    [process.execPath, cliPath, ...process.argv.slice(2)],
    env,
  );
}

main();
