import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// This pure stream observer needs no Bun executable or provider credentials.
const source = await readFile(
  new URL("../../src/usage-accounting.ts", import.meta.url),
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
test("replacing a receipt removes fields that disappear from the latest snapshot", async () => {
  const events = [];
  const accounting = createUsageAccounting(parser, (event) =>
    events.push(event),
  );
  const wire =
    frame(
      usage(10, 1, {
        cachedInputTokens: 7,
        cacheWriteTokens: 3,
        reasoningTokens: 2,
        costUsd: 0.4,
        costEstimated: true,
        costUnknown: false,
      }),
    ) + frame(usage(20, 2, { costUsd: 0.1, costUnknown: false }));

  await accounting.observe(new Response(wire)).text();
  assert.deepEqual(events.at(-1), {
    type: "usage",
    inputTokens: 20,
    outputTokens: 2,
    cachedInputTokens: undefined,
    cacheWriteTokens: undefined,
    reasoningTokens: undefined,
    costUsd: 0.1,
    costEstimated: undefined,
    costUnknown: false,
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
test("cost flags remain cumulative across independent calls and repeated step ids stay idempotent", async () => {
  const events = [];
  const accounting = createUsageAccounting(parser, (event) =>
    events.push(event),
  );
  await accounting
    .observe(
      new Response(
        frame(
          usage(100, 10, {
            costUsd: 0.25,
            costEstimated: true,
            costUnknown: false,
          }),
        ),
      ),
    )
    .text();
  accounting.completeStep("step-1", { input: 999, output: 999 });
  accounting.completeStep("step-1", { input: 999, output: 999 });

  await accounting.observe(new Response(frame(usage(5, 2)))).text();
  accounting.completeStep("step-2", { input: 40, output: 4 });
  accounting.completeStep("step-2", { input: 999, output: 999 });
  await accounting.observe(new Response("data: malformed\n")).text();
  accounting.completeStep("step-3", { input: 40, output: 4 });

  assert.deepEqual(events.at(-1), {
    type: "usage",
    inputTokens: 145,
    outputTokens: 16,
    cachedInputTokens: undefined,
    cacheWriteTokens: undefined,
    reasoningTokens: undefined,
    costUsd: 0.25,
    costEstimated: true,
    costUnknown: true,
  });
});
test("revising independent finite costs to zero does not publish a floating negative", async () => {
  const events = [];
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const makeStream = (initialCost, revisedCost, gate) =>
    new ReadableStream({
      async start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            frame(usage(1, 1, { costUsd: initialCost, costUnknown: false })),
          ),
        );
        await gate.promise;
        controller.enqueue(
          new TextEncoder().encode(
            frame(usage(1, 1, { costUsd: revisedCost, costUnknown: false })),
          ),
        );
        controller.close();
      },
    });
  const gateA = deferred();
  const gateB = deferred();
  const firstA = deferred();
  const firstB = deferred();
  const secondA = deferred();
  const secondB = deferred();
  const onUsage = (event) => {
    events.push(event);
    if (events.length === 1) firstA.resolve();
    if (events.length === 2) firstB.resolve();
    if (events.length === 3) secondA.resolve();
    if (events.length === 4) secondB.resolve();
  };
  const streamedAccounting = createUsageAccounting(parser, onUsage);
  const consumeA = streamedAccounting
    .observe(new Response(makeStream(0.7, 0, gateA)))
    .text();
  await firstA.promise;
  const consumeB = streamedAccounting
    .observe(new Response(makeStream(0.1, 0, gateB)))
    .text();
  await firstB.promise;
  gateA.resolve();
  await secondA.promise;
  gateB.resolve();
  await secondB.promise;
  await Promise.all([consumeA, consumeB]);

  assert.equal(events.at(-1).costUsd, 0);
  assert.ok(events.every((event) => event.costUsd >= 0));
});
test("replacing the last nonzero receipt publishes an exact zero total", async () => {
  const events = [];
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const costs = [0.7, 0.1, 0.2, 0.3];
  const gates = costs.map(() => deferred());
  const firsts = costs.map(() => deferred());
  const revisions = costs.map(() => deferred());
  const makeStream = (initialCost, gate) =>
    new ReadableStream({
      async start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            frame(usage(1, 1, { costUsd: initialCost, costUnknown: false })),
          ),
        );
        await gate.promise;
        controller.enqueue(
          new TextEncoder().encode(
            frame(usage(1, 1, { costUsd: 0, costUnknown: false })),
          ),
        );
        controller.close();
      },
    });
  const accounting = createUsageAccounting(parser, (event) => {
    events.push(event);
    const index = events.length - 1;
    if (index < costs.length) firsts[index].resolve();
    else revisions[index - costs.length].resolve();
  });
  const consumes = [];
  for (let index = 0; index < costs.length; index += 1) {
    consumes.push(
      accounting
        .observe(new Response(makeStream(costs[index], gates[index])))
        .text(),
    );
    await firsts[index].promise;
  }
  for (let index = 0; index < costs.length; index += 1) {
    gates[index].resolve();
    await revisions[index].promise;
  }
  await Promise.all(consumes);
  assert.equal(events.at(-1).costUsd, 0);
});
test("malformed negative costs remain observable instead of being normalized", async () => {
  const events = [];
  const accounting = createUsageAccounting(parser, (event) =>
    events.push(event),
  );
  await accounting
    .observe(
      new Response(frame(usage(1, 1, { costUsd: -1, costUnknown: false }))),
    )
    .text();
  assert.equal(events.at(-1).costUsd, -1);
});
test("replacing nonfinite or missing costs recovers the valid aggregate", async () => {
  for (const invalidCost of [NaN, Infinity, -Infinity, undefined]) {
    const events = [];
    const invalidParser = () => (line) => [
      {
        type: "usage",
        ...usage(1, 1, {
          costUsd: line.includes("initial") ? invalidCost : 0,
          costUnknown: false,
        }),
      },
    ];
    const accounting = createUsageAccounting(invalidParser, (event) =>
      events.push(event),
    );
    await accounting.observe(new Response("initial\nrevised\n")).text();
    assert.equal(events.at(-1).costUsd, 0);
  }
});
test("usage aggregation reads each live snapshot a bounded number of times", async () => {
  let propertyReads = 0;
  const instrumentedParser = () => () => [
    Object.defineProperties(
      { type: "usage" },
      Object.fromEntries(
        [
          ["inputTokens", 1],
          ["outputTokens", 1],
          ["costUsd", 0],
          ["costUnknown", true],
          ["cachedInputTokens", undefined],
          ["cacheWriteTokens", undefined],
          ["reasoningTokens", undefined],
          ["costEstimated", undefined],
        ].map(([key, value]) => [
          key,
          {
            enumerable: true,
            get() {
              propertyReads += 1;
              return value;
            },
          },
        ]),
      ),
    ),
  ];
  const events = [];
  const accounting = createUsageAccounting(instrumentedParser, (event) =>
    events.push(event),
  );
  const frames = 64;
  for (let index = 0; index < frames; index += 1) {
    await accounting.observe(new Response("data: usage\n")).text();
  }

  // Incremental aggregation reads only the current event's fields. A full
  // receipt rescan would grow with the number of prior frames and exceed this
  // linear bound by a wide margin.
  assert.ok(
    propertyReads <= frames * 16,
    `unexpected snapshot reads: ${propertyReads}`,
  );
  assert.equal(events.at(-1).inputTokens, frames);
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
