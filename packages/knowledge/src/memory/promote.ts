/**
 * Explicit promotion into durable memory.
 *
 * The system NEVER silently writes memory — it only suggests. Promotion is the
 * single path that produces an approved `MemoryRecord`. Whether it arrives via a
 * user-confirmed suggestion or a hand-authored entry, the result is the same:
 * `approved: true`, `approvalState: "approved"`, fresh provenance, and the
 * user as the ultimate authority. Pure and injectable (`now`) so tests can pin
 * timestamps and id suffixes without touching the clock.
 */

import type {
  KnowledgeScope,
  MemoryKind,
  MemoryProvenance,
  MemoryRecord,
  MemorySuggestion
} from "@mivlet/protocol";
import { GLOBAL_SCOPE } from "@mivlet/protocol";
import { redactKnowledgeText } from "../redact";

/** Input for explicit, user-initiated promotion. */
export interface PromoteMemoryInput {
  title: string;
  value: string;
  kind: MemoryKind;
  scope?: KnowledgeScope;
  provenance: MemoryProvenance;
  confidence?: number;
  runId?: string;
  /** ISO timestamp; injectable for deterministic tests. */
  now?: string;
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "memory"
  );
}

function randish(now: string): string {
  // Deterministic from `now` for stable ordering, plus a tiny random tail so
  // two same-instant promotions don't collide. Ids only need to be unique.
  const base = Date.parse(now).toString(36);
  const tail = Math.floor(Math.random() * 46656).toString(36);
  return `${base}-${tail}`;
}

/**
 * Promote an explicit, user-confirmed entry into an approved memory record.
 * This is one of only two paths (with `approveSuggestion`) that writes durable
 * memory. The returned record is `approved: true` / `approvalState: "approved"`.
 */
export function promoteToMemory(input: PromoteMemoryInput): MemoryRecord {
  const now = input.now ?? new Date().toISOString();
  const scope = input.scope ?? GLOBAL_SCOPE;
  const confidence = input.confidence ?? 1;
  const title = redactKnowledgeText(input.title);
  const value = redactKnowledgeText(input.value);
  const slug = slugify(title);
  const id = `mem-${slug}-${randish(now)}`;

  return {
    id,
    kind: input.kind,
    title,
    value,
    source: input.provenance.origin,
    freshness: "Just now",
    approved: true,
    pinned: false,
    scope,
    confidence,
    provenance: input.provenance,
    approvalState: "approved",
    runId: input.runId,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Promote a suggestion into an approved memory, carrying its provenance and
 * confidence. Any `duplicateOfId` / `contradictsId` flags the suggestion carried
 * are NOT propagated to the record — an explicit approval supersedes them.
 */
export function approveSuggestion(suggestion: MemorySuggestion, now?: string): MemoryRecord {
  const record = promoteToMemory({
    title: suggestion.title,
    value: suggestion.value,
    kind: suggestion.kind,
    provenance: suggestion.provenance,
    confidence: suggestion.confidence,
    now
  });
  if (suggestion.provenance.runId) {
    record.runId = suggestion.provenance.runId;
  }
  return record;
}
