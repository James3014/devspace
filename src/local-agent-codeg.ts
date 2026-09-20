import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import {
  LocalAgentProviderError,
  type LocalAgentRunCallbacks,
  type LocalAgentRunInput,
  type LocalAgentRunResult,
} from "./local-agent-runtime.js";

const CODEG_HANDLE_PREFIX = "codeg-work-task:";
const CODEG_TITLE_PREFIX = "[devspace:";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

const CODEG_AGENT_TYPE: Partial<Record<LocalAgentProvider, string>> = {
  codex: "codex",
  opencode: "open_code",
  grok: "grok",
  cline: "cline",
  agy: "antigravity",
};

const CODEG_TERMINAL_SUCCESS = new Set(["review", "done"]);
const CODEG_TERMINAL_FAILURE = new Set(["failed", "canceled"]);

export interface CodegGatewayConfig {
  baseUrl: string;
  token: string;
  providers: Set<LocalAgentProvider>;
  requestTimeoutMs: number;
  pollIntervalMs: number;
}

export interface CodegTaskSnapshot {
  id: number;
  status: string;
  title?: string;
  result_summary?: string | null;
  failure_reason?: string | null;
  last_error?: string | null;
  updated_at?: string | null;
  started_at?: string | null;
  settled_at?: string | null;
  work_branch?: string | null;
  worktree_folder_id?: number | null;
  base_sha?: string | null;
}

interface CodegChangedFile {
  file: string;
  additions: number;
  deletions: number;
}

interface CodegFolderDetail {
  id: number;
  path: string;
}

export interface CodegTaskInspection {
  taskId: number;
  status: string;
  terminal: boolean;
  success: boolean;
  summary?: string;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Codeg timeout/poll configuration must be a positive integer.");
  }
  return parsed;
}

function parseConfiguredProviders(value: string | undefined): Set<LocalAgentProvider> {
  const providers = new Set<LocalAgentProvider>();
  for (const raw of value?.split(",") ?? []) {
    const provider = raw.trim();
    if (!provider) continue;
    if (!(provider in CODEG_AGENT_TYPE)) {
      throw new Error(`Unsupported DEVSPACE_CODEG_PROVIDERS entry '${provider}'.`);
    }
    providers.add(provider as LocalAgentProvider);
  }
  return providers;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("DEVSPACE_CODEG_URL must not contain credentials, query parameters, or fragments.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("DEVSPACE_CODEG_URL must use http or https.");
  }
  const loopback =
    url.hostname === "127.0.0.1"
    || url.hostname === "::1"
    || url.hostname === "[::1]"
    || url.hostname === "localhost";
  if (url.protocol === "http:" && !loopback) {
    throw new Error("Plain HTTP Codeg transport is permitted only on loopback.");
  }
  return url.toString().replace(/\/$/, "");
}

