import { describe, expect, it } from "vitest";
import type { RuntimeConversationMessageView } from "../runtime";
import {
  matchesTerminalGeneralRetryStatus,
  resolveProjectMissionRerunSource
} from "./project-mission-rerun";

function message(
  id: string,
  kind: "user" | "assistant",
  content: string,
  runId: string,
  sequence: number
): RuntimeConversationMessageView {
  return {
    message: {
      id,
      threadId: "thread-project",
      runId,
      sequence,
      previousMessageId: sequence > 1 ? `message-${sequence - 1}` : undefined,
      kind,
      currentRevisionId: `revision-${id}`,
      currentRevisionNumber: 1,
      currentRevisionState: "terminal",
      workspaceId: "workspace-1",
      authority: "local",
      visibility: "member-private",
      ownerMemberId: "member-1",
      schemaVersion: 1,
      revision: 0,
      createdByInternalUserId: "user-1",
      createdAt: "2026-07-25T10:00:00.000Z",
      updatedAt: "2026-07-25T10:00:00.000Z"
    },
    currentRevision: {
      id: `revision-${id}`,
      messageId: id,
      threadId: "thread-project",
      messageRevisionNumber: 1,
      baseMessageRevisionNumber: 0,
      state: "terminal",
      content,
      reason: "initial",
      idempotencyKey: `key-${id}`,
      checkpointedAt: "2026-07-25T10:00:00.000Z",
      runId,
      workspaceId: "workspace-1",
      authority: "local",
      visibility: "member-private",
      ownerMemberId: "member-1",
      schemaVersion: 1,
      revision: 0,
      createdByInternalUserId: "user-1",
      createdAt: "2026-07-25T10:00:00.000Z",
      updatedAt: "2026-07-25T10:00:00.000Z"
    }
  } as RuntimeConversationMessageView;
}

describe("project Mission reruns", () => {
  it("resolves the exact durable general-Mission command for a run", () => {
    const source = resolveProjectMissionRerunSource([
      message("unrelated", "user", "/mission Other\n- task a\n- task b", "run-other", 1),
      message("request", "user", "/mission Weekly brief\n- gather\n- draft", "run-1", 2),
      message("response", "assistant", "Mission partially completed.", "run-1", 3)
    ], "run-1");

    expect(source).toEqual({
      sourceCommand: "/mission Weekly brief\n- gather\n- draft",
      sourceMessageId: "response"
    });
  });

  it("rejects ambiguous or non-general durable requests", () => {
    expect(() => resolveProjectMissionRerunSource([
      message("request-a", "user", "/mission One\n- a\n- b", "run-1", 1),
      message("request-b", "user", "/mission Two\n- a\n- b", "run-1", 2),
      message("response", "assistant", "Done", "run-1", 3)
    ], "run-1")).toThrow(/verify the original/i);

    expect(() => resolveProjectMissionRerunSource([
      message("request", "user", "/plan something", "run-2", 1),
      message("response", "assistant", "Done", "run-2", 2)
    ], "run-2")).toThrow(/exact saved \/mission/i);
  });

  it("only exposes fresh reruns for retryable terminal states", () => {
    expect(matchesTerminalGeneralRetryStatus("partially-completed")).toBe(true);
    expect(matchesTerminalGeneralRetryStatus("failed")).toBe(true);
    expect(matchesTerminalGeneralRetryStatus("cancelled")).toBe(true);
    expect(matchesTerminalGeneralRetryStatus("completed")).toBe(false);
    expect(matchesTerminalGeneralRetryStatus("running")).toBe(false);
  });
});
