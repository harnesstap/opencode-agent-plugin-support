# @harnesstap/opencode-agent-plugin-support

[![CI](https://github.com/harnesstap/opencode-agent-plugin-support/actions/workflows/ci.yml/badge.svg)](https://github.com/harnesstap/opencode-agent-plugin-support/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@harnesstap/opencode-agent-plugin-support.svg)](https://www.npmjs.com/package/@harnesstap/opencode-agent-plugin-support)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/harnesstap/opencode-agent-plugin-support/blob/main/LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-v2%20%7C%20v1%20%E2%89%A51.18.29-0ea5e9)](#compatibility)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugins%20compatible-7c3aed)](#compatibility)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

Loads **Claude Code plugins** and **[Agent Plugins](https://agent-plugins.org)** packages into OpenCode as native skills, slash commands, subagents, MCP servers, instructions, and lifecycle hooks. Plugin files stay where they are; nothing is copied into `.opencode/` or `~/.agents/skills`.

Unrelated to the former unscoped npm package `opencode-claude-plugins`.

## Quickstart

1. **Tell it where your plugins are.** Either:

   **a. Config file** (recommended). Point straight at Claude's plugin directory, no symlink:

   ```bash
   mkdir -p ~/.agents
   cat > ~/.agents/agent-plugin-support.json <<'JSON'
   {
     "$schema": "https://raw.githubusercontent.com/harnesstap/opencode-agent-plugin-support/main/schema/agent-plugin-support.schema.json",
     "sources": [
       { "path": "~/.claude/plugins", "format": "claude" }
     ]
   }
   JSON
   ```

   **b. Zero config.** With no config file, plugins are read from `~/.agents/plugins`, same layout as `~/.claude/plugins`. Symlink it:

   ```bash
   mkdir -p ~/.agents
   ln -s ~/.claude/plugins ~/.agents/plugins
   ```

   Codex also uses `~/.agents/plugins/` for its own plugin files; if you share that directory, prefer the config file and name each tool's directory explicitly.

2. **Add this package** to `opencode.json` (`plugins`, not `plugin`):

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["@harnesstap/opencode-agent-plugin-support"]
   }
   ```

3. **Restart OpenCode** (`opencode service restart` if a background service is running).

Check what was found with `npx @harnesstap/opencode-agent-plugin-support list` (plugins) and `... sources` (effective config).

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

## Configuration

`~/.agents/agent-plugin-support.json` (user) and `<repo>/.agents/agent-plugin-support.json` (project). Both are optional; a JSON schema is at [`schema/agent-plugin-support.schema.json`](schema/agent-plugin-support.schema.json).

```json
{
  "$schema": "https://raw.githubusercontent.com/harnesstap/opencode-agent-plugin-support/main/schema/agent-plugin-support.schema.json",
  "sources": [
    { "path": "~/.claude/plugins", "format": "claude" },
    { "path": "~/.agents/plugins", "format": "agent-plugins" }
  ],
  "enabledPlugins": { "oh-my-claudecode@omc": false }
}
```

**`sources`**: directories to load plugins from, in priority order.

| Field | |
| --- | --- |
| `path` | Directory. `~` is expanded; a relative path is relative to the config file's directory. |
| `format` | `claude`, `agent-plugins`, or `auto` (default). See below. |
| `label` | Suffix of Agent Plugins ids (`<name>@<label>`). Default: the directory name, or its parent's name when the directory is called `plugins` (`~/.agents/plugins` becomes `agents`). |
| `enabled` | `false` switches a source off, for example in a project to turn off a user source. |

A bare string is shorthand for `{ "path": "...", "format": "auto" }`.

| `format` | What the directory is |
| --- | --- |
| `claude` | A Claude plugin tree: `installed_plugins.json`, `known_marketplaces.json`, `cache/`, `marketplaces/`; directory marketplaces are read in place. Exactly the 0.1.x behavior. |
| `agent-plugins` | A directory whose immediate children are Agent Plugins packages (a root `plugin.json` declaring an agent-plugins.org `$schema`). Children named `cache`, `data`, `marketplaces`, `repos`, or starting with `.` are skipped. |
| `auto` | Decides per plugin by its manifests: the registry in `installed_plugins.json` if there is one, plus every child directory with a `.claude-plugin/plugin.json` (Claude) or an Agent Plugins `plugin.json`. |

**Merging.** Project sources come first, then user sources; a project entry with the same resolved path as a user entry replaces it. If no config file declares `sources`, the default is one `claude` source at `~/.agents/plugins`. If two enabled plugins from different sources have the same name, the first source wins and a warning is logged.

**Plugin ids.** `claude` plugins keep `name@marketplace`. Agent Plugins packages are `<name>@<label>`, with `name` from `plugin.json`: `greeter@agents`, or whatever `label` you set. `list` prints every id.

### Enablement

Plugins are enabled unless set to `false`. Highest precedence first:

1. `<repo>/.agents/agent-plugin-support.json` `enabledPlugins`
2. `~/.agents/agent-plugin-support.json` `enabledPlugins`
3. `<repo>/.agents/plugins.json` (legacy)
4. `~/.agents/plugins.json` (legacy)

> **Deprecated:** `plugins.json` still works and is read at lower precedence, but new setups should use `agent-plugin-support.json`. `extraKnownMarketplaces` is still read from `plugins.json` only.

Claude's `~/.claude/settings.json` is not read.

### Where data lives

`${CLAUDE_PLUGIN_DATA}` (Claude format) and `${PLUGIN_DATA}` (Agent Plugins format) are both `~/.agents/plugins/data/<id with unsafe characters replaced by "-">/`, created on first use, whichever sources you configure. Plugin updates and source changes do not move it.

## Security

Hook commands (`type: "command"` in `hooks.json`) run as **your user**: full environment, project cwd, and a **30s default timeout** (`timeout` in `hooks.json` is seconds). They can run any shell you would.

- **PreToolUse timeout is fail-closed:** if that hook hits the timeout, the tool call is blocked. A hung “deny this command” hook must not fail open.
- **Other hook events** still do not block on timeout (the process is killed; OpenCode continues). Exit `2` / JSON `deny` still block where those events support it.

Malformed `installed_plugins.json`, `plugin.json`, `hooks.json`, `.mcp.json`, `mcp.json`, config files, or YAML frontmatter are skipped with a warning; other plugins keep loading. A repo can declare `sources` in `<repo>/.agents/agent-plugin-support.json`, so only open repositories you trust (the same is true of OpenCode's own project config).

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

`extraPluginDirs` loads extra plugin directories (Claude or Agent Plugins, detected from the manifests) without writing a registry. `skipInstalled` skips discovery from every configured source. Prefer `install-local` (or that registry file) for Claude plugins if you need options on a local checkout.

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

## Claude plugin trees

```text
~/.agents/plugins/          (or any `claude` source)
  installed_plugins.json
  known_marketplaces.json
  marketplaces/<name>/
  cache/<marketplace>/<plugin>/<version>/
  data/<plugin-id>/
```

Plugin roots are found the way Claude Code finds them: a relative-path plugin of a local (`directory` / `file`) marketplace is read in place from that marketplace; otherwise `installPath` from `installed_plugins.json` (`~` / `$HOME` expanded, relative paths resolved from the source directory), then `cache/<marketplace>/<plugin>/<version>/`, then the marketplace clone's plugin `source`. Plugins that only exist in Claude's cache (`github`, `git-subdir`, `npm`, ... sources) cannot be rebuilt here; refresh them in Claude Code. Details in [ARCHITECTURE.md](ARCHITECTURE.md).

Project-scoped installs for **other** repos are ignored. If several entries remain, the one whose directory exists wins.

## Agent Plugins

Supports [Agent Plugins **1.0.0**](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md) (the only published version): a root `plugin.json` with `"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"`, `skills/<dir>/SKILL.md`, and `mcp.json`. Schemas are recognized locally and never fetched. A `1.1.0` (working draft) or unknown `$schema` rejects the plugin with a clear reason, as the spec requires for unsupported versions.

OpenCode-specific commands, agents, hooks, and instructions go in the client extension `com.harnesstap.opencode/` (Claude-like layout) and/or `extensions["com.harnesstap.opencode"]` in `plugin.json`:

```text
my-plugin/
  plugin.json
  skills/greet/SKILL.md
  mcp.json
  com.harnesstap.opencode/
    commands/hello.md
    agents/helper.md
    hooks/hooks.json
    instructions.md
```

Hook commands get `PLUGIN_ROOT` and `PLUGIN_DATA` next to the `CLAUDE_*` variables, and `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` are expanded in `hooks.json`.

A plugin with **both** a `.claude-plugin/plugin.json` and an Agent Plugins `plugin.json`: from a `claude` or `auto` source, Claude is primary and the Agent Plugins `mcp.json` servers are added (a server name Claude already defines keeps the Claude definition; a differing `name` logs a warning and the Claude name stays the prefix). From an `agent-plugins` source, only the Agent Plugins side is read. An invalid Agent Plugins manifest on such a plugin falls back to Claude with a warning.

## CLI

Bin name: `opencode-agent-plugin-support`.

```bash
npx @harnesstap/opencode-agent-plugin-support list
npx @harnesstap/opencode-agent-plugin-support sources
npx @harnesstap/opencode-agent-plugin-support enable name@marketplace
npx @harnesstap/opencode-agent-plugin-support disable name@marketplace --project
npx @harnesstap/opencode-agent-plugin-support install-local ./my-claude-plugin [name@local]
npx @harnesstap/opencode-agent-plugin-support install-local ./my-claude-plugin --write-claude-registry
npx @harnesstap/opencode-agent-plugin-support marketplace-add my-market github:org/repo
```

After a global install, the same commands work as `opencode-agent-plugin-support …`.

- `list` — every plugin with effective on/off and where that was decided (`source`: `default` | `user` | `project`, plus `sourceFile`), the `format` it was loaded as (`claude` | `agent-plugins`), its configured source (`sourcePath`, `sourceLabel`, `sourceFormat`), `dualManifest`, the resolved `root`, how it was found (`resolvedVia`), every location tried (`tried`), `reason` when it is off or unresolved, MCP servers left out (`mcpSkipped`), and `diagnostics`.
- `sources` (alias `config`) — the effective config: which config files exist, the merged sources with labels and origin, and every `enabledPlugins` key with the file that decides it. Reads config only; it does not load plugins. Set `OPENCODE_AGENT_PLUGIN_SUPPORT_DEBUG=1` to log resolution to stderr.
- `enable` / `disable` — write `agent-plugin-support.json` in the user directory (or the repo with `--project`) when that file exists, otherwise the legacy `plugins.json`. Other fields of the file are kept.
- `install-local` — register a local directory in `~/.agents/plugins` (must exist). Does not clone git marketplaces. Prints a note if `~/.agents/plugins` is not one of your sources.
- `marketplace-add` — record an extra marketplace (`github:org/repo` or a path).

## Support

| Component | OpenCode v2 | OpenCode v1 | Claude format | Agent Plugins format |
| --- | --- | --- | --- | --- |
| Skills | `ctx.skill.transform` | `config.skills.paths` | `skills/**/SKILL.md`, manifest `skills` paths, root `SKILL.md`. Lenient frontmatter. Invocable as `/plugin:skill`; `user-invocable: false` skips the command, `disable-model-invocation: true` keeps the command but hides the skill from the model. | Immediate children `skills/<dir>/SKILL.md` only, validated as [Agent Skills](https://agentskills.io/specification) (name equals the directory, description required); an invalid skill is skipped, siblings load. |
| MCP | `ctx.mcp.transform` (`disabled`) | `config.mcp` (`enabled`) | `.mcp.json` / manifest `mcpServers`. `${CLAUDE_PLUGIN_ROOT}` / `_DATA` / `_PROJECT_DIR` / `$ENV` expanded. stdio, `url` / `http` / `sse` / `ws` (all mapped to local / remote). | Root `mcp.json`, strict 1.0.0 rules. `stdio` and `streamable-http` run; `sse` is skipped with a report (OpenCode has no SSE client). Only `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` expand; `PLUGIN_ROOT` / `PLUGIN_DATA` are set in the server's environment. An invalid entry skips that server, a bad file disables MCP for that plugin. |
| Commands | `ctx.command.transform` | `config.command` | `commands/**/*.md` and manifest `commands`, namespaced `plugin:command`. `$ARGUMENTS` works. | From `com.harnesstap.opencode/commands/` or `extensions`, namespaced with the plugin `name`. |
| Instructions | re-injected on every `session.context` | `config.instructions` + system transform | Plugin-root `CLAUDE.md` / `AGENTS.md` / `INSTRUCTIONS.md`. | Only `com.harnesstap.opencode/instructions.md`. Root `AGENTS.md` / `CLAUDE.md` are not injected. |
| Agents | `ctx.agent.transform` `update()` (inserts if missing) | `config.agent` | `agents/**/*.md`, namespaced `plugin:agent`, `mode: "subagent"`. | From `com.harnesstap.opencode/agents/` or `extensions`. |
| Hooks | tool / session / permission / event subscribe | v1 hook object | `hooks/hooks.json`, command hooks (`type: "command"`) only. | `com.harnesstap.opencode/hooks/hooks.json` or inline, same event support. `PLUGIN_ROOT` / `PLUGIN_DATA` set. |
| `bin/` on `PATH` | `shell.hook("create.before")` | `shell.env` | Yes. | No. |

Every file an Agent Plugins package supplies must resolve (symlinks followed) inside the plugin root: `plugin.json`, `skills/`, each `SKILL.md`, MCP `command` and `cwd`, and extension files.

**Hooks wired on v2:** PreToolUse (block + `updatedInput`), PostToolUse / PostToolUseFailure (`additionalContext`), UserPromptSubmit, SessionStart (matcher = `startup` / `clear` / `compact`), SessionEnd, Stop (`session.idle`), PermissionRequest (`permission.evaluate`), PreCompact (`session.compaction`).

**Not loaded:** LSP, output styles, themes, monitors, workflows, in-process JS mods, `.mcpb` bundles, HTTP/prompt/MCP/agent hooks, and most other Claude hook events.

Skill **ids** stay kebab-case (OpenCode cannot namespace them as `plugin:name`). Invoke a plugin skill with `/plugin:skill` even if a user skill shares the name. Commands, agents, and MCP **are** namespaced as `plugin:component`.

v2 built-in tool ids `shell`, `patch`, and `subagent` map to Claude `Bash`, `Edit`, and `Task` for hook matchers.

This OpenCode plugin’s `id` is `opencode-agent-plugin-support`.

## License

MIT

How injection works: [ARCHITECTURE.md](https://github.com/harnesstap/opencode-agent-plugin-support/blob/main/ARCHITECTURE.md). Development: [CONTRIBUTING.md](https://github.com/harnesstap/opencode-agent-plugin-support/blob/main/CONTRIBUTING.md).
