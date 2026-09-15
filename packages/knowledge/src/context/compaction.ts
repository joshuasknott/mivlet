/**
 * Incremental, durable conversation summary compaction.
 *
 * Compaction never deletes or rewrites raw transcript records. Each fold takes
 * the previous summary revision plus only the newly elided messages, produces a
 * new bounded revision, and carries provenance (raw message/revision ids) so the
 * derived summary stays inspectable. Invalidation is conservative: a summary
 * that incorporated a corrected or forgotten memory record is marked stale and
 * excluded from context rather than silently rebuilt from the old fact.
 *
 * Summaries here are deterministic local extracts. No provider is called and no
 * credential or transcript ever leaves the native/account boundary through this
 * module.
 */

import type {
  ContextSummaryRecord,
  ContextSummaryStaleReason,
  KnowledgeScope
} from "@mivlet/protocol";
import type { HistoryEntry } from "./history";

export const MAX_SUMMARY_CHARACTERS = 12_000;
const MAX_SOURCE_REFS = 512;
const MAX_LINE_CHARACTERS = 280;
const MAX_USER_LINES = 24;
const MAX_CORRECTION_LINES = 12;
const MAX_ASSISTANT_LINES = 12;
const SECTION_SEPARATOR = "\n";

export interface FoldHistorySummaryInput {
  threadId: string;
  scope?: KnowledgeScope;
  /** Previous revision for this conversation, when one exists. */
  previous?: ContextSummaryRecord;
  /** Newly elided entries; entries already covered by `previous` are ignored. */
  entries: readonly HistoryEntry[];
  derivedMemoryIds?: readonly string[];
  derivedMemoryRevisions?: Readonly<Record<string, string>>;
  now?: string;
  maxCharacters?: number;
}

export interface InvalidationResult {
  summaries: ContextSummaryRecord[];
  invalidatedIds: string[];
}

/** A live summary that may enter context and be folded into a new revision. */
export function isUsableSummary(record: ContextSummaryRecord): boolean {
  return !record.staleAt && record.text.trim().length > 0;
}

/** Live summaries for one conversation, newest coverage first. */
export function summariesForThread(
  summaries: readonly ContextSummaryRecord[],
  threadId: string
): ContextSummaryRecord[] {
  return summaries
    .filter((summary) => summary.threadId === threadId && isUsableSummary(summary))
    .sort(
      (left, right) =>
        right.throughSequence - left.throughSequence || right.revision - left.revision
    );
}

/**
 * Invalidate every live summary derived from a changed memory record. Returns
 * new records for changed summaries only; transcript and raw history are
 * untouched, so the user can keep working without the removed fact.
 */
export function invalidateSummariesForMemory(
  summaries: readonly ContextSummaryRecord[],
  memoryId: string,
  reason: ContextSummaryStaleReason = "memory-changed",
  now = new Date().toISOString()
): InvalidationResult {
  const invalidatedIds: string[] = [];
  const next = summaries.map((summary) => {
    if (summary.staleAt || !summary.derivedMemoryIds.includes(memoryId)) {
      return summary;
    }
    invalidatedIds.push(summary.id);
    return {
      ...summary,
      staleAt: now,
      staleReason: reason,
      updatedAt: now
    };
  });
  return { summaries: next, invalidatedIds };
}

interface Highlight {
  text: string;
  sequence: number;
}

interface ExtractedHighlights {
  decisions: Highlight[];
  corrections: Highlight[];
  preferences: Highlight[];
  commitments: Highlight[];
  conclusions: Highlight[];
  outcomes: Map<string, number>;
  lastSequence: number;
}

