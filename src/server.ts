import { CarrierBindingStore, type CarrierCompletionBinding } from "./carrier-binding.js";
import type { ControlPlaneConsumerOptions } from "./control-plane-consumer.js";
import { ControlPlaneOwnershipError } from "./control-plane-ownership.js";
import {
  centralAdmissionCheck,
  computeWorkKey,
  computeWorkRequestHash,
  createWorkResumeStore,
  resolveCanonicalPath,
  WorkResumeStore,
} from "./work-resume.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, type ServerNotification, type ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import * as z from "zod/v4";
import { applyPatch, parsePatch, replaceFile } from "./apply-patch.js";
import { commitCandidate, pushCandidate, GitCandidateError } from "./git-candidate.js";
import { fetchRemoteBranchRef } from "./git-worktrees.js";
import { git as runGit } from "./git.js";
import {
  integrateCandidate,
  inspectIntegrationReadiness,
  promoteCandidate,
  probeRemoteWritability,
  type IntegrationApplyResult,
  type IntegrationReadiness,
} from "./git-integration.js";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { loadConfig, readControlPlaneInventory, type ServerConfig, type WidgetMode } from "./config.js";
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
import {
  OAUTH_TOKEN_FAILURE_CLASSES,
  SingleUserOAuthProvider,
  type OAuthTokenFailureClass,
} from "./oauth-provider.js";
import {
  McpSessionRegistry,
  type McpSessionCloseResult,
  type McpSessionDisposalReason,
} from "./mcp-sessions.js";
import {
  CutoverStateError,
  CutoverStateStore,
  CUTOVER_BINDING_REPAIR_SCHEMA,
  CUTOVER_BINDING_REPAIR_REASON,
  type CutoverBindingRepairReceipt,
  type CutoverDrainEvidence,
  type DurableCutoverRecord,
  type ExpectedCutoverIdentity,
} from "./cutover-state.js";

