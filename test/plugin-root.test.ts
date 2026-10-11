import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main as cliMain } from "../src/cli.js";
import { discoverEnabledPlugins } from "../src/discover.js";
import { DEBUG_ENV } from "../src/identity.js";
import { MarketplaceIndex, resolveEntrySource } from "../src/marketplace.js";
import { resolvePluginRoot } from "../src/plugin-root.js";
import { loadBridge } from "../src/runtime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const marketplaceFixture = path.join(here, "fixtures", "claude-plugins-marketplace");
const demoFixture = path.join(here, "fixtures", "demo-plugin");
const designDocRel = path.join("innovation-general", "documentation", "design-doc");

const temps: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ocp-root-"));
  temps.push(dir);
  return dir;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeText(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

type Machine = {
  home: string;
  cwd: string;
  /** `~/.claude/plugins`, which `~/.agents/plugins` points at. */
  store: string;
  /** The same directory as seen through the `~/.agents/plugins` symlink (what the plugin resolves). */
  agentsStore: string;
  paths: { home: string; cwd: string; env: NodeJS.ProcessEnv };
};

/** `~/.agents/plugins -> ~/.claude/plugins`, exactly like the reporter's machine. */
function machine(): Machine {
  const home = tmp();
  const cwd = tmp();
  const store = path.join(home, ".claude", "plugins");
  mkdirSync(store, { recursive: true });
  mkdirSync(path.join(home, ".agents"), { recursive: true });
  symlinkSync(store, path.join(home, ".agents", "plugins"));
  return { home, cwd, store, agentsStore: path.join(home, ".agents", "plugins"), paths: { home, cwd, env: process.env } };
}

function writeInstalled(m: Machine, plugins: Record<string, unknown>): void {
  writeJson(path.join(m.store, "installed_plugins.json"), { version: 2, plugins });
}

function writeKnown(m: Machine, known: Record<string, unknown>): void {
  writeJson(path.join(m.store, "known_marketplaces.json"), known);
}

function copyMarketplace(): string {
  const dir = path.join(tmp(), "claude-plugins");
  cpSync(marketplaceFixture, dir, { recursive: true });
  return dir;
}

function directoryMarketplace(name: string, dir: string): Record<string, unknown> {
  return { [name]: { source: { source: "directory", path: dir }, installLocation: dir, lastUpdated: "2026-10-01T00:00:00.000Z" } };
}

/** The reporter's registry: design-doc points at a cache dir that Claude already swept. */
function reporterMachine(): { m: Machine; marketplaceDir: string } {
  const m = machine();
  const marketplaceDir = copyMarketplace();
  const live = path.join(m.store, "cache", "teads-plugins", "code-review-workflow", "1.0.0");
  cpSync(demoFixture, live, { recursive: true });
  writeText(path.join(m.store, ".last_inuse_sweep"), "1760000000000");
  writeInstalled(m, {
    "design-doc@teads-plugins": [
      { scope: "user", installPath: "cache/teads-plugins/design-doc/bae9d808609d", version: "bae9d808609d" },
    ],
    "code-review-workflow@teads-plugins": [
      { scope: "user", installPath: "cache/teads-plugins/code-review-workflow/1.0.0", version: "1.0.0" },
    ],
  });
  writeKnown(m, directoryMarketplace("teads-plugins", marketplaceDir));
  return { m, marketplaceDir };
}

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

function warnings(): string[] {
  return warnSpy.mock.calls.map((call) => String(call[0]));
}

describe("swept cache + directory marketplace (reported bug)", () => {
  it("loads design-doc from the marketplace source when its cache dir is gone", () => {
    const { m, marketplaceDir } = reporterMachine();
    const discovered = discoverEnabledPlugins(m.paths);

    const designDoc = discovered.statuses.find((status) => status.id === "design-doc@teads-plugins");
    expect(designDoc).toMatchObject({ enabled: true });
    expect(designDoc?.plugin?.pluginRoot).toBe(path.join(marketplaceDir, designDocRel));
    expect(designDoc?.resolution?.via).toBe("marketplace-in-place");
    expect(designDoc?.plugin?.skills.map((skill) => skill.name).sort()).toEqual([
      "confluence-slack-summary",
      "design-doc",
    ]);
    expect(discovered.statuses.find((status) => status.id === "code-review-workflow@teads-plugins")?.resolution?.via).toBe(
      "installPath",
    );
    expect(warnings().filter((line) => line.includes("cannot resolve"))).toEqual([]);
  });

  it("registers /design-doc:design-doc like Claude Code", () => {
    const { m } = reporterMachine();
    const loaded = loadBridge({ home: m.home, cwd: m.cwd, env: process.env });
    expect(Object.keys(loaded.patch.command)).toEqual(
      expect.arrayContaining(["design-doc:design-doc", "design-doc:confluence-slack-summary"]),
    );
  });

  it("prefers the live marketplace tree over a stale cache copy", () => {
    const { m, marketplaceDir } = reporterMachine();
    const stale = path.join(m.store, "cache", "teads-plugins", "design-doc", "bae9d808609d");
    writeJson(path.join(stale, ".claude-plugin", "plugin.json"), { name: "design-doc" });
    writeText(path.join(stale, "skills", "old", "SKILL.md"), "---\nname: old\ndescription: stale\n---\n\nold\n");
    const status = discoverEnabledPlugins(m.paths).statuses.find((item) => item.id === "design-doc@teads-plugins");
    expect(status?.plugin?.pluginRoot).toBe(path.join(marketplaceDir, designDocRel));
    expect(status?.plugin?.skills.map((skill) => skill.name)).not.toContain("old");
  });

  it("falls back to the marketplace when the marketplace is only recorded by name", () => {
    const { m, marketplaceDir } = reporterMachine();
    writeKnown(m, { "teads-plugins": { source: { source: "directory", path: marketplaceDir } } });
    const status = discoverEnabledPlugins(m.paths).statuses.find((item) => item.id === "design-doc@teads-plugins");
    expect(status?.resolution?.via).toBe("marketplace-in-place");
  });

  it("`list` reports the resolved root and how it was found", () => {
    const { m, marketplaceDir } = reporterMachine();
    const previous = process.env.HOME;
    process.env.HOME = m.home;
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(cliMain(["list"])).toBe(0);
    } finally {
      process.stdout.write = write;
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
    const listing = JSON.parse(chunks.join("")) as {
      plugins: Array<{ id: string; root: string | null; resolvedVia: string | null; tried: unknown[]; enabled: boolean }>;
    };
    const entry = listing.plugins.find((item) => item.id === "design-doc@teads-plugins");
    expect(entry).toMatchObject({
      enabled: true,
      root: path.join(marketplaceDir, designDocRel),
      resolvedVia: "marketplace-in-place",
    });
  });
});

describe("fallback chain", () => {
  it("uses installPath (absolute) before anything else", () => {
    const m = machine();
    const dir = path.join(tmp(), "abs");
    cpSync(demoFixture, dir, { recursive: true });
    writeInstalled(m, { "demo@local": [{ scope: "user", installPath: dir, version: "1" }] });
    const status = discoverEnabledPlugins(m.paths).statuses[0];
    expect(status?.resolution).toMatchObject({ via: "installPath", root: dir });
  });

  it("falls back to the versioned cache path when installPath is stale", () => {
    const m = machine();
    const cache = path.join(m.store, "cache", "mkt", "demo", "2.0.0");
    cpSync(demoFixture, cache, { recursive: true });
    writeInstalled(m, { "demo@mkt": [{ scope: "user", installPath: "cache/mkt/demo/old", version: "2.0.0" }] });
    const status = discoverEnabledPlugins(m.paths).statuses[0];
    expect(status?.resolution?.via).toBe("cache");
    expect(status?.enabled).toBe(true);
  });

  it("falls back to a git marketplace clone under marketplaces/<name> and uses installPath when present", () => {
    const m = machine();
    const clone = path.join(m.store, "marketplaces", "teads-plugins");
    cpSync(marketplaceFixture, clone, { recursive: true });
    writeKnown(m, {
      "teads-plugins": {
        source: { source: "github", repo: "teads/claude-plugins" },
        installLocation: path.join(m.store, "marketplaces", "teads-plugins"),
      },
    });
    writeInstalled(m, {
      "design-doc@teads-plugins": [{ scope: "user", installPath: "cache/teads-plugins/design-doc/abc", version: "abc" }],
    });
    const missing = discoverEnabledPlugins(m.paths).statuses[0];
    expect(missing?.resolution).toMatchObject({ via: "marketplace", root: path.join(clone, designDocRel) });
    expect(missing?.enabled).toBe(true);

    cpSync(
      path.join(clone, designDocRel),
      path.join(m.store, "cache", "teads-plugins", "design-doc", "abc"),
      { recursive: true },
    );
    const present = discoverEnabledPlugins(m.paths).statuses[0];
    expect(present?.resolution).toMatchObject({
      via: "installPath",
      root: path.join(m.agentsStore, "cache", "teads-plugins", "design-doc", "abc"),
    });
  });

  it("finds a marketplaces/<name> clone even when known_marketplaces.json is missing", () => {
    const m = machine();
    cpSync(marketplaceFixture, path.join(m.store, "marketplaces", "teads-plugins"), { recursive: true });
    writeInstalled(m, { "design-doc@teads-plugins": [{ scope: "user", installPath: "cache/x", version: "x" }] });
    expect(discoverEnabledPlugins(m.paths).statuses[0]?.resolution?.via).toBe("marketplace");
  });

  it("reads a url-style marketplace stored as marketplaces/<name>.json (relative sources cannot resolve)", () => {
    const m = machine();
    writeJson(path.join(m.store, "marketplaces", "web.json"), {
      name: "web",
      owner: { name: "x" },
      plugins: [{ name: "demo", source: "./demo" }],
    });
    writeInstalled(m, { "demo@web": [{ scope: "user", installPath: "cache/web/demo/1", version: "1" }] });
    const status = discoverEnabledPlugins(m.paths).statuses[0];
    expect(status?.enabled).toBe(false);
    expect(status?.reason).toMatch(/source path does not exist/);
  });

  it("resolves a `file` marketplace through its marketplace.json path", () => {
    const m = machine();
    const dir = copyMarketplace();
    writeKnown(m, {
      "teads-plugins": {
        source: { source: "file", path: path.join(dir, ".claude-plugin", "marketplace.json") },
        installLocation: path.join(dir, ".claude-plugin", "marketplace.json"),
      },
    });
    writeInstalled(m, { "design-doc@teads-plugins": [{ scope: "user", installPath: "cache/x", version: "x" }] });
    expect(discoverEnabledPlugins(m.paths).statuses[0]?.resolution).toMatchObject({
      via: "marketplace-in-place",
      root: path.join(dir, designDocRel),
    });
  });

  it("uses marketplaces declared in plugins.json extraKnownMarketplaces", () => {
    const m = machine();
    const dir = copyMarketplace();
    writeJson(path.join(m.home, ".agents", "plugins.json"), {
      extraKnownMarketplaces: { "teads-plugins": { source: { source: "directory", path: dir } } },
    });
    writeInstalled(m, { "design-doc@teads-plugins": [{ scope: "user", installPath: "cache/x", version: "x" }] });
    expect(discoverEnabledPlugins(m.paths).statuses[0]?.resolution?.via).toBe("marketplace-in-place");
  });
});

describe("relative plugin sources", () => {
  it("resolves bare names under metadata.pluginRoot", () => {
    const root = tmp();
    mkdirSync(path.join(root, "plugins", "formatter"), { recursive: true });
    expect(resolveEntrySource(root, "formatter", "./plugins")).toEqual({
      dir: path.join(root, "plugins", "formatter"),
    });
  });

  it("refuses bare names without pluginRoot, `..`, escapes and missing dirs", () => {
    const root = tmp();
    mkdirSync(path.join(root, "a"), { recursive: true });
    expect(resolveEntrySource(root, "a").reason).toMatch(/must start with "\.\/"/);
    expect(resolveEntrySource(root, "./../a").reason).toMatch(/contains "\.\."/);
    expect(resolveEntrySource(root, "./a", "../x").dir).toBe(path.join(root, "a"));
    expect(resolveEntrySource(root, "./missing").reason).toMatch(/does not exist/);
    expect(resolveEntrySource(root, "a", "../plugins").reason).toMatch(/pluginRoot/);
  });

  it('treats "." as the marketplace root', () => {
    const root = tmp();
    expect(resolveEntrySource(root, ".")).toEqual({ dir: root });
  });

  it("reports object sources as remote because only Claude's cache holds them", () => {
    const root = tmp();
    const resolved = resolveEntrySource(root, { source: "github", repo: "org/repo", sha: "a".repeat(40) });
    expect(resolved.dir).toBeUndefined();
    expect(resolved.reason).toMatch(/remote \(github org\/repo\)/);
    expect(resolveEntrySource(root, { source: "git-subdir", url: "org/mono", path: "tools/x" }).reason).toMatch(
      /git-subdir org\/mono tools\/x/,
    );
  });
});

describe("unresolved plugins are explained", () => {
  it("warns and lists every place tried when a remote-source plugin has no cache", () => {
    const m = machine();
    const dir = tmp();
    writeJson(path.join(dir, ".claude-plugin", "marketplace.json"), {
      name: "teads-plugins",
      owner: { name: "x" },
      plugins: [{ name: "design-doc", source: { source: "github", repo: "teads/design-doc" } }],
    });
    writeKnown(m, directoryMarketplace("teads-plugins", dir));
    writeInstalled(m, {
      "design-doc@teads-plugins": [{ scope: "user", installPath: "cache/teads-plugins/design-doc/bae9d808609d", version: "bae9d808609d" }],
    });

    const discovered = discoverEnabledPlugins(m.paths);
    const status = discovered.statuses[0];
    expect(status).toMatchObject({ enabled: false });
    expect(status?.reason).toContain("plugin root unresolved");
    expect(status?.reason).toContain("installPath missing");
    expect(status?.reason).toContain(path.join(m.agentsStore, "cache", "teads-plugins", "design-doc", "bae9d808609d"));
    expect(status?.reason).toContain("versioned cache missing");
    expect(status?.reason).toContain("remote (github teads/design-doc)");
    expect(status?.resolution?.attempts.map((attempt) => attempt.step)).toEqual(["installPath", "cache", "marketplace"]);
    expect(warnings().some((line) => line.includes('cannot resolve plugin "design-doc@teads-plugins"'))).toBe(true);
  });

  it("explains an unknown marketplace and a plugin missing from marketplace.json", () => {
    const m = machine();
    const dir = copyMarketplace();
    writeKnown(m, directoryMarketplace("teads-plugins", dir));
    writeInstalled(m, {
      "ghost@teads-plugins": [{ scope: "user", installPath: "cache/a", version: "1" }],
      "demo@nowhere": [{ scope: "user", installPath: "cache/b", version: "1" }],
      "bare": [{ scope: "user", installPath: "cache/c", version: "1" }],
    });
    const reasons = Object.fromEntries(discoverEnabledPlugins(m.paths).statuses.map((status) => [status.id, status.reason]));
    expect(reasons["ghost@teads-plugins"]).toMatch(/no plugin named "ghost"/);
    expect(reasons["demo@nowhere"]).toMatch(/"nowhere" is not in known_marketplaces\.json/);
    expect(reasons.bare).toMatch(/no @marketplace part/);
  });

  it("stays quiet (debug only) for disabled plugins and prints debug lines when asked", () => {
    const { m } = reporterMachine();
    writeInstalled(m, {
      "gone@teads-plugins": [{ scope: "user", installPath: "cache/gone", version: "1" }],
    });
    writeJson(path.join(m.home, ".agents", "plugins.json"), { enabledPlugins: { "gone@teads-plugins": false } });
    discoverEnabledPlugins(m.paths);
    expect(warnings().filter((line) => line.includes("cannot resolve"))).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();

    process.env[DEBUG_ENV] = "1";
    discoverEnabledPlugins(m.paths);
    const debugLines = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(debugLines.some((line) => line.includes('cannot resolve plugin "gone@teads-plugins"'))).toBe(true);
  });

  it("warns instead of throwing on a malformed known_marketplaces.json", () => {
    const m = machine();
    writeText(path.join(m.store, "known_marketplaces.json"), "{ nope");
    writeInstalled(m, { "design-doc@teads-plugins": [{ scope: "user", installPath: "cache/x", version: "x" }] });
    const status = discoverEnabledPlugins(m.paths).statuses[0];
    expect(status?.enabled).toBe(false);
    expect(warnings().some((line) => line.includes("known_marketplaces.json"))).toBe(true);
  });
});

describe("marketplace entries and plugin.json", () => {
  function inlineMarketplace(entry: Record<string, unknown>, withManifest: boolean): Machine {
    const m = machine();
    const dir = tmp();
    const pluginDir = path.join(dir, "plugins", "inline");
    writeText(path.join(pluginDir, "skills", "default-skill", "SKILL.md"), "---\nname: default-skill\ndescription: d\n---\n\nbody\n");
    writeText(path.join(pluginDir, "extra", "extra-skill", "SKILL.md"), "---\nname: extra-skill\ndescription: d\n---\n\nbody\n");
    if (withManifest) writeJson(path.join(pluginDir, ".claude-plugin", "plugin.json"), { name: "inline", version: "1.2.3" });
    writeJson(path.join(dir, ".claude-plugin", "marketplace.json"), {
      name: "inl",
      owner: { name: "x" },
      plugins: [{ name: "inline", source: "./plugins/inline", ...entry }],
    });
    writeKnown(m, directoryMarketplace("inl", dir));
    writeInstalled(m, { "inline@inl": [{ scope: "user", installPath: "cache/inl/inline/1", version: "1" }] });
    return m;
  }

  it("uses the entry as the manifest when the plugin has no plugin.json", () => {
    const m = inlineMarketplace(
      {
        description: "inline plugin",
        version: "9.9.9",
        skills: ["./extra"],
        mcpServers: { echo: { command: "node", args: ["x.js"] } },
      },
      false,
    );
    const status = discoverEnabledPlugins(m.paths).statuses[0];
    expect(status?.enabled).toBe(true);
    expect(status?.plugin?.manifest).toMatchObject({ name: "inline", description: "inline plugin", version: "9.9.9" });
    expect(status?.plugin?.skills.map((skill) => skill.name).sort()).toEqual(["default-skill", "extra-skill"]);
    expect(Object.keys(status?.plugin?.mcp ?? {})).toEqual(["echo"]);
  });

  it("appends entry components to plugin.json when strict (default) and keeps the manifest version", () => {
    const m = inlineMarketplace({ version: "9.9.9", skills: ["./extra"] }, true);
    const status = discoverEnabledPlugins(m.paths).statuses[0];
    expect(status?.plugin?.manifest.version).toBe("1.2.3");
    expect(status?.plugin?.skills.map((skill) => skill.name).sort()).toEqual(["default-skill", "extra-skill"]);
  });

  it("fails with conflicting manifests when strict is false and both declare components", () => {
    const m = inlineMarketplace({ strict: false, skills: ["./extra"] }, true);
    const status = discoverEnabledPlugins(m.paths).statuses[0];
    expect(status?.enabled).toBe(false);
    expect(status?.reason).toMatch(/conflicting manifests/);
  });

  it("loads plugin.json alone when strict is false and the entry declares no components", () => {
    const m = inlineMarketplace({ strict: false, description: "d" }, true);
    const status = discoverEnabledPlugins(m.paths).statuses[0];
    expect(status?.enabled).toBe(true);
    expect(status?.plugin?.skills.map((skill) => skill.name)).toEqual(["default-skill"]);
  });

  it("applies entry fields when the plugin itself comes from the cache", () => {
    const m = machine();
    const clone = path.join(m.store, "marketplaces", "inl");
    writeJson(path.join(clone, ".claude-plugin", "marketplace.json"), {
      name: "inl",
      owner: { name: "x" },
      plugins: [{ name: "inline", source: "./plugins/inline", skills: ["./extra"], description: "from entry" }],
    });
    writeKnown(m, { inl: { source: { source: "github", repo: "o/r" }, installLocation: clone } });
    const cached = path.join(m.store, "cache", "inl", "inline", "1");
    writeText(path.join(cached, "skills", "default-skill", "SKILL.md"), "---\nname: default-skill\ndescription: d\n---\n\nbody\n");
    writeText(path.join(cached, "extra", "extra-skill", "SKILL.md"), "---\nname: extra-skill\ndescription: d\n---\n\nbody\n");
    writeInstalled(m, { "inline@inl": [{ scope: "user", installPath: cached, version: "1" }] });
    const status = discoverEnabledPlugins(m.paths).statuses[0];
    expect(status?.resolution?.via).toBe("installPath");
    expect(status?.plugin?.manifest.description).toBe("from entry");
    expect(status?.plugin?.skills.map((skill) => skill.name).sort()).toEqual(["default-skill", "extra-skill"]);
  });

  it("an entry at the marketplace root that lists skills replaces the default skills/ scan", () => {
    const m = machine();
    const dir = tmp();
    writeText(path.join(dir, "skills", "one", "SKILL.md"), "---\nname: one\ndescription: d\n---\n\nbody\n");
    writeText(path.join(dir, "skills", "two", "SKILL.md"), "---\nname: two\ndescription: d\n---\n\nbody\n");
    writeJson(path.join(dir, ".claude-plugin", "marketplace.json"), {
      name: "root-mkt",
      owner: { name: "x" },
      plugins: [{ name: "rooty", source: ".", skills: ["./skills/one"] }],
    });
    writeKnown(m, directoryMarketplace("root-mkt", dir));
    writeInstalled(m, { "rooty@root-mkt": [{ scope: "user", installPath: "cache/root-mkt/rooty/1", version: "1" }] });
    const status = discoverEnabledPlugins(m.paths).statuses[0];
    expect(status?.plugin?.pluginRoot).toBe(dir);
    expect(status?.plugin?.skills.map((skill) => skill.name)).toEqual(["one"]);
  });
});

describe("MarketplaceIndex", () => {
  it("only reports in-place for directory/file marketplaces", () => {
    const m = machine();
    const dir = copyMarketplace();
    writeKnown(m, directoryMarketplace("teads-plugins", dir));
    const index = new MarketplaceIndex(m.paths);
    expect(index.lookup("teads-plugins", "design-doc").located?.inPlace).toBe(true);

    const clone = path.join(m.store, "marketplaces", "git-mkt");
    cpSync(marketplaceFixture, clone, { recursive: true });
    expect(new MarketplaceIndex(m.paths).lookup("git-mkt", "design-doc").located?.inPlace).toBe(false);
  });

  it("resolvePluginRoot exposes the entry for later manifest merging", () => {
    const { m } = reporterMachine();
    const record = {
      id: "design-doc@teads-plugins",
      name: "design-doc",
      marketplace: "teads-plugins",
      installations: [{ scope: "user" as const, installPath: "cache/gone", version: "gone" }],
    };
    const resolved = resolvePluginRoot(record, record.installations[0]!, m.paths);
    expect(resolved.entry?.name).toBe("design-doc");
    expect(resolved.via).toBe("marketplace-in-place");
  });
});
