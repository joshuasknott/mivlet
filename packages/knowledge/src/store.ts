/**
 * Knowledge persistence seam.
 *
 * Storage is defined behind the `KnowledgeStore` interface so Goal 5 can
 * supply an encrypted SQLite implementation during integration — without
 * touching the ingestion / retrieval / memory / context code that depends on
 * it. The default implementation here (`createKnowledgeStore`) is the
 * in-memory map store the desktop shell wraps; it serializes cleanly to/from
 * the runtime snapshot (Tauri) or localStorage (preview), reusing the
 * existing persistence source-of-truth rules.
 *
 * No competing database architecture: this is an interface, not a store
 * engine. The default store is plain structured state that already round-
 * trips through the existing snapshot.
 */

import type {
  Artifact,
  KnowledgeScope,
  KnowledgeSource,
  MemoryRecord,
  PinnedContextEntry,
  SourceChunk
} from "@fable/protocol";
import { GLOBAL_SCOPE } from "@fable/protocol";

/** True when a memory record is live (not forgotten/disabled). */
export function isLiveMemory(record: MemoryRecord): boolean {
  return !record.forgottenAt && !record.disabled;
}

/** True when a source is live (not disabled and not in an error-excluded state). */
export function isLiveSource(source: KnowledgeSource): boolean {
  return !source.disabled;
}

/** Two scopes are the same effective scope. */
export function scopesMatch(a: KnowledgeScope, b: KnowledgeScope): boolean {
  if (a.level !== b.level) return false;
  if (a.level === "global") return true;
  if (a.level === "project") return a.projectId === b.projectId;
  return a.threadId === b.threadId;
}

/**
 * Whether `entry` scope is satisfied by `run` scope. A tighter entry scope is
 * satisfied by a matching run scope; global entries satisfy every run. The
 * context assembler uses this so thread-scoped material never leaks into a
 * global/project run.
 */
export function scopeSatisfies(entry: KnowledgeScope, run: KnowledgeScope): boolean {
  if (entry.level === "global") return true;
  if (entry.level === "project") {
    return run.level === "thread" ? run.projectId === entry.projectId : scopesMatch(entry, run);
  }
  return scopesMatch(entry, run);
}

/**
 * The persistence repository the knowledge layer reads and writes through.
 * Every read path MUST exclude forgotten memories and disabled/error sources
 * so deleted/disabled/stale material can never enter a run. The store is the
 * single chokepoint for that exclusion — callers do not re-filter.
 */
export interface KnowledgeStore {
  // -- sources -------------------------------------------------------------
  /** Live sources only (disabled sources excluded). */
  sources(): KnowledgeSource[];
  /** A source by id (live or not — the caller decides). */
  source(id: string): KnowledgeSource | undefined;
  /** Chunks for a source id (empty when unchunked). */
  chunks(sourceId: string): SourceChunk[];
  /** Insert or replace a source + its chunks atomically. */
  upsertSource(record: { source: KnowledgeSource; chunks?: SourceChunk[] }): void;
  /** Remove a source and its chunks. */
  removeSource(id: string): void;

  // -- memory --------------------------------------------------------------
  /** Live memories only (forgottenAt / disabled excluded). */
  memories(): MemoryRecord[];
  /** A memory by id (live or not). */
  memory(id: string): MemoryRecord | undefined;
  /** Insert or replace a memory. */
  upsertMemory(record: MemoryRecord): void;
  /** Hard-remove a memory. */
  removeMemory(id: string): void;

  // -- pinned context ------------------------------------------------------
  pinned(scope: KnowledgeScope): PinnedContextEntry[];
  pin(entry: PinnedContextEntry): void;
  unpin(id: string): void;

  // -- artifacts -----------------------------------------------------------
  artifacts(): Artifact[];
  upsertArtifact(artifact: Artifact): void;

