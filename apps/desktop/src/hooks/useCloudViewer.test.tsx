import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useCloudViewer } from "./useCloudViewer";
const port = vi.hoisted(() => ({
  openCloudViewer: vi.fn(),
  closeCloudViewer: vi.fn(),
  resizeCloudViewer: vi.fn(),
  cloudViewerStatus: vi.fn(),
}));
vi.mock("../runtime/domains/cloud-computers", () => port);
const bounds = { x: 20, y: 60, width: 400, height: 300 };
const active = {
  open: true,
  machineId: "machine-one",
  generation: 7,
  revoke: "notRequested",
  expiresAt: "later",
};
beforeEach(() => {
  vi.resetAllMocks();
  port.openCloudViewer.mockResolvedValue(active);
  port.closeCloudViewer.mockResolvedValue({
    ...active,
    open: false,
    generation: 8,
    revoke: "acknowledged",
  });
});
it("only opens after an explicit request and cleans up the exact stream on unmount", async () => {
  const hook = renderHook(() => useCloudViewer("one", "machine-one", 4));
  expect(port.openCloudViewer).not.toHaveBeenCalled();
  await act(async () => hook.result.current.open(bounds));
  expect(port.openCloudViewer).toHaveBeenCalledExactlyOnceWith(
    "one",
    "machine-one",
    4,
    bounds,
  );
  hook.unmount();
  expect(port.closeCloudViewer).toHaveBeenCalledExactlyOnceWith(
    "one",
    "machine-one",
    7,
  );
});
it("closes a stream that finished opening after the panel was left", async () => {
  let resolve!: (value: unknown) => void;
  port.openCloudViewer.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const hook = renderHook(() => useCloudViewer("one", "machine-one", 4));
  act(() => {
    void hook.result.current.open(bounds);
  });
  hook.unmount();
  await act(async () => {
    resolve(active);
  });
  expect(port.closeCloudViewer).toHaveBeenCalledWith("one", "machine-one", 7);
});
it("recovers a fence after uncertain revocation without retrying the write", async () => {
  const hook = renderHook(() => useCloudViewer("one", "machine-one", 4));
  await act(async () => hook.result.current.open(bounds));
  port.closeCloudViewer.mockRejectedValueOnce(
    new Error("Remote revoke not acknowledged"),
  );
  port.cloudViewerStatus.mockResolvedValue({
    ...active,
    open: false,
    generation: 8,
    revoke: "unconfirmed",
  });
  await act(async () => {
    expect(await hook.result.current.close()).toBe(false);
  });
  expect(port.closeCloudViewer).toHaveBeenCalledOnce();
  expect(hook.result.current.viewer?.revoke).toBe("unconfirmed");
  await act(async () => {
    await hook.result.current.close();
  });
  expect(port.closeCloudViewer).toHaveBeenLastCalledWith(
    "one",
    "machine-one",
    8,
  );
});
it("does not attach a previous machine's late viewer to a new selection", async () => {
  let resolve!: (value: unknown) => void;
  port.openCloudViewer.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const hook = renderHook(({ machine }) => useCloudViewer("one", machine, 4), {
    initialProps: { machine: "machine-one" },
  });
  act(() => {
    void hook.result.current.open(bounds);
  });
  hook.rerender({ machine: "machine-two" });
  await act(async () => {
    resolve(active);
  });
  await waitFor(() =>
    expect(port.closeCloudViewer).toHaveBeenCalledWith("one", "machine-one", 7),
  );
  expect(hook.result.current.viewer).toBeNull();
});

it("retries closing the recovered viewer's machine after another selection", async () => {
  port.openCloudViewer.mockRejectedValueOnce(
    new Error("Close the existing viewer"),
  );
  port.cloudViewerStatus.mockResolvedValue({
    ...active,
    open: false,
    generation: 8,
    revoke: "unconfirmed",
  });
  const hook = renderHook(() => useCloudViewer("one", "machine-two", 5));
  await act(async () => hook.result.current.open(bounds));
  await act(async () => hook.result.current.close());
  expect(port.closeCloudViewer).toHaveBeenCalledExactlyOnceWith(
    "one",
    "machine-one",
    8,
  );
});

it("closes the active stream when the connection revision changes", async () => {
  const hook = renderHook(
    ({ revision }) => useCloudViewer("one", "machine-one", revision),
    {
      initialProps: { revision: 4 },
    },
  );
  await act(async () => hook.result.current.open(bounds));
  hook.rerender({ revision: 5 });
  expect(port.closeCloudViewer).toHaveBeenCalledExactlyOnceWith(
    "one",
    "machine-one",
    7,
  );
  expect(hook.result.current.viewer).toBeNull();
});
