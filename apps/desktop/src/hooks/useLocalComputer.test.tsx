import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalComputer } from "./useLocalComputer";

const mocks = vi.hoisted(() => ({
  previewFile: vi.fn()
}));

vi.mock("../runtime", () => ({
  historyRuntimeLocalBrowser: vi.fn().mockResolvedValue(null),
  keyRuntimeLocalBrowser: vi.fn(),
  listRuntimeLocalComputerFiles: vi.fn().mockResolvedValue(null),
  loadRuntimeLocalComputer: vi.fn().mockResolvedValue(null),
  navigateRuntimeLocalBrowser: vi.fn().mockResolvedValue(null),
  pointRuntimeLocalBrowser: vi.fn().mockResolvedValue(null),
  previewRuntimeLocalComputerFile: mocks.previewFile,
  provisionRuntimeLocalComputer: vi.fn().mockResolvedValue(null),
  setRuntimeLocalComputerController: vi.fn().mockResolvedValue(null),
  snapshotRuntimeLocalBrowser: vi.fn().mockResolvedValue(null)
}));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useLocalComputer", () => {
  beforeEach(() => {
    mocks.previewFile.mockReset();
  });

  it("never projects a private file preview across agent scopes", async () => {
    let resolveFirst!: (value: {
      computerId: string;
      path: string;
      content: string;
      sizeBytes: number;
      truncated: boolean;
      updatedAt: string;
    }) => void;
    mocks.previewFile.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirst = resolve;
    }));
    const { result, rerender } = renderHook(
      ({ agentId }: { agentId: string }) => useLocalComputer({ workspaceId: "workspace-a", agentId }),
      { initialProps: { agentId: "agent-a" }, wrapper: wrapper() }
    );

    let firstPreview!: Promise<unknown>;
    act(() => {
      firstPreview = result.current.previewFile("notes/a.md");
    });
    await waitFor(() => expect(result.current.filePreviewLoading).toBe(true));

    rerender({ agentId: "agent-b" });
    expect(result.current.filePreviewLoading).toBe(false);
    expect(result.current.filePreview).toBeNull();
    expect(result.current.filePreviewError).toBeNull();

    resolveFirst({
      computerId: "computer-a",
      path: "notes/a.md",
      content: "agent A only",
      sizeBytes: 12,
      truncated: false,
      updatedAt: "2026-08-28T00:00:00.000Z"
    });
    await act(async () => firstPreview);
    expect(result.current.filePreview).toBeNull();

    mocks.previewFile.mockResolvedValueOnce({
      computerId: "computer-b",
      path: "notes/b.md",
      content: "agent B only",
      sizeBytes: 12,
      truncated: false,
      updatedAt: "2026-08-28T00:00:01.000Z"
    });
    await act(async () => {
      await result.current.previewFile("notes/b.md");
    });
    await waitFor(() => expect(result.current.filePreview?.path).toBe("notes/b.md"));
    expect(mocks.previewFile).toHaveBeenLastCalledWith({
      workspaceId: "workspace-a",
      agentId: "agent-b",
      path: "notes/b.md"
    });
  });
});
