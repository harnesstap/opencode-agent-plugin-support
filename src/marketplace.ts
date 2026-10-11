import path from "node:path";
import { isDirectory, isFile, JsonParseError, readJsonFile } from "./fs-utils.js";
import { isRecord } from "./manifest.js";
import { warn } from "./log.js";
import { expandUserPath, knownMarketplacesPath, marketplacesDir, pluginsDir, type RuntimePaths } from "./paths.js";

export type MarketplaceEntry = Record<string, unknown> & { name: string };

export type KnownMarketplace = {
  name: string;
  source?: Record<string, unknown>;
  installLocation?: string;
};

export type MarketplaceCandidateKind =
  | "installLocation"
  | "source-path"
  | "marketplaces-dir"
  | "marketplaces-file"
  | "marketplaces-repo-dir"
  | "settings-source";

export type LocatedMarketplace = {
  name: string;
  /** Directory that contains `.claude-plugin/`; relative plugin sources resolve from here. */
  root: string;
  /** The `marketplace.json` that was read. */
  file: string;
  kind: MarketplaceCandidateKind;
  /**
   * `directory` / `file` marketplaces are read where the user keeps them. Claude loads
   * their relative-path plugins from that tree on every start instead of from the cache.
   */
  inPlace: boolean;
};

export type MarketplaceLookup = {
  located?: LocatedMarketplace;
  entry?: MarketplaceEntry;
  /** Plugin directory derived from the entry's `source`, only when it exists on disk. */
  dir?: string;
  /** Present whenever `dir` is not. */
  reason?: string;
};

const MARKETPLACE_FILE = path.join(".claude-plugin", "marketplace.json");
const IN_PLACE_SOURCES = new Set(["directory", "file"]);

/** Extra marketplace sources declared in `plugins.json` (`extraKnownMarketplaces`). */
export type ExtraMarketplaceSources = Record<string, { source?: unknown } | undefined>;

export function loadKnownMarketplaces(paths: RuntimePaths): Map<string, KnownMarketplace> {
  const filePath = knownMarketplacesPath(paths);
  const out = new Map<string, KnownMarketplace>();
  let raw: unknown;
  try {
    raw = readJsonFile<unknown>(filePath);
  } catch (cause) {
    const detail = cause instanceof JsonParseError ? cause.message : String(cause);
    warn(`skipping ${filePath}: ${detail}`);
    return out;
  }
  if (!isRecord(raw)) return out;
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    out.set(name, {
      name,
      source: isRecord(value.source) ? value.source : undefined,
      installLocation: typeof value.installLocation === "string" ? value.installLocation : undefined,
    });
  }
  return out;
}

type Candidate = { kind: MarketplaceCandidateKind; target: string; inPlace: boolean; sourcePath?: string };

function sourcePathOf(source: Record<string, unknown> | undefined): string | undefined {
  if (!source) return undefined;
  const kind = source.source;
  if (typeof kind !== "string" || !IN_PLACE_SOURCES.has(kind)) return undefined;
  return typeof source.path === "string" ? source.path : undefined;
}

function repoDirName(source: Record<string, unknown> | undefined): string | undefined {
  if (!source || typeof source.repo !== "string") return undefined;
  const slug = source.repo.replace(/[\\/]+/g, "-");
  return slug || undefined;
}

export class MarketplaceIndex {
  private readonly known: Map<string, KnownMarketplace>;
  private readonly located = new Map<string, { value?: LocatedMarketplace; reason: string }>();
  private readonly manifests = new Map<string, { plugins?: MarketplaceEntry[]; pluginRoot?: string; reason?: string }>();

  constructor(
    private readonly paths: RuntimePaths,
    private readonly extra: ExtraMarketplaceSources = {},
  ) {
    this.known = loadKnownMarketplaces(paths);
  }

  lookup(marketplace: string, pluginName: string): MarketplaceLookup {
    const found = this.locate(marketplace);
    if (!found.value) return { reason: found.reason };
    const located = found.value;
    const manifest = this.readManifest(located);
    if (!manifest.plugins) return { located, reason: manifest.reason ?? "marketplace.json has no plugins" };
    const entry = manifest.plugins.find((item) => item.name === pluginName);
    if (!entry) {
      return { located, reason: `no plugin named "${pluginName}" in ${located.file}` };
    }
    const source = resolveEntrySource(located.root, entry.source, manifest.pluginRoot);
    if (!source.dir) return { located, entry, reason: source.reason };
    return { located, entry, dir: source.dir };
  }

  private candidates(marketplace: string): Candidate[] {
    const known = this.known.get(marketplace);
    const out: Candidate[] = [];
    const inPlaceKnown = Boolean(known?.source?.source && IN_PLACE_SOURCES.has(String(known.source.source)));
    if (known?.installLocation) {
      out.push({
        kind: "installLocation",
        target: this.resolveStorePath(known.installLocation),
        inPlace: inPlaceKnown,
      });
    }
    const knownPath = sourcePathOf(known?.source);
    if (knownPath) {
      out.push({ kind: "source-path", target: this.resolveStorePath(knownPath), inPlace: true });
    }
    const clones = marketplacesDir(this.paths);
    out.push({ kind: "marketplaces-dir", target: path.join(clones, marketplace), inPlace: false });
    out.push({ kind: "marketplaces-file", target: path.join(clones, `${marketplace}.json`), inPlace: false });
    const repoDir = repoDirName(known?.source);
    if (repoDir) out.push({ kind: "marketplaces-repo-dir", target: path.join(clones, repoDir), inPlace: false });
    const extraSource = this.extra[marketplace]?.source;
    const extraPath = sourcePathOf(isRecord(extraSource) ? extraSource : undefined);
    if (extraPath) out.push({ kind: "settings-source", target: this.resolveStorePath(extraPath), inPlace: true });
    return out;
  }

