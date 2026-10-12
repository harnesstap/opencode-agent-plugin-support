import type { EnabledPlugin } from "./discover.js";
import { pluginDataDir, type RuntimePaths } from "./paths.js";
import { realpathOrUndefined } from "./safe-path.js";

export function hookEnv(plugin: EnabledPlugin, paths: RuntimePaths): NodeJS.ProcessEnv {
  const data = pluginDataDir(paths, plugin.id);
  return {
    ...paths.env,
    CLAUDE_PLUGIN_ROOT: plugin.pluginRoot,
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_PROJECT_DIR: paths.cwd,
    ...(plugin.agentPluginsRoot
      ? { PLUGIN_ROOT: plugin.agentPluginsRoot, PLUGIN_DATA: realpathOrUndefined(data) ?? data }
      : {}),
  };
}

export function basePayload(
  event: string,
  cwd: string,
  sessionID?: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    hook_event_name: event,
    session_id: sessionID ?? "",
    cwd,
    permission_mode: "default",
    ...extra,
  };
}

export function looksLikeToolFailure(output: { output?: string; title?: string; metadata?: unknown }): boolean {
  const text = `${output.title ?? ""}\n${output.output ?? ""}`.toLowerCase();
  if (!output.output || output.output.trim() === "") return true;
  return /\berror\b|\bfailed\b|\bdenied\b/.test(text);
}
