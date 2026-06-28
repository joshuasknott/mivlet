/**
 * Memory suggestion: derive candidate facts/preferences WITHOUT writing.
 *
 * CRITICAL CONTRACT: `suggestMemories` is pure. It MUST NOT call the store,
 * touch any mutable argument, or persist anything. It returns suggestion
 * objects only — the caller (UI) decides whether to `approveSuggestion` any of
 * them, and only that approval writes a durable `MemoryRecord`. The system
 * never silently creates memory.
 */

import type {
  Artifact,
  KnowledgeSource,
  MemoryKind,
  MemoryProvenance,
  MemoryRecord,
  MemorySuggestion
} from "@fable/protocol";
import { detectContradiction, detectDuplicate } from "./duplicate";

export interface MemorySuggestionContext {
  recentMessages?: { role: string; content: string }[];
  artifacts?: Artifact[];
  sources?: KnowledgeSource[];
  existingMemory: MemoryRecord[];
  /** ISO timestamp; reserved for future freshness tagging. */
  now?: string;
}

interface RawCandidate {
  title: string;
  value: string;
  kind: MemoryKind;
  provenance: MemoryProvenance;
  confidence: number;
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

const PREFERENCE_PATTERNS: RegExp[] = [
  /\bi\s+(?:prefer|like|love|use|always use|tend to use)\s+(.+?)(?:\.|$)/i,
  /\bmy\s+(?:preferred|favorite|default)\s+(\w[\w\s-]+?)(?:\.|$)/i,
  /\bi\s+(?:always|never|usually)\s+(.+?)(?:\.|$)/i
];
const DISLIKE_PATTERNS: RegExp[] = [
  /\bi\s+(?:dislike|hate|avoid|can't stand)\s+(.+?)(?:\.|$)/i
];
const FACT_PATTERNS: RegExp[] = [
  /\bmy\s+(?:project|app|repo|team|company|stack)\s+is\s+(.+?)(?:\.|$)/i,
  /\bi(?:'m| am)\s+(?:working|building|writing|migrating)\s+(?:on|to|from)?\s*(.+?)(?:\.|$)/i
];

function deriveFromMessage(content: string, origin: MemoryProvenance["origin"]): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  for (const pattern of PREFERENCE_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      const target = match[1].trim();
      candidates.push({
        title: `Prefers ${target}`,
        value: `The user prefers ${target}.`,
        kind: "preference",
        provenance: { origin, note: "Inferred from chat message." },
        confidence: 0.7
      });
    }
  }
  // Dislike patterns are derived separately so the contradiction detector can
  // surface "prefers X" vs "dislikes X" for the same X. The candidate carries
  // the disliked object in both title and value so subject-matching fires.
  for (const pattern of DISLIKE_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      const target = match[1].trim();
      candidates.push({
        title: `Dislikes ${target}`,
        value: `The user dislikes ${target}.`,
        kind: "preference",
        provenance: { origin, note: "Inferred from chat message." },
        confidence: 0.7
      });
    }
  }
  for (const pattern of FACT_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      const target = match[1].trim();
      candidates.push({
        title: `Project context: ${target}`,
        value: `The user's current context is ${target}.`,
        kind: "fact",
        provenance: { origin, note: "Inferred from chat message." },
        confidence: 0.65
      });
    }
  }
  return candidates;
}

function deriveFromArtifacts(artifacts: Artifact[]): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  for (const artifact of artifacts) {
    if (artifact.pinned) {
      candidates.push({
        title: `Pinned artifact: ${artifact.title}`,
        value: `The user pinned "${artifact.title}" as worth keeping.`,
        kind: "fact",
        provenance: {
          origin: "artifact",
          artifactId: artifact.id,
          runId: artifact.provenance.runId,
          note: "Pinned artifact surfaced as a memory candidate."
        },
        confidence: 0.6
      });
    }
  }
  return candidates;
}

function deriveFromSources(sources: KnowledgeSource[]): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  for (const source of sources) {
    if (source.pinned) {
      candidates.push({
        title: `Pinned source: ${source.title}`,
        value: `The user pinned "${source.title}" as trusted context.`,
        kind: "imported",
        provenance: {
          origin: "source",
          sourceId: source.id,
          note: "Pinned source surfaced as a memory candidate."
        },
        confidence: 0.55
      });
    }
  }
  return candidates;
}

/**
 * Derive memory suggestions from chat messages, artifacts, and sources. NEVER
 * writes: this is a pure function over its inputs. Each candidate is checked
 * against existing memory for duplicates / contradictions and tagged with the
 * matched ids so the UI can show the relationship.
 */
export function suggestMemories(ctx: MemorySuggestionContext): MemorySuggestion[] {
  // --- PURE READ ONLY -----------------------------------------------------
  // This function MUST NOT call any store, mutate any argument, or persist.
  // It returns MemorySuggestion objects for the caller to surface/approve.
  // ------------------------------------------------------------------------

  const raw: RawCandidate[] = [];
  for (const message of ctx.recentMessages ?? []) {
    if (message.role === "user") {
      raw.push(...deriveFromMessage(message.content, "chat"));
    }
  }
  raw.push(...deriveFromArtifacts(ctx.artifacts ?? []));
  raw.push(...deriveFromSources(ctx.sources ?? []));

  // De-dupe raw candidates against each other so the same preference isn't
  // emitted twice from the same message.
  const seen = new Set<string>();
  const unique: RawCandidate[] = [];
  for (const candidate of raw) {
    const key = candidate.value.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  return unique.map((candidate, index) => {
    const dup = detectDuplicate(candidate, ctx.existingMemory);
    const contra = detectContradiction(candidate, ctx.existingMemory);
    const suggestion: MemorySuggestion = {
      id: `sug-${slugify(candidate.title)}-${index + 1}`,
      title: candidate.title,
      value: candidate.value,
      kind: candidate.kind,
      provenance: candidate.provenance,
      confidence: candidate.confidence
    };
    if (dup) suggestion.duplicateOfId = dup.memory.id;
    if (contra) suggestion.contradictsId = contra.memory.id;
    return suggestion;
  });
}
