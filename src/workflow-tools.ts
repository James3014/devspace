import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { jsonValueSchema, parseJsonText, type JsonValue } from "./json-types.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import {
  persistWorkflowScriptResult,
  resolveNamedWorkflowScriptResult,
  readWorkflowScriptFileResult,
} from "./workflow-files.js";
import { parseWorkflowScript } from "./workflow-script.js";
import { createWorkflowStore } from "./workflow-store.js";
import {
  WORKFLOW_MCP_YIELD_MS,
  WORKFLOW_LIMITS,
  type AgentProvidersConfig,
  type WorkflowEventRecord,
  type WorkflowRunRecord,
} from "./workflow-types.js";
import { resolveWorkspaceHead } from "./workflow-worktrees.js";
import { spawnWorkflowWorkerFromCli } from "./workflow-cli.js";
import { cancelWorkflowRun } from "./workflow-lifecycle.js";
import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";
import {
  isLocalAgentProvider,
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";
import {
  InvalidWorkflowInputError,
  isWorkflowOperationError,
  serializeWorkflowError,
  WorkflowNotFoundError,
  WorkflowStoredDataError,
} from "./workflow-errors.js";
import {
  loadWorkflowUiCallDetail,
  loadWorkflowUiProject,
  loadWorkflowUiRun,
} from "./workflow-ui.js";

const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
const WORKFLOW_UI_WAIT_MAX_MS = 30_000;

const WORKFLOW_API_CHEATSHEET = `
Workflow scripts (JS only):
  export const meta = { name, description, phases?, defaultProvider?, concurrency? }
  agent(prompt, { label?, phase?, schema?, model?, effort?, profile? | provider?, isolation?: 'worktree' })
  parallel(thunks) → Array<T|null>   // barrier; throw → null
  pipeline(items, ...stages)        // no cross-item barrier
  phase(title); log(msg); args
  workflow(name | { scriptPath }, args?)  // nest depth 1
Bans: Date.now(), Math.random(), new Date() without args.
No writeMode — teach RO vs write in prompts; isolation contains writes.
`.trim();

export function registerWorkflowTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
): void {
  if (!config.subagents) return;

  registerAppTool(
    server,
    "run_workflow",
    {
      title: "Run workflow",
      description:
        `Start a DevSpace Dynamic Workflow in an open workspace. Prefer named scripts or short inline scripts. ` +
        `Poll with workflow_status until terminal. Cancel with workflow_cancel. ${WORKFLOW_API_CHEATSHEET}`,
      inputSchema: {
        workspaceId: z.string().describe("Workspace id from open_workspace."),
        script: z
          .string()
          .optional()
          .describe("Inline workflow script source (export const meta = …)."),
        name: z.string().optional().describe("Named workflow under .devspace/workflows/<name>.js"),
        scriptPath: z
          .string()
          .optional()
          .describe("Existing workflow script path. May be combined with resumeFromRunId."),
        resumeFromRunId: z.string().optional().describe("Prior run id to resume (new run + cache)."),
        args: jsonValueSchema.optional().describe("JSON args passed to script as `args`."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(WORKFLOW_MCP_YIELD_MS)
          .optional()
          .describe(`Ms to wait for early completion (default 2000, max ${WORKFLOW_MCP_YIELD_MS}).`),
      },
      annotations: { readOnlyHint: false },
      _meta: workflowWidgetMeta(config),
    },
    async ({ workspaceId, script, name, scriptPath, resumeFromRunId, args, yieldTimeMs }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const store = createWorkflowStore(config);
      try {
        const providedSources = [script, name, scriptPath].filter((v) => v !== undefined);
        if (providedSources.length > 1 || (providedSources.length === 0 && !resumeFromRunId)) {
          throw new InvalidWorkflowInputError({
            code: providedSources.length === 0 ? "missing_source" : "ambiguous_source",
            message:
              "Provide one of script, name, or scriptPath; resumeFromRunId may accompany that source or reuse the prior script",
          });
        }

        let source: string;
        let scriptHash: string;
        let nameHint: string;
        let priorRunId: string | undefined;
        let priorScriptPath: string | undefined;
        let runSource: "inline" | "named" | "resume" = "inline";

        if (resumeFromRunId) {
          const priorResult = store.getRunResult(resumeFromRunId);
          if (priorResult.isErr()) throw priorResult.error;
          const prior = priorResult.value;
          if (!prior) throw new WorkflowNotFoundError(resumeFromRunId);
          priorRunId = prior.id;
          const overridePath = scriptPath;
          if (script !== undefined) {
            source = script;
            const overrideParsed = parseWorkflowScript(source);
            scriptHash = overrideParsed.scriptHash;
            nameHint = overrideParsed.meta.name;
          } else if (name) {
            const resolvedResult = await resolveNamedWorkflowScriptResult({
              name,
              workspaceRoot: workspace.root,
              stateDir: config.stateDir,
            });
            if (resolvedResult.isErr()) throw resolvedResult.error;
            source = resolvedResult.value.source;
            scriptHash = resolvedResult.value.scriptHash;
            nameHint = resolvedResult.value.nameHint;
          } else {
            priorScriptPath = overridePath ?? prior.scriptPath;
            const resolvedResult = await readWorkflowScriptFileResult(priorScriptPath);
            if (resolvedResult.isErr()) throw resolvedResult.error;
            source = resolvedResult.value.source;
            scriptHash = resolvedResult.value.scriptHash;
            nameHint = overridePath ? resolvedResult.value.nameHint : prior.name;
          }
          runSource = "resume";
          if (args === undefined && prior.argsJson && prior.argsJson !== "null") {
            try {
              args = parseJsonText(prior.argsJson);
            } catch (cause) {
              throw new WorkflowStoredDataError(`${prior.id}.argsJson`, cause);
            }
          }
        } else if (name) {
          const resolvedResult = await resolveNamedWorkflowScriptResult({
            name,
            workspaceRoot: workspace.root,
            stateDir: config.stateDir,
          });
          if (resolvedResult.isErr()) throw resolvedResult.error;
          const resolved = resolvedResult.value;
          source = resolved.source;
          scriptHash = resolved.scriptHash;
          nameHint = resolved.nameHint;
          runSource = "named";
        } else if (scriptPath) {
          const resolvedResult = await readWorkflowScriptFileResult(scriptPath);
          if (resolvedResult.isErr()) throw resolvedResult.error;
          source = resolvedResult.value.source;
          scriptHash = resolvedResult.value.scriptHash;
          nameHint = resolvedResult.value.nameHint;
        } else {
          source = script!;
          const parsed = parseWorkflowScript(source);
          scriptHash = parsed.scriptHash;
          nameHint = parsed.meta.name;
          runSource = "inline";
        }

        const parsed = parseWorkflowScript(source);
        const baseSha = await resolveWorkspaceHead(workspace.root);
        const run = store.createRun({
          name: parsed.meta.name || nameHint,
          source: runSource,
          scriptPath: "pending",
          scriptHash,
          workspaceRoot: workspace.root,
          workspaceId,
          argsJson: JSON.stringify(args ?? null),
          resumedFromRunId: priorRunId,
          baseSha,
        });

        const persistedResult = await persistWorkflowScriptResult({
          stateDir: config.stateDir,
          runId: run.id,
          source,
          preferredName: parsed.meta.name || nameHint,
        });
        if (persistedResult.isErr()) throw persistedResult.error;
        const persisted = persistedResult.value;
        const updated = store.setScriptPathResult(run.id, persisted);
        if (updated.isErr()) throw updated.error;

        const cliEntry = fileURLToPath(
          import.meta.url.replace(/workflow-tools\.(ts|js)$/, "cli.$1"),
        );
        spawnWorkflowWorkerFromCli(run.id, cliEntry);

        const yieldMs = yieldTimeMs ?? 2_000;
        const page = await yieldEvents(store, run.id, 0, yieldMs);
        return toolResult(page, "run_workflow");
      } catch (error) {
        if (isWorkflowOperationError(error)) return workflowToolError(error);
        throw error;
      } finally {
        store.close();
      }
    },
  );

  registerAppTool(
    server,
    "workflow_status",
    {
      title: "Workflow status",
      description: "Drain events for a workflow run; optional long-poll yield.",
      inputSchema: {
        runId: z.string(),
        sinceSeq: z.number().int().min(0).optional(),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(WORKFLOW_MCP_YIELD_MS)
          .optional()
          .describe(`Long-poll ms (default 0, max ${WORKFLOW_MCP_YIELD_MS}).`),
      },
      annotations: { readOnlyHint: true },
      _meta: workflowWidgetMeta(config),
    },
    async ({ runId, sinceSeq, yieldTimeMs }) => {
      const store = createWorkflowStore(config);
      try {
        const runResult = store.getRunResult(runId);
        if (runResult.isErr()) throw runResult.error;
        if (!runResult.value) throw new WorkflowNotFoundError(runId);
        const page = await yieldEvents(store, runId, sinceSeq ?? 0, yieldTimeMs ?? 0);
        return toolResult(page, "workflow_status");
      } catch (error) {
        if (isWorkflowOperationError(error)) return workflowToolError(error);
        throw error;
      } finally {
        store.close();
      }
    },
  );

  registerAppTool(
    server,
    "workflow_cancel",
    {
      title: "Cancel workflow",
      description: "Request cooperative cancel of a running workflow.",
      inputSchema: {
        runId: z.string(),
      },
      annotations: { readOnlyHint: false },
      _meta: {},
    },
    async ({ runId }) => {
      const store = createWorkflowStore(config);
      try {
        const latest = await cancelWorkflowRun(store, runId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ runId, status: latest.status }) }],
          structuredContent: { runId, status: latest.status },
        };
      } catch (error) {
        if (isWorkflowOperationError(error)) return workflowToolError(error);
        throw error;
      } finally {
        store.close();
      }
    },
  );

  if (config.widgets !== "off") {
    registerWorkflowUiTools(server, config, workspaces);
  }
}

function registerWorkflowUiTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
): void {
  registerAppTool(
    server,
    "workspace_workflow_activity",
    {
      title: "Workspace workflow activity",
      description: "Read-only workflow activity for the DevSpace app.",
      inputSchema: {
        workspaceId: z.string(),
        knownVersion: z.string().optional(),
        waitMs: z.number().int().min(0).max(WORKFLOW_UI_WAIT_MAX_MS).optional(),
      },
      annotations: { readOnlyHint: true },
      _meta: appOnlyToolMeta(),
    },
    async ({ workspaceId, knownVersion, waitMs }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const store = createWorkflowStore(config);
      try {
        const project = await waitForProjectSnapshot(
          store,
          workspace.root,
          knownVersion,
          waitMs ?? 0,
        );
        return appToolResult({ workspaceId, project });
      } finally {
        store.close();
      }
    },
  );

  registerAppTool(
    server,
    "workflow_ui_snapshot",
    {
      title: "Workflow UI snapshot",
      description: "Read-only workflow snapshot for the DevSpace app.",
      inputSchema: {
        runId: z.string(),
        knownVersion: z.string().optional(),
        waitMs: z.number().int().min(0).max(WORKFLOW_UI_WAIT_MAX_MS).optional(),
      },
      annotations: { readOnlyHint: true },
      _meta: appOnlyToolMeta(),
    },
    async ({ runId, knownVersion, waitMs }) => {
      const store = createWorkflowStore(config);
      try {
        const run = await waitForRunSnapshot(store, runId, knownVersion, waitMs ?? 0);
        if (!run) throw new WorkflowNotFoundError(runId);
        return appToolResult({ run });
      } finally {
        store.close();
      }
    },
  );

  registerAppTool(
    server,
    "workflow_ui_call_detail",
    {
      title: "Workflow call detail",
      description: "Read-only workflow call detail for the DevSpace app.",
      inputSchema: {
        runId: z.string(),
        callIndex: z.number().int().min(0),
      },
      annotations: { readOnlyHint: true },
      _meta: appOnlyToolMeta(),
    },
    async ({ runId, callIndex }) => {
      const store = createWorkflowStore(config);
      try {
        if (!store.getRun(runId)) throw new WorkflowNotFoundError(runId);
        const call = loadWorkflowUiCallDetail(store, runId, callIndex);
        if (!call) {
          throw new InvalidWorkflowInputError({
            code: "invalid_argument",
            message: `Unknown workflow agent call: ${runId}#${callIndex}`,
          });
        }
        return appToolResult({ call });
      } finally {
        store.close();
      }
    },
  );
}