export function resolveCodegGatewayConfig(
  provider: LocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
): CodegGatewayConfig | undefined {
  const providers = parseConfiguredProviders(env.DEVSPACE_CODEG_PROVIDERS);
  if (!providers.has(provider)) return undefined;

  const baseUrl = env.DEVSPACE_CODEG_URL?.trim();
  const token = env.DEVSPACE_CODEG_TOKEN?.trim();
  if (!baseUrl || !token) {
    throw new Error(
      `Codeg backend is selected for '${provider}' but DEVSPACE_CODEG_URL/DEVSPACE_CODEG_TOKEN is incomplete.`,
    );
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    token,
    providers,
    requestTimeoutMs: parsePositiveInteger(
      env.DEVSPACE_CODEG_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    pollIntervalMs: parsePositiveInteger(
      env.DEVSPACE_CODEG_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
    ),
  };
}

export function isCodegProviderEnabled(
  provider: LocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveCodegGatewayConfig(provider, env) !== undefined;
}

export function codegExecutionIdentity(
  provider: LocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
): { identity: string; version: string } | undefined {
  const config = resolveCodegGatewayConfig(provider, env);
  if (!config) return undefined;
  return {
    identity: `codeg:${new URL(config.baseUrl).origin}:${provider}`,
    version: "codeg-http-v1",
  };
}

export function formatCodegTaskHandle(taskId: number): string {
  if (!Number.isInteger(taskId) || taskId <= 0) throw new Error("Invalid Codeg task id.");
  return `${CODEG_HANDLE_PREFIX}${taskId}`;
}

export function parseCodegTaskHandle(handle: string | undefined): number | undefined {
  if (!handle?.startsWith(CODEG_HANDLE_PREFIX)) return undefined;
  const raw = handle.slice(CODEG_HANDLE_PREFIX.length);
  const taskId = Number(raw);
  return Number.isInteger(taskId) && taskId > 0 ? taskId : undefined;
}

export function codegTaskTitle(agentId: string, provider: LocalAgentProvider): string {
  return `${CODEG_TITLE_PREFIX}${agentId}] ${provider}`;
}

function codegModelValue(provider: LocalAgentProvider, model: string | undefined): string | undefined {
  if (!model) return undefined;
  if (provider === "cline" && model.startsWith("z-ai/")) {
    return `zai/${model.slice("z-ai/".length)}`;
  }
  return model;
}

function taskConfig(provider: LocalAgentProvider, input: LocalAgentRunInput): Record<string, unknown> {
  const agentType = CODEG_AGENT_TYPE[provider];
  if (!agentType) throw new Error(`Provider '${provider}' is not supported by the Codeg gateway.`);

  if (input.writeMode !== "allowed") {
    throw new Error(
      `Codeg backend currently requires writeMode=allowed for '${provider}'; read-only enforcement is not proven and will not be widened silently.`,
    );
  }
  if (input.selectedToolIntents !== undefined || input.effectProjection !== undefined) {
    throw new Error(
      "Codeg backend does not expose a proven DevSpace ToolProjection/effect-enforcement seam; refusing projected execution.",
    );
  }

  const configValues: Record<string, string> = {};
  const model = codegModelValue(provider, input.model);
  if (model) configValues.model = model;
  if (input.effort && (provider === "codex" || provider === "grok")) {
    configValues.reasoning_effort = input.effort;
  }
  if (provider === "cline") configValues.auto_approve = "true";

  let modeId: string | undefined;
  if (provider === "agy") modeId = "auto_edit";
  else if (provider === "cline") modeId = "act";
  else if (provider === "codex") modeId = "agent";

  return {
    display_text: input.prompt,
    prompt_blocks: [{ type: "text", text: input.prompt }],
    agent_type: agentType,
    ...(modeId ? { mode_id: modeId } : {}),
    ...(Object.keys(configValues).length > 0 ? { config_values: configValues } : {}),
  };
}

async function postJson<T>(
  config: CodegGatewayConfig,
  path: string,
  body: unknown,
  fetchImpl: FetchLike,
): Promise<T> {
  const signal = AbortSignal.timeout(config.requestTimeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/api/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    throw new Error(
      `Codeg ${path} request did not return a confirmed response: ${cause instanceof Error ? cause.name : "transport_error"}.`,
    );
  }
  if (!response.ok) {
    throw new Error(`Codeg ${path} failed with HTTP ${response.status}.`);
  }
  const text = await response.text();
  if (!text.trim()) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Codeg ${path} returned invalid JSON.`);
  }
}

async function ensureFolder(
  config: CodegGatewayConfig,
  workspaceRoot: string,
  fetchImpl: FetchLike,
): Promise<number> {
  const folder = await postJson<{ id?: unknown; path?: unknown }>(
    config,
    "add_folder_to_history",
    { path: workspaceRoot },
    fetchImpl,
  );
  if (!Number.isInteger(folder?.id) || Number(folder.id) <= 0) {
    throw new Error("Codeg add_folder_to_history returned no usable folder id.");
  }
  if (typeof folder.path === "string" && folder.path !== workspaceRoot) {
    throw new Error("Codeg folder path did not match the exact DevSpace workspace root.");
  }
  return Number(folder.id);
}

async function listTasks(
  config: CodegGatewayConfig,
  folderId: number,
  fetchImpl: FetchLike,
): Promise<CodegTaskSnapshot[]> {
  const tasks = await postJson<unknown>(
    config,
    "work_task_list",
    { folderId },
    fetchImpl,
  );
  if (!Array.isArray(tasks)) throw new Error("Codeg work_task_list returned a non-array payload.");
  return tasks.filter((task): task is CodegTaskSnapshot => {
    if (!task || typeof task !== "object" || Array.isArray(task)) return false;
    const candidate = task as Record<string, unknown>;
    return Number.isInteger(candidate.id) && typeof candidate.status === "string";
  });
}

async function getTask(
  config: CodegGatewayConfig,
  taskId: number,
  fetchImpl: FetchLike,
): Promise<CodegTaskSnapshot> {
  const task = await postJson<CodegTaskSnapshot>(
    config,
    "work_task_get",
    { id: taskId },
    fetchImpl,
  );
  if (!task || task.id !== taskId || typeof task.status !== "string") {
    throw new Error(`Codeg work_task_get did not return the exact task ${taskId}.`);
  }
  return task;
}

function terminalInspection(task: CodegTaskSnapshot): CodegTaskInspection {
  const status = task.status;
  const success = CODEG_TERMINAL_SUCCESS.has(status);
  const terminal = success || CODEG_TERMINAL_FAILURE.has(status);
  const summary = task.result_summary?.trim()
    || task.last_error?.trim()
    || task.failure_reason?.trim()
    || undefined;
  return { taskId: task.id, status, terminal, success, summary };
}

function taskFingerprint(task: CodegTaskSnapshot): string {
  return [
    task.status,
    task.updated_at ?? "",
    task.started_at ?? "",
    task.settled_at ?? "",
    task.result_summary ?? "",
    task.last_error ?? "",
  ].join("|");
}

function normalizeRelativeFile(file: string): string {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`Codeg returned unsafe changed-file path '${file}'.`);
  }
  return normalized;
}

function normalizeScope(scope: string): string {
  return scope.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function pathAllowedByWriteScope(file: string, writePaths: string[] | undefined): boolean {
  if (!writePaths?.length) return false;
  const normalizedFile = normalizeRelativeFile(file);
  return writePaths.some((rawScope) => {
    const scope = normalizeScope(rawScope);
    return scope === "." || scope === normalizedFile || normalizedFile.startsWith(`${scope}/`);
  });
}

function gitText(workspaceRoot: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Unable to verify Codeg materialization git identity: ${result.error?.message ?? String(result.stderr || result.status)}`,
    );
  }
  return result.stdout.trim();
}

