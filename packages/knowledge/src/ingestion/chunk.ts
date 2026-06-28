/**
 * Structure-aware chunking.
 *
 * Each chunk is a slice of the ORIGINAL text with `charStart`/`charEnd` that
 * index back into it (so citations resolve to an exact location), a stable id
 * (`${sourceId}#${ordinal}`, ordinal from 0), a content hash of the chunk text,
 * and the nearest heading when the source was chunked by structure.
 *
 * Per type:
 *   - markdown: split on ATX headings (^#{1..6} space); each section is one
 *     chunk carrying its heading; oversized sections further split on paragraph
 *     then fixed-window boundaries.
 *   - json: top-level array -> each element serialized is a chunk; object ->
 *     each top-level key/value is a chunk; primitives -> fixed window.
 *   - csv: row-group boundaries (~50 rows or maxChars, whichever first), with
 *     the header line prepended to every chunk.
 *   - text/other/yaml: fixed window of maxChars with overlapChars overlap,
 *     breaking on sentence/paragraph boundaries where possible.
 *
 * Bounded: the loop is driven by finite input, never unbounded.
 */

import type { SourceChunk } from "@fable/protocol";
import { contentHash } from "./hash";
import type { ExtractedType } from "./extract";

export interface ChunkOptions {
  sourceId: string;
  mimeType?: string;
  type?: ExtractedType;
  /** Max characters per chunk. Default 1200. */
  maxChars?: number;
  /** Overlap characters between adjacent fixed-window chunks. Default 200. */
  overlapChars?: number;
}

export const DEFAULT_MAX_CHARS = 1200;
export const DEFAULT_OVERLAP_CHARS = 200;
/** CSV row-group target size. */
const CSV_GROUP_ROWS = 50;

/** Build a single chunk; hashes the (normalized) chunk text for dedup. */
function makeChunk(
  sourceId: string,
  ordinal: number,
  text: string,
  charStart: number,
  charEnd: number,
  heading?: string
): SourceChunk {
  const chunk: SourceChunk = {
    id: `${sourceId}#${ordinal}`,
    sourceId,
    ordinal,
    text,
    contentHash: contentHash(text),
    charStart,
    charEnd
  };
  if (heading) chunk.heading = heading;
  return chunk;
}

/**
 * Fixed-window offsets over `text`, stepping by `maxChars - overlapChars`.
 * Always finite (bounded by text length). overlap is clamped so step >= 1.
 */
function fixedWindowOffsets(
  text: string,
  maxChars: number,
  overlapChars: number
): { start: number; end: number }[] {
  const windows: { start: number; end: number }[] = [];
  if (text.length === 0) return windows;

  const safeOverlap = Math.min(overlapChars, maxChars - 1);
  const step = Math.max(1, maxChars - safeOverlap);
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    windows.push({ start, end });
    if (end >= text.length) break;
    start += step;
  }
  return windows;
}

/**
 * Pull `end` back to a paragraph or sentence boundary if one is near the
 * window end, so chunks avoid splitting mid-sentence when possible. Never
 * grows the window past `maxChars` from `start`.
 */
function adjustToBoundary(text: string, start: number, end: number): number {
  if (end - start <= 0 || end >= text.length) return end;

  const minAccept = start + Math.floor((end - start) * 0.5);
  const tail = text.slice(minAccept, end);

  const paraBreak = tail.lastIndexOf("\n\n");
  if (paraBreak >= 0) return minAccept + paraBreak;

  const nl = tail.lastIndexOf("\n");
  if (nl >= 0) return minAccept + nl + 1;

  const sentenceEnd = Math.max(
    tail.lastIndexOf(". "),
    tail.lastIndexOf("! "),
    tail.lastIndexOf("? ")
  );
  if (sentenceEnd >= 0) return minAccept + sentenceEnd + 2;

  const space = tail.lastIndexOf(" ");
  if (space >= 0) return minAccept + space;

  return end;
}

/**
 * Build chunks from a list of segments. Any segment larger than `maxChars` is
 * further split on fixed windows with boundary adjustment, so no chunk exceeds
 * the cap. The segment heading carries only onto its first sub-chunk.
 */
function buildChunksFromSegments(
  sourceId: string,
  segments: { text: string; start: number; end: number; heading?: string }[],
  maxChars: number,
  overlapChars: number
): SourceChunk[] {
  const chunks: SourceChunk[] = [];
  let ordinal = 0;

  for (const segment of segments) {
    if (segment.text.length === 0) continue;

    if (segment.text.length <= maxChars) {
      chunks.push(
        makeChunk(sourceId, ordinal++, segment.text, segment.start, segment.end, segment.heading)
      );
      continue;
    }

    const windows = fixedWindowOffsets(segment.text, maxChars, overlapChars);
    let first = true;
    for (const window of windows) {
      const end = adjustToBoundary(segment.text, window.start, window.end);
      const slice = segment.text.slice(window.start, end).trim();
      if (slice.length === 0) continue;
      chunks.push(
        makeChunk(
          sourceId,
          ordinal++,
          slice,
          segment.start + window.start,
          segment.start + end,
          first ? segment.heading : undefined
        )
      );
      first = false;
    }
  }

  return chunks;
}

/** Plain text / yaml / unknown: fixed windows with overlap + boundary break. */
function chunkPlainText(
  text: string,
  sourceId: string,
  maxChars: number,
  overlapChars: number
): SourceChunk[] {
  if (text.trim().length === 0) return [];
  const windows = fixedWindowOffsets(text, maxChars, overlapChars);
  const chunks: SourceChunk[] = [];
  let ordinal = 0;
  for (const window of windows) {
    const end = adjustToBoundary(text, window.start, window.end);
    const slice = text.slice(window.start, end).trim();
    if (slice.length === 0) continue;
    chunks.push(makeChunk(sourceId, ordinal++, slice, window.start, end));
  }
  return chunks;
}

