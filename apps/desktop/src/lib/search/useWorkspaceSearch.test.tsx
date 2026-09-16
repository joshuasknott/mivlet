import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResponse, SearchResult } from "@mivlet/protocol";
import { useWorkspaceSearch } from "./useWorkspaceSearch";

const mocks = vi.hoisted(() => ({ searchWorkspace: vi.fn() }));
vi.mock("../../runtime/domains/search", () => ({
  searchWorkspace: mocks.searchWorkspace,
}));

function makeResult(id: string, title: string): SearchResult {
  return {
    reference: { workspaceId: "ws", kind: "conversation", id },
    objectKind: "conversation",
    title,
    snippet: `${title} snippet`,
    matchedField: "title",
    score: 4,
    archived: false,
    context: { conversationId: id },
  };
}

function response(
  results: SearchResult[],
  nextCursor?: string,
): SearchResponse {
  return {
    query: "aurora",
    results,
    nextCursor,
    truncated: Boolean(nextCursor),
    scanned: {
      conversationsScanned: results.length,
      messagesScanned: 0,
      workScanned: 0,
      projectsScanned: 0,
      agentsScanned: 0,
      filesScanned: 0,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useWorkspaceSearch", () => {
  it("stays idle until the query is meaningful", async () => {
    const { result } = renderHook(() =>
      useWorkspaceSearch({ workspaceId: "ws", debounceMs: 0 }),
    );
    act(() => result.current.setQuery("a"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocks.searchWorkspace).not.toHaveBeenCalled();
    expect(result.current.results).toEqual([]);
  });

  it("pages incrementally and dedupes repeated results", async () => {
    mocks.searchWorkspace
      .mockResolvedValueOnce(response([makeResult("thread-1", "Aurora one")], "1"))
      .mockResolvedValueOnce(
        response([makeResult("thread-2", "Aurora two"), makeResult("thread-1", "Aurora one")]),
      );
    const { result } = renderHook(() =>
      useWorkspaceSearch({ workspaceId: "ws", debounceMs: 0 }),
    );
    act(() => result.current.setQuery("aurora"));
    await waitFor(() => expect(result.current.results).toHaveLength(1));
    expect(result.current.hasMore).toBe(true);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.results).toHaveLength(2));
    expect(result.current.results.map((entry) => entry.reference.id)).toEqual([
      "thread-1",
      "thread-2",
    ]);
    expect(mocks.searchWorkspace.mock.calls[1][0]).toMatchObject({
      workspaceId: "ws",
      query: "aurora",
      cursor: "1",
    });
  });

  it("drops cached rows when the data revision changes", async () => {
    mocks.searchWorkspace.mockResolvedValueOnce(
      response([makeResult("thread-old", "Old")]),
    );
    const { result, rerender } = renderHook(
      ({ revision }: { revision: number }) =>
        useWorkspaceSearch({ workspaceId: "ws", debounceMs: 0, dataRevision: revision }),
      { initialProps: { revision: 1 } },
    );
    act(() => result.current.setQuery("aurora"));
    await waitFor(() => expect(result.current.results).toHaveLength(1));
    mocks.searchWorkspace.mockResolvedValueOnce(
      response([makeResult("thread-new", "New")]),
    );
    rerender({ revision: 2 });
    await waitFor(() =>
      expect(result.current.results[0]?.reference.id).toBe("thread-new"),
    );
    expect(mocks.searchWorkspace).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale response after a newer query", async () => {
    const first = deferred<SearchResponse>();
    const second = deferred<SearchResponse>();
    mocks.searchWorkspace
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() =>
      useWorkspaceSearch({ workspaceId: "ws", debounceMs: 0 }),
    );
    act(() => result.current.setQuery("aurora"));
    await waitFor(() => expect(mocks.searchWorkspace).toHaveBeenCalledTimes(1));
    act(() => result.current.setQuery("borealis"));
    await waitFor(() => expect(mocks.searchWorkspace).toHaveBeenCalledTimes(2));
    await act(async () => {
      second.resolve(response([makeResult("thread-b", "Borealis")]));
      await second.promise;
    });
    await waitFor(() =>
      expect(result.current.results[0]?.reference.id).toBe("thread-b"),
    );
    await act(async () => {
      first.resolve(response([makeResult("thread-a", "Aurora")]));
      await first.promise;
    });
    expect(result.current.results[0]?.reference.id).toBe("thread-b");
  });

  it("forwards archive visibility and surfaces native errors", async () => {
    mocks.searchWorkspace.mockResolvedValueOnce(response([]));
    const { result, rerender } = renderHook(
      ({ includeArchived }: { includeArchived: boolean }) =>
        useWorkspaceSearch({ workspaceId: "ws", debounceMs: 0, includeArchived }),
      { initialProps: { includeArchived: false } },
    );
    act(() => result.current.setQuery("aurora"));
    await waitFor(() => expect(mocks.searchWorkspace).toHaveBeenCalledTimes(1));
    expect(mocks.searchWorkspace.mock.calls[0][0].includeArchived).toBeUndefined();
    mocks.searchWorkspace.mockResolvedValueOnce(response([]));
    rerender({ includeArchived: true });
    await waitFor(() => expect(mocks.searchWorkspace).toHaveBeenCalledTimes(2));
    expect(mocks.searchWorkspace.mock.calls[1][0].includeArchived).toBe(true);

    mocks.searchWorkspace.mockRejectedValueOnce(
      new Error("Search requires the installed desktop app."),
    );
    act(() => result.current.setQuery("nebula"));
    await waitFor(() =>
      expect(result.current.error).toContain("installed desktop app"),
    );
  });
});
