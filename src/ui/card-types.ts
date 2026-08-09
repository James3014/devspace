import type { App } from "@modelcontextprotocol/ext-apps";
import type { WorkflowRunSummaryView } from "../workflow-ui.js";
import type { WorkflowCallCounts } from "../workflow-view.js";

export type ToolName =
  | "open_workspace"
  | "run_workflow"
  | "workflow_status"
  | "show_changes"
  | "apply_patch"
  | "exec_command"
  | "write_stdin"
  | "read"
  | "write"
  | "edit"
  | "grep"
  | "glob"
  | "ls"
  | "bash";

export type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

export interface WorkspaceWorkflowSummary {
  id: string;
  name: string;
  status: string;
  currentPhase?: string;
  calls?: WorkflowCallCounts;
  updatedAt?: string;
}

export type PatchOperation = "add" | "update" | "delete" | "move";

export interface ToolResultCard {
  tool: ToolName;
  workspaceId?: string;
  path?: string;
  root?: string;
  mode?: "checkout" | "worktree";
  sourceRoot?: string;
  worktree?: {
    path?: string;
    baseRef?: string;
    baseSha?: string;
    dirtySource?: boolean;
    detached?: boolean;
    managed?: boolean;
  };
  status?: string;
  name?: string;
  runId?: string;
  summary?: Record<string, unknown>;
  files?: Array<{
    path?: string;
    previousPath?: string;
    operation?: PatchOperation;
    type?: string;
    additions?: number;
    removals?: number;
  }>;
  payload?: ToolPayload;
  agentsFiles?: Array<{
    path?: string;
    content?: string;
  }>;
  availableAgentsFiles?: Array<{
    path?: string;
  }>;
  skills?: Array<{
    name?: string;
    description?: string;
    path?: string;
  }>;
  activeWorkflows?: Array<WorkflowRunSummaryView | WorkspaceWorkflowSummary>;
  callSummary?: {
    reused?: number;
    live?: number;
    failed?: number;
    running?: number;
    total?: number;
  };
  agentProviders?: Array<{
    name?: string;
  }>;
  agents?: Array<{
    name?: string;
    description?: string;
    provider?: string;
    model?: string;
    effort?: string;
  }>;
  skillDiagnostics?: unknown[];
  instruction?: string;
}

export interface ToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolPayload {
  content?: ToolContent[];
  diff?: string;
  patch?: string;
}

export function isToolName(value: unknown): value is ToolName {
  return (
    value === "open_workspace" ||
    value === "run_workflow" ||
    value === "workflow_status" ||
    value === "show_changes" ||
    value === "apply_patch" ||
    value === "exec_command" ||
    value === "write_stdin" ||
    value === "read" ||
    value === "write" ||
    value === "edit" ||
    value === "grep" ||
    value === "glob" ||
    value === "ls" ||
    value === "bash"
  );
}

export function isReadTool(tool: ToolName): boolean {
  return tool === "read";
}

export function isWriteTool(tool: ToolName): boolean {
  return tool === "write";
}

export function isEditTool(tool: ToolName): boolean {
  return tool === "edit";
}

export function isPatchTool(tool: ToolName): boolean {
  return tool === "apply_patch";
}

export function isSearchTool(tool: ToolName): boolean {
  return tool === "grep" || tool === "glob";
}

export function isShellTool(tool: ToolName): boolean {
  return tool === "bash" || tool === "exec_command" || tool === "write_stdin";
}

export function isReviewTool(tool: ToolName): boolean {
  return tool === "show_changes";
}

export function isWorkflowTool(tool: ToolName): boolean {
  return tool === "run_workflow" || tool === "workflow_status";
}

export function isToolResultCard(value: unknown): value is Omit<ToolResultCard, "tool"> {
  return Boolean(value && typeof value === "object");
}

export function payloadText(payload: ToolPayload | undefined): string {
  return (
    payload?.content
      ?.map((item) => {
        if (item.type === "text") return item.text ?? "";
        return `[${item.mimeType ?? "image"} image payload]`;
      })
      .filter(Boolean)
      .join("\n\n") ?? ""
  );
}

export function summaryNumber(
  summary: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = summary?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isExpandableCard(card: ToolResultCard): boolean {
  if (card.tool === "open_workspace") {
    return (
      Number(card.summary?.agentsFiles ?? 0) > 0 ||
      Number(card.summary?.skills ?? 0) > 0 ||
      Number(card.summary?.skillDiagnostics ?? 0) > 0 ||
      Boolean(card.agentsFiles?.length) ||
      Boolean(card.availableAgentsFiles?.length) ||
      Boolean(card.skills?.length) ||
      Boolean(card.activeWorkflows?.length) ||
      Boolean(card.agentProviders?.length) ||
      Boolean(card.agents?.length) ||
      Boolean(card.skillDiagnostics?.length)
    );
  }

  if (isWorkflowTool(card.tool)) return Boolean(card.runId);

  if (isReviewTool(card.tool)) return Boolean(card.files?.length || card.payload?.patch);
  if (isPatchTool(card.tool)) return Boolean(card.payload?.patch);

  return Boolean(card.payload);
}
