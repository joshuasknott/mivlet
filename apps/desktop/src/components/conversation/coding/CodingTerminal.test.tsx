import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCommandJob, NativeCommandOutput } from "@mivlet/protocol";
import { CodingTerminal, appendTerminalFrames } from "./CodingTerminal";
import { readNativeCommandOutput, stopNativeCommandJob } from "../../../runtime/domains/command-jobs";
vi.mock("../../../runtime/domains/command-jobs", () => ({ readNativeCommandOutput: vi.fn(), stopNativeCommandJob: vi.fn(), writeNativeCommandInput: vi.fn() }));
const target = { workspaceId: "space", agentId: "atlas", expectedGeneration: 4, jobId: "job-one", jobGeneration: 4 };
const job: NativeCommandJob & { interactive: boolean; inputSequence: number } = { id: "job-one", repositoryId: "copy", generation: 4, operationId: 2, commandId: "node", persistent: true, network: false, timeoutSeconds: 60, status: "running", createdAt: "now", finishedAt: null, exitCode: null, executionId: "execution", message: null, interactive: true, inputSequence: 2 };
const output = (text = "Waiting for input. <script>host()</script>"): NativeCommandOutput => ({ job, output: { frames: [{ sequence: 1, stream: "stdout", text }], nextCursor: 1, dropped: false, closed: false, redacted: false }, outputUnavailable: false });
const open = () => { const details = screen.getByText("Terminal").closest("details")!; details.open = true; fireEvent(details, new Event("toggle")); };
beforeEach(() => { vi.mocked(readNativeCommandOutput).mockResolvedValue(output()); vi.mocked(stopNativeCommandJob).mockResolvedValue({ job: { ...job, status: "stopped" } }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe("native result terminal", () => {
  it("reads only when disclosed and keeps untrusted output as selectable text", async () => {
    render(<CodingTerminal target={target} job={job} />);
    expect(readNativeCommandOutput).not.toHaveBeenCalled();
    open();
    expect(await screen.findByText(/Waiting for input/)).toHaveTextContent("<script>host()</script>");
    expect(screen.getByLabelText("Terminal output").querySelector("script")).toBeNull();
    expect(readNativeCommandOutput).toHaveBeenCalledWith(target, 0);
  });
  it("reconnects output without replaying input or restarting a command", async () => {
    vi.mocked(readNativeCommandOutput).mockRejectedValueOnce(new Error("Disconnected"));
    const writeInput = vi.fn();
    render(<CodingTerminal target={target} job={job} writeInput={writeInput} />); open();
    expect(await screen.findByRole("alert")).toHaveTextContent("Disconnected");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect output" }));
    await screen.findByText(/Waiting for input/);
    expect(writeInput).not.toHaveBeenCalled(); expect(stopNativeCommandJob).not.toHaveBeenCalled();
  });
  it("consumes the next exact input sequence and freezes uncertain delivery while Stop remains available", async () => {
    const writeInput = vi.fn().mockResolvedValue({ jobId: job.id, jobGeneration: 4, inputSequence: 3, delivery: "uncertain" });
    render(<CodingTerminal target={target} job={job} writeInput={writeInput} />); open();
    await screen.findByText("Output connected");
    fireEvent.change(screen.getByRole("textbox", { name: "Terminal input" }), { target: { value: "yes" } });
    fireEvent.click(screen.getByRole("button", { name: "Send line" }));
    await screen.findByText(/Input delivery was not confirmed/);
    expect(writeInput).toHaveBeenCalledWith({ ...target, inputSequence: 3, text: "yes\n" });
    expect(screen.getByRole("textbox", { name: "Terminal input" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Terminal input" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect output" }));
    await waitFor(() => expect(readNativeCommandOutput).toHaveBeenCalledTimes(2));
    expect(writeInput).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stopNativeCommandJob).toHaveBeenCalledWith(target));
  });
  it("ignores a late result after the exact owner changes", async () => {
    let finish!: (value: NativeCommandOutput) => void;
    vi.mocked(readNativeCommandOutput).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<CodingTerminal target={target} job={job} />); open();
    view.rerender(<CodingTerminal target={{ ...target, agentId: "mira" }} job={job} />); open();
    await screen.findByText(/Waiting for input/);
    finish(output("OLD PRIVATE OUTPUT"));
    await waitFor(() => expect(screen.queryByText("OLD PRIVATE OUTPUT")).toBeNull());
  });
  it("bounds output by bytes and deduplicates repeated frames", () => {
    const frame = { sequence: 1, stream: "stdout" as const, text: "line" };
    expect(appendTerminalFrames([frame], [frame, frame]).frames).toEqual([frame]);
    expect(appendTerminalFrames([], [{ ...frame, text: "😀".repeat(20_000) }])).toEqual({ frames: [], dropped: true });
  });
  it("counts the explicit newline and UTF-8 bytes before sending a line", async () => {
    const writeInput = vi.fn();
    render(<CodingTerminal target={target} job={job} writeInput={writeInput} />); open();
    await screen.findByText("Output connected");
    fireEvent.change(screen.getByRole("textbox", { name: "Terminal input" }), { target: { value: "😀".repeat(1024) } });
    fireEvent.click(screen.getByRole("button", { name: "Send line" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("4 KiB");
    expect(writeInput).not.toHaveBeenCalled();
  });
  it("keeps Stop independent from an unanswered input write", async () => {
    const writeInput = vi.fn(() => new Promise<never>(() => {}));
    render(<CodingTerminal target={target} job={job} writeInput={writeInput} />); open();
    await screen.findByText("Output connected");
    fireEvent.change(screen.getByRole("textbox", { name: "Terminal input" }), { target: { value: "yes" } });
    fireEvent.click(screen.getByRole("button", { name: "Send line" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stopNativeCommandJob).toHaveBeenCalledWith(target));
    expect(writeInput).toHaveBeenCalledTimes(1);
  });
});
