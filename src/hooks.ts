import path from "node:path";
import { expandDeep, type ExpandContext } from "./expand.js";
import { isFile, JsonParseError, readJsonFile } from "./fs-utils.js";
import type { FileFilter } from "./safe-path.js";
import { warn } from "./log.js";
import { isRecord, type PluginManifest, resolveComponentPath } from "./manifest.js";

export type ClaudeHookHandler = {
  type?: string;
  command?: string;
  args?: string[];
  timeout?: number;
  shell?: string;
  statusMessage?: string;
  [key: string]: unknown;
};

export type ClaudeHookGroup = {
  matcher?: string;
  hooks: ClaudeHookHandler[];
};

export type ClaudeHooksConfig = Record<string, ClaudeHookGroup[]>;

function asGroups(value: unknown): ClaudeHookGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: ClaudeHookGroup[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const hooksRaw = item.hooks;
    const hooks = Array.isArray(hooksRaw)
      ? hooksRaw.filter((hook): hook is ClaudeHookHandler => isRecord(hook) && typeof hook.command === "string")
      : [];
    if (hooks.length === 0 && typeof item.command === "string") {
      groups.push({
        matcher: typeof item.matcher === "string" ? item.matcher : undefined,
        hooks: [item as ClaudeHookHandler],
      });
      continue;
    }
    if (hooks.length === 0) continue;
    groups.push({
      matcher: typeof item.matcher === "string" ? item.matcher : undefined,
      hooks,
    });
  }
  return groups;
}

export function parseHooksObject(value: unknown): ClaudeHooksConfig {
  const root = isRecord(value) && isRecord(value.hooks) ? value.hooks : value;
  if (!isRecord(root)) return {};
  const out: ClaudeHooksConfig = {};
  for (const [event, groups] of Object.entries(root)) {
    const parsed = asGroups(groups);
    if (parsed.length) out[event] = parsed;
  }
  return out;
}

function mergeHookConfigs(...configs: ClaudeHooksConfig[]): ClaudeHooksConfig {
  const out: ClaudeHooksConfig = {};
  for (const config of configs) {
    for (const [event, groups] of Object.entries(config)) {
      out[event] = [...(out[event] ?? []), ...groups];
    }
  }
  return out;
}

function readHooksFile(filePath: string, accept?: FileFilter): ClaudeHooksConfig {
  if (!isFile(filePath)) return {};
  if (accept && !accept(filePath)) return {};
  try {
    return parseHooksObject(readJsonFile<unknown>(filePath));
  } catch (cause) {
    const detail = cause instanceof JsonParseError ? cause.message : String(cause);
    warn(`skipping hooks file ${filePath}: ${detail}`);
    return {};
  }
}

export function loadHooks(
  pluginRoot: string,
  manifest: PluginManifest,
  ctx: ExpandContext,
  accept?: FileFilter,
): ClaudeHooksConfig {
  const fromDefault = readHooksFile(path.join(pluginRoot, "hooks", "hooks.json"), accept);
  const declared = manifest.hooks;
  if (declared === undefined) return expandDeep(fromDefault, ctx);
  const pieces = Array.isArray(declared) ? declared : [declared];
  const extras: ClaudeHooksConfig[] = [];
  for (const piece of pieces) {
    if (typeof piece === "string") {
      try {
        extras.push(readHooksFile(resolveComponentPath(pluginRoot, piece), accept));
      } catch (cause) {
        warn(`skipping declared hooks path "${piece}": ${cause instanceof Error ? cause.message : cause}`);
      }
      continue;
    }
    extras.push(parseHooksObject(piece));
  }
  return expandDeep(mergeHookConfigs(fromDefault, ...extras), ctx);
}