import {
  CutoverBlockedError,
  assertLegacyCutoverUnbound,
  McpCutoverController,
  compareServerIdentity,
  registerCutoverHttpRoutes,
  type CutoverMode,
  type DurableReconciliationWitness,
} from "./mcp-cutover.js";
import type { LocalAgentRecord } from "./local-agent-store.js";
import {
  CutoverBuildNotReadyError,
  CutoverCapabilityManifestDomainMismatchError,
  probeBuildReady,
  probeTargetPackage,
  type BuildReadyProbeResult,
} from "./cutover-build-ready.js";
import { CutoverOrchestrator, type AdvanceOptions, type OrchestrationOutcome } from "./cutover-orchestration.js";
import {
  createLaunchdSelfRestartActuator,
  type SelfRestartActuator,
} from "./cutover-restart.js";
import type { WorkspaceSession } from "./workspace-store.js";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import {
  DurableOperationManager,
  planCutoverStart,
  DurableOperationError,
  NEXUS_GATEWAY_RECOVERY_SCHEMA,
  NEXUS_GATEWAY_RECOVERY_MATERIALIZATION_SCHEMA,
  type DurableOperationRecord,
} from "./durable-operations.js";
import { ChatSwarmMigrationCoordinator, chatSwarmMigrationOperationId } from "./chat-swarm-migration.js";
import { HostOperationError, HostOperationRegistrar } from "./host-operations.js";
import {
  CodexGoalSessionManager,
  type CodexGoalState,
} from "./codex-goal-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { openAiConversationScopeId } from "./request-meta.js";
import { isReadOnlyInspectionCommand } from "./conversation-isolation.js";
import { ChatSwarmLifecycle } from "./chat-swarm-lifecycle.js";
import type { ChatSwarmStore, ChatSwarmMigrationBundle } from "./chat-swarm-store.js";
import { registerChatSwarmTools, chatSwarmToolInputShapes } from "./chat-swarm-tools.js";
import { ChatSwarmRuntimeOwner } from "./chat-swarm-runtime-owner.js";
import { ChatSwarmRuntimeStore } from "./chat-swarm-runtime.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import {
  CoreMutationSessionStore,
  type CoreMutationAdmission,
  type CoreMutationPhysicalSnapshot,
  type CoreMutationSessionRecord,
} from "./core-mutation-session.js";
import {
  coreMutationAdmissionOutput,
  coreMutationCandidateOutput,
  CORE_MUTATION_TEST_ONLY_UNTRUSTED_BYPASS,
  createCoreMutationGuard,
  registerCoreMutationSessionTools,
  type CoreMutationGuard,
} from "./core-mutation-tools.js";
import {
  CoreCandidateAcquisitionObservationStore,
  orchestrateCoreCandidateAcquisition,
  validateCoreRuntimeConfigSync,
} from "./core-candidate-acquisition.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import {
  summarizeLocalAgentProfile,
  loadLocalAgentProfiles,
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProfile,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";
import { isSubagentProviderEnabled } from "./local-agent-config.js";
import {
  loadProfileCatalog,
  type ProfileCatalogEntry,
} from "./local-agent-profile-source.js";
import { acquireOpencodeCatalog, type OpencodeCatalogSnapshot } from "./local-agent-opencode-catalog.js";
import { createMcpOpencodeCatalogSource } from "./local-agent-opencode-mcp-catalog.js";
import { ClineCatalogService, isClineCatalogFresh, validateClineModelAndThinking, type ClineCatalogSnapshot } from "./local-agent-cline-catalog.js";
import { describeRuntimeBuildIdentity, type RuntimeBuildIdentity } from "./build-identity.js";
import {
  applySessionCallerRebind,
  evaluateClientProjectionConvergence,
  unprovenClientProjectionConvergence,
  evaluateSessionConvergence,
  evaluateMultiRoleConvergence,
  type SessionGenerationSnapshot,
  type SessionConvergenceEvaluation,
  type MultiRoleDeploymentEvaluation,
  type ServiceRoleDeploymentIdentity,
} from "./deployment-convergence.js";
import {
  assertExactServiceCatalogGeneration,
  evaluateControlPlaneConvergence,
  ControlPlaneConvergenceError,
  type ControlPlaneConvergenceEvaluation,
  type ControlPlaneInventory,
  type ControlPlaneServiceBinding,
} from "./control-plane-convergence.js";
import {
  deriveLoadedCapabilityManifest,
  mcpToolCatalogGeneration,
  type CapabilityManifest,
} from "./capability-manifest.js";
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
import { parseExecutionContract, type ExecutionContract } from "./local-agent-contract.js";
import {
  assertNexusMutationAdmission,
  nexusAdmissionChangedPathsToHead,
  type NexusMutationAdmissionPointer,
} from "./nexus-mutation-admission.js";
import {
  TOOL_INTENT_IDS,
  TOOL_INTENT_NAMESPACE,
  TOOL_PROJECTION_MANIFEST_SCHEMA,
} from "./execution-protocol.js";
import { LOCAL_EFFECT_PROJECTION_SCHEMA } from "./local-effect-enforcement.js";
import {
  CAPABILITY_DISCOVERY_INDEX_PATH,
  CAPABILITY_DISCOVERY_RECEIPT_SCHEMA,
  NEXUS_CAPABILITY_REPOSITORY,
  renderCapabilityDiscoveryForWorker,
  verifyCapabilityDiscoveryReceipt,
} from "./capability-discovery.js";
import { runToolchainVerifier, resolveToolchainExecutable, listToolchainCatalog } from "./local-agent-toolchains.js";
import {
  runRepositoryIntelligenceOperation,
  type RepositoryIntelligenceOperation,
} from "./repository-intelligence.js";
import { registerRepositoryIntelligenceArtifactTool } from "./repository-intelligence-artifact.js";
import { registerPhysicalHostRegistryTools } from "./physical-host-registry.js";
import { registerHostCapabilitySnapshotTool } from "./host-capability-snapshot.js";
import { assertAllowedPath, canonicalizePath, isPathInsideRoot } from "./roots.js";
import { applyHostStoragePlan, buildHostStoragePlan, resolveHostStorageRoot } from "./host-storage-retention.js";
import { openDatabase } from "./db/client.js";

