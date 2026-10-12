import path from "node:path";
import { JsonParseError, readJsonFile } from "./fs-utils.js";
import { isRecord } from "./manifest.js";
import { kindOf, realpathOrUndefined, resolveWithin } from "./safe-path.js";

/** Agent Plugins version this client implements. 1.1.0 is a working draft and is not accepted. */
export const SUPPORTED_AP_VERSION = "1.0.0";

const SCHEMA_ORIGIN = "https://agent-plugins.org/schemas/";

export function pluginSchemaId(version: string): string {
  return `${SCHEMA_ORIGIN}${version}/plugin.schema.json`;
}

export function mcpSchemaId(version: string): string {
  return `${SCHEMA_ORIGIN}${version}/mcp.schema.json`;
}

const PERMITTED_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

const NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export type AgentPluginsManifest = {
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  extensions?: Record<string, unknown>;
};

export type ManifestParse =
  | {
      ok: true;
      manifest: AgentPluginsManifest;
      version: typeof SUPPORTED_AP_VERSION;
      /** Non-fatal findings (unknown fields, non-object `extensions`) the spec says to report. */
      notes: string[];
    }
  | { ok: false; reason: string };

/** True when `plugin.json` content claims to be an Agent Plugins manifest (any version). */
export function declaresAgentPlugins(raw: unknown): boolean {
  return isRecord(raw) && typeof raw.$schema === "string" && raw.$schema.startsWith(SCHEMA_ORIGIN);
}

export function validatePluginName(name: string): string | undefined {
  if (name.length < 1 || name.length > 64) return "must be 1-64 characters";
  if (!NAME_PATTERN.test(name)) {
    return "may only use a-z, 0-9, '-' and '.', must start and end with a letter or digit, and must not contain '--' or '..'";
  }
  return undefined;
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined | Error {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") return new Error(`"${key}" must be a string`);
  return value;
}

/** Validate parsed `plugin.json` content against the 1.0.0 manifest rules (Agent Plugins §5). */
export function parseAgentPluginsManifest(raw: unknown): ManifestParse {
  if (!isRecord(raw)) return { ok: false, reason: "plugin.json must contain a JSON object" };

  const schema = raw.$schema;
  if (typeof schema !== "string" || !schema) {
    return { ok: false, reason: `required field "$schema" is missing or not a string (expected ${pluginSchemaId(SUPPORTED_AP_VERSION)})` };
  }
  if (schema !== pluginSchemaId(SUPPORTED_AP_VERSION)) {
    const declared = /^https:\/\/agent-plugins\.org\/schemas\/([^/]+)\/plugin\.schema\.json$/.exec(schema)?.[1];
    if (declared) {
      return {
        ok: false,
        reason: `unsupported Agent Plugins version ${declared}; this client supports ${SUPPORTED_AP_VERSION} only`,
      };
    }
    return {
      ok: false,
      reason: `unrecognized "$schema" ${schema}; expected ${pluginSchemaId(SUPPORTED_AP_VERSION)}`,
    };
  }

  if (typeof raw.name !== "string" || raw.name === "") {
    return { ok: false, reason: `required field "name" is missing, empty, or not a string` };
  }
  const nameProblem = validatePluginName(raw.name);
  if (nameProblem) return { ok: false, reason: `invalid "name" ${JSON.stringify(raw.name)}: ${nameProblem}` };

  const manifest: AgentPluginsManifest = { name: raw.name };
  for (const key of ["version", "description", "homepage", "repository", "license"] as const) {
    const value = stringField(raw, key);
    if (value instanceof Error) return { ok: false, reason: value.message };
    if (value !== undefined) manifest[key] = value;
  }

  if (raw.author !== undefined) {
    if (!isRecord(raw.author)) return { ok: false, reason: `"author" must be an object` };
    const author: NonNullable<AgentPluginsManifest["author"]> = {};
    for (const [key, value] of Object.entries(raw.author)) {
      if (key !== "name" && key !== "email" && key !== "url") {
        return { ok: false, reason: `"author" has unsupported field "${key}" (only name, email, url)` };
      }
      if (typeof value !== "string") return { ok: false, reason: `"author.${key}" must be a string` };
      author[key] = value;
    }
    manifest.author = author;
  }

  if (raw.keywords !== undefined) {
    if (!Array.isArray(raw.keywords) || raw.keywords.some((item) => typeof item !== "string")) {
      return { ok: false, reason: `"keywords" must be an array of strings` };
    }
    manifest.keywords = raw.keywords as string[];
  }

  const notes: string[] = [];
  if (raw.extensions !== undefined) {
    if (isRecord(raw.extensions)) manifest.extensions = raw.extensions;
    else notes.push(`"extensions" is not an object; ignoring it`);
  }
  for (const key of Object.keys(raw)) {
    if (!PERMITTED_FIELDS.has(key)) notes.push(`unknown plugin.json field "${key}" ignored`);
  }
  return { ok: true, manifest, version: SUPPORTED_AP_VERSION, notes };
}

/**
 * Read and validate `<realRoot>/plugin.json`. The file must resolve inside the plugin root
 * (a link out of it rejects the plugin, Agent Plugins §4.1).
 */
export function loadAgentPluginsManifest(realRoot: string): ManifestParse {
  const file = path.join(realRoot, "plugin.json");
  if (kindOf(file) === "missing") return { ok: false, reason: "plugin.json not found at the plugin root" };
  if (kindOf(file) !== "file") return { ok: false, reason: "plugin.json is not a regular file" };
  const within = resolveWithin(realRoot, file);
  if (!within.ok) return { ok: false, reason: `plugin.json ${within.reason}` };
  let raw: unknown;
  try {
    raw = readJsonFile<unknown>(file);
  } catch (cause) {
    const detail = cause instanceof JsonParseError ? "not valid JSON" : String(cause);
    return { ok: false, reason: `plugin.json is ${detail}` };
  }
  if (raw === undefined) return { ok: false, reason: "plugin.json is empty" };
  return parseAgentPluginsManifest(raw);
}

/** Result of looking for an Agent Plugins manifest next to a Claude one. */
export type ManifestSniff =
  | { kind: "none" }
  | { kind: "valid"; manifest: AgentPluginsManifest; notes: string[] }
  | { kind: "invalid"; reason: string };

/**
 * Does the plugin at `root` also ship an Agent Plugins manifest? A root `plugin.json` that does
 * not declare an agent-plugins.org `$schema` is somebody else's file and counts as `none`.
 */
export function sniffAgentPluginsManifest(root: string): ManifestSniff {
  const realRoot = realpathOrUndefined(root);
  if (!realRoot) return { kind: "none" };
  const file = path.join(realRoot, "plugin.json");
  if (kindOf(file) !== "file") return { kind: "none" };
  let raw: unknown;
  try {
    raw = readJsonFile<unknown>(file);
  } catch {
    return { kind: "none" };
  }
  if (!declaresAgentPlugins(raw)) return { kind: "none" };
  const parsed = loadAgentPluginsManifest(realRoot);
  return parsed.ok ? { kind: "valid", manifest: parsed.manifest, notes: parsed.notes } : { kind: "invalid", reason: parsed.reason };
}
