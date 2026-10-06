# Live OpenCode smoke

Automated tests in `test/all.test.ts` prove that a fixture Claude plugin is parsed and injected into an OpenCode-shaped config object.

A full TUI run needs the `opencode` CLI, a model provider, and this package on `plugin`.

```bash
npm install
npm run build

mkdir -p ~/.agents/plugins
npx opencode-claude-plugins install-local ./test/fixtures/demo-plugin fixture-demo@local

# opencode.json in a scratch repo
cat > /tmp/oc-smoke/opencode.json <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-claude-plugins"]
}
JSON
```

Then start OpenCode in that directory and check:

1. `/fixture-demo:hello world` is a slash command.
2. `@fixture-demo:reviewer` is mentionable.
3. `skill` tool lists `demo-skill`.
4. MCP `fixture-demo:echo-api` is in config (the fixture server exits immediately; it is only a mapping check).
5. A bash tool call containing `BLOCKME` is rejected by the PreToolUse hook.

Could not verify in this cloud workspace: interactive TUI, model-backed skill invocation, and MCP process lifetime.
