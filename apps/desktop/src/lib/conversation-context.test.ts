import type { AgentTurnRequest } from "@fable/protocol";
import { describe, expect, it } from "vitest";
import {
  CODEX_HISTORY_MAX_UTF8_BYTES,
  estimateConversationInputTokens,
  planConversationContext,
} from "./conversation-context";

const request: AgentTurnRequest = {
  model: "test-model",
  messages: [
    { role: "system", content: "Keep commitments." },
    { role: "user", content: "What remains?" },
  ],
  tools: [],
  maxTokens: 256,
};

describe("planConversationContext", () => {
  it("does not let invalid numeric model metadata bypass the context limit", () => {
    for (const contextWindowTokens of [NaN, Infinity, -1]) {
      expect(planConversationContext({ history: [{ role: "user", content: "x".repeat(40_000) }], request, contextWindowTokens, backendType: "native-api" }).ok).toBe(false);
    }
    expect(planConversationContext({ history: [], request: { ...request, maxTokens: NaN }, backendType: "native-api" }).ok).toBe(false);
  });
  it("preserves every historical message exactly and in order", () => {
    const history: AgentTurnRequest["messages"] = [
      { role: "user", content: "Use the blue design." },
      { role: "assistant", content: "I will keep it blue." },
      { role: "user", content: "Also keep the existing keyboard behavior." },
    ];
    const plan = planConversationContext({
      history,
      request,
      contextWindowTokens: 20_000,
      backendType: "native-api",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.messages).toEqual([
      request.messages[0],
      ...history,
      request.messages[1],
    ]);
  });

  it("rejects instead of returning a partial history", () => {
    const commitment = "Keep this exact commitment. ".repeat(200);
    const plan = planConversationContext({
      history: [{ role: "user", content: commitment }],
      request,
      contextWindowTokens: 2_000,
      backendType: "native-api",
    });
    expect(plan).toMatchObject({
      ok: false,
      code: "conversation-context-too-large",
      message: expect.stringContaining("did not omit or summarize"),
    });
  });

  it("counts multibyte text, tools, output, and images conservatively", () => {
    const ascii = estimateConversationInputTokens(
      [{ role: "user", content: "a".repeat(20) }],
      [],
    );
    const multibyte = estimateConversationInputTokens(
      [{ role: "user", content: "🙂".repeat(20) }],
      [],
    );
    const withToolAndImage = estimateConversationInputTokens(
      [{
        role: "user",
        content: "a".repeat(20),
        images: [{
          id: "image-1", name: "pixel.png", mediaType: "image/png",
          sizeBytes: 68, width: 1, height: 1, dataUrl: "data:image/png;base64,pixels",
        }],
      }],
      [{ name: "lookup", description: "Look up a record", parameters: "{\"type\":\"object\"}" }],
    );
    expect(multibyte).toBeGreaterThan(ascii);
    expect(withToolAndImage).toBeGreaterThan(ascii + 4_096);
  });

  it("enforces the exact-history Codex envelope", () => {
    const plan = planConversationContext({
      history: [{ role: "user", content: "x".repeat(CODEX_HISTORY_MAX_UTF8_BYTES) }],
      request,
      contextWindowTokens: 1_000_000,
      backendType: "codex-app-server",
    });
    expect(plan).toMatchObject({
      ok: false,
      code: "conversation-context-too-large",
    });
  });
});
