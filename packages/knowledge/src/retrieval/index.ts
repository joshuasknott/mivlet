/**
 * Barrel for the retrieval pipeline.
 *
 * Hybrid lexical + semantic retrieval over chunked sources, with scope
 * filtering, multi-factor ranking, context budgets, overlapping-chunk dedup,
 * and inspectable citations. Re-exported additively from the package barrel.
 */

export {
  buildLexicalCorpus,
  scoreChunkLexical,
  tokenize,
  tokenSet,
  type LexicalCorpus,
  type LexicalScoreOptions
} from "./lexical";

export {
  cosineSimilarity,
  hasEmbedding,
  norm,
  NO_EMBEDDING_PROVIDER,
  type EmbeddingProvider
} from "./semantic";

export {
  DEFAULT_RANKING_WEIGHTS,
  filterRetrievable,
  retrieve,
  type RetrievalFeedback,
  type RetrievalFilterOptions,
  type RetrievalRankingWeights,
  type RetrievalSource,
  type RetrieveOptions
} from "./retrieve";
