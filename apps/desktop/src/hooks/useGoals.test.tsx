import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPreviewGoals } from "../lib/goal-runtime";
import { clearPreviewProjects, createRuntimeProject } from "../lib/project-runtime";
import { goalQueryKeys, useGoals } from "./useGoals";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return {
    client,
    Wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
  };
}

describe("useGoals", () => {
  beforeEach(() => {
    clearPreviewGoals();
    clearPreviewProjects();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: undefined });
  });

  it("refreshes lifecycle lists after mutations", async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useGoals("workspace-a", null), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let created!: Awaited<ReturnType<typeof result.current.create>>;
    await act(async () => {
      created = await result.current.create({ title: "Goal", statement: "Do it" });
    });
    await waitFor(() => expect(result.current.activeGoals).toHaveLength(1));
    await act(async () => {
      await result.current.achieve({ goalId: created.id, baseRevision: created.revision });
    });
    await waitFor(() => expect(result.current.achievedGoals).toHaveLength(1));
    expect(result.current.activeGoals).toEqual([]);
    expect(result.current.persistence).toBe("preview-memory");
  });

  it("partitions cache and results by workspace and exact project filter", async () => {
    const project = await createRuntimeProject("workspace-a", { title: "Project A" });
    const { client, Wrapper } = wrapper();
    type HookProps = { workspaceId: string; projectId: string | null };
    const initialProps: HookProps = { workspaceId: "workspace-a", projectId: project.id };
    const { result, rerender } = renderHook(
      ({ workspaceId, projectId }: HookProps) =>
        useGoals(workspaceId, projectId),
      { initialProps, wrapper: Wrapper }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.create({ projectId: project.id, title: "Scoped", statement: "Only A" });
    });
    await waitFor(() => expect(result.current.activeGoals).toHaveLength(1));

    rerender({ workspaceId: "workspace-a", projectId: null });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeGoals).toEqual([]);
    expect(client.getQueryData(goalQueryKeys.scope("workspace-a", project.id))).toHaveLength(1);
    expect(client.getQueryData(goalQueryKeys.scope("workspace-a", null))).toEqual([]);

    rerender({ workspaceId: "workspace-b", projectId: null });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeGoals).toEqual([]);
    expect(result.current.queryKey).toEqual(goalQueryKeys.scope("workspace-b", null));
  });
});
