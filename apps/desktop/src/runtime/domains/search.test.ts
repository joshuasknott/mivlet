import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectRuntimeAdapterForTest } from "../adapters/select";
import { searchWorkspace } from "./search";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const request = { workspaceId: "workspace-a", query: "aurora" };
const response = {
  query: "aurora",
  results: [],
  truncated: false,
  scanned: {
    conversationsScanned: 0,
    messagesScanned: 0,
    workScanned: 0,
    projectsScanned: 0,
    agentsScanned: 0,
    filesScanned: 0,
  },
};

function native() {
  selectRuntimeAdapterForTest("native");
}

beforeEach(() => {
  vi.resetAllMocks();
  selectRuntimeAdapterForTest("preview");
});

describe("unified search runtime boundary", () => {
  it("fails closed in the browser preview instead of simulating a store", async () => {
    await expect(searchWorkspace(request)).rejects.toThrow(
      "installed desktop app",
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("forwards the exact scoped request and normalizes native prerequisite errors", async () => {
    native();
    mocks.invoke.mockResolvedValueOnce(response);
    await expect(searchWorkspace(request)).resolves.toEqual(response);
    expect(mocks.invoke).toHaveBeenCalledWith("search_workspace", { request });

    mocks.invoke.mockRejectedValueOnce({
      message: "Mivlet's encrypted store is not initialized.",
    });
    await expect(searchWorkspace(request)).rejects.toThrow("encrypted store");
  });
});
