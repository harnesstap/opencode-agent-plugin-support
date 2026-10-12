import type { McpSkip } from "./ap-mcp.js";
import type { LoadedAgent } from "./agents.js";
import type { LoadedCommand } from "./commands.js";
import type { SourceFormat } from "./config.js";
import type { EnablementDecision } from "./enablement.js";
import type { ClaudeHooksConfig } from "./hooks.js";
import type { LoadedInstructions } from "./instructions.js";
import type { PluginManifest } from "./manifest.js";
import type { OpenCodeMcp } from "./mcp.js";
import type { ResolutionAttempt, ResolutionVia } from "./plugin-root.js";
import type { LoadedSkill } from "./skills.js";

/** Which component conventions a loaded plugin follows. */
export type PluginFormat = "claude" | "agent-plugins";

/** The configured source a plugin came from. */
export type PluginOrigin = {
  path: string;
  label: string;
  /** The format the source is declared with (`auto` stays `auto`); see `PluginFormat` for the plugin itself. */
  format: SourceFormat;
};

export type EnabledPlugin = {
  id: string;
  name: string;
  marketplace?: string;
  pluginRoot: string;
  manifest: PluginManifest;
  format: PluginFormat;
  /** A Claude plugin that also ships a valid Agent Plugins manifest (its `mcp.json` servers were merged in). */
  dualManifest: boolean;
  /**
   * Symlink-resolved root, set when Agent Plugins rules apply (Agent Plugins format or dual manifest).
   * Hook processes then get `PLUGIN_ROOT` / `PLUGIN_DATA` next to the `CLAUDE_*` variables.
   */
  agentPluginsRoot?: string;
  skills: LoadedSkill[];
  commands: LoadedCommand[];
  agents: LoadedAgent[];
  mcp: Record<string, OpenCodeMcp>;
  /** Agent Plugins MCP servers that were not loaded, and why. */
  mcpSkipped: McpSkip[];
  instructions: LoadedInstructions;
  hooks: ClaudeHooksConfig;
  binDir?: string;
  /** Problems found while loading (also logged as warnings). */
  diagnostics: string[];
  origin?: PluginOrigin;
};

export type InstalledPluginStatus = {
  id: string;
  enabled: boolean;
  source: EnablementDecision["source"];
  sourceFile?: string;
  sourceKey?: string;
  reason?: string;
  plugin?: EnabledPlugin;
  /** How the plugin root was found (or every place that was tried when it was not). */
  resolution?: {
    root?: string;
    via?: ResolutionVia;
    attempts: ResolutionAttempt[];
  };
  format?: PluginFormat;
  dualManifest?: boolean;
  origin?: PluginOrigin;
  /** Position of the plugin's source in the effective source list; used for duplicate-name detection. */
  sourceIndex?: number;
  diagnostics?: string[];
};
