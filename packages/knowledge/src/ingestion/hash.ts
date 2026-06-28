/**
 * Content hashing + text normalization for the ingestion pipeline.
 *
 * Deterministic and SYNCHRONOUS — the pipeline never awaits a hash, so re-
 * indexing identical content always produces the same source id and the same
 * chunk content hashes (dedup + stable citations). We deliberately reimplement
 * the FNV-1a 64-bit pattern the local-files connector already uses
 * (`localFileFingerprint`) rather than import it, to keep the knowledge package
 * free of a cross-package connector dependency. No `node:crypto`, no global
 * `crypto.subtle` (that is async anyway).
 *
 * FNV-1a 64-bit is not cryptographically strong, but the pipeline only needs a
 * collision-resistant-enough fingerprint for content dedup within a workspace,
 * and it has the huge advantage of being pure, sync, and dependency-free.
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

/**
 * FNV-1a 64-bit over a UTF-8 byte stream, returned as 16-char lowercase hex.
 * Stable across processes and platforms (BigInt math is deterministic here).
 */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * FNV_PRIME) & U64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Normalize text before hashing so equivalent content collapses to one
 * fingerprint:
 *   - all whitespace runs (including newlines, CRLF, tabs) collapsed to a
 *     single space
 *   - leading/trailing whitespace removed
 *
 * Whitespace-only differences (indent style, trailing spaces, line wrapping,
 * CRLF vs LF) MUST NOT produce a different source id — that is the whole point
 * of the normalize step. Unicode/letter content is preserved unchanged.
 *
 * Note: this is the FINGERPRINT normalizer only. Structure-aware chunking
 * operates on the ORIGINAL candidate text (preserving newlines/headings) so
 * chunk charStart/charEnd and heading detection stay accurate.
 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Content hash of a chunk/source. Computed over the NORMALIZED text so
 * whitespace-equivalent content hashes identically (dedup + stable ids).
 */
export function contentHash(text: string): string {
  return fnv1a64(normalizeText(text));
}

/**
 * URL/file-safe slug derived from arbitrary text. Used to make source ids
 * human-readable while remaining filesystem/URL-safe. Non-alphanumeric runs
 * collapse to a single `-`, trimmed and lower-cased.
 */
export function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
