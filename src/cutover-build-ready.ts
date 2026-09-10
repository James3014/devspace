import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExpectedCutoverIdentity } from "./cutover-state.js";

export const BUILD_IDENTITY_RELATIVE_PATH = join("generated", "build-identity.json");

export class CutoverBuildNotReadyError extends Error {
  readonly code = "CUTOVER_BUILD_NOT_READY";

  constructor(detail: string) {
    super(
      `[CUTOVER_BUILD_NOT_READY] Refusing to schedule a cutover restart until the target build is verified. ${detail}`,
    );
    this.name = "CutoverBuildNotReadyError";
  }
}

export class CutoverCapabilityManifestDomainMismatchError extends Error {
  readonly code = "CAPABILITY_MANIFEST_DIGEST_DOMAIN_MISMATCH";

  constructor(detail?: string) {
    const message =
      "[CAPABILITY_MANIFEST_DIGEST_DOMAIN_MISMATCH] provided digest is the target build-manifest digest, not devspace.capability_manifest.v1 manifestSha256." +
      (detail ? ` ${detail}` : "");
    super(message);
    this.name = "CutoverCapabilityManifestDomainMismatchError";
  }
}

export interface BuildReadyProbeInput {
  packageRoot: string;
  expected: ExpectedCutoverIdentity;
}

export interface BuildReadyProbeResult {
  buildReady: boolean;
  verifiedBy: "build-identity-file";
  verifiedAt: string;
  expectedSourceCommit: string;
  expectedBuildId: string;
  actualSourceCommit?: string;
  actualBuildId?: string;
  actualBuildManifestSha256?: string;
  domainMismatch?: boolean;
  detail: string;
}

export interface TargetPackageIdentity {
  packageRoot: string;
  sourceCommit: string;
  buildId: string;
  buildManifestSha256?: string;
}

export function probeTargetPackage(packageRoot: string): TargetPackageIdentity {
  const identityPath = join(packageRoot, BUILD_IDENTITY_RELATIVE_PATH);
  const identityFile = identityFileContents(identityPath);
  if (!identityFile.ok) {
    throw new CutoverBuildNotReadyError(
      `Target package at ${packageRoot} identity file not readable: ${identityFile.detail}`,
    );
  }
  const sourceCommit = identityFile.value.source_commit;
  const buildId = identityFile.value.build_id;
  const buildManifestSha256 = identityFile.value.build_manifest_sha256;
  if (typeof sourceCommit !== "string" || typeof buildId !== "string") {
    throw new CutoverBuildNotReadyError(
      `Target package at ${packageRoot} lacks source_commit/build_id.`,
    );
  }
  return {
    packageRoot,
    sourceCommit,
    buildId,
    ...(typeof buildManifestSha256 === "string" ? { buildManifestSha256 } : {}),
  };
}

export function assertNoDigestDomainMismatch(
  expected: Partial<ExpectedCutoverIdentity>,
  targetPackage: { buildManifestSha256?: string },
): void {
  if (
    expected.capabilityManifestSha256 !== undefined &&
    targetPackage.buildManifestSha256 !== undefined &&
    expected.capabilityManifestSha256 === targetPackage.buildManifestSha256
  ) {
    throw new CutoverCapabilityManifestDomainMismatchError();
  }
}

export function probeBuildReady(input: BuildReadyProbeInput): BuildReadyProbeResult {
  const base = {
    verifiedBy: "build-identity-file" as const,
    verifiedAt: new Date().toISOString(),
    expectedSourceCommit: input.expected.sourceCommit,
    expectedBuildId: input.expected.buildId,
  };
  const identityPath = join(input.packageRoot, BUILD_IDENTITY_RELATIVE_PATH);
  const identityFile = identityFileContents(identityPath);
  if (!identityFile.ok) {
    return {
      ...base,
      buildReady: false,
      detail: `Build identity file not readable at ${identityPath}: ${identityFile.detail}`,
    };
  }
  const sourceCommit = identityFile.value.source_commit;
  const buildId = identityFile.value.build_id;
  const buildManifestSha256 = typeof identityFile.value.build_manifest_sha256 === "string"
    ? identityFile.value.build_manifest_sha256
    : undefined;
  if (typeof sourceCommit !== "string" || typeof buildId !== "string") {
    return {
      ...base,
      buildReady: false,
      detail: `Build identity file lacks source_commit/build_id at ${identityPath}.`,
    };
  }
  if (
    buildManifestSha256 !== undefined &&
    input.expected.capabilityManifestSha256 !== undefined &&
    input.expected.capabilityManifestSha256 === buildManifestSha256
  ) {
    return {
      ...base,
      buildReady: false,
      actualSourceCommit: sourceCommit,
      actualBuildId: buildId,
      actualBuildManifestSha256: buildManifestSha256,
      domainMismatch: true,
      detail:
        "[CAPABILITY_MANIFEST_DIGEST_DOMAIN_MISMATCH] provided digest is the target build-manifest digest, not devspace.capability_manifest.v1 manifestSha256.",
    };
  }
  const matches =
    sourceCommit === input.expected.sourceCommit && buildId === input.expected.buildId;
  return {
    ...base,
    buildReady: matches,
    actualSourceCommit: sourceCommit,
    actualBuildId: buildId,
    actualBuildManifestSha256: buildManifestSha256,
    detail: matches
      ? "Build identity file matches the bound expected target."
      : "Build identity file does not match the bound expected target.",
  };
}

function identityFileContents(
  identityPath: string,
):
  | {
      ok: true;
      value: {
        source_commit?: unknown;
        build_id?: unknown;
        build_manifest_sha256?: unknown;
      };
    }
  | { ok: false; detail: string } {
  let raw: string;
  try {
    raw = readFileSync(identityPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const parsed = JSON.parse(raw) as {
      source_commit?: unknown;
      build_id?: unknown;
      build_manifest_sha256?: unknown;
    };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, detail: "malformed JSON" };
  }
}