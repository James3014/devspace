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
  detail: string;
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
  if (typeof sourceCommit !== "string" || typeof buildId !== "string") {
    return {
      ...base,
      buildReady: false,
      detail: `Build identity file lacks source_commit/build_id at ${identityPath}.`,
    };
  }
  const matches =
    sourceCommit === input.expected.sourceCommit && buildId === input.expected.buildId;
  return {
    ...base,
    buildReady: matches,
    actualSourceCommit: sourceCommit,
    actualBuildId: buildId,
    detail: matches
      ? "Build identity file matches the bound expected target."
      : "Build identity file does not match the bound expected target.",
  };
}

function identityFileContents(
  identityPath: string,
):
  | { ok: true; value: { source_commit?: unknown; build_id?: unknown } }
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
    const parsed = JSON.parse(raw) as { source_commit?: unknown; build_id?: unknown };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, detail: "malformed JSON" };
  }
}