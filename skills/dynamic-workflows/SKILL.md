---
name: dynamic-workflows
description: Create and run resumable multi-agent workflows with the DevSpace CLI. Use for programmed fan-out, dependent stages, per-item processing, structured aggregation, isolated parallel work, or recovery after a failed run; use a direct subagent for one bounded delegation.
---

# DevSpace dynamic workflows

Use the DevSpace CLI from the project the workflow should operate on. Prefer
JSON output from a coding harness so each command returns promptly and the
harness can poll by id.

## Run and inspect

```bash
devspace workflow run --name <name> [--arg key=value]... --json
devspace workflow run --file <path> [--arg key=value]... --json
devspace workflow status <run-id> --json
devspace workflow calls <run-id> --json
devspace workflow call <run-id> <call-index> --json
devspace workflow cancel <run-id> --json
devspace workflow ls --json
```

Named workflows are project files at `.devspace/workflows/<name>.js`.
`--script-path` is an alias for `--file`; repeat `--arg key=value` to pass
inputs. Poll `status` until the run is `completed`, `failed`, or `cancelled`.
Use `calls` for the compact child-call list and `call` for one call's details.
Use `--follow` instead of `--json` when a long-running shell can stream output.

## Write a workflow

Export literal metadata, then compose the available primitives. Return a
JSON-compatible value.

```js
export const meta = {
  name: 'review-auth',
  description: 'Review auth changes from two perspectives',
  phases: [{ title: 'Review' }, { title: 'Synthesize' }],
  concurrency: 2,
}

phase('Review')
const findings = await parallel([
  () => agent('Review the auth diff for correctness.', { label: 'correctness' }),
  () => agent('Review the auth diff for security.', { label: 'security' }),
])

phase('Synthesize')
const summary = await agent(
  `Synthesize these findings: ${JSON.stringify(findings)}`,
  { label: 'summary' },
)

return { findings, summary }
```

Primitives and options:

- `agent(prompt, options?)` delegates one task. Options are `label`, `phase`,
  `schema`, `profile`, `provider`, `model`, `effort`, and
  `isolation: 'worktree'`. Choose either `profile` or `provider`.
- `parallel([thunks])` runs independent tasks concurrently and keeps input
  order. `pipeline(items, ...stages)` runs dependent stages for each item.
- `phase(title)` and `log(message)` record useful progress.
- `workflow(nameOrRef, args?)` composes another workflow one level deep.
- `args` contains values supplied with `--arg`.

Use `devspace agents targets --json` before choosing a profile or provider.
Profiles provide reusable role instructions and defaults. Use worktree
isolation for parallel writers that could touch the same files; shared
isolation is suitable for readers or intentionally sequential writers.
Use `schema` when a later stage needs structured JSON.

## Common patterns

- Fan out correctness, security, and test reviews, then ask one agent to
  combine the findings.
- Process a list of files through analysis, implementation, and verification
  stages.
- Run competing implementations in isolated worktrees and compare their
  results before choosing one.

## Resume a run

Failed or cancelled runs can be resumed after fixing the workflow or its
inputs:

```bash
devspace workflow status <run-id> --json
devspace workflow run --resume <run-id> --json
devspace workflow run --resume <run-id> --file <updated-script> --json
```

Inspect `status`, `calls`, and individual `call` results before resuming.
Keep the same profile/provider and prompt for stages whose earlier results
should be reused.

Use a direct `devspace agents run` command for one independent delegation.
