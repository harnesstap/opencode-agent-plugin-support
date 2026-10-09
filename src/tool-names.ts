/** Claude Code built-in tool names → OpenCode tool ids. */
export const CLAUDE_TO_OPENCODE_TOOLS: Record<string, string> = {
  Bash: "bash",
  PowerShell: "bash",
  Edit: "edit",
  Write: "write",
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  LS: "list",
  List: "list",
  NotebookEdit: "edit",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  Task: "task",
  Agent: "task",
  TodoWrite: "todowrite",
  TodoRead: "todoread",
  Skill: "skill",
  ToolSearch: "skill",
  ExitPlanMode: "plan",
  ApplyPatch: "apply_patch",
  LSP: "lsp",
  Question: "question",
};

const PRIMARY_CLAUDE_TOOLS: Record<string, string> = {
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  list: "LS",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  task: "Task",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  skill: "Skill",
  plan: "ExitPlanMode",
  apply_patch: "ApplyPatch",
  lsp: "LSP",
  question: "Question",
  // OpenCode V2 built-in tool ids
  shell: "Bash",
  subagent: "Task",
  patch: "Edit",
};

export const OPENCODE_TO_CLAUDE_TOOLS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(CLAUDE_TO_OPENCODE_TOOLS).map(([claude, oc]) => [oc, claude])),
  ...PRIMARY_CLAUDE_TOOLS,
};

export function toOpenCodeTool(name: string): string {
  if (CLAUDE_TO_OPENCODE_TOOLS[name]) return CLAUDE_TO_OPENCODE_TOOLS[name]!;
  if (name.startsWith("mcp__")) {
    const parts = name.split("__").slice(1);
    if (parts.length >= 2) return `${parts[0]}_${parts.slice(1).join("_")}`;
  }
  return name.toLowerCase();
}

/**
 * Claude Code plugin MCP tools are `mcp__plugin_<plugin>_<server>__<tool>`.
 * OpenCode V2 names the same call `plugin_server_tool` (colon → underscore).
 */
export function toClaudeMcpTool(opencodeTool: string, mcpServerIds: Iterable<string> = []): string | undefined {
  const servers = [...mcpServerIds]
    .map((id) => ({ original: id, v2: id.replaceAll(":", "_") }))
    .sort((a, b) => b.v2.length - a.v2.length);
  for (const server of servers) {
    const prefix = `${server.v2}_`;
    if (!opencodeTool.startsWith(prefix)) continue;
    const tool = opencodeTool.slice(prefix.length);
    if (!tool) continue;
    const pluginAndServer = server.original.replaceAll(":", "_");
    return `mcp__plugin_${pluginAndServer}__${tool}`;
  }
  return undefined;
}

export function toClaudeTool(name: string, mcpServerIds: Iterable<string> = []): string {
  if (OPENCODE_TO_CLAUDE_TOOLS[name]) return OPENCODE_TO_CLAUDE_TOOLS[name]!;
  const fromKnownMcp = toClaudeMcpTool(name, mcpServerIds);
  if (fromKnownMcp) return fromKnownMcp;
  const mcp = name.match(/^([a-zA-Z0-9:-]+)_(.+)$/);
  if (mcp) return `mcp__${mcp[1]}__${mcp[2]}`;
  const titled = name.charAt(0).toUpperCase() + name.slice(1);
  return CLAUDE_TO_OPENCODE_TOOLS[titled] ? titled : name;
}

export function claudeToolsToOpenCodeMap(tools: string[] | undefined): Record<string, boolean> | undefined {
  if (!tools || tools.length === 0) return undefined;
  const map: Record<string, boolean> = { "*": false };
  for (const tool of tools) {
    const base = tool.replace(/\(.*\)$/, "").trim();
    if (!base) continue;
    map[toOpenCodeTool(base)] = true;
  }
  return map;
}

/**
 * Claude matchers are `|`-separated patterns (`Write|Edit`, `Bash`, `*`).
 * Compared against the Claude-style tool name.
 */
export function matcherHits(matcher: string | undefined, claudeToolName: string): boolean {
  if (!matcher || matcher === "*" || matcher === "") return true;
  const parts = matcher.split("|").map((part) => part.trim()).filter(Boolean);
  return parts.some((part) => {
    if (part === "*") return true;
    try {
      return new RegExp(`^${part}$`, "i").test(claudeToolName);
    } catch {
      return part.toLowerCase() === claudeToolName.toLowerCase();
    }
  });
}
