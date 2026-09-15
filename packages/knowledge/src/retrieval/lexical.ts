/**
 * Lexical retrieval over source chunks.
 *
 * A compact BM25-lite scorer (token-frequency + inverse-document-frequency)
 * with title/heading boosts, generalizing the connector package's
 * `searchKnowledgeSources` to chunked sources. Pure and synchronous — no
 * network, no embeddings. This is the always-available fallback when no
 * embedding provider is configured.
 */

import type { SourceChunk } from "@mivlet/protocol";

/** Tokenize for lexical matching: lowercase, split on non-alphanumeric, drop 1-char noise. */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

/** Unique token set, used for IDF/coverage. */
export function tokenSet(value: string): Set<string> {
  return new Set(tokenize(value));
}

export interface LexicalCorpus {
  /** Average chunk length in tokens, for BM25 length normalization. */
  averageLength: number;
  /** Document frequency: how many chunks contain each token. */
  documentFrequency: Map<string, number>;
  /** Total chunk count, for IDF. */
  chunkCount: number;
  /**
   * Per-chunk precomputed term-frequency map + token length, produced in the
   * same single pass as the document frequencies so the body is tokenized once
   * per chunk (not once here and again at scoring time).
   */
  termFrequency: Map<SourceChunk, { tf: Map<string, number>; length: number }>;
}

/**
 * Build corpus statistics over a set of chunks (the denominator of BM25).
 * Computes each chunk's term-frequency map and token length in the same pass as
 * the document frequencies, so callers can reuse the precomputed TF map when
 * scoring instead of re-tokenizing the chunk body.
 */
export function buildLexicalCorpus(chunks: SourceChunk[]): LexicalCorpus {
  const documentFrequency = new Map<string, number>();
  const termFrequency = new Map<SourceChunk, { tf: Map<string, number>; length: number }>();
  let totalLength = 0;
  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    totalLength += tokens.length;
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    for (const token of tf.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
    termFrequency.set(chunk, { tf, length: tokens.length });
  }
  return {
    averageLength: chunks.length > 0 ? totalLength / chunks.length : 0,
    documentFrequency,
    chunkCount: chunks.length,
    termFrequency
  };
}

export interface LexicalScoreOptions {
  /** BM25 saturation (k1). Default 1.2. */
  k1?: number;
  /** BM25 length-normalization (b). Default 0.75. */
  b?: number;
  /** Multiplier applied to the score contribution from the source title. */
  titleBoost?: number;
  /** Multiplier applied to the score contribution from a chunk heading. */
  headingBoost?: number;
  /**
   * Optional precomputed token set for the source title (immutable per source
   * across a query), to avoid re-tokenizing the title once per chunk scored.
   */
  titleTokens?: Set<string>;
  /**
   * Optional precomputed token set for the chunk heading, to avoid re-tokenizing
   * the heading on every scoring call.
   */
  headingTokens?: Set<string>;
}

/**
 * BM25-ish score of a chunk against query tokens. Adds a title boost (when the
 * query matches the source title) and a heading boost (when the query matches
 * the chunk's nearest heading). Returns 0 when no query token matches.
 *
 * Uses the per-chunk term-frequency map precomputed by `buildLexicalCorpus`
 * (looked up on `corpus.termFrequency`) when available, so the chunk body is
 * tokenized once per corpus build instead of once per scoring call.
 */
export function scoreChunkLexical(
  chunk: SourceChunk,
  queryTokens: string[],
  corpus: LexicalCorpus,
  titleText: string,
  options: LexicalScoreOptions = {}
): number {
  if (queryTokens.length === 0) return 0;

  const { k1 = 1.2, b = 0.75, titleBoost = 3, headingBoost = 1.5 } = options;

  // Reuse the precomputed term-frequency map + length from the corpus build
  // when present; otherwise tokenize here (preserving the original behavior).
  const precomputed = corpus.termFrequency?.get(chunk);
  let termFreq: Map<string, number>;
  let chunkLen: number;
  if (precomputed) {
    termFreq = precomputed.tf;
    chunkLen = precomputed.length;
  } else {
    const chunkTokens = tokenize(chunk.text);
    termFreq = new Map<string, number>();
    for (const token of chunkTokens) {
      termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
    }
    chunkLen = chunkTokens.length;
  }

  const lenForNorm = chunkLen || 1;
  const denom = k1 * (1 - b + b * (lenForNorm / (corpus.averageLength || 1)));

  let score = 0;
  for (const token of queryTokens) {
    const tf = termFreq.get(token);
    if (!tf) continue;
    const df = corpus.documentFrequency.get(token) ?? 0;
    // Smoothed IDF so a token present in every chunk still contributes a little.
    const idf = Math.log(1 + (corpus.chunkCount - df + 0.5) / (df + 0.5));
    score += (idf * (tf * (k1 + 1))) / (tf + denom);
  }

  // Title match contribution: query tokens in the source title make the chunk
  // relevant even when the chunk body itself doesn't repeat the term. This is a
  // positive base (not a multiplier on body score) so a title-only match still
  // surfaces — a source titled "Launch plan" is relevant to "launch".
  const titleTokens = options.titleTokens ?? tokenSet(titleText);
  const titleHits = queryTokens.filter((token) => titleTokens.has(token)).length;
  if (titleHits > 0) {
    score += titleBoost * (titleHits / queryTokens.length);
  }

  // Heading match contribution: query tokens in the chunk's nearest heading.
  if (chunk.heading) {
    const headingTokens = options.headingTokens ?? tokenSet(chunk.heading);
    const headingHits = queryTokens.filter((token) => headingTokens.has(token)).length;
    if (headingHits > 0) {
      score += headingBoost * (headingHits / queryTokens.length);
    }
  }

  return score;
}
