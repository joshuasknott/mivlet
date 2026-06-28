/**
 * Semantic retrieval + pluggable embedding providers.
 *
 * An `EmbeddingProvider` turns text into vectors. When a provider is configured
 * AND a chunk carries an embedding, retrieval scores by cosine similarity. When
 * no provider is configured (or a chunk lacks an embedding), the pipeline
 * transparently falls back to lexical-only — the usable no-embedding path that
 * keeps the system functional without a model. Provider failures are caught by
 * the retrieval pipeline and turned into a lexical fallback (never an uncaught
 * throw).
 */

/** A pluggable embedding provider. Local or remote; the pipeline awaits it. */
export interface EmbeddingProvider {
  readonly id: string;
  embedTexts(texts: string[]): Promise<number[][]>;
}

/** L2 norm of a vector. */
export function norm(vec: number[]): number {
  let sum = 0;
  for (const v of vec) sum += v * v;
  return Math.sqrt(sum);
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 when either vector is empty or
 * zero-length (no direction). Vectors must be the same dimensionality; if they
 * differ, the trailing dimensions are ignored (defensive — embeddings from the
 * same model always match in length).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  const denom = norm(a) * norm(b);
  return denom === 0 ? 0 : dot / denom;
}

/** True when a chunk embedding is present and non-empty. */
export function hasEmbedding(embedding: number[] | undefined): boolean {
  return Boolean(embedding && embedding.length > 0);
}

/**
 * The no-op provider. Returned by the retrieval pipeline when no real provider
 * is configured: it yields no embeddings, which routes retrieval to the lexical
 * fallback. It never throws.
 */
export const NO_EMBEDDING_PROVIDER: EmbeddingProvider = {
  id: "none",
  async embedTexts(_texts: string[]): Promise<number[][]> {
    return [];
  }
};
