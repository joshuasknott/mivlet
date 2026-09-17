import assert from "node:assert/strict";
import { chunk, fixtureInput, withHost, sendChunks } from "./support/host-process.mjs";
import { test } from "./support/windows-host.mjs";

// DeepSeek speaks the OpenAI-compatible Chat Completions wire format, so the
// pinned SDK serves it through the same openai-compatible provider shim as
// OpenAI/xAI/custom. The host itself is provider-agnostic: it forwards the SDK
// body to the Rust bridge, which owns the DeepSeek endpoint, key, and the
// documented non-thinking-mode shaping.

test("DeepSeek is admitted to the embedded host and keeps its max_tokens field", async () => {
  await withHost(async host => {
    const base = fixtureInput();
    host.write({ type: "start", input: {
      ...base,
      providerId: "deepseek",
      request: { ...base.request, model: "deepseek-flash", tools: [] },
    } });
    const request = await host.nextType("model-request");
    assert.equal(request.body.model, "deepseek-flash");
    assert.equal(request.body.max_tokens, 256);
    assert.equal("max_completion_tokens" in request.body, false);
    sendChunks(host, request.id, [chunk({ content: "DeepSeek fixture reply." }), chunk({}, "stop"), "[DONE]"]);
    assert.equal((await host.nextType("done")).finishReason, "stop");
    assert.equal((await host.waitForExit()).code, 0);
    assert.equal(host.events.filter(event => event.type === "model-request").length, 1);
  });
});