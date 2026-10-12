import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter, splitList } from "./frontmatter.js";
import { isDirectory, isFile, walkFiles } from "./fs-utils.js";
import type { FileFilter } from "./safe-path.js";
import { warn } from "./log.js";
import {
  asPathList,
  isRecord,
  type InlineCommand,
  type PluginManifest,
  resolveComponentPath,
} from "./manifest.js";

export type LoadedCommand = {
  name: string;
  description?: string;
  template: string;
  model?: string;
  argumentHint?: string;
  allowedTools?: string[];
  agent?: string;
  sourcePath?: string;
};

function commandNameFromFile(filePath: string, commandsRoot: string): string {
  const rel = path.relative(commandsRoot, filePath).replace(/\\/g, "/");
  return rel.replace(/\.md$/i, "");
}

function fromMarkdownFile(filePath: string, name: string): LoadedCommand {
  const raw = fs.readFileSync(filePath, "utf8");
  const { data, body } = parseFrontmatter(raw);
  return {
    name,
    description: typeof data.description === "string" ? data.description : undefined,
    template: body.trim(),
    model: typeof data.model === "string" ? data.model : undefined,
    argumentHint:
      typeof data["argument-hint"] === "string"
        ? data["argument-hint"]
        : typeof data.argumentHint === "string"
          ? data.argumentHint
          : undefined,
    allowedTools: splitList(data["allowed-tools"] ?? data.allowedTools),
    agent: typeof data.agent === "string" ? data.agent : undefined,
    sourcePath: filePath,
  };
}

function tryMarkdownCommand(filePath: string, name: string, accept?: FileFilter): LoadedCommand | undefined {
  if (accept && !accept(filePath)) return undefined;
  try {
    return fromMarkdownFile(filePath, name);
  } catch (cause) {
    warn(`skipping command ${filePath}: ${cause instanceof Error ? cause.message : cause}`);
    return undefined;
  }
}

function collectMarkdownCommands(abs: string, accept?: FileFilter): LoadedCommand[] {
  if (isFile(abs) && abs.endsWith(".md")) {
    const loaded = tryMarkdownCommand(abs, path.basename(abs, path.extname(abs)), accept);
    return loaded ? [loaded] : [];
  }
  if (!isDirectory(abs)) return [];
  return walkFiles(abs, (file) => file.endsWith(".md"))
    .map((file) => tryMarkdownCommand(file, commandNameFromFile(file, abs), accept))
    .filter((item): item is LoadedCommand => Boolean(item));
}

export function loadCommands(pluginRoot: string, manifest: PluginManifest, accept?: FileFilter): LoadedCommand[] {
  const declared = manifest.commands;
  if (declared === undefined) {
    return collectMarkdownCommands(path.join(pluginRoot, "commands"), accept);
  }
  if (typeof declared === "string" || Array.isArray(declared)) {
    const out: LoadedCommand[] = [];
    for (const rel of asPathList(declared)) {
      try {
        out.push(...collectMarkdownCommands(resolveComponentPath(pluginRoot, rel), accept));
      } catch {
        // skip
      }
    }
    return out;
  }
  if (!isRecord(declared)) return [];
  const out: LoadedCommand[] = [];
  for (const [name, spec] of Object.entries(declared)) {
    if (!isRecord(spec)) continue;
    const entry = spec as InlineCommand;
    if (typeof entry.source === "string") {
      try {
        const filePath = resolveComponentPath(pluginRoot, entry.source);
        if (accept && !accept(filePath)) continue;
        const loaded = fromMarkdownFile(filePath, name);
        out.push({
          ...loaded,
          description: entry.description ?? loaded.description,
          argumentHint: entry.argumentHint ?? loaded.argumentHint,
          model: entry.model ?? loaded.model,
          allowedTools: entry.allowedTools ?? loaded.allowedTools,
        });
      } catch (cause) {
        warn(`skipping command "${name}": ${cause instanceof Error ? cause.message : cause}`);
      }
      continue;
    }
    if (typeof entry.content === "string") {
      out.push({
        name,
        description: entry.description,
        template: entry.content,
        model: entry.model,
        argumentHint: entry.argumentHint,
        allowedTools: entry.allowedTools,
      });
    }
  }
  return out;
}
