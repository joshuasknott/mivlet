import { describe, expect, it } from "vitest";
import type {
  CollaborationWorkItem,
  ConversationRoom,
  KnowledgeSource,
  LocalProject,
  MemoryRecord,
} from "@mivlet/protocol";
import {
  agentChatOwner,
  panelFiles,
  panelMemories,
  panelRooms,
  panelWork,
} from "./workspace-panel-data";

const room = (
  id: string,
  patch: Partial<ConversationRoom> = {},
): ConversationRoom => ({
  id,
  workspaceId: "workspace",
  title: id,
  kind: "direct",
  facilitatorId: "mira",
  participants: [{ agentId: "mira", name: "Mira" }],
  revision: 1,
  generation: 1,
  createdAt: "2026-10-15T09:00:00Z",
  updatedAt: "2026-10-15T09:00:00Z",
  ...patch,
});
const work = (id: string, patch: Partial<CollaborationWorkItem> = {}) =>
  ({
    id,
    rootId: id,
    workspaceId: "workspace",
    conversationId: "chat",
    agentId: "mira",
    agentName: "Mira",
    outputs: [],
    attachments: [],
    createdAt: "2026-10-15T09:00:00Z",
    updatedAt: "2026-10-15T09:00:00Z",
    ...patch,
  }) as CollaborationWorkItem;
const memory = (
  id: string,
  scope: MemoryRecord["scope"],
  patch: Partial<MemoryRecord> = {},
) =>
  ({
    id,
    scope,
    workspaceId: "workspace",
    title: id,
    value: "Preference",
    approved: true,
    ...patch,
  }) as MemoryRecord;
const project = {
  id: "project",
  workspaceId: "workspace",
  name: "Portfolio",
  knowledgeSourceIds: ["shared", "foreign", "deleted"],
  updatedAt: "2026-10-15T08:00:00Z",
} as LocalProject;

