# Contributing

```bash
npm install
npm test
npm run build
```

- `npm test` — Vitest (`test/all.test.ts`, `test/v2-entry.test.ts`): manifest/path containment, enablement merge, `installed_plugins` v1/v2/v3, foreign-project ranking, relative install paths, skill dedupe, frontmatter, env expansion, v1/v2 tool-name mapping (including MCP), hook JSON / exit code 2, SessionStart source matchers, fixture component load, v1 config injection, v2 `{ id, setup, server }` entry and mocked `setup(ctx)`.
- Live TUI smoke: [test/smoke.md](test/smoke.md). That needs a logged-in `opencode` binary; this environment may not have one.

See [ARCHITECTURE.md](ARCHITECTURE.md) for v2 transforms vs v1 config injection, component mapping, hook stdin/exit codes, and registry versions.
