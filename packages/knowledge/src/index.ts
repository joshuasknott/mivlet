/**
 * Public barrel for the @mivlet/knowledge package.
 *
 * The knowledge + adaptive memory layer: ingestion, retrieval, memory, the
 * bounded context assembler, and the storage repository interface. Everything
 * is pure (no React, no transport) and depends on @mivlet/protocol only. The
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
  promoteCompletedWorkOutcome,
  promoteSideChatOutcome,
  promoteToMemory,
  resolvePromotionScope,
  suggestMemories,
  unpinMemory,
  MAX_PROMOTED_RECORDS,
  MAX_PROMOTED_TITLE_CHARACTERS,
  MAX_PROMOTED_VALUE_CHARACTERS,
  type CompletedWorkPromotionInput,
  type MemoryRetentionPolicy,
  type MemorySuggestionContext,
  type OutcomeSourceMessage,
  type PromoteMemoryInput,
  type PromotionOwners,
  type SideChatPromotionInput
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
  foldHistorySummary,
  invalidateSummariesForMemory,
  isUsableSummary,
  planBoundedHistory,
  retrieveElidedHistory,
  safeHistoryStart,
  selectRecentHistory,
  summariesForThread,
  DERIVED_HISTORY_POLICY,
  MAX_SUMMARY_CHARACTERS,
  RETRIEVED_HISTORY_POLICY,
  type AssembleContextInput,
  type AssembledContext,
  type AssembledCitation,
  type BoundedHistoryBudget,
  type BoundedHistoryDiagnostics,
  type BoundedHistoryInput,
  type BoundedHistoryPlan,
  type ContextAuthorizationRules,
  type ContextContribution,
  type ContextContributionReason,
  type FoldHistorySummaryInput,
  type HistoryEntry,
  type InvalidationResult,
  type RetrievedHistoryExcerpt
} from "./context";
