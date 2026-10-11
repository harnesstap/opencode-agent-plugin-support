import fs from "node:fs";
import path from "node:path";
import { frontmatterString, parseFrontmatter, parseYamlBoolean } from "./frontmatter.js";
import { isDirectory, isFile, walkFiles } from "./fs-utils.js";
import { warn } from "./log.js";
import { asPathList, type PluginManifest, resolveComponentPath } from "./manifest.js";

export type SkillInvocation = "both" | "user-only" | "model-only" | "hidden";

export type LoadedSkill = {
  name: string;
  description: string;
  dir: string;
  filePath: string;
  body: string;
  frontmatter: Record<string, unknown>;
  argumentHint?: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
};

const ARGUMENT_PLACEHOLDER = /\$ARGUMENTS(?:\[\d+\])?|\$\d+\b/;

export function skillSearchRoots(pluginRoot: string, manifest: PluginManifest): string[] {
  const roots = new Set<string>();
  const defaultDir = path.join(pluginRoot, "skills");
  if (!manifest.replaceDefaultSkills && isDirectory(defaultDir)) roots.add(defaultDir);
  for (const rel of asPathList(manifest.skills)) {
    try {
      roots.add(resolveComponentPath(pluginRoot, rel));
    } catch {
      // skip paths that escape the plugin
    }
  }
  if (roots.size === 0 && isFile(path.join(pluginRoot, "SKILL.md"))) {
    roots.add(pluginRoot);
  }
  return [...roots];
}

export function loadSkills(pluginRoot: string, manifest: PluginManifest): LoadedSkill[] {
  const skills: LoadedSkill[] = [];
  const seen = new Set<string>();
  for (const root of skillSearchRoots(pluginRoot, manifest)) {
    const files = isFile(path.join(root, "SKILL.md"))
      ? [path.join(root, "SKILL.md")]
      : walkFiles(root, (file) => path.basename(file) === "SKILL.md");
    for (const filePath of files) {
      // manifest `skills` paths often overlap the default skills/ dir
      const key = path.resolve(filePath);
      if (seen.has(key)) continue;
      seen.add(key);
      let data: Record<string, unknown>;
      let body: string;
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        ({ data, body } = parseFrontmatter(raw));
      } catch (cause) {
        warn(`skipping skill ${filePath}: ${cause instanceof Error ? cause.message : cause}`);
        continue;
      }
      const dir = path.dirname(filePath);
      const fromFm = typeof data.name === "string" ? data.name : undefined;
      const name = fromFm || path.basename(dir);
      const description = listingDescription(data);
      const argumentHint = frontmatterString(data, "argument-hint", "argumentHint");
      skills.push({
        name,
        description,
        dir,
        filePath,
        body,
        frontmatter: data,
        ...(argumentHint ? { argumentHint } : {}),
        userInvocable: parseYamlBoolean(data["user-invocable"] ?? data.userInvocable, true),
        disableModelInvocation: parseYamlBoolean(
          data["disable-model-invocation"] ?? data.disableModelInvocation,
          false,
        ),
      });
    }
  }
  return skills;
}

function listingDescription(data: Record<string, unknown>): string {
  const description = typeof data.description === "string" ? data.description : "";
  const whenToUse = frontmatterString(data, "when_to_use", "whenToUse");
  return [description, whenToUse].filter(Boolean).join(" ");
}

export function skillInvocation(skill: LoadedSkill): SkillInvocation {
  const user = skill.userInvocable;
  const model = !skill.disableModelInvocation;
  if (user && model) return "both";
  if (user && !model) return "user-only";
  if (!user && model) return "model-only";
  return "hidden";
}

export function isSkillUserInvocable(skill: LoadedSkill): boolean {
  const mode = skillInvocation(skill);
  switch (mode) {
    case "both":
    case "user-only":
      return true;
    case "model-only":
    case "hidden":
      return false;
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

export function isSkillModelInvocable(skill: LoadedSkill): boolean {
  const mode = skillInvocation(skill);
  switch (mode) {
    case "both":
    case "model-only":
      return true;
    case "user-only":
    case "hidden":
      return false;
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

/** Slash-command id: `plugin:skill`. Does not double-prefix if `name` already starts with `plugin:`. */
export function pluginSkillCommandName(pluginName: string, skillName: string): string {
  if (skillName.startsWith(`${pluginName}:`)) return skillName;
  return `${pluginName}:${skillName}`;
}

export function ensureArgumentsPlaceholder(template: string): string {
  return template.includes("$ARGUMENTS") ? template : `${template}\n\n$ARGUMENTS`;
}

export function expandSkillCommandBody(
  body: string,
  dirs: { skillDir: string; pluginRoot: string; pluginData?: string; projectDir?: string },
): string {
  let text = body;
  const replacements: Array<[RegExp, string]> = [
    [/\$\{CLAUDE_SKILL_DIR\}/g, dirs.skillDir],
    [/\$\{CLAUDE_PLUGIN_ROOT\}/g, dirs.pluginRoot],
  ];
  if (dirs.pluginData) replacements.push([/\$\{CLAUDE_PLUGIN_DATA\}/g, dirs.pluginData]);
  if (dirs.projectDir) replacements.push([/\$\{CLAUDE_PROJECT_DIR\}/g, dirs.projectDir]);
  for (const [pattern, value] of replacements) text = text.replace(pattern, value);
  return text;
}

/**
 * Prompt sent when the user runs `/plugin:skill`. Inlines this plugin's SKILL.md
 * so a same-named skill under ~/.config/opencode/skills cannot replace it.
 * `$ARGUMENTS` is substituted by OpenCode (Claude: remaining user text).
 */
export function pluginSkillCommandTemplate(
  pluginName: string,
  pluginRoot: string,
  skill: LoadedSkill,
): string {
  const slash = pluginSkillCommandName(pluginName, skill.name);
  const body = expandSkillCommandBody(skill.body.trim(), {
    skillDir: skill.dir,
    pluginRoot,
  });
  const header = [
    `Use the Claude plugin skill "${slash}" from this plugin file (not a user skill of the same name):`,
    skill.filePath,
    `Skill directory: ${skill.dir}`,
    `If a skill tool is available, load id "${skill.name}" only when that definition is this same file; otherwise follow the inlined instructions.`,
    "",
    body,
  ].join("\n");
  if (ARGUMENT_PLACEHOLDER.test(body)) return header;
  return `${header}\n\n$ARGUMENTS`;
}
