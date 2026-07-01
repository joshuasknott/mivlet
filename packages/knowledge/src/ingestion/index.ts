/**
 * Public surface of the ingestion pipeline.
 *
 * Pure functions: hashing, extraction/classification, structure-aware
 * chunking, and the candidate -> IngestionOutcome pipeline (with incremental
 * reindex, dedup, move/rename detection, and folder indexing). No React, no
 * transport — depends on @fable/protocol types only.
 */

export { contentHash, fnv1a64, normalizeText, slug } from "./hash";

export {
  MAX_CANDIDATE_BYTES,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_MIME_TYPES,
  classifyCandidate,
  extensionFor,
  extensionToType,
  malformedCsvDetail,
  malformedJsonDetail,
  malformedYamlDetail,
  mimeTypeForExtension,
  resolveType,
  type Classification,
  type ExtractedType
} from "./extract";

export {
  DEFAULT_MAX_CHARS,
  DEFAULT_OVERLAP_CHARS,
  chunkSourceText,
  mimeToType,
  type ChunkOptions
} from "./chunk";

export {
  DEFAULT_FOLDER_MAX_FILES,
  ingestCandidate,
  ingestFolder,
  localFilesCandidate,
  reindexIndex,
  sanitizeSourcePath,
  sourceIdFor,
  type IngestCandidateOptions,
  type IngestFolderOptions,
  type LocalFileCandidateInput,
  type ReindexOptions,
  type ReindexResult
} from "./ingest";

export {
  disableSource,
  enableSource,
  markFailed,
  markHealthy,
  markIndexing
} from "./lifecycle";
