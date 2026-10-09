import { describe, expect, it, vi } from "vitest";
import {
  emitOutputPinned,
  emitOutputRevisionRequest,
  subscribeOutputPinned,
  subscribeOutputRevisionRequests,
} from "./output-revision-events";

describe("output revision request events", () => {
  it("routes a panel request to the owning conversation without losing the CAS base", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOutputRevisionRequests(listener);
    emitOutputRevisionRequest({
      kind: "text",
      conversationId: "thread-1",
      request: {
        outputId: "output-1",
        expectedRevisionId: "revision-4",
        expectedRevisionNumber: 4,
        content: "Draft",
        selection: "Draft",
        source: { conversationId: "thread-1", messageId: "message-1" },
      },
    });
    unsubscribe();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "thread-1",
        request: expect.objectContaining({
          expectedRevisionId: "revision-4",
          expectedRevisionNumber: 4,
        }),
      }),
    );
  });
});

describe("output pin events", () => {
  it("notifies workspace libraries after a durable pin update", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOutputPinned(listener);
    const output = {
      id: "output-1",
      title: "Decision",
      format: "markdown" as const,
      mimeType: "text/markdown",
      source: { conversationId: "thread-1" },
      revisions: [],
      currentRevisionId: "revision-1",
      currentRevisionNumber: 1,
      pinned: true,
      updatedAt: "2026-10-08T10:00:00.000Z",
    };
    emitOutputPinned({ workspaceId: "workspace-1", output });
    unsubscribe();
    expect(listener).toHaveBeenCalledWith({ workspaceId: "workspace-1", output });
  });
});