/**
 * Markdown: split on ATX headings (^#{1..6} space). Text before the first
 * heading becomes an un-headed preamble section. Each section carries its
 * heading forward; oversized sections are split via buildChunksFromSegments.
 */
function chunkMarkdown(
  text: string,
  sourceId: string,
  maxChars: number,
  overlapChars: number
): SourceChunk[] {
  const headingRe = /^(#{1,6})\s+(.+?)\s*$/gm;
  const positions: { index: number; heading: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(text)) !== null) {
    positions.push({ index: match.index, heading: match[2].trim() });
  }

  if (positions.length === 0) {
    return chunkPlainText(text, sourceId, maxChars, overlapChars);
  }

  const segments: { text: string; start: number; end: number; heading?: string }[] = [];

  if (positions[0].index > 0) {
    const preamble = text.slice(0, positions[0].index).trim();
    if (preamble.length > 0) {
      segments.push({ text: preamble, start: 0, end: positions[0].index });
    }
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index;
    const end = i + 1 < positions.length ? positions[i + 1].index : text.length;
    const sectionText = text.slice(start, end).trim();
    if (sectionText.length > 0) {
      segments.push({ text: sectionText, start, end, heading: positions[i].heading });
    }
  }

  return buildChunksFromSegments(sourceId, segments, maxChars, overlapChars);
}

/**
 * JSON: array -> one chunk per element (serialized); object -> one chunk per
 * top-level key/value; primitive/empty -> fixed window over the raw text.
 *
 * Element offsets cannot be cheaply mapped back into the original source
 * string, so per-element chunks record the full-document span; the stable
 * chunk id remains the durable locator and citations resolve by id.
 */
function chunkJson(
  text: string,
  sourceId: string,
  maxChars: number,
  overlapChars: number
): SourceChunk[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // classifyCandidate already rejected malformed JSON; stay bounded here.
    return chunkPlainText(text, sourceId, maxChars, overlapChars);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const chunks: SourceChunk[] = [];
    for (let i = 0; i < value.length; i++) {
      const serialized = JSON.stringify(value[i]);
      chunks.push(makeChunk(sourceId, i, serialized, 0, text.length));
    }
    return chunks;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [];
    const chunks: SourceChunk[] = [];
    let ordinal = 0;
    for (const [key, val] of entries) {
      const serialized = JSON.stringify({ [key]: val });
      chunks.push(makeChunk(sourceId, ordinal++, serialized, 0, text.length));
    }
    return chunks;
  }

  return chunkPlainText(text, sourceId, maxChars, overlapChars);
}

/**
 * CSV: chunk on row-group boundaries. ~CSV_GROUP_ROWS rows OR when the running
 * body length would exceed maxChars, whichever first. The header line (first
 * line) is prepended to every chunk so each is self-describing.
 */
function chunkCsv(
  text: string,
  sourceId: string,
  maxChars: number
): SourceChunk[] {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];
  if (lines.length === 1 && lines[0].trim() === "") return [];

  const header = lines[0];
  const dataLines = lines.slice(1).filter((line) => line.length > 0);
  if (dataLines.length === 0) {
    return [makeChunk(sourceId, 0, header, 0, text.length)];
  }

  const chunks: SourceChunk[] = [];
  let ordinal = 0;
  let group: string[] = [];
  let groupStart = header.length + 1;
  let cursor = header.length + 1;

  const flushGroup = (groupEnd: number) => {
    if (group.length === 0) return;
    const body = `${header}\n${group.join("\n")}`;
    chunks.push(makeChunk(sourceId, ordinal++, body, groupStart, groupEnd));
    group = [];
  };

  for (const line of dataLines) {
    const projectedLength = `${header}\n${[...group, line].join("\n")}`.length;
    if (group.length >= CSV_GROUP_ROWS || (group.length > 0 && projectedLength > maxChars)) {
      flushGroup(cursor);
      groupStart = cursor;
    }
    group.push(line);
    cursor += line.length + 1;
  }
  flushGroup(cursor);

  return chunks;
}

/** Map a MIME type to the canonical extracted type (unknown -> text). */
export function mimeToType(mimeType?: string): ExtractedType {
  if (!mimeType) return "text";
  const bare = mimeType.split(";")[0].trim().toLowerCase();
  switch (bare) {
    case "text/markdown":
    case "text/x-markdown":
      return "markdown";
    case "application/json":
    case "text/json":
      return "json";
    case "text/csv":
    case "application/csv":
      return "csv";
    case "application/yaml":
    case "text/yaml":
    case "text/x-yaml":
      return "yaml";
    default:
      return "text";
  }
}

/**
 * Structure-aware chunker. Entry point. Returns `SourceChunk`s with stable ids
 * (`${sourceId}#${ordinal}`) and offsets into the original `text`.
 *
 * `type` may be supplied directly (preferred — `classifyCandidate` resolves
 * it) or inferred from `mimeType`. When neither yields a known structural type,
 * plain-text chunking is used. Returns [] for empty/whitespace-only text.
 */
export function chunkSourceText(text: string, options: ChunkOptions): SourceChunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  const type = options.type ?? mimeToType(options.mimeType);

  if (text.trim().length === 0) return [];

  switch (type) {
    case "markdown":
      return chunkMarkdown(text, options.sourceId, maxChars, overlapChars);
    case "json":
      return chunkJson(text, options.sourceId, maxChars, overlapChars);
    case "csv":
      return chunkCsv(text, options.sourceId, maxChars);
    default:
      return chunkPlainText(text, options.sourceId, maxChars, overlapChars);
  }
}
