/** OpenCode plugin `id` (v2 `PLUGIN_ID`). Distinct from the npm package name. */
export const PLUGIN_ID = "opencode-agent-plugin-support";

/** Scoped npm package name. */
export const PACKAGE_NAME = "@harnesstap/opencode-agent-plugin-support";

/** CLI bin name (`package.json` `bin` key). */
export const CLI_NAME = "opencode-agent-plugin-support";

/** Set to `1` / `true` to log plugin-root resolution details to stderr. */
export const DEBUG_ENV = "OPENCODE_AGENT_PLUGIN_SUPPORT_DEBUG";

/** File name of the user and project config (`~/.agents/` and `<repo>/.agents/`). */
export const CONFIG_FILE_NAME = "agent-plugin-support.json";

/** Public URL of the config JSON schema (served from the default branch). */
export const CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/harnesstap/opencode-agent-plugin-support/main/schema/agent-plugin-support.schema.json";

/** Client extension namespace (Agent Plugins §8): `com.harnesstap.opencode/` and `extensions["com.harnesstap.opencode"]`. */
export const EXTENSION_NAMESPACE = "com.harnesstap.opencode";