async function yieldEvents(
  store: ReturnType<typeof createWorkflowStore>,
  runId: string,
  sinceSeq: number,
  yieldMs: number,
): Promise<{
  run: WorkflowRunRecord;
  events: WorkflowEventRecord[];
  nextSeq: number;
  hasMore: boolean;
  terminal: boolean;
  callSummary: ReturnType<typeof summarizeCalls>;
}> {
  const deadline = Date.now() + Math.min(yieldMs, WORKFLOW_MCP_YIELD_MS);
  let cursor = sinceSeq;
  let events: WorkflowEventRecord[] = [];
  let hasMore = false;
  let terminal = false;
  let run = store.getRun(runId)!;

  for (;;) {
    const page = store.drainEvents(runId, cursor, WORKFLOW_LIMITS.eventDrainDefault);
    events = events.concat(page.events);
    cursor = page.nextSeq;
    hasMore = page.hasMore;
    terminal = page.terminal;
    run = page.run;
    if (terminal || Date.now() >= deadline) break;
    if (hasMore) break;
    await sleep(250);
  }

  return {
    run,
    events,
    nextSeq: cursor,
    hasMore,
    terminal,
    callSummary: summarizeCalls(store.listAgentCalls(runId)),
  };
}

function toolResult(page: {
  run: WorkflowRunRecord;
  events: WorkflowEventRecord[];
  nextSeq: number;
  hasMore: boolean;
  terminal: boolean;
  callSummary: ReturnType<typeof summarizeCalls>;
}, tool: "run_workflow" | "workflow_status") {
  const payload = {
    runId: page.run.id,
    status: page.run.status,
    name: page.run.name,
    source: page.run.source,
    scriptPath: page.run.scriptPath,
    scriptHash: page.run.scriptHash,
    resumedFromRunId: page.run.resumedFromRunId,
    callSummary: page.callSummary,
    events: page.events.map((e) => ({
      seq: e.seq,
      type: e.type,
      phase: e.phase,
      label: e.label,
      dataJson: e.dataJson,
    })),
    nextSeq: page.nextSeq,
    hasMore: page.hasMore,
    result: page.run.resultJson ? safeJson(page.run.resultJson) : undefined,
    error: page.run.error,
    errorKind: page.run.errorKind,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    _meta: {
      tool,
      card: {
        runId: page.run.id,
        status: page.run.status,
        name: page.run.name,
      },
    },
  };
}

