import { describe, expect, it } from "vitest";
import type {
  CollaborationWorkItem,
  MivletAgentProfile,
} from "@mivlet/protocol";
import {
  conversationAuthors,
  pendingConversationTurns,
  responseOutputId,
} from "./conversation-pane-helpers";

const fallback: MivletAgentProfile = {
  id: "fallback",
  name: "Fallback",
  instructions: "",
  modelId: "",
  permissionLabel: "Ask Me",
  icon: "agent",
  iconColor: "#24bb77",
  connectorIds: [],
  knowledgeSourceIds: [],
};

const work = (patch: Partial<CollaborationWorkItem> = {}) =>
  ({
    id: "work-1",
    agentId: "agent-1",
    agentName: "Agent One",
    conversationId: "conversation-1",
    status: "failed",
    runIds: [],
    prompt: "Queued request",
    userRequest: "",
    createdAt: "2026-10-18T10:00:00.000Z",
    updatedAt: "2026-10-18T10:01:00.000Z",
    ...patch,
  }) as CollaborationWorkItem;

describe("conversation pane projections", () => {
  it("keeps a stable response id for the same source text", () => {
    expect(responseOutputId("message-1", "run-1", "answer")).toBe(
      responseOutputId("message-1", "run-1", "answer"),
    );
    expect(responseOutputId("message-1", "run-1", "answer")).not.toBe(
      responseOutputId("message-1", "run-1", "changed"),
    );
  });

  it("includes failed queue items and steering entries in feed order", () => {
    const turns = pendingConversationTurns([
      work({
        steering: [
          {
            id: "steer-1",
            text: "Continue with the review",
            createdAt: "2026-10-18T10:02:00.000Z",
          },
        ],
      }),
    ]);
    expect(turns.map((turn) => turn.id)).toEqual(["work-1", "steer-1"]);
    expect(turns[0]?.parts[0]).toMatchObject({
      kind: "notice",
      error: true,
    });
  });

  it("prefers persisted run authors and overlays current work authors", () => {
    const agentById = new Map<string, MivletAgentProfile>([
      ["agent-1", { ...fallback, id: "agent-1", name: "Current name" }],
    ]);
    const result = conversationAuthors({
      authors: [
        {
          conversationId: "conversation-1",
          runId: "run-1",
          agentId: "agent-1",
          name: "Saved name",
        },
      ],
      work: [work()],
      conversationId: "conversation-1",
      agentById,
      fallback,
    });
    expect(result["run-1"]?.name).toBe("Saved name");
    expect(result["work-1"]?.name).toBe("Agent One");
  });
});
