# opencode-claude-plugins

An OpenCode plugin that loads **Claude Code plugins** and exposes them as ordinary OpenCode resources: skills, slash commands, subagents, MCP servers, instructions, and lifecycle hooks.

Nothing is copied into `.opencode/` or `~/.agents/skills`. Components stay in the Claude plugin directory and are injected at runtime through OpenCode’s plugin `config` hook (`command`, `agent`, `mcp`, `instructions`, `skills.paths`).

## Install

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-claude-plugins"]
}
```

Local checkout:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-claude-plugins"]
}
```

Restart OpenCode after installing. npm plugins are installed by OpenCode into `~/.cache/opencode/node_modules/`.

Source: [github.com/harnesstap/opencode-agent-plugin-support](https://github.com/harnesstap/opencode-agent-plugin-support). Issues: [github.com/harnesstap/opencode-agent-plugin-support/issues](https://github.com/harnesstap/opencode-agent-plugin-support/issues).

## Storage layout (Claude-compatible)

Activation is **only** read from:

| File | Role |
| --- | --- |
| `~/.agents/plugins.json` | User-level `enabledPlugins` + `extraKnownMarketplaces` |
| `<repo>/.agents/plugins.json` | Project-level overlay (same schema). Overrides user keys |

Claude’s `~/.claude/settings.json` and `<repo>/.claude/settings.json` are **not** read.

Everything else is under `~/.agents/plugins/`, matching `~/.claude/plugins/`:

```text
~/.agents/plugins/
  installed_plugins.json      # v1 object, v2 { version: 2, plugins: { "name@market": [entries] } }, or v3 array
  known_marketplaces.json
  marketplaces/<name>/
  cache/<marketplace>/<plugin>/<version>/
  data/<plugin-id>/           # ${CLAUDE_PLUGIN_DATA}
```

Each install entry’s `installPath` is used as-is (with `~` / `$HOME` expanded). If that directory is missing, the versioned cache path above is tried.

### Symlink trick

If you already install plugins with Claude Code:

```bash
mkdir -p ~/.agents
ln -s ~/.claude/plugins ~/.agents/plugins
```

That shares the install cache. Enablement is separate: copy the `enabledPlugins` map into `~/.agents/plugins.json` if you want the same on/off state, or omit the file and every installed plugin stays on.

### Enablement

Every plugin listed in `installed_plugins.json` with a resolvable `installPath` is **enabled** unless `enabledPlugins` sets it to `false`.

- Missing `plugins.json` → all installed plugins enabled (`source: "default"`).
- Missing key → enabled (`source: "default"`).
- `"id": true` or `"id": false` in the user file → `source: "user"`.
- Same keys in the project file override the user file → `source: "project"`.
- Manifest `defaultEnabled` is ignored.

`plugins.json` shape:

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

`opencode-claude-plugins list` prints each installed plugin’s effective `enabled` flag and `source` (`default` | `user` | `project`). `enable` / `disable` write only the targeted file (`--project` for the repo file) and echo the effective state.

## How injection works

OpenCode plugins cannot drop files into the skill scanner without either copying or telling config about extra paths. The `config` hook runs at plugin init and mutates the live config object OpenCode already holds:

| Claude component | OpenCode field | Why this and not copies |
| --- | --- | --- |
| `skills/*/SKILL.md` | `config.skills.paths` | Same discovery as `.agents/skills`: OpenCode recursively finds `SKILL.md`. Path points at the plugin tree. |
| `commands/*.md` | `config.command["plugin:name"]` | Native slash commands, including `$ARGUMENTS`. |
| `agents/*.md` | `config.agent["plugin:name"]` | Native subagents (`mode: "subagent"`). |
| `.mcp.json` / `mcpServers` | `config.mcp["plugin:name"]` | Native MCP entries (`type: local \| remote`). |
| `CLAUDE.md` / `AGENTS.md` / `INSTRUCTIONS.md` | `config.instructions` + `experimental.chat.system.transform` | File paths for the instructions loader, plus inlined text so content still applies if files are not re-read after the hook. |
| `hooks/hooks.json` | mapped plugin hooks | Executed as Claude command hooks (stdin JSON, exit codes). |
| `bin/` | `shell.env` `PATH` | Prepended while the plugin is enabled. |

Skill **names** stay the `SKILL.md` folder names. OpenCode skill ids cannot contain `:`, so they are not namespaced as `plugin:skill`. Commands, agents, and MCP servers **are** namespaced as `plugin:component`, matching Claude.

## Feature mapping

| Claude | OpenCode | Notes |
| --- | --- | --- |
| Skills | `skills.paths` | Frontmatter `name` + `description` required by OpenCode. |
| MCP | `mcp` | `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, and `$ENV` expanded. stdio → `type: "local"`; `url`/`http`/`sse`/`ws` → `type: "remote"`. `.mcpb` bundles are not unpacked. |
| Commands | `command` | Markdown + inline `plugin.json` maps. `$ARGUMENTS` preserved (OpenCode already substitutes it). |
| Instructions | `instructions` + system prompt | Claude itself does **not** load plugin-root `CLAUDE.md`; we still do because it is the natural mapping. |
| Agents | `agent` | `description`, `tools` / `disallowedTools` → OpenCode `tools` booleans, `model` aliases (`haiku` / `sonnet` / `opus`) or `provider/model`. Plugin-agent `hooks` / `mcpServers` / `permissionMode` ignored (Claude ignores those on plugin agents too). |
| Hooks | see below | Command hooks only (`type: "command"`). HTTP, prompt, MCP, and agent hooks are not run. |

### Hook mapping

| Claude event | OpenCode hook | Fidelity |
| --- | --- | --- |
| `PreToolUse` | `tool.execute.before`, `permission.ask` | High. Exit `2` or JSON `permissionDecision: "deny"` / `decision: "block"` throws / denies. `updatedInput` merges into tool args. |
| `PostToolUse` | `tool.execute.after` | High. `additionalContext` appended to tool output. |
| `PostToolUseFailure` | `tool.execute.after` (heuristic) | Medium. Empty or error-like output. |
| `UserPromptSubmit` | `chat.message` | Medium. `additionalContext` appended as a text part. Block replaces the prompt text (OpenCode has no first-class reject). |
| `SessionStart` | `event` `session.created`, first `chat.message` | Medium. Context queued into `experimental.chat.system.transform`. |
| `SessionEnd` | `event` `session.deleted` | Medium. |
| `Stop` | `event` `session.idle` | Low. Idle ≠ Claude turn-complete Stop. |
| `PermissionRequest` | `permission.ask` | Medium. |
| `PreCompact` | `experimental.session.compacting` | Medium. Context strings only. |

Unmapped (not executed): `Setup`, `UserPromptExpansion`, `PermissionDenied`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`.

Tool matchers (`Bash`, `Write|Edit`) run against **Claude** names. OpenCode `bash` / `edit` / `write` / `read` / `glob` / `grep` / `list` / `webfetch` / `websearch` / `task` / `todowrite` / `skill` are translated first.

Hook processes receive Claude-style stdin JSON (`hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`, …) and `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` / `CLAUDE_PROJECT_DIR` in the environment.

## CLI

```bash
npx opencode-claude-plugins list
npx opencode-claude-plugins enable name@marketplace
npx opencode-claude-plugins disable name@marketplace --project
npx opencode-claude-plugins install-local ./my-claude-plugin [name@local]
npx opencode-claude-plugins marketplace-add my-market github:org/repo
```

`install-local` writes `installed_plugins.json` (v2). The plugin is enabled by default until you `disable` it. It does not clone git marketplaces.

## Develop

```bash
npm install
npm test
npm run build
```

## What we verified

- Unit tests: manifest/path containment, enablement merge, installed_plugins v1/v2/v3, frontmatter, env expansion, tool-name mapping, hook JSON / exit code 2, fixture component load, config injection.
- Integration: a fixture Claude plugin (skill, MCP, command, agent, instructions, hooks) is discovered from a fake `~/.agents/plugins` tree and injected so OpenCode config contains each resource.
- Full `opencode` TUI smoke: see `test/smoke.md`. This environment may not have a logged-in OpenCode binary; run the documented command locally if you need a live session.

## Limitations

- Skills cannot be `plugin:name` because OpenCode’s skill name regex is kebab-case only.
- `config.skills.paths` is the supported injection API; if an older OpenCode build scans skills **before** plugin config hooks, skills will not appear until that order is fixed upstream. Commands/agents/MCP from the same hook still apply.
- Marketplace install/update (`claude plugin install`) is not a full clone implementation; register local dirs or reuse Claude’s cache via the symlink.
- LSP, output styles, themes, monitors, workflows, mods (in-process JS hooks), and `.mcpb` bundles are not loaded.
- `${user_config.*}` is expanded only when values are passed in; this plugin does not implement Claude’s `/config` UI.

## License

MIT
