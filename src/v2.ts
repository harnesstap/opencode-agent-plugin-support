import { collectContext, firstBlock, runHookGroups, type HookRunResult } from "./hook-runtime.js";
import { toV2McpConfig, splitModelRef } from "./inject.js";
import { basePayload, hookEnv } from "./hook-payload.js";
import { mcpServerIds, type LoadedBridge } from "./runtime.js";
import { toClaudeTool } from "./tool-names.js";
import type { EnabledPlugin } from "./discover.js";
import type { RuntimePaths } from "./paths.js";

export const PLUGIN_ID = "opencode-claude-plugins";

type MutableRecord = Record<string, unknown>;

export type V2SkillEditor = {
  get?: (id: string) => unknown;
  add: (skill: {
    id: string;
    name: string;
    description?: string;
    path: string;
    content: string;
  }) => void;
};

export type V2CommandEditor = {
  add: (command: {
    name: string;
    description?: string;
    template?: string;
    execute?: (input: {
      sessionID: string;
      prompt?: { text?: string };
      delivery?: string;
    }) => Promise<void> | void;
  }) => void;
};

export type V2McpEditor = {
  set: (name: string, config: Record<string, unknown>) => void;
};

export type V2AgentEditor = {
  add?: (info: Record<string, unknown>) => void;
  update: (id: string, update: (agent: MutableRecord) => void) => void;
  get?: (id: string) => unknown;
};

export type V2PluginContext = {
  options?: unknown;
  location?: { directory?: string };
  skill?: { transform: (callback: (editor: V2SkillEditor) => void) => Promise<unknown> };
  command?: { transform: (callback: (editor: V2CommandEditor) => void) => Promise<unknown> };
  mcp?: { transform: (callback: (editor: V2McpEditor) => void) => Promise<unknown> };
  agent?: { transform: (callback: (editor: V2AgentEditor) => void) => Promise<unknown> };
  session?: {
    hook: (name: string, callback: (event: MutableRecord) => unknown) => Promise<unknown>;
    prompt?: (input: Record<string, unknown>) => Promise<unknown>;
  };
  tool?: {
    hook: (name: string, callback: (event: MutableRecord) => unknown) => Promise<unknown>;
    list?: () => Promise<Array<{ id: string }>>;
  };
  permission?: {
    hook: (name: string, callback: (event: MutableRecord) => unknown) => Promise<unknown>;
  };
  shell?: {
    hook: (name: string, callback: (event: MutableRecord) => unknown) => Promise<unknown>;
  };
  event?: {
    subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<{ type?: string; properties?: MutableRecord; data?: MutableRecord }>;
  };
};

function isV2Context(ctx: V2PluginContext | undefined): ctx is V2PluginContext {
  return Boolean(
    ctx &&
      ctx.skill &&
      typeof ctx.skill.transform === "function" &&
      ctx.session &&
      typeof ctx.session.hook === "function",
  );
}

function runAll(
  plugins: EnabledPlugin[],
  paths: RuntimePaths,
  event: string,
  extra: Record<string, unknown>,
  matcher?: string,
): HookRunResult[] {
  const results: HookRunResult[] = [];
  for (const plugin of plugins) {
    const groups = plugin.hooks[event];
    if (!groups) continue;
    const stdin = basePayload(event, paths.cwd, String(extra.session_id ?? ""), { ...extra });
    results.push(...runHookGroups(groups, stdin, { cwd: paths.cwd, env: hookEnv(plugin, paths) }, matcher));
  }
  return results;
}

function claudeToolName(tool: string, servers: string[]): string {
  return toClaudeTool(tool, servers);
}

function sessionIdFromEvent(event: MutableRecord): string {
  return String(event.sessionID ?? event.sessionId ?? "");
}

function appendToolContext(event: MutableRecord, extra: string[]): void {
  if (extra.length === 0) return;
  const joined = extra.join("\n\n");
  const result = (event.result as MutableRecord | undefined) ?? {};
  const content = result.content;
  if (typeof content === "string" || content === undefined) {
    event.result = { ...result, content: `${content ?? ""}\n\n${joined}` };
    return;
  }
  if (Array.isArray(content)) {
    event.result = { ...result, content: [...content, { type: "text", text: joined }] };
  }
}

