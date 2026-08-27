import type {
  LocalBrowserSnapshot,
  LocalComputerController,
  LocalComputerTarget,
} from "@fable/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  keyRuntimeLocalBrowser,
  loadRuntimeLocalComputer,
  navigateRuntimeLocalBrowser,
  pointRuntimeLocalBrowser,
  provisionRuntimeLocalComputer,
  setRuntimeLocalComputerController,
  snapshotRuntimeLocalBrowser,
} from "../runtime";

export function useLocalComputer({
  workspaceId,
  agentId,
}: {
  workspaceId?: string;
  agentId: string;
}) {
  const queryClient = useQueryClient();
  const target: LocalComputerTarget | null = workspaceId
    ? { workspaceId, agentId }
    : null;
  const queryKey = ["local-computer", workspaceId ?? "unavailable", agentId] as const;
  const browserQueryKey = ["local-computer-browser", workspaceId ?? "unavailable", agentId] as const;
  const computer = useQuery({
    queryKey,
    queryFn: () => target ? loadRuntimeLocalComputer(target) : Promise.resolve(null),
    enabled: Boolean(target),
    retry: false,
    refetchInterval: target ? 2_000 : false,
  });
  const browser = useQuery({
    queryKey: browserQueryKey,
    queryFn: () => target ? snapshotRuntimeLocalBrowser(target) : Promise.resolve(null),
    enabled: Boolean(target && computer.data?.browserActive),
    retry: false,
    refetchInterval: computer.data?.browserActive ? 1_500 : false,
  });

  const setBrowserSnapshot = (snapshot: LocalBrowserSnapshot | null) => {
    queryClient.setQueryData(browserQueryKey, snapshot);
    void queryClient.invalidateQueries({ queryKey });
  };
  const provision = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("Choose a teammate before setting up a local computer.");
      return provisionRuntimeLocalComputer(target);
    },
    onSuccess: async (snapshot) => {
      queryClient.setQueryData(queryKey, snapshot);
      if (target) setBrowserSnapshot(await snapshotRuntimeLocalBrowser(target));
    },
  });
  const navigate = useMutation({
    mutationFn: async (url: string) => {
      if (!target) throw new Error("The local browser is unavailable.");
      return navigateRuntimeLocalBrowser({ ...target, url });
    },
    onSuccess: setBrowserSnapshot,
  });
  const controller = useMutation({
    mutationFn: async (next: LocalComputerController) => {
      const snapshot = browser.data;
      if (!target || !snapshot) throw new Error("The local browser is unavailable.");
      return setRuntimeLocalComputerController({
        ...target,
        controller: next,
        expectedGeneration: snapshot.generation,
      });
    },
    onSuccess: setBrowserSnapshot,
  });
  const pointer = useMutation({
    mutationFn: async (input: { x: number; y: number; action: "click" | "scroll"; deltaY?: number }) => {
      const snapshot = browser.data;
      if (!target || !snapshot) throw new Error("The local browser is unavailable.");
      return pointRuntimeLocalBrowser({
        ...target,
        expectedGeneration: snapshot.generation,
        ...input,
      });
    },
    onSuccess: setBrowserSnapshot,
  });
  const key = useMutation({
    mutationFn: async (value: string) => {
      const snapshot = browser.data;
      if (!target || !snapshot) throw new Error("The local browser is unavailable.");
      return keyRuntimeLocalBrowser({
        ...target,
        expectedGeneration: snapshot.generation,
        key: value,
      });
    },
    onSuccess: setBrowserSnapshot,
  });
  const recoveryError = computer.error instanceof Error
    ? computer.error.message
    : provision.error instanceof Error
      ? provision.error.message
      : browser.error instanceof Error
        ? browser.error.message
        : null;

  return {
    scopeKey: `${workspaceId ?? "unavailable"}:${agentId}`,
    available: Boolean(target),
    node: computer.data ?? null,
    snapshot: browser.data ?? null,
    loading: computer.isLoading,
    provisioning: provision.isPending,
    browserBusy: navigate.isPending || controller.isPending || pointer.isPending || key.isPending,
    recoveryNeeded: recoveryError !== null,
    error: recoveryError
      ?? (navigate.error instanceof Error
        ? navigate.error.message
        : controller.error instanceof Error
          ? controller.error.message
          : pointer.error instanceof Error
            ? pointer.error.message
            : key.error instanceof Error
              ? key.error.message
              : null),
    provision: () => provision.mutateAsync(),
    navigate: (url: string) => navigate.mutateAsync(url),
    refresh: () => browser.refetch().then((result) => result.data ?? null),
    takeControl: () => controller.mutateAsync("human"),
    returnControl: () => controller.mutateAsync("agent"),
    click: (x: number, y: number) => pointer.mutateAsync({ x, y, action: "click" }),
    scroll: (x: number, y: number, deltaY: number) => pointer.mutateAsync({ x, y, action: "scroll", deltaY }),
    key: (value: string) => key.mutateAsync(value),
  };
}
