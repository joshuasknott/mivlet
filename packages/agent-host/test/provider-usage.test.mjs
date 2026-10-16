import assert from "node:assert/strict";
import {
  chunk,
  fixtureInput,
  sendChunks,
  usageChunk,
  withHost,
} from "./support/host-process.mjs";
import { test } from "./support/windows-host.mjs";

// Actual embedded executable with deterministic wire receipts; no live provider.
for (const cost of [0, 0.2]) {
  test(`embedded OpenRouter retains reported ${cost} cost and cache/reasoning categories`, async () => {
    await withHost(async (host) => {
      host.write({
        type: "start",
        input: fixtureInput({ providerId: "openrouter" }),
      });
      const request = await host.nextType("model-request");
      sendChunks(host, request.id, [
        chunk({ content: "Fixture answer." }),
        chunk({}, "stop"),
        JSON.stringify({
          ...JSON.parse(usageChunk(100, 20)),
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            cost,
            prompt_tokens_details: {
              cached_tokens: 40,
              cache_write_tokens: 10,
            },
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        }),
        "[DONE]",
      ]);
      await host.nextType("done");
      assert.equal((await host.waitForExit()).code, 0);
      assert.deepEqual(
        host.events.filter((event) => event.type === "usage").at(-1),
        {
          type: "usage",
          inputTokens: 90,
          outputTokens: 20,
          cachedInputTokens: 40,
          cacheWriteTokens: 10,
          reasoningTokens: 5,
          costUsd: cost,
          costUnknown: false,
        },
      );
    });
  });
}
test("embedded Anthropic replaces snapshots and retains additive cache writes", async () => {
  await withHost(async (host) => {
    host.write({
      type: "start",
      input: fixtureInput({ providerId: "anthropic" }),
    });
    const request = await host.nextType("model-request");
    sendChunks(
      host,
      request.id,
      [
        {
          type: "message_start",
          message: {
            id: "msg-usage",
            type: "message",
            role: "assistant",
            model: "fixture-model",
            content: [],
            usage: {
              input_tokens: 60,
              output_tokens: 0,
              cache_read_input_tokens: 40,
              cache_creation_input_tokens: 10,
            },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Fixture answer." },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 20 },
        },
        { type: "message_stop" },
      ]
        .map((value) => JSON.stringify(value))
        .concat("[DONE]"),
    );
    await host.nextType("done");
    assert.equal((await host.waitForExit()).code, 0);
    assert.deepEqual(
      host.events.filter((event) => event.type === "usage").at(-1),
      {
        type: "usage",
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 40,
        cacheWriteTokens: 10,
        costUsd: 0,
        costUnknown: true,
      },
    );
  });
});
test("embedded provider failure retains an observed partial receipt without another request", async () => {
  await withHost(async (host) => {
    host.write({
      type: "start",
      input: fixtureInput({ providerId: "openrouter" }),
    });
    const request = await host.nextType("model-request");
    sendChunks(host, request.id, [
      JSON.stringify({
        ...JSON.parse(usageChunk(100, 5)),
        usage: { prompt_tokens: 100, completion_tokens: 5, cost: 0.01 },
      }),
      JSON.stringify({
        __mivletTransport: {
          kind: "error",
          code: "rate-limit",
          message: "Fixture limit.",
          retryable: false,
        },
      }),
    ]);
    await host.nextType("error");
    await host.waitForExit();
    assert.equal(
      host.events.filter((event) => event.type === "model-request").length,
      1,
    );
    assert.deepEqual(
      host.events.filter((event) => event.type === "usage").at(-1),
      {
        type: "usage",
        inputTokens: 100,
        outputTokens: 5,
        costUsd: 0.01,
        costUnknown: false,
      },
    );
  });
});
test("embedded Anthropic failure before message delta retains its measured input receipt", async () => {
  await withHost(async (host) => {
    host.write({
      type: "start",
      input: fixtureInput({ providerId: "anthropic" }),
    });
    const request = await host.nextType("model-request");
    sendChunks(host, request.id, [
      JSON.stringify({
        type: "message_start",
        message: {
          id: "msg-partial",
          type: "message",
          role: "assistant",
          model: "fixture-model",
          content: [],
          usage: {
            input_tokens: 60,
            output_tokens: 0,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
          },
        },
      }),
      JSON.stringify({
        __mivletTransport: {
          kind: "error",
          code: "transport",
          message: "Fixture interrupted stream.",
          retryable: false,
        },
      }),
    ]);
    await host.nextType("error");
    await host.waitForExit();
    assert.equal(
      host.events.filter((event) => event.type === "model-request").length,
      1,
    );
    assert.deepEqual(
      host.events.filter((event) => event.type === "usage").at(-1),
      {
        type: "usage",
        inputTokens: 100,
        outputTokens: 0,
        cachedInputTokens: 40,
        cacheWriteTokens: 10,
        costUsd: 0,
        costUnknown: true,
      },
    );
  });
});
