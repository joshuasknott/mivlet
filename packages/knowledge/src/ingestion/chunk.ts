/**
 * Structure-aware chunking.
 *
 * Each chunk is a slice of the ORIGINAL text with `charStart`/`charEnd` that
 * index back into it (so citations resolve to an exact location), a stable id
 * (`${sourceId}#${ordinal}`, ordinal from 0), a content hash of the chunk text,
 * and the nearest heading when the source was chunked by structure.
 *
 * Per type:
 *   - markdown: split on ATX headings (^#{1..6} space) OUTSIDE fenced code
 *     blocks, so a `# ...` line inside a ``` fence stays code, not a heading;
 *     each section is one chunk carrying its heading; oversized sections
 *     further split on paragraph then fixed-window boundaries.
 *   - json: top-level array -> each element serialized is a chunk; object ->
 *     each top-level key/value is a chunk; primitives -> fixed window.
 *   - csv: row-group boundaries (~50 rows or maxChars, whichever first), with
 *     the header line prepended to every chunk.
 *   - text/other/yaml: fixed window of maxChars with overlapChars overlap,
 *     breaking on sentence/paragraph boundaries where possible.
 *
 * Boundaries are aligned to UTF-16 code points: a window never splits a
 * surrogate pair, so an emoji at a chunk edge survives intact instead of
 * corrupting into lone surrogates.
 *
 * Bounded: the loop is driven by finite input, never unbounded.
 */

import type { SourceChunk } from "@mivlet/protocol";
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
 * UTF-16 helper predicates. Chunk boundaries are code-unit indices; a boundary
 * that lands between the two halves of a surrogate pair would emit a lone
 * surrogate (a corrupted character). Alignment below refuses that.
 */
function isHighSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Push an END boundary right one code unit when it splits a surrogate pair, so
 * the low surrogate stays with its high surrogate in the current window.
 * Returns `end` unchanged for lone surrogates (malformed input) and for
 * boundaries that do not fall inside a pair.
 */
function alignEndBoundary(text: string, end: number): number {
  if (end > 0 && end < text.length && isLowSurrogate(text, end) && isHighSurrogate(text, end - 1)) {
    return end + 1;
  }
  return end;
}

/**
 * Push a START boundary right one code unit when it splits a surrogate pair.
 * The high surrogate at `start - 1` is always already covered by the previous
 * window (every window end is aligned and the next start never exceeds it), so
 * skipping the low surrogate never drops content.
 */
function alignStartBoundary(text: string, start: number): number {
  if (start > 0 && start < text.length && isLowSurrogate(text, start) && isHighSurrogate(text, start - 1)) {
    return start + 1;
  }
  return start;
}

/**
 * Fixed-window offsets over `text`, stepping by `maxChars - overlapChars`.
 * Always finite (bounded by text length). overlap is clamped so step >= 1.
 * Both window ends and starts are aligned so they never split a surrogate pair.
 */
function fixedWindowOffsets(
  text: string,
  maxChars: number,
  overlapChars: number
): { start: number; end: number }[] {
  const windows: { start: number; end: number }[] = [];
  if (text.length === 0) return windows;

  const safeOverlap = Math.min(overlapChars, maxChars - 1);
  let start = 0;
  while (start < text.length) {
    const end = alignEndBoundary(
      text,
      Math.max(start + 1, adjustToBoundary(text, start, Math.min(start + maxChars, text.length)))
    );
    windows.push({ start, end });
    if (end >= text.length) break;
    // Advance from the actual boundary, otherwise shortening a window can
    // leave an unindexed gap before the next fixed start. Aligning the start
    // only ever pushes right (past a low surrogate whose pair was already
    // covered), so progress toward the end of the text is guaranteed.
    start = alignStartBoundary(text, Math.max(start + 1, end - safeOverlap));
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
      const end = window.end;
      const slice = segment.text.slice(window.start, end);
      if (slice.trim().length === 0) continue;
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
    const end = window.end;
    const slice = text.slice(window.start, end);
    if (slice.trim().length === 0) continue;
    chunks.push(makeChunk(sourceId, ordinal++, slice, window.start, end));
  }
  return normalizeChunkList(chunks, sourceId, maxChars, overlapChars, true, text);
}

/**
 * Locate ATX heading positions (`^#{1..6} space`) that appear OUTSIDE fenced
 * code blocks, so a `# ...` line inside a ``` or ~~~ fence stays code rather
 * than being treated as a heading. Fences open on a line of 3+ backticks or
 * tildes (with optional trailing info string) and close on a line of the same
 * fence char repeated at least the opening run length. Returns absolute char
 * offsets into `text` in document order.
 */
