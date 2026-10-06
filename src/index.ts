import { discoverEnabledPlugins, type EnabledPlugin } from "./discover.js";
import {
  collectContext,
  firstBlock,
  runHookGroups,
  type HookRunResult,
} from "./hook-runtime.js";
import { applyConfigPatch, buildConfigPatch } from "./inject.js";
import { defaultRuntimePaths, type RuntimePaths } from "./paths.js";
import { basePayload, hookEnv, looksLikeToolFailure } from "./hook-payload.js";
import { toClaudeTool } from "./tool-names.js";

export type PluginInput = {
  directory?: string;
  worktree?: string;
  project?: { id?: string; worktree?: string };
  client?: {
    app?: { log?: (input: unknown) => Promise<unknown> };
    tui?: { showToast?: (input: unknown) => Promise<unknown> };
  };
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

export async function createClaudeCodeBridge(input: PluginInput) {
  const paths = defaultRuntimePaths({
    cwd: input.directory ?? input.worktree ?? process.cwd(),
  });
  const discovered = discoverEnabledPlugins(paths);
  const plugins = discovered.enabled;
  const patch = buildConfigPatch(plugins);
  log(input.client, `loaded ${plugins.length} Claude Code plugin(s)`, {
    plugins: plugins.map((plugin) => plugin.id),
    skipped: discovered.skipped,
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
        const results = runAll(plugins, "SessionStart", { session_id: sessionID, source: "startup" }, paths);
        pendingSystemContext.push(...collectContext(results));
      } else if (type === "session.deleted") {
        runAll(plugins, "SessionEnd", { session_id: sessionID, reason: "clear" }, paths);
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
        const startResults = runAll(plugins, "SessionStart", { session_id: sessionID, source: "startup" }, paths);
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
      const claudeTool = toClaudeTool(hookInput.tool);
      const results = runAll(
        plugins,
        "PreToolUse",
        {
          session_id: hookInput.sessionID,
          tool_name: claudeTool,
          tool_input: output.args,
          tool_use_id: hookInput.callID,
        },
        paths,
        claudeTool,
      );
      for (const result of results) {
        if (result.updatedInput) Object.assign(output.args, result.updatedInput);
      }
      const blocked = firstBlock(results);
      if (blocked) {
        throw new Error(blocked.blockReason ?? `Blocked by PreToolUse hook (${claudeTool})`);
      }
    },
    "tool.execute.after": async (
      hookInput: { tool: string; sessionID: string; callID: string; args: unknown },
      output: { title: string; output: string; metadata: unknown },
    ) => {
      const claudeTool = toClaudeTool(hookInput.tool);
      const payload = {
        session_id: hookInput.sessionID,
        tool_name: claudeTool,
        tool_input: hookInput.args,
        tool_response: output.output,
        tool_use_id: hookInput.callID,
      };
      const event = looksLikeToolFailure(output) ? "PostToolUseFailure" : "PostToolUse";
      const results = runAll(plugins, event, payload, paths, claudeTool);
      const extra = collectContext(results);
      if (extra.length) output.output = `${output.output}\n\n${extra.join("\n\n")}`;
    },
    "permission.ask": async (
      permInput: { permission?: string; type?: string; sessionID?: string; patterns?: string[] },
      output: { status: "ask" | "deny" | "allow" },
    ) => {
      const tool = String(permInput.permission ?? permInput.type ?? "");
      const claudeTool = toClaudeTool(tool);
      const results = [
        ...runAll(
          plugins,
          "PermissionRequest",
          {
            session_id: permInput.sessionID ?? "",
            tool_name: claudeTool,
            tool_input: { patterns: permInput.patterns },
          },
          paths,
          claudeTool,
        ),
        ...runAll(
          plugins,
          "PreToolUse",
          {
            session_id: permInput.sessionID ?? "",
            tool_name: claudeTool,
            tool_input: { patterns: permInput.patterns },
          },
          paths,
          claudeTool,
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
      const results = runAll(plugins, "PreCompact", { session_id: hookInput.sessionID ?? "", trigger: "auto" }, paths);
      output.context.push(...collectContext(results));
    },
    "experimental.chat.system.transform": async (
      _hookInput: unknown,
      output: { system: string[] },
    ) => {
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

const ClaudeCodePlugins = async (input: PluginInput) => createClaudeCodeBridge(input);

export default ClaudeCodePlugins;
export { ClaudeCodePlugins };
