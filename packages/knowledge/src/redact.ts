/**
 * Knowledge-boundary secret redaction.
 *
 * Previews and chunks are scrubbed with the shared protocol vocabulary before
 * they are stored and again before they enter model context. Surgical
 * replacement keeps surrounding prose; a surviving marker fails closed to the
 * shared omit sentinel.
 */

import type { KnowledgeSource, SourceChunk } from "@fable/protocol";
import { redactSecretTextOrOmit } from "@fable/protocol";
import { contentHash } from "./ingestion/hash";

/** Redact secret-shaped spans, or omit the whole string if a marker remains. */
export function redactKnowledgeText(value: string): string {
  return redactSecretTextOrOmit(value);
}

/** Redact a stored/reused source preview without changing identity fields. */
export function redactKnowledgeSourcePreview(source: KnowledgeSource): KnowledgeSource {
  if (!source.contentPreview) return source;
  const contentPreview = redactSecretTextOrOmit(source.contentPreview);
  if (contentPreview === source.contentPreview) return source;
  return { ...source, contentPreview };
}

/**
 * Redact chunk text that will be stored or scored. Offsets stay on the
 * original slice so citations still point at the source window; the stored
 * hash follows the redacted text.
 */
export function redactKnowledgeChunk(chunk: SourceChunk): SourceChunk {
  const text = redactSecretTextOrOmit(chunk.text);
  if (text === chunk.text) return chunk;
  return { ...chunk, text, contentHash: contentHash(text) };
}

export function redactKnowledgeChunks(chunks: SourceChunk[]): SourceChunk[] {
  return chunks.map(redactKnowledgeChunk);
}
