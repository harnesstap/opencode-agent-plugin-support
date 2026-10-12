#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverEnabledPlugins, loadPluginFromDirectory } from "./discover.js";
import { loadConfig, type EffectiveConfig } from "./config.js";
import {
  enablementWriteTarget,
  loadActivation,
  setLayerEnabled,
  setUserExtraMarketplaces,
  type PluginsActivation,
} from "./enablement.js";
import { isDirectory } from "./fs-utils.js";
import { CLI_NAME } from "./identity.js";
import { defaultPluginsDir, defaultRuntimePaths, type RuntimePaths } from "./paths.js";
import { CLAUDE_REGISTRY_WRITE_HELP, writesThroughClaudePluginRegistry } from "./registry-guard.js";
import { saveKnownMarketplace, upsertInstallation } from "./registry-write.js";
import { findPluginRoot, loadManifestFromRoot } from "./manifest.js";

export function usage(): string {
  return `${CLI_NAME} <command>

Commands:
  list                         Show plugins with source, format, effective enablement and where it was decided
  sources | config             Print the effective config: config files, sources, enablement by file
  enable <id> [--project]      Set enabledPlugins[id]=true in agent-plugin-support.json (or legacy plugins.json)
  disable <id> [--project]     Set enabledPlugins[id]=false in agent-plugin-support.json (or legacy plugins.json)
  install-local <dir> [id] [--write-claude-registry]
                               Register a local plugin directory
  marketplace-add <name> <src> Record an extra marketplace (github:org/repo or path)
`;
}

function describeSources(config: EffectiveConfig, counts: Map<string, number> = new Map()) {
  const describe = (source: EffectiveConfig["sources"][number]) => ({
    path: source.path,
    declaredPath: source.declaredPath,
    format: source.format,
    label: source.label,
    origin: source.origin,
    configFile: source.configFile ?? null,
    exists: isDirectory(source.path),
    ...(counts.has(source.path) ? { plugins: counts.get(source.path) } : {}),
  });
  return { active: config.sources.map(describe), disabled: config.disabledSources.map(describe) };
}

function describeEnablement(activation: PluginsActivation) {
  const layers = [activation.projectConfig, activation.userConfig, activation.project, activation.user];
  const out: Record<string, { enabled: boolean; file: string }> = {};
  for (const key of Object.keys(activation.enabledPlugins)) {
    const layer = layers.find((item) => key in item.enabledPlugins);
    if (layer) out[key] = { enabled: layer.enabledPlugins[key] !== false, file: layer.path };
  }
  return out;
}

function sourcesReport(paths: RuntimePaths) {
  const config = loadConfig(paths);
  const activation = loadActivation(paths, config);
  const sources = describeSources(config);
  const file = (layer: { scope?: string; path: string; exists: boolean; error?: string }) => ({
    ...(layer.scope ? { scope: layer.scope } : {}),
    path: layer.path,
    exists: layer.exists,
    ...(layer.error ? { error: layer.error } : {}),
  });
  return {
    mode: config.exists ? "config" : "legacy",
    note: config.exists
      ? "At least one agent-plugin-support.json exists; enabledPlugins there wins over the legacy plugins.json files."
      : "No agent-plugin-support.json found: behaving like 0.1.x (single claude source ~/.agents/plugins, enablement from plugins.json).",
    configFiles: [file(config.project), file(config.user)],
    legacyFiles: [
      { scope: "project", path: activation.project.path, exists: activation.project.exists },
      { scope: "user", path: activation.user.path, exists: activation.user.exists },
    ],
    sources: sources.active,
    disabledSources: sources.disabled,
    enabledPlugins: describeEnablement(activation),
  };
}

