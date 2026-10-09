import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import plugin, { PLUGIN_ID, setup } from "../src/index.js";
import type { V2PluginContext } from "../src/v2.js";

const temps: string[] = [];
const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/demo-plugin");

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ocp-v2-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("v2 default export", () => {
  it("exports id + setup + v1 server", () => {
    expect(plugin.id).toBe("opencode-claude-plugins");
    expect(plugin.id).toBe(PLUGIN_ID);
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");
    expect(typeof setup).toBe("function");
  });

  it("no-ops when ctx is V1-shaped (no skill.transform)", async () => {
    const result = await plugin.setup({ location: { directory: tmp() } });
    expect(result).toBeUndefined();
  });

  it("registers skills, commands, mcp, agents, and hooks from extraPluginDirs", async () => {
    const skills: Array<Record<string, unknown>> = [];
    const commands: Array<Record<string, unknown>> = [];
    const mcp = new Map<string, Record<string, unknown>>();
    const agents = new Map<string, Record<string, unknown>>();
    const hooks: string[] = [];
    let promptHook: ((event: Record<string, unknown>) => unknown) | undefined;
    let contextHook: ((event: Record<string, unknown>) => unknown) | undefined;
    let beforeHook: ((event: Record<string, unknown>) => unknown) | undefined;
    let afterHook: ((event: Record<string, unknown>) => unknown) | undefined;
    let permHook: ((event: Record<string, unknown>) => unknown) | undefined;
    let compactHook: ((event: Record<string, unknown>) => unknown) | undefined;

    const ctx: V2PluginContext = {
      options: {
        skipInstalled: true,
        extraPluginDirs: { "fixture-demo@local": fixtureRoot },
      },
      location: { directory: tmp() },
      skill: {
        transform: async (cb) => {
          cb({
            get: (id) => skills.find((s) => s.id === id),
            add: (skill) => {
              skills.push(skill);
            },
          });
        },
      },
      command: {
        transform: async (cb) => {
          cb({ add: (command) => commands.push(command) });
        },
      },
      mcp: {
        transform: async (cb) => {
          cb({
            set: (name, config) => {
              mcp.set(name, config);
            },
          });
        },
      },
      agent: {
        transform: async (cb) => {
          cb({
            update: (id, update) => {
              const current = agents.get(id) ?? { id };
              update(current);
              agents.set(id, current);
            },
          });
        },
      },
      session: {
        hook: async (name, callback) => {
          hooks.push(`session.${name}`);
          if (name === "prompt") promptHook = callback;
          if (name === "context") contextHook = callback;
          if (name === "compaction") compactHook = callback;
        },
        prompt: async () => undefined,
      },
      tool: {
        hook: async (name, callback) => {
          hooks.push(`tool.${name}`);
          if (name === "execute.before") beforeHook = callback;
          if (name === "execute.after") afterHook = callback;
        },
      },
      permission: {
        hook: async (name, callback) => {
          hooks.push(`permission.${name}`);
          if (name === "evaluate") permHook = callback;
        },
      },
      shell: {
        hook: async (name) => {
          hooks.push(`shell.${name}`);
        },
      },
    };

    await plugin.setup(ctx);

    expect(skills.map((s) => s.id)).toEqual(expect.arrayContaining(["demo-skill", "legacy-context", "hello"]));
    expect(skills.map((s) => s.id)).not.toContain("manual-deploy");
    expect(commands.map((c) => c.name)).toContain("fixture-demo:hello");
    expect(commands.map((c) => c.name)).toContain("fixture-demo:demo-skill");
    expect(commands.map((c) => c.name)).toContain("fixture-demo:manual-deploy");
    expect(commands.map((c) => c.name)).not.toContain("fixture-demo:legacy-context");
    const demoSkillCmd = commands.find((c) => c.name === "fixture-demo:demo-skill");
    expect(String(demoSkillCmd?.template)).toContain("fixture-skill-ok");
    expect(String(demoSkillCmd?.template)).toContain("$ARGUMENTS");
    const helloCmd = commands.find((c) => c.name === "fixture-demo:hello");
    expect(String(helloCmd?.template)).toContain("fixture-command-ok");
    expect(helloCmd?.argumentHint).toBe("[name]");
    expect(commands.find((c) => c.name === "fixture-demo:manual-deploy")?.argumentHint).toBe("[target]");
    expect(mcp.get("fixture-demo:echo-api")?.type).toBe("local");
    expect(mcp.get("fixture-demo:echo-api")?.disabled).toBe(false);
    expect(agents.get("fixture-demo:reviewer")?.mode).toBe("subagent");
    expect(agents.get("fixture-demo:reviewer")?.system).toContain("fixture-agent-ok");
    expect(hooks).toEqual(
      expect.arrayContaining([
        "session.context",
        "session.prompt",
        "session.compaction",
        "tool.execute.before",
        "tool.execute.after",
        "permission.evaluate",
        "shell.create.before",
      ]),
    );

    const system: Array<{ type: string; text: string }> = [];
    contextHook?.({ sessionID: "s1", system });
    expect(system.some((part) => part.text.includes("fixture-instructions-ok"))).toBe(true);
    expect(system.some((part) => part.text.includes("fixture-session-ok"))).toBe(true);
    const again: Array<{ type: string; text: string }> = [];
    contextHook?.({ sessionID: "s1", system: again });
    expect(again.some((part) => part.text.includes("fixture-session-ok"))).toBe(true);

    const promptEvent = { sessionID: "s1", prompt: { text: "hello" } };
    promptHook?.(promptEvent);
    expect(String((promptEvent.prompt as { text: string }).text)).toContain("fixture-prompt-ok");

    expect(() => {
      void beforeHook?.({
        tool: "shell",
        sessionID: "s1",
        id: "c1",
        input: { command: "echo BLOCKME" },
      });
    }).toThrow(/blocked/i);

    const rewrite = { tool: "shell", sessionID: "s1", id: "c2", input: { command: "echo REWRITE" } };
    await beforeHook?.(rewrite);
    expect((rewrite.input as { command: string }).command).toBe("echo rewritten");

    const after = {
      tool: "patch",
      status: "completed",
      sessionID: "s1",
      id: "c3",
      input: {},
      result: { content: "edited" },
    };
    await afterHook?.(after);
    expect(String((after.result as { content: string }).content)).toContain("fixture-post-tool-ok");

    const perm = { sessionID: "s1", action: "shell", resources: [], effect: "ask" };
    permHook?.(perm);
    expect(["ask", "allow", "deny"]).toContain(perm.effect);

    const compact = { sessionID: "s1", system: [] as Array<{ type: string; text: string }>, trigger: "auto" };
    compactHook?.(compact);
  });

  it("does not load installed plugins from other projects when skipInstalled is false", async () => {
    const home = tmp();
    const cwd = tmp();
    mkdirSync(path.join(home, ".agents", "plugins"), { recursive: true });
    writeFileSync(
      path.join(home, ".agents", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "ghost@m": [
            {
              scope: "project",
              projectPath: "/somewhere-else",
              installPath: path.join(home, "missing-ghost"),
            },
          ],
        },
      }),
    );
    const previous = process.env.HOME;
    process.env.HOME = home;
    const skills: string[] = [];
    try {
      await plugin.setup({
        location: { directory: cwd },
        skill: {
          transform: async (cb) => {
            cb({ add: (skill) => skills.push(skill.id) });
          },
        },
        session: { hook: async () => undefined },
        command: { transform: async () => undefined },
        mcp: { transform: async () => undefined },
        agent: { transform: async () => undefined },
        tool: { hook: async () => undefined },
      });
      expect(skills).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  });
});
