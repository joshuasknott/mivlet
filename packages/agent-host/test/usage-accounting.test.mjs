import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// This pure stream observer needs no Bun executable or provider credentials.
const source = await readFile(
  new URL("../src/usage-accounting.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const { createUsageAccounting } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const parser = () => (line) =>
  line.startsWith("data: ")
    ? [{ type: "usage", ...JSON.parse(line.slice(6)) }]
    : [];
const frame = (value) => `data: ${JSON.stringify(value)}\n`;
const usage = (inputTokens, outputTokens, extra = {}) => ({
  inputTokens,
  outputTokens,
  costUsd: 0,
  costUnknown: true,
  ...extra,
});
test("embedded observation preserves exact SDK bytes and headers while replacing snapshots", async () => {
  const events = [];
  const accounting = createUsageAccounting(parser, (event) =>
    events.push(event),
  );
  const wire =
    frame(usage(100, 2)) +
    frame(
      usage(100, 20, {
        cachedInputTokens: 40,
        costUsd: 0.2,
        costUnknown: false,
      }),
    );
  const encoder = new TextEncoder();
  const bytes = encoder.encode(wire);
  const response = accounting.observe(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 17));
          controller.enqueue(bytes.slice(17));
          controller.close();
        },
      }),
      { headers: { "x-fixture": "preserved" } },
    ),
  );
  assert.equal(await response.text(), wire);
  assert.equal(response.headers.get("x-fixture"), "preserved");
  accounting.completeStep("step-1", { input: 999, output: 999 });
  assert.deepEqual(events.at(-1), {
    type: "usage",
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 40,
    cacheWriteTokens: undefined,
    reasoningTokens: undefined,
    costUsd: 0.2,
    costUnknown: false,
    costEstimated: undefined,
  });
});
test("distinct model calls accumulate once, retaining partial receipts before failure", async () => {
  const events = [];
  const accounting = createUsageAccounting(parser, (event) =>
    events.push(event),
  );
  await accounting.observe(new Response(frame(usage(100, 20)))).text();
  accounting.completeStep("step-1", {});
  await accounting
    .observe(new Response(frame(usage(200, 5, { reasoningTokens: 2 }))))
    .text();
  assert.equal(events.at(-1).inputTokens, 300);
  assert.equal(events.at(-1).outputTokens, 25);
  accounting.completeStep("step-2", {});
  accounting.completeStep("step-2", { input: 999, output: 999 });
  assert.equal(events.at(-1).inputTokens, 300);
  assert.equal(events.at(-1).reasoningTokens, 2);
});
test("SDK token fallback stays unpriced and malformed/oversized frames pass through unchanged", async () => {
  const events = [];
  const accounting = createUsageAccounting(parser, (event) =>
    events.push(event),
  );
  const wire = "data: invalid\n" + "data: " + "x".repeat(140_000) + "\n";
  assert.equal(await accounting.observe(new Response(wire)).text(), wire);
  accounting.completeStep("step-1", {
    input: 60,
    output: 20,
    cache: { read: 40, write: 10 },
    reasoning: 5,
  });
  assert.equal(events.at(-1).inputTokens, 100);
  assert.equal(events.at(-1).cacheWriteTokens, 10);
  assert.equal(events.at(-1).costUnknown, true);
});
