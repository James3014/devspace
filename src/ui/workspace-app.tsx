import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isEditTool,
  isExpandableCard,
  isPatchTool,
  isReadTool,
  isReviewTool,
  shouldAutoExpandCard,
  isToolName,
  isToolResultCard,
  isWriteTool,
  payloadText,
  summaryNumber,
  type HostContext,
  type ToolName,
  type ToolResultCard,
} from "./card-types.js";
import { renderIcon, toolIcons, type ToolIcon } from "./icons.js";
import {
  getToolDisplay,
  getToolHeaderSummary,
  type ToolDisplay,
} from "./tool-display.js";
import {
  isSameWorkspaceCard,
  toggleWorkspaceDisclosure,
  toggleWorkspaceDocument,
  type WorkspaceDisclosureKey,
} from "./workspace-disclosures.js";
import "./workspace-app.css";

interface MountedPayload {
  update(options: {
    card: ToolResultCard;
    hostContext?: HostContext;
    errorMessage?: string | null;
    visibleFileCount?: number;
  }): void;
  unmount(): void;
}

let app: App | null = null;
let connected = false;
let connectionError: string | null = null;
let hostContext: HostContext | undefined;
let card: ToolResultCard | null = null;
let expanded = false;
let reviewFilesExpanded = false;
let errorMessage: string | null = null;
let currentPayload: MountedPayload | null = null;
let currentPayloadContainer: HTMLElement | null = null;
let openWorkspaceDisclosures = new Set<WorkspaceDisclosureKey>();
let openWorkspaceDocuments = new Set<string>();

const maybeAppRoot = document.querySelector<HTMLElement>("#app");

if (!maybeAppRoot) {
  throw new Error("Missing #app root element.");
}

const appRoot = maybeAppRoot;

void boot();

async function boot(): Promise<void> {
  render();

  app = new App(
    { name: "devspace-tool-cards", version: "0.4.0" },
    {},
  );

  app.ontoolresult = (result) => {
    const structured = cardForUi(result);
    const tool = toolNameFromMeta(result);

    if (!tool || !isToolResultCard(structured)) {
      card = null;
      expanded = false;
      reviewFilesExpanded = false;
      errorMessage = "No result card is available for this tool result.";
      render();
      return;
    }

    const nextCard = { ...structured, tool };
    if (!isSameWorkspaceCard(card, nextCard)) {
      openWorkspaceDisclosures = new Set();
      openWorkspaceDocuments = new Set();
    }
    card = nextCard;
    expanded = shouldAutoExpandCard(nextCard);
    reviewFilesExpanded = false;
    errorMessage = null;
    render();
  };

  app.onhostcontextchanged = (ctx) => {
    hostContext = {
      ...hostContext,
      ...ctx,
    };
    applyHostContext();
    renderPayloadIfNeeded();
  };

  app.onteardown = async () => {
    unmountPayload();
    return {};
  };

  try {
    await app.connect();
    const initialContext = app.getHostContext();
    if (initialContext) hostContext = initialContext;
    applyHostContext();
    connected = true;
  } catch (connectError) {
    connectionError = connectError instanceof Error
      ? connectError.message
      : String(connectError);
  }

  render();
}

function applyHostContext(): void {
  if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
  if (hostContext?.styles?.variables) {
    applyHostStyleVariables(hostContext.styles.variables);
  }
  if (hostContext?.styles?.css?.fonts) {
    applyHostFonts(hostContext.styles.css.fonts);
  }

  const insets = hostContext?.safeAreaInsets;
  if (!insets) return;

  document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
}

