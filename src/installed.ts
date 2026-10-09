import path from "node:path";
import { isDirectory, readJsonFile } from "./fs-utils.js";
import { expandUserPath, installedPluginsPath, pluginsDir, type RuntimePaths, versionedCachePath } from "./paths.js";

export type PluginScope = "user" | "project" | "local" | "managed" | "flag";

export type PluginInstallation = {
  scope?: PluginScope;
  installPath: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
  gitCommitSha?: string;
  isLocal?: boolean;
  projectPath?: string;
};

export type InstalledPluginRecord = {
  id: string;
  name: string;
  marketplace?: string;
  installations: PluginInstallation[];
};

type InstalledV1 = {
  version?: 1;
  plugins: Record<string, PluginInstallation>;
};

type InstalledV2 = {
  version: 2;
  plugins: Record<string, PluginInstallation[]>;
};

type InstalledV3Entry = PluginInstallation & {
  plugin?: string;
  id?: string;
  name?: string;
  marketplace?: string;
};

function splitId(id: string): { name: string; marketplace?: string } {
  const at = id.lastIndexOf("@");
  if (at <= 0) return { name: id };
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) };
}

function asInstallation(value: unknown): PluginInstallation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  const installPath = rec.installPath ?? rec.install_path ?? rec.path;
  if (typeof installPath !== "string" || !installPath) return undefined;
  return {
    scope: typeof rec.scope === "string" ? (rec.scope as PluginScope) : undefined,
    installPath,
    version: typeof rec.version === "string" ? rec.version : undefined,
    installedAt: typeof rec.installedAt === "string" ? rec.installedAt : undefined,
    lastUpdated: typeof rec.lastUpdated === "string" ? rec.lastUpdated : undefined,
    gitCommitSha: typeof rec.gitCommitSha === "string" ? rec.gitCommitSha : undefined,
    isLocal: typeof rec.isLocal === "boolean" ? rec.isLocal : undefined,
    projectPath: typeof rec.projectPath === "string" ? rec.projectPath : undefined,
  };
}

export function parseInstalledPluginsDatabase(raw: unknown): InstalledPluginRecord[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const out: InstalledPluginRecord[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as InstalledV3Entry;
      const id = rec.id ?? rec.plugin ?? (rec.name && rec.marketplace ? `${rec.name}@${rec.marketplace}` : rec.name);
      const install = asInstallation(entry);
      if (!id || !install) continue;
      const { name, marketplace } = splitId(id);
      out.push({ id, name, marketplace, installations: [install] });
    }
    return mergeRecords(out);
  }
  if (typeof raw !== "object") return [];
  const doc = raw as InstalledV1 | InstalledV2 | { plugins?: unknown };
  const plugins = doc.plugins;
  if (!plugins || typeof plugins !== "object") return [];
  const out: InstalledPluginRecord[] = [];
  for (const [id, value] of Object.entries(plugins as Record<string, unknown>)) {
    const { name, marketplace } = splitId(id);
    const installations = Array.isArray(value)
      ? value.map(asInstallation).filter((item): item is PluginInstallation => Boolean(item))
      : [asInstallation(value)].filter((item): item is PluginInstallation => Boolean(item));
    if (installations.length === 0) continue;
    out.push({ id, name, marketplace, installations });
  }
  return out;
}

function mergeRecords(records: InstalledPluginRecord[]): InstalledPluginRecord[] {
  const map = new Map<string, InstalledPluginRecord>();
  for (const record of records) {
    const existing = map.get(record.id);
    if (!existing) {
      map.set(record.id, { ...record, installations: [...record.installations] });
      continue;
    }
    existing.installations.push(...record.installations);
  }
  return [...map.values()];
}

export function loadInstalledPlugins(paths: RuntimePaths): InstalledPluginRecord[] {
  const raw = readJsonFile<unknown>(installedPluginsPath(paths));
  return parseInstalledPluginsDatabase(raw);
}

export function pickInstallation(
  record: InstalledPluginRecord,
  paths: RuntimePaths,
): PluginInstallation | undefined {
  const cwd = path.resolve(paths.cwd);
  const ranked = [...record.installations]
    // project/local installs only apply inside their own project (Claude semantics)
    .filter((install) => !isForeignProjectInstall(install, cwd))
    .sort((a, b) => rankScope(a, cwd) - rankScope(b, cwd));
  // prefer the best-ranked entry whose directory actually exists
  return ranked.find((install) => resolveExistingInstallPath(record, install, paths)) ?? ranked[0];
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

export function resolveInstallPath(
  record: InstalledPluginRecord,
  install: PluginInstallation,
  paths: RuntimePaths,
): string {
  const expanded = expandUserPath(install.installPath, paths.home);
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(pluginsDir(paths), expanded);
}

export function fallbackCachePath(record: InstalledPluginRecord, install: PluginInstallation, paths: RuntimePaths): string {
  const marketplace = record.marketplace ?? "local";
  const version = install.version ?? "latest";
  return versionedCachePath(paths, marketplace, record.name, version);
}

export function resolveExistingInstallPath(
  record: InstalledPluginRecord,
  install: PluginInstallation,
  paths: RuntimePaths,
): string | undefined {
  const primary = resolveInstallPath(record, install, paths);
  if (isDirectory(primary)) return primary;
  const fallback = fallbackCachePath(record, install, paths);
  if (isDirectory(fallback)) return fallback;
  return isDirectory(primary) ? primary : undefined;
}
