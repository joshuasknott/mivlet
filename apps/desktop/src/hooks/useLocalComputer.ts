import type {
  LocalBrowserSnapshot,
  LocalComputerController,
  LocalComputerTarget,
} from "@fable/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  historyRuntimeLocalBrowser,
  keyRuntimeLocalBrowser,
  listRuntimeLocalComputerFiles,
  loadRuntimeLocalComputer,
  navigateRuntimeLocalBrowser,
  pointRuntimeLocalBrowser,
  previewRuntimeLocalComputerFile,
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
  const scopeKey = `${workspaceId ?? "unavailable"}:${agentId}`;
  const target: LocalComputerTarget | null = workspaceId
    ? { workspaceId, agentId }
    : null;
  const queryKey = ["local-computer", workspaceId ?? "unavailable", agentId] as const;
  const browserQueryKey = ["local-computer-browser", workspaceId ?? "unavailable", agentId] as const;
  const filesQueryKey = ["local-computer-files", workspaceId ?? "unavailable", agentId] as const;
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
  const files = useQuery({
    queryKey: filesQueryKey,
    queryFn: () => target ? listRuntimeLocalComputerFiles(target) : Promise.resolve(null),
    enabled: false,
    retry: false,
  });
  const filePreview = useMutation({
    mutationFn: (input: { target: LocalComputerTarget; scopeKey: string; path: string }) => {
      return previewRuntimeLocalComputerFile({ ...input.target, path: input.path });
    },
  });
  const filePreviewMatchesScope = filePreview.variables?.scopeKey === scopeKey;

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
  const history = useMutation({
    mutationFn: async (direction: "back" | "forward") => {
      const snapshot = browser.data;
      if (!target || !snapshot) throw new Error("The local browser is unavailable.");
      return historyRuntimeLocalBrowser({
        ...target,
        expectedGeneration: snapshot.generation,
        direction,
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
    scopeKey,
    available: Boolean(target),
    node: computer.data ?? null,
    snapshot: browser.data ?? null,
    files: files.data ?? null,
    filesLoading: files.isFetching,
    filesError: files.error instanceof Error ? files.error.message : null,
    filePreview: filePreviewMatchesScope ? filePreview.data ?? null : null,
    filePreviewLoading: filePreviewMatchesScope && filePreview.isPending,
    filePreviewError: filePreviewMatchesScope && filePreview.error instanceof Error ? filePreview.error.message : null,
    loading: computer.isLoading,
    provisioning: provision.isPending,
    browserBusy: navigate.isPending || controller.isPending || pointer.isPending || key.isPending || history.isPending,
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
              : history.error instanceof Error
                ? history.error.message
                : null),
    provision: () => provision.mutateAsync(),
    navigate: (url: string) => navigate.mutateAsync(url),
    refresh: () => browser.refetch().then((result) => result.data ?? null),
    refreshFiles: () => files.refetch().then((result) => result.data ?? null),
    previewFile: (path: string) => {
      if (!target) return Promise.reject(new Error("The private file is unavailable."));
      filePreview.reset();
      return filePreview.mutateAsync({ target: { ...target }, scopeKey, path });
    },
    closeFilePreview: filePreview.reset,
    takeControl: () => controller.mutateAsync("human"),
    returnControl: () => controller.mutateAsync("agent"),
    click: (x: number, y: number) => pointer.mutateAsync({ x, y, action: "click" }),
    scroll: (x: number, y: number, deltaY: number) => pointer.mutateAsync({ x, y, action: "scroll", deltaY }),
    key: (value: string) => key.mutateAsync(value),
    goBack: () => history.mutateAsync("back"),
    goForward: () => history.mutateAsync("forward"),
  };
}
