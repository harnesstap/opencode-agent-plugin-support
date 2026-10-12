import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, vi } from "vitest";
import { DEBUG_ENV } from "../src/identity.js";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const fixtures = path.join(here, "fixtures");
export const apDemo = path.join(fixtures, "agent-plugins", "ap-demo");
export const dualFixture = path.join(fixtures, "agent-plugins", "dual-plugin");
export const demoPlugin = path.join(fixtures, "demo-plugin");
export const conformance = path.join(fixtures, "agent-plugins-conformance");
export const specSchemas = path.join(fixtures, "agent-plugins-spec", "schemas");

export const AP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const AP_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

export const symlinksSupported = process.platform !== "win32";

/** Temp dirs and a silenced, inspectable console.warn, cleaned up after every test. */
export function useTestEnvironment(prefix = "ocp-"): {
  tmp: () => string;
  warnings: () => string[];
} {
  const temps: string[] = [];
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    delete process.env[DEBUG_ENV];
    while (temps.length) {
      const dir = temps.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
  return {
    tmp: () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
      temps.push(dir);
      return dir;
    },
    warnings: () => warnSpy.mock.calls.map((call) => String(call[0])),
  };
}

export function writeText(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function writeJson(file: string, value: unknown): void {
  writeText(file, JSON.stringify(value, null, 2));
}

export function validSkill(name: string, description = "A skill."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`;
}

/** Minimal valid Agent Plugins package. */
export function writeAgentPlugin(root: string, name = "pkg", extra: Record<string, unknown> = {}): void {
  writeJson(path.join(root, "plugin.json"), { $schema: AP_SCHEMA, name, ...extra });
}

export function writeMcp(root: string, servers: Record<string, unknown>, schema: string = AP_MCP_SCHEMA): void {
  writeJson(path.join(root, "mcp.json"), { $schema: schema, mcpServers: servers });
}

export type Machine = { home: string; cwd: string; paths: { home: string; cwd: string; env: NodeJS.ProcessEnv } };

export function machine(tmp: () => string): Machine {
  const home = tmp();
  const cwd = tmp();
  return { home, cwd, paths: { home, cwd, env: process.env } };
}
