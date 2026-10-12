import { Ajv2020 } from "ajv/dist/2020.js";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main as cliMain } from "../src/cli.js";
import { deriveSourceLabel, parseConfigDocument } from "../src/config.js";
import { discoverEnabledPlugins } from "../src/discover.js";
import { loadActivation, resolvePluginEnablement } from "../src/enablement.js";
import { CONFIG_SCHEMA_URL } from "../src/identity.js";
import { loadBridge } from "../src/runtime.js";
import {
  AP_SCHEMA,
  apDemo,
  demoPlugin,
  dualFixture,
  here,
  machine,
  symlinksSupported,
  useTestEnvironment,
  validSkill,
  writeAgentPlugin,
  writeJson,
  writeText,
  type Machine,
} from "./helpers.js";

const env = useTestEnvironment("ocp-cfg-");

const userConfig = (m: Machine) => path.join(m.home, ".agents", "agent-plugin-support.json");
const projectConfig = (m: Machine) => path.join(m.cwd, ".agents", "agent-plugin-support.json");

/** A Claude registry tree at `store` with one local plugin `<name>@local` copied from the demo fixture. */
function claudeStore(store: string, name: string, version = "1.0.0"): void {
  const install = path.join(store, "cache", "local", name, version);
  cpSync(demoPlugin, install, { recursive: true });
  writeJson(path.join(install, ".claude-plugin", "plugin.json"), { name });
  writeJson(path.join(store, "installed_plugins.json"), {
    version: 2,
    plugins: { [`${name}@local`]: [{ scope: "user", installPath: install, version }] },
  });
}

