import fs from "node:fs";
import path from "node:path";
import { installedPluginsPath, pluginsDir, type RuntimePaths } from "./paths.js";

function realpathIfExists(target: string): string | undefined {
  try {
    return fs.realpathSync(target);
  } catch {
    return undefined;
  }
}

function isSymlink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function isSameOrInside(inner: string, outer: string): boolean {
  const a = path.resolve(inner);
  const b = path.resolve(outer);
  return a === b || a.startsWith(b + path.sep);
}

/** True when ~/.agents/plugins (or installed_plugins.json) is Claude's plugin store. */
export function writesThroughClaudePluginRegistry(paths: RuntimePaths): boolean {
  const agentsPlugins = pluginsDir(paths);
  const claudePlugins = path.join(paths.home, ".claude", "plugins");
  const registryFile = installedPluginsPath(paths);
  const claudeReal = realpathIfExists(claudePlugins);
  const agentsReal = realpathIfExists(agentsPlugins);
  if (claudeReal && agentsReal && isSameOrInside(agentsReal, claudeReal)) return true;
  if (isSymlink(agentsPlugins) || isSymlink(registryFile)) {
    const linked = realpathIfExists(isSymlink(registryFile) ? registryFile : agentsPlugins);
    if (linked && (linked.includes(`${path.sep}.claude${path.sep}plugins`) || linked.endsWith(`${path.sep}.claude${path.sep}plugins`))) {
      return true;
    }
  }
  return false;
}

export const CLAUDE_REGISTRY_WRITE_HELP =
  "install-local would write Claude Code's plugin registry because ~/.agents/plugins is a symlink (or otherwise the same tree as ~/.claude/plugins). Re-run with --write-claude-registry if you really want that, or point ~/.agents/plugins at its own directory.";
