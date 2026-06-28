/**
 * The retrieval pipeline: scope filter -> hybrid score -> budget -> citation.
 *
 * Hybrid = lexical (always) fused with semantic (when embeddings exist) via
 * reciprocal-rank fusion. When no embeddings are present the result is
 * lexical-only and the response reports `mode: "lexical-fallback"`. Ranking
 * layers relevance, recency, source authority, pinning, and explicit user
 * feedback — and the basis is never hidden: each citation carries its
 * `CitationRanking` components.
 *
 * Deleted / disabled / inaccessible / stale sources are filtered before
 * scoring (the store already excludes disabled; we additionally exclude stale/
 * error sources here). Bounded: the pipeline returns at most `limit` citations
 * within a character budget, with overlapping chunks from the same source
 * deduplicated so the budget isn't wasted on redundancy.
 */

import type {
  CitationRanking,
  CitationRanking as RankingType,
  KnowledgeCitation,
  KnowledgeScope,
  KnowledgeSource,
  KnowledgeSearchResponse,
  SourceChunk,
  SourceStatus
} from "@fable/protocol";
import { GLOBAL_SCOPE } from "@fable/protocol";
import { isLiveSource, scopeSatisfies } from "../store";
import { buildLexicalCorpus, scoreChunkLexical, tokenize } from "./lexical";
import { cosineSimilarity, hasEmbedding, type EmbeddingProvider } from "./semantic";

/** Sources/chunks that must never enter a run, regardless of score. */
const EXCLUDED_STATUSES: ReadonlySet<SourceStatus> = new Set(["error"]);

export interface RetrievalSource {
  source: KnowledgeSource;
  chunks: SourceChunk[];
}

export interface RetrievalFeedback {
  /** Per-source positive/negative feedback weight (user signals). */
  sourceWeights: Record<string, number>;
}

export interface RetrievalRankingWeights {
  relevance: number;
  recency: number;
  authority: number;
  pin: number;
  feedback: number;
}

export const DEFAULT_RANKING_WEIGHTS: RetrievalRankingWeights = {
  relevance: 1,
  recency: 0.15,
  authority: 0.2,
  pin: 0.25,
  feedback: 0.15
};

export interface RetrieveOptions {
  query: string;
  scope?: KnowledgeScope;
  /** Max number of citations. Default 8. */
  limit?: number;
  /** Character budget across all returned snippets. Default 6000. */
  budgetChars?: number;
  /** Snippet length per citation. Default 320. */
  snippetChars?: number;
  rankingWeights?: RetrievalRankingWeights;
  feedback?: RetrievalFeedback;
  /** Optional embedding provider. Omit/none -> lexical fallback. */
  embeddingProvider?: EmbeddingProvider;
  /** Optional query embedding, to avoid re-embedding across calls. */
  queryEmbedding?: number[];
}

/** Days recent content gets a recency boost for. */
const RECENCY_BOOST_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface ScoredChunk {
  source: KnowledgeSource;
  chunk: SourceChunk;
  lexicalScore: number;
  semanticScore: number;
  ranking: CitationRanking;
  fused: number;
}

/**
 * Filter sources to those live, in-scope, and not in an excluded status. This
 * is the chokepoint that prevents deleted/disabled/stale/inaccessible material
 * from entering retrieval. (Disabled is already filtered by the store's live
 * read path; we re-check defensively plus exclude error/stale-by-status.)
 */
export function filterRetrievable(
  sources: RetrievalSource[],
  scope: KnowledgeScope = GLOBAL_SCOPE
): RetrievalSource[] {
  return sources.filter(({ source }) => {
    if (!isLiveSource(source)) return false;
    if (source.status && EXCLUDED_STATUSES.has(source.status)) return false;
    const sourceScope = source.scope ?? GLOBAL_SCOPE;
    return scopeSatisfies(sourceScope, scope);
  });
}

function recencyBoost(source: KnowledgeSource, now: number): number {
  const importedAt = source.importedAt ? Date.parse(source.importedAt) : 0;
  if (!importedAt) return 0;
  const ageDays = (now - importedAt) / MS_PER_DAY;
  if (ageDays <= 0) return 1;
  if (ageDays >= RECENCY_BOOST_DAYS) return 0;
  return 1 - ageDays / RECENCY_BOOST_DAYS;
}

function feedbackWeight(source: KnowledgeSource, feedback?: RetrievalFeedback): number {
  if (!feedback) return 0;
  const weight = feedback.sourceWeights[source.id] ?? 0;
  // Clamp to [-1, 1].
  return Math.max(-1, Math.min(1, weight));
}

/**
 * Hybrid retrieval. Returns ranked, budgeted, deduplicated citations. When no
 * embedding provider (or no chunk embeddings) is available, the result is
 * lexical-only with `mode: "lexical-fallback"`. The embedding provider is
 * awaited but any failure is caught and routed to lexical fallback (never
 * thrown out of this function).
 */
