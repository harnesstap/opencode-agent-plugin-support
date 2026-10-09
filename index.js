/** Local-folder entry for OpenCode V2 (`plugins: ["/path/to/this-repo"]`).
 *  V2 ignores package.json `main` and only loads `index.*` / `server.*` at the folder root. */
export { default, ClaudeCodePlugins, createClaudeCodeBridge, PLUGIN_ID, setup } from "./dist/index.js";
