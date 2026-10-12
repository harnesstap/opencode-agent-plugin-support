import { Ajv2020 } from "ajv/dist/2020.js";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkRemoteUrl, checkServerShape, loadAgentMcp } from "../src/ap-mcp.js";
import { parseAgentPluginsManifest, validatePluginName } from "../src/ap-manifest.js";
import { validateSkillFrontmatter } from "../src/ap-skills.js";
import { Diagnostics } from "../src/diagnostics.js";
import { discoverEnabledPlugins, loadPluginFromDirectory } from "../src/discover.js";
import { hookEnv } from "../src/hook-payload.js";
import { runHookGroups } from "../src/hook-runtime.js";
import { buildConfigPatch } from "../src/inject.js";
import { pluginDataDir } from "../src/paths.js";
import {
  AP_MCP_SCHEMA,
  AP_SCHEMA,
  apDemo,
  dualFixture,
  machine,
  specSchemas,
  symlinksSupported,
  useTestEnvironment,
  validSkill,
  writeAgentPlugin,
  writeJson,
  writeMcp,
  writeText,
} from "./helpers.js";
import { loadAgentSkills } from "../src/ap-skills.js";

const env = useTestEnvironment("ocp-ap-");

function schemaValidator(file: string, ref = "") {
  const ajv = new Ajv2020({ strict: false });
  const schema = JSON.parse(readFileSync(path.join(specSchemas, "1.0.0", file), "utf8"));
  ajv.addSchema(schema);
  return ajv.getSchema(`${schema.$id}${ref}`)!;
}

describe("plugin.json validation", () => {
  const manifestSchema = schemaValidator("plugin.schema.json");
  const base = { $schema: AP_SCHEMA, name: "ok" };
  // schemaValid: what the official 1.0.0 schema says. ours: what the loader does.
  const cases: Array<{ label: string; doc: unknown; schemaValid: boolean; ours: "ok" | "reject"; reason?: RegExp }> = [
    { label: "minimal", doc: base, schemaValid: true, ours: "ok" },
    {
      label: "full",
      doc: {
        ...base,
        version: "x",
        description: "d",
        author: { name: "a", email: "not an email", url: "nope" },
        homepage: "h",
        repository: "r",
        license: "l",
        keywords: ["k"],
        extensions: { "com.example.c": { a: 1 } },
      },
      schemaValid: true,
      ours: "ok",
    },
    { label: "missing $schema", doc: { name: "ok" }, schemaValid: false, ours: "reject", reason: /"\$schema"/ },
    { label: "1.1.0 draft schema", doc: { ...base, $schema: AP_SCHEMA.replace("1.0.0", "1.1.0") }, schemaValid: false, ours: "reject", reason: /unsupported Agent Plugins version 1\.1\.0/ },
    { label: "foreign $schema", doc: { ...base, $schema: "https://example.com/x.json" }, schemaValid: false, ours: "reject", reason: /unrecognized/ },
    { label: "missing name", doc: { $schema: AP_SCHEMA }, schemaValid: false, ours: "reject", reason: /"name"/ },
    { label: "empty name", doc: { ...base, name: "" }, schemaValid: false, ours: "reject", reason: /"name"/ },
    { label: "uppercase name", doc: { ...base, name: "My-Plugin" }, schemaValid: false, ours: "reject", reason: /invalid "name"/ },
    { label: "leading hyphen", doc: { ...base, name: "-start" }, schemaValid: false, ours: "reject" },
    { label: "trailing period", doc: { ...base, name: "end." }, schemaValid: false, ours: "reject" },
    { label: "double hyphen", doc: { ...base, name: "has--double" }, schemaValid: false, ours: "reject" },
    { label: "double period", doc: { ...base, name: "too..many" }, schemaValid: false, ours: "reject" },
    { label: "65 chars", doc: { ...base, name: "a".repeat(65) }, schemaValid: false, ours: "reject" },
    { label: "dotted name", doc: { ...base, name: "acme.tools" }, schemaValid: true, ours: "ok" },
    { label: "single char", doc: { ...base, name: "a" }, schemaValid: true, ours: "ok" },
    { label: "non-string version", doc: { ...base, version: 1 }, schemaValid: false, ours: "reject" },
    { label: "author extra field", doc: { ...base, author: { name: "a", twitter: "x" } }, schemaValid: false, ours: "reject" },
    { label: "author non-string", doc: { ...base, author: { name: 3 } }, schemaValid: false, ours: "reject" },
    { label: "keywords non-strings", doc: { ...base, keywords: [1] }, schemaValid: false, ours: "reject" },
    // The two violations the spec says to report and ignore rather than reject:
    { label: "unknown top-level field", doc: { ...base, mcpServers: {} }, schemaValid: false, ours: "ok" },
    { label: "non-object extensions", doc: { ...base, extensions: false }, schemaValid: false, ours: "ok" },
    { label: "array document", doc: [], schemaValid: false, ours: "reject" },
  ];

  for (const item of cases) {
    it(`${item.label}: schema=${item.schemaValid}, loader=${item.ours}`, () => {
      expect(manifestSchema(item.doc)).toBe(item.schemaValid);
      const parsed = parseAgentPluginsManifest(item.doc);
      expect(parsed.ok).toBe(item.ours === "ok");
      if (!parsed.ok && item.reason) expect(parsed.reason).toMatch(item.reason);
    });
  }

  it("reports unknown fields and a non-object extensions, and ignores them", () => {
    const parsed = parseAgentPluginsManifest({ ...base, hooks: {}, extensions: [] });
    expect(parsed).toMatchObject({ ok: true, notes: [`"extensions" is not an object; ignoring it`, `unknown plugin.json field "hooks" ignored`] });
    if (parsed.ok) expect(parsed.manifest).toEqual({ name: "ok" });
  });

  it("does not validate the contents of another client's extension namespace", () => {
    expect(parseAgentPluginsManifest({ ...base, extensions: { "com.other": 5 } }).ok).toBe(true);
  });

  it("name rule has a readable explanation", () => {
    expect(validatePluginName("fine")).toBeUndefined();
    expect(validatePluginName("Not Fine")).toMatch(/a-z, 0-9/);
  });
});

