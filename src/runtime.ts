import { discoverEnabledPlugins, loadPluginFromDirectory, type EnabledPlugin } from "./discover.js";
import { buildConfigPatch, type OpenCodeConfigPatch } from "./inject.js";
import { parsePluginOptions, type PluginOptions } from "./plugin-options.js";
import { defaultRuntimePaths, type RuntimePaths } from "./paths.js";

export type LoadedBridge = {
  paths: RuntimePaths;
  options: PluginOptions;
  plugins: EnabledPlugin[];
  patch: OpenCodeConfigPatch;
  skipped: Array<{ id: string; reason: string }>;
};

export function loadBridge(input: {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  options?: unknown;
}): LoadedBridge {
  const options = parsePluginOptions(input.options);
  const paths = defaultRuntimePaths({
    cwd: input.cwd,
    home: input.home,
    env: input.env,
  });
  const discovered = options.skipInstalled
    ? { enabled: [] as EnabledPlugin[], skipped: [] as Array<{ id: string; reason: string }> }
    : discoverEnabledPlugins(paths);
  const plugins = [...discovered.enabled];
  for (const [id, dir] of Object.entries(options.extraPluginDirs ?? {})) {
    plugins.push(loadPluginFromDirectory(dir, id, paths));
  }
  return {
    paths,
    options,
    plugins,
    patch: buildConfigPatch(plugins),
    skipped: discovered.skipped,
  };
}

export function mcpServerIds(plugins: EnabledPlugin[]): string[] {
  const ids: string[] = [];
  for (const plugin of plugins) {
    for (const server of Object.keys(plugin.mcp)) {
      ids.push(`${plugin.name}:${server}`);
    }
  }
  return ids;
}
