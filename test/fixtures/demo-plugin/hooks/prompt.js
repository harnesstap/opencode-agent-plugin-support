#!/usr/bin/env node
import fs from "node:fs";

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
if (String(input.prompt ?? "").includes("DENYPROMPT")) {
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: "fixture denied prompt",
    }),
  );
  process.exit(0);
}
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "fixture-prompt-ok",
    },
  }),
);
