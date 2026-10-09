# opencode-claude-plugins

Loads **Claude Code plugins** into OpenCode as native skills, slash commands, subagents, MCP servers, instructions, and lifecycle hooks. Plugin files stay where they are; nothing is copied into `.opencode/` or `~/.agents/skills`.

**OpenCode v2 is the primary target.** A v1 `server()` export remains for OpenCode 1.18.29+. v2 does not run v1 plugin implementations.

## Install

### OpenCode v2 (2.0+)

Use the `plugins` key (not `plugin`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-claude-plugins"]
}
```

Restart OpenCode (`opencode service restart` if the background service is running). npm plugins land in OpenCode’s package cache.

### Local checkout (v2)

v2 only loads `index.js` / `index.ts` or `server.js` / `server.ts` **at the folder root**. It ignores `package.json` `"main"`, and a path to a file is rejected (`configured plugin path must be a directory`).

```bash
git clone https://github.com/harnesstap/opencode-agent-plugin-support.git
cd opencode-agent-plugin-support
npm install
npm run build
```

```json
{
  "plugins": ["/absolute/path/to/opencode-claude-plugins"]
}
```

Do **not** point `plugins` at `dist/index.js` or `src/index.ts`.

Options (object form):

```json
{
  "plugins": [
    {
      "package": "opencode-claude-plugins",
      "options": {
        "extraPluginDirs": { "my-plugin@local": "/path/to/claude-plugin" },
        "skipInstalled": false,
        "mcpDisabled": false
      }
    }
  ]
}
```

`extraPluginDirs` loads extra Claude plugin trees without writing a registry. `skipInstalled` skips `~/.agents/plugins/installed_plugins.json`.

### OpenCode v1

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-claude-plugins"]
}
```

Needs OpenCode **1.18.29+** (object entrypoint with `server()`). Older v1 hosts expected a default function export.

### Share Claude Code’s plugin cache

If you already install plugins with Claude Code:

```bash
mkdir -p ~/.agents
ln -s ~/.claude/plugins ~/.agents/plugins
```

That reuses the **install tree**. Enablement is separate (`~/.agents/plugins.json`); omit that file and every installed plugin stays on.

`install-local` **refuses** to write through that symlink unless you pass `--write-claude-registry`. A dedicated `~/.agents/plugins` directory is safer if you do not want this CLI touching Claude’s `installed_plugins.json`.

## Where plugins live

Installed plugins live under `~/.agents/plugins/` — the same layout as `~/.claude/plugins/`:

```text
~/.agents/plugins/
  installed_plugins.json
  known_marketplaces.json
  marketplaces/<name>/
  cache/<marketplace>/<plugin>/<version>/
  data/<plugin-id>/
```

`installPath` from `installed_plugins.json` is used as-is (`~` / `$HOME` expanded). Relative paths are resolved from `~/.agents/plugins/` (so `cache/...` works). If that directory is missing, the versioned cache path is tried.

Project-scoped installs for **other** repos are ignored. If several entries remain, the one whose directory exists wins.

### Enablement

Activation is read only from:

| File | Role |
| --- | --- |
| `~/.agents/plugins.json` | User-level `enabledPlugins` |
| `<repo>/.agents/plugins.json` | Project overlay; keys override the user file |

Claude’s `~/.claude/settings.json` is not read.

Every plugin in `installed_plugins.json` with a resolvable path is **enabled** unless `enabledPlugins` sets it to `false`. Missing file or missing key → enabled. Project keys override user keys. Manifest `defaultEnabled` is ignored.

```json
{
  "enabledPlugins": {
    "some-plugin@claude-plugins-official": false
  },
  "extraKnownMarketplaces": {
    "my-market": {
      "source": { "source": "github", "repo": "acme/plugins" }
    }
  }
}
```

## CLI

```bash
npx opencode-claude-plugins list
npx opencode-claude-plugins enable name@marketplace
npx opencode-claude-plugins disable name@marketplace --project
npx opencode-claude-plugins install-local ./my-claude-plugin [name@local]
npx opencode-claude-plugins install-local ./my-claude-plugin --write-claude-registry
npx opencode-claude-plugins marketplace-add my-market github:org/repo
```

- `list` — installed plugins, effective on/off, and source (`default` | `user` | `project`).
- `enable` / `disable` — write the user file, or `--project` for the repo file.
- `install-local` — register a local directory (enabled until you disable it). Does not clone git marketplaces. Refuses to overwrite Claude’s registry via a `~/.agents/plugins` → `~/.claude/plugins` symlink unless `--write-claude-registry` is set.
- `marketplace-add` — record an extra marketplace (`github:org/repo` or a path).

## Support

| Claude | OpenCode v2 | OpenCode v1 | Notes |
| --- | --- | --- | --- |
| Skills | `ctx.skill.transform` | `config.skills.paths` | Folder names as skill names. OpenCode requires kebab-case `name` + `description` in `SKILL.md`. Overlapping manifest `skills` paths and `skills/` are deduped. |
| MCP | `ctx.mcp.transform` (`disabled`) | `config.mcp` (`enabled`) | `${CLAUDE_PLUGIN_ROOT}` / `_DATA` / `_PROJECT_DIR` / `$ENV` expanded. stdio → local; `url` / `http` / `sse` / `ws` → remote. |
| Commands | `ctx.command.transform` | `config.command` | Namespaced `plugin:command`. `$ARGUMENTS` works. |
| Instructions | re-injected on every `session.context` | `config.instructions` + system transform | Plugin-root `CLAUDE.md` / `AGENTS.md` / `INSTRUCTIONS.md`. v2 context is per model call and is not persisted. |
| Agents | `ctx.agent.transform` `update()` (inserts if missing) | `config.agent` | Namespaced `plugin:agent`, `mode: "subagent"`. No files copied into user dirs. v2 tool allowlists are not 1:1 with Claude `tools:`. |
| Hooks | tool / session / permission / event subscribe | v1 hook object | Command hooks (`type: "command"`) only. See table below. |

**Hooks wired on v2:** PreToolUse (block + `updatedInput`), PostToolUse / PostToolUseFailure (`additionalContext`), UserPromptSubmit, SessionStart (matcher = `startup` / `clear` / `compact`, re-added every model call), SessionEnd, Stop (`session.idle`), PermissionRequest (`permission.evaluate`), PreCompact (`session.compaction`).

**Not loaded:** LSP, output styles, themes, monitors, workflows, in-process JS mods, `.mcpb` bundles, HTTP/prompt/MCP/agent hooks, and most other Claude hook events.

**Also:**

- Skills cannot be namespaced as `plugin:name` (OpenCode skill names are kebab-case only). Commands, agents, and MCP **are** namespaced as `plugin:component`.
- v2 built-in tool ids `shell`, `patch`, and `subagent` map to Claude `Bash`, `Edit`, and `Task` for hook matchers. Plugin MCP tools like `fixture-demo_echo-api_echo` map to `mcp__plugin_fixture-demo_echo-api__echo`.
- `${user_config.*}` is expanded only if values are supplied; there is no Claude `/config` UI.
- On v1 builds that scan skills before plugin config hooks, skills may not appear until that order is fixed upstream.

## License

MIT

See [ARCHITECTURE.md](ARCHITECTURE.md) for how injection works, and [CONTRIBUTING.md](CONTRIBUTING.md) for development.
