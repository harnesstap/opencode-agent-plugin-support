# Changelog

## 0.1.0 - 2026-10-09

First public release of `@harnesstap/opencode-agent-plugin-support` (OpenCode plugin id `opencode-agent-plugin-support`, CLI bin `opencode-agent-plugin-support`).

- Load Claude Code plugins from `~/.agents/plugins` (same layout as `~/.claude/plugins`) into OpenCode v2 and v1: skills, slash commands, agents, MCP, instructions, and command hooks.
- Isolate malformed `installed_plugins.json`, `plugin.json`, `hooks.json`, `.mcp.json`, and YAML frontmatter so one bad plugin does not block the rest.
- PreToolUse hook timeout is fail-closed; other hook events still do not block on timeout.
- CLI: `list`, `enable` / `disable`, `install-local` (errors if the directory is missing), `marketplace-add`.
- `${CLAUDE_PLUGIN_DATA}` directory is created on first use.
