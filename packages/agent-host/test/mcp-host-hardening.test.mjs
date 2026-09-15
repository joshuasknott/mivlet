import assert from "node:assert/strict";
import { AgentHostProcess } from "./support/host-process.mjs";
import { test } from "./support/windows-host.mjs";

async function withMcpHost(callback, env) {
  const host = new AgentHostProcess(["--mcp"], env);
  try {
    return await callback(host);
  } finally {
    await host.dispose();
  }
}

function initializeResult() {
  return {
    protocolVersion: "2025-11-25",
    capabilities: { tools: {}, resources: {} },
    serverInfo: { name: "fixture-mcp", version: "1" },
  };
}

async function acknowledge(host, event) {
  assert.equal(event.type, "send");
  host.write({ type: "sent", id: event.id, ok: true });
}

async function completeInitialize(host, requestId = 1) {
  host.write({ type: "request", id: requestId, method: "initialize" });
  const initialize = await host.nextType("send");
  assert.equal(initialize.frame.method, "initialize");
  await acknowledge(host, initialize);
  host.write({ type: "frame", frame: { jsonrpc: "2.0", id: initialize.frame.id, result: initializeResult() } });
  const initialized = await host.nextType("send");
  assert.equal(initialized.frame.method, "notifications/initialized");
  await acknowledge(host, initialized);
  const result = await host.next((event) => event.type === "result" && event.id === requestId, "initialize result");
  assert.equal(result.ok, true);
  return result;
}

function lineFor(value) {
  return `${JSON.stringify(value)}\n`;
}

test("MCP host rejects acknowledgements for sends that have not happened", async () => {
  await withMcpHost(async (host) => {
    host.write({ type: "sent", id: 1, ok: true });
    await host.nextType("closed");
    assert.notEqual((await host.waitForExit()).code, 0);
    assert.equal(host.events.some((event) => event.type === "send"), false);
  });
});

test("MCP host drops late results when initialization is cancelled", async () => {
  await withMcpHost(async (host) => {
    host.write({ type: "request", id: 1, method: "initialize" });
    const initialize = await host.nextType("send");
    await acknowledge(host, initialize);
    host.write({ type: "close" });
    await host.nextType("closed");
    const exit = await host.waitForExit();
    assert.equal(exit.code, 0);
    assert.equal(host.events.some((event) => event.type === "result"), false);
    assert.equal(host.events.filter((event) => event.type === "closed").length, 1);
  });
});

test("MCP host drops late results when list-tools is cancelled", async () => {
  await withMcpHost(async (host) => {
    await completeInitialize(host);
    host.write({ type: "request", id: 2, method: "listTools" });
    const list = await host.nextType("send");
    assert.equal(list.frame.method, "tools/list");
    await acknowledge(host, list);
    const before = host.events.length;
    host.write({ type: "close" });
    await host.nextType("closed");
    const exit = await host.waitForExit();
    assert.equal(exit.code, 0);
    assert.equal(host.events.slice(before).some((event) => event.type === "result"), false);
  });
});

test("MCP host treats EOF during initialization as cancellation without results", async () => {
  await withMcpHost(async (host) => {
    host.write({ type: "request", id: 1, method: "initialize" });
    const initialize = await host.nextType("send");
    await acknowledge(host, initialize);
    host.child.stdin.end();
    await host.nextType("closed");
    const exit = await host.waitForExit();
    assert.equal(exit.code, 0);
    assert.equal(host.events.some((event) => event.type === "result"), false);
  });
});

test("MCP host ignores a server response that arrives after close", async () => {
  await withMcpHost(async (host) => {
    host.write({ type: "request", id: 1, method: "initialize" });
    const initialize = await host.nextType("send");
    await acknowledge(host, initialize);
    host.write({ type: "close" });
    await host.nextType("closed");
    host.write({ type: "frame", frame: { jsonrpc: "2.0", id: initialize.frame.id, result: initializeResult() } });
    const exit = await host.waitForExit();
    assert.equal(exit.code, 0);
    assert.equal(host.events.some((event) => event.type === "result"), false);
  });
});