describe("skills", () => {
  const diag = () => new Diagnostics("t", false);

  it("validates Agent Skills frontmatter", () => {
    const ok = { name: "good", description: "d" };
    expect(validateSkillFrontmatter(ok, "good")).toBeUndefined();
    expect(validateSkillFrontmatter({ ...ok, license: "MIT", metadata: { a: "b" }, "allowed-tools": "Read" }, "good")).toBeUndefined();
    expect(validateSkillFrontmatter({ description: "d" }, "good")).toMatch(/"name" is required/);
    expect(validateSkillFrontmatter({ name: "good" }, "good")).toMatch(/"description" is required/);
    expect(validateSkillFrontmatter({ ...ok, description: "  " }, "good")).toMatch(/"description"/);
    expect(validateSkillFrontmatter(ok, "other")).toMatch(/must match its directory name/);
    for (const name of ["Good", "-a", "a-", "a--b", "a_b", "a".repeat(65)]) {
      expect(validateSkillFrontmatter({ ...ok, name }, name), name).toMatch(/"name"/);
    }
    expect(validateSkillFrontmatter({ ...ok, description: "x".repeat(1025) }, "good")).toMatch(/1024/);
    expect(validateSkillFrontmatter({ ...ok, compatibility: "" }, "good")).toMatch(/compatibility/);
    expect(validateSkillFrontmatter({ ...ok, metadata: { a: 1 } }, "good")).toMatch(/metadata/);
    expect(validateSkillFrontmatter({ ...ok, "allowed-tools": ["Read"] }, "good")).toMatch(/allowed-tools/);
    expect(validateSkillFrontmatter({ ...ok, "user-invocable": false }, "good")).toBeUndefined();
  });

  it("loads only immediate-child skills, skipping invalid ones and ignoring other files", () => {
    const root = env.tmp();
    writeText(path.join(root, "skills", "alpha", "SKILL.md"), validSkill("alpha"));
    writeText(path.join(root, "skills", "alpha", "references", "deep", "SKILL.md"), validSkill("deep"));
    writeText(path.join(root, "skills", "wrapper", "inner", "SKILL.md"), validSkill("inner"));
    writeText(path.join(root, "skills", "wrong-name", "SKILL.md"), validSkill("other"));
    writeText(path.join(root, "skills", "no-frontmatter", "SKILL.md"), "just text\n");
    writeText(path.join(root, "skills", "bad-yaml", "SKILL.md"), "---\nname: bad-yaml\n- description: x\n---\n");
    writeText(path.join(root, "skills", "lower", "skill.md"), validSkill("lower"));
    writeText(path.join(root, "skills", "README.md"), "not a skill\n");
    writeText(path.join(root, "skills", "omega", "SKILL.md"), validSkill("omega"));
    const d = diag();
    const skills = loadAgentSkills(root, d);
    expect(skills.map((skill) => skill.name)).toEqual(["alpha", "omega"]);
    expect(d.messages).toHaveLength(3);
    expect(d.messages.join("\n")).toMatch(/wrong-name.*must match its directory name/);
    expect(d.messages.join("\n")).toMatch(/no-frontmatter.*"name" is required/);
    expect(d.messages.join("\n")).toMatch(/bad-yaml.*malformed YAML/);
  });

  it("treats a skills file as invalid for the component type only", () => {
    const root = env.tmp();
    writeText(path.join(root, "skills"), "i am a file");
    const d = diag();
    expect(loadAgentSkills(root, d)).toEqual([]);
    expect(d.messages).toEqual(["skills is not a directory; skills disabled"]);
  });

  it("absent skills/ is not an error", () => {
    const d = diag();
    expect(loadAgentSkills(env.tmp(), d)).toEqual([]);
    expect(d.messages).toEqual([]);
  });
});

