import type { WorkflowRunSummaryView } from "../workflow-ui.js";
import type {
  WorkflowCallView,
  WorkflowProjectView,
  WorkflowRunView,
} from "../workflow-view.js";
import type { ToolResultCard, WorkspaceWorkflowSummary } from "./card-types.js";
import { renderIcon, toolIcons } from "./icons.js";

export interface DashboardDisplayOptions {
  canFullscreen: boolean;
  fullscreen: boolean;
  onToggleFullscreen(): void;
}

export function renderWorkspaceDashboard(
  container: HTMLElement,
  card: ToolResultCard,
  project: WorkflowProjectView | null,
  display: DashboardDisplayOptions,
): void {
  const root = node("div", {
    className: `workspace-dashboard ${display.fullscreen ? "fullscreen" : "inline"}`,
  });
  const runs: Array<WorkflowRunView | WorkspaceWorkflowSummary> = project?.runs ?? card.activeWorkflows ?? [];

  root.append(
    renderDashboardToolbar("Workspace overview", display),
    ...(card.activeWorkflows !== undefined || project !== null
      ? [renderWorkflowSummarySection(runs)]
      : []),
    renderAccordion(
      "Workspace",
      true,
      renderKeyValues([
        ["Root", card.root ?? card.path ?? "Unknown"],
        ["Workspace", card.workspaceId ?? "Unknown"],
        ["Mode", card.mode ?? stringValue(card.summary?.mode) ?? "checkout"],
        ...(card.sourceRoot ? [["Source root", card.sourceRoot] as [string, string]] : []),
        ...(card.worktree?.baseRef ? [["Base ref", card.worktree.baseRef] as [string, string]] : []),
        ...(card.worktree?.baseSha ? [["Base SHA", card.worktree.baseSha] as [string, string]] : []),
      ]),
    ),
    renderAccordion(
      `Loaded skills · ${card.skills?.length ?? 0}`,
      false,
      renderList(
        card.skills?.map((skill) => ({
          title: skill.name ?? "Unnamed skill",
          description: skill.description ?? skill.path,
          meta: skill.path,
        })) ?? [],
        "No skills loaded.",
      ),
    ),
    renderAccordion(
      `Project instructions · ${card.agentsFiles?.length ?? 0}`,
      false,
      renderList(
        card.agentsFiles?.map((file) => ({
          title: file.path ?? "AGENTS.md",
          description: summarizeText(file.content),
        })) ?? [],
        "No project instructions loaded.",
      ),
    ),
    renderAccordion(
      `Nested instructions · ${card.availableAgentsFiles?.length ?? 0}`,
      false,
      renderList(
        card.availableAgentsFiles?.map((file) => ({ title: file.path ?? "Unknown path" })) ?? [],
        "No nested instruction files discovered.",
      ),
    ),
    ...(card.agentProviders !== undefined
      ? [renderAccordion(
          `Agent providers · ${card.agentProviders.length}`,
          false,
          renderProviderList(card),
        )]
      : []),
    ...(card.agents !== undefined
      ? [renderAccordion(
          `Agent profiles · ${card.agents.length}`,
          false,
          renderList(
            card.agents.map((agent) => ({
              title: agent.name ?? "Unnamed profile",
              description: [agent.provider, agent.model, agent.effort].filter(Boolean).join(" · "),
              meta: agent.description,
            })),
            "No agent profiles loaded.",
          ),
        )]
      : []),
    renderAccordion(
      `Warnings · ${card.skillDiagnostics?.length ?? 0}`,
      false,
      renderList(
        card.skillDiagnostics?.map((diagnostic, index) => ({
          title: `Diagnostic ${index + 1}`,
          description: summarizeDiagnostic(diagnostic),
        })) ?? [],
        "No workspace warnings.",
      ),
    ),
    renderAccordion(
      "Model handoff",
      false,
      node("div", { className: "workspace-handoff", text: card.instruction ?? "No handoff instruction." }),
    ),
  );

  container.replaceChildren(root);
}

