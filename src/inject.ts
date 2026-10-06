import path from "node:path";
import type { EnabledPlugin } from "./discover.js";
import { namespaced } from "./discover.js";
import { mapClaudeModel } from "./agents.js";
import { claudeToolsToOpenCodeMap } from "./tool-names.js";

export type OpenCodeCommand = {
  template: string;
  description?: string;
  agent?: string;
  model?: string;
};

export type OpenCodeAgent = {
  description: string;
  prompt: string;
  mode: "subagent";
  model?: string;
  tools?: Record<string, boolean>;
};

export type OpenCodeConfigPatch = {
  command: Record<string, OpenCodeCommand>;
  agent: Record<string, OpenCodeAgent>;
  mcp: Record<string, unknown>;
  instructions: string[];
  instructionTexts: string[];
  skillPaths: string[];
  skillNames: string[];
};

export function buildConfigPatch(plugins: EnabledPlugin[]): OpenCodeConfigPatch {
  const command: Record<string, OpenCodeCommand> = {};
  const agent: Record<string, OpenCodeAgent> = {};
  const mcp: Record<string, unknown> = {};
  const instructions: string[] = [];
  const instructionTexts: string[] = [];
  const skillPaths: string[] = [];
  const skillNames: string[] = [];

  for (const plugin of plugins) {
    for (const cmd of plugin.commands) {
      const key = namespaced(plugin.name, cmd.name);
      command[key] = {
        template: cmd.template.includes("$ARGUMENTS") ? cmd.template : `${cmd.template}\n\n$ARGUMENTS`,
        description: cmd.description ?? `${plugin.name} command ${cmd.name}`,
        agent: cmd.agent,
        model: mapClaudeModel(cmd.model),
      };
      if (cmd.allowedTools && cmd.allowedTools.length > 0) {
        // OpenCode command schema has no allowedTools; encoded in description.
        command[key]!.description = `${command[key]!.description} (tools: ${cmd.allowedTools.join(", ")})`;
      }
    }

    for (const item of plugin.agents) {
      const key = namespaced(plugin.name, item.name);
      agent[key] = {
        description: item.description,
        prompt: item.prompt,
        mode: "subagent",
        model: item.model,
        tools: item.tools,
      };
    }

    for (const [serverName, spec] of Object.entries(plugin.mcp)) {
      mcp[namespaced(plugin.name, serverName)] = spec;
    }

    instructions.push(...plugin.instructions.files);
    instructionTexts.push(...plugin.instructions.texts);

    const skillDirs = new Set<string>();
    for (const skill of plugin.skills) {
      skillDirs.add(path.dirname(skill.dir));
      skillDirs.add(skill.dir);
      skillNames.push(skill.name);
    }
    skillPaths.push(...skillDirs);
  }

  return {
    command,
    agent,
    mcp,
    instructions: unique(instructions),
    instructionTexts,
    skillPaths: unique(skillPaths),
    skillNames: unique(skillNames),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function applyConfigPatch(config: Record<string, unknown>, patch: OpenCodeConfigPatch): void {
  const command = (asObject(config.command) ?? {}) as Record<string, OpenCodeCommand>;
  Object.assign(command, patch.command);
  config.command = command;

  const agent = (asObject(config.agent) ?? {}) as Record<string, OpenCodeAgent>;
  Object.assign(agent, patch.agent);
  config.agent = agent;

  const mcp = (asObject(config.mcp) ?? {}) as Record<string, unknown>;
  Object.assign(mcp, patch.mcp);
  config.mcp = mcp;

  const instructions = Array.isArray(config.instructions)
    ? config.instructions.filter((item): item is string => typeof item === "string")
    : [];
  config.instructions = unique([...instructions, ...patch.instructions]);

  const skills = config.skills;
  if (Array.isArray(skills)) {
    config.skills = unique([...skills.filter((item): item is string => typeof item === "string"), ...patch.skillPaths]);
  } else {
    const obj = asObject(skills) ?? {};
    const paths = Array.isArray(obj.paths) ? obj.paths.filter((item): item is string => typeof item === "string") : [];
    obj.paths = unique([...paths, ...patch.skillPaths]);
    config.skills = obj;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

export function commandToolsHint(allowedTools: string[] | undefined): Record<string, boolean> | undefined {
  return claudeToolsToOpenCodeMap(allowedTools);
}