describe.skipIf(!symlinksSupported)("realpath containment", () => {
  function pluginWithOutside() {
    const base = env.tmp();
    const root = path.join(base, "plugin");
    const outside = path.join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeAgentPlugin(root, "contained");
    return { root, outside };
  }

  it("rejects the plugin when plugin.json is a link out of the root", () => {
    const base = env.tmp();
    const root = path.join(base, "plugin");
    mkdirSync(root);
    writeJson(path.join(base, "elsewhere.json"), { $schema: AP_SCHEMA, name: "escaped" });
    symlinkSync(path.join(base, "elsewhere.json"), path.join(root, "plugin.json"));
    const m = machine(env.tmp);
    writeJson(path.join(m.home, ".agents", "agent-plugin-support.json"), { sources: [{ path: base, format: "agent-plugins", label: "t" }] });
    const status = discoverEnabledPlugins(m.paths).statuses.find((item) => item.id === "plugin@t");
    expect(status).toMatchObject({ enabled: false });
    expect(status?.reason).toMatch(/plugin\.json .*outside/);
  });

  it("disables skills when skills/ links outside, and skips a SKILL.md that links outside", () => {
    const { root, outside } = pluginWithOutside();
    writeText(path.join(outside, "alpha", "SKILL.md"), validSkill("alpha"));
    symlinkSync(path.join(outside, "alpha"), path.join(root, "skills"));
    const d = new Diagnostics("t", false);
    expect(loadAgentSkills(root, d)).toEqual([]);
    expect(d.messages[0]).toMatch(/skills .*outside.*skills disabled/);

    const second = pluginWithOutside();
    writeText(path.join(second.outside, "SKILL.md"), validSkill("linked"));
    writeText(path.join(second.root, "skills", "linked", "placeholder"), "");
    symlinkSync(path.join(second.outside, "SKILL.md"), path.join(second.root, "skills", "linked", "SKILL.md"));
    writeText(path.join(second.root, "skills", "fine", "SKILL.md"), validSkill("fine"));
    const d2 = new Diagnostics("t", false);
    expect(loadAgentSkills(second.root, d2).map((skill) => skill.name)).toEqual(["fine"]);
    expect(d2.messages[0]).toMatch(/linked.*outside/);
  });

  it("allows symlinks that stay inside the plugin root", () => {
    const { root } = pluginWithOutside();
    writeText(path.join(root, "store", "SKILL.md"), validSkill("inside"));
    mkdirSync(path.join(root, "skills"));
    symlinkSync(path.join(root, "store"), path.join(root, "skills", "inside"));
    expect(loadAgentSkills(root, new Diagnostics("t", false)).map((skill) => skill.name)).toEqual(["inside"]);
  });

  it("refuses MCP command and cwd links out of the root, per server", () => {
    const { root, outside } = pluginWithOutside();
    writeText(path.join(outside, "tool"), "#!/bin/sh\n");
    symlinkSync(path.join(outside, "tool"), path.join(root, "tool"));
    symlinkSync(outside, path.join(root, "dir"));
    symlinkSync(path.join(root, "missing-target"), path.join(root, "dangling"));
    mkdirSync(path.join(root, "real"));
    symlinkSync(path.join(root, "real"), path.join(root, "inside-link"));
    writeMcp(root, {
      "cmd-out": { type: "stdio", command: "./tool" },
      "cwd-out": { type: "stdio", command: "node", cwd: "./dir" },
      "cwd-dangling": { type: "stdio", command: "node", cwd: "./dangling" },
      "cwd-inside-link": { type: "stdio", command: "node", cwd: "./inside-link" },
    });
    const result = loadAgentMcp({ realRoot: root, pluginData: env.tmp(), schemaVersion: "1.0.0" });
    expect(Object.keys(result.servers)).toEqual(["cwd-inside-link"]);
    expect(result.skipped.map((item) => item.server)).toEqual(["cmd-out", "cwd-out", "cwd-dangling"]);
  });

  it("applies the same containment to the OpenCode extension directory", () => {
    const { root, outside } = pluginWithOutside();
    writeText(path.join(outside, "leak.md"), "---\ndescription: leak\n---\nsecret\n");
    writeText(path.join(root, "com.harnesstap.opencode", "commands", "ok.md"), "---\ndescription: ok\n---\nok\n");
    symlinkSync(path.join(outside, "leak.md"), path.join(root, "com.harnesstap.opencode", "commands", "leak.md"));
    writeText(path.join(outside, "instructions.md"), "leaked instructions");
    symlinkSync(path.join(outside, "instructions.md"), path.join(root, "com.harnesstap.opencode", "instructions.md"));
    const m = machine(env.tmp);
    const plugin = loadPluginFromDirectory(root, "contained@t", m.paths);
    expect(plugin.commands.map((command) => command.name)).toEqual(["ok"]);
    expect(plugin.instructions.files).toEqual([]);
    expect(plugin.diagnostics.join("\n")).toMatch(/leak\.md.*outside/);
  });
});

