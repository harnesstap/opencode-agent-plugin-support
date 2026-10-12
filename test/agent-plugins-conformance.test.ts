import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverEnabledPlugins, loadPluginFromDirectory } from "../src/discover.js";
import { conformance, machine, symlinksSupported, useTestEnvironment, writeJson } from "./helpers.js";

/**
 * Runs the official agentplugins/agent-plugins-conformance fixture plugins (vendored, see
 * fixtures/agent-plugins-conformance/NOTICE.md) through this package's loader. The upstream suite
 * drives a live client; here we check the loader's decisions on the same inputs.
 */
const env = useTestEnvironment("ocp-conf-");

function load(name: string) {
  const m = machine(env.tmp);
  return loadPluginFromDirectory(path.join(conformance, name), `${name}@conformance`, m.paths);
}

describe("conformance: core plugin", () => {
  it("loads exactly the two immediate-child skills and never the nested reference", () => {
    const plugin = load("agent-plugins-conformance-core");
    expect(plugin.format).toBe("agent-plugins");
    expect(plugin.skills.map((skill) => skill.name)).toEqual(["conformance-alpha", "conformance-beta"]);
  });

  it("keeps every valid stdio / streamable-http server and skips only the SSE ones", () => {
    const plugin = load("agent-plugins-conformance-core");
    expect(Object.keys(plugin.mcp).sort()).toEqual(
      [
        "command-token-posix",
        "command-token-windows",
        "data",
        "default",
        "http",
        "http-redirect",
        "relative",
        "root",
      ].sort(),
    );
    expect(plugin.mcpSkipped.map((item) => item.server).sort()).toEqual([
      "sse",
      "sse-endpoint-origin",
      "sse-header-precedence",
      "sse-redirect",
    ]);
    for (const skipped of plugin.mcpSkipped) expect(skipped.reason).toMatch(/unsupported transport "sse"/);
  });

  it("omitted cwd is the plugin root; relative and root-placeholder cwd resolve to probe-workdir", () => {
    const plugin = load("agent-plugins-conformance-core");
    const local = (name: string) => plugin.mcp[name] as { cwd: string; command: string[]; environment: Record<string, string> };
    expect(local("default").cwd).toBe(plugin.pluginRoot);
    expect(local("relative").cwd).toBe(path.join(plugin.pluginRoot, "probe-workdir"));
    expect(local("root").cwd).toBe(path.join(plugin.pluginRoot, "probe-workdir"));
  });

  it("puts PLUGIN_DATA in the data-rooted cwd and creates the directory", () => {
    const plugin = load("agent-plugins-conformance-core");
    const data = plugin.mcp.data as { cwd: string; environment: Record<string, string> };
    expect(data.cwd).toBe(data.environment.PLUGIN_DATA);
    expect(path.isAbsolute(data.cwd)).toBe(true);
  });

  it("sets PLUGIN_ROOT / PLUGIN_DATA after the configured env, and configured env wins for everything else", () => {
    const plugin = load("agent-plugins-conformance-core");
    const server = plugin.mcp.default as { environment: Record<string, string>; command: string[] };
    expect(server.environment.PLUGIN_ROOT).toBe(plugin.pluginRoot);
    expect(server.environment.APC_VALUE).toBe("fixture value with spaces");
    expect(server.environment.USER).toBe("apc-configured-environment-precedence");
    const data = server.environment.PLUGIN_DATA!;
    expect(server.environment.APC_EXPANSION).toBe(`${plugin.pluginRoot}|${data}|${plugin.pluginRoot}`);
    expect(server.environment.APC_LITERAL).toBe("${APC_UNKNOWN}|$APC_VALUE|${PLUGIN_ROOT_SUFFIX}");
  });

  it("preserves argument boundaries, expands only the two placeholders and leaves lookalikes literal", () => {
    const plugin = load("agent-plugins-conformance-core");
    const server = plugin.mcp.default as { environment: Record<string, string>; command: string[] };
    const data = server.environment.PLUGIN_DATA!;
    expect(server.command).toEqual([
      "node",
      path.join(plugin.pluginRoot, "dist/probe.mjs"),
      "default",
      "arg with spaces",
      "",
      plugin.pluginRoot,
      data,
      "${APC_UNKNOWN}",
      "$APC_VALUE",
      "${PLUGIN_ROOT_SUFFIX}",
    ]);
  });

  it("keeps a plugin-relative command with a space as one token resolved against the plugin root, not the cwd", () => {
    const plugin = load("agent-plugins-conformance-core");
    const server = plugin.mcp["command-token-posix"] as { command: string[]; cwd: string };
    // probe-workdir holds a decoy of the same relative path
    expect(server.command[0]).toBe(path.join(plugin.pluginRoot, "bin", "posix", "probe token.sh"));
    expect(server.command.slice(1)).toEqual(["arg with spaces", "", "literal-value"]);
    expect(server.cwd).toBe(path.join(plugin.pluginRoot, "probe-workdir"));
  });

  it("passes URL and headers through literally (no expansion) and drops nothing", () => {
    const plugin = load("agent-plugins-conformance-core");
    expect(plugin.mcp.http).toEqual({
      type: "remote",
      url: "http://127.0.0.1:43187/conformance/mcp?value=$APC_HTTP_VALUE",
      enabled: true,
      headers: { AcCePt: "text/plain", "x-apc-fixture": "${PLUGIN_ROOT}|${PLUGIN_DATA}|fixture value with spaces" },
    });
  });
});