  private resolveStorePath(value: string): string {
    const expanded = expandUserPath(value, this.paths.home);
    return path.isAbsolute(expanded) ? expanded : path.resolve(pluginsDir(this.paths), expanded);
  }

  private locate(marketplace: string): { value?: LocatedMarketplace; reason: string } {
    const cached = this.located.get(marketplace);
    if (cached) return cached;
    const tried: string[] = [];
    let result: { value?: LocatedMarketplace; reason: string } | undefined;
    for (const candidate of this.candidates(marketplace)) {
      const file = marketplaceFileFor(candidate.target);
      if (!file) {
        tried.push(`${candidate.target} (no .claude-plugin/marketplace.json)`);
        continue;
      }
      result = {
        value: { name: marketplace, root: file.root, file: file.file, kind: candidate.kind, inPlace: candidate.inPlace },
        reason: "",
      };
      break;
    }
    if (!result) {
      const known = this.known.has(marketplace)
        ? `marketplace "${marketplace}" is in known_marketplaces.json but its files were not found`
        : `marketplace "${marketplace}" is not in known_marketplaces.json and has no marketplaces/ copy`;
      result = { reason: tried.length ? `${known} (tried ${tried.join("; ")})` : known };
    }
    this.located.set(marketplace, result);
    return result;
  }

  private readManifest(located: LocatedMarketplace) {
    const cached = this.manifests.get(located.file);
    if (cached) return cached;
    let result: { plugins?: MarketplaceEntry[]; pluginRoot?: string; reason?: string };
    try {
      const raw = readJsonFile<unknown>(located.file);
      if (!isRecord(raw) || !Array.isArray(raw.plugins)) {
        result = { reason: `${located.file} has no "plugins" array` };
      } else {
        const plugins = raw.plugins.filter(
          (item): item is MarketplaceEntry => isRecord(item) && typeof item.name === "string" && item.name !== "",
        );
        const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
        const pluginRoot = typeof metadata?.pluginRoot === "string" ? metadata.pluginRoot : undefined;
        result = { plugins, pluginRoot };
      }
    } catch (cause) {
      const detail = cause instanceof JsonParseError ? cause.message : String(cause);
      result = { reason: detail };
    }
    this.manifests.set(located.file, result);
    return result;
  }
}

/**
 * A marketplace location is either its root directory or the `marketplace.json` file
 * itself (`file` / `url` sources). The root is the directory that holds `.claude-plugin/`.
 */
function marketplaceFileFor(target: string): { root: string; file: string } | undefined {
  if (isDirectory(target)) {
    const file = path.join(target, MARKETPLACE_FILE);
    return isFile(file) ? { root: target, file } : undefined;
  }
  if (!isFile(target)) return undefined;
  const dir = path.dirname(target);
  const root = path.basename(dir) === ".claude-plugin" ? path.dirname(dir) : dir;
  return { root, file: target };
}

type SourceResolution = { dir: string; reason?: undefined } | { dir?: undefined; reason: string };

function describeRemoteSource(source: Record<string, unknown>): string {
  const type = typeof source.source === "string" ? source.source : "unknown";
  const target = [source.repo, source.url, source.package, source.path]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
  return target ? `${type} ${target}` : type;
}

/**
 * Relative sources resolve from the marketplace root (or `metadata.pluginRoot` for bare
 * names). Object sources (github, git-subdir, npm, ...) only ever live in Claude's cache,
 * and fetching them is Claude's job, so they cannot be resolved without that cache.
 */
export function resolveEntrySource(
  marketplaceRoot: string,
  source: unknown,
  metadataPluginRoot?: string,
): SourceResolution {
  if (typeof source === "string") return resolveRelativeSource(marketplaceRoot, source, metadataPluginRoot);
  if (isRecord(source) && typeof source.source === "string") {
    return {
      reason: `plugin source is remote (${describeRemoteSource(source)}); only Claude Code's cache holds a copy, so run /plugin or /reload-plugins in Claude Code to fetch it`,
    };
  }
  return { reason: "marketplace entry has no usable source" };
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).includes("..");
}

function resolveRelativeSource(root: string, source: string, metadataPluginRoot?: string): SourceResolution {
  const trimmed = source.trim();
  if (!trimmed) return { reason: "marketplace entry source is empty" };
  if (hasParentSegment(trimmed)) return { reason: `source path contains "..": ${source}` };
  if (process.platform !== "win32" && trimmed.slice(2).includes("\\")) {
    return { reason: `source path contains a backslash: ${source}` };
  }
  let relative: string;
  if (trimmed === "." || trimmed.startsWith("./")) {
    relative = trimmed;
  } else if (!trimmed.includes("/") && metadataPluginRoot) {
    if (hasParentSegment(metadataPluginRoot) || path.isAbsolute(metadataPluginRoot)) {
      return { reason: `metadata.pluginRoot must be a relative path inside the marketplace: ${metadataPluginRoot}` };
    }
    relative = path.join(metadataPluginRoot, trimmed);
  } else {
    return { reason: `relative source must start with "./" (or be a bare name under metadata.pluginRoot): ${source}` };
  }
  const dir = path.resolve(root, relative);
  const inside = path.relative(root, dir);
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    return { reason: `source path escapes the marketplace: ${source}` };
  }
  if (!isDirectory(dir)) return { reason: `source path does not exist: ${dir}` };
  return { dir };
}