function capture(argv: string[], m: Machine): { code: number; out: string; err: string } {
  const previous = { home: process.env.HOME, cwd: process.cwd() };
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  process.env.HOME = m.home;
  process.chdir(m.cwd);
  process.stdout.write = ((chunk: string) => ((out += chunk), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => ((err += chunk), true)) as typeof process.stderr.write;
  try {
    return { code: cliMain(argv), out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    process.chdir(previous.cwd);
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
  }
}

describe("config parsing", () => {
  it("accepts the documented shape and the string shorthand", () => {
    const parsed = parseConfigDocument({
      $schema: CONFIG_SCHEMA_URL,
      sources: [
        { path: "~/.claude/plugins", format: "claude" },
        { path: "~/.agents/plugins", format: "agent-plugins", label: "agents-dir" },
        "./vendor",
        { path: "/x", enabled: false },
      ],
      enabledPlugins: { "oh-my-claudecode@omc": false },
    });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.sources).toEqual([
      { path: "~/.claude/plugins", format: "claude", enabled: true },
      { path: "~/.agents/plugins", format: "agent-plugins", label: "agents-dir", enabled: true },
      { path: "./vendor", format: "auto", enabled: true },
      { path: "/x", format: "auto", enabled: false },
    ]);
    expect(parsed.enabledPlugins).toEqual({ "oh-my-claudecode@omc": false });
  });

  it("drops bad entries with a warning instead of failing the file", () => {
    const parsed = parseConfigDocument({
      extra: 1,
      sources: [{ path: "" }, { path: "/a", format: "zip" }, 3, { path: "/b", label: "bad label!", color: "red" }, "  "],
      enabledPlugins: { a: "no", b: true },
    });
    expect(parsed.sources).toEqual([{ path: "/b", format: "auto", enabled: true }]);
    expect(parsed.enabledPlugins).toEqual({ b: true });
    expect(parsed.warnings).toHaveLength(8);
  });

  it("treats a non-array sources and a non-object document as absent", () => {
    expect(parseConfigDocument({ sources: "x" }).sources).toBeUndefined();
    expect(parseConfigDocument([]).warnings[0]).toMatch(/must be a JSON object/);
    expect(parseConfigDocument({ sources: [] }).sources).toEqual([]);
  });

  it("derives labels from the directory, using the parent for a directory named plugins", () => {
    expect(deriveSourceLabel("/home/u/.agents/plugins")).toBe("agents");
    expect(deriveSourceLabel("/home/u/.codex/plugins")).toBe("codex");
    expect(deriveSourceLabel("/work/Team Plugins")).toBe("team-plugins");
    expect(deriveSourceLabel("/work/acme.tools")).toBe("acme.tools");
  });

  it("validates against the shipped JSON schema", () => {
    const schema = JSON.parse(readFileSync(path.join(here, "..", "schema", "agent-plugin-support.schema.json"), "utf8"));
    expect(schema.$id).toBe(CONFIG_SCHEMA_URL);
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(
      validate({
        $schema: CONFIG_SCHEMA_URL,
        sources: ["./a", { path: "~/b", format: "claude", label: "b", enabled: false }],
        enabledPlugins: { "x@y": false },
      }),
    ).toBe(true);
    expect(validate({ sources: [{ format: "claude" }] })).toBe(false);
    expect(validate({ sources: [{ path: "a", format: "zip" }] })).toBe(false);
    expect(validate({ enabledPlugins: { a: "no" } })).toBe(false);
    expect(validate({ plugins: [] })).toBe(false);
  });
});

describe("backward compatibility (no config file)", () => {
  it("reads the single claude source ~/.agents/plugins and plugins.json, like 0.1.1", () => {
    const m = machine(env.tmp);
    claudeStore(path.join(m.home, ".agents", "plugins"), "legacy");
    writeJson(path.join(m.home, ".agents", "plugins.json"), { enabledPlugins: { "other@x": false } });
    const discovered = discoverEnabledPlugins(m.paths);
    expect(discovered.config.exists).toBe(false);
    expect(discovered.config.sources).toMatchObject([{ implicit: true, format: "claude", origin: "default", path: path.join(m.home, ".agents", "plugins") }]);
    expect(discovered.enabled.map((plugin) => plugin.id)).toEqual(["legacy@local"]);
    expect(discovered.statuses[0]).toMatchObject({ format: "claude", source: "default" });
  });

  it("a missing implicit source is silent", () => {
    const m = machine(env.tmp);
    expect(discoverEnabledPlugins(m.paths).statuses).toEqual([]);
    expect(env.warnings()).toEqual([]);
  });

  it("legacy plugins.json still disables, and the extra marketplaces key is still read", () => {
    const m = machine(env.tmp);
    claudeStore(path.join(m.home, ".agents", "plugins"), "legacy");
    writeJson(path.join(m.home, ".agents", "plugins.json"), { enabledPlugins: { "legacy@local": false } });
    const status = discoverEnabledPlugins(m.paths).statuses[0];
    expect(status).toMatchObject({ enabled: false, reason: "disabled", source: "user" });
  });

  it("a config that only sets enabledPlugins keeps the default source", () => {
    const m = machine(env.tmp);
    claudeStore(path.join(m.home, ".agents", "plugins"), "legacy");
    writeJson(userConfig(m), { enabledPlugins: { "legacy@local": false } });
    const discovered = discoverEnabledPlugins(m.paths);
    expect(discovered.config.sources.map((source) => source.implicit)).toEqual([true]);
    expect(discovered.statuses[0]).toMatchObject({ enabled: false, source: "user", sourceFile: userConfig(m) });
  });
});

describe("enablement precedence", () => {
  it("project config > user config > project plugins.json > user plugins.json", () => {
    const m = machine(env.tmp);
    const set = (file: string, value: boolean) => writeJson(file, { enabledPlugins: { "p@m": value } });
    const decide = () => resolvePluginEnablement(loadActivation(m.paths), "p@m");

    set(path.join(m.home, ".agents", "plugins.json"), false);
    expect(decide()).toMatchObject({ enabled: false, source: "user", file: path.join(m.home, ".agents", "plugins.json") });
    set(path.join(m.cwd, ".agents", "plugins.json"), true);
    expect(decide()).toMatchObject({ enabled: true, source: "project", file: path.join(m.cwd, ".agents", "plugins.json") });
    set(userConfig(m), false);
    expect(decide()).toMatchObject({ enabled: false, source: "user", file: userConfig(m) });
    set(projectConfig(m), true);
    expect(decide()).toMatchObject({ enabled: true, source: "project", file: projectConfig(m) });
  });

  it("a key set in a higher layer is never re-read from a lower one", () => {
    const m = machine(env.tmp);
    writeJson(path.join(m.cwd, ".agents", "plugins.json"), { enabledPlugins: { "a@m": false } });
    writeJson(userConfig(m), { enabledPlugins: { "a@m": true } });
    expect(resolvePluginEnablement(loadActivation(m.paths), "a@m").enabled).toBe(true);
  });

  it("a bare name key still matches name@source ids", () => {
    const m = machine(env.tmp);
    writeJson(userConfig(m), { enabledPlugins: { "ap-demo": false } });
    expect(resolvePluginEnablement(loadActivation(m.paths), "ap-demo@x")).toMatchObject({ enabled: false, key: "ap-demo" });
  });

  it("a malformed config is ignored with a warning and does not change behavior", () => {
    const m = machine(env.tmp);
    claudeStore(path.join(m.home, ".agents", "plugins"), "legacy");
    writeText(userConfig(m), "{ nope");
    const discovered = discoverEnabledPlugins(m.paths);
    expect(discovered.enabled.map((plugin) => plugin.id)).toEqual(["legacy@local"]);
    expect(discovered.config.user).toMatchObject({ exists: true, error: expect.stringMatching(/malformed JSON/) });
    expect(env.warnings().join("\n")).toMatch(/ignoring .*agent-plugin-support\.json/);
  });
});

describe("sources", () => {
  it("loads a claude source and an agent-plugins source side by side and shows both in ids", () => {
    const m = machine(env.tmp);
    const claude = path.join(m.home, "somewhere", "claude-tree");
    const agents = path.join(m.home, "somewhere", "agent-pkgs");
    claudeStore(claude, "cl");
    cpSync(apDemo, path.join(agents, "ap-demo"), { recursive: true });
    writeJson(userConfig(m), {
      sources: [
        { path: claude, format: "claude" },
        { path: agents, format: "agent-plugins", label: "pkgs" },
      ],
    });
    const discovered = discoverEnabledPlugins(m.paths);
    expect(discovered.statuses.map((status) => [status.id, status.format, status.origin?.format])).toEqual([
      ["cl@local", "claude", "claude"],
      ["ap-demo@pkgs", "agent-plugins", "agent-plugins"],
    ]);
    expect(discovered.statuses[1]?.origin).toMatchObject({ path: agents, label: "pkgs" });
  });

  it("expands ~ and resolves relative paths from the config file's directory", () => {
    const m = machine(env.tmp);
    claudeStore(path.join(m.home, "tilde-tree"), "tilde");
    claudeStore(path.join(m.cwd, "vendor", "rel-tree"), "rel");
    writeJson(userConfig(m), { sources: [{ path: "~/tilde-tree", format: "claude" }] });
    writeJson(projectConfig(m), { sources: [{ path: "../vendor/rel-tree", format: "claude" }] });
    const discovered = discoverEnabledPlugins(m.paths);
    expect(discovered.config.sources.map((source) => source.path)).toEqual([
      path.join(m.cwd, "vendor", "rel-tree"),
      path.join(m.home, "tilde-tree"),
    ]);
    expect(discovered.enabled.map((plugin) => plugin.id)).toEqual(["rel@local", "tilde@local"]);
  });

  it("points straight at ~/.claude/plugins with no symlink", () => {
    const m = machine(env.tmp);
    claudeStore(path.join(m.home, ".claude", "plugins"), "straight");
    writeJson(userConfig(m), { sources: [{ path: "~/.claude/plugins", format: "claude" }] });
    const discovered = discoverEnabledPlugins(m.paths);
    expect(discovered.enabled.map((plugin) => plugin.id)).toEqual(["straight@local"]);
    // data stays in the fixed location, not inside the source
    const root = discovered.enabled[0]!.pluginRoot;
    expect(root.startsWith(path.join(m.home, ".claude", "plugins"))).toBe(true);
    expect(existsSync(path.join(m.home, ".agents", "plugins", "data", "straight-local"))).toBe(true);
  });

  it("merges project over user: project sources first, same path replaced, enabled:false switches one off", () => {
    const m = machine(env.tmp);
    const a = path.join(m.home, "a");
    const b = path.join(m.home, "b");
    const c = path.join(m.home, "c");
    for (const dir of [a, b, c]) mkdirSync(dir);
    writeJson(userConfig(m), { sources: [{ path: a, format: "claude" }, { path: b, format: "claude" }] });
    writeJson(projectConfig(m), { sources: [{ path: c, format: "agent-plugins" }, { path: a, format: "auto", label: "mine" }, { path: b, enabled: false }] });
    const effective = discoverEnabledPlugins(m.paths).config;
    expect(effective.sources.map((source) => [path.basename(source.path), source.format, source.label, source.origin])).toEqual([
      ["c", "agent-plugins", "c", "project"],
      ["a", "auto", "mine", "project"],
    ]);
    expect(effective.disabledSources.map((source) => path.basename(source.path))).toEqual(["b"]);
  });

  it("an explicitly empty sources list loads nothing, and project-only sources replace the default", () => {
    const m = machine(env.tmp);
    claudeStore(path.join(m.home, ".agents", "plugins"), "legacy");
    writeJson(userConfig(m), { sources: [] });
    expect(discoverEnabledPlugins(m.paths).statuses).toEqual([]);
  });

  it("makes derived labels unique and warns", () => {
    const m = machine(env.tmp);
    const one = path.join(m.home, "x", "tools");
    const two = path.join(m.home, "y", "tools");
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });
    writeJson(userConfig(m), { sources: [{ path: one, format: "agent-plugins" }, { path: two, format: "agent-plugins" }] });
    const labels = discoverEnabledPlugins(m.paths).config.sources.map((source) => source.label);
    expect(labels).toEqual(["tools", "tools-2"]);
    expect(env.warnings().join("\n")).toMatch(/source label "tools" is used twice/);
  });

  it("warns about a configured source that is not a directory", () => {
    const m = machine(env.tmp);
    writeJson(userConfig(m), { sources: [{ path: "~/nope", format: "claude" }] });
    const discovered = discoverEnabledPlugins(m.paths);
    expect(discovered.sources[0]).toMatchObject({ exists: false, note: "path is not a directory" });
    expect(env.warnings().join("\n")).toMatch(/is not a directory; skipping it/);
  });

  it("keeps the first source on a duplicate plugin name and says so", () => {
    const m = machine(env.tmp);
    const first = path.join(m.home, "first");
    const second = path.join(m.home, "second");
    writeAgentPlugin(path.join(first, "one"), "same-name");
    writeAgentPlugin(path.join(second, "two"), "same-name");
    writeText(path.join(second, "two", "skills", "s", "SKILL.md"), validSkill("s"));
    writeJson(userConfig(m), {
      sources: [{ path: first, format: "agent-plugins", label: "a" }, { path: second, format: "agent-plugins", label: "b" }],
    });
    const discovered = discoverEnabledPlugins(m.paths);
    expect(discovered.enabled.map((plugin) => plugin.id)).toEqual(["same-name@a"]);
    const loser = discovered.statuses.find((status) => status.id === "same-name@b");
    expect(loser).toMatchObject({ enabled: false });
    expect(loser?.reason).toMatch(/duplicate plugin name "same-name": already provided by "same-name@a".*keeping the first source/);
    expect(env.warnings().join("\n")).toMatch(/duplicate plugin name "same-name"/);
  });

  it("a disabled plugin does not shadow a later one with the same name", () => {
    const m = machine(env.tmp);
    const first = path.join(m.home, "first");
    const second = path.join(m.home, "second");
    writeAgentPlugin(path.join(first, "one"), "same-name");
    writeAgentPlugin(path.join(second, "two"), "same-name");
    writeJson(userConfig(m), {
      sources: [{ path: first, format: "agent-plugins", label: "a" }, { path: second, format: "agent-plugins", label: "b" }],
      enabledPlugins: { "same-name@a": false },
    });
    expect(discoverEnabledPlugins(m.paths).enabled.map((plugin) => plugin.id)).toEqual(["same-name@b"]);
  });

  it("skips reserved directory names and rejected packages without blocking the rest", () => {
    const m = machine(env.tmp);
    const dir = path.join(m.home, "pkgs");
    for (const reserved of ["cache", "data", "marketplaces", "repos"]) writeAgentPlugin(path.join(dir, reserved), `r-${reserved}`);
    writeAgentPlugin(path.join(dir, "good"), "good");
    writeAgentPlugin(path.join(dir, "bad-name"), "Bad Name");
    writeJson(path.join(dir, "future", "plugin.json"), { $schema: AP_SCHEMA.replace("1.0.0", "1.1.0"), name: "future" });
    writeText(path.join(dir, "not-json", "plugin.json"), "{ nope");
    writeText(path.join(dir, "no-manifest", "skills", "s", "SKILL.md"), validSkill("s"));
    writeText(path.join(dir, "loose-file.txt"), "x");
    writeJson(userConfig(m), { sources: [{ path: dir, format: "agent-plugins", label: "t" }] });
    const discovered = discoverEnabledPlugins(m.paths);
    expect(discovered.enabled.map((plugin) => plugin.id)).toEqual(["good@t"]);
    const reasons = Object.fromEntries(discovered.skipped.map((item) => [item.id, item.reason]));
    expect(reasons["bad-name@t"]).toMatch(/^rejected: invalid "name"/);
    expect(reasons["future@t"]).toMatch(/^rejected: unsupported Agent Plugins version 1\.1\.0/);
    expect(reasons["not-json@t"]).toMatch(/^rejected: plugin\.json is not valid JSON/);
    expect(Object.keys(reasons)).toHaveLength(3);
  });

  it.skipIf(!symlinksSupported)("accepts symlinked plugin directories and uses the resolved path as the plugin root", () => {
    const m = machine(env.tmp);
    const dir = path.join(m.home, "pkgs");
    mkdirSync(dir);
    symlinkSync(apDemo, path.join(dir, "linked-demo"));
    writeJson(userConfig(m), { sources: [{ path: dir, format: "agent-plugins", label: "t" }] });
    const [plugin] = discoverEnabledPlugins(m.paths).enabled;
    expect(plugin).toMatchObject({ id: "ap-demo@t", pluginRoot: apDemo });
  });

  it("keeps the first of two packages with the same name inside one source", () => {
    const m = machine(env.tmp);
    const dir = path.join(m.home, "pkgs");
    writeAgentPlugin(path.join(dir, "a-first"), "dup");
    writeAgentPlugin(path.join(dir, "b-second"), "dup");
    writeJson(userConfig(m), { sources: [{ path: dir, format: "agent-plugins", label: "t" }] });
    const discovered = discoverEnabledPlugins(m.paths);
    expect(discovered.enabled.map((plugin) => plugin.pluginRoot.endsWith("a-first"))).toEqual([true]);
    expect(discovered.skipped[0]?.reason).toMatch(/duplicate plugin "dup@t" in this source/);
  });
});

