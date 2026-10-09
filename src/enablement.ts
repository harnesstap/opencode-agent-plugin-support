import { isFile, JsonParseError, readJsonFile, writeJsonFile } from "./fs-utils.js";
import { warn } from "./log.js";
import { projectPluginsJsonPath, type RuntimePaths, userPluginsJsonPath } from "./paths.js";

export type ExtraKnownMarketplace = {
  source:
    | { source: "github"; repo: string; ref?: string; path?: string }
    | { source: "git"; url: string }
    | { source: "directory"; path: string }
    | { source: string; [key: string]: unknown };
};

export type EnablementSource = "project" | "user" | "default";

export type ActivationLayer = {
  path: string;
  exists: boolean;
  enabledPlugins: Record<string, boolean>;
  extraKnownMarketplaces?: Record<string, ExtraKnownMarketplace>;
};

export type PluginsActivation = {
  user: ActivationLayer;
  project: ActivationLayer;
  /** Project keys override user keys. Missing keys are not listed. */
  enabledPlugins: Record<string, boolean>;
  extraKnownMarketplaces?: Record<string, ExtraKnownMarketplace>;
};

export type EnablementDecision = {
  enabled: boolean;
  source: EnablementSource;
  key?: string;
  file?: string;
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

function readActivationLayer(filePath: string): ActivationLayer {
  const exists = isFile(filePath);
  let raw: (Partial<PluginsActivation> & Record<string, unknown>) | undefined;
  try {
    raw = exists ? readJsonFile<Partial<PluginsActivation> & Record<string, unknown>>(filePath) : undefined;
  } catch (cause) {
    const detail = cause instanceof JsonParseError ? cause.message : String(cause);
    warn(`skipping ${filePath}: ${detail}`);
    return { path: filePath, exists, enabledPlugins: {} };
  }
  if (!raw) {
    return { path: filePath, exists, enabledPlugins: {} };
  }
  const enabled =
    raw.enabledPlugins && typeof raw.enabledPlugins === "object" && !Array.isArray(raw.enabledPlugins)
      ? { ...raw.enabledPlugins }
      : {};
  const extra =
    raw.extraKnownMarketplaces &&
    typeof raw.extraKnownMarketplaces === "object" &&
    !Array.isArray(raw.extraKnownMarketplaces)
      ? (raw.extraKnownMarketplaces as Record<string, ExtraKnownMarketplace>)
      : undefined;
  return { path: filePath, exists, enabledPlugins: enabled, extraKnownMarketplaces: extra };
}

/**
 * Only ~/.agents/plugins.json and <repo>/.agents/plugins.json are read.
 * Project overrides user. Missing files or keys mean the plugin stays enabled.
 */
export function loadActivation(paths: RuntimePaths): PluginsActivation {
  const user = readActivationLayer(userPluginsJsonPath(paths));
  const project = readActivationLayer(projectPluginsJsonPath(paths));
  const extraKnownMarketplaces = {
    ...user.extraKnownMarketplaces,
    ...project.extraKnownMarketplaces,
  };
  return {
    user,
    project,
    enabledPlugins: {
      ...user.enabledPlugins,
      ...project.enabledPlugins,
    },
    extraKnownMarketplaces: Object.keys(extraKnownMarketplaces).length
      ? extraKnownMarketplaces
      : undefined,
  };
}

function matchingEnablementKey(map: Record<string, boolean>, pluginId: string): string | undefined {
  if (pluginId in map) return pluginId;
  const parsed = parsePluginId(pluginId);
  if (parsed.marketplace && parsed.name in map) return parsed.name;
  if (!parsed.marketplace) {
    const prefixed = Object.keys(map).find((key) => parsePluginId(key).name === parsed.name);
    if (prefixed) return prefixed;
  }
  return undefined;
}

/**
 * Installed plugins are enabled unless some plugins.json sets the matching
 * key to false. Project wins over user. Manifest defaultEnabled is ignored.
 */
export function resolvePluginEnablement(activation: PluginsActivation, pluginId: string): EnablementDecision {
  const projectKey = matchingEnablementKey(activation.project.enabledPlugins, pluginId);
  if (projectKey !== undefined) {
    return {
      enabled: activation.project.enabledPlugins[projectKey] !== false,
      source: "project",
      key: projectKey,
      file: activation.project.path,
    };
  }
  const userKey = matchingEnablementKey(activation.user.enabledPlugins, pluginId);
  if (userKey !== undefined) {
    return {
      enabled: activation.user.enabledPlugins[userKey] !== false,
      source: "user",
      key: userKey,
      file: activation.user.path,
    };
  }
  return { enabled: true, source: "default" };
}

export function isPluginEnabled(activation: PluginsActivation, pluginId: string): boolean {
  return resolvePluginEnablement(activation, pluginId).enabled;
}

function writeLayer(layer: ActivationLayer): void {
  writeJsonFile(layer.path, {
    enabledPlugins: layer.enabledPlugins,
    ...(layer.extraKnownMarketplaces && Object.keys(layer.extraKnownMarketplaces).length
      ? { extraKnownMarketplaces: layer.extraKnownMarketplaces }
      : {}),
  });
}

export function saveUserActivation(paths: RuntimePaths, next: Pick<ActivationLayer, "enabledPlugins" | "extraKnownMarketplaces">): void {
  writeLayer({
    path: userPluginsJsonPath(paths),
    exists: true,
    enabledPlugins: next.enabledPlugins,
    extraKnownMarketplaces: next.extraKnownMarketplaces,
  });
}

export function saveProjectActivation(
  paths: RuntimePaths,
  next: Pick<ActivationLayer, "enabledPlugins" | "extraKnownMarketplaces">,
): void {
  writeLayer({
    path: projectPluginsJsonPath(paths),
    exists: true,
    enabledPlugins: next.enabledPlugins,
    extraKnownMarketplaces: next.extraKnownMarketplaces,
  });
}

export function setLayerEnabled(
  paths: RuntimePaths,
  pluginId: string,
  enabled: boolean,
  layer: "user" | "project",
): EnablementDecision {
  const activation = loadActivation(paths);
  const target = layer === "project" ? activation.project : activation.user;
  const next: ActivationLayer = {
    ...target,
    enabledPlugins: {
      ...target.enabledPlugins,
      [pluginId]: enabled,
    },
  };
  writeLayer(next);
  const refreshed = loadActivation(paths);
  return resolvePluginEnablement(refreshed, pluginId);
}

export function setUserExtraMarketplaces(
  paths: RuntimePaths,
  extraKnownMarketplaces: Record<string, ExtraKnownMarketplace>,
): void {
  const activation = loadActivation(paths);
  writeLayer({
    ...activation.user,
    extraKnownMarketplaces,
  });
}