function sameGitRepository(left: string, right: string): boolean {
  const leftCommon = realpathSync(gitText(left, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const rightCommon = realpathSync(gitText(right, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  return leftCommon === rightCommon;
}

async function getChangedFiles(
  config: CodegGatewayConfig,
  taskId: number,
  fetchImpl: FetchLike,
): Promise<CodegChangedFile[]> {
  const value = await postJson<unknown>(
    config,
    "work_task_changed_files",
    { id: taskId },
    fetchImpl,
  );
  if (!Array.isArray(value)) {
    throw new Error("Codeg work_task_changed_files returned a non-array payload.");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Codeg work_task_changed_files returned an invalid entry.");
    }
    const row = item as Record<string, unknown>;
    if (
      typeof row.file !== "string"
      || typeof row.additions !== "number"
      || typeof row.deletions !== "number"
    ) {
      throw new Error("Codeg work_task_changed_files returned an invalid entry.");
    }
    return {
      file: normalizeRelativeFile(row.file),
      additions: row.additions,
      deletions: row.deletions,
    };
  });
}

async function getFolder(
  config: CodegGatewayConfig,
  folderId: number,
  fetchImpl: FetchLike,
): Promise<CodegFolderDetail> {
  const folder = await postJson<CodegFolderDetail>(
    config,
    "get_folder",
    { folderId },
    fetchImpl,
  );
  if (!folder || folder.id !== folderId || typeof folder.path !== "string" || !folder.path) {
    throw new Error(`Codeg get_folder did not return worktree folder ${folderId}.`);
  }
  return folder;
}

type CodegMaterializationOperation =
  | { kind: "copy"; file: string; source: string; target: string; mode: number }
  | { kind: "delete"; file: string; target: string };

function assertNoSymlinkedParent(
  root: string,
  target: string,
  file: string,
  label: string,
): void {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const rel = relative(rootPath, targetPath);
  const segments = rel.split(sep).filter(Boolean);
  let current = rootPath;
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `${label} parent for '${file}' is a symbolic link; refusing materialization.`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `${label} parent for '${file}' is not a directory; refusing materialization.`,
      );
    }
  }
}

