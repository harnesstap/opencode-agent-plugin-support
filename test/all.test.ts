import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mapClaudeModel } from "../src/agents.js";
import { loadCommands } from "../src/commands.js";
import { discoverEnabledPlugins, loadPluginFromDirectory } from "../src/discover.js";
import { isPluginEnabled, loadActivation, parsePluginId, resolvePluginEnablement, setLayerEnabled } from "../src/enablement.js";
import { expandString } from "../src/expand.js";
import { parseFrontmatter, parseYamlBoolean, splitList } from "../src/frontmatter.js";
import { interpretHookResult, matchingHandlers, runHookCommand } from "../src/hook-runtime.js";
import { parseHooksObject } from "../src/hooks.js";
import { parseInstalledPluginsDatabase, pickInstallation, resolveInstallPath } from "../src/installed.js";
import { applyConfigPatch, buildConfigPatch, toV2McpConfig } from "../src/inject.js";
import { createClaudeCodeBridge } from "../src/index.js";
import { loadManifestFromRoot, resolveComponentPath } from "../src/manifest.js";
import { loadMcpServers } from "../src/mcp.js";
import { writesThroughClaudePluginRegistry } from "../src/registry-guard.js";
import {
  isSkillModelInvocable,
  isSkillUserInvocable,
  loadSkills,
  pluginSkillCommandName,
  pluginSkillCommandTemplate,
} from "../src/skills.js";
import { matcherHits, toClaudeMcpTool, toClaudeTool, toOpenCodeTool } from "../src/tool-names.js";

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

  it("parses Claude-style YAML booleans", () => {
    expect(parseYamlBoolean("yes", false)).toBe(true);
    expect(parseYamlBoolean("0", true)).toBe(false);
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

  it("enables installed plugins unless explicitly false", () => {
    const home = tmp();
    const cwd = tmp();
    mkdirSync(path.join(home, ".agents"), { recursive: true });
    writeFileSync(
      path.join(home, ".agents", "plugins.json"),
      JSON.stringify({ enabledPlugins: { "keep@m": true, "off@m": false } }),
    );
    const activation = loadActivation({ home, cwd, env: process.env });
    expect(isPluginEnabled(activation, "keep@m")).toBe(true);
    expect(isPluginEnabled(activation, "off@m")).toBe(false);
    expect(isPluginEnabled(activation, "fresh@m")).toBe(true);
    expect(resolvePluginEnablement(activation, "fresh@m").source).toBe("default");
    expect(resolvePluginEnablement(activation, "off@m")).toMatchObject({
      enabled: false,
      source: "user",
    });
  });

  it("treats missing plugins.json as all enabled", () => {
    const activation = loadActivation({ home: tmp(), cwd: tmp(), env: process.env });
    expect(activation.user.exists).toBe(false);
    expect(activation.project.exists).toBe(false);
    expect(isPluginEnabled(activation, "anything@local")).toBe(true);
    expect(resolvePluginEnablement(activation, "anything@local").source).toBe("default");
  });

  it("lets project .agents/plugins.json override user", () => {
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
    expect(isPluginEnabled(activation, "a@m")).toBe(true);
    expect(resolvePluginEnablement(activation, "a@m").source).toBe("user");
    expect(isPluginEnabled(activation, "b@m")).toBe(false);
    expect(resolvePluginEnablement(activation, "b@m")).toMatchObject({
      enabled: false,
      source: "project",
    });
  });

  it("ignores Claude settings.json files", () => {
    const home = tmp();
    const cwd = tmp();
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "blocked@m": false } }),
    );
    writeFileSync(
      path.join(cwd, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "blocked@m": false } }),
    );
    const activation = loadActivation({ home, cwd, env: process.env });
    expect(isPluginEnabled(activation, "blocked@m")).toBe(true);
    expect(resolvePluginEnablement(activation, "blocked@m").source).toBe("default");
  });

  it("setLayerEnabled writes only the targeted file and reports source", () => {
    const home = tmp();
    const cwd = tmp();
    const paths = { home, cwd, env: process.env };
    const userDecision = setLayerEnabled(paths, "x@m", false, "user");
    expect(userDecision).toMatchObject({ enabled: false, source: "user" });
    const projectDecision = setLayerEnabled(paths, "x@m", true, "project");
    expect(projectDecision).toMatchObject({ enabled: true, source: "project" });
    const activation = loadActivation(paths);
    expect(activation.user.enabledPlugins["x@m"]).toBe(false);
    expect(activation.project.enabledPlugins["x@m"]).toBe(true);
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
    expect(toClaudeTool("shell")).toBe("Bash");
    expect(toClaudeTool("subagent")).toBe("Task");
    expect(toClaudeTool("patch")).toBe("Edit");
    expect(toClaudeMcpTool("fixture-demo_echo-api_echo", ["fixture-demo:echo-api"])).toBe(
      "mcp__plugin_fixture-demo_echo-api__echo",
    );
    expect(toClaudeTool("fixture-demo_echo-api_echo", ["fixture-demo:echo-api"])).toBe(
      "mcp__plugin_fixture-demo_echo-api__echo",
    );
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
    expect(plugin.skills.map((s) => s.name)).toEqual(
      expect.arrayContaining(["demo-skill", "manual-deploy", "legacy-context", "hello"]),
    );
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
    expect(patch.command["fixture-demo:hello"]?.template).toContain("fixture-command-ok");
    expect(patch.command["fixture-demo:hello"]?.template).not.toContain("fixture-skill-hello-should-not-win");
    expect(patch.command["fixture-demo:demo-skill"]?.template).toContain("fixture-skill-ok");
    expect(patch.command["fixture-demo:demo-skill"]?.template).toContain("$ARGUMENTS");
    expect(patch.command["fixture-demo:demo-skill"]?.template).toContain(
      path.join("skills", "demo-skill", "SKILL.md"),
    );
    expect(patch.command["fixture-demo:manual-deploy"]?.template).toContain("fixture-manual-deploy-ok");
    expect(patch.command["fixture-demo:manual-deploy"]?.argumentHint).toBe("[target]");
    expect(patch.command["fixture-demo:legacy-context"]).toBeUndefined();
    expect(patch.skillNames).toEqual(expect.arrayContaining(["demo-skill", "legacy-context", "hello"]));
    expect(patch.skillNames).not.toContain("manual-deploy");
    expect(patch.skillPaths.some((dir) => dir.endsWith(`${path.sep}manual-deploy`))).toBe(false);
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

    const discovered = discoverEnabledPlugins({ home, cwd, env: process.env });
    expect(discovered.enabled).toHaveLength(1);
    expect(discovered.enabled[0]?.skills.map((s) => s.name)).toContain("demo-skill");
    expect(discovered.statuses[0]).toMatchObject({
      id: "fixture-demo@local",
      enabled: true,
      source: "default",
    });
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
    expect(discovered.statuses[0]).toMatchObject({
      enabled: false,
      source: "user",
      reason: "disabled",
    });
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

describe("installed path ranking", () => {
  it("ignores project installs that belong to other repos and prefers an existing path", () => {
    const home = tmp();
    const cwd = tmp();
    const userDir = path.join(home, ".agents", "plugins", "cache", "local", "demo", "1.0.0");
    mkdirSync(userDir, { recursive: true });
    const record = {
      id: "demo@local",
      name: "demo",
      marketplace: "local",
      installations: [
        { scope: "project" as const, installPath: "/does-not-exist", projectPath: "/some/other/project" },
        { scope: "user" as const, installPath: userDir, version: "1.0.0" },
      ],
    };
    const picked = pickInstallation(record, { home, cwd, env: process.env });
    expect(picked?.scope).toBe("user");
    expect(picked?.installPath).toBe(userDir);
  });

  it("resolves relative install paths against the plugins directory", () => {
    const home = tmp();
    const resolved = resolveInstallPath(
      { id: "demo@local", name: "demo", marketplace: "local", installations: [] },
      { scope: "user", installPath: "cache/local/demo/1.0.0" },
      { home, cwd: tmp(), env: process.env },
    );
    expect(resolved).toBe(path.join(home, ".agents", "plugins", "cache", "local", "demo", "1.0.0"));
  });
});

describe("skill path overlap", () => {
  it("dedupes SKILL.md files when manifest skills overlap skills/", () => {
    const root = tmp();
    mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    mkdirSync(path.join(root, "skills", "one"), { recursive: true });
    writeFileSync(
      path.join(root, "skills", "one", "SKILL.md"),
      "---\nname: one\ndescription: d\n---\n\nbody\n",
    );
    writeFileSync(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "overlap", skills: ["./skills"] }),
    );
    const loaded = loadManifestFromRoot(root, "overlap");
    const skills = loadSkills(root, loaded.manifest);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("one");
  });
});

