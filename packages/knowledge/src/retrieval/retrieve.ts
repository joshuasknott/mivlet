/**
 * The retrieval pipeline: filter -> hybrid score -> budget -> citation.
 *
 * Hybrid = lexical (always) fused with semantic (when embeddings exist) via
 * reciprocal-rank fusion (RRF, k=60). When no embeddings are present the
 * result is lexical-only and the response reports `mode: "lexical-fallback"`.
 * Ranking layers relevance, recency, source authority, pinning, and explicit
 * user feedback — and the basis is never hidden: each citation carries its
 * `CitationRanking` components.
 *
 * Deleted / disabled / inaccessible / stale / indexing sources are filtered
 * before scoring (the store already excludes disabled; we additionally
 * exclude stale/error/indexing-by-status, plus optional authorization,
 * connector, account, per-source, and user-selection filters). Bounded: the
 * pipeline returns at most `limit` citations within a character budget, with
 * overlapping and content-duplicate chunks from the same source deduplicated
 * so the budget isn't wasted on redundancy.
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
import { buildLexicalCorpus, scoreChunkLexical, tokenize, tokenSet } from "./lexical";
import { cosineSimilarity, hasEmbedding, type EmbeddingProvider } from "./semantic";

/** Sources/chunks that must never enter a run, regardless of score. */
const EXCLUDED_STATUSES: ReadonlySet<SourceStatus> = new Set(["error", "stale", "indexing"]);

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
  /** Restrict to sources from this connector. Undefined = no restriction. */
  connectorId?: string;
  /** Restrict to sources from this account. Undefined = no restriction. */
  account?: string;
  /** Restrict to these source ids. Undefined = no restriction. */
  sourceIds?: string[];
  /**
   * A user-selected source allowlist. When present, ONLY these source ids are
   * retrieved (intersection with any other filters). Undefined = no allowlist.
   */
  userSelectedSourceIds?: string[];
  /**
   * Authorization predicate. When present, sources failing it are excluded
   * before scoring — lets retrieval itself enforce disconnected/revoked-
   * account exclusion. Undefined = no extra authorization filter.
   */
  isAuthorized?: (source: KnowledgeSource) => boolean;
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

export interface RetrievalFilterOptions {
  scope?: KnowledgeScope;
  connectorId?: string;
  account?: string;
  sourceIds?: string[];
  userSelectedSourceIds?: string[];
  isAuthorized?: (source: KnowledgeSource) => boolean;
}

/**
 * Filter sources to those live, in-scope, authorized, and not in an excluded
 * status. This is the chokepoint that prevents deleted/disabled/stale/
 * inaccessible/unauthorized material from entering retrieval. (Disabled is
 * already filtered by the store's live read path; we re-check defensively
 * plus exclude error/stale/indexing-by-status.)
 *
 * Honors workspace/project/thread via `scope`, plus optional connector,
 * account, per-source, and user-selection filters. All filters are optional —
 * omitting any of them means "no restriction" (backward compatible).
 */