export function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const paths = defaultRuntimePaths();
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(usage());
    return 0;
  }

  switch (cmd) {
    case "list": {
      const discovered = discoverEnabledPlugins(paths);
      const counts = new Map(discovered.sources.map((item) => [item.source.path, item.pluginCount]));
      process.stdout.write(
        JSON.stringify(
          {
            pluginsDir: defaultPluginsDir(paths),
            userFile: discovered.activation.user.path,
            projectFile: discovered.activation.project.path,
            configFiles: [discovered.config.project, discovered.config.user].map((layer) => ({
              scope: layer.scope,
              path: layer.path,
              exists: layer.exists,
            })),
            sources: describeSources(discovered.config, counts).active,
            plugins: discovered.statuses.map((status) => ({
              id: status.id,
              enabled: status.enabled,
              source: status.source,
              sourceFile: status.sourceFile ?? null,
              sourceKey: status.sourceKey ?? null,
              reason: status.reason ?? null,
              format: status.format ?? null,
              dualManifest: status.dualManifest ?? false,
              sourcePath: status.origin?.path ?? null,
              sourceLabel: status.origin?.label ?? null,
              sourceFormat: status.origin?.format ?? null,
              root: status.plugin?.pluginRoot ?? status.resolution?.root ?? null,
              resolvedVia: status.resolution?.via ?? null,
              tried: status.resolution?.attempts ?? [],
              skills: status.plugin?.skills.map((skill) => skill.name) ?? [],
              commands: status.plugin?.commands.map((item) => item.name) ?? [],
              agents: status.plugin?.agents.map((item) => item.name) ?? [],
              mcp: status.plugin ? Object.keys(status.plugin.mcp) : [],
              mcpSkipped: status.plugin?.mcpSkipped ?? [],
              hooks: status.plugin ? Object.keys(status.plugin.hooks) : [],
              diagnostics: status.diagnostics ?? [],
            })),
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    case "sources":
    case "config": {
      process.stdout.write(`${JSON.stringify(sourcesReport(paths), null, 2)}\n`);
      return 0;
    }
    case "enable":
    case "disable": {
      const id = rest.find((arg) => !arg.startsWith("-"));
      if (!id) {
        process.stderr.write("missing plugin id\n");
        return 1;
      }
      const layer = rest.includes("--project") ? "project" : "user";
      const target = enablementWriteTarget(paths, layer);
      let decision;
      try {
        decision = setLayerEnabled(paths, id, cmd === "enable", layer);
      } catch (cause) {
        process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
        return 1;
      }
      process.stdout.write(
        JSON.stringify(
          {
            id,
            requested: cmd === "enable",
            wroteTo: layer,
            wroteFile: target.file,
            wroteKind: target.kind,
            enabled: decision.enabled,
            source: decision.source,
            sourceFile: decision.file ?? null,
            sourceKey: decision.key ?? null,
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    case "install-local": {
      const positional = rest.filter((arg) => !arg.startsWith("-"));
      const dir = positional[0];
      if (!dir) {
        process.stderr.write("missing directory\n");
        return 1;
      }
      if (writesThroughClaudePluginRegistry(paths) && !rest.includes("--write-claude-registry")) {
        process.stderr.write(`${CLAUDE_REGISTRY_WRITE_HELP}\n`);
        return 1;
      }
      const abs = path.resolve(dir);
      if (!isDirectory(abs)) {
        process.stderr.write(`directory does not exist: ${abs}\n`);
        return 1;
      }
      const root = findPluginRoot(abs) ?? abs;
      const loaded = loadManifestFromRoot(root, path.basename(root));
      const id = positional[1] ?? `${loaded.manifest.name}@local`;
      upsertInstallation(paths, id, loaded.manifest.name, "local", {
        scope: "user",
        installPath: root,
        isLocal: true,
        version: loaded.manifest.version ?? "0.0.0",
        installedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      });
      loadPluginFromDirectory(root, id, paths);
      process.stdout.write(`installed ${id} from ${root}\n`);
      const defaultStore = defaultPluginsDir(paths);
      if (!loadConfig(paths).sources.some((source) => source.path === defaultStore)) {
        process.stderr.write(
          `note: ${defaultStore} is not one of your configured sources, so ${id} will not load until you add it to "sources" in agent-plugin-support.json\n`,
        );
      }
      return 0;
    }
    case "marketplace-add": {
      const name = rest[0];
      const src = rest[1];
      if (!name || !src) {
        process.stderr.write("usage: marketplace-add <name> <github:org/repo|/path>\n");
        return 1;
      }
      const source = src.startsWith("github:")
        ? { source: "github", repo: src.slice("github:".length) }
        : src.includes("/") && !src.startsWith(".") && !src.startsWith("/")
          ? { source: "github", repo: src }
          : { source: "directory", path: path.resolve(src) };
      saveKnownMarketplace(paths, name, source);
      const activation = loadActivation(paths);
      setUserExtraMarketplaces(paths, {
        ...activation.user.extraKnownMarketplaces,
        [name]: { source },
      });
      process.stdout.write(`added marketplace ${name}\n`);
      return 0;
    }
    default:
      process.stderr.write(usage());
      return 1;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // `npx` and global installs run the bin through a symlink; compare real paths.
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  process.exitCode = main(process.argv.slice(2));
}
