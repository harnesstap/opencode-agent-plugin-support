import path from "node:path";
import { loadAgents, type LoadedAgent } from "./agents.js";
import { loadCommands, type LoadedCommand } from "./commands.js";
import { isPluginEnabled, loadActivation, parsePluginId, type PluginsActivation } from "./enablement.js";
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

export type DiscoveryResult = {
  paths: RuntimePaths;
  activation: PluginsActivation;
  installed: InstalledPluginRecord[];
  enabled: EnabledPlugin[];
  skipped: Array<{ id: string; reason: string }>;
};

export function discoverEnabledPlugins(overrides: Partial<RuntimePaths> = {}): DiscoveryResult {
  const paths = defaultRuntimePaths(overrides);
  const activation = loadActivation(paths);
  const installed = loadInstalledPlugins(paths);
  const enabled: EnabledPlugin[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const record of installed) {
    const install = pickInstallation(record, paths);
    if (!install) {
      skipped.push({ id: record.id, reason: "no installation entry" });
      continue;
    }
    const existing = resolveExistingInstallPath(record, install, paths);
    if (!existing) {
      skipped.push({ id: record.id, reason: `installPath missing: ${install.installPath}` });
      continue;
    }
    const pluginRoot = findPluginRoot(existing);
    if (!pluginRoot) {
      skipped.push({ id: record.id, reason: "could not find plugin root" });
      continue;
    }
    const loaded = loadManifestFromRoot(pluginRoot, record.name);
    const defaultEnabled = loaded.manifest.defaultEnabled !== false;
    if (!isPluginEnabled(activation, record.id, defaultEnabled)) {
      skipped.push({ id: record.id, reason: "disabled" });
      continue;
    }
    enabled.push(hydratePlugin(record, loaded.manifest, pluginRoot, paths));
  }

  return { paths, activation, installed, enabled, skipped };
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
