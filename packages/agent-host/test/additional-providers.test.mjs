import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk, fixtureInput, withHost, sendChunks } from "./support/host-process.mjs";

// The real bundled executable and SDK process are exercised; provider SSE is synthetic.
const providers = [
  [
    "alibaba",
    "qwen-plus"
  ],
  [
    "moonshot",
    "kimi-k2.6"
  ],
  [
    "zai",
    "glm-4.7"
  ],
  [
    "groq",
    "llama-3.3-70b-versatile"
  ],
  [
    "together",
    "meta-llama/Llama-3.3-70B-Instruct-Turbo"
  ],
  [
    "fireworks",
    "accounts/fireworks/models/gpt-oss-120b"
  ],
  [
    "cerebras",
    "gpt-oss-120b"
  ],
  [
    "mistral",
    "mistral-large-latest"
  ],
  [
    "openrouter",
    "openai/gpt-4.1"
  ],
  [
    "nvidia",
    "meta/llama-3.3-70b-instruct"
  ],
  [
    "siliconflow",
    "Qwen/Qwen2.5-72B-Instruct"
  ],
  [
    "cohere",
    "command-a-03-2025"
  ]
];

for (const [providerId, model] of providers) {
  test(`${providerId} completes an embedded function-call round trip`, async () => {
    await withHost(async host => {
      const base = fixtureInput({ providerId });
      host.write({ type: "start", input: { ...base, request: { ...base.request, model } } });
      const first = await host.nextType("model-request");
      assert.equal(first.body.model, model);
      assert.equal(first.body.max_tokens, 256);
      assert.equal(first.body.tools[0].function.name, "write_summary");
      sendChunks(host, first.id, [
        chunk({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "write_summary", arguments: '{"query":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"fixture"}' } }] }),
        chunk({}, "tool_calls"), "[DONE]",
      ]);
      const tool = await host.nextType("tool-request");
      assert.equal(tool.arguments, '{"query":"fixture"}');
      host.write({ type: "tool-result", callId: tool.callId, ok: true, output: "Saved fixture summary." });
      const second = await host.nextType("model-request");
      assert.equal(second.body.model, model);
      const assistantCall = second.body.messages.find(message => message.role === "assistant" && message.tool_calls?.length)?.tool_calls[0];
      assert.equal(assistantCall?.function.name, "write_summary");
      // Mistral requires nine alphanumeric characters; the SDK rewrites both sides.
      if (providerId === "mistral") assert.match(assistantCall.id, /^[a-zA-Z0-9]{9}$/);
      else assert.equal(assistantCall?.id, "call-1");
      assert.ok(second.body.messages.some(message => message.role === "tool"
        && message.tool_call_id === assistantCall.id && message.content === "Saved fixture summary."));
      sendChunks(host, second.id, [chunk({ content: "Completed." }), chunk({}, "stop"), "[DONE]"]);
      assert.equal((await host.nextType("done")).finishReason, "stop");
      assert.equal((await host.waitForExit()).code, 0);
      assert.equal(host.events.filter(event => event.type === "model-request").length, 2);
    });
  });
}
