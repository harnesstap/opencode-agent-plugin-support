import { readJsonFile, writeJsonFile } from "./fs-utils.js";
import {
  claudeProjectSettingsPath,
  claudeUserSettingsPath,
  projectPluginsJsonPath,
  type RuntimePaths,
  userPluginsJsonPath,
} from "./paths.js";

export type ExtraKnownMarketplace = {
  source:
    | { source: "github"; repo: string; ref?: string; path?: string }
    | { source: "git"; url: string }
    | { source: "directory"; path: string }
    | { source: string; [key: string]: unknown };
};

export type PluginsActivation = {
  enabledPlugins: Record<string, boolean>;
  extraKnownMarketplaces?: Record<string, ExtraKnownMarketplace>;
};

export type PluginIdentifier = {
  name: string;
  marketplace?: string;
  id: string;
};

export function parsePluginId(id: string): PluginIdentifier {
  const at = id.lastIndexOf("@");
  if (at <= 0) return { name: id, id };
  return {
    name: id.slice(0, at),
    marketplace: id.slice(at + 1),
    id,
  };
}

export function formatPluginId(name: string, marketplace?: string): string {
  return marketplace ? `${name}@${marketplace}` : name;
}

function readActivationFile(filePath: string): PluginsActivation {
  const raw = readJsonFile<Partial<PluginsActivation> & Record<string, unknown>>(filePath);
  if (!raw) return { enabledPlugins: {} };
  const enabled =
    raw.enabledPlugins && typeof raw.enabledPlugins === "object" && !Array.isArray(raw.enabledPlugins)
      ? { ...raw.enabledPlugins }
      : {};
  const extra =
    raw.extraKnownMarketplaces &&
    typeof raw.extraKnownMarketplaces === "object" &&
    !Array.isArray(raw.extraKnownMarketplaces)
      ? raw.extraKnownMarketplaces
      : undefined;
  return { enabledPlugins: enabled, extraKnownMarketplaces: extra };
}

/**
 * Merge enablement: Claude writes `enabledPlugins` in settings.json.
 * We keep the same map in ~/.agents/plugins.json and optional project .agents/plugins.json.
 * Project keys override user keys. Agents files override Claude settings fallbacks.
 */
export function loadActivation(paths: RuntimePaths): PluginsActivation {
  const claudeUser = readActivationFile(claudeUserSettingsPath(paths));
  const claudeProject = readActivationFile(claudeProjectSettingsPath(paths));
  const user = readActivationFile(userPluginsJsonPath(paths));
  const project = readActivationFile(projectPluginsJsonPath(paths));

  const extraKnownMarketplaces = {
    ...claudeUser.extraKnownMarketplaces,
    ...user.extraKnownMarketplaces,
    ...claudeProject.extraKnownMarketplaces,
    ...project.extraKnownMarketplaces,
  };

  return {
    enabledPlugins: {
      ...claudeUser.enabledPlugins,
      ...user.enabledPlugins,
      ...claudeProject.enabledPlugins,
      ...project.enabledPlugins,
    },
    extraKnownMarketplaces: Object.keys(extraKnownMarketplaces).length
      ? extraKnownMarketplaces
      : undefined,
  };
}

export function saveUserActivation(paths: RuntimePaths, next: PluginsActivation): void {
  writeJsonFile(userPluginsJsonPath(paths), next);
}

export function saveProjectActivation(paths: RuntimePaths, next: PluginsActivation): void {
  writeJsonFile(projectPluginsJsonPath(paths), next);
}

export function isPluginEnabled(
  activation: PluginsActivation,
  pluginId: string,
  defaultEnabled = true,
): boolean {
  const parsed = parsePluginId(pluginId);
  const map = activation.enabledPlugins;
  if (pluginId in map) return map[pluginId] === true;
  if (parsed.marketplace) {
    const bare = map[parsed.name];
    if (typeof bare === "boolean") return bare;
  } else {
    const prefixed = Object.entries(map).find(([key]) => parsePluginId(key).name === parsed.name);
    if (prefixed) return prefixed[1] === true;
  }
  return defaultEnabled;
}

export function setEnabled(
  activation: PluginsActivation,
  pluginId: string,
  enabled: boolean,
): PluginsActivation {
  return {
    ...activation,
    enabledPlugins: {
      ...activation.enabledPlugins,
      [pluginId]: enabled,
    },
  };
}
