import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { delimiter } from "node:path";
import { promisify } from "node:util";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { verifyRepositoryIntelligenceEngineHead } from "./repository-intelligence.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const ARTIFACT_NAME_PREFIX = "repository-intelligence-pr-";
const CLAIM_CEILING = "ADVISORY_EVIDENCE_ONLY" as const;
const SNAPSHOT_SEMANTICS = "PR_EVENT_SNAPSHOT_NOT_TERMINAL_CI" as const;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

const READ_ONLY_OPEN_WORLD_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export interface RepositoryIntelligenceArtifactInput {
  repository: string;
  prNumber: number;
  expectedHead: string;
}

export interface RepositoryIntelligenceArtifactResult {
  schema: "devspace.repository_intelligence_artifact.v1";
  repository: string;
  prNumber: number;
  expectedHead: string;
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
  snapshotSemantics: typeof SNAPSHOT_SEMANTICS;
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

function normalizeInput(input: RepositoryIntelligenceArtifactInput): RepositoryIntelligenceArtifactInput {
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
  return { repository, prNumber: input.prNumber, expectedHead };
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Repository Intelligence artifact ${field} is invalid`);
  return value;
}

export function validateRepositoryIntelligenceArtifactPayload(
  value: unknown,
  expected: RepositoryIntelligenceArtifactInput,
): Omit<RepositoryIntelligenceArtifactResult, "engineHead"> {
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
  if (payload.claimCeiling !== CLAIM_CEILING) {
    throw new Error("Repository Intelligence artifact claim ceiling mismatch");
  }
  if (payload.snapshotSemantics !== SNAPSHOT_SEMANTICS) {
    throw new Error("Repository Intelligence artifact snapshot semantics mismatch");
  }
  if (!Number.isSafeInteger(payload.artifactId) || Number(payload.artifactId) <= 0) {
    throw new Error("Repository Intelligence artifact id is invalid");
  }
  const expectedName = `${ARTIFACT_NAME_PREFIX}${expected.prNumber}-${expected.expectedHead}`;
  if (payload.artifactName !== expectedName) {
    throw new Error("Repository Intelligence artifact name mismatch");
  }
  if (!isDigest(payload.artifactDigest)) {
    throw new Error("Repository Intelligence artifact digest is invalid");
  }
  if (payload.workflowRunId !== null && (!Number.isSafeInteger(payload.workflowRunId) || Number(payload.workflowRunId) <= 0)) {
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

  return {
    schema: "devspace.repository_intelligence_artifact.v1",
    repository: expected.repository,
    prNumber: expected.prNumber,
    expectedHead: expected.expectedHead,
    artifactId: Number(payload.artifactId),
    artifactName: expectedName,
    artifactDigest: payload.artifactDigest,
    workflowRunId: payload.workflowRunId === null ? null : Number(payload.workflowRunId),
    reviewIdentity: [identity[0], identity[1], identity[2], identity[3], identity[4]],
    contentSha256: payload.contentSha256,
    claimCeiling: CLAIM_CEILING,
    readiness: nullableString(payload.readiness, "readiness"),
    cfiStatus: nullableString(payload.cfiStatus, "cfiStatus"),
    eiaDecision: nullableString(payload.eiaDecision, "eiaDecision"),
    snapshotSemantics: SNAPSHOT_SEMANTICS,
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
    throw new Error("Repository Intelligence artifact consumption requires a configured exact engine root and expected HEAD");
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
        "Read and canonically verify the exact GitHub Actions Repository Intelligence artifact for one PR head. Returns advisory PR-event snapshot evidence only; it does not prove terminal CI, accept a Candidate, dispatch workers, approve, merge, release, or activate runtime state.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Workspace to use. Reuse the current project's workspaceId."),
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).describe("GitHub repository in owner/name form."),
        prNumber: z.number().int().positive().describe("Pull request number whose exact-head artifact should be consumed."),
        expectedHead: z.string().regex(/^[0-9a-fA-F]{40}$/).describe("Exact pull-request head SHA expected inside the artifact."),
      },
      annotations: READ_ONLY_OPEN_WORLD_ANNOTATIONS,
    },
    async (input) => {
      workspaces.getWorkspace(input.workspaceId);
      const result = await consumeRepositoryIntelligenceArtifact(config, {
        repository: input.repository,
        prNumber: input.prNumber,
        expectedHead: input.expectedHead,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
