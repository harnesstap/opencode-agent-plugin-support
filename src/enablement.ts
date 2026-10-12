import { loadConfig, writeConfigEnabled, type ConfigLayer, type EffectiveConfig } from "./config.js";
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
  /** Legacy `~/.agents/plugins.json`. */
  user: ActivationLayer;
  /** Legacy `<repo>/.agents/plugins.json`. */
  project: ActivationLayer;
  /** `~/.agents/agent-plugin-support.json`; wins over both legacy files. */
  userConfig: ActivationLayer;
  /** `<repo>/.agents/agent-plugin-support.json`; wins over everything. */
  projectConfig: ActivationLayer;
  /** Effective keys after layering (see `resolvePluginEnablement`). Missing keys are not listed. */
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

function configLayerAsActivation(layer: ConfigLayer): ActivationLayer {
  return { path: layer.path, exists: layer.exists, enabledPlugins: layer.enabledPlugins };
}

/**
 * Enablement layers, highest precedence first: `<repo>/.agents/agent-plugin-support.json`,
 * `~/.agents/agent-plugin-support.json`, then the legacy `<repo>/.agents/plugins.json` and
 * `~/.agents/plugins.json`. A key set in a higher layer is never looked up in a lower one.
 * Missing files or keys mean the plugin stays enabled. `extraKnownMarketplaces` is still read
 * from the legacy files only.
 */
export function loadActivation(paths: RuntimePaths, config: EffectiveConfig = loadConfig(paths)): PluginsActivation {
  const user = readActivationLayer(userPluginsJsonPath(paths));
  const project = readActivationLayer(projectPluginsJsonPath(paths));
  const userConfig = configLayerAsActivation(config.user);
  const projectConfig = configLayerAsActivation(config.project);
  const extraKnownMarketplaces = {
    ...user.extraKnownMarketplaces,
    ...project.extraKnownMarketplaces,
  };
  return {
    user,
    project,
    userConfig,
    projectConfig,
    enabledPlugins: {
      ...user.enabledPlugins,
      ...project.enabledPlugins,
      ...userConfig.enabledPlugins,
      ...projectConfig.enabledPlugins,
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
 * Installed plugins are enabled unless the highest layer that mentions them sets the
 * matching key to false. Manifest defaultEnabled is ignored.
 */
export function resolvePluginEnablement(activation: PluginsActivation, pluginId: string): EnablementDecision {
  const layers: Array<[ActivationLayer, EnablementSource]> = [
    [activation.projectConfig, "project"],
    [activation.userConfig, "user"],
    [activation.project, "project"],
    [activation.user, "user"],
  ];
  for (const [layer, source] of layers) {
    const key = matchingEnablementKey(layer.enabledPlugins, pluginId);
    if (key !== undefined) {
      return { enabled: layer.enabledPlugins[key] !== false, source, key, file: layer.path };
    }
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

export type EnablementWriteTarget = { file: string; kind: "config" | "legacy" };

/**
 * Where `enable` / `disable` write for a layer: that layer's `agent-plugin-support.json` when it
 * exists, otherwise the legacy `plugins.json`.
 */
export function enablementWriteTarget(
  paths: RuntimePaths,
  layer: "user" | "project",
  config: EffectiveConfig = loadConfig(paths),
): EnablementWriteTarget {
  const configLayer = layer === "project" ? config.project : config.user;
  if (configLayer.exists) return { file: configLayer.path, kind: "config" };
  return { file: layer === "project" ? projectPluginsJsonPath(paths) : userPluginsJsonPath(paths), kind: "legacy" };
}

export function setLayerEnabled(
  paths: RuntimePaths,
  pluginId: string,
  enabled: boolean,
  layer: "user" | "project",
): EnablementDecision {
  const config = loadConfig(paths);
  const target = enablementWriteTarget(paths, layer, config);
  if (target.kind === "config") {
    const configLayer = layer === "project" ? config.project : config.user;
    if (configLayer.error) {
      throw new Error(`${target.file} is not valid JSON (${configLayer.error}); fix it before changing enablement`);
    }
    writeConfigEnabled(target.file, pluginId, enabled);
  } else {
    const activation = loadActivation(paths, config);
    const legacy = layer === "project" ? activation.project : activation.user;
    writeLayer({
      ...legacy,
      enabledPlugins: {
        ...legacy.enabledPlugins,
        [pluginId]: enabled,
      },
    });
  }
  return resolvePluginEnablement(loadActivation(paths), pluginId);
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