describe("MCP rules", () => {
  const load = (servers: Record<string, unknown>, overrides: Partial<Parameters<typeof loadAgentMcp>[0]> = {}) => {
    const root = env.tmp();
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(root, "bin", "run"), "");
    writeMcp(root, servers);
    return { root, ...loadAgentMcp({ realRoot: root, pluginData: env.tmp(), schemaVersion: "1.0.0", ...overrides }) };
  };
  const reasonFor = (spec: unknown) => {
    const result = load({ s: spec });
    return result.skipped[0]?.reason;
  };

  it("matches the official server schema on shape", () => {
    const server = schemaValidator("mcp.schema.json", "#/$defs/server");
    const specs: unknown[] = [
      { type: "stdio", command: "node" },
      { type: "stdio", command: "node", args: ["a"], env: { A: "b" }, cwd: "./x" },
      { type: "stdio", command: "node", cwd: "." },
      { type: "stdio", command: "node", env: { PLUGIN_ROOT: "x" } },
      { type: "stdio", command: "node", extra: 1 },
      { type: "stdio" },
      { command: "node" },
      { type: "http", url: "http://127.0.0.1/" },
      { type: "streamable-http", url: "https://e.com", headers: { A: "b" } },
      { type: "streamable-http", url: "https://e.com", command: "node" },
      { type: "sse", url: "https://e.com" },
      { type: "stdio", command: "node", args: [1] },
      { type: "streamable-http", url: "https://e.com", headers: { A: 1 } },
    ];
    for (const spec of specs) {
      // Anything the schema rejects, the loader must reject too (the loader is stricter where the spec is).
      if (!server(spec)) expect(checkServerShape(spec, "linux").ok, JSON.stringify(spec)).toBe(false);
    }
    expect(specs.filter((spec) => checkServerShape(spec, "linux").ok)).toHaveLength(specs.filter((spec) => server(spec)).length);
  });

  it("accepts a command that is a bare name or a contained ./ path, and rejects everything else", () => {
    expect(load({ s: { type: "stdio", command: "./bin/run" } }).servers.s).toBeDefined();
    expect(load({ s: { type: "stdio", command: "npx" } }).servers.s).toBeDefined();
    for (const command of ["node server.js", "/usr/bin/node", "bin/run", "../run", "./../run", "./bin/../../run", "C:\\x.exe", "a\tb", ".\\bin\\run", "./"]) {
      expect(reasonFor({ type: "stdio", command }), command).toMatch(/"command"/);
    }
  });

  it("does not expand placeholders in command, and resolves ./ against the plugin root", () => {
    const result = load({ s: { type: "stdio", command: "${PLUGIN_ROOT}/bin/run" } });
    expect(result.skipped[0]?.reason).toMatch(/"command"/);
    const ok = load({ s: { type: "stdio", command: "./bin/run", cwd: "./bin" } });
    const server = ok.servers.s as { command: string[]; cwd: string };
    expect(server.command[0]).toBe(path.join(ok.root, "bin", "run"));
    expect(server.cwd).toBe(path.join(ok.root, "bin"));
  });

  it("validates cwd forms", () => {
    for (const cwd of [".", "bin", "/tmp", "${PLUGIN_ROOT}x", "${PLUGIN_DATA}x", "../x", "./..", "${PLUGIN_ROOT}/..", "${PLUGIN_DATA}/../x", "${HOME}"]) {
      expect(reasonFor({ type: "stdio", command: "node", cwd }), cwd).toMatch(/"cwd"/);
    }
    for (const cwd of ["./", "./bin", "${PLUGIN_ROOT}", "${PLUGIN_ROOT}/bin", "${PLUGIN_DATA}", "${PLUGIN_DATA}/sub/dir"]) {
      expect(load({ s: { type: "stdio", command: "node", cwd } }).servers.s, cwd).toBeDefined();
    }
  });

  it("expansion is single-pass and limited to args, env values and cwd", () => {
    const result = load({
      s: {
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}", "${PLUGIN_DATA}", "$PLUGIN_ROOT", "${PLUGIN_ROOT_X}", "${CLAUDE_PLUGIN_ROOT}", "${HOME}", "${PLUGIN_ROOT}${PLUGIN_DATA}"],
        env: { "${PLUGIN_ROOT}": "key", V: "${PLUGIN_ROOT}!" },
      },
    });
    const server = result.servers.s as { command: string[]; environment: Record<string, string> };
    const data = server.environment.PLUGIN_DATA!;
    expect(server.command.slice(1)).toEqual([result.root, data, "$PLUGIN_ROOT", "${PLUGIN_ROOT_X}", "${CLAUDE_PLUGIN_ROOT}", "${HOME}", `${result.root}${data}`]);
    expect(server.environment["${PLUGIN_ROOT}"]).toBe("key");
    expect(server.environment.V).toBe(`${result.root}!`);
  });

  it("does not rescan text introduced by a replacement", () => {
    const base = env.tmp();
    const root = path.join(base, "${PLUGIN_DATA}-root");
    mkdirSync(root);
    writeMcp(root, { s: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}"] } });
    const result = loadAgentMcp({ realRoot: root, pluginData: env.tmp(), schemaVersion: "1.0.0" });
    expect((result.servers.s as { command: string[] }).command[1]).toBe(root);
  });

  it("forbids PLUGIN_ROOT / PLUGIN_DATA in env, case-insensitively only on Windows", () => {
    expect(reasonFor({ type: "stdio", command: "node", env: { PLUGIN_DATA: "x" } })).toMatch(/PLUGIN_DATA/);
    expect(load({ s: { type: "stdio", command: "node", env: { plugin_root: "x" } } }, { platform: "linux" }).servers.s).toBeDefined();
    expect(load({ s: { type: "stdio", command: "node", env: { plugin_root: "x" } } }, { platform: "win32" }).skipped).toHaveLength(1);
  });

  it("applies the URL rules", () => {
    const valid = ["https://example.com/mcp", "https://example.com:8443/a?b=c", "http://localhost:3000/mcp", "http://127.0.0.1/", "http://127.8.9.10/", "http://[::1]:80/", "http://[::ffff:127.0.0.1]/", "HTTP://LOCALHOST/x"];
    const invalid = [
      "http://example.com/mcp",
      "http://0.0.0.0/",
      "http://10.0.0.1/",
      "http://localhost./",
      "http://[::2]/",
      "//example.com/mcp",
      "/relative",
      "example.com",
      "ftp://example.com/",
      "https://user:pw@example.com/",
      "https://user@example.com/",
      "https://@example.com/",
      "https://example.com/#frag",
      "https://example.com/#",
      "https://exa mple.com/",
      "https://example.com/\n",
      "http:example.com",
    ];
    for (const url of valid) expect(checkRemoteUrl(url), url).toBeUndefined();
    for (const url of invalid) expect(checkRemoteUrl(url), url).toBeDefined();
  });

  it("validates headers: token names, no folded duplicates, no control characters", () => {
    const server = (headers: unknown) => checkServerShape({ type: "streamable-http", url: "https://e.com", headers }, "linux");
    expect(server({ "X-Tenant": "a b\tc", Accept: "" }).ok).toBe(true);
    expect(server({ "X Bad": "v" }).ok).toBe(false);
    expect(server({ "": "v" }).ok).toBe(false);
    expect(server({ A: "a\r\nb" }).ok).toBe(false);
    expect(server({ A: "a\u0000" }).ok).toBe(false);
    expect(server({ "X-A": "1", "x-a": "2" }).ok).toBe(false);
  });

  it("disables MCP for a bad file and for a version mismatch, but not for a bad entry", () => {
    const root = env.tmp();
    const run = () => loadAgentMcp({ realRoot: root, pluginData: env.tmp(), schemaVersion: "1.0.0" });
    expect(run()).toEqual({ servers: {}, skipped: [] });
    writeText(path.join(root, "mcp.json"), "{ nope");
    expect(run().disabled).toMatch(/not valid JSON/);
    writeJson(path.join(root, "mcp.json"), { mcpServers: {} });
    expect(run().disabled).toMatch(/missing "\$schema"/);
    writeJson(path.join(root, "mcp.json"), { $schema: AP_MCP_SCHEMA.replace("1.0.0", "1.1.0"), mcpServers: {} });
    expect(run().disabled).toMatch(/targets Agent Plugins 1\.1\.0 but plugin\.json targets 1\.0\.0/);
    writeJson(path.join(root, "mcp.json"), { $schema: "https://x/y", mcpServers: {} });
    expect(run().disabled).toMatch(/unrecognized/);
    writeJson(path.join(root, "mcp.json"), { $schema: AP_MCP_SCHEMA, mcpServers: {}, extra: 1 });
    expect(run().disabled).toMatch(/unknown top-level field "extra"/);
    writeJson(path.join(root, "mcp.json"), { $schema: AP_MCP_SCHEMA, mcpServers: [] });
    expect(run().disabled).toMatch(/"mcpServers" must be an object/);
    writeJson(path.join(root, "mcp.json"), { $schema: AP_MCP_SCHEMA, mcpServers: {} });
    expect(run()).toEqual({ servers: {}, skipped: [] });
    mkdirSync(path.join(root, "x"));
    writeMcp(root, { good: { type: "stdio", command: "node" }, bad: { type: "stdio" } });
    const mixed = run();
    expect(Object.keys(mixed.servers)).toEqual(["good"]);
    expect(mixed.skipped).toHaveLength(1);
  });

  it("maps remote servers without inventing fields, and skips SSE as an unsupported transport", () => {
    const result = load({
      remote: { type: "streamable-http", url: "https://example.com/mcp" },
      withHeaders: { type: "streamable-http", url: "https://example.com/mcp", headers: { "X-A": "b" } },
      legacy: { type: "sse", url: "https://example.com/sse" },
      invalidSse: { type: "sse", url: "http://example.com/sse" },
    });
    expect(result.servers.remote).toEqual({ type: "remote", url: "https://example.com/mcp", enabled: true });
    expect(result.servers.withHeaders).toMatchObject({ headers: { "X-A": "b" } });
    expect(result.skipped.map((item) => item.reason)).toEqual([
      expect.stringMatching(/unsupported transport "sse".*no SSE client/),
      expect.stringMatching(/invalid server: "url" must use https/),
    ]);
  });
});

