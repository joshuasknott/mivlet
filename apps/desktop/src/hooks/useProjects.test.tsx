import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPreviewProjects } from "../lib/project-runtime";
import { projectQueryKeys, useProjects } from "./useProjects";

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } }
  });
  return {
    client,
    Wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
  };
}

describe("useProjects", () => {
  beforeEach(() => {
    clearPreviewProjects();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: undefined
    });
  });

  it("refreshes active and archived project lists after mutations", async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useProjects("workspace-a"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let created!: Awaited<ReturnType<typeof result.current.create>>;
    await act(async () => {
      created = await result.current.create({ title: "A project" });
    });
    await waitFor(() => expect(result.current.projects.map((item) => item.id)).toEqual([created.id]));

    await act(async () => {
      await result.current.archive({ projectId: created.id, baseRevision: created.revision });
    });
    await waitFor(() => expect(result.current.archivedProjects).toHaveLength(1));
    expect(result.current.projects).toEqual([]);
    expect(result.current.persistence).toBe("preview-memory");
  });

  it("uses a workspace-specific cache and cannot show the previous workspace", async () => {
    const { client, Wrapper } = wrapper();
    const { result, rerender } = renderHook(
      ({ workspaceId }) => useProjects(workspaceId),
      { initialProps: { workspaceId: "workspace-a" }, wrapper: Wrapper }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.create({ title: "Only in A" });
    });
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    rerender({ workspaceId: "workspace-b" });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.queryKey).toEqual(projectQueryKeys.workspace("workspace-b"));
    expect(result.current.projects).toEqual([]);
    expect(client.getQueryData(projectQueryKeys.workspace("workspace-a"))).toHaveLength(1);
    expect(client.getQueryData(projectQueryKeys.workspace("workspace-b"))).toEqual([]);
  });
});
