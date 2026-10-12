import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_FILE_NAME } from "./identity.js";

export type RuntimePaths = {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * Claude-format registry tree to read instead of `~/.agents/plugins`. Only set on the
   * per-source copies that discovery hands to the registry readers; `pluginDataDir` ignores it.
   */
  storeDir?: string;
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

/** `~/.agents/agent-plugin-support.json`: sources and enablement for every project. */
export function userConfigPath(paths: RuntimePaths): string {
  return path.join(agentsRoot(paths), CONFIG_FILE_NAME);
}

/** `<cwd>/.agents/agent-plugin-support.json`: overrides and extends the user file. */
export function projectConfigPath(paths: RuntimePaths): string {
  return path.join(paths.cwd, ".agents", CONFIG_FILE_NAME);
}

/** The legacy store: where sources default to when no config file declares any. */
export function defaultPluginsDir(paths: RuntimePaths): string {
  return path.join(agentsRoot(paths), "plugins");
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
  return paths.storeDir ?? defaultPluginsDir(paths);
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
  // Fixed location, whatever sources are configured: data must survive source changes.
  const dir = path.join(defaultPluginsDir(paths), "data", slug);
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
