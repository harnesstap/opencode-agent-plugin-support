import fs from "node:fs";
import path from "node:path";
import {
  loadAgentPluginsManifest,
  sniffAgentPluginsManifest,
  type AgentPluginsManifest,
  type ManifestSniff,
} from "./ap-manifest.js";
import type { ResolvedSource } from "./config.js";
import { Diagnostics } from "./diagnostics.js";
import { isPluginEnabled, resolvePluginEnablement, type PluginsActivation } from "./enablement.js";
import { loadInstalledPlugins, type InstalledPluginRecord } from "./installed.js";
import { applyMarketplaceEntry } from "./marketplace-entry.js";
import { MarketplaceIndex } from "./marketplace.js";
import { findPluginRoot, loadManifestFromRoot, type PluginManifest } from "./manifest.js";
import { debug, warn } from "./log.js";
import type { RuntimePaths } from "./paths.js";
import { hydrateAgentPlugin, hydrateClaudePlugin } from "./plugin-build.js";
import { describeAttempts, pickInstallation, resolvePluginRoot } from "./plugin-root.js";
import type { InstalledPluginStatus, PluginOrigin } from "./plugin-types.js";
import { kindOf, realpathOrUndefined } from "./safe-path.js";

/** Directory names that belong to a plugin store, never to a plugin (Agent Plugins sources skip them). */
export const RESERVED_SOURCE_DIRS = new Set(["cache", "data", "marketplaces", "repos"]);

export type SourceContext = {
  paths: RuntimePaths;
  activation: PluginsActivation;
  sourceIndex: number;
};

export type SourceStatus = {
  source: ResolvedSource;
  /** False when the configured path is not a directory. */
  exists: boolean;
  pluginCount: number;
  /** Why the source yielded nothing, when that is not obvious. */
  note?: string;
};

export type SourceResult = {
  status: SourceStatus;
  statuses: InstalledPluginStatus[];
  installed: InstalledPluginRecord[];
};

function originOf(source: ResolvedSource): PluginOrigin {
  return { path: source.path, label: source.label, format: source.format };
}

function hasClaudeManifest(root: string): boolean {
  return kindOf(path.join(root, ".claude-plugin", "plugin.json")) === "file";
}

export function discoverSource(source: ResolvedSource, ctx: SourceContext): SourceResult {
  const result: SourceResult = {
    status: { source, exists: kindOf(source.path) === "directory", pluginCount: 0 },
    statuses: [],
    installed: [],
  };
  if (!result.status.exists) {
    result.status.note = "path is not a directory";
    if (!source.implicit) warn(`source "${source.declaredPath}" (${source.path}) is not a directory; skipping it`);
    return result;
  }
  if (source.format === "claude" || source.format === "auto") {
    const claude = discoverClaudeRegistry(source, ctx);
    result.statuses.push(...claude.statuses);
    result.installed.push(...claude.installed);
  }
  if (source.format === "agent-plugins" || source.format === "auto") {
    result.statuses.push(...discoverPackageDirs(source, ctx));
  }
  result.status.pluginCount = result.statuses.length;
  return result;
}