function render(): void {
  unmountPayload();

  if (connectionError) {
    renderEmpty(connectionError, "error");
    return;
  }

  if (!connected) {
    renderEmpty("Connecting to host...");
    return;
  }

  if (!card) {
    renderEmpty(errorMessage ?? "Waiting for a tool result.", errorMessage ? "error" : "muted");
    return;
  }

  const display = getToolDisplay(card);
  if (isReviewTool(card.tool)) {
    renderReviewCard(card, display);
    return;
  }

  const expandable = isExpandableCard(card);
  const main = element("main", { className: "shell" });
  const stateClass = cardStateClass(card);
  const section = element("section", {
    className: [
      "tool-card",
      display.tone,
      card.mode === "worktree" ? "worktree" : undefined,
      stateClass,
    ].filter(Boolean).join(" "),
  });
  const button = element("button", {
    className: "tool-header",
    type: "button",
    ariaExpanded: String(expanded),
    disabled: !expandable,
  });

  if (expandable) {
    button.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
  }

  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  if (display.iconLabel) {
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", display.iconLabel);
    icon.removeAttribute("aria-hidden");
  }
  icon.append(renderIcon(display.icon));

  const toolMain = element("span", { className: "tool-main" });
  const title = element("span", { className: "tool-title", text: display.title });
  toolMain.append(title);
  if (display.label) {
    toolMain.append(element("span", {
      className: "tool-label",
      text: display.label,
      title: display.label,
    }));
  }

  button.append(
    icon,
    toolMain,
    renderHeaderSummary(card),
    renderChevron(expanded, expandable),
  );
  section.append(button);

  if (expanded) {
    const body = element("div", { className: "tool-body" });
    currentPayloadContainer = body;
    section.append(body);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
}

function renderEmpty(message: string, tone: "muted" | "error" = "muted"): void {
  const main = element("main", { className: "shell" });
  main.append(element("section", { className: `empty ${tone}`, text: message }));
  appRoot.replaceChildren(main);
}

function cardStateClass(card: ToolResultCard): "running" | "failed" | undefined {
  if (card.tool !== "bash" && card.tool !== "exec_command" && card.tool !== "write_stdin") {
    return undefined;
  }
  if (card.summary?.running === true) return "running";

  const exitCode = summaryNumber(card.summary, "exitCode");
  return exitCode !== undefined && exitCode !== 0 ? "failed" : undefined;
}

async function renderPayloadIfNeeded(): Promise<void> {
  if (!card || !currentPayloadContainer || !expanded) return;

  const target = currentPayloadContainer;

  if (errorMessage) {
    renderStatus(target, errorMessage, "error");
    return;
  }

  if (card.tool === "open_workspace") {
    renderWorkspacePayload(target, card);
    return;
  }

  if (shouldUseHeavyPayload(card)) {
    if (currentPayload) {
      currentPayload.update({ card, hostContext, errorMessage });
      return;
    }

    setPayloadLoading(target, true);

    try {
      const { mountHeavyPayload } = await import("./heavy-payload.js");
      if (target !== currentPayloadContainer || !expanded || !card) return;

      setPayloadLoading(target, false);
      currentPayload = mountHeavyPayload(target, {
        card,
        hostContext,
        errorMessage,
      });
    } catch (loadError) {
      if (target !== currentPayloadContainer || !expanded) return;

      setPayloadLoading(target, false);
      renderStatus(
        target,
        loadError instanceof Error ? loadError.message : "Unable to load details.",
        "error",
      );
    }
    return;
  }

  if (isReviewTool(card.tool) || isPatchTool(card.tool)) {
    const visibleFileCount = isReviewTool(card.tool) && !reviewFilesExpanded
      ? Math.max(3, (card.files ?? []).slice(0, 3).length)
      : undefined;

    if (currentPayload) {
      currentPayload.update({ card, hostContext, errorMessage, visibleFileCount });
      return;
    }

    renderStatus(target, isReviewTool(card.tool) ? "Loading review..." : "Loading diff...");

    const { mountReviewPayload } = await import("./review-payload.js");
    if (target !== currentPayloadContainer || !card) return;

    currentPayload = mountReviewPayload(target, {
      card,
      hostContext,
      errorMessage,
      visibleFileCount,
    });
    return;
  }

  const text = payloadText(card.payload);
  if (!text) {
    renderStatus(target, "No details available.");
    return;
  }

  renderPrePayload(target, text, card.tool);
}

function shouldUseHeavyPayload(card: ToolResultCard): boolean {
  return isReadTool(card.tool) || isEditTool(card.tool) || isWriteTool(card.tool);
}

function unmountPayload(): void {
  unmountCurrentPayload();
  currentPayload = null;
  currentPayloadContainer = null;
}

function unmountCurrentPayload(): void {
  currentPayload?.unmount();
  currentPayload = null;
}

function renderStatus(
  container: HTMLElement,
  message: string,
  tone: "muted" | "error" = "muted",
): void {
  unmountCurrentPayload();
  container.replaceChildren(element("div", { className: `status ${tone}`, text: message }));
}

function renderPrePayload(
  container: HTMLElement,
  text: string,
  tool: string,
): void {
  unmountCurrentPayload();
  container.replaceChildren(element("pre", {
    className: `text-payload pretty-scrollbar ${tool}`,
    text,
  }));
}

function renderHeaderSummary(card: ToolResultCard): HTMLElement {
  const summary = getToolHeaderSummary(card);

  if (summary.kind === "diff") {
    const stats = element("span", { className: "stats" });
    stats.setAttribute("aria-label", "Diff statistics");
    stats.append(
      element("span", { className: "add", text: `+${String(summary.additions)}` }),
      element("span", { className: "remove", text: `-${String(summary.removals)}` }),
    );
    return stats;
  }

  const meta = element("span", {
    className: `header-meta ${summary.kind === "empty" ? "empty" : ""}`,
    text: summary.kind === "text" ? summary.text : "",
  });
  if (summary.kind === "empty") meta.setAttribute("aria-hidden", "true");
  return meta;
}

function renderReviewCard(card: ToolResultCard, display: ToolDisplay): void {
  unmountPayload();

  const files = card.files ?? [];
  const visibleFiles = reviewFilesExpanded ? files : files.slice(0, 3);
  const hiddenCount = Math.max(0, files.length - visibleFiles.length);
  const expandable = isExpandableCard(card);
  const main = element("main", { className: "shell" });
  const section = element("section", { className: "tool-card review" });
  const header = element("button", {
    className: "tool-header review-header",
    type: "button",
    ariaExpanded: String(expanded),
    disabled: !expandable,
  });

  if (expandable) {
    header.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
  }

  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.append(renderIcon(display.icon));
  const titleGroup = element("span", { className: "tool-main review-title-group" });

  titleGroup.append(element("span", { className: "tool-title", text: display.title }));
  if (display.label) {
    titleGroup.append(element("span", {
      className: "tool-label",
      text: display.label,
      title: display.label,
    }));
  }
  header.append(
    icon,
    titleGroup,
    renderHeaderSummary(card),
    renderChevron(expanded, expandable),
  );

  section.append(header);
  if (expanded) {
    const body = element("div", { className: "review-summary" });
    const payload = element("div", { className: "review-payload" });
    currentPayloadContainer = payload;
    body.append(payload);

    if (hiddenCount > 0) {
      const showMore = element("button", {
        className: "review-more",
        type: "button",
        text: `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`,
      });
      showMore.addEventListener("click", () => {
        reviewFilesExpanded = true;
        render();
      });
      body.append(showMore);
    }

    section.append(body);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
}

function renderChevron(isExpanded: boolean, visible: boolean): HTMLElement {
  const chevron = element("span", {
    className: visible ? `chevron ${isExpanded ? "expanded" : ""}` : "chevron",
    ariaHidden: "true",
  });

  if (visible) {
    chevron.append(renderIcon(toolIcons.chevronDown));
  }

  return chevron;
}

function setPayloadLoading(container: HTMLElement, loading: boolean): void {
  const header = container.previousElementSibling;
  const chevron = header?.querySelector<HTMLElement>(".chevron");
  if (!chevron) return;

  chevron.classList.toggle("loading", loading);
  chevron.replaceChildren(
    renderIcon(loading ? toolIcons.loading : toolIcons.chevronDown),
  );

  const button = header instanceof HTMLButtonElement ? header : null;
  if (button) button.setAttribute("aria-busy", String(loading));
}

function renderWorkspacePayload(container: HTMLElement, card: ToolResultCard): void {
  unmountCurrentPayload();

  const details = element("div", { className: "workspace-disclosures" });

  const agentsFiles = card.agentsFiles ?? [];
  const availableAgentsFiles = card.availableAgentsFiles ?? [];
  if (agentsFiles.length > 0 || availableAgentsFiles.length > 0) {
    details.append(renderWorkspaceInstructions(agentsFiles, availableAgentsFiles));
  }

  const skills = card.skills ?? [];
  if (skills.length > 0) {
    details.append(renderWorkspaceSkills(skills));
  }

  const agents = card.agents ?? [];
  const providers = card.agentProviders ?? [];
  if (agents.length > 0 || providers.length > 0) {
    details.append(renderWorkspaceAgents(agents, providers));
  }

  container.replaceChildren(details);
}

function renderWorkspaceInfoRow(
  icon: ToolIcon,
  label: string,
  value: string,
  action?: HTMLElement,
): HTMLElement {
  const row = element("div", {
    className: "workspace-info-row",
  });
  const iconNode = element("span", { className: "workspace-info-icon", ariaHidden: "true" });
  iconNode.append(renderIcon(icon));
  const valueGroup = element("span", { className: "workspace-info-value-group" });
  valueGroup.append(element("code", { className: "workspace-info-value", text: value, title: value }));
  if (action) valueGroup.append(action);
  row.append(
    iconNode,
    element("span", { className: "workspace-info-label", text: label }),
    valueGroup,
  );
  return row;
}

function renderWorkspaceInstructions(
  loaded: NonNullable<ToolResultCard["agentsFiles"]>,
  available: NonNullable<ToolResultCard["availableAgentsFiles"]>,
): HTMLElement {
  const body = element("div", { className: "workspace-disclosure-body" });
  const fileList = element("div", { className: "workspace-file-list pretty-scrollbar" });

  for (const [index, file] of loaded.entries()) {
    const item = element("div", { className: "workspace-file-item" });
    const path = file.path ?? "AGENTS.md";
    const content = file.content?.trim();
    if (content) {
      const documentKey = `${index}:${path}`;
      const documentId = workspaceDocumentId(path, index);
      const open = openWorkspaceDocuments.has(documentKey);
      const toggle = element("button", {
        className: "workspace-document-toggle",
        type: "button",
        text: "View",
        ariaExpanded: String(open),
      });
      toggle.setAttribute("aria-controls", documentId);
      const pre = element("pre", { className: "workspace-document pretty-scrollbar", text: content });
      pre.id = documentId;
      pre.hidden = !open;
      pre.setAttribute("role", "region");
      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openWorkspaceDocuments = toggleWorkspaceDocument(openWorkspaceDocuments, documentKey);
        const nextOpen = openWorkspaceDocuments.has(documentKey);
        toggle.setAttribute("aria-expanded", String(nextOpen));
        pre.hidden = !nextOpen;
      });
      item.append(
        renderWorkspaceInfoRow(toolIcons.instructions, "Loaded", path, toggle),
        pre,
      );
    } else {
      item.append(renderWorkspaceInfoRow(toolIcons.instructions, "Loaded", path));
    }
    fileList.append(item);
  }

  for (const file of available) {
    fileList.append(renderWorkspaceInfoRow(
      toolIcons.instructions,
      "Available",
      file.path ?? "AGENTS.md",
    ));
  }

  body.append(fileList);
  return renderWorkspaceDisclosure(
    "Instructions",
    `${loaded.length} loaded${available.length > 0 ? ` · ${available.length} available` : ""}`,
    body,
    "instructions",
  );
}

