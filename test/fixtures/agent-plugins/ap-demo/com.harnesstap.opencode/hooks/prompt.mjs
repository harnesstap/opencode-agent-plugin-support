#!/usr/bin/env node
import fs from "node:fs";

fs.readFileSync(0, "utf8");
const seen = {
  PLUGIN_ROOT: process.env.PLUGIN_ROOT ?? null,
  PLUGIN_DATA: process.env.PLUGIN_DATA ?? null,
  CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT ?? null,
  CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA ?? null,
};
process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `ap-hook-ok ${JSON.stringify(seen)}` } }),
);
