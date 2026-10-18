import type { BackendAgentEvent } from "@mivlet/protocol";

type Usage = Extract<BackendAgentEvent, { type: "usage" }>;
type Parser = (line: string) => BackendAgentEvent[];
interface Receipt {
  usage?: Usage;
  completed: boolean;
}
export interface StepTokens {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cache?: { read?: unknown; write?: unknown };
}
const measured = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
/** Observe the existing native response without buffering or changing SDK bytes. */
export function createUsageAccounting(
  createParser: () => Parser,
  emit: (usage: Usage) => void,
) {
  const receipts: Receipt[] = [];
  const steps = new Set<string>();
  // Usage events can arrive many times while a long turn streams. Keep the
  // aggregate incrementally so every event is O(1), rather than re-scanning
  // every prior receipt (which made a long session quadratic in event count).
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cachedInputCount: 0,
    cacheWriteCount: 0,
    reasoningCount: 0,
    estimatedCount: 0,
    unknownCostCount: 0,
    knownCount: 0,
    nonzeroCostCount: 0,
    negativeCostCount: 0,
    nonfiniteCostCount: 0,
  };

  const adjustCost = (usage: Usage, direction: 1 | -1) => {
    const value = usage.costUsd;
    if (!Number.isFinite(value)) {
      totals.nonfiniteCostCount += direction;
      return;
    }
    totals.costUsd += direction * value;
    if (value !== 0) totals.nonzeroCostCount += direction;
    if (value < 0) totals.negativeCostCount += direction;
  };

  const removeUsage = (usage: Usage) => {
    totals.inputTokens -= usage.inputTokens;
    totals.outputTokens -= usage.outputTokens;
    adjustCost(usage, -1);
    if (usage.cachedInputTokens !== undefined) {
      totals.cachedInputTokens -= usage.cachedInputTokens;
      totals.cachedInputCount -= 1;
    }
    if (usage.cacheWriteTokens !== undefined) {
      totals.cacheWriteTokens -= usage.cacheWriteTokens;
      totals.cacheWriteCount -= 1;
    }
    if (usage.reasoningTokens !== undefined) {
      totals.reasoningTokens -= usage.reasoningTokens;
      totals.reasoningCount -= 1;
    }
    if (usage.costEstimated && !usage.costUnknown) totals.estimatedCount -= 1;
    if (usage.costUnknown) totals.unknownCostCount -= 1;
    totals.knownCount -= 1;
  };

  const addUsage = (usage: Usage) => {
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    adjustCost(usage, 1);
    if (usage.cachedInputTokens !== undefined) {
      totals.cachedInputTokens += usage.cachedInputTokens;
      totals.cachedInputCount += 1;
    }
    if (usage.cacheWriteTokens !== undefined) {
      totals.cacheWriteTokens += usage.cacheWriteTokens;
      totals.cacheWriteCount += 1;
    }
    if (usage.reasoningTokens !== undefined) {
      totals.reasoningTokens += usage.reasoningTokens;
      totals.reasoningCount += 1;
    }
    if (usage.costEstimated && !usage.costUnknown) totals.estimatedCount += 1;
    if (usage.costUnknown) totals.unknownCostCount += 1;
    totals.knownCount += 1;
  };

  const setUsage = (receipt: Receipt, usage: Usage) => {
    if (receipt.usage) removeUsage(receipt.usage);
    receipt.usage = usage;
    addUsage(usage);
  };

  const publish = () => {
    if (!totals.knownCount) return;
    // Preserve the old reduction for malformed costs without making normal
    // streaming updates scan all receipts. An overflowed finite sum must also
    // be recomputed so replacing an extreme value can recover.
    if (!Number.isFinite(totals.costUsd)) {
      totals.costUsd = receipts.reduce((sum, receipt) => {
        const value = receipt.usage?.costUsd ?? 0;
        return Number.isFinite(value) ? sum + value : sum;
      }, 0);
    }
    // Subtraction can leave a residue of either sign after every cost is zero.
    if (totals.nonzeroCostCount === 0) totals.costUsd = 0;
    const costUsd = totals.nonfiniteCostCount
      ? receipts.reduce(
          (sum, receipt) => sum + (receipt.usage ? receipt.usage.costUsd : 0),
          0,
        )
      : totals.negativeCostCount === 0
        ? Math.max(0, totals.costUsd)
        : totals.costUsd;
    emit({
      type: "usage",
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cachedInputTokens: totals.cachedInputCount
        ? totals.cachedInputTokens
        : undefined,
      cacheWriteTokens: totals.cacheWriteCount
        ? totals.cacheWriteTokens
        : undefined,
      reasoningTokens: totals.reasoningCount
        ? totals.reasoningTokens
        : undefined,
      costUsd,
      costEstimated: totals.estimatedCount ? true : undefined,
      costUnknown:
        receipts.length - totals.knownCount + totals.unknownCostCount > 0,
    });
  };
  return {
    observe(response: Response): Response {
      const receipt: Receipt = { completed: false };
      receipts.push(receipt);
      if (!response.body || !response.ok) return response;
      const parse = createParser();
      const decoder = new TextDecoder();
      let pending = "";
      let dropping = false;
      const line = (text: string) => {
        let events: BackendAgentEvent[];
        try {
          events = parse(text);
        } catch {
          return;
        }
        for (const event of events)
          if (event.type === "usage") {
            setUsage(receipt, event);
            publish();
          }
      };
      const accept = (text: string) => {
        for (const fragment of text.split(/(?<=\n)/)) {
          const ended = fragment.endsWith("\n");
          if (!dropping) {
            if (pending.length + fragment.length > 128 * 1024) {
              pending = "";
              dropping = true;
            } else pending += fragment;
          }
          if (ended) {
            if (!dropping) line(pending);
            pending = "";
            dropping = false;
          }
        }
      };
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            accept(decoder.decode(chunk, { stream: true }));
            controller.enqueue(chunk);
          },
          flush() {
            accept(decoder.decode());
            if (pending && !dropping) line(pending);
          },
        }),
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
    completeStep(id: string, tokens: StepTokens) {
      if (steps.has(id)) return;
      steps.add(id);
      const receipt = receipts.find((value) => !value.completed);
      if (!receipt) return;
      receipt.completed = true;
      // Older/unsupported wire usage keeps SDK-measured tokens, never guessed
      // prices. A wire measurement wins over the SDK's API-equivalent amount.
      if (!receipt.usage) {
        const read = measured(tokens.cache?.read);
        setUsage(receipt, {
          type: "usage",
          inputTokens: (measured(tokens.input) ?? 0) + (read ?? 0),
          outputTokens: measured(tokens.output) ?? 0,
          cachedInputTokens: read,
          cacheWriteTokens: measured(tokens.cache?.write),
          reasoningTokens: measured(tokens.reasoning),
          costUsd: 0,
          costUnknown: true,
        });
        publish();
      }
    },
  };
}