/** Claude registry tree (`installed_plugins.json`, `known_marketplaces.json`, `cache/`, `marketplaces/`). */
function discoverClaudeRegistry(
  source: ResolvedSource,
  ctx: SourceContext,
): { statuses: InstalledPluginStatus[]; installed: InstalledPluginRecord[] } {
  const { activation } = ctx;
  const storePaths: RuntimePaths = { ...ctx.paths, storeDir: source.path };
  const installed = loadInstalledPlugins(storePaths);
  const marketplaces = new MarketplaceIndex(storePaths, activation.extraKnownMarketplaces);
  const origin = originOf(source);
  const statuses: InstalledPluginStatus[] = [];

  for (const record of installed) {
    const decision = resolvePluginEnablement(activation, record.id);
    const enabled = isPluginEnabled(activation, record.id);
    const statusBase = {
      id: record.id,
      source: decision.source,
      sourceFile: decision.file,
      sourceKey: decision.key,
      origin,
      sourceIndex: ctx.sourceIndex,
    };
    const install = pickInstallation(record, storePaths, marketplaces);
    if (!install) {
      statuses.push({ ...statusBase, enabled: false, reason: "no installation entry" });
      continue;
    }
    const resolved = resolvePluginRoot(record, install, storePaths, marketplaces);
    const resolution = { root: resolved.root, via: resolved.via, attempts: resolved.attempts };
    if (!resolved.root || !resolved.via) {
      const reason = `plugin root unresolved: ${resolved.reason ?? describeAttempts(resolved.attempts)}`;
      (enabled ? warn : debug)(`cannot resolve plugin "${record.id}": ${reason}`);
      statuses.push({ ...statusBase, enabled: false, reason, resolution });
      continue;
    }
    debug(`resolved plugin "${record.id}" via ${resolved.via}: ${resolved.root}`);
    // Marketplace sources are exact plugin directories; install/cache dirs may nest the plugin one level down.
    const pluginRoot =
      resolved.via === "installPath" || resolved.via === "cache" ? findPluginRoot(resolved.root) : resolved.root;
    if (!pluginRoot) {
      statuses.push({ ...statusBase, enabled: false, reason: "could not find plugin root", resolution });
      continue;
    }
    let manifest: PluginManifest;
    try {
      const loaded = loadManifestFromRoot(pluginRoot, record.name);
      manifest = applyMarketplaceEntry(loaded, resolved.entry);
    } catch (cause) {
      const reason = `malformed plugin.json: ${cause instanceof Error ? cause.message : cause}`;
      warn(`skipping plugin "${record.id}": ${reason}`);
      statuses.push({ ...statusBase, enabled: false, reason, resolution });
      continue;
    }
    if (!enabled) {
      statuses.push({ ...statusBase, enabled: false, reason: "disabled", resolution });
      continue;
    }
    try {
      const diag = new Diagnostics(record.id);
      const ap = sniffAgentPluginsManifest(pluginRoot);
      const agentOnly = source.format === "auto" && ap.kind === "valid" && !hasClaudeManifest(pluginRoot);
      let plugin;
      if (agentOnly && ap.kind === "valid") {
        const realRoot = realpathOrUndefined(pluginRoot) ?? pluginRoot;
        plugin = hydrateAgentPlugin(
          { id: record.id, label: record.marketplace, realRoot, manifest: ap.manifest, notes: ap.notes },
          ctx.paths,
          diag,
          origin,
        );
      } else {
        plugin = hydrateClaudePlugin(record, manifest, pluginRoot, ctx.paths, diag, ap, origin);
      }
      statuses.push({
        ...statusBase,
        enabled: true,
        plugin,
        resolution,
        format: plugin.format,
        dualManifest: plugin.dualManifest,
        diagnostics: plugin.diagnostics,
      });
    } catch (cause) {
      const reason = `failed to load: ${cause instanceof Error ? cause.message : cause}`;
      warn(`skipping plugin "${record.id}": ${reason}`);
      statuses.push({ ...statusBase, enabled: false, reason, resolution });
    }
  }
  return { statuses, installed };
}

type PackageDecision =
  | { kind: "agent-plugins"; manifest: AgentPluginsManifest; notes: string[] }
  | { kind: "claude"; ap: ManifestSniff }
  | { kind: "rejected"; reason: string }
  | { kind: "skip"; why: string };

/**
 * What does the plugin directory at `root` contain, as seen from a source of this format?
 *
 * - `agent-plugins` sources only know Agent Plugins packages: the root `plugin.json` decides.
 * - `auto` sources look at the manifests: a `.claude-plugin/plugin.json` makes it a Claude plugin
 *   (a valid Agent Plugins manifest next to it adds its `mcp.json`); otherwise a root
 *   `plugin.json` that declares an agent-plugins.org `$schema` makes it an Agent Plugins package.
 */
function decidePackage(root: string, format: ResolvedSource["format"]): PackageDecision {
  if (format === "agent-plugins") {
    if (kindOf(path.join(root, "plugin.json")) === "missing") return { kind: "skip", why: "no plugin.json" };
    const parsed = loadAgentPluginsManifest(root);
    return parsed.ok
      ? { kind: "agent-plugins", manifest: parsed.manifest, notes: parsed.notes }
      : { kind: "rejected", reason: parsed.reason };
  }
  const ap = sniffAgentPluginsManifest(root);
  if (hasClaudeManifest(root)) return { kind: "claude", ap };
  if (ap.kind === "valid") return { kind: "agent-plugins", manifest: ap.manifest, notes: ap.notes };
  if (ap.kind === "invalid") return { kind: "rejected", reason: ap.reason };
  return { kind: "skip", why: "no recognized manifest" };
}

