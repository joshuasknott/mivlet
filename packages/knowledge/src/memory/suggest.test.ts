import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "@mivlet/protocol";
import { suggestMemories } from "./suggest";

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1",
    kind: "preference",
    title: "Prefers dark mode",
    value: "The user prefers dark mode.",
    source: "chat",
    freshness: "Today",
    approved: true,
    pinned: false,
    ...overrides
  };
}

describe("suggestMemories", () => {
  it("extracts a preference from an 'I prefer X' message", () => {
    const suggestions = suggestMemories({
      recentMessages: [{ role: "user", content: "I prefer tabs over spaces." }],
      existingMemory: []
    });

    expect(suggestions.length).toBeGreaterThan(0);
    const pref = suggestions.find((s) => /tabs/i.test(s.title));
    expect(pref).toBeTruthy();
    expect(pref?.kind).toBe("preference");
    expect(pref?.id).toMatch(/^sug-/);
    expect(pref?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(pref?.confidence).toBeLessThanOrEqual(0.8);
  });

  it("does NOT mutate any argument and writes nothing", () => {
    const existing = [makeMemory()];
    const existingSnapshot = JSON.stringify(existing);
    const ctx = {
      recentMessages: [{ role: "user", content: "I prefer tabs over spaces." }],
      existingMemory: existing
    };
    const ctxSnapshot = JSON.stringify(ctx);

    const result = suggestMemories(ctx);

    expect(JSON.stringify(existing)).toBe(existingSnapshot);
    expect(JSON.stringify(ctx)).toBe(ctxSnapshot);
    for (const suggestion of result) {
      expect(suggestion.id).toMatch(/^sug-/);
      expect(typeof suggestion.value).toBe("string");
    }
  });

  it("attaches duplicateOfId when a candidate duplicates existing memory", () => {
    const existing = [makeMemory({ id: "mem-dark" })];
    const suggestions = suggestMemories({
      recentMessages: [{ role: "user", content: "I prefer dark mode." }],
      existingMemory: existing
    });
    const dup = suggestions.find((s) => s.duplicateOfId === "mem-dark");
    expect(dup).toBeTruthy();
  });

  it("attaches contradictsId when a candidate contradicts existing memory", () => {
    const existing = [makeMemory({ id: "mem-dark", value: "The user prefers dark mode." })];
    const suggestions = suggestMemories({
      recentMessages: [{ role: "user", content: "I dislike dark mode." }],
      existingMemory: existing
    });
    const contra = suggestions.find((s) => s.contradictsId === "mem-dark");
    expect(contra).toBeTruthy();
  });

  it("ignores non-user messages when extracting from chat", () => {
    const suggestions = suggestMemories({
      recentMessages: [{ role: "assistant", content: "I prefer tabs over spaces." }],
      existingMemory: []
    });
    expect(suggestions).toHaveLength(0);
  });
});