function registerAgent(editor: V2AgentEditor, id: string, def: { description: string; prompt: string; model?: string }): void {
  const apply = (agent: MutableRecord) => {
    agent.description = def.description;
    agent.system = def.prompt;
    agent.mode = "subagent";
    agent.hidden = false;
    const model = splitModelRef(def.model);
    if (model) agent.model = model;
  };
  if (typeof editor.add === "function") {
    const info: MutableRecord = {
      id,
      description: def.description,
      system: def.prompt,
      mode: "subagent",
      hidden: false,
      permissions: [],
      request: { headers: {}, body: {} },
    };
    const model = splitModelRef(def.model);
    if (model) info.model = model;
    try {
      editor.add(info);
      return;
    } catch {
      // Fall through to update(), which inserts on miss in current V2 registries.
    }
  }
  editor.update(id, apply);
}

/**
 * OpenCode V2 `setup(ctx)`. Detects a V1-shaped ctx and no-ops so older
 * hosts that also invoke `default.setup` keep using `server()`.
 */
export async function setup(ctx: V2PluginContext, bridge: LoadedBridge): Promise<(() => void) | undefined> {
  if (!isV2Context(ctx)) return undefined;

  const { plugins, patch, paths, options } = bridge;
  const servers = mcpServerIds(plugins);
  const abort = new AbortController();

  if (ctx.skill) {
    await ctx.skill.transform((editor) => {
      for (const plugin of plugins) {
        for (const skill of plugin.skills) {
          try {
            if (editor.get?.(skill.name)) continue;
            editor.add({
              id: skill.name,
              name: skill.name,
              ...(skill.description ? { description: skill.description } : {}),
              path: skill.filePath,
              content: skill.body,
            });
          } catch (error) {
            console.error(`[opencode-claude-plugins] skill "${skill.name}" rejected:`, error);
          }
        }
      }
    });
  }

  if (ctx.command) {
    await ctx.command.transform((editor) => {
      for (const [name, def] of Object.entries(patch.command)) {
        try {
          editor.add({
            name,
            description: def.description,
            template: def.template,
            execute: async ({ sessionID, prompt, delivery }) => {
              const text = def.template.replaceAll("$ARGUMENTS", prompt?.text ?? "");
              await ctx.session?.prompt?.({ ...prompt, sessionID, text, delivery });
            },
          });
        } catch (error) {
          console.error(`[opencode-claude-plugins] command "${name}" rejected:`, error);
        }
      }
    });
  }

  if (ctx.mcp) {
    await ctx.mcp.transform((editor) => {
      for (const [name, spec] of Object.entries(patch.mcp)) {
        try {
          editor.set(name, toV2McpConfig(spec, options.mcpDisabled === true));
        } catch (error) {
          console.error(`[opencode-claude-plugins] mcp "${name}" rejected:`, error);
        }
      }
    });
  }

  if (ctx.agent) {
    await ctx.agent.transform((editor) => {
      for (const [id, def] of Object.entries(patch.agent)) {
        try {
          registerAgent(editor, id, def);
        } catch (error) {
          console.error(`[opencode-claude-plugins] agent "${id}" rejected:`, error);
        }
      }
    });
  }

  const sessionCtx = new Map<string, string[]>();

  await ctx.session?.hook("context", (event) => {
    if (options.instructions !== false) {
      const system = Array.isArray(event.system) ? (event.system as unknown[]) : [];
      for (const text of patch.instructionTexts) {
        system.push({ type: "text", text });
      }
      event.system = system;
    }
    const sessionID = sessionIdFromEvent(event);
    if (!sessionCtx.has(sessionID)) {
      const ctxs = collectContext(
        runAll(plugins, paths, "SessionStart", { session_id: sessionID, source: "startup" }, "startup"),
      );
      sessionCtx.set(sessionID, ctxs);
    }
    const extra = sessionCtx.get(sessionID) ?? [];
    if (extra.length) {
      const system = Array.isArray(event.system) ? (event.system as unknown[]) : [];
      for (const text of extra) system.push({ type: "text", text });
      event.system = system;
    }
  });

  await ctx.session?.hook("prompt", (event) => {
    const prompt = (event.prompt as MutableRecord | undefined) ?? {};
    const sessionID = sessionIdFromEvent(event);
    const text = String(prompt.text ?? "");
    const results = runAll(plugins, paths, "UserPromptSubmit", { session_id: sessionID, prompt: text });
    const blocked = firstBlock(results);
    if (blocked) {
      prompt.text = `Prompt blocked by Claude plugin hook: ${blocked.blockReason ?? "blocked"}`;
      event.prompt = prompt;
      return;
    }
    const extra = collectContext(results);
    if (extra.length) prompt.text = `${text}\n\n${extra.join("\n\n")}`;
    event.prompt = prompt;
  });

  await ctx.session?.hook("compaction", (event) => {
    const sessionID = sessionIdFromEvent(event);
    const trigger = String(event.trigger ?? event.source ?? "auto");
    const results = runAll(
      plugins,
      paths,
      "PreCompact",
      { session_id: sessionID, trigger },
      trigger === "manual" ? "manual" : "auto",
    );
    const extra = collectContext(results);
    if (extra.length) {
      const system = Array.isArray(event.system) ? (event.system as unknown[]) : [];
      for (const text of extra) system.push({ type: "text", text });
      event.system = system;
    }
  });

  await ctx.tool?.hook("execute.before", (event) => {
    const tool = claudeToolName(String(event.tool ?? ""), servers);
    const input = event.input && typeof event.input === "object" ? (event.input as MutableRecord) : {};
    const results = runAll(
      plugins,
      paths,
      "PreToolUse",
      {
        session_id: sessionIdFromEvent(event),
        tool_name: tool,
        tool_input: input,
        tool_use_id: event.id,
      },
      tool,
    );
    for (const result of results) {
      if (result.updatedInput && event.input && typeof event.input === "object") {
        Object.assign(event.input as object, result.updatedInput);
      }
    }
    const blocked = firstBlock(results);
    if (blocked) throw new Error(blocked.blockReason ?? `Blocked by PreToolUse hook (${tool})`);
  });

  await ctx.tool?.hook("execute.after", (event) => {
    const tool = claudeToolName(String(event.tool ?? ""), servers);
    const ev = event.status === "error" ? "PostToolUseFailure" : "PostToolUse";
    const results = runAll(
      plugins,
      paths,
      ev,
      {
        session_id: sessionIdFromEvent(event),
        tool_name: tool,
        tool_input: event.input,
        tool_response:
          event.status === "completed"
            ? (event.result as MutableRecord | undefined)?.content
            : (event.error as MutableRecord | undefined)?.message,
        tool_use_id: event.id,
      },
      tool,
    );
    const extra = collectContext(results);
    if (event.status === "completed") appendToolContext(event, extra);
  });

  await ctx.permission?.hook("evaluate", (event) => {
    const tool = claudeToolName(String(event.action ?? event.permission ?? event.type ?? ""), servers);
    const sessionID = sessionIdFromEvent(event);
    const payload = {
      session_id: sessionID,
      tool_name: tool,
      tool_input: { patterns: event.resources, metadata: event.metadata },
    };
    const results = [
      ...runAll(plugins, paths, "PermissionRequest", payload, tool),
      ...runAll(plugins, paths, "PreToolUse", payload, tool),
    ];
    if (results.some((result) => result.permissionDecision === "deny" || result.blocked)) {
      event.effect = "deny";
      event.message = results.find((result) => result.blockReason)?.blockReason ?? "denied by Claude plugin hook";
    } else if (results.some((result) => result.permissionDecision === "allow")) {
      event.effect = "allow";
    }
  });

  await ctx.shell?.hook("create.before", (event) => {
    const bins = plugins.map((plugin) => plugin.binDir).filter((dir): dir is string => Boolean(dir));
    if (bins.length === 0) return;
    const env = ((event.env as Record<string, string | undefined> | undefined) ?? {}) as Record<
      string,
      string | undefined
    >;
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    const current = env[pathKey] ?? process.env[pathKey] ?? "";
    const sep = process.platform === "win32" ? ";" : ":";
    env[pathKey] = `${bins.join(sep)}${current ? sep + current : ""}`;
    event.env = env;
  });

  if (ctx.event?.subscribe) {
    void (async () => {
      try {
        for await (const raw of ctx.event!.subscribe({ signal: abort.signal })) {
          const type = String(raw.type ?? "");
          const props = { ...(raw.properties ?? {}), ...(raw.data ?? {}) };
          const sessionID = String(props.sessionID ?? props.id ?? props.sessionId ?? "");
          if (type === "session.created" || type.endsWith("session.created")) {
            if (!sessionCtx.has(sessionID)) {
              sessionCtx.set(
                sessionID,
                collectContext(
                  runAll(plugins, paths, "SessionStart", { session_id: sessionID, source: "startup" }, "startup"),
                ),
              );
            }
          } else if (type === "session.deleted" || type === "session.removed" || type.endsWith("session.deleted")) {
            runAll(plugins, paths, "SessionEnd", { session_id: sessionID, reason: "clear" }, "clear");
            sessionCtx.delete(sessionID);
          } else if (type === "session.idle" || type.endsWith("session.idle")) {
            runAll(plugins, paths, "Stop", { session_id: sessionID, stop_hook_active: true });
          }
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        console.error("[opencode-claude-plugins] event subscribe failed:", error);
      }
    })();
  }

  return () => abort.abort();
}
