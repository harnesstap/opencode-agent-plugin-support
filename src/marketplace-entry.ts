import path from "node:path";
import type { MarketplaceEntry } from "./marketplace.js";
import { warn } from "./log.js";
import { asPathList, isRecord, type LoadedManifest, type PluginManifest } from "./manifest.js";

/** Component fields that a marketplace entry can add to (or conflict with) `plugin.json`. */
const COMPONENT_FIELDS = ["commands", "agents", "skills", "hooks"] as const;

/** Entry keys that describe the catalog row, not the plugin. */
const ENTRY_ONLY_FIELDS = new Set([
  "source",
  "strict",
  "category",
  "tags",
  "relevance",
  "metadata",
  "headers",
  "headersHelper",
]);

/** Display fields where the entry overrides `plugin.json`. */
const ENTRY_WINS_FIELDS = ["displayName", "description", "author", "homepage", "repository", "license", "keywords", "defaultEnabled"];

function isMarketplaceRootSource(source: unknown): boolean {
  return typeof source === "string" && path.posix.normalize(source.trim()) === ".";
}

function mergePathList(base: unknown, extra: unknown): string[] {
  return [...new Set([...asPathList(base), ...asPathList(extra)])];
}

function mergeCommands(base: unknown, extra: unknown): unknown {
  if (isRecord(base) && isRecord(extra)) return { ...base, ...extra };
  if (!isRecord(base) && !isRecord(extra)) return mergePathList(base, extra);
  warn("marketplace entry `commands` cannot be combined with plugin.json `commands` (path list vs inline map); keeping plugin.json");
  return base;
}

function mergeHooks(base: unknown, extra: unknown): unknown {
  const pieces = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
  return [...pieces(base), ...pieces(extra)];
}

function mergeComponent(field: (typeof COMPONENT_FIELDS)[number], base: unknown, extra: unknown): unknown {
  if (extra === undefined) return base;
  if (base === undefined) return extra;
  switch (field) {
    case "commands":
      return mergeCommands(base, extra);
    case "hooks":
      return mergeHooks(base, extra);
    case "agents":
    case "skills":
      return mergePathList(base, extra);
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

/**
 * Claude Code treats the marketplace entry as the plugin manifest when the plugin has no
 * `plugin.json`, and otherwise as a supplement controlled by `strict` (default true).
 * Throws on the `strict: false` conflict, which Claude reports as
 * "Plugin has conflicting manifests".
 */
export function applyMarketplaceEntry(loaded: LoadedManifest, entry: MarketplaceEntry | undefined): PluginManifest {
  if (!entry) return loaded.manifest;
  const manifest: PluginManifest = { ...loaded.manifest };
  const fields: Record<string, unknown> = manifest;

  if (!loaded.manifestPath) {
    for (const [key, value] of Object.entries(entry)) {
      if (ENTRY_ONLY_FIELDS.has(key) || key === "name") continue;
      fields[key] = value;
    }
    markExclusiveSkills(manifest, entry);
    return manifest;
  }

  const declared = COMPONENT_FIELDS.filter((field) => entry[field] !== undefined);
  if (entry.strict === false) {
    if (declared.length > 0) {
      throw new Error(
        `Plugin has conflicting manifests: both plugin.json and marketplace entry specify components (${declared.join(", ")})`,
      );
    }
  } else {
    for (const field of declared) fields[field] = mergeComponent(field, fields[field], entry[field]);
    markExclusiveSkills(manifest, entry);
  }

  for (const key of ENTRY_WINS_FIELDS) {
    if (entry[key] !== undefined) fields[key] = entry[key];
  }
  if (manifest.version === undefined && typeof entry.version === "string") manifest.version = entry.version;
  return manifest;
}

/** An entry at the marketplace root that lists `skills` replaces the default `skills/` scan. */
function markExclusiveSkills(manifest: PluginManifest, entry: MarketplaceEntry): void {
  if (entry.skills !== undefined && isMarketplaceRootSource(entry.source)) {
    manifest.skills = asPathList(entry.skills);
    manifest.replaceDefaultSkills = true;
  }
}
