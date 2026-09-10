import { Plugin } from "@opencode/plugin";

/**
 * The native OpenCode provider is used for the model turn. This plugin only
 * contributes the bounded fixture tool; keeping model selection in the
 * provider config is the important compatibility check for workerd.
 */
export function syntheticPlugin(setup: () => void, write: () => string) {
  return Plugin.define({ id: "mivlet-synthetic-summary", async setup(ctx) {
    setup();
    await ctx.tool.transform(editor => {
      for (const tool of editor.list()) editor.remove(tool.id);
      editor.add({
        name: "write_summary",
        description: "Propose the fixed synthetic fixture summary for approval.",
        input: {
          type: "object",
          properties: { dataset: { type: "string", const: "fixture-v1" } },
          required: ["dataset"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute() { return { content: write() }; },
      });
    });
  } });
}

const FIXTURE_ORIGIN = "https://mivlet-fixture.invalid";

/** Create an isolated fixture endpoint for one probe/attempt. */
export function makeFixtureBaseURL(key: string) {
  return `${FIXTURE_ORIGIN}/${encodeURIComponent(key)}/v1`;
}

/** Deterministic OpenAI-compatible SSE response used by the local/workerd probes. */
export async function fixtureChatResponse(request: Request): Promise<Response> {
  const body = await request.clone().json() as { messages?: unknown };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const done = messages.some(message => typeof message === "object" && message !== null
    && (message as { role?: unknown }).role === "tool");
  const first = {
    id: "fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "summary",
    choices: [{
      index: 0,
      delta: done
        ? { content: "Synthetic task finished." }
        : { tool_calls: [{ index: 0, id: "summary-write", type: "function", function: { name: "write_summary", arguments: "{\"dataset\":\"fixture-v1\"}" } }] },
      finish_reason: null,
    }],
  };
  const second = {
    id: "fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "summary",
    choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }],
  };
  const text = `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(second)}\n\ndata: [DONE]\n\n`;
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}
