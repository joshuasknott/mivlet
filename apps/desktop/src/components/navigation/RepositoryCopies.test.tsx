import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryCopy } from "@mivlet/protocol";
import { RepositoryCopies, formatCopyBytes } from "./RepositoryCopies";

const native = vi.hoisted(() => ({
  load: vi.fn(),
  inventory: vi.fn(),
  preview: vi.fn(),
  remove: vi.fn(),
  select: vi.fn(),
}));
vi.mock("../../runtime/domains/local-computer", () => ({
  loadRuntimeLocalComputer: native.load,
}));
vi.mock("../../runtime/domains/repository-copies", () => ({
  inspectRepositoryCopies: native.inventory,
  previewRepositoryCopyCleanup: native.preview,
  deleteRepositoryCopy: native.remove,
  selectRepositoryCopy: native.select,
}));
const copy: RepositoryCopy = {
  id: "a".repeat(48),
  name: "Sample",
  accountId: "account-test",
  ownershipVerified: true,
  workspaceId: "workspace",
  agentId: "agent",
  sourceRepository: "Sample",
  managedPath: "coding/managed/checkout",
  branch: "mivlet/sample",
  head: "b".repeat(40),
  selected: false,
  dirty: false,
  sizeBytes: 2048,
  linkedWork: [{ id: "work-1", status: "completed" }],
  liveJobs: [],
  jobsStatus: "No active repository operation",
  checkpointsStatus: "No checkpoint service",
  blockers: [],
  cleanupPending: false,
};
function setup() {
  const onSelectionChange = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <RepositoryCopies
        workspaceId="workspace"
        agentId="agent"
        name="Ada"
        onSelectionChange={onSelectionChange}
      />
    </QueryClientProvider>,
  );
  const details = screen.getByText("Retained copies")
    .parentElement as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  return onSelectionChange;
}
beforeEach(() => {
  vi.resetAllMocks();
  native.load.mockResolvedValue({ generation: 7, plugins: { computer: true } });
  native.inventory.mockResolvedValue({ copies: [copy], busy: false });
  native.preview.mockResolvedValue({
    copy,
    previewToken: "exact-preview",
    expiresInSeconds: 120,
  });
  native.remove.mockResolvedValue(undefined);
  native.select.mockResolvedValue(undefined);
});

