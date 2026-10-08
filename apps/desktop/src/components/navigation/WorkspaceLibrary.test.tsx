import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MivletAgentProfile } from "@mivlet/protocol";
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
  return { onOpen, ...view };
}
beforeEach(() => vi.resetAllMocks());
describe("workspace Library", () => {
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
});
