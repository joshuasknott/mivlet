import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceExecution } from "../lib/workspace-execution";
import { selectRuntimeConversationBranch } from "../runtime/domains/conversations";
import { useConversationBranches } from "./useConversationBranches";

vi.mock("../runtime/domains/conversations", () => ({
  selectRuntimeConversationBranch: vi.fn(),
}));

function setup(work: unknown[] = []) {
  const loadHistory = vi.fn().mockResolvedValue(undefined);
  const submit = vi.fn();
  const setError = vi.fn();
  const submission = { current: false };
  const service = {
    loadHistory,
    submit,
    getSnapshot: () => ({ data: { work }, histories: {} }),
  } as unknown as WorkspaceExecution;
  const hook = renderHook(() =>
    useConversationBranches({
      conversationId: "chat",
      service,
      runtime: { flushSnapshot: vi.fn() },
      responderId: "mira",
      discussion: false,
      submission,
      setPending: vi.fn(),
      setError,
    }),
  );
  return { ...hook, loadHistory, submit, setError, submission };
}

beforeEach(() => vi.resetAllMocks());

describe("conversation branch ownership", () => {
  it("coalesces same-tick branch selection and never submits a provider request", async () => {
    let resolveSelection!: () => void;
    vi.mocked(selectRuntimeConversationBranch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSelection = () =>
            resolve(
              {} as Awaited<ReturnType<typeof selectRuntimeConversationBranch>>,
            );
        }),
    );
    const { result, loadHistory, submit } = setup();
    await act(async () => {
      const first = result.current.selectBranch("head");
      await result.current.selectBranch("other-head");
      expect(selectRuntimeConversationBranch).toHaveBeenCalledTimes(1);
      resolveSelection();
      await first;
    });
    expect(loadHistory).toHaveBeenCalledWith("chat", true);
    expect(submit).not.toHaveBeenCalled();
    expect(result.current.branchSelectionPending).toBe(false);
  });
  it("blocks selection while this composer owns a submission", async () => {
    const { result, submission } = setup();
    submission.current = true;
    await result.current.selectBranch("head");
    expect(selectRuntimeConversationBranch).not.toHaveBeenCalled();
  });
  it("refuses branch changes during live work", async () => {
    const { result, setError } = setup([
      { conversationId: "chat", status: "running" },
    ]);
    await result.current.selectBranch("head");
    expect(selectRuntimeConversationBranch).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalled();
  });
  it("releases selection ownership after a native failure", async () => {
    vi.mocked(selectRuntimeConversationBranch).mockRejectedValueOnce(
      new Error("stale branch"),
    );
    const { result } = setup();
    await act(async () => {
      await expect(result.current.selectBranch("head")).rejects.toThrow(
        "stale branch",
      );
    });
    await act(async () => {
      await result.current.selectBranch("fresh-head");
    });
    expect(selectRuntimeConversationBranch).toHaveBeenCalledTimes(2);
    expect(result.current.branchSelectionPending).toBe(false);
  });
});
