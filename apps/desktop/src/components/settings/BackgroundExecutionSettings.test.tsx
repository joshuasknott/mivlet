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
