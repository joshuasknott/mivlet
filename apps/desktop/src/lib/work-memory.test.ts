import { describe, expect, it, vi } from "vitest";
import type { CollaborationWorkItem, MemoryControlState } from "@mivlet/protocol";
import {
  memoryRecordFromWorkOutput,
  promoteWorkOutputToMemory,
} from "./work-memory";

vi.mock("../runtime/domains/memory", () => ({
saveRuntimeMemoryState: vi.fn(async (state: MemoryControlState) => state)
}));
import { saveRuntimeMemoryState } from "../runtime/domains/memory";

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
  it("builds an explicitly selected conclusion at the work owner's destination", () => {
    const agentRecord = memoryRecordFromWorkOutput(
      work,
      output,
      "Keep summaries under five lines.",
      "2026-09-12T11:00:00Z",
    );
    expect(agentRecord.scope).toEqual({ level: "agent", agentId: "agent" });
    expect(agentRecord.provenance).toEqual({
      origin: "run",
      runId: "run-one",
      note: "Saved from work output run-one",
    });
    expect(agentRecord.runId).toBe("run-one");
    expect(agentRecord.approved).toBe(true);
    expect(agentRecord.value).toBe("Keep summaries under five lines.");
    const projectRecord = memoryRecordFromWorkOutput(
      { ...work, projectId: "project" },
      output,
      "Keep summaries under five lines.",
      "2026-09-12T11:00:00Z",
    );
    expect(projectRecord.scope).toEqual({
      level: "project",
      projectId: "project",
    });
  });

  it("rejects an empty or unbounded conclusion instead of truncating it", () => {
    expect(() => memoryRecordFromWorkOutput(work, output, "  ")).toThrow(
      "Choose the conclusion",
    );
    expect(() =>
      memoryRecordFromWorkOutput(work, output, "x".repeat(2001)),
    ).toThrow("limited to 2000");
  });

  it("sends only the new record so concurrent memory is preserved", async () => {
    const mocked = vi.mocked(saveRuntimeMemoryState);
    mocked.mockClear();
    await promoteWorkOutputToMemory(
      work,
      output,
      "Keep summaries under five lines.",
      {
        disabled: false,
        records: [],
      },
    );
    expect(mocked).toHaveBeenCalledWith(
      expect.objectContaining({
        disabled: false,
        records: [
          expect.objectContaining({
            scope: { level: "agent", agentId: "agent" },
            value: "Keep summaries under five lines.",
          }),
        ],
      }),
    );
    expect(mocked.mock.calls[0][0].records).toHaveLength(1);
  });
});