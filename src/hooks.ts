import path from "node:path";
import { expandDeep, type ExpandContext } from "./expand.js";
import { isFile, readJsonFile } from "./fs-utils.js";
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

export const MAPPED_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "PermissionRequest",
  "PreCompact",
] as const;

export type MappedHookEvent = (typeof MAPPED_HOOK_EVENTS)[number];

export const UNMAPPED_HOOK_EVENTS = [
  "Setup",
  "UserPromptExpansion",
  "PermissionDenied",
  "PostToolBatch",
  "Notification",
  "MessageDisplay",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "StopFailure",
  "TeammateIdle",
  "InstructionsLoaded",
  "ConfigChange",
  "CwdChanged",
  "DirectoryAdded",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PostCompact",
  "PreModelSwitch",
  "PostModelSwitch",
  "Elicitation",
  "ElicitationResult",
] as const;

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

export function loadHooks(
  pluginRoot: string,
  manifest: PluginManifest,
  ctx: ExpandContext,
): ClaudeHooksConfig {
  const defaultFile = path.join(pluginRoot, "hooks", "hooks.json");
  const fromDefault = isFile(defaultFile) ? parseHooksObject(readJsonFile<unknown>(defaultFile)) : {};
  const declared = manifest.hooks;
  if (declared === undefined) return expandDeep(fromDefault, ctx);
  const pieces = Array.isArray(declared) ? declared : [declared];
  const extras: ClaudeHooksConfig[] = [];
  for (const piece of pieces) {
    if (typeof piece === "string") {
      try {
        const filePath = resolveComponentPath(pluginRoot, piece);
        extras.push(parseHooksObject(readJsonFile<unknown>(filePath)));
      } catch {
        // skip
      }
      continue;
    }
    extras.push(parseHooksObject(piece));
  }
  return expandDeep(mergeHookConfigs(fromDefault, ...extras), ctx);
}

export type HookMappingNote = {
  event: string;
  mappedTo: string;
  notes?: string;
};

export const HOOK_MAPPING_TABLE: HookMappingNote[] = [
  { event: "PreToolUse", mappedTo: "V1 tool.execute.before + permission.ask; V2 ctx.tool.hook(execute.before)" },
  { event: "PostToolUse", mappedTo: "V1 tool.execute.after; V2 ctx.tool.hook(execute.after)" },
  {
    event: "PostToolUseFailure",
    mappedTo: "tool.execute.after (heuristic / V2 status=error)",
    notes: "OpenCode does not expose a dedicated failure hook; we treat empty/error-like output as failure.",
  },
  { event: "UserPromptSubmit", mappedTo: "V1 chat.message; V2 ctx.session.hook(prompt)" },
  {
    event: "SessionStart",
    mappedTo: "V1 event session.created; V2 ctx.session.hook(context) + event subscribe",
    notes: "Matcher is the session source (startup/clear/compact), not a tool name. V2 re-injects context on every model call.",
  },
  { event: "SessionEnd", mappedTo: "V1 event session.deleted; V2 event subscribe session.deleted" },
  {
    event: "Stop",
    mappedTo: "V1 event session.idle; V2 event subscribe session.idle",
    notes: "Approximation: OpenCode idle is not identical to Claude's turn-complete Stop.",
  },
  { event: "PermissionRequest", mappedTo: "V1 permission.ask; V2 ctx.permission.hook(evaluate)" },
  { event: "PreCompact", mappedTo: "V1 experimental.session.compacting; V2 ctx.session.hook(compaction)" },
  ...UNMAPPED_HOOK_EVENTS.map((event) => ({
    event,
    mappedTo: "(unmapped)",
    notes: "No faithful OpenCode plugin hook. Commands are not executed.",
  })),
];
