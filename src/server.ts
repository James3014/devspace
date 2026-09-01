import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { applyPatch } from "./apply-patch.js";
import { commitCandidate, pushCandidate, GitCandidateError } from "./git-candidate.js";
import {
  integrateCandidate,
  inspectIntegrationReadiness,
  probeRemoteWritability,
} from "./git-integration.js";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import {
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
  sessionIdPrefix,
} from "./logger.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  McpSessionRegistry,
  type McpSessionCloseResult,
} from "./mcp-sessions.js";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import {
  DurableOperationManager,
  DurableOperationError,
  type DurableOperationRecord,
} from "./durable-operations.js";
import {
  CodexGoalSessionManager,
  type CodexGoalState,
} from "./codex-goal-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { openAiConversationScopeId } from "./request-meta.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { summarizeLocalAgentProfile, loadLocalAgentProfiles } from "./local-agent-profiles.js";
import {
  loadProfileCatalog,
  type ProfileCatalogEntry,
} from "./local-agent-profile-source.js";
import { describeRuntimeBuildIdentity, type RuntimeBuildIdentity } from "./build-identity.js";
import { devspaceConfigDir } from "./user-config.js";
import {
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
  formatLocalAgentProviderStatusSummary,
  type LocalAgentProviderStatus,
} from "./local-agent-catalog.js";
import {
  LocalAgentSessionManager,
  AgentSessionError,
  isTerminalStatus,
  AGENT_STATUS_MAX_WAIT_MS,
  AGENT_LIST_MAX_LIMIT,
  AGENT_LIST_DEFAULT_LIMIT,
} from "./local-agent-sessions.js";
import { parseExecutionContract } from "./local-agent-contract.js";
import { runToolchainVerifier, resolveToolchainExecutable } from "./local-agent-toolchains.js";
import {
  runRepositoryIntelligenceOperation,
  type RepositoryIntelligenceOperation,
} from "./repository-intelligence.js";

type Transport = StreamableHTTPServerTransport;
// MCP clients can reconnect without closing the previous transport. Bound stale
// session retention so abandoned MCP servers do not accumulate for the life of the process.
const MCP_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const AGENT_SUPERVISION_INTERVAL_MS = 2_000;
const AGENT_TERMINATION_OUTPUT_SCHEMA = z.object({
  pending: z.boolean(),
  generation: z.string().optional(),
  requestedAt: z.string().optional(),
  failure: z.string().optional(),
  corrupt: z.boolean().optional(),
  blocked: z.boolean().optional(),
  reason: z.string().optional(),
});
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
const COMMAND_STATUS_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const REPOSITORY_INTELLIGENCE_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderStatus[];
  close(): Promise<void>;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

interface DiffStats {
  additions: number;
  removals: number;
}

type ToolWidgetKind =
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
}

type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return kind === "workspace" || kind === "show_changes";
    case "full":
      return true;
  }
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  return {
    _meta: {
      ui: {
        resourceUri: WORKSPACE_APP_URI,
        visibility: ["model"],
      },
    },
  };
}

const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
} as const;

const workspaceIdDescription =
  "Workspace to use. Reuse the current project's workspaceId.";

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  attemptKey?: string;
  sessionId?: number;
  running?: boolean;
  success: boolean;
  durationMs: number;
  error?: string;
}