test("MCP host reassembles fragmented input lines", async () => {
  await withMcpHost(async (host) => {
    const line = lineFor({ type: "request", id: 1, method: "initialize" });
    for (const piece of [line.slice(0, 7), line.slice(7, 41), line.slice(41)]) {
      host.child.stdin.write(piece);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const initialize = await host.nextType("send");
    await acknowledge(host, initialize);
    host.write({ type: "frame", frame: { jsonrpc: "2.0", id: initialize.frame.id, result: initializeResult() } });
    const initialized = await host.nextType("send");
    await acknowledge(host, initialized);
    await host.next((event) => event.type === "result" && event.id === 1, "initialize result");
    host.write({ type: "close" });
    await host.nextType("closed");
    assert.equal((await host.waitForExit()).code, 0);
  });
});

test("MCP host fails closed on an oversized input line", async () => {
  await withMcpHost(async (host) => {
    host.child.stdin.write(`${JSON.stringify({ type: "request", id: 1, method: "initialize", bloat: "x".repeat(10 * 1024 * 1024) })}\n`);
    await host.nextType("closed");
    const exit = await host.waitForExit();
    assert.notEqual(exit.code, 0);
  });
});

test("MCP host fails closed on an oversized forwarded frame", async () => {
  await withMcpHost(async (host) => {
    host.write({ type: "frame", frame: { jsonrpc: "2.0", id: 0, result: { tools: ["x".repeat(10 * 1024 * 1024)] } } });
    await host.nextType("closed");
    const exit = await host.waitForExit();
    assert.notEqual(exit.code, 0);
  });
});

test("MCP host fails closed on malformed JSON input", async () => {
  await withMcpHost(async (host) => {
    host.child.stdin.write('{"type": "request", id: 1\n');
    await host.nextType("closed");
    const exit = await host.waitForExit();
    assert.notEqual(exit.code, 0);
  });
});

test("MCP host fails closed on a structurally invalid frame", async () => {
  await withMcpHost(async (host) => {
    host.write({ type: "frame", frame: { jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "both" } } });
    await host.nextType("closed");
    const exit = await host.waitForExit();
    assert.notEqual(exit.code, 0);
  });
});

test("MCP host fails closed on a reused request id", async () => {
  await withMcpHost(async (host) => {
    host.write({ type: "request", id: 1, method: "initialize" });
    await host.nextType("send");
    host.write({ type: "request", id: 1, method: "initialize" });
    await host.nextType("closed");
    const exit = await host.waitForExit();
    assert.notEqual(exit.code, 0);
  });
});

test("MCP host ignores unknown and out-of-order server responses", async () => {
  await withMcpHost(async (host) => {
    host.write({ type: "request", id: 1, method: "initialize" });
    const initialize = await host.nextType("send");
    await acknowledge(host, initialize);
    host.write({ type: "frame", frame: { jsonrpc: "2.0", id: 999, result: initializeResult() } });
    host.write({ type: "frame", frame: { jsonrpc: "2.0", id: initialize.frame.id, result: initializeResult() } });
    const initialized = await host.nextType("send");
    assert.equal(initialized.frame.method, "notifications/initialized");
    await acknowledge(host, initialized);
    const result = await host.next((event) => event.type === "result" && event.id === 1, "initialize result");
    assert.equal(result.ok, true);
    host.write({ type: "frame", frame: { jsonrpc: "2.0", id: initialize.frame.id, result: initializeResult() } });
    host.write({ type: "close" });
    await host.nextType("closed");
    assert.equal((await host.waitForExit()).code, 0);
  });
});

test("MCP host reports initialize timeouts and cancels the pending request", async () => {
  await withMcpHost(async (host) => {
    host.write({ type: "request", id: 1, method: "initialize" });
    const initialize = await host.nextType("send");
    await acknowledge(host, initialize);
    const cancelled = await host.next((event) => event.type === "send" && event.frame?.method === "notifications/cancelled", "cancelled notification");
    assert.equal(cancelled.frame.params.requestId, initialize.frame.id);
    await acknowledge(host, cancelled);
    const result = await host.next((event) => event.type === "result" && event.id === 1, "timed-out initialize result");
    assert.equal(result.ok, false);
    assert.match(result.message, /timed out/i);
    host.write({ type: "close" });
    await host.nextType("closed");
    assert.equal((await host.waitForExit()).code, 0);
  }, { MIVLET_MCP_REQUEST_TIMEOUT_MS: "400" });
});

test("MCP host reports list-tools timeouts and cancels the pending request", async () => {
  await withMcpHost(async (host) => {
    await completeInitialize(host);
    host.write({ type: "request", id: 2, method: "listTools" });
    const list = await host.nextType("send");
    assert.equal(list.frame.method, "tools/list");
    await acknowledge(host, list);
    const cancelled = await host.next((event) => event.type === "send" && event.frame?.method === "notifications/cancelled", "cancelled notification");
    assert.equal(cancelled.frame.params.requestId, list.frame.id);
    await acknowledge(host, cancelled);
    const result = await host.next((event) => event.type === "result" && event.id === 2, "timed-out listTools result");
    assert.equal(result.ok, false);
    host.write({ type: "close" });
    await host.nextType("closed");
    assert.equal((await host.waitForExit()).code, 0);
  }, { MIVLET_MCP_REQUEST_TIMEOUT_MS: "400" });
});

test("MCP host keeps a failed send acknowledgement out of a subsequent session result", async () => {
  await withMcpHost(async (host) => {
    host.write({ type: "request", id: 1, method: "initialize" });
    const initialize = await host.nextType("send");
    host.write({ type: "sent", id: initialize.id, ok: false });
    const result = await host.next((event) => event.type === "result" && event.id === 1, "rejected initialize result");
    assert.equal(result.ok, false);
    host.write({ type: "close" });
    await host.nextType("closed");
    assert.equal((await host.waitForExit()).code, 0);
  });
});
