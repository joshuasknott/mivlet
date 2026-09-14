import { describe, expect, it, vi } from "vitest";
import type { CollaborationWorkItem, MemoryControlState } from "@fable/protocol";
import {
  memoryRecordFromWorkOutput,
  promoteWorkOutputToMemory,
} from "./work-memory";

vi.mock("../runtime", () => ({
  saveRuntimeMemoryState: vi.fn(async (state: MemoryControlState) => state),
}));
import { saveRuntimeMemoryState } from "../runtime";

const work = {
  id: "work", rootId: "work", workspaceId: "workspace", conversationId: "room",
  agentId: "agent", agentName: "Researcher", prompt: "Read the brief and summarize", userRequest: "Summarize the brief for me",
  status: "completed", permissionMode: "trusted-scope",
  dependencies: [], waitingFor: [], prerequisites: [], awaitingUser: false, generation: 2,
  conversationGeneration: 1, contextRevision: 0, depth: 0, turnCount: 1, tokenUsage: 120,
  maxTurns: 12, maxTokens: 64000, runIds: ["run-one"], modelOptionId: "codex::fixture",
  outputs: [], createdAt: "2026-09-12T10:00:00Z", updatedAt: "2026-09-12T10:10:00Z",
} as CollaborationWorkItem;
const output = {
  runId: "run-one",
  conversationId: "room",
  text: "A durable saved report.",
  evidence: "agent-report" as const,
  createdAt: "2026-09-12T10:10:00Z",
};

describe("work outcome promotion through the baseline memory interface", () => {
  it("builds an explicit work-scoped record with run provenance", () => {
    const record = memoryRecordFromWorkOutput(work, output, "2026-09-12T11:00:00Z");
    expect(record.scope).toEqual({ level: "work", workId: "work" });
    expect(record.provenance).toEqual({
      origin: "run",
      runId: "run-one",
      note: "Saved from work output run-one",
    });
    expect(record.runId).toBe("run-one");
    expect(record.approved).toBe(true);
    expect(record.value).toBe("A durable saved report.");
  });

  it("persists through saveRuntimeMemoryState without a separate store", async () => {
    const mocked = vi.mocked(saveRuntimeMemoryState);
    mocked.mockClear();
    await promoteWorkOutputToMemory(work, output, {
      disabled: false,
      records: [],
    });
    expect(mocked).toHaveBeenCalledWith(
      expect.objectContaining({
        disabled: false,
        records: [expect.objectContaining({ scope: { level: "work", workId: "work" } })],
      }),
    );
  });
});