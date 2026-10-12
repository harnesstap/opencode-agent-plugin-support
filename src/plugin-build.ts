import path from "node:path";
import { loadOpenCodeExtension } from "./ap-extension.js";
import { loadAgentMcp, type AgentMcpResult } from "./ap-mcp.js";
import type { AgentPluginsManifest, ManifestSniff } from "./ap-manifest.js";
import { SUPPORTED_AP_VERSION } from "./ap-manifest.js";
import { loadAgentSkills } from "./ap-skills.js";
import { loadAgents } from "./agents.js";
import { loadCommands } from "./commands.js";
import type { Diagnostics } from "./diagnostics.js";
import type { ExpandContext } from "./expand.js";
import { isDirectory } from "./fs-utils.js";
import { loadHooks } from "./hooks.js";
import type { InstalledPluginRecord } from "./installed.js";
import { loadInstructions } from "./instructions.js";
import { debug } from "./log.js";
import type { PluginManifest } from "./manifest.js";
import { loadMcpServers } from "./mcp.js";
import { pluginDataDir, type RuntimePaths } from "./paths.js";
import type { EnabledPlugin, PluginOrigin } from "./plugin-types.js";
import { realpathOrUndefined } from "./safe-path.js";
import { loadSkills } from "./skills.js";

function reportMcp(result: AgentMcpResult, diag: Diagnostics): void {
  if (result.disabled) diag.warn(`MCP disabled: ${result.disabled}`);
  for (const skipped of result.skipped) diag.warn(`MCP server "${skipped.server}" skipped: ${skipped.reason}`);
}

/**
 * Load a Claude-format plugin. When it also ships a valid Agent Plugins manifest (`ap`), its
 * `mcp.json` servers are added to the Claude ones; a server name Claude already defines keeps
 * the Claude definition, and the Claude plugin name stays the namespace prefix.
 */
export function hydrateClaudePlugin(
  record: InstalledPluginRecord,
  manifest: PluginManifest,
  pluginRoot: string,
  paths: RuntimePaths,
  diag: Diagnostics,
  ap: ManifestSniff = { kind: "none" },
  origin?: PluginOrigin,
): EnabledPlugin {
  const ctx: ExpandContext = {
    pluginRoot,
    pluginData: pluginDataDir(paths, record.id),
    projectDir: paths.cwd,
    env: paths.env,
  };
  const binDir = path.join(pluginRoot, "bin");
  const plugin: EnabledPlugin = {
    id: record.id,
    name: manifest.name,
    marketplace: record.marketplace,
    pluginRoot,
    manifest,
    format: "claude",
    dualManifest: false,
    skills: loadSkills(pluginRoot, manifest),
    commands: loadCommands(pluginRoot, manifest),
    agents: loadAgents(pluginRoot, manifest),
    mcp: loadMcpServers(pluginRoot, manifest, ctx),
    mcpSkipped: [],
    instructions: loadInstructions(pluginRoot, manifest.name, ctx),
    hooks: loadHooks(pluginRoot, manifest, ctx),
    binDir: isDirectory(binDir) ? binDir : undefined,
    diagnostics: diag.messages,
    origin,
  };

  if (ap.kind === "invalid") {
    diag.warn(`invalid Agent Plugins manifest (${ap.reason}); using the Claude manifest only`);
  } else if (ap.kind === "valid") {
    const realRoot = realpathOrUndefined(pluginRoot) ?? pluginRoot;
    for (const note of ap.notes) diag.warn(note);
    if (ap.manifest.name !== manifest.name) {
      diag.warn(`Agent Plugins name "${ap.manifest.name}" differs from the Claude name "${manifest.name}"; using "${manifest.name}"`);
    }
    const result = loadAgentMcp({ realRoot, pluginData: ctx.pluginData, schemaVersion: SUPPORTED_AP_VERSION });
    reportMcp(result, diag);
    for (const [name, spec] of Object.entries(result.servers)) {
      if (name in plugin.mcp) debug(`plugin "${record.id}": mcp.json server "${name}" is also defined by the Claude manifest; keeping the Claude one`);
      else plugin.mcp[name] = spec;
    }
    plugin.mcpSkipped = result.skipped;
    plugin.dualManifest = true;
    plugin.agentPluginsRoot = realRoot;
  }
  return plugin;
}

export type AgentPackage = {
  id: string;
  label?: string;
  realRoot: string;
  manifest: AgentPluginsManifest;
  notes: string[];
};

/** Load an Agent Plugins package (spec 1.0.0) plus its `com.harnesstap.opencode` extension. */
export function hydrateAgentPlugin(
  pkg: AgentPackage,
  paths: RuntimePaths,
  diag: Diagnostics,
  origin?: PluginOrigin,
): EnabledPlugin {
  const { realRoot, manifest } = pkg;
  const dataDir = pluginDataDir(paths, pkg.id);
  const ctx: ExpandContext = {
    pluginRoot: realRoot,
    pluginData: realpathOrUndefined(dataDir) ?? dataDir,
    projectDir: paths.cwd,
    env: paths.env,
    pluginVars: true,
  };
  for (const note of pkg.notes) diag.warn(note);
  const mcp = loadAgentMcp({ realRoot, pluginData: ctx.pluginData, schemaVersion: SUPPORTED_AP_VERSION });
  reportMcp(mcp, diag);
  const extension = loadOpenCodeExtension(realRoot, manifest, ctx, diag);
  const { extensions: _extensions, author, ...metadata } = manifest;
  return {
    id: pkg.id,
    name: manifest.name,
    marketplace: pkg.label,
    pluginRoot: realRoot,
    manifest: { ...metadata, ...(author ? { author: { ...author, name: author.name ?? "" } } : {}), defaultEnabled: true },
    format: "agent-plugins",
    dualManifest: false,
    agentPluginsRoot: realRoot,
    skills: loadAgentSkills(realRoot, diag),
    commands: extension.commands,
    agents: extension.agents,
    mcp: mcp.servers,
    mcpSkipped: mcp.skipped,
    instructions: extension.instructions,
    hooks: extension.hooks,
    diagnostics: diag.messages,
    origin,
  };
}
