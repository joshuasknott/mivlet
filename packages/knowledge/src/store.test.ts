import { describe, expect, it } from "vitest";
import type {
  KnowledgeSource,
  MemoryRecord,
  PinnedContextEntry,
  SourceChunk
} from "@fable/protocol";
import { GLOBAL_SCOPE } from "@fable/protocol";
import {
  createKnowledgeStore,
  emptyKnowledgeStoreState,
  isLiveMemory,
  isLiveSource,
  scopeSatisfies,
  scopesMatch
} from "./store";

function makeSource(overrides: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: "s1",
    title: "Source one",
    kind: "document",
    connectorId: "local-files",
    provenance: "Local file - 1.0 KB",
    freshness: "Imported now",
    pinned: false,
    ...overrides
  };
}

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1",
    kind: "fact",
    title: "Prefers concise answers",
    value: "The user prefers concise answers.",
    source: "chat",
    freshness: "Today",
    approved: true,
    pinned: false,
    ...overrides
  };
}

function makeChunk(sourceId: string, ordinal: number): SourceChunk {
  return {
    id: `${sourceId}#${ordinal}`,
    sourceId,
    ordinal,
    text: `chunk ${ordinal}`,
    contentHash: `hash-${sourceId}-${ordinal}`,
    charStart: ordinal * 10,
    charEnd: ordinal * 10 + 10
  };
}

describe("knowledge store", () => {
  it("upserts sources and chunks and reads them back", () => {
    const store = createKnowledgeStore();
    store.upsertSource({ source: makeSource(), chunks: [makeChunk("s1", 0), makeChunk("s1", 1)] });

    expect(store.sources()).toHaveLength(1);
    expect(store.source("s1")?.title).toBe("Source one");
    expect(store.chunks("s1")).toHaveLength(2);
  });

  it("removing a source drops its chunks and pinned entries", () => {
    const store = createKnowledgeStore();
    store.upsertSource({ source: makeSource(), chunks: [makeChunk("s1", 0)] });
    const pinned: PinnedContextEntry = {
      id: "p1",
      scope: GLOBAL_SCOPE,
      sourceId: "s1",
      pinnedAt: "2026-06-28T00:00:00.000Z"
    };
    store.pin(pinned);

    store.removeSource("s1");

    expect(store.sources()).toHaveLength(0);
    expect(store.chunks("s1")).toHaveLength(0);
    expect(store.pinned(GLOBAL_SCOPE)).toHaveLength(0);
  });

  it("excludes disabled sources from the live read path", () => {
    const store = createKnowledgeStore();
    store.upsertSource({ source: makeSource({ disabled: true }) });

    expect(store.sources()).toHaveLength(0);
    // The source still exists by id so the caller can inspect/restore it.
    expect(store.source("s1")?.disabled).toBe(true);
    expect(isLiveSource(makeSource({ disabled: true }))).toBe(false);
  });

  it("excludes forgotten memories from the live read path", () => {
    const store = createKnowledgeStore();
    store.upsertMemory(makeMemory({ forgottenAt: "2026-06-28T00:00:00.000Z" }));

    expect(store.memories()).toHaveLength(0);
    expect(store.memory("m1")?.forgottenAt).toBeTruthy();
    expect(isLiveMemory(makeMemory({ forgottenAt: "x" }))).toBe(false);
  });

  it("removing a memory drops its pinned entries", () => {
    const store = createKnowledgeStore();
    store.upsertMemory(makeMemory());
    store.pin({
      id: "p1",
      scope: GLOBAL_SCOPE,
      memoryId: "m1",
      pinnedAt: "2026-06-28T00:00:00.000Z"
    });

    store.removeMemory("m1");

    expect(store.memories()).toHaveLength(0);
    expect(store.pinned(GLOBAL_SCOPE)).toHaveLength(0);
  });

  it("pins and unpins context within a scope", () => {
    const store = createKnowledgeStore();
    const entry: PinnedContextEntry = {
      id: "p1",
      scope: { level: "project", projectId: "proj" },
      sourceId: "s1",
      pinnedAt: "2026-06-28T00:00:00.000Z"
    };
    store.pin(entry);

    expect(store.pinned({ level: "project", projectId: "proj" })).toHaveLength(1);
    expect(store.pinned({ level: "project", projectId: "other" })).toHaveLength(0);

    store.unpin("p1");
    expect(store.pinned({ level: "project", projectId: "proj" })).toHaveLength(0);
  });

  it("export returns live sources and live memories only", () => {
    const store = createKnowledgeStore();
    store.upsertSource({ source: makeSource() });
    store.upsertSource({ source: makeSource({ id: "s2", disabled: true }) });
    store.upsertMemory(makeMemory());
    store.upsertMemory(makeMemory({ id: "m2", forgottenAt: "x" }));

    const exported = store.export();
    expect(exported.sources.map((s) => s.id)).toEqual(["s1"]);
    expect(exported.memories.map((m) => m.id)).toEqual(["m1"]);
  });

  it("snapshot round-trips through a fresh store", () => {
    const store = createKnowledgeStore();
    store.upsertSource({ source: makeSource(), chunks: [makeChunk("s1", 0)] });
    store.upsertMemory(makeMemory());

    const snap = store.snapshot();
    const restored = createKnowledgeStore(snap);

    expect(restored.sources()).toHaveLength(1);
    expect(restored.chunks("s1")).toHaveLength(1);
    expect(restored.memories()).toHaveLength(1);
  });

  it("emptyKnowledgeStoreState is a clean baseline", () => {
    const snap = emptyKnowledgeStoreState();
    expect(snap.sources).toEqual([]);
    expect(snap.memories).toEqual([]);
    expect(snap.pinned).toEqual([]);
  });

  it("can disable and re-enable sources to hide/reveal them", () => {
    const store = createKnowledgeStore();
    const source = makeSource();
    store.upsertSource({ source });
    expect(store.sources()).toHaveLength(1);

    // Disable
    store.upsertSource({ source: { ...source, disabled: true } });
    expect(store.sources()).toHaveLength(0);
    expect(store.source(source.id)?.disabled).toBe(true);

    // Re-enable
    store.upsertSource({ source: { ...source, disabled: false } });
    expect(store.sources()).toHaveLength(1);
    expect(store.source(source.id)?.disabled).toBe(false);
  });

  it("handles deleted cache by initializing and restoring from an empty snapshot", () => {
    const store = createKnowledgeStore();
    store.upsertSource({ source: makeSource(), chunks: [makeChunk("s1", 0)] });
    store.upsertMemory(makeMemory());
    expect(store.sources()).toHaveLength(1);

    // Delete cache / empty snap
    const emptySnap = emptyKnowledgeStoreState();
    const restored = createKnowledgeStore(emptySnap);
    expect(restored.sources()).toHaveLength(0);
    expect(restored.memories()).toHaveLength(0);
    expect(restored.pinned(GLOBAL_SCOPE)).toHaveLength(0);
  });
});

