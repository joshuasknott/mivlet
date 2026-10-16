import type { ExecutionAttempt } from "@mivlet/protocol";
import { describe, expect, it } from "vitest";
import { buildRetryTurnRequest, describeRetryBlock } from "./retry";
import { GENERATED_UI_INSTRUCTIONS } from "../../lib/generated-interface";

function attempt(
  patch: Partial<ExecutionAttempt> = {},
): ExecutionAttempt {
  return {
    id: "attempt-1",
    providerId: "openai",
    model: "gpt-5",
    status: "interrupted",
    transcript: "partial",
    threadId: "thread-1",
    exchanges: [{ role: "user", content: "Continue from here." }],
    turn: 0,
    pendingApprovalIds: [],
    recoverable: true,
    retryCount: 0,
    createdAt: "2026-07-11T12:00:00.000Z",
    updatedAt: "2026-07-11T12:00:01.000Z",
    ...patch,
  };
}

const availableModel = {
  id: "gpt-5",
  label: "GPT-5",
  available: true,
  capabilities: { streaming: true },
};

describe("describeRetryBlock", () => {
  it("allows a recoverable prompt on the same conversation and provider", () => {
    expect(
      describeRetryBlock(attempt(), {
        threadId: "thread-1",
        models: [availableModel],
        backend: { providerId: "openai" } as never,
      }),
    ).toBeNull();
  });

  it("refuses missing prompts, images, attachments, and provider drift", () => {
    expect(
      describeRetryBlock(attempt({ recoverable: false }), {
        threadId: "thread-1",
        models: [availableModel],
        backend: { providerId: "openai" } as never,
      }),
    ).toMatch(/safe user prompt/);
    expect(
      describeRetryBlock(
        attempt({
          exchanges: [
            {
              role: "user",
              content: "See this",
              images: [{ id: "img-1", name: "a.png", mediaType: "image/png", sizeBytes: 12, width: 8, height: 8 }],
            },
          ],
        }),
        {
          threadId: "thread-1",
          models: [availableModel],
          backend: { providerId: "openai" } as never,
        },
      ),
    ).toMatch(/original images/);
    expect(
      describeRetryBlock(attempt({ threadId: "other" }), {
        threadId: "thread-1",
        models: [availableModel],
        backend: { providerId: "openai" } as never,
      }),
    ).toMatch(/Open this run's conversation/);
    expect(
      describeRetryBlock(attempt(), {
        threadId: "thread-1",
        models: [availableModel],
        backend: { providerId: "anthropic" } as never,
      }),
    ).toMatch(/original provider/);
  });
});

describe("buildRetryTurnRequest", () => {
  it("keeps the OpenUI response contract on the default recovery route", () => {
    const request = buildRetryTurnRequest(attempt(), []);
    expect(request?.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Mivlet supports an optional interactive response format"),
    });
    expect(request?.messages[0]?.content).toContain(GENERATED_UI_INSTRUCTIONS);
  });
});
