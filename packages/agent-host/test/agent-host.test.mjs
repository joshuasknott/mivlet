import assert from "node:assert/strict";
import {
  chunk,
  fixtureInput,
  sendChunks,
  usageChunk,
  withHost,
} from "./support/host-process.mjs";
import { test } from "./support/windows-host.mjs";

test("runs a tool turn through two model requests and preserves text before tool order", async () => {
  await withHost(async (host) => {
    const promptCanary = "MIVLET_PROMPT_CANARY_4F75E1";
    const resultCanary = "MIVLET_RESULT_CANARY_93A2BC";
    const input = fixtureInput({ prompt: promptCanary });
    host.write({ type: "start", input });

    const first = await host.nextType("model-request");
    assert.equal(first.id, 1);
    assert.equal(first.body.model, "fixture-model");
    assert.equal(first.body.stream, true);
    assert.equal(first.body.max_tokens, 256);
    assert.equal("max_completion_tokens" in first.body, false);
    assert.ok(Array.isArray(first.body.tools));
    assert.equal(first.body.tools[0].type, "function");
    assert.equal(first.body.tools[0].function.name, "write_summary");
    assert.equal(first.body.tools[0].function.description, "Write a short fixture summary.");
    assert.deepEqual(first.body.tools[0].function.parameters, JSON.parse(input.request.tools[0].parameters));

    sendChunks(host, first.id, [
      chunk({ content: "Before the tool." }),
      chunk({ tool_calls: [{ index: 0, id: "summary-call", function: { name: "write_summary", arguments: '{"query":"fixture"}' } }] }),
      chunk({}, "tool_calls"),
      usageChunk(100, 10),
      "[DONE]",
    ]);
    const tool = await host.nextType("tool-request");
    assert.equal(tool.callId, "summary-call");
    assert.equal(tool.tool, "write_summary");
    assert.deepEqual(JSON.parse(tool.arguments), { query: "fixture" });
    host.write({ type: "tool-result", callId: tool.callId, ok: true, output: resultCanary });

    const second = await host.nextType("model-request");
    assert.equal(second.id, 2);
    assert.ok(second.body.messages.some((message) => message.role === "tool" && message.tool_call_id === "summary-call" && message.content === resultCanary));
    assert.ok(second.body.tools?.some((toolSpec) => toolSpec.function?.name === "write_summary"));
    sendChunks(host, second.id, [
      chunk({ content: "Final answer." }),
      chunk({}, "stop"),
      usageChunk(120, 5),
      "[DONE]",
    ]);

    const done = await host.nextType("done");
    assert.equal(done.finishReason, "stop");
    const exit = await host.waitForExit();
    assert.equal(exit.code, 0);
    const types = host.events.map((event) => event.type);
    const modelRequests = types.flatMap((type, index) => type === "model-request" ? [index] : []);
    assert.ok(types.indexOf("text-delta") < types.indexOf("tool-request"));
    assert.equal(modelRequests.length, 2);
    assert.ok(types.indexOf("tool-request") < modelRequests[1]);
    assert.deepEqual(host.events.filter((event) => event.type === "usage"), [
      { type: "usage", inputTokens: 100, outputTokens: 10, costUsd: 0, costUnknown: true },
      { type: "usage", inputTokens: 220, outputTokens: 15, costUsd: 0, costUnknown: true },
    ]);
    assert.ok(host.frames.some((frame) => frame.type === "tool-result" && frame.callId === "summary-call" && frame.output === resultCanary));
    assert.equal(host.containsBytes(promptCanary), false);
    assert.equal(host.containsBytes(resultCanary), false);
  });
});

test("treats maxTurns as a model-step budget and disables tools on the final step", async () => {
  await withHost(async (host) => {
    host.write({ type: "start", input: fixtureInput({ maxTurns: 1 }) });
    const request = await host.nextType("model-request");
    assert.equal(request.body.tool_choice, "none");
    sendChunks(host, request.id, [chunk({ content: "Budgeted answer." }), chunk({}, "stop"), "[DONE]"]);
    assert.equal((await host.nextType("done")).finishReason, "stop");
    assert.equal((await host.waitForExit()).code, 0);
    assert.equal(host.events.filter((event) => event.type === "model-request").length, 1);
    assert.equal(host.events.some((event) => event.type === "tool-request"), false);
  });
});

test("cancels a delayed tool response without late model requests or tool effects", async () => {
  await withHost(async (host) => {
    host.write({ type: "start", input: fixtureInput() });
    const first = await host.nextType("model-request");
    sendChunks(host, first.id, [
      chunk({ content: "Before waiting." }),
      chunk({ tool_calls: [{ index: 0, id: "delayed-call", function: { name: "write_summary", arguments: '{"query":"delayed"}' } }] }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ]);
    const tool = await host.nextType("tool-request");
    assert.equal(tool.callId, "delayed-call");
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

test("fails closed on a mismatched tool reply", async () => {
  await withHost(async (host) => {
    host.write({ type: "start", input: fixtureInput() });
    const first = await host.nextType("model-request");
    sendChunks(host, first.id, [
      chunk({ tool_calls: [{ index: 0, id: "expected-call", function: { name: "write_summary", arguments: '{"query":"mismatch"}' } }] }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ]);
    await host.nextType("tool-request");
    host.write({ type: "tool-result", callId: "wrong-call", ok: true, output: "should be rejected" });
    const error = await host.nextType("error");
    assert.equal(error.type, "error");
    const exit = await host.waitForExit();
    assert.equal(exit.code, 0);
    assert.equal(host.events.filter((event) => event.type === "model-request").length, 1);
  });
});

test("fails closed on a replayed tool reply", async () => {
  await withHost(async (host) => {
    host.write({ type: "start", input: fixtureInput() });
    const first = await host.nextType("model-request");
    sendChunks(host, first.id, [
      chunk({ tool_calls: [{ index: 0, id: "replay-call", function: { name: "write_summary", arguments: '{"query":"replay"}' } }] }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ]);
    const tool = await host.nextType("tool-request");
    host.write({ type: "tool-result", callId: tool.callId, ok: true, output: "first result" });
    await host.nextType("model-request");
    host.write({ type: "tool-result", callId: tool.callId, ok: true, output: "replayed result" });
    const error = await host.nextType("error");
    assert.equal(error.type, "error");
    const exit = await host.waitForExit();
    assert.equal(exit.code, 0);
  });
});

test("keeps process state isolated across independent host processes", async () => {
  const promptCanary = "MIVLET_PROMPT_CANARY_4F75E1";
  const run = async (prompt) => withHost(async (host) => {
    host.write({ type: "start", input: fixtureInput({ prompt }) });
    const request = await host.nextType("model-request");
    assert.equal(request.id, 1);
    assert.ok(request.body.messages.some((message) => message.content === prompt));
    sendChunks(host, request.id, [chunk({ content: "isolated answer" }), chunk({}, "stop"), "[DONE]"]);
    const done = await host.nextType("done");
    assert.equal(done.finishReason, "stop");
    const exit = await host.waitForExit();
    assert.equal(exit.code, 0);
    assert.equal(host.containsBytes(prompt), false);
    return host.events;
  });
  const [firstEvents, secondEvents] = await Promise.all([
    run(promptCanary),
    run(`${promptCanary}_SECOND`),
  ]);
  assert.equal(firstEvents.some((event) => event.type === "error"), false);
  assert.equal(secondEvents.some((event) => event.type === "error"), false);
});
