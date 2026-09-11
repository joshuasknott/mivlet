import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "@fable/protocol";
import { applyRetention, DEFAULT_RETENTION_POLICY } from "./retention";

const NOW = "2026-06-28T12:00:00.000Z";
const OLD = "2025-01-01T00:00:00.000Z";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STALE_AFTER_MS = DEFAULT_RETENTION_POLICY.staleAfterDays * MS_PER_DAY;

/** createdAt exactly `days` before NOW (or a custom `from`). */
function daysBefore(days: number, from: string = NOW): string {
  return new Date(Date.parse(from) - days * MS_PER_DAY).toISOString();
}

/** createdAt just past the 90-day boundary: 90 days minus 1 ms before NOW. */
function justPastBoundary(from: string = NOW): string {
  return new Date(Date.parse(from) - STALE_AFTER_MS - 1).toISOString();
}

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

  it("prunes a superseded memory that also meets the stale + low-confidence gates", () => {
    const old = makeMemory({ id: "m-old", value: "The user likes rain." });
    const newer = makeMemory({ id: "m-new", value: "The user likes rain.", createdAt: NOW });
    const result = applyRetention([old, newer], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.prunedIds).toContain("m-old");
    expect(result.reasons["m-old"]).toBe("superseded");
    expect(result.prunedIds).not.toContain("m-new");
  });

  it("does NOT prune a superseded memory that is still fresh", () => {
    const old = makeMemory({
      id: "m-old",
      value: "The user likes rain.",
      createdAt: daysBefore(10)
    });
    const newer = makeMemory({ id: "m-new", value: "The user likes rain.", createdAt: NOW });
    const result = applyRetention([old, newer], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.reasons["m-old"]).toBe("superseded");
    expect(result.prunedIds).not.toContain("m-old");
  });

  it("does NOT prune a superseded memory above the confidence floor even when stale", () => {
    const old = makeMemory({
      id: "m-old",
      value: "The user likes rain.",
      confidence: 0.9
    });
    const newer = makeMemory({ id: "m-new", value: "The user likes rain.", createdAt: NOW });
    const result = applyRetention([old, newer], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.reasons["m-old"]).toBe("superseded");
    expect(result.prunedIds).not.toContain("m-old");
  });

  it("keeps a record exactly at the expiry boundary (90 days) retained", () => {
    const atBoundary = makeMemory({ id: "m-boundary", createdAt: daysBefore(90) });
    const result = applyRetention([atBoundary], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.prunedIds).not.toContain("m-boundary");
    expect(result.reasons["m-boundary"]).toBeUndefined();
  });

  it("prunes a record 1 ms past the expiry boundary", () => {
    const pastBoundary = makeMemory({ id: "m-past", createdAt: justPastBoundary() });
    const result = applyRetention([pastBoundary], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.prunedIds).toContain("m-past");
    expect(result.reasons["m-past"]).toBe("low-confidence");
  });

  it("keeps a record whose confidence is exactly at the pruning floor", () => {
    const atFloor = makeMemory({ id: "m-floor", confidence: 0.6 });
    const result = applyRetention([atFloor], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.prunedIds).not.toContain("m-floor");
    expect(result.reasons["m-floor"]).toBe("stale");
  });

  it("retains records with invalid createdAt without flagging them", () => {
    const invalid = makeMemory({ id: "m-invalid", createdAt: "2025-13-99T99:99:99.000Z" });
    const result = applyRetention([invalid], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.prunedIds).not.toContain("m-invalid");
    expect(result.reasons["m-invalid"]).toBeUndefined();
  });

  it("never lets an invalid-dated duplicate supersede a validly-dated record", () => {
    const valid = makeMemory({ id: "m-valid", value: "The user likes rain." });
    const garbage = makeMemory({
      id: "m-garbage",
      value: "The user likes rain.",
      createdAt: "2025-13-99T99:99:99.000Z"
    });
    const result = applyRetention([valid, garbage], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.reasons["m-valid"]).not.toBe("superseded");
    expect(result.prunedIds).toContain("m-valid");
    expect(result.reasons["m-valid"]).toBe("low-confidence");
  });

  it("detects supersession for a newer duplicate with a non-ISO date", () => {
    const old = makeMemory({ id: "m-old", value: "The user likes rain." });
    const newer = makeMemory({
      id: "m-new",
      value: "The user likes rain.",
      createdAt: "01/02/2026"
    });
    const result = applyRetention([old, newer], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.reasons["m-old"]).toBe("superseded");
    expect(result.prunedIds).toContain("m-old");
  });

  it("retains records with missing or empty createdAt", () => {
    const missing = makeMemory({ id: "m-missing", createdAt: undefined });
    const empty = makeMemory({ id: "m-empty", createdAt: "" });
    const result = applyRetention([missing, empty], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.prunedIds).toEqual([]);
    expect(result.reasons).toEqual({});
  });

  it("supersedes via a future-dated duplicate but never flags the future record itself", () => {
    const old = makeMemory({ id: "m-old", value: "The user likes rain." });
    const future = makeMemory({
      id: "m-future",
      value: "The user likes rain.",
      createdAt: "2027-01-01T00:00:00.000Z"
    });
    const result = applyRetention([old, future], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.reasons["m-old"]).toBe("superseded");
    expect(result.prunedIds).toContain("m-old");
    expect(result.reasons["m-future"]).toBeUndefined();
    expect(result.prunedIds).not.toContain("m-future");
  });

  it("prunes nothing when the clock is before every record (clock moved back)", () => {
    const recent = makeMemory({ id: "m-recent", createdAt: NOW });
    const result = applyRetention([recent], DEFAULT_RETENTION_POLICY, "2026-01-01T00:00:00.000Z");
    expect(result.prunedIds).toEqual([]);
    expect(result.reasons).toEqual({});
  });

  it("prunes nothing when the clock itself is invalid", () => {
    const result = applyRetention(
      [makeMemory({ id: "m-stale" })],
      DEFAULT_RETENTION_POLICY,
      "not-a-date"
    );
    expect(result.prunedIds).toEqual([]);
    expect(result.reasons).toEqual({});
  });

  it("excludes forgotten and disabled records entirely", () => {
    const forgotten = makeMemory({
      id: "m-forgotten",
      forgottenAt: "2026-01-01T00:00:00.000Z"
    });
    const disabled = makeMemory({ id: "m-disabled", disabled: true });
    const result = applyRetention([forgotten, disabled], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.prunedIds).toEqual([]);
    expect(result.reasons).toEqual({});
  });

  it("does not supersede across workspaces", () => {
    const local = makeMemory({
      id: "m-local",
      workspaceId: "ws-a",
      value: "The user likes rain."
    });
    const otherWorkspace = makeMemory({
      id: "m-other",
      workspaceId: "ws-b",
      value: "The user likes rain.",
      createdAt: NOW
    });
    const result = applyRetention([local, otherWorkspace], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.reasons["m-local"]).not.toBe("superseded");
    expect(result.reasons["m-local"]).toBe("low-confidence");
    expect(result.reasons["m-other"]).toBeUndefined();
  });

  it("still supersedes within the same workspace", () => {
    const old = makeMemory({ id: "m-old", workspaceId: "ws-a", value: "The user likes rain." });
    const newer = makeMemory({
      id: "m-new",
      workspaceId: "ws-a",
      value: "The user likes rain.",
      createdAt: NOW
    });
    const result = applyRetention([old, newer], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.reasons["m-old"]).toBe("superseded");
  });

  it("treats legacy records without a workspace as the same store context", () => {
    const old = makeMemory({ id: "m-old", value: "The user likes rain." });
    const newer = makeMemory({
      id: "m-new",
      workspaceId: "ws-a",
      value: "The user likes rain.",
      createdAt: NOW
    });
    const result = applyRetention([old, newer], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.reasons["m-old"]).toBe("superseded");
  });

  it("handles mixed scopes deterministically without exempting records", () => {
    const thread = makeMemory({
      id: "m-thread",
      scope: { level: "thread", threadId: "thread-1" }
    });
    const global = makeMemory({
      id: "m-global",
      scope: { level: "global" }
    });
    const result = applyRetention([thread, global], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.prunedIds).toEqual(["m-thread", "m-global"]);
    expect(result.reasons["m-thread"]).toBe("low-confidence");
    expect(result.reasons["m-global"]).toBe("low-confidence");
  });

  it("does not supersede records with identical timestamps (strictly newer required)", () => {
    const a = makeMemory({ id: "m-a", value: "The user likes rain.", createdAt: OLD });
    const b = makeMemory({ id: "m-b", value: "The user likes rain.", createdAt: OLD });
    const result = applyRetention([a, b], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.reasons["m-a"]).toBe("low-confidence");
    expect(result.reasons["m-b"]).toBe("low-confidence");
  });

  it("returns an empty result for an empty collection", () => {
    const result = applyRetention([], DEFAULT_RETENTION_POLICY, NOW);
    expect(result.prunedIds).toEqual([]);
    expect(result.reasons).toEqual({});
  });
});