export async function retrieve(
  sources: RetrievalSource[],
  options: RetrieveOptions
): Promise<KnowledgeSearchResponse> {
  const scope = options.scope ?? GLOBAL_SCOPE;
  const limit = options.limit ?? 8;
  const budgetChars = options.budgetChars ?? 6_000;
  const snippetChars = options.snippetChars ?? 320;
  const weights = options.rankingWeights ?? DEFAULT_RANKING_WEIGHTS;
  const query = options.query.trim();

  const retrievable = filterRetrievable(sources, scope);
  const queryTokens = tokenize(query);

  // Gather all chunks for corpus statistics (lexical IDF).
  const allChunks: SourceChunk[] = [];
  for (const { chunks } of retrievable) allChunks.push(...chunks);
  const corpus = buildLexicalCorpus(allChunks);

  // Determine whether semantic scoring is possible. If the provider is absent
  // OR no chunk has an embedding, fall back to lexical-only.
  const provider = options.embeddingProvider;
  const anyEmbedding = allChunks.some((chunk) => hasEmbedding(chunk.embedding));
  let queryEmbedding = options.queryEmbedding;
  let useSemantic = Boolean(provider) && anyEmbedding;
  if (useSemantic && provider && !queryEmbedding) {
    try {
      const [embedded] = await provider.embedTexts([query]);
      queryEmbedding = embedded;
    } catch {
      // Provider failed — fall back to lexical. Never throw.
      useSemantic = false;
    }
  }
  if (useSemantic && !hasEmbedding(queryEmbedding)) {
    useSemantic = false;
  }

  const now = Date.now();
  const scored: ScoredChunk[] = [];

  for (const { source, chunks } of retrievable) {
    for (const chunk of chunks) {
      const lexicalScore = scoreChunkLexical(chunk, queryTokens, corpus, source.title);
      if (lexicalScore <= 0 && !source.pinned && queryTokens.length > 0) {
        // No lexical signal and not pinned: only relevant when semantic can help.
        if (!useSemantic || !hasEmbedding(chunk.embedding)) continue;
      }

      const semanticScore =
        useSemantic && hasEmbedding(chunk.embedding) && hasEmbedding(queryEmbedding)
          ? cosineSimilarity(queryEmbedding ?? [], chunk.embedding ?? [])
          : 0;

      const relevanceRaw = lexicalScore + semanticScore;
      if (relevanceRaw <= 0 && !source.pinned) continue;

      const recency = recencyBoost(source, now);
      const authority = source.authority ?? 0.5;
      const pin = source.pinned ? 1 : 0;
      const feedback = feedbackWeight(source, options.feedback);

      const ranking: CitationRanking = {
        relevance: round(relevanceRaw),
        recency: round(recency * weights.recency),
        authority: round(authority * weights.authority),
        pin: round(pin * weights.pin),
        feedback: round(feedback * weights.feedback)
      };

      const fused =
        relevanceRaw * weights.relevance +
        recency * weights.recency +
        authority * weights.authority +
        pin * weights.pin +
        feedback * weights.feedback;

      scored.push({ source, chunk, lexicalScore, semanticScore, ranking, fused: round(fused) });
    }
  }

  // Rank: fused score desc, then title for stable order.
  scored.sort((a, b) => b.fused - a.fused || a.source.title.localeCompare(b.source.title));

  // Deduplicate overlapping chunks from the same source: keep the top chunk per
  // source unless chunks are clearly distinct (different headings).
  const deduped = deduplicateOverlapping(scored);

  // Apply the limit, then the character budget across snippets.
  const limited = deduped.slice(0, limit);
  const citations: KnowledgeCitation[] = [];
  let used = 0;
  for (const scored0 of limited) {
    const snippet = makeSnippet(scored0.chunk.text, queryTokens, snippetChars);
    if (used + snippet.length > budgetChars && citations.length > 0) break;
    citations.push(toCitation(scored0, snippet));
    used += snippet.length;
  }

  return {
    query,
    mode: useSemantic ? "hybrid" : "lexical-fallback",
    citations
  };
}

/** Drop near-duplicate chunks from the SAME source that overlap heavily. */
function deduplicateOverlapping(scored: ScoredChunk[]): ScoredChunk[] {
  const kept: ScoredChunk[] = [];
  for (const candidate of scored) {
    const sameSource = kept.filter((k) => k.source.id === candidate.source.id);
    const overlaps = sameSource.some((k) => {
      // Char-range overlap.
      const aStart = k.chunk.charStart;
      const aEnd = k.chunk.charEnd;
      const bStart = candidate.chunk.charStart;
      const bEnd = candidate.chunk.charEnd;
      const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
      const minLen = Math.min(aEnd - aStart, bEnd - bStart) || 1;
      // >=50% overlap AND same heading (or both headingless) => redundant.
      const sameHeading = (k.chunk.heading ?? "") === (candidate.chunk.heading ?? "");
      return overlap / minLen >= 0.5 && sameHeading;
    });
    if (!overlaps) kept.push(candidate);
  }
  return kept;
}

function makeSnippet(text: string, queryTokens: string[], maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const normalized = clean.toLowerCase();
  const firstMatch = queryTokens
    .map((token) => normalized.indexOf(token))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const start = Math.max(0, (firstMatch ?? 0) - Math.floor(maxChars / 3));
  const end = Math.min(clean.length, start + maxChars);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < clean.length ? "..." : "";
  return `${prefix}${clean.slice(start, end).trim()}${suffix}`;
}

function toCitation(scored: ScoredChunk, snippet: string): KnowledgeCitation {
  const citation: KnowledgeCitation = {
    sourceId: scored.source.id,
    title: scored.source.title,
    snippet,
    provenance: scored.source.provenance,
    freshness: scored.source.freshness,
    trust: scored.source.trust ?? "untrusted",
    pinned: scored.source.pinned,
    score: scored.fused,
    chunkId: scored.chunk.id,
    ranking: scored.ranking
  };
  if (scored.source.account) citation.account = scored.source.account;
  return citation;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

export type { RankingType };
