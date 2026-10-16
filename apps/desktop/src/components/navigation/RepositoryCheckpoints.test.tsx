import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RepositoryCheckpoint,
  RepositoryCheckpointPreview,
} from "@mivlet/protocol";
import { RepositoryCheckpoints } from "./RepositoryCheckpoints";
import {
  executeCheckpointAction,
  listRepositoryCheckpoints,
  prepareCheckpointAction,
  previewRepositoryCheckpoint,
} from "../../runtime/domains/repository-checkpoints";
import { loadRuntimeLocalComputer } from "../../runtime/domains/local-computer";
vi.mock(
  "../../runtime/domains/repository-checkpoints",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../runtime/domains/repository-checkpoints")
    >()),
    listRepositoryCheckpoints: vi.fn(),
    previewRepositoryCheckpoint: vi.fn(),
    executeCheckpointAction: vi.fn(),
    prepareCheckpointAction: vi.fn((target, action, args) => ({
      target,
      tool: `repository-checkpoint-${action}`,
      arguments: args,
      approval: {
        consequence: "Replace private-copy files",
        confirmationPhrase: `approve repository-checkpoint-${action}`,
      },
    })),
  }),
);
vi.mock("../../runtime/domains/local-computer", () => ({
  loadRuntimeLocalComputer: vi.fn(),
  cancelRuntimeLocalComputer: vi.fn(),
}));
const checkpoint: RepositoryCheckpoint = {
  id: "saved",
  repositoryId: "repo",
  label: "Tests passing",
  treeId: "saved-tree",
  head: "head",
  createdAt: "2026-10-08T12:00:00Z",
  bytes: 40,
  fileCount: 2,
  requestId: "request",
  generation: 4,
  reason: "manual",
};
const review: RepositoryCheckpointPreview = {
  checkpoint,
  currentTreeId: "current-tree",
  outputTreeId: "target-tree",
  head: "head",
  files: [
    {
      path: "src/sum.ts",
      status: "modified",
      beforeSha256: "before",
      afterSha256: "after",
    },
  ],
  diff: "- broken\n+ working",
  truncated: false,
  preservesIgnoredFiles: true,
  verificationWillBeInvalidated: true,
};
function setup(disabled = false) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RepositoryCheckpoints
        workspaceId="workspace"
        agentId="agent"
        repositoryId="repo"
        disabled={disabled}
        onChanged={vi.fn()}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("File checkpoints"));
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadRuntimeLocalComputer).mockResolvedValue({
    generation: 7,
    plugins: { computer: true },
  } as Awaited<ReturnType<typeof loadRuntimeLocalComputer>>);
  vi.mocked(listRepositoryCheckpoints).mockResolvedValue({
    checkpoints: [checkpoint],
    maxCheckpoints: 24,
    maxBytes: 512 * 1024 * 1024,
  });
  vi.mocked(previewRepositoryCheckpoint).mockResolvedValue(review);
  vi.mocked(executeCheckpointAction).mockResolvedValue({
    ok: true,
    output: "restored",
  });
});
describe("repository file checkpoints", () => {
  it("previews real changes without restoring and approves only the reviewed epoch", async () => {
    setup();
    fireEvent.click(
      await screen.findByRole("button", { name: "Preview Tests passing" }),
    );
    expect(
      await screen.findByLabelText("Checkpoint file diff"),
    ).toHaveTextContent("- broken");
    expect(executeCheckpointAction).not.toHaveBeenCalled();
    vi.mocked(loadRuntimeLocalComputer).mockResolvedValue({
      generation: 8,
      plugins: { computer: true },
    } as Awaited<ReturnType<typeof loadRuntimeLocalComputer>>);
    fireEvent.click(
      screen.getByRole("button", { name: "Review restore approval" }),
    );
    expect(prepareCheckpointAction).toHaveBeenCalledWith(
      { workspaceId: "workspace", agentId: "agent", expectedGeneration: 7 },
      "restore",
      expect.objectContaining({
        expectedTree: "current-tree",
        expectedOutput: "target-tree",
        expectedCheckpointTree: "saved-tree",
      }),
    );
    expect(screen.getByRole("button", { name: "Approve once" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type/), {
      target: { value: "approve repository-checkpoint-restore" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    await waitFor(() =>
      expect(executeCheckpointAction).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByText(/Files restored. Run/)).toBeVisible();
  });
  it("cancels a reviewed restore without making a native mutation", async () => {
    setup();
    fireEvent.click(
      await screen.findByRole("button", { name: "Preview Tests passing" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Review restore approval" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(executeCheckpointAction).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("form", { name: "Confirm checkpoint action" }),
    ).not.toBeInTheDocument();
  });
  it("blocks checkpoint writes while the repository is busy or uncertain", async () => {
    setup(true);
    expect(
      await screen.findByRole("button", { name: "Save checkpoint" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Refresh checkpoints" }),
    ).toBeDisabled();
    expect(listRepositoryCheckpoints).not.toHaveBeenCalled();
  });
  it("identifies the exact checkpoint in a delete approval and cancels without mutation", async () => {
    setup();
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete Tests passing" }),
    );
    const confirmation = await screen.findByRole("form", {
      name: "Confirm checkpoint action",
    });
    expect(confirmation).toHaveTextContent("Tests passing");
    expect(confirmation.querySelector("code")).toHaveTextContent("saved");
    expect(prepareCheckpointAction).toHaveBeenCalledWith(
      { workspaceId: "workspace", agentId: "agent", expectedGeneration: 7 },
      "delete",
      {
        repositoryId: "repo",
        checkpointId: "saved",
        expectedCheckpointTree: "saved-tree",
      },
    );
    expect(screen.getByRole("button", { name: "Approve once" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(executeCheckpointAction).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("form", { name: "Confirm checkpoint action" }),
    ).not.toBeInTheDocument();
  });
  it("shows native prerequisites and failed previews without presenting restore", async () => {
    vi.mocked(previewRepositoryCheckpoint).mockRejectedValue(
      new Error("Checkpoint files changed"),
    );
    setup();
    fireEvent.click(
      await screen.findByRole("button", { name: "Preview Tests passing" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Checkpoint files changed",
    );
    expect(
      screen.queryByRole("button", { name: "Review restore approval" }),
    ).not.toBeInTheDocument();
    expect(executeCheckpointAction).not.toHaveBeenCalled();
  });
  it("clears a failed action when the user starts a fresh review", async () => {
    vi.mocked(executeCheckpointAction).mockRejectedValueOnce(
      new Error("Repository changed after review"),
    );
    setup();
    fireEvent.click(
      await screen.findByRole("button", { name: "Preview Tests passing" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Review restore approval" }),
    );
    fireEvent.change(screen.getByLabelText(/Type/), {
      target: { value: "approve repository-checkpoint-restore" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Repository changed after review",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Preview Tests passing" }),
    );
    expect(await screen.findByLabelText("Checkpoint file diff")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
