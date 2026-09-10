import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "@fable/protocol";
import { detectContradiction, detectDuplicate, isNearIdenticalNormalized, normalizeMemoryValue } from "./duplicate";

// Full edit-distance matrix serves as an independent reference for the bounded scan.
function referenceMatch(left: string, right: string): boolean {
  const a = normalizeMemoryValue(left);
  const b = normalizeMemoryValue(right);
  if (a.value && b.value && (a.value.includes(b.value) || b.value.includes(a.value))) return true;
  const union = new Set([...a.tokens, ...b.tokens]);
  const intersection = [...a.tokens].filter((token) => b.tokens.has(token)).length;
  if (union.size === 0 || intersection / union.size >= 0.8) return true;
  if (!a.value || !b.value) return false;
  const matrix = Array.from({ length: a.value.length + 1 }, (_, i) =>
    Array.from({ length: b.value.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= a.value.length; i++) {
    for (let j = 1; j <= b.value.length; j++) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a.value[i - 1] === b.value[j - 1] ? 0 : 1)
      );
    }
  }
  return 1 - matrix[a.value.length][b.value.length] / Math.max(a.value.length, b.value.length) >= 0.9;
}

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
  it("matches full edit distance for substitutions, insertions and deletions around the threshold", () => {
    let seed = 42;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (const length of [1, 9, 10, 11, 19, 20, 29, 30, 50, 100]) {
      for (let sample = 0; sample < 20; sample++) {
        const left = Array.from({ length }, () => String.fromCharCode(97 + random() % 26)).join("");
        const chars = [...left];
        const edits = Math.floor(length / 10) + sample % 3;
        for (let edit = 0; edit < edits; edit++) {
          const position = random() % chars.length;
          if (sample % 3 === 0) chars[position] = "z";
          else if (sample % 3 === 1) chars.splice(position, 0, "z");
          else chars.splice(position, 1);
        }
        const right = chars.join("");
        for (const [a, b] of [[left, right], [right, left]]) {
          expect(isNearIdenticalNormalized(normalizeMemoryValue(a), normalizeMemoryValue(b)), `${a} / ${b}`)
            .toBe(referenceMatch(a, b));
        }
      }
    }
  });

  it.each([
    ["abcdefghij", "abcdefghiZ", true],
    ["abcdefghi", "abcdefghZ", false],
    ["", "", true],
    ["", "abc", false],
    ["Résumé: CAFÉ!", "résumé café", true],
    ["alpha beta gamma delta epsilon", "epsilon delta gamma beta alpha", true],
    ["short", "a much longer short value", true]
  ])("preserves matching for %j and %j", (left, right, matches) => {
    expect(Boolean(detectDuplicate({ title: "Candidate", value: left }, [makeMemory({ value: right })])))
      .toBe(matches);
  });

  it("returns the first live matching record", () => {
    const existing = [makeMemory({ id: "disabled", disabled: true }), makeMemory({ id: "first" }), makeMemory({ id: "second" })];
    expect(detectDuplicate({ title: "Candidate", value: existing[0].value }, existing)?.memory.id).toBe("first");
  });

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