type Transport = StreamableHTTPServerTransport;
class ReboundTransport extends StreamableHTTPServerTransport {
  constructor(private readonly reboundSessionId: string) {
    super({ sessionIdGenerator: undefined });
  }

  override get sessionId(): string {
    return this.reboundSessionId;
  }
}
class McpSessionRegistrationError extends Error {
  constructor(reason: "capacity_exhausted" | "duplicate_session") {
    super(reason === "capacity_exhausted"
      ? "MCP session capacity exhausted; all resident sessions are in-flight"
      : "MCP session registration rejected for an already-registered session");
    this.name = "McpSessionRegistrationError";
  }
}
const MCP_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const AGENT_SUPERVISION_INTERVAL_MS = 2_000;
const MCP_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

/** Zod schema for the P0 resumable-work pointer carried by write-capable tool inputs. */
function mutationAdmissionSchema() {
  return z.object({
    admissionId: z.string().regex(/^admission-[0-9a-f]{32}$/),
    receiptHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict();
}

function resumableWorkSchema() {
  return z.object({
    workKey: z.string().regex(/^wk_[0-9a-f]{32}$/),
    leaseId: z.string().min(1),
    expectedLeaseVersion: z.number().int().positive(),
    baseRevisionSha: z.string().regex(/^[0-9a-f]{40}$/),
    effectHandle: z.string().optional(),
  });
}

type AgentSelector = {
  profile?: string;
  provider?: LocalAgentProvider;
  model?: string;
  effort?: string;
  cliProviderId?: "cline" | "cline-pass";
};

function agentSelectorShape() {
  return z.object({
    profile: z.string().min(1).optional().describe("Name of an advertised agent profile to run."),
    provider: z.enum(LOCAL_AGENT_PROVIDERS as [LocalAgentProvider, ...LocalAgentProvider[]]).optional()
      .describe("Provider for direct dispatch. Requires model and cannot be combined with profile."),
    model: z.string().trim().min(1).optional()
      .describe("Exact provider model for direct dispatch. Requires provider and cannot be combined with profile."),
    effort: z.string().trim().min(1).optional()
      .describe("Optional provider reasoning effort for direct dispatch."),
    cliProviderId: z.enum(["cline", "cline-pass"]).optional()
      .describe("Exact Cline CLI provider family; valid only when provider=cline."),
  });
}

function validateAgentSelector(value: AgentSelector): string | undefined {
  const hasProfile = value.profile !== undefined;
  const hasDirect = value.provider !== undefined || value.model !== undefined;
  if (hasProfile && value.effort !== undefined) return "effort is only valid with direct provider and model selection.";
  if (value.cliProviderId !== undefined && value.provider !== "cline") return "cliProviderId is only valid with provider=cline.";
  if (hasProfile === hasDirect) {
    return "Provide either profile, or provider and model together.";
  }
  if (hasDirect && (value.provider === undefined || value.model === undefined)) {
    return "Direct dispatch requires both provider and model.";
  }
  return undefined;
}

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderStatus[];
  close(): Promise<void>;
  broadcastToolListChanged(): Promise<number>;
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

const DIRECT_CODING_TOOL_NAMES = new Set<string>([
  toolNames.openWorkspace,
  toolNames.read,
  toolNames.write,
  toolNames.edit,
  toolNames.grep,
  toolNames.glob,
  toolNames.ls,
  toolNames.shell,
  "apply_patch",
  "command_status",
  "workspace_verify",
  "workspace_list_verifiers",
  "workspace_copy_file",
  "git_fetch_ref",
  "host_capability_snapshot",
  "git_commit",
  "git_push",
]);

const DIRECT_DISPATCH_TOOL_NAMES = new Set<string>([
  toolNames.openWorkspace,
  toolNames.read,
  "agent_catalog",
  "agent_preflight",
  "agent_start",
  "agent_status",
  "agent_continue",
  "agent_reconcile",
  "agent_cancel",
  "agent_list",
]);

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
  const directCodingMode = config.toolMode === "minimal";
  const directDispatchMode = config.toolMode === "dispatch";
  if (directDispatchMode) {
    return "Use DevSpace only for direct worker dispatch. Call open_workspace once for the project checkout or isolated worktree, then reuse its workspaceId. Use read only for bounded instruction or result inspection. Use agent_catalog when exact provider/model catalog membership matters, then agent_preflight before launch. Start exactly one worker with agent_start using a stable attemptKey and authorityMode OWNER_DIRECT. For write-capable work, provide expectedHead when known, bounded writePaths, and maxFiles. Poll the same agent with agent_status. Use agent_continue only for one evidence-guided follow-up on that same agentId. After a timeout, disconnect, or ambiguous response, query the same agentId and use agent_reconcile; never redispatch the logical task under a new attemptKey until the original effect is reconciled. Use agent_list to recover durable sessions and agent_cancel only for the exact worker that must be stopped. This surface grants no acceptance, merge, release, or production authority.";
  }
  const artifactInstruction = !directCodingMode && config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
    ? " When the user supplies or generates a file that is not present on the DevSpace host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs."
    : "";
  const showChangesInstruction =
    !directCodingMode && config.widgets === "changes"
      ? " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change; do not skip it because individual file-change tools already returned diffs."
      : "";

  const agentToolsInstruction = !directCodingMode && config.subagents.enabled
    ? " Use agent_start to launch an advertised agent profile as a background subagent. Use agent_status to retrieve result or progress. Use agent_continue for evidence-guided repair in the same session. Use agent_cancel to stop the exact owned worker. Use agent_list to inspect current workspace agent sessions. Do NOT use bash to call `devspace agents` when native agent tools are available."
    : "";

  const gitCandidatesInstruction = config.gitCandidatesEnabled
    ? " Use git_commit to form a scoped Candidate from exact paths. Use git_push to publish Candidate HEAD to a non-default branch. Do not use bash for git mutation."
    : "";

  const codexGoalsInstruction = !directCodingMode && config.codexGoalsEnabled
    ? " When a task should be delegated to the real interactive Codex CLI, use codex_goal_start to launch a /goal session in an open workspace, then poll codex_goal_status, send follow-ups with codex_goal_continue, and stop it with codex_goal_cancel."
    : "";
  const repositoryIntelligenceInstruction = !directCodingMode && config.repositoryIntelligenceRoot
    ? " When normalized repository evidence is already available, prefer the typed repository_intelligence_* tools over bash for canonical Repository Intelligence V1 computation. These tools are read-only and do not fetch GitHub or grant approve/merge authority."
    : "";

  if (config.toolMode === "codex") {
    return `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected. Use ${toolNames.read} for direct file reads, apply_patch for all file modifications, exec_command for inspection, tests, builds, and other commands, and write_stdin to poll or interact with running processes. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.${artifactInstruction}${showChangesInstruction}${agentToolsInstruction}${gitCandidatesInstruction}${codexGoalsInstruction}${repositoryIntelligenceInstruction}`;
  }

  if (config.toolMode === "minimal") {
    return `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree and keep reusing its workspaceId. If a remote branch is not yet local, open the repository checkout, call git_fetch_ref explicitly, then open the isolated worktree with the returned localRef. Use ${toolNames.read} for file inspection; structuredContent contains exact source text and pagination metadata is separate. Use apply_patch for structured multi-hunk changes, ${toolNames.edit} for targeted single-hunk changes, and ${toolNames.write} only for new files or complete rewrites. Use workspace_copy_file for exact cross-workspace regular-file transfer with SHA-256/CAS checks. Use workspace_list_verifiers before workspace_verify. Use ${toolNames.shell} only for tests, builds, git inspection, and package scripts — never to create or modify files.${gitCandidatesInstruction}`;
  }

  const inspection = `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for bounded read-only file inspection. Use ${toolNames.shell} only when shell semantics are actually needed. `;

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

function oauthRequestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  const fields = requestLogFields(req, config);
  delete fields.origin;
  delete fields.referer;
  return fields;
}

function isOAuthTokenFailureClass(value: unknown): value is OAuthTokenFailureClass {
  return typeof value === "string" && Object.values(OAUTH_TOKEN_FAILURE_CLASSES).includes(value as OAuthTokenFailureClass);
}

function classifyOAuthTokenFailure(body: Record<string, unknown>): OAuthTokenFailureClass | undefined {
  if (isOAuthTokenFailureClass(body.failure_class)) return body.failure_class;
  if (body.error === "invalid_request") return OAUTH_TOKEN_FAILURE_CLASSES.REQUEST_SHAPE_VALIDATION;
  return undefined;
}

function classifyOAuthTokenResponse(body: unknown): Record<string, unknown> | unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const response = body as Record<string, unknown>;
  if (typeof response.error !== "string") return body;

  const failureClass = classifyOAuthTokenFailure(response);
  if (failureClass) return { ...response, failure_class: failureClass };
  if (Object.hasOwn(response, "failure_class")) {
    const { failure_class: _unvalidatedFailureClass, ...withoutFailureClass } = response;
    return withoutFailureClass;
  }
  return response;
}

