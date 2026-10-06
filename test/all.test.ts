import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mapClaudeModel } from "../src/agents.js";
import { loadCommands } from "../src/commands.js";
import { discoverEnabledPlugins, loadPluginFromDirectory } from "../src/discover.js";
import { isPluginEnabled, loadActivation, parsePluginId } from "../src/enablement.js";
import { expandString } from "../src/expand.js";
import { parseFrontmatter, splitList } from "../src/frontmatter.js";
import { interpretHookResult, runHookCommand } from "../src/hook-runtime.js";
import { parseHooksObject } from "../src/hooks.js";
import { parseInstalledPluginsDatabase } from "../src/installed.js";
import { applyConfigPatch, buildConfigPatch } from "../src/inject.js";
import { createClaudeCodeBridge } from "../src/index.js";
import { loadManifestFromRoot, resolveComponentPath } from "../src/manifest.js";
import { loadMcpServers } from "../src/mcp.js";
import { matcherHits, toClaudeTool, toOpenCodeTool } from "../src/tool-names.js";

const temps: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ocp-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("frontmatter", () => {
  it("parses yaml and body", () => {
    const parsed = parseFrontmatter("---\nname: hello\ndescription: hi\n---\n\nBody $ARGUMENTS\n");
    expect(parsed.data.name).toBe("hello");
    expect(parsed.body.trim()).toBe("Body $ARGUMENTS");
  });

  it("splits tool lists", () => {
    expect(splitList("Read, Grep, Glob")).toEqual(["Read", "Grep", "Glob"]);
    expect(splitList(["Read", "Bash"])).toEqual(["Read", "Bash"]);
  });
});

describe("expand", () => {
  it("expands plugin root and env vars", () => {
    const out = expandString("node ${CLAUDE_PLUGIN_ROOT}/s.js --token ${API_KEY}", {
      pluginRoot: "/plug",
      pluginData: "/data",
      projectDir: "/proj",
      env: { API_KEY: "secret" },
    });
    expect(out).toBe("node /plug/s.js --token secret");
  });
});

describe("enablement", () => {
  it("parses plugin ids", () => {
    expect(parsePluginId("demo@shop")).toEqual({ name: "demo", marketplace: "shop", id: "demo@shop" });
  });

  it("honors enabledPlugins map and defaultEnabled", () => {
    const activation = { enabledPlugins: { "keep@m": true, "off@m": false } };
    expect(isPluginEnabled(activation, "keep@m", false)).toBe(true);
    expect(isPluginEnabled(activation, "off@m", true)).toBe(false);
    expect(isPluginEnabled(activation, "fresh@m", true)).toBe(true);
    expect(isPluginEnabled(activation, "fresh@m", false)).toBe(false);
  });

  it("loads project .agents/plugins.json over user", () => {
    const home = tmp();
    const cwd = tmp();
    mkdirSync(path.join(home, ".agents"), { recursive: true });
    mkdirSync(path.join(cwd, ".agents"), { recursive: true });
    writeFileSync(
      path.join(home, ".agents", "plugins.json"),
      JSON.stringify({ enabledPlugins: { "a@m": true, "b@m": true } }),
    );
    writeFileSync(path.join(cwd, ".agents", "plugins.json"), JSON.stringify({ enabledPlugins: { "b@m": false } }));
    const activation = loadActivation({ home, cwd, env: process.env });
    expect(activation.enabledPlugins["a@m"]).toBe(true);
    expect(activation.enabledPlugins["b@m"]).toBe(false);
  });
});

describe("installed_plugins.json", () => {
  it("parses v1, v2, and v3", () => {
    const v1 = parseInstalledPluginsDatabase({
      version: 1,
      plugins: { "a@m": { installPath: "/v1", version: "1.0.0" } },
    });
    expect(v1[0]?.installations[0]?.installPath).toBe("/v1");

    const v2 = parseInstalledPluginsDatabase({
      version: 2,
      plugins: {
        "a@m": [
          { scope: "user", installPath: "/user" },
          { scope: "project", installPath: "/proj", projectPath: "/repo" },
        ],
      },
    });
    expect(v2[0]?.installations).toHaveLength(2);

    const v3 = parseInstalledPluginsDatabase([
      { id: "b@n", installPath: "/v3", scope: "user" },
    ]);
    expect(v3[0]?.id).toBe("b@n");
  });
});

describe("manifest paths", () => {
  it("rejects paths that escape the plugin root", () => {
    const root = tmp();
    expect(() => resolveComponentPath(root, "./ok.md")).not.toThrow();
    expect(() => resolveComponentPath(root, "../secret")).toThrow(/escapes/);
  });
});