describe("scope helpers", () => {
  it("global scope satisfies every run scope", () => {
    expect(scopeSatisfies(GLOBAL_SCOPE, GLOBAL_SCOPE)).toBe(true);
    expect(scopeSatisfies(GLOBAL_SCOPE, { level: "project", projectId: "p" })).toBe(true);
    expect(scopeSatisfies(GLOBAL_SCOPE, { level: "thread", threadId: "t", projectId: "p" })).toBe(true);
  });

  it("project scope is satisfied only by a matching project/thread run", () => {
    const projectScope = { level: "project" as const, projectId: "p" };
    expect(scopeSatisfies(projectScope, GLOBAL_SCOPE)).toBe(false);
    expect(scopeSatisfies(projectScope, { level: "project", projectId: "p" })).toBe(true);
    expect(scopeSatisfies(projectScope, { level: "project", projectId: "other" })).toBe(false);
    expect(scopeSatisfies(projectScope, { level: "thread", threadId: "t", projectId: "p" })).toBe(true);
  });

  it("thread scope is satisfied only by the same thread", () => {
    const threadScope = { level: "thread" as const, threadId: "t", projectId: "p" };
    expect(scopeSatisfies(threadScope, GLOBAL_SCOPE)).toBe(false);
    expect(scopeSatisfies(threadScope, { level: "project", projectId: "p" })).toBe(false);
    expect(scopeSatisfies(threadScope, { level: "thread", threadId: "t", projectId: "p" })).toBe(true);
    expect(scopesMatch(threadScope, { level: "thread", threadId: "t", projectId: "p" })).toBe(true);
  });
});
