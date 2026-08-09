---
name: dynamic-workflows
description: Compose resumable multi-agent work with the DevSpace CLI for fan-out, staged processing, structured results, and isolated parallel tasks.
---

# DevSpace dynamic workflows

Use the DevSpace CLI from the project directory the workflow should operate
on. Use JSON output when a coding harness will start work and poll it later.

## Start and inspect

```bash
devspace workflow run --name <name> [--arg key=value]... --json
devspace workflow run --file <script.js> [--arg key=value]... --json
devspace workflow status <run-id> --json
devspace workflow calls <run-id> --json
devspace workflow call <run-id> <call-index> --json
devspace workflow ls --json
devspace workflow cancel <run-id> --json
```

Named workflows live in `.devspace/workflows/<name>.js`. `--script-path` is an
alias for `--file`. Poll `status` until the run is complete, failed, or
cancelled; use `calls` and `call` when a stage needs inspection. Use
`--follow` in a terminal that can remain attached instead of `--json`.

## Compose work

Workflow scripts can use:

- `agent(prompt, options?)` for one task. Options include `label`, `phase`,
  `schema`, `profile`, `provider`, `model`, `effort`, and
  `isolation: 'worktree'`.
- `parallel(tasks)` for independent work.
- `pipeline(items, ...stages)` for dependent processing.
- `phase(title)` and `log(message)` for progress.
- `workflow(nameOrRef, args?)` to reuse another workflow.
- `args` for values passed through repeated `--arg key=value` options.

Use profiles for reusable roles, `schema` when a later stage needs structured
JSON, and worktree isolation for parallel tasks that may edit overlapping
files.

```js
export const meta = {
  name: 'review-change',
  description: 'Review a change from several perspectives',
  concurrency: 2,
}

const findings = await parallel([
  () => agent('Review the change for correctness.', { label: 'correctness' }),
  () => agent('Review the change for test gaps.', { label: 'tests' }),
])

const summary = await agent(
  `Combine these findings: ${JSON.stringify(findings)}`,
  { label: 'summary' },
)

return { findings, summary }
```

## Common patterns

- Fan out security, correctness, and test reviews, then summarize them.
- Process a list of files through analysis, implementation, and verification
  stages.
- Run independent alternatives in isolated worktrees and compare their
  results.
- Resume a failed run after correcting its script or inputs:

```bash
devspace workflow run --resume <run-id> --json
devspace workflow run --resume <run-id> --file <updated-script> --json
```

Use a direct `devspace agents run` command for one bounded delegation.
