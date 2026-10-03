import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingRepositoryStatus,
  LocalComputerSnapshot,
  MivletAgentProfile,
} from "@mivlet/protocol";
import { RepositoryFiles } from "./RepositoryFiles";
import {
  attachCodingRepository,
  inspectCodingRepository,
} from "../../runtime/domains/coding";
import {
  cancelRuntimeLocalComputer,
  loadRuntimeLocalComputer,
} from "../../runtime/domains/local-computer";

vi.mock("../../runtime/domains/coding", () => ({
  attachCodingRepository: vi.fn(),
  inspectCodingRepository: vi.fn(),
}));
vi.mock("../../runtime/domains/local-computer", () => ({
  cancelRuntimeLocalComputer: vi.fn(),
  loadRuntimeLocalComputer: vi.fn(),
}));
const agents = [
  { id: "mira", name: "Mira" },
  { id: "ben", name: "Ben" },
] as MivletAgentProfile[];
const repository: CodingRepositoryStatus = {
  repository: {
    id: "repo",
    name: "sample",
    branch: "mivlet/task",
    base: "base",
    baseBranch: "main",
    remote: null,
    operation: "idle",
    lastCommand: "node test.js",
    commandDiffId: "old",
    publication: null,
    lastResult: {
      exitCode: 1,
      output: "AssertionError: expected 5",
      interrupted: false,
      truncated: false,
    },
  },
  changes: {
    head: "head",
    diffId: "new",
    diff: "+ a + b",
    files: "M sum.js",
    truncated: false,
  },
};
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RepositoryFiles workspaceId="workspace" agents={agents} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Repository", { selector: "summary" }));
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadRuntimeLocalComputer).mockResolvedValue({
    generation: 7,
    plugins: { computer: true },
  } as LocalComputerSnapshot);
  vi.mocked(inspectCodingRepository).mockResolvedValue(repository);
});
describe("repository in Files", () => {
  it("attaches to the selected saved agent and current native generation", async () => {
    setup();
    fireEvent.change(screen.getByRole("combobox", { name: "Agent" }), {
      target: { value: "ben" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Attach another repository" }),
    );
    await waitFor(() =>
      expect(attachCodingRepository).toHaveBeenCalledWith({
        workspaceId: "workspace",
        agentId: "ben",
        expectedGeneration: 7,
      }),
    );
  });
  it("presents real failure output and marks changed code unverified", async () => {
    setup();
    expect(await screen.findByText("Last command: exit 1")).toBeVisible();
    expect(screen.getByText("AssertionError: expected 5")).toBeVisible();
    expect(
      screen.getByText(
        "Current changes have not been verified by this command.",
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByText("Changes in this branch"));
    expect(screen.getByLabelText("Repository diff")).toHaveTextContent(
      "+ a + b",
    );
  });
  it("stops the exact scope and shows unknown-outcome recovery", async () => {
    vi.mocked(inspectCodingRepository).mockResolvedValue({
      ...repository,
      busy: true,
      recoveryRequired: true,
    });
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(cancelRuntimeLocalComputer).toHaveBeenCalledWith({
        workspaceId: "workspace",
        agentId: "mira",
        expectedGeneration: 7,
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("does not replay");
  });
  it("fails clearly outside the native runtime", async () => {
    vi.mocked(loadRuntimeLocalComputer).mockResolvedValue(null);
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Open the desktop app",
    );
    expect(inspectCodingRepository).not.toHaveBeenCalled();
  });
});
