import path from "node:path";
import { loadAgents, type LoadedAgent } from "./agents.js";
import { loadCommands, type LoadedCommand } from "./commands.js";
import {
  isPluginEnabled,
  loadActivation,
  parsePluginId,
  resolvePluginEnablement,
  type EnablementDecision,
  type PluginsActivation,
} from "./enablement.js";
import { type ExpandContext } from "./expand.js";
import { loadHooks, type ClaudeHooksConfig } from "./hooks.js";
import { loadInstalledPlugins, type InstalledPluginRecord } from "./installed.js";
import { loadInstructions, type LoadedInstructions } from "./instructions.js";
import { applyMarketplaceEntry } from "./marketplace-entry.js";
import { MarketplaceIndex } from "./marketplace.js";
import { findPluginRoot, loadManifestFromRoot, type PluginManifest } from "./manifest.js";
import { loadMcpServers, type OpenCodeMcp } from "./mcp.js";
import { debug, warn } from "./log.js";
import { defaultRuntimePaths, pluginDataDir, type RuntimePaths } from "./paths.js";
import {
  describeAttempts,
  pickInstallation,
  resolvePluginRoot,
  type ResolutionAttempt,
  type ResolutionVia,
} from "./plugin-root.js";
import { loadSkills, type LoadedSkill } from "./skills.js";
import { isDirectory } from "./fs-utils.js";

export type EnabledPlugin = {
  id: string;
  name: string;
  marketplace?: string;
  pluginRoot: string;
  manifest: PluginManifest;
  skills: LoadedSkill[];
  commands: LoadedCommand[];
  agents: LoadedAgent[];
  mcp: Record<string, OpenCodeMcp>;
  instructions: LoadedInstructions;
  hooks: ClaudeHooksConfig;
  binDir?: string;
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
};

export type DiscoveryResult = {
  paths: RuntimePaths;
  activation: PluginsActivation;
  installed: InstalledPluginRecord[];
  enabled: EnabledPlugin[];
  skipped: Array<{ id: string; reason: string }>;
  statuses: InstalledPluginStatus[];
};

export function discoverEnabledPlugins(overrides: Partial<RuntimePaths> = {}): DiscoveryResult {
  const paths = defaultRuntimePaths(overrides);
  const activation = loadActivation(paths);
  const installed = loadInstalledPlugins(paths);
  const enabled: EnabledPlugin[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const statuses: InstalledPluginStatus[] = [];
  const marketplaces = new MarketplaceIndex(paths, activation.extraKnownMarketplaces);

  for (const record of installed) {
    const decision = resolvePluginEnablement(activation, record.id);
    const statusBase = {
      id: record.id,
      source: decision.source,
      sourceFile: decision.file,
      sourceKey: decision.key,
    };
    const install = pickInstallation(record, paths, marketplaces);
    if (!install) {
      skipped.push({ id: record.id, reason: "no installation entry" });
      statuses.push({ ...statusBase, enabled: false, reason: "no installation entry" });
      continue;
    }
    const resolved = resolvePluginRoot(record, install, paths, marketplaces);
    const resolution = { root: resolved.root, via: resolved.via, attempts: resolved.attempts };
    if (!resolved.root || !resolved.via) {
      const reason = `plugin root unresolved: ${resolved.reason ?? describeAttempts(resolved.attempts)}`;
      const log = isPluginEnabled(activation, record.id) ? warn : debug;
      log(`cannot resolve plugin "${record.id}": ${reason}`);
      skipped.push({ id: record.id, reason });
      statuses.push({ ...statusBase, enabled: false, reason, resolution });
      continue;
    }
    debug(`resolved plugin "${record.id}" via ${resolved.via}: ${resolved.root}`);
    // Marketplace sources are exact plugin directories; install/cache dirs may nest the plugin one level down.
    const pluginRoot =
      resolved.via === "installPath" || resolved.via === "cache" ? findPluginRoot(resolved.root) : resolved.root;
    if (!pluginRoot) {
      skipped.push({ id: record.id, reason: "could not find plugin root" });
      statuses.push({ ...statusBase, enabled: false, reason: "could not find plugin root", resolution });
      continue;
    }
    let manifest: PluginManifest;
    try {
      const loaded = loadManifestFromRoot(pluginRoot, record.name);
      manifest = applyMarketplaceEntry(loaded, resolved.entry);
    } catch (cause) {
      const reason = `malformed plugin.json: ${cause instanceof Error ? cause.message : cause}`;
      warn(`skipping plugin "${record.id}": ${reason}`);
      skipped.push({ id: record.id, reason });
      statuses.push({ ...statusBase, enabled: false, reason, resolution });
      continue;
    }
    if (!isPluginEnabled(activation, record.id)) {
      skipped.push({ id: record.id, reason: "disabled" });
      statuses.push({ ...statusBase, enabled: false, reason: "disabled", resolution });
      continue;
    }
    try {
      const plugin = hydratePlugin(record, manifest, pluginRoot, paths);
      enabled.push(plugin);
      statuses.push({ ...statusBase, enabled: true, plugin, resolution });
    } catch (cause) {
      const reason = `failed to load: ${cause instanceof Error ? cause.message : cause}`;
      warn(`skipping plugin "${record.id}": ${reason}`);
      skipped.push({ id: record.id, reason });
      statuses.push({ ...statusBase, enabled: false, reason, resolution });
    }
  }

  return { paths, activation, installed, enabled, skipped, statuses };
}

export function loadPluginFromDirectory(
  pluginRoot: string,
  id: string,
  paths: RuntimePaths,
): EnabledPlugin {
  const parsed = parsePluginId(id);
  const loaded = loadManifestFromRoot(pluginRoot, parsed.name);
  return hydratePlugin(
    {
      id,
      name: loaded.manifest.name,
      marketplace: parsed.marketplace,
      installations: [
        {
          installPath: pluginRoot,
          isLocal: true,
          scope: "local",
        },
      ],
    },
    loaded.manifest,
    pluginRoot,
    paths,
  );
}

function hydratePlugin(
  record: InstalledPluginRecord,
  manifest: PluginManifest,
  pluginRoot: string,
  paths: RuntimePaths,
): EnabledPlugin {
  const ctx: ExpandContext = {
    pluginRoot,
    pluginData: pluginDataDir(paths, record.id),
    projectDir: paths.cwd,
    env: paths.env,
  };
  const binDir = path.join(pluginRoot, "bin");
  return {
    id: record.id,
    name: manifest.name,
    marketplace: record.marketplace,
    pluginRoot,
    manifest,
    skills: loadSkills(pluginRoot, manifest),
    commands: loadCommands(pluginRoot, manifest),
    agents: loadAgents(pluginRoot, manifest),
    mcp: loadMcpServers(pluginRoot, manifest, ctx),
    instructions: loadInstructions(pluginRoot, manifest.name, ctx),
    hooks: loadHooks(pluginRoot, manifest, ctx),
    binDir: isDirectory(binDir) ? binDir : undefined,
  };
}

export function namespaced(pluginName: string, component: string): string {
  return `${pluginName}:${component}`;
}
