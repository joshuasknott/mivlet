import type { AgentTurnRequest } from "@mivlet/protocol";
import { describe, expect, it } from "vitest";
import { buildQueuedAttempt, buildQueuedExchanges } from "./persistence";

const request: AgentTurnRequest = {
  model: "gpt-5",
  messages: [
    { role: "system", content: "Stay concise." },
    { role: "user", content: "List the files." },
  ],
  tools: [],
  maxTokens: 128,
};

describe("queued attempt persistence", () => {
  it("drops system messages and keeps durable file attachments on the user turn", () => {
    const exchanges = buildQueuedExchanges(request, {
      attachments: [
        {
          id: "file-1",
          name: "notes.md",
          mediaType: "text/markdown",
          sizeBytes: 24,
          availability: "workspace-file",
        } as never,
        {
          id: "img-1",
          name: "shot.png",
          mediaType: "image/png",
          sizeBytes: 10,
          availability: "image-input",
        } as never,
      ],
    });
    expect(exchanges).toEqual([
      {
        role: "user",
        content: "List the files.",
        toolCallId: undefined,
        toolName: undefined,
        attachments: [
          {
            id: "file-1",
            name: "notes.md",
            mediaType: "text/markdown",
            sizeBytes: 24,
            availability: "workspace-file",
          },
        ],
      },
    ]);
  });

  it("builds a queued journal with the prepared receipt and optional route", () => {
    const queued = buildQueuedAttempt({
      attemptId: "run-1",
      providerId: "openai",
      model: "gpt-5",
      threadId: "thread-1",
      exchanges: buildQueuedExchanges(request),
      contextReceipt: {
        version: 1,
        attemptId: "run-1",
        assembledAt: "2026-07-11T12:00:00.000Z",
        scope: { level: "thread", threadId: "thread-1" },
        citations: [],
        contributions: [],
      },
      providerRoute: {
        workspaceId: "workspace-1" as never,
        selection: {
          providerRouteId: "route-1" as never,
          selectedAt: "2026-07-12T12:00:00Z" as never,
          reason: "Selected openai gpt-5.",
        },
      },
      createdAt: "2026-07-11T12:00:00.000Z",
    });
    expect(queued).toMatchObject({
      id: "run-1",
      status: "queued",
      recoverable: true,
      turn: 0,
      pendingApprovalIds: [],
      providerRoute: { selection: { reason: "Selected openai gpt-5." } },
    });
  });
});
