# Codex overrides

DevSpace passes `--model` to the Codex SDK and maps `--effort` to model
reasoning effort.

The SDK accepts these effort labels:

- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

The selected model may support only a subset. Prefer the profile or provider
default. Omit `--effort` when the exact model capability is unknown.

```bash
devspace agents run codex --model <model> --effort <supported-level> "<brief>"
```