describe("auto format", () => {
  function autoSource(m: Machine): string {
    const dir = path.join(m.home, "auto");
    cpSync(apDemo, path.join(dir, "ap-demo"), { recursive: true });
    cpSync(dualFixture, path.join(dir, "dual"), { recursive: true });
    writeJson(path.join(dir, "claude-only", ".claude-plugin", "plugin.json"), { name: "claude-only" });
    writeText(path.join(dir, "claude-only", "skills", "cs", "SKILL.md"), validSkill("cs"));
    writeText(path.join(dir, "unrelated", "README.md"), "nothing here");
    writeJson(path.join(dir, "other-tool", "plugin.json"), { name: "someone-elses-plugin" });
    claudeStore(dir, "registered");
    writeJson(userConfig(m), { sources: [dir] });
    return dir;
  }

  it("detects each plugin by its manifests: registry plugins, Claude dirs, Agent Plugins dirs and dual", () => {
    const m = machine(env.tmp);
    autoSource(m);
    const discovered = discoverEnabledPlugins(m.paths);
    expect(discovered.statuses.map((status) => [status.id, status.format, status.dualManifest])).toEqual([
      ["registered@local", "claude", false],
      ["ap-demo@auto", "agent-plugins", false],
      ["claude-only@auto", "claude", false],
      ["dual@auto", "claude", true],
    ]);
  });

  it("a registry plugin that only ships an Agent Plugins manifest gets Agent Plugins semantics and keeps its registry id", () => {
    const m = machine(env.tmp);
    const store = path.join(m.home, "tree");
    const install = path.join(store, "cache", "local", "ap-demo", "1.0.0");
    cpSync(apDemo, install, { recursive: true });
    writeJson(path.join(store, "installed_plugins.json"), { version: 2, plugins: { "ap-demo@local": [{ scope: "user", installPath: install }] } });
    writeJson(userConfig(m), { sources: [{ path: store, format: "auto" }] });
    expect(discoverEnabledPlugins(m.paths).statuses[0]).toMatchObject({ id: "ap-demo@local", format: "agent-plugins", enabled: true });
    writeJson(userConfig(m), { sources: [{ path: store, format: "claude" }] });
    const asClaude = discoverEnabledPlugins(m.paths).statuses[0];
    expect(asClaude).toMatchObject({ id: "ap-demo@local", format: "claude", dualManifest: true });
    expect(asClaude?.plugin?.binDir).toBe(path.join(install, "bin"));
  });
});

