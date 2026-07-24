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
  KnowledgeScope,
  KnowledgeSource,
  SkipReason,
  SourceChunk
} from "@fable/protocol";
import { GLOBAL_SCOPE } from "@fable/protocol";
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

/**
 * Human-readable freshness derived from a modifiedAt/fetchedAt ISO timestamp.
 * Falls back to "Imported now" when no timestamp is available. Produces a
 * relative label ("just now", "N hours/days ago") so the freshness citation
 * field is informative instead of a constant.
 */
function freshnessFor(modifiedAt?: string, fetchedAt?: string): string {
  const ts = modifiedAt ?? fetchedAt;
  if (!ts) return "Imported now";
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return "Imported now";
  const diffMs = Date.now() - parsed;
  if (diffMs < 60_000) return "Imported just now";
  if (diffMs < 3_600_000) return `Imported ${Math.floor(diffMs / 60_000)} min ago`;
  if (diffMs < 86_400_000) return `Imported ${Math.floor(diffMs / 3_600_000)} h ago`;
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 30) return `Imported ${days} d ago`;
  return `Imported ${new Date(parsed).toISOString().slice(0, 10)}`;
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
    freshness: freshnessFor(candidate.modifiedAt, candidate.fetchedAt),
    pinned: false,
    trust: "untrusted",
    contentPreview: candidate.content.slice(0, PREVIEW_CHARS),
    contentFingerprint: fingerprint,
    sizeBytes: candidate.sizeBytes,
    importedAt: candidate.fetchedAt || new Date().toISOString(),
    origin: isLocal ? "local-import" : "connector-import",
    status: "ok",
    embeddingReady: false,
    authority: isLocal ? 0.5 : 0.7,
    scope: candidate.scope ?? GLOBAL_SCOPE,
    mediaType: candidate.mimeType
  };
  if (candidate.modifiedAt) source.modifiedAt = candidate.modifiedAt;
  if (candidate.sourcePath) source.sourcePath = candidate.sourcePath;
  if (candidate.account) source.account = candidate.account;
  if (candidate.connectionId) source.connectionId = candidate.connectionId;
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
    // Carry forward lifecycle fields that survive a content edit: pin state,
    // scope, and disabled/status. Only content-derived fields are rebuilt by
    // buildSource; deliberate user state must not be reset on edit.
    source.pinned = existing.pinned;
    source.scope = existing.scope ?? source.scope;
    source.disabled = existing.disabled;
    source.status = existing.status;
    if (existing.statusMessage) source.statusMessage = existing.statusMessage;
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

export interface ReindexOptions {
  /**
   * Ids of sources deliberately deleted by the user. A candidate that would
   * re-create one of these ids is skipped instead, so a routine refresh never
   * silently restores deliberately deleted content. The caller persists this
   * tombstone list; the knowledge layer only honors it.
   */
  deletedSourceIds?: ReadonlySet<string> | string[];
}

/**
 * Incremental reindex with a two-stage match model:
 *
 *   1. CONTENT HASH match (primary): a candidate whose content hash matches an
 *      existing same-connector source's `contentFingerprint` is treated as
 *      `unchanged`. This is how a moved/renamed file (same bytes, different
 *      path/title) is recognized as the same source — its id is preserved.
 *      When the path/title differs, metadata is refreshed (repath).
 *
 *   2. PATH/IDENTITY match (fallback): if no hash match exists, a candidate
 *      whose title matches an existing same-connector source represents the
 *      SAME file with CHANGED content -> `updated` (carrying
 *      previousFingerprint). This is how a file edit surfaces as an update
 *      rather than a duplicate.
 *
 * Candidates with neither match -> created, unless the resulting id is in the
 * tombstone set (deletedSourceIds), in which case the candidate is skipped.
 * Existing same-connector sources matched by either stage are kept; the rest
 * surface in `removedSourceIds` for deletion. Sources from OTHER connectors
 * are never removed here — they belong to a different ingestion domain.
 */
