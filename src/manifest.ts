import fs from "node:fs";
import path from "node:path";
import { isDirectory, isFile, readJsonFile } from "./fs-utils.js";

export type PluginAuthor = {
  name: string;
  email?: string;
  url?: string;
};

export type InlineCommand = {
  source?: string;
  content?: string;
  description?: string;
  argumentHint?: string;
  model?: string;
  allowedTools?: string[];
};

export type PluginManifest = {
  name: string;
  displayName?: string;
  version?: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  defaultEnabled?: boolean;
  dependencies?: unknown;
  skills?: string | string[];
  commands?: string | string[] | Record<string, InlineCommand>;
  agents?: string | string[];
  hooks?: unknown;
  mcpServers?: unknown;
  lspServers?: unknown;
  settings?: Record<string, unknown>;
  userConfig?: Record<string, unknown>;
  [key: string]: unknown;
};

export type LoadedManifest = {
  manifest: PluginManifest;
  pluginRoot: string;
  manifestPath?: string;
};

export function findPluginRoot(start: string): string | undefined {
  const candidates = [start];
  try {
    for (const name of fs.readdirSync(start)) {
      candidates.push(path.join(start, name));
    }
  } catch {
    return undefined;
  }
  for (const dir of candidates) {
    if (isFile(path.join(dir, ".claude-plugin", "plugin.json"))) return dir;
  }
  if (isDirectory(start)) return start;
  return undefined;
}

export function loadManifestFromRoot(pluginRoot: string, fallbackName: string): LoadedManifest {
  const manifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  if (!isFile(manifestPath)) {
    return {
      pluginRoot,
      manifest: { name: fallbackName, defaultEnabled: true },
    };
  }
  const raw = readJsonFile<Partial<PluginManifest>>(manifestPath) ?? {};
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : fallbackName;
  return {
    pluginRoot,
    manifestPath,
    manifest: { ...raw, name, defaultEnabled: raw.defaultEnabled !== false },
  };
}

export function resolveComponentPath(pluginRoot: string, rel: string): string {
  const trimmed = rel.trim();
  const withoutDot = trimmed === "." ? pluginRoot : path.resolve(pluginRoot, trimmed);
  const relative = path.relative(pluginRoot, withoutDot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes plugin directory: ${rel}`);
  }
  return withoutDot;
}

export function asPathList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