describe("panel browsing boundaries", () => {
  it("defaults to the exact chat and broadens only to the exact owning project", () => {
    const current = room("chat", { projectId: "project" });
    const sibling = room("sibling", { projectId: "project" });
    const others = [
      room("private"),
      room("other", { projectId: "other" }),
      room("foreign", { projectId: "project", workspaceId: "foreign" }),
    ];
    const owner = {
      kind: "project" as const,
      id: "project",
      name: "Portfolio",
    };
    expect(
      panelRooms(
        "workspace",
        current,
        [current, sibling, ...others],
        owner,
        "chat",
      ),
    ).toEqual([current]);
    expect(
      panelRooms(
        "workspace",
        current,
        [current, sibling, ...others],
        owner,
        "owner",
      ),
    ).toEqual([current, sibling]);
    expect(panelRooms("foreign", current, [current], owner, "chat")).toEqual(
      [],
    );
  });

  it("does not confuse an agent's project participation with private agent chats", () => {
    const current = room("chat");
    const sibling = room("sibling", {
      chat: { role: "side", ownerKind: "agent", ownerId: "mira" },
    });
    const projectChat = room("project", { projectId: "project" });
    const otherAgent = room("other", {
      facilitatorId: "theo",
      participants: [{ agentId: "theo", name: "Theo" }],
    });
    const owner = { kind: "agent" as const, id: "mira", name: "Mira" };
    expect(
      panelRooms(
        "workspace",
        current,
        [current, sibling, projectChat, otherAgent],
        owner,
        "owner",
      ),
    ).toEqual([current, sibling]);
    expect(agentChatOwner(projectChat)).toBeUndefined();
    expect(
      agentChatOwner(
        room("legacy-group", {
          facilitatorId: undefined,
          participants: [
            { agentId: "mira", name: "Mira" },
            { agentId: "theo", name: "Theo" },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it("retains delegated effort results while rejecting sibling and foreign work", () => {
    const root = work("root");
    const child = work("child", {
      parentId: "root",
      rootId: "root",
      conversationId: "delegated",
      agentId: "theo",
    });
    const unrelated = work("other", { conversationId: "sibling" });
    const foreign = work("foreign", { rootId: "root", workspaceId: "foreign" });
    expect(
      panelWork("workspace", [room("chat")], [root, child, unrelated, foreign]),
    ).toEqual([root, child]);
    expect(
      panelWork(
        "workspace",
        [room("chat", { workspaceId: "foreign" })],
        [root],
      ),
    ).toEqual([]);
  });

  it("owner memory browsing excludes chat-specific and unrelated shared records", () => {
    const records = [
      memory("chat", { level: "thread", threadId: "chat" }),
      memory("project", { level: "project", projectId: "project" }),
      memory("sibling", { level: "thread", threadId: "sibling" }),
      memory("agent", { level: "agent", agentId: "mira" }),
      memory("global", { level: "global" }),
      memory(
        "foreign",
        { level: "project", projectId: "project" },
        { workspaceId: "foreign" },
      ),
    ];
    expect(
      panelMemories(records, room("chat", { projectId: "project" })).map(
        ({ record }) => record.id,
      ),
    ).toEqual(["chat", "project"]);
    expect(
      panelMemories(
        records,
        room("chat", { projectId: "project" }),
        "owner",
      ).map(({ record }) => record.id),
    ).toEqual(["project"]);
    expect(
      panelMemories(records, room("chat"), "owner").map(
        ({ record }) => record.id,
      ),
    ).toEqual(["agent"]);
  });

  it("indexes immutable published outputs once and never guesses version relationships from names", () => {
    const artifact = (id: string) =>
      JSON.stringify({
        kind: "computer-artifact",
        version: 1,
        id: "artifact-" + id.repeat(64),
        computerId: "local-" + "a".repeat(24),
        title: "Brief.docx",
        relativePath: "published/brief.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 40,
        createdAt: "2026-10-15T09:00:00Z",
      });
    const output = (id: string) => ({
      text: artifact(id),
      createdAt: "2026-10-15T09:00:00Z",
      runId: "run",
      conversationId: "chat",
      evidence: "agent-report" as const,
      messageId: "response",
      sourceRevisionId: "revision-2",
    });
    const entries = panelFiles({
      workspaceId: "workspace",
      work: [
        work("root", { outputs: [output("a"), output("a"), output("b")] }),
        work("foreign", { workspaceId: "foreign", outputs: [output("c")] }),
      ],
    });
    expect(entries).toHaveLength(2);
    expect(entries[0].tab).toMatchObject({
      kind: "artifact",
      agentId: "mira",
      title: "Brief.docx",
      conversationId: "chat",
      messageId: "response",
      sourceRevisionId: "revision-2",
    });
    expect(entries.every((entry) => entry.origin === "created")).toBe(true);
  });

  it("labels live project files and retains unavailable uploads as explicit prerequisites", () => {
    const source = (id: string, patch: Partial<KnowledgeSource> = {}) =>
      ({
        id,
        title: id + ".pdf",
        connectorId: "local-files",
        workspaceId: "workspace",
        ...patch,
      }) as KnowledgeSource;
    const entries = panelFiles({
      workspaceId: "workspace",
      project,
      sources: [
        source("shared"),
        source("foreign", { workspaceId: "foreign" }),
        source("deleted", { deletedAt: "2026-10-14" }),
      ],
      work: [
        work("root", {
          attachments: [
            {
              id: "upload",
              name: "Missing.txt",
              mimeType: "text/plain",
              sizeBytes: 4,
              availability: "transient",
            },
          ],
        }),
      ],
    });
    expect(entries.map((entry) => entry.title).sort()).toEqual([
      "Missing.txt",
      "shared.pdf",
    ]);
    expect(entries.find((entry) => entry.origin === "shared")?.detail).toBe(
      "Shared by Portfolio",
    );
    expect(
      entries.find((entry) => entry.origin === "attached")?.attachment
        ?.threadId,
    ).toBe("chat");
    expect(
      entries.find((entry) => entry.origin === "attached")?.tab,
    ).toBeUndefined();
  });
});
