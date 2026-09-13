/**
 * Deliberate promotion interfaces for Side Chats and completed Work.
 *
 * These are the baseline seams P3/P4/P5 call from an explicit user action. They
 * never run automatically, never read a whole execution history, and never
 * promote sibling or private conversations. Each promotion selects a bounded
 * set of useful outcomes, records exact scope/provenance, and returns approved
 * records that the existing native `save_memory_state` path persists (the
 * native boundary still canonicalizes authority and owner).
 */

import type { KnowledgeScope, MemoryKind, MemoryProvenance, MemoryRecord } from "@fable/protocol";

export const MAX_PROMOTED_RECORDS = 6;
export const MAX_PROMOTED_TITLE_CHARACTERS = 120;
export const MAX_PROMOTED_VALUE_CHARACTERS = 2_000;
const MAX_SOURCE_MESSAGES = 8;
const OUTCOME_EXCERPT_CHARACTERS = 600;

export interface OutcomeSourceMessage {
  messageId: string;
  revisionId?: string;
  role: "user" | "assistant";
  sequence: number;
  text: string;
}

export interface PromotionOwners {
  threadId: string;
  agentId?: string;
  projectId?: string;
  workId?: string;
}

export interface SideChatPromotionInput extends PromotionOwners {
  /** Literal acknowledgement that a user explicitly chose to promote. */
  explicit: true;
  outcomes: readonly OutcomeSourceMessage[];
  /** Memory kill switch; promotion fails closed while memory is disabled. */
  memoryDisabled?: boolean;
  scope?: KnowledgeScope;
  now?: string;
}

export interface CompletedWorkPromotionInput extends PromotionOwners {
  explicit: true;
  /** Original bounded work request, not the execution history. */
  request: string;
  /** Public terminal results only; raw tool payloads are not accepted. */
  results: readonly OutcomeSourceMessage[];
  reason?: string;
  memoryDisabled?: boolean;
  scope?: KnowledgeScope;
  now?: string;
}

interface OutcomeCandidate {
  kind: MemoryKind;
  text: string;
  messageId: string;
  sequence: number;
}

const DECISION_PATTERN =
  /\b(decided|decision|we'?ll|we will|let'?s|final|approved|chosen|settled on)\b/iu;