export function reindexIndex(
  existingSources: KnowledgeSource[],
  candidates: ConnectorSourceCandidate[],
  connectorId: string,
  options: ReindexOptions = {}
): ReindexResult {
  const tombstones = new Set(
    Array.isArray(options.deletedSourceIds) ? options.deletedSourceIds : (options.deletedSourceIds ?? [])
  );

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

    // Repath: an unchanged content match whose path/title differs refreshes
    // the path/title metadata on the existing source (a move/rename) so the
    // new provenance is visible without re-chunking.
    if (outcome.kind === "unchanged" && existing) {
      const repathed = repathSource(outcome.source, candidate);
      outcomes.push({ kind: "unchanged", source: repathed });
      matchedSourceIds.add(repathed.id);
      continue;
    }

    // Tombstone: a would-be-created source whose id was deliberately deleted
    // is skipped so a refresh never silently restores it.
    if (outcome.kind === "created" && tombstones.has(outcome.source.id)) {
      outcomes.push({
        kind: "skipped",
        reason: "empty" as SkipReason,
        detail: `Source "${outcome.source.title}" was previously deleted and is held back by tombstone.`
      });
      continue;
    }

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

/**
 * Refresh path/title metadata on an unchanged source after a move/rename.
 * Returns a shallow-updated copy preserving the id, fingerprint, chunks, and
 * pin/lifecycle state. Only provenance metadata touched by a path change is
 * rewritten.
 */
function repathSource(source: KnowledgeSource, candidate: ConnectorSourceCandidate): KnowledgeSource {
  const updated: KnowledgeSource = { ...source };
  if (candidate.title && candidate.title !== source.title) {
    updated.title = candidate.title;
  }
  if (candidate.sourcePath) updated.sourcePath = candidate.sourcePath;
  if (candidate.scope) updated.scope = candidate.scope;
  if (candidate.modifiedAt) updated.modifiedAt = candidate.modifiedAt;
  updated.importedAt = candidate.fetchedAt || source.importedAt;
  updated.freshness = freshnessFor(candidate.modifiedAt, candidate.fetchedAt);
  return updated;
}

export interface IngestFolderOptions {
  connectorId?: string;
  /** Cap on the number of files ingested; overflow -> too-many-files skip. */
  maxFiles?: number;
  /**
   * Import boundary root (normalized, no trailing separator). When set, any
   * file whose `sourcePath` escapes this root (after resolving `..`) is
   * skipped with reason `path-escape`. When unset, absolute paths are still
   * rejected but `..` segments are collapsed.
   */
  importRoot?: string;
}

export interface LocalFileCandidateInput {
  name: string;
  content: string;
  sizeBytes: number;
  fetchedAt?: string;
  /** Optional relative path within the import boundary (preserved as metadata). */
  sourcePath?: string;
  /** Optional content last-modified timestamp (ISO). */
  modifiedAt?: string;
  /** Optional scope the file should be ingested into. */
  scope?: KnowledgeScope;
}

/**
 * Sanitize a candidate source path into a boundary-relative form. Strips
 * drive letters/leading separators, collapses `.`/`..` segments, and returns
 * the normalized relative path. Returns `null` when the path escapes the
 * boundary (resolves above the import root) — the caller turns that into a
 * `path-escape` skip.
 */
export function sanitizeSourcePath(path: string, importRoot?: string): string | null {
  if (!path) return "";
  // Normalize backslashes to forward slashes.
  let p = path.replace(/\\/g, "/");
  // Strip a Windows drive letter (e.g. "C:") and any leading UNC/root.
  p = p.replace(/^[a-zA-Z]:/, "");
  // Collapse repeated slashes.
  p = p.replace(/\/+/g, "/");
  // Strip leading slash (make relative).
  p = p.replace(/^\/+/, "");

  // Resolve `.` and `..` segments.
  const segments: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segments.length === 0) {
        // Escapes the boundary.
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  const normalized = segments.join("/");

  // When an explicit import root is provided, also ensure the original path
  // (joined to the root) does not escape it. The segment resolver above
  // already rejects `..` overflow; this is a belt-and-braces guard for
  // symlink-shaped inputs.
  if (importRoot) {
    const root = sanitizeSourcePath(importRoot);
    if (root === null) return null;
  }
  return normalized;
}

/**
 * Wrap a local file as a `ConnectorSourceCandidate` (connectorId "local-files",
 * MIME inferred from the file extension). Used by the shell to feed local
 * files into the same pipeline as connector sources.
 */
export function localFilesCandidate(input: LocalFileCandidateInput): ConnectorSourceCandidate {
  const ext = input.name.split(".").pop()?.toLowerCase() ?? "";
  const mime = mimeForExt(ext);
  const candidate: ConnectorSourceCandidate = {
    externalId: input.name,
    title: input.name,
    mimeType: mime,
    content: input.content,
    sizeBytes: input.sizeBytes,
    fetchedAt: input.fetchedAt ?? new Date().toISOString()
  };
  if (input.sourcePath) candidate.sourcePath = input.sourcePath;
  if (input.modifiedAt) candidate.modifiedAt = input.modifiedAt;
  if (input.scope) candidate.scope = input.scope;
  return candidate;
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
 * cap (default 500), deterministic ordering (by normalized path then name),
 * and a path-escape guard (files whose `sourcePath` resolves above the import
 * boundary are skipped with reason `path-escape`). Files beyond the cap each
 * return a `too-many-files` skip so the user sees exactly what was held back.
 * Dedup within the folder is automatic — identical content yields the same
 * source id. Partial failures are bounded per-file: a skip on one file never
 * invalidates successful imports.
 *
 * Bounded: iterates the finite input list once; never unbounded.
 */
export function ingestFolder(
  files: LocalFileCandidateInput[],
  options: IngestFolderOptions = {}
): IngestionOutcome[] {
  const connectorId = options.connectorId ?? "local-files";
  const maxFiles = options.maxFiles ?? DEFAULT_FOLDER_MAX_FILES;

  // Deterministic ordering: by sanitized sourcePath (when present) then name,
  // then content length as a final stable tie-breaker. Ordering is applied
  // BEFORE the cap so the cap is deterministic regardless of input order.
  const normalized = files.map((file) => {
    const safePath = file.sourcePath
      ? sanitizeSourcePath(file.sourcePath, options.importRoot)
      : null;
    return { file, safePath };
  });
  normalized.sort((a, b) => {
    const pa = a.safePath ?? a.file.name;
    const pb = b.safePath ?? b.file.name;
    if (pa !== pb) return pa < pb ? -1 : 1;
    if (a.file.name !== b.file.name) return a.file.name < b.file.name ? -1 : 1;
    return a.file.sizeBytes - b.file.sizeBytes;
  });

  const outcomes: IngestionOutcome[] = [];

  for (let i = 0; i < normalized.length; i++) {
    const { file, safePath } = normalized[i];

    if (i >= maxFiles) {
      outcomes.push({
        kind: "skipped",
        reason: "too-many-files" as SkipReason,
        detail: `File "${file.name}" exceeds the ${maxFiles}-file folder cap.`
      });
      continue;
    }

    // Path-escape guard: a sourcePath that resolves above the boundary is
    // rejected. This is the chokepoint for unsafe path traversal.
    if (file.sourcePath && safePath === null) {
      outcomes.push({
        kind: "skipped",
        reason: "path-escape" as SkipReason,
        detail: `File "${file.name}" path escapes the import boundary.`
      });
      continue;
    }

    // When the path was sanitized (e.g. backslashes normalized), use the
    // sanitized form so downstream metadata is boundary-relative. The
    // path-escape guard above already `continue`d when safePath was null, so
    // here safePath is a normalized string (or undefined when no sourcePath).
    const candidateInput: LocalFileCandidateInput = { ...file };
    if (file.sourcePath && typeof safePath === "string") {
      candidateInput.sourcePath = safePath;
    }
    const candidate = localFilesCandidate(candidateInput);
    outcomes.push(ingestCandidate(candidate, { connectorId }));
  }

  return outcomes;
}

/** Re-export the normalizer for callers that need to match the hash input. */
export { normalizeText };
