import net from "node:net";
import path from "node:path";
import { mcpSchemaId } from "./ap-manifest.js";
import { JsonParseError, readJsonFile } from "./fs-utils.js";
import { isRecord } from "./manifest.js";
import type { OpenCodeMcp } from "./mcp.js";
import { kindOf, realpathOrUndefined, resolveWithin } from "./safe-path.js";

export type McpSkip = { server: string; reason: string };

export type AgentMcpResult = {
  servers: Record<string, OpenCodeMcp>;
  /** Servers left out, with why: invalid entry, or a transport OpenCode cannot run. */
  skipped: McpSkip[];
  /** Set when `mcp.json` as a whole was rejected; MCP is then off for the plugin. */
  disabled?: string;
};

export type AgentMcpInput = {
  /** Symlink-resolved plugin root. */
  realRoot: string;
  /** Per-plugin data directory; must already exist. */
  pluginData: string;
  /** Agent Plugins version from `plugin.json`; `mcp.json` must declare the same one. */
  schemaVersion: string;
  platform?: NodeJS.Platform;
};

const STDIO_KEYS = new Set(["type", "command", "args", "env", "cwd"]);
const REMOTE_KEYS = new Set(["type", "url", "headers"]);
const RESERVED_ENV = ["PLUGIN_ROOT", "PLUGIN_DATA"];
const CWD_FORM = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const OPENCODE_UNSUPPORTED: Record<string, string> = {
  sse: "legacy HTTP+SSE is not supported by OpenCode (no SSE client)",
};

type Stdio = { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string };
type Remote = { type: "streamable-http" | "sse"; url: string; headers: Record<string, string> };
type Checked = { ok: true; server: Stdio | Remote } | { ok: false; reason: string };

function stringRecord(value: unknown, label: string): Record<string, string> | string {
  if (!isRecord(value)) return `"${label}" must be an object`;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return `"${label}.${key}" must be a string`;
    out[key] = item;
  }
  return out;
}

function unknownFields(spec: Record<string, unknown>, allowed: Set<string>): string | undefined {
  const extra = Object.keys(spec).filter((key) => !allowed.has(key));
  return extra.length ? `unknown field${extra.length > 1 ? "s" : ""} ${extra.map((key) => `"${key}"`).join(", ")}` : undefined;
}

function isReservedEnvName(name: string, platform: NodeJS.Platform): boolean {
  const compare = platform === "win32" ? name.toUpperCase() : name;
  return RESERVED_ENV.includes(compare);
}

/** Structural checks of one server entry (Agent Plugins §7.2.1); no filesystem access. */
export function checkServerShape(spec: unknown, platform: NodeJS.Platform = process.platform): Checked {
  if (!isRecord(spec)) return { ok: false, reason: "server entry must be an object" };
  const type = spec.type;
  if (typeof type !== "string") return { ok: false, reason: `"type" is required` };

  if (type === "stdio") {
    const extra = unknownFields(spec, STDIO_KEYS);
    if (extra) return { ok: false, reason: `${extra} for a stdio server` };
    if (typeof spec.command !== "string" || spec.command === "") {
      return { ok: false, reason: `"command" is required and must be a non-empty string` };
    }
    let args: string[] = [];
    if (spec.args !== undefined) {
      if (!Array.isArray(spec.args) || spec.args.some((item) => typeof item !== "string")) {
        return { ok: false, reason: `"args" must be an array of strings` };
      }
      args = spec.args as string[];
    }
    let env: Record<string, string> = {};
    if (spec.env !== undefined) {
      const parsed = stringRecord(spec.env, "env");
      if (typeof parsed === "string") return { ok: false, reason: parsed };
      const reserved = Object.keys(parsed).find((key) => isReservedEnvName(key, platform));
      if (reserved) return { ok: false, reason: `"env" must not define ${reserved}; the client provides it` };
      env = parsed;
    }
    if (spec.cwd !== undefined && typeof spec.cwd !== "string") return { ok: false, reason: `"cwd" must be a string` };
    return { ok: true, server: { type, command: spec.command, args, env, cwd: spec.cwd as string | undefined } };
  }

  if (type === "streamable-http" || type === "sse") {
    const extra = unknownFields(spec, REMOTE_KEYS);
    if (extra) return { ok: false, reason: `${extra} for a ${type} server` };
    if (typeof spec.url !== "string" || spec.url === "") {
      return { ok: false, reason: `"url" is required and must be a non-empty string` };
    }
    const urlProblem = checkRemoteUrl(spec.url);
    if (urlProblem) return { ok: false, reason: `"url" ${urlProblem}` };
    let headers: Record<string, string> = {};
    if (spec.headers !== undefined) {
      const parsed = stringRecord(spec.headers, "headers");
      if (typeof parsed === "string") return { ok: false, reason: parsed };
      const seen = new Set<string>();
      for (const [name, value] of Object.entries(parsed)) {
        if (!HEADER_NAME.test(name)) return { ok: false, reason: `header name ${JSON.stringify(name)} is not a valid HTTP field name` };
        if (!HEADER_VALUE.test(value)) return { ok: false, reason: `header ${JSON.stringify(name)} has an invalid value` };
        const folded = name.toLowerCase();
        if (seen.has(folded)) return { ok: false, reason: `header ${JSON.stringify(name)} is defined twice with different casing` };
        seen.add(folded);
      }
      headers = parsed;
    }
    return { ok: true, server: { type, url: spec.url, headers } };
  }

  return { ok: false, reason: `unknown "type" ${JSON.stringify(type)} (expected stdio, streamable-http or sse)` };
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (net.isIPv4(bare)) return bare.startsWith("127.");
  if (!net.isIPv6(bare)) return false;
  const groups = expandIpv6(bare);
  if (!groups) return false;
  const loopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff && groups[6]! >> 8 === 127;
  return loopback || mapped;
}