describe("dual manifests by source format", () => {
  function dualInSource(m: Machine, format: "claude" | "agent-plugins" | "auto"): ReturnType<typeof discoverEnabledPlugins> {
    const dir = path.join(m.home, "src");
    if (format === "claude") {
      const install = path.join(dir, "cache", "local", "dual", "2.0.0");
      cpSync(dualFixture, install, { recursive: true });
      writeJson(path.join(dir, "installed_plugins.json"), { version: 2, plugins: { "dual@local": [{ scope: "user", installPath: install }] } });
    } else {
      cpSync(dualFixture, path.join(dir, "dual"), { recursive: true });
    }
    writeJson(userConfig(m), { sources: [{ path: dir, format, label: "s" }] });
    return discoverEnabledPlugins(m.paths);
  }

  it("claude source: Claude primary, mcp.json servers merged", () => {
    const [status] = dualInSource(machine(env.tmp), "claude").statuses;
    expect(status).toMatchObject({ id: "dual@local", format: "claude", dualManifest: true });
    expect(Object.keys(status!.plugin!.mcp).sort()).toEqual(["agent-only", "claude-only", "shared"]);
  });

  it("agent-plugins source: Agent Plugins semantics only; Claude files are ignored", () => {
    const [status] = dualInSource(machine(env.tmp), "agent-plugins").statuses;
    expect(status).toMatchObject({ id: "dual@s", format: "agent-plugins", dualManifest: false });
    const plugin = status!.plugin!;
    expect(Object.keys(plugin.mcp).sort()).toEqual(["agent-only", "shared"]);
    expect((plugin.mcp.shared as { command: string[] }).command).toEqual(["node", "agent-plugins-version"]);
    expect(plugin.commands).toEqual([]);
    expect(plugin.instructions.files).toEqual([]);
    expect(plugin.binDir).toBeUndefined();
  });

  it("auto source: a Claude manifest makes the plugin Claude-primary, like a claude source", () => {
    const [status] = dualInSource(machine(env.tmp), "auto").statuses;
    expect(status).toMatchObject({ id: "dual@s", format: "claude", dualManifest: true });
  });
});

