import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk, fixtureInput, withHost, sendChunks } from "./support/host-process.mjs";

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

test("native provider retry is forwarded and the same model request can continue", async () => {
  await withHost(async host => {
    host.write({ type: "start", input: fixtureInput() });
    const request = await host.nextType("model-request");
    sendChunks(host, request.id, [
      JSON.stringify({ __fableTransport: { kind: "retrying", code: "rate-limited", message: "Retrying.", retryable: true } }),
      chunk({ content: "Recovered." }),
      chunk({}, "stop"),
      "[DONE]",
    ]);
    assert.equal((await host.nextType("retrying")).type, "retrying");
    assert.equal((await host.nextType("done")).finishReason, "stop");
    assert.equal((await host.waitForExit()).code, 0);
    assert.equal(host.events.filter(event => event.type === "model-request").length, 1);
  });
});

test("OpenAI and compatible providers retain their established token-limit fields", async () => {
  const cases = [
    { providerId: "openai", model: "gpt-5-mini", field: "max_completion_tokens" },
    { providerId: "openai", model: "gpt-4.1-mini", field: "max_tokens" },
    { providerId: "xai", model: "grok-4", field: "max_tokens" },
    { providerId: "custom", model: "custom-model", field: "max_tokens" },
  ];
  for (const entry of cases) {
    await withHost(async host => {
      const base = fixtureInput();
      host.write({ type: "start", input: {
        ...base,
        providerId: entry.providerId,
        request: { ...base.request, model: entry.model, tools: [] },
      } });
      const request = await host.nextType("model-request");
      assert.equal(request.body[entry.field], 256);
      const other = entry.field === "max_tokens" ? "max_completion_tokens" : "max_tokens";
      assert.equal(other in request.body, false);
      sendChunks(host, request.id, [chunk({ content: "Done." }), chunk({}, "stop"), "[DONE]"]);
      assert.equal((await host.nextType("done")).finishReason, "stop");
      assert.equal((await host.waitForExit()).code, 0);
    });
  }
});
