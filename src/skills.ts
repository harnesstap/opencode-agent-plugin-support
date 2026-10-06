import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { isDirectory, isFile, walkFiles } from "./fs-utils.js";
import { asPathList, type PluginManifest, resolveComponentPath } from "./manifest.js";

export type LoadedSkill = {
  name: string;
  description: string;
  dir: string;
  filePath: string;
  body: string;
  frontmatter: Record<string, unknown>;
};

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function skillSearchRoots(pluginRoot: string, manifest: PluginManifest): string[] {
  const roots = new Set<string>();
  const defaultDir = path.join(pluginRoot, "skills");
  if (isDirectory(defaultDir)) roots.add(defaultDir);
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
  for (const root of skillSearchRoots(pluginRoot, manifest)) {
    const files = isFile(path.join(root, "SKILL.md"))
      ? [path.join(root, "SKILL.md")]
      : walkFiles(root, (file) => path.basename(file) === "SKILL.md");
    for (const filePath of files) {
      const raw = fs.readFileSync(filePath, "utf8");
      const { data, body } = parseFrontmatter(raw);
      const dir = path.dirname(filePath);
      const fromFm = typeof data.name === "string" ? data.name : undefined;
      const name = fromFm || path.basename(dir);
      const description = typeof data.description === "string" ? data.description : "";
      skills.push({ name, description, dir, filePath, body, frontmatter: data });
    }
  }
  return skills;
}

export function isOpenCodeSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && SKILL_NAME.test(name);
}