describe("retained repository copies", () => {
  it("shows native inventory and scoped details without claiming allocation", async () => {
    setup();
    await screen.findByText("Sample", { selector: "strong" });
    expect(screen.getByText(/2.0 KiB measured file bytes/)).toBeInTheDocument();
    expect(screen.getByText("account-test")).toBeInTheDocument();
    expect(screen.getByText("coding/managed/checkout")).toBeInTheDocument();
    expect(native.inventory).toHaveBeenCalledWith({
      workspaceId: "workspace",
      agentId: "agent",
      expectedGeneration: 7,
    });
  });
  it("requires exact review and deliberate confirmation, then consumes the captured generation", async () => {
    setup();
    await screen.findByText("Sample", { selector: "strong" });
    fireEvent.click(screen.getByRole("button", { name: "Review cleanup" }));
    const remove = await screen.findByRole("button", {
      name: "Permanently remove this copy",
    });
    expect(remove).toBeDisabled();
    expect(native.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    native.load.mockResolvedValue({
      generation: 8,
      plugins: { computer: true },
    });
    fireEvent.click(remove);
    await waitFor(() =>
      expect(native.remove).toHaveBeenCalledWith({
        target: {
          workspaceId: "workspace",
          agentId: "agent",
          expectedGeneration: 7,
        },
        repositoryId: copy.id,
        previewToken: "exact-preview",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument(),
    );
  });
  it("shows native protections without offering deletion", async () => {
    native.preview.mockResolvedValue({
      copy: { ...copy, blockers: ["Untracked files must be preserved."] },
      previewToken: null,
      expiresInSeconds: 120,
    });
    setup();
    await screen.findByText("Sample", { selector: "strong" });
    fireEvent.click(screen.getByRole("button", { name: "Review cleanup" }));
    await screen.findByText("This copy is protected");
    expect(
      screen.getByText("Untracked files must be preserved."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(native.remove).not.toHaveBeenCalled();
  });
  it("returns focus after closing a preview without deleting the copy", async () => {
    setup();
    const review = await screen.findByRole("button", {
      name: "Review cleanup",
    });
    fireEvent.click(review);
    const preview = await screen.findByRole("region", {
      name: "Exact repository cleanup preview",
    });
    await waitFor(() => expect(preview).toHaveFocus());
    const close = screen.getByRole("button", { name: "Close cleanup preview" });
    close.focus();
    fireEvent.click(close);
    await waitFor(() => expect(review).toHaveFocus());
    expect(native.remove).not.toHaveBeenCalled();
    fireEvent.click(review);
    expect(await screen.findByRole("checkbox")).not.toBeChecked();
  });
  it("focuses refresh after cleanup removes the preview's originating copy", async () => {
    setup();
    fireEvent.click(
      await screen.findByRole("button", { name: "Review cleanup" }),
    );
    fireEvent.click(await screen.findByRole("checkbox"));
    let finishRefresh!: (value: {
      copies: RepositoryCopy[];
      busy: boolean;
    }) => void;
    native.inventory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Permanently remove this copy" }),
    );
    await waitFor(() => expect(native.remove).toHaveBeenCalled());
    await waitFor(() => expect(native.inventory).toHaveBeenCalledTimes(2));
    finishRefresh({ copies: [], busy: false });
    await screen.findByText("No retained repository copies in this account.");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh copies" }),
      ).toHaveFocus(),
    );
  });
  it("reopens a retained copy and refreshes the canonical selected repository", async () => {
    const changed = setup();
    await screen.findByText("Sample", { selector: "strong" });
    fireEvent.click(screen.getByRole("button", { name: "Use this copy" }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(native.select).toHaveBeenCalledWith({
      target: {
        workspaceId: "workspace",
        agentId: "agent",
        expectedGeneration: 7,
      },
      repositoryId: copy.id,
      previewToken: null,
    });
  });
  it("invalidates a failed cleanup and permits a fresh native retry", async () => {
    native.remove.mockRejectedValue(new Error("Copy changed. Inspect again."));
    setup();
    await screen.findByText("Sample", { selector: "strong" });
    fireEvent.click(screen.getByRole("button", { name: "Review cleanup" }));
    await screen.findByRole("checkbox");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Permanently remove this copy" }),
    );
    await screen.findByRole("alert");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review cleanup" }));
    await screen.findByRole("checkbox");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(native.preview).toHaveBeenCalledTimes(2);
  });
  it("fails closed in browser and unavailable plugin states", async () => {
    native.load.mockResolvedValue(null);
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Open the desktop app",
    );
    expect(native.inventory).not.toHaveBeenCalled();
  });
  it("requires the Computer Use prerequisite before inspecting account copies", async () => {
    native.load.mockResolvedValue({
      generation: 7,
      plugins: { computer: false },
    });
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enable Computer Use",
    );
    expect(native.inventory).not.toHaveBeenCalled();
  });
  it("does not report selection success when the native bridge becomes unavailable", async () => {
    native.select.mockResolvedValue(null);
    const changed = setup();
    await screen.findByText("Sample", { selector: "strong" });
    fireEvent.click(screen.getByRole("button", { name: "Use this copy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Open the desktop app",
    );
    expect(changed).not.toHaveBeenCalled();
  });
  it("labels unknown sizes rather than treating them as zero", () => {
    expect(formatCopyBytes(null)).toBe("Size unavailable");
    expect(formatCopyBytes(0)).toBe("0 B");
  });
});