describe("tool names", () => {
  it("maps Claude tools to OpenCode and back", () => {
    expect(toOpenCodeTool("Bash")).toBe("bash");
    expect(toOpenCodeTool("Write")).toBe("write");
    expect(toClaudeTool("bash")).toBe("Bash");
    expect(toClaudeTool("edit")).toBe("Edit");
    expect(matcherHits("Write|Edit", "Write")).toBe(true);
    expect(matcherHits("Write|Edit", "Bash")).toBe(false);
    expect(matcherHits("*", "Anything")).toBe(true);
  });

  it("maps Claude model aliases", () => {
    expect(mapClaudeModel("haiku")).toContain("anthropic/");
    expect(mapClaudeModel("anthropic/claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4-5");
    expect(mapClaudeModel("inherit")).toBeUndefined();
  });
});

describe("hook stdin / exit codes", () => {
  it("blocks on exit 2", () => {
    expect(interpretHookResult(2, "", "nope").blocked).toBe(true);
    expect(interpretHookResult(2, "", "nope").blockReason).toBe("nope");
  });

  it("honors JSON deny and additionalContext", () => {
    const deny = interpretHookResult(
      0,
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "policy" },
      }),
      "",
    );
    expect(deny.blocked).toBe(true);
    expect(deny.permissionDecision).toBe("deny");

    const ctx = interpretHookResult(
      0,
      JSON.stringify({ hookSpecificOutput: { additionalContext: "hello" } }),
      "",
    );
    expect(ctx.blocked).toBe(false);
    expect(ctx.additionalContext).toBe("hello");
  });

  it("runs a command hook with stdin JSON", () => {
    const script = `const fs=require('fs');const i=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:i.tool_name}}))`;
    const result = runHookCommand(
      { type: "command", command: `node -e ${JSON.stringify(script)}` },
      { tool_name: "Bash" },
      { cwd: process.cwd(), env: process.env },
    );
    expect(result.additionalContext).toBe("Bash");
  });
});

describe("hooks.json parser", () => {
  it("reads wrapped hooks files", () => {
    const parsed = parseHooksObject({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }] },
    });
    expect(parsed.PreToolUse?.[0]?.matcher).toBe("Bash");
  });
});

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/demo-plugin");

describe("fixture plugin components", () => {
  it("loads every component type from the fixture", () => {
    const plugin = loadPluginFromDirectory(fixtureRoot, "fixture-demo@local", {
      home: tmp(),
      cwd: tmp(),
      env: { ...process.env, FIXTURE_TOKEN: "tok" },
    });
    expect(plugin.skills.map((s) => s.name)).toContain("demo-skill");
    expect(plugin.commands.map((c) => c.name)).toContain("hello");
    expect(plugin.commands[0]?.template).toContain("$ARGUMENTS");
    expect(plugin.agents.map((a) => a.name)).toContain("reviewer");
    expect(plugin.agents[0]?.tools?.read).toBe(true);
    expect(plugin.instructions.files.some((f) => f.endsWith("CLAUDE.md"))).toBe(true);
    expect(Object.keys(plugin.mcp)).toEqual(expect.arrayContaining(["fixture-stdio", "echo-api"]));
    expect(plugin.mcp["echo-api"]?.type).toBe("local");
    if (plugin.mcp["echo-api"]?.type === "local") {
      expect(plugin.mcp["echo-api"].command[1]).toContain("mcp-echo.js");
      expect(plugin.mcp["echo-api"].environment?.FROM_ENV).toBe("tok");
    }
    expect(Object.keys(plugin.hooks)).toEqual(
      expect.arrayContaining(["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart"]),
    );
  });

  it("injects them as native OpenCode config resources", () => {
    const plugin = loadPluginFromDirectory(fixtureRoot, "fixture-demo@local", {
      home: tmp(),
      cwd: tmp(),
      env: process.env,
    });
    const patch = buildConfigPatch([plugin]);
    expect(patch.command["fixture-demo:hello"]?.template).toContain("$ARGUMENTS");
    expect(patch.agent["fixture-demo:reviewer"]?.mode).toBe("subagent");
    expect(patch.mcp["fixture-demo:echo-api"]).toBeTruthy();
    expect(patch.instructions.some((file) => file.endsWith("CLAUDE.md"))).toBe(true);
    expect(patch.skillPaths.some((dir) => dir.includes("skills"))).toBe(true);

    const config: Record<string, unknown> = { command: {}, agent: {}, mcp: {}, instructions: [] };
    applyConfigPatch(config, patch);
    expect((config.command as Record<string, unknown>)["fixture-demo:hello"]).toBeTruthy();
    expect((config.agent as Record<string, unknown>)["fixture-demo:reviewer"]).toBeTruthy();
    expect((config.skills as { paths: string[] }).paths.length).toBeGreaterThan(0);
  });

  it("plugin config hook mutates a live OpenCode config object", async () => {
    const home = tmp();
    const cwd = tmp();
    const store = path.join(home, ".agents", "plugins");
    const versionDir = path.join(store, "cache", "local", "fixture-demo", "1.0.0");
    mkdirSync(versionDir, { recursive: true });
    copyDir(fixtureRoot, versionDir);
    writeFileSync(
      path.join(store, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "fixture-demo@local": [{ scope: "user", installPath: versionDir, version: "1.0.0" }] },
      }),
    );
    writeFileSync(
      path.join(home, ".agents", "plugins.json"),
      JSON.stringify({ enabledPlugins: { "fixture-demo@local": true } }),
    );
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const hooks = await createClaudeCodeBridge({ directory: cwd });
      const config: Record<string, unknown> = {};
      await hooks.config(config);
      expect((config.command as Record<string, unknown>)["fixture-demo:hello"]).toBeTruthy();
      expect((config.agent as Record<string, unknown>)["fixture-demo:reviewer"]).toBeTruthy();
      expect((config.mcp as Record<string, unknown>)["fixture-demo:echo-api"]).toBeTruthy();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});

