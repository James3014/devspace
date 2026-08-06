import assert from "node:assert/strict";
import test from "node:test";
import {
  isSameWorkspaceCard,
  toggleWorkspaceDisclosure,
  toggleWorkspaceDocument,
} from "./workspace-disclosures.js";

test("workspace card state is keyed only by the opaque workspace id", () => {
  assert.equal(
    isSameWorkspaceCard(
      { tool: "open_workspace", workspaceId: "ws_same", root: "/tmp/project" },
      { tool: "open_workspace", workspaceId: "ws_same", root: "/tmp/project" },
    ),
    true,
  );
  assert.equal(
    isSameWorkspaceCard(
      { tool: "open_workspace", workspaceId: "ws_same", root: "/tmp/root-a", path: "/tmp/path-a" },
      { tool: "open_workspace", workspaceId: "ws_same", root: "/tmp/root-b", path: "/tmp/path-b" },
    ),
    true,
  );
  assert.equal(
    isSameWorkspaceCard(
      { tool: "open_workspace", root: "/tmp/project" },
      { tool: "open_workspace", root: "/tmp/project" },
    ),
    false,
  );
  assert.equal(
    isSameWorkspaceCard(
      { tool: "open_workspace", workspaceId: "ws_one", path: "/tmp/project" },
      { tool: "open_workspace", workspaceId: "ws_two", path: "/tmp/project" },
    ),
    false,
  );
});

test("workspace disclosure state toggles one section without losing other open sections", () => {
  let open = new Set<"instructions" | "skills" | "agents">(["skills"]);

  const nextWithInstructions = toggleWorkspaceDisclosure(open, "instructions");
  assert.notStrictEqual(nextWithInstructions, open);
  assert.deepEqual([...open], ["skills"]);
  open = nextWithInstructions;
  assert.deepEqual([...open].sort(), ["instructions", "skills"]);

  // Rendering a fresh DOM uses this state, so a host refresh cannot close an
  // already-open section.
  const nextWithoutSkills = toggleWorkspaceDisclosure(open, "skills");
  assert.notStrictEqual(nextWithoutSkills, open);
  assert.deepEqual([...open].sort(), ["instructions", "skills"]);
  open = nextWithoutSkills;
  assert.deepEqual([...open], ["instructions"]);
});

test("workspace document state toggles independently for each file", () => {
  let open = new Set(["0:/project/AGENTS.md"]);

  const nextWithNestedFile = toggleWorkspaceDocument(open, "1:/project/src/AGENTS.md");
  assert.notStrictEqual(nextWithNestedFile, open);
  assert.deepEqual([...open], ["0:/project/AGENTS.md"]);
  open = nextWithNestedFile;
  assert.deepEqual([...open].sort(), ["0:/project/AGENTS.md", "1:/project/src/AGENTS.md"]);

  const nextWithoutRootFile = toggleWorkspaceDocument(open, "0:/project/AGENTS.md");
  assert.notStrictEqual(nextWithoutRootFile, open);
  assert.deepEqual([...open].sort(), ["0:/project/AGENTS.md", "1:/project/src/AGENTS.md"]);
  open = nextWithoutRootFile;
  assert.deepEqual([...open], ["1:/project/src/AGENTS.md"]);
});
