import { describe, expect, it } from "vitest";
import {
  promoteCompletedWorkOutcome,
  promoteSideChatOutcome,
  resolvePromotionScope
} from "./promotion";

const outcomes = [
  {
    messageId: "message-1",
    role: "user" as const,
    sequence: 1,
    text: "We decided to ship the pilot on Friday."
  },
  {
    messageId: "message-2",
    role: "assistant" as const,
    sequence: 2,
    text: "I prefer the staged rollout and will keep the existing keyboard behavior."
  },
  {
    messageId: "message-3",
    role: "user" as const,
    sequence: 3,
    text: "Actually, switch the pilot to Monday instead."
  }
];

describe("promotion scope", () => {
  it("requires the exact owner id for every narrow scope", () => {
    expect(resolvePromotionScope(undefined, { threadId: "thread-1" })).toEqual({
      level: "thread",
      threadId: "thread-1"
    });
    expect(() =>
      resolvePromotionScope({ level: "thread", threadId: "thread-1" }, { threadId: "" })
    ).toThrow(/conversation id/);
    expect(() => resolvePromotionScope({ level: "agent", agentId: "agent-1" }, { threadId: "t" })).toThrow(
      /agent id/
    );
    expect(() =>
      resolvePromotionScope({ level: "project", projectId: "project-1" }, { threadId: "t" })
    ).toThrow(/project id/);
    expect(() =>
      resolvePromotionScope({ level: "work", workId: "work-1" }, { threadId: "t" })
    ).toThrow(/work id/);
    expect(
      resolvePromotionScope({ level: "global" }, { threadId: "thread-1" })
    ).toEqual({ level: "global" });
  });

  it("stamps the requested narrow scope onto promoted records", () => {
    const records = promoteSideChatOutcome({
      explicit: true,
      threadId: "thread-1",
      agentId: "agent-1",
      outcomes,
      scope: { level: "agent", agentId: "agent-1" },
      now: "2026-09-10T00:00:00.000Z"
    });
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.scope).toEqual({ level: "agent", agentId: "agent-1" });
      expect(record.approved).toBe(true);
      expect(record.approvalState).toBe("approved");
      expect(record.provenance?.origin).toBe("chat");
      expect(record.source).toContain("Side Chat thread-1");
    }
  });
});

describe("side chat promotion", () => {
  it("requires an explicit user action and enabled memory", () => {
    expect(() =>
      promoteSideChatOutcome({
        explicit: false as never,
        threadId: "thread-1",
        outcomes
      })
    ).toThrow(/explicit user action/);
    expect(() =>
      promoteSideChatOutcome({
        explicit: true,
        threadId: "thread-1",
        outcomes,
        memoryDisabled: true
      })
    ).toThrow(/Memory is disabled/);
  });

  it("selects bounded useful outcomes with kinds, sources and owner", () => {
    const records = promoteSideChatOutcome({
      explicit: true,
      threadId: "thread-1",
      outcomes,
      now: "2026-09-10T00:00:00.000Z"
    });
    expect(records.length).toBeLessThanOrEqual(3);
    const kinds = records.map((record) => record.kind);
    expect(kinds).toContain("decision");
    expect(kinds).toContain("correction");
    expect(kinds).toContain("preference");
    for (const record of records) {
      expect(record.value.length).toBeLessThanOrEqual(2_000);
      expect(record.title.length).toBeLessThanOrEqual(120);
      expect(record.scope).toEqual({ level: "thread", threadId: "thread-1" });
      expect(record.confidence).toBe(1);
      expect(record.runId).toBeUndefined();
    }
  });

  it("never promotes more than the bounded record count", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      messageId: `message-${index}`,
      role: "user" as const,
      sequence: index + 1,
      text: `Decision ${index}: keep the setting ${index}.`
    }));
    const records = promoteSideChatOutcome({
      explicit: true,
      threadId: "thread-1",
      outcomes: many
    });
    expect(records.length).toBeLessThanOrEqual(6);
  });
});

describe("completed work promotion", () => {
  it("promotes the bounded request and public results, not execution history", () => {
    const records = promoteCompletedWorkOutcome({
      explicit: true,
      workId: "work-1",
      threadId: "thread-1",
      request: "Research the pilot rollout plan.",
      results: [
        {
          messageId: "message-2",
          role: "assistant",
          sequence: 2,
          text: "The pilot rollout decision is to stage 10% first."
        }
      ],
      reason: "completed",
      now: "2026-09-10T00:00:00.000Z"
    });
    expect(records.length).toBeGreaterThan(0);
    expect(records.some((record) => record.value.includes("Research the pilot"))).toBe(true);
    expect(records.some((record) => record.kind === "decision")).toBe(true);
    for (const record of records) {
      expect(record.scope).toEqual({ level: "work", workId: "work-1" });
      expect(record.provenance?.origin).toBe("run");
      expect(record.provenance?.runId).toBe("work-1");
      expect(record.runId).toBe("work-1");
    }
  });

  it("fails closed without a work id or while memory is disabled", () => {
    expect(() =>
      promoteCompletedWorkOutcome({
        explicit: true,
        workId: "",
        threadId: "thread-1",
        request: "Do the thing",
        results: []
      })
    ).toThrow(/work id/);
    expect(() =>
      promoteCompletedWorkOutcome({
        explicit: true,
        workId: "work-1",
        threadId: "thread-1",
        request: "Do the thing",
        results: [],
        memoryDisabled: true
      })
    ).toThrow(/Memory is disabled/);
  });
});

describe("promotion — secret-shaped outcomes", () => {
  it("scrubs secret-shaped side-chat outcomes before they become approved memory", () => {
    const leaked = "sk-12345678901234567890abc123";
    const records = promoteSideChatOutcome({
      explicit: true,
      threadId: "thread-1",
      outcomes: [
        {
          messageId: "message-secret",
          role: "user",
          sequence: 1,
          text: `We decided to keep the launch key ${leaked} in the vault.`
        }
      ],
      now: "2026-09-10T00:00:00.000Z"
    });
    expect(records).toHaveLength(1);
    expect(records[0].value).toContain("We decided to keep the launch key");
    expect(records[0].value).not.toContain(leaked);
    expect(records[0].value).toContain("[REDACTED]");
  });

  it("does not promote omit-only outcomes", () => {
    const records = promoteSideChatOutcome({
      explicit: true,
      threadId: "thread-1",
      outcomes: [
        {
          messageId: "message-omit",
          role: "user",
          sequence: 1,
          text: "[content omitted: secret-shaped content]"
        }
      ],
      now: "2026-09-10T00:00:00.000Z"
    });
    expect(records).toEqual([]);
  });
});
