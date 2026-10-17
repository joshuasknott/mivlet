import { expect, it } from "vitest";
import type { CollaborationWorkItem } from "@mivlet/protocol";
import { previewFeedbackWork } from "./preview-feedback";
const source = { runId: "run-original", agentId: "agent", repositoryId: "copy-a", jobId: "job", jobGeneration: 4 };
const work = (patch: Partial<CollaborationWorkItem> = {}): CollaborationWorkItem => ({
  id: "original", rootId: "original", workspaceId: "workspace", conversationId: "room", agentId: "agent", agentName: "Atlas",
  prompt: "Build this page", userRequest: "Build this page", permissionMode: "read-only", status: "completed",
  dependencies: [], waitingFor: [], prerequisites: [], awaitingUser: false, generation: 4,
  conversationGeneration: 1, contextRevision: 0, depth: 0, turnCount: 1, tokenUsage: 1000,
  maxTurns: 6, maxTokens: 128000, runIds: ["run-original"], modelOptionId: "codex::fixture", outputs: [],
  repositoryBinding: { version: 1, repositoryId: "copy-a", branch: "mivlet/a", baseCommit: "base", capturedAt: "2026-10-17T00:00:00Z" },
  createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z", ...patch,
});
it.each(["running", "completed"] as const)("keeps feedback on its %s source Work even when a newer task uses another selected copy", status => {
  const original = work({ status });
  const newer = work({ id: "newer", runIds: ["new-run"], repositoryBinding: { ...original.repositoryBinding!, repositoryId: "copy-b" } });
  expect(previewFeedbackWork([original, newer], "room", source)).toBe(original);
});
it.each([
  { runIds: ["another-run"] }, { agentId: "another-agent" }, { conversationId: "another-room" },
  { repositoryBinding: undefined }, { repositoryBinding: { version: 1, repositoryId: "copy-b", branch: "b", baseCommit: "base", capturedAt: "now" } },
] satisfies Partial<CollaborationWorkItem>[])("never guesses a source across mismatched provenance %j", patch => {
  expect(() => previewFeedbackWork([work(patch)], "room", source)).toThrow("could not be matched");
});
it("rejects ambiguous source Work and ended, uncertain or exhausted assignments", () => {
  expect(() => previewFeedbackWork([work(), work({ id: "duplicate" })], "room", source)).toThrow("could not be matched");
  for (const patch of [{ status: "failed" }, { status: "cancelled" }, { status: "awaiting-user", awaitingUser: false }] satisfies Partial<CollaborationWorkItem>[])
    expect(() => previewFeedbackWork([work(patch)], "room", source)).toThrow("reconcile");
  expect(() => previewFeedbackWork([work({ turnCount: 6 })], "room", source)).toThrow("budget");
});