describe("plugin skill slash commands", () => {
  it("parses Claude boolean frontmatter", () => {
    expect(parseYamlBoolean(true, false)).toBe(true);
    expect(parseYamlBoolean("YES", false)).toBe(true);
    expect(parseYamlBoolean("off", true)).toBe(false);
    expect(parseYamlBoolean(undefined, true)).toBe(true);
  });

  it("names commands plugin:skill without double-prefixing", () => {
    expect(pluginSkillCommandName("jenkins", "jenkins-ci")).toBe("jenkins:jenkins-ci");
    expect(pluginSkillCommandName("code-review-workflow", "request-slack-review")).toBe(
      "code-review-workflow:request-slack-review",
    );
    expect(pluginSkillCommandName("my-plugin", "my-plugin:fancy")).toBe("my-plugin:fancy");
  });

  it("skips user-invocable:false and hides disable-model-invocation from the skill list", () => {
    const root = tmp();
    mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    mkdirSync(path.join(root, "skills", "background"), { recursive: true });
    mkdirSync(path.join(root, "skills", "deploy"), { recursive: true });
    mkdirSync(path.join(root, "skills", "hidden"), { recursive: true });
    writeFileSync(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "acme" }),
    );
    writeFileSync(
      path.join(root, "skills", "background", "SKILL.md"),
      "---\nname: background\ndescription: ctx\nuser-invocable: false\n---\n\nbg\n",
    );
    writeFileSync(
      path.join(root, "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: ship\ndisable-model-invocation: true\nargument-hint: \"[env]\"\n---\n\nShip it. Supporting ${CLAUDE_SKILL_DIR}/notes.md\n",
    );
    writeFileSync(
      path.join(root, "skills", "hidden", "SKILL.md"),
      "---\nname: hidden\ndescription: both\nuser-invocable: false\ndisable-model-invocation: true\n---\n\nnone\n",
    );
    const plugin = loadPluginFromDirectory(root, "acme@local", { home: tmp(), cwd: tmp(), env: process.env });
    const background = plugin.skills.find((s) => s.name === "background");
    const deploy = plugin.skills.find((s) => s.name === "deploy");
    const hidden = plugin.skills.find((s) => s.name === "hidden");
    expect(background && isSkillUserInvocable(background)).toBe(false);
    expect(background && isSkillModelInvocable(background)).toBe(true);
    expect(deploy && isSkillUserInvocable(deploy)).toBe(true);
    expect(deploy && isSkillModelInvocable(deploy)).toBe(false);
    expect(hidden && isSkillUserInvocable(hidden)).toBe(false);
    expect(hidden && isSkillModelInvocable(hidden)).toBe(false);

    const patch = buildConfigPatch([plugin]);
    expect(patch.command["acme:background"]).toBeUndefined();
    expect(patch.command["acme:hidden"]).toBeUndefined();
    expect(patch.command["acme:deploy"]?.argumentHint).toBe("[env]");
    expect(patch.command["acme:deploy"]?.template).toContain(path.join(root, "skills", "deploy", "notes.md"));
    expect(patch.command["acme:deploy"]?.template).toContain(path.join(root, "skills", "deploy", "SKILL.md"));
    expect(patch.skillNames).toEqual(["background"]);
    expect(patch.skillPaths).toEqual([path.join(root, "skills", "background")]);
  });

  it("inlines the plugin SKILL.md so a colliding user skill name cannot replace it", () => {
    const root = tmp();
    mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    mkdirSync(path.join(root, "skills", "summarize"), { recursive: true });
    writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "ops" }));
    writeFileSync(
      path.join(root, "skills", "summarize", "SKILL.md"),
      "---\nname: summarize\ndescription: plugin copy\n---\n\nPLUGIN_COPY_BODY\n",
    );
    const plugin = loadPluginFromDirectory(root, "ops@local", { home: tmp(), cwd: tmp(), env: process.env });
    const skill = plugin.skills[0]!;
    const template = pluginSkillCommandTemplate(plugin.name, plugin.pluginRoot, skill);
    expect(template).toContain("PLUGIN_COPY_BODY");
    expect(template).toContain(skill.filePath);
    expect(template).toContain("$ARGUMENTS");
    expect(template).not.toContain("opencode/skills");
    const patch = buildConfigPatch([plugin]);
    expect(patch.command["ops:summarize"]?.template).toBe(template);
  });
});

