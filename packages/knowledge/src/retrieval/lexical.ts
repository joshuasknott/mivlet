/**
 * Lexical retrieval over source chunks.
 *
 * A compact BM25-lite scorer (token-frequency + inverse-document-frequency)
 * with title/heading boosts, generalizing the connector package's
 * `searchKnowledgeSources` to chunked sources. Pure and synchronous — no
 * network, no embeddings. This is the always-available fallback when no
 * embedding provider is configured.
 */

import type { SourceChunk } from "@fable/protocol";

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
}

/** Build corpus statistics over a set of chunks (the denominator of BM25). */
export function buildLexicalCorpus(chunks: SourceChunk[]): LexicalCorpus {
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    totalLength += tokens.length;
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  return {
    averageLength: chunks.length > 0 ? totalLength / chunks.length : 0,
    documentFrequency,
    chunkCount: chunks.length
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
}

/**
 * BM25-ish score of a chunk against query tokens. Adds a title boost (when the
 * query matches the source title) and a heading boost (when the query matches
 * the chunk's nearest heading). Returns 0 when no query token matches.
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

  // Term frequencies in the chunk body.
  const chunkTokens = tokenize(chunk.text);
  const termFreq = new Map<string, number>();
  for (const token of chunkTokens) {
    termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
  }

  const chunkLen = chunkTokens.length || 1;
  const denom = k1 * (1 - b + b * (chunkLen / (corpus.averageLength || 1)));

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
  const titleTokens = tokenSet(titleText);
  const titleHits = queryTokens.filter((token) => titleTokens.has(token)).length;
  if (titleHits > 0) {
    score += titleBoost * (titleHits / queryTokens.length);
  }

  // Heading match contribution: query tokens in the chunk's nearest heading.
  if (chunk.heading) {
    const headingTokens = tokenSet(chunk.heading);
    const headingHits = queryTokens.filter((token) => headingTokens.has(token)).length;
    if (headingHits > 0) {
      score += headingBoost * (headingHits / queryTokens.length);
    }
  }

  return score;
}
