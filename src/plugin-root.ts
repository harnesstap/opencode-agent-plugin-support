import path from "node:path";
import { isDirectory } from "./fs-utils.js";
import {
  fallbackCachePath,
  resolveInstallPath,
  type InstalledPluginRecord,
  type PluginInstallation,
} from "./installed.js";
import { MarketplaceIndex, type LocatedMarketplace, type MarketplaceEntry } from "./marketplace.js";
import type { RuntimePaths } from "./paths.js";

/**
 * Where a plugin root was found, in the order Claude Code would find it:
 *
 * - `marketplace-in-place`: relative-path plugin of a `directory` / `file` marketplace.
 *   Claude loads these from the marketplace tree on every start, never from the cache,
 *   so a stale or swept cache copy must not shadow the live source.
 * - `installPath`: `installed_plugins.json` `installPath` (absolute, or relative to the plugins dir).
 * - `cache`: `cache/<marketplace>/<plugin>/<version>/`.
 * - `marketplace`: relative-path plugin of a git-hosted marketplace clone
 *   (`marketplaces/<name>/`), used when the cache copy is missing.
 */
export type ResolutionVia = "marketplace-in-place" | "installPath" | "cache" | "marketplace";

export type ResolutionAttempt = {
  step: ResolutionVia;
  path?: string;
  result: "used" | "missing" | "unavailable";
  detail?: string;
};

export type PluginRootResolution = {
  root?: string;
  via?: ResolutionVia;
  /** Marketplace entry for this plugin, when its marketplace could be read (even if the root came from the cache). */
  entry?: MarketplaceEntry;
  marketplace?: LocatedMarketplace;
  attempts: ResolutionAttempt[];
  /** Present when `root` is not. */
  reason?: string;
};

export function resolvePluginRoot(
  record: InstalledPluginRecord,
  install: PluginInstallation,
  paths: RuntimePaths,
  index: MarketplaceIndex = new MarketplaceIndex(paths),
): PluginRootResolution {
  const lookup = record.marketplace
    ? index.lookup(record.marketplace, record.name)
    : { reason: "plugin id has no @marketplace part" };
  const base = { entry: lookup.entry, marketplace: lookup.located };

  if (lookup.dir && lookup.located?.inPlace) {
    return {
      ...base,
      root: lookup.dir,
      via: "marketplace-in-place",
      attempts: [{ step: "marketplace-in-place", path: lookup.dir, result: "used" }],
    };
  }

  const attempts: ResolutionAttempt[] = [];
  const installPath = resolveInstallPath(record, install, paths);
  if (isDirectory(installPath)) {
    attempts.push({ step: "installPath", path: installPath, result: "used" });
    return { ...base, root: installPath, via: "installPath", attempts };
  }
  attempts.push({ step: "installPath", path: installPath, result: "missing", detail: install.installPath });

  const cachePath = fallbackCachePath(record, install, paths);
  if (isDirectory(cachePath)) {
    attempts.push({ step: "cache", path: cachePath, result: "used" });
    return { ...base, root: cachePath, via: "cache", attempts };
  }
  attempts.push({ step: "cache", path: cachePath, result: "missing" });

  if (lookup.dir) {
    attempts.push({ step: "marketplace", path: lookup.dir, result: "used" });
    return { ...base, root: lookup.dir, via: "marketplace", attempts };
  }
  attempts.push({ step: "marketplace", result: "unavailable", detail: lookup.reason });

  return { ...base, attempts, reason: describeAttempts(attempts) };
}

export function describeAttempts(attempts: ResolutionAttempt[]): string {
  return attempts
    .map((attempt) => {
      switch (attempt.step) {
        case "marketplace-in-place":
          return `marketplace source ${attempt.path ?? ""}`.trim();
        case "installPath":
          return `installPath missing (${attempt.path})`;
        case "cache":
          return `versioned cache missing (${attempt.path})`;
        case "marketplace":
          return attempt.path ? `marketplace source ${attempt.path}` : `marketplace source unavailable (${attempt.detail})`;
        default: {
          const _exhaustive: never = attempt.step;
          return _exhaustive;
        }
      }
    })
    .join("; ");
}

export function pickInstallation(
  record: InstalledPluginRecord,
  paths: RuntimePaths,
  index: MarketplaceIndex = new MarketplaceIndex(paths),
): PluginInstallation | undefined {
  const cwd = path.resolve(paths.cwd);
  const ranked = [...record.installations]
    // project/local installs only apply inside their own project (Claude semantics)
    .filter((install) => !isForeignProjectInstall(install, cwd))
    .sort((a, b) => rankScope(a, cwd) - rankScope(b, cwd));
  // prefer the best-ranked entry whose directory actually exists
  return ranked.find((install) => resolvePluginRoot(record, install, paths, index).root) ?? ranked[0];
}

function isForeignProjectInstall(install: PluginInstallation, cwd: string): boolean {
  if (install.scope !== "project" && install.scope !== "local") return false;
  if (!install.projectPath) return false;
  return path.resolve(install.projectPath) !== cwd;
}

function rankScope(install: PluginInstallation, cwd: string): number {
  if (install.scope === "local" && install.projectPath && path.resolve(install.projectPath) === cwd) return 0;
  if (install.scope === "project" && install.projectPath && path.resolve(install.projectPath) === cwd) return 1;
  if (install.scope === "local") return 2;
  if (install.scope === "project") return 3;
  if (install.scope === "user") return 4;
  if (install.scope === "managed") return 5;
  return 6;
}