function expandIpv6(address: string): number[] | undefined {
  const [head = "", tail, ...rest] = address.split("::");
  if (rest.length) return undefined;
  const toGroups = (part: string): number[] =>
    part === "" ? [] : part.split(":").flatMap((item) => {
      if (item.includes(".")) {
        const octets = item.split(".").map(Number);
        return [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
      }
      return [Number.parseInt(item, 16)];
    });
  const first = toGroups(head);
  if (tail === undefined) return first.length === 8 ? first : undefined;
  const last = toGroups(tail);
  const zeros = 8 - first.length - last.length;
  return zeros < 0 ? undefined : [...first, ...Array<number>(zeros).fill(0), ...last];
}

/** Remote URL rules of Agent Plugins §7.2.1. Returns a problem description, or undefined when valid. */
export function checkRemoteUrl(url: string): string | undefined {
  if (/[\u0000-\u0020\u007f]/.test(url)) return "contains whitespace or control characters";
  if (!/^https?:\/\//i.test(url)) return "must be an absolute http(s) URL";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "is not a valid URL";
  }
  if (!parsed.hostname) return "has no host";
  if (url.includes("#")) return "must not contain a fragment";
  const authority = url.slice(url.indexOf("//") + 2).split(/[/?#]/, 1)[0] ?? "";
  if (authority.includes("@")) return "must not contain user information";
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    return "must use https unless the host is localhost or a loopback address";
  }
  return undefined;
}

function expandPluginVars(value: string, root: string, data: string): string {
  return value.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g, (_match, name: string) => (name === "PLUGIN_ROOT" ? root : data));
}

function resolveCommand(command: string, realRoot: string): { command: string } | { reason: string } {
  if (command.startsWith("./")) {
    const absolute = path.resolve(realRoot, command);
    const within = resolveWithin(realRoot, absolute);
    if (!within.ok) return { reason: `"command" ${within.reason}` };
    if (kindOf(absolute) === "directory") return { reason: `"command" ${JSON.stringify(command)} is a directory` };
    return { command: absolute };
  }
  if (/[\\/]/.test(command) || /[\s\u0000-\u001f]/.test(command)) {
    return {
      reason: `"command" ${JSON.stringify(command)} must be one executable token: a bare name or a "./" path inside the plugin`,
    };
  }
  return { command };
}

function resolveCwd(cwd: string, realRoot: string, realData: string): { cwd: string } | { reason: string } {
  if (!CWD_FORM.test(cwd)) {
    return { reason: `"cwd" ${JSON.stringify(cwd)} must start with "./", \${PLUGIN_ROOT} or \${PLUGIN_DATA}` };
  }
  const dataRooted = cwd.startsWith("${PLUGIN_DATA}");
  const absolute = cwd.startsWith("./") ? path.resolve(realRoot, cwd) : path.resolve(expandPluginVars(cwd, realRoot, realData));
  const within = resolveWithin(dataRooted ? realData : realRoot, absolute);
  if (!within.ok) return { reason: `"cwd" ${within.reason}` };
  return { cwd: absolute };
}

/**
 * Load `<realRoot>/mcp.json` under the Agent Plugins 1.0.0 rules and map it to OpenCode MCP
 * config. A bad file disables MCP for the plugin; a bad entry skips only that server.
 */
export function loadAgentMcp(input: AgentMcpInput): AgentMcpResult {
  const { realRoot, schemaVersion } = input;
  const platform = input.platform ?? process.platform;
  const result: AgentMcpResult = { servers: {}, skipped: [] };
  const file = path.join(realRoot, "mcp.json");
  const kind = kindOf(file);
  if (kind === "missing") return result;
  if (kind !== "file") return { ...result, disabled: "mcp.json is not a regular file" };
  const within = resolveWithin(realRoot, file);
  if (!within.ok) return { ...result, disabled: `mcp.json ${within.reason}` };

  let raw: unknown;
  try {
    raw = readJsonFile<unknown>(file);
  } catch (cause) {
    return { ...result, disabled: cause instanceof JsonParseError ? "mcp.json is not valid JSON" : String(cause) };
  }
  if (!isRecord(raw)) return { ...result, disabled: "mcp.json must contain a JSON object" };
  const extra = Object.keys(raw).filter((key) => key !== "$schema" && key !== "mcpServers");
  if (extra.length) return { ...result, disabled: `mcp.json has unknown top-level field ${extra.map((key) => `"${key}"`).join(", ")}` };

  const schema = raw.$schema;
  if (typeof schema !== "string") return { ...result, disabled: `mcp.json is missing "$schema"` };
  if (schema !== mcpSchemaId(schemaVersion)) {
    const declared = /^https:\/\/agent-plugins\.org\/schemas\/([^/]+)\/mcp\.schema\.json$/.exec(schema)?.[1];
    return {
      ...result,
      disabled: declared
        ? `mcp.json targets Agent Plugins ${declared} but plugin.json targets ${schemaVersion}`
        : `mcp.json has an unrecognized "$schema" ${schema}`,
    };
  }
  if (!isRecord(raw.mcpServers)) return { ...result, disabled: `mcp.json "mcpServers" must be an object` };

  const realData = realpathOrUndefined(input.pluginData) ?? input.pluginData;
  for (const [name, spec] of Object.entries(raw.mcpServers)) {
    const checked = checkServerShape(spec, platform);
    if (!checked.ok) {
      result.skipped.push({ server: name, reason: `invalid server: ${checked.reason}` });
      continue;
    }
    const server = checked.server;
    if (server.type === "stdio") {
      const command = resolveCommand(server.command, realRoot);
      if ("reason" in command) {
        result.skipped.push({ server: name, reason: `invalid server: ${command.reason}` });
        continue;
      }
      let cwd = realRoot;
      if (server.cwd !== undefined) {
        const resolved = resolveCwd(server.cwd, realRoot, realData);
        if ("reason" in resolved) {
          result.skipped.push({ server: name, reason: `invalid server: ${resolved.reason}` });
          continue;
        }
        cwd = resolved.cwd;
      }
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(server.env)) env[key] = expandPluginVars(value, realRoot, realData);
      env.PLUGIN_ROOT = realRoot;
      env.PLUGIN_DATA = realData;
      result.servers[name] = {
        type: "local",
        command: [command.command, ...server.args.map((arg) => expandPluginVars(arg, realRoot, realData))],
        enabled: true,
        environment: env,
        cwd,
      };
      continue;
    }
    const unsupported = OPENCODE_UNSUPPORTED[server.type];
    if (unsupported) {
      result.skipped.push({ server: name, reason: `unsupported transport "${server.type}": ${unsupported}` });
      continue;
    }
    result.servers[name] = {
      type: "remote",
      url: server.url,
      enabled: true,
      ...(Object.keys(server.headers).length ? { headers: server.headers } : {}),
    };
  }
  return result;
}
