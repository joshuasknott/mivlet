import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "@fable/protocol";
import { applyRetention, DEFAULT_RETENTION_POLICY } from "./retention";

const NOW = "2026-06-28T12:00:00.000Z";
const OLD = "2025-01-01T00:00:00.000Z";

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1",
    kind: "inference",
    title: "Maybe likes rain",
    value: "The user might like rain.",
    source: "chat",
    freshness: "Old",
    approved: false,
    pinned: false,
    confidence: 0.4,
    createdAt: OLD,
    ...overrides
  };
}

describe("applyRetention", () => {
  it("prunes stale + low-confidence + unpinned + non-approved memory", () => {
    const result = applyRetention([makeMemory({ id: "m-stale" })], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.prunedIds).toContain("m-stale");
    expect(result.reasons["m-stale"]).toBe("low-confidence");
  });

  it("does NOT prune a pinned memory even if stale + low-confidence", () => {
    const result = applyRetention(
      [makeMemory({ id: "m-pinned", pinned: true })],
      DEFAULT_RETENTION_POLICY,
      NOW
    );
    expect(result.prunedIds).not.toContain("m-pinned");
    expect(result.reasons["m-pinned"]).toBeUndefined();
  });

  it("does NOT prune an approved memory even if stale + low-confidence", () => {
    const result = applyRetention(
      [makeMemory({ id: "m-approved", approvalState: "approved", approved: true })],
      DEFAULT_RETENTION_POLICY,
      NOW
    );
    expect(result.prunedIds).not.toContain("m-approved");
    expect(result.reasons["m-approved"]).toBeUndefined();
  });

  it("flags stale-but-above-confidence-floor as stale, not pruned", () => {
    const result = applyRetention(
      [makeMemory({ id: "m-stale-ok", confidence: 0.9 })],
      DEFAULT_RETENTION_POLICY,
      NOW
    );
    expect(result.prunedIds).not.toContain("m-stale-ok");
    expect(result.reasons["m-stale-ok"]).toBe("stale");
  });

  it("flags superseded when a newer duplicate exists", () => {
    const old = makeMemory({ id: "m-old", value: "The user likes rain." });
    const newer = makeMemory({ id: "m-new", value: "The user likes rain.", createdAt: NOW });
    const result = applyRetention([old, newer], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.reasons["m-old"]).toBe("superseded");
  });

  it.each([[0, 1, 2], [2, 1, 0], [1, 2, 0]])(
    "finds a newer protected duplicate in input order %j without mutating memory",
    (...order) => {
      const records = [
        makeMemory({ id: "old" }),
        makeMemory({ id: "pinned", createdAt: NOW, pinned: true }),
        makeMemory({ id: "approved", createdAt: NOW, approvalState: "approved" })
      ];
      records.forEach(Object.freeze);
      const memory = order.map((index) => records[index]);
      const original = [...memory];
      Object.freeze(memory);

      expect(applyRetention(memory, DEFAULT_RETENTION_POLICY, NOW)).toEqual({
        prunedIds: [],
        reasons: { old: "superseded" }
      });
      expect(memory).toEqual(original);
    }
  );

  it("ignores older, same-time, disabled and forgotten duplicates", () => {
    const memory = [
      makeMemory({ id: "target", createdAt: NOW }),
      makeMemory({ id: "older", pinned: true }),
      makeMemory({ id: "same-time", createdAt: NOW, approved: true }),
      makeMemory({ id: "disabled", createdAt: "2026-06-29T12:00:00.000Z", disabled: true }),
      makeMemory({ id: "forgotten", createdAt: "2026-06-29T12:00:00.000Z", forgottenAt: NOW })
    ];

    expect(applyRetention(memory, DEFAULT_RETENTION_POLICY, NOW)).toEqual({
      prunedIds: [],
      reasons: {}
    });
  });
});
