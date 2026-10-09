# @harnesstap/opencode-agent-plugin-support

[![CI](https://github.com/harnesstap/opencode-agent-plugin-support/actions/workflows/ci.yml/badge.svg)](https://github.com/harnesstap/opencode-agent-plugin-support/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@harnesstap/opencode-agent-plugin-support.svg)](https://www.npmjs.com/package/@harnesstap/opencode-agent-plugin-support)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/harnesstap/opencode-agent-plugin-support/blob/main/LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-v2%20%7C%20v1%20%E2%89%A51.18.29-0ea5e9)](#compatibility)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugins%20compatible-7c3aed)](#compatibility)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

Loads **Claude Code plugins** into OpenCode as native skills, slash commands, subagents, MCP servers, instructions, and lifecycle hooks. Plugin files stay where they are; nothing is copied into `.opencode/` or `~/.agents/skills`.

Unrelated to the former unscoped npm package `opencode-claude-plugins`.

## Quickstart

Plugins are read from **`~/.agents/plugins`**, same layout as `~/.claude/plugins`.

1. **Point `~/.agents/plugins` at your Claude plugin cache** (skip if you already keep plugins there):

   ```bash
   mkdir -p ~/.agents
   ln -s ~/.claude/plugins ~/.agents/plugins
   ```

2. **Add this package** to `opencode.json` (`plugins`, not `plugin`):

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["@harnesstap/opencode-agent-plugin-support"]
   }
   ```

3. **Restart OpenCode** (`opencode service restart` if a background service is running).

### From git (local directory)

v2 only loads `index.js` / `index.ts` at the **folder root**. It ignores `package.json` `"main"`, and a path to a file is rejected.

```bash
git clone https://github.com/harnesstap/opencode-agent-plugin-support.git
cd opencode-agent-plugin-support
npm install
npm run build
```

```json
{
  "plugins": ["/absolute/path/to/opencode-agent-plugin-support"]
}
```

Restart OpenCode. Do **not** point `plugins` at `dist/index.js` or `src/index.ts`.

## Security

Hook commands (`type: "command"` in `hooks.json`) run as **your user**: full environment, project cwd, and a **30s default timeout** (`timeout` in `hooks.json` is seconds). They can run any shell you would.

- **PreToolUse timeout is fail-closed:** if that hook hits the timeout, the tool call is blocked. A hung “deny this command” hook must not fail open.
- **Other hook events** still do not block on timeout (the process is killed; OpenCode continues). Exit `2` / JSON `deny` still block where those events support it.

Malformed `installed_plugins.json`, `plugin.json`, `hooks.json`, `.mcp.json`, or YAML frontmatter is skipped with a warning; other plugins keep loading.

See [SECURITY.md](https://github.com/harnesstap/opencode-agent-plugin-support/blob/main/SECURITY.md) to report a vulnerability.

## Options and compatibility

Object form (npm package; local directory+options is dropped on OpenCode **2.0.24**):

```json
{
  "plugins": [
    {
      "package": "@harnesstap/opencode-agent-plugin-support",
      "options": {
        "extraPluginDirs": { "my-plugin@local": "/path/to/claude-plugin" },
        "skipInstalled": false,
        "mcpDisabled": false
      }
    }
  ]
}
```

`extraPluginDirs` loads extra Claude plugin trees without writing a registry. `skipInstalled` skips `~/.agents/plugins/installed_plugins.json`. Prefer `install-local` (or that registry file) for Claude plugins if you need options on a local checkout.

### OpenCode v1

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@harnesstap/opencode-agent-plugin-support"]
}
```

Needs OpenCode **1.18.29+** (object entrypoint with `server()`).

### Compatibility

OpenCode **v2** is the primary target. A v1 `server()` export remains for OpenCode 1.18.29+. v2 does not run v1 plugin implementations.

`install-local` **refuses** to write through a `~/.agents/plugins` → `~/.claude/plugins` symlink unless you pass `--write-claude-registry`.

## Where plugins live

```text
~/.agents/plugins/
  installed_plugins.json
  known_marketplaces.json
  marketplaces/<name>/
  cache/<marketplace>/<plugin>/<version>/
  data/<plugin-id>/
```

`installPath` from `installed_plugins.json` is used as-is (`~` / `$HOME` expanded). Relative paths are resolved from `~/.agents/plugins/`. `${CLAUDE_PLUGIN_DATA}` is `~/.agents/plugins/data/<slug>/` and is created on first use.

Project-scoped installs for **other** repos are ignored. If several entries remain, the one whose directory exists wins.

### Enablement

| File | Role |
| --- | --- |
| `~/.agents/plugins.json` | User-level `enabledPlugins` |
| `<repo>/.agents/plugins.json` | Project overlay; keys override the user file |

Claude’s `~/.claude/settings.json` is not read. Every resolvable installed plugin is **enabled** unless `enabledPlugins` sets it to `false`.

## CLI

Bin name: `opencode-agent-plugin-support`.

```bash
npx @harnesstap/opencode-agent-plugin-support list
npx @harnesstap/opencode-agent-plugin-support enable name@marketplace
npx @harnesstap/opencode-agent-plugin-support disable name@marketplace --project
npx @harnesstap/opencode-agent-plugin-support install-local ./my-claude-plugin [name@local]
npx @harnesstap/opencode-agent-plugin-support install-local ./my-claude-plugin --write-claude-registry
npx @harnesstap/opencode-agent-plugin-support marketplace-add my-market github:org/repo
```

After a global install, the same commands work as `opencode-agent-plugin-support …`.

- `list` — installed plugins, effective on/off, and source (`default` | `user` | `project`).
- `enable` / `disable` — write the user file, or `--project` for the repo file.
- `install-local` — register a local directory (must exist). Does not clone git marketplaces.
- `marketplace-add` — record an extra marketplace (`github:org/repo` or a path).

## Support

| Claude | OpenCode v2 | OpenCode v1 | Notes |
| --- | --- | --- | --- |
| Skills | `ctx.skill.transform` | `config.skills.paths` | Folder names as skill names. Also invocable as `/plugin:skill`. `user-invocable: false` skips the slash command. `disable-model-invocation: true` keeps `/plugin:skill` but omits the skill from the model's list. OpenCode requires kebab-case `name` + `description` in `SKILL.md`. |
| MCP | `ctx.mcp.transform` (`disabled`) | `config.mcp` (`enabled`) | `${CLAUDE_PLUGIN_ROOT}` / `_DATA` / `_PROJECT_DIR` / `$ENV` expanded. stdio → local; `url` / `http` / `sse` / `ws` → remote. |
| Commands | `ctx.command.transform` | `config.command` | Namespaced `plugin:command`, plus `/plugin:skill` for each user-invocable plugin skill. `$ARGUMENTS` works. An existing plugin command of the same name wins. |
| Instructions | re-injected on every `session.context` | `config.instructions` + system transform | Plugin-root `CLAUDE.md` / `AGENTS.md` / `INSTRUCTIONS.md`. |
| Agents | `ctx.agent.transform` `update()` (inserts if missing) | `config.agent` | Namespaced `plugin:agent`, `mode: "subagent"`. |
| Hooks | tool / session / permission / event subscribe | v1 hook object | Command hooks (`type: "command"`) only. |

**Hooks wired on v2:** PreToolUse (block + `updatedInput`), PostToolUse / PostToolUseFailure (`additionalContext`), UserPromptSubmit, SessionStart (matcher = `startup` / `clear` / `compact`), SessionEnd, Stop (`session.idle`), PermissionRequest (`permission.evaluate`), PreCompact (`session.compaction`).

**Not loaded:** LSP, output styles, themes, monitors, workflows, in-process JS mods, `.mcpb` bundles, HTTP/prompt/MCP/agent hooks, and most other Claude hook events.

Skill **ids** stay kebab-case (OpenCode cannot namespace them as `plugin:name`). Invoke a plugin skill with `/plugin:skill` even if a user skill shares the name. Commands, agents, and MCP **are** namespaced as `plugin:component`.

v2 built-in tool ids `shell`, `patch`, and `subagent` map to Claude `Bash`, `Edit`, and `Task` for hook matchers.

This OpenCode plugin’s `id` is `opencode-agent-plugin-support`.

## License

MIT

How injection works: [ARCHITECTURE.md](https://github.com/harnesstap/opencode-agent-plugin-support/blob/main/ARCHITECTURE.md). Development: [CONTRIBUTING.md](https://github.com/harnesstap/opencode-agent-plugin-support/blob/main/CONTRIBUTING.md).
