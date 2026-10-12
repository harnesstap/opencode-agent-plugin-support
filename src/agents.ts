import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter, splitList } from "./frontmatter.js";
import { isDirectory, isFile, walkFiles } from "./fs-utils.js";
import type { FileFilter } from "./safe-path.js";
import { warn } from "./log.js";
import { asPathList, type PluginManifest, resolveComponentPath } from "./manifest.js";
import { claudeToolsToOpenCodeMap } from "./tool-names.js";

export type LoadedAgent = {
  name: string;
  description: string;
  prompt: string;
  model?: string;
  tools?: Record<string, boolean>;
  sourcePath: string;
};

const MODEL_ALIASES: Record<string, string> = {
  sonnet: "anthropic/claude-sonnet-4-5",
  opus: "anthropic/claude-opus-4-5",
  haiku: "anthropic/claude-haiku-4-5",
  inherit: "",
};

export function mapClaudeModel(model: string | undefined): string | undefined {
  if (!model || model === "inherit") return undefined;
  if (model.includes("/")) return model;
  return MODEL_ALIASES[model.toLowerCase()] ?? model;
}

function agentNameFromFile(filePath: string, agentsRoot: string): string {
  const rel = path.relative(agentsRoot, filePath).replace(/\\/g, "/");
  return rel.replace(/\.md$/i, "");
}

function fromMarkdownFile(filePath: string, fallbackName: string): LoadedAgent {
  const raw = fs.readFileSync(filePath, "utf8");
  const { data, body } = parseFrontmatter(raw);
  const name = typeof data.name === "string" ? data.name : fallbackName;
  const description =
    typeof data.description === "string" ? data.description : `Claude plugin agent ${name}`;
  const allowed = splitList(data.tools);
  const denied = splitList(data.disallowedTools ?? data["disallowed-tools"]);
  let tools = claudeToolsToOpenCodeMap(allowed.length ? allowed : undefined);
  if (denied.length > 0) {
    tools = tools ?? {};
    for (const tool of denied) {
      const mapped = claudeToolsToOpenCodeMap([tool]);
      if (mapped) {
        for (const key of Object.keys(mapped)) {
          if (key !== "*") tools[key] = false;
        }
      }
    }
  }
  return {
    name,
    description,
    prompt: body.trim(),
    model: mapClaudeModel(typeof data.model === "string" ? data.model : undefined),
    tools,
    sourcePath: filePath,
  };
}

function tryMarkdownAgent(filePath: string, fallbackName: string, accept?: FileFilter): LoadedAgent | undefined {
  if (accept && !accept(filePath)) return undefined;
  try {
    return fromMarkdownFile(filePath, fallbackName);
  } catch (cause) {
    warn(`skipping agent ${filePath}: ${cause instanceof Error ? cause.message : cause}`);
    return undefined;
  }
}

function collectAgents(abs: string, accept?: FileFilter): LoadedAgent[] {
  if (isFile(abs) && abs.endsWith(".md")) {
    const loaded = tryMarkdownAgent(abs, path.basename(abs, path.extname(abs)), accept);
    return loaded ? [loaded] : [];
  }
  if (!isDirectory(abs)) return [];
  return walkFiles(abs, (file) => file.endsWith(".md"))
    .map((file) => tryMarkdownAgent(file, agentNameFromFile(file, abs), accept))
    .filter((item): item is LoadedAgent => Boolean(item));
}

export function loadAgents(pluginRoot: string, manifest: PluginManifest, accept?: FileFilter): LoadedAgent[] {
  if (manifest.agents === undefined) {
    return collectAgents(path.join(pluginRoot, "agents"), accept);
  }
  const out: LoadedAgent[] = [];
  for (const rel of asPathList(manifest.agents)) {
    try {
      out.push(...collectAgents(resolveComponentPath(pluginRoot, rel), accept));
    } catch {
      // skip
    }
  }
  return out;
}