function workspaceDocumentId(path: string, index: number): string {
  const safePath = path.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return `workspace-document-${index}-${safePath}`;
}

function renderWorkspaceSkills(
  skills: NonNullable<ToolResultCard["skills"]>,
): HTMLElement {
  const body = element("div", { className: "workspace-disclosure-body" });
  const list = element("div", { className: "workspace-chip-list pretty-scrollbar" });
  for (const skill of skills) {
    const name = skill.name ?? skill.path ?? "Unnamed skill";
    list.append(element("span", { className: "workspace-chip", text: name, title: skill.description ?? name }));
  }
  body.append(list);
  return renderWorkspaceDisclosure("Skills", `${skills.length} available`, body, "skills");
}

function renderWorkspaceAgents(
  agents: NonNullable<ToolResultCard["agents"]>,
  providers: NonNullable<ToolResultCard["agentProviders"]>,
): HTMLElement {
  const body = element("div", { className: "workspace-disclosure-body workspace-agent-list" });
  for (const provider of providers) {
    body.append(renderWorkspaceInfoRow(
      provider.available === false ? toolIcons.alert : toolIcons.check,
      "Provider",
      provider.name ?? "Unknown provider",
    ));
  }
  for (const agent of agents) {
    body.append(renderWorkspaceInfoRow(
      agent.providerAvailable === false ? toolIcons.alert : toolIcons.agents,
      "Agent",
      agent.name ?? "Unnamed agent",
    ));
  }
  return renderWorkspaceDisclosure(
    "Agents",
    `${agents.length} agents · ${providers.length} providers`,
    body,
    "agents",
  );
}

