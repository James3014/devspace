# Claude overrides

DevSpace passes `--model` to the Claude Agent SDK. When `--effort` is present,
DevSpace passes the SDK effort value with adaptive thinking enabled.

The SDK effort vocabulary is:

- `low`
- `medium`
- `high`
- `xhigh`
- `max`

Support is model-dependent. Some Claude models expose only part of this set or
do not support the effort option. Prefer configured defaults and omit an
override when the selected model's capability is unknown.

```bash
devspace agents run claude --model <model> --effort <supported-level> "<brief>"
```