const CORRECTION_PATTERN =
  /\b(actually|correction|not anymore|no longer|instead|revert|changed my mind|that'?s wrong|scratch that)\b/iu;
const PREFERENCE_PATTERN =
  /\b(prefer|always|never|do not|don'?t|keep it|from now on|make sure|must|should)\b/iu;

function clip(value: string, maxCharacters: number): string {
  const text = value.trim().replace(/\s+/gu, " ");
  if (text.length <= maxCharacters) return text;
  return `${text.slice(0, maxCharacters - 1).trimEnd()}…`;
}

function kindFor(text: string): MemoryKind {
  if (CORRECTION_PATTERN.test(text)) return "correction";
  if (DECISION_PATTERN.test(text)) return "decision";
  if (PREFERENCE_PATTERN.test(text)) return "preference";
  return "fact";
}

function selectOutcomes(
  messages: readonly OutcomeSourceMessage[]
): OutcomeCandidate[] {
  const candidates: OutcomeCandidate[] = [];
  for (const message of messages) {
    const text = message.text.trim();
    if (!text) continue;
    const excerpt = clip(text, OUTCOME_EXCERPT_CHARACTERS);
    candidates.push({
      kind: kindFor(excerpt),
      text: excerpt,
      messageId: message.messageId,
      sequence: message.sequence
    });
  }
  // Prefer stated decisions/corrections/preferences over open-ended chatter,
  // then keep the newest bounded set. Never promote the entire history.
  const priority: Record<MemoryKind, number> = {
    correction: 0,
    decision: 1,
    preference: 2,
    fact: 3,
    inference: 4,
    imported: 5
  };
  return candidates
    .sort(
      (left, right) =>
        priority[left.kind] - priority[right.kind] ||
        right.sequence - left.sequence
    )
    .slice(0, MAX_SOURCE_MESSAGES)
    .sort((left, right) => left.sequence - right.sequence);
}

function assertMemoryEnabled(memoryDisabled: boolean | undefined): void {
  if (memoryDisabled) {
    throw new Error("Memory is disabled. Enable memory before promoting an outcome.");
  }
}

function assertExplicit(explicit: boolean): void {
  if (explicit !== true) {
    throw new Error("Promotion requires an explicit user action.");
  }
}

/**
 * Resolve the promotion scope. Narrow scopes always require their exact owner
 * ID and can never silently widen to global; global is only used when the
 * caller explicitly passes it.
 */
export function resolvePromotionScope(
  requested: KnowledgeScope | undefined,
  owners: PromotionOwners
): KnowledgeScope {
  if (requested?.level === "global") return { level: "global" };
  const level = requested?.level ?? "thread";
  if (level === "thread") {
    if (!owners.threadId.trim()) {
      throw new Error("Thread-scoped promotion needs its owning conversation id.");
    }
    return { level: "thread", threadId: owners.threadId };
  }
  if (level === "agent") {
    if (!owners.agentId?.trim()) {
      throw new Error("Agent-scoped promotion needs its owning agent id.");
    }
    return { level: "agent", agentId: owners.agentId };
  }
  if (level === "project") {
    if (!owners.projectId?.trim()) {
      throw new Error("Project-scoped promotion needs its owning project id.");
    }
    return { level: "project", projectId: owners.projectId };
  }
  if (level === "work") {
    if (!owners.workId?.trim()) {
      throw new Error("Work-scoped promotion needs its owning work id.");
    }
    return { level: "work", workId: owners.workId };
  }
  throw new Error("Promotion scope is not recognized.");
}

function buildRecord(
  candidate: OutcomeCandidate,
  scope: KnowledgeScope,
  provenance: MemoryProvenance,
  now: string
): MemoryRecord {
  const title = clip(candidate.text, MAX_PROMOTED_TITLE_CHARACTERS);
  const value = clip(candidate.text, MAX_PROMOTED_VALUE_CHARACTERS);
  return {
    id: `mem-promoted-${candidate.messageId}`.replace(/[^A-Za-z0-9._:-]+/gu, "-").slice(0, 120),
    kind: candidate.kind,
    title,
    value,
    source: provenance.note,
    freshness: "Promoted by you",
    approved: true,
    pinned: false,
    scope,
    confidence: 1,
    provenance,
    approvalState: "approved",
    ...(provenance.runId ? { runId: provenance.runId } : {}),
    createdAt: now,
    updatedAt: now
  };
}

/** Promote bounded, user-selected outcomes from one Agent/Project Side Chat. */
export function promoteSideChatOutcome(
  input: SideChatPromotionInput
): MemoryRecord[] {
  assertExplicit(input.explicit);
  assertMemoryEnabled(input.memoryDisabled);
  const scope = resolvePromotionScope(input.scope, input);
  const now = input.now ?? new Date().toISOString();
  const provenance: MemoryProvenance = {
    origin: "chat",
    note: `Promoted from Side Chat ${input.threadId}`
  };
  return selectOutcomes(input.outcomes)
    .slice(0, MAX_PROMOTED_RECORDS)
    .map((candidate) => buildRecord(candidate, scope, provenance, now));
}

/**
 * Promote only the useful terminal outcomes of completed Work: the bounded
 * request, public results and reconciliation reason. The full run history,
 * tool payloads and attempts are never accepted or stored here.
 */
export function promoteCompletedWorkOutcome(
  input: CompletedWorkPromotionInput
): MemoryRecord[] {
  assertExplicit(input.explicit);
  assertMemoryEnabled(input.memoryDisabled);
  const workId = (input.workId ?? "").trim();
  if (!workId) {
    throw new Error("Completed Work promotion needs its owning work id.");
  }
  const scope = resolvePromotionScope(
    input.scope ?? { level: "work", workId },
    input
  );
  const now = input.now ?? new Date().toISOString();
  const provenance: MemoryProvenance = {
    origin: "run",
    note: `Promoted from completed Work ${workId}${input.reason ? ` (${clip(input.reason, 160)})` : ""}`,
    runId: workId
  };
  const request = clip(input.request, OUTCOME_EXCERPT_CHARACTERS);
  const candidates = selectOutcomes(input.results);
  if (request && !candidates.some((candidate) => candidate.text === request)) {
    candidates.unshift({
      kind: kindFor(request),
      text: request,
      messageId: `work-${workId}-request`,
      sequence: 0
    });
  }
  return candidates
    .slice(0, MAX_PROMOTED_RECORDS)
    .map((candidate) => buildRecord(candidate, scope, provenance, now));
}
