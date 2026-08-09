# Subagents and Dynamic Workflows

DevSpace provides one local agent execution layer through the CLI. Codex, Pi,
OpenCode, Cursor, ChatGPT, and Claude can use the same commands from a project
directory. There are no dedicated MCP execution tools for subagents or
workflows; an MCP host can invoke the CLI through its normal shell/process
tool.

## Setup

Run `devspace init`, enable agent tooling, and choose the providers DevSpace may
use. Setup installs the `subagents` and `dynamic-workflows` skills under
`~/.devspace/skills`. Provider availability is checked again when a command
runs, so disabled or unavailable providers are not offered.

## Scope

Run CLI commands from the project they should operate on. A standalone CLI
invocation uses an explicit DevSpace workspace root when supplied, otherwise
the nearest project marker, Git repository root, or current directory. When an
MCP shell launches the CLI, DevSpace carries the opened workspace identity into
that process.

## Direct subagents

```bash
devspace agents targets --json
devspace agents run <profile-or-provider> "<brief>" --json
devspace agents show <agent-id> --json
devspace agents run <agent-id> "<follow-up>" --json
devspace agents ls --json
```

Use a direct subagent for one focused implementation, investigation, review, or
verification task. Profiles provide reusable role instructions and optional
provider/model/effort defaults. Keep the brief self-contained.

## Dynamic workflows

```bash
devspace workflow run --name <name> [--arg key=value]... --json
devspace workflow run --file <script.js> [--arg key=value]... --json
devspace workflow status <run-id> --json
devspace workflow calls <run-id> --json
devspace workflow call <run-id> <call-index> --json
devspace workflow cancel <run-id> --json
devspace workflow ls --json
```

Named scripts live in `.devspace/workflows/<name>.js`; `--script-path` is an
alias for `--file`. Use `--json` to start promptly and poll by id, or use
`--follow` from a terminal that can remain attached. A failed or cancelled run
can be started again with `workflow run --resume <run-id>`.

Workflow scripts can combine `agent`, `parallel`, `pipeline`, `phase`, `log`,
and `workflow`. Agent calls support profiles or providers, optional model and
effort overrides, structured `schema` results, and `isolation: 'worktree'` for
parallel writers. Use `--arg key=value` for run-specific inputs.

Common uses include fan-out reviews followed by a summary, per-file analysis
and verification pipelines, and comparing independent implementations in
isolated worktrees.

## MCP workspace summary

`open_workspace` exposes only the information needed to choose a target and
decide whether to inspect a running workflow. When enabled, its compact agent
fields look like this:

```json
{
  "agentProviders": [
    {
      "name": "codex",
      "model": { "supported": true, "discovery": "model_dependent" },
      "effort": {
        "supported": true,
        "semantics": "reasoning_effort",
        "discovery": "model_dependent"
      }
    }
  ],
  "agents": [
    {
      "name": "reviewer",
      "description": "Review changes and test gaps.",
      "provider": "codex",
      "model": "gpt-5.4",
      "effort": "high"
    }
  ],
  "activeWorkflows": [
    {
      "id": "wfr_123",
      "name": "review-auth",
      "status": "running",
      "calls": { "running": 2, "completed": 3, "failed": 0 }
    }
  ]
}
```

Only usable configured providers and profiles are included. Detailed execution
results remain available through the CLI commands above.
