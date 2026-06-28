import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "@fable/protocol";
import { detectContradiction, detectDuplicate } from "./duplicate";

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1",
    kind: "fact",
    title: "Prefers concise answers",
    value: "The user prefers concise answers.",
    source: "chat",
    freshness: "Today",
    approved: true,
    pinned: false,
    ...overrides
  };
}

describe("detectDuplicate", () => {
  it("flags a near-identical value", () => {
    const existing = [makeMemory()];
    const candidate = { title: "Prefers concise answers", value: "The user prefers concise answers." };
    expect(detectDuplicate(candidate, existing)?.memory.id).toBe("m1");
  });

  it("flags a substring-equivalent value", () => {
    const existing = [makeMemory({ value: "The user prefers concise answers." })];
    const candidate = { title: "Concise", value: "the user prefers concise answers" };
    expect(detectDuplicate(candidate, existing)).not.toBeNull();
  });

  it("does not flag a clearly distinct value", () => {
    const existing = [makeMemory()];
    const candidate = { title: "Lives in Berlin", value: "The user lives in Berlin." };
    expect(detectDuplicate(candidate, existing)).toBeNull();
  });

  it("ignores forgotten (non-live) memories", () => {
    const existing = [makeMemory({ forgottenAt: "2026-01-01T00:00:00.000Z" })];
    const candidate = { title: "Prefers concise answers", value: "The user prefers concise answers." };
    expect(detectDuplicate(candidate, existing)).toBeNull();
  });

  it("ignores disabled (non-live) memories", () => {
    const existing = [makeMemory({ disabled: true })];
    const candidate = { title: "Prefers concise answers", value: "The user prefers concise answers." };
    expect(detectDuplicate(candidate, existing)).toBeNull();
  });
});

describe("detectContradiction", () => {
  it("flags 'prefers dark mode' vs 'dislikes dark mode' with a reason", () => {
    const existing = [
      makeMemory({ id: "m-dark", title: "Prefers dark mode", value: "The user prefers dark mode." })
    ];
    const candidate = { title: "Dislikes dark mode", value: "The user dislikes dark mode." };
    const result = detectContradiction(candidate, existing);
    expect(result).not.toBeNull();
    expect(result?.memory.id).toBe("m-dark");
    expect(result?.reason.length ?? 0).toBeGreaterThan(0);
  });

  it("flags a negation asymmetry on the same subject", () => {
    const existing = [
      makeMemory({ id: "m-coffee", title: "Drinks coffee", value: "The user drinks coffee." })
    ];
    const candidate = { title: "Coffee", value: "The user does not drink coffee." };
    expect(detectContradiction(candidate, existing)).not.toBeNull();
  });

  it("does not flag unrelated subjects", () => {
    const existing = [makeMemory({ title: "Prefers dark mode", value: "The user prefers dark mode." })];
    const candidate = { title: "Lives in Berlin", value: "The user lives in Berlin." };
    expect(detectContradiction(candidate, existing)).toBeNull();
  });
});