export function renderWorkflowDashboard(
  container: HTMLElement,
  run: WorkflowRunView | null,
  fallback: ToolResultCard,
  display: DashboardDisplayOptions,
): void {
  const root = node("div", {
    className: `workflow-dashboard ${display.fullscreen ? "fullscreen" : "inline"}`,
  });
  root.append(renderDashboardToolbar("Workflow monitor", display));

  if (!run) {
    root.append(
      node("div", {
        className: "dashboard-empty",
        text: fallback.runId ? "Loading workflow activity…" : "No workflow run selected.",
      }),
    );
    container.replaceChildren(root);
    return;
  }

  const heading = node("section", { className: "workflow-heading" });
  const titleRow = node("div", { className: "workflow-title-row" });
  titleRow.append(
    node("span", { className: `workflow-status-dot ${run.status}`, ariaHidden: "true" }),
    node("div", { className: "workflow-title-copy" }, [
      node("strong", { text: run.name }),
      node("span", {
        className: "workflow-subtitle",
        text: `${run.status}${run.currentPhase ? ` · ${run.currentPhase}` : ""}`,
      }),
    ]),
  );
  heading.append(titleRow, renderCallCounts(run));
  root.append(heading);

  const phases = node("section", { className: "workflow-phases" });
  for (const phase of run.phases) {
    const phaseSection = node("section", { className: "workflow-phase" });
    phaseSection.append(node("h3", { text: phase.title }));
    const calls = node("div", { className: "workflow-call-list" });
    for (const call of phase.calls) calls.append(renderCall(call));
    if (phase.calls.length === 0) {
      calls.append(node("div", { className: "dashboard-empty", text: "No observed calls in this phase." }));
    }
    phaseSection.append(calls);
    phases.append(phaseSection);
  }
  if (run.unphasedCalls.length > 0) {
    const unphased = node("section", { className: "workflow-phase" });
    unphased.append(node("h3", { text: "Other calls" }));
    const calls = node("div", { className: "workflow-call-list" });
    for (const call of run.unphasedCalls) calls.append(renderCall(call));
    unphased.append(calls);
    phases.append(unphased);
  }
  if (run.phases.length === 0 && run.unphasedCalls.length === 0) {
    phases.append(node("div", { className: "dashboard-empty", text: "No agent calls observed yet." }));
  }
  root.append(phases);

  if (run.recentActivity.length > 0) {
    const activity = node("section", { className: "workflow-activity" });
    activity.append(node("h3", { text: "Recent activity" }));
    for (const event of run.recentActivity.slice(-8).reverse()) {
      activity.append(
        node("div", { className: "workflow-event" }, [
          node("time", { text: formatTime(event.createdAt) }),
          node("span", {
            text: `${event.label ?? event.phase ?? event.type.replaceAll("_", " ")}${event.detail ? ` · ${event.detail}` : ""}`,
          }),
        ]),
      );
    }
    root.append(activity);
  }

  if (run.error) {
    root.append(
      node("section", { className: "workflow-error" }, [
        node("strong", { text: run.errorKind ?? "Workflow error" }),
        node("p", { text: run.error }),
      ]),
    );
  }

  container.replaceChildren(root);
}

function renderDashboardToolbar(
  title: string,
  display: DashboardDisplayOptions,
): HTMLElement {
  const toolbar = node("div", { className: "dashboard-toolbar" });
  toolbar.append(node("strong", { text: title }));
  if (display.canFullscreen || display.fullscreen) {
    const button = node("button", {
      className: "display-mode-button",
      type: "button",
      text: display.fullscreen ? "Exit fullscreen" : "Open dashboard",
    });
    button.prepend(renderIcon(display.fullscreen ? toolIcons.minimize : toolIcons.maximize));
    button.addEventListener("click", display.onToggleFullscreen);
    toolbar.append(button);
  }
  return toolbar;
}

function renderWorkflowSummarySection(
  runs: Array<WorkflowRunView | WorkflowRunSummaryView | WorkspaceWorkflowSummary>,
): HTMLElement {
  const section = node("section", { className: "active-workflows" });
  section.append(node("h3", { text: `Active workflows · ${runs.length}` }));
  if (runs.length === 0) {
    section.append(node("div", { className: "dashboard-empty", text: "No active workflows." }));
    return section;
  }
  for (const run of runs) {
    const row = node("div", { className: "active-workflow-row" });
    row.append(
      node("span", { className: `workflow-status-dot ${run.status}`, ariaHidden: "true" }),
      node("div", { className: "active-workflow-copy" }, [
        node("strong", { text: run.name }),
        node("span", {
          text: `${run.currentPhase ?? run.status}${run.calls ? ` · ${summaryCounts(run.calls)}` : ""}`,
        }),
      ]),
    );
    section.append(row);
  }
  return section;
}

