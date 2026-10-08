import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MivletAgentProfile, NativeCommandJob } from "@mivlet/protocol";
import { NativeCommandJobs, retainCommandFrames } from "./NativeCommandJobs";
import {
  listNativeCommandJobs,
  readNativeCommandOutput,
  stopNativeCommandJob,
} from "../../runtime/domains/command-jobs";
import { loadRuntimeLocalComputer } from "../../runtime/domains/local-computer";
vi.mock("../../runtime/domains/command-jobs", () => ({
  listNativeCommandJobs: vi.fn(),
  readNativeCommandOutput: vi.fn(),
  stopNativeCommandJob: vi.fn(),
}));
vi.mock("../../runtime/domains/local-computer", () => ({
  loadRuntimeLocalComputer: vi.fn(),
}));
const job: NativeCommandJob = {
  id: "job-one",
  repositoryId: null,
  generation: 4,
  operationId: 1,
  commandId: "digest",
  persistent: true,
  network: false,
  timeoutSeconds: 600,
  status: "running",
  createdAt: "2026-10-08T12:00:00Z",
  finishedAt: null,
  exitCode: null,
  executionId: null,
  message: null,
};
const agent = { id: "agent-one", name: "Agent" } as MivletAgentProfile;
const mount = () => {
  const view = render(
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
      <NativeCommandJobs workspaceId="workspace-one" agents={[agent]} />
    </QueryClientProvider>,
  );
  const details = screen.getByText("Commands").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  return view;
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadRuntimeLocalComputer).mockResolvedValue({
    generation: 4,
  } as Awaited<ReturnType<typeof loadRuntimeLocalComputer>>);
  vi.mocked(listNativeCommandJobs).mockResolvedValue({ jobs: [job] });
  vi.mocked(readNativeCommandOutput).mockResolvedValue({
    job,
    output: {
      frames: [{ sequence: 1, stream: "stdout", text: "build passed\n" }],
      nextCursor: 1,
      dropped: true,
      closed: true,
      redacted: true,
    },
    outputUnavailable: false,
  });
  vi.mocked(stopNativeCommandJob).mockResolvedValue({
    job: { ...job, status: "stopping" },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("NativeCommandJobs", () => {
  it("shows a clear error if the native output connection is unavailable", async () => {
    vi.mocked(readNativeCommandOutput).mockResolvedValue(null);
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Open the desktop app to read native output.",
    );
    expect(stopNativeCommandJob).not.toHaveBeenCalled();
  });
  it("shows bounded output, redaction and gaps and stops the exact scoped job", async () => {
    mount();
    expect(await screen.findByText("build passed")).toBeInTheDocument();
    expect(screen.getByText(/Older output exceeded/)).toBeInTheDocument();
    expect(screen.getByText(/Some output was redacted/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop job" }));
    await waitFor(() =>
      expect(stopNativeCommandJob).toHaveBeenCalledWith({
        workspaceId: "workspace-one",
        agentId: "agent-one",
        expectedGeneration: 4,
        jobId: job.id,
        jobGeneration: 4,
      }),
    );
  });
  it("never reads output from a revoked generation", async () => {
    vi.mocked(loadRuntimeLocalComputer).mockResolvedValue({
      generation: 5,
    } as Awaited<ReturnType<typeof loadRuntimeLocalComputer>>);
    mount();
    expect(
      await screen.findByText(/This generation has ended/),
    ).toBeInTheDocument();
    expect(readNativeCommandOutput).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Stop job" }),
    ).not.toBeInTheDocument();
  });
  it("discards a late output response after the view disconnects without stopping its job", async () => {
    let resolve:
      | ((value: Awaited<ReturnType<typeof readNativeCommandOutput>>) => void)
      | undefined;
    vi.mocked(readNativeCommandOutput).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = mount();
    await waitFor(() => expect(resolve).toBeDefined());
    view.unmount();
    await act(async () =>
      resolve!({ job, output: null, outputUnavailable: true }),
    );
    expect(stopNativeCommandJob).not.toHaveBeenCalled();
  });
  it("bounds client scrollback and ignores duplicated replay frames", () => {
    const frames = Array.from({ length: 1000 }, (_, index) => ({
      sequence: index + 1,
      stream: "stdout" as const,
      text: "x".repeat(200),
    }));
    const retained = retainCommandFrames([], frames);
    expect(
      retained.reduce((sum, frame) => sum + frame.text.length, 0),
    ).toBeLessThanOrEqual(64 * 1024);
    expect(retained.at(-1)?.sequence).toBe(1000);
    expect(retainCommandFrames(retained, retained)).toEqual(retained);
  });
});
