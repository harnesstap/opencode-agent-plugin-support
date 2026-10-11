# Changelog

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
