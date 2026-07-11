import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  const request = JSON.parse(line);
  let result;
  if (request.method === "initialize") {
    result = {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "fable-test-mcp", version: "1" }
    };
  } else if (request.method === "tools/list") {
    result = {
      tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }]
    };
  } else if (request.method === "tools/call") {
    result = { content: [{ type: "text", text: request.params.arguments.text }] };
  } else {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Method not found" }
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});

