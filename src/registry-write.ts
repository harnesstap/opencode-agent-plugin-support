import { writeJsonFile } from "./fs-utils.js";
import { parseInstalledPluginsDatabase, type InstalledPluginRecord, type PluginInstallation } from "./installed.js";
import { installedPluginsPath, knownMarketplacesPath, type RuntimePaths } from "./paths.js";
import { readJsonFile } from "./fs-utils.js";

export function saveInstalledPlugins(paths: RuntimePaths, records: InstalledPluginRecord[]): void {
  const plugins: Record<string, PluginInstallation[]> = {};
  for (const record of records) {
    plugins[record.id] = record.installations;
  }
  writeJsonFile(installedPluginsPath(paths), { version: 2, plugins });
}

export function upsertInstallation(
  paths: RuntimePaths,
  id: string,
  name: string,
  marketplace: string | undefined,
  installation: PluginInstallation,
): void {
  const existing = parseInstalledPluginsDatabase(readJsonFile<unknown>(installedPluginsPath(paths)));
  const found = existing.find((record) => record.id === id);
  if (found) {
    const idx = found.installations.findIndex(
      (item) => (item.scope ?? "user") === (installation.scope ?? "user"),
    );
    if (idx >= 0) found.installations[idx] = installation;
    else found.installations.push(installation);
  } else {
    existing.push({ id, name, marketplace, installations: [installation] });
  }
  saveInstalledPlugins(paths, existing);
}

export function saveKnownMarketplace(
  paths: RuntimePaths,
  name: string,
  source: unknown,
): void {
  const current = readJsonFile<Record<string, unknown>>(knownMarketplacesPath(paths)) ?? {};
  current[name] = {
    source,
    lastUpdated: new Date().toISOString(),
  };
  writeJsonFile(knownMarketplacesPath(paths), current);
}