describe("discovery against Claude-compatible layout", () => {
  it("reads ~/.agents/plugins like ~/.claude/plugins", () => {
    const home = tmp();
    const cwd = tmp();
    const store = path.join(home, ".agents", "plugins");
    const versionDir = path.join(store, "cache", "local", "fixture-demo", "1.0.0");
    mkdirSync(versionDir, { recursive: true });
    mkdirSync(path.dirname(path.join(home, ".agents", "plugins.json")), { recursive: true });
    copyDir(fixtureRoot, versionDir);
    writeFileSync(
      path.join(store, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "fixture-demo@local": [
            {
              scope: "user",
              installPath: versionDir,
              version: "1.0.0",
              installedAt: new Date().toISOString(),
              lastUpdated: new Date().toISOString(),
            },
          ],
        },
      }),
    );
    writeFileSync(
      path.join(home, ".agents", "plugins.json"),
      JSON.stringify({ enabledPlugins: { "fixture-demo@local": true } }),
    );

    const discovered = discoverEnabledPlugins({ home, cwd, env: process.env });
    expect(discovered.enabled).toHaveLength(1);
    expect(discovered.enabled[0]?.skills[0]?.name).toBe("demo-skill");
  });

  it("skips disabled plugins", () => {
    const home = tmp();
    const cwd = tmp();
    const store = path.join(home, ".agents", "plugins");
    const versionDir = path.join(store, "cache", "local", "fixture-demo", "1.0.0");
    mkdirSync(versionDir, { recursive: true });
    copyDir(fixtureRoot, versionDir);
    writeFileSync(
      path.join(store, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "fixture-demo@local": [{ scope: "user", installPath: versionDir, version: "1.0.0" }] },
      }),
    );
    writeFileSync(
      path.join(home, ".agents", "plugins.json"),
      JSON.stringify({ enabledPlugins: { "fixture-demo@local": false } }),
    );
    const discovered = discoverEnabledPlugins({ home, cwd, env: process.env });
    expect(discovered.enabled).toHaveLength(0);
    expect(discovered.skipped[0]?.reason).toBe("disabled");
  });
});

describe("fixture hook scripts", () => {
  it("blocks Bash when command contains BLOCKME", () => {
    const pre = path.join(fixtureRoot, "hooks", "pre-tool.js");
    const blocked = runHookCommand(
      { type: "command", command: `node ${JSON.stringify(pre)}` },
      { tool_name: "Bash", tool_input: { command: "echo BLOCKME" } },
      { cwd: fixtureRoot, env: process.env },
    );
    expect(blocked.blocked).toBe(true);

    const ok = runHookCommand(
      { type: "command", command: `node ${JSON.stringify(pre)}` },
      { tool_name: "Bash", tool_input: { command: "echo hi" } },
      { cwd: fixtureRoot, env: process.env },
    );
    expect(ok.blocked).toBe(false);
  });
});

describe("commands loader respects replace semantics", () => {
  it("loads markdown commands from default directory", () => {
    const loaded = loadManifestFromRoot(fixtureRoot, "fixture-demo");
    const cmds = loadCommands(fixtureRoot, loaded.manifest);
    expect(cmds.map((c) => c.name)).toContain("hello");
  });
});

describe("mcp merge", () => {
  it("lets plugin.json override .mcp.json on the same name", () => {
    const root = tmp();
    mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { echo: { command: "old", args: [] } } }),
    );
    writeFileSync(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "x",
        mcpServers: { echo: { command: "new", args: ["${CLAUDE_PLUGIN_ROOT}/s.js"] } },
      }),
    );
    const loaded = loadManifestFromRoot(root, "x");
    const mcp = loadMcpServers(root, loaded.manifest, {
      pluginRoot: root,
      pluginData: root,
      projectDir: root,
      env: {},
    });
    expect(mcp.echo?.type).toBe("local");
    if (mcp.echo?.type === "local") expect(mcp.echo.command[0]).toBe("new");
  });
});

function copyDir(from: string, to: string): void {
  cpSync(from, to, { recursive: true });
}
