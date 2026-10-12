import fs from "node:fs";
import path from "node:path";
import type { Diagnostics } from "./diagnostics.js";
import { parseFrontmatter } from "./frontmatter.js";
import { isRecord } from "./manifest.js";
import { kindOf, resolveWithin } from "./safe-path.js";
import { buildLoadedSkill, type LoadedSkill } from "./skills.js";

const SKILL_NAME = /^[\p{Ll}\p{Nd}]+(?:-[\p{Ll}\p{Nd}]+)*$/u;

function codePoints(value: string): number {
  return [...value].length;
}

/** Check frontmatter against the Agent Skills specification (https://agentskills.io/specification). */
export function validateSkillFrontmatter(data: Record<string, unknown>, dirName: string): string | undefined {
  const name = data.name;
  if (typeof name !== "string" || name === "") return `"name" is required`;
  if (codePoints(name) > 64 || !SKILL_NAME.test(name)) {
    return `"name" ${JSON.stringify(name)} must be 1-64 lowercase letters, digits and single hyphens, not starting or ending with a hyphen`;
  }
  if (name !== dirName) return `"name" ${JSON.stringify(name)} must match its directory name "${dirName}"`;

  const description = data.description;
  if (typeof description !== "string" || description.trim() === "") return `"description" is required`;
  if (codePoints(description) > 1024) return `"description" is longer than 1024 characters`;

  if (data.license !== undefined && typeof data.license !== "string") return `"license" must be a string`;
  if (data.compatibility !== undefined) {
    if (typeof data.compatibility !== "string" || data.compatibility === "" || codePoints(data.compatibility) > 500) {
      return `"compatibility" must be a string of 1-500 characters`;
    }
  }
  if (data.metadata !== undefined) {
    if (!isRecord(data.metadata) || Object.values(data.metadata).some((value) => typeof value !== "string")) {
      return `"metadata" must map string keys to string values`;
    }
  }
  if (data["allowed-tools"] !== undefined && typeof data["allowed-tools"] !== "string") {
    return `"allowed-tools" must be a space-separated string`;
  }
  return undefined;
}

/**
 * Skills of an Agent Plugins package (§6.1, §7.1): each immediate child directory of `skills/`
 * that holds a regular file named exactly `SKILL.md`. Nothing deeper is searched. A skill that
 * is not valid Agent Skills content, or that resolves outside the plugin root, is skipped and
 * reported; its siblings still load. A `skills` entry that is not a directory (or leaves the
 * root) disables skills for the plugin and nothing else.
 */
export function loadAgentSkills(realRoot: string, diag: Diagnostics): LoadedSkill[] {
  const skillsDir = path.join(realRoot, "skills");
  const kind = kindOf(skillsDir);
  if (kind === "missing") return [];
  if (kind !== "directory") {
    diag.warn(`skills is not a directory; skills disabled`);
    return [];
  }
  const within = resolveWithin(realRoot, skillsDir);
  if (!within.ok) {
    diag.warn(`skills ${within.reason}; skills disabled`);
    return [];
  }

  const skills: LoadedSkill[] = [];
  for (const entry of fs.readdirSync(skillsDir).sort()) {
    const dir = path.join(skillsDir, entry);
    if (kindOf(dir) !== "directory") continue;
    if (!fs.readdirSync(dir).includes("SKILL.md")) continue;
    const file = path.join(dir, "SKILL.md");
    if (kindOf(file) !== "file") continue;
    const contained = resolveWithin(realRoot, file);
    if (!contained.ok) {
      diag.warn(`skipping skill "${entry}": SKILL.md ${contained.reason}`);
      continue;
    }
    let data: Record<string, unknown>;
    let body: string;
    try {
      ({ data, body } = parseFrontmatter(fs.readFileSync(file, "utf8")));
    } catch (cause) {
      diag.warn(`skipping skill "${entry}": ${cause instanceof Error ? cause.message : cause}`);
      continue;
    }
    const problem = validateSkillFrontmatter(data, entry);
    if (problem) {
      diag.warn(`skipping skill "${entry}": ${problem}`);
      continue;
    }
    skills.push(buildLoadedSkill(file, data, body));
  }
  return skills;
}
