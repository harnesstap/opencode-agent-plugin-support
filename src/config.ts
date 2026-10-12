import path from "node:path";
import { isFile, JsonParseError, readJsonFile, writeJsonFile } from "./fs-utils.js";
import { warn } from "./log.js";
import { defaultPluginsDir, expandUserPath, projectConfigPath, type RuntimePaths, userConfigPath } from "./paths.js";
import { isRecord } from "./manifest.js";

export const SOURCE_FORMATS = ["claude", "agent-plugins", "auto"] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

export type ConfigScope = "user" | "project";

/** One `sources` entry after validation, with its path still as written. */
export type DeclaredSource = {
  path: string;
  format: SourceFormat;
  label?: string;
  enabled: boolean;
};

export type ConfigLayer = {
  scope: ConfigScope;
  path: string;
  exists: boolean;
  /** Set when the file exists but is not usable JSON; its contents are then ignored. */
  error?: string;
  /** `undefined` when the file does not declare `sources` at all (an empty array is a declaration). */
  sources?: DeclaredSource[];
  enabledPlugins: Record<string, boolean>;
};

export type SourceOrigin = "user" | "project" | "default";

export type ResolvedSource = {
  /** Path as written in the config file (or the default). */
  declaredPath: string;
  /** Absolute path: `~` expanded, relative paths resolved from the config file's directory. */
  path: string;
  format: SourceFormat;
  /** Suffix of Agent Plugins ids (`<name>@<label>`). Unique across the effective sources. */
  label: string;
  origin: SourceOrigin;
  /** Config file that declared it; absent for the implicit default source. */
  configFile?: string;
  /** True for the built-in `~/.agents/plugins` source used when no config declares any. */
  implicit: boolean;
};

export type EffectiveConfig = {
  user: ConfigLayer;
  project: ConfigLayer;
  /** True when at least one config file exists. */
  exists: boolean;
  sources: ResolvedSource[];
  /** Sources a config file switched off with `enabled: false`; kept for `sources` output. */
  disabledSources: ResolvedSource[];
};

const TOP_LEVEL_KEYS = new Set(["$schema", "sources", "enabledPlugins"]);
const SOURCE_KEYS = new Set(["path", "format", "label", "enabled"]);
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GENERIC_SOURCE_NAMES = new Set(["plugins"]);

export type ParsedConfig = {
  sources?: DeclaredSource[];
  enabledPlugins: Record<string, boolean>;
  warnings: string[];
};

/** Validate a parsed config document. Problems become warnings; bad entries are dropped, never fatal. */
export function parseConfigDocument(raw: unknown): ParsedConfig {
  const warnings: string[] = [];
  if (!isRecord(raw)) {
    return { enabledPlugins: {}, warnings: ["config must be a JSON object; ignoring it"] };
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) warnings.push(`unknown config field "${key}" ignored`);
  }

  let sources: DeclaredSource[] | undefined;
  if (raw.sources !== undefined) {
    if (!Array.isArray(raw.sources)) {
      warnings.push(`"sources" must be an array; ignoring it`);
    } else {
      sources = [];
      raw.sources.forEach((entry, index) => {
        const parsed = parseSourceEntry(entry, index, warnings);
        if (parsed) sources!.push(parsed);
      });
    }
  }

  const enabledPlugins: Record<string, boolean> = {};
  if (raw.enabledPlugins !== undefined) {
    if (!isRecord(raw.enabledPlugins)) {
      warnings.push(`"enabledPlugins" must be an object; ignoring it`);
    } else {
      for (const [key, value] of Object.entries(raw.enabledPlugins)) {
        if (typeof value === "boolean") enabledPlugins[key] = value;
        else warnings.push(`enabledPlugins["${key}"] must be true or false; ignoring it`);
      }
    }
  }
  return { sources, enabledPlugins, warnings };
}

function parseSourceEntry(entry: unknown, index: number, warnings: string[]): DeclaredSource | undefined {
  const where = `sources[${index}]`;
  if (typeof entry === "string") {
    if (!entry.trim()) {
      warnings.push(`${where} is an empty path; skipping it`);
      return undefined;
    }
    return { path: entry, format: "auto", enabled: true };
  }
  if (!isRecord(entry)) {
    warnings.push(`${where} must be a path string or an object; skipping it`);
    return undefined;
  }
  for (const key of Object.keys(entry)) {
    if (!SOURCE_KEYS.has(key)) warnings.push(`${where}: unknown field "${key}" ignored`);
  }
  if (typeof entry.path !== "string" || !entry.path.trim()) {
    warnings.push(`${where}: "path" must be a non-empty string; skipping it`);
    return undefined;
  }
  let format: SourceFormat = "auto";
  if (entry.format !== undefined) {
    if (typeof entry.format !== "string" || !(SOURCE_FORMATS as readonly string[]).includes(entry.format)) {
      warnings.push(`${where}: "format" must be one of ${SOURCE_FORMATS.join(", ")}; skipping it`);
      return undefined;
    }
    format = entry.format as SourceFormat;
  }
  let label: string | undefined;
  if (entry.label !== undefined) {
    if (typeof entry.label === "string" && LABEL_PATTERN.test(entry.label)) {
      label = entry.label;
    } else {
      warnings.push(`${where}: "label" must match ${LABEL_PATTERN}; using a derived label instead`);
    }
  }
  let enabled = true;
  if (entry.enabled !== undefined) {
    if (typeof entry.enabled === "boolean") enabled = entry.enabled;
    else warnings.push(`${where}: "enabled" must be true or false; treating it as true`);
  }
  return { path: entry.path, format, ...(label ? { label } : {}), enabled };
}

