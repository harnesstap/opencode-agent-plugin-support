# Contributing

```bash
npm install
npm test
npm run build
```

- `npm test` — Vitest (`test/all.test.ts`): manifest/path containment, enablement merge, `installed_plugins` v1/v2/v3, frontmatter, env expansion, tool-name mapping, hook JSON / exit code 2, fixture component load, config injection.
- Integration in the same file: a fixture Claude plugin (skill, MCP, command, agent, instructions, hooks) is discovered from a fake `~/.agents/plugins` tree and injected so OpenCode-shaped config contains each resource.
- Live TUI smoke: [test/smoke.md](test/smoke.md). That needs a logged-in `opencode` binary; this environment may not have one.

See [ARCHITECTURE.md](ARCHITECTURE.md) for config injection, component mapping, hook stdin/exit codes, and registry versions.
