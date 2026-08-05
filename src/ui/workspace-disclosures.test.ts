import assert from "node:assert/strict";
import test from "node:test";
import {
  toggleWorkspaceDisclosure,
  toggleWorkspaceDocument,
} from "./workspace-disclosures.js";

test("workspace disclosure state toggles one section without losing other open sections", () => {
  let open = new Set<"instructions" | "skills" | "agents">(["skills"]);

  open = toggleWorkspaceDisclosure(open, "instructions");
  assert.deepEqual([...open].sort(), ["instructions", "skills"]);

  // Rendering a fresh DOM uses this state, so a host refresh cannot close an
  // already-open section.
  open = toggleWorkspaceDisclosure(open, "skills");
  assert.deepEqual([...open], ["instructions"]);
});

test("workspace document state toggles independently for each file", () => {
  let open = new Set(["0:/project/AGENTS.md"]);

  open = toggleWorkspaceDocument(open, "1:/project/src/AGENTS.md");
  assert.deepEqual([...open].sort(), ["0:/project/AGENTS.md", "1:/project/src/AGENTS.md"]);

  open = toggleWorkspaceDocument(open, "0:/project/AGENTS.md");
  assert.deepEqual([...open], ["1:/project/src/AGENTS.md"]);
});
