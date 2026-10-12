# Architecture

Runtime bridge: Claude Code plugin trees and Agent Plugins packages stay on disk where they are (by default `~/.agents/plugins/`, same layout as `~/.claude/plugins/`; any directory via `sources`). This package never copies components into `.opencode/` or `~/.agents/skills`.

OpenCode **v2** is the primary host. The default export is `{ id, setup, server }`:

- v2 reads `id` + `setup(ctx)` and ignores `server()`. There is no `config` hook; plugins register through domain `transform` / `hook` APIs.
- v1 (1.18.29+) calls `server()`, which is the original function plugin (`createClaudeCodeBridge`).

A root `index.js` re-exports `./dist/index.js` so a **directory** path in v2 `plugins` loads (v2 does not honor `package.json` `"main"` for local folders, and rejects file paths).

## Config and sources

`src/config.ts` reads `~/.agents/agent-plugin-support.json` and `<cwd>/.agents/agent-plugin-support.json` (`parseConfigDocument` is pure; problems are warnings, never fatal) and `mergeConfigLayers` produces the effective source list:

- Neither file declares `sources` → one implicit source `{ path: ~/.agents/plugins, format: claude }`. Together with the legacy `plugins.json` precedence below this is exactly 0.1.x.
- Otherwise project sources first, then user sources, deduplicated by resolved path (project wins, which is also how `enabled: false` removes a user source). `~` is expanded and relative paths resolve from the declaring file's directory.
- Labels (the `@<label>` of Agent Plugins ids) are explicit or derived (`deriveSourceLabel`) and made unique with a `-2` suffix and a warning.

Enablement (`src/enablement.ts`) resolves a key through four layers, first hit wins: project config, user config, project `plugins.json`, user `plugins.json`. `enable` / `disable` write the layer's config file when it exists (other fields preserved, refused if it is not valid JSON), else the legacy file.

`discoverEnabledPlugins` (`src/discover.ts`) walks the sources in order through `src/source-discovery.ts`, then drops a plugin whose **name** (the namespace prefix) was already provided by an earlier source. Duplicates inside one source keep 0.1.x behavior. `${CLAUDE_PLUGIN_DATA}` / `${PLUGIN_DATA}` is always `~/.agents/plugins/data/<slug>`, independent of sources (`pluginDataDir` ignores `RuntimePaths.storeDir`).

| Source format | What `source-discovery` does |
| --- | --- |
| `claude` | Registry readers with `RuntimePaths.storeDir` set to the source (the steps under **Discovery**). |
| `agent-plugins` | Sorted immediate children, skipping `cache`, `data`, `marketplaces`, `repos`, dot-directories and non-directories. Each child's `realpath` is the plugin root; root `plugin.json` decides. |
| `auto` | Registry (if present) and children. Per plugin: `.claude-plugin/plugin.json` → Claude (plus dual merge); else an Agent Plugins `plugin.json` → Agent Plugins; else ignored. For a registry plugin without a Claude manifest but with a valid Agent Plugins one, Agent Plugins semantics apply and the registry id is kept. |

## Agent Plugins loading (1.0.0)

Modules: `ap-manifest.ts` (manifest), `ap-skills.ts`, `ap-mcp.ts`, `ap-extension.ts` (`com.harnesstap.opencode`), `safe-path.ts` (containment), `plugin-build.ts` (assembly).

