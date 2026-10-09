# Live OpenCode smoke

Automated tests in `test/all.test.ts` and `test/v2-entry.test.ts` prove that a fixture Claude plugin is parsed, that the v2 default export is `{ id, setup, server }`, and that a mocked v2 `setup(ctx)` registers skills, commands, MCP, agents, and hooks.

A full TUI run needs the `opencode` CLI, a model provider, and this package on `plugins` (v2) or `plugin` (v1).

## v2

```bash
npm install
npm run build

# scratch project — do not point plugins at a file
mkdir -p /tmp/oc-smoke
cat > /tmp/oc-smoke/opencode.json <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "$(pwd)",
      "options": {
        "skipInstalled": true,
        "extraPluginDirs": { "fixture-demo@local": "$(pwd)/test/fixtures/demo-plugin" }
      }
    }
  ]
}
JSON

cd /tmp/oc-smoke
opencode --version
# if a background service is running:
# opencode service restart
```

On OpenCode 2.0.24 a local `{ package, options }` entry is flattened to the directory string (options dropped). The reliable smoke path is `plugins: ["/abs/this-repo"]` plus `install-local` of the fixture (isolated `HOME` if you do not want to touch a real registry).

Verified on **OpenCode 2.0.24** (`@opencode/cli`) in this environment with `opencode serve` + authenticated `/api/*`:

- `GET /api/plugin` — `opencode-claude-plugins` `state.status=active`, source `local` `/…/index.js` (no v1 SchemaError)
- `GET /api/skill` — `demo-skill`
- `GET /api/command` — `fixture-demo:hello`
- `GET /api/mcp` — `fixture-demo:echo-api` and `fixture-demo:fixture-stdio` registered (`${CLAUDE_PLUGIN_ROOT}` expanded; fixture process exits by design)
- `GET /api/agent` / `opencode debug agents` — `fixture-demo:reviewer` `mode: subagent` with the markdown `system` prompt (via `agent.update`, no files copied)

Hook block/rewrite/`patch`→Edit were covered by mocked `setup(ctx)` tests, not a model-backed TUI session.

Then start OpenCode in that directory (or `opencode serve` / `opencode api get /api/plugin` if those exist on your build) and check:

1. Plugin `opencode-claude-plugins` is active (not a SchemaError about `default`).
2. `/fixture-demo:hello world` is a slash command.
3. `@fixture-demo:reviewer` is mentionable as a subagent (registered via `agent.update`, not copied files).
4. `skill` tool lists `demo-skill`.
5. MCP `fixture-demo:echo-api` is in config (`disabled: false`; the fixture server exits immediately).
6. A `shell` tool call containing `BLOCKME` is rejected by the PreToolUse hook.
7. A `patch` (or `edit`) tool call fires PostToolUse (`Write|Edit` matcher) and appends `fixture-post-tool-ok`.
8. Session instructions include `fixture-instructions-ok` and SessionStart `fixture-session-ok` on **every** model call, not only the first.

Installing via the CLI registry:

```bash
mkdir -p ~/.agents/plugins
# if ~/.agents/plugins → ~/.claude/plugins, either use extraPluginDirs or:
npx opencode-claude-plugins install-local ./test/fixtures/demo-plugin fixture-demo@local --write-claude-registry
```

## v1

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-claude-plugins"]
}
```

Same fixture checks, but tool ids are `bash` / `edit` / `write` / `task`, MCP uses `enabled`, and agents land in `config.agent`.