describe("loadBridge and OpenCode entry points", () => {
  it("loadBridge picks up sources from the config and exposes namespaced components", () => {
    const m = machine(env.tmp);
    const dir = path.join(m.home, "pkgs");
    cpSync(apDemo, path.join(dir, "ap-demo"), { recursive: true });
    writeJson(userConfig(m), { sources: [{ path: dir, format: "agent-plugins" }] });
    const bridge = loadBridge({ cwd: m.cwd, home: m.home, env: process.env });
    expect(bridge.plugins.map((plugin) => plugin.id)).toEqual(["ap-demo@pkgs"]);
    expect(Object.keys(bridge.patch.command).sort()).toEqual(["ap-demo:greet", "ap-demo:hello", "ap-demo:inline-hi"]);
    expect(bridge.patch.instructionTexts.join("\n")).toContain("ap-instructions-ok");
    expect(bridge.skipped.map((item) => item.id)).toEqual([]);
  });

  it("skipInstalled switches discovery off for every source", () => {
    const m = machine(env.tmp);
    const dir = path.join(m.home, "pkgs");
    cpSync(apDemo, path.join(dir, "ap-demo"), { recursive: true });
    writeJson(userConfig(m), { sources: [{ path: dir, format: "agent-plugins" }] });
    expect(loadBridge({ cwd: m.cwd, home: m.home, env: process.env, options: { skipInstalled: true } }).plugins).toEqual([]);
  });

  it("extraPluginDirs detects Agent Plugins packages", () => {
    const m = machine(env.tmp);
    const bridge = loadBridge({ cwd: m.cwd, home: m.home, env: process.env, options: { skipInstalled: true, extraPluginDirs: { "ap-demo@extra": apDemo } } });
    expect(bridge.plugins[0]).toMatchObject({ id: "ap-demo@extra", format: "agent-plugins" });
  });
});