function renderCallCounts(run: WorkflowRunView): HTMLElement {
  const counts = node("div", { className: "workflow-counts" });
  const values = [
    ["Completed", run.calls.completed],
    ["Replayed", run.calls.cached],
    ["Running", run.calls.running],
    ["Failed", run.calls.failed],
  ] as const;
  for (const [label, value] of values) {
    if (!value) continue;
    counts.append(node("span", { text: `${value} ${label.toLowerCase()}` }));
  }
  if (counts.childElementCount === 0) {
    counts.append(node("span", { text: "No agent calls yet" }));
  }
  return counts;
}

function renderCall(call: WorkflowCallView): HTMLElement {
  const row = node("article", { className: `workflow-call ${call.status}` });
  const main = node("div", { className: "workflow-call-main" });
  main.append(
    node("span", { className: `call-status ${call.status}`, text: callGlyph(call.status) }),
    node("div", { className: "workflow-call-copy" }, [
      node("strong", { text: call.label ?? `Agent #${call.callIndex}` }),
      node("span", {
        text: [
          call.model ? `${call.provider}/${call.model}` : call.provider,
          call.isolation === "worktree" ? "worktree" : undefined,
          call.fromCache ? "replayed" : undefined,
        ].filter(Boolean).join(" · "),
      }),
    ]),
  );
  row.append(main);
  if (call.error) {
    row.append(node("p", { className: "workflow-call-error", text: `${call.errorKind ?? "error"}: ${call.error}` }));
  }
  return row;
}

function renderAccordion(title: string, open: boolean, content: HTMLElement): HTMLElement {
  const details = node("details", { className: "workspace-accordion" }) as HTMLDetailsElement;
  details.open = open;
  details.append(node("summary", { text: title }), content);
  return details;
}

function renderKeyValues(entries: Array<[string, string]>): HTMLElement {
  const list = node("dl", { className: "workspace-key-values" });
  for (const [label, value] of entries) {
    list.append(node("dt", { text: label }), node("dd", { text: value, title: value }));
  }
  return list;
}

function renderProviderList(card: ToolResultCard): HTMLElement {
  return renderList(
    card.agentProviders?.map((provider) => ({
      title: provider.name ?? "Unknown provider",
    })) ?? [],
    "No subagent providers exposed.",
  );
}

function renderList(
  items: Array<{ title: string; description?: string; meta?: string }>,
  emptyText: string,
): HTMLElement {
  const list = node("div", { className: "workspace-list" });
  if (items.length === 0) {
    list.append(node("div", { className: "dashboard-empty", text: emptyText }));
    return list;
  }
  for (const item of items) {
    list.append(
      node("div", { className: "workspace-list-row" }, [
        node("strong", { text: item.title }),
        item.description ? node("span", { text: item.description }) : undefined,
        item.meta ? node("code", { text: item.meta, title: item.meta }) : undefined,
      ].filter((child): child is HTMLElement => Boolean(child))),
    );
  }
  return list;
}

function summaryCounts(calls: WorkflowRunSummaryView["calls"]): string {
  const parts = [
    calls.completed ? `${calls.completed} done` : undefined,
    calls.cached ? `${calls.cached} replayed` : undefined,
    calls.running ? `${calls.running} running` : undefined,
    calls.failed ? `${calls.failed} failed` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ") || "no calls yet";
}

function callGlyph(status: WorkflowCallView["status"]): string {
  if (status === "completed" || status === "from_cache") return "✓";
  if (status === "failed") return "✕";
  if (status === "cancelled") return "−";
  return "●";
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function summarizeText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 140 ? `${compact.slice(0, 139)}…` : compact;
}

function summarizeDiagnostic(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Unserializable diagnostic";
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    type?: string;
    title?: string;
    ariaHidden?: string;
  } = {},
  children: HTMLElement[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.type !== undefined) element.setAttribute("type", options.type);
  if (options.title !== undefined) element.title = options.title;
  if (options.ariaHidden !== undefined) element.setAttribute("aria-hidden", options.ariaHidden);
  element.append(...children);
  return element;
}
