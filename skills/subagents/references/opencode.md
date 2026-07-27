# OpenCode overrides

DevSpace passes `--model` to OpenCode. A model may be written as
`<provider>/<model>` when the OpenCode provider id is needed.

DevSpace maps `--effort` to the OpenCode model `variant` field. Variant names
are model-specific; there is no safe global effort list. Omit `--effort` unless
the exact variant is already known from the user's configuration or request.

```bash
devspace agents run opencode --model <provider/model> --effort <exact-variant> "<brief>"
```