describe("CLI", () => {
  function setup(): { m: Machine; dir: string } {
    const m = machine(env.tmp);
    const dir = path.join(m.home, "pkgs");
    cpSync(apDemo, path.join(dir, "ap-demo"), { recursive: true });
    return { m, dir };
  }

  it("list shows source, format and diagnostics per plugin", () => {
    const { m, dir } = setup();
    claudeStore(path.join(m.home, "claude-tree"), "cl");
    writeJson(userConfig(m), {
      sources: [{ path: path.join(m.home, "claude-tree"), format: "claude" }, { path: dir, format: "agent-plugins", label: "pkgs" }],
    });
    const { code, out } = capture(["list"], m);
    expect(code).toBe(0);
    const listed = JSON.parse(out);
    expect(listed.configFiles.find((file: { scope: string }) => file.scope === "user")).toMatchObject({ exists: true, path: userConfig(m) });
    expect(listed.sources.map((source: { format: string; plugins: number }) => [source.format, source.plugins])).toEqual([["claude", 1], ["agent-plugins", 1]]);
    const byId = Object.fromEntries(listed.plugins.map((plugin: { id: string }) => [plugin.id, plugin]));
    expect(byId["cl@local"]).toMatchObject({ format: "claude", sourceFormat: "claude", sourceLabel: "claude-tree", enabled: true });
    expect(byId["ap-demo@pkgs"]).toMatchObject({ format: "agent-plugins", sourceFormat: "agent-plugins", sourceLabel: "pkgs", sourcePath: dir, dualManifest: false });
    expect(byId["ap-demo@pkgs"].mcpSkipped.map((item: { server: string }) => item.server).sort()).toEqual(["broken", "legacy"]);
    expect(byId["ap-demo@pkgs"].diagnostics.length).toBeGreaterThan(0);
    expect(listed.userFile).toBe(path.join(m.home, ".agents", "plugins.json"));
  });

  it("sources (and config) print the effective config without loading plugins", () => {
    const { m, dir } = setup();
    writeJson(userConfig(m), { sources: [{ path: dir, format: "agent-plugins" }], enabledPlugins: { "a@b": false } });
    writeJson(projectConfig(m), { enabledPlugins: { "a@b": true, "c@d": false } });
    writeJson(path.join(m.home, ".agents", "plugins.json"), { enabledPlugins: { "legacy@x": false } });
    for (const name of ["sources", "config"]) {
      const { code, out } = capture([name], m);
      expect(code).toBe(0);
      const report = JSON.parse(out);
      expect(report.mode).toBe("config");
      expect(report.sources).toMatchObject([{ path: dir, format: "agent-plugins", label: "pkgs", origin: "user", exists: true }]);
      expect(report.enabledPlugins).toEqual({
        "a@b": { enabled: true, file: projectConfig(m) },
        "c@d": { enabled: false, file: projectConfig(m) },
        "legacy@x": { enabled: false, file: path.join(m.home, ".agents", "plugins.json") },
      });
      expect(report.configFiles.map((file: { exists: boolean }) => file.exists)).toEqual([true, true]);
    }
  });

  it("sources reports legacy mode when there is no config file", () => {
    const m = machine(env.tmp);
    const report = JSON.parse(capture(["sources"], m).out);
    expect(report.mode).toBe("legacy");
    expect(report.sources).toMatchObject([{ declaredPath: "~/.agents/plugins", format: "claude", origin: "default" }]);
  });

  it("enable / disable write the config file when it exists, preserving its other fields", () => {
    const { m, dir } = setup();
    writeJson(userConfig(m), { $schema: CONFIG_SCHEMA_URL, sources: [{ path: dir, format: "agent-plugins" }], note: "keep me" });
    const off = JSON.parse(capture(["disable", "ap-demo@pkgs"], m).out);
    expect(off).toMatchObject({ wroteFile: userConfig(m), wroteKind: "config", wroteTo: "user", enabled: false, source: "user" });
    const written = JSON.parse(readFileSync(userConfig(m), "utf8"));
    expect(written).toEqual({
      $schema: CONFIG_SCHEMA_URL,
      sources: [{ path: dir, format: "agent-plugins" }],
      note: "keep me",
      enabledPlugins: { "ap-demo@pkgs": false },
    });
    expect(existsSync(path.join(m.home, ".agents", "plugins.json"))).toBe(false);
    expect(discoverEnabledPlugins(m.paths).statuses[0]).toMatchObject({ enabled: false, reason: "disabled" });
    const on = JSON.parse(capture(["enable", "ap-demo@pkgs"], m).out);
    expect(on.enabled).toBe(true);
  });

  it("enable / disable --project write the project config when it exists, otherwise the legacy file", () => {
    const m = machine(env.tmp);
    writeJson(projectConfig(m), { enabledPlugins: {} });
    expect(JSON.parse(capture(["disable", "x@y", "--project"], m).out)).toMatchObject({ wroteFile: projectConfig(m), wroteKind: "config" });
    expect(JSON.parse(readFileSync(projectConfig(m), "utf8"))).toEqual({ enabledPlugins: { "x@y": false } });
    // user layer has no config file: legacy
    const legacy = JSON.parse(capture(["disable", "u@v"], m).out);
    expect(legacy).toMatchObject({ wroteKind: "legacy", wroteFile: path.join(m.home, ".agents", "plugins.json") });
    expect(JSON.parse(readFileSync(path.join(m.home, ".agents", "plugins.json"), "utf8"))).toEqual({ enabledPlugins: { "u@v": false } });
  });

  it("with no config at all, enable / disable behave exactly like 0.1.1", () => {
    const m = machine(env.tmp);
    const result = JSON.parse(capture(["disable", "x@y"], m).out);
    expect(result).toMatchObject({ wroteKind: "legacy", wroteFile: path.join(m.home, ".agents", "plugins.json"), enabled: false });
    expect(existsSync(userConfig(m))).toBe(false);
  });

  it("refuses to overwrite a config file that is not valid JSON", () => {
    const m = machine(env.tmp);
    writeText(userConfig(m), "{ nope");
    const { code, err } = capture(["disable", "x@y"], m);
    expect(code).toBe(1);
    expect(err).toMatch(/not valid JSON/);
    expect(readFileSync(userConfig(m), "utf8")).toBe("{ nope");
  });

  it("install-local notes when ~/.agents/plugins is not a configured source", () => {
    const m = machine(env.tmp);
    writeJson(userConfig(m), { sources: [{ path: path.join(m.home, "elsewhere"), format: "claude" }] });
    const result = capture(["install-local", demoPlugin, "demo@local"], m);
    expect(result.code).toBe(0);
    expect(result.err).toMatch(/is not one of your configured sources/);
  });
});

describe("CLI entry", () => {
  it.skipIf(!symlinksSupported)("runs when invoked through a symlink, as npx and global installs do", () => {
    const m = machine(env.tmp);
    const dist = path.join(here, "..", "dist", "cli.js");
    expect(existsSync(dist), "run `npm run build` first (npm install does it via prepare)").toBe(true);
    const link = path.join(env.tmp(), "opencode-agent-plugin-support");
    symlinkSync(dist, link);
    const out = execFileSync(process.execPath, [link, "sources"], { cwd: m.cwd, env: { ...process.env, HOME: m.home }, encoding: "utf8" });
    expect(JSON.parse(out).mode).toBe("legacy");
  });
});