describe("conformance: recovery plugin", () => {
  const invalid = [
    ["recovery-invalid", /"command" is required/],
    ["recovery-missing-type", /"type" is required/],
    ["recovery-cwd-invalid-form", /"cwd" "\." must start with/],
    ["recovery-cwd-escape", /"cwd" .*outside/],
    ["recovery-cwd-data-escape", /"cwd" .*outside/],
    ["recovery-unknown-field", /unknown field "conformanceUnknown"/],
    ["recovery-env-plugin-root", /must not define PLUGIN_ROOT/],
    ["recovery-env-plugin-data", /must not define PLUGIN_DATA/],
    ["recovery-http-non-loopback", /"url" must use https/],
    ["recovery-http-relative-url", /"url" must be an absolute http\(s\) URL/],
    ["recovery-http-type", /unknown "type" "http"/],
    ["recovery-http-header-name", /not a valid HTTP field name/],
    ["recovery-http-header-value", /invalid value/],
    ["recovery-http-userinfo", /user information/],
    ["recovery-http-fragment", /fragment/],
    ["recovery-http-duplicate-headers", /defined twice/],
    ["recovery-sse-non-loopback", /"url" must use https/],
    ["recovery-sse-relative-url", /absolute http\(s\) URL/],
    ["recovery-sse-fragment", /fragment/],
    ["recovery-sse-userinfo", /user information/],
    ["recovery-sse-duplicate-headers", /defined twice/],
    ["recovery-sse-header-name", /not a valid HTTP field name/],
    ["recovery-sse-header-value", /invalid value/],
  ] as const;

  it("loads the plugin despite an unknown manifest field and a non-object extensions", () => {
    const plugin = load("agent-plugins-conformance-recovery");
    expect(plugin.name).toBe("agent-plugins-conformance-recovery");
    expect(plugin.diagnostics).toEqual(
      expect.arrayContaining([
        `unknown plugin.json field "conformanceUnknown" ignored`,
        `"extensions" is not an object; ignoring it`,
      ]),
    );
  });

  it("keeps the valid skill and skips the one with malformed frontmatter", () => {
    const plugin = load("agent-plugins-conformance-recovery");
    expect(plugin.skills.map((skill) => skill.name)).toEqual(["conformance-recovery-valid"]);
    expect(plugin.diagnostics.some((line) => /skipping skill "conformance-recovery-invalid"/.test(line))).toBe(true);
  });

  it.skipIf(!symlinksSupported)("keeps only recovery-valid; every other entry is skipped for the documented reason", () => {
    const plugin = load("agent-plugins-conformance-recovery");
    expect(Object.keys(plugin.mcp)).toEqual(["recovery-valid"]);
    const reasons = new Map(plugin.mcpSkipped.map((item) => [item.server, item.reason]));
    for (const [server, pattern] of invalid) {
      expect(reasons.get(server), server).toMatch(pattern);
    }
    expect(reasons.get("recovery-cwd-symlink-escape")).toMatch(/outside/);
    expect(reasons.get("recovery-command-symlink-posix")).toMatch(/"command" .*outside/);
    expect(reasons.get("recovery-command-symlink-windows")).toMatch(/"command"/);
    expect(plugin.mcpSkipped).toHaveLength(invalid.length + 3);
  });
});

describe("conformance: invalid-mcp plugin", () => {
  it("disables MCP for a malformed mcp.json but keeps the skill", () => {
    const plugin = load("agent-plugins-conformance-invalid-mcp");
    expect(plugin.mcp).toEqual({});
    expect(plugin.skills.map((skill) => skill.name)).toEqual(["conformance-invalid-mcp-valid"]);
    expect(plugin.diagnostics.some((line) => /MCP disabled: mcp\.json is not valid JSON/.test(line))).toBe(true);
  });
});

describe("conformance: runner plugin and source scan", () => {
  it("a skills-only plugin with no mcp.json loads cleanly", () => {
    const plugin = load("agent-plugins-conformance");
    expect(plugin.skills.map((skill) => skill.name)).toEqual(["run-conformance"]);
    expect(plugin.diagnostics).toEqual([]);
  });

  it("an agent-plugins source over the whole suite finds all four plugins with name@label ids", () => {
    const m = machine(env.tmp);
    writeJson(path.join(m.home, ".agents", "agent-plugin-support.json"), {
      sources: [{ path: conformance, format: "agent-plugins", label: "apc" }],
    });
    const discovered = discoverEnabledPlugins(m.paths);
    expect(discovered.statuses.map((status) => status.id)).toEqual([
      "agent-plugins-conformance@apc",
      "agent-plugins-conformance-core@apc",
      "agent-plugins-conformance-invalid-mcp@apc",
      "agent-plugins-conformance-recovery@apc",
    ]);
    expect(discovered.statuses.every((status) => status.enabled && status.format === "agent-plugins")).toBe(true);
  });
});