function installOAuthTokenResponseSafety(config: ServerConfig) {
  return (req: Request, res: Response, next: () => void): void => {
    const json = res.json.bind(res) as (body: unknown) => Response;
    res.json = ((body: unknown) => {
      const classified = classifyOAuthTokenResponse(body);
      if (classified && typeof classified === "object" && !Array.isArray(classified) && typeof (classified as Record<string, unknown>).error === "string") {
        const failureClass = classifyOAuthTokenFailure(classified as Record<string, unknown>);
        logEvent(config.logging, "warn", "oauth_token_failure", {
          requestId: res.locals.requestId as string | undefined,
          method: req.method,
          path: "/token",
          oauthError: (classified as Record<string, unknown>).error,
          ...(failureClass ? { failureClass } : {}),
          ...oauthRequestLogFields(req, config),
        });
      }
      return json(classified);
    }) as typeof res.json;
    next();
  };
}

function handleOAuthTokenBodyParseError(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!error || typeof error !== "object" || (error as { type?: unknown }).type !== "entity.parse.failed") {
    next(error);
    return;
  }
  res.status(400).json({
    error: "invalid_request",
    error_description: "Token request validation failed.",
    failure_class: OAUTH_TOKEN_FAILURE_CLASSES.REQUEST_SHAPE_VALIDATION,
  });
}

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

