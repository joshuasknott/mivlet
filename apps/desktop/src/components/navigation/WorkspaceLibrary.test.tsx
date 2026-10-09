import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MivletAgentProfile, CollaborationWorkItem, ConversationRoom } from "@mivlet/protocol";
import { WorkspaceLibrary } from "./WorkspaceLibrary";
import { listRuntimeLocalComputerFiles } from "../../runtime/domains/local-computer";
import { listRuntimeOutputs } from "../../runtime/domains/outputs";
import { emitOutputPinned } from "../../lib/output-revision-events";

vi.mock("../../runtime/domains/local-computer", () => ({
  listRuntimeLocalComputerFiles: vi.fn(),
}));
vi.mock("../../runtime/domains/outputs", () => ({
  listRuntimeOutputs: vi.fn(),
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
  return { onOpen, ...view };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listRuntimeOutputs).mockResolvedValue([]);
});
describe("workspace Library", () => {
  it("shows attachments only for the current workspace and chat", async () => {
    vi.mocked(listRuntimeLocalComputerFiles).mockResolvedValue({ ...listing, entries: [] });
    const room = { id: "chat", workspaceId: "workspace", title: "Current chat" } as ConversationRoom;
    const work = (id: string, workspaceId: string, conversationId: string) => ({ id, workspaceId, conversationId, agentId: "mira", outputs: [], attachments: [{ id, name: `${id}.txt`, sizeBytes: 5, mimeType: "text/plain", availability: "transient" }] }) as unknown as CollaborationWorkItem;
    render(<QueryClientProvider client={new QueryClient()}><WorkspaceLibrary workspaceId="workspace" agents={agents} room={room} work={[work("current", "workspace", "chat"), work("sibling", "workspace", "other"), work("foreign", "other", "chat")]} onOpen={vi.fn()} /></QueryClientProvider>);
    expect(screen.getByText("current.txt")).toBeVisible();
    expect(screen.queryByText("sibling.txt")).toBeNull();
    expect(screen.queryByText("foreign.txt")).toBeNull();
    expect(screen.getByRole("button", { name: "Preview current.txt" })).toBeDisabled();
    expect(screen.getByText("Original not retained · Reattach to preview")).toBeVisible();
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
    expect(screen.getByText("1 file")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "missing" },
    });
    expect(screen.queryByRole("button", { name: /brief.md/ })).toBeNull();
    expect(screen.getByText("No files match your search.")).toBeVisible();
  });
  it("reports a failed listing and retries on Refresh", async () => {
    vi.mocked(listRuntimeLocalComputerFiles)
      .mockRejectedValueOnce(new Error("Workspace unavailable"))
      .mockResolvedValue(listing);
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Workspace unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
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

  it("refreshes pinned outputs after a pin and labels the historical pinned revision", async () => {
    const first = {
      id: "output-1",
      title: "Decision",
      format: "markdown" as const,
      mimeType: "text/markdown",
      source: { conversationId: "chat" },
      revisions: [
        {
          id: "revision-1",
          outputId: "output-1",
          number: 1,
          baseNumber: 0,
          content: "first",
          author: "system" as const,
          provenance: { conversationId: "chat", reason: "generated" as const },
          createdAt: "2026-10-08T10:00:00.000Z",
        },
      ],
      currentRevisionId: "revision-1",
      currentRevisionNumber: 1,
      pinned: true,
      pin: { revisionId: "revision-1", source: { conversationId: "chat" } },
      updatedAt: "2026-10-08T10:00:00.000Z",
    };
    const second = {
      ...first,
      revisions: [
        ...first.revisions,
        {
          ...first.revisions[0],
          id: "revision-2",
          number: 2,
          baseNumber: 1,
          content: "second",
          author: "user" as const,
          provenance: { conversationId: "chat", reason: "direct-edit" as const },
        },
      ],
      currentRevisionId: "revision-2",
      currentRevisionNumber: 2,
    };
    vi.mocked(listRuntimeOutputs)
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([second]);
    setup();
    await waitFor(() => expect(screen.getByText("markdown · pinned revision 1")).toBeVisible());
    emitOutputPinned({ workspaceId: "workspace", output: second });
    await waitFor(() => expect(listRuntimeOutputs).toHaveBeenCalledTimes(2));
    expect(screen.getByText("markdown · pinned revision 1")).toBeVisible();
    expect(screen.queryByText("markdown · pinned revision 2")).toBeNull();
  });
});