/** Plugin directories that are immediate children of an Agent Plugins / auto source. */
function discoverPackageDirs(source: ResolvedSource, ctx: SourceContext): InstalledPluginStatus[] {
  const { activation } = ctx;
  const origin = originOf(source);
  const statuses: InstalledPluginStatus[] = [];
  const seenIds = new Set<string>();
  let entries: string[];
  try {
    entries = fs.readdirSync(source.path).sort();
  } catch (cause) {
    warn(`cannot read source ${source.path}: ${cause instanceof Error ? cause.message : cause}`);
    return statuses;
  }

  for (const entry of entries) {
    if (RESERVED_SOURCE_DIRS.has(entry) || entry.startsWith(".")) continue;
    const dir = path.join(source.path, entry);
    if (kindOf(dir) !== "directory") continue;
    const realRoot = realpathOrUndefined(dir);
    if (!realRoot) continue;
    const decision = decidePackage(realRoot, source.format);
    if (decision.kind === "skip") {
      debug(`source ${source.path}: ignoring ${entry} (${decision.why})`);
      continue;
    }
    const resolution = { root: realRoot, attempts: [] };
    const base = { origin, sourceIndex: ctx.sourceIndex, resolution };
    const rejectedId = `${entry}@${source.label}`;
    const reject = (id: string, reason: string, loud: boolean): void => {
      const enablement = resolvePluginEnablement(activation, id);
      (loud ? warn : debug)(`skipping plugin "${id}": ${reason}`);
      statuses.push({
        ...base,
        id,
        source: enablement.source,
        sourceFile: enablement.file,
        sourceKey: enablement.key,
        enabled: false,
        reason,
      });
    };

    if (decision.kind === "rejected") {
      reject(rejectedId, `rejected: ${decision.reason}`, isPluginEnabled(activation, rejectedId));
      continue;
    }

    let name: string;
    let claudeManifest: PluginManifest | undefined;
    if (decision.kind === "agent-plugins") {
      name = decision.manifest.name;
    } else {
      try {
        claudeManifest = loadManifestFromRoot(realRoot, entry).manifest;
      } catch (cause) {
        reject(rejectedId, `malformed plugin.json: ${cause instanceof Error ? cause.message : cause}`, true);
        continue;
      }
      name = claudeManifest.name;
    }
    const id = `${name}@${source.label}`;
    if (seenIds.has(id)) {
      reject(id, `duplicate plugin "${id}" in this source (${entry}); keeping the first`, true);
      continue;
    }
    seenIds.add(id);

    const enablement = resolvePluginEnablement(activation, id);
    const common = {
      ...base,
      id,
      source: enablement.source,
      sourceFile: enablement.file,
      sourceKey: enablement.key,
    };
    if (!enablement.enabled) {
      statuses.push({ ...common, enabled: false, reason: "disabled" });
      continue;
    }
    try {
      const diag = new Diagnostics(id);
      const plugin =
        decision.kind === "agent-plugins"
          ? hydrateAgentPlugin({ id, label: source.label, realRoot, manifest: decision.manifest, notes: decision.notes }, ctx.paths, diag, origin)
          : hydrateClaudePlugin(
              {
                id,
                name,
                marketplace: source.label,
                installations: [{ installPath: realRoot, isLocal: true, scope: "user" }],
              },
              claudeManifest!,
              realRoot,
              ctx.paths,
              diag,
              decision.ap,
              origin,
            );
      statuses.push({
        ...common,
        enabled: true,
        plugin,
        format: plugin.format,
        dualManifest: plugin.dualManifest,
        diagnostics: plugin.diagnostics,
      });
    } catch (cause) {
      reject(id, `failed to load: ${cause instanceof Error ? cause.message : cause}`, true);
    }
  }
  return statuses;
}