export function filterRetrievable(
  sources: RetrievalSource[],
  scope: KnowledgeScope = GLOBAL_SCOPE,
  filters: RetrievalFilterOptions = {}
): RetrievalSource[] {
  const connectorId = filters.connectorId;
  const account = filters.account;
  const sourceIdSet = filters.sourceIds ? new Set(filters.sourceIds) : undefined;
  const userSelectedSet = filters.userSelectedSourceIds
    ? new Set(filters.userSelectedSourceIds)
    : undefined;
  const isAuthorized = filters.isAuthorized;

  return sources.filter(({ source }) => {
    if (!isLiveSource(source)) return false;
    if (source.status && EXCLUDED_STATUSES.has(source.status)) return false;
    const sourceScope = source.scope ?? GLOBAL_SCOPE;
    if (!scopeSatisfies(sourceScope, scope)) return false;
    if (connectorId && source.connectorId !== connectorId) return false;
    if (account && source.account !== account) return false;
    if (sourceIdSet && !sourceIdSet.has(source.id)) return false;
    if (userSelectedSet && !userSelectedSet.has(source.id)) return false;
    if (isAuthorized && !isAuthorized(source)) return false;
    return true;
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

  const retrievable = filterRetrievable(sources, scope, {
    connectorId: options.connectorId,
    account: options.account,
    sourceIds: options.sourceIds,
    userSelectedSourceIds: options.userSelectedSourceIds,
    isAuthorized: options.isAuthorized
  });
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

  // Pass 1: compute raw lexical and semantic scores per chunk. The per-source
  // title token set is immutable across a query, so it is cached once per
  // source; each chunk's heading token set is precomputed once (it is read
  // again inside scoring for the heading boost).
  const raw: Array<{
    source: KnowledgeSource;
    chunk: SourceChunk;
    lexicalScore: number;
    semanticScore: number;
  }> = [];
  for (const { source, chunks } of retrievable) {
    const titleTokens = tokenSet(source.title);
    for (const chunk of chunks) {
      const headingTokens = chunk.heading ? tokenSet(chunk.heading) : undefined;
      const lexicalScore = scoreChunkLexical(chunk, queryTokens, corpus, source.title, {
        titleTokens,
        headingTokens
      });
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
      raw.push({ source, chunk, lexicalScore, semanticScore });
    }
  }

  // Pass 2: reciprocal-rank fusion (RRF, k=60) of the lexical and semantic
  // rankings into a single relevance score. Pure-lexical mode uses the lexical
  // rank only (RRF with one list reduces to 1/(k+rank)). This replaces the
  // previous raw-score sum so heterogeneous score scales (BM25 vs cosine) no
  // longer dominate each other, and matches the documented hybrid contract.
  const RRF_K = 60;
  const byLexical = [...raw].sort((a, b) => b.lexicalScore - a.lexicalScore);
  const bySemantic = [...raw].sort((a, b) => b.semanticScore - a.semanticScore);
  const lexicalRank = new Map<SourceChunk, number>();
  const semanticRank = new Map<SourceChunk, number>();
  byLexical.forEach((entry, rank) => lexicalRank.set(entry.chunk, rank));
  bySemantic.forEach((entry, rank) => semanticRank.set(entry.chunk, rank));

  const scored: ScoredChunk[] = raw.map((entry) => {
    let relevanceRaw: number;
    if (useSemantic) {
      const lr = 1 / (RRF_K + (lexicalRank.get(entry.chunk) ?? raw.length));
      const sr = 1 / (RRF_K + (semanticRank.get(entry.chunk) ?? raw.length));
      relevanceRaw = lr + sr;
    } else {
      relevanceRaw = 1 / (RRF_K + (lexicalRank.get(entry.chunk) ?? raw.length));
    }

    const recency = recencyBoost(entry.source, now);
    const authority = entry.source.authority ?? 0.5;
    const pin = entry.source.pinned ? 1 : 0;
    const feedback = feedbackWeight(entry.source, options.feedback);

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

    return {
      source: entry.source,
      chunk: entry.chunk,
      lexicalScore: entry.lexicalScore,
      semanticScore: entry.semanticScore,
      ranking,
      fused: round(fused)
    };
  });

  // Rank: fused score desc, then deterministic tie-breakers (title, chunk
  // ordinal, chunkId) so identical inputs always produce identical ordering.
  scored.sort(
    (a, b) =>
      b.fused - a.fused ||
      a.source.title.localeCompare(b.source.title) ||
      a.chunk.ordinal - b.chunk.ordinal ||
      a.chunk.id.localeCompare(b.chunk.id)
  );

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

/**
 * Drop near-duplicate chunks from the SAME source: those that overlap heavily
 * in the source text (>=50% char range AND same heading), OR that share an
 * identical content hash (exact duplicate text). Keeps the higher-ranked one.
 *
 * Groups kept chunks by source id in a Map for O(1) same-source lookup instead
 * of re-scanning the whole kept list per candidate.
 */
function deduplicateOverlapping(scored: ScoredChunk[]): ScoredChunk[] {
  const kept: ScoredChunk[] = [];
  const keptBySource = new Map<string, ScoredChunk[]>();
  for (const candidate of scored) {
    const sameSource = keptBySource.get(candidate.source.id);
    const redundant = sameSource?.some((k) => {
      // Exact content-hash duplicate (identical chunk text).
      if (k.chunk.contentHash === candidate.chunk.contentHash) return true;
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
    if (!redundant) {
      kept.push(candidate);
      const list = keptBySource.get(candidate.source.id);
      if (list) list.push(candidate);
      else keptBySource.set(candidate.source.id, [candidate]);
    }
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
    ranking: scored.ranking,
    scope: scored.source.scope ?? GLOBAL_SCOPE
  };
  if (scored.source.account) citation.account = scored.source.account;
  if (scored.source.sourcePath) citation.sourcePath = scored.source.sourcePath;
  if (scored.source.mediaType) citation.mediaType = scored.source.mediaType;
  return citation;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

export type { RankingType };
