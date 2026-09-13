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
    const store = createKnowledgeStore("ws-a");
    store.upsertSource({ source: makeSource(), chunks: [makeChunk("s1", 0), makeChunk("s1", 1)] });

    expect(store.sources()).toHaveLength(1);
    expect(store.source("s1")?.title).toBe("Source one");
    expect(store.chunks("s1")).toHaveLength(2);
  });

  it("removing a source drops its chunks and pinned entries", () => {
    const store = createKnowledgeStore("ws-a");
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
    const store = createKnowledgeStore("ws-a");
    store.upsertSource({ source: makeSource({ disabled: true }) });

    expect(store.sources()).toHaveLength(0);
    // The source still exists by id so the caller can inspect/restore it.
    expect(store.source("s1")?.disabled).toBe(true);
    expect(isLiveSource(makeSource({ disabled: true }))).toBe(false);
  });

  it("excludes forgotten memories from the live read path", () => {
    const store = createKnowledgeStore("ws-a");
    store.upsertMemory(makeMemory({ forgottenAt: "2026-06-28T00:00:00.000Z" }));

    expect(store.memories()).toHaveLength(0);
    expect(store.memory("m1")?.forgottenAt).toBeTruthy();
    expect(isLiveMemory(makeMemory({ forgottenAt: "x" }))).toBe(false);
  });

  it("removing a memory drops its pinned entries", () => {
    const store = createKnowledgeStore("ws-a");
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
    const store = createKnowledgeStore("ws-a");
    const entry: PinnedContextEntry = {
      id: "p1",
      scope: { level: "thread", threadId: "thread-1" },
      sourceId: "s1",
      pinnedAt: "2026-06-28T00:00:00.000Z"
    };
    store.pin(entry);

    expect(store.pinned({ level: "thread", threadId: "thread-1" })).toHaveLength(1);
    expect(store.pinned({ level: "thread", threadId: "thread-2" })).toHaveLength(0);

    store.unpin("p1");
    expect(store.pinned({ level: "thread", threadId: "thread-1" })).toHaveLength(0);
  });

  it("export returns live sources and live memories only", () => {
    const store = createKnowledgeStore("ws-a");
    store.upsertSource({ source: makeSource() });
    store.upsertSource({ source: makeSource({ id: "s2", disabled: true }) });
    store.upsertMemory(makeMemory());
    store.upsertMemory(makeMemory({ id: "m2", forgottenAt: "x" }));

    const exported = store.export();
    expect(exported.sources.map((s) => s.id)).toEqual(["s1"]);
    expect(exported.memories.map((m) => m.id)).toEqual(["m1"]);
  });

  it("snapshot round-trips through a fresh store", () => {
    const store = createKnowledgeStore("ws-a");
    store.upsertSource({ source: makeSource(), chunks: [makeChunk("s1", 0)] });
    store.upsertMemory(makeMemory());

    const snap = store.snapshot();
    const restored = createKnowledgeStore("ws-a", snap);

    expect(restored.sources()).toHaveLength(1);
    expect(restored.chunks("s1")).toHaveLength(1);
    expect(restored.memories()).toHaveLength(1);
  });

  it("accepts legacy snapshots without a top-level workspace id", () => {
    const legacy = emptyKnowledgeStoreState("legacy");
    delete legacy.workspaceId;
    legacy.sources.push(makeSource({ id: "s1" }));

    const restored = createKnowledgeStore("ws-a", legacy);

    expect(restored.snapshot().workspaceId).toBe("ws-a");
    expect(restored.source("s1")?.workspaceId).toBe("ws-a");
  });

  it("emptyKnowledgeStoreState is a clean baseline", () => {
    const snap = emptyKnowledgeStoreState("ws-a");
    expect(snap.sources).toEqual([]);
    expect(snap.memories).toEqual([]);
    expect(snap.pinned).toEqual([]);
  });

  it("can disable and re-enable sources to hide/reveal them", () => {
    const store = createKnowledgeStore("ws-a");
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
    const store = createKnowledgeStore("ws-a");
    store.upsertSource({ source: makeSource(), chunks: [makeChunk("s1", 0)] });
    store.upsertMemory(makeMemory());
    expect(store.sources()).toHaveLength(1);

    // Delete cache / empty snap
    const emptySnap = emptyKnowledgeStoreState("ws-a");
    const restored = createKnowledgeStore("ws-a", emptySnap);
    expect(restored.sources()).toHaveLength(0);
    expect(restored.memories()).toHaveLength(0);
    expect(restored.pinned(GLOBAL_SCOPE)).toHaveLength(0);
  });

  it("isolates identical ids in different workspaces and rejects cross-workspace snapshots", () => {
    const alpha = createKnowledgeStore("alpha");
    const beta = createKnowledgeStore("beta");
    alpha.upsertSource({ source: makeSource({ id: "shared", title: "Alpha" }) });
    beta.upsertSource({ source: makeSource({ id: "shared", title: "Beta" }) });

    expect(alpha.source("shared")?.title).toBe("Alpha");
    expect(beta.source("shared")?.title).toBe("Beta");
    expect(() => createKnowledgeStore("beta", alpha.snapshot())).toThrow(/another workspace/);
    expect(() =>
      alpha.upsertMemory(makeMemory({ id: "foreign", workspaceId: "beta" }))
    ).toThrow(/another workspace/);
  });

  it("persists deletion and forget guards across snapshot round trips", () => {
    const store = createKnowledgeStore("alpha");
    store.upsertSource({ source: makeSource({ id: "deleted" }) });
    store.removeSource("deleted");
    store.upsertMemory(makeMemory({ id: "forgotten", forgottenAt: "2026-07-01T00:00:00Z" }));

    const restored = createKnowledgeStore("alpha", store.snapshot());
    expect(() => restored.upsertSource({ source: makeSource({ id: "deleted" }) })).toThrow(
      /cannot be restored/
    );
    expect(() => restored.upsertMemory(makeMemory({ id: "forgotten" }))).toThrow(
      /cannot be restored/
    );
    expect(restored.export()).toMatchObject({
      workspaceId: "alpha",
      disabledRecordsIncluded: false,
      forgottenRecordsIncluded: false,
      sources: [],
      memories: []
    });
  });
});

