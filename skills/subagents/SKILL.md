---
name: subagents
description: Delegate one focused coding, research, review, or verification task to a DevSpace subagent through the CLI.
---

# DevSpace subagents

Use the DevSpace CLI from the project directory the task belongs to. The CLI
uses the current project scope, so run it from the checkout or worktree you
want the subagent to inspect.

## Discover targets

```bash
devspace agents targets --json
```

The response lists usable providers and configured profiles. A profile is a
named role with its own instructions and optional model or effort defaults.
Use a provider name when no profile fits.

## Delegate work

```bash
devspace agents run <profile-or-provider> "<self-contained brief>" --json
devspace agents run <profile-or-provider> --model <model> --effort <level> "<brief>" --json
```

The response gives an agent id and status. Include the objective, relevant
paths, constraints, and the expected result in the brief. `--model` and
`--effort` are optional overrides; use values accepted by the selected target.

## Check or continue

```bash
devspace agents show <agent-id> --json
devspace agents ls --json
devspace agents run <agent-id> "<follow-up>" --json
```

Use `show` to poll a running task and to read its response or error. Continue
an existing id when the same context is useful; start a new task for an
independent perspective.

## Good uses

- Ask a reviewer to inspect a change for bugs and missing tests.
- Delegate focused research before deciding on an implementation.
- Have a specialist verify a fix or run a targeted check.
- Ask one subagent for a self-contained implementation while the parent keeps
  coordinating the larger task.

Use a Dynamic Workflow when work needs several coordinated agents, stages, or
structured fan-out.
