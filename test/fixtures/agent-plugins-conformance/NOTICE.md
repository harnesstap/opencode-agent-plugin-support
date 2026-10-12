# Vendored: Agent Plugins conformance fixtures

These plugin directories are copied unmodified from
[agentplugins/agent-plugins-conformance](https://github.com/agentplugins/agent-plugins-conformance)
at commit `6bfce5436435ffed10ab0020ee0f331ddeb640d6` (`plugins/`), Copyright 2026 Vercel, Inc.

Licensing follows the upstream split (see `LICENSE.md` and `LICENSES/`): software and configuration
files (`plugin.json`, `mcp.json`, scripts) are Apache-2.0; documentation (READMEs, skill text) is CC-BY-4.0.

Only what a loader needs is vendored: manifests, `mcp.json`, skills, the fixture symlinks, and the
directories the MCP entries point at. The bundled `dist/` MCP probes and `src/` (about 2.5 MB, with
third-party notices) are omitted because these tests check what this package loads from the fixtures,
not that a probe server runs. `test/agent-plugins-conformance.test.ts` is the consumer.

The symlinks in `agent-plugins-conformance-recovery/` (`escape-link`, `escape-command-*`) are part of
the fixtures: they point outside the plugin and must be refused.
