---
name: dynamic-workflows
description: Run programmable multi-agent workflows through the DevSpace CLI.
---

# DevSpace Dynamic Workflows

Use a workflow when the work benefits from a repeatable program: parallel
reviews, fan-out research, staged implementation, per-file pipelines, or a
review-and-fix loop. Use a direct subagent for one focused delegation.

This skill is CLI-only. A coding harness should create or select a workflow
script and invoke it with `devspace workflow`.

## CLI

```bash
devspace workflow run --file path/to/workflow.js [--arg key=value]... [--follow]
devspace workflow run --script-path path/to/workflow.js [--resume <run-id>] [--follow]
devspace workflow run --name <name> [--arg key=value]... [--follow]
devspace workflow status <run-id> [--follow]
devspace workflow cancel <run-id>
devspace workflow ls
devspace workflow calls <run-id>
devspace workflow call <run-id> <call-index>
```

Named scripts are stored in the project’s `.devspace/workflows/` directory.
Workflow commands are scoped to the current Git checkout (or the current
directory when it is not a Git project). Use `--follow` for a live terminal
handoff; otherwise poll with `status`.

`--arg key=value` passes JSON values when the value is valid JSON and otherwise
passes a string. A failed or cancelled run can be started again with
`workflow run --resume <run-id>` after reviewing its status and call results.

## Script capabilities

Workflow scripts are JavaScript modules with a metadata export and an async
body. The orchestration API includes:

| Capability | Use |
| --- | --- |
| `agent(prompt, options?)` | Ask one configured profile or provider to perform a unit of work. |
| `parallel(thunks)` | Run independent units together and collect their results. |
| `pipeline(items, ...stages)` | Apply the same sequence of agent stages to each item. |
| `phase(title)` | Group later work under a named stage. |
| `log(message)` | Emit progress text for the supervising harness. |
| `args` | Read values passed with `--arg`. |
| `workflow(nameOrPath, args?)` | Compose a named or project workflow as a step. |

An `agent` can select `profile` or `provider`, and can set `label`, `phase`,
`schema`, `model`, `effort`, or `isolation: 'worktree'`. Use a profile when one
is configured; use `provider` only when the target is intentional. `profile`
and `provider` are alternatives, not a combination.

The optional `schema` describes a JSON result, which is useful when later
stages consume structured findings. Prompts should say whether a child may
change files and what it should return.

## Basic script

```js
export const meta = {
  name: 'review-changes',
  description: 'Independent correctness and security review',
}

phase('Review')
const [correctness, security] = await parallel([
  () => agent('Review the diff for correctness bugs. Return file paths and concrete findings.', { label: 'correctness' }),
  () => agent('Review the diff for security issues. Return file paths, severity, and evidence.', { label: 'security' }),
])

return { correctness, security }
```

Run it with:

```bash
devspace workflow run --file .devspace/workflows/review-changes.js --follow
```

## Structured pipeline

```js
export const meta = { name: 'test-plan', description: 'Find and prioritize test gaps' }

return await pipeline(
  args.files,
  (file) => agent(`Find test gaps in ${file}`, {
    schema: {
      type: 'object',
      properties: { gaps: { type: 'array', items: { type: 'string' } } },
      required: ['gaps'],
    },
  }),
  (findings, file) => agent(`Prioritize these gaps for ${file}: ${JSON.stringify(findings)}`),
)
```

```bash
devspace workflow run --name test-plan --arg files='["src/parser.ts","src/parser.test.ts"]' --follow
```

For parallel writers, request `isolation: 'worktree'` and make the prompt
describe how the result should be handed back. For sequential edits that must
see one another’s files, keep the stages in a pipeline or ordinary sequence.
