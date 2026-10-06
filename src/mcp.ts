import path from "node:path";
import { expandDeep, type ExpandContext } from "./expand.js";
import { isFile, readJsonFile } from "./fs-utils.js";
import { asPathList, isRecord, type PluginManifest, resolveComponentPath } from "./manifest.js";

export type OpenCodeMcpLocal = {
  type: "local";
  command: string[];
  enabled?: boolean;
  environment?: Record<string, string>;
  cwd?: string;
};

export type OpenCodeMcpRemote = {
  type: "remote";
  url: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  oauth?: false | Record<string, unknown>;
};

export type OpenCodeMcp = OpenCodeMcpLocal | OpenCodeMcpRemote;

function envRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (nested === undefined || nested === null) continue;
    out[key] = String(nested);
  }
  return Object.keys(out).length ? out : undefined;
}

export function claudeMcpToOpenCode(name: string, spec: unknown, ctx: ExpandContext): OpenCodeMcp | undefined {
  if (typeof spec === "string") {
    const expanded = expandDeep(spec, ctx);
    if (expanded.startsWith("http://") || expanded.startsWith("https://")) {
      return { type: "remote", url: expanded, enabled: true };
    }
    return undefined;
  }
  if (!isRecord(spec)) return undefined;
  const expanded = expandDeep(spec, ctx);
  const url = typeof expanded.url === "string" ? expanded.url : undefined;
  const type = typeof expanded.type === "string" ? expanded.type : undefined;
  if (url && (type === "http" || type === "sse" || type === "ws" || type === "remote" || !expanded.command)) {
    return {
      type: "remote",
      url,
      enabled: expanded.disabled === true ? false : true,
      headers: envRecord(expanded.headers),
    };
  }
  const command = typeof expanded.command === "string" ? expanded.command : undefined;
  if (!command) return undefined;
  const args = Array.isArray(expanded.args) ? expanded.args.map((item) => String(item)) : [];
  return {
    type: "local",
    command: [command, ...args],
    enabled: expanded.disabled === true ? false : true,
    environment: envRecord(expanded.env ?? expanded.environment),
    cwd: typeof expanded.cwd === "string" ? expanded.cwd : ctx.pluginRoot,
  };
}

function serversFromObject(value: unknown, ctx: ExpandContext): Record<string, OpenCodeMcp> {
  const source = isRecord(value) && isRecord(value.mcpServers) ? value.mcpServers : value;
  if (!isRecord(source)) return {};
  const out: Record<string, OpenCodeMcp> = {};
  for (const [name, spec] of Object.entries(source)) {
    const mapped = claudeMcpToOpenCode(name, spec, ctx);
    if (mapped) out[name] = mapped;
  }
  return out;
}

function loadMcpFile(filePath: string, ctx: ExpandContext): Record<string, OpenCodeMcp> {
  if (!isFile(filePath)) return {};
  return serversFromObject(readJsonFile<unknown>(filePath), ctx);
}

export function loadMcpServers(
  pluginRoot: string,
  manifest: PluginManifest,
  ctx: ExpandContext,
): Record<string, OpenCodeMcp> {
  const merged: Record<string, OpenCodeMcp> = {
    ...loadMcpFile(path.join(pluginRoot, ".mcp.json"), ctx),
  };
  const declared = manifest.mcpServers;
  if (declared === undefined) return merged;
  const pieces = Array.isArray(declared) ? declared : [declared];
  for (const piece of pieces) {
    if (typeof piece === "string") {
      if (piece.endsWith(".json")) {
        try {
          Object.assign(merged, loadMcpFile(resolveComponentPath(pluginRoot, piece), ctx));
        } catch {
          // skip
        }
      }
      continue;
    }
    Object.assign(merged, serversFromObject(piece, ctx));
  }
  return merged;
}
