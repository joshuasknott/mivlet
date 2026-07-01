/**
 * Text extraction + MIME/type handling + bounded failure classification.
 *
 * The ingestion pipeline MUST NEVER throw for ordinary problems — an
 * unsupported, malformed, binary, oversized, or empty candidate becomes a
 * bounded `skipped` outcome the caller can show. `classifyCandidate` is the
 * single chokepoint that turns a raw `ConnectorSourceCandidate` into either
 * the normalized text the chunker wants, or a structured skip reason.
 *
 * Supported types mirror the local-files connector
 * (packages/connectors/src/local-files.ts): txt, md, markdown, json, csv, yaml,
 * yml — plus their standard MIMEs.
 */

import type { ConnectorSourceCandidate, SkipReason } from "@fable/protocol";

/** Two megabytes — same bound as `MAX_LOCAL_FILE_BYTES` in local-files. */
export const MAX_CANDIDATE_BYTES = 2 * 1024 * 1024;

/** Canonical content "type" the chunker switches on (structure-aware). */
export type ExtractedType = "markdown" | "json" | "csv" | "yaml" | "text";

/**
 * Supported file extensions (lowercase, no leading dot). Kept in sync with the
 * local-files connector's `SUPPORTED_LOCAL_FILE_EXTENSIONS`.
 */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "csv",
  "yaml",
  "yml"
]);

/**
 * Supported MIME types mapped to the canonical extracted type. Parameters
 * (e.g. `text/markdown; charset=utf-8`) are stripped before lookup.
 */
export const SUPPORTED_MIME_TYPES: Record<string, ExtractedType> = {
  "text/plain": "text",
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "application/json": "json",
  "text/json": "json",
  "text/csv": "csv",
  "application/csv": "csv",
  "application/yaml": "yaml",
  "text/yaml": "yaml",
  "text/x-yaml": "yaml"
};

/** Strip any `;charset=...` parameter from a MIME type. */
function bareMimeType(mimeType: string): string {
  const semi = mimeType.indexOf(";");
  return (semi >= 0 ? mimeType.slice(0, semi) : mimeType).trim().toLowerCase();
}

