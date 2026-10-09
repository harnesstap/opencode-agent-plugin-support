import { collectContext, firstBlock, runHookGroups, type HookRunResult } from "./hook-runtime.js";
import { applyConfigPatch } from "./inject.js";
import { loadBridge, mcpServerIds, type LoadedBridge } from "./runtime.js";
import { PLUGIN_ID, setup as setupV2, type V2PluginContext } from "./v2.js";
import { basePayload, hookEnv, looksLikeToolFailure } from "./hook-payload.js";
import { toClaudeTool } from "./tool-names.js";
import type { EnabledPlugin } from "./discover.js";
import type { RuntimePaths } from "./paths.js";

export type PluginInput = {
  directory?: string;
  worktree?: string;
  project?: { id?: string; worktree?: string };
  client?: {
    app?: { log?: (input: unknown) => Promise<unknown> };
    tui?: { showToast?: (input: unknown) => Promise<unknown> };
  };
  options?: unknown;
};

type TextPart = { type: "text"; text: string; [key: string]: unknown };

const sessionStarted = new Set<string>();
const pendingSystemContext: string[] = [];

function log(client: PluginInput["client"], message: string, extra?: Record<string, unknown>): void {
  void client?.app?.log?.({
    body: { service: "opencode-claude-plugins", level: "info", message, extra },
  });
}

function execFor(plugin: EnabledPlugin, paths: RuntimePaths) {
  return { cwd: paths.cwd, env: hookEnv(plugin, paths) };
}

function runAll(
  plugins: EnabledPlugin[],
  event: string,
  stdinExtra: Record<string, unknown>,
  paths: RuntimePaths,
  claudeToolName?: string,
): HookRunResult[] {
  const results: HookRunResult[] = [];
  for (const plugin of plugins) {
    const groups = plugin.hooks[event];
    if (!groups) continue;
    const stdin = basePayload(event, paths.cwd, String(stdinExtra.session_id ?? ""), {
      ...stdinExtra,
    });
    results.push(...runHookGroups(groups, stdin, execFor(plugin, paths), claudeToolName));
  }
  return results;
}

function appendTextPart(parts: unknown, text: string): unknown {
  if (!Array.isArray(parts)) return [{ type: "text", text } satisfies TextPart];
  return [...parts, { type: "text", text } satisfies TextPart];
}

function claudeTool(tool: string, plugins: EnabledPlugin[]): string {
  return toClaudeTool(tool, mcpServerIds(plugins));
}

