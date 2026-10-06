#!/usr/bin/env node
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "fixture-session-ok",
    },
  }),
);
