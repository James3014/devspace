import { applyHostActivation, hostActivationManifestPathFromArgv } from "./host-activation.js";

const manifestPath = hostActivationManifestPathFromArgv(process.argv.slice(2));
const operationId = process.env.DEVSPACE_HOST_OPERATION_ID;
const manifestSha256 = process.env.DEVSPACE_HOST_ACTIVATION_MANIFEST_SHA256;
const writePaths = parseScope(process.env.DEVSPACE_HOST_ACTIVATION_WRITE_PATHS);
const readPaths = parseScope(process.env.DEVSPACE_HOST_ACTIVATION_READ_PATHS);

if (!manifestPath || !operationId || !manifestSha256) {
  console.error("Host activation requires --activation-manifest plus DevSpace operation binding environment.");
  process.exit(64);
}

try {
  const receipt = await applyHostActivation(manifestPath, manifestSha256, operationId, writePaths, readPaths);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exit(receipt.classification === "APPLIED" ? 0 : receipt.classification === "ROLLED_BACK" || receipt.classification === "BLOCKED_PREIMAGE_DRIFT" || receipt.classification === "CONFIRMED_NO_EFFECT" ? 2 : 3);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(3);
}

function parseScope(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
  } catch {
    return [];
  }
}