describe("session hook matchers", () => {
  it("matches SessionStart groups against the session source, not a tool name", () => {
    const groups = [
      { matcher: "startup|clear|compact", hooks: [{ type: "command", command: "true" }] },
    ];
    expect(matchingHandlers(groups, "startup")).toHaveLength(1);
    expect(matchingHandlers(groups, "Bash")).toHaveLength(0);
    expect(matchingHandlers(groups)).toHaveLength(0);
  });
});

describe("v2 mcp config", () => {
  it("maps enabled:false to disabled:true", () => {
    const mapped = toV2McpConfig({ type: "local", command: ["node"], enabled: false }, false);
    expect(mapped.disabled).toBe(true);
    expect(mapped.enabled).toBeUndefined();
    expect(mapped.command).toEqual(["node"]);
  });
});

describe("install-local registry guard", () => {
  it("detects when ~/.agents/plugins is a symlink into ~/.claude/plugins", () => {
    const home = tmp();
    const claude = path.join(home, ".claude", "plugins");
    const agents = path.join(home, ".agents");
    mkdirSync(claude, { recursive: true });
    mkdirSync(agents, { recursive: true });
    symlinkSync(claude, path.join(agents, "plugins"));
    expect(writesThroughClaudePluginRegistry({ home, cwd: tmp(), env: process.env })).toBe(true);
  });

  it("allows a dedicated ~/.agents/plugins directory", () => {
    const home = tmp();
    mkdirSync(path.join(home, ".agents", "plugins"), { recursive: true });
    mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
    expect(writesThroughClaudePluginRegistry({ home, cwd: tmp(), env: process.env })).toBe(false);
  });
});

function copyDir(from: string, to: string): void {
  cpSync(from, to, { recursive: true });
}