/** Lowercase extension (no dot) from a filename/title, or "" if none. */
export function extensionFor(name: string): string {
  const base = name.trim().split(/[\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Resolve a candidate's canonical extracted type from its MIME (preferred) or
 * its file extension (fallback for `application/octet-stream` / missing MIME).
 * Returns `undefined` when the type is not supported.
 */
export function resolveType(candidate: ConnectorSourceCandidate): ExtractedType | undefined {
  const mime = bareMimeType(candidate.mimeType);
  if (mime && SUPPORTED_MIME_TYPES[mime]) {
    return SUPPORTED_MIME_TYPES[mime];
  }
  const ext = extensionFor(candidate.title);
  if (!ext || !SUPPORTED_EXTENSIONS.has(ext)) return undefined;
  return extensionToType(ext);
}

/** Map a supported extension to its canonical extracted type. */
export function extensionToType(ext: string): ExtractedType {
  switch (ext) {
    case "md":
    case "markdown":
      return "markdown";
    case "json":
      return "json";
    case "csv":
      return "csv";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return "text";
  }
}

/** MIME type for a supported extension (used by `localFilesCandidate`). */
export function mimeTypeForExtension(ext: string): string {
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

/** Result of classification: either normalized text or a bounded skip. */
export type Classification =
  | { ok: true; text: string; type: ExtractedType }
  | { ok: false; reason: SkipReason; detail: string };

/**
 * Heuristic: does `content` look like binary data? Treats a NUL byte, or a
 * disproportionate share of non-text control characters, as binary. The
 * chunker and embedding path only ever see genuine text.
 *
 * `>5%` control-char ratio threshold matches the task spec. Tab/newline/CR are
 * legitimate text and are excluded from the control-char count.
 */
function looksBinary(content: string): boolean {
  if (content.length === 0) return false;
  if (content.indexOf("\u0000") >= 0) return true;

  let controlCount = 0;
  const sampleLen = Math.min(content.length, 8192);
  for (let i = 0; i < sampleLen; i++) {
    const code = content.charCodeAt(i);
    // Allow tab (9), LF (10), CR (13). Everything else < 32 is a control char.
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      controlCount++;
    }
  }
  return controlCount / sampleLen > 0.05;
}

/**
 * Classify a candidate. Bounded: never throws. The order of checks matters —
 * size and emptiness are checked before parsing so a huge malformed payload is
 * reported as `oversized` (not `malformed`) and an empty payload as `empty`.
 *
 *   1. empty (after trim)            -> empty
 *   2. sizeBytes > 2MB               -> oversized
 *   3. unsupported mime/extension    -> unsupported-type
 *   4. binary (NUL / >5% controls)   -> binary
 *   5. malformed (JSON.parse throws) -> malformed   (json only)
 *
 * The returned `text` is the RAW content (not normalized); normalization is
 * applied at hash time so chunk charStart/charEnd stay accurate to the text
 * the chunker actually received.
 */
export function classifyCandidate(candidate: ConnectorSourceCandidate): Classification {
  const trimmed = candidate.content.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty", detail: "Candidate content is empty." };
  }

  if (candidate.sizeBytes > MAX_CANDIDATE_BYTES) {
    return {
      ok: false,
      reason: "oversized",
      detail: `Candidate is ${candidate.sizeBytes} bytes; limit is ${MAX_CANDIDATE_BYTES} bytes.`
    };
  }

  const type = resolveType(candidate);
  if (!type) {
    return {
      ok: false,
      reason: "unsupported-type",
      detail: `Unsupported MIME "${candidate.mimeType}" / extension "${extensionFor(candidate.title)}".`
    };
  }

  if (looksBinary(candidate.content)) {
    return {
      ok: false,
      reason: "binary",
      detail: "Candidate content appears to be binary (NUL byte or high control-char ratio)."
    };
  }

  if (type === "json") {
    const jsonError = malformedJsonDetail(candidate.content);
    if (jsonError) {
      return {
        ok: false,
        reason: "malformed",
        detail: `JSON parse failed: ${jsonError}`
      };
    }
  } else if (type === "csv") {
    const csvError = malformedCsvDetail(candidate.content);
    if (csvError) {
      return { ok: false, reason: "malformed", detail: csvError };
    }
  } else if (type === "yaml") {
    const yamlError = malformedYamlDetail(candidate.content);
    if (yamlError) {
      return { ok: false, reason: "malformed", detail: yamlError };
    }
  }

  return { ok: true, text: candidate.content, type };
}

/**
 * Validate JSON structure. Returns an error message when malformed, or `null`
 * when well-formed. Used by `classifyCandidate` so malformed JSON becomes a
 * bounded `malformed` skip instead of a later chunker failure.
 */
export function malformedJsonDetail(content: string): string | null {
  try {
    JSON.parse(content);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "parse error";
  }
}

/**
 * Conservative CSV sanity check. Rejects content that is clearly not CSV:
 *   - a header line with no delimiter AND multiple non-empty data lines
 *     (looks like prose, not tabular data);
 *   - grossly ragged rows (every data row has a different column count that
 *     differs from the header) when the delimiter is consistent.
 *
 * Tab characters are treated as an alternative delimiter. Empty/single-row
 * content is not flagged here (the chunker handles it). Conservative: only
 * clearly broken structure is rejected.
 */
export function malformedCsvDetail(content: string): string | null {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return null;

  const header = lines[0];
  const candidateDelims = [",", "\t", ";", "|"];
  let delim = ",";
  for (const d of candidateDelims) {
    if (header.includes(d)) {
      delim = d;
      break;
    }
  }

  // Header with no delimiter and more than one data line → likely prose.
  if (!header.includes(delim) && lines.length > 2) {
    return "Header line has no delimiter and multiple data rows; not tabular.";
  }

  const headerCols = countCsvFields(header, delim);
  if (headerCols <= 1) return null;

  // Reject when EVERY data row's column count differs from the header
  // (a consistently ragged table is broken; one or two ragged rows are tolerated).
  let mismatched = 0;
  for (let i = 1; i < lines.length; i++) {
    if (countCsvFields(lines[i], delim) !== headerCols) mismatched++;
  }
  if (mismatched === lines.length - 1 && lines.length > 2) {
    return `All ${mismatched} data rows have a column count differing from the header (${headerCols}).`;
  }
  return null;
}

/** Count CSV fields in a line, honoring quoted fields containing the delimiter. */
function countCsvFields(line: string, delim: string): number {
  if (!line.includes(delim)) return 1;
  let count = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++; // escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delim && !inQuotes) {
      count++;
    }
  }
  return count;
}

/**
 * Conservative YAML structure check. Rejects clearly broken YAML:
 *   - tabs used for indentation (YAML forbids tab indentation);
 *   - a document that has no recognizable structure at all (no mapping keys,
 *     no sequence entries, no scalars) beyond whitespace/comments.
 *
 * Does NOT require a full YAML parser — only flags unambiguous breakage so
 * ordinary YAML passes through. Bounded by line count.
 */
export function malformedYamlDetail(content: string): string | null {
  const lines = content.split(/\r?\n/);
  let hasContent = false;
  for (const line of lines) {
    // Tab indentation (a leading tab before non-comment content) is invalid.
    if (/^\t+\S/.test(line)) {
      return "YAML forbids tab indentation; found a tab-indented line.";
    }
    // Any non-comment, non-whitespace line counts as content.
    if (line.trim().length > 0 && !line.trim().startsWith("#")) {
      hasContent = true;
    }
  }
  if (!hasContent) {
    return "YAML document has no content beyond comments/whitespace.";
  }
  return null;
}