function findAtxHeadings(text: string): { index: number; heading: string }[] {
  const positions: { index: number; heading: string }[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let fence: { char: string; length: number } | null = null;

  for (const line of lines) {
    // CRLF: strip the `\r` for line semantics but keep it in `offset`, so
    // offsets stay exact against the original text.
    const raw = line.replace(/\r$/, "");
    const first = raw.charAt(0);

    if (fence) {
      // A closing fence must be a run of the same char (optionally indented).
      if (first === fence.char || first === " ") {
        const closing = new RegExp(`^\\s{0,3}${fence.char}{${fence.length},}\\s*$`);
        if (closing.test(raw)) fence = null;
      }
    } else if (first === "`" || first === "~" || first === " ") {
      // A fence opener may carry a trailing info string (e.g. "```ts").
      const opening = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (opening) {
        fence = { char: opening[1][0], length: opening[1].length };
      }
    } else if (first === "#") {
      const heading = raw.match(/^(#{1,6})\s+(.+?)\s*$/);
      if (heading) {
        positions.push({ index: offset, heading: heading[2].trim() });
      }
    }

    offset += line.length + 1;
  }

  return positions;
}

/**
 * Markdown: split on ATX headings outside fenced code blocks. Text before the
 * first heading becomes an un-headed preamble section. Each section carries its
 * heading forward; oversized sections are split via buildChunksFromSegments.
 */
function chunkMarkdown(
  text: string,
  sourceId: string,
  maxChars: number,
  overlapChars: number
): SourceChunk[] {
  const positions = findAtxHeadings(text);

  if (positions.length === 0) {
    return chunkPlainText(text, sourceId, maxChars, overlapChars);
  }

  const segments: { text: string; start: number; end: number; heading?: string }[] = [];

  if (positions[0].index > 0) {
    const preamble = text.slice(0, positions[0].index);
    if (preamble.trim().length > 0) {
      segments.push({ text: preamble, start: 0, end: positions[0].index });
    }
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index;
    const end = i + 1 < positions.length ? positions[i + 1].index : text.length;
    const sectionText = text.slice(start, end);
    if (sectionText.trim().length > 0) {
      segments.push({ text: sectionText, start, end, heading: positions[i].heading });
    }
  }

  return buildChunksFromSegments(sourceId, segments, maxChars, overlapChars);
}

/**
 * JSON: array -> one chunk per element (serialized); object -> one chunk per
 * top-level key/value; primitive/empty -> fixed window over the raw text.
 *
 * Per-element/per-key chunks record real `charStart`/`charEnd` offsets into
 * the original text (located via `locateJsonSpans`), so citations resolve to
 * an exact source location. When positional location fails for any element,
 * that element falls back to a full-document span (the stable chunk id
 * remains the durable locator either way).
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
    const spans = locateJsonSpans(text, value, "array");
    const chunks: SourceChunk[] = [];
    for (let i = 0; i < value.length; i++) {
      const serialized = JSON.stringify(value[i]);
      if (serialized.length === 0) continue;
      const span = spans[i] ?? { start: 0, end: text.length };
      chunks.push(makeChunk(sourceId, chunks.length, serialized, span.start, span.end));
    }
    return normalizeChunkList(chunks, sourceId, maxChars, overlapChars);
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [];
    const spans = locateJsonSpans(text, value, "object");
    const chunks: SourceChunk[] = [];
    for (let i = 0; i < entries.length; i++) {
      const [key, val] = entries[i];
      const serialized = JSON.stringify({ [key]: val });
      if (serialized.length === 0) continue;
      const span = spans[i] ?? { start: 0, end: text.length };
      chunks.push(makeChunk(sourceId, chunks.length, serialized, span.start, span.end));
    }
    return normalizeChunkList(chunks, sourceId, maxChars, overlapChars);
  }

  return chunkPlainText(text, sourceId, maxChars, overlapChars);
}

/**
 * Locate the `[start,end)` char spans of each top-level array element or
 * object entry within the raw JSON `text`. Returns spans in entry order.
 *
 * Approach: a single forward scan that tracks depth (`[`/`{` vs `]`/`}`),
 * string state (with escapes), and records the span of each depth-1 item
 * (and each top-level object key's value). Bounded by `text.length`.
 */
function locateJsonSpans(
  text: string,
  value: unknown,
  shape: "array" | "object"
): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let depth = 0;
  let itemStart = -1;
  let inString = false;
  let escape = false;
  let topLevelEnd = -1;

  // For object entries: track the key position so a span covers key:value.
  let awaitingKey = shape === "object";
  let keyStart = -1;
  let keyEnd = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
        if (shape === "object" && awaitingKey && depth === 1 && keyStart >= 0) {
          keyEnd = i;
        }
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      if (shape === "object" && awaitingKey && depth === 1 && keyStart < 0) {
        keyStart = i;
      }
      continue;
    }

    if (ch === "[" || ch === "{") {
      if (depth === 0) {
        // entering the container
      } else if (depth === 1 && itemStart < 0) {
        // first nested token of a new item
        itemStart = shape === "object" && keyStart >= 0 ? keyStart : i;
      }
      depth++;
      continue;
    }

    if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        topLevelEnd = i;
      } else if (depth === 1 && itemStart >= 0) {
        spans.push({ start: itemStart, end: i + 1 });
        itemStart = -1;
        if (shape === "object") {
          awaitingKey = true;
          keyStart = -1;
          keyEnd = -1;
        }
      }
      continue;
    }

    // At depth 1, a scalar/colon/comma. For arrays, capture scalar items.
    if (depth === 1) {
      if (shape === "array") {
        if (itemStart < 0 && !/\s|,/.test(ch)) {
          itemStart = i;
        }
        if (itemStart >= 0 && ch === ",") {
          spans.push({ start: itemStart, end: i });
          itemStart = -1;
        }
      } else {
        // object: after a key string and a colon, the value follows.
        if (keyEnd >= 0 && ch === ":" && itemStart < 0) {
          // value begins after this colon at the next non-space char.
          itemStart = keyStart;
        } else if (itemStart >= 0 && ch === ",") {
          spans.push({ start: itemStart, end: i });
          itemStart = -1;
          awaitingKey = true;
          keyStart = -1;
          keyEnd = -1;
        }
      }
    }
  }

  // Flush a trailing item (no comma after the last element).
  if (depth === 1 && itemStart >= 0) {
    // Find the end: last non-whitespace before the closing brace/bracket.
    let end = topLevelEnd >= 0 ? topLevelEnd : text.length;
    while (end > itemStart && /\s/.test(text[end - 1])) end--;
    spans.push({ start: itemStart, end });
  }

  // Guard: span count must match the value's entry count, else discard
  // (caller falls back to full-document span per element).
  const expected = shape === "array" ? (value as unknown[]).length : Object.keys(value as object).length;
  if (spans.length !== expected) return [];
  return spans;
}

