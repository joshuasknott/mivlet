/**
 * The ingestion pipeline: candidate -> IngestionOutcome.
 *
 * Pure, synchronous, no transport. Depends on @fable/protocol types and the
 * hashing/extraction/chunking helpers in this folder only. The pipeline NEVER
 * throws for ordinary problems — unsupported / malformed / binary / oversized
 * inputs become a bounded `skipped` outcome.
 *
 * Re-importing identical content yields the same source id (the id is derived
 * from the content hash), so a moved/renamed file with identical bytes matches
 * its existing source and is reported unchanged/updated, preserving the id.
 */

import type {
  ConnectorId,
  ConnectorSourceCandidate,
  IngestionOutcome,
  KnowledgeSource,
  SkipReason,
  SourceChunk
} from "@fable/protocol";
import { chunkSourceText } from "./chunk";
import { classifyCandidate } from "./extract";
import { contentHash, normalizeText, slug } from "./hash";

/** Max preview characters stored on the source (mirrors local-files). */
const PREVIEW_CHARS = 6_000;
/** Default per-connector folder cap. */
export const DEFAULT_FOLDER_MAX_FILES = 500;

export interface IngestCandidateOptions {
  connectorId: ConnectorId | string;
  /** Existing source matched to this candidate by content hash, if any. */
  existing?: KnowledgeSource;
}

/**
 * Stable source id: `source-${connectorId}-${slug(hash).slice(0,12)}`. Because
 * the hash is over the NORMALIZED text, re-importing identical content (even
 * after a rename or move) yields the same id — the basis of dedup.
 */
export function sourceIdFor(connectorId: string, contentFingerprint: string): string {
  return `source-${connectorId}-${slug(contentFingerprint).slice(0, 12)}`;
}

/** Local-files provenance label, e.g. "Local file - 1.2 KB". */
function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1_024) return `${sizeBytes} B`;
  return `${(sizeBytes / 1_024).toFixed(1)} KB`;
}

/** Human-readable freshness from a fetchedAt/importedAt ISO timestamp. */
function freshnessFor(fetchedAt?: string): string {
  if (!fetchedAt) return "Imported now";
  return "Imported now";
}

/**
 * Build a KnowledgeSource from a classified candidate + its fingerprint.
 * Sets the additive ingestion fields per the protocol: status "ok",
 * embeddingReady false (no embeddings yet), authority (0.5 local-files /
 * 0.7 connector), origin by connector.
 */
function buildSource(
  candidate: ConnectorSourceCandidate,
  connectorId: string,
  fingerprint: string
): KnowledgeSource {
  const isLocal = connectorId === "local-files";
  const source: KnowledgeSource = {
    id: sourceIdFor(connectorId, fingerprint),
    title: candidate.title,
    kind: "document",
    connectorId,
    provenance: isLocal
      ? `Local file - ${formatFileSize(candidate.sizeBytes)}`
      : `Connector: ${connectorId}`,
    freshness: freshnessFor(candidate.fetchedAt),
    pinned: false,
    trust: "untrusted",
    contentPreview: candidate.content.slice(0, PREVIEW_CHARS),
    contentFingerprint: fingerprint,
    sizeBytes: candidate.sizeBytes,
    importedAt: candidate.fetchedAt || new Date().toISOString(),
    origin: isLocal ? "local-import" : "connector-import",
    status: "ok",
    embeddingReady: false,
    authority: isLocal ? 0.5 : 0.7
  };
  if (candidate.account) source.account = candidate.account;
  if (candidate.providerMetadata) source.providerMetadata = candidate.providerMetadata;
  return source;
}

/**
 * Ingest one candidate into a bounded outcome.
 *
 *   - classify fails -> { kind: "skipped", reason, detail }
 *   - existing && existing.contentFingerprint === fingerprint -> "unchanged"
 *   - else build source + chunks; "created" (no existing) or "updated"
 *     (existing, carrying previousFingerprint)
 *
 * The fingerprint is the content hash over the NORMALIZED full text. Matching
 * is by content hash (NOT title), so a moved/renamed file with identical bytes
 * matches its existing source.
 */
export function ingestCandidate(
  candidate: ConnectorSourceCandidate,
  options: IngestCandidateOptions
): IngestionOutcome {
  const classified = classifyCandidate(candidate);
  if (!classified.ok) {
    return { kind: "skipped", reason: classified.reason, detail: classified.detail };
  }

  const fingerprint = contentHash(classified.text);

  const existing = options.existing;
  if (existing && existing.contentFingerprint === fingerprint) {
    return { kind: "unchanged", source: existing };
  }

  const source = buildSource(candidate, options.connectorId, fingerprint);
  // An update keeps the EXISTING source id so citations, pinned references,
  // and chunk ids stay stable across a content edit — only the content (and
  // thus the fingerprint) changes. A brand-new source keeps its hash-derived id.
  if (existing) {
    source.id = existing.id;
  }
  const chunks = chunkSourceText(classified.text, {
    sourceId: source.id,
    type: classified.type,
    mimeType: candidate.mimeType
  });

  if (existing) {
    return {
      kind: "updated",
      source,
      chunks,
      previousFingerprint: existing.contentFingerprint ?? ""
    };
  }

  return { kind: "created", source, chunks };
}

