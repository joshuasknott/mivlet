import { describe, expect, it } from "vitest";
import type { CollaborationWorkItem, MivletAgentProfile } from "@mivlet/protocol";
import { sidebarActivity, sidebarAttention, sidebarProjectMembers } from "./sidebar-data";

const room = { id: "chat", title: "Launch chat", kind: "group" as const, projectId: "launch", updatedAt: "2026-10-10", participants: [{ agentId: "mira" }] };
const work = (id: string, status: CollaborationWorkItem["status"], patch: Partial<CollaborationWorkItem> = {}) => ({
  id, status, agentId: "mira", agentName: "Mira", conversationId: room.id, updatedAt: "2026-10-12", ...patch,
}) as CollaborationWorkItem;

describe("sidebar data", () => {
  it("sorts from conversations and work, including project side chats and legacy main rooms", () => {
    const activity = sidebarActivity([{ id: "launch", name: "Launch", threadId: room.id, updatedAt: "2026-10-01" }],
      [{ ...room, projectId: undefined }], [work("w", "completed")]);
    expect(activity.project.get("launch")).toBe(Date.parse("2026-10-12"));
    expect(activity.agent.get("mira")).toBe(Date.parse("2026-10-12"));
    const sidebar = sidebarActivity([{ id: "launch", name: "Launch" }], [room, { ...room, id: "side", updatedAt: "2026-10-15" }], []);
    expect(sidebar.project.get("launch")).toBe(Date.parse("2026-10-15"));
  });

  it("uses current team membership instead of agents retained in historical chats", () => {
    const agents = [{ id: "mira" }, { id: "nova" }] as MivletAgentProfile[];
    const projects = [{ id: "launch", name: "Launch", threadId: room.id }];
    expect(sidebarProjectMembers(projects, agents, [room], [{ projectId: "launch", participantIds: ["nova", "nova", "deleted"], revision: 1 }]).get("launch"))
      .toEqual([agents[1]]);
    expect(sidebarProjectMembers(projects, agents, [room], [{ projectId: "launch", participantIds: [], revision: 2 }]).get("launch")).toEqual([]);
    expect(sidebarProjectMembers(projects, agents, [room], []).get("launch")).toEqual([agents[0]]);
  });

  it("shows only actionable work, deduplicates approvals and drops resolved or missing conversations", () => {
    const pending = [work("approval", "awaiting-approval"), work("question", "awaiting-user"), work("blocker", "blocked"),
      work("running", "running"), work("queued", "queued"), work("waiting", "waiting"), work("done", "completed", { awaitingUser: true }),
      work("failed", "failed"), work("review", "failed", { awaitingUser: true }), work("cancelled", "cancelled"), work("gone", "awaiting-user", { conversationId: "deleted" })];
    const attention = sidebarAttention(pending, [{ work: { id: "approval" }, approvalIds: new Set(["a", "b", "resolved"]) }], [{ id: "a" }, { id: "b" }], [room]);
    expect(attention.map((item) => [item.id, item.kind, item.count])).toEqual([
      ["approval", "approval", 2], ["question", "input", 1], ["blocker", "blocked", 1], ["review", "blocked", 1],
    ]);
    expect(sidebarAttention(pending.map((item) => ({ ...item, status: "completed" })), [], [], [room])).toEqual([]);
  });
});
