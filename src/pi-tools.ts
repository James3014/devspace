import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashToolInput,
  type EditToolInput,
  type EditToolDetails,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { resolveAllowedPath } from "./roots.js";

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }

    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
}

function formatToolError(error: unknown): McpContent[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

export interface ToolTimeoutOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput, signal?: AbortSignal) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
  timeoutOptions?: ToolTimeoutOptions,
): Promise<ToolResponse<TDetails>> {
  const timeoutMs = timeoutOptions?.timeoutMs ?? 30_000;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  let timeoutPromise: Promise<never> | undefined;
  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Tool execution timed out after ${timeoutMs}ms.`);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
  }

  if (timeoutOptions?.signal) {
    if (timeoutOptions.signal.aborted) {
      controller.abort(timeoutOptions.signal.reason);
    } else {
      timeoutOptions.signal.addEventListener("abort", () => {
        controller.abort(timeoutOptions.signal?.reason);
      }, { once: true });
    }
  }

  try {
    const promises: Promise<AgentToolResult<TDetails>>[] = [
      execute(input, controller.signal),
    ];
    if (timeoutPromise) {
      promises.push(timeoutPromise);
    }
    const result = await Promise.race(promises);
    if (timer) clearTimeout(timer);
    if (controller.signal.aborted) {
      const message = controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : `Tool execution timed out after ${timeoutMs}ms.`;
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    if (timer) clearTimeout(timer);
    const message = controller.signal.aborted
      ? (controller.signal.reason instanceof Error ? controller.signal.reason.message : `Tool execution timed out after ${timeoutMs}ms.`)
      : (error instanceof Error ? error.message : String(error));
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);
  const tool = createReadTool(context.cwd);

  return runTool((params, signal) => tool.execute("read_file", params, signal), {
    path,
    offset: input.offset,
    limit: input.limit,
  }, context);
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createWriteTool(context.cwd);

  return runTool((params, signal) => tool.execute("write_file", params, signal), {
    path,
    content: input.content,
  }, context);
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createEditTool(context.cwd);

  return runTool((params, signal) => tool.execute("edit_file", params, signal), {
    path,
    edits: input.edits,
  }, context);
}

export async function grepFilesTool(input: GrepToolInput, context: ToolContext, options?: ToolTimeoutOptions): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createGrepTool(context.cwd);

  return runTool((params, signal) => tool.execute("grep_files", params, signal), input, context, options);
}

export async function findFilesTool(input: FindToolInput, context: ToolContext, options?: ToolTimeoutOptions): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createFindTool(context.cwd);

  return runTool((params, signal) => tool.execute("find_files", params, signal), input, context, options);
}

export async function listDirectoryTool(input: LsToolInput, context: ToolContext, options?: ToolTimeoutOptions): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createLsTool(context.cwd);

  return runTool((params, signal) => tool.execute("list_directory", params, signal), input, context, options);
}

export async function runShellTool(input: BashToolInput, context: ToolContext): Promise<ToolResponse> {
  const tool = createBashTool(context.cwd);
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);

  return runTool((params) => tool.execute("run_shell", params), {
    command: input.command,
    timeout,
  }, context);
}
