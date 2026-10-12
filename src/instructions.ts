import fs from "node:fs";
import path from "node:path";
import { expandString, type ExpandContext } from "./expand.js";
import { isFile } from "./fs-utils.js";

export type LoadedInstructions = {
  files: string[];
  texts: string[];
};

const CANDIDATES = ["INSTRUCTIONS.md", "instructions.md", "AGENTS.md", "CLAUDE.md"];

/**
 * Claude does not load a plugin-root CLAUDE.md as session context.
 * OpenCode users asked for that mapping, so we still pick up CLAUDE.md /
 * AGENTS.md / INSTRUCTIONS.md when present and inject them as OpenCode
 * `instructions` (file paths) plus system-prompt text.
 */
export function loadInstructions(
  pluginRoot: string,
  pluginName: string,
  ctx: ExpandContext,
  options: { candidates?: string[]; accept?: (filePath: string) => boolean } = {},
): LoadedInstructions {
  const files: string[] = [];
  const texts: string[] = [];
  for (const name of options.candidates ?? CANDIDATES) {
    const filePath = path.join(pluginRoot, name);
    if (!isFile(filePath)) continue;
    if (options.accept && !options.accept(filePath)) continue;
    files.push(filePath);
    const body = expandString(fs.readFileSync(filePath, "utf8"), ctx).trim();
    if (body) {
      texts.push(`# Plugin instructions: ${pluginName} (${name})\n\n${body}`);
    }
  }
  return { files, texts };
}