export async function createClaudeCodeBridge(input: PluginInput) {
  const loaded = loadBridge({
    cwd: input.directory ?? input.worktree ?? process.cwd(),
    options: input.options,
  });
  const { plugins, patch, paths } = loaded;
  log(input.client, `loaded ${plugins.length} Claude Code plugin(s)`, {
    plugins: plugins.map((plugin) => plugin.id),
    skipped: loaded.skipped,
  });

  return {
    config: async (config: Record<string, unknown>) => {
      applyConfigPatch(config, patch);
    },
    event: async ({ event }: { event: { type?: string; properties?: Record<string, unknown> } }) => {
      const type = event.type ?? "";
      const sessionID = String(event.properties?.sessionID ?? event.properties?.id ?? "");
      if (type === "session.created") {
        sessionStarted.add(sessionID);
        const results = runAll(
          plugins,
          "SessionStart",
          { session_id: sessionID, source: "startup" },
          paths,
          "startup",
        );
        pendingSystemContext.push(...collectContext(results));
      } else if (type === "session.deleted") {
        runAll(plugins, "SessionEnd", { session_id: sessionID, reason: "clear" }, paths, "clear");
        sessionStarted.delete(sessionID);
      } else if (type === "session.idle") {
        const results = runAll(plugins, "Stop", { session_id: sessionID, stop_hook_active: true }, paths);
        pendingSystemContext.push(...collectContext(results));
      }
    },
    "chat.message": async (
      inputArgs: { sessionID?: string },
      output: { message: { content?: string }; parts: unknown },
    ) => {
      const sessionID = inputArgs.sessionID ?? "";
      if (sessionID && !sessionStarted.has(sessionID)) {
        sessionStarted.add(sessionID);
        const startResults = runAll(
          plugins,
          "SessionStart",
          { session_id: sessionID, source: "startup" },
          paths,
          "startup",
        );
        pendingSystemContext.push(...collectContext(startResults));
      }
      const prompt =
        typeof output.message?.content === "string"
          ? output.message.content
          : Array.isArray(output.parts)
            ? output.parts
                .map((part) => (part && typeof part === "object" && "text" in part ? String((part as TextPart).text) : ""))
                .join("\n")
            : "";
      const results = runAll(plugins, "UserPromptSubmit", { session_id: sessionID, prompt }, paths);
      const blocked = firstBlock(results);
      if (blocked) {
        output.parts = [
          {
            type: "text",
            text: `Prompt blocked by Claude plugin hook: ${blocked.blockReason ?? "blocked"}`,
          },
        ];
        return;
      }
      const extra = collectContext(results);
      if (extra.length) output.parts = appendTextPart(output.parts, extra.join("\n\n"));
    },
    "tool.execute.before": async (
      hookInput: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ) => {
      const mapped = claudeTool(hookInput.tool, plugins);
      const results = runAll(
        plugins,
        "PreToolUse",
        {
          session_id: hookInput.sessionID,
          tool_name: mapped,
          tool_input: output.args,
          tool_use_id: hookInput.callID,
        },
        paths,
        mapped,
      );
      for (const result of results) {
        if (result.updatedInput) Object.assign(output.args, result.updatedInput);
      }
      const blocked = firstBlock(results);
      if (blocked) {
        throw new Error(blocked.blockReason ?? `Blocked by PreToolUse hook (${mapped})`);
      }
    },
    "tool.execute.after": async (
      hookInput: { tool: string; sessionID: string; callID: string; args: unknown },
      output: { title: string; output: string; metadata: unknown },
    ) => {
      const mapped = claudeTool(hookInput.tool, plugins);
      const payload = {
        session_id: hookInput.sessionID,
        tool_name: mapped,
        tool_input: hookInput.args,
        tool_response: output.output,
        tool_use_id: hookInput.callID,
      };
      const event = looksLikeToolFailure(output) ? "PostToolUseFailure" : "PostToolUse";
      const results = runAll(plugins, event, payload, paths, mapped);
      const extra = collectContext(results);
      if (extra.length) output.output = `${output.output}\n\n${extra.join("\n\n")}`;
    },
    "permission.ask": async (
      permInput: { permission?: string; type?: string; sessionID?: string; patterns?: string[] },
      output: { status: "ask" | "deny" | "allow" },
    ) => {
      const tool = String(permInput.permission ?? permInput.type ?? "");
      const mapped = claudeTool(tool, plugins);
      const results = [
        ...runAll(
          plugins,
          "PermissionRequest",
          {
            session_id: permInput.sessionID ?? "",
            tool_name: mapped,
            tool_input: { patterns: permInput.patterns },
          },
          paths,
          mapped,
        ),
        ...runAll(
          plugins,
          "PreToolUse",
          {
            session_id: permInput.sessionID ?? "",
            tool_name: mapped,
            tool_input: { patterns: permInput.patterns },
          },
          paths,
          mapped,
        ),
      ];
      if (results.some((result) => result.permissionDecision === "deny" || result.blocked)) {
        output.status = "deny";
      } else if (results.some((result) => result.permissionDecision === "allow")) {
        output.status = "allow";
      }
    },
    "experimental.session.compacting": async (
      hookInput: { sessionID?: string },
      output: { context: string[]; prompt?: string },
    ) => {
      const results = runAll(
        plugins,
        "PreCompact",
        { session_id: hookInput.sessionID ?? "", trigger: "auto" },
        paths,
        "auto",
      );
      output.context.push(...collectContext(results));
    },
    "experimental.chat.system.transform": async (_hookInput: unknown, output: { system: string[] }) => {
      if (patch.instructionTexts.length) output.system.push(...patch.instructionTexts);
      if (pendingSystemContext.length) {
        output.system.push(...pendingSystemContext);
        pendingSystemContext.length = 0;
      }
    },
    "shell.env": async (_hookInput: unknown, output: { env: Record<string, string> }) => {
      const bins = plugins.map((plugin) => plugin.binDir).filter((dir): dir is string => Boolean(dir));
      if (bins.length === 0) return;
      const pathKey = process.platform === "win32" ? "Path" : "PATH";
      const current = output.env[pathKey] ?? process.env[pathKey] ?? "";
      output.env[pathKey] = `${bins.join(process.platform === "win32" ? ";" : ":")}${current ? (process.platform === "win32" ? ";" : ":") + current : ""}`;
    },
  };
}

/** V1 plugin function (also `default.server`). */
export async function ClaudeCodePlugins(input: PluginInput) {
  return createClaudeCodeBridge(input);
}

async function setup(ctx: V2PluginContext) {
  const directory = ctx.location?.directory ?? process.cwd();
  const bridge: LoadedBridge = loadBridge({ cwd: directory, options: ctx.options });
  return setupV2(ctx, bridge);
}

/**
 * Dual V1/V2 entrypoint.
 * V2 reads `{ id, setup }`. V1 (1.18.29+) calls `server()`.
 */
const plugin = {
  id: PLUGIN_ID,
  setup,
  server: ClaudeCodePlugins,
};

export default plugin;
export { plugin, PLUGIN_ID, setup };
export type { V2PluginContext };
