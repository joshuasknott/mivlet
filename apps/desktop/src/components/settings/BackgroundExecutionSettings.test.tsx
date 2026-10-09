import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundExecutionSettings } from "./BackgroundExecutionSettings";

const native = vi.hoisted(() => ({ status: vi.fn(), control: vi.fn() }));
vi.mock("../../runtime/domains/background-worker", () => ({
  backgroundWorkerStatus: native.status,
  controlBackgroundWorker: native.control,
}));
const stopped = {
  supported: true,
  enabled: false,
  running: false,
  protocol: 1,
  version: "fixture",
  processId: null,
  activeWork: 0,
};
beforeEach(() => {
  vi.clearAllMocks();
  native.status.mockResolvedValue(stopped);
});

describe("background execution controls", () => {
  it("can request Stop when the owner cannot answer the initial status read", async () => {
    native.status.mockRejectedValueOnce(new Error("Worker disconnected."));
    native.control.mockResolvedValueOnce(stopped);
    render(<BackgroundExecutionSettings />);
    const stop = await screen.findByRole("button", {
      name: "Stop background work",
    });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    await screen.findByText("Stopped");
    expect(native.control).toHaveBeenCalledExactlyOnceWith("stop");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("can reconnect after the first status read fails", async () => {
    native.status.mockRejectedValueOnce(new Error("Worker disconnected."));
    render(<BackgroundExecutionSettings />);
    await screen.findByText("Background connection unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await screen.findByText("Stopped");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start background worker" }),
    ).toBeEnabled();
  });
  it("marks a cached running status unavailable until a refresh reconnects", async () => {
    native.status.mockResolvedValueOnce({
      ...stopped,
      running: true,
      activeWork: 2,
    });
    render(<BackgroundExecutionSettings />);
    await screen.findByText("Running · 2 active");
    native.status.mockRejectedValueOnce(new Error("Worker disconnected."));
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await screen.findByText("Background connection unavailable");
    expect(screen.queryByText("Running · 2 active")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Restart worker" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Stop background work" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await screen.findByText("Stopped");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("allows Stop during a slow refresh and discards its late running response", async () => {
    const running = { ...stopped, running: true, activeWork: 1 };
    native.status.mockResolvedValueOnce(running);
    render(<BackgroundExecutionSettings />);
    await screen.findByText("Running · 1 active");
    let finish!: (value: typeof running) => void;
    native.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    native.control.mockResolvedValueOnce(stopped);
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    const stop = screen.getByRole("button", { name: "Stop background work" });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    await screen.findByText("Stopped");
    await act(async () => finish(running));
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.queryByText("Running · 1 active")).not.toBeInTheDocument();
    expect(native.control).toHaveBeenCalledExactlyOnceWith("stop");
  });
  it("retains emergency Stop while reconnecting an unknown owner", async () => {
    native.status.mockRejectedValueOnce(new Error("Worker disconnected."));
    render(<BackgroundExecutionSettings />);
    await screen.findByText("Background connection unavailable");
    let finish!: (value: typeof stopped) => void;
    native.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(
      screen.getByRole("button", { name: "Stop background work" }),
    ).toBeEnabled();
    await act(async () => finish(stopped));
    await screen.findByText("Stopped");
  });
  it("waits for native acknowledgment before showing a running worker", async () => {
    let finish!: (value: unknown) => void;
    native.control.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<BackgroundExecutionSettings />);
    const start = await screen.findByRole("button", {
      name: "Start background worker",
    });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    expect(start).toBeDisabled();
    expect(screen.queryByText("Running · 0 active")).not.toBeInTheDocument();
    await act(async () =>
      finish({ ...stopped, enabled: true, running: true, processId: 123 }),
    );
    expect(
      screen.getByRole("button", { name: "Stop background work" }),
    ).toBeEnabled();
    expect(native.control).toHaveBeenCalledWith("start");
  });
  it("preserves an actionable error without claiming a failed stop succeeded", async () => {
    native.status.mockResolvedValue({
      ...stopped,
      enabled: true,
      running: true,
    });
    native.control.mockRejectedValue(
      new Error("Worker did not acknowledge Stop."),
    );
    render(<BackgroundExecutionSettings />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Stop background work" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Worker did not acknowledge Stop.",
    );
    expect(
      screen.getByRole("button", { name: "Stop background work" }),
    ).toBeEnabled();
  });
  it("does not offer a browser-only background runtime", async () => {
    native.status.mockResolvedValue({ ...stopped, supported: false });
    render(<BackgroundExecutionSettings />);
    await screen.findByText("Requires the installed Windows app");
    expect(
      screen.getByRole("button", { name: "Start background worker" }),
    ).toBeDisabled();
    expect(native.control).not.toHaveBeenCalled();
  });
});
