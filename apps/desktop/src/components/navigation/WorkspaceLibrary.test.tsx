import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MivletAgentProfile,
  CollaborationWorkItem,
  ConversationRoom,
} from "@mivlet/protocol";
import { WorkspaceLibrary } from "./WorkspaceLibrary";
import { listRuntimeLocalComputerFiles } from "../../runtime/domains/local-computer";

vi.mock("../../runtime/domains/local-computer", () => ({
  listRuntimeLocalComputerFiles: vi.fn(),
}));
const agents = [{ id: "mira", name: "Mira" }] as MivletAgentProfile[];
const listing = {
  computerId: "computer",
  entries: [
    { path: "notes/brief.md", name: "brief.md", kind: "file" as const },
    { path: "notes", name: "notes", kind: "directory" as const },
  ],
  truncated: false,
  updatedAt: "now",
};
function setup(workspaceId = "workspace") {
  const onOpen = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <WorkspaceLibrary
        workspaceId={workspaceId}
        agents={agents}
        onOpen={onOpen}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Agent files & setup"));
  return { onOpen, ...view };
}
beforeEach(() => vi.resetAllMocks());
describe("workspace Library", () => {
  it("bounds a large collection and searches beyond the initially visible files without scanning agent files", () => {
    const files = Array.from({ length: 125 }, (_, index) => ({
      id: "result-" + index,
      title: "Result " + index,
      detail: "Created here",
      origin: "created" as const,
      updatedAt: "2026-10-15",
      tab: {
        id: "result-" + index,
        kind: "web" as const,
        title: "Result " + index,
        url: "https://example.com/" + index,
      },
    }));
    const onOpen = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceLibrary
          workspaceId="workspace"
          agents={agents}
          files={files}
          onOpen={onOpen}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("button", { name: /Result 124/ })).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "File collection" }),
    ).toBeNull();
    expect(listRuntimeLocalComputerFiles).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Result 124" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Result 124/ }));
    expect(onOpen).toHaveBeenCalledWith(files[124].tab);
    expect(listRuntimeLocalComputerFiles).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    expect(
      screen.getAllByRole("button", { name: /^Open Result/ }),
    ).toHaveLength(24);
    fireEvent.click(screen.getByRole("button", { name: "Next files page" }));
    expect(
      screen.getByRole("button", { name: "Open Result 47" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Result 0" })).toBeNull();
    expect(
      screen.getAllByRole("button", { name: /^Open Result/ }),
    ).toHaveLength(24);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Result 124" },
    });
    expect(
      screen.getByRole("button", { name: "Open Result 124" }),
    ).toBeVisible();
  });
  it("only shows an origin filter when a collection has multiple origins", () => {
    const created = {
      id: "created",
      title: "Draft.md",
      detail: "Created here",
      origin: "created" as const,
      updatedAt: "2026-10-15",
      tab: {
        id: "created",
        kind: "web" as const,
        title: "Draft.md",
        url: "https://example.com/draft",
      },
    };
    const attached = {
      ...created,
      id: "attached",
      title: "Reference.md",
      detail: "Added to chat",
      origin: "attached" as const,
      tab: { ...created.tab, id: "attached", title: "Reference.md" },
    };
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <WorkspaceLibrary
          workspaceId="workspace"
          agents={agents}
          files={[created]}
          onOpen={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.queryByRole("combobox", { name: "File collection" }),
    ).toBeNull();
    view.rerender(
      <QueryClientProvider client={client}>
        <WorkspaceLibrary
          workspaceId="workspace"
          agents={agents}
          files={[created, attached]}
          onOpen={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("combobox", { name: "File collection" }),
    ).toHaveValue("all");
  });
  it("shows attachments only for the current workspace and chat", async () => {
    vi.mocked(listRuntimeLocalComputerFiles).mockResolvedValue({
      ...listing,
      entries: [],
    });
    const room = {
      id: "chat",
      workspaceId: "workspace",
      title: "Current chat",
    } as ConversationRoom;
    const work = (id: string, workspaceId: string, conversationId: string) =>
      ({
        id,
        workspaceId,
        conversationId,
        agentId: "mira",
        outputs: [],
        attachments: [
          {
            id,
            name: `${id}.txt`,
            sizeBytes: 5,
            mimeType: "text/plain",
            availability: "transient",
          },
        ],
      }) as unknown as CollaborationWorkItem;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceLibrary
          workspaceId="workspace"
          agents={agents}
          room={room}
          work={[
            work("current", "workspace", "chat"),
            work("sibling", "workspace", "other"),
            work("foreign", "other", "chat"),
          ]}
          onOpen={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("current.txt")).toBeVisible();
    expect(screen.queryByText("sibling.txt")).toBeNull();
    expect(screen.queryByText("foreign.txt")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Preview current.txt" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Original not retained · Reattach to preview"),
    ).toBeVisible();
  });
  it("lists files, filters them and opens the exact workspace and agent path", async () => {
    vi.mocked(listRuntimeLocalComputerFiles).mockResolvedValue(listing);
    const { onOpen } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /brief.md/ }));
    expect(listRuntimeLocalComputerFiles).toHaveBeenCalledWith({
      workspaceId: "workspace",
      agentId: "mira",
    });
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          type: "artifact",
          workspaceId: "workspace",
          agentId: "mira",
          relativePath: "notes/brief.md",
          title: "brief.md",
        },
      }),
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "missing" },
    });
    expect(screen.queryByRole("button", { name: /brief.md/ })).toBeNull();
    for (const message of screen.getAllByText("No files match your search."))
      expect(message).toBeVisible();
  });
  it("reports a failed listing and retries on Refresh", async () => {
    vi.mocked(listRuntimeLocalComputerFiles)
      .mockRejectedValueOnce(new Error("Workspace unavailable"))
      .mockResolvedValue(listing);
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Workspace unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh files" }));
    await screen.findByRole("button", { name: /brief.md/ });
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("does not show files from a previous workspace while the new scope loads", async () => {
    vi.mocked(listRuntimeLocalComputerFiles)
      .mockResolvedValueOnce(listing)
      .mockImplementationOnce(() => new Promise(() => {}));
    const client = new QueryClient();
    const draw = (workspaceId: string) => (
      <QueryClientProvider client={client}>
        <WorkspaceLibrary
          workspaceId={workspaceId}
          agents={agents}
          onOpen={vi.fn()}
        />
      </QueryClientProvider>
    );
    const view = render(draw("first"));
    fireEvent.click(screen.getByText("Agent files & setup"));
    await screen.findByRole("button", { name: /brief.md/ });
    view.rerender(draw("second"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /brief.md/ })).toBeNull(),
    );
  });
  it("reports the desktop prerequisite instead of presenting a failed read as empty", async () => {
    vi.mocked(listRuntimeLocalComputerFiles).mockResolvedValue(null);
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Open the desktop app",
    );
  });
});
