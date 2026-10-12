import path from "node:path";
import { sniffAgentPluginsManifest } from "./ap-manifest.js";
import { loadConfig, type EffectiveConfig } from "./config.js";
import { Diagnostics } from "./diagnostics.js";
import { loadActivation, parsePluginId, type PluginsActivation } from "./enablement.js";
import type { InstalledPluginRecord } from "./installed.js";
import { isFile } from "./fs-utils.js";
import { loadManifestFromRoot } from "./manifest.js";
import { warn } from "./log.js";
import { defaultRuntimePaths, type RuntimePaths } from "./paths.js";
import { hydrateAgentPlugin, hydrateClaudePlugin } from "./plugin-build.js";
import type { EnabledPlugin, InstalledPluginStatus } from "./plugin-types.js";
import { realpathOrUndefined } from "./safe-path.js";
import { discoverSource, type SourceStatus } from "./source-discovery.js";

export type { EnabledPlugin, InstalledPluginStatus, PluginFormat, PluginOrigin } from "./plugin-types.js";
export type { SourceStatus } from "./source-discovery.js";

export type DiscoveryResult = {
  paths: RuntimePaths;
  config: EffectiveConfig;
  activation: PluginsActivation;
  sources: SourceStatus[];
  /** Claude registry records from every claude / auto source. */
  installed: InstalledPluginRecord[];
  enabled: EnabledPlugin[];
  skipped: Array<{ id: string; reason: string }>;
  statuses: InstalledPluginStatus[];
};

/**
 * Plugin names are the namespace prefix of commands, agents and MCP servers, so two enabled
 * plugins from different sources cannot share one. The earlier source wins.
 */
function dropDuplicateNames(statuses: InstalledPluginStatus[]): void {
  const first = new Map<string, InstalledPluginStatus>();
  for (const status of statuses) {
    const plugin = status.plugin;
    if (!status.enabled || !plugin) continue;
    const winner = first.get(plugin.name);
    if (!winner || winner.sourceIndex === status.sourceIndex) {
      if (!winner) first.set(plugin.name, status);
      continue;
    }
    const reason = `duplicate plugin name "${plugin.name}": already provided by "${winner.id}" from ${winner.origin?.path ?? "an earlier source"}; keeping the first source`;
    warn(`skipping plugin "${status.id}": ${reason}`);
    status.enabled = false;
    status.reason = reason;
    status.plugin = undefined;
  }
}

export function discoverEnabledPlugins(overrides: Partial<RuntimePaths> = {}): DiscoveryResult {
  const paths = defaultRuntimePaths(overrides);
  const config = loadConfig(paths);
  const activation = loadActivation(paths, config);
  const statuses: InstalledPluginStatus[] = [];
  const installed: InstalledPluginRecord[] = [];
  const sources: SourceStatus[] = [];

  config.sources.forEach((source, sourceIndex) => {
    const result = discoverSource(source, { paths, activation, sourceIndex });
    statuses.push(...result.statuses);
    installed.push(...result.installed);
    sources.push(result.status);
  });
  dropDuplicateNames(statuses);

  return {
    paths,
    config,
    activation,
    sources,
    installed,
    enabled: statuses.flatMap((status) => (status.enabled && status.plugin ? [status.plugin] : [])),
    skipped: statuses.filter((status) => !status.enabled).map((status) => ({ id: status.id, reason: status.reason ?? "skipped" })),
    statuses,
  };
}

/**
 * Load one plugin directory outside any source (`extraPluginDirs`, `install-local`). The kind is
 * detected from the manifests: a root `plugin.json` that declares an agent-plugins.org `$schema`
 * and no `.claude-plugin/plugin.json` is an Agent Plugins package, anything else is Claude format.
 */
export function loadPluginFromDirectory(pluginRoot: string, id: string, paths: RuntimePaths): EnabledPlugin {
  const parsed = parsePluginId(id);
  const diag = new Diagnostics(id);
  const ap = sniffAgentPluginsManifest(pluginRoot);
  const claudeManifest = isFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"));
  if (!claudeManifest && ap.kind === "valid") {
    return hydrateAgentPlugin(
      {
        id,
        label: parsed.marketplace,
        realRoot: realpathOrUndefined(pluginRoot) ?? pluginRoot,
        manifest: ap.manifest,
        notes: ap.notes,
      },
      paths,
      diag,
    );
  }
  const loaded = loadManifestFromRoot(pluginRoot, parsed.name);
  return hydrateClaudePlugin(
    {
      id,
      name: loaded.manifest.name,
      marketplace: parsed.marketplace,
      installations: [{ installPath: pluginRoot, isLocal: true, scope: "local" }],
    },
    loaded.manifest,
    pluginRoot,
    paths,
    diag,
    ap,
  );
}

export function namespaced(pluginName: string, component: string): string {
  return `${pluginName}:${component}`;
}
