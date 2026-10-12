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

Verified on **OpenCode 2.0.26** (`@opencode/cli`) with isolated `HOME`, `plugins: ["/abs/this-repo"]`, `install-local` of the fixture, `opencode serve`, and authenticated `/api/*`:

- `GET /api/plugin` — `opencode-agent-plugin-support` `state.status=active`, source `local` `/…/index.js` (no v1 SchemaError)
- `GET /api/skill` — `demo-skill`, `legacy-context`, `hello` (not `manual-deploy`, which is `disable-model-invocation`)
- `GET /api/command` — `fixture-demo:hello`, `fixture-demo:demo-skill`, `fixture-demo:manual-deploy` (not `fixture-demo:legacy-context`). Public `Command.Info` is name+description only; templates are asserted in unit tests (`fixture-skill-ok` / plugin `SKILL.md` path).
- `GET /api/mcp` — `fixture-demo:echo-api` and `fixture-demo:fixture-stdio` registered (`${CLAUDE_PLUGIN_ROOT}` expanded; fixture process exits by design)
- `GET /api/agent` / `opencode debug agents` — `fixture-demo:reviewer` `mode: subagent` with the markdown `system` prompt (via `agent.update`, no files copied)

Hook block/rewrite/`patch`→Edit were covered by mocked `setup(ctx)` tests, not a model-backed TUI session.

Then start OpenCode in that directory (or `opencode serve` / `opencode api get /api/plugin` if those exist on your build) and check:

1. Plugin `opencode-agent-plugin-support` is active (not a SchemaError about `default`).
2. `/fixture-demo:hello world` is a slash command. `/fixture-demo:demo-skill` and `/fixture-demo:manual-deploy` are skill commands whose templates include the plugin `SKILL.md` body.
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
npx @harnesstap/opencode-agent-plugin-support install-local ./test/fixtures/demo-plugin fixture-demo@local --write-claude-registry
```

## Config file, Claude plugin and Agent Plugins package (0.2.0)

Verified on **OpenCode 2.0.26** (`npm i @opencode/cli@2.0.26`) with an isolated `HOME` / `XDG_*`, no symlinks:

```bash
S=/tmp/ocsmoke; mkdir -p $S/home/.claude/plugins/cache/local/fixture-demo/1.0.0 $S/home/.agents $S/home/pkgs $S/proj
cp -r test/fixtures/demo-plugin/. $S/home/.claude/plugins/cache/local/fixture-demo/1.0.0/
echo '{"version":2,"plugins":{"fixture-demo@local":[{"scope":"user","installPath":"'$S'/home/.claude/plugins/cache/local/fixture-demo/1.0.0"}]}}' > $S/home/.claude/plugins/installed_plugins.json
cp -r test/fixtures/agent-plugins/ap-demo $S/home/pkgs/ap-demo
cat > $S/home/.agents/agent-plugin-support.json <<'JSON'
{ "sources": [ { "path": "~/.claude/plugins", "format": "claude" },
               { "path": "~/pkgs", "format": "agent-plugins", "label": "pkgs" } ] }
JSON
echo '{ "plugins": ["'$(pwd)'"] }' > $S/proj/opencode.json
cd $S/proj
export HOME=$S/home XDG_CONFIG_HOME=$HOME/.config XDG_DATA_HOME=$HOME/.local/share XDG_STATE_HOME=$HOME/.local/state XDG_CACHE_HOME=$HOME/.cache
opencode service start
opencode api -H "x-opencode-directory: $S/proj" GET /api/mcp   # also /api/plugin /api/skill /api/command /api/agent
```

`opencode api --standalone` and a request without the `x-opencode-directory` header do not load project plugins; use the service and the header.

Observed: plugin `opencode-agent-plugin-support` active; skills `greet` (Agent Plugins) plus `hello`, `legacy-context`, `demo-skill` (Claude); commands `ap-demo:greet`, `ap-demo:hello`, `ap-demo:inline-hi`, `fixture-demo:hello`, `fixture-demo:demo-skill`, `fixture-demo:manual-deploy`; agents `ap-demo:helper` and `fixture-demo:reviewer` (`subagent`); MCP `ap-demo:whoami` **connected** (the fixture servers that exit, point at example.com, or at an unused port report `failed` by design), with the `sse` and malformed entries never registered. To see what OpenCode launched the server with, make `mcp-server.mjs` write its environment into `$PLUGIN_DATA` at startup: `PLUGIN_ROOT` and `PLUGIN_DATA` were set, `cwd` was `PLUGIN_DATA`, `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` were expanded once in `args` and `env`, and `$HOME` / `${CLAUDE_PLUGIN_ROOT}` stayed literal.

## v1

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@harnesstap/opencode-agent-plugin-support"]
}
```

Same fixture checks, but tool ids are `bash` / `edit` / `write` / `task`, MCP uses `enabled`, and agents land in `config.agent`.