function renderWorkspaceDisclosure(
  title: string,
  summaryText: string,
  body: HTMLElement,
  key: WorkspaceDisclosureKey,
): HTMLElement {
  const open = openWorkspaceDisclosures.has(key);
  const disclosure = element("section", {
    className: `workspace-disclosure${open ? " open" : ""}`,
  });
  const summary = element("button", {
    className: "workspace-disclosure-summary",
    type: "button",
    ariaExpanded: String(open),
  });
  const bodyId = `workspace-disclosure-${key}`;
  body.id = bodyId;
  body.hidden = !open;
  body.setAttribute("role", "region");
  summary.setAttribute("aria-controls", bodyId);
  const chevron = element("span", { className: "workspace-disclosure-chevron", ariaHidden: "true" });
  chevron.append(renderIcon(toolIcons.chevronRight));
  summary.append(
    element("span", { className: "workspace-disclosure-title", text: title }),
    element("span", { className: "workspace-disclosure-count", text: summaryText }),
    chevron,
  );
  summary.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openWorkspaceDisclosures = toggleWorkspaceDisclosure(openWorkspaceDisclosures, key);
    const nextOpen = openWorkspaceDisclosures.has(key);
    disclosure.classList.toggle("open", nextOpen);
    summary.setAttribute("aria-expanded", String(nextOpen));
    body.hidden = !nextOpen;
  });
  disclosure.append(summary, body);
  return disclosure;
}