function workflowWidgetMeta(config: ServerConfig) {
  if (config.widgets !== "full") return {};
  return {
    ui: {
      resourceUri: WORKSPACE_APP_URI,
      visibility: ["model"] as const,
    },
  };
}

function appOnlyToolMeta() {
  return {
    ui: {
      visibility: ["app"] as const,
    },
  };
}

function appToolResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

async function waitForProjectSnapshot(
  store: ReturnType<typeof createWorkflowStore>,
  workspaceRoot: string,
  knownVersion: string | undefined,
  waitMs: number,
) {
  const deadline = Date.now() + Math.min(waitMs, WORKFLOW_UI_WAIT_MAX_MS);
  for (;;) {
    const project = loadWorkflowUiProject(store, workspaceRoot);
    if (knownVersion === undefined || project.version !== knownVersion || Date.now() >= deadline) {
      return project;
    }
    await sleep(250);
  }
}

async function waitForRunSnapshot(
  store: ReturnType<typeof createWorkflowStore>,
  runId: string,
  knownVersion: string | undefined,
  waitMs: number,
) {
  const deadline = Date.now() + Math.min(waitMs, WORKFLOW_UI_WAIT_MAX_MS);
  for (;;) {
    const run = loadWorkflowUiRun(store, runId);
    if (!run || knownVersion === undefined || run.version !== knownVersion || Date.now() >= deadline) {
      return run;
    }
    await sleep(250);
  }
}

function summarizeCalls(calls: ReturnType<ReturnType<typeof createWorkflowStore>["listAgentCalls"]>) {
  return {
    reused: calls.filter((call) => call.fromCache).length,
    live: calls.filter((call) => !call.fromCache && call.status === "completed").length,
    failed: calls.filter((call) => call.status === "failed").length,
    running: calls.filter((call) => call.status === "running").length,
    total: calls.length,
  };
}

function workflowToolError(error: Parameters<typeof serializeWorkflowError>[0]) {
  const payload = { error: serializeWorkflowError(error) };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

function safeJson(text: string): JsonValue {
  try {
    return parseJsonText(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolve enabled ∩ live providers for workflows. */
export function resolveWorkflowEnabledProviders(
  agentProviders: AgentProvidersConfig | undefined,
): LocalAgentProvider[] {
  const snapshot = getLocalAgentProviderAvailabilitySnapshot();
  const live = new Set(
    snapshot.filter((row) => row.available).map((row) => row.name),
  );
  if (!agentProviders) {
    return LOCAL_AGENT_PROVIDERS.filter((id) => live.has(id));
  }
  return agentProviders.enabled.filter(
    (id): id is LocalAgentProvider => isLocalAgentProvider(id) && live.has(id),
  );
}
