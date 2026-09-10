import type { AgentTurnRequest } from "@fable/protocol";
import { describe, expect, it } from "vitest";
import {
  CODEX_HISTORY_MAX_UTF8_BYTES,
  codexHistoryUtf8Bytes,
  estimateConversationInputTokens,
  planConversationContext,
} from "./conversation-context";

const request: AgentTurnRequest = {
  model: "provider-reported-model",
  messages: [
    { role: "system", content: "Keep commitments." },
    { role: "user", content: "What remains?" },
  ],
  tools: [],
  maxTokens: 256,
};

describe("planConversationContext", () => {
  it("does not invent a model capacity when provider metadata is unavailable", async () => {
    const plan = await planConversationContext({
      history: [{ role: "user", content: "x".repeat(40_000) }],
      request,
      contextWindowTokens: NaN,
      backendType: "native-api",
    });
    expect(plan).toMatchObject({ ok: true, capacitySource: "unavailable", contextWindowTokens: undefined });
  });

  it("rejects invalid output metadata with a distinct diagnostic", async () => {
    const plan = await planConversationContext({
      history: [],
      request: { ...request, maxTokens: NaN },
      backendType: "native-api",
    });
    expect(plan).toMatchObject({ ok: false, reason: "invalid-output-budget" });
  });

  it("preserves every historical message exactly and in order", async () => {
    const history: AgentTurnRequest["messages"] = [
      { role: "user", content: "Use the blue design." },
      { role: "assistant", content: "I will keep it blue." },
      { role: "user", content: "Also keep the existing keyboard behavior." },
    ];
    const plan = await planConversationContext({ history, request, contextWindowTokens: 20_000, backendType: "native-api" });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.messages).toEqual([request.messages[0], ...history, request.messages[1]]);
  });

  it("reports the provider model threshold without returning partial history", async () => {
    const plan = await planConversationContext({
      history: [{ role: "user", content: "Keep this exact commitment. ".repeat(400) }],
      request,
      contextWindowTokens: 2_000,
      backendType: "native-api",
    });
    expect(plan).toMatchObject({
      ok: false,
      reason: "model-context-window",
      capacitySource: "provider-metadata",
      contextWindowTokens: 2_000,
      outputReserveTokens: 256,
    });
  });

  it("uses a reference tokenizer and explicit reserves for tools and images", async () => {
    const plain = await estimateConversationInputTokens([{ role: "user", content: "repeat ".repeat(200) }], []);
    const withToolAndImage = await estimateConversationInputTokens(
      [{ role: "user", content: "repeat ".repeat(200), images: [{ id: "image-1", name: "pixel.png", mediaType: "image/png", sizeBytes: 68, width: 1, height: 1, dataUrl: "data:image/png;base64,pixels" }] }],
      [{ name: "lookup", description: "Look up a record", parameters: "{\"type\":\"object\"}" }],
    );
    expect(plain).toBeLessThan(new TextEncoder().encode("repeat ".repeat(200)).byteLength);
    expect(withToolAndImage).toBeGreaterThan(plain + 4_096);
  });

  it("measures the exact native Codex history shape and retains its strict envelope", async () => {
    expect(codexHistoryUtf8Bytes([{ role: "tool", content: "not sent", toolCallId: "call", toolName: "lookup" }])).toBe(2);
    const plan = await planConversationContext({
      history: [{ role: "user", content: "x".repeat(CODEX_HISTORY_MAX_UTF8_BYTES) }],
      request,
      contextWindowTokens: 1_000_000,
      backendType: "codex-app-server",
    });
    expect(plan).toMatchObject({
      ok: false,
      reason: "native-history-envelope",
      nativeHistoryMaxUtf8Bytes: CODEX_HISTORY_MAX_UTF8_BYTES,
    });
  });
});