function serverInstructions(config: ServerConfig): string {
  const artifactInstruction = config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
    ? " When the user supplies or generates a file that is not present on the DevSpace host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs."
    : "";
  const showChangesInstruction =
    config.widgets === "changes"
      ? " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change; do not skip it because individual file-change tools already returned diffs."
      : "";

  const agentToolsInstruction = config.subagents
    ? " Use agent_start to launch an advertised agent profile as a background subagent. Use agent_status to retrieve result or progress. Use agent_continue for evidence-guided repair in the same session. Use agent_cancel to stop the exact owned worker. Use agent_list to inspect current workspace agent sessions. Do NOT use bash to call `devspace agents` when native agent tools are available."
    : "";

  const gitCandidatesInstruction = config.gitCandidatesEnabled
    ? " Use git_commit to form a scoped Candidate from exact paths. Use git_push to publish Candidate HEAD to a non-default branch. Do not use bash for git mutation."
    : "";

  const codexGoalsInstruction = config.codexGoalsEnabled
    ? " When a task should be delegated to the real interactive Codex CLI, use codex_goal_start to launch a /goal session in an open workspace, then poll codex_goal_status, send follow-ups with codex_goal_continue, and stop it with codex_goal_cancel."
    : "";
  const repositoryIntelligenceInstruction = config.repositoryIntelligenceRoot
    ? " When normalized repository evidence is already available, prefer the typed repository_intelligence_* tools over bash for canonical Repository Intelligence V1 computation. These tools are read-only and do not fetch GitHub or grant approve/merge authority."
    : "";

  if (config.toolMode === "codex") {
    return `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected. Use ${toolNames.read} for direct file reads, apply_patch for all file modifications, exec_command for inspection, tests, builds, and other commands, and write_stdin to poll or interact with running processes. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.${artifactInstruction}${showChangesInstruction}${agentToolsInstruction}${gitCandidatesInstruction}${codexGoalsInstruction}${repositoryIntelligenceInstruction}`;
  }

  const inspection = config.toolMode !== "full"
    ? `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `
    : `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;

  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";

  const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;

  return `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected. ${agentsMd}${skills}${inspection}Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.${artifactInstruction}${showChangesInstruction}${agentToolsInstruction}${gitCandidatesInstruction}${codexGoalsInstruction}${repositoryIntelligenceInstruction}`;
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  effort?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const effort = agent.effort ? `, effort ${agent.effort}` : "";
  return `${agent.name} (${agent.provider}${model}${effort})`;
}

function formatAvailableAgentProvider(provider: {
  id: string;
  model?: string;
  effort?: string;
  note?: string;
}): string {
  const details = [
    provider.model ? `model ${provider.model}` : undefined,
    provider.effort ? `effort ${provider.effort}` : undefined,
    provider.note,
  ].filter(Boolean).join(", ");
  return `${provider.id}${details ? ` (${details})` : ""}`;
}

function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  write_mode: z.enum(["read_only", "allowed"]).optional(),
  providerAvailable: z.boolean().optional(),
  providerUnavailableReason: z.string().optional(),
});

const workspaceProfileStatusOutputSchema = z.object({
  name: z.string(),
  provider: z.string(),
  state: z.string(),
  sources: z.array(z.string()),
  model: z.string().optional(),
  effort: z.string().optional(),
  write_mode: z.string().optional(),
  tracked: z.boolean().optional(),
  diagnostic: z.string().optional(),
});

const devspaceBuildOutputSchema = z.object({
  serverInstanceId: z.string(),
  buildId: z.string(),
  sourceCommit: z.string(),
  profileCatalogGeneration: z.string(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  id: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  note: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? (snapshot.attemptKey
        ? `Process running with session ID ${snapshot.sessionId} (attemptKey: ${snapshot.attemptKey}).`
        : `Process running with session ID ${snapshot.sessionId}.`)
    : snapshot.timedOut
      ? `Process timed out and was terminated.`
      : snapshot.signal
        ? `Process exited after signal ${snapshot.signal}.`
        : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    sessionId: z.number().optional(),
    attemptKey: z.string().optional(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    timedOut: z.boolean().optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  });
}

function processToolResponse(
  tool: string,
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
  const isError = !snapshot.running && (snapshot.exitCode !== 0 || snapshot.timedOut === true);
  return {
    content,
    ...(isError ? { isError: true } : {}),
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: { ...summary, ...outputSummary },
        payload: { content },
      },
    },
    structuredContent: {
      result,
      sessionId: snapshot.sessionId,
      attemptKey: snapshot.attemptKey,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      timedOut: snapshot.timedOut,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
    },
  };
}

function registerCodexProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
): void {
  registerAppTool(
    server,
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a command in a workspace. Returns its result when it exits during the yield window, otherwise returns a sessionId for write_stdin. Use this for file inspection, tests, builds, package scripts, and long-running processes.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory relative to the workspace root. Defaults to the workspace root."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait before returning a running session. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
        attemptKey: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)
          .optional()
          .describe("Optional workspace-scoped replay identity for idempotent command execution."),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Command execution deadline in seconds. Defaults to unbounded if omitted."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens, attemptKey, timeout }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      const snapshot = await processSessions.start({
        workspaceId,
        command: cmd,
        cwd,
        workspaceRoot: workspace.root,
        tty,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
        attemptKey,
        timeoutSeconds: timeout,
      });

      logToolCall(config, {
        tool: "exec_command",
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: cmd,
        commandLength: cmd.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("exec_command", workspaceId, snapshot, {
        command: cmd,
        workingDirectory: workingDirectory ?? ".",
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );

  registerAppTool(
    server,
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().describe("Process session identifier returned by exec_command."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait for process output or completion. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, chars, columns, rows, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const snapshot = await processSessions.write({
        workspaceId,
        sessionId,
        chars,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "write_stdin",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("write_stdin", workspaceId, snapshot, {
        sessionId,
        charactersWritten: chars?.length ?? 0,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );
}

function codexGoalStateStructured(state: CodexGoalState): Record<string, unknown> {
  return {
    goalId: state.goalId,
    workspaceId: state.workspaceId,
    running: state.running,
    terminal: state.terminal,
    exitCode: state.exitCode,
    signal: state.signal,
    goalActiveObserved: state.goalActiveObserved,
    wallTimeMs: state.wallTimeMs,
    outputChunk: state.outputChunk,
    outputTruncated: state.outputTruncated,
    model: state.model,
    reasoningEffort: state.reasoningEffort,
    baseHead: state.baseHead,
    terminalReason: state.terminalReason,
    error: state.error,
  };
}

function codexGoalResultText(action: string, state: CodexGoalState): string {
  const status = state.terminal
    ? `terminal (${state.terminalReason ?? "exited"}, exitCode=${state.exitCode ?? "unknown"})`
    : state.goalActiveObserved
      ? "running with Goal Mode active"
      : "running";
  const output = state.outputChunk.trim();
  return [
    `Codex goal ${state.goalId} ${action}: ${status}.`,
    output ? `Output:\n${output}` : undefined,
  ].filter(Boolean).join("\n");
}

function registerCodexGoalTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  goals: CodexGoalSessionManager,
): void {
  const GOAL_START_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  };

  registerAppTool(
    server,
    "codex_goal_start",
    {
      title: "Start Codex goal",
      description:
        "Launch a real interactive Codex CLI session in an open workspace and activate its /goal mode with the given goal text. Runs the actual Codex CLI binary in a PTY inside the exact opened workspace; never uses bash or the Codex SDK. Git workspaces must be clean and must provide expectedHead matching the current Git HEAD. Only one active Codex goal is allowed per workspace.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        goal: z
          .string()
          .min(1)
          .max(20_000)
          .describe("Goal text passed to the interactive /goal command."),
        model: z.string().optional().describe("Codex model to select (for example gpt-5.6-sol). Omit for the CLI default."),
        reasoningEffort: z
          .enum(["minimal", "low", "medium", "high", "xhigh"])
          .optional()
          .describe("Reasoning effort for the selected model."),
        expectedHead: z
          .string()
          .regex(/^[0-9a-fA-F]{40}$/, "expectedHead must be a valid 40-character commit SHA.")
          .optional()
          .describe("Exact 40-character Git HEAD the workspace must be at before launch. Required for Git workspaces; start fails closed when missing or mismatched."),
      },
      outputSchema: {
        goalId: z.string(),
        workspaceId: z.string(),
        running: z.boolean(),
        terminal: z.boolean(),
        exitCode: z.number().int().optional(),
        signal: z.string().optional(),
        goalActiveObserved: z.boolean(),
        wallTimeMs: z.number().nonnegative(),
        outputChunk: z.string(),
        outputTruncated: z.boolean(),
        model: z.string().optional(),
        reasoningEffort: z.string().optional(),
        baseHead: z.string().optional(),
        terminalReason: z.string().optional(),
        error: z.string().optional(),
      },
      _meta: {},
      annotations: GOAL_START_ANNOTATIONS,
    },
    async ({ workspaceId, goal, model, reasoningEffort, expectedHead }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      let state: CodexGoalState;
      try {
        state = await goals.startPrompt({
          workspaceId,
          workspaceRoot: workspace.root,
          goal,
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(expectedHead ? { expectedHead } : {}),
        });
      } catch (error) {
        logFailedToolResponse(config, {
          tool: "codex_goal_start",
          workspaceId,
        }, [textBlock(error instanceof Error ? error.message : String(error))], startedAt);
        throw error;
      }
      logToolCall(config, {
        tool: "codex_goal_start",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(codexGoalResultText("started", state))],
        structuredContent: codexGoalStateStructured(state),
      };
    },
  );

  registerAppTool(
    server,
    "codex_goal_status",
    {
      title: "Codex goal status",
      description:
        "Poll one exact Codex CLI goal session owned by this workspace. Returns running/terminal state, whether Goal Mode was observed active, wall time, and new output since the last poll. Never creates a replacement Codex process.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the goal."),
        goalId: z.string().describe("Exact goal ID returned by codex_goal_start."),
        waitMs: z.number().int().min(0).max(30_000).optional().describe("Milliseconds to poll for new output. Default 0."),
      },
      outputSchema: {
        goalId: z.string(),
        workspaceId: z.string(),
        running: z.boolean(),
        terminal: z.boolean(),
        exitCode: z.number().int().optional(),
        signal: z.string().optional(),
        goalActiveObserved: z.boolean(),
        wallTimeMs: z.number().nonnegative(),
        outputChunk: z.string(),
        outputTruncated: z.boolean(),
        model: z.string().optional(),
        reasoningEffort: z.string().optional(),
        baseHead: z.string().optional(),
        terminalReason: z.string().optional(),
        error: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, goalId, waitMs }) => {
      workspaces.getWorkspace(workspaceId);
      const state = await goals.status(workspaceId, goalId, { waitMs });
      return {
        content: [textBlock(codexGoalResultText("status", state))],
        structuredContent: codexGoalStateStructured(state),
      };
    },
  );

  registerAppTool(
    server,
    "codex_goal_continue",
    {
      title: "Continue Codex goal",
      description:
        "Send a follow-up message into the same live Codex CLI goal session. Rejects unknown, cross-workspace, or already-terminal goals and never spawns a second Codex process.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the goal."),
        goalId: z.string().describe("Exact goal ID returned by codex_goal_start."),
        message: z.string().min(1).max(20_000).describe("Follow-up message for the active goal."),
      },
      outputSchema: {
        goalId: z.string(),
        workspaceId: z.string(),
        running: z.boolean(),
        terminal: z.boolean(),
        exitCode: z.number().int().optional(),
        signal: z.string().optional(),
        goalActiveObserved: z.boolean(),
        wallTimeMs: z.number().nonnegative(),
        outputChunk: z.string(),
        outputTruncated: z.boolean(),
        model: z.string().optional(),
        reasoningEffort: z.string().optional(),
        baseHead: z.string().optional(),
        terminalReason: z.string().optional(),
        error: z.string().optional(),
      },
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, goalId, message }) => {
      workspaces.getWorkspace(workspaceId);
      const state = await goals.continue(workspaceId, goalId, message);
      logToolCall(config, {
        tool: "codex_goal_continue",
        workspaceId,
        success: true,
        durationMs: 0,
      });
      return {
        content: [textBlock(codexGoalResultText("continued", state))],
        structuredContent: codexGoalStateStructured(state),
      };
    },
  );

  registerAppTool(
    server,
    "codex_goal_cancel",
    {
      title: "Cancel Codex goal",
      description:
        "Terminate exactly the Codex CLI process owned by this goal session. Cancelling an already-terminal goal returns its preserved final state. Repeated calls are safe.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the goal."),
        goalId: z.string().describe("Exact goal ID returned by codex_goal_start."),
      },
      outputSchema: {
        goalId: z.string(),
        workspaceId: z.string(),
        running: z.boolean(),
        terminal: z.boolean(),
        exitCode: z.number().int().optional(),
        signal: z.string().optional(),
        goalActiveObserved: z.boolean(),
        wallTimeMs: z.number().nonnegative(),
        outputChunk: z.string(),
        outputTruncated: z.boolean(),
        model: z.string().optional(),
        reasoningEffort: z.string().optional(),
        baseHead: z.string().optional(),
        terminalReason: z.string().optional(),
        error: z.string().optional(),
      },
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, goalId }) => {
      workspaces.getWorkspace(workspaceId);
      const state = await goals.cancel(workspaceId, goalId);
      logToolCall(config, {
        tool: "codex_goal_cancel",
        workspaceId,
        success: true,
        durationMs: 0,
      });
      return {
        content: [textBlock(codexGoalResultText("cancelled", state))],
        structuredContent: codexGoalStateStructured(state),
      };
    },
  );
}

function registerRepositoryIntelligenceTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
): void {
  const root = config.repositoryIntelligenceRoot;
  const expectedHead = config.repositoryIntelligenceExpectedHead;
  if (!root || !expectedHead) return;

  const snapshotSchema = z.record(z.string(), z.unknown());
  const specs: Array<{
    name: string;
    title: string;
    description: string;
    operation: RepositoryIntelligenceOperation;
    inputSchema: Record<string, z.ZodType>;
    extractInput: (input: Record<string, unknown>) => unknown;
  }> = [
    {
      name: "repository_intelligence_revision",
      title: "Repository Intelligence revision",
      description: "Compute canonical Repository Intelligence V1 revision/staleness identity from normalized evidence already supplied by the caller. Read-only: does not fetch GitHub, write state, invoke an LLM, approve, or merge.",
      operation: "revision",
      inputSchema: { workspaceId: z.string().describe(workspaceIdDescription), snapshot: snapshotSchema },
      extractInput: (input) => input.snapshot,
    },
    {
      name: "repository_intelligence_readiness",
      title: "Repository Intelligence readiness",
      description: "Compute canonical Repository Intelligence V1 advisory PR readiness from normalized evidence already supplied by the caller. Read-only: does not fetch GitHub, write state, invoke an LLM, approve, or merge.",
      operation: "readiness",
      inputSchema: { workspaceId: z.string().describe(workspaceIdDescription), snapshot: snapshotSchema },
      extractInput: (input) => input.snapshot,
    },
    {
      name: "repository_intelligence_overlap",
      title: "Repository Intelligence overlap",
      description: "Compute canonical Repository Intelligence V1 cross-PR overlap from normalized snapshot evidence already supplied by the caller. Read-only: does not fetch GitHub, write state, invoke an LLM, approve, or merge.",
      operation: "overlap",
      inputSchema: { workspaceId: z.string().describe(workspaceIdDescription), snapshots: z.array(snapshotSchema) },
      extractInput: (input) => ({ snapshots: input.snapshots }),
    },
    {
      name: "repository_intelligence_ci",
      title: "Repository Intelligence CI evidence",
      description: "Compute canonical Repository Intelligence V1 CI failure evidence from normalized evidence already supplied by the caller. Read-only: does not fetch GitHub, write state, invoke an LLM, approve, or merge.",
      operation: "ci",
      inputSchema: { workspaceId: z.string().describe(workspaceIdDescription), snapshot: snapshotSchema },
      extractInput: (input) => input.snapshot,
    },
    {
      name: "repository_intelligence_impact",
      title: "Repository Intelligence change impact",
      description: "Compute canonical Repository Intelligence V1.1 downstream Change Impact from normalized repository graph evidence already supplied by the caller. Read-only: does not fetch GitHub, parse source, write state, invoke an LLM, approve, or merge.",
      operation: "impact",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        snapshot: snapshotSchema,
        covered_files: z.array(z.string()),
        dependency_edges: z.array(z.object({ consumer: z.string(), dependency: z.string() })),
        observed_symbols: z.record(z.string(), z.array(z.string())).optional(),
        graph_complete: z.boolean(),
        graph_errors: z.array(z.string()).optional(),
      },
      extractInput: (input) => ({
        snapshot: input.snapshot,
        covered_files: input.covered_files,
        dependency_edges: input.dependency_edges,
        observed_symbols: input.observed_symbols ?? {},
        graph_complete: input.graph_complete,
        graph_errors: input.graph_errors ?? [],
      }),
    },
    {
      name: "repository_intelligence_cfi",
      title: "Repository Intelligence CI failure intelligence",
      description: "Compute canonical Repository Intelligence V1.1 CFI triage from normalized CI evidence already supplied by the caller. Read-only and CI_EVIDENCE_ONLY: does not infer root cause, fetch GitHub, write state, invoke an LLM, dispatch a worker, approve, or merge.",
      operation: "cfi",
      inputSchema: { workspaceId: z.string().describe(workspaceIdDescription), snapshot: snapshotSchema },
      extractInput: (input) => input.snapshot,
    },
    {
      name: "repository_intelligence_eia",
      title: "Repository Intelligence external automation advisory",
      description: "Compute canonical Repository Intelligence V1.1 EIA advisory from caller-supplied snapshot or verified CFI report. Read-only and AUTOMATION_ADVISORY_ONLY: READY grants no worker dispatch, GitHub write, approval, merge, or other execution authority.",
      operation: "eia",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        snapshot: snapshotSchema.optional(),
        cfi_report: snapshotSchema.optional(),
      },
      extractInput: (input) => {
        const hasSnapshot = input.snapshot !== undefined;
        const hasCfiReport = input.cfi_report !== undefined;
        if (hasSnapshot === hasCfiReport) {
          throw new Error("Repository Intelligence EIA requires exactly one of snapshot or cfi_report");
        }
        return hasSnapshot ? { snapshot: input.snapshot } : { cfi_report: input.cfi_report };
      },
    },
  ];

  for (const spec of specs) {
    registerAppTool(
      server,
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: REPOSITORY_INTELLIGENCE_TOOL_ANNOTATIONS,
      },
      async (rawInput) => {
        const startedAt = performance.now();
        const input = rawInput as Record<string, unknown>;
        const workspaceId = String(input.workspaceId ?? "");
        workspaces.getWorkspace(workspaceId);
        try {
          const result = await runRepositoryIntelligenceOperation(
            {
              root,
              expectedHead,
              pythonBin: config.repositoryIntelligencePythonBin,
            },
            spec.operation,
            spec.extractInput(input),
          );
          logToolCall(config, {
            tool: spec.name,
            workspaceId,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return {
            content: [textBlock(JSON.stringify(result, null, 2))],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logToolCall(config, {
            tool: spec.name,
            workspaceId,
            success: false,
            durationMs: Math.round(performance.now() - startedAt),
            error: message.slice(0, 240),
          });
          return {
            content: [textBlock(message)],
            isError: true,
            structuredContent: { error: message },
          };
        }
      },
    );
  }
}

export interface RuntimeBuildIdentityContext {
  identity: RuntimeBuildIdentity;
  latestProfileCatalogGeneration: { value: string };
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  agentSessionManager?: LocalAgentSessionManager,
  codexGoals?: CodexGoalSessionManager,
  runtimeBuildIdentityContext?: RuntimeBuildIdentityContext,
  durableOperations?: DurableOperationManager,
): McpServer {
  const runtimeBuildIdentity = runtimeBuildIdentityContext?.identity
    ?? describeRuntimeBuildIdentity({
      env: process.env,
      listenPort: config.port,
      configRoot: devspaceConfigDir(process.env),
      stateRoot: config.stateDir,
      profileCatalogGeneration: "unresolved",
    });
  const latestProfileCatalogGeneration = runtimeBuildIdentityContext?.latestProfileCatalogGeneration
    ?? { value: runtimeBuildIdentity.profileCatalogGeneration };
  const server = new McpServer(
    {
      name: "devspace",
      title: "DevSpace",
      version: "0.1.0",
      description:
        "Coding tools for project workspaces. Open each project or worktree once, then reuse its workspaceId.",
    },
    {
      instructions: serverInstructions(config),
    },
  );

  registerRepositoryIntelligenceTools(server, config, workspaces);

  registerAppResource(
    server,
    "DevSpace Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing DevSpace file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config),
            _meta: {
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );

  registerAppTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Start work in a project directory or isolated worktree when no usable workspaceId exists for it. During continued work, reuse the existing workspaceId instead of calling this tool again. By default this uses the actual checkout; set mode=\"worktree\" for isolated or parallel work.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout, which works in the actual directory. Use worktree for isolated or parallel Git work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema).optional(),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
        skills: z.array(workspaceSkillOutputSchema).optional(),
        agentProviders: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
        agents: z.array(workspaceLocalAgentOutputSchema).optional(),
        agentProfileStatuses: z.array(workspaceProfileStatusOutputSchema).optional(),
        devspaceBuild: devspaceBuildOutputSchema,
        skillDiagnostics: z.array(z.unknown()).optional(),
        instruction: z.string(),
      },
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef }, { _meta }) => {
      const startedAt = performance.now();
      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        workspaceReused,
        includeBootstrapContext,
      } = await workspaces.openWorkspace(
        { path, mode, baseRef },
        { conversationScopeId: openAiConversationScopeId(_meta) },
      );
      if (config.widgets === "changes") {
        await reviewCheckpoints.initializeWorkspace({
          workspaceId: workspace.id,
          root: workspace.root,
        });
      }
      const cardSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const agentCatalog = buildLocalAgentCatalog(
        config.subagents,
        workspace.agentProfiles,
        resolveLocalAgentProviders(),
      );
      const cardAgentProviders = agentCatalog.providers
        .filter((provider) => provider.usable)
        .map((provider) => ({
          id: provider.id,
          model: provider.model,
          effort: provider.effort,
          note: provider.note,
        }));
      const cardAgents = agentCatalog.profiles;
      const cardProfileStatuses = (workspace.profileCatalogEntries ?? []).map(
        (entry: ProfileCatalogEntry) => ({
          name: entry.name,
          provider: entry.provider,
          state: entry.state,
          sources: entry.sources,
          ...(entry.model ? { model: entry.model } : {}),
          ...(entry.effort ? { effort: entry.effort } : {}),
          ...(entry.write_mode ? { write_mode: entry.write_mode } : {}),
          ...(entry.tracked !== undefined ? { tracked: entry.tracked } : {}),
          ...(entry.diagnostic ? { diagnostic: entry.diagnostic } : {}),
        }),
      );
      const devspaceBuildReceipt = {
        serverInstanceId: runtimeBuildIdentity.serverInstanceId,
        buildId: runtimeBuildIdentity.buildId,
        sourceCommit: runtimeBuildIdentity.sourceCommit,
        profileCatalogGeneration: workspace.profileCatalogGeneration ?? "unresolved",
      };
      latestProfileCatalogGeneration.value = devspaceBuildReceipt.profileCatalogGeneration;
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const visibleSkills = includeBootstrapContext ? cardSkills : [];
      const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
      const visibleAgents = includeBootstrapContext ? cardAgents : [];
      const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
      const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
      const cardInstruction = config.skillsEnabled
        ? "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
        : "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
      const instruction = workspaceReused
        ? [
            `Workspace already open as ${workspace.id}.`,
            "Continue with this workspaceId.",
            "Keep following the project instructions, nested instruction files, skills, agent profiles, and diagnostics already provided for this workspace.",
          ].join("\n\n")
        : workspace.mode === "worktree"
          ? "Use this workspaceId for subsequent work in this isolated worktree. Keep reusing it while working in this worktree. Follow the project instructions, nested instruction files, skills, agent profiles, and diagnostics returned for it."
          : cardInstruction;
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            workspaceReused
              ? `Workspace already open as ${workspace.id}.`
              : workspace.mode === "worktree"
                ? `Opened isolated worktree workspace ${workspace.id}.`
                : `Opened workspace ${workspace.id}.`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            visibleAgentProviders.length > 0
              ? `Available subagent providers: ${visibleAgentProviders.map(formatAvailableAgentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
              : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            mode: workspace.mode,
            workspaceReused,
            includeBootstrapContext,
            sourceRoot: workspace.sourceRoot,
            worktree: workspace.worktree,
            agentsFiles: cardAgentsFiles,
            availableAgentsFiles: cardAvailableAgentsFiles,
            skills: cardSkills,
            agentProviders: cardAgentProviders,
            agents: cardAgents,
            agentProfileStatuses: cardProfileStatuses,
            devspaceBuild: devspaceBuildReceipt,
            instruction: cardInstruction,
            summary: {
              mode: workspace.mode,
              agentsFiles: cardAgentsFiles.length,
              availableAgentsFiles: cardAvailableAgentsFiles.length,
              skills: cardSkills.length,
              agentProviders: cardAgentProviders.length,
              agents: cardAgents.length,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          agentProfileStatuses: cardProfileStatuses,
          devspaceBuild: devspaceBuildReceipt,
          ...(includeBootstrapContext
            ? {
                agentsFiles: loadedAgentsFiles,
                availableAgentsFiles: availableAgentsFileOutputs,
                skills: visibleSkills,
                agentProviders: visibleAgentProviders,
                agents: visibleAgents,
                skillDiagnostics: workspace.skillDiagnostics,
              }
            : {}),
          instruction,
        },
      };
    },
  );

  if (durableOperations) {
    const durableOperationOutputSchema = {
      operationId: z.string(),
      attemptKey: z.string(),
      requestHash: z.string(),
      kind: z.enum(["workspace_clone", "dependency_sync"]),
      authorityMode: z.enum(["OWNER_DIRECT", "NEXUS_GOVERNED"]),
      scopeRoot: z.string(),
      workspaceId: z.string().optional(),
      status: z.enum(["started", "succeeded", "failed", "outcome_unknown"]),
      retrySafe: z.boolean(),
      request: z.record(z.string(), z.unknown()),
      receipt: z.record(z.string(), z.unknown()).optional(),
      errorCode: z.string().optional(),
      errorMessage: z.string().optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
    };
    const operationResponse = (operation: DurableOperationRecord) => ({
      content: [textBlock(
        `${operation.kind} ${operation.operationId}: status=${operation.status}, retrySafe=${operation.retrySafe}.`,
      )],
      structuredContent: operation as unknown as Record<string, unknown>,
    });

    registerAppTool(
      server,
      "workspace_clone",
      {
        title: "Clone workspace",
        description:
          "Clone one Git repository into a new or empty destination under a configured allowed root. This is a typed OWNER_DIRECT bootstrap mutation with durable attempt fencing; it never overwrites an existing non-empty destination and never falls back to broad shell mutation.",
        inputSchema: {
          attemptKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)
            .describe("Stable operation identity. Exact replay returns the existing operation; conflicting reuse fails closed."),
          remote: z.string().min(1).describe("Credential-free Git remote URL or local repository path."),
          destination: z.string().min(1).describe("Absolute destination path under a configured allowed root."),
          ref: z.string().min(1).optional().describe("Optional branch or tag to clone as a single branch."),
          authorityMode: z.enum(["OWNER_DIRECT", "NEXUS_GOVERNED"]).default("OWNER_DIRECT")
            .describe("NEXUS_GOVERNED remains fail-closed until an external Nexus grant validator is wired."),
        },
        outputSchema: durableOperationOutputSchema,
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ attemptKey, remote, destination, ref, authorityMode }) => {
        try {
          const operation = await durableOperations.workspaceClone({
            attemptKey,
            remote,
            destination,
            ref,
            authorityMode,
          });
          return operationResponse(operation);
        } catch (error) {
          if (error instanceof DurableOperationError && error.operation) {
            return {
              content: [textBlock(`${error.code}: ${error.message}`)],
              isError: true,
              structuredContent: error.operation as unknown as Record<string, unknown>,
            };
          }
          throw error;
        }
      },
    );

    registerAppTool(
      server,
      "dependency_sync",
      {
        title: "Synchronize dependencies",
        description:
          "Synchronize an existing workspace using a conservative frozen dependency recipe. The operation is durably fenced and verifies dependency specification/lock inputs remain unchanged. It does not add packages, update manifests, or perform global installs.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          attemptKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)
            .describe("Stable operation identity. Exact replay returns the existing operation; conflicting reuse fails closed."),
          recipe: z.enum(["npm_ci", "pnpm_frozen", "uv_frozen"]),
          authorityMode: z.enum(["OWNER_DIRECT", "NEXUS_GOVERNED"]).default("OWNER_DIRECT")
            .describe("NEXUS_GOVERNED remains fail-closed until an external Nexus grant validator is wired."),
        },
        outputSchema: durableOperationOutputSchema,
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ workspaceId, attemptKey, recipe, authorityMode }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        try {
          const operation = await durableOperations.dependencySync({
            workspaceId,
            workspaceRoot: workspace.root,
            attemptKey,
            recipe,
            authorityMode,
          });
          return operationResponse(operation);
        } catch (error) {
          if (error instanceof DurableOperationError && error.operation) {
            return {
              content: [textBlock(`${error.code}: ${error.message}`)],
              isError: true,
              structuredContent: error.operation as unknown as Record<string, unknown>,
            };
          }
          throw error;
        }
      },
    );

    registerAppTool(
      server,
      "operation_status",
      {
        title: "Durable operation status",
        description:
          "Read one exact durable workspace/dependency operation without starting, retrying, or replacing it.",
        inputSchema: { operationId: z.string().min(1) },
        outputSchema: durableOperationOutputSchema,
        _meta: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ operationId }) => {
        const operation = durableOperations.store.getByOperationId(operationId);
        if (!operation) throw new DurableOperationError("RECONCILIATION_REQUIRED", `Unknown durable operation: ${operationId}`);
        return operationResponse(operation);
      },
    );

    registerAppTool(
      server,
      "operation_reconcile",
      {
        title: "Reconcile durable operation",
        description:
          "Reconcile physical state for one exact durable mutating operation after timeout/restart uncertainty. This never re-executes the mutation; unresolved physical truth remains outcome_unknown.",
        inputSchema: { operationId: z.string().min(1) },
        outputSchema: durableOperationOutputSchema,
        _meta: {},
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ operationId }) => operationResponse(await durableOperations.reconcile(operationId)),
    );
  }

  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read a file in a workspace. Use this for file inspection instead of shell commands like cat or sed.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);

      const summary = {
        ...textSummary(response.content),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.read,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description:
        `Create or completely overwrite a file in a workspace. Prefer ${toolNames.edit} for targeted changes to existing files.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description:
        `Edit one file in a workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              diff: response.details?.diff,
              patch: response.details?.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          result: contentText(editContent),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    registerAppTool(
      server,
      "apply_patch",
      {
        title: "Apply patch",
        description:
          "Apply one Codex-style patch in a workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          patch: z
            .string()
            .describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
        },
        outputSchema: resultOutputSchema({
          additions: z.number(),
          removals: z.number(),
          files: z.array(
            z.object({
              path: z.string(),
              previousPath: z.string().optional(),
              operation: z.enum(["add", "update", "delete", "move"]),
            }),
          ),
        }),
        ...toolWidgetDescriptorMeta(config, "edit"),
        annotations: EDIT_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, patch }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const applied = await applyPatch(workspace.root, patch);
        const paths = applied.files.map((file) => file.path).join(", ");
        const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
        const content = [textBlock(result)];
        const displayPath = applied.files.length === 1
          ? applied.files[0]?.path
          : `${applied.files.length} files`;

        logToolCall(config, {
          tool: "apply_patch",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "apply_patch",
            card: {
              workspaceId,
              path: displayPath,
              summary: {
                files: applied.files.length,
                additions: applied.additions,
                removals: applied.removals,
              },
              files: applied.files,
              payload: { patch: applied.patch },
            },
          },
          structuredContent: {
            result,
            additions: applied.additions,
            removals: applied.removals,
            files: applied.files,
          },
        };
      },
    );
  }

  if (config.widgets === "changes") {
    registerAppTool(
      server,
      "show_changes",
      {
        title: "Show changes",
        description:
          "Show the changes made in this turn for an open workspace. Call this once after the final related file change and before your final response so the user can review the combined diff. Do not call it after each individual file change.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "show_changes"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const review = await reviewCheckpoints.reviewChanges({
          workspaceId,
          root: workspace.root,
          markReviewed: true,
        });

        const content = [textBlock(review.result)];
        logToolCall(config, {
          tool: "show_changes",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "show_changes",
            card: {
              workspaceId,
              summary: review.summary,
              files: review.files,
              payload: {
                patch: review.patch,
              },
            },
          },
          structuredContent: {
            result: contentText(content),
          },
        };
      },
    );
  }

  if (config.toolMode === "full") {
    registerAppTool(
      server,
      toolNames.grep,
      {
        title: "Grep",
        description:
          "Search file contents in a workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          pattern: z.string().describe("Search pattern."),
          path: z
            .string()
            .optional()
            .describe(
              "Optional path or glob scope relative to the workspace root.",
            ),
          include: z.string().optional().describe("Optional include glob."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.grep,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.glob,
      {
        title: "Glob",
        description:
          "Find files by glob pattern in a workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          pattern: z.string().describe("File glob pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.glob,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.ls,
      {
        title: "Ls",
        description:
          "List a directory in a workspace. Use this for directory inspection before reading files.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root.",
            ),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "directory"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        workspaces.resolvePath(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = textSummary(response.content);
        logToolCall(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.ls,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );
  }

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.shell,
    {
      title: "Bash",
      description: config.subagents.enabled
        ? (config.toolMode !== "full"
          ? `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, search, file discovery, and directory inspection. In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read} for direct file reads. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication. Do not use bash to call \`devspace agents\` when native agent tools are available.`
          : `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication. Do not use bash to call \`devspace agents\` when native agent tools are available.`)
        : (config.toolMode !== "full"
          ? `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, search, file discovery, and directory inspection. In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read} for direct file reads. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`
          : `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`),

      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        command: z
          .string()
          .describe(
            `Shell command to run. Must not create or modify project files; use ${toolNames.edit} or ${toolNames.write} for file changes.`,
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
        attemptKey: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)
          .describe(
            "Required physical-workspace-scoped command execution identity. Establish before spawn so transport failures (e.g. 502/timeouts) can be safely reconciled. Exact request replays reuse the existing running or completed command session; conflicting reuse fails closed. After transport uncertainty, use command_status with this attemptKey; do not issue a new attemptKey to retry an uncertain execution.",
          ),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait before returning a running session. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, command, timeout, attemptKey, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const snapshot = await processSessions.start({
        workspaceId,
        command,
        cwd,
        workspaceRoot: workspace.root,
        yieldTimeMs,
        timeoutSeconds: timeout ?? 30,
        attemptKey,
        maxOutputTokens,
      });

      const summary = {
        command,
        workingDirectory: workingDirectory ?? ".",
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
        attemptKey: snapshot.attemptKey,
      };

      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command,
        commandLength: command.length,
        success: snapshot.exitCode === 0 || snapshot.running,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse(toolNames.shell, workspaceId, snapshot, summary);
    },
  );
  }

  registerAppTool(
    server,
    "command_status",
    {
      title: "Command status",
      description:
        "Read-only inspection and reconciliation of an existing command session by attemptKey or sessionId. Observe running progress or retrieve terminal result without spawning new processes.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        attemptKey: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)
          .optional()
          .describe("Attempt key of the command session to inspect."),
        sessionId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Process session identifier to inspect."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait for command output or completion if still running. Defaults to 5000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: COMMAND_STATUS_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, attemptKey, sessionId, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const snapshot = await processSessions.getStatus({
        workspaceId,
        workspaceRoot: workspace.root,
        attemptKey,
        sessionId,
        yieldTimeMs: yieldTimeMs ?? 5_000,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "command_status",
        workspaceId,
        attemptKey,
        sessionId: snapshot.sessionId,
        running: snapshot.running,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("command_status", workspaceId, snapshot, {
        attemptKey,
        sessionId: snapshot.sessionId,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );

  if (config.toolMode === "codex") {
    registerCodexProcessTools(server, config, workspaces, processSessions);
  }

  // Narrow opt-in Codex Goal capability. Available in every tool mode, but it
  // exposes only special-purpose goal actions; generic exec_command/write_stdin
  // stay hidden outside codex mode.
  if (config.codexGoalsEnabled && codexGoals) {
    registerCodexGoalTools(server, config, workspaces, codexGoals);
  }

  if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
    registerArtifactTools(server, {
      config,
      workspaces,
      incomingArtifactAdapters,
    });
  }

  // ── Native Agent MCP Tools (only when subagents enabled) ──────────────────
  if (config.subagents && agentSessionManager) {
    const AGENT_TOOL_ANNOTATIONS_WRITE = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    };

    registerAppTool(
      server,
      "agent_start",
      {
        title: "Start agent",
        description:
          "Start a bounded background subagent using an advertised agent profile in an already-open workspace. Returns immediately with a durable agent ID. Use agent_status to retrieve progress/result.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          profile: z.string().describe("Name of an advertised agent profile to run."),
          prompt: z.string().describe("Task prompt for the agent."),
          attemptKey: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)
            .optional()
            .describe("Optional physical-workspace-scoped replay identity. Exact request replays reuse one durable agent; conflicting reuse fails closed."),
          executionContract: z
            .object({
              expectedHead: z
                .string()
                .describe("40-character commit SHA. If supplied, agent_start fails closed when workspace HEAD no longer matches."),
              writePaths: z
                .array(z.string())
                .describe("Exact intended writable paths relative to the workspace root. Observed and aborted on violation; not a hard sandbox."),
              maxFiles: z
                .number()
                .int()
                .min(1)
                .describe("Maximum number of files the worker may change."),
              toolchainId: z
                .string()
                .describe("Toolchain id used to resolve verifier executables. Must already be configured; Dev MCP does not install toolchains."),
              maxWallMs: z
                .number()
                .int()
                .min(1)
                .describe("Optional wall-clock bound for the whole agent turn."),
              maxStartupMs: z
                .number()
                .int()
                .min(1)
                .describe("Optional wall-clock bound for the startup/readiness phase (turn start -> execution started)."),
              maxExecutionMs: z
                .number()
                .int()
                .min(1)
                .describe("Optional wall-clock bound for semantic provider execution (execution started -> terminal)."),
              idleTimeoutMs: z
                .number()
                .int()
                .min(1)
                .describe("Recorded and surfaced; not auto-enforced (no mid-run activity signal)."),
            })
            .partial()
            .optional()
            .describe("Optional structured execution contract. Records and enforces where/how the worker may run."),
        },
        outputSchema: {
          agentId: z.string(),
          status: z.string(),
          profileName: z.string(),
          provider: z.string(),
          model: z.string().optional(),
          thinking: z.string().optional(),
          workspaceId: z.string().optional(),
          workspaceRoot: z.string(),
          createdAt: z.string(),
          updatedAt: z.string(),
        },
        _meta: {},
        annotations: AGENT_TOOL_ANNOTATIONS_WRITE,
      },
      async ({ workspaceId, profile, prompt, attemptKey, executionContract }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const profileCatalog = await loadProfileCatalog(config, workspace.root);
        const profiles = profileCatalog.profiles;
        let contract;
        try {
          contract = parseExecutionContract(executionContract);
        } catch (error) {
          throw new AgentSessionError(
            "INVALID_EXECUTION_CONTRACT",
            error instanceof Error ? error.message : String(error),
          );
        }
        const output = await agentSessionManager.startAgent({
          workspaceId,
          workspaceRoot: workspace.root,
          profileName: profile,
          prompt,
          profiles,
          profileCatalog,
          attemptKey,
          executionContract: contract,
        });
        logToolCall(config, {
          tool: "agent_start",
          workspaceId,
          success: true,
          durationMs: 0,
        });
        return {
          content: [textBlock(`Started agent ${output.agentId} (${output.profileName}). Use agent_status to check progress.`)],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      },
    );

    registerAppTool(
      server,
      "agent_continue",
      {
        title: "Continue agent",
        description:
          "Continue one exact durable subagent session in the same physical workspace. Reuses the provider session/conversation and returns immediately.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          agentId: z.string().describe("Exact agent ID returned by agent_start."),
          prompt: z.string().describe("Follow-up prompt for the agent."),
        },
        outputSchema: {
          agentId: z.string(),
          status: z.string(),
          profileName: z.string(),
          provider: z.string(),
          model: z.string().optional(),
          thinking: z.string().optional(),
          workspaceId: z.string().optional(),
          workspaceRoot: z.string(),
          createdAt: z.string(),
          updatedAt: z.string(),
          continued: z.boolean(),
        },
        _meta: {},
        annotations: AGENT_TOOL_ANNOTATIONS_WRITE,
      },
      async ({ workspaceId, agentId, prompt }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const profileCatalog = await loadProfileCatalog(config, workspace.root);
        const output = await agentSessionManager.continueAgent({
          workspaceId,
          workspaceRoot: workspace.root,
          agentId,
          prompt,
          profiles: profileCatalog.profiles,
          profileCatalog,
        });
        logToolCall(config, {
          tool: "agent_continue",
          workspaceId,
          success: true,
          durationMs: 0,
        });
        return {
          content: [textBlock(`Continuing agent ${output.agentId} (${output.profileName}). Use agent_status to check progress.`)],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      },
    );

    registerAppTool(
      server,
      "agent_status",
      {
        title: "Agent status",
        description:
          "Retrieve the status and result of a durable subagent session. Optionally poll for up to waitMs milliseconds.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          agentId: z.string().describe("Exact agent ID returned by agent_start."),
          waitMs: z
            .number()
            .int()
            .min(0)
            .max(AGENT_STATUS_MAX_WAIT_MS)
            .optional()
            .describe(`Milliseconds to poll for completion. Default 0, max ${AGENT_STATUS_MAX_WAIT_MS}.`),
        },
        outputSchema: {
          agentId: z.string(),
          workspaceId: z.string().optional(),
          workspaceRoot: z.string(),
          profileName: z.string(),
          provider: z.string(),
          model: z.string().optional(),
          thinking: z.string().optional(),
          providerSessionId: z.string().optional(),
          status: z.string(),
          terminal: z.boolean(),
          latestResponse: z.string().optional(),
          error: z.string().optional(),
          errorCode: z.string().optional(),
          errorRetryable: z.boolean().optional(),
          errorDetails: z.record(z.string(), z.unknown()).optional(),
          createdAt: z.string(),
          updatedAt: z.string(),
          startedAt: z.string().optional(),
          lastActivityAt: z.string().optional(),
          lastFileMutationAt: z.number().optional(),
          wallMs: z.number().optional(),
          idleMs: z.number().optional(),
          changedPaths: z.array(z.string()).optional(),
          terminalReason: z.string().optional(),
          scopeState: z.string().optional(),
          termination: AGENT_TERMINATION_OUTPUT_SCHEMA.optional(),
        },
        _meta: {},
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, agentId, waitMs }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const output = await agentSessionManager.getAgentStatus({
          workspaceId,
          workspaceRoot: workspace.root,
          agentId,
          waitMs,
        });
        const statusLine = output.terminal
          ? `Agent ${agentId} is ${output.status}.`
          : `Agent ${agentId} is ${output.status} (still running).`;
        const responseLine = output.latestResponse ? `\nResponse: ${output.latestResponse}` : "";
        const errorLine = output.error ? `\nError: ${output.error}` : "";
        return {
          content: [textBlock(`${statusLine}${responseLine}${errorLine}`)],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      },
    );

    registerAppTool(
      server,
      "agent_cancel",
      {
        title: "Cancel agent",
        description:
          "Cancel one exact durable subagent session. Persists stopped state first, then terminates only the worker process owned by that agent's PID/token fence.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          agentId: z.string().describe("Exact agent ID returned by agent_start."),
        },
        outputSchema: {
          agentId: z.string(),
          workspaceId: z.string().optional(),
          workspaceRoot: z.string(),
          profileName: z.string(),
          provider: z.string(),
          model: z.string().optional(),
          thinking: z.string().optional(),
          providerSessionId: z.string().optional(),
          status: z.string(),
          terminal: z.boolean(),
          latestResponse: z.string().optional(),
          error: z.string().optional(),
          termination: AGENT_TERMINATION_OUTPUT_SCHEMA.optional(),
          createdAt: z.string(),
          updatedAt: z.string(),
        },
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ workspaceId, agentId }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const output = await agentSessionManager.cancelAgent({
          workspaceId,
          workspaceRoot: workspace.root,
          agentId,
        });
        logToolCall(config, {
          tool: "agent_cancel",
          workspaceId,
          success: true,
          durationMs: 0,
        });
        return {
          content: [textBlock(`Agent ${agentId} is ${output.status}.`)],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      },
    );

    registerAppTool(
      server,
      "agent_list",
      {
        title: "List agents",
        description:
          "List recent durable subagent sessions in the current workspace. Use agent_status for full response/error retrieval.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(AGENT_LIST_MAX_LIMIT)
            .optional()
            .describe(`Maximum number of agents to return. Default ${AGENT_LIST_DEFAULT_LIMIT}, max ${AGENT_LIST_MAX_LIMIT}.`),
        },
        outputSchema: {
          agents: z.array(
            z.object({
              agentId: z.string(),
              profileName: z.string(),
              provider: z.string(),
              model: z.string().optional(),
              thinking: z.string().optional(),
              status: z.string(),
              terminationPending: z.boolean().optional(),
              terminationBlocked: z.boolean().optional(),
              updatedAt: z.string(),
            }),
          ),
        },
        _meta: {},
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, limit }) => {
        const workspace = workspaces.getWorkspace(workspaceId); // boundary check
        const agents = agentSessionManager.listAgents({ workspaceId, workspaceRoot: workspace.root, limit });
        const summary = agents.length === 0
          ? "No agent sessions found for this workspace."
          : `${agents.length} agent session(s) in this workspace.`;
        return {
          content: [textBlock(summary)],
          structuredContent: { agents },
        };
      },
    );

    registerAppTool(
      server,
      "agent_preflight",
      {
        title: "Agent preflight",
        description:
          "Read-only readiness evidence for an exact workspace + agent profile before dispatch. Provider 'configured' is not the same as dispatch-ready; unknown evidence stays unknown. Never exposes credentials and grants no routing/admission authority.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          profile: z.string().describe("Name of an advertised agent profile to check."),
          toolchainId: z.string().optional().describe("Optional toolchain id to check availability for."),
        },
        outputSchema: {
          workspace: z.object({
            workspaceId: z.string(),
            root: z.string(),
            head: z.string().optional(),
            dirty: z.boolean(),
            isolated: z.boolean(),
          }),
          worker: z.object({
            profile: z.string(),
            provider: z.string(),
            model: z.string().optional(),
            thinking: z.string().optional(),
            executionIdentity: z.string(),
            runtimeVersion: z.string().optional(),
          }),
          readiness: z.object({
            profileResolved: z.boolean(),
            providerConfigured: z.boolean(),
            authReady: z.union([z.boolean(), z.string()]),
            providerReachable: z.union([z.boolean(), z.string()]),
            runtimeReady: z.boolean(),
            capacityAvailable: z.boolean(),
            dispatchState: z.enum(["READY", "BLOCKED", "UNKNOWN"]),
          }),
          toolchain: z.object({
            id: z.string(),
            available: z.boolean(),
            executables: z.record(z.string(), z.string()).optional(),
          }),
          blockers: z.array(z.object({ code: z.string(), detail: z.string() })),
          unknowns: z.array(z.string()),
        },
        _meta: {},
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, profile, toolchainId }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const profileCatalog = await loadProfileCatalog(config, workspace.root);
        const profiles = profileCatalog.profiles;
        const output = await agentSessionManager.preflightAgent({
          workspaceId,
          workspaceRoot: workspace.root,
          isolated: workspace.mode === "worktree",
          profileName: profile,
          profiles,
          profileCatalog,
          toolchainId,
        });
        const blockerSummary =
          output.blockers.length > 0
            ? ` Blockers: ${output.blockers.map((blocker) => blocker.code).join(", ")}`
            : "";
        return {
          content: [
            textBlock(
              `Preflight for ${profile}: dispatchState=${output.readiness.dispatchState}.${blockerSummary}`,
            ),
          ],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      },
    );

    registerAppTool(
      server,
      "agent_reconcile",
      {
        title: "Reconcile agent",
        description:
          "Read-only physical reconciliation for an exact durable agent. Reports what actually happened in the workspace regardless of provider/session status. A provider timeout/error does NOT imply no candidate exists. Never retries mutation.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          agentId: z.string().describe("Exact agent ID returned by agent_start."),
        },
        outputSchema: {
          agentId: z.string(),
          agentState: z.string(),
          providerState: z.string().optional(),
          providerSessionId: z.string().optional(),
          terminalReason: z.string().optional(),
          workspace: z.object({ head: z.string().optional(), dirty: z.boolean() }),
          candidate: z.object({
            present: z.boolean(),
            changedPaths: z.array(z.string()),
            unexpectedPaths: z.array(z.string()),
            diffHash: z.string().optional(),
            scopeState: z.string(),
          }),
          activity: z.object({
            startedAt: z.string(),
            lastActivityAt: z.string(),
            lastFileMutationAt: z.number().optional(),
            wallMs: z.number(),
            idleMs: z.number(),
          }),
        },
        _meta: {},
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, agentId }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const output = await agentSessionManager.reconcileAgent({
          workspaceId,
          workspaceRoot: workspace.root,
          isolated: workspace.mode === "worktree",
          agentId,
        });
        const candidateLine = output.candidate.present
          ? `Candidate present (${output.candidate.changedPaths.length} changed path(s), scope=${output.candidate.scopeState}).`
          : "No physical candidate changes detected.";
        return {
          content: [
            textBlock(
              `Agent ${output.agentId} state=${output.agentState}. ${candidateLine}`,
            ),
          ],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      },
    );

    registerAppTool(
      server,
      "workspace_verify",
      {
        title: "Verify workspace",
        description:
          "Run an allowlisted verifier executable from a configured toolchain inside the workspace. Bounded cwd, bounded timeout, structured exit code. Always available; when no compatible toolchain is configured it returns a structured TOOLCHAIN_UNAVAILABLE result instead of installing or repairing toolchains.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          toolchainId: z.string().describe("Configured toolchain id."),
          verifier: z.string().describe("Verifier name defined by the toolchain, e.g. pytest or ruff."),
          args: z.array(z.string()).default([]).describe("Arguments passed to the verifier executable."),
          timeoutMs: z.number().int().min(1).optional().describe("Timeout in milliseconds."),
        },
        outputSchema: {
          ok: z.boolean(),
          error: z
            .object({ code: z.string(), message: z.string() })
            .optional(),
          toolchainId: z.string().optional(),
          verifier: z.string().optional(),
          executable: z.string().optional(),
          exitCode: z.number().nullable().optional(),
          timedOut: z.boolean().optional(),
          durationMs: z.number().optional(),
          stdout: z.string().optional(),
          stderr: z.string().optional(),
        },
        _meta: {},
        annotations: SHELL_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, toolchainId, verifier, args, timeoutMs }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const resolved = resolveToolchainExecutable(config.toolchains, toolchainId, verifier);
        if (!resolved) {
          return {
            content: [
              textBlock(
                `TOOLCHAIN_UNAVAILABLE: toolchain '${toolchainId}' verifier '${verifier}' is not configured or not resolvable.`,
              ),
            ],
            structuredContent: {
              ok: false,
              error: {
                code: "TOOLCHAIN_UNAVAILABLE",
                message: `Toolchain '${toolchainId}' verifier '${verifier}' is not configured or not resolvable.`,
              },
            },
          };
        }
        const result = await runToolchainVerifier({
          toolchains: config.toolchains,
          toolchainId,
          verifier,
          args,
          cwd: workspace.root,
          timeoutMs,
        });
        return {
          content: [
            textBlock(
              `${verifier} exited with code ${result.exitCode ?? "null"} in ${result.durationMs}ms.`,
            ),
          ],
          structuredContent: { ok: true, ...result } as unknown as Record<string, unknown>,
        };
      },
    );
  }

  // ── Candidate integration readiness / typed integration (workspace level) ──
  const candidateRangeInputSchema = {
    sourceWorkspaceId: z.string().describe("Workspace that produced the accepted Candidate commits."),
    candidateBase: z
      .string()
      .regex(/^[0-9a-fA-F]{40}$/)
      .describe("Exact base SHA of the accepted Candidate range (ancestor of candidateHead)."),
    candidateHead: z
      .string()
      .regex(/^[0-9a-fA-F]{40}$/)
      .describe("Exact head SHA of the accepted Candidate range."),
    destinationWorkspaceId: z.string().describe("Destination checkout workspace that should receive the Candidate range."),
    expectedDestinationHead: z
      .string()
      .regex(/^[0-9a-fA-F]{40}$/)
      .describe("Exact HEAD the destination must currently be at."),
    dirtyPolicy: z.enum(["allow_unrelated", "pristine"]).optional(),
  };

  registerAppTool(
    server,
    "candidate_integration_readiness",
    {
      title: "Candidate integration readiness",
      description:
        "Read-only readiness evidence for integrating one exact immutable committed Candidate range (candidateBase..candidateHead) into a destination checkout. Verifies commit/tree/base identities, ancestor relation, destination base, and dirty overlap. Acceptance authority is external and never granted here; technical readiness and Owner acceptance are reported separately. No mutation happens.",
      inputSchema: candidateRangeInputSchema,
      outputSchema: {
        candidateCommitVerified: z.boolean(),
        candidateTreeId: z.string().optional(),
        candidateBaseVerified: z.boolean(),
        candidateBaseIsAncestor: z.boolean(),
        candidateChangedPaths: z.array(z.string()),
        destinationBaseMatches: z.boolean(),
        destinationOverlap: z.string(),
        overlappingPaths: z.array(z.string()),
        unrelatedDestinationDirtyPaths: z.array(z.string()),
        gitStateAvailable: z.boolean(),
        operationExpressible: z.boolean(),
        technicallyReadyToApply: z.boolean(),
        acceptanceStatus: z.string(),
        blockers: z.array(z.object({ code: z.string(), detail: z.string() })),
        unknowns: z.array(z.string()),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sourceWorkspaceId, candidateBase, candidateHead, destinationWorkspaceId, expectedDestinationHead, dirtyPolicy }) => {
      const source = workspaces.getWorkspace(sourceWorkspaceId);
      const destination = workspaces.getWorkspace(destinationWorkspaceId);
      const output = await inspectIntegrationReadiness({
        sourceWorkspaceRoot: source.root,
        candidateBase,
        candidateHead,
        destinationWorkspaceRoot: destination.root,
        expectedDestinationHead,
        dirtyPolicy,
      });
      const blockerSummary = output.blockers.length > 0
        ? ` Blockers: ${output.blockers.map((blocker) => blocker.code).join(", ")}`
        : "";
      return {
        content: [
          textBlock(
            `Integration readiness: technicallyReadyToApply=${output.technicallyReadyToApply}, ownerAcceptance=${output.acceptanceStatus}.${blockerSummary}`,
          ),
        ],
        structuredContent: output as unknown as Record<string, unknown>,
      };
    },
  );

  registerAppTool(
    server,
    "candidate_integrate",
    {
      title: "Integrate candidate",
      description:
        "Apply one exact immutable committed Candidate range (candidateBase..candidateHead) onto a destination checkout after every identity gate passes (commit/tree existence, base ancestry, destination base, dirty-overlap policy). The payload comes only from the committed range; untracked workspace files are never included. Fails closed with the destination unchanged on any mismatch.",
      inputSchema: {
        ...candidateRangeInputSchema,
        confirmApply: z
          .boolean()
          .describe("Must be true to apply. Without it the operation stays read-only preparation."),
      },
      outputSchema: {
        applied: z.boolean(),
        appliedRange: z.object({ base: z.string(), head: z.string() }),
        appliedTrackedFiles: z.number(),
        blockers: z.array(z.object({ code: z.string(), detail: z.string() })),
      },
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ sourceWorkspaceId, candidateBase, candidateHead, destinationWorkspaceId, expectedDestinationHead, dirtyPolicy, confirmApply }) => {
      const source = workspaces.getWorkspace(sourceWorkspaceId);
      const destination = workspaces.getWorkspace(destinationWorkspaceId);
      const output = await integrateCandidate({
        sourceWorkspaceRoot: source.root,
        candidateBase,
        candidateHead,
        destinationWorkspaceRoot: destination.root,
        expectedDestinationHead,
        dirtyPolicy,
        confirmApply,
      });
      const summary = output.applied
        ? `Candidate range integrated (${output.appliedTrackedFiles} changed file(s)).`
        : `Not applied${output.blockers.length > 0 ? `: ${output.blockers.map((blocker) => blocker.code).join(", ")}` : "."}`;
      return {
        content: [textBlock(summary)],
        structuredContent: output as unknown as Record<string, unknown>,
      };
    },
  );

  registerAppTool(
    server,
    "remote_writability_probe",
    {
      title: "Remote writability probe",
      description:
        "Read-only Git remote readiness for a workspace. Reports whether a remote is configured, reachability/auth evidence when safely observable, upstream binding, and never claims push permission: proving it would require a mutating push.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        remoteName: z.string().optional().describe("Remote name. Defaults to origin."),
      },
      outputSchema: {
        remoteName: z.string().optional(),
        remoteUrl: z.string().optional(),
        remoteConfigured: z.boolean(),
        reachable: z.union([z.boolean(), z.string()]),
        credentialsEvidence: z.string(),
        upstreamBranch: z.string().optional(),
        upstreamConfigured: z.boolean(),
        pushPermissionProven: z.string(),
        notes: z.array(z.string()),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, remoteName }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const output = await probeRemoteWritability(workspace.root, remoteName ?? "origin");
      return {
        content: [
          textBlock(
            `Remote '${remoteName ?? "origin"}': configured=${output.remoteConfigured}, reachable=${String(output.reachable)}, push permission proven=${output.pushPermissionProven}.`,
          ),
        ],
        structuredContent: output as unknown as Record<string, unknown>,
      };
    },
  );

  // ── Native Git Candidate MCP Tools (only when gitCandidatesEnabled is true) ──
  if (config.gitCandidatesEnabled) {
    registerAppTool(
      server,
      "git_commit",
      {
        title: "Git Commit Candidate",
        description:
          "Create a scoped Candidate commit from exactly specified paths inside a managed DevSpace worktree.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          expectedHead: z
            .string()
            .regex(/^[0-9a-fA-F]{40}$/)
            .describe("Exact 40-character Git commit hash expected at current HEAD."),
          message: z.string().min(1).describe("Bounded commit message describing the changes."),
          paths: z
            .array(z.string().min(1))
            .min(1)
            .max(100)
            .describe("Workspace-relative file paths to stage and commit."),
        },
        outputSchema: {
          workspaceId: z.string(),
          previousHead: z.string(),
          commitSha: z.string(),
          treeSha: z.string(),
          message: z.string(),
          paths: z.array(z.string()),
          detached: z.boolean(),
          created: z.literal(true),
        },
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ workspaceId, expectedHead, message, paths }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        if (workspace.mode !== "worktree" || !workspace.worktree?.managed) {
          throw new Error(
            "[GIT_MANAGED_WORKTREE_REQUIRED] Git candidate mutations are only allowed on DevSpace-managed worktrees.",
          );
        }
        try {
          const result = await commitCandidate({
            workspaceId,
            workspaceRoot: workspace.root,
            expectedHead,
            message,
            paths,
          });
          return {
            content: [textBlock(`Successfully created Candidate commit ${result.commitSha}`)],
            structuredContent: {
              workspaceId: result.workspaceId,
              previousHead: result.previousHead,
              commitSha: result.commitSha,
              treeSha: result.treeSha,
              message: result.message,
              paths: result.paths,
              detached: result.detached,
              created: true as const,
            },
          };
        } catch (err: any) {
          const code = err instanceof GitCandidateError ? err.code : "GIT_EXECUTION_ERROR";
          throw new Error(`[${code}] ${err.message}`);
        }
      },
    );

    registerAppTool(
      server,
      "git_push",
      {
        title: "Git Push Candidate",
        description:
          "Publish current Candidate HEAD from a managed DevSpace worktree to a non-default remote branch.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
          expectedHead: z
            .string()
            .regex(/^[0-9a-fA-F]{40}$/)
            .describe("Exact 40-character Git commit hash expected at current HEAD."),
          remote: z.string().describe("Configured Git remote name (e.g. 'origin')."),
          branch: z.string().describe("Name of the target non-default remote branch to push to."),
        },
        outputSchema: {
          remote: z.string(),
          branch: z.string(),
          pushedSha: z.string(),
        },
        _meta: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ workspaceId, expectedHead, remote, branch }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        if (workspace.mode !== "worktree" || !workspace.worktree?.managed) {
          throw new Error(
            "[GIT_MANAGED_WORKTREE_REQUIRED] Git candidate mutations are only allowed on DevSpace-managed worktrees.",
          );
        }
        try {
          const result = await pushCandidate({
            workspaceRoot: workspace.root,
            expectedHead,
            remote,
            branch,
          });
          return {
            content: [
              textBlock(`Successfully pushed ${result.pushedSha} to ${result.remote}/${result.branch}`),
            ],
            structuredContent: {
              remote: result.remote,
              branch: result.branch,
              pushedSha: result.pushedSha,
            },
          };
        } catch (err: any) {
          const code = err instanceof GitCandidateError ? err.code : "GIT_EXECUTION_ERROR";
          throw new Error(`[${code}] ${err.message}`);
        }
      },
    );
  }

  return server;
}

