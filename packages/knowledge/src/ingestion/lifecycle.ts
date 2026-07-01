/**
 * Pure source-lifecycle helpers: disable / enable / soft-state transitions.
 *
 * These are immutable transitions — they return an updated copy of the source
 * and never mutate the input. Disabling is a soft exclusion (the source record
 * stays manageable, but is excluded from retrieval); deletion (hard remove)
 * is performed by the store. This keeps disable/enable as reversible operations
 * the Knowledge page can drive without losing the source record.
 */

import type { KnowledgeSource, SourceStatus } from "@fable/protocol";

/**
 * Disable a source: set `disabled: true`. The source record is preserved so it
 * can be re-enabled or inspected, but `isLiveSource` (and thus retrieval)
 * excludes it immediately. Pin references are NOT touched here — the store
 * decides whether to cascade-remove pinned entries on hard delete.
 */
export function disableSource(source: KnowledgeSource): KnowledgeSource {
  return { ...source, disabled: true };
}

/**
 * Re-enable a previously disabled source. Clears the `disabled` flag and
 * restores a healthy status (`ok`) unless the source is in an `error` state,
 * which the caller should clear separately once the underlying problem is fixed.
 */
export function enableSource(source: KnowledgeSource): KnowledgeSource {
  const updated: KnowledgeSource = { ...source };
  delete updated.disabled;
  if (updated.status === "stale") {
    updated.status = "ok";
    delete updated.statusMessage;
  }
  return updated;
}

/**
 * Mark a source as `indexing` (in-progress). Used when a refresh/re-embed is
 * underway. Retrieval excludes `indexing` sources until the work completes and
 * the caller transitions the status back to `ok`.
 */
export function markIndexing(source: KnowledgeSource): KnowledgeSource {
  return { ...source, status: "indexing" };
}

/**
 * Mark a source as `ok` (healthy). Clears an `indexing`/`stale` status and any
 * associated status message. Does not change an `error` status unless
 * `clearError` is true.
 */
export function markHealthy(source: KnowledgeSource, clearError = false): KnowledgeSource {
  const updated: KnowledgeSource = { ...source, status: "ok" };
  delete updated.statusMessage;
  if (!clearError && source.status === "error") {
    updated.status = source.status as SourceStatus;
    if (source.statusMessage) updated.statusMessage = source.statusMessage;
  }
  return updated;
}

/**
 * Mark a source as failed (`error`) with an explanatory message. The source
 * stays in the store (manageable) but retrieval excludes `error` sources.
 */
export function markFailed(source: KnowledgeSource, message: string): KnowledgeSource {
  return { ...source, status: "error", statusMessage: message };
}
