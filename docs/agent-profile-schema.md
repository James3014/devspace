# Subagent profile schema

DevSpace agent profiles are user-owned markdown files with YAML
frontmatter. They describe roles such as reviewer, explorer, or implementer.
DevSpace owns provider invocation.

Profiles are discovered from:

- `~/.devspace/agents/*.md`
- `.devspace/agents/*.md`

Packaged files under `examples/agents/` are starter templates only.

## Minimal shape

```md
---
schema: devspace-agent/v1
name: reviewer
description: Read-only reviewer for bugs, security risks, and missing tests.
provider: codex
model: gpt-5.4
effort: high
disabled: false
---

You are a read-only reviewer. Do not edit files.
Focus on correctness, security, test gaps, and maintainability.
Cite files and return concise findings.
```

## Frontmatter fields

### `schema`

Optional schema identifier:

```yaml
schema: devspace-agent/v1
```

### `name`

Stable profile identifier shown to the model and accepted by:

```bash
devspace agents run <name> "<prompt>"
```

Use lowercase kebab-case names. If omitted, DevSpace uses the filename without
`.md`.

### `description`

Required short purpose. This is exposed by `open_workspace` so the supervising
model can choose the right profile.

### `provider`

Required built-in provider id:

```yaml
provider: codex
provider: claude
provider: opencode
provider: pi
provider: cursor
provider: copilot
```

Unsupported or custom providers are rejected. DevSpace maps providers to their
native integration:

- `codex`: Codex SDK
- `claude`: Claude Code SDK
- `opencode`: OpenCode SDK
- `pi`: Pi RPC mode
- `cursor`: ACP
- `copilot`: ACP

### `model`

Optional provider model id or alias.

```yaml
model: gpt-5.4
model: sonnet
```

### `effort`

Optional provider reasoning effort, thinking level, or model variant. If omitted,
DevSpace lets the provider default apply. Values are provider-specific
passthrough strings; DevSpace does not translate names between harnesses.

```yaml
effort: low
effort: high
effort: xhigh
```

DevSpace passes this through to providers that expose a matching control:

- `claude`: SDK effort with adaptive thinking.
- `codex`: SDK model reasoning effort.
- `pi`: CLI `--thinking` (provider-native flag; DevSpace field is still `effort`).
- `opencode`: model variant.
- `cursor` and `copilot`: ACP thought-level config when supported.

Legacy profile frontmatter key `thinking:` is still accepted and maps to `effort`.

### `disabled`

Optional boolean. Disabled profiles are not exposed.

```yaml
disabled: true
```

## Markdown body

The body is the profile prompt prefix DevSpace prepends when launching that
profile. It is not included in `open_workspace` by default.

Recommended body content:

- When to use this profile.
- Whether the worker should act read-only or may make changes.
- Output format.
- Review or testing expectations.

## Model-facing workflow

The CLI skill teaches the model to discover usable targets and then use only
the small session surface it needs:

```bash
devspace agents targets --json
devspace agents ls
devspace agents run <profile-or-provider> "<prompt>"
devspace agents show <agent-id>
devspace agents run <agent-id> "<follow-up>"
```

`open_workspace` exposes compact, model-relevant capability metadata when agent
or workflow tooling is enabled:

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
      "description": "Read-only reviewer for bugs, security risks, and missing tests.",
      "provider": "codex",
      "model": "gpt-5.4",
      "effort": "high"
    }
  ]
}
```

Only enabled providers that pass the local availability check are returned;
profiles using a disabled or unavailable provider are omitted. The
`activeWorkflows` field, when workflows are enabled, contains only active run
ids, names, statuses, and running/completed/failed call counts.

`devspace agents ls` lists existing subagent sessions for the current workspace;
it does not list profile definitions. The full profile body stays out of the
model context until DevSpace launches the profile.

## Current non-goals

- Custom or arbitrary CLI-backed agents.
- Inferring changed files, tests, or diffs from worker output.
- Exposing raw provider transcripts by default.
- Teaching the model provider-specific CLIs.
- First-class MCP agent tools. Future tools should wrap the same provider
  adapter registry used by `devspace agents`.
