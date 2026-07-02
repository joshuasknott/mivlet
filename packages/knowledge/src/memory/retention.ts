/**
 * Staleness + retention pruning for memory.
 *
 * Pure: takes a snapshot of memory + a policy + a clock, returns which ids to
 * prune and why. NEVER prunes pinned or approved memories. The caller applies
 * the result (e.g. forget the pruned ids) — this function does not mutate.
 */

import type { MemoryRecord, MemoryRetentionResult } from "@fable/protocol";
import { isLiveMemory } from "../store";
import { isNearIdenticalNormalized, normalizeMemoryValue } from "./duplicate";

export interface MemoryRetentionPolicy {
  /** Max age in days for non-pinned, low-confidence memories before they're stale. */
  staleAfterDays: number;
  /** Confidence below which a stale, non-pinned, non-approved memory is pruned. */
  pruneBelowConfidence: number;
}

export const DEFAULT_RETENTION_POLICY: MemoryRetentionPolicy = {
  staleAfterDays: 90,
  pruneBelowConfidence: 0.6
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isStale(record: MemoryRecord, now: string, staleAfterDays: number): boolean {
  if (!record.createdAt) return false;
  const created = Date.parse(record.createdAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(created) || Number.isNaN(nowMs)) return false;
  return nowMs - created > staleAfterDays * MS_PER_DAY;
}

/**
 * Apply the retention policy. A memory is PRUNED only when it is ALL of:
 * stale, low-confidence (< pruneBelowConfidence), not pinned, and not approved.
 * A superseded memory (a newer duplicate exists) is reported with reason
 * "superseded" but is only pruned if it also meets the stale/low-confidence
 * gates. Approved/pinned memories never appear in the result. `stale` flags
 * age without pruning.
 */
export function applyRetention(
  memory: MemoryRecord[],
  policy: MemoryRetentionPolicy,
  now: string
): MemoryRetentionResult {
  const prunedIds: string[] = [];
  const reasons: Record<string, "stale" | "superseded" | "low-confidence"> = {};

  // Hoist the live filter once and sort newest-first. Each live record's value
  // is normalized once into a parallel map so the duplicate scan does not
  // re-normalize on every pairwise check (the original code normalized inside
  // isNearIdentical per comparison). Matching math is unchanged.
  const live = memory.filter(isLiveMemory);
  const byRecencyDesc = [...live].sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });
  const normalizedValue = new Map<string, ReturnType<typeof normalizeMemoryValue>>();
  for (const record of live) {
    normalizedValue.set(record.id, normalizeMemoryValue(record.value));
  }

  for (const record of memory) {
    if (!isLiveMemory(record)) continue;
    if (record.pinned) continue;
    if (record.approvalState === "approved" || record.approved) continue;

    const stale = isStale(record, now, policy.staleAfterDays);
    const lowConf = (record.confidence ?? 1) < policy.pruneBelowConfidence;

    // A record is superseded when any NEWER live memory is near-identical.
    // byRecencyDesc is newest-first, so the first qualifying entry is the
    // newest duplicate — same result as the original `byRecencyDesc.find`.
    const candidateNorm = normalizedValue.get(record.id)!;
    let supersededBy: MemoryRecord | undefined;
    for (const other of byRecencyDesc) {
      if (other.id === record.id) continue;
      if ((other.createdAt ?? "") <= (record.createdAt ?? "")) continue;
      if (isNearIdenticalNormalized(candidateNorm, normalizedValue.get(other.id)!)) {
        supersededBy = other;
        break;
      }
    }

    if (supersededBy) {
      reasons[record.id] = "superseded";
    } else if (stale && lowConf) {
      prunedIds.push(record.id);
      reasons[record.id] = "low-confidence";
    } else if (stale) {
      reasons[record.id] = "stale";
    }
  }

  return { prunedIds, reasons };
}
