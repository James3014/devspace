---
name: mcp-workspace
description: Use DevSpace MCP tools to inspect and change an approved local coding workspace.
---

# DevSpace MCP workspace

Use the MCP tools for direct work in the opened local project. This skill is
about the workspace tools; subagents and Dynamic Workflows are separate CLI
capabilities.

## Open once

Call `open_workspace` with the project directory before any other workspace
tool. Keep the returned `workspaceId` and pass it to every later call for that
folder. Open again only when switching folders or worktree mode, when the id
is rejected, or when the user asks to reopen.

The response includes project instructions, available skills, and the root
scope. Read applicable `AGENTS.md` or `CLAUDE.md` files and matching skills
before editing their directories.

## Workspace tools

- `read` inspects a file.
- `grep`, `glob`, and `ls` inspect content and directories when the server
  exposes them; otherwise use `bash` for inspection.
- `edit` applies targeted file edits.
- `write` creates a file or replaces a complete file.
- `bash` runs tests, builds, git commands, and other terminal checks.

Use paths relative to the opened root when practical. Keep file changes inside
the approved workspace and run focused verification after edits.

## Typical loop

1. Open the project and read its instructions.
2. Inspect the relevant files and tests.
3. Make the smallest coherent edit.
4. Run the relevant checks through the shell tool.
5. Summarize the result and any remaining risk.