export interface ReindexResult {
  outcomes: IngestionOutcome[];
  /** Ids of existing sources with no matching candidate (caller deletes them). */
  removedSourceIds: string[];
}

/**
 * Incremental reindex with a two-stage match model:
 *
 *   1. CONTENT HASH match (primary): a candidate whose content hash matches an
 *      existing same-connector source's `contentFingerprint` is treated as
 *      `unchanged`. This is how a moved/renamed file (same bytes, different
 *      path/title) is recognized as the same source — its id is preserved.
 *
 *   2. PATH/IDENTITY match (fallback): if no hash match exists, a candidate
 *      whose title matches an existing same-connector source represents the
 *      SAME file with CHANGED content -> `updated` (carrying
 *      previousFingerprint). This is how a file edit surfaces as an update
 *      rather than a duplicate.
 *
 * Candidates with neither match -> created. Existing same-connector sources
 * matched by either stage are kept; the rest surface in `removedSourceIds` for
 * deletion. Sources from OTHER connectors are never removed here — they belong
 * to a different ingestion domain.
 */
export function reindexIndex(
  existingSources: KnowledgeSource[],
  candidates: ConnectorSourceCandidate[],
  connectorId: string
): ReindexResult {
  // Same-connector existing sources, indexed by fingerprint AND by title, so a
  // candidate can match by content (move/rename) OR by path (content edit).
  const byFingerprint = new Map<string, KnowledgeSource>();
  const byTitle = new Map<string, KnowledgeSource>();
  for (const source of existingSources) {
    if (source.connectorId !== connectorId) continue;
    if (source.contentFingerprint) byFingerprint.set(source.contentFingerprint, source);
    byTitle.set(source.title, source);
  }

  const outcomes: IngestionOutcome[] = [];
  const matchedSourceIds = new Set<string>();

  for (const candidate of candidates) {
    const hashFp = contentHash(candidate.content);
    // Stage 1: content-hash match (move/rename -> unchanged).
    const hashMatch = byFingerprint.get(hashFp);
    // Stage 2: path/identity match (same file, changed content -> updated).
    const titleMatch = byTitle.get(candidate.title);

    // Prefer a content match; fall back to a title match only when the content
    // genuinely differs (otherwise stage 1 already handles it).
    const existing = hashMatch ?? (titleMatch && titleMatch.contentFingerprint !== hashFp ? titleMatch : undefined);

    const outcome = ingestCandidate(candidate, { connectorId, existing });
    outcomes.push(outcome);

    if (outcome.kind === "created" || outcome.kind === "updated" || outcome.kind === "unchanged") {
      matchedSourceIds.add(outcome.source.id);
    }
  }

  const removedSourceIds: string[] = [];
  for (const source of byFingerprint.values()) {
    if (!matchedSourceIds.has(source.id)) {
      removedSourceIds.push(source.id);
    }
  }

  return { outcomes, removedSourceIds };
}

export interface IngestFolderOptions {
  connectorId?: string;
  /** Cap on the number of files ingested; overflow -> too-many-files skip. */
  maxFiles?: number;
}

export interface LocalFileCandidateInput {
  name: string;
  content: string;
  sizeBytes: number;
  fetchedAt?: string;
}

/**
 * Wrap a local file as a `ConnectorSourceCandidate` (connectorId "local-files",
 * MIME inferred from the file extension). Used by the shell to feed local
 * files into the same pipeline as connector sources.
 */
export function localFilesCandidate(input: LocalFileCandidateInput): ConnectorSourceCandidate {
  const ext = input.name.split(".").pop()?.toLowerCase() ?? "";
  const mime = mimeForExt(ext);
  return {
    externalId: input.name,
    title: input.name,
    mimeType: mime,
    content: input.content,
    sizeBytes: input.sizeBytes,
    fetchedAt: input.fetchedAt ?? new Date().toISOString()
  };
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
    case "yaml":
    case "yml":
      return "application/yaml";
    default:
      return "text/plain";
  }
}

/**
 * Folder ingestion: ingest a list of local file candidates with a per-folder
 * cap (default 500). Files beyond the cap each return a `too-many-files` skip
 * so the user sees exactly what was held back. Dedup within the folder is
 * automatic — identical content yields the same source id.
 *
 * Bounded: iterates the finite input list once; never unbounded.
 */
export function ingestFolder(
  files: LocalFileCandidateInput[],
  options: IngestFolderOptions = {}
): IngestionOutcome[] {
  const connectorId = options.connectorId ?? "local-files";
  const maxFiles = options.maxFiles ?? DEFAULT_FOLDER_MAX_FILES;
  const outcomes: IngestionOutcome[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i >= maxFiles) {
      outcomes.push({
        kind: "skipped",
        reason: "too-many-files" as SkipReason,
        detail: `File "${file.name}" exceeds the ${maxFiles}-file folder cap.`
      });
      continue;
    }
    const candidate = localFilesCandidate(file);
    outcomes.push(ingestCandidate(candidate, { connectorId }));
  }

  return outcomes;
}

/** Re-export the normalizer for callers that need to match the hash input. */
export { normalizeText };
