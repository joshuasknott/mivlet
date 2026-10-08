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
  const publish = () => {
    const known = receipts.flatMap((receipt) =>
      receipt.usage ? [receipt.usage] : [],
    );
    if (!known.length) return;
    const category = (
      key: "cachedInputTokens" | "cacheWriteTokens" | "reasoningTokens",
    ) => {
      const values = known.flatMap((usage) =>
        usage[key] === undefined ? [] : [usage[key]!],
      );
      return values.length
        ? values.reduce((sum, value) => sum + value, 0)
        : undefined;
    };
    emit({
      type: "usage",
      inputTokens: known.reduce((sum, usage) => sum + usage.inputTokens, 0),
      outputTokens: known.reduce((sum, usage) => sum + usage.outputTokens, 0),
      cachedInputTokens: category("cachedInputTokens"),
      cacheWriteTokens: category("cacheWriteTokens"),
      reasoningTokens: category("reasoningTokens"),
      costUsd: known.reduce((sum, usage) => sum + usage.costUsd, 0),
      costEstimated: known.some(
        (usage) => usage.costEstimated && !usage.costUnknown,
      )
        ? true
        : undefined,
      costUnknown: receipts.some(
        (receipt) => !receipt.usage || receipt.usage.costUnknown,
      ),
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
            receipt.usage = event;
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
        receipt.usage = {
          type: "usage",
          inputTokens: (measured(tokens.input) ?? 0) + (read ?? 0),
          outputTokens: measured(tokens.output) ?? 0,
          cachedInputTokens: read,
          cacheWriteTokens: measured(tokens.cache?.write),
          reasoningTokens: measured(tokens.reasoning),
          costUsd: 0,
          costUnknown: true,
        };
        publish();
      }
    },
  };
}
