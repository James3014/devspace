import { execFile } from "node:child_process";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { verifyRepositoryIntelligenceEngineHead } from "./repository-intelligence.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const EVENT_ARTIFACT_NAME_PREFIX = "repository-intelligence-pr-";
const TERMINAL_ARTIFACT_NAME_PREFIX = "repository-intelligence-terminal-pr-";
const CLAIM_CEILING = "ADVISORY_EVIDENCE_ONLY" as const;
const EVENT_SNAPSHOT_SEMANTICS = "PR_EVENT_SNAPSHOT_NOT_TERMINAL_CI" as const;
const TERMINAL_SNAPSHOT_SEMANTICS = "OBSERVED_CHECK_SET_TERMINAL_AFTER_QUIESCENCE" as const;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

const READ_ONLY_OPEN_WORLD_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export type RepositoryIntelligenceSnapshotKind = "event" | "terminal";
export type RepositoryIntelligenceSnapshotSemantics =
  | typeof EVENT_SNAPSHOT_SEMANTICS
  | typeof TERMINAL_SNAPSHOT_SEMANTICS;

export interface RepositoryIntelligenceArtifactInput {
  repository: string;
  prNumber: number;
  expectedHead: string;
  snapshotKind?: RepositoryIntelligenceSnapshotKind;
}

export interface RepositoryIntelligenceArtifactResult {
  schema: "devspace.repository_intelligence_artifact.v1";
  repository: string;
  prNumber: number;
  expectedHead: string;
  snapshotKind: RepositoryIntelligenceSnapshotKind;
  artifactId: number;
  artifactName: string;
  artifactDigest: string;
  workflowRunId: number | null;
  reviewIdentity: [string, number, string, string, string];
  contentSha256: string;
  claimCeiling: typeof CLAIM_CEILING;
  readiness: string | null;
  cfiStatus: string | null;
  eiaDecision: string | null;
  snapshotSemantics: RepositoryIntelligenceSnapshotSemantics;
  engineHead: string;
}

export interface RepositoryIntelligenceArtifactDependencies {
  verifyEngineHead?: typeof verifyRepositoryIntelligenceEngineHead;
  helperPath?: string;
  env?: NodeJS.ProcessEnv;
  runProcess?: (
    executable: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      timeoutMs: number;
      maxOutputBytes: number;
    },
  ) => Promise<{ stdout: string; stderr: string }>;
}

function normalizeInput(input: RepositoryIntelligenceArtifactInput): Required<RepositoryIntelligenceArtifactInput> {
  const repository = input.repository.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Repository Intelligence artifact repository must be owner/name");
  }
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) {
    throw new Error("Repository Intelligence artifact prNumber must be a positive integer");
  }
  const expectedHead = input.expectedHead.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expectedHead)) {
    throw new Error("Repository Intelligence artifact expectedHead must be a full 40-hex SHA");
  }
  const snapshotKind = input.snapshotKind ?? "event";
  if (snapshotKind !== "event" && snapshotKind !== "terminal") {
    throw new Error("Repository Intelligence artifact snapshotKind must be event or terminal");
  }
  return { repository, prNumber: input.prNumber, expectedHead, snapshotKind };
}

function expectedSemantics(kind: RepositoryIntelligenceSnapshotKind): RepositoryIntelligenceSnapshotSemantics {
  return kind === "terminal" ? TERMINAL_SNAPSHOT_SEMANTICS : EVENT_SNAPSHOT_SEMANTICS;
}

function expectedArtifactName(input: Required<RepositoryIntelligenceArtifactInput>): string {
  const prefix = input.snapshotKind === "terminal"
    ? TERMINAL_ARTIFACT_NAME_PREFIX
    : EVENT_ARTIFACT_NAME_PREFIX;
  return `${prefix}${input.prNumber}-${input.expectedHead}`;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`Repository Intelligence artifact ${field} is invalid`);
  }
  return value;
}

