# Copilot overrides

DevSpace connects to Copilot through ACP. `--model` selects the ACP `model`
option and `--effort` selects the ACP `thought_level` option.

Both option sets are announced by the running Copilot ACP session and may vary
by version or account. Do not invent a value. Omit the override unless the user
provided an exact value known to that Copilot installation.

```bash
devspace agents run copilot --model <exact-model> --effort <exact-thought-level> "<brief>"
```
