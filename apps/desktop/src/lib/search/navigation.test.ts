import { describe, expect, it } from "vitest";
import type { SearchObjectKind, SearchResult } from "@fable/protocol";
import { navigationTargetFor } from "./navigation";

function result(
  objectKind: SearchObjectKind,
  id: string,
  context: SearchResult["context"] = {},
): SearchResult {
  return {
    reference: { workspaceId: "ws", kind: objectKind, id },
    objectKind,
    title: "Title",
    snippet: "snippet",
    matchedField: "title",
    score: 1,
    archived: false,
    context,
  };
}

describe("search result navigation targets", () => {
  it("references the existing conversation and optional message", () => {
    expect(
      navigationTargetFor(
        result("conversation", "thread-1", {
          conversationId: "thread-1",
          messageId: "message-9",
        }),
      ),
    ).toEqual({
      type: "conversation",
      workspaceId: "ws",
      conversationId: "thread-1",
      messageId: "message-9",
    });
  });

  it("resolves projects to their proven thread and work to its chat", () => {
    expect(
      navigationTargetFor(
        result("project", "project-1", {
          projectId: "project-1",
          threadId: "thread-project",
        }),
      ),
    ).toEqual({
      type: "project",
      workspaceId: "ws",
      projectId: "project-1",
      threadId: "thread-project",
    });
    expect(
      navigationTargetFor(
        result("work", "work-1", {
          workId: "work-1",
          conversationId: "thread-2",
        }),
      ),
    ).toEqual({
      type: "work",
      workspaceId: "ws",
      workId: "work-1",
      conversationId: "thread-2",
    });
  });

  it("resolves agent and file results without creating a conversation", () => {
    expect(navigationTargetFor(result("agent", "agent-1"))).toEqual({
      type: "agent",
      workspaceId: "ws",
      agentId: "agent-1",
    });
    expect(
      navigationTargetFor(
        result("file", '["agent-1","notes/aurora.txt"]', {
          fileKind: "artifact",
          agentId: "agent-1",
          relativePath: "notes/aurora.txt",
        }),
      ),
    ).toEqual({
      type: "artifact",
      workspaceId: "ws",
      agentId: "agent-1",
      relativePath: "notes/aurora.txt",
      title: "Title",
    });
    expect(
      navigationTargetFor(
        result("file", "source-1", {
          fileKind: "knowledge",
          sourceId: "source-1",
          projectId: "project-1",
        }),
      ),
    ).toEqual({
      type: "knowledge-file",
      workspaceId: "ws",
      sourceId: "source-1",
      projectId: "project-1",
    });
  });

  it("fails closed when owner context is incomplete", () => {
    expect(navigationTargetFor(result("project", "project-1"))).toBeNull();
    expect(
      navigationTargetFor(result("work", "work-1", { workId: "work-1" })),
    ).toBeNull();
    expect(
      navigationTargetFor(result("file", "artifact-1", { fileKind: "artifact" })),
    ).toBeNull();
  });
});