const CORRECTION_PATTERN =
  /\b(actually|correction|correct that|not anymore|no longer|instead|revert|changed my mind|that'?s wrong|scratch that|update:)\b/iu;
const DECISION_PATTERN =
  /\b(decided|decision|we'?ll|we will|let'?s|final|approved|choose|chosen|switch to|settled on)\b/iu;
const PREFERENCE_PATTERN =
  /\b(prefer|always|never|do not|don'?t|keep it|from now on|make sure|must|should)\b/iu;

function clipLine(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, " ");
  if (normalized.length <= MAX_LINE_CHARACTERS) return normalized;
  return `${normalized.slice(0, MAX_LINE_CHARACTERS - 1).trimEnd()}…`;
}

function boundedPush(lines: Highlight[], candidate: Highlight, cap: number): void {
  if (!candidate.text) return;
  if (lines.some((line) => line.text === candidate.text)) return;
  lines.push(candidate);
  if (lines.length > cap) lines.splice(0, lines.length - cap);
}

function extractHighlights(entries: readonly HistoryEntry[]): ExtractedHighlights {
  const extracted: ExtractedHighlights = {
    decisions: [],
    corrections: [],
    preferences: [],
    commitments: [],
    conclusions: [],
    outcomes: new Map(),
    lastSequence: 0
  };
  for (const entry of entries) {
    extracted.lastSequence = Math.max(extracted.lastSequence, entry.sequence);
    const role = entry.message.role;
    const text = clipLine(entry.message.content);
    if (!text) continue;
    const highlight: Highlight = { text, sequence: entry.sequence };
    if (role === "user") {
      if (CORRECTION_PATTERN.test(text)) {
        boundedPush(extracted.corrections, highlight, MAX_CORRECTION_LINES);
      } else if (DECISION_PATTERN.test(text)) {
        boundedPush(extracted.decisions, highlight, MAX_USER_LINES);
      } else if (PREFERENCE_PATTERN.test(text)) {
        boundedPush(extracted.preferences, highlight, MAX_USER_LINES);
      } else {
        boundedPush(extracted.commitments, highlight, MAX_USER_LINES);
      }
    } else if (role === "assistant") {
      boundedPush(extracted.conclusions, highlight, MAX_ASSISTANT_LINES);
    } else if (role === "tool") {
      const outcome = entry.outcome === "failed" ? "failed" : "succeeded";
      extracted.outcomes.set(outcome, (extracted.outcomes.get(outcome) ?? 0) + 1);
    }
  }
  return extracted;
}

function renderHighlights(extracted: ExtractedHighlights): string {
  const sections: string[] = [];
  const render = (label: string, lines: Highlight[]) => {
    if (!lines.length) return;
    sections.push(
      `${label}:\n${lines.map((line) => `- ${line.text}`).join(SECTION_SEPARATOR)}`
    );
  };
  render("Decisions", extracted.decisions);
  render("Corrections", extracted.corrections);
  render("Preferences", extracted.preferences);
  render("User commitments", extracted.commitments);
  render("Agent conclusions", extracted.conclusions);
  if (extracted.outcomes.size) {
    const summary = [...extracted.outcomes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([outcome, count]) => `${outcome} ${count}`)
      .join(", ");
    sections.push(`Tool outcomes: ${summary}`);
  }
  return sections.join(SECTION_SEPARATOR);
}

function clipSummaryText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  const note = " […earlier summary trimmed; raw history retained]";
  const room = Math.max(0, maxCharacters - note.length);
  return `${text.slice(0, room).trimEnd()}${note}`;
}

function stableId(threadId: string, fromSequence: number, throughSequence: number): string {
  const slug = threadId.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 48) || "thread";
  return `summary-${slug}-${fromSequence}-${throughSequence}`;
}

/**
 * Fold newly elided entries into a new bounded summary revision. Returns null
 * only when there is neither a previous revision nor new material. Never throws
 * for ordinary input: unavailable or stale input is rejected by the caller.
 */
export function foldHistorySummary(
  input: FoldHistorySummaryInput
): ContextSummaryRecord | null {
  const previous = input.previous;
  const throughPrevious = previous?.throughSequence ?? 0;
  const fresh = input.entries.filter((entry) => entry.sequence > throughPrevious);
  if (fresh.length === 0) return null;
  const now = input.now ?? new Date().toISOString();
  const maxCharacters = input.maxCharacters ?? MAX_SUMMARY_CHARACTERS;
  const extracted = extractHighlights(fresh);
  const freshText = renderHighlights(extracted);
  let text = freshText;
  if (previous?.text) {
    const room = maxCharacters - freshText.length - SECTION_SEPARATOR.length;
    if (room > 0) {
      text = `${freshText}${SECTION_SEPARATOR}${previous.text.slice(0, room).trimEnd()}`;
    }
  }
  text = clipSummaryText(text, maxCharacters);
  const firstSequence = previous?.fromSequence ?? fresh[0].sequence;
  const freshThrough = fresh.reduce(
    (max, entry) => Math.max(max, entry.sequence),
    0
  );
  const throughSequence = Math.max(
    previous?.throughSequence ?? 0,
    extracted.lastSequence,
    freshThrough
  );
  const sourceMessageIds = dedupe([
    ...(previous?.sourceMessageIds ?? []),
    ...fresh.map((entry) => entry.messageId ?? `sequence-${entry.sequence}`)
  ]).slice(-MAX_SOURCE_REFS);
  const sourceRevisionIds = dedupe([
    ...(previous?.sourceRevisionIds ?? []),
    ...fresh.map((entry) => entry.revisionId ?? `sequence-${entry.sequence}`)
  ]).slice(-MAX_SOURCE_REFS);
  const derivedMemoryIds = dedupe([
    ...(previous?.derivedMemoryIds ?? []),
    ...(input.derivedMemoryIds ?? [])
  ]);
  const derivedMemoryRevisions = dedupeRecord({
    ...(previous?.derivedMemoryRevisions ?? {}),
    ...(input.derivedMemoryRevisions ?? {})
  });
  return {
    id: previous?.id ?? stableId(input.threadId, firstSequence, throughSequence),
    threadId: input.threadId,
    scope: input.scope ?? { level: "thread", threadId: input.threadId },
    fromSequence: firstSequence,
    throughSequence,
    revision: (previous?.revision ?? 0) + 1,
    text,
    sourceMessageIds,
    sourceRevisionIds,
    derivedMemoryIds,
    derivedMemoryRevisions,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function dedupeRecord(
  value: Readonly<Record<string, string>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => Boolean(item))
  );
}
