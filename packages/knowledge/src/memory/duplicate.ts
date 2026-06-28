/**
 * Duplicate + contradiction detection for candidate memories.
 *
 * Heuristic, surface-only: these never auto-resolve. They flag relationships so
 * the UI can show them and so the retention pass can detect supersession. Only
 * LIVE existing memories are considered (forgotten/disabled are excluded).
 */

import type { MemoryRecord } from "@fable/protocol";
import { isLiveMemory } from "../store";

interface Candidate {
  title: string;
  value: string;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(normalize(text).split(" ").filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function levenshteinRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

function isNearIdentical(candidate: Candidate, existing: MemoryRecord): boolean {
  const cv = normalize(candidate.value);
  const ev = normalize(existing.value);
  if (cv.length > 0 && cv === ev) return true;
  if (cv.length > 0 && ev.length > 0 && (cv.includes(ev) || ev.includes(cv))) return true;
  if (jaccard(tokens(candidate.value), tokens(existing.value)) >= 0.8) return true;
  if (cv.length > 0 && ev.length > 0 && levenshteinRatio(cv, ev) >= 0.9) return true;
  return false;
}

const NEGATORS = [
  "not", "no", "never", "dislikes", "dislike", "avoids", "avoid",
  "doesn't", "don't", "isn't", "aren't", "wasn't", "weren't", "without", "hates", "hate"
];

function hasNegator(text: string): boolean {
  const words = normalize(text).split(" ");
  for (const word of words) {
    if (NEGATORS.includes(word)) return true;
    if (word.endsWith("n't")) return true;
  }
  return false;
}

/**
 * Returns the matched LIVE memory if the candidate duplicates it, else null.
 * Duplicate = near-identical value (exact / substring / Jaccard >= 0.8 /
 * Levenshtein ratio >= 0.9).
 */
export function detectDuplicate(
  candidate: Candidate,
  existing: MemoryRecord[]
): { memory: MemoryRecord } | null {
  const live = existing.filter(isLiveMemory);
  for (const memory of live) {
    if (isNearIdentical(candidate, memory)) {
      return { memory };
    }
  }
  return null;
}

/**
 * Returns the matched LIVE memory + reason if the candidate contradicts it,
 * else null. Heuristic: same subject (shared significant title tokens) AND a
 * negation/opposition asymmetry on the value. SURFACES for the user; never
 * auto-resolves.
 */
export function detectContradiction(
  candidate: Candidate,
  existing: MemoryRecord[]
): { memory: MemoryRecord; reason: string } | null {
  const live = existing.filter(isLiveMemory);
  const candidateTitleTokens = significantTokens(candidate.title);

  for (const memory of live) {
    const existingTitleTokens = significantTokens(memory.title);
    if (!shareSubject(candidateTitleTokens, existingTitleTokens)) continue;

    const candidateNeg = hasNegator(candidate.value);
    const existingNeg = hasNegator(memory.value);

    if (candidateNeg !== existingNeg) {
      return {
        memory,
        reason: `Candidate "${candidate.title}" ${candidateNeg ? "negates" : "affirms"} what "${memory.title}" ${existingNeg ? "negates" : "affirms"}.`
      };
    }

    const contradiction = preferenceContradiction(candidate.value, memory.value);
    if (contradiction) {
      return {
        memory,
        reason: `Candidate "${candidate.title}" conflicts with "${memory.title}": ${contradiction}.`
      };
    }
  }
  return null;
}

const STOP = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "of", "to", "in", "on", "for", "with", "and", "or", "but", "user",
  "prefers", "prefer", "likes", "like", "dislikes", "dislike"
]);

function significantTokens(title: string): Set<string> {
  return new Set(
    normalize(title)
      .split(" ")
      .filter((word) => word.length > 1 && !STOP.has(word))
  );
}

function shareSubject(a: Set<string>, b: Set<string>): boolean {
  for (const token of a) if (b.has(token)) return true;
  return false;
}

interface Preference {
  sentiment: "like" | "dislike";
  object: string;
}

function extractPreference(text: string): Preference | null {
  const likeMatch = text.match(/\b(?:prefer(?:s)?|like(?:s)?|love(?:s)?)\s+(.+?)(?:\.|$)/i);
  if (likeMatch) {
    return { sentiment: "like", object: likeMatch[1].trim() };
  }
  const dislikeMatch = text.match(/\b(?:dislike(?:s)?|hate(?:s)?|avoid(?:s)?)\s+(.+?)(?:\.|$)/i);
  if (dislikeMatch) {
    return { sentiment: "dislike", object: dislikeMatch[1].trim() };
  }
  return null;
}

function preferenceContradiction(a: string, b: string): string {
  const prefA = extractPreference(normalize(a));
  const prefB = extractPreference(normalize(b));
  if (!prefA || !prefB) return "";
  if (prefA.object !== prefB.object) return "";
  if (prefA.sentiment !== prefB.sentiment) {
    return `opposite sentiment toward "${prefA.object}"`;
  }
  return "";
}
