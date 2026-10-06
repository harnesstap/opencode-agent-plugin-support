#!/usr/bin/env node
import path from "node:path";
import { discoverEnabledPlugins, loadPluginFromDirectory } from "./discover.js";
import {
  loadActivation,
  setLayerEnabled,
  setUserExtraMarketplaces,
} from "./enablement.js";
import { defaultRuntimePaths } from "./paths.js";
import { saveKnownMarketplace, upsertInstallation } from "./registry-write.js";
import { findPluginRoot, loadManifestFromRoot } from "./manifest.js";

function usage(): string {
  return `opencode-claude-plugins <command>

Commands:
  list                         Show installed plugins with effective enablement and source
  enable <id> [--project]      Set enabledPlugins[id]=true (user or project file)
  disable <id> [--project]     Set enabledPlugins[id]=false (user or project file)
  install-local <dir> [id]     Register a local plugin directory
  marketplace-add <name> <src> Record an extra marketplace (github:org/repo or path)
`;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const paths = defaultRuntimePaths();
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(usage());
    return 0;
  }

  switch (cmd) {
    case "list": {
      const discovered = discoverEnabledPlugins(paths);
      process.stdout.write(
        JSON.stringify(
          {
            pluginsDir: path.join(paths.home, ".agents", "plugins"),
            userFile: discovered.activation.user.path,
            projectFile: discovered.activation.project.path,
            plugins: discovered.statuses.map((status) => ({
              id: status.id,
              enabled: status.enabled,
              source: status.source,
              sourceFile: status.sourceFile ?? null,
              sourceKey: status.sourceKey ?? null,
              reason: status.reason ?? null,
              root: status.plugin?.pluginRoot ?? null,
              skills: status.plugin?.skills.map((skill) => skill.name) ?? [],
              commands: status.plugin?.commands.map((item) => item.name) ?? [],
              agents: status.plugin?.agents.map((item) => item.name) ?? [],
              mcp: status.plugin ? Object.keys(status.plugin.mcp) : [],
              hooks: status.plugin ? Object.keys(status.plugin.hooks) : [],
            })),
          },
          null,
          2,
        ) + "\n",
      );
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
      const decision = setLayerEnabled(paths, id, cmd === "enable", layer);
      process.stdout.write(
        JSON.stringify(
          {
            id,
            requested: cmd === "enable",
            wroteTo: layer,
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
      const dir = rest[0];
      if (!dir) {
        process.stderr.write("missing directory\n");
        return 1;
      }
      const abs = path.resolve(dir);
      const root = findPluginRoot(abs) ?? abs;
      const loaded = loadManifestFromRoot(root, path.basename(root));
      const id = rest[1] ?? `${loaded.manifest.name}@local`;
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

process.exitCode = main(process.argv.slice(2));