function isRepositoryReadOnlyShellCommand(command: string): boolean {
  if (!isReadOnlyInspectionCommand(command)) return false;
  // This is deliberately not a shell parser. Quoting and escaping can hide a
  // mutating token from whitespace inspection, so ambiguous commands require
  // the Core mutation path instead of being guessed read-only.
  if (/['"\\]/u.test(command)) return false;
  const unsafeOption = /(?:^|\s)(?:(?:-delete|-exec|-execdir|-ok|-okdir|-fprint|-fprint0|-fprintf|-fls|-o|--ext-diff|--textconv)(?=\s|$)|(?:--output|--pre)(?:=|\s))/u;
  return !unsafeOption.test(command.trim());
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

interface ReadPaginationInfo {
  truncated: boolean;
  offset: number;
  limit?: number;
  returnedLines: number;
  totalLines: number;
  remainingLines: number;
  nextOffset?: number;
  notice?: string;
}

async function readExactTextRange(
  path: string,
  inputOffset: number = 1,
  inputLimit?: number,
): Promise<{
  exactContent: string;
  fileSha256: string;
  totalLines: number;
  pagination?: ReadPaginationInfo;
}> {
  const bytes = await readFile(path);
  const text = bytes.toString("utf8");
  const lines = text.split("\n");
  const offset = Math.max(1, inputOffset);
  const startIndex = Math.min(lines.length, offset - 1);
  const endIndex = inputLimit === undefined
    ? lines.length
    : Math.min(lines.length, startIndex + inputLimit);
  const selected = lines.slice(startIndex, endIndex);
  const exactContent = selected.join("\n");
  const returnedLines = selected.length;
  const remainingLines = Math.max(0, lines.length - endIndex);
  const nextOffset = remainingLines > 0 ? endIndex + 1 : undefined;
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");

  return {
    exactContent,
    fileSha256,
    totalLines: lines.length,
    ...(inputLimit !== undefined || offset !== 1
      ? {
          pagination: {
            truncated: remainingLines > 0,
            offset,
            limit: inputLimit,
            returnedLines,
            totalLines: lines.length,
            remainingLines,
            nextOffset,
            ...(nextOffset
              ? { notice: `${remainingLines} more lines in file. Use offset=${nextOffset} to continue.` }
              : {}),
          },
        }
      : {}),
  };
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
    : snapshot.processTreeState && snapshot.processTreeState !== "terminated"
      ? `Process exited, but owned descendant cleanup is ${snapshot.processTreeState}.`
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
    processTreeState: z.enum(["terminated", "still-running", "unknown"]).optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
    coreMutation: z.record(z.string(), z.unknown()).optional(),
  });
}

function processToolResponse(
  tool: string,
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
  coreMutation?: CoreMutationAdmission,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
  const isError = !snapshot.running
    && (snapshot.exitCode !== 0
      || snapshot.timedOut === true
      || (snapshot.processTreeState !== undefined && snapshot.processTreeState !== "terminated"));
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
      processTreeState: snapshot.processTreeState,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
      ...(coreMutation?.bound ? { coreMutation: coreMutationAdmissionOutput(coreMutation) } : {}),
    },
  };
}

