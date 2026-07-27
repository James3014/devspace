---
name: subagents
description: Delegate focused work to isolated DevSpace coding agents.
---

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Choose a target

Prefer a matching named profile from `open_workspace`. Use a raw provider when
the user names that harness or no profile fits. Choose only profiles and
providers returned by `open_workspace`.

## Write the brief

Describe the task directly. Include decisions and constraints that exist only
in the parent conversation. Mention relevant paths or scope when useful. Do not
repeat project instructions that the child can discover from the repository.

## Run and continue

```bash
devspace agents run <profile-or-provider> "<brief>"
devspace agents show <id>
devspace agents run <id> "<follow-up>"
devspace agents ls
```

`run` with a profile or provider starts a child and returns its id. `show`
reads its latest status and response. `run` with an existing id continues the
same child session. `ls` lists sessions for the current project.

Do not invoke provider CLIs directly; use `devspace agents` so DevSpace keeps
session and provider handling consistent.

## Model and effort overrides

Normally omit `--model` and `--effort`. When an exact override is needed, read
`references/<provider>.md` first. Do not guess values or transfer an effort
name between providers merely because both use the same word.

```bash
devspace agents run <target> --model <model> --effort <effort> "<brief>"
```

## Direct subagent or workflow

Use a direct subagent for one focused delegation or a follow-up with the same
child. Use a dynamic workflow when the task needs programmed fan-out, stages,
branching, nesting, or replay.
