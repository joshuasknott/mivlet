import assert from "node:assert/strict";
import { AgentHostProcess } from "./support/host-process.mjs";
import { test } from "./support/windows-host.mjs";

async function withMcpHost(callback, args = ["--mcp"]) {
  const host = new AgentHostProcess(args);
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

test("MCP host performs official-SDK initialize and paginated tool discovery", async () => {
  await withMcpHost(async (host) => {
    host.write({ type: "request", id: 1, method: "initialize" });
    const initialize = await host.nextType("send");
    assert.equal(initialize.frame.method, "initialize");
    await acknowledge(host, initialize);
    host.write({
      type: "frame",
      frame: { jsonrpc: "2.0", id: initialize.frame.id, result: initializeResult() },
    });

    const initialized = await host.nextType("send");
    assert.deepEqual(initialized.frame, { jsonrpc: "2.0", method: "notifications/initialized" });
    await acknowledge(host, initialized);
    const initializeResultEvent = await host.next((event) => event.type === "result" && event.id === 1, "initialize result");
    assert.equal(initializeResultEvent.ok, true);
    assert.equal(initializeResultEvent.value.serverInfo.name, "fixture-mcp");

    host.write({ type: "request", id: 2, method: "listTools" });
    const list = await host.nextType("send");
    assert.equal(list.frame.method, "tools/list");
    await acknowledge(host, list);
    host.write({
      type: "frame",
      frame: {
        jsonrpc: "2.0",
        id: list.frame.id,
        result: { tools: [{ name: "first", inputSchema: { type: "object" } }] },
      },
    });
    const tools = await host.next((event) => event.type === "result" && event.id === 2, "listTools result");
    assert.equal(tools.ok, true);
    assert.deepEqual(tools.value.map((tool) => tool.name), ["first"]);

    host.write({ type: "close" });
    const closed = await host.nextType("closed");
    assert.equal(closed.type, "closed");
    assert.equal((await host.waitForExit()).code, 0);
  });
});

test("MCP host rejects tools/call commands at the host IPC boundary", async () => {
  await withMcpHost(async (host) => {
    host.write({ type: "request", id: 1, method: "tools/call" });
    const closed = await host.nextType("closed");
    assert.equal(closed.type, "closed");
    const exit = await host.waitForExit();
    assert.notEqual(exit.code, 0);
    assert.equal(host.events.some((event) => event.type === "send" || event.type === "result"), false);
  });
});

test("MCP host rejects unsolicited server requests before SDK handlers can answer", async () => {
  await withMcpHost(async (host) => {
    host.write({ type: "request", id: 1, method: "initialize" });
    const initialize = await host.nextType("send");
    await acknowledge(host, initialize);
    host.write({
      type: "frame",
      frame: { jsonrpc: "2.0", id: initialize.frame.id, result: initializeResult() },
    });
    const initialized = await host.nextType("send");
    await acknowledge(host, initialized);
    await host.next((event) => event.type === "result" && event.id === 1, "initialize result");

    host.write({
      type: "frame",
      frame: { jsonrpc: "2.0", id: "server-request", method: "sampling/createMessage", params: {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(host.events.some((event) => event.type === "send" && event.frame?.id === "server-request"), false);

    host.write({ type: "close" });
    await host.nextType("closed");
    assert.equal((await host.waitForExit()).code, 0);
  });
});

test("MCP host fails closed on an unexpected send acknowledgement", async () => {
  await withMcpHost(async (host) => {
    host.write({ type: "request", id: 1, method: "initialize" });
    const initialize = await host.nextType("send");
    host.write({ type: "sent", id: initialize.id + 100, ok: true });
    await host.nextType("closed");
    assert.notEqual((await host.waitForExit()).code, 0);
  });
});

test("MCP host closes cleanly on explicit close and EOF", async () => {
  await withMcpHost(async (host) => {
    host.write({ type: "close" });
    host.write({ type: "close" });
    await host.nextType("closed");
    assert.equal(host.events.filter((event) => event.type === "closed").length, 1);
    assert.equal((await host.waitForExit()).code, 0);
  });

  await withMcpHost(async (host) => {
    host.child.stdin.end();
    await host.nextType("closed");
    assert.equal((await host.waitForExit()).code, 0);
  });
});
