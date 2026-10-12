# Changelog

## 0.2.0 - 2026-10-12

Config file, multiple plugin sources, and [Agent Plugins](https://github.com/agentplugins/agent-plugins-spec) 1.0.0 support. Without a config file nothing changes from 0.1.1.

- **Config file** `~/.agents/agent-plugin-support.json` and `<repo>/.agents/agent-plugin-support.json` with `sources` (`path`, `format`: `claude` | `agent-plugins` | `auto`, optional `label`, `enabled`) and `enabledPlugins`; JSON schema in `schema/`. Point at `~/.claude/plugins` directly, no symlink needed. `~` and config-relative paths work. Project sources come first and override user sources by path.
- **Enablement precedence** is now project config, user config, project `plugins.json`, user `plugins.json`. `plugins.json` is deprecated but still read.
- **Agent Plugins 1.0.0**: root `plugin.json` (closed field set, name rules, unknown fields reported and ignored), `skills/<dir>/SKILL.md` (immediate children, Agent Skills validation), `mcp.json` (strict `stdio` / `streamable-http` rules, `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`, URL and header checks, `PLUGIN_ROOT` / `PLUGIN_DATA` in the environment), realpath containment for every package path. `sse` servers are skipped with a report because OpenCode has no SSE client. Spec `1.1.0` (working draft) and unknown `$schema` values are rejected.
- **`com.harnesstap.opencode` extension** (`com.harnesstap.opencode/` and/or `extensions["com.harnesstap.opencode"]`): `commands/`, `agents/`, `hooks/hooks.json`, `instructions.md` for Agent Plugins packages. Hook processes get `PLUGIN_ROOT` / `PLUGIN_DATA` next to the `CLAUDE_*` variables.
- **Ids and duplicates.** Agent Plugins ids are `<name>@<label>`; Claude ids are unchanged. Two enabled plugins with the same name from different sources: first source wins, warning logged.
- **Dual manifests** (`.claude-plugin/plugin.json` plus an Agent Plugins `plugin.json`): Claude is primary and `mcp.json` servers are added from `claude` and `auto` sources; Agent Plugins only from `agent-plugins` sources. An invalid Agent Plugins manifest falls back to Claude with a warning.
- **CLI**: `list` shows `format`, `sourcePath`, `sourceLabel`, `sourceFormat`, `dualManifest`, `mcpSkipped` and `diagnostics` per plugin; new `sources` (alias `config`) prints the effective config; `enable` / `disable` write the config file when it exists (else `plugins.json`) and report `wroteFile`.
- **Fix:** the CLI printed nothing when started through the `node_modules/.bin` symlink (`npx`, global installs).
- Tests run the official [agent-plugins-conformance](https://github.com/agentplugins/agent-plugins-conformance) fixtures (vendored under `test/fixtures`, with license notes) and cross-check the validators against the official 1.0.0 JSON schemas.

## 0.1.1 - 2026-10-11

Fix plugins that Claude Code loads from their marketplace never showing up in OpenCode (for example a plugin in a `directory` marketplace whose `cache/<marketplace>/<plugin>/<version>/` copy Claude had swept).

- Resolve the plugin root the way Claude Code does, in this order: relative-path plugin of a `directory` / `file` marketplace (loaded in place, never from the cache), then `installPath` (absolute, or relative to the plugins dir), then `cache/<marketplace>/<plugin>/<version>/`, then the marketplace's own tree (`installLocation`, `marketplaces/<name>/`, `marketplaces/<name>.json`, or an `extraKnownMarketplaces` path) via the plugin entry's `source` in `marketplace.json`.
- Understand relative `source` strings (`./path`, `"."`, bare names under `metadata.pluginRoot`) and refuse `..`, backslashes, and paths that escape the marketplace. Object sources (`github`, `url`, `git-subdir`, `npm`, `archive`, `command`) only exist in Claude's cache, so they are reported as unresolved with a hint to refresh in Claude Code.
- Honor marketplace entries as manifests: an entry is the manifest when the plugin has no `plugin.json`; otherwise `strict` (default `true`) appends the entry's `commands` / `agents` / `skills` / `hooks`, and `strict: false` with entry components fails with "Plugin has conflicting manifests". Entry display fields override, manifest `version` wins.
- An unresolvable enabled plugin now logs a warning that lists every place tried (silent before). Set `OPENCODE_AGENT_PLUGIN_SUPPORT_DEBUG=1` for per-plugin resolution lines on stderr.
- `list` adds `resolvedVia` and `tried`, and `reason` now explains why a plugin is unresolved (`plugin root unresolved: ...`, replacing `installPath missing: ...`).

## 0.1.0 - 2026-10-09

First public release of `@harnesstap/opencode-agent-plugin-support` (OpenCode plugin id `opencode-agent-plugin-support`, CLI bin `opencode-agent-plugin-support`).

- Load Claude Code plugins from `~/.agents/plugins` (same layout as `~/.claude/plugins`) into OpenCode v2 and v1: skills, slash commands, agents, MCP, instructions, and command hooks.
- Isolate malformed `installed_plugins.json`, `plugin.json`, `hooks.json`, `.mcp.json`, and YAML frontmatter so one bad plugin does not block the rest.
- PreToolUse hook timeout is fail-closed; other hook events still do not block on timeout.
- CLI: `list`, `enable` / `disable`, `install-local` (errors if the directory is missing), `marketplace-add`.
- `${CLAUDE_PLUGIN_DATA}` directory is created on first use.
