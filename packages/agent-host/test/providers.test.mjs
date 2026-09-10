import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureInput, withHost, sendChunks } from "./support/host-process.mjs";

function anthropic(id, parts, stop = "end_turn") {
  return [
    { type: "message_start", message: { id, type: "message", role: "assistant", model: "fixture-model", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    ...parts,
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 8 } },
    { type: "message_stop" },
  ].map(value => JSON.stringify(value)).concat("[DONE]");
}

test("Anthropic adapter forwards a failed Mivlet tool result and completes the next model step", async () => {
  await withHost(async host => {
    host.write({ type: "start", input: fixtureInput({ providerId: "anthropic" }) });
    const first = await host.nextType("model-request");
    assert.equal(first.body.max_tokens, 256);
    assert.equal(first.body.tools[0].name, "write_summary");
    sendChunks(host, first.id, anthropic("msg-1", [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "anthropic-call", name: "write_summary", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"fixture"}' } },
      { type: "content_block_stop", index: 0 },
    ], "tool_use"));
    const tool = await host.nextType("tool-request");
    assert.equal(tool.callId, "anthropic-call");
    host.write({ type: "tool-result", callId: tool.callId, ok: false, output: "Approval denied by Mivlet." });
    const second = await host.nextType("model-request");
    const result = second.body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.type === "tool_result");
    assert.equal(result.tool_use_id, tool.callId);
    assert.equal(result.is_error, true);
    assert.ok(JSON.stringify(result.content).includes("Approval denied by Mivlet."));
    sendChunks(host, second.id, anthropic("msg-2", [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The action was denied." } },
      { type: "content_block_stop", index: 0 },
    ]));
    assert.equal((await host.nextType("done")).finishReason, "stop");
    assert.equal((await host.waitForExit()).code, 0);
  });
});

test("native provider failure is forwarded without another model request", async () => {
  await withHost(async host => {
    host.write({ type: "start", input: fixtureInput() });
    const request = await host.nextType("model-request");
    sendChunks(host, request.id, [JSON.stringify({ __fableTransport: { kind: "error", code: "authentication", message: "Provider authentication failed.", retryable: false } })]);
    const error = await host.nextType("error");
    assert.equal(error.code, "authentication");
    await host.waitForExit();
    assert.equal(host.events.filter(event => event.type === "model-request").length, 1);
    assert.equal(host.events.some(event => event.type === "done"), false);
  });
});
