export type WorkspaceDisclosureKey = "instructions" | "skills" | "agents";

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
