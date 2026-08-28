/**
 * Public barrel for the @fable/knowledge package.
 *
 * The knowledge + adaptive memory layer: ingestion, retrieval, memory, the
 * bounded context assembler, and the storage repository interface. Everything
 * is pure (no React, no transport) and depends on @fable/protocol only. The
 * storage seam (`KnowledgeStore`) is where Goal 5 swaps in encrypted SQLite.
 *
 * Re-exports grow as each pipeline module lands (ingestion, retrieval, memory,
 * context). Keeping them centralized here keeps the package's public protocol
 * stable for consumers.
 */

export {
  createKnowledgeStore,
  emptyKnowledgeStoreState,
  isLiveMemory,
  isLiveSource,
  authorityScopeAllowsAudience,
  scopeSatisfies,
  scopesMatch,
  type KnowledgeStore,
  type KnowledgeStoreState
} from "./store";

/**
 * Ingestion pipeline: pure functions for turning connector/local-file
 * candidates into stable KnowledgeSource + SourceChunk records, with dedup,
 * incremental reindex, move/rename detection, and folder indexing. See
 * ./ingestion for the full surface.
 */
export * from "./ingestion";

// --- memory pipeline (additive) -------------------------------------------
export {
  approveSuggestion,
  applyRetention,
  DEFAULT_RETENTION_POLICY,
  detectContradiction,
  detectDuplicate,
  disableMemory,
  editMemory,
  exportMemories,
  forgetMemory,
  pinMemory,
  promoteToMemory,
  suggestMemories,
  unpinMemory,
  type MemoryRetentionPolicy,
  type MemorySuggestionContext,
  type PromoteMemoryInput
} from "./memory";

// --- retrieval pipeline (additive) ----------------------------------------
export {
  cosineSimilarity,
  DEFAULT_RANKING_WEIGHTS,
  filterRetrievable,
  NO_EMBEDDING_PROVIDER,
  retrieve,
  type EmbeddingProvider,
  type RetrievalFeedback,
  type AuthorityScopedKnowledgeCitation,
  type KnowledgeRetrievalResponse,
  type RetrievalRankingWeights,
  type RetrievalSource,
  type RetrieveOptions
} from "./retrieval";

// --- context assembler (additive) -----------------------------------------
export {
  assembleContext,
  type AssembleContextInput,
  type AssembledContext,
  type AssembledCitation,
  type ContextAuthorizationRules,
  type ContextContribution,
  type ContextContributionReason
} from "./context";