/**
 * Post-process a raw chunk list: drop empty/whitespace-only chunks, split any
 * chunk exceeding `maxChars` into bounded windows, and re-assign stable
 * ordinals/ids so the result is deterministic for identical input.
 *
 * `mergeTiny` (default false) additionally merges a trailing tiny chunk
 * (< 25% of maxChars) into the previous chunk. Only used for windowed
 * (plain-text) chunking, NOT for structurally-delimited chunks (JSON
 * elements / YAML keys are intentional units and must not be merged away).
 */
function normalizeChunkList(
  chunks: SourceChunk[],
  sourceId: string,
  maxChars: number,
  overlapChars: number,
  mergeTiny = false,
  originalText?: string
): SourceChunk[] {
  const tinyThreshold = Math.max(1, Math.floor(maxChars * 0.25));

  // Pass 1: drop empty/whitespace-only.
  let cleaned = chunks.filter((c) => c.text.trim().length > 0);

  // Pass 2: split oversized chunks into bounded windows over their own text.
  const expanded: SourceChunk[] = [];
  for (const chunk of cleaned) {
    if (chunk.text.length <= maxChars) {
      expanded.push(chunk);
      continue;
    }
    const base = chunk.charStart;
    const windows = fixedWindowOffsets(chunk.text, maxChars, overlapChars);
    for (const w of windows) {
      const end = w.end;
      const slice = chunk.text.slice(w.start, end).trim();
      if (slice.length === 0) continue;
      expanded.push(
        makeChunk(sourceId, expanded.length, slice, base + w.start, base + end, chunk.heading)
      );
    }
  }

  // Pass 3: merge a trailing tiny chunk into the previous chunk (windowed only).
  cleaned = expanded;
  if (mergeTiny && originalText !== undefined && cleaned.length >= 2) {
    const last = cleaned[cleaned.length - 1];
    const prev = cleaned[cleaned.length - 2];
    const start = Math.min(prev.charStart, last.charStart);
    const end = Math.max(prev.charEnd, last.charEnd);
    if (last.text.length <= tinyThreshold && end - start <= maxChars) {
      const merged = makeChunk(
        sourceId,
        prev.ordinal,
        originalText.slice(start, end),
        start,
        end,
        prev.heading
      );
      cleaned = [...cleaned.slice(0, -2), merged];
    }
  }

  // Pass 4: re-assign deterministic ordinals/ids.
  return cleaned.map((chunk, ordinal) => ({
    ...chunk,
    ordinal,
    id: `${sourceId}#${ordinal}`
  }));
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
    // Header-only CSV produces no useful retrieval chunk — return empty
    // rather than a header-only chunk with no data context.
    return [];
  }

  const chunks: SourceChunk[] = [];
  let ordinal = 0;
  let group: string[] = [];
  // Running length of `group.join("\n")` (sum of line lengths + one separator
  // between each pair), so the projected group length can be measured
  // numerically instead of re-joining the whole accumulating group per line.
  let groupByteLength = 0;
  let groupStart = header.length + 1;
  let cursor = header.length + 1;

  const flushGroup = (groupEnd: number) => {
    if (group.length === 0) return;
    const body = `${header}\n${group.join("\n")}`;
    chunks.push(makeChunk(sourceId, ordinal++, body, groupStart, groupEnd));
    group = [];
    groupByteLength = 0;
  };

  for (const line of dataLines) {
    // projectedLength == header.length + 1 (header/body sep) + groupByteLength + 1
    // (line sep) + line.length — exactly what `${header}\n${[...group,line].join("\n")}`.length was.
    const projectedLength = header.length + 1 + groupByteLength + 1 + line.length;
    if (group.length >= CSV_GROUP_ROWS || (group.length > 0 && projectedLength > maxChars)) {
      flushGroup(cursor);
      groupStart = cursor;
    }
    group.push(line);
    groupByteLength = group.length === 1 ? line.length : groupByteLength + 1 + line.length;
    cursor += line.length + 1;
  }
  flushGroup(cursor);

  return chunks;
}

