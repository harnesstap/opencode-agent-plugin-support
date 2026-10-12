#!/usr/bin/env node
// Minimal dependency-free stdio MCP server used by the live smoke: one tool, `whoami`,
// that reports the environment and working directory the client launched it with.
import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = request;
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "ap-demo-whoami", version: "1.0.0" },
      },
    });
  } else if (method === "tools/list") {
    send({
      id,
      result: {
        tools: [
          {
            name: "whoami",
            description: "Report PLUGIN_ROOT, PLUGIN_DATA, FROM_CONFIG, the working directory and args.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
  } else if (method === "tools/call") {
    const report = {
      PLUGIN_ROOT: process.env.PLUGIN_ROOT ?? null,
      PLUGIN_DATA: process.env.PLUGIN_DATA ?? null,
      FROM_CONFIG: process.env.FROM_CONFIG ?? null,
      cwd: process.cwd(),
      args: process.argv.slice(2),
    };
    send({ id, result: { content: [{ type: "text", text: JSON.stringify(report) }] } });
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: `unsupported: ${method}` } });
  }
});
