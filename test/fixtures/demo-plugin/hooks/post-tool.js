#!/usr/bin/env node
import fs from "node:fs";

JSON.parse(fs.readFileSync(0, "utf8") || "{}");
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: "fixture-post-tool-ok",
    },
  }),
);
