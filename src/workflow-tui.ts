import { resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import type { ServerConfig } from "./config.js";
import { createWorkflowStore } from "./workflow-store.js";
import {
  ACTIVE_WORKFLOW_STATUSES,
  loadWorkflowProjectView,
  type WorkflowCallView,
  type WorkflowProjectView,
  type WorkflowRunView,
} from "./workflow-view.js";

const REFRESH_MS = 750;

export async function runWorkflowTui(
  args: string[],
  config: ServerConfig,
): Promise<void> {
  const requestedRunId = args.find((arg) => !arg.startsWith("-"));
  const workspaceRoot = resolveWorkflowTuiWorkspaceRoot();
  const store = createWorkflowStore(config);

  const load = (): WorkflowProjectView =>
    loadWorkflowProjectView(store, workspaceRoot, {
      statuses: requestedRunId ? undefined : [...ACTIVE_WORKFLOW_STATUSES],
      limit: 50,
      eventLimit: 100,
    });

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    try {
      const view = load();
      const selectedIndex = findInitialSelection(view, requestedRunId);
      process.stdout.write(
        `${renderWorkflowTui(view, selectedIndex, 100, 40, { ansi: false })}\n`,
      );
      return;
    } finally {
      store.close();
    }
  }

  let project = load();
  let selectedIndex = findInitialSelection(project, requestedRunId);
  let closed = false;
  let rendering = false;

  const render = (): void => {
    if (rendering || closed) return;
    rendering = true;
    try {
      project = load();
      selectedIndex = clampSelection(project, selectedIndex, requestedRunId);
      process.stdout.write(
        `\u001b[H\u001b[2J${renderWorkflowTui(
          project,
          selectedIndex,
          process.stdout.columns || 100,
          process.stdout.rows || 40,
          { ansi: true },
        )}`,
      );
    } finally {
      rendering = false;
    }
  };

  await new Promise<void>((done) => {
    let timer: NodeJS.Timeout;

    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      process.stdin.off("keypress", onKeypress);
      process.stdout.off("resize", render);
      process.off("SIGINT", finish);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\u001b[?25h\u001b[?1049l");
      store.close();
      done();
    };

    const onKeypress = (
      _input: string,
      key: { name?: string; ctrl?: boolean },
    ): void => {
      if ((key.ctrl && key.name === "c") || key.name === "q" || key.name === "escape") {
        finish();
        return;
      }
      if (key.name === "up") {
        selectedIndex = Math.max(0, selectedIndex - 1);
        render();
      } else if (key.name === "down") {
        selectedIndex = Math.min(Math.max(0, project.runs.length - 1), selectedIndex + 1);
        render();
      }
    };

    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
    process.stdout.on("resize", render);
    process.on("SIGINT", finish);
    process.stdout.write("\u001b[?1049h\u001b[?25l");
    timer = setInterval(render, REFRESH_MS);
    render();
  });
}

export function resolveWorkflowTuiWorkspaceRoot(cwd = process.cwd()): string {
  return resolve(cwd);
}

export function renderWorkflowTui(
  project: WorkflowProjectView,
  selectedIndex: number,
  columns: number,
  rows: number,
  options: { ansi?: boolean } = {},
): string {
  const ansi = options.ansi !== false;
  const width = Math.max(48, columns);
  const selected = project.runs[selectedIndex];
  const lines: string[] = [];

  lines.push(style(truncate(`DevSpace workflows · ${project.workspaceRoot}`, width), "bold", ansi));
  lines.push(rule(width));

  if (project.runs.length === 0) {
    lines.push("No active workflows in the current directory.");
    lines.push("");
    lines.push(style("q quit", "muted", ansi));
    return fitRows(lines, rows).join("\n");
  }

  const maxRunRows = Math.max(3, Math.min(8, Math.floor(rows / 4)));
  lines.push(style("Active workflows", "heading", ansi));
  for (const [index, run] of project.runs.slice(0, maxRunRows).entries()) {
    const marker = index === selectedIndex ? "›" : " ";
    const phase = run.currentPhase ? ` · ${run.currentPhase}` : "";
    lines.push(
      truncate(
        `${marker} ${statusGlyph(run.status)} ${run.name}${phase} · ${callSummary(run)}`,
        width,
      ),
    );
  }
  if (project.runs.length > maxRunRows) {
    lines.push(style(`  +${project.runs.length - maxRunRows} more`, "muted", ansi));
  }

  lines.push(rule(width));
  if (selected) renderRunDetails(lines, selected, width, rows, ansi);
  lines.push(rule(width));
  lines.push(style("↑/↓ select · q/esc quit · refreshes automatically", "muted", ansi));
  return fitRows(lines, rows).join("\n");
}

function renderRunDetails(
  lines: string[],
  run: WorkflowRunView,
  width: number,
  rows: number,
  ansi: boolean,
): void {
  lines.push(`${style(run.name, "bold", ansi)}  ${statusGlyph(run.status)} ${run.status}`);
  lines.push(
    truncate(
      `${run.currentPhase ? `Phase: ${run.currentPhase} · ` : ""}${callSummary(run)} · ${elapsedLabel(run)}`,
      width,
    ),
  );

  const phaseBudget = Math.max(4, Math.floor(rows / 2));
  let renderedCalls = 0;
  for (const phase of run.phases) {
    if (renderedCalls >= phaseBudget) break;
    lines.push(style(`\n${phase.title}`, "heading", ansi));
    for (const call of phase.calls) {
      if (renderedCalls >= phaseBudget) break;
      lines.push(truncate(formatCall(call), width));
      renderedCalls += 1;
    }
  }
  if (run.unphasedCalls.length > 0 && renderedCalls < phaseBudget) {
    lines.push(style("\nOther calls", "heading", ansi));
    for (const call of run.unphasedCalls) {
      if (renderedCalls >= phaseBudget) break;
      lines.push(truncate(formatCall(call), width));
      renderedCalls += 1;
    }
  }

  const activity = run.recentActivity.slice(-4);
  if (activity.length > 0) {
    lines.push(style("\nRecent activity", "heading", ansi));
    for (const event of activity) {
      const time = new Date(event.createdAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const label = event.label ?? event.phase ?? event.type.replaceAll("_", " ");
      const detail = event.detail ? `: ${event.detail}` : "";
      lines.push(truncate(`${time}  ${label}${detail}`, width));
    }
  }

  if (run.error) {
    lines.push(style(`\n${run.errorKind ?? "error"}: ${run.error}`, "error", ansi));
  }
}

function findInitialSelection(
  project: WorkflowProjectView,
  requestedRunId: string | undefined,
): number {
  if (!requestedRunId) return 0;
  const index = project.runs.findIndex((run) => run.id === requestedRunId);
  if (index < 0) {
    throw new Error(
      `Workflow ${requestedRunId} does not belong to the current directory: ${project.workspaceRoot}`,
    );
  }
  return index;
}

function clampSelection(
  project: WorkflowProjectView,
  selectedIndex: number,
  requestedRunId: string | undefined,
): number {
  if (requestedRunId) return findInitialSelection(project, requestedRunId);
  return Math.min(Math.max(0, selectedIndex), Math.max(0, project.runs.length - 1));
}

function formatCall(call: WorkflowCallView): string {
  const label = call.label ?? `Agent #${call.callIndex}`;
  const provider = call.model ? `${call.provider}/${call.model}` : call.provider;
  const worktree = call.isolation === "worktree" ? " · worktree" : "";
  const replay = call.fromCache ? " · replayed" : "";
  const error = call.error ? ` · ${call.errorKind ?? "error"}: ${call.error}` : "";
  return `  ${statusGlyph(call.status)} ${label}  ${provider}${worktree}${replay}${error}`;
}

function callSummary(run: WorkflowRunView): string {
  const parts = [
    run.calls.completed ? `${run.calls.completed} done` : undefined,
    run.calls.cached ? `${run.calls.cached} replayed` : undefined,
    run.calls.running ? `${run.calls.running} running` : undefined,
    run.calls.failed ? `${run.calls.failed} failed` : undefined,
    run.calls.cancelled ? `${run.calls.cancelled} cancelled` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "no agent calls yet";
}

function elapsedLabel(run: WorkflowRunView): string {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = run.completedAt ? Date.parse(run.completedAt) : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remaining}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function statusGlyph(status: WorkflowRunView["status"] | WorkflowCallView["status"]): string {
  if (status === "completed" || status === "from_cache") return "✓";
  if (status === "failed") return "✕";
  if (status === "cancelled") return "−";
  if (status === "running") return "●";
  return "◌";
}

function rule(width: number): string {
  return "─".repeat(width);
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function fitRows(lines: string[], rows: number): string[] {
  if (rows <= 0 || lines.length <= rows) return lines;
  return lines.slice(0, Math.max(1, rows));
}

function style(
  value: string,
  tone: "bold" | "heading" | "muted" | "error",
  ansi: boolean,
): string {
  if (!ansi) return value;
  if (tone === "bold") return `\u001b[1m${value}\u001b[0m`;
  if (tone === "heading") return `\u001b[1;36m${value}\u001b[0m`;
  if (tone === "error") return `\u001b[31m${value}\u001b[0m`;
  return `\u001b[2m${value}\u001b[0m`;
}