function toolNameFromMeta(result: CallToolResult): ToolName | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const tool = meta?.tool;
  return isToolName(tool) ? tool : undefined;
}

function cardFromMeta(result: CallToolResult): Partial<ToolResultCard> | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const metaCard = meta?.card;
  return metaCard && typeof metaCard === "object"
    ? metaCard as Partial<ToolResultCard>
    : undefined;
}

function getStructuredContent<T>(result: CallToolResult): T | undefined {
  return result.structuredContent as T | undefined;
}

function cardForUi(result: CallToolResult): Partial<ToolResultCard> | undefined {
  // Model-facing workspace context is intentionally kept out of the card
  // projection. In particular, diagnostics and instructions can be large or
  // actionable for the model but are not user-facing card content.
  const source = cardFromMeta(result) ?? getStructuredContent<Partial<ToolResultCard>>(result);
  if (!source) return undefined;

  const uiCard = { ...source } as Partial<ToolResultCard> & Record<string, unknown>;
  delete uiCard.skillDiagnostics;
  delete uiCard.diagnostics;
  delete uiCard.instruction;

  if (uiCard.summary && typeof uiCard.summary === "object") {
    const summary = { ...uiCard.summary } as Record<string, unknown>;
    delete summary.skillDiagnostics;
    delete summary.diagnostics;
    uiCard.summary = summary;
  }

  return uiCard;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    type?: string;
    title?: string;
    ariaHidden?: string;
    ariaExpanded?: string;
    disabled?: boolean;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type !== undefined && "type" in node) node.setAttribute("type", options.type);
  if (options.title !== undefined) node.title = options.title;
  if (options.ariaHidden !== undefined) node.setAttribute("aria-hidden", options.ariaHidden);
  if (options.ariaExpanded !== undefined) node.setAttribute("aria-expanded", options.ariaExpanded);
  if (options.disabled !== undefined && "disabled" in node) {
    (node as HTMLButtonElement).disabled = options.disabled;
  }
  return node;
}
