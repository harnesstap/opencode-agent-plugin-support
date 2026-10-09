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
import {
  loadInstalledPlugins,
  pickInstallation,
  resolveExistingInstallPath,
  type InstalledPluginRecord,
} from "./installed.js";
import { loadInstructions, type LoadedInstructions } from "./instructions.js";
import { findPluginRoot, loadManifestFromRoot, type PluginManifest } from "./manifest.js";
import { loadMcpServers, type OpenCodeMcp } from "./mcp.js";
import { warn } from "./log.js";
import { defaultRuntimePaths, pluginDataDir, type RuntimePaths } from "./paths.js";
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

  for (const record of installed) {
    const decision = resolvePluginEnablement(activation, record.id);
    const statusBase = {
      id: record.id,
      source: decision.source,
      sourceFile: decision.file,
      sourceKey: decision.key,
    };
    const install = pickInstallation(record, paths);
    if (!install) {
      skipped.push({ id: record.id, reason: "no installation entry" });
      statuses.push({ ...statusBase, enabled: false, reason: "no installation entry" });
      continue;
    }
    const existing = resolveExistingInstallPath(record, install, paths);
    if (!existing) {
      const reason = `installPath missing: ${install.installPath}`;
      skipped.push({ id: record.id, reason });
      statuses.push({ ...statusBase, enabled: false, reason });
      continue;
    }
    const pluginRoot = findPluginRoot(existing);
    if (!pluginRoot) {
      skipped.push({ id: record.id, reason: "could not find plugin root" });
      statuses.push({ ...statusBase, enabled: false, reason: "could not find plugin root" });
      continue;
    }
    let loaded;
    try {
      loaded = loadManifestFromRoot(pluginRoot, record.name);
    } catch (cause) {
      const reason = `malformed plugin.json: ${cause instanceof Error ? cause.message : cause}`;
      warn(`skipping plugin "${record.id}": ${reason}`);
      skipped.push({ id: record.id, reason });
      statuses.push({ ...statusBase, enabled: false, reason });
      continue;
    }
    if (!isPluginEnabled(activation, record.id)) {
      skipped.push({ id: record.id, reason: "disabled" });
      statuses.push({ ...statusBase, enabled: false, reason: "disabled" });
      continue;
    }
    try {
      const plugin = hydratePlugin(record, loaded.manifest, pluginRoot, paths);
      enabled.push(plugin);
      statuses.push({ ...statusBase, enabled: true, plugin });
    } catch (cause) {
      const reason = `failed to load: ${cause instanceof Error ? cause.message : cause}`;
      warn(`skipping plugin "${record.id}": ${reason}`);
      skipped.push({ id: record.id, reason });
      statuses.push({ ...statusBase, enabled: false, reason });
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