export interface CreateServerOptions {
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  const incomingArtifactAdapters = options.incomingArtifactAdapters
    ?? [createOpenAIIncomingArtifactAdapter()];
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new McpSessionRegistry<Transport>();
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager();
  const durableOperations = new DurableOperationManager(config);
  const localAgentProviders = buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );
  const runtimeBuildIdentity = describeRuntimeBuildIdentity({
    env: process.env,
    listenPort: config.port,
    configRoot: devspaceConfigDir(process.env),
    stateRoot: config.stateDir,
    profileCatalogGeneration: "unresolved",
  });
  const latestProfileCatalogGeneration = { value: runtimeBuildIdentity.profileCatalogGeneration };
  const agentSessionManager = config.subagents.enabled
    ? new LocalAgentSessionManager(config, undefined, undefined, undefined, runtimeBuildIdentity)
    : undefined;
  const codexGoals = config.codexGoalsEnabled
    ? new CodexGoalSessionManager(processSessions, { codexBin: config.codexBin })
    : undefined;

  const agentSupervisionTimer = agentSessionManager
    ? setInterval(() => {
        void agentSessionManager.superviseActiveAgents().catch((error) => {
          logEvent(config.logging, "error", "agent_supervision_error", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, AGENT_SUPERVISION_INTERVAL_MS)
    : undefined;
  agentSupervisionTimer?.unref();

  const logSessionCloseResults = (
    reason: "idle_timeout" | "server_shutdown",
    results: McpSessionCloseResult[],
  ) => {
    for (const result of results) {
      if (result.error) {
        logEvent(config.logging, "warn", "mcp_session_close_failed", {
          reason,
          sessionIdPrefix: sessionIdPrefix(result.sessionId),
          error:
            result.error instanceof Error
              ? result.error.message
              : String(result.error),
        });
        continue;
      }

      logEvent(config.logging, "info", "mcp_session_closed", {
        reason,
        sessionIdPrefix: sessionIdPrefix(result.sessionId),
      });
    }
  };

  const sessionCleanupTimer = setInterval(() => {
    void transports
      .closeIdle(MCP_SESSION_IDLE_TIMEOUT_MS)
      .then((results) => logSessionCloseResults("idle_timeout", results));
  }, MCP_SESSION_CLEANUP_INTERVAL_MS);
  sessionCleanupTimer.unref();

  if (config.logging.trustProxy !== false) {
    app.set("trust proxy", config.logging.trustProxy);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "DevSpace",
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      name: "devspace",
      build: {
        package_name: runtimeBuildIdentity.package,
        package_version: runtimeBuildIdentity.version,
        source_commit: runtimeBuildIdentity.sourceCommit,
        source_dirty: runtimeBuildIdentity.sourceDirty,
        build_id: runtimeBuildIdentity.buildId,
        pid: runtimeBuildIdentity.pid,
        listen_port: runtimeBuildIdentity.listenPort,
      },
    });
  });

  // Unauthenticated runtime identity endpoint (same trust level as /healthz).
  // Exposes build/runtime identity only; no secrets, no workspace data.
  app.get("/identity", (_req, res) => {
    res.json({
      ...runtimeBuildIdentity,
      profileCatalogGeneration: latestProfileCatalogGeneration.value,
    });
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
    });

    try {
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.register(newSessionId, transport);
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId && transports.remove(closedSessionId)) {
            logEvent(config.logging, "info", "mcp_session_closed", {
              reason: "transport_close",
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          resolveLocalAgentProviders,
          incomingArtifactAdapters,
          agentSessionManager,
          codexGoals,
          { identity: runtimeBuildIdentity, latestProfileCatalogGeneration },
          durableOperations,
        );
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    localAgentProviders,
    close: () => {
      closePromise ??= (async () => {
        clearInterval(sessionCleanupTimer);
        if (agentSupervisionTimer) clearInterval(agentSupervisionTimer);
        const results = await transports.closeAll();
        logSessionCloseResults("server_shutdown", results);
        codexGoals?.shutdown();
        processSessions.shutdown();
        durableOperations.close();
        agentSessionManager?.close();
        oauthProvider.close();
        workspaceStore.close?.();
      })();
      return closePromise;
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, localAgentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    const artifactDownloadStatus = !config.artifactsEnabled
      ? "disabled"
      : isArtifactDownloadSupportedPlatform()
        ? "enabled"
        : `unsupported on ${process.platform}`;
    console.log(`native artifact download: ${artifactDownloadStatus}`);
    console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);
    if (config.subagents.enabled) {
      console.log(`subagent availability: ${formatLocalAgentProviderAvailabilitySummary(localAgentProviders.map((provider) => ({
        name: provider.id,
        available: provider.available,
        reason: provider.reason ?? provider.note,
      })))}`);
    }
    if (config.codexGoalsEnabled) {
      console.log(`codex goal tools: enabled${config.codexBin ? ` (${config.codexBin})` : ""}`);
    }
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
