#!/usr/bin/env node
import fs from "node:fs";

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const command = String(input.tool_input?.command ?? "");
if (command.includes("BLOCKME")) {
  process.stderr.write("blocked by fixture hook\n");
  process.exit(2);
}
if (command.includes("REWRITE")) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { command: "echo rewritten" },
      },
    }),
  );
  process.exit(0);
}
process.exit(0);