async function assertCoreProcessCompletion(
  coreMutation: CoreMutationGuard | undefined,
  workspaceId: string,
  extra: Parameters<CoreMutationGuard["require"]>[0]["extra"],
  snapshot: ProcessSnapshot,
): Promise<void> {
  if (!coreMutation || snapshot.running || !snapshot.coreMutation) return;
  const pointer = { required: true, ...snapshot.coreMutation } as const;
  coreMutation.require({ workspaceId, extra, pointer });
  const physical = await coreMutation.snapshot({ workspaceId, extra, pointer });
  if (physical.scopeEscapePaths.length > 0) {
    throw new Error(
      `[CORE_MUTATION_POST_EFFECT_SCOPE_ESCAPE] PATH_LEVEL_PREWRITE_CONTAINMENT_NOT_PROVEN: shell changed paths outside AcceptanceContract: ${physical.scopeEscapePaths.join(", ")}. No trusted completion claim is available.`,
    );
  }
  if (physical.deletionViolation) {
    throw new Error(
      `[CORE_MUTATION_POST_EFFECT_DELETION_FORBIDDEN] PATH_LEVEL_PREWRITE_CONTAINMENT_NOT_PROVEN: shell deleted paths forbidden by AcceptanceContract: ${physical.deletedPaths.join(", ")}. No trusted completion claim is available.`,
    );
  }
}