/**
 * YAML: chunk on document boundaries (`---`) and top-level mapping keys. Each
 * top-level mapping entry (`key:`) becomes one segment spanning from its key
 * line to the next top-level key (or document end), preserving offsets into
 * the original text. Multi-document streams split on `---` separators first.
 *
 * Non-mapping YAML (scalar or sequence root) falls back to plain-text windows.
 * No external dependency — line/regex based and conservative.
 */
function chunkYaml(
  text: string,
  sourceId: string,
  maxChars: number,
  overlapChars: number
): SourceChunk[] {
  if (text.trim().length === 0) return [];

  // Split into documents on leading `---` separators. Each `---` (at column 0)
  // starts a new document; `...` ends one. We track document boundaries by
  // line index so offsets stay accurate against the original text.
  const lines = text.split(/\n/);
  // Keep CR characters when counting offsets into the original Windows text.
  const lineOffsets: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(lineOffsets[i] + lines[i].length + 1);
  }

  // A top-level mapping key: a line at column 0 (no leading whitespace) whose
  // first token is `key:` or `"key":`. Matches inline values too
  // (`name: Mivlet`). Indented keys (nested mappings) are excluded by the `^`
  // anchor requiring col 0.
  const topLevelKey = /^(?:[A-Za-z0-9_.\-]+|"[^"]*"|'[^']*'):(?:\s.*)?$/;

  // Collect segment spans: [startOffset, endOffset] for each top-level entry.
  const segments: { start: number; end: number }[] = [];
  let keyLineIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    // Skip document separators / end markers.
    if (/^---\s*$/.test(raw) || /^\.\.\.\s*$/.test(raw)) continue;
    if (topLevelKey.test(raw)) {
      keyLineIdx.push(i);
    }
  }

  if (keyLineIdx.length === 0) {
    // Not a top-level mapping — fall back to plain text.
    return chunkPlainText(text, sourceId, maxChars, overlapChars);
  }

  for (let k = 0; k < keyLineIdx.length; k++) {
    const startLine = keyLineIdx[k];
    const endLine = k + 1 < keyLineIdx.length ? keyLineIdx[k + 1] : lines.length;
    const start = lineOffsets[startLine];
    // End = start of the line AFTER the segment (exclusive), clamped.
    const end = Math.min(text.length, lineOffsets[endLine]);
    if (end > start) segments.push({ start, end });
  }

  // Build chunks from segments (handles oversized segments via windows).
  const segObjects = segments.map((s) => ({
    text: text.slice(s.start, s.end),
    start: s.start,
    end: s.end
  }));
  return buildChunksFromSegments(sourceId, segObjects, maxChars, overlapChars);
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

  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new RangeError("maxChars must be a positive safe integer");
  }
  if (!Number.isSafeInteger(overlapChars) || overlapChars < 0) {
    throw new RangeError("overlapChars must be a non-negative safe integer");
  }

  if (text.trim().length === 0) return [];

  switch (type) {
    case "markdown":
      return chunkMarkdown(text, options.sourceId, maxChars, overlapChars);
    case "json":
      return chunkJson(text, options.sourceId, maxChars, overlapChars);
    case "csv":
      return chunkCsv(text, options.sourceId, maxChars);
    case "yaml":
      return chunkYaml(text, options.sourceId, maxChars, overlapChars);
    default:
      return chunkPlainText(text, options.sourceId, maxChars, overlapChars);
  }
}
