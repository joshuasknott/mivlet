/**
 * CRUD-style memory actions.
 *
 * Every action returns a NEW record (immutable update) — none mutate the input.
 * `forgetMemory` is the durable exclusion signal: the store's live read path
 * already filters on `forgottenAt`, so a forgotten memory disappears from every
 * retrieval / context / Knowledge-page path while staying auditable.
 */

import type { MemoryKind, MemoryRecord } from "@mivlet/protocol";
import { isLiveMemory } from "../store";

/** Edit a memory's editable fields. Bumps updatedAt. */
export function editMemory(
  record: MemoryRecord,
  patch: { title?: string; value?: string; kind?: MemoryKind },
  now: string
): MemoryRecord {
  return {
    ...record,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.value !== undefined ? { value: patch.value } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    updatedAt: now
  };
}

/** Pin a memory so it is always available within its scope. */
export function pinMemory(record: MemoryRecord): MemoryRecord {
  return { ...record, pinned: true };
}

/** Unpin a memory. */
export function unpinMemory(record: MemoryRecord): MemoryRecord {
  return { ...record, pinned: false };
}

/** Soft-disable a memory (excluded from the live read path). */
export function disableMemory(record: MemoryRecord, now: string): MemoryRecord {
  return { ...record, disabled: true, updatedAt: now };
}

/**
 * Forget a memory. This is THE durable exclusion signal — the store filters on
 * `forgottenAt`, so the memory vanishes from retrieval / context / the Knowledge
 * page while remaining auditable (preferred over hard delete).
 */
export function forgetMemory(record: MemoryRecord, now: string): MemoryRecord {
  return { ...record, forgottenAt: now, updatedAt: now };
}

/**
 * Plain-text export of LIVE memories only. Forgotten/disabled records are
 * excluded. Format is human-readable: title, value, provenance, timestamps.
 */
export function exportMemories(records: MemoryRecord[]): string {
  const lines: string[] = ["# Memory export", ""];
  const live = records.filter(isLiveMemory);
  if (live.length === 0) {
    lines.push("(no live memories)");
    return lines.join("\n");
  }
  for (const record of live) {
    lines.push(`## ${record.title}`);
    lines.push(record.value);
    const meta: string[] = [`kind: ${record.kind}`];
    if (record.provenance) {
      meta.push(`origin: ${record.provenance.origin}`);
      if (record.provenance.note) meta.push(`note: ${record.provenance.note}`);
    }
    meta.push(`confidence: ${record.confidence ?? 1}`);
    if (record.pinned) meta.push("pinned");
    if (record.approvalState) meta.push(`state: ${record.approvalState}`);
    if (record.createdAt) meta.push(`created: ${record.createdAt}`);
    if (record.updatedAt) meta.push(`updated: ${record.updatedAt}`);
    lines.push(`_(${meta.join(" | ")})_`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