describe("the ap-demo package", () => {
  function load() {
    const m = machine(env.tmp);
    return { m, plugin: loadPluginFromDirectory(apDemo, "ap-demo@fixtures", m.paths) };
  }

  it("loads as agent-plugins format with spec skills, MCP and the OpenCode extension", () => {
    const { plugin } = load();
    expect(plugin).toMatchObject({ name: "ap-demo", format: "agent-plugins", dualManifest: false });
    expect(plugin.skills.map((skill) => skill.name)).toEqual(["greet"]);
    expect(plugin.commands.map((command) => command.name).sort()).toEqual(["hello", "inline-hi"]);
    expect(plugin.agents.map((agent) => agent.name)).toEqual(["helper"]);
    expect(Object.keys(plugin.hooks)).toEqual(["UserPromptSubmit"]);
    expect(Object.keys(plugin.mcp).sort()).toEqual(["bundled", "local-http", "remote", "whoami"]);
    expect(plugin.mcpSkipped.map((item) => item.server).sort()).toEqual(["broken", "legacy"]);
  });

  it("does not inject root AGENTS.md / CLAUDE.md and does not prepend bin/", () => {
    const { plugin } = load();
    expect(plugin.binDir).toBeUndefined();
    expect(plugin.instructions.files).toEqual([path.join(apDemo, "com.harnesstap.opencode", "instructions.md")]);
    expect(plugin.instructions.texts.join("\n")).toContain("ap-instructions-ok");
    expect(plugin.instructions.texts.join("\n")).not.toMatch(/must NOT be injected/);
  });

  it("namespaces commands, agents and MCP servers with the Agent Plugins name", () => {
    const { plugin } = load();
    const patch = buildConfigPatch([plugin]);
    expect(Object.keys(patch.command).sort()).toEqual(["ap-demo:greet", "ap-demo:hello", "ap-demo:inline-hi"]);
    expect(Object.keys(patch.agent)).toEqual(["ap-demo:helper"]);
    expect(Object.keys(patch.mcp).sort()).toEqual(["ap-demo:bundled", "ap-demo:local-http", "ap-demo:remote", "ap-demo:whoami"]);
    expect(patch.skillNames).toEqual(["greet"]);
  });

  it("launches the stdio server with plugin variables expanded and PLUGIN_ROOT / PLUGIN_DATA injected", () => {
    const { plugin } = load();
    const whoami = plugin.mcp.whoami as { command: string[]; cwd: string; environment: Record<string, string> };
    const data = whoami.environment.PLUGIN_DATA!;
    expect(whoami.environment.PLUGIN_ROOT).toBe(apDemo);
    expect(whoami.cwd).toBe(data);
    expect(whoami.command).toEqual(["node", path.join(apDemo, "mcp-server.mjs"), "--data", `${data}/state`]);
    expect(whoami.environment.FROM_CONFIG).toBe(`${apDemo}|${data}|$HOME|\${CLAUDE_PLUGIN_ROOT}`);
  });

  it("runs hooks with PLUGIN_ROOT / PLUGIN_DATA next to the CLAUDE_* variables", () => {
    const { m, plugin } = load();
    const results = runHookGroups(plugin.hooks.UserPromptSubmit, { prompt: "hi" }, { cwd: m.cwd, env: hookEnv(plugin, m.paths) });
    const context = results[0]?.additionalContext ?? "";
    expect(context.startsWith("ap-hook-ok ")).toBe(true);
    const seen = JSON.parse(context.slice("ap-hook-ok ".length));
    const data = pluginDataDir(m.paths, "ap-demo@fixtures");
    expect(seen.PLUGIN_ROOT).toBe(apDemo);
    expect(seen.CLAUDE_PLUGIN_ROOT).toBe(apDemo);
    expect(seen.CLAUDE_PLUGIN_DATA).toBe(data);
    expect(path.basename(seen.PLUGIN_DATA)).toBe("ap-demo-fixtures");
  });

  it("reports the problems it found", () => {
    const { plugin } = load();
    const text = plugin.diagnostics.join("\n");
    expect(text).toMatch(/skipping skill "Bad-Name"/);
    expect(text).toMatch(/skipping skill "mismatch"/);
    expect(text).toMatch(/MCP server "legacy" skipped: unsupported transport/);
    expect(text).toMatch(/MCP server "broken" skipped: invalid server: "command"/);
    expect(plugin.diagnostics.some((line) => /group|inner/.test(line))).toBe(false);
  });
});

