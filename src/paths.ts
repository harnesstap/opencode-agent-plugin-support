import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type RuntimePaths = {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export function defaultRuntimePaths(overrides: Partial<RuntimePaths> = {}): RuntimePaths {
  const homeFromEnv = overrides.env?.HOME ?? process.env.HOME;
  return {
    home: overrides.home ?? homeFromEnv ?? os.homedir(),
    cwd: overrides.cwd ?? process.cwd(),
    env: overrides.env ?? process.env,
  };
}

export function expandUserPath(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(home, value.slice(2));
  }
  return value.replaceAll("${HOME}", home).replaceAll("$HOME", home);
}

export function agentsRoot(paths: RuntimePaths): string {
  return path.join(paths.home, ".agents");
}

/** Activation state: Claude's enabledPlugins / extraKnownMarketplaces. */
export function userPluginsJsonPath(paths: RuntimePaths): string {
  return path.join(agentsRoot(paths), "plugins.json");
}

export function projectPluginsJsonPath(paths: RuntimePaths): string {
  return path.join(paths.cwd, ".agents", "plugins.json");
}

/**
 * On-disk plugin store. Layout matches ~/.claude/plugins/ so
 * `ln -s ~/.claude/plugins ~/.agents/plugins` works.
 */
export function pluginsDir(paths: RuntimePaths): string {
  return path.join(agentsRoot(paths), "plugins");
}

export function installedPluginsPath(paths: RuntimePaths): string {
  return path.join(pluginsDir(paths), "installed_plugins.json");
}

export function knownMarketplacesPath(paths: RuntimePaths): string {
  return path.join(pluginsDir(paths), "known_marketplaces.json");
}

export function marketplacesDir(paths: RuntimePaths): string {
  return path.join(pluginsDir(paths), "marketplaces");
}

export function cacheDir(paths: RuntimePaths): string {
  return path.join(pluginsDir(paths), "cache");
}

export function pluginDataDir(paths: RuntimePaths, pluginId: string): string {
  const slug = pluginId.replace(/[^A-Za-z0-9_-]/g, "-");
  const dir = path.join(pluginsDir(paths), "data", slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function versionedCachePath(
  paths: RuntimePaths,
  marketplace: string,
  name: string,
  version: string,
): string {
  return path.join(cacheDir(paths), marketplace, name, version);
}
