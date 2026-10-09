# Architecture

Runtime bridge: Claude Code plugin trees stay on disk under `~/.agents/plugins/` (same layout as `~/.claude/plugins/`). This package never copies components into `.opencode/` or `~/.agents/skills`. At OpenCode plugin init, the `config` hook mutates the live config object OpenCode already holds.

## Discovery

1. Read activation from `~/.agents/plugins.json` and `<cwd>/.agents/plugins.json` only. Project `enabledPlugins` keys override user keys. Missing file/key → enabled. Manifest `defaultEnabled` is ignored.
2. Parse `~/.agents/plugins/installed_plugins.json` (see versions below).
3. For each record, pick an installation (scope rank: matching-cwd `local` / `project`, then other `local` / `project`, then `user`, `managed`, other).
4. Resolve `installPath` (`~` / `$HOME` expanded). If that directory is missing, try `cache/<marketplace>/<name>/<version>/`.
5. Find the plugin root (directory containing `.claude-plugin/plugin.json` or equivalent), load the manifest, hydrate skills / commands / agents / MCP / instructions / hooks.

`${CLAUDE_PLUGIN_DATA}` maps to `~/.agents/plugins/data/<slug>/`. Plugin `bin/` is prepended onto `PATH` via the `shell.env` hook while the plugin is enabled.

## Config injection

OpenCode plugins cannot drop files into the skill scanner without either copying or telling config about extra paths. The `config` hook runs at plugin init:

| Claude component | OpenCode field | Behavior |
| --- | --- | --- |
| `skills/*/SKILL.md` | `config.skills.paths` (or `config.skills` if it is already a string array) | Same discovery as `.agents/skills`: OpenCode recursively finds `SKILL.md`. Paths point at the plugin tree. |
| `commands/*.md` | `config.command["plugin:name"]` | Native slash commands. `$ARGUMENTS` is appended if the template does not already include it. `allowedTools` is only hinted in the description (OpenCode command schema has no field). |
| `agents/*.md` | `config.agent["plugin:name"]` | `mode: "subagent"`. |
| `.mcp.json` / `mcpServers` | `config.mcp["plugin:name"]` | Native MCP entries (`type: local \| remote`). |
| `CLAUDE.md` / `AGENTS.md` / `INSTRUCTIONS.md` | `config.instructions` + `experimental.chat.system.transform` | File paths for the instructions loader, plus inlined text so content still applies if files are not re-read after the hook. |
| `hooks/hooks.json` | mapped plugin hooks | Command hooks only; see below. |
| `bin/` | `shell.env` `PATH` | Prepended while enabled. |

Skill **names** stay the `SKILL.md` folder names. OpenCode skill ids cannot contain `:`, so they are not namespaced as `plugin:skill`. Commands, agents, and MCP servers **are** namespaced as `plugin:component`.

### Component mapping details

- **Skills:** Frontmatter `name` + `description` are required by OpenCode. Search roots: `skills/`, manifest `skills` paths, or a root-level `SKILL.md`.
- **MCP:** `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, and `$ENV` expanded. stdio / `command` → `type: "local"`; `url` / `http` / `sse` / `ws` → `type: "remote"`. `.mcpb` bundles are not unpacked. `${user_config.*}` expands only when `userConfig` is passed in (this plugin does not implement Claude’s `/config` UI).
- **Commands:** Markdown files plus inline `plugin.json` maps. `$ARGUMENTS` is preserved (OpenCode substitutes it).
- **Instructions:** Claude itself does **not** load plugin-root `CLAUDE.md`; we still do because it is the natural OpenCode mapping.
- **Agents:** `description`; `tools` / `disallowedTools` → OpenCode `tools` booleans; `model` aliases (`haiku` / `sonnet` / `opus`) or `provider/model`. Plugin-agent `hooks` / `mcpServers` / `permissionMode` ignored (Claude ignores those on plugin agents too).

## Hook execution

Only `type: "command"` hooks run (HTTP, prompt, MCP, and agent hooks are skipped). Matchers (`Bash`, `Write|Edit`) are compared against **Claude** tool names. OpenCode `bash` / `edit` / `write` / `read` / `glob` / `grep` / `list` / `webfetch` / `websearch` / `task` / `todowrite` / `skill` (and related) are translated first.

Processes get Claude-style stdin JSON (`hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`, …) and `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` / `CLAUDE_PROJECT_DIR` in the environment. Timeout defaults to 30s (`hooks.json` `timeout` is seconds). If `args` is empty, the command string is run via the shell.

Stdout is parsed as JSON when possible (`hookSpecificOutput`, `decision`, `additionalContext`, `updatedInput`, `continue`). Interpretation:

- Exit `2`, `permissionDecision: "deny"`, `decision: "block"`, or `continue: false` → block.
- `updatedInput` merges into tool args (PreToolUse).
- `additionalContext` is appended to tool output, prompt parts, or compacting context depending on the event.
- PostToolUse vs PostToolUseFailure: the latter is used when tool output is empty or looks like an error (`error` / `failed` / `denied` in title/output).

UserPromptSubmit block replaces the prompt text (OpenCode has no first-class reject). SessionStart context is queued into `experimental.chat.system.transform` (also fired on the first `chat.message` if `session.created` was missed).

### Event mapping

| Claude event | OpenCode hook | Fidelity |
| --- | --- | --- |
| `PreToolUse` | `tool.execute.before`, `permission.ask` | High. Exit `2` or JSON deny/block throws / denies. `updatedInput` merges into tool args. |
| `PostToolUse` | `tool.execute.after` | High. `additionalContext` appended to tool output. |
| `PostToolUseFailure` | `tool.execute.after` (heuristic) | Medium. Empty or error-like output. |
| `UserPromptSubmit` | `chat.message` | Medium. `additionalContext` appended as a text part. Block replaces the prompt. |
| `SessionStart` | `event` `session.created`, first `chat.message` | Medium. Context queued into `experimental.chat.system.transform`. |
| `SessionEnd` | `event` `session.deleted` | Medium. |
| `Stop` | `event` `session.idle` | Low. Idle ≠ Claude turn-complete Stop. |
| `PermissionRequest` | `permission.ask` | Medium. |
| `PreCompact` | `experimental.session.compacting` | Medium. Context strings only. |

Unmapped (not executed): `Setup`, `UserPromptExpansion`, `PermissionDenied`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`.

## `installed_plugins.json` versions

Readers accept:

- **v1** object: `{ plugins: { "name@market": { installPath, … } } }`
- **v2** object: `{ version: 2, plugins: { "name@market": [entries] } }`
- **v3** array of entries (`id` / `plugin` / `name`+`marketplace` plus install fields)

`install-local` always writes **v2**. Multiple installations per id are kept; `pickInstallation` ranks by scope against the current cwd. Writes replace the file with v2 (so a v1/v3 file becomes v2 after `install-local`).