describe("dual manifests (Claude + Agent Plugins)", () => {
  function copyDual(): string {
    const root = env.tmp();
    for (const file of [".claude-plugin/plugin.json", "plugin.json", ".mcp.json", "mcp.json", "skills/dual-skill/SKILL.md", "commands/dual-cmd.md", "CLAUDE.md"]) {
      writeText(path.join(root, file), readFileSync(path.join(dualFixture, file), "utf8"));
    }
    return root;
  }
  const mcpOf = (plugin: ReturnType<typeof loadPluginFromDirectory>, name: string) => plugin.mcp[name] as { command: string[]; environment?: Record<string, string> };

  it("Claude is primary, mcp.json adds servers Claude does not define, and Claude definitions win", () => {
    const m = machine(env.tmp);
    const plugin = loadPluginFromDirectory(copyDual(), "dual@t", m.paths);
    expect(plugin).toMatchObject({ format: "claude", dualManifest: true, name: "dual" });
    expect(Object.keys(plugin.mcp).sort()).toEqual(["agent-only", "claude-only", "shared"]);
    expect(mcpOf(plugin, "shared").command).toEqual(["node", "claude-version"]);
    expect(mcpOf(plugin, "agent-only").environment?.PLUGIN_ROOT).toBe(plugin.agentPluginsRoot);
    expect(plugin.commands.map((command) => command.name)).toEqual(["dual-cmd"]);
    expect(plugin.skills.map((skill) => skill.name)).toEqual(["dual-skill"]);
    expect(plugin.instructions.files).toHaveLength(1);
  });

  it("warns on a name mismatch and keeps the Claude name as the prefix", () => {
    const root = copyDual();
    writeJson(path.join(root, "plugin.json"), { $schema: AP_SCHEMA, name: "dual-ap" });
    const m = machine(env.tmp);
    const plugin = loadPluginFromDirectory(root, "dual@t", m.paths);
    expect(plugin.name).toBe("dual");
    expect(plugin.diagnostics.join("\n")).toMatch(/Agent Plugins name "dual-ap" differs from the Claude name "dual"/);
    expect(Object.keys(buildConfigPatch([plugin]).mcp).sort()).toEqual(["dual:agent-only", "dual:claude-only", "dual:shared"]);
    expect(env.warnings().join("\n")).toMatch(/differs from the Claude name/);
  });

  it("falls back to Claude with a warning when the Agent Plugins manifest is invalid", () => {
    for (const manifest of [{ $schema: AP_SCHEMA, name: "Bad Name" }, { $schema: AP_SCHEMA.replace("1.0.0", "1.1.0"), name: "dual" }]) {
      const root = copyDual();
      writeJson(path.join(root, "plugin.json"), manifest);
      const m = machine(env.tmp);
      const plugin = loadPluginFromDirectory(root, "dual@t", m.paths);
      expect(plugin).toMatchObject({ format: "claude", dualManifest: false });
      expect(Object.keys(plugin.mcp).sort()).toEqual(["claude-only", "shared"]);
      expect(plugin.diagnostics.join("\n")).toMatch(/invalid Agent Plugins manifest .*using the Claude manifest only/);
    }
  });

  it("ignores a root plugin.json that does not declare an Agent Plugins schema", () => {
    const root = copyDual();
    writeJson(path.join(root, "plugin.json"), { name: "someone-elses-manifest" });
    const plugin = loadPluginFromDirectory(root, "dual@t", machine(env.tmp).paths);
    expect(plugin).toMatchObject({ format: "claude", dualManifest: false });
    expect(plugin.diagnostics).toEqual([]);
  });

  it("a malformed mcp.json next to a Claude manifest disables only the Agent Plugins servers", () => {
    const root = copyDual();
    writeText(path.join(root, "mcp.json"), "{ nope");
    const plugin = loadPluginFromDirectory(root, "dual@t", machine(env.tmp).paths);
    expect(Object.keys(plugin.mcp).sort()).toEqual(["claude-only", "shared"]);
    expect(plugin.diagnostics.join("\n")).toMatch(/MCP disabled: mcp\.json is not valid JSON/);
  });
});