- **Version.** `$schema` must equal the 1.0.0 identifier. `1.1.0` is a working draft whose schemas differ only in `$id`/`$schema`; it is rejected like any unsupported version, because the spec only allows accepting identifiers a client explicitly recognizes as compatible. Schemas are never fetched.
- **Manifest** (§5): closed field set; unknown top-level fields and a non-object `extensions` are reported and ignored; everything else (including the name rule: 1-64 of `a-z0-9.-`, alphanumeric ends, no `--` or `..`) rejects the plugin. Contents of other clients' `extensions` namespaces are not validated.
- **Containment** (§4.1). `resolveWithin(realBase, target)` requires the lexical path and the symlink-resolved path (nearest existing ancestor, plus the missing tail) to stay inside the base; a dangling or looping link is refused. Applied to `plugin.json` (rejects the plugin), `skills/` (disables skills), each `SKILL.md` (skips it), MCP `command` and `cwd` (skips the server; `${PLUGIN_DATA}`-rooted `cwd` is checked against the data directory) and extension files.
- **Skills** (§7.1). Immediate children of `skills/` with a `SKILL.md` regular file; no recursion. Frontmatter is checked against the Agent Skills spec (name format and equal to the directory, description 1-1024, optional field types); extra fields are tolerated. Invalid skills are skipped and reported.
- **MCP** (§7.2, §9). `loadAgentMcp` validates `mcp.json` (closed top-level, `$schema` equal to the plugin's version), then each entry: closed variants `stdio` / `streamable-http` / `sse`; `command` is one token (bare name or `./` path, never expanded, resolved against the plugin root, not `cwd`); `cwd` must be `./…`, `${PLUGIN_ROOT}…` or `${PLUGIN_DATA}…`; URL must be absolute http(s) without userinfo or fragment, https unless `localhost` or a loopback IP literal; header names are RFC 9110 tokens, no case-folded duplicates, values without control characters; `env` may not define `PLUGIN_ROOT` / `PLUGIN_DATA`. Expansion is one regex pass over `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` in `args`, `env` values and `cwd` only. The two variables are set in the environment after `env`. A valid `sse` entry is skipped as unsupported (OpenCode has no SSE client). Mapping: stdio → `local` (`command`, `environment`, `cwd`), `streamable-http` → `remote`.
- **No Claude extras.** Root `AGENTS.md` / `CLAUDE.md` are not injected and `bin/` is not put on `PATH`.
- **OpenCode extension.** `ap-extension.ts` runs the Claude loaders with `com.harnesstap.opencode/` as the base (default `commands/`, `agents/`, `hooks/hooks.json`; only `instructions.md` for instructions) and with inline `commands`, `agents`, `hooks` from `extensions["com.harnesstap.opencode"]`. Unlike a Claude manifest, inline declarations add to the default directories instead of replacing them. A file filter (`FileFilter`) applies containment to every file read. Hook processes get `PLUGIN_ROOT` / `PLUGIN_DATA` (`hookEnv`, `agentPluginsRoot`), and `expandString` expands both names (`ExpandContext.pluginVars`).
- **Reporting.** Everything the spec says to report goes through `Diagnostics`: logged as a warning (debug for disabled plugins) and kept in `EnabledPlugin.diagnostics`, shown by `list`. Skipped MCP servers are in `mcpSkipped`.

### Dual manifests

A plugin with a valid Agent Plugins `plugin.json` (the `$schema` identifies it; a root `plugin.json` without an agent-plugins.org `$schema` is ignored) in a `claude` or `auto` source (or with a `.claude-plugin/plugin.json` in `auto`) is loaded Claude-first (`hydrateClaudePlugin`) and `mcp.json` servers are added when the Claude manifest does not already define the name. The Claude name stays the namespace prefix and a different Agent Plugins `name` warns. Skills, commands, agents, instructions, hooks and `bin/` come from the Claude layout only. An invalid or unsupported Agent Plugins manifest warns and the plugin is Claude-only. In an `agent-plugins` source only the Agent Plugins side exists.

## Discovery

1. Read activation from the four enablement layers (see **Config and sources**). Missing file/key → enabled. Manifest `defaultEnabled` is ignored. Everything below applies per `claude` source, with `~/.agents/plugins` standing for the source directory.
2. Parse `<source>/installed_plugins.json` (see versions below). Optional v2/v1 plugin option `skipInstalled` skips this.
3. For each record, pick an installation:
   - Drop `project` / `local` entries whose `projectPath` is a different cwd.
   - Rank remaining: matching-cwd `local` / `project`, then other `local` / `project` without a foreign path, then `user`, `managed`.
   - Prefer the best-ranked entry whose directory exists.
4. Resolve the plugin root (`src/plugin-root.ts`), first hit wins. This mirrors Claude Code, which loads relative-path plugins of local marketplaces in place and copies everything else into `cache/`, and sweeps cache dirs it no longer uses:
   1. **Local marketplace, in place.** If the plugin's marketplace is a `directory` / `file` marketplace (`known_marketplaces.json` `installLocation` or `source.path`, or `extraKnownMarketplaces` in `plugins.json`) and the `marketplace.json` entry has a relative-path `source`, use that directory. It wins over a cache copy because Claude reads it live.
   2. `installPath` (`~` / `$HOME` expanded). Relative paths are resolved from the source directory (not `$HOME`), so Claude’s `cache/...` values work.
   3. `cache/<marketplace>/<name>/<version>/`.
   4. **Marketplace tree.** For git-hosted marketplaces, the clone (`installLocation`, `marketplaces/<name>/`, `marketplaces/<repo-slug>/`, or the `marketplaces/<name>.json` file of a `url` marketplace) plus the entry's relative `source`.

   Relative `source` rules (`src/marketplace.ts`): resolved from the marketplace root (the directory containing `.claude-plugin/`); `"."` is the root; a bare name resolves under `metadata.pluginRoot`; `..`, backslashes, and escapes are refused. Object sources (`github`, `url`, `git-subdir`, `npm`, `archive`, `command`) are never resolved from a marketplace tree because only Claude’s cache has them; fetching is Claude’s job.

   When nothing resolves, the plugin is skipped with `plugin root unresolved: ...` listing each place tried. That is logged with `warn` for enabled plugins (`debug` for disabled ones) and shown by `list` (`reason`, `resolvedVia`, `tried`). `OPENCODE_AGENT_PLUGIN_SUPPORT_DEBUG=1` also logs successful resolutions to stderr.
5. For `installPath` / cache hits, find the plugin root (directory containing `.claude-plugin/plugin.json` or equivalent; marketplace hits are already exact). Load the manifest and merge the marketplace entry (`src/marketplace-entry.ts`): no `plugin.json` → the entry is the manifest; `strict` (default `true`) → the entry's `commands` / `agents` / `skills` / `hooks` are appended (hooks are appended, not replaced per event); `strict: false` with entry components → "Plugin has conflicting manifests"; an entry at the marketplace root (`"."`) that lists `skills` replaces the default `skills/` scan; display fields come from the entry, `version` from the manifest. Then hydrate skills / commands / agents / MCP / instructions / hooks.
6. Plugin option `extraPluginDirs` (`{ id: "/abs/path" }`) appends more trees without a registry write.

`${CLAUDE_PLUGIN_DATA}` maps to `~/.agents/plugins/data/<slug>/` (fixed, whatever the sources) and that directory is created on first use. Plugin `bin/` is prepended onto `PATH` (v1 `shell.env`, v2 `ctx.shell.hook("create.before")`) while the plugin is enabled.

Malformed `installed_plugins.json`, a plugin's `plugin.json`, `hooks.json`, `.mcp.json`, or YAML frontmatter is skipped with a warning; other plugins and components still load. The OpenCode plugin `id` is `opencode-agent-plugin-support`.

Duplicate `SKILL.md` paths (manifest `skills` overlapping default `skills/`) are skipped.

## Config injection

### v2 (`setup`)

v2 has no mutable global config object.

| Claude component | v2 API | Behavior |
| --- | --- | --- |
| `skills/*/SKILL.md` | `ctx.skill.transform` `editor.add` | `{ id, name, description?, path, content }`. Not namespaced (kebab-case only). Skipped when `disable-model-invocation` is set. Also registered as `/plugin:skill` commands (see Commands). |
| `commands/*.md` | `ctx.command.transform` `editor.add` | Native slash commands, plus user-invocable plugin skills as `plugin:skill`. Executor substitutes `$ARGUMENTS` and calls `ctx.session.prompt`. |
| `agents/*.md` | `ctx.agent.transform` | See **Agents** below. |
| `.mcp.json` / `mcpServers` (Claude) or `mcp.json` (Agent Plugins) | `ctx.mcp.transform` `editor.set` | Native MCP. v2 field is `disabled` (not `enabled`). |
| `CLAUDE.md` / … | `ctx.session.hook("context")` | Push instruction texts onto `event.system` **every** model call (v2 context is not persisted). |
| `hooks/hooks.json` | session / tool / permission hooks + `ctx.event.subscribe` | Command hooks only. |
| `bin/` | `ctx.shell.hook("create.before")` | Prepend `PATH`. |

### v1 (`config` hook)

The `config` hook runs at plugin init and mutates the live config object:

| Claude component | OpenCode field | Behavior |
| --- | --- | --- |
| `skills/*/SKILL.md` | `config.skills.paths` (or `config.skills` if it is already a string array) | Same discovery as `.agents/skills`. Paths omitted for `disable-model-invocation` skills. |
| `commands/*.md` | `config.command["plugin:name"]` | Native slash commands, plus `plugin:skill` for each user-invocable plugin skill. |
| `agents/*.md` | `config.agent["plugin:name"]` | `mode: "subagent"`. |
| `.mcp.json` / `mcpServers` | `config.mcp["plugin:name"]` | Native MCP (`type: local \| remote`, `enabled`). |
| `CLAUDE.md` / … | `config.instructions` + `experimental.chat.system.transform` | File paths plus inlined text. |
| `hooks/hooks.json` | mapped plugin hooks | Command hooks only. |
| `bin/` | `shell.env` `PATH` | Prepended while enabled. |

Skill **ids** stay the `SKILL.md` folder names (OpenCode skill ids cannot contain `:`). Each user-invocable plugin skill is also a slash command named `plugin:skill` (for example `/code-review-workflow:request-slack-review`). That command inlines the plugin file so a colliding user skill in `~/.config/opencode/skills` cannot replace it. If the plugin already defines a command with the same namespaced id, that command wins. Commands, agents, and MCP servers **are** namespaced as `plugin:component`.

### Component mapping details

- **Skills:** Frontmatter `name` + `description` are required by OpenCode. Search roots: `skills/`, manifest `skills` paths, or a root-level `SKILL.md`. Claude fields: `user-invocable` (default true; `false` skips the slash command), `disable-model-invocation` (keeps `/plugin:skill` but does not advertise the skill to the model), `argument-hint` (copied onto the command), `when_to_use` (appended to the listing description). Boolean frontmatter accepts Claude's `yes`/`no`/`on`/`off`/`1`/`0`. If frontmatter `name` already starts with `plugin:`, the prefix is not doubled.
- **MCP:** `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, and `$ENV` expanded. stdio / `command` → `type: "local"`; `url` / `http` / `sse` / `ws` → `type: "remote"`. `.mcpb` bundles are not unpacked. `${user_config.*}` expands only when `userConfig` is passed in.
- **Commands:** Markdown files plus inline `plugin.json` maps, then plugin skills as `/plugin:skill`. `$ARGUMENTS` is preserved. Skill-command templates include the plugin `SKILL.md` path and body (and expand `${CLAUDE_SKILL_DIR}` / `${CLAUDE_PLUGIN_ROOT}`).
- **Instructions:** Claude itself does **not** load plugin-root `CLAUDE.md`; we still do because it is the natural OpenCode mapping.
- **Agents (v1):** `description`; `tools` / `disallowedTools` → OpenCode `tools` booleans; `model` aliases (`haiku` / `sonnet` / `opus`) or `provider/model`. Plugin-agent `hooks` / `mcpServers` / `permissionMode` ignored.

### Agents on v2

Published plugin docs expose `AgentEditor` as `list` / `get` / `default` / `update` / `remove` (no `add` on OpenCode 2.0.24). Upstream `packages/core/src/agent.ts` implements `update` as **insert-on-miss** (`Info.empty(id)` then the callback). That is the legitimate way to register Claude plugin subagents without copying markdown into `~/.config/opencode` or `.opencode/`.

If a future host adds `editor.add`, we call it first and fall back to `update`.

`Agent.Info` uses `system` (not `prompt`) and `permissions` (not v1 `tools` booleans). We set `mode: "subagent"`, `hidden: false`, `system` from the agent markdown, optional `{ providerID, id }` model. Claude tool allowlists are not rewritten into v2 permission rulesets (lossy; would be a silent policy change).

We do **not** copy agent files into user directories.

## Hook execution

Only `type: "command"` hooks run (HTTP, prompt, MCP, and agent hooks are skipped). Matchers (`Bash`, `Write|Edit`) are compared against **Claude** tool names. OpenCode v1 `bash` / `edit` / `write` and v2 `shell` / `patch` / `subagent` (and related) are translated first.

Plugin MCP tool ids on v2 look like `fixture-demo_echo-api_echo` and map to Claude `mcp__plugin_fixture-demo_echo-api__echo` when the namespaced server `fixture-demo:echo-api` is known.

**SessionStart / SessionEnd / PreCompact** matchers are session sources (`startup`, `clear`, `auto` / `manual`), not tool names. Passing no matcher name still skips groups that declare a matcher.

Processes get Claude-style stdin JSON (`hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`, …) and `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` / `CLAUDE_PROJECT_DIR` in the environment. Timeout defaults to 30s (`hooks.json` `timeout` is seconds). If `args` is empty, the command string is run via the shell. A **PreToolUse** timeout fails closed (the tool call is blocked). Other hook events do not treat timeout as a block.

Stdout is parsed as JSON when possible (`hookSpecificOutput`, `decision`, `additionalContext`, `updatedInput`, `continue`). Interpretation:

- Exit `2`, `permissionDecision: "deny"`, `decision: "block"`, or `continue: false` → block.
- `updatedInput` merges into tool args (PreToolUse).
- `additionalContext` is appended to tool output, prompt text, or compacting context depending on the event.
- PostToolUse vs PostToolUseFailure: v1 uses empty/error-like output; v2 uses `event.status === "error"`.

UserPromptSubmit block replaces the prompt text (OpenCode has no first-class reject). SessionStart context is cached per session and re-injected on every v2 `context` hook (and queued into v1 `experimental.chat.system.transform`).

### Event mapping

| Claude event | v2 | v1 |
| --- | --- | --- |
| `PreToolUse` | `ctx.tool.hook("execute.before")` | `tool.execute.before`, `permission.ask` |
| `PostToolUse` | `ctx.tool.hook("execute.after")` | `tool.execute.after` |
| `PostToolUseFailure` | `execute.after` when `status === "error"` | `tool.execute.after` (heuristic) |
| `UserPromptSubmit` | `ctx.session.hook("prompt")` | `chat.message` |
| `SessionStart` | `ctx.session.hook("context")` + `session.created` events; matcher `startup` | `event` `session.created`, first `chat.message` |
| `SessionEnd` | `ctx.event.subscribe` `session.deleted` / `session.removed`; matcher `clear` | `event` `session.deleted` |
| `Stop` | `session.idle` events | `event` `session.idle` |
| `PermissionRequest` | `ctx.permission.hook("evaluate")` | `permission.ask` |
| `PreCompact` | `ctx.session.hook("compaction")`; matcher `auto` / `manual` | `experimental.session.compacting` |

Unmapped (not executed): `Setup`, `UserPromptExpansion`, `PermissionDenied`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`.

## `installed_plugins.json` versions

Readers accept:

- **v1** object: `{ plugins: { "name@market": { installPath, … } } }`
- **v2** object: `{ version: 2, plugins: { "name@market": [entries] } }`
- **v3** array of entries (`id` / `plugin` / `name`+`marketplace` plus install fields)

`install-local` always writes **v2**. It refuses when `~/.agents/plugins` is Claude’s store (symlink / same realpath as `~/.claude/plugins`) unless `--write-claude-registry`. Multiple installations per id are kept; `pickInstallation` ranks by scope against the current cwd and prefers an existing directory. Writes replace the file with v2 (so a v1/v3 file becomes v2 after `install-local`).
