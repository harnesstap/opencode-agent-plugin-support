# opencode-claude-plugins

Loads **Claude Code plugins** into OpenCode as native skills, slash commands, subagents, MCP servers, instructions, and lifecycle hooks. Plugin files stay where they are; nothing is copied into `.opencode/` or `~/.agents/skills`.

## Install

Add the plugin to your OpenCode config (`opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-claude-plugins"]
}
```

From a local checkout:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-claude-plugins"]
}
```

Restart OpenCode after installing. npm plugins land in `~/.cache/opencode/node_modules/`.

### Share Claude Code’s plugin cache

If you already install plugins with Claude Code:

```bash
mkdir -p ~/.agents
ln -s ~/.claude/plugins ~/.agents/plugins
```

That reuses the install tree. Enablement is separate (`~/.agents/plugins.json`); omit that file and every installed plugin stays on.

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

`installPath` from `installed_plugins.json` is used as-is (`~` / `$HOME` expanded). If that directory is missing, the versioned cache path is tried.

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
npx opencode-claude-plugins marketplace-add my-market github:org/repo
```

- `list` — installed plugins, effective on/off, and source (`default` | `user` | `project`).
- `enable` / `disable` — write the user file, or `--project` for the repo file.
- `install-local` — register a local directory (enabled until you disable it). Does not clone git marketplaces.
- `marketplace-add` — record an extra marketplace (`github:org/repo` or a path).

## Support

| Claude | OpenCode | Notes |
| --- | --- | --- |
| Skills | skills | Folder names as skill names. OpenCode requires kebab-case `name` + `description` in `SKILL.md`. |
| MCP | MCP | `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, `$ENV` expanded. stdio → local; `url` / `http` / `sse` / `ws` → remote. |
| Commands | slash commands | Namespaced `plugin:command`. `$ARGUMENTS` works. |
| Instructions | instructions | Plugin-root `CLAUDE.md` / `AGENTS.md` / `INSTRUCTIONS.md`. |
| Agents | subagents | Namespaced `plugin:agent`. |
| Hooks | plugin hooks | Command hooks (`type: "command"`) only, for a subset of events (Pre/Post tool, prompt submit, session start/end, stop, permission, pre-compact). |

**Not loaded:** LSP, output styles, themes, monitors, workflows, in-process JS mods, `.mcpb` bundles, HTTP/prompt/MCP/agent hooks, and most other Claude hook events.

**Also:**

- Skills cannot be namespaced as `plugin:name` (OpenCode skill names are kebab-case only). Commands, agents, and MCP **are** namespaced as `plugin:component`.
- `install-local` / the symlink reuse Claude’s cache; this CLI does not fully clone/update marketplaces the way `claude plugin install` does.
- `${user_config.*}` is expanded only if values are supplied; there is no Claude `/config` UI.
- On older OpenCode builds that scan skills before plugin config hooks, skills may not appear until that order is fixed upstream. Commands, agents, and MCP from the same load still apply.

## License

MIT

See [ARCHITECTURE.md](ARCHITECTURE.md) for how injection works, and [CONTRIBUTING.md](CONTRIBUTING.md) for development.
