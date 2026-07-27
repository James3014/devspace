# Cursor overrides

DevSpace connects to Cursor through ACP. `--model` selects the ACP `model`
option and `--effort` selects the ACP `thought_level` option.

Both option sets are announced by the running Cursor ACP session and may vary
by version or account. Do not invent a value. Omit the override unless the user
provided an exact value known to that Cursor installation.

```bash
devspace agents run cursor --model <exact-model> --effort <exact-thought-level> "<brief>"
```
