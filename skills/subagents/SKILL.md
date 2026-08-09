---
name: subagents
description: Delegate focused coding work to DevSpace subagents from a shell.
---

# DevSpace subagents

Use a subagent for one focused piece of work: a second opinion, a narrow
investigation, a test plan, or an isolated implementation. Use a dynamic
workflow when the task needs several stages or programmable fan-out.

This skill uses the DevSpace CLI from any coding harness that can run shell
commands.

## Discover available targets

Run this before choosing a profile or provider when the available targets are
not already known:

```bash
devspace agents targets
devspace agents targets --json
```

Configured profiles are preferred because they provide a reusable description
and defaults. A raw provider is useful when the user names a specific harness
or no matching profile exists. Do not guess a profile name.

## Start and inspect work

```bash
devspace agents run <profile-or-provider> "<self-contained brief>"
devspace agents show <agent-id>
devspace agents ls
```

The `run` command returns an agent id immediately. Use `show` to wait for the
final response or to read a later update. `ls` lists sessions for the current
project scope. Running the command from a subdirectory uses the enclosing Git
checkout; a non-Git directory uses the current directory.

To continue the same session, use its id as the target:

```bash
devspace agents run <agent-id> "Follow up by checking the failing test and report the cause."
```

## Write a useful brief

Give the child everything it needs without relying on the parent conversation:

- the exact goal and expected output;
- relevant files, commands, or boundaries;
- whether it may modify files;
- the checks it should run before reporting back.

The child’s final response is the handoff. Ask for concise findings, paths, or
patch-ready changes rather than a broad narrative.

## Optional model controls

Profiles normally supply model and effort defaults. When an exact override is
needed, pass:

```bash
devspace agents run <target> --model <model> --effort <level> "<brief>"
```

Only use values supplied by the user, a configured profile, or the target
catalog. Omit overrides when the provider’s accepted values are unknown.

## Common uses

```bash
# Ask for an independent security review.
devspace agents run reviewer "Review the authentication changes for vulnerabilities. Return findings with file paths and severity."

# Delegate a small implementation and ask for verification.
devspace agents run implementer "Add a regression test for the parser bug. Run the focused test and report the result."

# Continue after the parent has inspected the first response.
devspace agents run agt_1234abcd "The test still fails on Windows. Investigate only the path handling and report a fix."
```

Keep direct delegation to one focused child at a time. For independent
reviewers, staged implementation, or repeatable fan-out, use the
`dynamic-workflows` skill.
