import assert from "node:assert/strict";
import { chunk, fixtureInput, sendChunks, withHost } from "./support/host-process.mjs";
import { test } from "./support/windows-host.mjs";

// OpenRouter speaks the OpenAI-compatible chat wire, so the embedded host
// routes it through `@opencode/ai/providers/openai-compatible`. These fixtures
// pin the OpenRouter contract end-to-end through the real compiled host (no
// live API): stable model id passthrough, bounded max_tokens output, text
// streaming, interleaved tool-call fragments, approval denial, the documented
// final usage chunk (a content-free delta that repeats the finish_reason),
// mid-stream provider errors, rate limiting, and cancellation.

/** OpenRouter's documented chat-completions terminal chunk: one choice with a
 *  content-free delta repeating the finish_reason, plus the usage object. */
function openRouterUsageChunk(inputTokens, outputTokens, finishReason = "stop") {
  return JSON.stringify({
    id: "fixture-completion",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-model",
    choices: [{ index: 0, delta: { content: "", role: "assistant" }, finish_reason: finishReason, native_finish_reason: finishReason }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  });
}

function openRouterInput(model = "anthropic/claude-sonnet-4.6") {
  const base = fixtureInput();
  return {
    ...base,
    providerId: "openrouter",
    request: { ...base.request, model },
  };
}

test("OpenRouter streams text with bounded max_tokens and the repeated-finish usage chunk as an accounting frame", async () => {
  await withHost(async (host) => {
    host.write({ type: "start", input: openRouterInput("openai/gpt-4.1:free") });
    const request = await host.nextType("model-request");
    // The routed model id travels verbatim (routing suffixes preserved).
    assert.equal(request.body.model, "openai/gpt-4.1:free");
    assert.equal(request.body.max_tokens, 256);
    assert.equal("max_completion_tokens" in request.body, false);
    sendChunks(host, request.id, [
      chunk({ content: "Hello " }),
      chunk({ content: "world" }),
      chunk({}, "stop"),
      openRouterUsageChunk(7, 2),
      "[DONE]",
    ]);
    const done = await host.nextType("done");
    assert.equal(done.finishReason, "stop");
    assert.equal((await host.waitForExit()).code, 0);
    assert.deepEqual(host.events.filter((event) => event.type === "usage"), [
      { type: "usage", inputTokens: 7, outputTokens: 2, costUsd: 0, costUnknown: true },
    ]);
    const deltas = host.events.filter((event) => event.type === "text-delta").map((event) => event.text).join("");
    assert.equal(deltas, "Hello world");
  });
});

test("OpenRouter assembles interleaved tool-call fragments in order with approval gating", async () => {
  await withHost(async (host) => {
    const promptCanary = "MIVLET_OPENROUTER_PROMPT_9C1D";
    host.write({ type: "start", input: { ...openRouterInput(), request: { ...fixtureInput({ prompt: promptCanary }).request, model: "deepseek/deepseek-chat:free" } } });
    const first = await host.nextType("model-request");
    assert.equal(first.body.model, "deepseek/deepseek-chat:free");
    sendChunks(host, first.id, [
      chunk({ content: "Checking the source." }),
      chunk({ tool_calls: [{ index: 0, id: "or-call", function: { name: "write_summary", arguments: '{"query":"fixture"' } }] }),
      chunk({ content: "", tool_calls: [{ index: 0, function: { arguments: '}' } }] }),
      chunk({}, "tool_calls"),
      openRouterUsageChunk(9, 3, "tool_calls"),
      "[DONE]",
    ]);
    const tool = await host.nextType("tool-request");
    assert.equal(tool.callId, "or-call");
    assert.equal(tool.tool, "write_summary");
    assert.deepEqual(JSON.parse(tool.arguments), { query: "fixture" });
    const types = host.events.map((event) => event.type);
    assert.ok(types.indexOf("text-delta") < types.indexOf("tool-request"));
    host.write({ type: "tool-result", callId: tool.callId, ok: true, output: "Fetched." });

    const second = await host.nextType("model-request");
    assert.equal(second.id, 2);
    assert.ok(second.body.messages.some((message) => message.role === "tool" && message.tool_call_id === "or-call" && message.content === "Fetched."));
    sendChunks(host, second.id, [
      chunk({ content: "Final answer." }),
      chunk({}, "stop"),
      openRouterUsageChunk(11, 4),
      "[DONE]",
    ]);
    assert.equal((await host.nextType("done")).finishReason, "stop");
    assert.equal((await host.waitForExit()).code, 0);
    assert.deepEqual(host.events.filter((event) => event.type === "usage"), [
      { type: "usage", inputTokens: 9, outputTokens: 3, costUsd: 0, costUnknown: true },
      { type: "usage", inputTokens: 20, outputTokens: 7, costUsd: 0, costUnknown: true },
    ]);
    // No prompt canary is ever written to the host's temp directory.
    assert.equal(host.containsBytes(promptCanary), false);
  });
});

test("OpenRouter denial of an approved-request tool call continues the turn with the denied result", async () => {
  await withHost(async (host) => {
    host.write({ type: "start", input: openRouterInput() });
    const first = await host.nextType("model-request");
    sendChunks(host, first.id, [
      chunk({ tool_calls: [{ index: 0, id: "denied-call", function: { name: "write_summary", arguments: '{"query":"denied"}' } }] }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ]);
    const tool = await host.nextType("tool-request");
    host.write({ type: "tool-result", callId: tool.callId, ok: false, output: "Approval denied by Mivlet." });
    const second = await host.nextType("model-request");
    // The OpenAI-compatible wire carries the denied result back as a tool
    // message bound to the exact call id (Anthropic's is_error flag is not
    // part of this wire family).
    const denied = second.body.messages.find((message) => message.role === "tool" && message.tool_call_id === tool.callId);
    assert.ok(denied, "the denied tool result must return to the model");
    assert.ok(denied.content.includes("Approval denied by Mivlet."));
    sendChunks(host, second.id, [
      chunk({ content: "The action was denied." }),
      chunk({}, "stop"),
      openRouterUsageChunk(5, 2),
      "[DONE]",
    ]);
    assert.equal((await host.nextType("done")).finishReason, "stop");
    assert.equal((await host.waitForExit()).code, 0);
  });
});

test("OpenRouter preserves signed and encrypted reasoning across a tool continuation", async () => {
  await withHost(async (host) => {
    host.write({ type: "start", input: openRouterInput() });
    const first = await host.nextType("model-request");
    const details = [
      { type: "reasoning.text", text: "Check the source.", signature: "fixture-signature", format: "anthropic-claude-v1", index: 0 },
      { type: "reasoning.encrypted", data: "fixture-encrypted-reasoning", id: "reasoning-1", format: "anthropic-claude-v1", index: 1 },
    ];
    sendChunks(host, first.id, [
      chunk({ reasoning_details: details }),
      chunk({ tool_calls: [{ index: 0, id: "signed-call", function: { name: "write_summary", arguments: '{"query":"fixture"}' } }] }),
      chunk({}, "tool_calls"), openRouterUsageChunk(9, 3, "tool_calls"), "[DONE]",
    ]);
    const tool = await host.nextType("tool-request");
    host.write({ type: "tool-result", callId: tool.callId, ok: true, output: "Fetched." });
    const second = await host.nextType("model-request");
    const assistant = second.body.messages.find(message => message.role === "assistant" && message.tool_calls?.some(call => call.id === "signed-call"));
    assert.deepEqual(assistant?.reasoning_details, details);
    sendChunks(host, second.id, [chunk({ content: "Done." }), chunk({}, "stop"), openRouterUsageChunk(11, 4), "[DONE]"]);
    assert.equal((await host.nextType("done")).finishReason, "stop");
    assert.equal((await host.waitForExit()).code, 0);
  });
});

test("OpenRouter mid-stream provider errors surface truthfully without a second model request", async () => {
  await withHost(async (host) => {
    host.write({ type: "start", input: openRouterInput() });
    const request = await host.nextType("model-request");
    // OpenRouter's documented mid-stream error shape: a top-level error field
    // with a terminating `finish_reason: "error"` choice.
    sendChunks(host, request.id, [
      JSON.stringify({
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture-model",
        provider: "openai",
        error: { code: "server_error", message: "Provider disconnected unexpectedly" },
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
      }),
    ]);
    const error = await host.nextType("error");
    assert.equal(error.type, "error");
    const exit = await host.waitForExit();
    assert.equal(exit.code, 0);
    assert.equal(host.events.filter((event) => event.type === "model-request").length, 1);
    assert.equal(host.events.some((event) => event.type === "done"), false);
  });
});

test("OpenRouter rate limiting surfaces as a classified error and stops the turn", async () => {
  await withHost(async (host) => {
    host.write({ type: "start", input: openRouterInput() });
    const request = await host.nextType("model-request");
    sendChunks(host, request.id, [
      JSON.stringify({ __mivletTransport: { kind: "error", code: "rate-limited", message: "Provider returned HTTP 429.", retryable: true } }),
    ]);
    const error = await host.nextType("error");
    assert.equal(error.code, "rate-limited");
    assert.equal(error.retryable, true);
    const exit = await host.waitForExit();
    assert.equal(exit.code, 0);
    assert.equal(host.events.filter((event) => event.type === "model-request").length, 1);
    assert.equal(host.events.some((event) => event.type === "done"), false);
  });
});

test("OpenRouter cancellation stops a pending tool turn without late effects", async () => {
  await withHost(async (host) => {
    host.write({ type: "start", input: openRouterInput() });
    const first = await host.nextType("model-request");
    sendChunks(host, first.id, [
      chunk({ content: "Before waiting." }),
      chunk({ tool_calls: [{ index: 0, id: "or-delayed", function: { name: "write_summary", arguments: '{"query":"delayed"}' } }] }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ]);
    const tool = await host.nextType("tool-request");
    assert.equal(tool.callId, "or-delayed");
    host.write({ type: "cancel" });
    const cancelled = await host.nextType("cancelled");
    assert.equal(cancelled.type, "cancelled");
    host.write({ type: "tool-result", callId: tool.callId, ok: true, output: "late result" });
    const exit = await host.waitForExit();
    assert.equal(exit.code, 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(host.events.some((event) => event.type === "model-request" && event.id > first.id), false);
    assert.equal(host.events.some((event) => event.type === "tool-result"), false);
  });
});