function codegGitProvesDeletion(
  worktreeRoot: string,
  baseSha: string | null | undefined,
  file: string,
): boolean {
  if (!baseSha) return false;
  const result = spawnSync(
    "git",
    ["diff", "--name-only", "--diff-filter=D", "-z", baseSha, "--", file],
    {
      cwd: worktreeRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Unable to verify Codeg deletion provenance for '${file}': ${result.error?.message ?? String(result.stderr || result.status)}`,
    );
  }
  return result.stdout.split("\0").filter(Boolean).includes(file);
}

async function materializeCodegTask(
  config: CodegGatewayConfig,
  task: CodegTaskSnapshot,
  input: LocalAgentRunInput,
  fetchImpl: FetchLike,
): Promise<void> {
  const changedFiles = await getChangedFiles(config, task.id, fetchImpl);
  if (changedFiles.length === 0) return;

  if (!Number.isInteger(task.worktree_folder_id) || Number(task.worktree_folder_id) <= 0) {
    throw new Error(`Codeg task ${task.id} has changed files but no usable worktree_folder_id.`);
  }
  if (!input.writePaths?.length) {
    throw new Error(
      `Codeg task ${task.id} changed files but DevSpace has no explicit writePaths authority for materialization.`,
    );
  }

  for (const change of changedFiles) {
    if (!pathAllowedByWriteScope(change.file, input.writePaths)) {
      throw new Error(
        `Codeg task ${task.id} changed '${change.file}' outside the DevSpace write scope; refusing materialization.`,
      );
    }
  }

  const codegFolder = await getFolder(
    config,
    Number(task.worktree_folder_id),
    fetchImpl,
  );
  if (!sameGitRepository(input.workspaceRoot, codegFolder.path)) {
    throw new Error(
      `Codeg task ${task.id} worktree does not belong to the same Git repository as the DevSpace workspace.`,
    );
  }

  const localHead = gitText(input.workspaceRoot, ["rev-parse", "HEAD"]);
  if (!task.base_sha) {
    throw new Error(
      `Codeg task ${task.id} has no exact base_sha; refusing changed-file materialization.`,
    );
  }
  if (task.base_sha !== localHead) {
    throw new Error(
      `Codeg task ${task.id} base ${task.base_sha} does not match DevSpace workspace HEAD ${localHead}; refusing stale materialization.`,
    );
  }

  // Validate the complete physical change-set before the first DevSpace write.
  // This prevents a later invalid path/type/deletion from leaving an earlier
  // path partially materialized.
  const root = resolve(input.workspaceRoot);
  const operations: CodegMaterializationOperation[] = [];
  for (const change of changedFiles) {
    const source = resolve(codegFolder.path, change.file);
    const target = resolve(root, change.file);
    const rel = relative(root, target);
    if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
      throw new Error(`Codeg changed-file path '${change.file}' escapes the DevSpace workspace.`);
    }

    assertNoSymlinkedParent(
      codegFolder.path,
      source,
      change.file,
      "Codeg source",
    );
    assertNoSymlinkedParent(
      root,
      target,
      change.file,
      "DevSpace target",
    );

    if (existsSync(source)) {
      const sourceStat = lstatSync(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error(
          `Codeg changed path '${change.file}' is not a regular file; refusing materialization.`,
        );
      }
      if (existsSync(target)) {
        const targetStat = lstatSync(target);
        if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
          throw new Error(
            `DevSpace target '${change.file}' is not a regular file; refusing materialization.`,
          );
        }
      }
      operations.push({
        kind: "copy",
        file: change.file,
        source,
        target,
        mode: sourceStat.mode & 0o777,
      });
      continue;
    }

    if (!codegGitProvesDeletion(codegFolder.path, task.base_sha, change.file)) {
      throw new Error(
        `Codeg changed path '${change.file}' has no source file, but its missing-source deletion is not proven by Git against the exact task base; refusing materialization.`,
      );
    }
    if (existsSync(target)) {
      const targetStat = lstatSync(target);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        throw new Error(
          `DevSpace deletion target '${change.file}' is not a regular file; refusing materialization.`,
        );
      }
    }
    operations.push({ kind: "delete", file: change.file, target });
  }

  for (const operation of operations) {
    if (operation.kind === "copy") {
      mkdirSync(dirname(operation.target), { recursive: true });
      copyFileSync(operation.source, operation.target);
      chmodSync(operation.target, operation.mode);
      continue;
    }
    if (existsSync(operation.target)) unlinkSync(operation.target);
  }
}

async function waitForTerminal(
  config: CodegGatewayConfig,
  taskId: number,
  callbacks: LocalAgentRunCallbacks | undefined,
  fetchImpl: FetchLike,
): Promise<CodegTaskSnapshot> {
  let lastFingerprint = "";
  for (;;) {
    const task = await getTask(config, taskId, fetchImpl);
    const nextFingerprint = taskFingerprint(task);
    if (nextFingerprint !== lastFingerprint) {
      lastFingerprint = nextFingerprint;
      await callbacks?.onActivity?.();
    }
    const inspection = terminalInspection(task);
    if (inspection.terminal) return task;
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

async function createOrRecoverTask(
  config: CodegGatewayConfig,
  agentId: string,
  provider: LocalAgentProvider,
  input: LocalAgentRunInput,
  fetchImpl: FetchLike,
): Promise<{ task: CodegTaskSnapshot; created: boolean }> {
  const folderId = await ensureFolder(config, input.workspaceRoot, fetchImpl);
  const title = codegTaskTitle(agentId, provider);
  const existing = (await listTasks(config, folderId, fetchImpl))
    .filter((task) => task.title === title);
  if (existing.length > 1) {
    throw new Error(
      `Codeg reconciliation found ${existing.length} tasks for durable DevSpace agent ${agentId}; refusing ambiguous duplicate ownership.`,
    );
  }
  if (existing.length === 1) return { task: existing[0], created: false };

  let task: CodegTaskSnapshot;
  try {
    task = await postJson<CodegTaskSnapshot>(
      config,
      "work_task_create",
      {
        draft: {
          folder_id: folderId,
          title,
          config: taskConfig(provider, input),
        },
      },
      fetchImpl,
    );
  } catch (cause) {
    // A transport error after create is an ambiguous remote effect. Never
    // resend create. Reconcile the deterministic DevSpace title exactly once;
    // zero matches remains OUTCOME_UNKNOWN for a later reconciliation gate.
    let reconciled: CodegTaskSnapshot[];
    try {
      reconciled = (await listTasks(config, folderId, fetchImpl))
        .filter((candidate) => candidate.title === title);
    } catch {
      throw new Error(
        `Codeg work_task_create outcome is unknown for durable DevSpace agent ${agentId}; create was not retried.`,
        { cause },
      );
    }
    if (reconciled.length > 1) {
      throw new Error(
        `Codeg create reconciliation found ${reconciled.length} tasks for durable DevSpace agent ${agentId}; refusing ambiguous duplicate ownership.`,
        { cause },
      );
    }
    if (reconciled.length === 0) {
      throw new Error(
        `Codeg work_task_create outcome is unknown for durable DevSpace agent ${agentId}; no exact task is yet observable and create was not retried.`,
        { cause },
      );
    }
    task = reconciled[0]!;
  }
  if (!task || !Number.isInteger(task.id) || task.id <= 0) {
    throw new Error("Codeg work_task_create returned no durable task id.");
  }
  return { task, created: true };
}

async function startOrContinueTask(
  config: CodegGatewayConfig,
  task: CodegTaskSnapshot,
  input: LocalAgentRunInput,
  firstTurn: boolean,
  fetchImpl: FetchLike,
): Promise<CodegTaskSnapshot> {
  if (firstTurn) {
    if (task.status === "todo") {
      try {
        await postJson<unknown>(config, "work_task_start", { id: task.id }, fetchImpl);
      } catch (cause) {
        // The exact task handle is already durable before start. A lost start
        // acknowledgement may therefore be reconciled by reading that same
        // task, but must never trigger a second start call.
        let reconciled: CodegTaskSnapshot;
        try {
          reconciled = await getTask(config, task.id, fetchImpl);
        } catch {
          throw new Error(
            `Codeg work_task_start outcome is unknown for task ${task.id}; start was not retried.`,
            { cause },
          );
        }
        if (reconciled.status === "todo") {
          throw new Error(
            `Codeg work_task_start outcome is unresolved for task ${task.id}; the exact task is still todo and start was not retried.`,
            { cause },
          );
        }
        return reconciled;
      }
      return getTask(config, task.id, fetchImpl);
    }
    return task;
  }

  if (task.status !== "review") {
    throw new Error(
      `Codeg task ${task.id} cannot accept a DevSpace continuation from status '${task.status}'.`,
    );
  }
  await postJson<unknown>(
    config,
    "work_task_return",
    { id: task.id, feedback: input.prompt, intent: "revise", blocks: [] },
    fetchImpl,
  );
  return getTask(config, task.id, fetchImpl);
}

export async function runCodegLocalAgent(
  agentId: string,
  provider: LocalAgentProvider,
  input: LocalAgentRunInput,
  callbacks?: LocalAgentRunCallbacks,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<LocalAgentRunResult> {
  const config = resolveCodegGatewayConfig(provider, env);
  if (!config) throw new Error(`Codeg backend is not selected for '${provider}'.`);
  taskConfig(provider, input);

  const existingTaskId = parseCodegTaskHandle(input.providerSessionId);
  let task: CodegTaskSnapshot;
  let firstTurn = existingTaskId === undefined;

  if (existingTaskId !== undefined) {
    task = await getTask(config, existingTaskId, fetchImpl);
  } else {
    const recovered = await createOrRecoverTask(config, agentId, provider, input, fetchImpl);
    task = recovered.task;
    await callbacks?.onSessionId?.(formatCodegTaskHandle(task.id));
  }

  task = await startOrContinueTask(config, task, input, firstTurn, fetchImpl);
  await callbacks?.onExecutionStarted?.();

  const terminal = terminalInspection(task).terminal
    ? task
    : await waitForTerminal(config, task.id, callbacks, fetchImpl);
  const inspection = terminalInspection(terminal);
  const handle = formatCodegTaskHandle(terminal.id);
  const summary = inspection.summary ?? `Codeg task ${terminal.id} settled as ${terminal.status}.`;

  if (!inspection.success) {
    throw new LocalAgentProviderError(
      `Codeg task ${terminal.id} settled as '${terminal.status}'.`,
      { providerSessionId: handle, finalResponse: summary },
    );
  }

  await materializeCodegTask(config, terminal, input, fetchImpl);
  await callbacks?.onActivity?.();

  return {
    provider,
    providerSessionId: handle,
    finalResponse: summary,
    items: [{ codegTask: terminal }],
  };
}

export async function cancelCodegTask(
  provider: LocalAgentProvider,
  providerSessionId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const taskId = parseCodegTaskHandle(providerSessionId);
  if (taskId === undefined) return false;
  const config = resolveCodegGatewayConfig(provider, env);
  if (!config) throw new Error(`Codeg backend configuration is unavailable for '${provider}'.`);

  const before = await getTask(config, taskId, fetchImpl);
  if (CODEG_TERMINAL_SUCCESS.has(before.status) || CODEG_TERMINAL_FAILURE.has(before.status)) return true;

  await postJson<unknown>(
    config,
    "work_task_cancel",
    { id: taskId, reason: "cancelled by DevSpace", deleteWorktree: false },
    fetchImpl,
  );
  const after = await getTask(config, taskId, fetchImpl);
  return after.status === "canceled" || CODEG_TERMINAL_SUCCESS.has(after.status) || after.status === "failed";
}

export async function inspectCodegTask(
  provider: LocalAgentProvider,
  providerSessionId: string | undefined,
  agentId: string,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<CodegTaskInspection | undefined> {
  const config = resolveCodegGatewayConfig(provider, env);
  if (!config) return undefined;

  const taskId = parseCodegTaskHandle(providerSessionId);
  if (taskId !== undefined) {
    return terminalInspection(await getTask(config, taskId, fetchImpl));
  }

  const folderId = await ensureFolder(config, workspaceRoot, fetchImpl);
  const title = codegTaskTitle(agentId, provider);
  const matches = (await listTasks(config, folderId, fetchImpl))
    .filter((task) => task.title === title);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    throw new Error(
      `Codeg reconciliation found ${matches.length} tasks for durable DevSpace agent ${agentId}; ownership is ambiguous.`,
    );
  }
  return terminalInspection(matches[0]);
}
