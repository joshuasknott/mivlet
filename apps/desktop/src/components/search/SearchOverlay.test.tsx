import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResponse, SearchResult } from "@fable/protocol";
import { SearchOverlay } from "./SearchOverlay";

const mocks = vi.hoisted(() => ({ searchWorkspace: vi.fn() }));
vi.mock("../../runtime/domains/search", () => ({
  searchWorkspace: mocks.searchWorkspace,
}));

function makeResult(
  id: string,
  title: string,
  context: SearchResult["context"] = {},
): SearchResult {
  return {
    reference: { workspaceId: "ws", kind: "conversation", id },
    objectKind: "conversation",
    title,
    snippet: `${title} details`,
    matchedField: "title",
    score: 4,
    archived: false,
    context: { conversationId: id, ...context },
  };
}

function response(results: SearchResult[]): SearchResponse {
  return {
    query: "aurora",
    results,
    truncated: false,
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

beforeEach(() => {
  vi.resetAllMocks();
});

describe("SearchOverlay", () => {
  it("renders mixed authorized results and opens the active one", async () => {
    const onOpenResult = vi.fn();
    const onClose = vi.fn();
    mocks.searchWorkspace.mockResolvedValueOnce(
      response([
        makeResult("thread-1", "Aurora planning"),
        {
          reference: { workspaceId: "ws", kind: "work", id: "work-1" },
          objectKind: "work",
          title: "Aurora research",
          snippet: "Summarize aurora findings",
          matchedField: "title",
          score: 3,
          archived: false,
          context: {
            workId: "work-1",
            conversationId: "thread-1",
            agentName: "Nova",
          },
        },
      ]),
    );
    render(
      <SearchOverlay
        workspaceId="ws"
        open
        onClose={onClose}
        onOpenResult={onOpenResult}
        debounceMs={0}
      />,
    );
    const input = screen.getByRole("combobox", { name: /search agents/i });
    fireEvent.change(input, { target: { value: "aurora" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(
      screen.getByRole("option", { name: /Aurora planning/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Work · Nova/ }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("aurora", { exact: false }).length,
    ).toBeGreaterThan(0);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      "workspace-search-result-1",
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenResult).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: expect.objectContaining({ id: "work-1" }),
      }),
    );
  });

  it("continues searching after an empty bounded batch", async () => {
    mocks.searchWorkspace
      .mockResolvedValueOnce({
        ...response([]),
        truncated: true,
        nextCursor: "1:0:2:0",
      })
      .mockResolvedValueOnce(
        response([makeResult("older", "Aurora older chat")]),
      );
    render(
      <SearchOverlay
        workspaceId="ws"
        open
        onClose={vi.fn()}
        onOpenResult={vi.fn()}
        debounceMs={0}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "aurora" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(
      await screen.findByRole("option", { name: /Aurora older chat/ }),
    ).toBeInTheDocument();
    expect(mocks.searchWorkspace.mock.calls[1][0].cursor).toBe("1:0:2:0");
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
  });

  it("requests archived rows only when asked", async () => {
    mocks.searchWorkspace
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]));
    render(
      <SearchOverlay
        workspaceId="ws"
        open
        onClose={vi.fn()}
        onOpenResult={vi.fn()}
        debounceMs={0}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: /search agents/i }), {
      target: { value: "aurora" },
    });
    await waitFor(() => expect(mocks.searchWorkspace).toHaveBeenCalledTimes(1));
    expect(
      mocks.searchWorkspace.mock.calls[0][0].includeArchived,
    ).toBeUndefined();
    fireEvent.click(screen.getByLabelText("Include archived"));
    await waitFor(() => expect(mocks.searchWorkspace).toHaveBeenCalledTimes(2));
    expect(mocks.searchWorkspace.mock.calls[1][0].includeArchived).toBe(true);
  });

  it("reports empty, error and prerequisite states accessibly", async () => {
    const onClose = vi.fn();
    mocks.searchWorkspace.mockResolvedValueOnce(response([]));
    const { rerender } = render(
      <SearchOverlay
        workspaceId="ws"
        open
        onClose={onClose}
        onOpenResult={vi.fn()}
        debounceMs={0}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: /search agents/i }), {
      target: { value: "aurora" },
    });
    await waitFor(() =>
      expect(screen.getByText(/No results for/i)).toBeInTheDocument(),
    );

    mocks.searchWorkspace.mockRejectedValueOnce(
      new Error("Search requires the installed desktop app."),
    );
    rerender(
      <SearchOverlay
        workspaceId="ws"
        open
        onClose={onClose}
        onOpenResult={vi.fn()}
        debounceMs={0}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: /search agents/i }), {
      target: { value: "nebula" },
    });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "installed desktop app",
      ),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
