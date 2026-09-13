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
  ContextRecordAuthorityScope,
  KnowledgeScope,
  KnowledgeSource,
  MemoryRecord,
  PinnedContextEntry,
  ExecutionContextAudience,
  SourceChunk
} from "@fable/protocol";
import { GLOBAL_SCOPE } from "@fable/protocol";

/** True when a memory record is live (not forgotten/disabled). */
export function isLiveMemory(record: MemoryRecord): boolean {
  return !record.forgottenAt && !record.disabled;
}

/** True when a source is live (not disabled and not in an error-excluded state). */
export function isLiveSource(source: KnowledgeSource): boolean {
  return !source.disabled && !source.deletedAt;
}

/**
 * Whether a record may enter context for an explicit run audience. Omitted
 * audiences retain the legacy non-run behavior; supplied audiences fail closed
 * for absent or malformed ownership.
 */
export function authorityScopeAllowsAudience(
  authorityScope: ContextRecordAuthorityScope | undefined,
  audience?: ExecutionContextAudience
): boolean {
  if (!audience) return true;
  const actingMemberId = audience.actingMemberId?.trim();
  const actingInternalUserId = audience.actingInternalUserId?.trim();
  const hasOneActor = Boolean(actingMemberId) !== Boolean(actingInternalUserId);
  if (!hasOneActor) return false;

  const sharedAudience =
    audience.authority === "convex" &&
    audience.visibility === "workspace-shared" &&
    Boolean(actingMemberId) &&
    !actingInternalUserId;
  const privateAudience = audience.authority === "local" && audience.visibility === "member-private";
  if (!sharedAudience && !privateAudience) return false;
  if (!authorityScope) return false;

  const sharedRecord =
    authorityScope.authority === "convex" &&
    authorityScope.visibility === "workspace-shared" &&
    authorityScope.ownerMemberId === undefined &&
    authorityScope.ownerInternalUserId === undefined;
  if (sharedRecord) return true;

  const ownerMemberId = authorityScope.ownerMemberId?.trim();
  const ownerInternalUserId = authorityScope.ownerInternalUserId?.trim();
  const privateRecord =
    authorityScope.authority === "local" &&
    authorityScope.visibility === "member-private" &&
    Boolean(ownerMemberId) !== Boolean(ownerInternalUserId);
  return privateAudience && privateRecord && (
    (Boolean(ownerMemberId) && ownerMemberId === actingMemberId) ||
    (Boolean(ownerInternalUserId) && ownerInternalUserId === actingInternalUserId)
  );
}

function scopeIdKey(level: Exclude<KnowledgeScope["level"], "global">): "threadId" | "agentId" | "projectId" | "workId" {
  return { thread: "threadId", agent: "agentId", project: "projectId", work: "workId" }[level] as "threadId" | "agentId" | "projectId" | "workId";
}

/** Two scopes are the same effective scope. */
export function scopesMatch(a: KnowledgeScope, b: KnowledgeScope): boolean {
  if (a.level !== b.level) return false;
  if (a.level === "global") return true;
  const key = scopeIdKey(a.level);
  return Boolean(a[key]) && a[key] === b[key];
}

/**
 * Whether `entry` scope is satisfied by `run` scope. A tighter entry scope is
 * satisfied by a matching run scope; global entries satisfy every run. The
 * context assembler uses this so thread-scoped material never leaks into a
 * global run.
 */
export function scopeSatisfies(entry: KnowledgeScope, run: KnowledgeScope): boolean {
  if (entry.level === "global") return true;
  const key = scopeIdKey(entry.level);
  return Boolean(entry[key]) && entry[key] === run[key];
}

/**
 * The persistence repository the knowledge layer reads and writes through.
 * Every read path MUST exclude forgotten memories and disabled/error sources
 * so deleted/disabled/stale material can never enter a run. The store is the
 * single chokepoint for that exclusion — callers do not re-filter.
 */
export interface KnowledgeStore {
  readonly workspaceId: string;
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

  // -- export --------------------------------------------------------------
  /** Full export (sources + live memories) for the export action. */
  export(): { workspaceId: string; disabledRecordsIncluded: false; forgottenRecordsIncluded: false; sources: KnowledgeSource[]; memories: MemoryRecord[] };
}

/** Serializable shape of the default store, for snapshot round-trips. */
export interface KnowledgeStoreState {
  /** Missing in legacy snapshots; normalized to the active workspace on load. */
  workspaceId?: string;
  sources: KnowledgeSource[];
  chunksBySource: Record<string, SourceChunk[]>;
  memories: MemoryRecord[];
  pinned: PinnedContextEntry[];
  deletedSourceIds: string[];
  forgottenMemoryIds: string[];
}

export function emptyKnowledgeStoreState(workspaceId: string): KnowledgeStoreState {
  assertWorkspaceId(workspaceId);
  return {
    workspaceId,
    sources: [],
    chunksBySource: {},
    memories: [],
    pinned: [],
    deletedSourceIds: [],
    forgottenMemoryIds: []
  };
}

/**
 * The default store: an in-memory structured map that serializes to
 * `KnowledgeStoreState`. The desktop shell wraps it for snapshot/localStorage
 * round-trips; Goal 5 swaps in an encrypted SQLite impl of `KnowledgeStore`.
 */
