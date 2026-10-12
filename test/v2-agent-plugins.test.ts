import { cpSync, realpathSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import { createClaudeCodeBridge } from "../src/index.js";
import type { V2PluginContext } from "../src/v2.js";
import { apDemo, machine, useTestEnvironment, writeJson } from "./helpers.js";

const env = useTestEnvironment("ocp-v2ap-");
const previousHome = process.env.HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

function configured() {
  const m = machine(env.tmp);
  const dir = path.join(m.home, "pkgs");
  cpSync(apDemo, path.join(dir, "ap-demo"), { recursive: true });
  writeJson(path.join(m.home, ".agents", "agent-plugin-support.json"), { sources: [{ path: dir, format: "agent-plugins", label: "pkgs" }] });
  process.env.HOME = m.home;
  return { ...m, root: realpathSync(path.join(dir, "ap-demo")) };
}

describe("Agent Plugins through the OpenCode entry points", () => {
  it("v2 setup registers skills, commands, MCP, agents and hooks from a configured agent-plugins source", async () => {
    const m = configured();
    const skills: Array<Record<string, unknown>> = [];
    const commands: Array<Record<string, unknown>> = [];
    const mcp = new Map<string, Record<string, unknown>>();
    const agents = new Map<string, Record<string, unknown>>();
    const hooks: Record<string, (event: Record<string, unknown>) => unknown> = {};
    const ctx: V2PluginContext = {
      location: { directory: m.cwd },
      skill: { transform: async (cb) => cb({ get: () => undefined, add: (skill) => void skills.push(skill) }) },
      command: { transform: async (cb) => cb({ add: (command) => void commands.push(command) }) },
      mcp: { transform: async (cb) => cb({ set: (name, config) => void mcp.set(name, config) }) },
      agent: {
        transform: async (cb) =>
          cb({
            update: (id, update) => {
              const current = agents.get(id) ?? { id };
              update(current);
              agents.set(id, current);
            },
          }),
      },
      session: { hook: async (name, callback) => void (hooks[`session.${name}`] = callback), prompt: async () => undefined },
    };
    await plugin.setup(ctx);

    expect(skills.map((skill) => skill.id)).toEqual(["greet"]);
    expect(commands.map((command) => command.name).sort()).toEqual(["ap-demo:greet", "ap-demo:hello", "ap-demo:inline-hi"]);
    expect([...agents.keys()]).toEqual(["ap-demo:helper"]);
    expect([...mcp.keys()].sort()).toEqual(["ap-demo:bundled", "ap-demo:local-http", "ap-demo:remote", "ap-demo:whoami"]);

    const whoami = mcp.get("ap-demo:whoami") as { type: string; disabled: boolean; environment: Record<string, string>; command: string[] };
    expect(whoami).toMatchObject({ type: "local", disabled: false });
    expect(whoami.environment.PLUGIN_ROOT).toBe(m.root);
    expect(whoami.command[1]).toBe(path.join(m.root, "mcp-server.mjs"));
    expect(mcp.get("ap-demo:remote")).toMatchObject({ type: "remote", url: "https://example.com/mcp", disabled: false });

    const context = { system: [] as unknown[], sessionID: "s1" };
    hooks["session.context"]!(context);
    expect(JSON.stringify(context.system)).toContain("ap-instructions-ok");
    expect(JSON.stringify(context.system)).not.toContain("must NOT be injected");

    const prompt = { sessionID: "s1", prompt: { text: "hello" } };
    hooks["session.prompt"]!(prompt);
    expect(String((prompt.prompt as { text: string }).text)).toMatch(/ap-hook-ok .*"PLUGIN_ROOT":/);
  });

  it("v1 bridge injects the same components into config", async () => {
    const m = configured();
    const hooks = await createClaudeCodeBridge({ directory: m.cwd });
    const config: Record<string, unknown> = {};
    await hooks.config(config);
    expect(Object.keys(config.command as object).sort()).toEqual(["ap-demo:greet", "ap-demo:hello", "ap-demo:inline-hi"]);
    expect(Object.keys(config.mcp as object).sort()).toEqual(["ap-demo:bundled", "ap-demo:local-http", "ap-demo:remote", "ap-demo:whoami"]);
    expect(Object.keys(config.agent as object)).toEqual(["ap-demo:helper"]);
    const system = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({}, system);
    expect(system.system.join("\n")).toContain("ap-instructions-ok");
  });
});
