import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeCodingResult } from "./NativeCodingResult";
import { listNativeCommandJobs, stopNativeCommandJob } from "../../../runtime/domains/command-jobs";
import { loadRuntimeLocalComputer } from "../../../runtime/domains/local-computer";
vi.mock("../../../runtime/domains/command-jobs", () => ({ listNativeCommandJobs: vi.fn(), stopNativeCommandJob: vi.fn() }));
vi.mock("../../../runtime/domains/local-computer", () => ({ loadRuntimeLocalComputer: vi.fn() }));
vi.mock("./CodingTerminal", () => ({ CodingTerminal: ({ target }: { target: { jobId: string } }) => <p>Verified terminal {target.jobId}</p> }));
const callbacks = vi.hoisted(() => ({ stop: undefined as (() => Promise<void>) | undefined }));
vi.mock("./CodingPreview", () => ({ CodingPreview: ({ onStop }: { onStop: () => Promise<void> }) => { callbacks.stop = onStop; return <p>Verified preview</p>; } }));
vi.mock("./CodingRepositoryReview", () => ({ CodingRepositoryReview: ({ target, repositoryId, view }: { target: { agentId: string }; repositoryId: string; view: string }) => <p>Task {view}: {target.agentId}/{repositoryId}</p> }));
vi.mock("./CodingResultTabs", () => ({ CodingResultTabs: ({ terminal, preview, files, changes }: { terminal: React.ReactNode; preview: React.ReactNode; files: React.ReactNode; changes: React.ReactNode }) => <>{terminal}{preview}{files}{changes}</> }));
const id = "a".repeat(48);
const props = { workspaceId: "workspace", agentId: "agent", jobId: id, jobGeneration: 4 };
beforeEach(() => {
  vi.mocked(loadRuntimeLocalComputer).mockResolvedValue({ workspaceId: "workspace", agentId: "agent", generation: 4 } as never);
  vi.mocked(listNativeCommandJobs).mockResolvedValue({ jobs: [{ id, generation: 4, status: "running", repositoryId: "repo", previewPort: 4173 }] } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); callbacks.stop = undefined; });
it("opens controls only after deliberate reconnect and exact scoped native verification", async () => {
  render(<NativeCodingResult {...props} onDraft={vi.fn()} />);
  expect(loadRuntimeLocalComputer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open session" }));
  await screen.findByText(`Verified terminal ${id}`);
  expect(listNativeCommandJobs).toHaveBeenCalledWith({ workspaceId: "workspace", agentId: "agent", expectedGeneration: 4 });
  expect(screen.getByText("Verified preview")).toBeTruthy();
  expect(screen.getByText("Task files: agent/repo")).toBeTruthy();
  expect(screen.getByText("Task changes: agent/repo")).toBeTruthy();
});
it("refuses a receipt whose generation does not match native history", async () => {
  vi.mocked(listNativeCommandJobs).mockResolvedValue({ jobs: [{ id, generation: 9 }] } as never);
  render(<NativeCodingResult {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Open session" }));
  await screen.findByText(/unavailable in this agent's scope/);
  expect(screen.queryByText(`Verified terminal ${id}`)).toBeNull();
});
it("ignores a late scope lookup when the result closes", async () => {
  let finish!: (value: never) => void;
  vi.mocked(loadRuntimeLocalComputer).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<NativeCodingResult {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Open session" }));
  await waitFor(() => expect(loadRuntimeLocalComputer).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Hide session" }));
  await act(async () => finish({ workspaceId: "workspace", agentId: "agent", generation: 4 } as never));
  expect(screen.queryByText(`Verified terminal ${id}`)).toBeNull();
});
it("bounds a stalled combined reconnect and requires explicit retry without adopting its late result", async () => {
  vi.useFakeTimers();
  let finish!: (value: never) => void;
  vi.mocked(loadRuntimeLocalComputer).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<NativeCodingResult {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Open session" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(screen.getByText(/Reconnecting timed out/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry connection" })).toBeTruthy();
  await act(async () => finish({ workspaceId: "workspace", agentId: "agent", generation: 4 } as never));
  expect(screen.queryByText(`Verified terminal ${id}`)).toBeNull();
});
it("refuses a missing or retargeted Stop receipt", async () => {
  render(<NativeCodingResult {...props} onDraft={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Open session" }));
  await screen.findByText("Verified preview");
  vi.mocked(stopNativeCommandJob).mockResolvedValueOnce(null);
  await expect(callbacks.stop!()).rejects.toThrow("did not match");
  vi.mocked(stopNativeCommandJob).mockResolvedValueOnce({ job: { id: "b".repeat(48), generation: 4 } } as never);
  await expect(callbacks.stop!()).rejects.toThrow("did not match");
});
it("remounts a changed owner and does not adopt a late Stop into that owner", async () => {
  let finish!: (value: never) => void;
  vi.mocked(stopNativeCommandJob).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<NativeCodingResult {...props} onDraft={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Open session" }));
  await screen.findByText("Verified preview");
  const stopped = callbacks.stop!();
  view.rerender(<NativeCodingResult {...props} agentId="other-agent" />);
  await act(async () => { finish({ job: { id, generation: 4, status: "stopped" } } as never); await stopped; });
  expect(screen.queryByText(`Verified terminal ${id}`)).toBeNull();
  expect(screen.getByRole("button", { name: "Open session" })).toBeTruthy();
});
