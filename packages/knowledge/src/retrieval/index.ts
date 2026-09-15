/** Public retrieval API; pipeline internals stay in their owning modules. */
export {
  cosineSimilarity,
  NO_EMBEDDING_PROVIDER,
  type EmbeddingProvider
} from "./semantic";
export {
  DEFAULT_RANKING_WEIGHTS,
  filterRetrievable,
  retrieve,
  type RetrievalFeedback,
  type RetrievalRankingWeights,
  type RetrievalSource,
  type AuthorityScopedKnowledgeCitation,
  type KnowledgeRetrievalResponse,
  type RetrieveOptions
} from "./retrieve";
