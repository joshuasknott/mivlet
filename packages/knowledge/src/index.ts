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
