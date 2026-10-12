import path from "node:path";
import type { AgentPluginsManifest } from "./ap-manifest.js";
import { loadAgents, type LoadedAgent } from "./agents.js";
import { loadCommands, type LoadedCommand } from "./commands.js";
import type { Diagnostics } from "./diagnostics.js";
import type { ExpandContext } from "./expand.js";
import { loadHooks, type ClaudeHooksConfig } from "./hooks.js";
import { EXTENSION_NAMESPACE } from "./identity.js";
import { loadInstructions, type LoadedInstructions } from "./instructions.js";
import { isRecord, type PluginManifest } from "./manifest.js";
import { kindOf, resolveWithin } from "./safe-path.js";

export type OpenCodeExtension = {
  commands: LoadedCommand[];
  agents: LoadedAgent[];
  hooks: ClaudeHooksConfig;
  instructions: LoadedInstructions;
};

/** Manifest fields the `com.harnesstap.opencode` namespace understands (same shapes as a Claude manifest). */
const INLINE_KEYS = ["commands", "agents", "hooks"] as const;

export function emptyExtension(): OpenCodeExtension {
  return { commands: [], agents: [], hooks: {}, instructions: { files: [], texts: [] } };
}

/**
 * The OpenCode client extension of an Agent Plugins package (§8): Claude-like components
 * under `<root>/com.harnesstap.opencode/` (`commands/`, `agents/`, `hooks/hooks.json`,
 * `instructions.md`) and/or inline `commands`, `agents`, `hooks` in
 * `extensions["com.harnesstap.opencode"]`, loaded with the Claude loaders rooted at that
 * directory. Every file read must resolve inside the plugin root.
 */
export function loadOpenCodeExtension(
  realRoot: string,
  manifest: AgentPluginsManifest,
  ctx: ExpandContext,
  diag: Diagnostics,
): OpenCodeExtension {
  const inline = manifest.extensions?.[EXTENSION_NAMESPACE];
  const extDir = path.join(realRoot, EXTENSION_NAMESPACE);
  let hasDir = false;
  const dirKind = kindOf(extDir);
  if (dirKind === "directory") {
    const within = resolveWithin(realRoot, extDir);
    if (within.ok) hasDir = true;
    else diag.warn(`${EXTENSION_NAMESPACE}/ ${within.reason}; ignoring it`);
  } else if (dirKind !== "missing") {
    diag.warn(`${EXTENSION_NAMESPACE} is not a directory; ignoring it`);
  }

  let inlineManifest: PluginManifest = { name: manifest.name };
  if (inline !== undefined) {
    if (!isRecord(inline)) {
      diag.warn(`extensions["${EXTENSION_NAMESPACE}"] is not an object; ignoring it`);
    } else {
      for (const key of Object.keys(inline)) {
        if (!(INLINE_KEYS as readonly string[]).includes(key)) {
          diag.warn(`extensions["${EXTENSION_NAMESPACE}"]: unknown field "${key}" ignored`);
        }
      }
      inlineManifest = { name: manifest.name, ...Object.fromEntries(INLINE_KEYS.filter((key) => key in inline).map((key) => [key, inline[key]])) };
    }
  }
  if (!hasDir && !INLINE_KEYS.some((key) => key in inlineManifest)) return emptyExtension();

  const accept = (file: string): boolean => {
    const within = resolveWithin(realRoot, file);
    if (!within.ok) diag.warn(`ignoring ${path.relative(realRoot, file)}: ${within.reason}`);
    return within.ok;
  };
  const expand: ExpandContext = { ...ctx, pluginRoot: realRoot, pluginVars: true };
  const base = extDir;
  return {
    commands: loadCommands(base, inlineManifest, accept),
    agents: loadAgents(base, inlineManifest, accept),
    hooks: loadHooks(base, inlineManifest, expand, accept),
    instructions: hasDir
      ? loadInstructions(base, manifest.name, expand, { candidates: ["instructions.md"], accept })
      : { files: [], texts: [] },
  };
}