describe("scope helpers", () => {
  it("global scope satisfies every run scope", () => {
    expect(scopeSatisfies(GLOBAL_SCOPE, GLOBAL_SCOPE)).toBe(true);
    expect(scopeSatisfies(GLOBAL_SCOPE, { level: "thread", threadId: "t" })).toBe(true);
  });

  it("thread scope is satisfied only by the same thread", () => {
    const threadScope = { level: "thread" as const, threadId: "t" };
    expect(scopeSatisfies(threadScope, GLOBAL_SCOPE)).toBe(false);
    expect(scopeSatisfies(threadScope, { level: "thread", threadId: "other" })).toBe(false);
    expect(scopeSatisfies(threadScope, { level: "thread", threadId: "t" })).toBe(true);
    expect(scopesMatch(threadScope, { level: "thread", threadId: "t" })).toBe(true);
  });
});

describe("roadmap object memory scopes", () => {
  it("inherits only explicitly supplied durable context and excludes sibling scopes", () => {
    const run = { level: "thread" as const, threadId: "side-a", agentId: "agent-a", projectId: "project-a", workId: "work-a" };
    expect(scopeSatisfies({level:"agent",agentId:"agent-a"},run)).toBe(true);
    expect(scopeSatisfies({level:"agent",agentId:"agent-b"},run)).toBe(false);
    expect(scopeSatisfies({level:"project",projectId:"project-a"},run)).toBe(true);
    expect(scopeSatisfies({level:"thread",threadId:"side-b"},run)).toBe(false);
    expect(scopeSatisfies({level:"work",workId:"work-b"},run)).toBe(false);
    expect(scopeSatisfies({level:"agent"},run)).toBe(false);
    expect(scopesMatch({level:"agent"},{level:"agent"})).toBe(false);
  });
});
