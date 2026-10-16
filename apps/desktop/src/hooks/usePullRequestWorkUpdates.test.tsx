import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { listenPullRequestWorkUpdates } from "../runtime/domains/pull-requests";
import { usePullRequestWorkUpdates } from "./usePullRequestWorkUpdates";
vi.mock("../runtime/domains/pull-requests", () => ({
  listenPullRequestWorkUpdates: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());
it("refreshes the existing Work owner only for this workspace and unsubscribes", async () => {
  let event: (workspace: string) => void = () => {};
  const release = vi.fn();
  vi.mocked(listenPullRequestWorkUpdates).mockImplementation(
    async (handler) => {
      event = handler;
      return release;
    },
  );
  const service = { refresh: vi.fn(async () => {}), report: vi.fn() };
  const { unmount } = renderHook(() =>
    usePullRequestWorkUpdates("workspace", service),
  );
  await waitFor(() => expect(service.refresh).toHaveBeenCalledTimes(1));
  act(() => event("another-workspace"));
  expect(service.refresh).toHaveBeenCalledTimes(1);
  act(() => event("workspace"));
  await waitFor(() => expect(service.refresh).toHaveBeenCalledTimes(2));
  unmount();
  expect(release).toHaveBeenCalledTimes(1);
  act(() => event("workspace"));
  expect(service.refresh).toHaveBeenCalledTimes(2);
});
it("cleans up a late subscription after workspace disposal without refreshing", async () => {
  let subscribed: (release: () => void) => void = () => {};
  vi.mocked(listenPullRequestWorkUpdates).mockImplementation(
    () =>
      new Promise((resolve) => {
        subscribed = resolve;
      }),
  );
  const service = { refresh: vi.fn(async () => {}), report: vi.fn() };
  const release = vi.fn();
  const { unmount } = renderHook(() =>
    usePullRequestWorkUpdates("workspace", service),
  );
  unmount();
  await act(async () => subscribed(release));
  expect(release).toHaveBeenCalledTimes(1);
  expect(service.refresh).not.toHaveBeenCalled();
});
