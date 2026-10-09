import { discoverEnabledPlugins, loadPluginFromDirectory, type EnabledPlugin } from "./discover.js";
import { buildConfigPatch, type OpenCodeConfigPatch } from "./inject.js";
import { warn } from "./log.js";
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
  const skipped = [...discovered.skipped];
  for (const [id, dir] of Object.entries(options.extraPluginDirs ?? {})) {
    try {
      plugins.push(loadPluginFromDirectory(dir, id, paths));
    } catch (cause) {
      const reason = `failed to load extraPluginDirs entry: ${cause instanceof Error ? cause.message : cause}`;
      warn(`skipping plugin "${id}": ${reason}`);
      skipped.push({ id, reason });
    }
  }
  return {
    paths,
    options,
    plugins,
    patch: buildConfigPatch(plugins),
    skipped,
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