export function createKnowledgeStore(
  workspaceId: string,
  initial: KnowledgeStoreState = emptyKnowledgeStoreState(workspaceId)
): KnowledgeStore & { snapshot(): KnowledgeStoreState } {
  assertWorkspaceId(workspaceId);
  if (initial.workspaceId && initial.workspaceId !== workspaceId) {
    throw new Error("Knowledge snapshot belongs to another workspace.");
  }
  const owns = (owner?: string) => !owner || owner === workspaceId;
  if (
    !initial.sources.every((source) => owns(source.workspaceId)) ||
    !initial.memories.every((memory) => owns(memory.workspaceId)) ||
    !initial.pinned.every((entry) => owns(entry.workspaceId)) ||
    !Object.values(initial.chunksBySource).flat().every((chunk) => owns(chunk.workspaceId))
  ) {
    throw new Error("Knowledge snapshot contains cross-workspace records.");
  }
  const state: KnowledgeStoreState = {
    workspaceId,
    sources: initial.sources.map((source) => ({ ...source, workspaceId })),
    chunksBySource: Object.fromEntries(
      Object.entries(initial.chunksBySource).map(([id, chunks]) => [
        id,
        chunks.map((chunk) => ({ ...chunk, workspaceId }))
      ])
    ),
    memories: initial.memories.map((memory) => ({ ...memory, workspaceId })),
    pinned: initial.pinned.map((entry) => ({ ...entry, workspaceId })),
    deletedSourceIds: [...(initial.deletedSourceIds ?? [])],
    forgottenMemoryIds: [...(initial.forgottenMemoryIds ?? [])]
  };

  return {
    workspaceId,
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
      if (!owns(source.workspaceId) || chunks.some((chunk) => !owns(chunk.workspaceId))) {
        throw new Error("Knowledge source belongs to another workspace.");
      }
      if (state.deletedSourceIds.includes(source.id)) {
        throw new Error("Deleted knowledge cannot be restored by a background import.");
      }
      const ownedSource = { ...source, workspaceId };
      const ownedChunks = chunks.map((chunk) => ({ ...chunk, workspaceId }));
      const index = state.sources.findIndex((existing) => existing.id === source.id);
      if (index >= 0) {
        state.sources[index] = ownedSource;
      } else {
        state.sources.push(ownedSource);
      }
      state.chunksBySource[source.id] = ownedChunks;
    },
    removeSource(id) {
      state.sources = state.sources.filter((source) => source.id !== id);
      delete state.chunksBySource[id];
      state.pinned = state.pinned.filter(
        (entry) => entry.sourceId !== id
      );
      if (!state.deletedSourceIds.includes(id)) state.deletedSourceIds.push(id);
    },
    memories() {
      return state.memories.filter(isLiveMemory);
    },
    memory(id) {
      return state.memories.find((memory) => memory.id === id);
    },
    upsertMemory(record) {
      if (!owns(record.workspaceId)) throw new Error("Memory belongs to another workspace.");
      if (state.forgottenMemoryIds.includes(record.id) && !record.forgottenAt) {
        throw new Error("Forgotten memory cannot be restored by a background write.");
      }
      if (record.forgottenAt && !state.forgottenMemoryIds.includes(record.id)) {
        state.forgottenMemoryIds.push(record.id);
      }
      const ownedRecord = { ...record, workspaceId };
      const index = state.memories.findIndex((existing) => existing.id === record.id);
      if (index >= 0) {
        state.memories[index] = ownedRecord;
      } else {
        state.memories.push(ownedRecord);
      }
    },
    removeMemory(id) {
      state.memories = state.memories.filter((memory) => memory.id !== id);
      state.pinned = state.pinned.filter(
        (entry) => entry.memoryId !== id
      );
      if (!state.forgottenMemoryIds.includes(id)) state.forgottenMemoryIds.push(id);
    },
    pinned(scope) {
      if (scope.level === "global") {
        return state.pinned.filter((entry) => scopeSatisfies(entry.scope, GLOBAL_SCOPE));
      }
      return state.pinned.filter((entry) => scopeSatisfies(entry.scope, scope));
    },
    pin(entry) {
      if (!owns(entry.workspaceId)) throw new Error("Pinned context belongs to another workspace.");
      entry = { ...entry, workspaceId };
      const exists = state.pinned.some((existing) => existing.id === entry.id);
      if (!exists) state.pinned.push(entry);
    },
    unpin(id) {
      state.pinned = state.pinned.filter((entry) => entry.id !== id);
    },
    export() {
      return {
        workspaceId,
        disabledRecordsIncluded: false,
        forgottenRecordsIncluded: false,
        sources: state.sources.filter(isLiveSource).sort((a, b) => a.id.localeCompare(b.id)),
        memories: state.memories.filter(isLiveMemory).sort((a, b) => a.id.localeCompare(b.id))
      };
    },
    snapshot() {
      return {
        workspaceId,
        sources: [...state.sources],
        chunksBySource: { ...state.chunksBySource },
        memories: [...state.memories],
        pinned: [...state.pinned],
        deletedSourceIds: [...state.deletedSourceIds],
        forgottenMemoryIds: [...state.forgottenMemoryIds]
      };
    }
  };
}

function assertWorkspaceId(workspaceId: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(workspaceId)) {
    throw new Error("A valid workspace id is required.");
  }
}