export function loadConfigLayer(filePath: string, scope: ConfigScope): ConfigLayer {
  const base: ConfigLayer = { scope, path: filePath, exists: false, enabledPlugins: {} };
  if (!isFile(filePath)) return base;
  let raw: unknown;
  try {
    raw = readJsonFile<unknown>(filePath);
  } catch (cause) {
    const detail = cause instanceof JsonParseError ? cause.message : String(cause);
    warn(`ignoring ${filePath}: ${detail}`);
    return { ...base, exists: true, error: detail };
  }
  if (raw === undefined) return { ...base, exists: true };
  const parsed = parseConfigDocument(raw);
  for (const message of parsed.warnings) warn(`${filePath}: ${message}`);
  return { ...base, exists: true, sources: parsed.sources, enabledPlugins: parsed.enabledPlugins };
}

/**
 * Default Agent Plugins id suffix for a source path: its directory name, or the parent's
 * name when the directory is the conventional `plugins` (so `~/.agents/plugins` is `agents`
 * and `~/.codex/plugins` is `codex`). Reduced to `[a-z0-9._-]`.
 */
export function deriveSourceLabel(resolvedPath: string): string {
  const clean = path.resolve(resolvedPath);
  let name = path.basename(clean);
  if (GENERIC_SOURCE_NAMES.has(name.toLowerCase())) name = path.basename(path.dirname(clean)) || name;
  const slug = name
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug || "source";
}

function resolveDeclaredPath(declared: string, home: string, configFile: string): string {
  const expanded = expandUserPath(declared, home);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(path.dirname(configFile), expanded);
}

function toResolved(entry: DeclaredSource, layer: ConfigLayer, home: string): ResolvedSource {
  return {
    declaredPath: entry.path,
    path: resolveDeclaredPath(entry.path, home, layer.path),
    format: entry.format,
    label: entry.label ?? "",
    origin: layer.scope,
    configFile: layer.path,
    implicit: false,
  };
}

function uniqueLabels(sources: ResolvedSource[], explicit: Set<ResolvedSource>): void {
  const used = new Set<string>();
  const claim = (source: ResolvedSource, wanted: string): void => {
    let label = wanted;
    for (let n = 2; used.has(label); n += 1) label = `${wanted}-${n}`;
    if (label !== wanted) {
      warn(`source label "${wanted}" is used twice; "${source.path}" is labelled "${label}" (set "label" to pick one)`);
    }
    used.add(label);
    source.label = label;
  };
  for (const source of sources) {
    if (explicit.has(source)) claim(source, source.label);
  }
  for (const source of sources) {
    if (!explicit.has(source)) claim(source, deriveSourceLabel(source.path));
  }
}

/**
 * Merge the user and project config files into the effective source list.
 *
 * - No file declares `sources`: the single implicit source `~/.agents/plugins` (format `claude`),
 *   exactly what 0.1.x read.
 * - Otherwise project sources come first, then user sources, so on a duplicate plugin name the
 *   project's copy wins. A project entry with the same resolved path as a user entry replaces it
 *   (this is how a project turns a user source off: `{ "path": "...", "enabled": false }`).
 */
export function mergeConfigLayers(user: ConfigLayer, project: ConfigLayer, paths: RuntimePaths): EffectiveConfig {
  const exists = user.exists || project.exists;
  if (user.sources === undefined && project.sources === undefined) {
    const dir = defaultPluginsDir(paths);
    const implicit: ResolvedSource = {
      declaredPath: "~/.agents/plugins",
      path: dir,
      format: "claude",
      label: deriveSourceLabel(dir),
      origin: "default",
      implicit: true,
    };
    return { user, project, exists, sources: [implicit], disabledSources: [] };
  }

  const ordered: Array<{ source: ResolvedSource; enabled: boolean; explicit: boolean }> = [];
  const byPath = new Map<string, number>();
  for (const layer of [project, user]) {
    for (const entry of layer.sources ?? []) {
      const source = toResolved(entry, layer, paths.home);
      if (byPath.has(source.path)) continue;
      byPath.set(source.path, ordered.length);
      ordered.push({ source, enabled: entry.enabled, explicit: entry.label !== undefined });
    }
  }
  const all = ordered.map((item) => item.source);
  uniqueLabels(all, new Set(ordered.filter((item) => item.explicit).map((item) => item.source)));
  return {
    user,
    project,
    exists,
    sources: ordered.filter((item) => item.enabled).map((item) => item.source),
    disabledSources: ordered.filter((item) => !item.enabled).map((item) => item.source),
  };
}

export function loadConfig(paths: RuntimePaths): EffectiveConfig {
  const user = loadConfigLayer(userConfigPath(paths), "user");
  const project = loadConfigLayer(projectConfigPath(paths), "project");
  return mergeConfigLayers(user, project, paths);
}

/** Set one `enabledPlugins` key in an existing config file, leaving every other field as it was. */
export function writeConfigEnabled(filePath: string, pluginId: string, enabled: boolean): void {
  const raw = readJsonFile<unknown>(filePath);
  if (raw !== undefined && !isRecord(raw)) throw new Error(`${filePath} is not a JSON object`);
  const doc: Record<string, unknown> = raw ?? {};
  const current = isRecord(doc.enabledPlugins) ? doc.enabledPlugins : {};
  doc.enabledPlugins = { ...current, [pluginId]: enabled };
  writeJsonFile(filePath, doc);
}
