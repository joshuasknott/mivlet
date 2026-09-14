import { describe, expect, it } from "vitest";
import type {
  CollaborationWorkItem,
  ConversationRoom,
  MemoryRecord,
} from "@fable/protocol";
import {
  attentionOrder,
  memoryInScope,
  scopeLevelsFor,
  scopeWork,
  scopedRoomIds,
  sideChatsFor,
  teamMembers,
} from "./work-order";

const room = (patch: Partial<ConversationRoom> = {}): ConversationRoom => ({
  id: "room",
  workspaceId: "workspace",
  kind: "direct",
  title: "Room",
  participants: [{ agentId: "agent", name: "Mira" }],
  revision: 1,
  generation: 1,
  createdAt: "2026-09-12T10:00:00Z",
  updatedAt: "2026-09-12T10:00:00Z",
  ...patch,
});
const item = (patch: Partial<CollaborationWorkItem> = {}): CollaborationWorkItem => ({
  id: "work",
  rootId: "work",
  workspaceId: "workspace",
  conversationId: "room",
  agentId: "agent",
  agentName: "Mira",
  prompt: "Assignment",
  userRequest: "Request",
  status: "queued",
  permissionMode: "trusted-scope",
  dependencies: [],
  waitingFor: [],
  prerequisites: [],
  awaitingUser: false,
  generation: 1,
  conversationGeneration: 1,
  contextRevision: 0,
  depth: 0,
  turnCount: 0,
  tokenUsage: 0,
  maxTurns: 12,
  maxTokens: 64000,
  runIds: [],
  modelOptionId: "codex::fixture",
  outputs: [],
  createdAt: "2026-09-12T10:00:00Z",
  updatedAt: "2026-09-12T10:00:00Z",
  ...patch,
});
const memory = (patch: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: "memory",
  kind: "fact",
  title: "Title",
  value: "Value",
  source: "Test",
  freshness: "Today",
  approved: true,
  pinned: false,
  ...patch,
});

describe("navigation scoping", () => {
  it("scopes work to the selected agent or project", () => {
    const work = [
      item({ id: "a", agentId: "agent", projectId: "project" }),
      item({ id: "b", agentId: "other" }),
      item({ id: "c", agentId: "agent" }),
    ];
    expect(scopeWork(work, { agentId: "agent" }).map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(scopeWork(work, { projectId: "project" }).map((entry) => entry.id)).toEqual(["a"]);
    expect(scopeWork(work, {}).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("matches memory only by its exact owning scope", () => {
    const agentScopes = scopeLevelsFor({
      agentId: "agent",
      roomIds: ["room"],
      workIds: ["work"],
    });
    expect(memoryInScope(memory(), agentScopes)).toBe(true);
    expect(
      memoryInScope(memory({ scope: { level: "agent", agentId: "agent" } }), agentScopes),
    ).toBe(true);
    expect(
      memoryInScope(memory({ scope: { level: "agent", agentId: "other" } }), agentScopes),
    ).toBe(false);
    expect(
      memoryInScope(memory({ scope: { level: "thread", threadId: "room" } }), agentScopes),
    ).toBe(true);
    expect(
      memoryInScope(memory({ scope: { level: "thread", threadId: "elsewhere" } }), agentScopes),
    ).toBe(false);
    expect(
      memoryInScope(memory({ scope: { level: "work", workId: "work" } }), agentScopes),
    ).toBe(true);
    expect(
      memoryInScope(memory({ scope: { level: "project", projectId: "project" } }), agentScopes),
    ).toBe(false);
    const projectScopes = scopeLevelsFor({ projectId: "project", roomIds: ["main"] });
    expect(
      memoryInScope(memory({ scope: { level: "project", projectId: "project" } }), projectScopes),
    ).toBe(true);
    expect(
      memoryInScope(memory({ scope: { level: "agent", agentId: "agent" } }), projectScopes),
    ).toBe(false);
  });

  it("keeps side chats subordinate and never promotes a main chat", () => {
    const rooms = [
      room({ id: "main", chat: { role: "main", ownerKind: "agent", ownerId: "agent" } }),
      room({ id: "side", chat: { role: "side", ownerKind: "agent", ownerId: "agent" } }),
      room({ id: "legacy", participants: [{ agentId: "agent", name: "Mira" }] }),
      room({ id: "other", participants: [{ agentId: "other", name: "Theo" }] }),
    ];
    expect(
      sideChatsFor({ kind: "agent", agentId: "agent" }, rooms).map((entry) => entry.id),
    ).toEqual(["side", "legacy"]);
    const projectRooms = [
      room({ id: "main", projectId: "project", kind: "group", title: "Main" }),
      room({ id: "side", projectId: "project", kind: "group", title: "Side", chat: { role: "side", ownerKind: "project", ownerId: "project" } }),
      room({ id: "unmarked", projectId: "project", kind: "group", title: "Unmarked" }),
    ];
    // An unmarked room that is the project's thread is the main chat, never a side chat.
    expect(
      sideChatsFor(
        { kind: "project", project: { id: "project", threadId: "main" } },
        projectRooms,
      ).map((entry) => entry.id),
    ).toEqual(["side", "unmarked"]);
    expect(sideChatsFor(null, rooms)).toEqual([]);
  });

  it("resolves thread scopes to the context's rooms", () => {
    const rooms = [
      room({ id: "a", participants: [{ agentId: "agent", name: "Mira" }] }),
      room({ id: "b", projectId: "project", kind: "group", participants: [{ agentId: "other", name: "Theo" }] }),
    ];
    expect(scopedRoomIds("agent", undefined, rooms)).toEqual(["a"]);
    expect(scopedRoomIds(undefined, "project", rooms)).toEqual(["b"]);
    expect(scopedRoomIds(undefined, undefined, rooms)).toEqual([]);
  });

  it("reads team membership from saved agent profiles", () => {
    expect(
      teamMembers(
        { projectId: "project", participantIds: ["agent", "gone"], leadAgentId: "agent", revision: 1 },
        [{ id: "agent", name: "Mira" }],
      ),
    ).toEqual({ lead: "Mira", participants: ["Mira", "gone"] });
    expect(teamMembers(undefined, [])).toEqual({ participants: [] });
  });

  it("keeps attention ahead of active and finished work", () => {
    const ordered = attentionOrder([
      item({ id: "done", status: "completed" }),
      item({ id: "run", status: "running" }),
      item({ id: "fail", status: "failed" }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["fail", "run", "done"]);
  });
});