async function assertCoreGoalCompletion(
  coreMutation: CoreMutationGuard | undefined,
  workspaceId: string,
  extra: Parameters<CoreMutationGuard["require"]>[0]["extra"],
  state: CodexGoalState,
): Promise<void> {
  if (!coreMutation || !state.terminal || !state.coreMutation) return;
  const pointer = { required: true, ...state.coreMutation } as const;
  coreMutation.require({ workspaceId, extra, pointer });
  const physical = await coreMutation.snapshot({ workspaceId, extra, pointer });
  if (physical.scopeEscapePaths.length > 0) {
    throw new Error(
      `[CORE_MUTATION_POST_EFFECT_SCOPE_ESCAPE] PATH_LEVEL_PREWRITE_CONTAINMENT_NOT_PROVEN: Codex goal changed paths outside AcceptanceContract: ${physical.scopeEscapePaths.join(", ")}. No trusted completion claim is available.`,
    );
  }
  if (physical.deletionViolation) {
    throw new Error(
      `[CORE_MUTATION_POST_EFFECT_DELETION_FORBIDDEN] PATH_LEVEL_PREWRITE_CONTAINMENT_NOT_PROVEN: Codex goal deleted paths forbidden by AcceptanceContract: ${physical.deletedPaths.join(", ")}. No trusted completion claim is available.`,
    );
  }
}

function registerCodexProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
  coreMutation?: CoreMutationGuard,
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
    async ({ workspaceId, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens, attemptKey, timeout }, extra) => {
      const startedAt = performance.now();
      const mutationCapable = !isRepositoryReadOnlyShellCommand(cmd);
      if (mutationCapable) {
        await workspaces.assertConversationMutationAllowed(workspaceId, openAiConversationScopeId(extra._meta));
      }
      const workspace = workspaces.getWorkspace(workspaceId);
      const coreAdmission = mutationCapable && coreMutation
        ? await coreMutation.admit({ workspaceId, extra, pathContainment: "NOT_PROVEN", writerDomain: "PROCESS" })
        : undefined;
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
        ...(coreAdmission?.bound
          ? { coreMutation: { sessionId: coreAdmission.sessionId!, bindingHash: coreAdmission.bindingHash! } }
          : {}),
      });
      await assertCoreProcessCompletion(coreMutation, workspaceId, extra, snapshot);

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
      }, coreAdmission);
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
    async ({ workspaceId, sessionId, chars, columns, rows, yieldTimeMs, maxOutputTokens }, extra) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      let coreAdmission: CoreMutationAdmission | undefined;
      if (chars && chars.length > 0 && coreMutation) {
        const active = coreMutation.active(workspaceId);
        const original = processSessions.getCoreMutationBinding(workspaceId, sessionId);
        if (active && !original) {
          throw new Error("[CORE_BOUND_SESSION_REQUIRED] Historical unbound process input cannot receive retroactive Core provenance.");
        }
        if (original) {
          coreAdmission = await coreMutation.admit({
            workspaceId,
            extra,
            pointer: { required: true, ...original },
            pathContainment: "NOT_PROVEN",
            writerDomain: "PROCESS",
          });
        }
      }
      const snapshot = await processSessions.write({
        workspaceId,
        sessionId,
        chars,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });
      await assertCoreProcessCompletion(coreMutation, workspaceId, extra, snapshot);

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
      }, coreAdmission);
    },
  );
}

function codexGoalStateStructured(state: CodexGoalState, coreMutation?: CoreMutationAdmission): Record<string, unknown> {
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
    processTreeState: state.processTreeState,
    ...(coreMutation?.bound
      ? { coreMutation: coreMutationAdmissionOutput(coreMutation) }
      : state.coreMutation
        ? {
            coreMutation: {
              bound: true,
              claim: "CORE_BOUND_SESSION",
              sessionId: state.coreMutation.sessionId,
              bindingHash: state.coreMutation.bindingHash,
              pathContainment: "NOT_PROVEN",
              pathContainmentEvidence: "PATH_LEVEL_PREWRITE_CONTAINMENT_NOT_PROVEN",
              trustedEngineeringCompletion: false,
            },