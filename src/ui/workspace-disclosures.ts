import type { ToolName } from "./card-types.js";

export type WorkspaceDisclosureKey = "instructions" | "skills" | "agents";

export interface WorkspaceCardIdentityInput {
  tool?: ToolName;
  workspaceId?: string;
  root?: string;
  path?: string;
}

export function isSameWorkspaceCard(
  previous: WorkspaceCardIdentityInput | null,
  next: WorkspaceCardIdentityInput,
): boolean {
  const previousId = previous?.tool === "open_workspace" ? previous.workspaceId : undefined;
  const nextId = next.tool === "open_workspace" ? next.workspaceId : undefined;
  return previousId !== undefined && previousId === nextId;
}

export function toggleWorkspaceDisclosure(
  open: ReadonlySet<WorkspaceDisclosureKey>,
  key: WorkspaceDisclosureKey,
): Set<WorkspaceDisclosureKey> {
  const next = new Set(open);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

export function toggleWorkspaceDocument(
  open: ReadonlySet<string>,
  key: string,
): Set<string> {
  const next = new Set(open);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}
