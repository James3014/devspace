# Pi overrides

DevSpace passes `--model` to Pi and maps `--effort` to Pi's native
`--thinking` option.

Pi accepts these thinking labels:

- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

Pi applies model-specific capability rules, so a selected model may expose or
honor only a subset. Prefer the profile or provider default when uncertain.

```bash
devspace agents run pi --model <model> --effort <supported-level> "<brief>"
```