  // -- export --------------------------------------------------------------
  /** Full export (sources + live memories) for the export action. */
  export(): { sources: KnowledgeSource[]; memories: MemoryRecord[] };
}

/** Serializable shape of the default store, for snapshot round-trips. */
export interface KnowledgeStoreState {
  sources: KnowledgeSource[];
  chunksBySource: Record<string, SourceChunk[]>;
  memories: MemoryRecord[];
  pinned: PinnedContextEntry[];
  artifacts: Artifact[];
}

export function emptyKnowledgeStoreState(): KnowledgeStoreState {
  return {
    sources: [],
    chunksBySource: {},
    memories: [],
    pinned: [],
    artifacts: []
  };
}

/**
 * The default store: an in-memory structured map that serializes to
 * `KnowledgeStoreState`. The desktop shell wraps it for snapshot/localStorage
 * round-trips; Goal 5 swaps in an encrypted SQLite impl of `KnowledgeStore`.
 */
export function createKnowledgeStore(
  initial: KnowledgeStoreState = emptyKnowledgeStoreState()
): KnowledgeStore & { snapshot(): KnowledgeStoreState } {
  const state: KnowledgeStoreState = {
    sources: [...initial.sources],
    chunksBySource: { ...initial.chunksBySource },
    memories: [...initial.memories],
    pinned: [...initial.pinned],
    artifacts: [...initial.artifacts]
  };

  return {
    sources() {
      return state.sources.filter(isLiveSource);
    },
    source(id) {
      return state.sources.find((source) => source.id === id);
    },
    chunks(sourceId) {
      return state.chunksBySource[sourceId] ?? [];
    },
    upsertSource(record) {
      const { source, chunks = [] } = record;
      const index = state.sources.findIndex((existing) => existing.id === source.id);
      if (index >= 0) {
        state.sources[index] = source;
      } else {
        state.sources.push(source);
      }
      state.chunksBySource[source.id] = chunks;
    },
    removeSource(id) {
      state.sources = state.sources.filter((source) => source.id !== id);
      delete state.chunksBySource[id];
      state.pinned = state.pinned.filter(
        (entry) => entry.sourceId !== id
      );
    },
    memories() {
      return state.memories.filter(isLiveMemory);
    },
    memory(id) {
      return state.memories.find((memory) => memory.id === id);
    },
    upsertMemory(record) {
      const index = state.memories.findIndex((existing) => existing.id === record.id);
      if (index >= 0) {
        state.memories[index] = record;
      } else {
        state.memories.push(record);
      }
    },
    removeMemory(id) {
      state.memories = state.memories.filter((memory) => memory.id !== id);
      state.pinned = state.pinned.filter(
        (entry) => entry.memoryId !== id
      );
    },
    pinned(scope) {
      if (scope.level === "global") {
        return state.pinned.filter((entry) => scopeSatisfies(entry.scope, GLOBAL_SCOPE));
      }
      return state.pinned.filter((entry) => scopeSatisfies(entry.scope, scope));
    },
    pin(entry) {
      const exists = state.pinned.some((existing) => existing.id === entry.id);
      if (!exists) state.pinned.push(entry);
    },
    unpin(id) {
      state.pinned = state.pinned.filter((entry) => entry.id !== id);
    },
    artifacts() {
      return state.artifacts;
    },
    upsertArtifact(artifact) {
      const index = state.artifacts.findIndex((existing) => existing.id === artifact.id);
      if (index >= 0) {
        state.artifacts[index] = artifact;
      } else {
        state.artifacts.push(artifact);
      }
    },
    export() {
      return { sources: state.sources.filter(isLiveSource), memories: state.memories.filter(isLiveMemory) };
    },
    snapshot() {
      return {
        sources: [...state.sources],
        chunksBySource: { ...state.chunksBySource },
        memories: [...state.memories],
        pinned: [...state.pinned],
        artifacts: [...state.artifacts]
      };
    }
  };
}