export function validateRepositoryIntelligenceArtifactPayload(
  value: unknown,
  expectedInput: RepositoryIntelligenceArtifactInput,
): Omit<RepositoryIntelligenceArtifactResult, "engineHead"> {
  const expected = normalizeInput(expectedInput);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Repository Intelligence artifact helper returned a non-object JSON payload");
  }
  const payload = value as Record<string, unknown>;
  if (payload.schema !== "devspace.repository_intelligence_artifact.v1") {
    throw new Error("Repository Intelligence artifact schema mismatch");
  }
  if (
    payload.repository !== expected.repository
    || payload.prNumber !== expected.prNumber
    || payload.expectedHead !== expected.expectedHead
  ) {
    throw new Error("Repository Intelligence artifact subject mismatch");
  }
  if (payload.snapshotKind !== expected.snapshotKind) {
    throw new Error("Repository Intelligence artifact snapshot kind mismatch");
  }
  if (payload.claimCeiling !== CLAIM_CEILING) {
    throw new Error("Repository Intelligence artifact claim ceiling mismatch");
  }
  const semantics = expectedSemantics(expected.snapshotKind);
  if (payload.snapshotSemantics !== semantics) {
    throw new Error("Repository Intelligence artifact snapshot semantics mismatch");
  }
  if (!Number.isSafeInteger(payload.artifactId) || Number(payload.artifactId) <= 0) {
    throw new Error("Repository Intelligence artifact id is invalid");
  }
  const expectedName = expectedArtifactName(expected);
  if (payload.artifactName !== expectedName) {
    throw new Error("Repository Intelligence artifact name mismatch");
  }
  if (!isDigest(payload.artifactDigest)) {
    throw new Error("Repository Intelligence artifact digest is invalid");
  }
  if (
    payload.workflowRunId !== null
    && (!Number.isSafeInteger(payload.workflowRunId) || Number(payload.workflowRunId) <= 0)
  ) {
    throw new Error("Repository Intelligence artifact workflow run id is invalid");
  }
  if (!isSha256(payload.contentSha256)) {
    throw new Error("Repository Intelligence artifact content hash is invalid");
  }
  const identity = payload.reviewIdentity;
  if (!Array.isArray(identity) || identity.length !== 5) {
    throw new Error("Repository Intelligence artifact review identity is invalid");
  }
  if (
    identity[0] !== expected.repository
    || identity[1] !== expected.prNumber
    || identity[2] !== expected.expectedHead
    || typeof identity[3] !== "string"
    || typeof identity[4] !== "string"
    || !/^[0-9a-f]{40}$/.test(identity[3])
    || !/^[0-9a-f]{40}$/.test(identity[4])
  ) {
    throw new Error("Repository Intelligence artifact review identity mismatches requested subject");
  }

  const reviewIdentity: [string, number, string, string, string] = [
    expected.repository,
    expected.prNumber,
    expected.expectedHead,
    identity[3],
    identity[4],
  ];

  return {
    schema: "devspace.repository_intelligence_artifact.v1",
    repository: expected.repository,
    prNumber: expected.prNumber,
    expectedHead: expected.expectedHead,
    snapshotKind: expected.snapshotKind,
    artifactId: Number(payload.artifactId),
    artifactName: expectedName,
    artifactDigest: payload.artifactDigest,
    workflowRunId: payload.workflowRunId === null ? null : Number(payload.workflowRunId),
    reviewIdentity,
    contentSha256: payload.contentSha256,
    claimCeiling: CLAIM_CEILING,
    readiness: nullableString(payload.readiness, "readiness"),
    cfiStatus: nullableString(payload.cfiStatus, "cfiStatus"),
    eiaDecision: nullableString(payload.eiaDecision, "eiaDecision"),
    snapshotSemantics: semantics,
  };
}

async function defaultRunProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

export async function consumeRepositoryIntelligenceArtifact(
  config: Pick<ServerConfig, "repositoryIntelligenceRoot" | "repositoryIntelligenceExpectedHead" | "repositoryIntelligencePythonBin">,
  input: RepositoryIntelligenceArtifactInput,
  dependencies: RepositoryIntelligenceArtifactDependencies = {},
): Promise<RepositoryIntelligenceArtifactResult> {
  const root = config.repositoryIntelligenceRoot;
  const expectedEngineHead = config.repositoryIntelligenceExpectedHead;
  if (!root || !expectedEngineHead) {
    throw new Error(
      "Repository Intelligence artifact consumption requires a configured exact engine root and expected HEAD",
    );
  }
  const normalized = normalizeInput(input);
  const verifyEngineHead = dependencies.verifyEngineHead ?? verifyRepositoryIntelligenceEngineHead;
  const engineHead = await verifyEngineHead(root, expectedEngineHead);
  const helperPath = dependencies.helperPath
    ?? fileURLToPath(new URL("../scripts/consume-rie-artifact.py", import.meta.url));
  const pythonBin = config.repositoryIntelligencePythonBin?.trim() || "python3";
  const baseEnv = dependencies.env ?? process.env;
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPATH: [root, baseEnv.PYTHONPATH].filter(Boolean).join(delimiter),
  };
  const runProcess = dependencies.runProcess ?? defaultRunProcess;

  let stdout: string;
  try {
    ({ stdout } = await runProcess(
      pythonBin,
      [
        helperPath,
        "--repository", normalized.repository,
        "--pr-number", String(normalized.prNumber),
        "--expected-head", normalized.expectedHead,
        "--snapshot-kind", normalized.snapshotKind,
      ],
      {
        cwd: root,
        env,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      },
    ));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Repository Intelligence artifact consumption failed: ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Repository Intelligence artifact helper returned invalid JSON");
  }
  return {
    ...validateRepositoryIntelligenceArtifactPayload(parsed, normalized),
    engineHead,
  };
}

export function registerRepositoryIntelligenceArtifactTool(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
): void {
  if (!config.repositoryIntelligenceRoot || !config.repositoryIntelligenceExpectedHead) return;

  registerAppTool(
    server,
    "repository_intelligence_artifact",
    {
      title: "Repository Intelligence artifact",
      description:
        "Read and canonically verify one exact-head Repository Intelligence GitHub Actions artifact. snapshotKind=event returns PR-event timing only. snapshotKind=terminal returns evidence that the observed external check/status set was terminal and stable after quiescence; it still does not prove required-check completeness, Candidate acceptance, approval, merge readiness, release, or runtime activation.",
      inputSchema: {
        workspaceId: z.string().min(1).describe(
          "Workspace to use. Reuse the current project's workspaceId.",
        ),
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).describe(
          "GitHub repository in owner/name form.",
        ),
        prNumber: z.number().int().positive().describe(
          "Pull request number whose exact-head artifact should be consumed.",
        ),
        expectedHead: z.string().regex(/^[0-9a-fA-F]{40}$/).describe(
          "Exact pull-request head SHA expected inside the artifact.",
        ),
        snapshotKind: z.enum(["event", "terminal"]).optional().describe(
          "Artifact timing kind. Defaults to event for backward compatibility.",
        ),
      },
      _meta: {},
      annotations: READ_ONLY_OPEN_WORLD_ANNOTATIONS,
    },
    async (input) => {
      workspaces.getWorkspace(input.workspaceId);
      const result = await consumeRepositoryIntelligenceArtifact(config, {
        repository: input.repository,
        prNumber: input.prNumber,
        expectedHead: input.expectedHead,
        snapshotKind: input.snapshotKind,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
