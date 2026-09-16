import { describe, expect, it } from "vitest";
import type { MemoryProvenance, MemorySuggestion } from "@mivlet/protocol";
import { GLOBAL_SCOPE } from "@mivlet/protocol";
import { approveSuggestion, promoteToMemory } from "./promote";

const NOW = "2026-06-28T12:00:00.000Z";
const chatProvenance: MemoryProvenance = { origin: "chat", note: "User-confirmed." };

describe("promoteToMemory", () => {
  it("produces an approved record with provenance, scope, and timestamps", () => {
    const record = promoteToMemory({
      title: "Prefers dark mode",
      value: "The user prefers dark mode.",
      kind: "preference",
      provenance: chatProvenance,
      now: NOW
    });

    expect(record.approved).toBe(true);
    expect(record.approvalState).toBe("approved");
    expect(record.pinned).toBe(false);
    expect(record.freshness).toBe("Just now");
    expect(record.source).toBe("chat");
    expect(record.provenance).toEqual(chatProvenance);
    expect(record.scope).toEqual(GLOBAL_SCOPE);
    expect(record.confidence).toBe(1);
    expect(record.createdAt).toBe(NOW);
    expect(record.updatedAt).toBe(NOW);
    expect(record.id).toMatch(/^mem-prefers-dark-mode-/);
  });

  it("honors an explicit scope, confidence, and runId", () => {
    const threadScope = { level: "thread" as const, threadId: "thread-1" };
    const record = promoteToMemory({
      title: "Uses Postgres",
      value: "The project uses Postgres.",
      kind: "fact",
      scope: threadScope,
      provenance: { origin: "run", runId: "r1", note: "From a completed run." },
      confidence: 0.9,
      runId: "r1",
      now: NOW
    });

    expect(record.scope).toEqual(threadScope);
    expect(record.confidence).toBe(0.9);
    expect(record.runId).toBe("r1");
  });
});

describe("approveSuggestion", () => {
  it("promotes a suggestion and clears dup/contradiction flags", () => {
    const suggestion: MemorySuggestion = {
      id: "sug-foo-1",
      title: "Likes tabs over spaces",
      value: "The user likes tabs over spaces.",
      kind: "preference",
      provenance: { origin: "chat", note: "Inferred." },
      confidence: 0.7,
      duplicateOfId: "mem-existing-1",
      contradictsId: "mem-existing-2"
    };

    const record = approveSuggestion(suggestion, NOW);

    expect(record.approved).toBe(true);
    expect(record.approvalState).toBe("approved");
    expect(record.title).toBe("Likes tabs over spaces");
    expect(record.value).toBe("The user likes tabs over spaces.");
    expect(record.kind).toBe("preference");
    expect(record.confidence).toBe(0.7);
    expect(record.createdAt).toBe(NOW);
    // Approved records carry NO duplicate/contradicts fields — explicit approval
    // supersedes them (these are suggestion-only concepts).
    expect("duplicateOfId" in record).toBe(false);
    expect("contradictsId" in record).toBe(false);
  });

  it("scrubs secret-shaped suggestion values before they become approved memory", () => {
    const leaked = "sk-12345678901234567890abc123";
    const suggestion: MemorySuggestion = {
      id: "sug-secret-1",
      title: "API key",
      value: `Keep the launch key ${leaked} in the vault.`,
      kind: "fact",
      provenance: { origin: "chat", note: "Inferred." },
      confidence: 0.8
    };

    const record = approveSuggestion(suggestion, NOW);

    expect(record.value).toContain("Keep the launch key");
    expect(record.value).not.toContain(leaked);
    expect(record.value).toContain("[REDACTED]");
  });
});

describe("promoteToMemory — secret-shaped values", () => {
  it("scrubs secret-shaped values before they are stored as approved memory", () => {
    const leaked = "sk-ant-12345678901234567890abc123";
    const record = promoteToMemory({
      title: "Deploy token",
      value: `The deploy token is ${leaked} for staging.`,
      kind: "fact",
      provenance: chatProvenance,
      now: NOW
    });

    expect(record.approved).toBe(true);
    expect(record.value).toContain("The deploy token is");
    expect(record.value).not.toContain(leaked);
    expect(record.value).toContain("[REDACTED]");
  });
});
